//! The outbound time-lock verifier extension -- CONFIRM that the value-tiered outbound bridge-out
//! time-lock held ON-CHAIN (design "2b.2 Outbound (hub -> spoke) is the RISKY direction").
//!
//! Bridging value OUT of the secured 0G hub is the asymmetrically-risky direction: the hop burns/locks
//! on the hub and depends on a remote chain to release (the hollow-egress trap). The on-chain
//! `TimelockGuard` makes a large outbound transfer a TWO-STEP, VALUE-TIERED time-lock:
//! `queueBridgeOut` (mandate-gated, value-tiered delay) -> `executeBridgeOut` (REVERTS unless the delay
//! elapsed) / `cancelBridgeOut` (owner aborts in-window). This module is the verifier's INDEPENDENT
//! confirmation that the contract enforced that lock -- it never trusts the agent's "I waited."
//!
//! ## Two-source truth (design SS3 principle 1)
//!
//! The agent's claim "this outbound bridge was time-locked correctly" is the **Claim**; the verifier's
//! own read of the guard's queued-request state (the `queuedAt` / `executableAt` schedule + the actual
//! `executedAt`, or the `cancelled` flag) is the **Observation**. A request is CONFIRMED only when the
//! independent read proves the lock was honored -- the value tier's delay was applied AND, if executed,
//! it executed only AT or AFTER `executableAt` (no bypass). The verdict is minted HERE (the monopoly).
//!
//! ## The time-lock-verdict monopoly (design SS3 principle 2)
//!
//! [`TimelockVerdict`] is `#[non_exhaustive]` with `pub(crate)`-only minting, mirroring the settlement
//! [`crate::Verdict`] and the [`crate::mandate::TierVerdict`]: nothing outside this crate can fabricate
//! a "the lock held" verdict.
//!
//! ## Never fabricate (design SS3 principle 3)
//!
//! An unreadable / unrecorded request degrades LOUDLY to [`TimelockVerdict::Unverified`] -- never to a
//! fabricated `Confirmed`. A request that executed but whose read shows it executed BEFORE its
//! `executableAt` (a bypass the contract should make impossible) is a loud [`TimelockVerdict::Refuted`]
//! -- the verifier proves the no-bypass guarantee held, rather than assuming it.
//!
//! ## Deterministic (design SS3 principle 4) + offline-by-default (design SS6)
//!
//! [`adjudicate_timelock`] is pure over `(claim, observation)` -- no wall-clock, no global state. The
//! default build confirms a time-lock against a deterministic, std-only [`TimelockTape`] (a recorded
//! guard-state read); a feature-gated [`LiveTimelockSource`] reads the guard's state on 0G itself via
//! raw `eth_call`, so the default build needs no network.

use core::fmt;
use std::collections::BTreeMap;

/// Which value tier a queued outbound bridge-out fell into (design "2b.2 value-tiered time-lock"). A
/// label for the human-readable confirmation row + the schedule check, never part of the verdict
/// algebra beyond pairing the expected delay with the tier.
///
/// `Small` is `amount <= bigValueThreshold` (the short delay); `Big` is `amount > bigValueThreshold`
/// (the long, 24h-style lock). The exact boundary is the contract's; the verifier re-derives which tier
/// a request SHOULD have used from the claimed amount + threshold and confirms the on-chain delay matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ValueTier {
    /// `amount <= bigValueThreshold` -- the SHORT-delay tier.
    Small,
    /// `amount > bigValueThreshold` -- the LONG (24h-style) lock tier.
    Big,
}

impl ValueTier {
    /// Which tier `amount` falls into given the big-value `threshold` (inclusive at the threshold ==
    /// small). Pure -> the verifier re-derives the tier the contract should have applied.
    #[must_use]
    pub const fn classify(amount: i128, threshold: i128) -> ValueTier {
        if amount > threshold {
            ValueTier::Big
        } else {
            ValueTier::Small
        }
    }

    /// A stable, human-readable label for the confirmation row (deterministic; design SS3 principle 4).
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            ValueTier::Small => "small:short-delay",
            ValueTier::Big => "big:long-lock",
        }
    }
}

