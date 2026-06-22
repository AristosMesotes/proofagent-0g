//! Integration test -- the verifier's BRIDGE verdict-extension (design WOW Feature 3 / 3b), driven by a
//! deterministic, OFFLINE [`BridgeTape`] of recorded TWO-leg bridge reads (the source burn/lock event +
//! the destination release/mint event).
//!
//! Design WOW Feature 3 / 3b ("wrapped by the proofs -- the highest-value verification showcase"): after
//! each bridge hop, "the verifier reads **both** legs (source `ccipSend`/burn event + destination
//! release/mint) ... and stamps a **per-hop** verdict: **settled** (both legs present, released amount in
//! tolerance), **hollow** (source burned, destination empty -> **LOUD**), **mismatch** (destination
//! SUCCESS but amount short), or **unverified** (a leg not yet readable). A multi-hop journey is **settled
//! only if every hop is independently settled**." This file is the offline-buildable, tape-tested proof of
//! that algebra end to end across the lanes (USDC inbound / USDC egress / w0G egress): it replays recorded
//! two-leg observations (the shape the `live` `LiveBridgeSource` decodes from the source + destination
//! receipts) and proves the verifier mints the right verdict for each case -- the SAME four-verdict
//! alphabet the settlement leg uses, through the one [`verifier::Verdict`] monopoly.
//!
//! CCIP on 0G is **MAINNET-only** (Galileo CCIP is decommissioned) -- there is no testnet rehearsal -- so
//! these recorded observations replay the two-chain read deterministically and at $0, with no network,
//! exactly as `route_verdict.rs` replays the live rail reads. The HOLLOW-EGRESS catch (source burned,
//! destination read + empty -> LOUD `hollow`) is the centerpiece, structurally distinct from `unverified`
//! (the destination leg still in-flight / unreadable).

use verifier::{
    verify_bridge, verify_hop, BridgeLane, DestSelector, HopClaim, HopObservation, Ratio, ReadKey,
    Verdict,
};

// A representative hop claim (bridged token MINOR units): the agent SENT `SENT` on the source and bound
// the egress with an on-chain `MIN_RELEASE` floor (the lane's CCIP fee-skim allowance).
const SENT: i128 = 1_000_000; // e.g. 1.0 USDC (6-dec) sent into CCIP
const MIN_RELEASE: i128 = 990_000; // the on-chain min-release floor the agent set (a 1% bound)

// Well-formed 32-byte tx hashes for the recorded hop legs (source + destination).
const SRC_SETTLED: &str = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const SRC_HOLLOW: &str = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const SRC_MISMATCH: &str = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const SRC_INFLIGHT: &str = "0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
const SRC_UNKNOWN: &str = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const DST_X: &str = "0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6";

fn key(h: &str) -> ReadKey {
    ReadKey::new(h).expect("test hash is well-formed")
}

fn band_15pct() -> Ratio {
    Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
}

fn claim(lane: BridgeLane, sel: DestSelector) -> HopClaim {
    HopClaim::new(lane, sel, SENT, MIN_RELEASE)
}

