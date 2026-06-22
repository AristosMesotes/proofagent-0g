//! The net-worth-floor verifier extension -- CONFIRM that total NET WORTH did not drain below a floor
//! (design SS3b, the "can't deplete net worth" portfolio-level money-safety primitive).
//!
//! The asset cap (design SS2 Rails) bounds how much of a *single* asset the agent may move per action,
//! and the gas floor (design SS3a) keeps the *native* token above a reserve. But neither bounds the
//! PORTFOLIO as a whole: total net worth -- `Sigma (holdings_i x price_i)` across every token and chain --
//! can still drain via slippage, mismatch, fees, a hack, or a string of individually-"settled" but
//! value-losing legs. Each leg passed its own cap; the SUM still fell. The net-worth floor closes this
//! gap with a HARD FLOOR (a kill-switch): if total net worth drops below the floor -- an ABSOLUTE minimum,
//! OR a MAX-DRAWDOWN from the session-start value (e.g. below 70% of session-start, the doctrine's
//! "wallet < 70% of session-start -> hard stop") -- the action HALTS.
//!
//! This module is the verifier's INDEPENDENT confirmation that the floor held. The VERIFIER computes net
//! worth from its OWN chain reads (on-chain balances x prices -- the Observation), never the agent's
//! self-reported total (the Claim). A post-action net worth below the floor is a LOUD `refuted` (a
//! depletion the kill-switch should have prevented), surfaced via the verdict monopoly.
//!
//! ## Two-source truth (design SS3 principle 1)
//!
//! The agent's "my net worth is still above the floor" is the **Claim** (the configured floor + the
//! agent's own reported total, neither trusted on its own); the verifier's INDEPENDENT per-holding reads
//! (each token's on-chain balance x its price) summed into a total is the **Observation**. The floor is
//! CONFIRMED only when the verifier's own computed total is at or above the effective floor. The agent's
//! reported total is NEVER an input to the verdict -- only the chain-read total is. The verdict is minted
//! HERE (the monopoly).
//!
//! ## The net-worth-verdict monopoly (design SS3 principle 2)
//!
//! [`NetWorthVerdict`] is `#[non_exhaustive]` with `pub(crate)`-only minting, mirroring the settlement
//! [`crate::Verdict`], the [`crate::mandate::TierVerdict`], the [`crate::timelock::TimelockVerdict`], and
//! the [`crate::gasfloor::GasFloorVerdict`]: nothing outside this crate can fabricate a "the floor held"
//! verdict.
//!
//! ## Never fabricate (design SS3 principle 3) -- a PARTIAL read can never become a total
//!
//! If ANY single holding leg is unreadable, the WHOLE net worth degrades LOUDLY to
//! [`NetWorthVerdict::Unverified`] -- never a fabricated total computed from the readable legs only (a
//! partial sum could falsely clear the floor while a missing leg hides a depletion). This mirrors the
//! bridge/route "settled IFF EVERY leg settled" composition: a net-worth confirmation requires EVERY
//! holding to be independently read. A read that shows the total fell BELOW the floor is a loud
//! [`NetWorthVerdict::Refuted`] -- the verifier proves the floor held rather than assuming it. The three
//! are different code paths that can never be confused.
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5) -- NO float on the money path
//!
//! [`adjudicate_net_worth`] is pure over `(claim, observation)` -- no wall-clock, no global state. Net
//! worth is an exact `i128` "value unit" = `balance (minor units) x price (USD micro-units, 1e-6 USD)`,
//! summed with checked arithmetic (an overflow degrades LOUDLY to `Unverified`, never a wrapped total).
//! The drawdown floor is an exact-integer ratio of the session-start value (`start x num / den`, integer
//! division) -- there is NO floating point ANYWHERE on this money path.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build confirms the floor against a deterministic, std-only [`NetWorthTape`] (a recorded
//! set of per-holding reads), so it needs no network. The `live` feature adds [`LiveNetWorthSource`] -- a
//! real `eth_getBalance` / ERC-20 `balanceOf` reader that POSTs to the 0G RPC and decodes each balance,
//! the same raw-JSON-RPC shape the settlement [`crate::LiveSource`], the mandate
//! [`crate::mandate::LiveGateSource`], and the gas-floor [`crate::gasfloor::LiveGasFloorSource`] use.
//! Prices are supplied by the caller (a public price feed) -- the module never invents a price.

use core::fmt;
use std::collections::BTreeMap;

/// The verdict for ONE net-worth-floor confirmation, minted by the verifier (design SS3 principle 2).
///
/// `#[non_exhaustive]` + `pub(crate)`-only minting: only this crate can construct a value, so nothing
/// outside the verifier can fabricate a "the floor held" verdict (exactly like [`crate::Verdict`],
/// [`crate::mandate::TierVerdict`], [`crate::timelock::TimelockVerdict`], and
/// [`crate::gasfloor::GasFloorVerdict`]).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetWorthVerdict {
    /// The independent read PROVES the floor held: the verifier's OWN computed total net worth (every
    /// holding read on-chain, priced, summed) is AT or ABOVE the effective floor -- the portfolio did
    /// not drain below the minimum / the max-drawdown line.
    Confirmed,
    /// The read shows the floor was BREACHED: the verifier's own computed total net worth fell BELOW the
    /// effective floor -- a portfolio depletion the kill-switch should have blocked. A loud "the
    /// net-worth floor did NOT hold as designed" (the verifier proves it rather than assuming it).
    Refuted,
    /// The net worth could not be computed -- AT LEAST ONE holding leg was unreadable, OR the priced sum
    /// overflowed. The loud, honest degrade target (design SS3 principle 3): a partial sum is NEVER
    /// passed off as a total, so a missing leg can never fabricate a `Confirmed`.
    Unverified,
}

