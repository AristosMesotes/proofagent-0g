//! The CROSS-CHAIN FILL PROOF -- `verify_xchain_fill(...)`: the honest fill-proof oracle, ACROSS TWO
//! CHAINS (the capstone of the LI.FI-Intents frontier).
//!
//! A cross-chain intent LOCKS value on a SOURCE chain and is FILLED on a DESTINATION chain; a solver is
//! released only if BOTH legs landed. A naive integration reads the source lock, sees it confirmed, and
//! pays -- but the destination fill is async and can fail with ZERO delivered while the source is locked
//! (the cross-chain HOLLOW fill). ProofAgent reads BOTH legs INDEPENDENTLY (two `Source` reads, like the
//! [`crate::bridge`] two-leg read) and mints ONE cross-chain [`Verdict`] + a [`FillDecision`] -- RELEASE
//! only when BOTH legs settled within band, and BLOCK a cross-chain hollow fill, exactly where a
//! hash-only oracle would have paid.
//!
//! ## Composition (no new verdict enum -- the monopoly holds, design SS3 principle 2)
//!
//! The DESTINATION leg is the release-critical fill: it is adjudicated through [`adjudicate_fill`] (the
//! fill-proof oracle, with its HOLLOW-FILL catch -- a positive claimed fill, an observed ZERO delivery).
//! The SOURCE leg is the lock: it is adjudicated through the shared settlement algebra [`adjudicate`]
//! (did the agent lock the claimed amount?). [`combine_xchain`] folds the two leg verdicts into one with
//! fail-closed precedence: an UNREADABLE leg dominates (the journey cannot be confirmed -> `unverified`),
//! then a HOLLOW leg (the release-critical defect -> `hollow`), then a `mismatch`, else both `settled`.
//! Pure + deterministic; the live two-chain read reuses the settlement [`Source`] (a tape offline; a
//! feature-gated live reader per chain).

use crate::{
    adjudicate, adjudicate_fill, observed_amount, FillClaim, FillDecision, Ratio, ReadKey, Source,
    Verdict,
};

/// A cross-chain intent CLAIM -- the source lock + the destination fill (never trusted; one input of
/// two-source truth). `source_tx` / `dest_tx` are PUBLIC tx ids; the amounts are minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XChainFillClaim {
    /// The lock tx on the SOURCE chain (the funds the intent locks). PUBLIC id.
    pub source_tx: String,
    /// The fill tx on the DESTINATION chain (the solver's claimed delivery). PUBLIC id.
    pub dest_tx: String,
    /// The amount CLAIMED locked on the source, in minor units.
    pub source_locked: i128,
    /// The amount CLAIMED delivered on the destination, in minor units.
    pub claimed_fill: i128,
}

impl XChainFillClaim {
    /// Build a cross-chain fill claim from the two PUBLIC tx ids + the locked/delivered amounts.
    #[must_use]
    pub fn new(
        source_tx: impl Into<String>,
        dest_tx: impl Into<String>,
        source_locked: i128,
        claimed_fill: i128,
    ) -> XChainFillClaim {
        XChainFillClaim {
            source_tx: source_tx.into(),
            dest_tx: dest_tx.into(),
            source_locked,
            claimed_fill,
        }
    }
}

/// The cross-chain fill-proof report: the combined cross-chain [`Verdict`] + the [`FillDecision`], plus
/// each leg's own verdict and the four amounts (the per-leg claim + the verifier's independent reads).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XChainFillReport {
    /// The combined cross-chain verdict (one of the SAME four -- the monopoly).
    pub verdict: Verdict,
    /// The release/block decision derived purely from the combined verdict.
    pub decision: FillDecision,
    /// The SOURCE-lock leg's own verdict.
    pub source_verdict: Verdict,
    /// The DESTINATION-fill leg's own verdict (the fill-proof leg).
    pub dest_verdict: Verdict,
    /// The claimed source lock, minor units.
    pub source_locked: i128,
    /// The claimed destination fill, minor units.
    pub claimed_fill: i128,
    /// The verifier's INDEPENDENT read of the source lock (None = unreadable).
    pub source_observed: Option<i128>,
    /// The verifier's INDEPENDENT read of the destination fill (None = unreadable).
    pub dest_observed: Option<i128>,
}

