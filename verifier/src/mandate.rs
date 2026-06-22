//! The mandate-tier verifier extension -- confirm each tier of the four-tier spend gate ON-CHAIN.
//!
//! Design SS2 (the Rails proof): the on-chain `MandateRegistry.checkTransfer()` "rejects any spend over
//! the cap, before broadcast, as a zero-gas `eth_call`." The MVP proves *one cap held*; the production
//! `MandateRegistryV3` is a FOUR-TIER gate (period cap, expiry + spender-allowlist, asset/USD/pause,
//! per-destination + atomic gate+accrue). This module is the verifier's EXTENSION that independently
//! confirms each tier on-chain -- it reads the gate itself (an `eth_call` to `checkTransfer` /
//! `checkTransferTo`) and adjudicates whether the gate's answer MATCHES the tier's expected outcome.
//!
//! ## Two-source truth at the gate boundary (design SS3 principle 1)
//!
//! Exactly as the settlement verifier never trusts the UI for "did it settle", this never trusts the
//! agent (or the web UI) for "is the agent bounded". The agent's mandate config is a **Claim**; the
//! verifier's own `eth_call` read of the gate is the **Observation**. A tier is confirmed ONLY when the
//! independent gate read MATCHES the tier's expected `(ok, reason)` -- e.g. the period tier is confirmed
//! when a probe that should breach it reads back `(false, OVER_PERIOD_CAP)` from the chain.
//!
//! ## The tier-verdict monopoly (design SS3 principle 2)
//!
//! [`TierVerdict`] is `#[non_exhaustive]` with `pub(crate)`-only minting, mirroring the settlement
//! [`crate::Verdict`] monopoly: only this crate can mint `Confirmed` / `Refuted` / `Unverified`. Nothing
//! outside the crate can fabricate a "the tier holds" verdict.
//!
//! ## Never fabricate (design SS3 principle 3)
//!
//! An unavailable / unreadable gate read degrades LOUDLY to [`TierVerdict::Unverified`] -- never to a
//! fabricated `Confirmed`. A gate read that ANSWERS but disagrees with the tier's expectation is
//! [`TierVerdict::Refuted`] (a real, loud "the gate does NOT enforce this tier as designed"), distinct
//! from "we could not read it". The three are different code paths that can never be confused.
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5)
//!
//! [`confirm_tier`] is pure over `(probe, observation)` -- no wall-clock, no global state. The probe's
//! amount is an exact `i128` in minor units; there is no float anywhere here.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build confirms tiers against a deterministic, std-only [`MandateTape`] (a recorded gate
//! read), so it needs no network. The `live` feature adds [`LiveGateSource`] -- a real `eth_call` reader
//! that POSTs `checkTransfer`/`checkTransferTo` to the 0G RPC and decodes the `(bool, bytes32)` return,
//! the same raw-JSON-RPC shape the settlement [`crate::LiveSource`] uses.

use core::fmt;
use std::collections::BTreeMap;

/// Which tier of the four-tier gate a probe confirms (design SS2 Rails / `MandateRegistryV3`).
///
/// This is a label for the human-readable confirmation row, never part of the verdict algebra. Each
/// tier maps to the attack it closes (the contract's own doc table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Tier {
    /// Tier 1 -- cumulative per-PERIOD cap (closes looping-drain).
    PeriodCap,
    /// Tier 2 -- enforced expiry (closes a missing time-box).
    Expiry,
    /// Tier 2 -- spender/router allowlist (closes "send anywhere").
    SpenderAllowlist,
    /// Tier 3 -- per-asset sub-cap.
    AssetCap,
    /// Tier 3 -- pause kill-switch (global or per-agent).
    Pause,
    /// Tier 3 -- USD-denominated cap (price-feed, opt-in, fail-closed).
    UsdCap,
    /// Tier 4 -- per-destination 'sandbox' cap.
    DestCap,
    /// Tier 4 -- the baseline within-cap PASS (the gate authorizes a legal spend).
    WithinMandate,
    // --- consolidated-hardened tiers (the V4 `MandateRegistry`, the 9-lens adversarial spec) ---
    /// notBefore -- the half-open window's lower edge (now < start -> NOT_STARTED).
    NotStarted,
    /// EPOCH on the money path -- a `bumpEpoch` strands an in-flight grant (EPOCH_STALE).
    Epoch,
    /// The tx-count leaky bucket (OVER_TXCOUNT_CAP) -- a count-tier looping guard.
    TxCountCap,
    /// The raw dust floor (BELOW_MIN_SPEND).
    MinSpend,
    /// The USD dust floor (BELOW_MIN_USD).
    MinUsd,
    /// The price-feed STALENESS guard -- a stale/out-of-band/overflow feed fails CLOSED (PRICE_UNAVAILABLE).
    UsdStaleness,
    /// The TYPED per-spoke isolation -- an UNCONFIGURED spoke authorizes nothing (default-deny).
    SpokeDefaultDeny,
    /// The folded time-lock RE-GATES at execute -- a pause/expiry/epoch/de-allowlist between queue and
    /// execute REFUSES the execute (the schedule can only deny, never extend executability).
    ExecuteReGate,
    /// The folded time-lock RESERVES period headroom at queue + releases on cancel/expire (egress is
    /// period-bounded; smurfing past the threshold crosses into the long lock).
    EgressReservation,
}

