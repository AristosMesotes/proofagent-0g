//! The gas-floor verifier extension -- CONFIRM that the native gas reserve HELD after an action
//! (design SS3a, the "can't deplete gas" money-safety primitive).
//!
//! The agent gateway enforces a PRE-broadcast gas floor: before any value-moving action it asserts, on
//! the agent's own native balance, `nativeBalance - actionNativeCost - estGasFee >= minGasReserve`, and
//! REFUSES the action otherwise (the kill-switch). This module is the verifier's INDEPENDENT
//! confirmation that the reserve actually held ON-CHAIN after the action ran -- it never trusts the
//! agent's "I left enough gas." A post-action native balance that fell BELOW the configured reserve is a
//! LOUD `refuted` (a depletion the gate should have prevented), surfaced via the verdict monopoly.
//!
//! ## Two-source truth (design SS3 principle 1)
//!
//! The agent's claim "this action kept the gas reserve above the floor" is the **Claim** (the configured
//! `min_gas_reserve` the gate promised to hold); the verifier's own `eth_getBalance` read of the agent
//! AFTER the action is the **Observation**. The reserve is CONFIRMED only when the independent read shows
//! the post-action balance is at or above the configured floor. The verdict is minted HERE (the monopoly).
//!
//! ## The gas-floor-verdict monopoly (design SS3 principle 2)
//!
//! [`GasFloorVerdict`] is `#[non_exhaustive]` with `pub(crate)`-only minting, mirroring the settlement
//! [`crate::Verdict`], the [`crate::mandate::TierVerdict`], and the [`crate::timelock::TimelockVerdict`]:
//! nothing outside this crate can fabricate a "the reserve held" verdict.
//!
//! ## Never fabricate (design SS3 principle 3)
//!
//! An unreadable post-action balance degrades LOUDLY to [`GasFloorVerdict::Unverified`] -- never to a
//! fabricated `Confirmed`. A read that shows the reserve was BREACHED (the post-action balance fell below
//! the configured floor -- a depletion the gate should have blocked) is a loud [`GasFloorVerdict::Refuted`]
//! -- the verifier proves the floor held rather than assuming it. The three are different code paths that
//! can never be confused.
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5)
//!
//! [`adjudicate_gas_floor`] is pure over `(claim, observation)` -- no wall-clock, no global state. Every
//! amount is an exact `i128` in native minor units (wei); there is NO float anywhere on this money path.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build confirms the floor against a deterministic, std-only [`GasFloorTape`] (a recorded
//! post-action balance read), so it needs no network. The `live` feature adds [`LiveGasFloorSource`] -- a
//! real `eth_getBalance` reader that POSTs to the 0G RPC and decodes the hex balance, the same
//! raw-JSON-RPC shape the settlement [`crate::LiveSource`] and the mandate [`crate::mandate::LiveGateSource`]
//! use.

use core::fmt;
use std::collections::BTreeMap;

/// The verdict for ONE gas-floor confirmation, minted by the verifier (design SS3 principle 2, monopoly).
///
/// `#[non_exhaustive]` + `pub(crate)`-only minting: only this crate can construct a value, so nothing
/// outside the verifier can fabricate a "the reserve held" verdict (exactly like [`crate::Verdict`],
/// [`crate::mandate::TierVerdict`], and [`crate::timelock::TimelockVerdict`]).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GasFloorVerdict {
    /// The independent read PROVES the reserve held: the post-action native balance is AT or ABOVE the
    /// configured `min_gas_reserve` -- the agent kept enough gas to pay for its own next transaction.
    Confirmed,
    /// The read shows the reserve was BREACHED: the post-action native balance fell BELOW the configured
    /// floor -- a depletion the PRE-broadcast gate should have blocked. A loud "the gas floor did NOT hold
    /// as designed" (the gate makes this impossible; the verifier confirms it did not happen).
    Refuted,
    /// The post-action balance could not be read (off-tape / unreadable / not wired). The loud, honest
    /// degrade target (design SS3 principle 3) -- never a fabricated `Confirmed`.
    Unverified,
}

