//! The SWAP verifier extension -- mint a settlement verdict for a Uniswap-V3 single-hop swap.
//!
//! Design SS2 (the Settlement proof): "an independent Rust verifier reads 0G via raw JSON-RPC and stamps
//! each trade settled / hollow / mismatch / unverified -- it never trusts the UI." Design WOW Feature 1
//! ("wrapped by the proofs"): after the swap is broadcast "the verifier reads 0G directly, decodes the
//! `Swap` event + realized deltas, and mints settled / hollow / mismatch / unverified -- never the
//! front-end's word."
//!
//! The MVP settlement leg ([`crate::verify_tx`]) adjudicates a transaction's native **value moved** (wei)
//! against a claim. A SWAP does not move native value -- it moves an ERC-20 *output token*, and the
//! amount actually received (`amountOut`) is carried in the pool's `Swap` event, NOT in `tx.value`. So a
//! SWAP needs its own *observation shape*: the realized `amountOut` decoded from the on-chain `Swap`
//! event. This module is that EXTENSION -- it reuses the exact-integer settlement algebra
//! ([`crate::adjudicate`]) and the one [`crate::Verdict`] monopoly, but reads a different on-chain fact.
//!
//! ## Two-source truth at the swap boundary (design SS3 principle 1)
//!
//! Exactly as the value verifier never trusts the UI for "did it settle", this never trusts the agent
//! (or the front-end) for "how much came out". The agent's [`SwapClaim`] is the **Claim** (what it
//! intended to receive, plus the on-chain `amountOutMinimum` floor it set); the verifier's own decode of
//! the realized `amountOut` from the `Swap` event is the **Observation**. They meet only in
//! [`adjudicate_swap`].
//!
//! ## The verdict alphabet, reused (design SS2 + SS3 principle 2, the verdict monopoly)
//!
//! A SWAP mints one of the SAME four [`crate::Verdict`]s -- there is no new verdict enum, so the swap
//! leg cannot widen the alphabet or escape the monopoly:
//!
//! - **`settled`**  -- a `Swap` event was decoded, `amountOut >= amountOutMinimum` (the on-chain floor
//!   held), AND `amountOut` is within the exact-integer tolerance band of the claimed `expectedOut`.
//! - **`hollow`**   -- the tx is on-record and succeeded but the swap moved *nothing*: no `Swap` event,
//!   or a decoded `amountOut == 0` (a "hollow" success -- e.g. a receipt with no realized output).
//! - **`mismatch`** -- a `Swap` event was decoded but the realized `amountOut` is below the on-chain
//!   floor (the slippage protection should have reverted -- a refuted economic outcome) OR it is outside
//!   the tolerance band of the claim. Either is a loud "the chain disagrees with the claim".
//! - **`unverified`** -- the chain could not be read (off-tape / unreadable / unknown tx). The loud,
//!   honest degrade target (design SS3 principle 3) -- never a fabricated `settled`.
//!
//! ## Never fabricate (design SS3 principle 3)
//!
//! An unavailable / unreadable swap read degrades LOUDLY to [`crate::Verdict::Unverified`] via the same
//! `observed == None -> Unverified` keystone the value leg uses -- it can never collapse into a
//! fabricated `settled`. A decoded `amountOut` *below* the floor is a real, loud `mismatch`, distinct
//! from "we could not read it".
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5)
//!
//! [`adjudicate_swap`] is pure over `(claim, observation)` -- no wall-clock, no global state. Every
//! amount (`amountOut`, the floor, the claimed `expectedOut`, the tolerance band) is an exact `i128` in
//! the output token's MINOR units; there is no float anywhere on this money path.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build adjudicates a swap against a deterministic, std-only [`SwapTape`] (a recorded
//! `Swap`-event read), so it needs no network. The `live` feature adds [`LiveSwapSource`] -- a real
//! `eth_getTransactionReceipt` reader that finds the pool's `Swap` log, decodes the realized
//! `amountOut`, and feeds the SAME algebra, the same raw-JSON-RPC shape the settlement
//! [`crate::LiveSource`] uses.

use crate::{adjudicate, Ratio, ReadKey, Verdict};
use core::fmt;
use std::collections::BTreeMap;

