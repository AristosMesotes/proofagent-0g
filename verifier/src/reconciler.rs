//! The SPEND RECONCILER -- the named system invariant that backs the ADVISORY, NON-CUSTODIAL mandate.
//!
//! ## Why a reconciler exists (the honest money-safety model)
//!
//! The consolidated `MandateRegistry` is ADVISORY + NON-CUSTODIAL: it holds NO funds. The agent gateway
//! ENFORCES by refusing an over-cap action PRE-broadcast (a fail-closed kill-switch); the registry accrues
//! every cleared spend into its leaky bucket via `gateAndRecord`, emitting a `SpendRecorded(spendId, agent,
//! token, amount, ...)` event. But because the contract is not the spender, "the agent can't overspend" is
//! NOT a pure on-chain invariant the way it would be for a custodial escrow -- it is enforced PRE-broadcast
//! and PROVEN by this reconciler. The HONEST claim is therefore: "the mandate blocks it pre-broadcast and
//! the verifier proves it", NEVER "physically can't overspend".
//!
//! This module is the PROOF half. It pairs, 1:1 by `spendId`:
//!   - every agent-originated `SpendRecorded` (the registry's accrual record -- the **Claim**), against
//!   - every on-chain `Transfer` of an allowlisted token from the agent (the verifier's own read -- the
//!     **Observation**).
//!
//! A record with NO matching transfer (the agent accrued but never spent -- benign, or a phantom record) OR
//! a transfer with NO matching record (the agent SPENT WITHOUT ACCRUING -- the dangerous unbounded-spend
//! that bypasses the cap) is **Refuted** -- a LOUD "the advisory mandate did NOT bind this spend". A perfect
//! 1:1 pairing is **Reconciled**. An unreadable side degrades to **Unverified** (never a fabricated pass).
//!
//! ## The verdict monopoly (design SS3 principle 2)
//!
//! [`ReconcileVerdict`] is `#[non_exhaustive]` with `pub(crate)`-only minting, mirroring the settlement
//! [`crate::Verdict`] and the [`crate::mandate::TierVerdict`]: nothing outside the crate fabricates a
//! "reconciled" verdict.
//!
//! ## Determinism + exact-integer + offline-by-default (design SS3 principles 4/5, SS6)
//!
//! [`reconcile`] is pure over `(records, transfers)` -- no wall-clock, no global state, ordered `BTreeMap`
//! pairing, exact `i128` minor-unit amounts (no float). The default build reconciles a deterministic, std-
//! only set of records + transfers (the recorded tape); a `live` reader (the on-chain log scan) is a future
//! leg -- the algebra here is the binding invariant either way.

use core::fmt;
use std::collections::BTreeMap;

/// One `SpendRecorded` accrual the registry emitted -- the agent's recorded CLAIM that it is about to spend
/// `amount` of `token` to `spender`, accrued under `spend_id` at `epoch`. Exact-integer minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendRecord {
    /// The monotonic spend id the registry assigned (the 1:1 pairing key; `>= 1`).
    pub spend_id: u64,
    /// The accruing agent (lowercased address).
    pub agent: String,
    /// The allowlisted token (lowercased address).
    pub token: String,
    /// The accrued amount, MINOR units (exact-integer).
    pub amount: i128,
    /// The destination/spender (lowercased; may be the zero address for a no-destination accrual).
    pub spender: String,
    /// The epoch the accrual was recorded under (a `bumpEpoch` between accrual + spend strands a grant).
    pub epoch: u64,
}

impl SpendRecord {
    /// Build a spend record (canonicalizing addresses to lowercase for a stable pairing key).
    #[must_use]
    pub fn new(
        spend_id: u64,
        agent: impl AsRef<str>,
        token: impl AsRef<str>,
        amount: i128,
        spender: impl AsRef<str>,
        epoch: u64,
    ) -> SpendRecord {
        SpendRecord {
            spend_id,
            agent: agent.as_ref().trim().to_ascii_lowercase(),
            token: token.as_ref().trim().to_ascii_lowercase(),
            amount,
            spender: spender.as_ref().trim().to_ascii_lowercase(),
            epoch,
        }
    }
}