impl GasFloorVerdict {
    /// The canonical, stable, snake_case string (the wire/journal form; deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            GasFloorVerdict::Confirmed => "confirmed",
            GasFloorVerdict::Refuted => "refuted",
            GasFloorVerdict::Unverified => "unverified",
        }
    }

    /// `true` only for `Confirmed` -- the honest "the reserve held on-chain" check. Nothing else reads as
    /// success (design SS3 principle 3).
    #[must_use]
    pub const fn is_confirmed(&self) -> bool {
        matches!(self, GasFloorVerdict::Confirmed)
    }

    // The minting surface -- `pub(crate)` ONLY (the gas-floor-verdict monopoly, design SS3 principle 2).
    pub(crate) const fn confirmed() -> GasFloorVerdict {
        GasFloorVerdict::Confirmed
    }
    pub(crate) const fn refuted() -> GasFloorVerdict {
        GasFloorVerdict::Refuted
    }
    pub(crate) const fn unverified() -> GasFloorVerdict {
        GasFloorVerdict::Unverified
    }
}

impl fmt::Display for GasFloorVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The agent's recorded CLAIM about one gas-floor-gated action -- the **Claim** half of two-source truth
/// (design SS3 principle 1). Never trusted on its own; adjudicated against the verifier's own post-action
/// `eth_getBalance` read of the agent.
///
/// All amounts are exact `i128` minor units (wei -- design SS3 principle 5).
///
/// - `agent` -- the address whose native reserve the floor protects (the read target).
/// - `min_gas_reserve` -- the configured native reserve the gate promised to keep (the floor the
///   post-action balance must stay at or above). The agent's word about how the gate was configured;
///   confirmed against the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GasFloorClaim {
    /// The agent address whose post-action native balance is checked (the read target).
    agent: String,
    /// The configured native reserve (wei) the post-action balance must hold at or above.
    min_gas_reserve: i128,
}

impl GasFloorClaim {
    /// Build a gas-floor claim from the agent + the configured reserve (a public config of the gate).
    #[must_use]
    pub fn new(agent: impl Into<String>, min_gas_reserve: i128) -> GasFloorClaim {
        GasFloorClaim { agent: agent.into(), min_gas_reserve }
    }

    /// The agent address this claim is about.
    #[must_use]
    pub fn agent(&self) -> &str {
        &self.agent
    }

    /// The configured native reserve (wei) the post-action balance must hold at or above.
    #[must_use]
    pub const fn min_gas_reserve(&self) -> i128 {
        self.min_gas_reserve
    }
}

/// The verifier's INDEPENDENT observation of the agent's native balance AFTER the action -- the
/// **Observation** (design SS3 principle 1). The verifier's own `eth_getBalance` read, never the agent's
/// word.
///
/// `post_balance` is the native balance (wei) read after the action settled. Exact `i128` (design SS3 #5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GasFloorObservation {
    /// The independently-read native balance (wei) of the agent AFTER the action.
    post_balance: i128,
}

impl GasFloorObservation {
    /// Record an observed post-action native balance (wei).
    #[must_use]
    pub const fn new(post_balance: i128) -> GasFloorObservation {
        GasFloorObservation { post_balance }
    }

    /// The observed post-action native balance (wei).
    #[must_use]
    pub const fn post_balance(&self) -> i128 {
        self.post_balance
    }
}

/// The result of confirming one gas-floor-gated action: the claim's reserve, the independent observation
/// (or `None` if unreadable), and the minted [`GasFloorVerdict`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GasFloorReport {
    /// The agent this report is about.
    pub agent: String,
    /// The configured native reserve (wei) the post-action balance had to hold at or above (the Claim).
    pub min_gas_reserve: i128,
    /// The independently-observed post-action native balance, or `None` when it could not be read (the
    /// loud absence that adjudicates to [`GasFloorVerdict::Unverified`]).
    pub observed: Option<GasFloorObservation>,
    /// The minted gas-floor verdict -- the only place a gas-floor verdict is created (the monopoly).
    pub verdict: GasFloorVerdict,
}