impl Tier {
    /// A stable, human-readable label for the confirmation row (deterministic; design SS3 principle 4).
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            Tier::PeriodCap => "tier1:period-cap",
            Tier::Expiry => "tier2:expiry",
            Tier::SpenderAllowlist => "tier2:spender-allowlist",
            Tier::AssetCap => "tier3:asset-cap",
            Tier::Pause => "tier3:pause",
            Tier::UsdCap => "tier3:usd-cap",
            Tier::DestCap => "tier4:dest-cap",
            Tier::WithinMandate => "tier4:within-mandate",
            // consolidated-hardened tiers (V4):
            Tier::NotStarted => "v4:not-started",
            Tier::Epoch => "v4:epoch",
            Tier::TxCountCap => "v4:txcount-cap",
            Tier::MinSpend => "v4:min-spend",
            Tier::MinUsd => "v4:min-usd",
            Tier::UsdStaleness => "v4:usd-staleness",
            Tier::SpokeDefaultDeny => "v4:spoke-default-deny",
            Tier::ExecuteReGate => "v4:execute-re-gate",
            Tier::EgressReservation => "v4:egress-reservation",
        }
    }
}

impl fmt::Display for Tier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The verdict for ONE mandate tier, minted by the verifier (design SS3 principle 2, the monopoly).
///
/// `#[non_exhaustive]` + `pub(crate)`-only minting: only this crate can construct a value, so nothing
/// outside the verifier can fabricate a "the tier holds" verdict (exactly like [`crate::Verdict`]).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TierVerdict {
    /// The independent gate read MATCHED the tier's expected `(ok, reason)` -- the tier is enforced
    /// on-chain exactly as designed.
    Confirmed,
    /// The gate ANSWERED, but its `(ok, reason)` disagrees with the tier's expectation -- a loud
    /// "the gate does NOT enforce this tier as designed" (e.g. an over-cap probe the gate let pass).
    Refuted,
    /// The gate could not be read (off-tape / unreadable / not wired). The loud, honest degrade target
    /// (design SS3 principle 3) -- never a fabricated `Confirmed`.
    Unverified,
}

impl TierVerdict {
    /// The canonical, stable, snake_case string (the wire/journal form; deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            TierVerdict::Confirmed => "confirmed",
            TierVerdict::Refuted => "refuted",
            TierVerdict::Unverified => "unverified",
        }
    }

    /// `true` only for `Confirmed` -- the honest "the tier is enforced on-chain" check. Nothing else
    /// reads as success (design SS3 principle 3).
    #[must_use]
    pub const fn is_confirmed(&self) -> bool {
        matches!(self, TierVerdict::Confirmed)
    }

    // The minting surface -- `pub(crate)` ONLY (the tier-verdict monopoly, design SS3 principle 2).
    pub(crate) const fn confirmed() -> TierVerdict {
        TierVerdict::Confirmed
    }
    pub(crate) const fn refuted() -> TierVerdict {
        TierVerdict::Refuted
    }
    pub(crate) const fn unverified() -> TierVerdict {
        TierVerdict::Unverified
    }
}

