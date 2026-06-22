//! Integration test -- the verifier's ROUTE verdict-extension (design WOW Feature 2), driven by a
//! deterministic, OFFLINE [`RouteTape`] of recorded route reads (the rail's settle/refund event +
//! delivered amount).
//!
//! Design WOW Feature 2 ("wrapped by the proofs"): after a routed leg settles, "the verifier reads 0G
//! directly (never the aggregator API) and mints one verdict per leg -- for [the intent rail] it treats
//! `refunded` as a non-settlement terminal state (mandate-safe) and only `filled`-with-matching-on-chain-
//! transfer as `settled`; it catches API false-`filled` (hollow) and slippage/wrong-asset/refund-as-fill
//! (mismatch)." This file is the offline-buildable, tape-tested proof of that algebra end to end across
//! all three rails (intent / aggregation / native AMM): it replays recorded route observations (the shape
//! the `live` `LiveRouteSource` decodes from the rail's settle/refund log on 0G) and proves the verifier
//! mints the right verdict for each case -- the SAME four-verdict alphabet the settlement leg uses,
//! through the one [`verifier::Verdict`] monopoly.
//!
//! The cross-chain rails (intent/aggregation) are MAINNET-only and the native-AMM rail is testnet-able on
//! Galileo (16602); these recorded observations replay the route read deterministically and at $0, with no
//! network, exactly as `swap_verdict.rs` replays the live swap reads.

use verifier::{
    verify_route, verify_route_leg, ReadKey, Ratio, RouteClaim, RouteObservation, RouteRail,
    RouteTape, RouteTerminal, Verdict,
};

// A representative routed-leg claim (output token MINOR units): the agent quoted `EXPECTED_OUT` and
// bound the leg with an on-chain `MIN_OUT` minimum-output floor (the rail's slippage/route-quality bound).
const EXPECTED_OUT: i128 = 1_000_000; // e.g. 1.0 USDC.e (6-dec) quoted out on this leg
const MIN_OUT: i128 = 990_000; // the on-chain min-output floor the agent set (a 1% bound)

// Well-formed 32-byte tx hashes for the four recorded route-leg outcomes.
const TX_SETTLED: &str = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const TX_REFUNDED: &str = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const TX_MISMATCH: &str = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const TX_FALSEFILL: &str = "0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
const TX_UNKNOWN: &str = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

fn key(h: &str) -> ReadKey {
    ReadKey::new(h).expect("test hash is well-formed")
}

fn band_15pct() -> Ratio {
    Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
}

fn claim(rail: RouteRail) -> RouteClaim {
    RouteClaim::new(rail, EXPECTED_OUT, MIN_OUT)
}

#[test]
fn each_route_outcome_mints_the_right_verdict_from_recorded_rail_reads() {
    // The tape carries the rail settle/refund outcome the verifier WOULD decode from each leg's tx:
    //   settled    -> filled, delivered 1_005_000  (>= floor 990_000 AND within 15% band of 1_000_000)
    //   refunded   -> a non-settlement terminal (the Khalani rule) -- delivered nothing
    //   mismatch   -> filled, delivered 980_000    (BELOW the on-chain floor 990_000 -- bound violated)
    //   false-fill -> filled, delivered 0          (the rail SAYS filled but the chain delivered nothing)
    //   unknown    -> NOT on the tape               (an off-record / unreadable leg -> the loud Unverified)
    let mut tape = RouteTape::new()
        .with(key(TX_SETTLED), RouteObservation::filled(1_005_000))
        .with(key(TX_REFUNDED), RouteObservation::refunded())
        .with(key(TX_MISMATCH), RouteObservation::filled(980_000))
        .with(key(TX_FALSEFILL), RouteObservation::filled(0));

    // The native-AMM rail (JAINE, testnet-able) settles in-band, above-floor -> settled.
    let settled = verify_route_leg(&key(TX_SETTLED), &claim(RouteRail::NativeAmm), band_15pct(), &mut tape);
    assert_eq!(settled.verdict, Verdict::Settled, "in-band, above-floor fill settles");
    assert_eq!(settled.verdict_string(), "settled");
    assert_eq!(settled.delivered, Some(1_005_000));
    assert_eq!(settled.terminal, Some(RouteTerminal::Filled));

    // The intent rail (Khalani) refunded -> a non-settlement terminal -> hollow, NEVER settled.
    let refunded = verify_route_leg(&key(TX_REFUNDED), &claim(RouteRail::Intent), band_15pct(), &mut tape);
    assert_eq!(refunded.verdict, Verdict::Hollow, "a refunded intent leg is a non-settlement terminal");
    assert_eq!(refunded.terminal, Some(RouteTerminal::Refunded));
    assert_ne!(refunded.verdict, Verdict::Settled, "a refund is NEVER a fabricated settle (design WOW F2)");

    // A below-floor fill on the aggregation rail -> a loud mismatch (the route-quality bound was violated).
    let mismatch = verify_route_leg(&key(TX_MISMATCH), &claim(RouteRail::Aggregation), band_15pct(), &mut tape);
    assert_eq!(mismatch.verdict, Verdict::Mismatch, "a below-floor fill is a loud mismatch");
    assert_ne!(mismatch.verdict, Verdict::Settled, "a below-floor fill NEVER settles");

    // An API false-`filled` (rail says filled, chain delivered 0) -> hollow.
    let false_fill = verify_route_leg(&key(TX_FALSEFILL), &claim(RouteRail::Aggregation), band_15pct(), &mut tape);
    assert_eq!(false_fill.verdict, Verdict::Hollow, "a filled-but-zero delivery is an API false-fill -> hollow");
    assert_eq!(false_fill.delivered, Some(0));

    // An off-record leg degrades LOUDLY to unverified.
    let unverified = verify_route_leg(&key(TX_UNKNOWN), &claim(RouteRail::Intent), band_15pct(), &mut tape);
    assert_eq!(unverified.verdict, Verdict::Unverified, "an off-record leg degrades LOUDLY");
    assert_eq!(unverified.delivered, None);
    assert_eq!(unverified.terminal, None);
    assert_ne!(unverified.verdict, Verdict::Settled, "NEVER a fabricated settled (design SS3 #3)");
}