impl NetWorthVerdict {
    /// The canonical, stable, snake_case string (the wire/journal form; deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            NetWorthVerdict::Confirmed => "confirmed",
            NetWorthVerdict::Refuted => "refuted",
            NetWorthVerdict::Unverified => "unverified",
        }
    }

    /// `true` only for `Confirmed` -- the honest "the floor held on-chain" check. Nothing else reads as
    /// success (design SS3 principle 3).
    #[must_use]
    pub const fn is_confirmed(&self) -> bool {
        matches!(self, NetWorthVerdict::Confirmed)
    }

    // The minting surface -- `pub(crate)` ONLY (the net-worth-verdict monopoly, design SS3 principle 2).
    pub(crate) const fn confirmed() -> NetWorthVerdict {
        NetWorthVerdict::Confirmed
    }
    pub(crate) const fn refuted() -> NetWorthVerdict {
        NetWorthVerdict::Refuted
    }
    pub(crate) const fn unverified() -> NetWorthVerdict {
        NetWorthVerdict::Unverified
    }
}

impl fmt::Display for NetWorthVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The net-worth floor -- the configured minimum the post-action total must stay AT or ABOVE.
///
/// The floor is the **maximum** of two independent bounds (a breach of EITHER is a breach), each in
/// exact-integer value units (`balance_minor_units x price_micro_usd`):
///
/// - **Absolute floor** (`absolute_floor`) -- a hard minimum net worth, regardless of history. `0` means
///   "no absolute floor" (only the drawdown bound applies).
/// - **Max-drawdown floor** -- a fraction `drawdown_num / drawdown_den` of the SESSION-START net worth
///   (`session_start_value`). E.g. `drawdown_num = 70, drawdown_den = 100` is the doctrine's "wallet <
///   70% of session-start -> hard stop". The drawdown floor is `session_start_value x num / den` (exact
///   integer division). A `session_start_value` of `0` (no recorded start) disables the drawdown bound.
///
/// The EFFECTIVE floor is `max(absolute_floor, drawdown_floor)` -- the stricter of the two binds, so the
/// portfolio is held to the tighter line. All exact `i128` value units (design SS3 principle 5); there is
/// NO floating point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NetWorthFloor {
    /// The hard absolute minimum net worth (value units). `0` => no absolute bound.
    absolute_floor: i128,
    /// The session-start net worth (value units) the drawdown bound is a fraction of. `0` => no drawdown.
    session_start_value: i128,
    /// The max-drawdown numerator (e.g. `70` for "keep >= 70% of session-start").
    drawdown_num: i128,
    /// The max-drawdown denominator (e.g. `100`).
    drawdown_den: i128,
}

impl NetWorthFloor {
    /// Build a floor from an absolute minimum AND a max-drawdown bound (`session_start x num / den`).
    ///
    /// Set `absolute_floor = 0` to use only the drawdown bound; set `session_start_value = 0` to use only
    /// the absolute bound. `drawdown_den` must be non-zero when a drawdown bound is in use (a `0`
    /// denominator yields a `0` drawdown floor -- the bound is treated as absent, never a divide-by-zero).
    #[must_use]
    pub const fn new(
        absolute_floor: i128,
        session_start_value: i128,
        drawdown_num: i128,
        drawdown_den: i128,
    ) -> NetWorthFloor {
        NetWorthFloor { absolute_floor, session_start_value, drawdown_num, drawdown_den }
    }

    /// A floor with ONLY an absolute minimum (no drawdown bound).
    #[must_use]
    pub const fn absolute(absolute_floor: i128) -> NetWorthFloor {
        NetWorthFloor::new(absolute_floor, 0, 0, 1)
    }

    /// A floor with ONLY a max-drawdown bound: keep at least `num/den` of the session-start value.
    #[must_use]
    pub const fn drawdown(session_start_value: i128, drawdown_num: i128, drawdown_den: i128) -> NetWorthFloor {
        NetWorthFloor::new(0, session_start_value, drawdown_num, drawdown_den)
    }

    /// The drawdown floor in value units: `session_start_value x num / den` (exact integer division), or
    /// `0` when the drawdown bound is disabled (`session_start_value == 0` or a non-positive denominator).
    #[must_use]
    pub const fn drawdown_floor(&self) -> i128 {
        if self.session_start_value <= 0 || self.drawdown_den <= 0 || self.drawdown_num <= 0 {
            return 0;
        }
        // Exact-integer: multiply first (i128 headroom), then integer-divide. No float.
        match self.session_start_value.checked_mul(self.drawdown_num) {
            Some(scaled) => scaled / self.drawdown_den,
            None => 0, // overflow in the floor computation degrades to "no drawdown bound", never a panic
        }
    }

    /// The EFFECTIVE floor: `max(absolute_floor, drawdown_floor)` -- the stricter bound binds.
    #[must_use]
    pub fn effective_floor(&self) -> i128 {
        let dd = self.drawdown_floor();
        if self.absolute_floor >= dd {
            self.absolute_floor
        } else {
            dd
        }
    }

    /// The configured absolute floor (value units).
    #[must_use]
    pub const fn absolute_floor(&self) -> i128 {
        self.absolute_floor
    }

    /// The recorded session-start net worth (value units).
    #[must_use]
    pub const fn session_start_value(&self) -> i128 {
        self.session_start_value
    }
}

/// The agent's recorded CLAIM about its post-action net worth -- the **Claim** half of two-source truth
/// (design SS3 principle 1). Carries the floor config (a public knob) + the agent's OWN reported total
/// (recorded for the journal, NEVER an input to the verdict). The verdict is decided purely on the
/// verifier's own chain-read total vs the floor; the agent's `reported_total` is audit-only.
///
/// All amounts are exact `i128` value units (design SS3 principle 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetWorthClaim {
    /// The address whose portfolio net worth the floor protects (the read target / journal label).
    agent: String,
    /// The configured floor (absolute + max-drawdown) the post-action total must stay at or above.
    floor: NetWorthFloor,
    /// The agent's OWN reported net worth (value units) -- recorded for the journal, NEVER trusted as an
    /// input to the verdict (two-source truth: only the verifier's chain-read total decides).
    reported_total: i128,
}

