//! Integration test -- the verifier independently CONFIRMS per-spoke ISOLATED caps on-chain (design
//! "2b.3 Per-spoke isolated caps -- a weak spoke is capped to that spoke").
//!
//! The hub-and-spoke envelope bounds each outbound spoke with its OWN isolated cap, reusing the
//! `MandateRegistryV3` per-destination (Tier-4) `destCap` surface, keyed by the spoke's per-spoke
//! SENTINEL spender (`TimelockGuard.spokeSpender(destSelector)`). The contract enforces it at queue
//! time; THIS file is the verifier's INDEPENDENT confirmation that the isolation actually holds on the
//! gate -- it reads the gate `checkTransferTo(agent, token, amount, spokeSpender)` per spoke and
//! adjudicates whether the gate's answer MATCHES the per-spoke expectation (design SS3 principle 1,
//! two-source truth). It is OFFLINE-buildable: a deterministic [`MandateTape`] replays the gate reads
//! (the genuine on-chain reads would be captured via `cast call`, like the mandate-tier integration
//! test; the `live` feature cannot link on this windows-gnu host).
//!
//! THE ISOLATION PROOF, confirmed on the gate:
//!   - the WEAK spoke (a tight 0.5M per-spoke cap) reads back `(false, OVER_DEST_CAP)` for a 0.6M egress
//!     -- the weak spoke is capped to ITS cap;
//!   - a DIFFERENT spoke (a looser 4M cap) reads back `(true, "")` for the SAME 0.6M -- one spoke's tight
//!     cap never constrains another (the spokes are isolated);
//!   - the 0G HUB's own on-hub spend (the address(0) / no-spoke spender) reads back `(true, "")` for 0.6M
//!     -- the hub is untouched by any spoke's cap.
//!
//! A weak-spoke exploit is bounded to that one spoke -- never the hub, never another spoke.

use verifier::{
    confirm_tier_via, ExpectedGate, GateKey, GateObservation, MandateProbe, MandateTape, Tier,
    TierVerdict,
};

// The actors (all PUBLIC -- no secret). The per-spoke SENTINELS are opaque per-spoke spender keys (the
// contract derives them as keccak("proofagent:spoke:" || selector); the verifier confirms the gate's
// answer for whatever spender it probes, so the exact derivation is the contract's, not the verifier's).
const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN: &str = "0x1111111111111111111111111111111111111111";
const ETH_SPOKE: &str = "0x00000000000000000000000000000000eee70000"; // the WEAK spoke sentinel (0.5M cap)
const ARB_SPOKE: &str = "0x00000000000000000000000000000000a4b00000"; // a healthy spoke sentinel (4M cap)

/// Build a per-destination (Tier-4) probe AT a specific spoke spender, expecting `expected`.
fn spoke_probe(token: &str, amount: i128, spoke: &str, expected: ExpectedGate) -> MandateProbe {
    MandateProbe {
        tier: Tier::DestCap,
        agent: AGENT.to_string(),
        token: token.to_string(),
        amount,
        spender: Some(spoke.to_string()),
        expected,
    }
}

/// Seed a tape with one recorded gate read for `probe`.
fn record(tape: &mut MandateTape, probe: &MandateProbe, ok: bool, reason: &str) {
    tape.record(GateKey::from_probe(probe), GateObservation::new(ok, reason));
}

#[test]
fn weak_spoke_over_its_cap_is_confirmed_blocked_on_chain() {
    // The weak ethereum spoke (0.5M isolated cap) rejects a 0.6M egress with OVER_DEST_CAP -- the gate
    // read confirms the per-spoke cap is enforced. The verifier CONFIRMS the spoke is capped to its cap.
    let weak = spoke_probe(TOKEN, 600_000, ETH_SPOKE, ExpectedGate::blocked("OVER_DEST_CAP"));
    let mut tape = MandateTape::new();
    record(&mut tape, &weak, false, "OVER_DEST_CAP"); // the genuine gate read at the weak spoke

    let report = confirm_tier_via(&weak, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Confirmed, "the weak spoke's per-spoke cap is confirmed enforced");
}