/// The canonical Uniswap-V3 pool `Swap` event topic0 (the keccak of the event signature).
///
/// `Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1,
/// uint160 sqrtPriceX96, uint128 liquidity, int24 tick)` -- the event Oku's Uniswap-V3 pools emit on
/// every swap (design WOW Feature 1: "parse `amountOut` / the `Swap` event"). The realized output is the
/// pool-NEGATIVE side of `(amount0, amount1)` -- the token leaving the pool to the recipient.
///
/// Pinned (not hashed at runtime) so the default build needs no keccak dependency and stays std-only /
/// offline (design SS6). Derivation (public, reproducible):
/// `cast keccak "Swap(address,address,int256,int256,uint160,uint128,int24)"` =>
/// `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` (the canonical Uniswap-V3 topic).
pub const SWAP_EVENT_TOPIC0: &str =
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/// The realized swap output, INDEPENDENTLY observed from the chain -- the **Observation** (design SS3
/// principle 1). This is the verifier's own decode of the `Swap` event, never the agent's word.
///
/// `amount_out` is the realized output in the output token's MINOR units (exact-integer, design SS3
/// principle 5). A value of `0` means "the tx is on-record and succeeded, but the swap moved nothing"
/// (the honest hollow input) -- distinct from the *absence* of an observation (a [`SwapSource`] read
/// that could not answer), which is modelled one level up as `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SwapObservation {
    /// The realized `amountOut` decoded from the `Swap` event, in the output token's MINOR units.
    amount_out: i128,
}

impl SwapObservation {
    /// Record an independently-observed realized `amountOut`, in minor units.
    #[must_use]
    pub const fn new(amount_out: i128) -> SwapObservation {
        SwapObservation { amount_out }
    }

    /// The realized output amount, in minor units.
    #[must_use]
    pub const fn amount_out(&self) -> i128 {
        self.amount_out
    }
}

/// The agent's recorded claim about a swap -- the **Claim** half of two-source truth (design SS3
/// principle 1). This is never trusted on its own; it is adjudicated against the verifier's own
/// `Swap`-event read.
///
/// All amounts are exact `i128` minor units of the OUTPUT token (design SS3 principle 5):
///
/// - `expected_out` -- the quoted output the agent expected (e.g. from `QuoterV2.quoteExactInputSingle`).
///   The realized `amountOut` is adjudicated against this with the exact-integer tolerance band.
/// - `amount_out_minimum` -- the ON-CHAIN slippage floor the agent set in `exactInputSingle`
///   (`amountOutMinimum`). The protocol itself reverts a swap whose output is below this, so a
///   *settled* swap must have `amountOut >= amount_out_minimum`; a decoded output below the floor is a
///   loud `mismatch` (the floor was the agent's own protocol-native protection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SwapClaim {
    /// The quoted/expected output (minor units) the realized output is adjudicated against.
    expected_out: i128,
    /// The on-chain `amountOutMinimum` slippage floor the agent set (minor units). A settled swap's
    /// realized output must be at or above this.
    amount_out_minimum: i128,
}

impl SwapClaim {
    /// Build a swap claim from the quoted `expected_out` and the on-chain `amount_out_minimum` floor.
    #[must_use]
    pub const fn new(expected_out: i128, amount_out_minimum: i128) -> SwapClaim {
        SwapClaim { expected_out, amount_out_minimum }
    }

    /// The quoted/expected output (minor units) -- the claim the realized output is adjudicated against.
    #[must_use]
    pub const fn expected_out(&self) -> i128 {
        self.expected_out
    }

    /// The on-chain `amountOutMinimum` slippage floor (minor units) -- a settled swap's realized output
    /// must be at or above this.
    #[must_use]
    pub const fn amount_out_minimum(&self) -> i128 {
        self.amount_out_minimum
    }
}

