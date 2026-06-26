//! The FILLER reference loop -- `run_filler(...)`: the honest fill-proof oracle wired into a real
//! intent fill -> prove -> release loop (the LI.FI-Intents frontier, made concrete + end-to-end).
//!
//! ## Why this leg exists (the capstone)
//!
//! [`crate::fillproof`] proves ONE fill; [`crate::slasher`] projects a journal into a mandate standing.
//! This leg is the loop a real Input Settler runs over a BATCH of solver fill claims, composing both.
//! For each request the verifier reads the destination fill INDEPENDENTLY ([`verify_fill`]) and RELEASES
//! the solver ONLY on a chain-confirmed, within-band fill ([`crate::FillDecision::Release`]); every
//! hollow / out-of-band / unreadable fill is BLOCKED (fail-closed, design SS3 principle 3 -- exactly
//! where a hash-only oracle would have paid). The verifier's OWN minted verdicts accrue into a
//! settlement-truth journal, and the [`slash`] projection GATES the loop: once a solver's mandate is
//! REVOKED (N consecutive DISHONEST fills), even an otherwise-releasable fill is WITHHELD -- the slash
//! BITES. Honesty is not just observed; it is enforced as economics, in the loop.
//!
//! ## Honest by construction (the monopoly holds)
//!
//! The filler introduces NO new verdict enum and NO new decision type: it only composes the proven
//! [`verify_fill`] + [`slash`] algebras (design SS3 principle 2, the verdict monopoly). The solver's
//! claim is never trusted -- it is one input of two-source truth, checked against the verifier's own
//! read. The loop is pure + deterministic over the [`Source`] read seam (a [`crate::TapeSource`]
//! offline; the live destination read reuses the settlement [`Source`]), so swapping a taped read for a
//! live one never changes what a settlement *means* -- only its source. The on-chain release gate (the
//! `SettlementOracle` whose `requireProven` reverts unless the attested verdict is `Settled`) is the
//! operator-gated production wiring of exactly this RELEASE-only-on-settled decision.

use crate::{
    slash, verify_fill, FillClaim, FillReport, JournalRecord, MandateStatus, Ratio, ReadKey,
    SlashConfig, SlashReport, Source,
};

/// One intent the filler settles: the solver's [`FillClaim`] (never trusted) + the [`ReadKey`] for the
/// verifier's OWN independent read of the destination fill (the Observation half of two-source truth).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillRequest {
    /// The solver's claim about the fill -- one input of two-source truth, checked against the chain.
    pub claim: FillClaim,
    /// The read-key the verifier uses to read the destination fill INDEPENDENTLY (the Observation).
    pub key: ReadKey,
}

impl FillRequest {
    /// Build a fill request from the solver's [`FillClaim`] and the destination-fill [`ReadKey`].
    #[must_use]
    pub fn new(claim: FillClaim, key: ReadKey) -> FillRequest {
        FillRequest { claim, key }
    }
}

/// The outcome of settling ONE request in the loop: the oracle's report, the mandate standing that
/// gated it, and whether the solver's funds were actually released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settlement {
    /// The oracle's report for this fill: the minted [`crate::Verdict`], the RELEASE/BLOCK decision,
    /// and the two amounts (the solver's claim + the verifier's independent observation).
    pub report: FillReport,
    /// The mandate standing BEFORE this fill was recorded -- the standing that GATES this release.
    pub mandate_before: MandateStatus,
    /// Were the solver's funds actually released? `true` ONLY when the oracle decision is RELEASE AND
    /// the mandate was [`MandateStatus::Active`] before this fill -- a revoked mandate withholds even a
    /// chain-confirmed, within-band fill (the slash bites).
    pub released: bool,
}

impl Settlement {
    /// The reason this settlement did NOT release, if it did not (for the journal/CLI); `None` on
    /// release. A revoked mandate withholds first (the slash bites before the fill is even paid out);
    /// otherwise the oracle's own BLOCK (hollow / out-of-band / unreadable) is the reason.
    #[must_use]
    pub fn withheld_reason(&self) -> Option<&'static str> {
        if self.released {
            return None;
        }
        if self.mandate_before.is_active() {
            Some("oracle blocked")
        } else {
            Some("mandate revoked")
        }
    }
}