/// One on-chain `Transfer` the verifier independently read -- the OBSERVATION that an agent moved `amount`
/// of an allowlisted `token`, tagged with the `spend_id` the agent claims it corresponds to (read from the
/// agent's submitted intent / the tx that carried the accrual id). Exact-integer minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnchainTransfer {
    /// The spend id this transfer claims to fulfil (the pairing key).
    pub spend_id: u64,
    /// The spending agent (lowercased address).
    pub agent: String,
    /// The token moved (lowercased address).
    pub token: String,
    /// The amount moved, MINOR units (exact-integer; the verifier's own chain read).
    pub amount: i128,
}

impl OnchainTransfer {
    /// Build an on-chain transfer observation (canonicalizing addresses to lowercase).
    #[must_use]
    pub fn new(spend_id: u64, agent: impl AsRef<str>, token: impl AsRef<str>, amount: i128) -> OnchainTransfer {
        OnchainTransfer {
            spend_id,
            agent: agent.as_ref().trim().to_ascii_lowercase(),
            token: token.as_ref().trim().to_ascii_lowercase(),
            amount,
        }
    }
}

/// The verdict for the whole reconciliation pass, minted by the verifier (design SS3 principle 2).
///
/// `#[non_exhaustive]` + `pub(crate)`-only minting: nothing outside the crate fabricates a "reconciled".
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReconcileVerdict {
    /// Every record paired 1:1 with a matching transfer (same agent/token/amount) and vice-versa -- the
    /// advisory mandate bound every spend; no spend escaped the accrual.
    Reconciled,
    /// At least one orphan: a record with no matching transfer, a transfer with no matching record, or a
    /// pair that disagrees on agent/token/amount. A LOUD "an advisory spend did NOT reconcile" (the
    /// dangerous case is a transfer with no record -- an unbounded spend that bypassed the cap).
    Refuted,
    /// A side could not be read (no records AND no transfers supplied, i.e. nothing to reconcile). The loud,
    /// honest degrade target -- never a fabricated `Reconciled` over an empty read.
    Unverified,
}

impl ReconcileVerdict {
    /// The canonical, stable, snake_case string (the wire/journal form; deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            ReconcileVerdict::Reconciled => "reconciled",
            ReconcileVerdict::Refuted => "refuted",
            ReconcileVerdict::Unverified => "unverified",
        }
    }

    /// `true` only for `Reconciled` -- the honest "every advisory spend bound" check.
    #[must_use]
    pub const fn is_reconciled(&self) -> bool {
        matches!(self, ReconcileVerdict::Reconciled)
    }

    // The minting surface -- `pub(crate)` ONLY (the verdict monopoly, design SS3 principle 2).
    pub(crate) const fn reconciled() -> ReconcileVerdict {
        ReconcileVerdict::Reconciled
    }
    pub(crate) const fn refuted() -> ReconcileVerdict {
        ReconcileVerdict::Refuted
    }
    pub(crate) const fn unverified() -> ReconcileVerdict {
        ReconcileVerdict::Unverified
    }
}

impl fmt::Display for ReconcileVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// Why a single `spend_id` failed to reconcile (a loud, structured orphan reason for the journal/UI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrphanKind {
    /// A `SpendRecorded` with no matching on-chain `Transfer` (accrued but never spent -- benign or phantom).
    RecordWithoutTransfer,
    /// An on-chain `Transfer` with no matching `SpendRecorded` -- the DANGEROUS case: a spend that bypassed
    /// the accrual (an unbounded spend the advisory cap did not bind).
    TransferWithoutRecord,
    /// A paired record + transfer that DISAGREE on agent / token / amount.
    Mismatch,
}

impl OrphanKind {
    /// A stable, human-readable label.
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            OrphanKind::RecordWithoutTransfer => "record-without-transfer",
            OrphanKind::TransferWithoutRecord => "transfer-without-record",
            OrphanKind::Mismatch => "mismatch",
        }
    }
}

/// One orphan / mismatch found during reconciliation (the loud detail behind a `Refuted`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orphan {
    /// The spend id that did not reconcile.
    pub spend_id: u64,
    /// Why it did not reconcile.
    pub kind: OrphanKind,
}