/// Fold the two leg verdicts into one cross-chain verdict, fail-closed (design SS3 principle 3): an
/// unreadable leg dominates (`unverified`), then a hollow leg (the release-critical defect), then a
/// mismatch, else both settled.
fn combine_xchain(source: Verdict, dest: Verdict) -> Verdict {
    if matches!(source, Verdict::Unverified) || matches!(dest, Verdict::Unverified) {
        return Verdict::unverified();
    }
    if matches!(source, Verdict::Hollow) || matches!(dest, Verdict::Hollow) {
        return Verdict::hollow();
    }
    if matches!(source, Verdict::Mismatch) || matches!(dest, Verdict::Mismatch) {
        return Verdict::mismatch();
    }
    Verdict::settled()
}

/// Adjudicate a cross-chain fill from the two independent observations, and emit a RELEASE/BLOCK decision.
/// Pure: the destination leg goes through [`adjudicate_fill`] (the hollow-fill catch), the source leg
/// through [`adjudicate`], and [`combine_xchain`] folds them. RELEASE only when the combined verdict is
/// `settled` (both legs landed within band).
#[must_use]
pub fn adjudicate_xchain_fill(
    claim: &XChainFillClaim,
    source_observed: Option<i128>,
    dest_observed: Option<i128>,
    tol: Ratio,
) -> XChainFillReport {
    let source_verdict = adjudicate(claim.source_locked, source_observed, tol);
    let dest_claim = FillClaim::new(claim.source_tx.clone(), claim.dest_tx.clone(), claim.claimed_fill);
    let dest_verdict = adjudicate_fill(&dest_claim, dest_observed, tol).verdict;
    let verdict = combine_xchain(source_verdict, dest_verdict);
    XChainFillReport {
        verdict,
        decision: FillDecision::from_verdict(verdict),
        source_verdict,
        dest_verdict,
        source_locked: claim.source_locked,
        claimed_fill: claim.claimed_fill,
        source_observed,
        dest_observed,
    }
}