/// The end-to-end filler report over a batch: the per-request settlements, the released/withheld
/// accounting (exact-integer minor units, design SS3 principle 5), and the FINAL mandate standing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillerReport {
    /// One [`Settlement`] per request, in batch order.
    pub settlements: Vec<Settlement>,
    /// How many requests released the solver's funds.
    pub released_count: usize,
    /// How many requests were blocked / withheld.
    pub blocked_count: usize,
    /// Total minor units actually paid out to solvers (sum of `claimed_fill` over released settlements).
    pub released_amount: i128,
    /// Total positive minor units CLAIMED but withheld (hollow / out-of-band / unreadable / slashed).
    pub withheld_amount: i128,
    /// Did the mandate become REVOKED at ANY point during the batch? A trailing honest fill can RESET
    /// the slasher's trailing-streak projection, so the FINAL [`FillerReport::mandate`] may read
    /// `Active` even though the solver WAS revoked mid-batch and had a fill withheld for it. This is the
    /// honest "was it ever slashed in this batch" -- the gate's peak, not just the final standing.
    pub peak_revoked: bool,
    /// The final mandate standing after the whole batch (the [`slash`] projection over every verdict).
    pub mandate: SlashReport,
}

impl FillerReport {
    /// A single, human-readable summary line for the CLI/journal (deterministic; design SS3 principle 4).
    ///
    /// The standing reports the honest peak: if the mandate was REVOKED mid-batch but a later honest fill
    /// reset the slasher's trailing streak, it says so explicitly -- so the summary can never read a bare
    /// `ACTIVE` while a fill was withheld for a revoked mandate.
    #[must_use]
    pub fn summary_line(&self) -> String {
        let standing = if self.peak_revoked && self.mandate.status.is_active() {
            format!(
                "was REVOKED mid-batch (final ACTIVE, streak={}/{} -- a later honest fill reset the streak)",
                self.mandate.consecutive_dishonest, self.mandate.revoke_after,
            )
        } else {
            format!(
                "{} (streak={}/{})",
                self.mandate.status, self.mandate.consecutive_dishonest, self.mandate.revoke_after,
            )
        };
        format!(
            "filler: {} released, {} blocked, released={} withheld={} minor-units; mandate {}",
            self.released_count, self.blocked_count, self.released_amount, self.withheld_amount, standing,
        )
    }
}

