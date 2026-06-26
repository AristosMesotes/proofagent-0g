//! `verifier` binary -- the command surface.
//!
//! Design SS9 (getting started): `cargo run -p verifier -- verify-tx <hash>`
//! -> SETTLED / HOLLOW / MISMATCH / UNVERIFIED.
//!
//! STEP VS4 wires `verify-tx` to the real verify leg of the loop (design SS5): it reads the data
//! spine (`proofagent.toml`) for the recorded **claim** corpus + the exact-integer **tolerance**
//! (design SS4), binds an independent [`Source`] (a deterministic offline [`TapeSource`] by default;
//! a `LiveSource` JSON-RPC reader under the `live` feature), and calls [`verifier::verify_tx`] to mint
//! and print the canonical [`verifier::Verdict`] string (design SS2 settlement proof).
//!
//! STEP LEDGER adds the settlement-truth LEDGER subcommands (design SS5a): `verify-tx` JOURNALS each
//! verdict (append-only, deterministic, redacted) to a verdict journal; `ledger` projects that journal
//! read-only (per tx: claimed vs chain-observed minor units, the verdict, the exact-integer delta); and
//! `audit` surfaces every non-`settled` row (hollow / mismatch / unverified) LOUDLY, exiting non-zero
//! when any defect is present (design SS3 principle 3 / SS8, zero-loss). Both `ledger` and `audit` read
//! ONLY the journal -- never the agent's report, never the UI: the ledger IS the settlement truth.
//!
//! ## The honest exit contract (design SS3 principle 3, never fabricate)
//!
//! - `verify-tx`: a real verdict prints its canonical string to **stdout** (the one machine-readable
//!   line). Exit is `0` for `settled`, and **non-zero** for `hollow` / `mismatch` / `unverified` -- so a
//!   script that only checks the exit code can never mistake a non-settlement for success.
//! - The NEG case (design SS2): a *fabricated / unknown* hash (well-formed, but not on-record in the
//!   corpus) is NOT a usage error -- it stamps the hero verdict `unverified` to stdout and exits
//!   non-zero. The verifier degrades LOUDLY; it never prints `settled` for an off-record hash.
//! - `audit`: exits `0` only when the journal is clean (every row `settled`); a journal carrying ANY
//!   defect (hollow / mismatch / unverified) exits **non-zero** (design SS5a / SS8). `ledger` is a
//!   read-only projection and exits `0` whenever it can read the journal (it reports, it does not gate).
//! - A *usage* failure (a string that is not a transaction hash at all, an unreadable / malformed spine
//!   or journal, or no chain reader wired) prints a diagnostic to **stderr**, prints NO verdict line,
//!   and exits non-zero. It is deliberately NOT a verdict -- the absence of a verdict is itself the
//!   honest signal that nothing could even be adjudicated.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use verifier::{
    adjudicate_fill, parse_journal, verify_fill, verify_tx, Audit, FillClaim, FillReport,
    JournalRecord, LedgerSummary, Ratio, ReadKey, SpineConfig, Source, Verdict,
};

/// Stable program name for usage/diagnostic text -- not the binary's filesystem path (determinism:
/// no env-derived program name).
const PROG: &str = "verifier";

/// The data-spine filename searched for from the working directory upward (design SS4 data spine).
const SPINE_FILE: &str = "proofagent.toml";

/// The verdict-journal filename (design SS5a). Found beside the spine by default; `--journal` overrides.
const JOURNAL_FILE: &str = "proofagent.journal";

fn main() -> ExitCode {
    // Skip argv[0]; std-only, deterministic argument handling (no clap dependency).
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(String::as_str) {
        Some("verify-tx") => cmd_verify_tx(&args[1..]),
        Some("fill-proof") => cmd_fill_proof(&args[1..]),
        Some("ledger") => cmd_ledger(&args[1..]),
        Some("audit") => cmd_audit(&args[1..]),
        Some("--help" | "-h" | "help") | None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("{PROG}: unknown command: {other}");
            print_usage();
            ExitCode::FAILURE
        }
    }
}

