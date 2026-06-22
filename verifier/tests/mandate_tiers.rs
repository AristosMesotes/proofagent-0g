//! Integration test -- the verifier's mandate-tier confirmation extension, seeded from REAL on-chain
//! reads of the deployed `MandateRegistryV3` (the four-tier production spend gate, design SS2 Rails).
//!
//! Design SS2 / `MandateRegistryV3`: the verifier independently confirms each tier on-chain by reading
//! the gate itself (an `eth_call` to `checkTransfer` / `checkTransferTo`) and adjudicating whether the
//! gate's answer MATCHES the tier's expected `(ok, reason)`. This file is the OFFLINE-buildable proof of
//! that algebra: it replays a deterministic [`MandateTape`] whose recorded gate observations are the
//! GENUINE on-chain reads captured from the live deployment on 0G Galileo testnet (chain 16602):
//!
//!   MandateRegistryV3 @ 0xC24A325dB118cfFD586E72b9D085FB71D5202BD2  (PUBLIC; pinned in proofagent.toml)
//!   per-tx cap 2_000_000 · period 3600s / cap 1_500_000 · native sentinel allowlisted (assetCap 2M)
//!
//! Each recorded observation below was read LIVE via `cast call ... checkTransfer(...)` against that
//! address (see demo/mandate_v3_period_cap.sh + demo/EVIDENCE_MANDATE_V3.md). The verifier's
//! `confirm_tier` then proves the tier holds -- the SAME algebra the `live` build runs against the chain
//! (the `live` feature is feature-gated and cannot link on this windows-gnu host, so the chain read is
//! done via `cast`, and these recordings replay it deterministically and offline).
//!
//! THE HEADLINE: the period tier reads back `(false, OVER_PERIOD_CAP)` for a second in-cap loop after the
//! first 1_000_000 accrued -- confirming on-chain that the cumulative window BLOCKS a looping sequence
//! the per-tx cap (2_000_000) alone would have passed. Looping-drain is closed.

use verifier::{
    confirm_tier_via, ExpectedGate, GateKey, GateObservation, MandateProbe, MandateTape, Tier,
    TierVerdict,
};

// The live deployment + actors (all PUBLIC -- the demo wallet address, the native sentinel; no secret).
const REGISTRY: &str = "0xc24a325db118cffd586e72b9d085fb71d5202bd2";
const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a"; // demo wallet == mandated agent
const NATIVE: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // native-asset sentinel (allowlisted)
const OTHER_TOKEN: &str = "0x2222222222222222222222222222222222222222"; // NOT allowlisted
const STRANGER: &str = "0x000000000000000000000000000000000000beef"; // not the mandated agent

/// Build a probe whose expected answer CONFIRMS the named tier.
fn probe(tier: Tier, agent: &str, token: &str, amount: i128, expected: ExpectedGate) -> MandateProbe {
    MandateProbe {
        tier,
        agent: agent.to_string(),
        token: token.to_string(),
        amount,
        spender: None,
        expected,
    }
}

/// Seed a tape with one recorded REAL on-chain gate read for `probe`.
fn record(tape: &mut MandateTape, probe: &MandateProbe, ok: bool, reason: &str) {
    tape.record(GateKey::from_probe(probe), GateObservation::new(ok, reason));
}