impl GasFloorReport {
    /// The canonical gas-floor-verdict string (`confirmed` / `refuted` / `unverified`).
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate one gas-floor-gated action: does the independent post-action balance read PROVE the native
/// reserve held -- i.e. the agent kept at least `min_gas_reserve` after the action?
///
/// The gas-floor-confirmation algebra (design SS3 principle 1, two-source truth; SS3a), evaluated strictly
/// in order:
///
/// 1. `observed == None`                          -> [`GasFloorVerdict::Unverified`]  (the keystone --
///    never fabricate; an unreadable post-action balance can never become a fabricated `Confirmed`).
/// 2. `post_balance >= min_gas_reserve`           -> [`GasFloorVerdict::Confirmed`]  (the reserve HELD --
///    the agent kept enough native gas to pay for its own next transaction).
/// 3. else (`post_balance < min_gas_reserve`)     -> [`GasFloorVerdict::Refuted`]  (the reserve was
///    BREACHED -- a depletion the PRE-broadcast gate should have blocked; the verifier proves it did not
///    happen, never assumes it).
///
/// The verdict is minted HERE -- inside the crate -- preserving the gas-floor-verdict monopoly (design
/// SS3 principle 2). Note the layering: an unreadable balance is `Unverified` (step 1) BEFORE the reserve
/// check, so a missing read can NEVER read as confirmed; only a read that proves `>=` confirms.
#[must_use]
pub fn adjudicate_gas_floor(
    claim: &GasFloorClaim,
    observed: Option<GasFloorObservation>,
) -> GasFloorReport {
    let verdict = adjudicate_gas_floor_verdict(claim, observed.as_ref());
    GasFloorReport {
        agent: claim.agent().to_string(),
        min_gas_reserve: claim.min_gas_reserve(),
        observed,
        verdict,
    }
}

/// The pure verdict core of [`adjudicate_gas_floor`] (the algebra, split out for direct testing).
#[must_use]
fn adjudicate_gas_floor_verdict(
    claim: &GasFloorClaim,
    observed: Option<&GasFloorObservation>,
) -> GasFloorVerdict {
    // (1) Keystone (design SS3 principle 3): no read -> Unverified, never a fabricated Confirmed.
    let Some(obs) = observed else {
        return GasFloorVerdict::unverified();
    };
    // (2) The reserve HELD: the post-action balance is at or above the configured floor -> Confirmed.
    if obs.post_balance() >= claim.min_gas_reserve() {
        GasFloorVerdict::confirmed()
    } else {
        // (3) The reserve was BREACHED -> Refuted (a depletion the gate should have blocked). Loud.
        GasFloorVerdict::refuted()
    }
}

// =================================================================================================
// The gas-floor read seam -- the independent Observation source (mirrors the mandate gate source).
// =================================================================================================

/// The key for a gas-floor read: which agent's post-action native balance to read.
///
/// A distinct newtype so the read seam is type-checked + the tape is deterministically ordered. Two reads
/// of the same agent yield the same key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GasFloorKey {
    /// Lowercased agent address.
    agent: String,
}

impl GasFloorKey {
    /// Build a gas-floor key from the agent address (lowercased for a canonical key).
    #[must_use]
    pub fn new(agent: impl AsRef<str>) -> GasFloorKey {
        GasFloorKey { agent: agent.as_ref().trim().to_ascii_lowercase() }
    }

    /// The lowercased agent address.
    #[must_use]
    pub fn agent(&self) -> &str {
        &self.agent
    }
}

/// The independent gas-floor-read seam -- the Observation source for a post-action native balance.
///
/// `read_balance` returns `Some(observation)` when the chain answered the `eth_getBalance`, or `None` when
/// it could not (off-tape / unreadable / not wired) -- never a fabricated observation (design SS3
/// principle 3). A taped replay and a live `eth_getBalance` reader both satisfy it, so swapping one for
/// the other never changes what a gas-floor verdict MEANS.
pub trait GasFloorSource {
    /// Read the agent's post-action native balance for `key`. `None` is the loud honest absence.
    fn read_balance(&mut self, key: &GasFloorKey) -> Option<GasFloorObservation>;
}

/// A deterministic, std-only replay of recorded post-action balance reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`GasFloorKey`] to a
/// recorded [`GasFloorObservation`]. A keyed read replays its exact recording; an unrecorded key is `None`
/// (we have no recording, so we refuse to invent one). The tape IS the recorded post-action balance, frozen.
#[derive(Debug, Clone, Default)]
pub struct GasFloorTape {
    tape: BTreeMap<GasFloorKey, GasFloorObservation>,
}

impl GasFloorTape {
    /// An empty tape -- every gas-floor read is `None` (unverified).
    #[must_use]
    pub fn new() -> GasFloorTape {
        GasFloorTape { tape: BTreeMap::new() }
    }

