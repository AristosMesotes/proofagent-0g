//! The data spine -- `proofagent.toml` read into a [`SpineConfig`] (corpus + tolerance).
//!
//! Design SS4 (the architecture / data spine): "`proofagent.toml` -- data spine -- chain, RPC (via
//! env), corpus, registry address, checks." Design SS4 module note: the verifier "carries a corpus of
//! real, already-settled transactions so the demo verifies genuine settlements." STEP VS4 reads two
//! of those spine fields -- the verifier **corpus** and the exact-integer **tolerance** -- so
//! `verify-tx <hash>` can look up the claim recorded for a hash and adjudicate it against an
//! independent on-chain read.
//!
//! Design SS3 principle 5 (exact-integer money): the tolerance is `num / den` integers and every
//! corpus `claimed` amount is parsed from a decimal **string** straight to `i128` -- there is NO
//! `f32`/`f64` anywhere in this module, so a minor-unit amount wider than `i64` (e.g. an 18-decimal
//! `W0G` value) is read exactly, never through a lossy float.
//!
//! Design SS3 principle 4 (deterministic): parsing is pure over the file bytes -- no env, no
//! wall-clock -- so the same spine always yields the same [`SpineConfig`]. Corpus order is preserved
//! as written.
//!
//! Design SS3 principle 3 (never fabricate): a malformed spine, a bad amount, or a bad hash is a
//! *loud* [`ConfigError`] -- it never degrades into a usable-but-wrong claim that could mint a
//! fabricated `Settled`. (An off-corpus *hash*, by contrast, is a normal "no claim recorded" outcome
//! handled by the caller, not a parse error.)
//!
//! ## Why a focused std-only reader (not a TOML crate)
//!
//! The default build is std-only and offline by construction (design SS6 + the VS1-VS3 pattern: zero
//! default dependencies, the only optional dep -- `ureq` -- is behind the `live` feature). This reader
//! parses exactly the narrow spine subset the verifier consumes -- `[verifier.tolerance]` and the
//! `[[verifier.corpus]]` entries -- and rejects anything it does not understand, rather than pull a
//! general TOML parser into the money-path crate. It is intentionally minimal and fully covered by
//! tests; it is **not** a general TOML implementation.

use crate::{Observation, ReadKey, Ratio, TapeSource};
use core::fmt;

/// The verifier's view of the data spine: the tolerance band and the claim corpus.
///
/// Design SS4: the two spine fields STEP VS4's `verify-tx` consumes. Built by [`SpineConfig::parse`]
/// from the `proofagent.toml` text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpineConfig {
    tolerance: Ratio,
    corpus: Vec<CorpusEntry>,
}

/// One recorded claim in the verifier corpus.
///
/// Design SS4 module note: the corpus is "real, already-settled transactions." Each entry is the
/// agent's recorded **Claim** for one transaction (design SS3 principle 1, two-source truth) -- a
/// `kind` label, the transaction `hash` (the [`ReadKey`] the independent read is keyed by), and the
/// `claimed` amount in minor units that the independent on-chain **Observation** is adjudicated
/// against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusEntry {
    kind: String,
    key: ReadKey,
    claimed: i128,
    observed: Option<i128>,
}

impl CorpusEntry {
    /// The trade kind label (e.g. `BUY` / `SELL` / `SWAP`) -- for the journal, not the verdict.
    #[must_use]
    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// The normalized transaction-hash read key this claim is recorded against.
    #[must_use]
    pub fn key(&self) -> &ReadKey {
        &self.key
    }

    /// The claimed amount in minor units (the agent's word -- never trusted on its own).
    #[must_use]
    pub fn claimed(&self) -> i128 {
        self.claimed
    }

    /// The OPTIONAL recorded independent on-chain read for this transaction, in minor units.
    ///
    /// Design SS3 principle 1 (two-source truth) + SS4 module note ("a corpus of real, already-settled
    /// transactions"): this is the *recorded chain read* -- the **Observation**, deliberately distinct
    /// from [`Self::claimed`] (the agent's word). It exists so the default **offline** build can seed a
    /// deterministic [`TapeSource`] (via [`SpineConfig::tape_source`]) and replay a genuine settlement
    /// without a network.
    ///
    /// `None` means no read is recorded for this entry -- the honest state of the real spine today
    /// (its corpus is empty / unrecorded). An entry with no recorded read is **omitted from the
    /// offline tape**, so its read is off-tape and adjudicates to [`crate::Verdict::Unverified`] --
    /// never a fabricated `Settled` (design SS3 principle 3). A live read (`live` feature) ignores this
    /// field entirely and reads the chain itself.
    #[must_use]
    pub fn observed(&self) -> Option<i128> {
        self.observed
    }
}

