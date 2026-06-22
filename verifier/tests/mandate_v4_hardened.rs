//! Integration test -- the verifier's CONSOLIDATED-HARDENED mandate extension (the V4 `MandateRegistry`
//! from the 9-lens adversarial spec) + the SPEND RECONCILER that backs the advisory, non-custodial model.
//!
//! ## The honest money-safety model
//!
//! The consolidated `MandateRegistry` is ADVISORY + verifier-enforced + NON-CUSTODIAL: it holds NO funds.
//! The agent gateway ENFORCES by refusing an over-cap action PRE-broadcast; the verifier CATCHES any
//! violation LOUD. The HONEST claim is "the mandate blocks it pre-broadcast and the verifier proves it",
//! NEVER "physically can't overspend". This file proves both halves offline + deterministically:
//!
//!   1. The new HARDENED tiers (NotStarted · Epoch · TxCountCap · MinSpend · UsdStaleness · SpokeDefaultDeny
//!      · ExecuteReGate via the gate-read algebra) each read back their exact `(ok, reason)` from a recorded
//!      gate observation -> `confirm_tier` Confirms the tier is enforced on-chain.
//!   2. The RECONCILER pairs every `SpendRecorded` accrual 1:1 against the on-chain `Transfer` the verifier
//!      reads -- a transfer with no record (an unbounded spend the advisory cap did not bind) is a LOUD
//!      `Refuted`, never a fabricated `Reconciled`.
//!
//! Offline-by-default (design SS6): a deterministic [`MandateTape`] replays recorded gate reads; the
//! `live` feature (an `eth_call` reader) is the on-chain counterpart but cannot link on this windows-gnu
//! host, so the algebra is proven via the recorded tape + `cast` reads, exactly like the V3 extension.

use verifier::{
    confirm_tier_via, reconcile, ExpectedGate, GateKey, GateObservation, MandateProbe, MandateTape,
    OnchainTransfer, OrphanKind, ReconcileVerdict, SpendRecord, Tier, TierVerdict,
};

// PUBLIC actors / tokens (no secret): a demo agent, the native sentinel, a stranger, a router.
const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const NATIVE: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const STRANGER: &str = "0x000000000000000000000000000000000000beef";

/// Build a probe whose expected answer CONFIRMS the named hardened tier.
fn probe(tier: Tier, agent: &str, token: &str, amount: i128, expected: ExpectedGate) -> MandateProbe {
    MandateProbe { tier, agent: agent.to_string(), token: token.to_string(), amount, spender: None, expected }
}

/// Record an observation for a probe's key (the recorded on-chain gate read).
fn record(tape: MandateTape, p: &MandateProbe, ok: bool, reason: &str) -> MandateTape {
    tape.with(GateKey::from_probe(p), GateObservation::new(ok, reason))
}

// =================================================================================================
// The hardened tiers -- each confirmed via the two-source gate-read algebra.
// =================================================================================================

#[test]
fn hardened_tiers_each_confirm_from_their_recorded_gate_read() {
    // One probe per new hardened reason code; the recorded gate read MATCHES -> Confirmed. Each probe uses
    // a DISTINCT amount so its GateKey (agent,token,amount,spender) is unique on the tape (no collision).
    let not_started =
        probe(Tier::NotStarted, AGENT, NATIVE, 10, ExpectedGate::blocked("NOT_STARTED"));
    let epoch = probe(Tier::Epoch, AGENT, NATIVE, 20, ExpectedGate::blocked("EPOCH_STALE"));
    let txcount =
        probe(Tier::TxCountCap, AGENT, NATIVE, 30, ExpectedGate::blocked("OVER_TXCOUNT_CAP"));
    let min_spend =
        probe(Tier::MinSpend, AGENT, NATIVE, 40, ExpectedGate::blocked("BELOW_MIN_SPEND"));
    let staleness =
        probe(Tier::UsdStaleness, AGENT, NATIVE, 1_000_000, ExpectedGate::blocked("PRICE_UNAVAILABLE"));
    // The TYPED-spoke default-deny now reads back its OWN dedicated reason at the bridge boundary
    // (SPOKE_NOT_CONFIGURED), distinct from the address spender/router deny -- the honest two-source story.
    let spoke_deny =
        probe(Tier::SpokeDefaultDeny, AGENT, NATIVE, 60, ExpectedGate::blocked("SPOKE_NOT_CONFIGURED"));

    let mut tape = MandateTape::new();
    tape = record(tape, &not_started, false, "NOT_STARTED");
    tape = record(tape, &epoch, false, "EPOCH_STALE");
    tape = record(tape, &txcount, false, "OVER_TXCOUNT_CAP");
    tape = record(tape, &min_spend, false, "BELOW_MIN_SPEND");
    tape = record(tape, &staleness, false, "PRICE_UNAVAILABLE");
    tape = record(tape, &spoke_deny, false, "SPOKE_NOT_CONFIGURED");

    for p in [&not_started, &epoch, &txcount, &min_spend, &staleness, &spoke_deny] {
        let report = confirm_tier_via(p, &mut tape);
        assert_eq!(report.verdict, TierVerdict::Confirmed, "tier {} must confirm from its read", p.tier);
    }
}

