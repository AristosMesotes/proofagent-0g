//! The FILL-PROOF ORACLE -- `adjudicate_fill(...)` / `verify_fill(...)`: ProofAgent as the HONEST
//! settlement oracle for cross-chain intents (the LI.FI-Intents frontier).
//!
//! ## Why this leg exists
//!
//! Intent-settlement protocols (LI.FI Intents, live 2026) run on a settler-pair + Oracle: a solver
//! fronts destination liquidity, and the Input Settler releases the solver's funds ONLY after an oracle
//! proves the fill (an `efficientRequireProven`-style gate over a hash-based fill attestation). The open
//! gap is HONESTY under adversarial fills -- a hash-only oracle releases whatever it is *told* proved.
//!
//! This leg makes ProofAgent that oracle, the honest version. It adjudicates the solver's CLAIMED fill
//! against the verifier's INDEPENDENT on-chain read of the actually-delivered amount (the Observation),
//! reusing the SAME [`adjudicate`] algebra and the SAME four [`Verdict`]s (the monopoly, design SS3
//! principle 2) -- then emits a [`FillDecision`]: RELEASE the solver only on [`Verdict::Settled`], and
//! BLOCK every other verdict. The centerpiece is the HOLLOW-FILL block: a solver claims payment for a
//! delivery that never happened (a positive claimed fill, an independently-observed ZERO delivery) reads
//! a loud [`Verdict::Hollow`] -> [`FillDecision::Block`], exactly where a hash-only oracle would have
//! paid. Fail-closed by construction (design SS3 principle 3, never fabricate): an out-of-band fill
//! ([`Verdict::Mismatch`]) and an unreadable fill ([`Verdict::Unverified`]) also BLOCK -- the oracle
//! releases ONLY on a chain-confirmed, within-band fill.
//!
//! No new verdict enum: the fill-proof oracle cannot escape the verdict monopoly. It is offline-buildable
//! (a pure algebra over the existing [`Source`] read seam, deterministic by construction); the live
//! destination read reuses the settlement [`Source`] (a [`crate::TapeSource`] offline, a feature-gated
//! live reader on 0G), so swapping a taped read for a live one never changes what a decision *means*.

use crate::{adjudicate, observed_amount, Ratio, ReadKey, Source, Verdict};

/// The solver's CLAIM about an intent fill -- never trusted, only ever one input of two-source truth.
///
/// `intent_tx` (the source-lock that opened the intent) and `fill_tx` (the destination transfer the
/// solver points to as proof of delivery) are PUBLIC identifiers for the journal; `claimed_fill` is the
/// amount, in minor units, the solver CLAIMS it delivered to the destination -- the number the oracle
/// checks against the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillClaim {
    /// The source-lock tx that opened the intent (the funds the solver fronts against). PUBLIC id.
    pub intent_tx: String,
    /// The destination fill tx the solver points to as proof of delivery. PUBLIC id.
    pub fill_tx: String,
    /// The amount the solver CLAIMS it delivered to the destination, in minor units.
    pub claimed_fill: i128,
}

impl FillClaim {
    /// Build a fill claim from the two PUBLIC tx ids and the claimed delivered amount (minor units).
    #[must_use]
    pub fn new(intent_tx: impl Into<String>, fill_tx: impl Into<String>, claimed_fill: i128) -> FillClaim {
        FillClaim { intent_tx: intent_tx.into(), fill_tx: fill_tx.into(), claimed_fill }
    }
}

/// The oracle's release gate: RELEASE the solver's funds, or BLOCK (and never pay a hollow fill).
///
/// This is the new surface the fill-proof leg adds over a bare settlement verdict -- the
/// `efficientRequireProven` decision, made honestly. It is `#[non_exhaustive]` so adding a future gate
/// state forces a deliberate match, and it is derived purely from the minted [`Verdict`] (see
/// [`FillDecision::from_verdict`]) so it can never disagree with the verdict monopoly.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FillDecision {
    /// The chain confirmed a within-band fill -> release the solver's funds.
    Release,
    /// The fill is hollow / out-of-band / unreadable -> block release (fail-closed, never fabricate).
    Block,
}

impl FillDecision {
    /// Derive the oracle decision from a minted [`Verdict`]: RELEASE only on `Settled`, BLOCK otherwise.
    ///
    /// Hollow / Mismatch / Unverified all BLOCK -- the oracle releases ONLY on a chain-confirmed,
    /// within-band fill (design SS3 principle 3, fail-closed: never fabricate a release).
    #[must_use]
    pub const fn from_verdict(verdict: Verdict) -> FillDecision {
        if verdict.is_settled() {
            FillDecision::Release
        } else {
            FillDecision::Block
        }
    }

