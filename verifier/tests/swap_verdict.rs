//! Integration test -- the verifier's SWAP verdict-extension (design WOW Feature 1), driven by a
//! deterministic, OFFLINE [`SwapTape`] of recorded `Swap`-event reads.
//!
//! Design WOW Feature 1 ("wrapped by the proofs"): after a Uniswap-V3 single-hop swap is broadcast,
//! "the verifier reads 0G directly, decodes the `Swap` event + realized deltas, and mints
//! settled / hollow / mismatch / unverified -- never the front-end's word." This file is the
//! offline-buildable, tape-tested proof of that algebra end to end: it replays recorded realized-output
//! observations (the shape the `live` `LiveSwapSource` decodes from the pool's `Swap` log on 0G mainnet
//! 16661) and proves the verifier mints the right verdict for each case -- the SAME four-verdict alphabet
//! the settlement leg uses, through the one [`verifier::Verdict`] monopoly.
//!
//! The swap leg is MAINNET-only on 0G (Oku/Uniswap-V3 has no 16602 deployment), so a live swap is
//! operator-gated; these recorded observations replay the realized-output read deterministically and at
//! $0, with no network, exactly as `mandate_tiers.rs` replays the live gate reads.

use verifier::{verify_swap, ReadKey, Ratio, SwapClaim, SwapObservation, SwapTape, Verdict};

// A representative single-hop swap claim (output token MINOR units): the agent quoted `expected_out`
// and set an on-chain `amount_out_minimum` slippage floor in `exactInputSingle`.
const EXPECTED_OUT: i128 = 1_000_000; // e.g. 1.0 USDC.e (6-dec) quoted out
const FLOOR: i128 = 990_000; // amountOutMinimum -- a 1% slippage floor the agent set on-chain

// Well-formed 32-byte tx hashes for the four recorded swap outcomes.
const TX_SETTLED: &str = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const TX_HOLLOW: &str = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const TX_MISMATCH: &str = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const TX_UNKNOWN: &str = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

fn key(h: &str) -> ReadKey {
    ReadKey::new(h).expect("test hash is well-formed")
}

fn band_15pct() -> Ratio {
    Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
}

fn claim() -> SwapClaim {
    SwapClaim::new(EXPECTED_OUT, FLOOR)
}

#[test]
fn each_swap_outcome_mints_the_right_verdict_from_recorded_swap_event_reads() {
    // The tape carries the realized `amountOut` the verifier WOULD decode from each tx's `Swap` log:
    //   settled  -> realized 1_005_000  (>= floor 990_000 AND within 15% band of expected 1_000_000)
    //   hollow   -> realized 0          (the tx succeeded but the swap moved nothing -- no realized out)
    //   mismatch -> realized 980_000    (BELOW the on-chain floor 990_000 -- slippage protection refuted)
    //   unknown  -> NOT on the tape     (an off-record / unreadable swap -> the loud Unverified)
    let mut tape = SwapTape::new()
        .with(key(TX_SETTLED), SwapObservation::new(1_005_000))
        .with(key(TX_HOLLOW), SwapObservation::new(0))
        .with(key(TX_MISMATCH), SwapObservation::new(980_000));

    let settled = verify_swap(&key(TX_SETTLED), &claim(), band_15pct(), &mut tape);
    assert_eq!(settled.verdict, Verdict::Settled, "in-band, above-floor swap settles");
    assert_eq!(settled.verdict_string(), "settled");
    assert_eq!(settled.amount_out, Some(1_005_000));

    let hollow = verify_swap(&key(TX_HOLLOW), &claim(), band_15pct(), &mut tape);
    assert_eq!(hollow.verdict, Verdict::Hollow, "a swap that realized nothing is hollow");
    assert_eq!(hollow.amount_out, Some(0));

    let mismatch = verify_swap(&key(TX_MISMATCH), &claim(), band_15pct(), &mut tape);
    assert_eq!(mismatch.verdict, Verdict::Mismatch, "below the on-chain floor is a loud mismatch");
    assert_ne!(mismatch.verdict, Verdict::Settled, "a below-floor swap NEVER settles");

    let unverified = verify_swap(&key(TX_UNKNOWN), &claim(), band_15pct(), &mut tape);
    assert_eq!(unverified.verdict, Verdict::Unverified, "an off-record swap degrades LOUDLY");
    assert_eq!(unverified.amount_out, None);
    assert_ne!(unverified.verdict, Verdict::Settled, "NEVER a fabricated settled (design SS3 #3)");
}

#[test]
fn the_swap_neg_case_an_unreadable_swap_is_unverified_never_settled() {
    // The NEG case for the swap leg (design SS2 / SS3 principle 3): a fabricated / unreadable swap tx
    // (empty tape) stamps Unverified -- the verifier reads the chain, and an absent read can NEVER
    // collapse into a fabricated settled. This is the swap analogue of the settlement NEG case.
    let mut tape = SwapTape::new(); // empty -> every swap read is off-tape

    let report = verify_swap(&key(TX_SETTLED), &claim(), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Unverified);
    assert_ne!(report.verdict, Verdict::Settled, "a fabricated swap hash must stamp Unverified");
    assert_eq!(report.amount_out, None, "no realized output for an unreadable swap");
}

#[test]
fn the_on_chain_floor_dominates_a_near_expected_but_below_floor_swap_is_mismatch() {
    // The hard protocol-native floor wins over the soft tolerance band: a realized output that is close
    // to `expected` (would pass the band) but BELOW the on-chain `amountOutMinimum` is a loud mismatch,
    // because the protocol itself should have reverted it. This is the swap-specific safety invariant.
    let mut tape = SwapTape::new()
        .with(key(TX_MISMATCH), SwapObservation::new(EXPECTED_OUT - 1)); // 999_999, just below expected
    // Set the floor ABOVE expected so even a near-expected output is below the floor.
    let high_floor_claim = SwapClaim::new(EXPECTED_OUT, EXPECTED_OUT); // floor == expected
    let report = verify_swap(&key(TX_MISMATCH), &high_floor_claim, band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Mismatch, "below the on-chain floor never settles");
}

#[test]
fn the_swap_verdict_is_deterministic_across_repeated_runs() {
    // Design SS3 principle 4: the same recorded tape + claim -> a byte-identical report, every run.
    let build = || {
        SwapTape::new()
            .with(key(TX_SETTLED), SwapObservation::new(1_005_000))
            .with(key(TX_MISMATCH), SwapObservation::new(980_000))
    };
    let mut first_tape = build();
    let first = verify_swap(&key(TX_SETTLED), &claim(), band_15pct(), &mut first_tape);
    for _ in 0..8 {
        let mut t = build();
        assert_eq!(verify_swap(&key(TX_SETTLED), &claim(), band_15pct(), &mut t), first);
    }
}