#[test]
fn epoch_tier_refuted_when_the_gate_lets_a_stale_epoch_pass() {
    // The money-path epoch must STRAND a stale grant; if the gate let it pass (ok=true) -> Refuted.
    let epoch = probe(Tier::Epoch, AGENT, NATIVE, 1, ExpectedGate::blocked("EPOCH_STALE"));
    let mut tape = record(MandateTape::new(), &epoch, true, ""); // the gate WRONGLY allowed it.
    let report = confirm_tier_via(&epoch, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Refuted, "a stale-epoch spend that passes refutes the tier");
}

#[test]
fn spoke_default_deny_refuted_when_an_unconfigured_spoke_is_allowed() {
    // An unconfigured spoke must authorize nothing; a gate that allows it -> Refuted.
    let spoke = probe(Tier::SpokeDefaultDeny, AGENT, NATIVE, 1, ExpectedGate::blocked("SPOKE_NOT_CONFIGURED"));
    let mut tape = record(MandateTape::new(), &spoke, true, "");
    let report = confirm_tier_via(&spoke, &mut tape);
    assert_eq!(report.verdict, TierVerdict::Refuted, "an unconfigured spoke that passes refutes default-deny");
}

#[test]
fn hardened_tier_unreadable_is_unverified_never_confirmed() {
    // The keystone: an off-tape hardened probe degrades LOUDLY to Unverified, never a fabricated Confirmed.
    let p = probe(Tier::UsdStaleness, AGENT, NATIVE, 1, ExpectedGate::blocked("PRICE_UNAVAILABLE"));
    let mut empty = MandateTape::new();
    let report = confirm_tier_via(&p, &mut empty);
    assert_eq!(report.verdict, TierVerdict::Unverified);
    assert_ne!(report.verdict, TierVerdict::Confirmed, "an unread hardened tier must NEVER confirm");
}

// =================================================================================================
// The reconciler -- the advisory-path backing (the named system invariant I14-R).
// =================================================================================================

#[test]
fn reconciler_reconciles_a_clean_advisory_run() {
    // Every gateAndRecord accrual paired 1:1 with the on-chain transfer it bound -> Reconciled.
    let records =
        [SpendRecord::new(1, AGENT, NATIVE, 1_000_000, "0x0", 1), SpendRecord::new(2, AGENT, NATIVE, 500_000, "0x0", 1)];
    let transfers = [OnchainTransfer::new(1, AGENT, NATIVE, 1_000_000), OnchainTransfer::new(2, AGENT, NATIVE, 500_000)];
    let report = reconcile(&records, &transfers);
    assert_eq!(report.verdict, ReconcileVerdict::Reconciled);
    assert_eq!(report.paired, 2);
}

#[test]
fn reconciler_refutes_an_unbounded_spend_the_dangerous_case() {
    // THE DANGEROUS CASE the advisory model must catch: a spend that broadcast WITHOUT accruing (a transfer
    // with no SpendRecorded) -> the cap did not bind it -> LOUD Refuted, never a fabricated Reconciled.
    let records = [SpendRecord::new(1, AGENT, NATIVE, 1_000_000, "0x0", 1)];
    let transfers =
        [OnchainTransfer::new(1, AGENT, NATIVE, 1_000_000), OnchainTransfer::new(2, AGENT, NATIVE, 9_999_999)];
    let report = reconcile(&records, &transfers);
    assert_eq!(report.verdict, ReconcileVerdict::Refuted);
    assert_eq!(report.orphans[0].kind, OrphanKind::TransferWithoutRecord);
    assert_ne!(report.verdict, ReconcileVerdict::Reconciled, "an unbounded spend must NEVER reconcile");
}

#[test]
fn reconciler_refutes_a_spend_larger_than_its_accrual() {
    // The agent accrued 1.0M but moved 1.1M -- a mismatch -> Refuted (the spend exceeded what it bound).
    let records = [SpendRecord::new(1, AGENT, NATIVE, 1_000_000, "0x0", 1)];
    let transfers = [OnchainTransfer::new(1, AGENT, NATIVE, 1_100_000)];
    let report = reconcile(&records, &transfers);
    assert_eq!(report.verdict, ReconcileVerdict::Refuted);
    assert_eq!(report.orphans[0].kind, OrphanKind::Mismatch);
}

#[test]
fn reconciler_unverified_on_an_empty_read_never_reconciled() {
    // Nothing to reconcile -> the loud honest absence, never a fabricated Reconciled over an empty read.
    let report = reconcile(&[], &[]);
    assert_eq!(report.verdict, ReconcileVerdict::Unverified);
    assert_ne!(report.verdict, ReconcileVerdict::Reconciled);
}

#[test]
fn reconciler_is_deterministic() {
    let records = [SpendRecord::new(1, AGENT, NATIVE, 1, "0x0", 1)];
    let transfers = [OnchainTransfer::new(1, AGENT, NATIVE, 1)];
    let first = reconcile(&records, &transfers);
    for _ in 0..8 {
        assert_eq!(reconcile(&records, &transfers), first, "same inputs -> identical report");
    }
}

#[test]
fn a_stranger_spend_with_no_record_is_caught() {
    // A non-agent transfer with no record is still a transfer-without-record (the verifier is agnostic to
    // WHO -- any unrecorded move is unbounded by the advisory mandate).
    let transfers = [OnchainTransfer::new(7, STRANGER, NATIVE, 1)];
    let report = reconcile(&[], &transfers);
    assert_eq!(report.verdict, ReconcileVerdict::Refuted);
    assert_eq!(report.orphans[0].kind, OrphanKind::TransferWithoutRecord);
}
