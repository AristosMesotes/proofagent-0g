//! Integration test for the settlement-truth LEDGER (design SS5a): journal -> ledger -> audit.
//!
//! These exercise the crate's PUBLIC surface exactly as the `verifier verify-tx` / `ledger` / `audit`
//! binary subcommands do: mint a verdict with [`verifier::verify_tx`], journal it as one append-only
//! redacted record ([`verifier::JournalRecord`]), then project that journal read-only
//! ([`verifier::project`] / [`verifier::LedgerSummary`]) and audit it ([`verifier::Audit`]). The
//! headline cases mirror the LIVE demo: a SETTLED transfer and the NEG (fabricated hash -> UNVERIFIED),
//! together in one journal, projected and audited.
//!
//! The invariants pinned here (the LEDGER doctrine, design SS5a / SS3 / SS8):
//!   - the journal is append-only and round-trips deterministically (no clock, no path, no secret);
//!   - the ledger projects ONLY the journal (never the agent's word, never the UI), in journal order;
//!   - a SETTLED row's delta is exact; an UNVERIFIED row's observation + delta are the loud "unavailable",
//!     never a fabricated 0;
//!   - the audit surfaces every non-`settled` row LOUDLY and is NOT clean when any defect is present;
//!   - a clean journal (every row settled) audits GREEN.

use verifier::{
    parse_journal, project, verify_tx, Audit, JournalRecord, LedgerSummary, Source, SpineConfig,
    Verdict,
};

/// The pinned LIVE-LOOP settled transfer (proofagent.toml [[verifier.corpus]]): claimed == observed
/// == 1_000_000 wei, recorded with its on-chain read so the offline tape replays a genuine settlement.
const HASH_SETTLED: &str = "0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0";
/// The NEG-case fabricated hash (demo/live_loop.sh FAKE_TX): well-formed, but not on-record.
const HASH_FABRICATED: &str = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";

/// A spine that mirrors the real `proofagent.toml`: the one pinned settled transfer (with its recorded
/// on-chain `observed`) + the 15% band. The offline tape it builds replays the genuine settlement.
fn live_spine() -> SpineConfig {
    let text = format!(
        "\
[chain]
id = 16602

[verifier.tolerance]
num = 15
den = 100

[[verifier.corpus]]
kind = \"TRANSFER\"
hash = \"{HASH_SETTLED}\"
claimed = \"1000000\"
observed = \"1000000\"
"
    );
    SpineConfig::parse(&text).expect("the live-mirror spine is well-formed")
}

/// Mint the two demo verdicts (SETTLED + NEG) and journal them, returning the parsed journal records
/// in mint order -- exactly what `verify-tx` appends, then `ledger`/`audit` read.
fn journal_the_demo() -> Vec<JournalRecord> {
    let config = live_spine();
    let mut text = String::new();

    // PROOF 1 -- SETTLED: the pinned transfer, replayed offline from the tape.
    let mut tape = config.tape_source();
    let settled = verify_tx(HASH_SETTLED, &config, &mut tape as &mut dyn Source).unwrap();
    assert_eq!(settled.verdict, Verdict::Settled, "the pinned transfer must settle");
    text.push_str(&JournalRecord::from_report(&settled).to_line());
    text.push('\n');

    // PROOF 3 -- NEG: a fabricated hash, off-record -> UNVERIFIED (never a fabricated settled).
    let mut tape2 = config.tape_source();
    let neg = verify_tx(HASH_FABRICATED, &config, &mut tape2 as &mut dyn Source).unwrap();
    assert_eq!(neg.verdict, Verdict::Unverified, "the fabricated hash must be unverified");
    text.push_str(&JournalRecord::from_report(&neg).to_line());
    text.push('\n');

    parse_journal(&text).expect("the journal we just wrote must parse back")
}

#[test]
fn journal_round_trips_the_demo_verdicts_deterministically() {
    // The journal we mint parses back to the same records, in order, byte-identically across runs.
    let first = journal_the_demo();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].verdict, Verdict::Settled);
    assert_eq!(first[0].kind, "TRANSFER");
    assert_eq!(first[0].claimed, 1_000_000);
    assert_eq!(first[0].observed, Some(1_000_000));
    assert_eq!(first[1].verdict, Verdict::Unverified);
    assert_eq!(first[1].observed, None, "the NEG row has no observation");
    for _ in 0..8 {
        assert_eq!(journal_the_demo(), first, "the demo journal is deterministic");
    }
}