impl SpineConfig {
    /// The exact-integer tolerance band (design SS3 principle 5).
    #[must_use]
    pub fn tolerance(&self) -> Ratio {
        self.tolerance
    }

    /// The recorded claim corpus, in spine order (design SS3 principle 4, deterministic).
    #[must_use]
    pub fn corpus(&self) -> &[CorpusEntry] {
        &self.corpus
    }

    /// Build a deterministic, offline [`TapeSource`] from the corpus's *recorded* on-chain reads.
    ///
    /// Design SS3 principle 4 (deterministic) + the Source/Tape pivot (design SS6, offline-by-default):
    /// each corpus entry that carries a recorded [`CorpusEntry::observed`] becomes one tape slot keyed
    /// by its hash. An entry with **no** recorded read is *omitted* -- so the default offline build's
    /// read for it is off-tape and adjudicates to [`crate::Verdict::Unverified`], never a fabricated
    /// `Settled` (design SS3 principle 3). This is the source the default `verify-tx` binds; the
    /// `live` build binds a real JSON-RPC reader instead and ignores these recordings.
    #[must_use]
    pub fn tape_source(&self) -> TapeSource {
        let mut tape = TapeSource::new();
        for e in &self.corpus {
            if let Some(value) = e.observed {
                tape.record(e.key.clone(), Observation::new(value));
            }
        }
        tape
    }

    /// Look up the recorded claim for a transaction hash, if the spine has one.
    ///
    /// `None` means "no claim is recorded for this hash" -- a normal outcome (the corpus is a finite
    /// set of pinned transactions), NOT a parse error and NOT a verdict. The caller decides what to do
    /// (STEP VS4's CLI treats an unknown hash as a usage error, distinct from any verdict, so an
    /// unknown hash can never be mistaken for a settlement -- design SS3 principle 3).
    #[must_use]
    pub fn claim_for(&self, key: &ReadKey) -> Option<&CorpusEntry> {
        self.corpus.iter().find(|e| e.key == *key)
    }

    /// Parse the verifier's spine view from `proofagent.toml` text.
    ///
    /// Reads `[verifier.tolerance]` (`num` / `den`, integers) and every `[[verifier.corpus]]` table
    /// (`kind`, `hash`, `claimed`). An empty / absent corpus is valid -- it yields an empty corpus, so
    /// the verifier honestly has no pinned claims (every `verify-tx` then reports an unknown hash,
    /// never a fabricated settlement). A malformed field is a loud [`ConfigError`].
    ///
    /// Design SS3 principle 5: `num` / `den` / `claimed` are parsed as exact integers -- no float ever
    /// touches the money path.
    pub fn parse(text: &str) -> Result<SpineConfig, ConfigError> {
        let mut tol_num: Option<i128> = None;
        let mut tol_den: Option<i128> = None;
        let mut corpus: Vec<CorpusEntry> = Vec::new();

        // A minimal section-aware line walk over the narrow spine subset. We track only whether we are
        // inside `[verifier.tolerance]` (a single table) or a `[[verifier.corpus]]` entry (an array of
        // tables); every other section is skipped. This is deliberately not a general TOML parser.
        #[derive(PartialEq)]
        enum Section {
            Other,
            Tolerance,
        }
        let mut section = Section::Other;
        // The corpus entry currently being assembled (its fields arrive on following lines).
        let mut pending: Option<PendingCorpus> = None;

        for (idx, raw) in text.lines().enumerate() {
            let lineno = idx + 1;
            let line = strip_comment(raw).trim();
            if line.is_empty() {
                continue;
            }

            if let Some(header) = line.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
                // An array-of-tables header. Flush any in-progress corpus entry first.
                flush_corpus(&mut pending, &mut corpus, lineno)?;
                section = Section::Other;
                if header.trim() == "verifier.corpus" {
                    pending = Some(PendingCorpus::default());
                }
                continue;
            }
            if let Some(header) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                // A plain table header. Flush any in-progress corpus entry first.
                flush_corpus(&mut pending, &mut corpus, lineno)?;
                section = if header.trim() == "verifier.tolerance" {
                    Section::Tolerance
                } else {
                    Section::Other
                };
                continue;
            }

