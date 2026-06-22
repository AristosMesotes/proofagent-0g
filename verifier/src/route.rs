//! The ROUTE verifier extension -- mint a settlement verdict for each leg of a routed action.
//!
//! Design SS2 (the Settlement proof): "an independent Rust verifier reads 0G via raw JSON-RPC and stamps
//! each trade settled / hollow / mismatch / unverified -- it never trusts the UI." Design WOW Feature 2
//! (Routing -- intent + aggregation + native AMM) "wrapped by the proofs": "After settlement the verifier
//! reads 0G directly (never the aggregator API) and mints one verdict per leg -- for the intent rail it
//! treats `refunded` as a **non-settlement terminal state** (mandate-safe) and only `filled`-with-
//! matching-on-chain-transfer as `settled`; it catches API false-`filled` (hollow) and slippage/
//! wrong-asset/refund-as-fill (mismatch)."
//!
//! The MVP settlement leg ([`crate::verify_tx`]) adjudicates a transaction's native **value moved** (wei)
//! against a claim; the SWAP extension ([`crate::swap`]) decodes a pool `Swap`-event realized output. A
//! ROUTE leg is the next generalization: an action routed through an intent/aggregation/AMM rail settles
//! by **delivering an output amount to the recipient**, AND it carries a rail-level **terminal status**
//! that a naive integration would trust blindly (the aggregator's own "filled"/"refunded" word). This
//! module is that EXTENSION -- it reuses the exact-integer settlement algebra ([`crate::adjudicate`]) and
//! the one [`crate::Verdict`] monopoly, but it adjudicates an observation that pairs an *independently
//! observed* delivered amount with the rail's terminal status, so a rail that SAYS `filled` while the
//! chain delivered nothing can never be minted `settled`.
//!
//! ## Two-source truth at the routing boundary (design SS3 principle 1)
//!
//! Exactly as the value verifier never trusts the UI for "did it settle", this never trusts the
//! aggregator API for "did the leg fill". The agent's [`RouteClaim`] is the **Claim** (the quoted output
//! it expected on this leg, plus the on-chain `min_out` floor it bounded the leg with); the verifier's
//! own read of the delivered amount AND the on-chain-confirmed terminal status is the **Observation**.
//! They meet only in [`adjudicate_route_leg`]. The aggregator's REST status is, on its own, a *claim*;
//! the [`RouteObservation`] is only ever built from an INDEPENDENT on-chain read (the destination
//! transfer + the rail's settle/refund event), never from the API alone.
//!
//! ## The Khalani `refunded` rule -- a refund is a NON-settlement terminal state (mandate-safe)
//!
//! The intent rail (Khalani) settles atomically or **refunds**: a `refunded` order returned the funds
//! and delivered NOTHING to the destination. Design WOW Feature 2: a `refunded` is "a non-settlement
//! terminal state ... never a fabricated settle". So a non-settlement terminal status
//! ([`RouteTerminal::Refunded`] / [`RouteTerminal::Failed`]) adjudicates to [`crate::Verdict::Hollow`]
//! (on-record, but the leg delivered no economic effect to the recipient) -- it can NEVER be `settled`,
//! and crucially a rail that *reports* `filled` while the chain shows a refund / zero delivery is caught
//! as `hollow` (API false-`filled`), not trusted. This is mandate-safe: the safest routing failure is the
//! one whose funds never left, and a refund is reported as exactly what it is.
//!
//! ## The verdict alphabet, reused (design SS2 + SS3 principle 2, the verdict monopoly)
//!
//! A ROUTE leg mints one of the SAME four [`crate::Verdict`]s -- there is no new verdict enum, so the
//! route leg cannot widen the alphabet or escape the monopoly:
//!
//! - **`settled`**  -- the rail's terminal status is `filled`, the independently-observed delivered
//!   amount is at/above the on-chain `min_out` floor, AND it is within the exact-integer tolerance band
//!   of the claimed `expected_out`.
//! - **`hollow`**   -- a NON-settlement terminal (`refunded` / `failed`), OR a `filled` status whose
//!   independently-observed delivery is `0` (an API false-`filled`). On-record, but no economic effect.
//! - **`mismatch`** -- `filled` with a delivered amount BELOW the on-chain `min_out` floor (the leg's own
//!   slippage/route-quality bound was violated) OR outside the tolerance band of the claim (slippage /
//!   wrong-asset / refund-as-fill). A loud "the chain disagrees with the claim".
//! - **`unverified`** -- the chain could not be read (off-tape / unreadable / unknown leg). The loud,
//!   honest degrade target (design SS3 principle 3) -- never a fabricated `settled`.
//!
//! ## Never fabricate (design SS3 principle 3)
//!
//! An unavailable / unreadable route read degrades LOUDLY to [`crate::Verdict::Unverified`] via the same
//! `observed == None -> Unverified` keystone the value + swap legs use. A `refunded` terminal is a real,
//! loud `hollow`, distinct from "we could not read it". A short delivery is a real, loud `mismatch`. None
//! can collapse into a fabricated `settled`.
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5)
//!
//! [`adjudicate_route_leg`] is pure over `(claim, observation)` -- no wall-clock, no global state. Every
//! amount (`delivered`, the `min_out` floor, the claimed `expected_out`, the tolerance band) is an exact
//! `i128` in the output token's MINOR units; there is no float anywhere on this money path.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build adjudicates a route leg against a deterministic, std-only [`RouteTape`] (a recorded
//! route read), so it needs no network. The `live` feature adds [`LiveRouteSource`] -- a real
//! `eth_getTransactionReceipt` reader that confirms the rail's settle/refund event on the destination tx
//! and decodes the delivered amount, feeding the SAME algebra, the same raw-JSON-RPC shape the settlement
//! [`crate::LiveSource`] uses. The cross-chain rails (intent / aggregation) are MAINNET-only; the native
//! AMM rail is testnet-able (16602) -- the verdict algebra is identical for all three.