impl fmt::Display for TierVerdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The expected outcome of a gate probe -- the agent's **Claim** about how the gate SHOULD answer.
///
/// A tier is confirmed when the independent on-chain read matches this. `ok` is the expected boolean;
/// `reason` is the expected ASCII reason tag (e.g. `"OVER_PERIOD_CAP"`), or the empty string for the
/// `REASON_OK` (within-mandate) case. The reason is exactly the contract's left-aligned ASCII `bytes32`
/// tag, decoded to a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedGate {
    /// The expected `ok` boolean of `checkTransfer`/`checkTransferTo`.
    pub ok: bool,
    /// The expected reason tag (ASCII). Empty string == the `REASON_OK` zero word (within-mandate).
    pub reason: String,
}

impl ExpectedGate {
    /// The within-mandate expectation: `(true, "")` (the gate authorizes a legal spend).
    #[must_use]
    pub fn ok() -> ExpectedGate {
        ExpectedGate { ok: true, reason: String::new() }
    }

    /// A blocked expectation: `(false, reason)` -- the tier rejects with this exact reason tag.
    #[must_use]
    pub fn blocked(reason: impl Into<String>) -> ExpectedGate {
        ExpectedGate { ok: false, reason: reason.into() }
    }
}

/// The independent on-chain read of a gate call -- the **Observation** (design SS3 principle 1).
///
/// This is what the chain's `checkTransfer`/`checkTransferTo` actually returned, read by the verifier
/// itself (never the agent's word). `reason` is the decoded ASCII tag (empty for the zero word).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateObservation {
    /// The observed `ok` boolean from the gate.
    pub ok: bool,
    /// The observed reason tag (ASCII; empty == `REASON_OK`).
    pub reason: String,
}

impl GateObservation {
    /// Record an observed gate answer.
    #[must_use]
    pub fn new(ok: bool, reason: impl Into<String>) -> GateObservation {
        GateObservation { ok, reason: reason.into() }
    }
}

/// One mandate-tier probe -- a tier label, the gate call to make, and the expected answer.
///
/// The probe is the experiment: "call the gate with these args; the tier is confirmed iff the chain
/// answers as expected." It carries the exact-integer amount (minor units) so there is no float on the
/// money path (design SS3 principle 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MandateProbe {
    /// Which tier this probe confirms (the human-readable label).
    pub tier: Tier,
    /// The agent address argument to the gate (the proposing agent).
    pub agent: String,
    /// The token address argument.
    pub token: String,
    /// The amount in MINOR units (exact-integer, design SS3 principle 5).
    pub amount: i128,
    /// The spender/router argument. `None` calls `checkTransfer` (v2 shape); `Some` calls
    /// `checkTransferTo` (Tier 2/4).
    pub spender: Option<String>,
    /// The expected gate answer that CONFIRMS this tier (the **Claim**).
    pub expected: ExpectedGate,
}

/// The result of confirming one tier: the probe, the independent observation (or `None` if unreadable),
/// and the minted [`TierVerdict`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TierReport {
    /// The tier this report is about.
    pub tier: Tier,
    /// The amount probed (minor units) -- echoed for the confirmation row.
    pub amount: i128,
    /// The expected gate answer (the Claim).
    pub expected: ExpectedGate,
    /// The independently-observed gate answer, or `None` when the gate could not be read (the loud
    /// absence that adjudicates to [`TierVerdict::Unverified`]).
    pub observed: Option<GateObservation>,
    /// The minted tier verdict -- the only place a tier verdict is created (the monopoly).
    pub verdict: TierVerdict,
}