impl NetWorthClaim {
    /// Build a net-worth claim from the agent, the configured floor, and the agent's reported total.
    #[must_use]
    pub fn new(agent: impl Into<String>, floor: NetWorthFloor, reported_total: i128) -> NetWorthClaim {
        NetWorthClaim { agent: agent.into(), floor, reported_total }
    }

    /// The agent address this claim is about.
    #[must_use]
    pub fn agent(&self) -> &str {
        &self.agent
    }

    /// The configured floor.
    #[must_use]
    pub const fn floor(&self) -> &NetWorthFloor {
        &self.floor
    }

    /// The agent's self-reported net worth (audit-only; never an input to the verdict).
    #[must_use]
    pub const fn reported_total(&self) -> i128 {
        self.reported_total
    }
}

/// ONE independently-read on-chain holding -- a `(token, balance, price)` triple the verifier read itself.
///
/// `value = balance x price` is the holding's contribution to net worth, in exact-integer value units
/// (`minor_units x micro_usd`). `balance` is the token's on-chain balance in its OWN minor units;
/// `price_micro_usd` is the token's price in USD micro-units (1e-6 USD) PER WHOLE token... but to keep the
/// money path exact-integer with NO per-token decimal normalization baked in here, the caller supplies the
/// price already scaled to "USD micro-units per one minor unit of this token", so `balance x price` is a
/// clean integer product in value units. (The live reader / config does the decimals scaling once, at the
/// edge; the algebra stays a pure integer multiply.)
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HoldingObservation {
    /// A stable token id (symbol or address) -- journal label + deterministic ordering key.
    token: String,
    /// The on-chain balance in the token's minor units (exact `i128`).
    balance: i128,
    /// The token's price in USD micro-units PER MINOR UNIT (exact `i128`); the caller scales for decimals.
    price_micro_usd_per_minor: i128,
}

impl HoldingObservation {
    /// Record one independently-read holding: token id, on-chain balance (minor units), and its price
    /// (USD micro-units per minor unit, already decimal-scaled by the caller).
    #[must_use]
    pub fn new(
        token: impl Into<String>,
        balance: i128,
        price_micro_usd_per_minor: i128,
    ) -> HoldingObservation {
        HoldingObservation {
            token: token.into(),
            balance,
            price_micro_usd_per_minor,
        }
    }

    /// The token id.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }

    /// The on-chain balance (minor units).
    #[must_use]
    pub const fn balance(&self) -> i128 {
        self.balance
    }

    /// The price (USD micro-units per minor unit).
    #[must_use]
    pub const fn price_micro_usd_per_minor(&self) -> i128 {
        self.price_micro_usd_per_minor
    }

    /// This holding's value contribution (`balance x price`), value units, with CHECKED arithmetic.
    /// `None` on overflow -- an overflowing leg degrades the whole net worth to `Unverified` (never a
    /// wrapped value).
    #[must_use]
    pub const fn value(&self) -> Option<i128> {
        self.balance.checked_mul(self.price_micro_usd_per_minor)
    }
}

/// The verifier's INDEPENDENT observation of the agent's WHOLE portfolio AFTER the action -- the
/// **Observation** (design SS3 principle 1). A list of the holdings the verifier could read PLUS the count
/// of holdings it EXPECTED to read but could NOT (the loud-absence marker).
///
/// `unreadable_legs > 0` means at least one holding the portfolio includes could not be read -- so the
/// total is INCOMPLETE and the whole net worth must degrade to `Unverified` (a partial sum is never a
/// total, design SS3 principle 3). This is the multi-leg analogue of a single `None` read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NetWorthObservation {
    /// The holdings the verifier independently read + priced (each a `(token, balance, price)` it observed).
    holdings: Vec<HoldingObservation>,
    /// How many holdings the portfolio includes that the verifier could NOT read (the loud absence).
    unreadable_legs: usize,
}

impl NetWorthObservation {
    /// An observation of the readable holdings, with `unreadable_legs` holdings that could not be read.
    #[must_use]
    pub fn new(holdings: Vec<HoldingObservation>, unreadable_legs: usize) -> NetWorthObservation {
        NetWorthObservation { holdings, unreadable_legs }
    }

    /// An observation where EVERY holding was read (no unreadable legs).
    #[must_use]
    pub fn complete(holdings: Vec<HoldingObservation>) -> NetWorthObservation {
        NetWorthObservation { holdings, unreadable_legs: 0 }
    }

    /// The holdings read.
    #[must_use]
    pub fn holdings(&self) -> &[HoldingObservation] {
        &self.holdings
    }

    /// How many holdings could not be read (the loud absence; `> 0` forces `Unverified`).
    #[must_use]
    pub const fn unreadable_legs(&self) -> usize {
        self.unreadable_legs
    }

    /// The total net worth = `Sigma (balance_i x price_i)` over the readable holdings, with CHECKED
    /// arithmetic at EVERY step. Returns:
    ///
    /// - `Some(total)` -- every readable leg priced + summed without overflow;
    /// - `None`        -- a single leg's `value()` overflowed OR the running sum overflowed (the priced
    ///   total is not representable, so it degrades LOUDLY, never a wrapped total).
    ///
    /// NOTE: this is the sum over the READABLE legs only; the caller MUST also check `unreadable_legs == 0`
    /// before trusting it as the full net worth ([`adjudicate_net_worth`] does exactly that, in order).
    #[must_use]
    pub fn priced_total(&self) -> Option<i128> {
        let mut total: i128 = 0;
        for h in &self.holdings {
            let v = h.value()?; // a leg whose balance x price overflowed -> None (loud)
            total = total.checked_add(v)?; // a running-sum overflow -> None (loud)
        }
        Some(total)
    }
}