/// The result of verifying one swap: the claim, the independent observation (or `None` if unreadable),
/// and the minted [`Verdict`].
///
/// This is the swap analogue of [`crate::VerifyReport`]: it carries enough to *reproduce and audit* the
/// verdict -- the claimed/expected output, the on-chain floor, the realized output (or `None` -- the
/// loud absence), and the verdict the verifier minted -- and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapReport {
    /// The canonical `0x`-lowercase transaction hash this swap report is about.
    pub hash: String,
    /// The quoted/expected output (minor units) -- the agent's claim.
    pub expected_out: i128,
    /// The on-chain `amountOutMinimum` floor the agent set (minor units).
    pub amount_out_minimum: i128,
    /// The independently-observed realized `amountOut` (minor units), or `None` when the chain could
    /// not be read (the loud absence that adjudicates to [`Verdict::Unverified`]).
    pub amount_out: Option<i128>,
    /// The minted verdict -- the only place a swap verdict is created (the [`Verdict`] monopoly).
    pub verdict: Verdict,
}

impl SwapReport {
    /// The canonical verdict string (design SS2 alphabet): `settled / hollow / mismatch / unverified`.
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }
}

/// Adjudicate a swap: does the realized `amountOut` confirm the claimed swap, within its on-chain floor
/// and the exact-integer tolerance band?
///
/// The swap-settlement algebra (design SS3 principle 1, two-source truth; principle 5, exact-integer
/// money), evaluated strictly in order:
///
/// 1. `observed == None`                          -> [`Verdict::Unverified`]  (the keystone -- never
///    fabricate; an unreadable swap can never become a fabricated `settled`).
/// 2. `amount_out == 0`                           -> [`Verdict::Hollow`]      (on-record, but the swap
///    moved nothing -- no realized output).
/// 3. `amount_out < amount_out_minimum`           -> [`Verdict::Mismatch`]    (below the on-chain floor
///    the agent set -- the protocol's own slippage protection was violated; a refuted economic outcome).
/// 4. `|amount_out - expected_out| <= band`       -> [`Verdict::Settled`]     (within tolerance of the
///    quoted output -- the swap settled as claimed).
/// 5. else                                        -> [`Verdict::Mismatch`]    (above the floor but
///    outside the tolerance band of the claim).
///
/// The verdict is minted HERE -- through [`crate::adjudicate`] for the band check and the same
/// crate-private [`Verdict`] constructors elsewhere -- so the [`Verdict`] monopoly (design SS3
/// principle 2) is preserved: no caller outside the crate can construct a swap verdict, only obtain one.
///
/// Note the asymmetry vs the plain value leg: a swap that delivers *more* than expected is still settled
/// only if it is within the band (a wildly-over delivery is a `mismatch`, because it disagrees with the
/// claim) -- but it can NEVER be below the on-chain floor and settle, because step (3) rejects a
/// below-floor output before the band is even consulted. The floor is the hard protocol-native bound;
/// the band is the softer "as quoted" bound.
#[must_use]
pub fn adjudicate_swap(claim: &SwapClaim, observed: Option<SwapObservation>, tol: Ratio) -> Verdict {
    // (1) Keystone (design SS3 principle 3): no read -> Unverified, never a fabricated Settled.
    let Some(obs) = observed else {
        return Verdict::unverified();
    };
    let amount_out = obs.amount_out();

    // (2) Hollow: the swap is on-record but realized NOTHING (no output). Distinct from "unreadable".
    if amount_out == 0 {
        return Verdict::hollow();
    }

    // (3) Below the on-chain slippage floor the agent set -> Mismatch. The protocol itself should have
    // reverted such a swap; observing a below-floor realized output is a loud refuted economic outcome,
    // checked BEFORE the softer band so a below-floor output can never settle.
    if amount_out < claim.amount_out_minimum() {
        return Verdict::mismatch();
    }

    // (4) + (5) Band check against the quoted/expected output -- the exact-integer settlement algebra,
    // reused verbatim (design SS3 principle 1 + 5). Within band -> Settled; outside -> Mismatch. The
    // verdict is minted by `adjudicate` (the value leg's algebra), preserving the verdict monopoly.
    adjudicate(claim.expected_out(), Some(amount_out), tol)
}

// =================================================================================================
// The swap read seam -- the independent Observation source (mirrors the settlement `Source` trait).
// =================================================================================================