impl TierReport {
    /// The canonical tier-verdict string (`confirmed` / `refuted` / `unverified`).
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate a mandate tier: does the independent gate read MATCH the tier's expected answer?
///
/// The tier-confirmation algebra (design SS3 principle 1, two-source truth), evaluated strictly in order:
///
/// 1. `observed == None`                          -> [`TierVerdict::Unverified`]  (never fabricate)
/// 2. `observed == Some(expected)` (exact match)  -> [`TierVerdict::Confirmed`]
/// 3. else (the gate answered, but differently)   -> [`TierVerdict::Refuted`]
///
/// The verdict is minted HERE -- inside the crate -- preserving the tier-verdict monopoly (design SS3
/// principle 2). The match is exact on BOTH `ok` and the reason tag: the period tier is confirmed only
/// if the gate reads back precisely `(false, "OVER_PERIOD_CAP")`, not merely "blocked for some reason".
#[must_use]
pub fn confirm_tier(probe: &MandateProbe, observed: Option<GateObservation>) -> TierReport {
    let verdict = match &observed {
        // (1) Keystone (design SS3 principle 3): no read -> Unverified, never a fabricated Confirmed.
        None => TierVerdict::unverified(),
        // (2) Exact match on ok AND reason -> Confirmed.
        Some(obs) if obs.ok == probe.expected.ok && obs.reason == probe.expected.reason => {
            TierVerdict::confirmed()
        }
        // (3) The gate answered but disagrees -> Refuted (a loud "not enforced as designed").
        Some(_) => TierVerdict::refuted(),
    };
    TierReport {
        tier: probe.tier,
        amount: probe.amount,
        expected: probe.expected.clone(),
        observed,
        verdict,
    }
}

// =================================================================================================
// The gate read seam -- the independent Observation source (mirrors the settlement `Source` trait).
// =================================================================================================

/// The key for a gate read: the exact call to make (which method + its args).
///
/// A distinct newtype so the read seam is type-checked. Two gate reads with identical args yield the
/// same key (so the tape is deterministic).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GateKey {
    /// Lowercased agent address.
    agent: String,
    /// Lowercased token address.
    token: String,
    /// The amount in minor units (as a decimal string, for a total Ord key).
    amount: String,
    /// Lowercased spender, or empty for the v2-shape `checkTransfer`.
    spender: String,
}

impl GateKey {
    /// Build a gate key from a probe (lowercasing addresses for a canonical key).
    #[must_use]
    pub fn from_probe(probe: &MandateProbe) -> GateKey {
        GateKey {
            agent: probe.agent.trim().to_ascii_lowercase(),
            token: probe.token.trim().to_ascii_lowercase(),
            amount: probe.amount.to_string(),
            spender: probe
                .spender
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .unwrap_or_default(),
        }
    }
}

/// The independent gate-read seam -- the Observation source for the mandate tiers.
///
/// `read_gate` returns `Some(observation)` when the chain answered the `eth_call`, or `None` when it
/// could not (off-tape / unreadable / not wired) -- never a fabricated observation (design SS3
/// principle 3). A taped replay and a live `eth_call` reader both satisfy it, so swapping one for the
/// other never changes what a tier verdict MEANS.
pub trait MandateGateSource {
    /// Read the gate for the call named by `key`. `None` is the loud honest absence.
    fn read_gate(&mut self, key: &GateKey) -> Option<GateObservation>;
}

/// A deterministic, std-only replay of recorded gate reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`GateKey`] to
/// [`GateObservation`]. A keyed read replays its exact recording; an unrecorded key is `None` (we have
/// no recording, so we refuse to invent one). This is what makes the default verifier build confirm
/// tiers with no network -- the tape IS the recorded gate, frozen.
#[derive(Debug, Clone, Default)]
pub struct MandateTape {
    tape: BTreeMap<GateKey, GateObservation>,
}

impl MandateTape {
    /// An empty tape -- every gate read is `None` (unverified).
    #[must_use]
    pub fn new() -> MandateTape {
        MandateTape { tape: BTreeMap::new() }
    }

    /// Record a gate observation for a key, returning the tape for chaining.
    #[must_use]
    pub fn with(mut self, key: GateKey, obs: GateObservation) -> MandateTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a gate observation for a key in place.
    pub fn record(&mut self, key: GateKey, obs: GateObservation) {
        self.tape.insert(key, obs);
    }

    /// How many gate reads are recorded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff no gate reads are recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl MandateGateSource for MandateTape {
    fn read_gate(&mut self, key: &GateKey) -> Option<GateObservation> {
        self.tape.get(key).cloned()
    }
}

/// Confirm one tier end-to-end: build the gate key from the probe, read it from `source`, adjudicate.
///
/// This is the mandate analogue of [`crate::verify_tx`] for ONE tier: the probe's expected answer is the
/// Claim, the gate read is the Observation, and [`confirm_tier`] mints the verdict. An unreadable gate
/// degrades to [`TierVerdict::Unverified`] -- never a fabricated `Confirmed` (design SS3 principle 3).
#[must_use]
pub fn confirm_tier_via(probe: &MandateProbe, source: &mut dyn MandateGateSource) -> TierReport {
    let key = GateKey::from_probe(probe);
    let observed = source.read_gate(&key);
    confirm_tier(probe, observed)
}

