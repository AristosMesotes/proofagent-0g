//! `verify_tx` -- the verify leg of the loop, as one deterministic call.
//!
//! Design SS5 (the loop): `plan -> mandate-gate -> execute -> verify`, where **verify** is "an
//! independent chain read -> verdict." Design SS2 (the three proofs / settlement): the verifier
//! "reads 0G via raw JSON-RPC and stamps each trade settled / hollow / mismatch / unverified -- it
//! never trusts the UI." [`verify_tx`] is exactly that leg, standalone: given a transaction hash, a
//! [`SpineConfig`] (the recorded claim corpus + tolerance), and a bound [`Source`], it returns the
//! [`Verdict`] minted by the in-crate [`crate::adjudicate`].
//!
//! ## The two-source-truth wiring (design SS3 principle 1)
//!
//! - The **Claim** is the corpus entry recorded for the hash (the agent's word -- never trusted on
//!   its own). It enters via [`SpineConfig::claim_for`].
//! - The **Observation** is the independent on-chain read from the bound [`Source`] (a [`TapeSource`]
//!   offline by default, a `LiveSource` under the `live` feature). It enters via [`Source::read`].
//! - The **Verdict** is `adjudicate(claimed, observed, tolerance)` -- minted inside the crate, the
//!   verdict monopoly (design SS3 principle 2).
//!
//! ## Never fabricate -- the NEG case / hero invariant (design SS2 + SS3 principle 3)
//!
//! Design SS2 (the NEG case): "Point the verifier at a *fabricated* transaction hash -> it stamps
//! **`UNVERIFIED`**." This is the single most convincing demo invariant, and STEP VS5 makes it a
//! property of this function. Both "we cannot conclude settled" inputs land on the same honest stamp --
//! `Unverified` -- so a viewer pointing the verifier at any off-record hash sees the verifier degrade
//! *loudly*, never to a fabricated `settled`:
//!
//! - **A fabricated / unknown hash** (well-formed, but no claim recorded in the corpus) -> there is
//!   neither a Claim nor an Observation. The verifier has nothing on-record confirming a settlement, so
//!   it degrades *loudly* to [`Verdict::Unverified`] -- the NEG case (the report's
//!   [`VerifyReport::recorded`] flag is `false` so the journal still distinguishes "off-record" from a
//!   recorded-but-unread claim). It is **never** `settled`.
//! - **A recorded claim whose chain read is unavailable** (off-tape / off-record) -> the read bridges
//!   to `None`, and [`crate::adjudicate`] degrades it the same way to [`Verdict::Unverified`].
//!
//! Both are real verdicts on the `Ok` path -- the honest "could not verify" -- and neither can be
//! mistaken for a `settled`. The verdict is always minted by [`crate::adjudicate`] (the verdict
//! monopoly, design SS3 principle 2); even the unknown-hash case routes through `adjudicate(_, None, _)`
//! so no `Unverified` is ever hand-built outside the algebra.
//!
//! A malformed hash *string* (not 32 bytes of hex at all) is the one remaining *usage* error
//! ([`VerifyError::BadHash`]) -- it is not a transaction hash the verifier could point at the chain, so
//! it never becomes a lookup that misses and reads as a real on-chain absence.
//!
//! Design SS3 principle 4 (deterministic): the whole call is pure over `(hash, config, source)` with
//! no wall-clock and no global state, so a taped read always reproduces the same verdict.

use crate::{adjudicate, observed_amount, ReadKey, SpineConfig, Source, Verdict};
use core::fmt;

/// The kind label stamped on the journal row for a fabricated / unknown hash (design SS2, the NEG
/// case). A hash with no recorded claim has no trade kind, so the journal records this sentinel rather
/// than invent one; it is for the human-readable row only, never the verdict.
pub const UNKNOWN_KIND: &str = "unknown";