/// The independent swap-read seam -- the **Observation** source for a swap (design SS3 principle 1).
///
/// `read_swap` returns `Some(observation)` when the chain answered (a `Swap` event was found + decoded),
/// or `None` when it could not (off-tape / unreadable / unknown tx) -- never a fabricated observation
/// (design SS3 principle 3). A taped replay and a live `eth_getTransactionReceipt` reader both satisfy
/// it, so swapping one for the other never changes what a swap verdict MEANS.
///
/// `read_swap` takes `&mut self` so a live implementation may hold and mutate a connection; [`SwapTape`]
/// does not need the mutability but honors the same signature so the two are drop-in interchangeable.
pub trait SwapSource {
    /// Read the realized `Swap`-event output for the transaction named by `key`. `None` is the loud
    /// honest absence (design SS3 principle 3).
    fn read_swap(&mut self, key: &ReadKey) -> Option<SwapObservation>;
}

/// A deterministic, std-only replay of recorded `Swap`-event reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from [`ReadKey`] to
/// [`SwapObservation`]. A keyed read replays its exact recording; an unrecorded key is `None` (we have
/// no recording, so we refuse to invent one -- design SS3 principle 3). Because the map is ordered and
/// the lookup is pure, the same tape always answers a given key identically, with no network and no
/// wall-clock -- the tape IS the recorded chain, frozen.
#[derive(Debug, Clone, Default)]
pub struct SwapTape {
    tape: BTreeMap<ReadKey, SwapObservation>,
}

impl SwapTape {
    /// An empty tape -- every swap read is `None` (unverified).
    #[must_use]
    pub fn new() -> SwapTape {
        SwapTape { tape: BTreeMap::new() }
    }

    /// Record a swap observation for a key, returning the tape for chaining. Re-recording a key
    /// overwrites it (the tape is the single source of recorded truth for that key).
    #[must_use]
    pub fn with(mut self, key: ReadKey, obs: SwapObservation) -> SwapTape {
        self.tape.insert(key, obs);
        self
    }

    /// Record a swap observation for a key in place.
    pub fn record(&mut self, key: ReadKey, obs: SwapObservation) {
        self.tape.insert(key, obs);
    }

    /// How many swap reads are recorded on this tape.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff the tape has no recorded swap reads.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl SwapSource for SwapTape {
    fn read_swap(&mut self, key: &ReadKey) -> Option<SwapObservation> {
        self.tape.get(key).copied()
    }
}

/// Verify one swap end-to-end: read the realized output from `source`, adjudicate against the claim.
///
/// This is the swap analogue of [`crate::verify_tx`]: the agent's [`SwapClaim`] is the Claim, the
/// decoded `Swap`-event output is the Observation, and [`adjudicate_swap`] mints the verdict. An
/// unreadable swap degrades to [`Verdict::Unverified`] -- never a fabricated `settled` (design SS3
/// principle 3). It returns a [`SwapReport`] carrying the inputs that produced the verdict.
///
/// The `hash` is normalized to the one canonical [`ReadKey`] shape; a malformed hash is `None` (the
/// caller has supplied a string that is not a transaction hash). Use [`ReadKey::new`] at the boundary if
/// you need to distinguish a malformed hash from an unreadable one.
#[must_use]
pub fn verify_swap(
    key: &ReadKey,
    claim: &SwapClaim,
    tol: Ratio,
    source: &mut dyn SwapSource,
) -> SwapReport {
    let observed = source.read_swap(key);
    let verdict = adjudicate_swap(claim, observed, tol);
    SwapReport {
        hash: key.tx_hash().to_string(),
        expected_out: claim.expected_out(),
        amount_out_minimum: claim.amount_out_minimum(),
        amount_out: observed.map(|o| o.amount_out()),
        verdict,
    }
}

// =================================================================================================
// LiveSwapSource -- the real eth_getTransactionReceipt reader. Behind the `live` feature ONLY (SS6).
// =================================================================================================