use crate::{adjudicate, Ratio, ReadKey, Verdict};
use core::fmt;
use std::collections::BTreeMap;

/// Which public routing rail a leg rode (design WOW Feature 2). A label for the human-readable
/// confirmation row -- never part of the verdict algebra (the algebra is identical for every rail).
///
/// The three rails differ only in HOW the agent built the leg (intent publish / aggregator quote / AMM
/// router call) and WHERE it settles (cross-chain vs same-chain); the verifier reads the chain the same
/// way for all of them, so the rail is carried for the audit trail, not consulted by the verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RouteRail {
    /// Intent rail (Khalani) -- publish one intent, atomic settle-or-**refund**. Cross-chain, MAINNET.
    Intent,
    /// Aggregation rail (LI.FI) -- aggregated DEX/cross-chain route. Cross-chain, MAINNET.
    Aggregation,
    /// Native AMM rail (JAINE V3 on 0G) -- same-chain swap. TESTNET-able (16602).
    NativeAmm,
}

impl RouteRail {
    /// A stable, human-readable label for the confirmation row (deterministic; design SS3 principle 4).
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            RouteRail::Intent => "intent:khalani",
            RouteRail::Aggregation => "aggregation:lifi",
            RouteRail::NativeAmm => "native-amm:jaine",
        }
    }
}

impl fmt::Display for RouteRail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The rail's TERMINAL status for a leg, as INDEPENDENTLY confirmed from the chain (the settle/refund
/// event), NOT the aggregator's REST word.
///
/// A routed leg ends in exactly one terminal state. `Filled` is the only one that can settle -- and only
/// when the independently-observed delivery confirms it. `Refunded` / `Failed` are NON-settlement
/// terminals: the leg delivered nothing to the recipient (design WOW Feature 2: a `refunded` is a
/// non-settlement terminal state, never a fabricated settle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RouteTerminal {
    /// The rail reports the leg filled. The ONLY status that can settle -- and only if the independently
    /// observed delivery confirms it (a `Filled` with zero on-chain delivery is an API false-fill).
    Filled,
    /// The intent rail refunded the leg -- funds returned, NOTHING delivered to the recipient. A
    /// non-settlement terminal state (mandate-safe). Adjudicates to `hollow`, NEVER `settled`.
    Refunded,
    /// The leg failed / reverted on-chain -- nothing delivered. A non-settlement terminal (like refund).
    Failed,
}

impl RouteTerminal {
    /// The canonical, stable, snake_case string for the journal/UI (deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            RouteTerminal::Filled => "filled",
            RouteTerminal::Refunded => "refunded",
            RouteTerminal::Failed => "failed",
        }
    }

    /// `true` iff this terminal status is one the rail considers a *settlement attempt that delivered*
    /// (i.e. `Filled`). `Refunded` / `Failed` are non-settlement terminals (return `false`). Note: a
    /// `Filled` status still only SETTLES if the independent on-chain delivery confirms it -- this is the
    /// status check, not the verdict.
    #[must_use]
    pub const fn is_fill(&self) -> bool {
        matches!(self, RouteTerminal::Filled)
    }
}

impl fmt::Display for RouteTerminal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The independently-observed outcome of one routed leg -- the **Observation** (design SS3 principle 1).
///
/// This is the verifier's own read of the chain: the rail's terminal status confirmed by the on-chain
/// settle/refund event, paired with the realized `delivered` amount (the output token actually received
/// by the recipient), in the output token's MINOR units (exact-integer, design SS3 principle 5). It is
/// NEVER built from the aggregator's REST status alone -- a `Filled` here means the chain's settle event
/// was read, and `delivered` is the chain's number, not the API's.
///
/// A `delivered` of `0` under a `Filled` status means "the rail reports filled, but the chain delivered
/// nothing" (an API false-`filled`) -- distinct from the *absence* of an observation (a [`RouteSource`]
/// read that could not answer), which is modelled one level up as `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RouteObservation {
    /// The rail's terminal status, INDEPENDENTLY confirmed from the chain (settle/refund event).
    terminal: RouteTerminal,
    /// The realized delivered amount to the recipient, output token MINOR units (exact-integer).
    delivered: i128,
}

impl RouteObservation {
    /// Record an independently-observed routed-leg outcome (terminal status + delivered minor units).
    #[must_use]
    pub const fn new(terminal: RouteTerminal, delivered: i128) -> RouteObservation {
        RouteObservation { terminal, delivered }
    }

    /// A convenience constructor for a confirmed FILL delivering `delivered` minor units.
    #[must_use]
    pub const fn filled(delivered: i128) -> RouteObservation {
        RouteObservation { terminal: RouteTerminal::Filled, delivered }
    }

    /// A convenience constructor for a confirmed REFUND (a non-settlement terminal; delivered `0`).
    #[must_use]
    pub const fn refunded() -> RouteObservation {
        RouteObservation { terminal: RouteTerminal::Refunded, delivered: 0 }
    }

    /// The independently-confirmed terminal status.
    #[must_use]
    pub const fn terminal(&self) -> RouteTerminal {
        self.terminal
    }

    /// The realized delivered amount to the recipient, in minor units.
    #[must_use]
    pub const fn delivered(&self) -> i128 {
        self.delivered
    }
}