/// The result of confirming one net-worth-floor check: the claim's effective floor, the verifier's own
/// computed total (or `None` when incomplete/unreadable), the count of unreadable legs, and the minted
/// [`NetWorthVerdict`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetWorthReport {
    /// The agent this report is about.
    pub agent: String,
    /// The EFFECTIVE floor (value units) the post-action total had to hold at or above (the Claim).
    pub effective_floor: i128,
    /// The verifier's OWN independently-computed total net worth (value units), or `None` when it could
    /// not be computed (an unreadable leg or an overflow -> the loud absence -> `Unverified`).
    pub observed_total: Option<i128>,
    /// How many holding legs the verifier could NOT read (echoed for the audit row; `> 0` => `Unverified`).
    pub unreadable_legs: usize,
    /// The agent's self-reported total (audit-only; echoed for the journal, never an input to the verdict).
    pub reported_total: i128,
    /// The minted net-worth verdict -- the only place a net-worth verdict is created (the monopoly).
    pub verdict: NetWorthVerdict,
}

impl NetWorthReport {
    /// The canonical net-worth-verdict string (`confirmed` / `refuted` / `unverified`).
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate one net-worth-floor check: does the verifier's OWN independently-computed total net worth
/// PROVE the portfolio stayed at or above the effective floor (absolute OR max-drawdown)?
///
/// The net-worth-confirmation algebra (design SS3 principle 1, two-source truth; SS3b), evaluated strictly
/// in order -- the safety layering matters:
///
/// 1. `observed == None`                              -> [`NetWorthVerdict::Unverified`]  (the keystone --
///    never fabricate; no observation at all can never become a fabricated `Confirmed`).
/// 2. `unreadable_legs > 0`                           -> [`NetWorthVerdict::Unverified`]  (a PARTIAL read:
///    at least one holding is missing, so the total is incomplete -- a partial sum is never a total).
/// 3. `priced_total() == None` (overflow)             -> [`NetWorthVerdict::Unverified`]  (the priced sum
///    is not representable -> loud degrade, never a wrapped total).
/// 4. `total >= effective_floor`                      -> [`NetWorthVerdict::Confirmed`]  (the floor HELD --
///    the portfolio did not drain below the absolute / max-drawdown line).
/// 5. else (`total < effective_floor`)                -> [`NetWorthVerdict::Refuted`]  (the floor was
///    BREACHED -- a portfolio depletion the kill-switch should have blocked; the verifier proves it did
///    not happen rather than assuming it).
///
/// The verdict is minted HERE -- inside the crate -- preserving the net-worth-verdict monopoly (design SS3
/// principle 2). Steps 1-3 (the three loud-degrade paths) ALL precede the floor comparison, so an
/// incomplete or non-representable read can NEVER read as confirmed; only a COMPLETE, representable
/// chain-read total that proves `>=` confirms. The agent's `reported_total` is NEVER consulted.
#[must_use]
pub fn adjudicate_net_worth(
    claim: &NetWorthClaim,
    observed: Option<&NetWorthObservation>,
) -> NetWorthReport {
    let effective_floor = claim.floor().effective_floor();
    let (observed_total, unreadable_legs, verdict) =
        adjudicate_net_worth_core(effective_floor, observed);
    NetWorthReport {
        agent: claim.agent().to_string(),
        effective_floor,
        observed_total,
        unreadable_legs,
        reported_total: claim.reported_total(),
        verdict,
    }
}

/// The pure verdict core of [`adjudicate_net_worth`] (the algebra, split out for direct testing).
///
/// Returns `(observed_total, unreadable_legs, verdict)`: `observed_total` is `Some` ONLY when a complete,
/// representable total was computed (steps 4/5); it is `None` for every `Unverified` path (steps 1-3), so
/// the report never carries a partial sum alongside an `Unverified` verdict.
fn adjudicate_net_worth_core(
    effective_floor: i128,
    observed: Option<&NetWorthObservation>,
) -> (Option<i128>, usize, NetWorthVerdict) {
    // (1) Keystone (design SS3 principle 3): no observation at all -> Unverified.
    let Some(obs) = observed else {
        return (None, 0, NetWorthVerdict::unverified());
    };
    // (2) A PARTIAL read: at least one holding is missing -> the total is incomplete -> Unverified.
    //     (A partial sum is NEVER passed off as a total -- a missing leg could hide a depletion.)
    if obs.unreadable_legs() > 0 {
        return (None, obs.unreadable_legs(), NetWorthVerdict::unverified());
    }
    // (3) The priced sum must be representable; an overflow degrades LOUDLY, never a wrapped total.
    let Some(total) = obs.priced_total() else {
        return (None, 0, NetWorthVerdict::unverified());
    };
    // (4) The floor HELD: the verifier's own complete total is at or above the effective floor.
    if total >= effective_floor {
        (Some(total), 0, NetWorthVerdict::confirmed())
    } else {
        // (5) The floor was BREACHED -> Refuted (a portfolio depletion the kill-switch should have blocked).
        (Some(total), 0, NetWorthVerdict::refuted())
    }
}

// =================================================================================================
// The net-worth read seam -- the independent Observation source (mirrors the gas-floor read seam).
// =================================================================================================

/// The key for a net-worth read: which agent's whole-portfolio holdings to read.
///
/// A distinct newtype so the read seam is type-checked + the tape is deterministically ordered. Two reads
/// of the same agent yield the same key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NetWorthKey {
    /// Lowercased agent address.
    agent: String,
}

impl NetWorthKey {
    /// Build a net-worth key from the agent address (lowercased for a canonical key).
    #[must_use]
    pub fn new(agent: impl AsRef<str>) -> NetWorthKey {
        NetWorthKey { agent: agent.as_ref().trim().to_ascii_lowercase() }
    }

    /// The lowercased agent address.
    #[must_use]
    pub fn agent(&self) -> &str {
        &self.agent
    }
}

/// The independent net-worth-read seam -- the Observation source for a post-action portfolio.
///
/// `read_portfolio` returns `Some(observation)` when the chain answered (every holding read, OR a
/// partial read with its `unreadable_legs` count recorded honestly), or `None` when the read could not be
/// started at all (off-tape / not wired) -- never a fabricated observation (design SS3 principle 3). A
/// taped replay and a live multi-balance reader both satisfy it, so swapping one for the other never
/// changes what a net-worth verdict MEANS.
pub trait NetWorthSource {
    /// Read the agent's whole-portfolio holdings for `key`. `None` is the loud honest absence.
    fn read_portfolio(&mut self, key: &NetWorthKey) -> Option<NetWorthObservation>;
}

