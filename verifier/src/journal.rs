//! The settlement-truth journal -- the append-only, deterministic, redacted record of verdicts.
//!
//! Design SS5a (the settlement-truth LEDGER): "Every verdict the verifier mints is appended as one
//! canonical record to a verdict **journal**. A record carries exactly the fields needed to reproduce
//! and audit the verdict ... and **nothing else**: no wall-clock, no home filesystem path, no key, no
//! secret." This module owns that record -- [`JournalRecord`] -- plus the deterministic serialization
//! to one canonical JSONL line ([`JournalRecord::to_line`]) and the strict parse back
//! ([`JournalRecord::parse_line`]). The ledger projection and the audit (SS5a) read from this, never
//! from the agent's report or the UI.
//!
//! ## Why one canonical line, std-only, hand-rolled (no serde on the money path)
//!
//! Design SS6 (offline-by-default clean room): the default verifier build pulls in **zero**
//! dependencies. The journal must round-trip in that default build, so it is a tiny, fully-tested,
//! std-only JSON-object encoder/decoder for exactly the flat record shape below -- never a general
//! JSON implementation. Keeping it in-crate also keeps the **redaction** invariant (design SS5a + SS6)
//! auditable in one place: the record type physically *cannot* hold a path or a secret, because its
//! only fields are the hash, the kind, the two exact-integer amounts, the `recorded` flag, and the
//! verdict string.
//!
//! ## Determinism (design SS3 principle 4)
//!
//! A record serializes to a byte-identical line every time: the keys are written in a fixed order, the
//! amounts are exact `i128` decimals (no float, design SS3 principle 5), the verdict is its canonical
//! snake_case string (design SS2), and there is **no timestamp** -- nothing wall-clock-derived. So the
//! same verdict always journals to the same bytes, and the same journal always projects to the same
//! ledger. (The `Date` column of the human `LEDGER.md` comes from the on-chain block, not from the
//! machine clock -- it is never journalled here.)
//!
//! ## Append-only (design SS5a)
//!
//! The journal is a sequence of these lines, one per verdict, in the order verdicts were minted. A
//! later run *appends* rows; it never edits or deletes one. [`append_record`] enforces exactly that --
//! it opens the journal file in append mode and writes one `\n`-terminated line, so history is
//! immutable by construction (no seek, no truncate, no rewrite).

use crate::{Verdict, VerifyReport};
use core::fmt;

/// One append-only journal record -- the canonical, redacted form of a single verdict.
///
/// Design SS5a: this is the *only* shape the journal stores. It is deliberately flat and minimal so it
/// cannot carry a home path, a key, or a secret -- only the fields needed to reproduce and audit the
/// verdict (design SS6 clean-room redaction). It is built solely from a [`VerifyReport`] (the verdict
/// monopoly's output, design SS3 principle 2), so a journal row can only exist because the verifier
/// minted the verdict it records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRecord {
    /// The canonical `0x`-lowercase transaction hash the verdict is about.
    pub hash: String,
    /// The trade-kind label (journal only, never the verdict). [`crate::UNKNOWN_KIND`] for an
    /// off-record / fabricated hash.
    pub kind: String,
    /// The agent's claimed amount in minor units (the **Claim**, design SS3 principle 1).
    pub claimed: i128,
    /// The independently-observed on-chain amount in minor units (the **Observation**), or `None`
    /// when the chain could not be read -- the loud absence that adjudicated to `unverified`
    /// (design SS3 principle 3).
    pub observed: Option<i128>,
    /// Whether a claim for this hash was on-record in the corpus (vs. a fabricated / unknown hash).
    pub recorded: bool,
    /// The minted verdict (design SS2 alphabet). Stored as its canonical snake_case string on the wire.
    pub verdict: Verdict,
}