/// The agent's recorded claim about one routed leg -- the **Claim** half of two-source truth (design SS3
/// principle 1). Never trusted on its own; adjudicated against the verifier's own on-chain read.
///
/// All amounts are exact `i128` minor units of the OUTPUT token (design SS3 principle 5):
///
/// - `rail` -- which public rail the leg rode (audit-trail label; the verdict algebra is rail-independent).
/// - `expected_out` -- the quoted output the agent expected for this leg (e.g. the rail's quote). The
///   delivered amount is adjudicated against this with the exact-integer tolerance band.
/// - `min_out` -- the ON-CHAIN minimum-output floor the agent bound the leg with (the slippage / route-
///   quality bound -- e.g. the JAINE router `amountOutMinimum`, or the intent's min-fill constraint). A
///   *settled* leg must have `delivered >= min_out`; a delivery below the floor is a loud `mismatch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RouteClaim {
    /// Which public rail this leg rode (audit-trail label).
    rail: RouteRail,
    /// The quoted/expected output (minor units) the delivered amount is adjudicated against.
    expected_out: i128,
    /// The on-chain minimum-output floor the agent bound this leg with (minor units). A settled leg's
    /// delivery must be at or above this.
    min_out: i128,
}

impl RouteClaim {
    /// Build a route-leg claim from the rail, the quoted `expected_out`, and the on-chain `min_out` floor.
    #[must_use]
    pub const fn new(rail: RouteRail, expected_out: i128, min_out: i128) -> RouteClaim {
        RouteClaim { rail, expected_out, min_out }
    }

    /// The rail this leg rode.
    #[must_use]
    pub const fn rail(&self) -> RouteRail {
        self.rail
    }

    /// The quoted/expected output (minor units) -- the claim the delivered amount is adjudicated against.
    #[must_use]
    pub const fn expected_out(&self) -> i128 {
        self.expected_out
    }

    /// The on-chain minimum-output floor (minor units) -- a settled leg's delivery must be at or above it.
    #[must_use]
    pub const fn min_out(&self) -> i128 {
        self.min_out
    }
}

/// The result of verifying one routed leg: the claim, the independent observation (or `None` if
/// unreadable), and the minted [`Verdict`].
///
/// This is the route analogue of [`crate::swap::SwapReport`]: it carries enough to *reproduce and audit*
/// the verdict -- the rail, the claimed/expected output, the on-chain floor, the observed terminal status
/// and delivered amount (or `None` -- the loud absence), and the verdict the verifier minted -- and
/// nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteReport {
    /// The canonical `0x`-lowercase transaction hash this route-leg report is about (the settle tx).
    pub hash: String,
    /// Which public rail the leg rode.
    pub rail: RouteRail,
    /// The quoted/expected output (minor units) -- the agent's claim.
    pub expected_out: i128,
    /// The on-chain minimum-output floor the agent bound the leg with (minor units).
    pub min_out: i128,
    /// The independently-confirmed terminal status, or `None` when the chain could not be read.
    pub terminal: Option<RouteTerminal>,
    /// The independently-observed delivered amount (minor units), or `None` when unreadable (the loud
    /// absence that adjudicates to [`Verdict::Unverified`]).
    pub delivered: Option<i128>,
    /// The minted verdict -- the only place a route verdict is created (the [`Verdict`] monopoly).
    pub verdict: Verdict,
}

impl RouteReport {
    /// The canonical verdict string (design SS2 alphabet): `settled / hollow / mismatch / unverified`.
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate one routed leg: does the independently-observed delivery confirm the claimed leg, within
/// its on-chain floor and the exact-integer tolerance band -- AND was the terminal status a real fill?
///
/// The route-settlement algebra (design SS3 principle 1, two-source truth; principle 5, exact-integer
/// money; design WOW Feature 2, the Khalani `refunded` rule), evaluated strictly in order:
///
/// 1. `observed == None`                          -> [`Verdict::Unverified`]  (the keystone -- never
///    fabricate; an unreadable leg can never become a fabricated `settled`).
/// 2. terminal is NOT a fill (`refunded` / `failed`) -> [`Verdict::Hollow`]   (a non-settlement terminal
///    -- the leg delivered nothing to the recipient; the Khalani `refunded` rule, mandate-safe).
/// 3. `delivered == 0` (a `filled` that delivered nothing) -> [`Verdict::Hollow`]  (an API false-`filled`
///    -- the rail SAYS filled but the chain delivered nothing).
/// 4. `delivered < min_out`                       -> [`Verdict::Mismatch`]    (below the on-chain floor
///    the agent set -- the leg's slippage/route-quality bound was violated; a refuted economic outcome).
/// 5. `|delivered - expected_out| <= band`        -> [`Verdict::Settled`]     (within tolerance of the
///    quoted output -- the leg settled as claimed).
/// 6. else                                        -> [`Verdict::Mismatch`]    (above the floor but
///    outside the tolerance band of the claim -- slippage / wrong-asset / short fill).
///
/// The verdict is minted HERE -- through [`crate::adjudicate`] for the band check (steps 5/6) and the
/// same crate-private [`Verdict`] constructors elsewhere -- so the [`Verdict`] monopoly (design SS3
/// principle 2) is preserved: no caller outside the crate can construct a route verdict, only obtain one.
///
/// Note the layered safety: a `refunded`/`failed` terminal is caught at step (2) BEFORE any amount math,
/// so a refund can never settle even if a stray `delivered` were nonzero; and a below-floor delivery is
/// caught at step (4) BEFORE the softer band, so a short fill can never settle. The floor is the hard
/// protocol-native bound; the band is the softer "as quoted" bound; the terminal status gates both.
#[must_use]
pub fn adjudicate_route_leg(
    claim: &RouteClaim,
    observed: Option<RouteObservation>,
    tol: Ratio,
) -> Verdict {
    // (1) Keystone (design SS3 principle 3): no read -> Unverified, never a fabricated Settled.
    let Some(obs) = observed else {
        return Verdict::unverified();
    };

    // (2) The Khalani `refunded` rule (design WOW Feature 2): a non-settlement terminal (refunded /
    // failed) delivered NOTHING to the recipient -> Hollow. Checked BEFORE any amount math so a refund
    // can NEVER settle, and a rail that reported `filled` while the chain shows a refund is caught here.
    if !obs.terminal().is_fill() {
        return Verdict::hollow();
    }

    let delivered = obs.delivered();

    // (3) An API false-`filled`: the rail reports filled but the chain delivered nothing -> Hollow.
    if delivered == 0 {
        return Verdict::hollow();
    }

    // (4) Below the on-chain min-output floor the agent set -> Mismatch. The leg's own slippage / route-
    // quality protection was violated; observing a below-floor delivery is a loud refuted economic
    // outcome, checked BEFORE the softer band so a below-floor delivery can never settle.
    if delivered < claim.min_out() {
        return Verdict::mismatch();
    }

    // (5) + (6) Band check against the quoted/expected output -- the exact-integer settlement algebra,
    // reused verbatim (design SS3 principle 1 + 5). Within band -> Settled; outside -> Mismatch. The
    // verdict is minted by `adjudicate` (the value leg's algebra), preserving the verdict monopoly.
    adjudicate(claim.expected_out(), Some(delivered), tol)
}

// =================================================================================================
// The route read seam -- the independent Observation source (mirrors the settlement `Source` trait).
// =================================================================================================

/// The independent route-read seam -- the **Observation** source for a routed leg (design SS3 principle
/// 1).
///
/// `read_route` returns `Some(observation)` when the chain answered (the rail's settle/refund event was
/// found + decoded), or `None` when it could not (off-tape / unreadable / unknown leg) -- never a
/// fabricated observation (design SS3 principle 3). A taped replay and a live `eth_getTransactionReceipt`
/// reader both satisfy it, so swapping one for the other never changes what a route verdict MEANS.
///
/// `read_route` takes `&mut self` so a live implementation may hold and mutate a connection; [`RouteTape`]
/// does not need the mutability but honors the same signature so the two are drop-in interchangeable.
pub trait RouteSource {
    /// Read the independently-confirmed outcome of the routed leg named by `key`. `None` is the loud
    /// honest absence (design SS3 principle 3).
    fn read_route(&mut self, key: &ReadKey) -> Option<RouteObservation>;
}

/// A deterministic, std-only replay of recorded route reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`ReadKey`] to
/// [`RouteObservation`]. A keyed read replays its exact recording; an unrecorded key is `None` (we have
/// no recording, so we refuse to invent one -- design SS3 principle 3). Because the map is ordered and
/// the lookup is pure, the same tape always answers a given key identically, with no network and no
/// wall-clock -- the tape IS the recorded chain, frozen.
#[derive(Debug, Clone, Default)]
pub struct RouteTape {
    tape: BTreeMap<ReadKey, RouteObservation>,
}

impl RouteTape {
    /// An empty tape -- every route read is `None` (unverified).
    #[must_use]
    pub fn new() -> RouteTape {
        RouteTape { tape: BTreeMap::new() }
    }