/// Run the honest settlement loop over a batch of fill requests: release the solver ONLY on a
/// chain-confirmed, within-band fill -- and withhold even an honest fill once the mandate is REVOKED.
///
/// For each request, in order:
/// 1. project the journal-so-far through [`slash`] to read the mandate standing BEFORE this fill;
/// 2. read the destination fill INDEPENDENTLY ([`verify_fill`]) and mint a [`FillReport`] (two-source
///    truth -- the solver's claim is checked against the verifier's OWN read);
/// 3. RELEASE the solver IFF the oracle decision is RELEASE AND the mandate was [`MandateStatus::Active`]
///    before this fill (a revoked mandate withholds even a settled fill -- the slash bites);
/// 4. record this fill's verdict in the journal, so the NEXT request sees the updated standing and the
///    final mandate reflects every fill.
///
/// Pure + deterministic: the same requests + the same [`Source`] yield the same [`FillerReport`], every
/// time (design SS3 principle 4). Exact-integer accounting throughout -- no float on the money path.
#[must_use]
pub fn run_filler(
    requests: &[FillRequest],
    tol: Ratio,
    slash_config: SlashConfig,
    source: &mut dyn Source,
) -> FillerReport {
    let mut journal: Vec<JournalRecord> = Vec::with_capacity(requests.len());
    let mut settlements: Vec<Settlement> = Vec::with_capacity(requests.len());
    let (mut released_count, mut blocked_count) = (0usize, 0usize);
    let (mut released_amount, mut withheld_amount) = (0i128, 0i128);
    let mut peak_revoked = false;

    for request in requests {
        // (1) The mandate standing BEFORE this fill -- the standing that gates this release.
        let mandate_before = slash(&journal, slash_config).status;
        if !mandate_before.is_active() {
            peak_revoked = true; // the solver was revoked at the moment this fill was gated.
        }

        // (2) The verifier's OWN independent read of the destination fill (two-source truth, never the
        // solver's word). An unreadable fill flows to Unverified -> BLOCK (fail-closed), never released.
        let report = verify_fill(&request.key, &request.claim, tol, source);

        // (3) Release IFF the oracle says RELEASE *and* the mandate is still active. A revoked mandate
        // withholds even a chain-confirmed fill -- honesty enforced as economics (design SS3 principle 3).
        let released = report.decision.is_release() && mandate_before.is_active();
        if released {
            released_count += 1;
            // Only a positive claim adds to the payout total -- symmetric with `withheld_amount`: counts
            // track decisions, amounts track value. A non-positive claim releases nothing of value (and
            // the signed-band algebra never lets it produce a negative payout total).
            if request.claim.claimed_fill > 0 {
                released_amount = released_amount.saturating_add(request.claim.claimed_fill);
            }
        } else {
            blocked_count += 1;
            // Withheld value is the positive claim the settler did NOT pay out (a non-positive claim
            // withholds nothing of value -- e.g. the (0, 0) hollow).
            if request.claim.claimed_fill > 0 {
                withheld_amount = withheld_amount.saturating_add(request.claim.claimed_fill);
            }
        }

        // (4) Journal this fill's verdict (the verifier's OWN minted verdict -- never the solver's word),
        // so the slasher's trailing-streak projection sees it for the next request + the final standing.
        journal.push(JournalRecord {
            hash: request.claim.fill_tx.clone(),
            kind: "FILL".to_string(),
            claimed: report.claimed,
            observed: report.observed,
            recorded: true,
            verdict: report.verdict,
        });

        settlements.push(Settlement { report, mandate_before, released });
    }

    let mandate = slash(&journal, slash_config);
    if !mandate.status.is_active() {
        peak_revoked = true; // revoked on the final fill (no later fill to carry it as a `mandate_before`).
    }
    FillerReport {
        settlements,
        released_count,
        blocked_count,
        released_amount,
        withheld_amount,
        peak_revoked,
        mandate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FillDecision, Observation, TapeSource, Verdict};

    /// The canonical demo band from the data spine (`proofagent.toml [verifier.tolerance]`): 15%.
    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    /// A revoke threshold of `n` consecutive dishonest fills.
    fn after(n: u32) -> SlashConfig {
        SlashConfig::new(n).expect("a positive threshold")
    }

    /// The intent source-lock id is informational for the journal (it is not the read key) -- one
    /// well-formed placeholder hash is fine across the batch.
    const INTENT: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    /// Build a filler batch from `(claimed, observed)` specs: each request gets a DISTINCT destination
    /// fill key, and the tape records its observation (`None` = off-tape, i.e. the verifier could not
    /// read that fill -> Unverified).
    fn batch(specs: &[(i128, Option<i128>)]) -> (Vec<FillRequest>, TapeSource) {
        let mut tape = TapeSource::new();
        let mut requests = Vec::with_capacity(specs.len());
        for (i, &(claimed, observed)) in specs.iter().enumerate() {
            let fill_tx = format!("0x{:064x}", i + 1);
            let key = ReadKey::new(&fill_tx).expect("well-formed 32-byte hash");
            if let Some(v) = observed {
                tape.record(key.clone(), Observation::new(v));
            }
            requests.push(FillRequest::new(FillClaim::new(INTENT, fill_tx, claimed), key));
        }
        (requests, tape)
    }

    // --- The happy path: honest fills release ------------------------------------------------------

    #[test]
    fn all_honest_fills_release_everything() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(1_000_000)), (500_000, Some(500_000)), (2_000_000, Some(2_000_000))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.released_count, 3);
        assert_eq!(r.blocked_count, 0);
        assert_eq!(r.released_amount, 3_500_000);
        assert_eq!(r.withheld_amount, 0);
        assert_eq!(r.mandate.status, MandateStatus::Active);
        assert_eq!(r.mandate.consecutive_dishonest, 0);
        assert!(!r.peak_revoked, "an all-honest batch is never revoked");
        for s in &r.settlements {
            assert!(s.released);
            assert_eq!(s.report.verdict, Verdict::Settled);
            assert_eq!(s.withheld_reason(), None);
        }
    }

    // --- A single hollow is blocked; the rest still release ----------------------------------------

    #[test]
    fn one_hollow_fill_is_blocked_others_release() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(1_000_000)), (1_000_000, Some(0)), (1_000_000, Some(1_000_000))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.released_count, 2);
        assert_eq!(r.blocked_count, 1);
        assert_eq!(r.released_amount, 2_000_000);
        assert_eq!(r.withheld_amount, 1_000_000);
        // The middle fill is the hollow: blocked by the oracle, not the mandate (which was active).
        let mid = r.settlements[1];
        assert!(!mid.released);
        assert_eq!(mid.report.verdict, Verdict::Hollow);
        assert_eq!(mid.report.decision, FillDecision::Block);
        assert_eq!(mid.withheld_reason(), Some("oracle blocked"));
        // One settled at the end breaks the streak -> the mandate still stands.
        assert_eq!(r.mandate.status, MandateStatus::Active);
    }

    // --- THE KILL DEMO: two consecutive hollow fills revoke the mandate ----------------------------

    #[test]
    fn two_consecutive_hollow_fills_revoke_the_mandate_the_kill_demo() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(1_000_000)), (1_000_000, Some(0)), (1_000_000, Some(0))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.mandate.status, MandateStatus::Revoked, "two hollow fills in a row -> REVOKED");
        assert_eq!(r.mandate.consecutive_dishonest, 2);
        assert_eq!(r.released_count, 1, "only the first, honest fill released");
        assert_eq!(r.blocked_count, 2);
        // Both hollow fills were blocked by the oracle while the mandate was still active.
        assert_eq!(r.settlements[1].report.verdict, Verdict::Hollow);
        assert_eq!(r.settlements[2].report.verdict, Verdict::Hollow);
        assert!(!r.mandate.status.is_active());
        assert!(r.peak_revoked);
    }

    // --- THE SLASH BITES: a revoked mandate withholds even an HONEST fill --------------------------

    #[test]
    fn a_revoked_mandate_withholds_even_an_honest_fill_the_slash_bites() {
        // Two hollow fills revoke the mandate; the THIRD fill is genuinely settled -- yet it is WITHHELD,
        // because the solver's mandate was already revoked. The oracle says RELEASE; the slash overrules.
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(0)), (1_000_000, Some(0)), (1_000_000, Some(1_000_000))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        let third = r.settlements[2];
        assert_eq!(third.report.verdict, Verdict::Settled, "the chain confirms the third fill");
        assert_eq!(third.report.decision, FillDecision::Release, "the oracle alone would RELEASE");
        assert_eq!(third.mandate_before, MandateStatus::Revoked, "but the mandate was already revoked");
        assert!(!third.released, "so the honest fill is WITHHELD -- the slash bites");
        assert_eq!(third.withheld_reason(), Some("mandate revoked"));
        assert_eq!(r.released_count, 0, "nothing released -- two lies cost the solver its honest fill");
        assert_eq!(r.released_amount, 0);
        assert!(r.peak_revoked, "the mandate was revoked mid-batch even if a trailing settled reset it");
    }

    // --- A settled fill between two hollows prevents the revoke ------------------------------------

    #[test]
    fn a_settled_fill_between_two_hollows_prevents_revoke() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(0)), (1_000_000, Some(1_000_000)), (1_000_000, Some(0))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.mandate.status, MandateStatus::Active, "the honest fill broke the dishonest run");
        assert_eq!(r.mandate.consecutive_dishonest, 1);
        assert_eq!(r.released_count, 1);
        assert_eq!(r.blocked_count, 2);
    }

    // --- An unreadable fill blocks as unverified and never counts toward a slash -------------------

    #[test]
    fn an_unreadable_fill_blocks_as_unverified_and_does_not_slash() {
        let (reqs, mut tape) = batch(&[(1_000_000, None)]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.released_count, 0);
        assert_eq!(r.blocked_count, 1);
        assert_eq!(r.withheld_amount, 1_000_000);
        let only = r.settlements[0];
        assert_eq!(only.report.verdict, Verdict::Unverified);
        assert!(!only.released);
        // Unverified is undetermined -- it never counts toward a slash.
        assert_eq!(r.mandate.status, MandateStatus::Active);
        assert_eq!(r.mandate.consecutive_dishonest, 0);
        assert_eq!(r.mandate.unverified, 1);
    }

    // --- An empty batch is a clean, active, zero report -------------------------------------------

    #[test]
    fn an_empty_batch_is_active_and_zero() {
        let mut tape = TapeSource::new();
        let r = run_filler(&[], band_15pct(), after(2), &mut tape);
        assert!(r.settlements.is_empty());
        assert_eq!(r.released_count, 0);
        assert_eq!(r.blocked_count, 0);
        assert_eq!(r.released_amount, 0);
        assert_eq!(r.withheld_amount, 0);
        assert_eq!(r.mandate.status, MandateStatus::Active);
        assert_eq!(r.mandate.total, 0);
        assert!(!r.peak_revoked);
    }

    // --- Exact-integer released / withheld accounting ---------------------------------------------

    #[test]
    fn released_and_withheld_amounts_account_exactly() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(1_000_000)), (3_000_000, Some(0)), (2_000_000, Some(2_000_000))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.released_amount, 3_000_000, "1_000_000 + 2_000_000 paid out");
        assert_eq!(r.withheld_amount, 3_000_000, "the 3_000_000 hollow withheld");
        assert_eq!(r.released_count, 2);
        assert_eq!(r.blocked_count, 1);
    }

    // --- A non-positive claim never corrupts the payout totals (symmetric accounting) -------------

    #[test]
    fn a_negative_claim_does_not_corrupt_the_payout_total() {
        // A negative "delivery" is outside the realistic intent domain, but the i128 claim type allows
        // it. The signed band algebra settles a matching negative claim/observation, so the gate would
        // RELEASE it -- but the payout total must NOT go negative: `released_amount` counts only positive
        // value (symmetric with `withheld_amount`), so a released negative claim contributes nothing.
        let (reqs, mut tape) = batch(&[(1_000_000, Some(1_000_000)), (-1_000_000, Some(-1_000_000))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        assert_eq!(r.released_count, 2, "both legs clear the gate (a matching negative is within band)");
        assert_eq!(r.released_amount, 1_000_000, "only the positive claim adds to the payout total");
        assert!(r.released_amount >= 0, "the payout total is never negative");
        assert_eq!(r.blocked_count, 0);
        assert!(!r.peak_revoked);
    }

    // --- mandate_before is the standing PRIOR to each fill ----------------------------------------

    #[test]
    fn mandate_before_reflects_the_standing_prior_to_each_fill() {
        let (reqs, mut tape) = batch(&[(1_000_000, Some(0)), (1_000_000, Some(0))]);
        let r = run_filler(&reqs, band_15pct(), after(2), &mut tape);
        // Before fill 1 the journal is empty -> active; before fill 2 it is [hollow], streak 1 -> active.
        assert_eq!(r.settlements[0].mandate_before, MandateStatus::Active);
        assert_eq!(r.settlements[1].mandate_before, MandateStatus::Active);
        // Only AFTER fill 2 does the standing flip to revoked.
        assert_eq!(r.mandate.status, MandateStatus::Revoked);
    }

    // --- Determinism: same batch -> same report, every time ---------------------------------------

    #[test]
    fn run_filler_is_deterministic() {
        let specs = [(1_000_000, Some(0)), (1_000_000, Some(0)), (1_000_000, Some(1_000_000))];
        let (reqs0, mut tape0) = batch(&specs);
        let first = run_filler(&reqs0, band_15pct(), after(2), &mut tape0);
        for _ in 0..8 {
            let (reqs, mut tape) = batch(&specs);
            assert_eq!(run_filler(&reqs, band_15pct(), after(2), &mut tape), first);
        }
    }

    // --- The summary line renders the scoreboard --------------------------------------------------

    #[test]
    fn summary_line_renders_the_kill_demo() {
        let (reqs, mut tape) =
            batch(&[(1_000_000, Some(1_000_000)), (1_000_000, Some(0)), (1_000_000, Some(0))]);
        let line = run_filler(&reqs, band_15pct(), after(2), &mut tape).summary_line();
        assert!(line.contains("REVOKED"), "{line}");
        assert!(line.contains("2 blocked"), "{line}");
        assert!(line.contains("streak=2/2"), "{line}");
    }
}