impl fmt::Display for ValueTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The verdict for ONE outbound time-lock request, minted by the verifier (design SS3 principle 2).
///
/// `#[non_exhaustive]` + `pub(crate)`-only minting: only this crate can construct a value, so nothing
/// outside the verifier can fabricate a "the lock held" verdict (exactly like [`crate::Verdict`] and
/// [`crate::mandate::TierVerdict`]).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimelockVerdict {
    /// The independent read PROVES the lock was honored: the value tier's delay was applied, and the
    /// request either is still safely pending under its delay, was cancelled in-window, or executed
    /// only AT or AFTER `executableAt` (no bypass).
    Confirmed,
    /// The read shows the lock was BYPASSED or mis-scheduled: the request executed BEFORE its
    /// `executableAt`, or the on-chain delay did not match the value tier's required delay. A loud
    /// "the time-lock did NOT hold as designed" (the contract should make this impossible -- the
    /// verifier proves it did not happen rather than assuming).
    Refuted,
    /// The guard state could not be read (off-tape / unreadable / not wired). The loud, honest degrade
    /// target (design SS3 principle 3) -- never a fabricated `Confirmed`.
    Unverified,
}

impl TimelockVerdict {
    /// The canonical, stable, snake_case string (the wire/journal form; deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            TimelockVerdict::Confirmed => "confirmed",
            TimelockVerdict::Refuted => "refuted",
            TimelockVerdict::Unverified => "unverified",
        }
    }

    /// `true` only for `Confirmed` -- the honest "the lock held on-chain" check. Nothing else reads as
    /// success (design SS3 principle 3).
    #[must_use]
    pub const fn is_confirmed(&self) -> bool {
        matches!(self, TimelockVerdict::Confirmed)
    }

    // The minting surface -- `pub(crate)` ONLY (the time-lock-verdict monopoly, design SS3 principle 2).
    pub(crate) const fn confirmed() -> TimelockVerdict {
        TimelockVerdict::Confirmed
    }
    pub(crate) const fn refuted() -> TimelockVerdict {
        TimelockVerdict::Refuted
    }
    pub(crate) const fn unverified() -> TimelockVerdict {
        TimelockVerdict::Unverified
    }
}

impl fmt::Display for TimelockVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The lifecycle status of a queued bridge-out, mirroring the `TimelockGuard.Status` enum on-chain.
///
/// `Pending` (queued, not yet executed/cancelled), `Executed` (the delay elapsed and `executeBridgeOut`
/// cleared it), `Cancelled` (the owner/queuer aborted it in-window). A read that finds NO request at the
/// queue id is the `None` Observation one level up (-> `Unverified`), distinct from a present `Pending`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LockStatus {
    /// Queued, within (or past) its delay, not yet executed or cancelled.
    Pending,
    /// `executeBridgeOut` cleared it AFTER the tier's delay -- the absorbing success.
    Executed,
    /// `cancelBridgeOut` aborted it in-window -- the absorbing abort (no value ever burned).
    Cancelled,
}

impl LockStatus {
    /// A stable, human-readable label (deterministic).
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            LockStatus::Pending => "pending",
            LockStatus::Executed => "executed",
            LockStatus::Cancelled => "cancelled",
        }
    }
}

impl fmt::Display for LockStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The agent's recorded CLAIM about one outbound time-lock request -- the **Claim** half of two-source
/// truth (design SS3 principle 1). Never trusted on its own; adjudicated against the verifier's own read
/// of the guard's queued-request state.
///
/// All amounts are exact `i128` minor units (design SS3 principle 5); all times are exact unix seconds.
///
/// - `queue_id` -- which queued request this claim is about (the guard's queue id, `>= 1`).
/// - `amount` -- the outbound amount the agent claims it queued, minor units (used to re-derive the
///   value tier the contract should have applied).
/// - `big_value_threshold` -- the guard's tier boundary, minor units (a public config of the guard).
/// - `expected_short_delay` / `expected_long_delay` -- the tier delays the guard is configured with
///   (public config), in seconds. The verifier re-derives which delay the request SHOULD have used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimelockClaim {
    /// The guard queue id this claim is about (`>= 1`; `0` is the guard's None sentinel).
    queue_id: u64,
    /// The outbound amount, minor units (drives the value-tier classification).
    amount: i128,
    /// The guard's big-value threshold, minor units (the tier boundary).
    big_value_threshold: i128,
    /// The configured SHORT-tier delay, seconds.
    expected_short_delay: u64,
    /// The configured LONG-tier (24h-style) delay, seconds.
    expected_long_delay: u64,
}

