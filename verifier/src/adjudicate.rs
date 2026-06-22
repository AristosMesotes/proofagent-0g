//! The settlement algebra -- `adjudicate(Claim, Observation)`.
//!
//! Design SS3 principle 1 (two-source truth): "The agent's report of an action is a **Claim**
//! (never trusted). The verifier's independent on-chain read is the **Observation**. The verdict is
//! `adjudicate(Claim, Observation)` -- the agent's word is only ever *one* input, checked against the
//! chain."
//!
//! Design SS3 principle 5 (exact-integer money): "Amounts are compared in minor units with
//! exact-integer tolerance bands -- **no floating point** on the money path." There is NO `f32`/`f64`
//! anywhere in this module by construction; every comparison is `i128` integer arithmetic.
//!
//! Design SS3 principle 3 (never fabricate): the keystone branch is `observed == None -> Unverified`.
//! An absent observation can NEVER collapse into a fabricated `Settled` -- it degrades loudly.
//!
//! Design SS3 principle 4 (deterministic): the function is pure -- same inputs always yield the same
//! verdict, byte-identically, with no wall-clock, no global state, and no floating-point rounding.
//!
//! ## The decision tree (design SS3, the verdict algebra), evaluated strictly in order:
//!
//! 1. `observed == None`                 -> [`Verdict::Unverified`]  (the keystone -- never fabricate)
//! 2. `claimed == 0 && observed == Some(0)` -> [`Verdict::Hollow`]   (a claimed-nothing, got-nothing)
//! 3. `|claimed - observed| <= floor(|claimed| * num / den)` -> [`Verdict::Settled`]
//! 4. else                               -> [`Verdict::Mismatch`]
//!
//! All values are minor-unit integers (e.g. wei / token base units), so the tolerance band
//! `floor(|claimed| * num / den)` is an exact-integer count of minor units -- no rounding error.

use crate::Verdict;

/// An exact-integer tolerance ratio `num / den`, applied to the *claimed* magnitude.
///
/// Design SS3 principle 5 (exact-integer money): the tolerance band is `floor(|claimed| * num / den)`
/// minor units -- a pure-integer computation, never a float percentage. This mirrors the data-spine
/// shape `[verifier.tolerance] num / den` in `proofagent.toml` (e.g. `15 / 100` = a 15% band).
///
/// The fields are private so a `Ratio` can only be built through [`Ratio::new`], which rejects the
/// ill-formed shapes (`den == 0`, negative components) that would otherwise make the band undefined
/// or let a "tolerance" widen a mismatch into a false `Settled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ratio {
    num: i128,
    den: i128,
}

impl Ratio {
    /// Build a tolerance ratio `num / den`.
    ///
    /// Returns `None` for an ill-formed ratio so the money path never silently does the wrong thing
    /// (design SS3 principle 5 -- the band must be well-defined):
    ///
    /// - `den <= 0` -- a zero or negative denominator has no exact-integer meaning (and `den == 0`
    ///   would be a division-by-zero panic; we refuse it rather than risk an unwrap).
    /// - `num < 0`  -- a negative numerator would make the band negative, so *every* nonzero claim
    ///   would read as `Mismatch`; that is a misconfiguration, not a tolerance.
    ///
    /// `num == 0` is permitted: it is the *exact-equality* band (zero slack) -- the strictest honest
    /// tolerance, where only an observation equal to the claim settles.
    #[must_use]
    pub const fn new(num: i128, den: i128) -> Option<Ratio> {
        if den <= 0 || num < 0 {
            return None;
        }
        Some(Ratio { num, den })
    }

    /// The numerator of the tolerance ratio.
    #[must_use]
    pub const fn num(&self) -> i128 {
        self.num
    }

    /// The denominator of the tolerance ratio (always `> 0` by construction).
    #[must_use]
    pub const fn den(&self) -> i128 {
        self.den
    }