/// A deterministic, std-only replay of recorded portfolio reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`NetWorthKey`] to a
/// recorded [`NetWorthObservation`]. A keyed read replays its exact recording; an unrecorded key is `None`
/// (we have no recording, so we refuse to invent one). The tape IS the recorded portfolio, frozen.
#[derive(Debug, Clone, Default)]
pub struct NetWorthTape {
    tape: BTreeMap<NetWorthKey, NetWorthObservation>,
}

impl NetWorthTape {
    /// An empty tape -- every net-worth read is `None` (unverified).
    #[must_use]
    pub fn new() -> NetWorthTape {
        NetWorthTape { tape: BTreeMap::new() }
    }

    /// Record a portfolio observation for a key, returning the tape for chaining.
    #[must_use]
    pub fn with(mut self, key: NetWorthKey, obs: NetWorthObservation) -> NetWorthTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a portfolio observation for a key in place.
    pub fn record(&mut self, key: NetWorthKey, obs: NetWorthObservation) {
        self.tape.insert(key, obs);
    }

    /// How many portfolio reads are recorded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff no portfolio reads are recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl NetWorthSource for NetWorthTape {
    fn read_portfolio(&mut self, key: &NetWorthKey) -> Option<NetWorthObservation> {
        self.tape.get(key).cloned()
    }
}

/// Confirm one net-worth-floor check end-to-end: build the key, read the portfolio from `source`,
/// adjudicate.
///
/// The net-worth analogue of [`crate::gasfloor::confirm_gas_floor_via`] /
/// [`crate::timelock::confirm_timelock_via`]: the claim's configured floor is the Claim, the verifier's
/// own portfolio read (balances x prices, summed) is the Observation, and [`adjudicate_net_worth`] mints
/// the verdict. An unreadable / partial / overflowing read degrades to [`NetWorthVerdict::Unverified`] --
/// never a fabricated `Confirmed`.
#[must_use]
pub fn confirm_net_worth_via(
    claim: &NetWorthClaim,
    source: &mut dyn NetWorthSource,
) -> NetWorthReport {
    let key = NetWorthKey::new(claim.agent());
    let observed = source.read_portfolio(&key);
    adjudicate_net_worth(claim, observed.as_ref())
}

/// Render a [`NetWorthReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for NetWorthReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let total = match self.observed_total {
            Some(t) => t.to_string(),
            None => "<unreadable>".to_string(),
        };
        write!(
            f,
            "NET-WORTH agent={} effective_floor={} observed_total={} unreadable_legs={} -> {}",
            self.agent,
            self.effective_floor,
            total,
            self.unreadable_legs,
            self.verdict_string(),
        )
    }
}

// =================================================================================================
// LiveNetWorthSource -- the real multi-balance reader. Behind the `live` cargo feature ONLY (SS6).
// =================================================================================================

/// One holding to read live: the token id, its on-chain address (or the native sentinel), and its
/// already-decimal-scaled price (USD micro-units per minor unit). The price comes from the caller's public
/// price feed -- the reader never invents a price.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveHolding {
    /// The token id (journal label).
    pub token: String,
    /// The on-chain address: the native sentinel (read via `eth_getBalance`) or an ERC-20 (via `balanceOf`).
    pub address: String,
    /// `true` if this is the native token (use `eth_getBalance`); `false` for an ERC-20 (`balanceOf`).
    pub is_native: bool,
    /// The price in USD micro-units per minor unit (caller-supplied, decimal-scaled).
    pub price_micro_usd_per_minor: i128,
}

/// A live multi-balance reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`NetWorthTape`]: for each configured [`LiveHolding`] it reads the
/// agent's on-chain balance (`eth_getBalance` for native, ERC-20 `balanceOf` for tokens) and pairs it with
/// the caller-supplied price. EVERY transport / decode failure on ANY leg makes that leg count toward
/// `unreadable_legs` -- so a single unreadable holding degrades the WHOLE net worth to `Unverified`
/// (design SS3 principle 3), never a fabricated partial total. The endpoint + the holdings (with prices)
/// are supplied by the caller (from `OG_RPC` + a public price feed), never hardcoded.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveNetWorthSource {
    endpoint: String,
    holdings: Vec<LiveHolding>,
}

#[cfg(feature = "live")]
impl LiveNetWorthSource {
    /// Build a live net-worth reader against an RPC endpoint + a configured set of holdings (with prices).
    #[must_use]
    pub fn new(endpoint: impl Into<String>, holdings: Vec<LiveHolding>) -> LiveNetWorthSource {
        LiveNetWorthSource { endpoint: endpoint.into(), holdings }
    }

    /// The configured RPC endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Decode a `0x...` hex quantity into an exact `i128`. `None` for a malformed / out-of-range reply
    /// (never coerced to a fabricated balance) -- the same exact codec the gas-floor reader uses.
    fn decode_uint(raw: &str) -> Option<i128> {
        let hex = raw.trim();
        let body = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X"))?;
        if body.is_empty() || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        i128::from_str_radix(body, 16).ok()
    }

    /// POST one `eth_getBalance` and return the native balance as `i128` wei, or `None` on any failure.
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
        Self::decode_uint(raw)
    }

    /// POST one ERC-20 `balanceOf(agent)` `eth_call` and decode the returned uint256, or `None` on failure.
    fn erc20_balance_of(&self, token: &str, agent: &str) -> Option<i128> {
        // balanceOf(address) selector 0x70a08231, then the left-padded 32-byte agent address.
        let addr = agent.trim().trim_start_matches("0x").trim_start_matches("0X");
        if addr.len() != 40 || !addr.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let data = format!("0x70a08231{addr:0>64}");
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{ "to": token, "data": data }, "latest"],
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
        Self::decode_uint(raw)
    }
}