impl TimelockClaim {
    /// Build a time-lock claim from the queue id, the outbound amount, the guard's value-tier threshold,
    /// and the two configured tier delays (all public facts about the guard).
    #[must_use]
    pub const fn new(
        queue_id: u64,
        amount: i128,
        big_value_threshold: i128,
        expected_short_delay: u64,
        expected_long_delay: u64,
    ) -> TimelockClaim {
        TimelockClaim { queue_id, amount, big_value_threshold, expected_short_delay, expected_long_delay }
    }

    /// The guard queue id this claim is about.
    #[must_use]
    pub const fn queue_id(&self) -> u64 {
        self.queue_id
    }

    /// The outbound amount, minor units.
    #[must_use]
    pub const fn amount(&self) -> i128 {
        self.amount
    }

    /// The value tier this amount falls into (`Small` <= threshold, `Big` above).
    #[must_use]
    pub const fn tier(&self) -> ValueTier {
        ValueTier::classify(self.amount, self.big_value_threshold)
    }

    /// The delay (seconds) the contract SHOULD have applied for this amount's tier.
    #[must_use]
    pub const fn expected_delay(&self) -> u64 {
        match self.tier() {
            ValueTier::Small => self.expected_short_delay,
            ValueTier::Big => self.expected_long_delay,
        }
    }
}

/// The verifier's INDEPENDENT observation of one queued bridge-out's on-chain state -- the
/// **Observation** (design SS3 principle 1). The verifier's own read of the guard, never the agent's word.
///
/// All times are exact unix seconds. `status` is the on-chain lifecycle; `queued_at` + `executable_at`
/// are the recorded schedule; `executed_at` is `Some` only when the request actually executed (the unix
/// second of the `BridgeOutExecuted` event), `None` otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimelockObservation {
    /// The on-chain lifecycle status of the request.
    status: LockStatus,
    /// The unix second the request was queued (recorded on-chain).
    queued_at: u64,
    /// The unix second at/after which execution is allowed (recorded on-chain == `queued_at + delay`).
    executable_at: u64,
    /// The unix second the request actually executed, or `None` if it never executed.
    executed_at: Option<u64>,
}

impl TimelockObservation {
    /// Record an observation of a queued request's on-chain state.
    #[must_use]
    pub const fn new(
        status: LockStatus,
        queued_at: u64,
        executable_at: u64,
        executed_at: Option<u64>,
    ) -> TimelockObservation {
        TimelockObservation { status, queued_at, executable_at, executed_at }
    }

    /// A still-PENDING request (queued, not yet executed/cancelled) with this schedule.
    #[must_use]
    pub const fn pending(queued_at: u64, executable_at: u64) -> TimelockObservation {
        TimelockObservation { status: LockStatus::Pending, queued_at, executable_at, executed_at: None }
    }

    /// An EXECUTED request: it cleared at `executed_at` (the verifier checks this is `>= executable_at`).
    #[must_use]
    pub const fn executed(queued_at: u64, executable_at: u64, executed_at: u64) -> TimelockObservation {
        TimelockObservation {
            status: LockStatus::Executed,
            queued_at,
            executable_at,
            executed_at: Some(executed_at),
        }
    }

    /// A CANCELLED request (aborted in-window; no value ever burned).
    #[must_use]
    pub const fn cancelled(queued_at: u64, executable_at: u64) -> TimelockObservation {
        TimelockObservation {
            status: LockStatus::Cancelled,
            queued_at,
            executable_at,
            executed_at: None,
        }
    }

    /// The on-chain status.
    #[must_use]
    pub const fn status(&self) -> LockStatus {
        self.status
    }

    /// The recorded queue time (unix seconds).
    #[must_use]
    pub const fn queued_at(&self) -> u64 {
        self.queued_at
    }

    /// The recorded executable-at time (unix seconds).
    #[must_use]
    pub const fn executable_at(&self) -> u64 {
        self.executable_at
    }

    /// The actual execution time, or `None` if never executed.
    #[must_use]
    pub const fn executed_at(&self) -> Option<u64> {
        self.executed_at
    }

    /// The on-chain delay the guard recorded (`executable_at - queued_at`), seconds. `None` if the read
    /// is malformed (`executable_at < queued_at`, which the contract never produces).
    #[must_use]
    pub const fn recorded_delay(&self) -> Option<u64> {
        if self.executable_at >= self.queued_at {
            Some(self.executable_at - self.queued_at)
        } else {
            None
        }
    }
}