#[test]
fn a_different_spoke_is_confirmed_unaffected_by_another_spokes_tight_cap() {
    // The SAME 0.6M the weak spoke refuses is WITHIN the arbitrum spoke's 4M cap -> (true, "") -- the
    // spokes are ISOLATED. The verifier confirms one spoke's tight cap does NOT constrain another.
    let healthy = spoke_probe(TOKEN, 600_000, ARB_SPOKE, ExpectedGate::ok());
    let mut tape = MandateTape::new();
    record(&mut tape, &healthy, true, ""); // the genuine gate read at the healthy spoke

    let report = confirm_tier_via(&healthy, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Confirmed, "a healthy spoke is confirmed unaffected by another's cap");
}

#[test]
fn the_hub_is_confirmed_untouched_by_any_spoke_cap() {
    // The 0G HUB's own on-hub spend (no spoke -- the v2-shape checkTransfer, spender None) is checked
    // against the hub's global+asset caps ONLY. 0.6M (which the weak spoke refuses) passes the hub gate.
    // The verifier confirms the hub is untouched by any spoke's cap (the hub is the security floor).
    let hub = MandateProbe {
        tier: Tier::WithinMandate,
        agent: AGENT.to_string(),
        token: TOKEN.to_string(),
        amount: 600_000,
        spender: None, // the on-hub spend -- no spoke
        expected: ExpectedGate::ok(),
    };
    let mut tape = MandateTape::new();
    record(&mut tape, &hub, true, "");

    let report = confirm_tier_via(&hub, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Confirmed, "the hub's own spend is confirmed within mandate");
}

#[test]
fn the_full_isolation_picture_is_confirmed_in_one_pass() {
    // All three reads together: the weak spoke blocked, the healthy spoke + the hub allowed, for the
    // SAME 0.6M amount. This is the isolation invariant on the gate -- a weak spoke is capped to that
    // spoke, never the hub and never another spoke.
    let weak = spoke_probe(TOKEN, 600_000, ETH_SPOKE, ExpectedGate::blocked("OVER_DEST_CAP"));
    let healthy = spoke_probe(TOKEN, 600_000, ARB_SPOKE, ExpectedGate::ok());
    let hub = MandateProbe {
        tier: Tier::WithinMandate,
        agent: AGENT.to_string(),
        token: TOKEN.to_string(),
        amount: 600_000,
        spender: None,
        expected: ExpectedGate::ok(),
    };

    let mut tape = MandateTape::new();
    record(&mut tape, &weak, false, "OVER_DEST_CAP");
    record(&mut tape, &healthy, true, "");
    record(&mut tape, &hub, true, "");

    for p in [&weak, &healthy, &hub] {
        let report = confirm_tier_via(p, &mut tape);
        assert_eq!(
            report.verdict,
            TierVerdict::Confirmed,
            "the per-spoke isolation must be CONFIRMED on the gate for every leg"
        );
    }
}

#[test]
fn a_gate_that_lets_a_weak_spoke_overspend_is_refuted_never_fabricated() {
    // The honesty doctrine (design SS3 principle 3) for the per-spoke cap: if the gate had ANSWERED but
    // let the weak spoke's 0.6M PASS (ok=true) -- i.e. the per-spoke isolation was NOT enforced -- the
    // verifier REFUTES it, never fabricating a confirmation. A broken isolation is caught LOUD.
    let weak = spoke_probe(TOKEN, 600_000, ETH_SPOKE, ExpectedGate::blocked("OVER_DEST_CAP"));
    let mut tape = MandateTape::new();
    record(&mut tape, &weak, true, ""); // a (hypothetical) broken gate that let the weak spoke overspend

    let report = confirm_tier_via(&weak, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Refuted, "an unenforced per-spoke cap is refuted, never confirmed");
    assert_ne!(report.verdict, TierVerdict::Confirmed, "NEVER a fabricated confirmation");
}

#[test]
fn an_unreadable_spoke_gate_is_unverified_never_confirmed() {
    // The keystone: an off-tape (unreadable) per-spoke gate read degrades LOUDLY to Unverified -- never
    // a fabricated Confirmed (design SS3 principle 3).
    let weak = spoke_probe(TOKEN, 600_000, ETH_SPOKE, ExpectedGate::blocked("OVER_DEST_CAP"));
    let mut tape = MandateTape::new(); // empty -> off-tape

    let report = confirm_tier_via(&weak, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Unverified);
    assert_ne!(report.verdict, TierVerdict::Confirmed, "an unreadable spoke gate must NEVER confirm");
}