impl JournalRecord {
    /// Build a journal record from a verdict report -- the only constructor.
    ///
    /// Design SS5a + SS3 principle 2: the record is derived entirely from a [`VerifyReport`] (the
    /// verifier's own minted output), so journalling cannot invent a row the verifier did not mint, and
    /// the record copies *only* the redacted fields -- never anything path- or secret-shaped.
    #[must_use]
    pub fn from_report(report: &VerifyReport) -> JournalRecord {
        JournalRecord {
            hash: report.hash.clone(),
            kind: report.kind.clone(),
            claimed: report.claimed,
            observed: report.observed,
            recorded: report.recorded,
            verdict: report.verdict,
        }
    }

    /// The exact-integer settlement delta `claimed - observed`, in minor units, or `None` when the
    /// chain read was unavailable.
    ///
    /// Design SS3 principle 5 (exact-integer money): a pure `i128` subtraction, no float. `None` mirrors
    /// an unavailable observation (the `unverified` degrade) -- the ledger renders it as the loud
    /// "unavailable", never as a fabricated `0` delta. Uses checked arithmetic so an extreme pair can
    /// never wrap into a misleading small delta (it surfaces as `None`, an honest "not representable").
    #[must_use]
    pub fn delta(&self) -> Option<i128> {
        self.observed.and_then(|o| self.claimed.checked_sub(o))
    }

    /// `true` iff this record's verdict is the honest success `settled` (design SS2 / SS3 principle 3).
    /// Everything else (`hollow` / `mismatch` / `unverified`) is a defect the audit surfaces loudly.
    #[must_use]
    pub fn is_settled(&self) -> bool {
        self.verdict.is_settled()
    }

    /// Serialize to the one canonical JSONL line (no trailing newline).
    ///
    /// Design SS3 principle 4 (deterministic): a fixed key order, exact-integer decimals, the canonical
    /// verdict string, and NO timestamp -> a byte-identical line every time. The `observed` field is
    /// JSON `null` for an unavailable read (the loud absence), never a fabricated number.
    #[must_use]
    pub fn to_line(&self) -> String {
        // Fixed key order (determinism). `hash`, `kind`, `verdict` are simple snake/hex tokens that
        // need no escaping; we still escape defensively so an unexpected `kind` can never break a line.
        let observed = match self.observed {
            Some(v) => v.to_string(),
            None => "null".to_string(),
        };
        format!(
            "{{\"hash\":\"{}\",\"kind\":\"{}\",\"claimed\":{},\"observed\":{},\"recorded\":{},\"verdict\":\"{}\"}}",
            json_escape(&self.hash),
            json_escape(&self.kind),
            self.claimed,
            observed,
            self.recorded,
            self.verdict.canonical_string(),
        )
    }

    /// Parse one canonical JSONL line back into a record (strict; a malformed line is a loud error).
    ///
    /// Design SS3 principle 3 (never fabricate): a malformed or ambiguous line is a [`JournalError`],
    /// never a silently-wrong record that could understate a defect. The parser accepts exactly the
    /// shape [`Self::to_line`] emits (the six keys, in any order), and rejects unknown verdict strings,
    /// non-integer amounts, and missing keys.
    pub fn parse_line(line: &str) -> Result<JournalRecord, JournalError> {
        let trimmed = line.trim();
        let inner = trimmed
            .strip_prefix('{')
            .and_then(|s| s.strip_suffix('}'))
            .ok_or_else(|| JournalError::Malformed { text: trimmed.to_string() })?;

        let mut hash: Option<String> = None;
        let mut kind: Option<String> = None;
        let mut claimed: Option<i128> = None;
        let mut observed: Option<Option<i128>> = None;
        let mut recorded: Option<bool> = None;
        let mut verdict: Option<Verdict> = None;

        for (key, raw) in split_top_level_pairs(inner)? {
            match key.as_str() {
                "hash" => hash = Some(parse_json_string(&raw)?),
                "kind" => kind = Some(parse_json_string(&raw)?),
                "claimed" => claimed = Some(parse_json_i128(&raw)?),
                "observed" => {
                    observed = Some(if raw.trim() == "null" {
                        None
                    } else {
                        Some(parse_json_i128(&raw)?)
                    });
                }
                "recorded" => recorded = Some(parse_json_bool(&raw)?),
                "verdict" => verdict = Some(parse_verdict(&parse_json_string(&raw)?)?),
                _ => {} // forward-compatible: ignore unknown keys rather than fail the whole journal
            }
        }

        Ok(JournalRecord {
            hash: hash.ok_or(JournalError::MissingKey { key: "hash" })?,
            kind: kind.ok_or(JournalError::MissingKey { key: "kind" })?,
            claimed: claimed.ok_or(JournalError::MissingKey { key: "claimed" })?,
            observed: observed.ok_or(JournalError::MissingKey { key: "observed" })?,
            recorded: recorded.ok_or(JournalError::MissingKey { key: "recorded" })?,
            verdict: verdict.ok_or(JournalError::MissingKey { key: "verdict" })?,
        })
    }
}