    /// The canonical, stable, UPPERCASE string (the wire/journal form). Deterministic (design SS3 #4).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            FillDecision::Release => "RELEASE",
            FillDecision::Block => "BLOCK",
        }
    }

    /// `true` only for `Release`. The honest "may the solver be paid?" check, without re-matching.
    #[must_use]
    pub const fn is_release(&self) -> bool {
        matches!(self, FillDecision::Release)
    }
}

impl core::fmt::Display for FillDecision {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The fill-proof oracle report: the minted [`Verdict`], the derived [`FillDecision`], and the two
/// amounts that produced them (the solver's claim, and the verifier's independent observation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FillReport {
    /// The verdict minted by the verifier -- one of the SAME four (the monopoly).
    pub verdict: Verdict,
    /// The release/block decision derived purely from `verdict`.
    pub decision: FillDecision,
    /// The solver's claimed delivered amount, in minor units.
    pub claimed: i128,
    /// The verifier's INDEPENDENT observation of the delivered amount; `None` = unreadable.
    pub observed: Option<i128>,
}

/// Adjudicate a solver's claimed fill against the verifier's independent observation, and emit a
/// RELEASE/BLOCK decision. Pure, deterministic, float-free.
///
/// The verdict is minted through the monopoly: the HOLLOW-FILL catch (a positive claimed fill with an
/// independently-observed ZERO delivery) mints [`Verdict::Hollow`] -- the loud "claimed payment, moved
/// nothing", structurally distinct from a [`Verdict::Mismatch`] (delivered, but the wrong amount); every
/// other shape defers to the shared [`adjudicate`] band algebra (which also maps the claimed-nothing /
/// got-nothing `(0, 0)` case to `Hollow`, and an absent observation to `Unverified`). The
/// [`FillDecision`] is then derived purely from that verdict.
#[must_use]
pub fn adjudicate_fill(claim: &FillClaim, observed: Option<i128>, tol: Ratio) -> FillReport {
    let verdict = match observed {
        // The hollow-fill centerpiece: the solver claims a positive delivery, the chain says ZERO moved.
        // This is the exact attack a hash-only oracle would pay; here it is a loud Hollow, never settled.
        Some(0) if claim.claimed_fill > 0 => Verdict::hollow(),
        // Everything else (within/outside band, the (0,0) hollow, and the unreadable None) goes through
        // the shared two-source band algebra -- the fill-proof leg cannot escape the verdict monopoly.
        other => adjudicate(claim.claimed_fill, other, tol),
    };
    FillReport { verdict, decision: FillDecision::from_verdict(verdict), claimed: claim.claimed_fill, observed }
}