    /// Record a post-action balance observation for a key, returning the tape for chaining.
    #[must_use]
    pub fn with(mut self, key: GasFloorKey, obs: GasFloorObservation) -> GasFloorTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a post-action balance observation for a key in place.
    pub fn record(&mut self, key: GasFloorKey, obs: GasFloorObservation) {
        self.tape.insert(key, obs);
    }

    /// How many balance reads are recorded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff no balance reads are recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl GasFloorSource for GasFloorTape {
    fn read_balance(&mut self, key: &GasFloorKey) -> Option<GasFloorObservation> {
        self.tape.get(key).copied()
    }
}

/// Confirm one gas-floor-gated action end-to-end: build the key, read the post-action balance from
/// `source`, adjudicate.
///
/// The gas-floor analogue of [`crate::mandate::confirm_tier_via`] / [`crate::timelock::confirm_timelock_via`]:
/// the claim's configured reserve is the Claim, the post-action balance read is the Observation, and
/// [`adjudicate_gas_floor`] mints the verdict. An unreadable balance degrades to
/// [`GasFloorVerdict::Unverified`] -- never a fabricated `Confirmed`.
#[must_use]
pub fn confirm_gas_floor_via(
    claim: &GasFloorClaim,
    source: &mut dyn GasFloorSource,
) -> GasFloorReport {
    let key = GasFloorKey::new(claim.agent());
    let observed = source.read_balance(&key);
    adjudicate_gas_floor(claim, observed)
}

/// Render a [`GasFloorReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for GasFloorReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let post = match &self.observed {
            Some(o) => o.post_balance().to_string(),
            None => "<unreadable>".to_string(),
        };
        write!(
            f,
            "GAS-FLOOR agent={} min_gas_reserve={} post_balance={} -> {}",
            self.agent,
            self.min_gas_reserve,
            post,
            self.verdict_string(),
        )
    }
}

// =================================================================================================
// LiveGasFloorSource -- the real eth_getBalance reader. Behind the `live` cargo feature ONLY (SS6).
// =================================================================================================

/// A live `eth_getBalance` reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`GasFloorTape`]: it POSTs an `eth_getBalance(agent, "latest")` to the
/// 0G RPC endpoint and decodes the hex quantity into a [`GasFloorObservation`]. Every transport / decode
/// failure is a loud `None` (design SS3 principle 3) -- never a fabricated observation. The endpoint is
/// supplied by the caller (from `OG_RPC`), never hardcoded.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveGasFloorSource {
    endpoint: String,
}

#[cfg(feature = "live")]
impl LiveGasFloorSource {
    /// Build a live gas-floor reader against an RPC endpoint.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> LiveGasFloorSource {
        LiveGasFloorSource { endpoint: endpoint.into() }
    }

    /// The configured RPC endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Decode an `eth_getBalance` hex quantity (`0x...`) into an exact `i128` wei. `None` for a malformed
    /// or out-of-range reply (never coerced to a fabricated balance).
    fn decode_balance(raw: &str) -> Option<i128> {
        let hex = raw.trim();
        let body = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X"))?;
        if body.is_empty() || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        // A 0G native balance comfortably fits i128; reject an absurd width rather than wrap.
        i128::from_str_radix(body, 16).ok()
    }

    /// POST one `eth_getBalance` and return the agent's balance as `i128` wei, or `None` on any
    /// transport/RPC/decode failure.
    fn eth_get_balance(&self, agent: &str) -> Option<i128> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getBalance",
            "params": [agent, "latest"],
        });
        let response = ureq::post(&self.endpoint)
            .set("content-type", "application/json")
            .send_json(body)
            .ok()?;
        let value: serde_json::Value = response.into_json().ok()?;
        if value.get("error").is_some() {
            return None;
        }
        let raw = value.get("result")?.as_str()?;
        Self::decode_balance(raw)
    }
}