// =================================================================================================
// LiveGateSource -- the real eth_call reader. Behind the `live` cargo feature ONLY (design SS6).
// =================================================================================================

/// A live `eth_call` gate reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`MandateTape`]: it POSTs an `eth_call` of
/// `checkTransfer(address,address,uint256)` (selector `0xcc1dd94f`) or
/// `checkTransferTo(address,address,uint256,address)` (selector `0x697bb97c`) to the 0G RPC endpoint and
/// decodes the `(bool ok, bytes32 reason)` return into a [`GateObservation`]. Every transport / decode
/// failure is a loud `None` (design SS3 principle 3) -- never a fabricated observation. The endpoint is
/// supplied by the caller (from `OG_RPC`), never hardcoded.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveGateSource {
    endpoint: String,
    registry: String,
}

#[cfg(feature = "live")]
impl LiveGateSource {
    /// `checkTransfer(address,address,uint256)` -- the v2-compatible selector.
    const SEL_CHECK_TRANSFER: &'static str = "cc1dd94f";
    /// `checkTransferTo(address,address,uint256,address)` -- the Tier 2/4 selector.
    const SEL_CHECK_TRANSFER_TO: &'static str = "697bb97c";

    /// Build a live gate reader against an RPC endpoint and a registry address.
    #[must_use]
    pub fn new(endpoint: impl Into<String>, registry: impl Into<String>) -> LiveGateSource {
        LiveGateSource { endpoint: endpoint.into(), registry: registry.into() }
    }

    /// The configured RPC endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The configured registry (gate) address.
    #[must_use]
    pub fn registry(&self) -> &str {
        &self.registry
    }

    /// Left-pad a 20-byte address to a 32-byte ABI word (no `0x`).
    fn address_word(addr: &str) -> Option<String> {
        let body = addr.trim().strip_prefix("0x").or_else(|| addr.trim().strip_prefix("0X")).unwrap_or(addr.trim());
        if body.len() != 40 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(format!("{:0>64}", body.to_ascii_lowercase()))
    }

    /// Encode a non-negative `i128` amount to a 32-byte ABI word.
    fn amount_word(amount: i128) -> Option<String> {
        if amount < 0 {
            return None;
        }
        Some(format!("{amount:064x}"))
    }

    /// Build the `eth_call` calldata for a probe (selector + ABI words). `None` for a malformed arg.
    fn encode(probe: &MandateProbe) -> Option<String> {
        let agent = Self::address_word(&probe.agent)?;
        let token = Self::address_word(&probe.token)?;
        let amount = Self::amount_word(probe.amount)?;
        let data = match &probe.spender {
            None => format!("0x{}{agent}{token}{amount}", Self::SEL_CHECK_TRANSFER),
            Some(spender) => {
                let sp = Self::address_word(spender)?;
                format!("0x{}{agent}{token}{amount}{sp}", Self::SEL_CHECK_TRANSFER_TO)
            }
        };
        Some(data)
    }

    /// Decode a `(bool ok, bytes32 reason)` `eth_call` return (two 32-byte words) into a
    /// [`GateObservation`]. `None` for a malformed reply (never coerced to a fabricated `ok`).
    fn decode(raw: &str) -> Option<GateObservation> {
        let hex = raw.trim().to_ascii_lowercase();
        let body = hex.strip_prefix("0x").unwrap_or(&hex);
        if body.len() != 128 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let ok_word = &body[0..64];
        let reason_word = &body[64..128];
        // ABI bool: the whole word is 0 (false) or ...01 (true).
        let ok = if ok_word.bytes().all(|b| b == b'0') {
            false
        } else if ok_word == "0000000000000000000000000000000000000000000000000000000000000001" {
            true
        } else {
            return None; // malformed bool
        };
        // bytes32 reason: left-aligned ASCII, stop at the first NUL.
        let mut reason = String::new();
        let bytes = reason_word.as_bytes();
        let mut i = 0;
        while i < 64 {
            let hi = (bytes[i] as char).to_digit(16)?;
            let lo = (bytes[i + 1] as char).to_digit(16)?;
            let b = (hi * 16 + lo) as u8;
            if b == 0 {
                break;
            }
            if !(0x20..=0x7e).contains(&b) {
                return None; // non-printable -> malformed tag
            }
            reason.push(b as char);
            i += 2;
        }
        Some(GateObservation { ok, reason })
    }