/// The result of confirming one time-lock request: the claim, the independent observation (or `None` if
/// unreadable), and the minted [`TimelockVerdict`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelockReport {
    /// The guard queue id this report is about.
    pub queue_id: u64,
    /// The outbound amount probed (minor units) -- echoed for the confirmation row.
    pub amount: i128,
    /// The value tier the amount falls into (re-derived from the claim).
    pub tier: ValueTier,
    /// The delay (seconds) the contract SHOULD have applied for the tier (the Claim's expectation).
    pub expected_delay: u64,
    /// The independently-observed on-chain state, or `None` when the guard could not be read (the loud
    /// absence that adjudicates to [`TimelockVerdict::Unverified`]).
    pub observed: Option<TimelockObservation>,
    /// The minted time-lock verdict -- the only place a time-lock verdict is created (the monopoly).
    pub verdict: TimelockVerdict,
}

impl TimelockReport {
    /// The canonical time-lock-verdict string (`confirmed` / `refuted` / `unverified`).
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate one outbound time-lock request: does the independent on-chain read PROVE the value-tiered
/// lock was honored -- the right delay applied, and (if executed) no too-early bypass?
///
/// The time-lock-confirmation algebra (design SS3 principle 1, two-source truth; "2b.2", the no-bypass
/// guarantee), evaluated strictly in order:
///
/// 1. `observed == None`                          -> [`TimelockVerdict::Unverified`]  (the keystone --
///    never fabricate; an unreadable request can never become a fabricated `Confirmed`).
/// 2. malformed schedule (`executable_at < queued_at`) -> [`TimelockVerdict::Refuted`]  (the read is
///    impossible -- the contract never records a negative delay; a loud "not as designed").
/// 3. the recorded delay != the value tier's expected delay -> [`TimelockVerdict::Refuted`]  (the wrong
///    tier delay was applied -- e.g. a big-value transfer scheduled with the short delay).
/// 4. status `Executed` AND `executed_at < executable_at`   -> [`TimelockVerdict::Refuted`]  (the
///    NO-BYPASS proof: the request executed BEFORE its delay elapsed -- the contract should make this
///    impossible, and the verifier confirms it did not happen).
/// 5. status `Executed` AND `executed_at >= executable_at`  -> [`TimelockVerdict::Confirmed`]  (executed
///    only after the delay -- the lock held).
/// 6. status `Pending` or `Cancelled` (with the right delay) -> [`TimelockVerdict::Confirmed`]  (a
///    request still safely under its lock, or aborted in-window -- both are the lock holding; no value
///    escaped early).
///
/// The verdict is minted HERE -- inside the crate -- preserving the time-lock-verdict monopoly (design
/// SS3 principle 2). Note the layered safety: a malformed/mis-scheduled read is refuted (steps 2-3)
/// BEFORE the execution check, and a too-early execute is the loud refuted at step (4) BEFORE the
/// confirmed path, so a bypassed lock can NEVER read as confirmed.
#[must_use]
pub fn adjudicate_timelock(claim: &TimelockClaim, observed: Option<TimelockObservation>) -> TimelockReport {
    let verdict = adjudicate_timelock_verdict(claim, observed.as_ref());
    TimelockReport {
        queue_id: claim.queue_id(),
        amount: claim.amount(),
        tier: claim.tier(),
        expected_delay: claim.expected_delay(),
        observed,
        verdict,
    }
}

/// The pure verdict core of [`adjudicate_timelock`] (the algebra, split out for direct testing).
#[must_use]
fn adjudicate_timelock_verdict(
    claim: &TimelockClaim,
    observed: Option<&TimelockObservation>,
) -> TimelockVerdict {
    // (1) Keystone (design SS3 principle 3): no read -> Unverified, never a fabricated Confirmed.
    let Some(obs) = observed else {
        return TimelockVerdict::unverified();
    };

    // (2) A malformed schedule (executable_at < queued_at) is an impossible read -> Refuted. The
    // contract never records a negative delay; if we read one, the lock is not as designed.
    let Some(recorded_delay) = obs.recorded_delay() else {
        return TimelockVerdict::refuted();
    };

    // (3) The recorded delay must equal the value tier's expected delay -- the right lock for the tier.
    // A big-value transfer scheduled with the short delay (or vice versa) is a loud Refuted.
    if recorded_delay != claim.expected_delay() {
        return TimelockVerdict::refuted();
    }

    // (4) + (5) The NO-BYPASS proof for an executed request: it must have executed at or after its
    // executable_at. A too-early execution is Refuted (the contract should make it impossible; the
    // verifier confirms it did not happen). On-or-after is Confirmed.
    if obs.status() == LockStatus::Executed {
        return match obs.executed_at() {
            // Executed but no recorded execution time is a malformed read -> Refuted (never confirmed).
            None => TimelockVerdict::refuted(),
            Some(executed_at) if executed_at < obs.executable_at() => TimelockVerdict::refuted(),
            Some(_) => TimelockVerdict::confirmed(),
        };
    }

    // (6) Pending or Cancelled, with the right tier delay applied -> Confirmed. The lock is holding (the
    // request is still under its delay) or was aborted in-window (no value ever burned). Either way no
    // value escaped early -- the time-lock did its job.
    TimelockVerdict::confirmed()
}

// =================================================================================================
// The time-lock read seam -- the independent Observation source (mirrors the mandate gate source).
// =================================================================================================

/// The key for a time-lock read: which guard + which queue id to read.
///
/// A distinct newtype so the read seam is type-checked + the tape is deterministically ordered. Two
/// reads with identical (guard, queue id) yield the same key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimelockKey {
    /// Lowercased guard contract address.
    guard: String,
    /// The queue id (as a decimal string, for a total Ord key).
    queue_id: String,
}