    /// Record a route observation for a key, returning the tape for chaining. Re-recording a key
    /// overwrites it (the tape is the single source of recorded truth for that key).
    #[must_use]
    pub fn with(mut self, key: ReadKey, obs: RouteObservation) -> RouteTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a route observation for a key in place.
    pub fn record(&mut self, key: ReadKey, obs: RouteObservation) {
        self.tape.insert(key, obs);
    }

    /// How many route reads are recorded on this tape.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff the tape has no recorded route reads.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl RouteSource for RouteTape {
    fn read_route(&mut self, key: &ReadKey) -> Option<RouteObservation> {
        self.tape.get(key).copied()
    }
}

/// Verify one routed leg end-to-end: read the independent outcome from `source`, adjudicate vs the claim.
///
/// This is the route analogue of [`crate::verify_tx`] / [`crate::verify_swap`]: the agent's [`RouteClaim`]
/// is the Claim, the chain-confirmed terminal status + delivered amount is the Observation, and
/// [`adjudicate_route_leg`] mints the verdict. An unreadable leg degrades to [`Verdict::Unverified`] --
/// never a fabricated `settled` (design SS3 principle 3). It returns a [`RouteReport`] carrying the inputs
/// that produced the verdict.
#[must_use]
pub fn verify_route_leg(
    key: &ReadKey,
    claim: &RouteClaim,
    tol: Ratio,
    source: &mut dyn RouteSource,
) -> RouteReport {
    let observed = source.read_route(key);
    let verdict = adjudicate_route_leg(claim, observed, tol);
    RouteReport {
        hash: key.tx_hash().to_string(),
        rail: claim.rail(),
        expected_out: claim.expected_out(),
        min_out: claim.min_out(),
        terminal: observed.map(|o| o.terminal()),
        delivered: observed.map(|o| o.delivered()),
        verdict,
    }
}

/// Verify a MULTI-leg route: a route is settled ONLY if EVERY leg is independently settled.
///
/// Design WOW Feature 2 ("the wow scales the action ... while every leg stays mandate-gated + verifier-
/// confirmed") + the egress doctrine generalized: "A multi-hop journey is settled only if every hop is
/// independently settled -- hop-1 ... says nothing about hop-2." This is the route-composition rule: it
/// verifies each leg with [`verify_route_leg`] and returns the per-leg reports PLUS the single composed
/// verdict, which is `Settled` IFF all legs settled, and otherwise the FIRST non-settled leg's verdict
/// (the loud first failure -- never a fabricated whole-route settled when any leg did not settle).
///
/// `legs` pairs each leg's settle-tx key with its claim, in route order. An empty route is NOT a settled
/// route -- it is `Unverified` (there is nothing on-record confirming any settlement), never a vacuous
/// `settled` (design SS3 principle 3).
#[must_use]
pub fn verify_route(
    legs: &[(ReadKey, RouteClaim)],
    tol: Ratio,
    source: &mut dyn RouteSource,
) -> (Vec<RouteReport>, Verdict) {
    let reports: Vec<RouteReport> = legs
        .iter()
        .map(|(key, claim)| verify_route_leg(key, claim, tol, source))
        .collect();

    // An empty route asserts no settlement -> Unverified (never a vacuous settled).
    let Some(first) = reports.first() else {
        return (reports, Verdict::unverified());
    };

    // The composed verdict: Settled IFF every leg settled; else the FIRST non-settled leg's verdict (the
    // loud first failure). This can NEVER be a fabricated whole-route settled when any leg did not settle.
    let composed = if reports.iter().all(|r| r.verdict.is_settled()) {
        Verdict::settled()
    } else {
        reports
            .iter()
            .find(|r| !r.verdict.is_settled())
            .map_or(first.verdict, |r| r.verdict)
    };
    (reports, composed)
}

// =================================================================================================
// LiveRouteSource -- the real eth_getTransactionReceipt reader. Behind the `live` feature ONLY (SS6).
// =================================================================================================

/// A live routed-leg reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`RouteTape`]: it POSTs `eth_getTransactionReceipt(hash)` to the 0G
/// RPC for the leg's settle tx and confirms the rail's terminal status + delivered amount from the chain
/// itself -- NEVER the aggregator REST API. It is feature-gated so the default build pulls in no network
/// dependency and stays fully offline (design SS6). The endpoint is supplied by the caller (from
/// `OG_RPC`), never hardcoded.
///
/// ## How it stays honest (design SS3 principle 3, never fabricate)
///
/// - A `null` receipt (unknown / unmined leg tx) -> `None` (the chain has no record; degrade loudly).
/// - A receipt with `status == 0x0` (reverted) -> `Some(RouteObservation::new(Failed, 0))` -- the leg
///   failed on-chain (a non-settlement terminal), never an `Unavailable` and never a fabricated nonzero.
/// - A successful receipt whose logs match the rail's REFUND event topic -> `Some(refunded())` -- a
///   non-settlement terminal (the Khalani `refunded` rule), confirmed from the chain, not the API.
/// - A successful receipt whose logs match the rail's FILL/transfer event topic -> decode the delivered
///   amount from the recipient's transfer; any malformed / out-of-`i128`-range data -> `None` (loud),
///   never a truncated/wrapped (fabricated) amount.
/// - A successful receipt with NO matching event -> `Some(RouteObservation::filled(0))` -- on-record but
///   no decodable delivery (an API false-`filled`), distinct from "unreadable".
///
/// The caller supplies the rail's FILL and REFUND event `topic0`s (public protocol facts, from the rail's
/// docs/ABI), so no rail-specific topic is baked into the verifier -- the read stays clean-room + generic.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveRouteSource {
    endpoint: String,
    /// The rail's FILL/settle event `topic0` (lowercase `0x` + 64 hex). The recipient transfer decoded
    /// from the matching log is the delivered amount.
    fill_topic0: String,
    /// The rail's REFUND event `topic0` (lowercase `0x` + 64 hex). A matching log is a non-settlement
    /// terminal (the Khalani `refunded` rule).
    refund_topic0: String,
}