#[cfg(feature = "live")]
impl GasFloorSource for LiveGasFloorSource {
    fn read_balance(&mut self, key: &GasFloorKey) -> Option<GasFloorObservation> {
        let balance = self.eth_get_balance(key.agent())?;
        Some(GasFloorObservation::new(balance))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
    const RESERVE: i128 = 1_000_000;

    fn claim() -> GasFloorClaim {
        GasFloorClaim::new(AGENT, RESERVE)
    }

    // --- the three verdicts (the alphabet) -------------------------------------------------------

    #[test]
    fn confirmed_when_post_balance_is_above_the_reserve() {
        // The action ran and the agent kept 3_000_000 > the 1_000_000 reserve -> the floor HELD.
        let r = adjudicate_gas_floor(&claim(), Some(GasFloorObservation::new(3_000_000)));
        assert_eq!(r.verdict, GasFloorVerdict::Confirmed);
        assert_eq!(r.verdict_string(), "confirmed");
    }

    #[test]
    fn confirmed_exactly_at_the_reserve_boundary() {
        // post == reserve is confirmed (the floor is a >= bound, not >).
        let r = adjudicate_gas_floor(&claim(), Some(GasFloorObservation::new(RESERVE)));
        assert_eq!(r.verdict, GasFloorVerdict::Confirmed, "post == reserve holds the floor");
    }

    #[test]
    fn refuted_when_post_balance_fell_below_the_reserve_a_depletion() {
        // The post-action balance fell to 900_000 < the 1_000_000 reserve -- a depletion the gate should
        // have blocked. The verifier proves it did NOT hold -> Refuted (never a fabricated Confirmed).
        let r = adjudicate_gas_floor(&claim(), Some(GasFloorObservation::new(900_000)));
        assert_eq!(r.verdict, GasFloorVerdict::Refuted, "a breached reserve is a loud refuted");
        assert_ne!(r.verdict, GasFloorVerdict::Confirmed, "a depleted wallet must NEVER confirm");
    }

    #[test]
    fn refuted_when_the_wallet_was_drained_to_zero_the_headline_depletion() {
        // The headline risk: the agent spent its native gas to ~0 -> stuck. post 0 < reserve -> Refuted.
        let r = adjudicate_gas_floor(&claim(), Some(GasFloorObservation::new(0)));
        assert_eq!(r.verdict, GasFloorVerdict::Refuted);
    }

    #[test]
    fn unverified_when_no_read_at_all_never_confirmed() {
        // THE KEYSTONE (design SS3 principle 3): no read -> Unverified, never a fabricated confirmed.
        let r = adjudicate_gas_floor(&claim(), None);
        assert_eq!(r.verdict, GasFloorVerdict::Unverified);
        assert_ne!(r.verdict, GasFloorVerdict::Confirmed);
        assert!(r.observed.is_none());
    }

    // --- exact-integer over an 18-decimal native balance (design SS3 principle 5) ----------------

    #[test]
    fn exact_integer_over_an_18_decimal_native_balance() {
        // A reserve + balance in 18-decimal wei need exact i128 (they exceed i64). reserve 10e18 (10 0G)
        // is > i64::MAX (~9.22e18); post 15e18 -> confirmed; post 5e18 (< the floor) -> refuted.
        let big_claim = GasFloorClaim::new(AGENT, 10_000_000_000_000_000_000);
        assert!(big_claim.min_gas_reserve() > i64::MAX as i128, "the figures exceed i64 range");
        let hi = adjudicate_gas_floor(&big_claim, Some(GasFloorObservation::new(15_000_000_000_000_000_000)));
        assert_eq!(hi.verdict, GasFloorVerdict::Confirmed);
        let lo = adjudicate_gas_floor(&big_claim, Some(GasFloorObservation::new(5_000_000_000_000_000_000)));
        assert_eq!(lo.verdict, GasFloorVerdict::Refuted);
    }

    #[test]
    fn adjudicate_gas_floor_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let c = claim();
        for _ in 0..8 {
            assert_eq!(
                adjudicate_gas_floor(&c, Some(GasFloorObservation::new(3_000_000))).verdict,
                GasFloorVerdict::Confirmed
            );
            assert_eq!(
                adjudicate_gas_floor(&c, Some(GasFloorObservation::new(900_000))).verdict,
                GasFloorVerdict::Refuted
            );
            assert_eq!(adjudicate_gas_floor(&c, None).verdict, GasFloorVerdict::Unverified);
        }
    }

    // --- the gas-floor tape (offline, deterministic) ---------------------------------------------