impl TimelockKey {
    /// Build a time-lock key from the guard address + the queue id.
    #[must_use]
    pub fn new(guard: impl AsRef<str>, queue_id: u64) -> TimelockKey {
        TimelockKey { guard: guard.as_ref().trim().to_ascii_lowercase(), queue_id: queue_id.to_string() }
    }

    /// The lowercased guard address.
    #[must_use]
    pub fn guard(&self) -> &str {
        &self.guard
    }
}

/// The independent time-lock-read seam -- the Observation source for a queued bridge-out.
///
/// `read_lock` returns `Some(observation)` when the guard answered (the request was found + decoded), or
/// `None` when it could not be read (off-tape / unreadable / not wired) -- never a fabricated observation
/// (design SS3 principle 3). A taped replay and a live `eth_call` reader both satisfy it, so swapping one
/// for the other never changes what a time-lock verdict MEANS.
pub trait TimelockSource {
    /// Read the guard state for `key`. `None` is the loud honest absence (-> Unverified).
    fn read_lock(&mut self, key: &TimelockKey) -> Option<TimelockObservation>;
}

/// A deterministic, std-only replay of recorded guard-state reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`TimelockKey`] to a
/// recorded [`TimelockObservation`]. A keyed read replays its exact recording; an unrecorded key is
/// `None` (we have no recording, so we refuse to invent one). The tape IS the recorded guard state, frozen.
#[derive(Debug, Clone, Default)]
pub struct TimelockTape {
    tape: BTreeMap<TimelockKey, TimelockObservation>,
}

impl TimelockTape {
    /// An empty tape -- every time-lock read is `None` (unverified).
    #[must_use]
    pub fn new() -> TimelockTape {
        TimelockTape { tape: BTreeMap::new() }
    }

    /// Record a guard observation for a key, returning the tape for chaining.
    #[must_use]
    pub fn with(mut self, key: TimelockKey, obs: TimelockObservation) -> TimelockTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a guard observation for a key in place.
    pub fn record(&mut self, key: TimelockKey, obs: TimelockObservation) {
        self.tape.insert(key, obs);
    }

    /// How many guard reads are recorded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff no guard reads are recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl TimelockSource for TimelockTape {
    fn read_lock(&mut self, key: &TimelockKey) -> Option<TimelockObservation> {
        self.tape.get(key).copied()
    }
}

/// Confirm one time-lock request end-to-end: build the key, read the guard from `source`, adjudicate.
///
/// The time-lock analogue of [`crate::mandate::confirm_tier_via`]: the claim's expected schedule is the
/// Claim, the guard read is the Observation, and [`adjudicate_timelock`] mints the verdict. An unreadable
/// guard degrades to [`TimelockVerdict::Unverified`] -- never a fabricated `Confirmed`.
#[must_use]
pub fn confirm_timelock_via(
    guard: &str,
    claim: &TimelockClaim,
    source: &mut dyn TimelockSource,
) -> TimelockReport {
    let key = TimelockKey::new(guard, claim.queue_id());
    let observed = source.read_lock(&key);
    adjudicate_timelock(claim, observed)
}