/// The outcome of a [`verify_tx`]: the verdict plus the inputs that produced it.
///
/// The report is the journal row for one verification (design SS2): the canonical hash, the trade
/// kind, the claimed amount, the independently observed amount (`None` if the chain could not be
/// read -- the loud absence), whether the hash was on-record in the corpus, and the minted
/// [`Verdict`]. It carries enough to reproduce and audit the verdict, never less.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    /// The canonical `0x`-lowercase transaction hash that was verified.
    pub hash: String,
    /// The trade kind label recorded in the corpus (for the journal, not the verdict). For a
    /// fabricated / unknown hash with no recorded claim this is [`UNKNOWN_KIND`].
    pub kind: String,
    /// The claimed amount in minor units (the agent's word). `0` for a fabricated / unknown hash,
    /// which records no claim (`recorded == false`); the verdict for that case is driven purely by the
    /// absent observation, never by this placeholder.
    pub claimed: i128,
    /// The independently observed amount in minor units, or `None` if the chain could not be read
    /// (the loud absence that adjudicates to [`Verdict::Unverified`]).
    pub observed: Option<i128>,
    /// Whether a claim for this hash was on-record in the corpus.
    ///
    /// `true` -> a recorded claim was adjudicated against an independent read. `false` -> the hash is
    /// fabricated / unknown (the NEG case, design SS2): no claim and no read, so the verdict is the
    /// loud [`Verdict::Unverified`]. This flag lets the journal distinguish "off-record / fabricated"
    /// from "recorded but unread" -- both honest `Unverified`s, never a `settled`.
    pub recorded: bool,
    /// The verdict minted by [`crate::adjudicate`] -- the only place a verdict is created.
    pub verdict: Verdict,
}

impl VerifyReport {
    /// The canonical verdict string (design SS2 alphabet): `settled / hollow / mismatch / unverified`.
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// A reason [`verify_tx`] could not even reach an adjudication.
///
/// This is a *usage* failure, deliberately distinct from any [`Verdict`] (design SS3 principle 3): it
/// is never rendered as a settlement. Two cases that *could* be confused with a usage error are NOT
/// here -- both are honest verdicts on the `Ok` path:
///
/// - a *fabricated / unknown* hash (no recorded claim) -> [`Verdict::Unverified`] (design SS2, the NEG
///   case), with [`VerifyReport::recorded`] `false`;
/// - a recorded claim whose chain read failed -> [`Verdict::Unverified`] as well.
///
/// The only thing left here is a string that is not a transaction hash at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The supplied hash string is not a well-formed 32-byte transaction hash, so it is not something
    /// the verifier could point at the chain at all (distinct from a well-formed hash that simply is
    /// not on-record -- that is the [`Verdict::Unverified`] NEG case, not an error).
    BadHash {
        /// The offending input.
        input: String,
    },
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerifyError::BadHash { input } => {
                write!(f, "not a 32-byte transaction hash: {input:?}")
            }
        }
    }
}

impl std::error::Error for VerifyError {}