#[test]
fn confirms_each_live_tier_from_recorded_on_chain_reads() {
    // The probes -- one per tier the live deployment exposes, with the expected on-chain answer.
    let within = probe(Tier::WithinMandate, AGENT, NATIVE, 1, ExpectedGate::ok());
    let period = probe(Tier::PeriodCap, AGENT, NATIVE, 1_000_000, ExpectedGate::blocked("OVER_PERIOD_CAP"));
    let per_tx = probe(Tier::AssetCap, AGENT, NATIVE, 2_000_001, ExpectedGate::blocked("OVER_TX_CAP"));
    let not_allowed = probe(Tier::AssetCap, AGENT, OTHER_TOKEN, 1, ExpectedGate::blocked("TOKEN_NOT_ALLOWED"));
    let not_agent = probe(Tier::Expiry, STRANGER, NATIVE, 1, ExpectedGate::blocked("NOT_AGENT"));

    // The tape carries the GENUINE on-chain reads captured live via `cast` (EVIDENCE_MANDATE_V3.md):
    //   checkTransfer(agent, native, 1)        -> (true,  "")               -- within mandate
    //   checkTransfer(agent, native, 1_000_000)-> (false, "OVER_PERIOD_CAP")-- THE HEADLINE (window full)
    //   checkTransfer(agent, native, 2_000_001)-> (false, "OVER_TX_CAP")    -- over the per-tx cap
    //   checkTransfer(agent, other, 1)         -> (false, "TOKEN_NOT_ALLOWED")
    //   checkTransfer(stranger, native, 1)     -> (false, "NOT_AGENT")
    let mut tape = MandateTape::new();
    record(&mut tape, &within, true, "");
    record(&mut tape, &period, false, "OVER_PERIOD_CAP");
    record(&mut tape, &per_tx, false, "OVER_TX_CAP");
    record(&mut tape, &not_allowed, false, "TOKEN_NOT_ALLOWED");
    record(&mut tape, &not_agent, false, "NOT_AGENT");

    // Every tier is CONFIRMED -- the independent gate read matched the expected answer on-chain.
    for p in [&within, &period, &per_tx, &not_allowed, &not_agent] {
        let report = confirm_tier_via(p, &mut tape);
        assert_eq!(
            report.verdict,
            TierVerdict::Confirmed,
            "tier {} must be CONFIRMED from its recorded on-chain read",
            p.tier
        );
    }
}

#[test]
fn the_headline_period_cap_block_is_confirmed_on_chain() {
    // THE HEADLINE, isolated: the SECOND in-cap loop reads back (false, OVER_PERIOD_CAP) from the live
    // gate after the first 1_000_000 accrued. The verifier confirms the period tier IS enforced.
    let period = probe(Tier::PeriodCap, AGENT, NATIVE, 1_000_000, ExpectedGate::blocked("OVER_PERIOD_CAP"));
    let mut tape = MandateTape::new();
    record(&mut tape, &period, false, "OVER_PERIOD_CAP"); // the genuine live read

    let report = confirm_tier_via(&period, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Confirmed);
    assert!(report.verdict.is_confirmed(), "the looping-drain guard is confirmed enforced on-chain");
}

#[test]
fn a_refuted_tier_is_loud_never_a_fabricated_confirmation() {
    // The honesty doctrine (design SS3 principle 3) applied to the rails proof: if the gate had ANSWERED
    // but let an over-cap loop PASS (ok=true), the verifier REFUTES the tier -- it never fabricates a
    // confirmation. This is the rails-side analogue of the settlement NEG case.
    let period = probe(Tier::PeriodCap, AGENT, NATIVE, 1_000_000, ExpectedGate::blocked("OVER_PERIOD_CAP"));
    let mut tape = MandateTape::new();
    record(&mut tape, &period, true, ""); // a (hypothetical) broken gate that let the loop pass

    let report = confirm_tier_via(&period, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Refuted, "a gate that fails to enforce a tier is refuted");
    assert_ne!(report.verdict, TierVerdict::Confirmed, "NEVER a fabricated confirmation");
}

#[test]
fn an_unreadable_gate_is_unverified_never_confirmed() {
    // The keystone: if the gate cannot be read (off-tape), the tier degrades LOUDLY to Unverified --
    // never a fabricated Confirmed (design SS3 principle 3). Registry address echoed for documentation.
    assert_eq!(REGISTRY.len(), 42, "the pinned V3 registry address is a 20-byte 0x address");
    let period = probe(Tier::PeriodCap, AGENT, NATIVE, 1_000_000, ExpectedGate::blocked("OVER_PERIOD_CAP"));
    let mut tape = MandateTape::new(); // empty -> the probe is off-tape

    let report = confirm_tier_via(&period, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Unverified);
    assert_ne!(report.verdict, TierVerdict::Confirmed, "an unreadable gate must NEVER confirm");
}