/// Parse a whole journal (one record per non-empty line) into records, in journal order.
///
/// Design SS5a (append-only, in mint order): the journal is a sequence of lines; this preserves their
/// order exactly. Blank lines are skipped (a trailing newline is normal); a malformed line is a loud
/// [`JournalError`] that names the 1-based line number, never a silently-dropped row.
pub fn parse_journal(text: &str) -> Result<Vec<JournalRecord>, JournalError> {
    let mut out = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let rec = JournalRecord::parse_line(raw)
            .map_err(|e| JournalError::AtLine { line: idx + 1, source: Box::new(e) })?;
        out.push(rec);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Append-only persistence (design SS5a). The ONLY write path: open in append mode, write one line.
// No seek, no truncate, no rewrite -- so journalled history is immutable by construction.
// ---------------------------------------------------------------------------------------------

/// Append one verdict record to the journal file at `path`, creating it if absent.
///
/// Design SS5a (append-only): opens the file with `append(true)` and writes exactly one
/// `\n`-terminated canonical line, so a later run only ever *adds* rows -- it never edits or deletes
/// one. Returns the line that was written (for the caller to echo), or an I/O error.
pub fn append_record(path: &std::path::Path, record: &JournalRecord) -> std::io::Result<String> {
    use std::io::Write;
    let mut line = record.to_line();
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")?;
    line.push('\n');
    Ok(line)
}

/// A loud, deterministic journal parse failure (design SS3 principle 3: never silently proceed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    /// A line is not a single `{...}` JSON object.
    Malformed {
        /// The offending (trimmed) line text.
        text: String,
    },
    /// A required key was absent from a record.
    MissingKey {
        /// The missing key name.
        key: &'static str,
    },
    /// A value was not the expected JSON shape (string / integer / bool / known verdict).
    BadValue {
        /// What was expected.
        expected: &'static str,
        /// The offending raw value text.
        got: String,
    },
    /// A failure tied to a specific 1-based journal line number.
    AtLine {
        /// 1-based line number.
        line: usize,
        /// The underlying error.
        source: Box<JournalError>,
    },
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JournalError::Malformed { text } => {
                write!(f, "journal: not a single JSON object: {text:?}")
            }
            JournalError::MissingKey { key } => write!(f, "journal: record missing key `{key}`"),
            JournalError::BadValue { expected, got } => {
                write!(f, "journal: expected {expected}, got {got:?}")
            }
            JournalError::AtLine { line, source } => write!(f, "journal line {line}: {source}"),
        }
    }
}

impl std::error::Error for JournalError {}

// ---------------------------------------------------------------------------------------------
// The tiny, std-only JSON helpers -- exactly the flat-object subset the record needs (design SS6).
// Not a general JSON implementation; fully tested for the shapes `to_line` emits.
// ---------------------------------------------------------------------------------------------