#[test]
fn the_route_neg_case_an_unreadable_leg_is_unverified_never_settled() {
    // The NEG case for the route leg (design SS2 / SS3 principle 3): a fabricated / unreadable route leg
    // (empty tape) stamps Unverified -- the verifier reads the chain, and an absent read can NEVER
    // collapse into a fabricated settled. This is the route analogue of the settlement NEG case.
    let mut tape = RouteTape::new(); // empty -> every route read is off-tape

    let report = verify_route_leg(&key(TX_SETTLED), &claim(RouteRail::Aggregation), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Unverified);
    assert_ne!(report.verdict, Verdict::Settled, "a fabricated route-leg hash must stamp Unverified");
    assert_eq!(report.delivered, None, "no delivery for an unreadable leg");
}

#[test]
fn the_khalani_refunded_rule_a_refund_is_a_non_settlement_terminal_never_settled() {
    // Design WOW Feature 2 (the headline route-safety invariant): a Khalani `refunded` is a non-settlement
    // terminal state. Even a refund that (malformed) carried a nonzero delivered amount near `expected`
    // can NEVER settle -- the terminal status gates the amount math entirely.
    let mut tape = RouteTape::new()
        .with(key(TX_REFUNDED), RouteObservation::new(RouteTerminal::Refunded, EXPECTED_OUT));
    let report = verify_route_leg(&key(TX_REFUNDED), &claim(RouteRail::Intent), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Hollow, "a refund never settles, even with a near-expected amount");
    assert_ne!(report.verdict, Verdict::Settled);
}

#[test]
fn the_on_chain_floor_dominates_a_near_expected_but_below_floor_leg_is_mismatch() {
    // The hard protocol-native floor wins over the soft tolerance band: a delivered output that is close
    // to `expected` (would pass the band) but BELOW the on-chain `min_out` is a loud mismatch, because the
    // leg's own bound should have rejected it. This is the route-specific safety invariant.
    let mut tape = RouteTape::new()
        .with(key(TX_MISMATCH), RouteObservation::filled(EXPECTED_OUT - 1)); // 999_999, just below expected
    // Set the floor ABOVE expected so even a near-expected fill is below the floor.
    let high_floor_claim = RouteClaim::new(RouteRail::NativeAmm, EXPECTED_OUT, EXPECTED_OUT); // floor == expected
    let report = verify_route_leg(&key(TX_MISMATCH), &high_floor_claim, band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Mismatch, "below the on-chain floor never settles");
}

#[test]
fn a_multi_leg_route_settles_only_when_every_leg_independently_settles() {
    // Design WOW Feature 2: "the wow scales the action ... while every leg stays mandate-gated + verifier-
    // confirmed." A two-leg route (an aggregation hop + a native-AMM hop) settles ONLY if BOTH legs
    // settle independently; a single refunded/short leg makes the WHOLE route non-settled (never a
    // fabricated whole-route settled).
    let mut tape = RouteTape::new()
        .with(key(TX_SETTLED), RouteObservation::filled(1_005_000))
        .with(key(TX_MISMATCH), RouteObservation::filled(995_000)); // in band/above floor -> settled

    // Both legs settle -> the whole route settles.
    let both = [
        (key(TX_SETTLED), claim(RouteRail::Aggregation)),
        (key(TX_MISMATCH), claim(RouteRail::NativeAmm)),
    ];
    let (reports, composed) = verify_route(&both, band_15pct(), &mut tape);
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|r| r.verdict == Verdict::Settled));
    assert_eq!(composed, Verdict::Settled, "every leg settled -> the route settled");

    // Now make leg 2 a refund -> the whole route is NOT settled (the refunded leg dominates).
    let mut tape2 = RouteTape::new()
        .with(key(TX_SETTLED), RouteObservation::filled(1_005_000))
        .with(key(TX_REFUNDED), RouteObservation::refunded());
    let with_refund = [
        (key(TX_SETTLED), claim(RouteRail::Aggregation)),
        (key(TX_REFUNDED), claim(RouteRail::Intent)),
    ];
    let (_r2, composed2) = verify_route(&with_refund, band_15pct(), &mut tape2);
    assert_ne!(composed2, Verdict::Settled, "a route with a refunded leg is NEVER settled");
    assert_eq!(composed2, Verdict::Hollow, "the refunded leg's verdict composes the route verdict");
}

#[test]
fn the_route_verdict_is_deterministic_across_repeated_runs() {
    // Design SS3 principle 4: the same recorded tape + claim -> a byte-identical report, every run.
    let build = || {
        RouteTape::new()
            .with(key(TX_SETTLED), RouteObservation::filled(1_005_000))
            .with(key(TX_REFUNDED), RouteObservation::refunded())
    };
    let mut first_tape = build();
    let first = verify_route_leg(&key(TX_SETTLED), &claim(RouteRail::NativeAmm), band_15pct(), &mut first_tape);
    for _ in 0..8 {
        let mut t = build();
        assert_eq!(verify_route_leg(&key(TX_SETTLED), &claim(RouteRail::NativeAmm), band_15pct(), &mut t), first);
    }
}