#[test]
fn each_bridge_outcome_mints_the_right_verdict_from_recorded_two_leg_reads() {
    // The tape carries the two-leg outcome the verifier WOULD decode from each hop's source + dest tx:
    //   settled       -> burned 1_000_000, released 1_005_000  (>= floor 990_000 AND within 15% band)
    //   hollow-egress -> burned 1_000_000, dest READ + released 0  (the centerpiece -- value did not arrive)
    //   mismatch      -> burned 1_000_000, released 980_000    (BELOW the on-chain floor -- bound violated)
    //   in-flight     -> burned 1_000_000, dest UNREADABLE     (still arriving -> the loud Unverified)
    //   unknown       -> NOT on the tape (source unreadable)   (an off-record hop -> the loud Unverified)
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_SETTLED), HopObservation::bridged(1_000_000, 1_005_000))
        .with(key(SRC_HOLLOW), HopObservation::hollow_egress(1_000_000))
        .with(key(SRC_MISMATCH), HopObservation::bridged(1_000_000, 980_000))
        .with(key(SRC_INFLIGHT), HopObservation::in_flight(1_000_000));

    // The USDC egress lane (0G -> Ethereum) settles in-band, above-floor, with BOTH legs read -> settled.
    let settled = verify_hop(&key(SRC_SETTLED), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(settled.verdict, Verdict::Settled, "both legs read, in-band, above-floor -> settled");
    assert_eq!(settled.verdict_string(), "settled");
    assert_eq!(settled.burned, Some(1_000_000));
    assert_eq!(settled.released, Some(1_005_000));

    // THE HOLLOW-EGRESS CATCH (the centerpiece): source burned, destination READ + empty -> hollow, LOUD.
    let hollow = verify_hop(&key(SRC_HOLLOW), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(hollow.verdict, Verdict::Hollow, "burned-on-source, empty-on-dest is the hollow-egress catch");
    assert!(hollow.is_hollow_egress(), "the report flags the stuck-egress defect (heal = manual-exec)");
    assert_eq!(hollow.released, Some(0));
    assert_ne!(hollow.verdict, Verdict::Settled, "a hollow egress is NEVER a fabricated settle (design WOW F3b)");

    // A short release below the on-chain floor -> a loud mismatch (the lane's bound was violated).
    let mismatch = verify_hop(&key(SRC_MISMATCH), Some(&key(DST_X)), &claim(BridgeLane::W0gEgress, DestSelector::Base), band_15pct(), &mut tape);
    assert_eq!(mismatch.verdict, Verdict::Mismatch, "a below-floor release is a loud mismatch");
    assert_ne!(mismatch.verdict, Verdict::Settled, "a below-floor release NEVER settles");

    // A still-in-flight hop (source burned, dest UNREADABLE) -> unverified, NOT a hollow-egress defect.
    let in_flight = verify_hop(&key(SRC_INFLIGHT), None, &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(in_flight.verdict, Verdict::Unverified, "a still-in-flight hop degrades LOUDLY to unverified");
    assert!(!in_flight.is_hollow_egress(), "an UNREADABLE destination is NOT the hollow-egress defect");
    assert_eq!(in_flight.released, None);

    // An off-record hop (source unreadable) degrades LOUDLY to unverified.
    let unverified = verify_hop(&key(SRC_UNKNOWN), Some(&key(DST_X)), &claim(BridgeLane::UsdcInbound, DestSelector::ZeroG), band_15pct(), &mut tape);
    assert_eq!(unverified.verdict, Verdict::Unverified, "an off-record hop degrades LOUDLY");
    assert_eq!(unverified.burned, None);
    assert_eq!(unverified.released, None);
    assert_ne!(unverified.verdict, Verdict::Settled, "NEVER a fabricated settled (design SS3 #3)");
}

#[test]
fn the_bridge_neg_case_an_unreadable_hop_is_unverified_never_settled() {
    // The NEG case for the bridge leg (design SS2 / SS3 principle 3): a fabricated / unreadable bridge hop
    // (empty tape) stamps Unverified -- the verifier reads the chain, and an absent read can NEVER collapse
    // into a fabricated settled. This is the bridge analogue of the settlement NEG case.
    let mut tape = verifier::BridgeTape::new(); // empty -> every hop read is off-tape

    let report = verify_hop(&key(SRC_SETTLED), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Unverified);
    assert_ne!(report.verdict, Verdict::Settled, "a fabricated bridge-hop hash must stamp Unverified");
    assert_eq!(report.burned, None, "no source burn for an unreadable hop");
    assert_eq!(report.released, None, "no destination release for an unreadable hop");
}

#[test]
fn the_hollow_egress_catch_is_the_centerpiece_burned_but_not_released_is_loud_hollow() {
    // Design WOW Feature 3b (the headline bridge-safety invariant -- "the kill-shot is hollow-egress"):
    // a source that burned on 0G but whose destination released NOTHING can NEVER settle -- the destination
    // leg releasing 0 is the catch, checked before any amount math, no matter how large the source burn.
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_HOLLOW), HopObservation::hollow_egress(SENT));
    let report = verify_hop(&key(SRC_HOLLOW), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Hollow, "burned-but-not-released is a LOUD hollow, never a settle");
    assert!(report.is_hollow_egress(), "the report flags the stuck egress so the audit prescribes the heal");
    assert_ne!(report.verdict, Verdict::Settled);
}