/// The result of a reconciliation pass: the minted verdict + every orphan (empty iff `Reconciled`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    /// The number of records paired 1:1 with a transfer (agent/token/amount all matched).
    pub paired: usize,
    /// Every orphan / mismatch (empty iff reconciled). Ordered by spend id (deterministic).
    pub orphans: Vec<Orphan>,
    /// The minted reconcile verdict -- the only place a reconcile verdict is created (the monopoly).
    pub verdict: ReconcileVerdict,
}

impl ReconcileReport {
    /// The canonical reconcile-verdict string.
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// RECONCILE the advisory mandate: pair every `SpendRecorded` 1:1 against every on-chain `Transfer` by
/// `spend_id`, and adjudicate. The named system invariant I14-R that backs the non-custodial mandate.
///
/// The algebra (design SS3 principle 1, two-source truth), evaluated deterministically:
///
/// 1. `records` AND `transfers` both empty -> [`ReconcileVerdict::Unverified`] (nothing to reconcile; the
///    loud honest absence -- never a fabricated `Reconciled` over an empty read).
/// 2. For each `spend_id`: a record present without a transfer is `RecordWithoutTransfer`; a transfer
///    present without a record is `TransferWithoutRecord` (the dangerous unbounded spend); a present pair
///    that disagrees on agent/token/amount is `Mismatch`. ANY orphan -> [`ReconcileVerdict::Refuted`].
/// 3. Every `spend_id` paired 1:1 with agent/token/amount matching -> [`ReconcileVerdict::Reconciled`].
///
/// The verdict is minted HERE -- inside the crate -- preserving the monopoly. Exact-integer amount compare;
/// no float; ordered by spend id so the orphan list is deterministic.
#[must_use]
pub fn reconcile(records: &[SpendRecord], transfers: &[OnchainTransfer]) -> ReconcileReport {
    if records.is_empty() && transfers.is_empty() {
        return ReconcileReport { paired: 0, orphans: Vec::new(), verdict: ReconcileVerdict::unverified() };
    }

    // Index both sides by spend id (BTreeMap => deterministic iteration order).
    let mut rec_by_id: BTreeMap<u64, &SpendRecord> = BTreeMap::new();
    for r in records {
        rec_by_id.insert(r.spend_id, r);
    }
    let mut tx_by_id: BTreeMap<u64, &OnchainTransfer> = BTreeMap::new();
    for t in transfers {
        tx_by_id.insert(t.spend_id, t);
    }

    // The union of spend ids, ordered.
    let mut ids: BTreeMap<u64, ()> = BTreeMap::new();
    for id in rec_by_id.keys() {
        ids.insert(*id, ());
    }
    for id in tx_by_id.keys() {
        ids.insert(*id, ());
    }

    let mut paired = 0usize;
    let mut orphans: Vec<Orphan> = Vec::new();
    for id in ids.keys() {
        match (rec_by_id.get(id), tx_by_id.get(id)) {
            (Some(r), Some(t)) => {
                if r.agent == t.agent && r.token == t.token && r.amount == t.amount {
                    paired += 1;
                } else {
                    orphans.push(Orphan { spend_id: *id, kind: OrphanKind::Mismatch });
                }
            }
            (Some(_), None) => {
                orphans.push(Orphan { spend_id: *id, kind: OrphanKind::RecordWithoutTransfer });
            }
            (None, Some(_)) => {
                orphans.push(Orphan { spend_id: *id, kind: OrphanKind::TransferWithoutRecord });
            }
            (None, None) => unreachable!("an id in the union must be in at least one side"),
        }
    }

    let verdict =
        if orphans.is_empty() { ReconcileVerdict::reconciled() } else { ReconcileVerdict::refuted() };
    ReconcileReport { paired, orphans, verdict }
}

impl fmt::Display for ReconcileReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RECONCILE paired={} orphans={} -> {}", self.paired, self.orphans.len(), self.verdict_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0xC7AF61a1399ACa0BeE648d7853ae93f96B86866A";
    const TOKEN: &str = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const OTHER: &str = "0x1111111111111111111111111111111111111111";

    fn rec(id: u64, amount: i128) -> SpendRecord {
        SpendRecord::new(id, AGENT, TOKEN, amount, "0x0000000000000000000000000000000000000000", 1)
    }