/// Minimal JSON string escaping for the values we emit (hash / kind / verdict are simple tokens, but
/// we escape `"` and `\` and control chars defensively so a record can never produce a broken line).
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Split the inside of a `{...}` object into `(key, raw_value)` pairs at top-level commas/colons.
///
/// "Top-level" means not inside a double-quoted string. Our records are flat (no nested objects or
/// arrays), so this is sufficient and total over the shape `to_line` emits; an unbalanced quote is a
/// loud [`JournalError::Malformed`].
fn split_top_level_pairs(inner: &str) -> Result<Vec<(String, String)>, JournalError> {
    let mut pairs = Vec::new();
    for field in split_top_level_commas(inner)? {
        let field = field.trim();
        if field.is_empty() {
            continue;
        }
        let (k, v) = split_key_value(field)?;
        pairs.push((parse_json_string(&k)?, v));
    }
    Ok(pairs)
}

/// Split a string at commas that are NOT inside a double-quoted span.
fn split_top_level_commas(s: &str) -> Result<Vec<String>, JournalError> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut escaped = false;
    for c in s.chars() {
        if in_quote {
            cur.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_quote = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_quote = true;
                cur.push(c);
            }
            ',' => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    if in_quote {
        return Err(JournalError::Malformed { text: s.to_string() });
    }
    out.push(cur);
    Ok(out)
}

/// Split one `"key": value` field at the FIRST top-level colon (not inside the quoted key).
fn split_key_value(field: &str) -> Result<(String, String), JournalError> {
    let mut in_quote = false;
    let mut escaped = false;
    for (i, c) in field.char_indices() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_quote = false;
            }
            continue;
        }
        match c {
            '"' => in_quote = true,
            ':' => {
                let (k, v) = field.split_at(i);
                return Ok((k.trim().to_string(), v[1..].trim().to_string()));
            }
            _ => {}
        }
    }
    Err(JournalError::Malformed { text: field.to_string() })
}

/// Parse a JSON string literal (`"..."`), unescaping the few escapes we emit.
fn parse_json_string(raw: &str) -> Result<String, JournalError> {
    let raw = raw.trim();
    let body = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or_else(|| JournalError::BadValue { expected: "a JSON string", got: raw.to_string() })?;
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('u') => {
                let hex: String = (&mut chars).take(4).collect();
                let cp = u32::from_str_radix(&hex, 16).map_err(|_| JournalError::BadValue {
                    expected: "a \\uXXXX escape",
                    got: hex.clone(),
                })?;
                out.push(char::from_u32(cp).ok_or(JournalError::BadValue {
                    expected: "a valid unicode scalar",
                    got: hex,
                })?);
            }
            other => {
                return Err(JournalError::BadValue {
                    expected: "a valid JSON escape",
                    got: other.map(|c| c.to_string()).unwrap_or_default(),
                })
            }
        }
    }
    Ok(out)
}

/// Parse an exact `i128` from a bare JSON number (integer only -- no float, design SS3 principle 5).
fn parse_json_i128(raw: &str) -> Result<i128, JournalError> {
    let t = raw.trim();
    t.parse::<i128>()
        .map_err(|_| JournalError::BadValue { expected: "an integer", got: t.to_string() })
}

/// Parse a JSON `true` / `false`.
fn parse_json_bool(raw: &str) -> Result<bool, JournalError> {
    match raw.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(JournalError::BadValue { expected: "a boolean", got: other.to_string() }),
    }
}