/// A live `Swap`-event reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`SwapTape`]: it POSTs `eth_getTransactionReceipt(hash)` to the 0G
/// RPC, finds the pool's `Swap` log (topic0 == [`SWAP_EVENT_TOPIC0`]), and decodes the realized
/// `amountOut` from the event data -- the pool-NEGATIVE side of `(amount0, amount1)` (the token leaving
/// the pool to the recipient). It is feature-gated so the default build pulls in no network dependency
/// and stays fully offline (design SS6). The endpoint is supplied by the caller (from `OG_RPC`), never
/// hardcoded.
///
/// ## How it stays honest (design SS3 principle 3, never fabricate)
///
/// - A `null` receipt (unknown / unmined tx) -> `None` (the chain has no record; degrade loudly).
/// - A receipt with `status == 0x0` (reverted) -> `Some(SwapObservation::new(0))` -- the swap settled
///   *nothing* (the honest hollow input), never an `Unavailable` and never a fabricated nonzero.
/// - A successful receipt with NO `Swap` log -> `Some(SwapObservation::new(0))` -- on-record but no
///   realized output (also hollow), distinct from "unreadable".
/// - A successful receipt with a `Swap` log -> decode the realized `amountOut`; any malformed /
///   out-of-`i128`-range data -> `None` (loud), never a truncated/wrapped (fabricated) amount.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveSwapSource {
    endpoint: String,
}