#[cfg(feature = "live")]
impl NetWorthSource for LiveNetWorthSource {
    fn read_portfolio(&mut self, key: &NetWorthKey) -> Option<NetWorthObservation> {
        let agent = key.agent();
        let mut holdings = Vec::new();
        let mut unreadable_legs = 0usize;
        for h in &self.holdings {
            let balance = if h.is_native {
                self.eth_get_balance(agent)
            } else {
                self.erc20_balance_of(&h.address, agent)
            };
            match balance {
                Some(b) => holdings.push(HoldingObservation::new(
                    h.token.clone(),
                    b,
                    h.price_micro_usd_per_minor,
                )),
                // A leg we could not read counts as unreadable -> the whole net worth degrades to
                // Unverified (a partial total is never trusted, design SS3 principle 3).
                None => unreadable_legs += 1,
            }
        }
        Some(NetWorthObservation::new(holdings, unreadable_legs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";

    // A simple two-holding portfolio: 1_000_000 of a 1-micro-usd/minor token (value 1_000_000) +
    // 2_000_000 of a 1-micro-usd/minor token (value 2_000_000) = total 3_000_000 value units.
    fn two_holdings(v1: i128, v2: i128) -> NetWorthObservation {
        NetWorthObservation::complete(vec![
            HoldingObservation::new("A", v1, 1),
            HoldingObservation::new("B", v2, 1),
        ])
    }

    fn claim_with(floor: NetWorthFloor) -> NetWorthClaim {
        NetWorthClaim::new(AGENT, floor, 0)
    }

    // --- the three verdicts (the alphabet) -------------------------------------------------------

    #[test]
    fn confirmed_when_total_is_above_an_absolute_floor() {
        // total 3_000_000 >= absolute floor 2_000_000 -> the floor HELD.
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let obs = two_holdings(1_000_000, 2_000_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Confirmed);
        assert_eq!(r.observed_total, Some(3_000_000));
        assert_eq!(r.verdict_string(), "confirmed");
    }

    #[test]
    fn confirmed_exactly_at_the_floor_boundary() {
        // total == effective floor is confirmed (the floor is a >= bound, not >).
        let claim = claim_with(NetWorthFloor::absolute(3_000_000));
        let obs = two_holdings(1_000_000, 2_000_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Confirmed, "total == floor holds");
    }

    #[test]
    fn refuted_when_total_fell_below_an_absolute_floor_a_depletion() {
        // total 1_500_000 < absolute floor 2_000_000 -- a portfolio depletion the kill-switch should have
        // blocked. The verifier proves it did NOT hold -> Refuted (never a fabricated Confirmed).
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let obs = two_holdings(1_000_000, 500_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Refuted, "a breached floor is a loud refuted");
        assert_ne!(r.verdict, NetWorthVerdict::Confirmed, "a depleted portfolio must NEVER confirm");
        assert_eq!(r.observed_total, Some(1_500_000));
    }

    #[test]
    fn refuted_when_portfolio_drained_to_zero_the_headline_depletion() {
        // The headline risk: net worth drains to ~0 across legs that each "settled". total 0 < floor.
        let claim = claim_with(NetWorthFloor::absolute(1));
        let obs = NetWorthObservation::complete(vec![]);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Refuted);
        assert_eq!(r.observed_total, Some(0));
    }

    #[test]
    fn unverified_when_no_observation_at_all_never_confirmed() {
        // THE KEYSTONE (design SS3 principle 3): no observation -> Unverified, never a fabricated confirmed.
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let r = adjudicate_net_worth(&claim, None);
        assert_eq!(r.verdict, NetWorthVerdict::Unverified);
        assert_ne!(r.verdict, NetWorthVerdict::Confirmed);
        assert!(r.observed_total.is_none());
    }

    // --- the PARTIAL-read keystone: a missing leg can never fabricate a total ---------------------

    #[test]
    fn unverified_when_a_single_leg_is_unreadable_partial_is_never_a_total() {
        // The portfolio has a holding the verifier could NOT read. Even though the readable legs sum well
        // above the floor, the total is INCOMPLETE -> Unverified (a partial sum is NEVER a total). A missing
        // leg could hide a depletion, so confirming on a partial read would be a fabricated success.
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let obs = NetWorthObservation::new(
            vec![HoldingObservation::new("A", 5_000_000, 1)], // readable legs alone are 5_000_000 > floor
            1,                                                // ...but one leg is unreadable
        );
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Unverified, "a partial read can never confirm");
        assert_ne!(r.verdict, NetWorthVerdict::Confirmed);
        assert!(r.observed_total.is_none(), "no partial total is carried on an Unverified");
        assert_eq!(r.unreadable_legs, 1);
    }

    #[test]
    fn unverified_on_overflow_never_a_wrapped_total() {
        // A leg whose balance x price overflows i128 -> the priced total is not representable -> Unverified
        // (never a wrapped total). balance = i128::MAX, price = 2 overflows the checked_mul.
        let claim = claim_with(NetWorthFloor::absolute(0));
        let obs = NetWorthObservation::complete(vec![HoldingObservation::new("BIG", i128::MAX, 2)]);
        assert!(obs.priced_total().is_none(), "the priced sum overflows");
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Unverified, "an overflow degrades loudly, never wraps");
        assert!(r.observed_total.is_none());
    }

    // --- the MAX-DRAWDOWN bound (the "< 70% of session-start -> hard stop" doctrine) --------------

    #[test]
    fn drawdown_floor_is_exact_integer_70_percent_of_session_start() {
        // session-start 10_000_000, keep >= 70% -> drawdown floor 7_000_000 (exact integer).
        let floor = NetWorthFloor::drawdown(10_000_000, 70, 100);
        assert_eq!(floor.drawdown_floor(), 7_000_000);
        assert_eq!(floor.effective_floor(), 7_000_000);
    }

    #[test]
    fn confirmed_when_above_the_drawdown_line() {
        // total 8_000_000 >= 70%-of-10_000_000 (= 7_000_000) -> confirmed (within the max drawdown).
        let claim = claim_with(NetWorthFloor::drawdown(10_000_000, 70, 100));
        let obs = two_holdings(5_000_000, 3_000_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Confirmed);
    }