/// Parse a canonical verdict string back into a [`Verdict`] (the SS2 alphabet only; unknown is loud).
///
/// This is the read-back twin of [`Verdict::canonical_string`]. It does NOT mint a fresh verdict
/// outside the monopoly (design SS3 principle 2): the journal can only contain a verdict the verifier
/// already minted and wrote, so re-reading its canonical string is recovering that same value, not
/// authoring a new judgement. An unknown string is a loud parse error, never a silent `settled`.
fn parse_verdict(s: &str) -> Result<Verdict, JournalError> {
    // Recover by canonical string. We match against the known alphabet via the public read API so the
    // mapping stays in lockstep with `canonical_string` (the single source of truth for the spelling).
    for v in [Verdict::Settled, Verdict::Hollow, Verdict::Mismatch, Verdict::Unverified] {
        if v.canonical_string() == s {
            return Ok(v);
        }
    }
    Err(JournalError::BadValue { expected: "a verdict (settled/hollow/mismatch/unverified)", got: s.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0";

    fn report(kind: &str, claimed: i128, observed: Option<i128>, recorded: bool, verdict: Verdict) -> VerifyReport {
        VerifyReport {
            hash: HASH.to_string(),
            kind: kind.to_string(),
            claimed,
            observed,
            recorded,
            verdict,
        }
    }

    #[test]
    fn record_round_trips_through_a_line() {
        // A settled record serializes and parses back byte-for-byte identically.
        let r = JournalRecord::from_report(&report("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled));
        let line = r.to_line();
        assert_eq!(
            line,
            "{\"hash\":\"0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0\",\
\"kind\":\"TRANSFER\",\"claimed\":1000000,\"observed\":1000000,\"recorded\":true,\"verdict\":\"settled\"}"
        );
        assert_eq!(JournalRecord::parse_line(&line).unwrap(), r);
    }

    #[test]
    fn unavailable_observation_is_json_null_and_round_trips() {
        // The NEG case: an unavailable read journals `observed: null`, NEVER a fabricated number.
        let r = JournalRecord::from_report(&report(crate::UNKNOWN_KIND, 0, None, false, Verdict::Unverified));
        let line = r.to_line();
        assert!(line.contains("\"observed\":null"), "an unavailable read must journal null");
        assert!(!line.contains("\"observed\":0"), "must NOT fabricate a 0 observation");
        let back = JournalRecord::parse_line(&line).unwrap();
        assert_eq!(back, r);
        assert_eq!(back.observed, None);
        assert_eq!(back.delta(), None, "no delta when the read was unavailable");
    }

    #[test]
    fn delta_is_exact_integer_and_signed() {
        // claimed - observed, exact i128, both signs.
        let over = JournalRecord::from_report(&report("BUY", 1_000, Some(1_300), true, Verdict::Mismatch));
        assert_eq!(over.delta(), Some(-300), "observed 300 over claim -> delta -300");
        let under = JournalRecord::from_report(&report("BUY", 1_000, Some(850), true, Verdict::Settled));
        assert_eq!(under.delta(), Some(150));
        let exact = JournalRecord::from_report(&report("BUY", 1_000_000, Some(1_000_000), true, Verdict::Settled));
        assert_eq!(exact.delta(), Some(0));
    }

    #[test]
    fn delta_amounts_wider_than_i64_are_exact() {
        // Design SS3 principle 5: an 18-decimal W0G-scale amount exceeds i64; the delta stays exact.
        let big = 10_000_000_000_000_000_000_i128; // 10 * 10^18 > i64::MAX
        let r = JournalRecord::from_report(&report("SWAP", big, Some(big - 5), true, Verdict::Settled));
        assert_eq!(r.delta(), Some(5));
        assert!(big > i64::MAX as i128);
        // And it round-trips exactly as a decimal in the line.
        let back = JournalRecord::parse_line(&r.to_line()).unwrap();
        assert_eq!(back.claimed, big);
        assert_eq!(back.observed, Some(big - 5));
    }

    #[test]
    fn to_line_is_deterministic_with_no_timestamp() {
        // Same record -> byte-identical line, every call; and the line carries NO clock-derived field.
        let r = JournalRecord::from_report(&report("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled));
        let first = r.to_line();
        for _ in 0..8 {
            assert_eq!(r.to_line(), first);
        }
        for clocky in ["timestamp", "time", "date", "ts", "at\"", "when"] {
            assert!(!first.contains(clocky), "the journal line must carry no wall-clock field ({clocky})");
        }
    }

    #[test]
    fn line_carries_no_path_or_secret_shaped_field() {
        // Design SS6 redaction: the record physically cannot hold a path or a secret -- assert the
        // emitted line contains only the six allowed keys and nothing path/secret-shaped.
        let r = JournalRecord::from_report(&report("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled));
        let line = r.to_line();
        for forbidden in ["PRIVATE_KEY", "WALLET", "/Users/", "C:\\\\", "mnemonic", "seed", ":\\"] {
            assert!(!line.contains(forbidden), "journal line must not contain {forbidden:?}");
        }
    }

    #[test]
    fn parse_journal_preserves_order_and_skips_blanks() {
        let a = JournalRecord::from_report(&report("TRANSFER", 1, Some(1), true, Verdict::Settled)).to_line();
        let b = JournalRecord::from_report(&report("BUY", 2, None, false, Verdict::Unverified)).to_line();
        let text = format!("{a}\n\n{b}\n");
        let recs = parse_journal(&text).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].claimed, 1);
        assert_eq!(recs[1].verdict, Verdict::Unverified);
    }

    #[test]
    fn keys_may_arrive_in_any_order() {
        let line = "{\"verdict\":\"settled\",\"observed\":1000000,\"recorded\":true,\"claimed\":1000000,\"kind\":\"TRANSFER\",\"hash\":\"0xabc0000000000000000000000000000000000000000000000000000000000001\"}";
        let r = JournalRecord::parse_line(line).unwrap();
        assert_eq!(r.verdict, Verdict::Settled);
        assert_eq!(r.kind, "TRANSFER");
        assert_eq!(r.observed, Some(1_000_000));
    }

    #[test]
    fn unknown_keys_are_ignored_forward_compatibly() {
        let line = "{\"hash\":\"0xabc0000000000000000000000000000000000000000000000000000000000001\",\"kind\":\"BUY\",\"claimed\":1,\"observed\":1,\"recorded\":true,\"verdict\":\"settled\",\"future\":\"x\"}";
        let r = JournalRecord::parse_line(line).unwrap();
        assert_eq!(r.claimed, 1);
    }

    #[test]
    fn malformed_lines_are_loud_errors_never_silent() {
        assert!(matches!(JournalRecord::parse_line("not json"), Err(JournalError::Malformed { .. })));
        // Missing a required key.
        let miss = "{\"hash\":\"0xabc0000000000000000000000000000000000000000000000000000000000001\",\"kind\":\"BUY\",\"claimed\":1,\"observed\":1,\"recorded\":true}";
        assert!(matches!(JournalRecord::parse_line(miss), Err(JournalError::MissingKey { key: "verdict" })));
        // Unknown verdict string.
        let badv = "{\"hash\":\"0xabc0000000000000000000000000000000000000000000000000000000000001\",\"kind\":\"BUY\",\"claimed\":1,\"observed\":1,\"recorded\":true,\"verdict\":\"approved\"}";
        assert!(matches!(JournalRecord::parse_line(badv), Err(JournalError::BadValue { .. })));
        // Float amount rejected (no float on the money path).
        let flt = "{\"hash\":\"0xabc0000000000000000000000000000000000000000000000000000000000001\",\"kind\":\"BUY\",\"claimed\":1.5,\"observed\":1,\"recorded\":true,\"verdict\":\"settled\"}";
        assert!(matches!(JournalRecord::parse_line(flt), Err(JournalError::BadValue { expected: "an integer", .. })));
    }

    #[test]
    fn malformed_journal_names_the_line_number() {
        let good = JournalRecord::from_report(&report("TRANSFER", 1, Some(1), true, Verdict::Settled)).to_line();
        let text = format!("{good}\nnot json\n");
        let err = parse_journal(&text).unwrap_err();
        assert!(matches!(err, JournalError::AtLine { line: 2, .. }));
    }

    #[test]
    fn is_settled_only_for_settled() {
        assert!(JournalRecord::from_report(&report("T", 1, Some(1), true, Verdict::Settled)).is_settled());
        for v in [Verdict::Hollow, Verdict::Mismatch, Verdict::Unverified] {
            assert!(!JournalRecord::from_report(&report("T", 1, Some(1), true, v)).is_settled());
        }
    }
}