            // A `key = value` line. Split on the FIRST '=' only.
            let Some((key, value)) = line.split_once('=') else {
                // Not a header and not an assignment -- a shape this reader does not model.
                return Err(ConfigError::Malformed { line: lineno, text: line.to_string() });
            };
            let key = key.trim();
            let value = value.trim();

            if section == Section::Tolerance {
                match key {
                    "num" => tol_num = Some(parse_i128(value, lineno, "verifier.tolerance.num")?),
                    "den" => tol_den = Some(parse_i128(value, lineno, "verifier.tolerance.den")?),
                    _ => {} // ignore unrecognized tolerance keys (forward-compatible)
                }
            } else if let Some(p) = pending.as_mut() {
                match key {
                    "kind" => p.kind = Some(parse_string(value, lineno, "verifier.corpus.kind")?),
                    "hash" => p.hash = Some(parse_string(value, lineno, "verifier.corpus.hash")?),
                    "claimed" => {
                        // Accept a quoted decimal string OR a bare integer; both parse to exact i128.
                        let inner = unquote(value).unwrap_or(value);
                        p.claimed =
                            Some(parse_i128(inner, lineno, "verifier.corpus.claimed")?);
                    }
                    "observed" => {
                        // OPTIONAL recorded on-chain read (the Observation), seeds the offline tape.
                        let inner = unquote(value).unwrap_or(value);
                        p.observed =
                            Some(parse_i128(inner, lineno, "verifier.corpus.observed")?);
                    }
                    _ => {} // ignore unrecognized corpus keys (forward-compatible)
                }
            }
            // Assignments outside both sections (e.g. `[chain]` fields) are simply skipped.
        }
        // Flush a trailing corpus entry at EOF.
        flush_corpus(&mut pending, &mut corpus, text.lines().count())?;

        let (num, den) = match (tol_num, tol_den) {
            (Some(n), Some(d)) => (n, d),
            _ => return Err(ConfigError::MissingTolerance),
        };
        let tolerance = Ratio::new(num, den).ok_or(ConfigError::BadTolerance { num, den })?;

        Ok(SpineConfig { tolerance, corpus })
    }
}

/// A corpus entry under construction as its `key = value` lines are read.
#[derive(Default)]
struct PendingCorpus {
    kind: Option<String>,
    hash: Option<String>,
    claimed: Option<i128>,
    observed: Option<i128>,
}

/// Finalize the pending corpus entry (if any) into a [`CorpusEntry`], or error loudly if it is
/// incomplete / malformed. Clears `pending` either way.
fn flush_corpus(
    pending: &mut Option<PendingCorpus>,
    corpus: &mut Vec<CorpusEntry>,
    lineno: usize,
) -> Result<(), ConfigError> {
    let Some(p) = pending.take() else {
        return Ok(());
    };
    let kind = p.kind.ok_or(ConfigError::IncompleteCorpus { line: lineno, field: "kind" })?;
    let hash = p.hash.ok_or(ConfigError::IncompleteCorpus { line: lineno, field: "hash" })?;
    let claimed =
        p.claimed.ok_or(ConfigError::IncompleteCorpus { line: lineno, field: "claimed" })?;
    // Normalize the hash to the one canonical read-key shape; a malformed hash is loud, never a
    // silently-wrong key (design SS3 principle 3).
    let key = ReadKey::new(&hash).ok_or(ConfigError::BadHash { line: lineno, hash })?;
    // `observed` is optional (see CorpusEntry::observed); absence means "no recorded read" -> the
    // entry is omitted from the offline tape -> off-tape -> Unverified.
    corpus.push(CorpusEntry { kind, key, claimed, observed: p.observed });
    Ok(())
}

/// Strip a `#` line comment, but only when the `#` is OUTSIDE a double-quoted string (so a `#` inside
/// a quoted hash/label is preserved). Returns the comment-free prefix.
fn strip_comment(line: &str) -> &str {
    let mut in_quote = false;
    for (i, b) in line.bytes().enumerate() {
        match b {
            b'"' => in_quote = !in_quote,
            b'#' if !in_quote => return &line[..i],
            _ => {}
        }
    }
    line
}

