//! Integration test -- the UNIFIED connector-settlement entry (STEP VERIFIER-UNIFY).
//!
//! Design SS2 (the verdict alphabet) + SS3 principle 2 (the verdict monopoly): the verifier mints one of
//! the SAME four verdicts for EVERY protocol, through one monopoly. STEP VERIFIER-UNIFY adds the ONE door
//! that adjudicates any adapter's settlement -- [`verifier::verify_connector_settlement`] -- by dispatching
//! to the existing per-protocol algebra (the value leg / swap / route / bridge). This file proves, end to
//! end, that:
//!
//!   1. each connector KIND routes to the right per-protocol algebra (the swap floor rule, the route
//!      refund rule, the bridge hollow-egress catch each fire through the ONE entry);
//!   2. every result is one of the four verdicts -- NO new verdict enum (design SS2);
//!   3. a cross-family claim/observation pair is a LOUD refusal, never a fabricated `settled` (design SS3
//!      principle 3);
//!   4. the width-by-data manifest (`[[connector]]` blocks) parses to the typed
//!      [`verifier::ConnectorManifest`] -- a new adapter is a manifest entry + the adapter, zero dispatch
//!      change.
//!
//! It is fully offline + deterministic (no network, no clock) -- the unifying entry is pure over its
//! inputs, exactly like every per-protocol `adjudicate_*`.

use verifier::{
    verify_connector_settlement, BridgeLane, ConnectorClaim, ConnectorKind, ConnectorManifest,
    ConnectorObservation, DestSelector, HopClaim, HopObservation, Ratio, RouteClaim,
    RouteObservation, RouteRail, SwapClaim, SwapObservation, Verdict,
};

fn band_15pct() -> Ratio {
    Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
}

#[test]
fn the_unified_entry_adjudicates_all_four_protocols_through_one_door() {
    let tol = band_15pct();

    // (1) The MVP native-value leg: claimed 1000, observed 1100, within the 15% band -> Settled.
    let value = verify_connector_settlement(
        &ConnectorClaim::Settlement(1_000),
        &ConnectorObservation::Settlement(Some(1_100)),
        tol,
    )
    .expect("a same-family pair adjudicates");
    assert_eq!(value, Verdict::Settled, "the value leg routes through the unified entry");

    // (2) A SWAP: the swap-specific on-chain floor rule fires through the SAME entry. Below-floor -> Mismatch.
    let swap_claim = ConnectorClaim::Swap(SwapClaim::new(1_000, 900));
    let swap_settled = verify_connector_settlement(
        &swap_claim,
        &ConnectorObservation::Swap(Some(SwapObservation::new(1_100))),
        tol,
    )
    .unwrap();
    assert_eq!(swap_settled, Verdict::Settled, "in-band, above-floor swap settles");
    let swap_below_floor = verify_connector_settlement(
        &swap_claim,
        &ConnectorObservation::Swap(Some(SwapObservation::new(800))), // below the 900 floor
        tol,
    )
    .unwrap();
    assert_eq!(swap_below_floor, Verdict::Mismatch, "the swap FLOOR rule fired through the unified entry");

    // (3) A ROUTE: the Khalani refunded rule (a non-settlement terminal -> hollow) fires through the entry.
    let route_claim = ConnectorClaim::Route(RouteClaim::new(RouteRail::Intent, 1_000, 900));
    let route_refunded = verify_connector_settlement(
        &route_claim,
        &ConnectorObservation::Route(Some(RouteObservation::refunded())),
        tol,
    )
    .unwrap();
    assert_eq!(route_refunded, Verdict::Hollow, "the route REFUND rule fired through the unified entry");
    assert_ne!(route_refunded, Verdict::Settled, "a refund is NEVER a fabricated settle");

    // (4) A BRIDGE: the HOLLOW-EGRESS catch (source burned, destination read + empty) fires through the entry.
    let bridge_claim =
        ConnectorClaim::Bridge(HopClaim::new(BridgeLane::UsdcEgress, DestSelector::Ethereum, 1_000_000, 990_000));
    let bridge_settled = verify_connector_settlement(
        &bridge_claim,
        &ConnectorObservation::Bridge(Some(HopObservation::bridged(1_000_000, 1_000_000))),
        tol,
    )
    .unwrap();
    assert_eq!(bridge_settled, Verdict::Settled, "both legs read + in band -> settled");
    let bridge_hollow_egress = verify_connector_settlement(
        &bridge_claim,
        &ConnectorObservation::Bridge(Some(HopObservation::hollow_egress(1_000_000))),
        tol,
    )
    .unwrap();
    assert_eq!(bridge_hollow_egress, Verdict::Hollow, "the HOLLOW-EGRESS catch fired through the unified entry");
    assert_ne!(bridge_hollow_egress, Verdict::Settled, "a stuck egress is NEVER a fabricated settle");
}