#[cfg(feature = "live")]
impl LiveRouteSource {
    /// Build a live route reader against a JSON-RPC endpoint and the rail's fill/refund event topics.
    /// The topics are public protocol facts (the rail's settle/refund event signatures), supplied by the
    /// caller -- never hardcoded, so the verifier stays rail-generic + clean-room.
    #[must_use]
    pub fn new(
        endpoint: impl Into<String>,
        fill_topic0: impl Into<String>,
        refund_topic0: impl Into<String>,
    ) -> LiveRouteSource {
        LiveRouteSource {
            endpoint: endpoint.into(),
            fill_topic0: fill_topic0.into().trim().to_ascii_lowercase(),
            refund_topic0: refund_topic0.into().trim().to_ascii_lowercase(),
        }
    }

    /// The configured JSON-RPC endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// POST one JSON-RPC call and return the `result` value, or `None` on any transport/RPC failure.
    fn rpc_call(&self, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let response = ureq::post(&self.endpoint)
            .set("content-type", "application/json")
            .send_json(body)
            .ok()?;
        let value: serde_json::Value = response.into_json().ok()?;
        if value.get("error").is_some() {
            return None;
        }
        value.get("result").cloned()
    }
}

/// Decode the delivered amount from a rail FILL-event data blob: the first 32-byte word as a `uint256`.
///
/// The recipient transfer amount is the first non-indexed word of the rail's settle event data (the
/// canonical shape for a `Filled`/transfer event carrying a `uint256 amount`). Returns the delivered
/// amount as a non-negative `i128` of minor units, or `None` for a malformed blob or an out-of-`i128`-
/// range magnitude (never a wrapped/fabricated amount; design SS3 principle 3 + 5).
#[cfg(feature = "live")]
fn decode_route_delivered(data_hex: &str) -> Option<i128> {
    let body = data_hex.trim().strip_prefix("0x").or_else(|| data_hex.trim().strip_prefix("0X"))?;
    if body.len() < 64 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None; // need at least one 32-byte word (the uint256 amount)
    }
    let word = &body[0..64];
    // A delivered amount far inside i128 for any realistic balance; the high 16 bytes must be zero
    // (positive, in range). Anything else is out of i128 range -> None (never wrapped).
    let high = &word[0..32];
    let low = &word[32..64];
    if !high.bytes().all(|b| b == b'0') {
        return None;
    }
    let low_val = u128::from_str_radix(low, 16).ok()?;
    if low_val > i128::MAX as u128 {
        return None;
    }
    Some(low_val as i128)
}