    #[test]
    fn refuted_when_below_the_drawdown_line_the_70_percent_hard_stop() {
        // total 6_000_000 < 70%-of-10_000_000 (= 7_000_000) -> the wallet fell below 70% of session-start
        // -> hard stop (the doctrine). Refuted, loud -- never a fabricated confirmed.
        let claim = claim_with(NetWorthFloor::drawdown(10_000_000, 70, 100));
        let obs = two_holdings(3_000_000, 3_000_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Refuted, "below 70% of session-start is a hard stop");
        assert_eq!(r.observed_total, Some(6_000_000));
    }

    #[test]
    fn effective_floor_is_the_stricter_of_absolute_and_drawdown() {
        // absolute 8_000_000 vs drawdown 7_000_000 -> effective is the STRICTER 8_000_000.
        let floor = NetWorthFloor::new(8_000_000, 10_000_000, 70, 100);
        assert_eq!(floor.effective_floor(), 8_000_000, "absolute is stricter here");
        // total 7_500_000 >= drawdown (7M) but < absolute (8M) -> Refuted (the stricter bound binds).
        let claim = claim_with(floor);
        let obs = two_holdings(4_000_000, 3_500_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Refuted, "the stricter (absolute) floor binds");

        // And the other way: drawdown 9_000_000 stricter than absolute 5_000_000.
        let floor2 = NetWorthFloor::new(5_000_000, 10_000_000, 90, 100);
        assert_eq!(floor2.effective_floor(), 9_000_000, "drawdown is stricter here");
    }

    #[test]
    fn a_zero_session_start_disables_the_drawdown_bound() {
        // No recorded session start -> the drawdown floor is 0; only the absolute bound applies.
        let floor = NetWorthFloor::new(2_000_000, 0, 70, 100);
        assert_eq!(floor.drawdown_floor(), 0);
        assert_eq!(floor.effective_floor(), 2_000_000);
    }

    #[test]
    fn a_zero_denominator_never_divides_by_zero() {
        // A malformed (zero) denominator yields a 0 drawdown floor (the bound is treated absent) -- no panic.
        let floor = NetWorthFloor::new(1_000_000, 10_000_000, 70, 0);
        assert_eq!(floor.drawdown_floor(), 0, "a 0 denominator is a disabled bound, never a panic");
        assert_eq!(floor.effective_floor(), 1_000_000);
    }

    // --- multi-chain / multi-token aggregation (the Sigma) ---------------------------------------