/// Render a [`TimelockReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for TimelockReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (status, queued, exec_at, executed) = match &self.observed {
            Some(o) => (
                o.status().label(),
                o.queued_at().to_string(),
                o.executable_at().to_string(),
                o.executed_at().map_or_else(|| "<none>".to_string(), |t| t.to_string()),
            ),
            None => ("<unreadable>", "<n/a>".to_string(), "<n/a>".to_string(), "<n/a>".to_string()),
        };
        write!(
            f,
            "TIMELOCK queue={} amount={} tier={} expected_delay={} status={} queued_at={} executable_at={} executed_at={} -> {}",
            self.queue_id,
            self.amount,
            self.tier,
            self.expected_delay,
            status,
            queued,
            exec_at,
            executed,
            self.verdict_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUARD: &str = "0xguard000000000000000000000000000000guard";

    // A guard with threshold 1_000_000, short delay 3600 (1h), long delay 86_400 (24h).
    const THRESHOLD: i128 = 1_000_000;
    const SHORT: u64 = 3_600;
    const LONG: u64 = 86_400;

    const SMALL: i128 = 500_000; // small tier
    const BIG: i128 = 5_000_000; // big tier

    const T0: u64 = 2_000_000;

    fn small_claim() -> TimelockClaim {
        TimelockClaim::new(1, SMALL, THRESHOLD, SHORT, LONG)
    }

    fn big_claim() -> TimelockClaim {
        TimelockClaim::new(2, BIG, THRESHOLD, SHORT, LONG)
    }

    // --- the value-tier classification (pure) ----------------------------------------------------

    #[test]
    fn classify_is_inclusive_at_the_threshold() {
        assert_eq!(ValueTier::classify(THRESHOLD, THRESHOLD), ValueTier::Small, "== threshold is small");
        assert_eq!(ValueTier::classify(THRESHOLD - 1, THRESHOLD), ValueTier::Small);
        assert_eq!(ValueTier::classify(THRESHOLD + 1, THRESHOLD), ValueTier::Big, "just over is big");
    }

    #[test]
    fn expected_delay_follows_the_tier() {
        assert_eq!(small_claim().tier(), ValueTier::Small);
        assert_eq!(small_claim().expected_delay(), SHORT, "small -> short delay");
        assert_eq!(big_claim().tier(), ValueTier::Big);
        assert_eq!(big_claim().expected_delay(), LONG, "big -> long lock");
    }

    // --- the three verdicts ----------------------------------------------------------------------

    #[test]
    fn confirmed_when_small_executes_at_or_after_its_short_delay() {
        // queued at T0, executable at T0+SHORT, executed exactly at the boundary -> Confirmed.
        let obs = TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT);
        let r = adjudicate_timelock(&small_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Confirmed);
        assert_eq!(r.verdict_string(), "confirmed");
        assert_eq!(r.tier, ValueTier::Small);
    }

    #[test]
    fn confirmed_when_big_executes_after_the_full_long_lock() {
        let obs = TimelockObservation::executed(T0, T0 + LONG, T0 + LONG + 5);
        let r = adjudicate_timelock(&big_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Confirmed, "executed well after the long lock");
    }

    #[test]
    fn refuted_when_a_request_executed_before_its_delay_the_no_bypass_proof() {
        // THE NO-BYPASS PROOF: executed_at < executable_at -> Refuted. The contract should make this
        // impossible (executeBridgeOut reverts TooEarly); the verifier confirms it did NOT happen.
        let obs = TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT - 1);
        let r = adjudicate_timelock(&small_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Refuted, "a too-early execute is a bypass -> refuted");
        assert_ne!(r.verdict, TimelockVerdict::Confirmed, "a bypassed lock must NEVER confirm");
    }

    #[test]
    fn refuted_when_the_wrong_tier_delay_was_applied() {
        // A BIG-value transfer scheduled with the SHORT delay (the contract under-locked it) -> Refuted.
        let obs = TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT);
        let r = adjudicate_timelock(&big_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Refuted, "big value under the short delay is mis-scheduled");
    }

    #[test]
    fn refuted_when_the_schedule_is_malformed_negative_delay() {
        // executable_at < queued_at is an impossible read (negative delay) -> Refuted.
        let obs = TimelockObservation::new(LockStatus::Pending, T0, T0 - 10, None);
        let r = adjudicate_timelock(&small_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Refuted, "a negative recorded delay is not as designed");
    }

    #[test]
    fn refuted_when_executed_without_a_recorded_execution_time() {
        // Status Executed but no executed_at is a malformed read -> Refuted, never confirmed.
        let obs = TimelockObservation::new(LockStatus::Executed, T0, T0 + SHORT, None);
        let r = adjudicate_timelock(&small_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Refuted);
    }

    #[test]
    fn confirmed_when_pending_under_the_right_delay() {
        // Still pending under the correct tier delay -> Confirmed (the lock is holding; nothing escaped).
        let obs = TimelockObservation::pending(T0, T0 + SHORT);
        let r = adjudicate_timelock(&small_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Confirmed, "a holding lock is confirmed");
    }

    #[test]
    fn confirmed_when_cancelled_in_window() {
        // Cancelled in-window under the right delay -> Confirmed (aborted before any value burned).
        let obs = TimelockObservation::cancelled(T0, T0 + LONG);
        let r = adjudicate_timelock(&big_claim(), Some(obs));
        assert_eq!(r.verdict, TimelockVerdict::Confirmed, "an in-window cancel is the lock doing its job");
    }

    #[test]
    fn unverified_when_no_read_at_all_never_confirmed() {
        // THE KEYSTONE (design SS3 principle 3): no read -> Unverified, never a fabricated confirmed.
        let r = adjudicate_timelock(&small_claim(), None);
        assert_eq!(r.verdict, TimelockVerdict::Unverified);
        assert_ne!(r.verdict, TimelockVerdict::Confirmed);
    }

    #[test]
    fn adjudicate_timelock_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let c = small_claim();
        for _ in 0..8 {
            assert_eq!(
                adjudicate_timelock(&c, Some(TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT))).verdict,
                TimelockVerdict::Confirmed
            );
            assert_eq!(
                adjudicate_timelock(&c, Some(TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT - 1))).verdict,
                TimelockVerdict::Refuted
            );
            assert_eq!(adjudicate_timelock(&c, None).verdict, TimelockVerdict::Unverified);
        }
    }

    // --- the time-lock tape (offline, deterministic) ---------------------------------------------

    #[test]
    fn tape_hit_confirms_and_off_tape_is_unverified() {
        let c = small_claim();
        let key = TimelockKey::new(GUARD, c.queue_id());
        let mut tape = TimelockTape::new()
            .with(key, TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT));

        let report = confirm_timelock_via(GUARD, &c, &mut tape);
        assert_eq!(report.verdict, TimelockVerdict::Confirmed);

        // A different queue id is off-tape -> Unverified (never fabricated).
        let other = TimelockClaim::new(99, SMALL, THRESHOLD, SHORT, LONG);
        let off = confirm_timelock_via(GUARD, &other, &mut tape);
        assert_eq!(off.verdict, TimelockVerdict::Unverified);
    }

    #[test]
    fn tape_too_early_execute_is_refuted_through_the_seam() {
        let c = big_claim();
        let key = TimelockKey::new(GUARD, c.queue_id());
        // A big-value request that executed one second before its long lock elapsed.
        let mut tape = TimelockTape::new()
            .with(key, TimelockObservation::executed(T0, T0 + LONG, T0 + LONG - 1));
        let report = confirm_timelock_via(GUARD, &c, &mut tape);
        assert_eq!(report.verdict, TimelockVerdict::Refuted, "a bypass is caught through the read seam");
    }

    #[test]
    fn recorded_delay_handles_a_well_formed_and_malformed_schedule() {
        let ok = TimelockObservation::pending(T0, T0 + SHORT);
        assert_eq!(ok.recorded_delay(), Some(SHORT));
        let bad = TimelockObservation::new(LockStatus::Pending, T0, T0 - 1, None);
        assert_eq!(bad.recorded_delay(), None, "executable before queued is malformed");
    }

    #[test]
    fn display_is_stable_and_carries_the_verdict() {
        let r = adjudicate_timelock(
            &small_claim(),
            Some(TimelockObservation::executed(T0, T0 + SHORT, T0 + SHORT)),
        );
        let line = r.to_string();
        assert!(line.contains("TIMELOCK"));
        assert!(line.contains("tier=small:short-delay"));
        assert!(line.ends_with("-> confirmed"));
    }
}