    fn tx(id: u64, amount: i128) -> OnchainTransfer {
        OnchainTransfer::new(id, AGENT, TOKEN, amount)
    }

    #[test]
    fn reconciled_when_every_record_pairs_one_to_one() {
        let records = [rec(1, 1_000_000), rec(2, 500_000)];
        let transfers = [tx(1, 1_000_000), tx(2, 500_000)];
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Reconciled);
        assert_eq!(report.verdict_string(), "reconciled");
        assert_eq!(report.paired, 2);
        assert!(report.orphans.is_empty());
    }

    #[test]
    fn refuted_on_a_transfer_without_a_record_the_unbounded_spend() {
        // THE DANGEROUS CASE: a spend that bypassed the accrual -> a transfer with no record -> Refuted.
        let records = [rec(1, 1_000_000)];
        let transfers = [tx(1, 1_000_000), tx(2, 9_999_999)];
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Refuted);
        assert_eq!(report.orphans.len(), 1);
        assert_eq!(report.orphans[0].spend_id, 2);
        assert_eq!(report.orphans[0].kind, OrphanKind::TransferWithoutRecord);
    }

    #[test]
    fn refuted_on_a_record_without_a_transfer() {
        let records = [rec(1, 1_000_000), rec(2, 500_000)];
        let transfers = [tx(1, 1_000_000)];
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Refuted);
        assert_eq!(report.orphans[0].kind, OrphanKind::RecordWithoutTransfer);
    }

    #[test]
    fn refuted_on_an_amount_mismatch() {
        let records = [rec(1, 1_000_000)];
        let transfers = [tx(1, 1_100_000)]; // moved MORE than was accrued.
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Refuted);
        assert_eq!(report.orphans[0].kind, OrphanKind::Mismatch);
    }

    #[test]
    fn refuted_on_a_token_mismatch() {
        let records = [rec(1, 1_000_000)];
        let transfers = [OnchainTransfer::new(1, AGENT, OTHER, 1_000_000)];
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Refuted);
        assert_eq!(report.orphans[0].kind, OrphanKind::Mismatch);
    }

    #[test]
    fn unverified_when_nothing_to_reconcile_never_reconciled() {
        let report = reconcile(&[], &[]);
        assert_eq!(report.verdict, ReconcileVerdict::Unverified);
        assert_ne!(report.verdict, ReconcileVerdict::Reconciled, "an empty read must never reconcile");
    }

    #[test]
    fn reconcile_is_deterministic() {
        let records = [rec(2, 500_000), rec(1, 1_000_000)]; // out of order.
        let transfers = [tx(1, 1_000_000), tx(2, 500_000)];
        let first = reconcile(&records, &transfers);
        for _ in 0..8 {
            assert_eq!(reconcile(&records, &transfers), first, "same inputs -> identical report");
        }
    }

    #[test]
    fn addresses_are_canonicalized_case_insensitively() {
        // The record's lowercased agent/token must pair with an upper-cased transfer of the same address.
        let records = [rec(1, 1_000_000)];
        let transfers = [OnchainTransfer::new(1, AGENT.to_ascii_uppercase(), TOKEN.to_ascii_uppercase(), 1_000_000)];
        let report = reconcile(&records, &transfers);
        assert_eq!(report.verdict, ReconcileVerdict::Reconciled, "case-insensitive address pairing");
    }

    #[test]
    fn canonical_strings_are_exact_and_distinct() {
        assert_eq!(ReconcileVerdict::reconciled().canonical_string(), "reconciled");
        assert_eq!(ReconcileVerdict::refuted().canonical_string(), "refuted");
        assert_eq!(ReconcileVerdict::unverified().canonical_string(), "unverified");
        assert!(ReconcileVerdict::reconciled().is_reconciled());
        assert!(!ReconcileVerdict::refuted().is_reconciled());
    }

    #[test]
    fn display_carries_the_verdict() {
        let report = reconcile(&[rec(1, 1)], &[tx(1, 1)]);
        let line = report.to_string();
        assert!(line.contains("RECONCILE"));
        assert!(line.ends_with("-> reconciled"));
    }
}