/// Verify one transaction hash against its recorded claim and an independent on-chain read.
///
/// This is the verify leg of the loop (design SS5) as one deterministic call. It:
///
/// 1. normalizes `hash` to the one canonical [`ReadKey`] shape (a malformed hash is a loud
///    [`VerifyError::BadHash`], never a silent wrong-key lookup);
/// 2. looks up the recorded **Claim** in the corpus ([`SpineConfig::claim_for`]); a *fabricated /
///    unknown* hash (no recorded claim) is the NEG case (design SS2) -- it has no Claim and no read, so
///    it adjudicates to [`Verdict::Unverified`] via `adjudicate(0, None, _)` (the report's
///    [`VerifyReport::recorded`] is `false`), **never** a fabricated `settled`;
/// 3. takes the independent **Observation** from `source` ([`Source::read`]), bridging an unavailable
///    read to `None` (design SS3 principle 3);
/// 4. mints the [`Verdict`] via [`crate::adjudicate`] -- the verdict monopoly (design SS3 principle 2).
///
/// It returns a [`VerifyReport`]; the verdict inside is the only thing the CLI prints. Both a fabricated
/// hash and a recorded-but-unread claim yield a perfectly valid `Ok(report)` whose verdict is
/// [`Verdict::Unverified`] -- the honest NEG case (design SS2). The one `Err` is a string that is not a
/// transaction hash at all ([`VerifyError::BadHash`]).
pub fn verify_tx(
    hash: &str,
    config: &SpineConfig,
    source: &mut dyn Source,
) -> Result<VerifyReport, VerifyError> {
    // (1) Normalize -- a malformed hash is loud, never a silently-wrong key.
    let key = ReadKey::new(hash).ok_or_else(|| VerifyError::BadHash { input: hash.to_string() })?;

    // (2) The Claim (the agent's word). A fabricated / unknown hash has NO recorded claim -- the NEG
    // case (design SS2). There is nothing on-record confirming a settlement, so we degrade LOUDLY to
    // Unverified: no claim (0) and no observation (None) routed through the SAME algebra, so the
    // verdict is still minted by `adjudicate` (the verdict monopoly) and can never be a fabricated
    // `settled` (design SS3 principle 3). The `recorded == false` flag keeps the journal honest.
    let Some(entry) = config.claim_for(&key) else {
        let verdict = adjudicate(0, None, config.tolerance());
        debug_assert_eq!(verdict, Verdict::Unverified, "the NEG case must stamp Unverified");
        return Ok(VerifyReport {
            hash: key.tx_hash().to_string(),
            kind: UNKNOWN_KIND.to_string(),
            claimed: 0,
            observed: None,
            recorded: false,
            verdict,
        });
    };

    // (3) The Observation (the verifier's independent on-chain read). An unavailable read bridges to
    // None -- the loud absence the algebra degrades to Unverified.
    let read = source.read(&key);
    let observed = observed_amount(&read);

    // (4) Mint the verdict -- inside the crate, the verdict monopoly.
    let verdict = adjudicate(entry.claimed(), observed, config.tolerance());

    Ok(VerifyReport {
        hash: key.tx_hash().to_string(),
        kind: entry.kind().to_string(),
        claimed: entry.claimed(),
        observed,
        recorded: true,
        verdict,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Observation, TapeSource};

    const HASH_A: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";
    const HASH_B: &str = "0xdef0000000000000000000000000000000000000000000000000000000000002";

    /// A spine with one BUY claim of 1000 minor units and the 15% band.
    fn spine() -> SpineConfig {
        let text = format!(
            "\
[[verifier.corpus]]
kind = \"BUY\"
hash = \"{HASH_A}\"
claimed = \"1000\"

[verifier.tolerance]
num = 15
den = 100
"
        );
        SpineConfig::parse(&text).expect("well-formed spine")
    }

    #[test]
    fn settled_when_tape_observation_is_within_band() {
        // The headline path: a recorded claim + an in-band independent read -> SETTLED.
        // claimed 1000, observed 1100, 15% band (floor(150)) -> Settled.
        let cfg = spine();
        let mut src = TapeSource::new()
            .with(ReadKey::new(HASH_A).unwrap(), Observation::new(1_100));
        let report = verify_tx(HASH_A, &cfg, &mut src).expect("a recorded claim adjudicates");
        assert_eq!(report.verdict, Verdict::Settled);
        assert_eq!(report.verdict_string(), "settled");
        assert_eq!(report.kind, "BUY");
        assert_eq!(report.claimed, 1_000);
        assert_eq!(report.observed, Some(1_100));
        assert_eq!(report.hash, HASH_A);
        assert!(report.recorded, "a corpus hit is on-record");
    }

    #[test]
    fn mismatch_when_tape_observation_is_out_of_band() {
        // A recorded read that disagrees beyond tolerance -> MISMATCH (claimed 1000, observed 1300).
        let cfg = spine();
        let mut src = TapeSource::new()
            .with(ReadKey::new(HASH_A).unwrap(), Observation::new(1_300));
        let report = verify_tx(HASH_A, &cfg, &mut src).unwrap();
        assert_eq!(report.verdict, Verdict::Mismatch);
    }

    #[test]
    fn unverified_when_read_is_off_tape_for_a_recorded_claim() {
        // The NEG case: a claim is recorded, but the independent read is unavailable (empty tape) ->
        // the loud honest degrade UNVERIFIED, NEVER a fabricated settled (design SS3 principle 3).
        let cfg = spine();
        let mut src = TapeSource::new(); // empty -> the recorded hash is off-tape
        let report = verify_tx(HASH_A, &cfg, &mut src).unwrap();
        assert_eq!(report.verdict, Verdict::Unverified);
        assert_eq!(report.observed, None);
        assert_ne!(report.verdict, Verdict::Settled);
        assert!(report.recorded, "the claim was on-record, only the read was unavailable");
    }

    #[test]
    fn hollow_when_zero_claim_and_zero_observed() {
        // A zero-claim corpus entry read as on-record-but-moved-nothing -> HOLLOW.
        let text = format!(
            "\
[[verifier.corpus]]
kind = \"SWAP\"
hash = \"{HASH_A}\"
claimed = \"0\"

[verifier.tolerance]
num = 15
den = 100
"
        );
        let cfg = SpineConfig::parse(&text).unwrap();
        let mut src = TapeSource::new().with(ReadKey::new(HASH_A).unwrap(), Observation::new(0));
        let report = verify_tx(HASH_A, &cfg, &mut src).unwrap();
        assert_eq!(report.verdict, Verdict::Hollow);
    }

    #[test]
    fn fabricated_unknown_hash_stamps_unverified_never_settled() {
        // THE HERO INVARIANT (design SS2, the NEG case): a well-formed but fabricated / unknown hash
        // (no recorded claim) stamps UNVERIFIED -- never a fabricated settled (design SS3 principle 3).
        // Even a tape that HAS a reading for this hash cannot manufacture a settlement, because with no
        // recorded claim there is nothing to settle against: no claim + no adjudicable observation.
        let cfg = spine();
        let mut src = TapeSource::new().with(ReadKey::new(HASH_B).unwrap(), Observation::new(1));
        let report = verify_tx(HASH_B, &cfg, &mut src).unwrap();
        assert_eq!(report.verdict, Verdict::Unverified, "a fabricated hash must stamp Unverified");
        assert_ne!(report.verdict, Verdict::Settled, "NEVER a fabricated settled");
        assert!(!report.recorded, "an unknown hash is off-record");
        assert_eq!(report.observed, None, "no adjudicable observation for an unrecorded claim");
        assert_eq!(report.claimed, 0, "no claim recorded");
        assert_eq!(report.kind, super::UNKNOWN_KIND);
        assert_eq!(report.hash, HASH_B, "the canonical hash is still echoed for the journal");
        assert_eq!(report.verdict_string(), "unverified");
    }

    #[test]
    fn malformed_hash_is_rejected_up_front() {
        let cfg = spine();
        let mut src = TapeSource::new();
        let err = verify_tx("0xnothex", &cfg, &mut src).unwrap_err();
        assert!(matches!(err, VerifyError::BadHash { .. }));
    }

    #[test]
    fn verify_is_deterministic() {
        // Same (hash, config, tape) -> identical report, every call (design SS3 principle 4).
        let cfg = spine();
        let build = || TapeSource::new().with(ReadKey::new(HASH_A).unwrap(), Observation::new(1_100));
        let mut a = build();
        let first = verify_tx(HASH_A, &cfg, &mut a).unwrap();
        for _ in 0..8 {
            let mut s = build();
            assert_eq!(verify_tx(HASH_A, &cfg, &mut s).unwrap(), first);
        }
    }

    #[test]
    fn input_hash_is_normalized_before_lookup_and_read() {
        // A differently-cased / unprefixed input must hit the same claim and the same tape slot.
        let cfg = spine();
        let mut src = TapeSource::new().with(ReadKey::new(HASH_A).unwrap(), Observation::new(1_000));
        let messy = "  ABC0000000000000000000000000000000000000000000000000000000000001  ";
        let report = verify_tx(messy, &cfg, &mut src).unwrap();
        assert_eq!(report.hash, HASH_A);
        assert_eq!(report.verdict, Verdict::Settled);
    }
}