/// Verify a fill end-to-end: take the verifier's INDEPENDENT on-chain read of the destination fill (the
/// Observation) through the [`Source`] seam, then [`adjudicate_fill`]. Two-source truth (design SS3
/// principle 1): the solver's claim is only ever one input, checked against the verifier's own read. An
/// unreadable fill flows (via [`observed_amount`]) to `None` -> [`Verdict::Unverified`] -> BLOCK -- a
/// fill the verifier could not confirm is NEVER released (design SS3 principle 3).
#[must_use]
pub fn verify_fill(key: &ReadKey, claim: &FillClaim, tol: Ratio, source: &mut dyn Source) -> FillReport {
    let observed = observed_amount(&source.read(key));
    adjudicate_fill(claim, observed, tol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Observation, TapeSource};

    /// The canonical demo band from the data spine (`proofagent.toml [verifier.tolerance]`): 15%.
    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    fn claim(amount: i128) -> FillClaim {
        FillClaim::new(
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222222222222222222222222222",
            amount,
        )
    }

    // --- The oracle gate: RELEASE only on a chain-confirmed, within-band fill ----------------------

    #[test]
    fn settled_fill_releases() {
        // The chain confirms ~the claimed delivery (within the 15% band) -> Settled -> RELEASE.
        let r = adjudicate_fill(&claim(1_000_000), Some(1_000_000), band_15pct());
        assert_eq!(r.verdict, Verdict::Settled);
        assert_eq!(r.decision, FillDecision::Release);
        assert!(r.decision.is_release());
        // Within-band under-delivery still releases (|1_000_000 - 900_000| = 100_000 <= 150_000).
        let under = adjudicate_fill(&claim(1_000_000), Some(900_000), band_15pct());
        assert_eq!(under.verdict, Verdict::Settled);
        assert_eq!(under.decision, FillDecision::Release);
    }

    #[test]
    fn hollow_fill_blocks_the_kill_demo() {
        // THE KILLER DEMO: a solver claims a 1,000,000 delivery; the chain says ZERO moved. A hash-only
        // oracle would pay. ProofAgent mints a loud Hollow and BLOCKS the release.
        let r = adjudicate_fill(&claim(1_000_000), Some(0), band_15pct());
        assert_eq!(r.verdict, Verdict::Hollow, "claimed payment, moved nothing -> Hollow");
        assert_eq!(r.decision, FillDecision::Block, "a hollow fill is NEVER released");
        assert!(!r.decision.is_release());
        // It is structurally NOT settled -- never a fabricated release.
        assert_ne!(r.verdict, Verdict::Settled);
    }

    #[test]
    fn out_of_band_fill_blocks_as_mismatch() {
        // Delivered, but far below the claim and outside the band -> Mismatch -> BLOCK.
        let r = adjudicate_fill(&claim(1_000_000), Some(500_000), band_15pct());
        assert_eq!(r.verdict, Verdict::Mismatch);
        assert_eq!(r.decision, FillDecision::Block);
    }

    #[test]
    fn unreadable_fill_blocks_as_unverified() {
        // The chain could not be read (None) -> Unverified -> BLOCK (fail-closed, never fabricate).
        let r = adjudicate_fill(&claim(1_000_000), None, band_15pct());
        assert_eq!(r.verdict, Verdict::Unverified);
        assert_eq!(r.decision, FillDecision::Block);
    }

    #[test]
    fn claimed_nothing_got_nothing_is_hollow_and_blocks() {
        // The genuine (0, 0) no-op also resolves to Hollow (via the shared algebra) -> BLOCK.
        let r = adjudicate_fill(&claim(0), Some(0), band_15pct());
        assert_eq!(r.verdict, Verdict::Hollow);
        assert_eq!(r.decision, FillDecision::Block);
    }

    // --- Two-source via the Source seam (the verifier's OWN independent read) ----------------------

    #[test]
    fn verify_fill_releases_on_a_taped_settled_observation() {
        let key = ReadKey::new("0x2222222222222222222222222222222222222222222222222222222222222222").unwrap();
        let mut tape = TapeSource::new().with(key.clone(), Observation::new(1_005_000));
        let r = verify_fill(&key, &claim(1_000_000), band_15pct(), &mut tape);
        assert_eq!(r.verdict, Verdict::Settled);
        assert_eq!(r.decision, FillDecision::Release);
        assert_eq!(r.observed, Some(1_005_000));
    }

    #[test]
    fn verify_fill_blocks_a_taped_hollow_fill() {
        // The destination read is on-record and says ZERO delivered against a positive claim -> Hollow.
        let key = ReadKey::new("0x2222222222222222222222222222222222222222222222222222222222222222").unwrap();
        let mut tape = TapeSource::new().with(key.clone(), Observation::new(0));
        let r = verify_fill(&key, &claim(1_000_000), band_15pct(), &mut tape);
        assert_eq!(r.verdict, Verdict::Hollow);
        assert_eq!(r.decision, FillDecision::Block);
        assert_eq!(r.observed, Some(0));
    }

    #[test]
    fn verify_fill_blocks_an_off_tape_fill_as_unverified() {
        // No recording for this key -> Unavailable -> None -> Unverified -> BLOCK (never released).
        let key = ReadKey::new("0x3333333333333333333333333333333333333333333333333333333333333333").unwrap();
        let mut tape = TapeSource::new(); // empty
        let r = verify_fill(&key, &claim(1_000_000), band_15pct(), &mut tape);
        assert_eq!(r.verdict, Verdict::Unverified);
        assert_eq!(r.decision, FillDecision::Block);
        assert_eq!(r.observed, None);
    }

    // --- Decision derivation + canonical forms ----------------------------------------------------

    #[test]
    fn decision_releases_only_on_settled() {
        assert_eq!(FillDecision::from_verdict(Verdict::settled()), FillDecision::Release);
        assert_eq!(FillDecision::from_verdict(Verdict::hollow()), FillDecision::Block);
        assert_eq!(FillDecision::from_verdict(Verdict::mismatch()), FillDecision::Block);
        assert_eq!(FillDecision::from_verdict(Verdict::unverified()), FillDecision::Block);
    }

    #[test]
    fn decision_canonical_strings_are_stable() {
        assert_eq!(FillDecision::Release.canonical_string(), "RELEASE");
        assert_eq!(FillDecision::Block.canonical_string(), "BLOCK");
        assert_eq!(format!("{}", FillDecision::Release), "RELEASE");
        assert_eq!(format!("{}", FillDecision::Block), "BLOCK");
    }

    #[test]
    fn adjudicate_fill_is_deterministic() {
        for _ in 0..8 {
            assert_eq!(adjudicate_fill(&claim(1_000_000), Some(1_000_000), band_15pct()).decision, FillDecision::Release);
            assert_eq!(adjudicate_fill(&claim(1_000_000), Some(0), band_15pct()).verdict, Verdict::Hollow);
            assert_eq!(adjudicate_fill(&claim(1_000_000), None, band_15pct()).decision, FillDecision::Block);
        }
    }
}