/// Strip surrounding double quotes from a value, if present. `None` if the value is not quoted.
fn unquote(value: &str) -> Option<&str> {
    value.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
}

/// Parse a required double-quoted string value.
fn parse_string(value: &str, line: usize, field: &'static str) -> Result<String, ConfigError> {
    unquote(value)
        .map(str::to_string)
        .ok_or(ConfigError::BadString { line, field })
}

/// Parse an exact `i128` from a (possibly underscore-grouped) decimal integer literal.
///
/// Design SS3 principle 5: this is the ONLY numeric ingest for money/tolerance, and it is integer-only
/// -- a value with a decimal point or any non-digit (after stripping a leading sign and `_` grouping)
/// is rejected, so no float can sneak onto the money path.
fn parse_i128(value: &str, line: usize, field: &'static str) -> Result<i128, ConfigError> {
    // Allow TOML-style `_` digit grouping (e.g. `1_000_000`); strip it before parsing.
    let cleaned: String = value.chars().filter(|&c| c != '_').collect();
    cleaned
        .parse::<i128>()
        .map_err(|_| ConfigError::BadInteger { line, field, value: value.to_string() })
}

/// A loud, deterministic spine-parse failure (design SS3 principle 3: never silently proceed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// A non-empty line that is neither a header nor a `key = value` assignment.
    Malformed {
        /// 1-based line number.
        line: usize,
        /// The offending (comment-stripped) line text.
        text: String,
    },
    /// A `[verifier.tolerance]` was not found (both `num` and `den` are required).
    MissingTolerance,
    /// The tolerance `num`/`den` parsed but is not a well-formed [`Ratio`] (e.g. `den <= 0`).
    BadTolerance {
        /// The parsed numerator.
        num: i128,
        /// The parsed denominator.
        den: i128,
    },
    /// A `[[verifier.corpus]]` entry is missing a required field.
    IncompleteCorpus {
        /// 1-based line number where the entry was finalized.
        line: usize,
        /// The missing field name.
        field: &'static str,
    },
    /// A field expected to be a quoted string was not quoted.
    BadString {
        /// 1-based line number.
        line: usize,
        /// The field name.
        field: &'static str,
    },
    /// A field expected to be an exact integer did not parse.
    BadInteger {
        /// 1-based line number.
        line: usize,
        /// The field name.
        field: &'static str,
        /// The offending value text.
        value: String,
    },
    /// A corpus `hash` was not a well-formed 32-byte transaction hash.
    BadHash {
        /// 1-based line number.
        line: usize,
        /// The offending hash text.
        hash: String,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Malformed { line, text } => {
                write!(f, "spine line {line}: not a header or assignment: {text:?}")
            }
            ConfigError::MissingTolerance => {
                write!(f, "spine: missing [verifier.tolerance] (num and den are required)")
            }
            ConfigError::BadTolerance { num, den } => {
                write!(f, "spine: ill-formed tolerance {num}/{den} (den must be > 0, num >= 0)")
            }
            ConfigError::IncompleteCorpus { line, field } => {
                write!(f, "spine line {line}: [[verifier.corpus]] entry missing `{field}`")
            }
            ConfigError::BadString { line, field } => {
                write!(f, "spine line {line}: `{field}` must be a double-quoted string")
            }
            ConfigError::BadInteger { line, field, value } => {
                write!(f, "spine line {line}: `{field}` must be an integer, got {value:?}")
            }
            ConfigError::BadHash { line, hash } => {
                write!(f, "spine line {line}: `hash` is not a 32-byte tx hash: {hash:?}")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Source, Verdict};

    const HASH_A: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";

    /// A spine with one BUY corpus entry and the canonical 15% band.
    fn spine_one_entry() -> &'static str {
        "\
[chain]
id = 16661

[verifier]
# leading comment
corpus = []          # this inline form is ignored; the [[..]] tables below are the corpus

[[verifier.corpus]]
kind = \"BUY\"
hash = \"0xABC0000000000000000000000000000000000000000000000000000000000001\"
claimed = \"1000\"

[verifier.tolerance]
num = 15
den = 100
"
    }

    #[test]
    fn parses_tolerance_and_one_corpus_entry() {
        let cfg = SpineConfig::parse(spine_one_entry()).expect("well-formed spine");
        assert_eq!(cfg.tolerance(), Ratio::new(15, 100).unwrap());
        assert_eq!(cfg.corpus().len(), 1);
        let e = &cfg.corpus()[0];
        assert_eq!(e.kind(), "BUY");
        assert_eq!(e.claimed(), 1_000);
        // The hash is normalized to canonical lowercase 0x form.
        assert_eq!(e.key(), &ReadKey::new(HASH_A).unwrap());
    }

    #[test]
    fn claim_for_finds_by_normalized_hash() {
        let cfg = SpineConfig::parse(spine_one_entry()).unwrap();
        // Look up using a DIFFERENTLY-cased / unprefixed hash; normalization must still match.
        let key = ReadKey::new("ABC0000000000000000000000000000000000000000000000000000000000001").unwrap();
        let entry = cfg.claim_for(&key).expect("claim recorded for this hash");
        assert_eq!(entry.claimed(), 1_000);
        // An unrecorded hash yields None -- a normal "no claim", not an error.
        let other = ReadKey::new("0xdef0000000000000000000000000000000000000000000000000000000000002").unwrap();
        assert!(cfg.claim_for(&other).is_none());
    }

    #[test]
    fn empty_corpus_is_valid() {
        let cfg = SpineConfig::parse(
            "[verifier.tolerance]\nnum = 15\nden = 100\n",
        )
        .unwrap();
        assert!(cfg.corpus().is_empty());
        assert_eq!(cfg.tolerance(), Ratio::new(15, 100).unwrap());
    }

    #[test]
    fn claimed_accepts_bare_integer_and_underscores() {
        let text = "\
[[verifier.corpus]]
kind = \"SWAP\"
hash = \"0xabc0000000000000000000000000000000000000000000000000000000000001\"
claimed = 1_000_000

[verifier.tolerance]
num = 0
den = 1
";
        let cfg = SpineConfig::parse(text).unwrap();
        assert_eq!(cfg.corpus()[0].claimed(), 1_000_000);
    }

    #[test]
    fn claimed_parses_amounts_wider_than_i64_exactly() {
        // Design SS3 principle 5: an 18-decimal W0G amount exceeds i64; it must round-trip exactly as
        // i128 with no float. 5 * 10^18 = 5_000_000_000_000_000_000 > i64::MAX (~9.2e18 is the i64 max,
        // but 10 W0G = 10e18 exceeds it).
        let text = "\
[[verifier.corpus]]
kind = \"SELL\"
hash = \"0xabc0000000000000000000000000000000000000000000000000000000000001\"
claimed = \"10000000000000000000\"

[verifier.tolerance]
num = 15
den = 100
";
        let cfg = SpineConfig::parse(text).unwrap();
        assert_eq!(cfg.corpus()[0].claimed(), 10_000_000_000_000_000_000_i128);
        assert!(cfg.corpus()[0].claimed() > i64::MAX as i128);
    }

    #[test]
    fn rejects_missing_tolerance() {
        let err = SpineConfig::parse("[chain]\nid = 1\n").unwrap_err();
        assert_eq!(err, ConfigError::MissingTolerance);
    }

    #[test]
    fn rejects_ill_formed_tolerance() {
        let err = SpineConfig::parse("[verifier.tolerance]\nnum = 15\nden = 0\n").unwrap_err();
        assert_eq!(err, ConfigError::BadTolerance { num: 15, den: 0 });
    }

    #[test]
    fn rejects_float_claimed_amount() {
        // A decimal point must be rejected -- no float on the money path (design SS3 principle 5).
        let text = "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"0xabc0000000000000000000000000000000000000000000000000000000000001\"
claimed = \"10.5\"

[verifier.tolerance]
num = 15
den = 100
";
        let err = SpineConfig::parse(text).unwrap_err();
        assert!(matches!(err, ConfigError::BadInteger { field: "verifier.corpus.claimed", .. }));
    }

    #[test]
    fn rejects_incomplete_corpus_entry() {
        // Missing `claimed`.
        let text = "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"0xabc0000000000000000000000000000000000000000000000000000000000001\"

[verifier.tolerance]
num = 15
den = 100
";
        let err = SpineConfig::parse(text).unwrap_err();
        assert!(matches!(err, ConfigError::IncompleteCorpus { field: "claimed", .. }));
    }

    #[test]
    fn rejects_bad_hash() {
        let text = "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"0xnothex\"
claimed = \"1000\"

[verifier.tolerance]
num = 15
den = 100
";
        let err = SpineConfig::parse(text).unwrap_err();
        assert!(matches!(err, ConfigError::BadHash { .. }));
    }

    #[test]
    fn comment_inside_quotes_is_preserved() {
        // A `#` inside a quoted value is NOT a comment. (No spine field legitimately needs one, but
        // the stripper must not corrupt a quoted value that contains it.)
        assert_eq!(strip_comment("kind = \"a#b\"  # trailing"), "kind = \"a#b\"  ");
        assert_eq!(strip_comment("num = 15 # band"), "num = 15 ");
    }

    #[test]
    fn parse_is_deterministic_and_preserves_order() {
        let text = "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"0xabc0000000000000000000000000000000000000000000000000000000000001\"
claimed = \"1\"

[[verifier.corpus]]
kind = \"SELL\"
hash = \"0xdef0000000000000000000000000000000000000000000000000000000000002\"
claimed = \"2\"

[verifier.tolerance]
num = 15
den = 100
";
        let a = SpineConfig::parse(text).unwrap();
        let b = SpineConfig::parse(text).unwrap();
        assert_eq!(a, b, "same text -> identical config (deterministic)");
        // Order preserved as written.
        assert_eq!(a.corpus()[0].kind(), "BUY");
        assert_eq!(a.corpus()[1].kind(), "SELL");
    }

    #[test]
    fn the_repo_spine_parses() {
        // The real proofagent.toml (empty corpus + 15% band) must parse -- this guards the data-spine
        // shape the CLI reads at runtime. We re-embed only the verifier-relevant subset here so the
        // test stays hermetic (it does not read the filesystem), matching the real spine's values.
        let text = "\
[verifier]
corpus = []

[verifier.tolerance]
num = 15
den = 100
";
        let cfg = SpineConfig::parse(text).unwrap();
        assert!(cfg.corpus().is_empty());
        assert_eq!(cfg.tolerance(), Ratio::new(15, 100).unwrap());
    }

    #[test]
    fn end_to_end_corpus_claim_adjudicates_settled_within_band() {
        // Pull a claim from the parsed corpus and adjudicate it against an in-band observation -- the
        // money path the CLI runs. claimed 1000, observed 1100, 15% band -> Settled.
        let cfg = SpineConfig::parse(spine_one_entry()).unwrap();
        let entry = &cfg.corpus()[0];
        let verdict = crate::adjudicate(entry.claimed(), Some(1_100), cfg.tolerance());
        assert_eq!(verdict, Verdict::Settled);
    }

    #[test]
    fn observed_is_optional_and_defaults_to_none() {
        // The real spine omits `observed`; the entry parses with observed == None.
        let cfg = SpineConfig::parse(spine_one_entry()).unwrap();
        assert_eq!(cfg.corpus()[0].observed(), None);
    }

    #[test]
    fn observed_when_present_seeds_the_offline_tape() {
        // An entry WITH a recorded `observed` puts exactly one slot on the offline tape, keyed by the
        // canonical hash -- so the default build can replay a real settlement with no network.
        let text = format!(
            "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"{HASH_A}\"
claimed = \"1000\"
observed = \"1100\"

[verifier.tolerance]
num = 15
den = 100
"
        );
        let cfg = SpineConfig::parse(&text).unwrap();
        assert_eq!(cfg.corpus()[0].observed(), Some(1_100));
        let mut tape = cfg.tape_source();
        assert_eq!(tape.len(), 1);
        let key = ReadKey::new(HASH_A).unwrap();
        assert_eq!(crate::observed_amount(&tape.read(&key)), Some(1_100));
    }

    #[test]
    fn entry_without_observed_is_omitted_from_the_tape() {
        // An entry with NO recorded read is omitted -> its read is off-tape -> Unverified (never a
        // fabricated Settled). Design SS3 principle 3.
        let cfg = SpineConfig::parse(spine_one_entry()).unwrap();
        let tape = cfg.tape_source();
        assert!(tape.is_empty(), "no recorded read -> no tape slot");
    }
}