/// Verify a cross-chain fill end-to-end: read the SOURCE lock and the DESTINATION fill INDEPENDENTLY,
/// each through its own [`Source`] (the verifier's own per-chain read), then [`adjudicate_xchain_fill`].
/// Two-source truth across two chains (design SS3 principle 1): the solver's claim is checked against the
/// verifier's own reads of BOTH legs; an unreadable leg flows to `unverified` -> BLOCK (never released).
#[must_use]
pub fn verify_xchain_fill(
    source_key: &ReadKey,
    dest_key: &ReadKey,
    claim: &XChainFillClaim,
    tol: Ratio,
    source_reader: &mut dyn Source,
    dest_reader: &mut dyn Source,
) -> XChainFillReport {
    let source_observed = observed_amount(&source_reader.read(source_key));
    let dest_observed = observed_amount(&dest_reader.read(dest_key));
    adjudicate_xchain_fill(claim, source_observed, dest_observed, tol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Observation, TapeSource};

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100")
    }
    const SRC: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const DST: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

    fn claim() -> XChainFillClaim {
        XChainFillClaim::new(SRC, DST, 1_000_000, 1_000_000)
    }

    #[test]
    fn both_legs_settled_releases() {
        // Source locked ~1M, destination delivered ~1M (both within band) -> Settled -> RELEASE.
        let r = adjudicate_xchain_fill(&claim(), Some(1_000_000), Some(1_005_000), band_15pct());
        assert_eq!(r.verdict, Verdict::Settled);
        assert_eq!(r.decision, FillDecision::Release);
        assert_eq!(r.source_verdict, Verdict::Settled);
        assert_eq!(r.dest_verdict, Verdict::Settled);
    }

    #[test]
    fn locked_on_source_nothing_on_destination_is_hollow_block_the_kill_demo() {
        // THE CAPSTONE DEMO: the source LOCKED a million, the destination delivered ZERO -> a cross-chain
        // HOLLOW fill. A naive integration paid on the source confirmation; ProofAgent BLOCKS.
        let r = adjudicate_xchain_fill(&claim(), Some(1_000_000), Some(0), band_15pct());
        assert_eq!(r.dest_verdict, Verdict::Hollow, "destination delivered nothing");
        assert_eq!(r.verdict, Verdict::Hollow, "the cross-chain fill is hollow");
        assert_eq!(r.decision, FillDecision::Block, "a cross-chain hollow fill is NEVER released");
        assert_ne!(r.verdict, Verdict::Settled);
    }

    #[test]
    fn an_unreadable_leg_dominates_and_blocks() {
        // The source is fine but the destination chain is unreadable -> unverified -> BLOCK (fail-closed).
        let r = adjudicate_xchain_fill(&claim(), Some(1_000_000), None, band_15pct());
        assert_eq!(r.verdict, Verdict::Unverified);
        assert_eq!(r.decision, FillDecision::Block);
        // And symmetrically, an unreadable SOURCE also dominates.
        let r2 = adjudicate_xchain_fill(&claim(), None, Some(1_000_000), band_15pct());
        assert_eq!(r2.verdict, Verdict::Unverified);
        assert_eq!(r2.decision, FillDecision::Block);
    }

    #[test]
    fn an_out_of_band_leg_is_mismatch_block() {
        // Destination delivered far below the claim (outside band, but nonzero) -> mismatch -> BLOCK.
        let r = adjudicate_xchain_fill(&claim(), Some(1_000_000), Some(500_000), band_15pct());
        assert_eq!(r.dest_verdict, Verdict::Mismatch);
        assert_eq!(r.verdict, Verdict::Mismatch);
        assert_eq!(r.decision, FillDecision::Block);
    }

    #[test]
    fn hollow_dominates_mismatch_precedence() {
        // Source mismatch + destination hollow -> the hollow (release-critical) wins.
        let r = adjudicate_xchain_fill(&claim(), Some(500_000), Some(0), band_15pct());
        assert_eq!(r.source_verdict, Verdict::Mismatch);
        assert_eq!(r.dest_verdict, Verdict::Hollow);
        assert_eq!(r.verdict, Verdict::Hollow, "hollow has precedence over mismatch");
    }

    #[test]
    fn verify_xchain_reads_both_chains_independently() {
        // Two SEPARATE tapes (the two chains): source lock recorded settled, destination fill recorded 0.
        let src_key = ReadKey::new(SRC).unwrap();
        let dst_key = ReadKey::new(DST).unwrap();
        let mut src_tape = TapeSource::new().with(src_key.clone(), Observation::new(1_000_000));
        let mut dst_tape = TapeSource::new().with(dst_key.clone(), Observation::new(0));
        let r = verify_xchain_fill(&src_key, &dst_key, &claim(), band_15pct(), &mut src_tape, &mut dst_tape);
        assert_eq!(r.verdict, Verdict::Hollow);
        assert_eq!(r.decision, FillDecision::Block);
        assert_eq!(r.source_observed, Some(1_000_000));
        assert_eq!(r.dest_observed, Some(0));
    }

    #[test]
    fn verify_xchain_off_tape_destination_blocks_unverified() {
        // The destination read is off-tape (unreadable) -> unverified -> BLOCK (never released).
        let src_key = ReadKey::new(SRC).unwrap();
        let dst_key = ReadKey::new(DST).unwrap();
        let mut src_tape = TapeSource::new().with(src_key.clone(), Observation::new(1_000_000));
        let mut dst_tape = TapeSource::new(); // empty -> destination unreadable
        let r = verify_xchain_fill(&src_key, &dst_key, &claim(), band_15pct(), &mut src_tape, &mut dst_tape);
        assert_eq!(r.verdict, Verdict::Unverified);
        assert_eq!(r.decision, FillDecision::Block);
    }

    #[test]
    fn adjudicate_xchain_is_deterministic() {
        for _ in 0..8 {
            assert_eq!(
                adjudicate_xchain_fill(&claim(), Some(1_000_000), Some(0), band_15pct()).decision,
                FillDecision::Block
            );
        }
    }
}