    /// POST one `eth_call` and return the raw hex `result`, or `None` on any transport/RPC failure.
    fn eth_call(&self, data: &str) -> Option<String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{ "to": self.registry, "data": data }, "latest"],
        });
        let response = ureq::post(&self.endpoint)
            .set("content-type", "application/json")
            .send_json(body)
            .ok()?;
        let value: serde_json::Value = response.into_json().ok()?;
        if value.get("error").is_some() {
            return None;
        }
        value.get("result")?.as_str().map(str::to_string)
    }
}

#[cfg(feature = "live")]
impl LiveGateSource {
    /// Read a probe live: encode -> eth_call -> decode. Loud `None` on any failure (never fabricate).
    fn read_probe(&mut self, probe: &MandateProbe) -> Option<GateObservation> {
        let data = Self::encode(probe)?;
        let raw = self.eth_call(&data)?;
        Self::decode(&raw)
    }
}

/// Confirm a probe against a LIVE gate read (the `live` build's end-to-end tier confirmation).
///
/// Mirrors [`confirm_tier_via`] but reads the chain itself via `eth_call`. An unreadable gate degrades
/// LOUDLY to [`TierVerdict::Unverified`] (design SS3 principle 3), never a fabricated `Confirmed`.
#[cfg(feature = "live")]
#[must_use]
pub fn confirm_tier_live(probe: &MandateProbe, source: &mut LiveGateSource) -> TierReport {
    let observed = source.read_probe(probe);
    confirm_tier(probe, observed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
    const TOKEN: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const ROUTER: &str = "0x3333333333333333333333333333333333333333";

    fn probe(tier: Tier, amount: i128, spender: Option<&str>, expected: ExpectedGate) -> MandateProbe {
        MandateProbe {
            tier,
            agent: AGENT.to_string(),
            token: TOKEN.to_string(),
            amount,
            spender: spender.map(str::to_string),
            expected,
        }
    }

    // --- the three tier verdicts (the alphabet) -------------------------------------------------

    #[test]
    fn confirmed_when_gate_read_matches_expected_block() {
        // Tier 1: an over-period probe expects (false, OVER_PERIOD_CAP); the gate reads back exactly
        // that -> Confirmed (the period tier IS enforced on-chain).
        let p = probe(Tier::PeriodCap, 1_000_000, None, ExpectedGate::blocked("OVER_PERIOD_CAP"));
        let obs = Some(GateObservation::new(false, "OVER_PERIOD_CAP"));
        let report = confirm_tier(&p, obs);
        assert_eq!(report.verdict, TierVerdict::Confirmed);
        assert_eq!(report.verdict_string(), "confirmed");
        assert_eq!(report.tier, Tier::PeriodCap);
    }

    #[test]
    fn confirmed_when_within_mandate_pass_matches() {
        // The within-mandate baseline: expect (true, "") and read it back -> Confirmed.
        let p = probe(Tier::WithinMandate, 1_000_000, None, ExpectedGate::ok());
        let report = confirm_tier(&p, Some(GateObservation::new(true, "")));
        assert_eq!(report.verdict, TierVerdict::Confirmed);
    }

    #[test]
    fn refuted_when_gate_answers_but_disagrees() {
        // The gate ANSWERS, but it let an over-cap probe PASS (ok=true) where we expected a block ->
        // Refuted (the tier is NOT enforced as designed) -- distinct from Unverified.
        let p = probe(Tier::AssetCap, 9_999_999, None, ExpectedGate::blocked("OVER_ASSET_CAP"));
        let report = confirm_tier(&p, Some(GateObservation::new(true, "")));
        assert_eq!(report.verdict, TierVerdict::Refuted, "a gate that lets an over-cap spend pass is refuted");
        assert_ne!(report.verdict, TierVerdict::Confirmed, "NEVER a fabricated confirmation");
    }

    #[test]
    fn refuted_when_blocked_for_the_wrong_reason() {
        // Blocked, but with a DIFFERENT reason than the tier expects -> Refuted (an exact match on the
        // reason tag is required; "blocked for some reason" is not enough).
        let p = probe(Tier::PeriodCap, 1_000_000, None, ExpectedGate::blocked("OVER_PERIOD_CAP"));
        let report = confirm_tier(&p, Some(GateObservation::new(false, "OVER_TX_CAP")));
        assert_eq!(report.verdict, TierVerdict::Refuted, "the wrong block-reason refutes the tier");
    }

    #[test]
    fn unverified_when_gate_read_is_unavailable_never_confirmed() {
        // The keystone (design SS3 principle 3): no gate read -> Unverified, never a fabricated
        // Confirmed -- no matter what the probe expected.
        let p = probe(Tier::Pause, 1_000_000, None, ExpectedGate::blocked("PAUSED"));
        let report = confirm_tier(&p, None);
        assert_eq!(report.verdict, TierVerdict::Unverified);
        assert_ne!(report.verdict, TierVerdict::Confirmed, "an unreadable gate must NEVER confirm");
        assert!(report.observed.is_none());
    }

    // --- the tape source (offline, deterministic) -----------------------------------------------

    #[test]
    fn tape_hit_confirms_and_off_tape_is_unverified() {
        // A recorded gate read confirms its tier; an off-tape probe degrades to Unverified.
        let p_block = probe(Tier::SpenderAllowlist, 1_000_000, Some(ROUTER), ExpectedGate::blocked("SPENDER_NOT_ALLOWED"));
        let key = GateKey::from_probe(&p_block);
        let mut tape = MandateTape::new().with(key, GateObservation::new(false, "SPENDER_NOT_ALLOWED"));

        let report = confirm_tier_via(&p_block, &mut tape);
        assert_eq!(report.verdict, TierVerdict::Confirmed);

        // A different probe (not on the tape) is Unverified.
        let p_other = probe(Tier::AssetCap, 7, None, ExpectedGate::blocked("OVER_ASSET_CAP"));
        let report2 = confirm_tier_via(&p_other, &mut tape);
        assert_eq!(report2.verdict, TierVerdict::Unverified, "an off-tape probe never confirms");
    }

    #[test]
    fn empty_tape_makes_every_tier_unverified() {
        let mut tape = MandateTape::new();
        assert!(tape.is_empty());
        let p = probe(Tier::DestCap, 1_000_000, Some(ROUTER), ExpectedGate::blocked("OVER_DEST_CAP"));
        assert_eq!(confirm_tier_via(&p, &mut tape).verdict, TierVerdict::Unverified);
    }

    #[test]
    fn gate_key_is_canonical_over_case_and_prefix() {
        // The key lowercases addresses + folds the spender, so a differently-cased probe hits the same
        // recorded slot (deterministic; design SS3 principle 4).
        let p = probe(Tier::AssetCap, 1_500_001, None, ExpectedGate::blocked("OVER_ASSET_CAP"));
        let key = GateKey::from_probe(&p);
        let mut tape = MandateTape::new().with(key, GateObservation::new(false, "OVER_ASSET_CAP"));
        // Same probe but with an UPPER-cased agent/token -> same key -> still confirms.
        let p_upper = MandateProbe {
            agent: AGENT.to_ascii_uppercase(),
            token: TOKEN.to_ascii_uppercase(),
            ..p.clone()
        };
        assert_eq!(confirm_tier_via(&p_upper, &mut tape).verdict, TierVerdict::Confirmed);
    }

    #[test]
    fn confirm_tier_is_deterministic() {
        let p = probe(Tier::PeriodCap, 1_000_000, None, ExpectedGate::blocked("OVER_PERIOD_CAP"));
        let obs = || Some(GateObservation::new(false, "OVER_PERIOD_CAP"));
        let first = confirm_tier(&p, obs());
        for _ in 0..8 {
            assert_eq!(confirm_tier(&p, obs()), first, "same inputs -> identical report");
        }
    }

    #[test]
    fn canonical_strings_are_exact_and_distinct() {
        assert_eq!(TierVerdict::confirmed().canonical_string(), "confirmed");
        assert_eq!(TierVerdict::refuted().canonical_string(), "refuted");
        assert_eq!(TierVerdict::unverified().canonical_string(), "unverified");
        assert!(TierVerdict::confirmed().is_confirmed());
        assert!(!TierVerdict::refuted().is_confirmed());
        assert!(!TierVerdict::unverified().is_confirmed());
    }

    #[test]
    fn tier_labels_are_stable() {
        assert_eq!(Tier::PeriodCap.label(), "tier1:period-cap");
        assert_eq!(Tier::Expiry.label(), "tier2:expiry");
        assert_eq!(Tier::SpenderAllowlist.label(), "tier2:spender-allowlist");
        assert_eq!(Tier::AssetCap.label(), "tier3:asset-cap");
        assert_eq!(Tier::Pause.label(), "tier3:pause");
        assert_eq!(Tier::UsdCap.label(), "tier3:usd-cap");
        assert_eq!(Tier::DestCap.label(), "tier4:dest-cap");
        assert_eq!(Tier::WithinMandate.label(), "tier4:within-mandate");
    }

    // --- the live decoder (feature-gated): the ABI codec is exact + never fabricates ------------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_round_trips_ok_and_blocked() {
        // (true, "") -- the within-mandate zero reason word.
        let ok_raw = format!("0x{}{}", "0".repeat(63) + "1", "0".repeat(64));
        let obs = LiveGateSource::decode(&ok_raw).expect("a well-formed ok reply decodes");
        assert!(obs.ok);
        assert_eq!(obs.reason, "");

        // (false, "OVER_PERIOD_CAP") -- bool word 0, reason = left-aligned ASCII of the tag.
        let tag = "OVER_PERIOD_CAP";
        let mut reason_hex = String::new();
        for b in tag.bytes() {
            reason_hex.push_str(&format!("{b:02x}"));
        }
        while reason_hex.len() < 64 {
            reason_hex.push('0');
        }
        let blocked_raw = format!("0x{}{}", "0".repeat(64), reason_hex);
        let obs2 = LiveGateSource::decode(&blocked_raw).expect("a well-formed blocked reply decodes");
        assert!(!obs2.ok);
        assert_eq!(obs2.reason, "OVER_PERIOD_CAP");
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_rejects_malformed_never_fabricates() {
        assert!(LiveGateSource::decode("0x").is_none(), "empty reply is malformed");
        assert!(LiveGateSource::decode("0xzz").is_none(), "non-hex is malformed");
        // A non-0/1 bool word is malformed (never coerced to ok).
        let bad_bool = format!("0x{}{}", "2".repeat(64), "0".repeat(64));
        assert!(LiveGateSource::decode(&bad_bool).is_none(), "a non-0/1 bool word must be rejected");
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_encode_selects_the_right_selector() {
        // No spender -> checkTransfer selector; with spender -> checkTransferTo selector.
        let p = probe(Tier::AssetCap, 1, None, ExpectedGate::blocked("OVER_ASSET_CAP"));
        let data = LiveGateSource::encode(&p).unwrap();
        assert!(data.starts_with("0xcc1dd94f"), "v2-shape uses checkTransfer 0xcc1dd94f");
        let p2 = probe(Tier::DestCap, 1, Some(ROUTER), ExpectedGate::blocked("OVER_DEST_CAP"));
        let data2 = LiveGateSource::encode(&p2).unwrap();
        assert!(data2.starts_with("0x697bb97c"), "Tier 2/4 uses checkTransferTo 0x697bb97c");
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoint_is_unverified_never_confirmed() {
        // The live reader is wired but pointed at an unreachable endpoint: the eth_call fails, so the
        // tier degrades LOUDLY to Unverified (design SS3 principle 3), never a fabricated Confirmed.
        let mut src = LiveGateSource::new("http://127.0.0.1:0", "0x675ff5053f434aa3f1d48574813bfc1696fbd345");
        let p = probe(Tier::PeriodCap, 1_000_000, None, ExpectedGate::blocked("OVER_PERIOD_CAP"));
        let report = confirm_tier_live(&p, &mut src);
        assert_eq!(report.verdict, TierVerdict::Unverified);
        assert_ne!(report.verdict, TierVerdict::Confirmed);
    }
}