#[test]
fn ledger_projects_claimed_vs_observed_verdict_and_exact_delta() {
    // Design SS5a §1: per tx claimed vs chain-observed minor units, the verdict, and the exact delta.
    let records = journal_the_demo();
    let rows = project(&records);
    assert_eq!(rows.len(), 2, "the ledger projects every journalled row, in order");

    // The SETTLED row: claimed == observed -> delta 0, verdict settled.
    let s = &rows[0];
    assert_eq!(s.claimed, 1_000_000);
    assert_eq!(s.observed, Some(1_000_000));
    assert_eq!(s.delta, Some(0));
    assert_eq!(s.verdict, Verdict::Settled);
    assert_eq!(s.observed_display(), "1000000");
    assert_eq!(s.delta_display(), "0");

    // The NEG row: no observation, no delta -> the loud "unavailable", NEVER a fabricated 0.
    let n = &rows[1];
    assert_eq!(n.observed, None);
    assert_eq!(n.delta, None);
    assert_eq!(n.observed_display(), "unavailable");
    assert_eq!(n.delta_display(), "unavailable");
    assert_eq!(n.verdict, Verdict::Unverified);
}

#[test]
fn audit_surfaces_the_neg_defect_loudly_and_is_not_clean() {
    // Design SS5a / SS8: the audit must surface the UNVERIFIED row loudly and must NOT be clean.
    let records = journal_the_demo();
    let audit = Audit::of(&records);
    assert!(!audit.is_clean(), "a journal carrying an unverified row is NOT a clean settlement record");
    assert_eq!(audit.defects.len(), 1, "exactly the NEG row is a defect");
    assert_eq!(audit.defects[0].verdict, Verdict::Unverified);
    assert_eq!(audit.summary.settled, 1);
    assert_eq!(audit.summary.unverified, 1);
    assert_eq!(audit.summary.defects(), 1);

    let text = audit.to_string();
    assert!(text.contains("audit RED"), "any defect makes the audit RED");
    assert!(text.contains("UNVERIFIED"), "the unverified defect must be named loudly");
    // The settlement truth is the journal's, not the agent's: the settled row is NOT a defect.
    assert!(!text.contains(HASH_SETTLED), "the settled row is not surfaced as a defect");
}

#[test]
fn a_journal_of_only_settled_rows_audits_green() {
    // The clean case: a journal where every row settled audits GREEN with no defects.
    let config = live_spine();
    let mut text = String::new();
    for _ in 0..3 {
        let mut tape = config.tape_source();
        let r = verify_tx(HASH_SETTLED, &config, &mut tape as &mut dyn Source).unwrap();
        text.push_str(&JournalRecord::from_report(&r).to_line());
        text.push('\n');
    }
    let records = parse_journal(&text).unwrap();
    let audit = Audit::of(&records);
    assert!(audit.is_clean(), "every row settled -> clean");
    assert_eq!(audit.summary.settled, 3);
    assert_eq!(audit.summary.defects(), 0);
    assert!(audit.to_string().contains("audit GREEN"));
    assert!(LedgerSummary::of(&records).status_line().starts_with("GREEN"));
}

#[test]
fn the_journal_is_redacted_no_path_or_secret_or_clock() {
    // Design SS6 / SS5a: the journal lines carry only the redacted verdict fields -- never a home path,
    // a secret, or a wall-clock field.
    let records = journal_the_demo();
    for r in &records {
        let line = r.to_line();
        for forbidden in [
            "PRIVATE_KEY", "WALLET_ADDRESS", "mnemonic", "seed phrase",
            "/Users/", "C:\\Users", "timestamp", "\"time\"", "\"date\"",
        ] {
            assert!(!line.contains(forbidden), "journal line must not contain {forbidden:?}: {line}");
        }
    }
}

#[test]
fn append_is_append_only_history_is_never_rewritten() {
    // Design SS5a: appending a second verdict ADDS a row; it never edits or deletes the first. We verify
    // the projection over an appended journal keeps the original row intact and in order.
    let config = live_spine();
    let mut tape = config.tape_source();
    let first = verify_tx(HASH_SETTLED, &config, &mut tape as &mut dyn Source).unwrap();
    let mut journal = String::new();
    journal.push_str(&JournalRecord::from_report(&first).to_line());
    journal.push('\n');
    let after_one = parse_journal(&journal).unwrap();
    assert_eq!(after_one.len(), 1);

    // Append a NEG verdict.
    let mut tape2 = config.tape_source();
    let neg = verify_tx(HASH_FABRICATED, &config, &mut tape2 as &mut dyn Source).unwrap();
    journal.push_str(&JournalRecord::from_report(&neg).to_line());
    journal.push('\n');
    let after_two = parse_journal(&journal).unwrap();

    assert_eq!(after_two.len(), 2);
    assert_eq!(after_two[0], after_one[0], "the first row is unchanged after appending");
    assert_eq!(after_two[1].verdict, Verdict::Unverified, "the appended row is the new one");
}