/// `verify-tx <hash> [--spine <path>] [--journal <path>] [--no-journal]` -- the verify leg, journalled.
fn cmd_verify_tx(rest: &[String]) -> ExitCode {
    // Parse the small, fixed argument set deterministically. The hash is positional; `--spine` and
    // `--journal` take a path; `--no-journal` disables the append (e.g. a pure read with no side effect).
    let mut hash: Option<&str> = None;
    let mut spine_override: Option<PathBuf> = None;
    let mut journal_override: Option<PathBuf> = None;
    let mut no_journal = false;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--spine" => {
                let Some(p) = rest.get(i + 1) else {
                    eprintln!("{PROG}: --spine requires a path");
                    return ExitCode::FAILURE;
                };
                spine_override = Some(PathBuf::from(p));
                i += 2;
            }
            "--journal" => {
                let Some(p) = rest.get(i + 1) else {
                    eprintln!("{PROG}: --journal requires a path");
                    return ExitCode::FAILURE;
                };
                journal_override = Some(PathBuf::from(p));
                i += 2;
            }
            "--no-journal" => {
                no_journal = true;
                i += 1;
            }
            other if other.starts_with("--") => {
                eprintln!("{PROG}: unknown option: {other}");
                eprintln!(
                    "usage: {PROG} verify-tx <hash> [--spine <path>] [--journal <path>] [--no-journal]"
                );
                return ExitCode::FAILURE;
            }
            positional => {
                if hash.is_some() {
                    eprintln!("{PROG}: unexpected extra argument: {positional}");
                    return ExitCode::FAILURE;
                }
                hash = Some(positional);
                i += 1;
            }
        }
    }

    let Some(hash) = hash else {
        eprintln!("{PROG}: verify-tx requires a transaction hash");
        eprintln!("usage: {PROG} verify-tx <hash> [--spine <path>] [--journal <path>] [--no-journal]");
        return ExitCode::FAILURE;
    };

    // (a) Load + parse the data spine (corpus + tolerance). A missing/unreadable/malformed spine is a
    // loud usage error -- never a fabricated verdict.
    let spine_path = match resolve_spine(spine_override) {
        Ok(p) => p,
        Err(code) => return code,
    };
    let config = match load_spine(&spine_path) {
        Ok(c) => c,
        Err(code) => return code,
    };

    // (b) Bind the independent on-chain read source (two-source truth, design SS3 principle 1).
    let mut source = match bind_source(&config) {
        Ok(s) => s,
        Err(msg) => {
            eprintln!("{PROG}: {msg}");
            return ExitCode::FAILURE;
        }
    };

    // (c) Run the verify leg -> Verdict, and honor the honest exit contract.
    match verify_tx(hash, &config, source.as_mut()) {
        Ok(report) => {
            // The one machine-readable line: the canonical verdict string, to stdout. For a fabricated
            // / unknown hash this is the hero stamp `unverified` (design SS2, the NEG case).
            println!("{}", report.verdict_string());
            // A human-readable journal row to stderr (does not pollute the stdout verdict line).
            eprintln!(
                "{PROG}: {} {} claimed={} observed={} -> {}",
                report.kind,
                report.hash,
                report.claimed,
                report
                    .observed
                    .map_or_else(|| "<unavailable>".to_string(), |v| v.to_string()),
                report.verdict_string(),
            );
            if !report.recorded {
                eprintln!(
                    "{PROG}: (NEG case -- no claim recorded in the corpus for this hash; the verifier \
                     has nothing on-record confirming a settlement, so it stamps `unverified`, NEVER \
                     `settled`. Pin the tx in {SPINE_FILE} or read it live with --features live.)"
                );
            }

            // (d) JOURNAL the verdict (design SS5a): append one redacted, deterministic record to the
            // verdict journal so the ledger/audit can project the settlement truth. Journalling is a
            // side effect that NEVER changes the verdict or the exit contract -- a journal write failure
            // is a loud stderr warning, not a fabricated success and not a verdict downgrade.
            if !no_journal {
                let journal_path = journal_override
                    .unwrap_or_else(|| spine_path.with_file_name(JOURNAL_FILE));
                let record = JournalRecord::from_report(&report);
                match verifier::append_record(&journal_path, &record) {
                    Ok(_) => eprintln!(
                        "{PROG}: journalled -> {} (append-only)",
                        journal_path.display()
                    ),
                    Err(e) => eprintln!(
                        "{PROG}: WARNING could not append to journal {}: {e} (verdict stands; the \
                         verdict line above is authoritative)",
                        journal_path.display()
                    ),
                }
            }

            // Exit 0 ONLY for settled; every non-settlement -- including the NEG case -- is non-zero.
            if report.verdict.is_settled() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        // The one remaining usage failure: the input was not a transaction hash at all. NO verdict line
        // on stdout; a diagnostic on stderr; non-zero exit. NOT journalled (there is no verdict).
        Err(e) => {
            eprintln!("{PROG}: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `fill-proof --claimed <n> [--observed <n> | --unreadable] [--tol-num <n>] [--tol-den <n>]`
/// -- the FILL-PROOF ORACLE demo (the LI.FI-Intents frontier, STEP FILL-PROOF). Adjudicates a solver's
/// CLAIMED fill against the verifier's independent OBSERVATION and prints `<verdict> <decision>` to
/// stdout. The headline: `fill-proof --claimed 1000000 --observed 0` -> `hollow BLOCK` -- a hollow fill
/// a hash-only oracle would have RELEASED. Honest exit contract: exit `0` ONLY on RELEASE (settled); any
/// BLOCK exits non-zero, so a script that checks only the exit code can never release a hollow fill.
fn cmd_fill_proof(rest: &[String]) -> ExitCode {
    let mut claimed: Option<i128> = None;
    let mut observed: Option<i128> = None;
    let mut unreadable = false;
    let mut tol_num: i128 = 15;
    let mut tol_den: i128 = 100;
    let mut fill_tx: Option<&str> = None;
    let mut intent_tx: Option<&str> = None;
    let mut spine_override: Option<PathBuf> = None;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            flag @ ("--fill-tx" | "--intent-tx" | "--spine") => {
                let Some(raw) = rest.get(i + 1) else {
                    eprintln!("{PROG}: {flag} requires a value");
                    return ExitCode::FAILURE;
                };
                match flag {
                    "--fill-tx" => fill_tx = Some(raw),
                    "--intent-tx" => intent_tx = Some(raw),
                    _ => spine_override = Some(PathBuf::from(raw)),
                }
                i += 2;
            }
            flag @ ("--claimed" | "--observed" | "--tol-num" | "--tol-den") => {
                let Some(raw) = rest.get(i + 1) else {
                    eprintln!("{PROG}: {flag} requires an integer (minor units)");
                    return ExitCode::FAILURE;
                };
                let Ok(n) = raw.parse::<i128>() else {
                    eprintln!("{PROG}: {flag} must be an integer (minor units), got {raw}");
                    return ExitCode::FAILURE;
                };
                match flag {
                    "--claimed" => claimed = Some(n),
                    "--observed" => observed = Some(n),
                    "--tol-num" => tol_num = n,
                    _ => tol_den = n,
                }
                i += 2;
            }
            "--unreadable" => {
                unreadable = true;
                i += 1;
            }
            other => {
                eprintln!("{PROG}: unknown option: {other}");
                eprintln!(
                    "usage: {PROG} fill-proof --claimed <n> (--fill-tx <hash> | --observed <n> | \
                     --unreadable) [--intent-tx <hash>] [--spine <path>] [--tol-num <n>] [--tol-den <n>]"
                );
                return ExitCode::FAILURE;
            }
        }
    }

    let Some(claimed) = claimed else {
        eprintln!("{PROG}: fill-proof requires --claimed <n> (the solver's claimed delivered amount)");
        return ExitCode::FAILURE;
    };
    let Some(tol) = Ratio::new(tol_num, tol_den) else {
        eprintln!("{PROG}: invalid tolerance {tol_num}/{tol_den} (need den > 0, num >= 0)");
        return ExitCode::FAILURE;
    };
    // The intent's source-lock id is informational for the journal; a placeholder is fine for the demo.
    let intent_id =
        intent_tx.unwrap_or("0x1111111111111111111111111111111111111111111111111111111111111111");

    // MODE A (the LIVE oracle, two-source): read the destination fill INDEPENDENTLY by its tx hash via
    // verify_fill -- the verifier's OWN chain read (a TapeSource offline; a LiveSource under
    // --features live). This is the mode the agent loop's fill-proof leg shells to.
    if let Some(fill_tx) = fill_tx {
        let Some(key) = ReadKey::new(fill_tx) else {
            eprintln!("{PROG}: --fill-tx is not a transaction hash: {fill_tx}");
            return ExitCode::FAILURE;
        };
        let spine_path = match resolve_spine(spine_override) {
            Ok(p) => p,
            Err(code) => return code,
        };
        let config = match load_spine(&spine_path) {
            Ok(c) => c,
            Err(code) => return code,
        };
        let mut source = match bind_source(&config) {
            Ok(s) => s,
            Err(msg) => {
                eprintln!("{PROG}: {msg}");
                return ExitCode::FAILURE;
            }
        };
        let claim = FillClaim::new(intent_id, fill_tx, claimed);
        let report = verify_fill(&key, &claim, tol, source.as_mut());
        return emit_fill_report(&report);
    }

    // MODE B (the demo): the observation is supplied directly (--observed) or absent (--unreadable).
    let observed_opt: Option<i128> = if unreadable {
        None
    } else {
        let Some(v) = observed else {
            eprintln!(
                "{PROG}: fill-proof requires --fill-tx <hash> (read the chain), --observed <n> (the \
                 chain's delivered amount), or --unreadable (the chain could not be read)"
            );
            return ExitCode::FAILURE;
        };
        Some(v)
    };
    let claim = FillClaim::new(
        intent_id,
        "0x2222222222222222222222222222222222222222222222222222222222222222",
        claimed,
    );
    let report = adjudicate_fill(&claim, observed_opt, tol);
    emit_fill_report(&report)
}

/// Emit a [`FillReport`] under the honest output contract: the one machine-readable line
/// `<verdict> <decision>` to stdout, a human-readable explanation to stderr, and exit `0` ONLY on
/// RELEASE (settled) -- any BLOCK exits non-zero, so a script that checks only the exit code can never
/// release a hollow fill.
fn emit_fill_report(report: &FillReport) -> ExitCode {
    println!("{} {}", report.verdict.canonical_string(), report.decision.canonical_string());
    let observed_str = report
        .observed
        .map_or_else(|| "<unreadable>".to_string(), |v| v.to_string());
    eprintln!(
        "{PROG}: fill-proof oracle (the honest fill-proof for cross-chain intents): claimed={} \
         observed={observed_str} -> verdict={} decision={}",
        report.claimed, report.verdict, report.decision,
    );
    if report.verdict == Verdict::Hollow {
        eprintln!(
            "{PROG}: (HOLLOW FILL -- the solver claims payment for a delivery the chain says never \
             happened; a hash-only oracle would RELEASE here. ProofAgent BLOCKS.)"
        );
    }
    if report.decision.is_release() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// `ledger [--journal <path>] [--spine <path>]` -- the read-only projection of the verdict journal.
///
/// Design SS5a: prints, per transaction, claimed vs chain-observed minor units, the verdict, and the
/// exact-integer delta, in journal order, plus the summary counts and the one-line status. It computes
/// nothing new and mints no verdict -- a pure view. Exits `0` whenever the journal is readable (it
/// reports; it does not gate). A missing journal prints an honest "empty ledger" and exits `0`.
fn cmd_ledger(rest: &[String]) -> ExitCode {
    let (journal_path, _spine) = match resolve_journal(rest) {
        Ok(p) => p,
        Err(code) => return code,
    };
    let records = match read_journal(&journal_path) {
        Ok(r) => r,
        Err(code) => return code,
    };

    if records.is_empty() {
        println!("ledger: empty -- no verdicts journalled yet at {}", journal_path.display());
        println!("{}", LedgerSummary::default().status_line());
        return ExitCode::SUCCESS;
    }

    // §1 the per-tx projection (design SS5a). A fixed-order, deterministic table.
    println!(
        "ledger (settlement truth, projected read-only from {} -- never the agent's word, never the UI):",
        journal_path.display()
    );
    println!(
        "  {:<8}  {:>16}  {:>16}  {:>14}  {:<10}  hash",
        "KIND", "CLAIMED", "OBSERVED", "DELTA", "VERDICT"
    );
    for row in verifier::project(&records) {
        println!(
            "  {:<8}  {:>16}  {:>16}  {:>14}  {:<10}  {}",
            row.kind,
            row.claimed,
            row.observed_display(),
            row.delta_display(),
            row.verdict.canonical_string(),
            row.hash,
        );
    }

    // §2 the summary counts + status-at-a-glance.
    let summary = LedgerSummary::of(&records);
    println!("{}", summary.status_line());
    ExitCode::SUCCESS
}

/// `audit [--journal <path>] [--spine <path>]` -- surface every non-`settled` row LOUDLY.
///
/// Design SS5a / SS8 (zero-loss): reads the same journal as `ledger` and prints every defect
/// (`hollow` / `mismatch` / `unverified`) loudly, with a non-zero exit when ANY defect is present. A
/// clean journal (every row `settled`) audits GREEN and exits `0`. The audit never heals a row and never
/// downgrades a defect to success -- it only reports.
fn cmd_audit(rest: &[String]) -> ExitCode {
    let (journal_path, _spine) = match resolve_journal(rest) {
        Ok(p) => p,
        Err(code) => return code,
    };
    let records = match read_journal(&journal_path) {
        Ok(r) => r,
        Err(code) => return code,
    };

    let audit = Audit::of(&records);
    // The full audit surface (status line, defect rows with reasons, the GREEN/RED conclusion).
    println!("{audit}");
    eprintln!("{PROG}: audit of {} -- {}", journal_path.display(), audit.summary.status_line());

    // The exit contract: clean -> 0, any defect -> non-zero (design SS5a / SS8). An empty journal is
    // clean (no defects) and exits 0 -- it asserts no settlement, but it also hides no defect.
    if audit.is_clean() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

// ------------------------------------------------------------------------------------------------
// Shared path resolution + loaders (deterministic over the filesystem; loud on failure).
// ------------------------------------------------------------------------------------------------

/// Parse the `[--journal <path>] [--spine <path>]` options shared by `ledger` and `audit`, and resolve
/// the journal path: an explicit `--journal`, else `proofagent.journal` beside the (found) spine.
fn resolve_journal(rest: &[String]) -> Result<(PathBuf, PathBuf), ExitCode> {
    let mut journal_override: Option<PathBuf> = None;
    let mut spine_override: Option<PathBuf> = None;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--journal" => {
                let Some(p) = rest.get(i + 1) else {
                    eprintln!("{PROG}: --journal requires a path");
                    return Err(ExitCode::FAILURE);
                };
                journal_override = Some(PathBuf::from(p));
                i += 2;
            }
            "--spine" => {
                let Some(p) = rest.get(i + 1) else {
                    eprintln!("{PROG}: --spine requires a path");
                    return Err(ExitCode::FAILURE);
                };
                spine_override = Some(PathBuf::from(p));
                i += 2;
            }
            other => {
                eprintln!("{PROG}: unexpected argument: {other}");
                eprintln!("usage: {PROG} ledger|audit [--journal <path>] [--spine <path>]");
                return Err(ExitCode::FAILURE);
            }
        }
    }
    let spine_path = resolve_spine(spine_override)?;
    let journal_path = journal_override.unwrap_or_else(|| spine_path.with_file_name(JOURNAL_FILE));
    Ok((journal_path, spine_path))
}

/// Resolve the spine path: an explicit `--spine`, else the nearest `proofagent.toml` at/above the cwd.
fn resolve_spine(spine_override: Option<PathBuf>) -> Result<PathBuf, ExitCode> {
    match spine_override {
        Some(p) => Ok(p),
        None => find_spine().ok_or_else(|| {
            eprintln!(
                "{PROG}: could not find {SPINE_FILE} (searched the working directory upward); \
                 pass --spine <path>"
            );
            ExitCode::FAILURE
        }),
    }
}

/// Load + parse the data spine; a missing/unreadable/malformed spine is a loud usage error.
fn load_spine(spine_path: &Path) -> Result<SpineConfig, ExitCode> {
    let text = std::fs::read_to_string(spine_path).map_err(|e| {
        eprintln!("{PROG}: cannot read spine {}: {e}", spine_path.display());
        ExitCode::FAILURE
    })?;
    SpineConfig::parse(&text).map_err(|e| {
        eprintln!("{PROG}: invalid spine {}: {e}", spine_path.display());
        ExitCode::FAILURE
    })
}

/// Read + parse the verdict journal. A *missing* journal is NOT an error -- it is an empty journal
/// (no verdicts yet); a present-but-malformed journal is a loud usage error (design SS3 principle 3:
/// a corrupt journal must never be silently read as clean).
fn read_journal(journal_path: &Path) -> Result<Vec<JournalRecord>, ExitCode> {
    match std::fs::read_to_string(journal_path) {
        Ok(text) => parse_journal(&text).map_err(|e| {
            eprintln!("{PROG}: invalid journal {}: {e}", journal_path.display());
            ExitCode::FAILURE
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => {
            eprintln!("{PROG}: cannot read journal {}: {e}", journal_path.display());
            Err(ExitCode::FAILURE)
        }
    }
}

/// Bind the independent read source for this build.
///
/// Design SS6 (offline-by-default clean room): the default build returns a deterministic
/// [`TapeSource`] seeded from the corpus's recorded reads -- no network. The `live` build returns a
/// `LiveSource` JSON-RPC reader pointed at the `OG_RPC` endpoint from the environment (design data
/// spine `[chain].rpc_env`); its read leg reads 0G itself via raw JSON-RPC
/// (`eth_getTransactionReceipt` + `eth_getTransactionByHash`) and mints a settlement observation only
/// for a mined, successful tx -- an unreachable endpoint or an unknown/unmined hash degrades *loudly*
/// to `unverified` rather than fabricate (design SS3 principle 3), never a made-up settlement.
#[cfg(not(feature = "live"))]
fn bind_source(config: &SpineConfig) -> Result<Box<dyn Source>, String> {
    Ok(Box::new(config.tape_source()))
}

/// Live build: bind a real JSON-RPC reader against `$OG_RPC` that reads 0G itself
/// (`eth_getTransactionReceipt` + `eth_getTransactionByHash`) -- see the offline twin above. An
/// unreachable endpoint or an unknown/unmined hash degrades *loudly* to `unverified` (design SS3
/// principle 3, never fabricate); only a mined, successful tx mints a real settlement observation.
#[cfg(feature = "live")]
fn bind_source(_config: &SpineConfig) -> Result<Box<dyn Source>, String> {
    // The endpoint is read from the environment per the data spine ([chain].rpc_env = "OG_RPC") --
    // never hardcoded, so no network target is baked into the binary.
    let endpoint = std::env::var("OG_RPC").map_err(|_| {
        "live build requires the OG_RPC environment variable (the 0G JSON-RPC endpoint)".to_string()
    })?;
    Ok(Box::new(verifier::LiveSource::new(endpoint)))
}

/// Find `proofagent.toml` by walking up from the current working directory.
///
/// Deterministic over the filesystem layout (design SS3 principle 4): it returns the nearest spine at
/// or above the cwd, or `None`. No environment beyond the cwd is consulted.
fn find_spine() -> Option<PathBuf> {
    let start = std::env::current_dir().ok()?;
    let mut dir: Option<&Path> = Some(start.as_path());
    while let Some(d) = dir {
        let candidate = d.join(SPINE_FILE);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

fn print_usage() {
    println!("{PROG} -- independent on-chain settlement verifier + settlement-truth ledger");
    println!();
    println!("USAGE:");
    println!("    {PROG} verify-tx <hash> [--spine <path>] [--journal <path>] [--no-journal]");
    println!("        verify a transaction; prints one of:");
    println!("        settled / hollow / mismatch / unverified");
    println!("        and APPENDS the verdict to the journal (design SS5a; --no-journal to skip)");
    println!("    {PROG} fill-proof --claimed <n> (--fill-tx <hash> | --observed <n> | --unreadable) [--spine <path>]");
    println!("        the FILL-PROOF ORACLE for cross-chain intents: adjudicate a solver's claimed fill");
    println!("        against the chain (--fill-tx reads it; --observed/--unreadable is the demo) and");
    println!("        print `<verdict> <decision>` (RELEASE only on settled; exit 0 only on RELEASE).");
    println!("        e.g. fill-proof --claimed 1000000 --observed 0  ->  hollow BLOCK");
    println!("    {PROG} ledger [--journal <path>] [--spine <path>]");
    println!("        project the journal read-only: per tx claimed vs observed, verdict, delta");
    println!("    {PROG} audit  [--journal <path>] [--spine <path>]");
    println!("        surface every non-settled verdict LOUDLY; exit non-zero if any defect");
    println!("    {PROG} help                show this message");
    println!();
    println!("verify-tx prints the verdict to stdout; exit is 0 only for `settled`.");
    println!("audit exits 0 only for a CLEAN journal (every row settled); any defect exits non-zero.");
    println!("Reads the chain independently; never trusts the agent's word (design SS2, SS3).");
    println!("The ledger reads ONLY the journal -- the ledger IS the settlement truth (design SS5a).");
    println!("Offline by default (a recorded tape); build with --features live for a JSON-RPC read.");
}