#[test]
fn the_unified_neg_case_an_unreadable_observation_is_unverified_never_settled() {
    // The NEG case carried into the unified entry (design SS2 / SS3 principle 3): an unreadable observation
    // for ANY protocol degrades LOUDLY to Unverified -- the verifier reads the chain, and an absent read
    // can NEVER collapse into a fabricated settled, no matter which connector it came through.
    let tol = band_15pct();
    let unreadable = [
        (ConnectorClaim::Settlement(1_000), ConnectorObservation::Settlement(None)),
        (ConnectorClaim::Swap(SwapClaim::new(1_000, 900)), ConnectorObservation::Swap(None)),
        (ConnectorClaim::Route(RouteClaim::new(RouteRail::Intent, 1_000, 900)), ConnectorObservation::Route(None)),
        (
            ConnectorClaim::Bridge(HopClaim::new(BridgeLane::UsdcEgress, DestSelector::Ethereum, 1, 0)),
            ConnectorObservation::Bridge(None),
        ),
    ];
    for (claim, obs) in unreadable {
        let v = verify_connector_settlement(&claim, &obs, tol).unwrap();
        assert_eq!(v, Verdict::Unverified, "an unreadable {:?} observation -> Unverified", claim.kind());
        assert_ne!(v, Verdict::Settled, "NEVER a fabricated settled (design SS3 #3)");
    }
}

#[test]
fn a_cross_family_pair_is_a_loud_refusal_never_a_fabricated_verdict() {
    // The type-level twin of two-source truth (design SS3 principle 1 + 3): the Claim and the Observation
    // must describe the SAME action to be adjudicated. A mismatched pair is a loud ConnectorMismatch,
    // NEVER a coerced verdict -- the unifying entry refuses rather than fabricate.
    let tol = band_15pct();
    let err = verify_connector_settlement(
        &ConnectorClaim::Swap(SwapClaim::new(1_000, 900)),
        &ConnectorObservation::Bridge(Some(HopObservation::bridged(1, 1))),
        tol,
    )
    .expect_err("a swap claim cannot be adjudicated against a bridge observation");
    assert_eq!(err.claim_kind, ConnectorKind::Swap);
    assert_eq!(err.observation_kind, ConnectorKind::Bridge);
}

#[test]
fn the_unified_entry_is_deterministic_across_repeated_runs() {
    // Design SS3 principle 4: the same (claim, observation, tol) -> a byte-identical verdict, every run.
    let tol = band_15pct();
    let claim = ConnectorClaim::Bridge(HopClaim::new(BridgeLane::W0gEgress, DestSelector::Base, 1_000_000, 990_000));
    let obs = ConnectorObservation::Bridge(Some(HopObservation::bridged(1_000_000, 1_000_000)));
    let first = verify_connector_settlement(&claim, &obs, tol).unwrap();
    for _ in 0..8 {
        assert_eq!(verify_connector_settlement(&claim, &obs, tol).unwrap(), first);
    }
}

#[test]
fn the_repo_manifest_declares_the_built_connectors_width_by_data() {
    // The width-by-data manifest: the verifier reads the `[[connector]]` blocks of the data spine to know
    // each adapter's shape · chains · priority · which checks gate it -- with NO change to the dispatch.
    // We embed the manifest subset here so the test is hermetic (it does not read the filesystem), matching
    // the real spine's `[[connector]]` shape.
    let text = "\
[[connector]]
name     = \"native-settlement\"
shape    = \"settlement\"
chains   = [16602, 16661]
priority = 0
gates    = [\"settlement\"]

[[connector]]
name     = \"oku-swap\"
shape    = \"swap\"
chains   = [16661]
priority = 10
gates    = [\"settlement\", \"mandate-cap\"]

[[connector]]
name     = \"ccip-bridge\"
shape    = \"bridge\"
chains   = [16661]
priority = 30
gates    = [\"settlement\", \"mandate-cap\"]
";
    let m = ConnectorManifest::parse(text).expect("the manifest subset parses");
    assert_eq!(m.len(), 3, "three declared connectors");

    // Every declared connector's shape is a known ConnectorKind the unified entry can dispatch -- the
    // width-by-data invariant (a manifest entry maps to a dispatchable family, zero code change).
    for entry in m.entries() {
        // The shape is one the unified entry routes (settlement / swap / route / bridge).
        assert!(
            matches!(
                entry.shape,
                ConnectorKind::Settlement | ConnectorKind::Swap | ConnectorKind::Route | ConnectorKind::Bridge
            ),
            "{} declares a dispatchable shape",
            entry.name
        );
        // An adapter CANNOT vote itself in: every declared connector names at least one gate.
        assert!(!entry.gates.is_empty(), "{} must declare a gate (cannot vote itself in)", entry.name);
    }

    // The swap connector is mainnet-only (chain 16661) + gated by BOTH settlement and the mandate cap.
    let swap = m.get("oku-swap").expect("oku-swap is declared");
    assert_eq!(swap.shape, ConnectorKind::Swap);
    assert_eq!(swap.chains, vec![16661]);
    assert!(swap.gates.contains(&"mandate-cap".to_string()), "the swap is gated by the mandate cap");
}