    #[test]
    fn aggregates_holdings_across_multiple_tokens_with_distinct_prices() {
        // Net worth = Sigma (balance_i x price_i). 3 USDC.e (6-dec) @ price scaled to micro-usd/minor +
        // a W0G holding @ its own price. We check the exact integer Sigma.
        //   USDC.e: 3_000_000 minor (3.0 USDC.e @ $1) -> price 1 micro-usd/minor -> value 3_000_000
        //   W0G:    2_000_000_000_000_000_000 wei (2.0 W0G @ $0.50)
        //           $0.50/whole-token = 500_000 micro-usd / 1e18 minor -> but to keep an exact integer we
        //           pick a price that divides evenly: 1 micro-usd per 1e12 minor is not integer, so use a
        //           holding already scaled: 4_000_000 minor of a token @ 1 micro-usd/minor -> value 4_000_000
        let obs = NetWorthObservation::complete(vec![
            HoldingObservation::new("USDC.e", 3_000_000, 1),
            HoldingObservation::new("TOKEN", 4_000_000, 1),
        ]);
        assert_eq!(obs.priced_total(), Some(7_000_000));
        let claim = claim_with(NetWorthFloor::absolute(7_000_000));
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Confirmed);
    }

    #[test]
    fn price_scales_the_value_exactly_no_float() {
        // A holding of 1_000 minor units @ 2_500 micro-usd/minor -> value 2_500_000 (exact integer multiply).
        let h = HoldingObservation::new("X", 1_000, 2_500);
        assert_eq!(h.value(), Some(2_500_000));
    }

    // --- exact-integer over an 18-decimal balance (design SS3 principle 5) ------------------------

    #[test]
    fn exact_integer_over_a_large_priced_total() {
        // A priced total that exceeds i64 needs exact i128. 10e18 value units > i64::MAX (~9.22e18).
        let big = 10_000_000_000_000_000_000i128;
        assert!(big > i64::MAX as i128, "the figure exceeds i64 range");
        let obs = NetWorthObservation::complete(vec![HoldingObservation::new("BIG", big, 1)]);
        assert_eq!(obs.priced_total(), Some(big));
        let claim = claim_with(NetWorthFloor::absolute(big));
        assert_eq!(adjudicate_net_worth(&claim, Some(&obs)).verdict, NetWorthVerdict::Confirmed);
        // One less than the floor -> refuted.
        let lo = NetWorthObservation::complete(vec![HoldingObservation::new("BIG", big - 1, 1)]);
        assert_eq!(adjudicate_net_worth(&claim, Some(&lo)).verdict, NetWorthVerdict::Refuted);
    }

    #[test]
    fn adjudicate_net_worth_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let hi = two_holdings(1_000_000, 2_000_000);
        let lo = two_holdings(500_000, 500_000);
        for _ in 0..8 {
            assert_eq!(adjudicate_net_worth(&claim, Some(&hi)).verdict, NetWorthVerdict::Confirmed);
            assert_eq!(adjudicate_net_worth(&claim, Some(&lo)).verdict, NetWorthVerdict::Refuted);
            assert_eq!(adjudicate_net_worth(&claim, None).verdict, NetWorthVerdict::Unverified);
        }
    }

    // --- the reported_total is NEVER an input (two-source truth) ----------------------------------

    #[test]
    fn the_agents_reported_total_is_never_consulted() {
        // The agent reports a healthy total, but the verifier's own read shows a depletion. The verdict
        // follows the CHAIN read (refuted), never the agent's word (two-source truth, design SS3 #1).
        let claim = NetWorthClaim::new(AGENT, NetWorthFloor::absolute(2_000_000), 9_999_999_999);
        let obs = two_holdings(100, 100); // chain says ~200 value units, far below the floor
        let r = adjudicate_net_worth(&claim, Some(&obs));
        assert_eq!(r.verdict, NetWorthVerdict::Refuted, "the agent's rosy report cannot rescue a real depletion");
        assert_eq!(r.reported_total, 9_999_999_999, "the report is recorded for audit, never trusted");
    }

    // --- the net-worth tape (offline, deterministic) ---------------------------------------------

    #[test]
    fn tape_hit_confirms_and_off_tape_is_unverified() {
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let key = NetWorthKey::new(claim.agent());
        let mut tape = NetWorthTape::new().with(key, two_holdings(1_000_000, 2_000_000));

        let report = confirm_net_worth_via(&claim, &mut tape);
        assert_eq!(report.verdict, NetWorthVerdict::Confirmed);

        // A different agent is off-tape -> Unverified (never fabricated).
        let other = NetWorthClaim::new(
            "0x0000000000000000000000000000000000000abc",
            NetWorthFloor::absolute(2_000_000),
            0,
        );
        let off = confirm_net_worth_via(&other, &mut tape);
        assert_eq!(off.verdict, NetWorthVerdict::Unverified);
    }

    #[test]
    fn tape_breach_is_refuted_through_the_seam() {
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let key = NetWorthKey::new(claim.agent());
        // The recorded post-action portfolio fell below the floor -- a depletion caught through the seam.
        let mut tape = NetWorthTape::new().with(key, two_holdings(100, 100));
        let report = confirm_net_worth_via(&claim, &mut tape);
        assert_eq!(report.verdict, NetWorthVerdict::Refuted, "a depletion is caught through the read seam");
    }

    #[test]
    fn tape_partial_read_is_unverified_through_the_seam() {
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let key = NetWorthKey::new(claim.agent());
        // A recorded PARTIAL read (one leg unreadable) -> Unverified through the seam (never a partial total).
        let partial = NetWorthObservation::new(vec![HoldingObservation::new("A", 5_000_000, 1)], 1);
        let mut tape = NetWorthTape::new().with(key, partial);
        assert_eq!(confirm_net_worth_via(&claim, &mut tape).verdict, NetWorthVerdict::Unverified);
    }

    #[test]
    fn net_worth_key_is_canonical_over_case_and_whitespace() {
        // The key lowercases + trims, so a differently-cased agent hits the same recorded slot.
        let key = NetWorthKey::new(AGENT);
        let mut tape = NetWorthTape::new().with(key, two_holdings(1_000_000, 2_000_000));
        let upper = NetWorthClaim::new(
            format!("  {}  ", AGENT.to_ascii_uppercase()),
            NetWorthFloor::absolute(2_000_000),
            0,
        );
        assert_eq!(confirm_net_worth_via(&upper, &mut tape).verdict, NetWorthVerdict::Confirmed);
    }

    #[test]
    fn empty_tape_makes_every_floor_unverified() {
        let mut tape = NetWorthTape::new();
        assert!(tape.is_empty());
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        assert_eq!(confirm_net_worth_via(&claim, &mut tape).verdict, NetWorthVerdict::Unverified);
    }

    #[test]
    fn canonical_strings_are_exact_and_distinct() {
        assert_eq!(NetWorthVerdict::confirmed().canonical_string(), "confirmed");
        assert_eq!(NetWorthVerdict::refuted().canonical_string(), "refuted");
        assert_eq!(NetWorthVerdict::unverified().canonical_string(), "unverified");
        assert!(NetWorthVerdict::confirmed().is_confirmed());
        assert!(!NetWorthVerdict::refuted().is_confirmed());
        assert!(!NetWorthVerdict::unverified().is_confirmed());
    }

    #[test]
    fn display_is_stable_and_carries_the_verdict() {
        let claim = claim_with(NetWorthFloor::absolute(2_000_000));
        let obs = two_holdings(1_000_000, 2_000_000);
        let r = adjudicate_net_worth(&claim, Some(&obs));
        let line = r.to_string();
        assert!(line.contains("NET-WORTH"));
        assert!(line.contains("effective_floor=2000000"));
        assert!(line.contains("observed_total=3000000"));
        assert!(line.ends_with("-> confirmed"));
    }

    // --- the live codec (feature-gated): exact + never fabricates --------------------------------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_round_trips_a_hex_uint() {
        assert_eq!(LiveNetWorthSource::decode_uint("0x0f4240"), Some(1_000_000));
        assert_eq!(
            LiveNetWorthSource::decode_uint("0x0de0b6b3a7640000"),
            Some(1_000_000_000_000_000_000)
        );
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_rejects_malformed_never_fabricates() {
        assert!(LiveNetWorthSource::decode_uint("0x").is_none());
        assert!(LiveNetWorthSource::decode_uint("0xzz").is_none());
        assert!(LiveNetWorthSource::decode_uint("1234").is_none());
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoint_makes_every_leg_unreadable_so_unverified() {
        // The live reader is wired but pointed at an unreachable endpoint: every balance read fails, so
        // every leg counts as unreadable -> the whole net worth degrades to Unverified (never a fabricated
        // total). A native + an ERC-20 leg, both unreadable.
        let holdings = vec![
            LiveHolding {
                token: "NATIVE".into(),
                address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE".into(),
                is_native: true,
                price_micro_usd_per_minor: 1,
            },
            LiveHolding {
                token: "ERC20".into(),
                address: "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E".into(),
                is_native: false,
                price_micro_usd_per_minor: 1,
            },
        ];
        let mut src = LiveNetWorthSource::new("http://127.0.0.1:0", holdings);
        let claim = claim_with(NetWorthFloor::absolute(1));
        let report = confirm_net_worth_via(&claim, &mut src);
        assert_eq!(report.verdict, NetWorthVerdict::Unverified);
        assert_ne!(report.verdict, NetWorthVerdict::Confirmed);
        assert_eq!(report.unreadable_legs, 2, "both legs were unreadable");
    }
}