    /// The exact-integer tolerance band `floor(|claimed| * num / den)`, in minor units.
    ///
    /// Returns `None` only on an arithmetic edge that cannot be represented exactly in `i128`
    /// (`|claimed|` overflow at `i128::MIN`, or `|claimed| * num` overflow). Per design SS3
    /// principle 3 (never fabricate), an unrepresentable band must NOT be silently treated as a
    /// huge-or-zero slack: the caller degrades such a case to a non-`Settled` verdict rather than
    /// guess. No floating point is used; the multiply-then-floor-divide is exact for all
    /// representable inputs.
    #[must_use]
    fn band(&self, claimed: i128) -> Option<i128> {
        // |claimed| without the i128::MIN abs panic (checked_abs returns None at MIN).
        let mag = claimed.checked_abs()?;
        // mag * num then integer floor-division by den (den > 0 by construction, so no div panic and
        // the floor is toward zero == mathematical floor for the non-negative numerator mag*num).
        let scaled = mag.checked_mul(self.num)?;
        Some(scaled / self.den)
    }
}

/// Adjudicate a claimed amount against an independently observed amount, in minor units.
///
/// This is the settlement algebra (design SS3 principle 1, two-source truth). `claimed` is the
/// agent's word; `observed` is the verifier's independent on-chain read. The returned [`Verdict`] is
/// minted here -- inside the verifier crate -- preserving the verdict monopoly (design SS3
/// principle 2): no caller outside this crate can construct a verdict, only obtain one from this
/// function.
///
/// The decision tree is evaluated strictly in the documented order (see the module docs). It is
/// total (every input maps to exactly one verdict), pure, panic-free, and float-free.
///
/// # Examples
///
/// ```
/// use verifier::{adjudicate, Ratio, Verdict};
/// let tol = Ratio::new(15, 100).unwrap(); // a 15% band
/// // No observation -> the keystone degrade, never a fabricated success.
/// assert_eq!(adjudicate(1_000, None, tol), Verdict::Unverified);
/// // Within band -> settled.
/// assert_eq!(adjudicate(1_000, Some(1_100), tol), Verdict::Settled);
/// // Outside band -> mismatch.
/// assert_eq!(adjudicate(1_000, Some(1_200), tol), Verdict::Mismatch);
/// ```
#[must_use]
pub fn adjudicate(claimed: i128, observed: Option<i128>, tol: Ratio) -> Verdict {
    // (1) Keystone (design SS3 principle 3): no observation -> Unverified. Evaluated FIRST so an
    // absent read can never fall through into a fabricated Settled.
    let Some(observed) = observed else {
        return Verdict::unverified();
    };

    // (2) Hollow: claimed nothing AND observed nothing. A genuine "no economic effect" -- the
    // transaction is real but moved zero, exactly as (not) claimed.
    if claimed == 0 && observed == 0 {
        return Verdict::hollow();
    }

    // (3) Settled: |claimed - observed| <= floor(|claimed| * num / den).
    //
    // |claimed - observed| via checked arithmetic so an i128 wrap can never masquerade as a small
    // delta (which would be a fabricated Settled). checked_sub is None only on overflow; checked_abs
    // is None only at i128::MIN. The tolerance band is likewise checked. If ANY of these cannot be
    // represented exactly, we do NOT settle -- we fall through to Mismatch (design SS3 principle 3:
    // never fabricate a success out of an arithmetic edge).
    let within_band = claimed
        .checked_sub(observed)
        .and_then(i128::checked_abs)
        .zip(tol.band(claimed))
        .is_some_and(|(delta, band)| delta <= band);

    if within_band {
        return Verdict::settled();
    }

    // (4) Otherwise: the chain disagrees with the claim beyond tolerance -> Mismatch.
    Verdict::mismatch()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical demo band from the data spine (`proofagent.toml [verifier.tolerance]`): 15%.
    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    // --- Ratio construction (the band must be well-defined; design SS3 principle 5) -------------

    #[test]
    fn ratio_rejects_zero_denominator() {
        // den == 0 would be a division-by-zero panic on the money path -- refuse it.
        assert_eq!(Ratio::new(15, 0), None);
    }

    #[test]
    fn ratio_rejects_negative_denominator() {
        assert_eq!(Ratio::new(15, -100), None);
    }

    #[test]
    fn ratio_rejects_negative_numerator() {
        // A negative band would mark every nonzero claim as Mismatch -- a misconfiguration.
        assert_eq!(Ratio::new(-1, 100), None);
    }

    #[test]
    fn ratio_accepts_zero_numerator_as_exact_equality_band() {
        // Zero slack is the strictest honest tolerance, not an error.
        let exact = Ratio::new(0, 100).expect("0/100 is valid -- exact equality");
        assert_eq!(exact.num(), 0);
        assert_eq!(exact.den(), 100);
    }

    // --- The FOUR verdicts (the verdict alphabet, design SS2) ------------------------------------

    #[test]
    fn unverified_when_no_observation() {
        // VERDICT 1/4: the keystone. observed == None -> Unverified, regardless of the claim
        // (design SS3 principle 3, never fabricate).
        assert_eq!(adjudicate(0, None, band_15pct()), Verdict::Unverified);
        assert_eq!(adjudicate(1_000, None, band_15pct()), Verdict::Unverified);
        assert_eq!(adjudicate(i128::MAX, None, band_15pct()), Verdict::Unverified);
        assert_eq!(adjudicate(i128::MIN, None, band_15pct()), Verdict::Unverified);
    }

    #[test]
    fn hollow_when_claimed_zero_and_observed_zero() {
        // VERDICT 2/4: claimed nothing, observed nothing.
        assert_eq!(adjudicate(0, Some(0), band_15pct()), Verdict::Hollow);
        // Hollow takes precedence over the band check for the (0, 0) case.
        assert_eq!(adjudicate(0, Some(0), Ratio::new(0, 1).unwrap()), Verdict::Hollow);
    }

    #[test]
    fn settled_within_tolerance_band() {
        // VERDICT 3/4: |1000 - 1100| = 100 <= floor(1000 * 15 / 100) = 150 -> Settled.
        assert_eq!(adjudicate(1_000, Some(1_100), band_15pct()), Verdict::Settled);
        // Exact match always settles (delta 0 <= any band >= 0).
        assert_eq!(adjudicate(1_000, Some(1_000), band_15pct()), Verdict::Settled);
        // Under-delivery within band settles symmetrically: |1000 - 900| = 100 <= 150.
        assert_eq!(adjudicate(1_000, Some(900), band_15pct()), Verdict::Settled);
        // A claimed-zero with an observed within band: floor(|0|*15/100) = 0, so only observed == 0
        // would settle -- but (0,0) is Hollow, so a nonzero observed against claim 0 is Mismatch.
        assert_eq!(adjudicate(0, Some(5), band_15pct()), Verdict::Mismatch);
    }

    #[test]
    fn mismatch_outside_tolerance_band() {
        // VERDICT 4/4: |1000 - 1200| = 200 > floor(1000 * 15 / 100) = 150 -> Mismatch.
        assert_eq!(adjudicate(1_000, Some(1_200), band_15pct()), Verdict::Mismatch);
        // Under-delivery outside band: |1000 - 800| = 200 > 150.
        assert_eq!(adjudicate(1_000, Some(800), band_15pct()), Verdict::Mismatch);
    }

    // --- The BOUNDARY case (the spec mandates one) ----------------------------------------------

    #[test]
    fn boundary_delta_exactly_equal_to_band_settles() {
        // The band is INCLUSIVE (`<=`). With claim 1000 and a 15% band, floor(1000*15/100) = 150.
        // A delta of EXACTLY 150 must settle; one minor unit more must not.
        let tol = band_15pct();
        assert_eq!(adjudicate(1_000, Some(1_150), tol), Verdict::Settled, "delta 150 == band -> Settled");
        assert_eq!(adjudicate(1_000, Some(850), tol), Verdict::Settled, "delta 150 == band (under) -> Settled");
        assert_eq!(adjudicate(1_000, Some(1_151), tol), Verdict::Mismatch, "delta 151 > band -> Mismatch");
        assert_eq!(adjudicate(1_000, Some(849), tol), Verdict::Mismatch, "delta 151 > band (under) -> Mismatch");
    }

    #[test]
    fn floor_truncates_the_band_exactly() {
        // floor(|claimed| * num / den) must truncate, never round up. claim 7, 15% band:
        // 7 * 15 / 100 = 105 / 100 = 1 (floor), NOT 2. So delta 1 settles, delta 2 mismatches.
        let tol = band_15pct();
        assert_eq!(adjudicate(7, Some(8), tol), Verdict::Settled, "delta 1 <= floor(105/100)=1");
        assert_eq!(adjudicate(7, Some(6), tol), Verdict::Settled, "delta 1 <= 1 (under)");
        assert_eq!(adjudicate(7, Some(9), tol), Verdict::Mismatch, "delta 2 > 1");
    }

    #[test]
    fn zero_band_demands_exact_equality() {
        // num == 0 -> band 0 -> only an observation equal to the claim settles.
        let exact = Ratio::new(0, 100).unwrap();
        assert_eq!(adjudicate(500, Some(500), exact), Verdict::Settled);
        assert_eq!(adjudicate(500, Some(501), exact), Verdict::Mismatch);
        assert_eq!(adjudicate(500, Some(499), exact), Verdict::Mismatch);
    }

    // --- Determinism & total-function properties (design SS3 principle 4) ------------------------

    #[test]
    fn adjudicate_is_deterministic() {
        // Same inputs -> identical verdict, every call (no wall-clock, no global state).
        for _ in 0..8 {
            assert_eq!(adjudicate(1_000, Some(1_100), band_15pct()), Verdict::Settled);
            assert_eq!(adjudicate(1_000, Some(2_000), band_15pct()), Verdict::Mismatch);
            assert_eq!(adjudicate(0, Some(0), band_15pct()), Verdict::Hollow);
            assert_eq!(adjudicate(1, None, band_15pct()), Verdict::Unverified);
        }
    }

    #[test]
    fn negative_amounts_use_absolute_magnitude_for_the_band() {
        // Minor units can be negative (e.g. a net debit). The band scales on |claimed|, and the
        // delta is |claimed - observed| -- both sign-independent.
        let tol = band_15pct();
        // claim -1000, observed -1100: delta 100 <= floor(1000*15/100)=150 -> Settled.
        assert_eq!(adjudicate(-1_000, Some(-1_100), tol), Verdict::Settled);
        // claim -1000, observed -1200: delta 200 > 150 -> Mismatch.
        assert_eq!(adjudicate(-1_000, Some(-1_200), tol), Verdict::Mismatch);
    }

    #[test]
    fn extreme_magnitudes_do_not_panic_and_never_fabricate_settled() {
        // i128::MIN can't be abs'd; |claimed|*num can overflow. Per design SS3 principle 3 these
        // arithmetic edges must NOT yield a fabricated Settled -- they fall through to a non-Settled
        // verdict, and crucially must not panic (the money path stays alive and honest).
        let tol = band_15pct();
        // claimed == i128::MIN, observed present: band() is None (abs overflow) -> not Settled.
        assert_ne!(adjudicate(i128::MIN, Some(i128::MIN), tol), Verdict::Settled);
        // A claim so large that claimed*num overflows i128 -> band None -> not Settled.
        let huge = i128::MAX;
        assert_ne!(adjudicate(huge, Some(huge), tol), Verdict::Settled);
        // delta computation overflow (MAX - MIN) must not panic; result is a non-Settled verdict.
        let _ = adjudicate(i128::MAX, Some(i128::MIN), tol);
    }

    #[test]
    fn every_input_maps_to_exactly_one_of_the_four_verdicts() {
        // Total-function sanity across a small grid: the result is always in the alphabet.
        let tol = band_15pct();
        let claims = [-3_i128, 0, 1, 7, 1_000];
        let obs = [None, Some(-3), Some(0), Some(1), Some(1_000)];
        for &c in &claims {
            for &o in &obs {
                let v = adjudicate(c, o, tol);
                assert!(
                    matches!(
                        v,
                        Verdict::Settled | Verdict::Hollow | Verdict::Mismatch | Verdict::Unverified
                    ),
                    "verdict {v} for (claimed={c}, observed={o:?}) must be in the four-verdict alphabet"
                );
            }
        }
    }
}