    #[test]
    fn tape_hit_confirms_and_off_tape_is_unverified() {
        let c = claim();
        let key = GasFloorKey::new(c.agent());
        let mut tape = GasFloorTape::new().with(key, GasFloorObservation::new(3_000_000));

        let report = confirm_gas_floor_via(&c, &mut tape);
        assert_eq!(report.verdict, GasFloorVerdict::Confirmed);

        // A different agent is off-tape -> Unverified (never fabricated).
        let other = GasFloorClaim::new("0x0000000000000000000000000000000000000abc", RESERVE);
        let off = confirm_gas_floor_via(&other, &mut tape);
        assert_eq!(off.verdict, GasFloorVerdict::Unverified);
    }

    #[test]
    fn tape_breach_is_refuted_through_the_seam() {
        let c = claim();
        let key = GasFloorKey::new(c.agent());
        // The recorded post-action balance fell below the reserve -- a depletion caught through the seam.
        let mut tape = GasFloorTape::new().with(key, GasFloorObservation::new(1));
        let report = confirm_gas_floor_via(&c, &mut tape);
        assert_eq!(report.verdict, GasFloorVerdict::Refuted, "a depletion is caught through the read seam");
    }

    #[test]
    fn gas_floor_key_is_canonical_over_case_and_whitespace() {
        // The key lowercases + trims, so a differently-cased agent hits the same recorded slot.
        let key = GasFloorKey::new(AGENT);
        let mut tape = GasFloorTape::new().with(key, GasFloorObservation::new(3_000_000));
        let upper = GasFloorClaim::new(format!("  {}  ", AGENT.to_ascii_uppercase()), RESERVE);
        assert_eq!(confirm_gas_floor_via(&upper, &mut tape).verdict, GasFloorVerdict::Confirmed);
    }

    #[test]
    fn empty_tape_makes_every_floor_unverified() {
        let mut tape = GasFloorTape::new();
        assert!(tape.is_empty());
        assert_eq!(confirm_gas_floor_via(&claim(), &mut tape).verdict, GasFloorVerdict::Unverified);
    }

    #[test]
    fn canonical_strings_are_exact_and_distinct() {
        assert_eq!(GasFloorVerdict::confirmed().canonical_string(), "confirmed");
        assert_eq!(GasFloorVerdict::refuted().canonical_string(), "refuted");
        assert_eq!(GasFloorVerdict::unverified().canonical_string(), "unverified");
        assert!(GasFloorVerdict::confirmed().is_confirmed());
        assert!(!GasFloorVerdict::refuted().is_confirmed());
        assert!(!GasFloorVerdict::unverified().is_confirmed());
    }

    #[test]
    fn display_is_stable_and_carries_the_verdict() {
        let r = adjudicate_gas_floor(&claim(), Some(GasFloorObservation::new(3_000_000)));
        let line = r.to_string();
        assert!(line.contains("GAS-FLOOR"));
        assert!(line.contains("min_gas_reserve=1000000"));
        assert!(line.ends_with("-> confirmed"));
    }

    // --- the live decoder (feature-gated): the hex codec is exact + never fabricates -------------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_round_trips_a_hex_balance() {
        // 0x0f4240 == 1_000_000 wei.
        assert_eq!(LiveGasFloorSource::decode_balance("0x0f4240"), Some(1_000_000));
        // An 18-decimal balance (1 0G = 1e18 wei) decodes exactly to i128.
        assert_eq!(
            LiveGasFloorSource::decode_balance("0x0de0b6b3a7640000"),
            Some(1_000_000_000_000_000_000)
        );
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_rejects_malformed_never_fabricates() {
        assert!(LiveGasFloorSource::decode_balance("0x").is_none(), "empty body is malformed");
        assert!(LiveGasFloorSource::decode_balance("0xzz").is_none(), "non-hex is malformed");
        assert!(LiveGasFloorSource::decode_balance("1234").is_none(), "missing 0x prefix is malformed");
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoint_is_unverified_never_confirmed() {
        // The live reader is wired but pointed at an unreachable endpoint: the read fails, so the floor
        // degrades LOUDLY to Unverified (design SS3 principle 3), never a fabricated Confirmed.
        let mut src = LiveGasFloorSource::new("http://127.0.0.1:0");
        let report = confirm_gas_floor_via(&claim(), &mut src);
        assert_eq!(report.verdict, GasFloorVerdict::Unverified);
        assert_ne!(report.verdict, GasFloorVerdict::Confirmed);
    }
}