#[cfg(feature = "live")]
impl LiveSwapSource {
    /// Build a live swap reader against a JSON-RPC endpoint URL (from `OG_RPC`; never hardcoded).
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> LiveSwapSource {
        LiveSwapSource { endpoint: endpoint.into() }
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

/// Decode the realized swap output from a `Swap`-event data blob.
///
/// The `Swap` event has FOUR non-indexed words in `data` (the indexed `sender`/`recipient` are topics):
/// `int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick` -- so `data`
/// is 5 words; the first two are the signed token deltas from the POOL's perspective. The realized
/// output is the magnitude of the NEGATIVE delta (the token the pool sent OUT to the recipient).
///
/// Returns the realized `amountOut` as a non-negative `i128` of minor units, or `None` for a malformed
/// blob or an out-of-`i128`-range magnitude (never a wrapped/fabricated amount; design SS3 principle 3 +
/// 5). If both deltas are non-negative (no token left the pool) the realized output is `0` (hollow).
#[cfg(feature = "live")]
fn decode_swap_amount_out(data_hex: &str) -> Option<i128> {
    let body = data_hex.trim().strip_prefix("0x").or_else(|| data_hex.trim().strip_prefix("0X"))?;
    if body.len() < 128 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None; // need at least the two int256 deltas (2 * 64 hex)
    }
    let amount0 = decode_int256_word(&body[0..64])?;
    let amount1 = decode_int256_word(&body[64..128])?;
    // The pool-NEGATIVE side is the token sent OUT to the recipient. Take the magnitude of whichever is
    // negative; if neither is negative, nothing left the pool -> 0 (hollow).
    let out = if amount0 < 0 {
        amount0.checked_abs()?
    } else if amount1 < 0 {
        amount1.checked_abs()?
    } else {
        0
    };
    Some(out)
}

/// Decode one 32-byte ABI word as a two's-complement `int256`, into an `i128`.
///
/// 0G swap amounts are far inside `i128` for any realistic balance, so an out-of-`i128`-range value
/// signals a malformed/hostile blob, not a real swap -> `None` (never wrapped). A negative value is a
/// word whose top bit is set (two's complement): its magnitude is `2^256 - word`, which we compute by
/// summing the bit-complement plus one only for the low 128 bits that fit -- but since we only accept
/// values within `i128` range, we reconstruct the signed magnitude directly from the low bytes when the
/// high bytes are all-`f` (negative) or all-`0` (positive), rejecting anything else as out of range.
#[cfg(feature = "live")]
fn decode_int256_word(word: &str) -> Option<i128> {
    // word is 64 hex chars (32 bytes). The top bit (first hex nibble >= 8) indicates a negative int256.
    let bytes = word.as_bytes();
    let negative = (bytes[0] as char).to_digit(16)? >= 8;
    // The high 16 bytes (32 hex) must be the sign extension: all 'f' for negative, all '0' for positive,
    // so the magnitude fits in the low 16 bytes (i128 range). Anything else is out of i128 range.
    let high = &word[0..32];
    let low = &word[32..64];
    if negative {
        if !high.bytes().all(|b| b == b'f' || b == b'F') {
            return None; // magnitude exceeds i128 range
        }
        // Two's complement of the low 128 bits: value = -(2^128 - low) = low - 2^128.
        let low_val = u128::from_str_radix(low, 16).ok()?;
        // low - 2^128, as i128. low_val is in [0, 2^128); the result is in [-2^128, 0).
        // Compute as i128 via wrapping: (low_val as i128) since u128->i128 wraps to the two's-complement
        // i128 of the same bit pattern -- which is exactly low - 2^128 for the negative range.
        Some(low_val as i128)
    } else {
        if !high.bytes().all(|b| b == b'0') {
            return None; // magnitude exceeds i128 range
        }
        let low_val = u128::from_str_radix(low, 16).ok()?;
        if low_val > i128::MAX as u128 {
            return None;
        }
        Some(low_val as i128)
    }
}

#[cfg(feature = "live")]
impl SwapSource for LiveSwapSource {
    fn read_swap(&mut self, key: &ReadKey) -> Option<SwapObservation> {
        // (1) The receipt is the source of truth for "did this settle + what logs did it emit".
        let receipt = self.rpc_call("eth_getTransactionReceipt", serde_json::json!([key.tx_hash()]))?;
        if receipt.is_null() {
            return None; // unknown / unmined tx -> loud absence -> unverified
        }
        // (2) A reverted tx settled NOTHING -> hollow (an on-record read of 0), never Unavailable.
        match receipt.get("status").and_then(serde_json::Value::as_str) {
            Some("0x0") => return Some(SwapObservation::new(0)),
            Some("0x1") => {}
            _ => return None, // missing / malformed status -> loud absence
        }
        // (3) Find the pool's `Swap` log (topic0 == SWAP_EVENT_TOPIC0) and decode the realized output.
        let logs = receipt.get("logs").and_then(serde_json::Value::as_array)?;
        for log in logs {
            let topic0 = log
                .get("topics")
                .and_then(serde_json::Value::as_array)
                .and_then(|t| t.first())
                .and_then(serde_json::Value::as_str);
            if topic0.map(|t| t.eq_ignore_ascii_case(SWAP_EVENT_TOPIC0)) == Some(true) {
                let data = log.get("data").and_then(serde_json::Value::as_str)?;
                let amount_out = decode_swap_amount_out(data)?;
                return Some(SwapObservation::new(amount_out));
            }
        }
        // (4) Success but NO Swap event -> on-record, realized nothing -> hollow (not Unavailable).
        Some(SwapObservation::new(0))
    }
}

/// Render a [`SwapReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for SwapReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let observed = match self.amount_out {
            Some(v) => v.to_string(),
            None => "<unavailable>".to_string(),
        };
        write!(
            f,
            "SWAP {} expected_out={} floor={} amount_out={} -> {}",
            self.hash,
            self.expected_out,
            self.amount_out_minimum,
            observed,
            self.verdict_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";
    const HASH_B: &str = "0xdef0000000000000000000000000000000000000000000000000000000000002";

    fn key(h: &str) -> ReadKey {
        ReadKey::new(h).expect("test hash is well-formed")
    }

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    // --- the FOUR verdicts (the alphabet, design SS2) reused for the swap -------------------------

    #[test]
    fn settled_when_realized_output_is_within_band_and_above_floor() {
        // expected 1000, floor 900, observed 1100: 1100 >= floor AND |1100-1000|=100 <= floor(150) band.
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(1_100)), band_15pct());
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn hollow_when_realized_output_is_zero() {
        // On-record but the swap moved nothing -> Hollow (distinct from unreadable).
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(0)), band_15pct());
        assert_eq!(v, Verdict::Hollow);
    }

    #[test]
    fn mismatch_when_realized_output_is_below_the_on_chain_floor() {
        // observed 800 < floor 900 -> Mismatch (the protocol's own slippage floor was violated). This is
        // checked BEFORE the band, so a below-floor output can NEVER settle even if it were near expected.
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(800)), band_15pct());
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn mismatch_when_above_floor_but_outside_the_band() {
        // observed 1300 >= floor 900, but |1300-1000|=300 > floor(150) band -> Mismatch.
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(1_300)), band_15pct());
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn unverified_when_no_observation_never_settled() {
        // THE KEYSTONE (design SS3 principle 3): an unreadable swap -> Unverified, never a fabricated
        // settled, no matter the claim.
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, None, band_15pct());
        assert_eq!(v, Verdict::Unverified);
        assert_ne!(v, Verdict::Settled);
    }

    #[test]
    fn floor_dominates_band_a_below_floor_output_near_expected_is_still_mismatch() {
        // The asymmetry: even an output EXACTLY equal to `expected` settles only if it is at/above the
        // floor. Here floor 1100 > expected 1000; observed 1000 == expected (band would pass) but is
        // below the floor -> Mismatch. The hard protocol floor wins over the soft band.
        let claim = SwapClaim::new(1_000, 1_100);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(1_000)), band_15pct());
        assert_eq!(v, Verdict::Mismatch, "below the on-chain floor never settles, even at expected");
    }

    #[test]
    fn settled_at_the_floor_boundary() {
        // observed exactly == floor, and within band -> Settled (the floor is inclusive: >=).
        // expected 1000, floor 900, observed 900: 900 >= 900 AND |900-1000|=100 <= 150 -> Settled.
        let claim = SwapClaim::new(1_000, 900);
        let v = adjudicate_swap(&claim, Some(SwapObservation::new(900)), band_15pct());
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn adjudicate_swap_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let claim = SwapClaim::new(1_000, 900);
        for _ in 0..8 {
            assert_eq!(adjudicate_swap(&claim, Some(SwapObservation::new(1_100)), band_15pct()), Verdict::Settled);
            assert_eq!(adjudicate_swap(&claim, Some(SwapObservation::new(800)), band_15pct()), Verdict::Mismatch);
            assert_eq!(adjudicate_swap(&claim, Some(SwapObservation::new(0)), band_15pct()), Verdict::Hollow);
            assert_eq!(adjudicate_swap(&claim, None, band_15pct()), Verdict::Unverified);
        }
    }

    // --- the swap tape (offline, deterministic) --------------------------------------------------

    #[test]
    fn tape_hit_verifies_and_off_tape_is_unverified() {
        let claim = SwapClaim::new(1_000, 900);
        let mut tape = SwapTape::new().with(key(HASH_A), SwapObservation::new(1_100));

        let report = verify_swap(&key(HASH_A), &claim, band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Settled);
        assert_eq!(report.verdict_string(), "settled");
        assert_eq!(report.amount_out, Some(1_100));
        assert_eq!(report.hash, HASH_A);

        // An off-tape tx is Unverified (never a fabricated settled).
        let report2 = verify_swap(&key(HASH_B), &claim, band_15pct(), &mut tape);
        assert_eq!(report2.verdict, Verdict::Unverified);
        assert_eq!(report2.amount_out, None);
        assert_ne!(report2.verdict, Verdict::Settled);
    }

    #[test]
    fn empty_tape_makes_every_swap_unverified() {
        let mut tape = SwapTape::new();
        assert!(tape.is_empty());
        assert_eq!(tape.len(), 0);
        let claim = SwapClaim::new(1_000, 900);
        let report = verify_swap(&key(HASH_A), &claim, band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Unverified);
    }

    #[test]
    fn swap_tape_read_is_deterministic_and_record_overwrites() {
        let mut tape = SwapTape::new();
        tape.record(key(HASH_A), SwapObservation::new(1));
        tape.record(key(HASH_A), SwapObservation::new(2)); // overwrites
        assert_eq!(tape.read_swap(&key(HASH_A)), Some(SwapObservation::new(2)));
        assert_eq!(tape.len(), 1);
        // The same key answers identically, every time.
        let first = tape.read_swap(&key(HASH_A));
        for _ in 0..8 {
            assert_eq!(tape.read_swap(&key(HASH_A)), first);
        }
    }

    #[test]
    fn swap_tape_is_a_dyn_source() {
        // The seam is object-safe: a SwapTape works through &mut dyn SwapSource, so a live + a taped
        // reader are drop-in interchangeable behind one trait.
        let mut tape = SwapTape::new().with(key(HASH_A), SwapObservation::new(5));
        let dynamic: &mut dyn SwapSource = &mut tape;
        assert_eq!(dynamic.read_swap(&key(HASH_A)), Some(SwapObservation::new(5)));
        assert_eq!(dynamic.read_swap(&key(HASH_B)), None);
    }

    #[test]
    fn report_renders_for_the_journal() {
        let claim = SwapClaim::new(1_000, 900);
        let mut tape = SwapTape::new().with(key(HASH_A), SwapObservation::new(1_100));
        let report = verify_swap(&key(HASH_A), &claim, band_15pct(), &mut tape);
        let line = report.to_string();
        assert!(line.contains("SWAP"));
        assert!(line.contains("amount_out=1100"));
        assert!(line.contains("settled"));
        // An unavailable read renders the loud absence, never a number.
        let report2 = verify_swap(&key(HASH_B), &claim, band_15pct(), &mut tape);
        assert!(report2.to_string().contains("<unavailable>"));
        assert!(report2.to_string().contains("unverified"));
    }

    #[test]
    fn swap_topic0_is_the_canonical_uniswap_v3_swap_event() {
        // Pinned topic0 -- the canonical keccak of the V3 Swap event signature (conformance).
        assert_eq!(
            SWAP_EVENT_TOPIC0,
            "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
        );
        assert_eq!(SWAP_EVENT_TOPIC0.len(), 66, "0x + 32-byte (64 hex) topic");
    }

    // --- the live decoder (feature-gated): the int256 codec is exact + never fabricates -----------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_amount_out_picks_the_negative_pool_delta() {
        // amount0 positive (token IN to pool), amount1 negative (token OUT to recipient): the realized
        // output is |amount1|. amount0 = +1000 (0x...3e8), amount1 = -1100 (two's complement).
        let amount0 = format!("{:0>64x}", 1_000u128); // positive
        // -1100 as int256: 2^256 - 1100. High 16 bytes all 'f', low 16 bytes = 2^128 - 1100.
        let low = (0u128.wrapping_sub(1_100u128)) & u128::MAX; // = 2^128 - 1100
        let amount1 = format!("{}{:032x}", "f".repeat(32), low);
        let data = format!("0x{amount0}{amount1}{}", "0".repeat(64 * 3)); // + sqrtPrice, liq, tick words
        assert_eq!(super::decode_swap_amount_out(&data), Some(1_100));
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_amount_out_is_zero_when_nothing_left_the_pool() {
        // Both deltas non-negative -> nothing went OUT -> realized 0 (hollow input).
        let amount0 = format!("{:0>64x}", 1_000u128);
        let amount1 = format!("{:0>64x}", 5u128);
        let data = format!("0x{amount0}{amount1}{}", "0".repeat(64 * 3));
        assert_eq!(super::decode_swap_amount_out(&data), Some(0));
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_rejects_malformed_never_fabricates() {
        assert_eq!(super::decode_swap_amount_out("0x"), None, "empty blob is malformed");
        assert_eq!(super::decode_swap_amount_out("0xzz"), None, "non-hex is malformed");
        // A magnitude that exceeds i128 range (high bytes not pure sign-extension) -> None, never wrapped.
        let oversized_neg = format!("0x{}{}{}", "f".repeat(31), "e", "0".repeat(96)); // high not all-f
        // build a 5-word blob with a malformed first delta
        let blob = format!("{oversized_neg}{}", "0".repeat(64 * 3));
        assert_eq!(super::decode_swap_amount_out(&blob), None);
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_int256_round_trips_small_signed_values() {
        // +5
        let pos = format!("{:0>64x}", 5u128);
        assert_eq!(super::decode_int256_word(&pos), Some(5));
        // -5 (two's complement): high all 'f', low = 2^128 - 5.
        let low = 0u128.wrapping_sub(5u128);
        let neg = format!("{}{:032x}", "f".repeat(32), low);
        assert_eq!(super::decode_int256_word(&neg), Some(-5));
        // 0
        let zero = "0".repeat(64);
        assert_eq!(super::decode_int256_word(&zero), Some(0));
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoint_is_unverified_never_settled() {
        // The live reader is wired but pointed at an unreachable endpoint: the read fails, so the swap
        // degrades LOUDLY to Unverified (design SS3 principle 3), never a fabricated Settled.
        let mut src = LiveSwapSource::new("http://127.0.0.1:0");
        assert_eq!(src.endpoint(), "http://127.0.0.1:0");
        let claim = SwapClaim::new(1_000, 900);
        let report = verify_swap(&key(HASH_A), &claim, band_15pct(), &mut src);
        assert_eq!(report.verdict, Verdict::Unverified);
        assert_ne!(report.verdict, Verdict::Settled);
        assert_eq!(report.amount_out, None);
    }
}