#[cfg(feature = "live")]
impl RouteSource for LiveRouteSource {
    fn read_route(&mut self, key: &ReadKey) -> Option<RouteObservation> {
        // (1) The receipt is the source of truth for "did this leg settle + what events did it emit".
        let receipt = self.rpc_call("eth_getTransactionReceipt", serde_json::json!([key.tx_hash()]))?;
        if receipt.is_null() {
            return None; // unknown / unmined leg tx -> loud absence -> unverified
        }
        // (2) A reverted leg tx settled NOTHING -> Failed (a non-settlement terminal), never Unavailable.
        match receipt.get("status").and_then(serde_json::Value::as_str) {
            Some("0x0") => return Some(RouteObservation::new(RouteTerminal::Failed, 0)),
            Some("0x1") => {}
            _ => return None, // missing / malformed status -> loud absence
        }
        let logs = receipt.get("logs").and_then(serde_json::Value::as_array)?;
        // (3) A REFUND event (the Khalani `refunded` rule) is a non-settlement terminal -> Refunded.
        // Checked BEFORE the fill so a refund-as-fill can never be read as a delivery.
        for log in logs {
            if Self::log_topic0_matches(log, &self.refund_topic0) {
                return Some(RouteObservation::refunded());
            }
        }
        // (4) A FILL event -> decode the delivered amount from the recipient transfer.
        for log in logs {
            if Self::log_topic0_matches(log, &self.fill_topic0) {
                let data = log.get("data").and_then(serde_json::Value::as_str)?;
                let delivered = decode_route_delivered(data)?;
                return Some(RouteObservation::filled(delivered));
            }
        }
        // (5) Success but NO matching rail event -> on-record, no decodable delivery -> filled(0) (an API
        // false-`filled`), distinct from "unreadable".
        Some(RouteObservation::filled(0))
    }
}

#[cfg(feature = "live")]
impl LiveRouteSource {
    /// `true` iff the log's `topic0` equals `topic` (case-insensitive).
    fn log_topic0_matches(log: &serde_json::Value, topic: &str) -> bool {
        log.get("topics")
            .and_then(serde_json::Value::as_array)
            .and_then(|t| t.first())
            .and_then(serde_json::Value::as_str)
            .map(|t| t.eq_ignore_ascii_case(topic))
            == Some(true)
    }
}