#[test]
fn an_unreadable_destination_is_unverified_not_a_hollow_egress_defect() {
    // The crucial distinction (design SS3 principle 3): a hop whose source burned but whose destination is
    // UNREADABLE (still in-flight) is `unverified` -- a loud honest absence -- NOT `hollow`. We never call a
    // still-arriving hop a defect, and we never call a read-empty destination a success. The two are
    // different code paths that can never be confused.
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_INFLIGHT), HopObservation::in_flight(SENT));
    let report = verify_hop(&key(SRC_INFLIGHT), None, &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Unverified, "an unreadable destination is still-in-flight -> unverified");
    assert!(!report.is_hollow_egress(), "still-in-flight is NOT the hollow-egress defect");
}

#[test]
fn the_on_chain_floor_dominates_a_near_sent_but_below_floor_release_is_mismatch() {
    // The hard protocol-native floor wins over the soft tolerance band: a destination release close to
    // `sent` (would pass the band) but BELOW the on-chain `min_release` is a loud mismatch, because the
    // egress's own bound should have rejected it. This is the bridge-specific safety invariant.
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_MISMATCH), HopObservation::bridged(SENT, SENT - 1)); // released 999_999, just below sent
    // Set the floor ABOVE sent so even a near-sent release is below the floor.
    let high_floor_claim = HopClaim::new(BridgeLane::UsdcEgress, DestSelector::Ethereum, SENT, SENT); // floor == sent
    let report = verify_hop(&key(SRC_MISMATCH), Some(&key(DST_X)), &high_floor_claim, band_15pct(), &mut tape);
    assert_eq!(report.verdict, Verdict::Mismatch, "below the on-chain floor never settles");
}

#[test]
fn a_multi_hop_journey_settles_only_when_every_hop_independently_settles() {
    // Design WOW Feature 3b: "A multi-hop journey is settled only if every hop is independently settled --
    // hop-1 on Ethereum says nothing about hop-2 to Base." A two-hop journey (0G -> Ethereum, then
    // Ethereum -> Base) settles ONLY if BOTH hops settle independently; a single hollow-egress hop makes
    // the WHOLE journey non-settled (never a fabricated whole-journey settled).
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_SETTLED), HopObservation::bridged(1_000_000, 1_005_000))
        .with(key(SRC_MISMATCH), HopObservation::bridged(1_000_000, 995_000)); // in band/above floor -> settled

    // Both hops settle -> the whole journey settles.
    let both = [
        (key(SRC_SETTLED), Some(key(DST_X)), claim(BridgeLane::UsdcEgress, DestSelector::Ethereum)),
        (key(SRC_MISMATCH), Some(key(DST_X)), claim(BridgeLane::UsdcEgress, DestSelector::Base)),
    ];
    let (reports, composed) = verify_bridge(&both, band_15pct(), &mut tape);
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|r| r.verdict == Verdict::Settled));
    assert_eq!(composed, Verdict::Settled, "every hop settled -> the journey settled");

    // Now make hop 2 a hollow-egress -> the whole journey is NOT settled (the stuck hop dominates).
    let mut tape2 = verifier::BridgeTape::new()
        .with(key(SRC_SETTLED), HopObservation::bridged(1_000_000, 1_005_000))
        .with(key(SRC_HOLLOW), HopObservation::hollow_egress(1_000_000));
    let with_hollow = [
        (key(SRC_SETTLED), Some(key(DST_X)), claim(BridgeLane::UsdcEgress, DestSelector::Ethereum)),
        (key(SRC_HOLLOW), Some(key(DST_X)), claim(BridgeLane::UsdcEgress, DestSelector::Base)),
    ];
    let (r2, composed2) = verify_bridge(&with_hollow, band_15pct(), &mut tape2);
    assert_ne!(composed2, Verdict::Settled, "a journey with a hollow-egress hop is NEVER settled");
    assert_eq!(composed2, Verdict::Hollow, "the hollow-egress hop's verdict composes the journey verdict");
    assert!(r2[1].is_hollow_egress(), "the stuck second hop is flagged for the heal (manual-exec)");
}