/// Render a [`RouteReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for RouteReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let terminal = match self.terminal {
            Some(t) => t.canonical_string(),
            None => "<unavailable>",
        };
        let delivered = match self.delivered {
            Some(v) => v.to_string(),
            None => "<unavailable>".to_string(),
        };
        write!(
            f,
            "ROUTE {} {} expected_out={} min_out={} terminal={} delivered={} -> {}",
            self.rail,
            self.hash,
            self.expected_out,
            self.min_out,
            terminal,
            delivered,
            self.verdict_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";
    const HASH_B: &str = "0xdef0000000000000000000000000000000000000000000000000000000000002";
    const HASH_C: &str = "0x1230000000000000000000000000000000000000000000000000000000000003";

    fn key(h: &str) -> ReadKey {
        ReadKey::new(h).expect("test hash is well-formed")
    }

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    fn claim(rail: RouteRail) -> RouteClaim {
        // expected 1000, floor 900.
        RouteClaim::new(rail, 1_000, 900)
    }

    // --- the FOUR verdicts (the alphabet, design SS2) reused for a routed leg --------------------

    #[test]
    fn settled_when_filled_delivery_is_within_band_and_above_floor() {
        // filled, delivered 1100: 1100 >= floor(900) AND |1100-1000|=100 <= 15%-of-1000 band(150).
        let v = adjudicate_route_leg(&claim(RouteRail::NativeAmm), Some(RouteObservation::filled(1_100)), band_15pct());
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn hollow_when_intent_leg_refunded_the_khalani_rule() {
        // A refunded intent leg delivered NOTHING -> Hollow, NEVER settled (design WOW Feature 2). This
        // is checked BEFORE any amount math, so a refund can never settle.
        let v = adjudicate_route_leg(&claim(RouteRail::Intent), Some(RouteObservation::refunded()), band_15pct());
        assert_eq!(v, Verdict::Hollow, "a refunded intent leg is a non-settlement terminal -> hollow");
        assert_ne!(v, Verdict::Settled, "a refund must NEVER be a fabricated settle");
    }

    #[test]
    fn hollow_when_a_refund_falsely_carries_a_nonzero_delivered() {
        // Defense-in-depth: even if a (malformed) observation paired a Refunded terminal with a nonzero
        // delivered, the terminal gate (step 2) still yields Hollow -- a refund can NEVER settle.
        let obs = RouteObservation::new(RouteTerminal::Refunded, 1_000);
        let v = adjudicate_route_leg(&claim(RouteRail::Intent), Some(obs), band_15pct());
        assert_eq!(v, Verdict::Hollow, "the terminal status gates the amount; a refund never settles");
    }

    #[test]
    fn hollow_when_filled_but_chain_delivered_nothing_api_false_filled() {
        // The rail SAYS filled but the chain delivered 0 -> Hollow (an API false-`filled`), never settled.
        let v = adjudicate_route_leg(&claim(RouteRail::Aggregation), Some(RouteObservation::filled(0)), band_15pct());
        assert_eq!(v, Verdict::Hollow, "a filled-but-zero delivery is an API false-fill -> hollow");
    }

    #[test]
    fn mismatch_when_filled_delivery_is_below_the_on_chain_floor() {
        // delivered 800 < floor 900 -> Mismatch (the leg's slippage/route-quality floor was violated).
        // Checked BEFORE the band, so a below-floor delivery can never settle even if near expected.
        let v = adjudicate_route_leg(&claim(RouteRail::NativeAmm), Some(RouteObservation::filled(800)), band_15pct());
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn mismatch_when_above_floor_but_outside_the_band() {
        // delivered 1300 >= floor 900, but |1300-1000|=300 > band(150) -> Mismatch.
        let v = adjudicate_route_leg(&claim(RouteRail::Aggregation), Some(RouteObservation::filled(1_300)), band_15pct());
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn unverified_when_no_observation_never_settled() {
        // THE KEYSTONE (design SS3 principle 3): an unreadable leg -> Unverified, never a fabricated
        // settled, no matter the claim.
        let v = adjudicate_route_leg(&claim(RouteRail::Intent), None, band_15pct());
        assert_eq!(v, Verdict::Unverified);
        assert_ne!(v, Verdict::Settled);
    }

    #[test]
    fn failed_terminal_is_hollow() {
        // A failed/reverted leg delivered nothing -> Hollow (a non-settlement terminal, like refund).
        let obs = RouteObservation::new(RouteTerminal::Failed, 0);
        let v = adjudicate_route_leg(&claim(RouteRail::NativeAmm), Some(obs), band_15pct());
        assert_eq!(v, Verdict::Hollow);
    }

    #[test]
    fn settled_at_the_floor_boundary() {
        // delivered exactly == floor, and within band -> Settled (the floor is inclusive: >=).
        // expected 1000, floor 900, delivered 900: 900 >= 900 AND |900-1000|=100 <= 150 -> Settled.
        let v = adjudicate_route_leg(&claim(RouteRail::NativeAmm), Some(RouteObservation::filled(900)), band_15pct());
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn adjudicate_route_leg_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let c = claim(RouteRail::NativeAmm);
        for _ in 0..8 {
            assert_eq!(adjudicate_route_leg(&c, Some(RouteObservation::filled(1_100)), band_15pct()), Verdict::Settled);
            assert_eq!(adjudicate_route_leg(&c, Some(RouteObservation::filled(800)), band_15pct()), Verdict::Mismatch);
            assert_eq!(adjudicate_route_leg(&c, Some(RouteObservation::refunded()), band_15pct()), Verdict::Hollow);
            assert_eq!(adjudicate_route_leg(&c, None, band_15pct()), Verdict::Unverified);
        }
    }

    // --- the route tape (offline, deterministic) -------------------------------------------------

    #[test]
    fn tape_hit_verifies_and_off_tape_is_unverified() {
        let c = claim(RouteRail::NativeAmm);
        let mut tape = RouteTape::new().with(key(HASH_A), RouteObservation::filled(1_100));

        let report = verify_route_leg(&key(HASH_A), &c, band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Settled);
        assert_eq!(report.verdict_string(), "settled");
        assert_eq!(report.delivered, Some(1_100));
        assert_eq!(report.terminal, Some(RouteTerminal::Filled));
        assert_eq!(report.hash, HASH_A);
        assert_eq!(report.rail, RouteRail::NativeAmm);

        // An off-tape leg is Unverified (never a fabricated settled).
        let report2 = verify_route_leg(&key(HASH_B), &c, band_15pct(), &mut tape);
        assert_eq!(report2.verdict, Verdict::Unverified);
        assert_eq!(report2.delivered, None);
        assert_eq!(report2.terminal, None);
        assert_ne!(report2.verdict, Verdict::Settled);
    }

    #[test]
    fn empty_tape_makes_every_route_unverified() {
        let mut tape = RouteTape::new();
        assert!(tape.is_empty());
        assert_eq!(tape.len(), 0);
        let report = verify_route_leg(&key(HASH_A), &claim(RouteRail::Intent), band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Unverified);
    }

    #[test]
    fn route_tape_read_is_deterministic_and_record_overwrites() {
        let mut tape = RouteTape::new();
        tape.record(key(HASH_A), RouteObservation::filled(1));
        tape.record(key(HASH_A), RouteObservation::filled(2)); // overwrites
        assert_eq!(tape.read_route(&key(HASH_A)), Some(RouteObservation::filled(2)));
        assert_eq!(tape.len(), 1);
        let first = tape.read_route(&key(HASH_A));
        for _ in 0..8 {
            assert_eq!(tape.read_route(&key(HASH_A)), first);
        }
    }

    #[test]
    fn route_tape_is_a_dyn_source() {
        // The seam is object-safe: a RouteTape works through &mut dyn RouteSource, so a live + a taped
        // reader are drop-in interchangeable behind one trait.
        let mut tape = RouteTape::new().with(key(HASH_A), RouteObservation::filled(5));
        let dynamic: &mut dyn RouteSource = &mut tape;
        assert_eq!(dynamic.read_route(&key(HASH_A)), Some(RouteObservation::filled(5)));
        assert_eq!(dynamic.read_route(&key(HASH_B)), None);
    }

    // --- the multi-leg route composition (settled IFF every leg settled) -------------------------

    #[test]
    fn multi_leg_route_settles_only_when_every_leg_settles() {
        // Two legs, both filled within band/above floor -> the whole route is Settled.
        let mut tape = RouteTape::new()
            .with(key(HASH_A), RouteObservation::filled(1_100))
            .with(key(HASH_B), RouteObservation::filled(950));
        let legs = [
            (key(HASH_A), claim(RouteRail::Aggregation)),
            (key(HASH_B), claim(RouteRail::NativeAmm)),
        ];
        let (reports, composed) = verify_route(&legs, band_15pct(), &mut tape);
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|r| r.verdict == Verdict::Settled));
        assert_eq!(composed, Verdict::Settled);
    }

    #[test]
    fn multi_leg_route_with_one_refunded_leg_is_not_settled() {
        // Leg 1 fills, leg 2 refunds -> the whole route is NOT settled; the composed verdict is the FIRST
        // non-settled leg's verdict (hollow). A refunded hop can never make the route a fabricated settled.
        let mut tape = RouteTape::new()
            .with(key(HASH_A), RouteObservation::filled(1_050))
            .with(key(HASH_B), RouteObservation::refunded());
        let legs = [
            (key(HASH_A), claim(RouteRail::Aggregation)),
            (key(HASH_B), claim(RouteRail::Intent)),
        ];
        let (reports, composed) = verify_route(&legs, band_15pct(), &mut tape);
        assert_eq!(reports[0].verdict, Verdict::Settled);
        assert_eq!(reports[1].verdict, Verdict::Hollow, "the refunded leg is hollow");
        assert_eq!(composed, Verdict::Hollow, "a route with a refunded leg is NOT settled");
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn multi_leg_route_first_non_settled_leg_decides_the_composed_verdict() {
        // Leg 1 mismatches (below floor), leg 2 settles -> composed = mismatch (the first failure).
        let mut tape = RouteTape::new()
            .with(key(HASH_A), RouteObservation::filled(800)) // below floor 900 -> mismatch
            .with(key(HASH_B), RouteObservation::filled(1_000)); // settled
        let legs = [
            (key(HASH_A), claim(RouteRail::NativeAmm)),
            (key(HASH_B), claim(RouteRail::NativeAmm)),
        ];
        let (_reports, composed) = verify_route(&legs, band_15pct(), &mut tape);
        assert_eq!(composed, Verdict::Mismatch, "the first non-settled leg decides the route verdict");
    }

    #[test]
    fn an_empty_route_is_unverified_never_a_vacuous_settled() {
        // No legs -> the route asserts no settlement -> Unverified (never a vacuous settled).
        let mut tape = RouteTape::new();
        let (reports, composed) = verify_route(&[], band_15pct(), &mut tape);
        assert!(reports.is_empty());
        assert_eq!(composed, Verdict::Unverified);
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn multi_leg_route_with_an_unreadable_leg_is_not_settled() {
        // Leg 1 settles, leg 2 is off-tape (unreadable) -> composed = unverified (never settled).
        let mut tape = RouteTape::new().with(key(HASH_A), RouteObservation::filled(1_000));
        let legs = [
            (key(HASH_A), claim(RouteRail::NativeAmm)),
            (key(HASH_C), claim(RouteRail::Intent)), // not on the tape
        ];
        let (reports, composed) = verify_route(&legs, band_15pct(), &mut tape);
        assert_eq!(reports[0].verdict, Verdict::Settled);
        assert_eq!(reports[1].verdict, Verdict::Unverified);
        assert_eq!(composed, Verdict::Unverified);
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn report_renders_for_the_journal() {
        let c = claim(RouteRail::Intent);
        let mut tape = RouteTape::new().with(key(HASH_A), RouteObservation::filled(1_100));
        let report = verify_route_leg(&key(HASH_A), &c, band_15pct(), &mut tape);
        let line = report.to_string();
        assert!(line.contains("ROUTE"));
        assert!(line.contains("intent:khalani"));
        assert!(line.contains("terminal=filled"));
        assert!(line.contains("delivered=1100"));
        assert!(line.contains("settled"));
        // An unavailable read renders the loud absence, never a number/status.
        let report2 = verify_route_leg(&key(HASH_B), &c, band_15pct(), &mut tape);
        let line2 = report2.to_string();
        assert!(line2.contains("terminal=<unavailable>"));
        assert!(line2.contains("delivered=<unavailable>"));
        assert!(line2.contains("unverified"));
        // A refunded read renders the refund terminal + the hollow verdict.
        let mut tape3 = RouteTape::new().with(key(HASH_A), RouteObservation::refunded());
        let report3 = verify_route_leg(&key(HASH_A), &c, band_15pct(), &mut tape3);
        let line3 = report3.to_string();
        assert!(line3.contains("terminal=refunded"));
        assert!(line3.contains("hollow"));
    }

    #[test]
    fn rail_labels_are_stable() {
        assert_eq!(RouteRail::Intent.label(), "intent:khalani");
        assert_eq!(RouteRail::Aggregation.label(), "aggregation:lifi");
        assert_eq!(RouteRail::NativeAmm.label(), "native-amm:jaine");
    }

    #[test]
    fn terminal_strings_are_stable_and_fill_is_distinct() {
        assert_eq!(RouteTerminal::Filled.canonical_string(), "filled");
        assert_eq!(RouteTerminal::Refunded.canonical_string(), "refunded");
        assert_eq!(RouteTerminal::Failed.canonical_string(), "failed");
        assert!(RouteTerminal::Filled.is_fill());
        assert!(!RouteTerminal::Refunded.is_fill(), "a refund is NOT a fill");
        assert!(!RouteTerminal::Failed.is_fill(), "a failure is NOT a fill");
    }

    // --- the live decoder (feature-gated): the delivered codec is exact + never fabricates -------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_delivered_reads_the_first_uint256_word() {
        let amount = format!("{:0>64x}", 1_234_567u128);
        let data = format!("0x{amount}{}", "0".repeat(64)); // amount + a trailing word
        assert_eq!(super::decode_route_delivered(&data), Some(1_234_567));
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_delivered_rejects_malformed_and_oversized_never_fabricates() {
        assert_eq!(super::decode_route_delivered("0x"), None, "empty blob is malformed");
        assert_eq!(super::decode_route_delivered("0xzz"), None, "non-hex is malformed");
        // High bytes set -> out of i128 range -> None (never wrapped).
        let oversized = format!("0x{}{}", "f".repeat(32), "0".repeat(32));
        assert_eq!(super::decode_route_delivered(&oversized), None);
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoint_is_unverified_never_settled() {
        // The live reader is wired but pointed at an unreachable endpoint: the read fails, so the leg
        // degrades LOUDLY to Unverified (design SS3 principle 3), never a fabricated Settled.
        let mut src = LiveRouteSource::new(
            "http://127.0.0.1:0",
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222222222222222222222222222",
        );
        assert_eq!(src.endpoint(), "http://127.0.0.1:0");
        let report = verify_route_leg(&key(HASH_A), &claim(RouteRail::Intent), band_15pct(), &mut src);
        assert_eq!(report.verdict, Verdict::Unverified);
        assert_ne!(report.verdict, Verdict::Settled);
        assert_eq!(report.delivered, None);
    }
}