#[test]
fn the_hub_and_spoke_inbound_lanes_verify_per_hop_through_the_same_two_leg_algebra() {
    // The hub-and-spoke section: the Arbitrum->0G + BNB->0G INBOUND lanes (w0G CCT direct, value entering
    // the secured 0G hub) ride the SAME two-leg verifier algebra as every other lane -- the verifier reads
    // BOTH legs (the source lock on the spoke + the w0G mint on the 0G hub). An inbound hop's destination is
    // the 0G hub (DestSelector::ZeroG); the SOURCE spoke is recorded by the lane (spoke_selector). The
    // inbound direction is autonomous, but it is STILL verifier-confirmed two-leg, never trusted blind.
    let mut tape = verifier::BridgeTape::new()
        .with(key(SRC_SETTLED), HopObservation::bridged(1_000_000, 1_005_000)) // locked on spoke, minted on hub
        .with(key(SRC_HOLLOW), HopObservation::hollow_egress(1_000_000)); // locked on spoke, NOTHING minted on hub

    // Arbitrum -> 0G hub: both legs read, in-band, above floor -> settled (value arrived in the hub).
    let arb = verify_hop(
        &key(SRC_SETTLED),
        Some(&key(DST_X)),
        &claim(BridgeLane::W0gInboundArbitrum, DestSelector::ZeroG),
        band_15pct(),
        &mut tape,
    );
    assert_eq!(arb.verdict, Verdict::Settled, "Arbitrum->0G inbound settles when both legs read in-band");
    assert_eq!(arb.lane, BridgeLane::W0gInboundArbitrum);
    assert!(arb.lane.is_inbound(), "the lane is inbound (into the hub)");
    assert_eq!(arb.lane.spoke_selector(), Some(DestSelector::Arbitrum), "the source spoke is recorded");

    // BNB -> 0G hub: source locked on BNB but the hub mint released NOTHING (read + empty) -> hollow. Even
    // the autonomous inbound direction is NOT trusted blind -- a missing hub-side mint is caught LOUD.
    let bnb = verify_hop(
        &key(SRC_HOLLOW),
        Some(&key(DST_X)),
        &claim(BridgeLane::W0gInboundBnb, DestSelector::ZeroG),
        band_15pct(),
        &mut tape,
    );
    assert_eq!(bnb.verdict, Verdict::Hollow, "a missing hub-side mint is caught LOUD even on an inbound lane");
    assert!(bnb.is_hollow_egress(), "the report flags the burned-source/empty-dest defect (heal applies)");
    assert_eq!(bnb.lane.spoke_selector(), Some(DestSelector::Bnb), "the source spoke is BNB");
    assert_ne!(bnb.verdict, Verdict::Settled, "never a fabricated settle, even inbound");
}

#[test]
fn the_bridge_verdict_is_deterministic_across_repeated_runs() {
    // Design SS3 principle 4: the same recorded tape + claim -> a byte-identical report, every run.
    let build = || {
        verifier::BridgeTape::new()
            .with(key(SRC_SETTLED), HopObservation::bridged(1_000_000, 1_005_000))
            .with(key(SRC_HOLLOW), HopObservation::hollow_egress(1_000_000))
    };
    let mut first_tape = build();
    let first = verify_hop(&key(SRC_SETTLED), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut first_tape);
    for _ in 0..8 {
        let mut t = build();
        assert_eq!(verify_hop(&key(SRC_SETTLED), Some(&key(DST_X)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut t), first);
    }
}
