//! The `Source` trait -- two-source truth at the read boundary (the Source/Tape pivot).
//!
//! Design SS3 principle 1 (two-source truth): "The agent's report of an action is a **Claim**
//! (never trusted). The verifier's independent on-chain read is the **Observation**." A [`Source`]
//! is exactly that independent read leg: given a [`ReadKey`] (which on-chain fact to look up) it
//! returns an [`Observation`] (what the chain says) or, if the chain cannot answer, an
//! `Unavailable(reason)` -- it never invents an answer.
//!
//! Design SS3 principle 3 (never fabricate): an off-record, unreadable, or unavailable read is
//! surfaced *loudly* as [`ReadResult::Unavailable`]. The [`observed_amount`] bridge converts that to
//! `None`, which [`crate::adjudicate`] maps to [`crate::Verdict::Unverified`] -- never a fabricated
//! [`crate::Verdict::Settled`]. The whole point of the pivot is that "we could not read it" and "it settled"
//! are *different code paths* that can never be confused.
//!
//! Design SS3 principle 4 (deterministic): the in-repo [`TapeSource`] replays from an ordered
//! [`BTreeMap`], so a given key always yields a byte-identical observation (or the same
//! `Unavailable`) with no wall-clock and no network. This is what makes a verdict reproducible: the
//! tape *is* the recorded chain, frozen.
//!
//! ## The Source/Tape pivot
//!
//! The verifier reads the chain through one narrow seam -- [`Source::read`]. Two implementations sit
//! behind it:
//!
//! - [`TapeSource`] -- a deterministic, std-only **replay** of recorded on-chain reads. The default
//!   build uses only this; it needs no network. An off-tape key is `Unavailable` (we do **not** have
//!   a recording, so we must not pretend to).
//! - [`LiveSource`] -- a real JSON-RPC reader, compiled **only** behind the `live` cargo feature so
//!   the default build stays offline and std-only (design SS6, clean-room / offline-by-default).
//!
//! Because both go through the same trait and both feed the same `Unavailable -> Unverified` bridge,
//! swapping a live read for a taped one never changes the *meaning* of a verdict -- only its source.

use core::fmt;
use std::collections::BTreeMap;

/// The key for an independent on-chain read: *which* fact the verifier looks up.
///
/// At this step the only readable fact is a transaction's settled value, keyed by its hash, so a
/// `ReadKey` wraps a normalized transaction hash. It is a distinct newtype (not a bare `String`) so
/// the read seam is type-checked: you cannot pass a raw, un-normalized string where a key is
/// expected, and the tape and a live reader agree on exactly one canonical key shape.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReadKey {
    /// Canonical `0x`-prefixed lowercase transaction hash (see [`ReadKey::new`]).
    tx_hash: String,
}

impl ReadKey {
    /// Build a read key from a transaction hash, normalizing it to the one canonical shape.
    ///
    /// Normalization is deterministic (design SS3 principle 4) and total over its accepted domain:
    /// surrounding whitespace is trimmed, hex is lowercased, and a missing `0x` prefix is added. The
    /// result is `Some` only for a well-formed 32-byte hash (`0x` + 64 hex digits); anything else is
    /// `None` so a malformed key can never silently key a wrong (or empty) tape slot.
    ///
    /// Returning `None` rather than a "best effort" key matters for design SS3 principle 3: a
    /// garbage key must not become a *lookup that misses and reads as a real off-chain absence*; the
    /// caller is told up front the key is malformed.
    #[must_use]
    pub fn new(tx_hash: &str) -> Option<ReadKey> {
        let t = tx_hash.trim();
        // Accept with or without the 0x prefix; normalize to lowercase, always-0x-prefixed.
        let body = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
        if body.len() != 64 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut s = String::with_capacity(66);
        s.push_str("0x");
        for b in body.bytes() {
            // ASCII-only lowercasing -- deterministic, locale-independent.
            s.push(b.to_ascii_lowercase() as char);
        }
        Some(ReadKey { tx_hash: s })
    }

    /// The canonical `0x`-prefixed lowercase transaction hash this key looks up.
    #[must_use]
    pub fn tx_hash(&self) -> &str {
        &self.tx_hash
    }
}

impl fmt::Display for ReadKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tx_hash)
    }
}

/// An independent on-chain read result: what the chain says, for one [`ReadKey`].
///
/// Design SS3 principle 1: this is the **Observation** half of two-source truth -- the verifier's
/// own read, never the agent's claim. At this step it carries the settled value in minor units
/// (token base units / wei), the exact-integer shape [`crate::adjudicate`] consumes (design SS3
/// principle 5, no float on the money path).
///
/// `Observation::value` is `Some(0)` for a transaction that is on-record but moved nothing (the
/// honest "hollow" input), and the *absence of an observation entirely* is modelled one level up by
/// [`ReadResult::Unavailable`] -- the two are deliberately not the same value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Observation {
    /// The independently-read settled amount, in minor units. `0` means "on-record, moved nothing".
    value: i128,
}

impl Observation {
    /// Record an observed settled amount, in minor units.
    #[must_use]
    pub const fn new(value: i128) -> Observation {
        Observation { value }
    }

    /// The observed settled amount, in minor units.
    #[must_use]
    pub const fn value(&self) -> i128 {
        self.value
    }
}

/// Why an independent read could not produce an [`Observation`].
///
/// Design SS3 principle 3 (never fabricate): every reason here is a *loud honest absence*. None of
/// them is ever silently treated as a settlement -- they all flow to [`crate::Verdict::Unverified`] via the
/// [`observed_amount`] bridge. The reason exists for the human-readable journal, not to change the
/// verdict (an `Unavailable` is an `Unverified`, whatever the reason).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Unavailable {
    /// The key is not on the tape -- we have no recording of this read, so we will not invent one.
    OffTape {
        /// The key that missed, for the journal.
        key: ReadKey,
    },
    /// A live read leg is not wired in this build (the `live` feature is off, or the reader is a
    /// not-yet-implemented skeleton). The honest answer is "this build cannot read the chain", not
    /// a fabricated result.
    NotWired {
        /// A short, deterministic explanation for the journal.
        detail: &'static str,
    },
    /// A live read was attempted but the transport/endpoint failed (no network, RPC error, malformed
    /// response). Reserved for the `live` leg; the default build never produces it.
    Transport {
        /// A short, deterministic explanation for the journal.
        detail: String,
    },
}

impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unavailable::OffTape { key } => write!(f, "off-tape: no recorded read for {key}"),
            Unavailable::NotWired { detail } => write!(f, "not wired: {detail}"),
            Unavailable::Transport { detail } => write!(f, "transport: {detail}"),
        }
    }
}

/// The result of a [`Source::read`]: either an [`Observation`], or a loud [`Unavailable`] reason.
///
/// This is intentionally **not** [`std::result::Result`]: there is no "error to handle and recover
/// from" here, only the two-source-truth dichotomy "the chain answered" vs "the chain did not". The
/// `Unavailable` arm is a first-class, expected outcome (design SS3 principle 3), not an exception.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadResult<T> {
    /// The chain answered: an independent observation.
    Ok(T),
    /// The chain did not answer; the loud, honest reason. Flows to [`crate::Verdict::Unverified`].
    Unavailable(Unavailable),
}

impl<T> ReadResult<T> {
    /// `true` iff this is the `Ok` arm (an observation was read).
    #[must_use]
    pub const fn is_ok(&self) -> bool {
        matches!(self, ReadResult::Ok(_))
    }

    /// `true` iff this is the `Unavailable` arm (a loud honest absence).
    #[must_use]
    pub const fn is_unavailable(&self) -> bool {
        matches!(self, ReadResult::Unavailable(_))
    }

    /// Borrow the observation, if any. `None` for an `Unavailable` read -- which is precisely the
    /// shape [`crate::adjudicate`] degrades to [`crate::Verdict::Unverified`].
    #[must_use]
    pub const fn observation(&self) -> Option<&T> {
        match self {
            ReadResult::Ok(t) => Some(t),
            ReadResult::Unavailable(_) => None,
        }
    }
}

/// The independent on-chain read seam -- the **Observation** source of two-source truth.
///
/// Design SS3 principle 1: a `Source` is the verifier's *own* read of the chain. It is the only way
/// an [`Observation`] enters the verifier; the agent's claim enters by a different door entirely, and
/// [`crate::adjudicate`] is where the two meet. Keeping the read behind one trait is what lets a
/// taped replay and a live JSON-RPC read be interchangeable without changing what a verdict *means*.
///
/// `read` takes `&mut self` so a live implementation may hold and mutate a connection/transport;
/// [`TapeSource`] does not need the mutability but honors the same signature so the two are drop-in
/// interchangeable.
pub trait Source {
    /// Read the chain for the fact named by `key`.
    ///
    /// Returns [`ReadResult::Ok`] with the [`Observation`] if the chain answers, or
    /// [`ReadResult::Unavailable`] with a loud reason if it cannot -- **never** a fabricated
    /// observation standing in for a missing read (design SS3 principle 3).
    fn read(&mut self, key: &ReadKey) -> ReadResult<Observation>;
}

/// A deterministic, std-only replay of recorded on-chain reads -- the default (offline) source.
///
/// Design SS3 principle 4 (deterministic) + the Source/Tape pivot: the tape is an **ordered**
/// [`BTreeMap`] from [`ReadKey`] to [`Observation`]. A key on the tape replays its exact recorded
/// observation; a key *off* the tape is [`Unavailable::OffTape`] -- we have no recording, so we
/// refuse to invent one (design SS3 principle 3). Because the map is ordered and the lookup is pure,
/// the same tape always answers a given key identically, with no network and no wall-clock.
#[derive(Debug, Clone, Default)]
pub struct TapeSource {
    tape: BTreeMap<ReadKey, Observation>,
}

impl TapeSource {
    /// An empty tape -- every read is `Unavailable::OffTape`.
    #[must_use]
    pub fn new() -> TapeSource {
        TapeSource { tape: BTreeMap::new() }
    }

    /// Record an observation for a key, returning the tape for chaining. Re-recording a key
    /// overwrites it (the tape is the single source of recorded truth for that key).
    #[must_use]
    pub fn with(mut self, key: ReadKey, observation: Observation) -> TapeSource {
        self.tape.insert(key, observation);
        self
    }

    /// Record an observation for a key in place.
    pub fn record(&mut self, key: ReadKey, observation: Observation) {
        self.tape.insert(key, observation);
    }

    /// How many reads are recorded on this tape.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff the tape has no recorded reads.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl Source for TapeSource {
    fn read(&mut self, key: &ReadKey) -> ReadResult<Observation> {
        match self.tape.get(key) {
            // A recorded read replays exactly (Observation is Copy).
            Some(obs) => ReadResult::Ok(*obs),
            // Off-tape: we have no recording. Loud, honest absence -- NEVER a fabricated value
            // (design SS3 principle 3). This is the keystone that becomes Unverified downstream.
            None => ReadResult::Unavailable(Unavailable::OffTape { key: key.clone() }),
        }
    }
}

/// The bridge from an independent read to the [`crate::adjudicate`] money path.
///
/// Design SS3 principle 1 + 3: this is where the **Observation** half of two-source truth is handed
/// to the algebra. A read that produced an observation becomes `Some(value)`; an `Unavailable` read
/// becomes `None`. Passing that `None` to [`crate::adjudicate`] yields [`crate::Verdict::Unverified`] -- so
/// an off-record / unreadable read flows *only* to `Unverified`, never to a fabricated `Settled`.
///
/// This function is the single, audited choke point for that conversion; nothing else in the crate
/// turns an `Unavailable` into a numeric amount, so the "never fabricate" invariant lives in one
/// place.
#[must_use]
pub fn observed_amount(read: &ReadResult<Observation>) -> Option<i128> {
    read.observation().map(Observation::value)
}

// ---------------------------------------------------------------------------------------------
// LiveSource -- the real JSON-RPC reader. Behind the `live` cargo feature ONLY, so the default
// build is std-only and needs NO network (design SS6, offline-by-default clean room).
// ---------------------------------------------------------------------------------------------

/// A live JSON-RPC on-chain reader -- compiled **only** behind the `live` cargo feature.
///
/// Design SS2 (settlement proof): "an independent Rust verifier reads 0G via raw JSON-RPC". This is
/// the real-network counterpart to [`TapeSource`]; it speaks `eth_getTransactionReceipt` and
/// `eth_getTransactionByHash` to an RPC endpoint over HTTPS (`ureq` with rustls). It is feature-gated
/// so the default build pulls in no network dependency and stays fully offline (design SS6).
///
/// ## What it reads, and how it stays honest (design SS3 principle 3, never fabricate)
///
/// The independently-observed "settled amount" is the transaction's **native value moved**, in minor
/// units (wei), *gated on the receipt status*:
///
/// 1. `eth_getTransactionReceipt(hash)` is the source of truth for "did this settle". A `null` result
///    (the tx is not mined / not found on this chain) is a [`Unavailable::Transport`] -- the chain has
///    no record, so the verifier degrades *loudly* to `Unverified`, it does **not** invent a value.
/// 2. A receipt with `status == 0x0` (the tx reverted) settled *nothing*: the honest observation is
///    `Observation::new(0)` -- an on-record read of zero (the "hollow" input), never an `Unavailable`
///    and never a fabricated nonzero.
/// 3. A receipt with `status == 0x1` (success) is paired with `eth_getTransactionByHash(hash)` to read
///    the native `value` field (hex wei) -> [`Observation`] in minor units.
///
/// Every transport failure, malformed response, missing field, or out-of-`i128`-range value maps to
/// [`Unavailable::Transport`] -- there is **no** code path here that returns a made-up `Observation`.
/// An unreachable or absent read therefore always becomes `Unverified`, exactly as design SS3
/// principle 3 demands.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveSource {
    /// The JSON-RPC endpoint URL (supplied by the caller from the `OG_RPC` env var -- never
    /// hardcoded; design data-spine `[chain].rpc_env`).
    endpoint: String,
}

#[cfg(feature = "live")]
impl LiveSource {
    /// Build a live source against a JSON-RPC endpoint URL.
    ///
    /// The URL is provided by the caller (read from the `OG_RPC` environment variable per the data
    /// spine) -- this constructor never embeds a default endpoint, so no network target is baked
    /// into the binary.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> LiveSource {
        LiveSource { endpoint: endpoint.into() }
    }

    /// The configured JSON-RPC endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// POST one JSON-RPC call and return the `result` value, or a [`Unavailable::Transport`] reason.
    ///
    /// This is the single transport choke point: every network/parse failure is funneled to a loud
    /// `Unavailable` here (design SS3 principle 3), so no caller can accidentally turn a failed read
    /// into a fabricated observation. A JSON-RPC `error` object, a non-2xx HTTP status, an unreadable
    /// body, or a missing `result` all degrade to `Unavailable`.
    fn rpc_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, Unavailable> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        // A bounded, deterministic transport. `ureq` is blocking and returns an error for any
        // non-2xx status or transport failure; we translate every one to a loud Unavailable.
        let response = ureq::post(&self.endpoint)
            .set("content-type", "application/json")
            .send_json(body)
            .map_err(|e| Unavailable::Transport {
                detail: format!("RPC {method} transport failed: {e}"),
            })?;
        let value: serde_json::Value =
            response.into_json().map_err(|e| Unavailable::Transport {
                detail: format!("RPC {method} response was not JSON: {e}"),
            })?;
        if let Some(err) = value.get("error") {
            return Err(Unavailable::Transport {
                detail: format!("RPC {method} returned an error: {err}"),
            });
        }
        // `result` is present on a successful JSON-RPC reply. A `null` result is a valid JSON value
        // (e.g. an unknown tx hash) and is returned as `Value::Null` for the caller to interpret;
        // its *absence* is a malformed reply.
        value.get("result").cloned().ok_or_else(|| Unavailable::Transport {
            detail: format!("RPC {method} reply had no `result` field"),
        })
    }
}

/// Parse a `0x`-prefixed hex quantity into an `i128` of minor units.
///
/// Design SS3 principle 3 + 5 (never fabricate, exact-integer money): this is `None` for anything that
/// is not a clean hex quantity OR for a value too large to hold in `i128` -- the caller turns that
/// `None` into a loud [`Unavailable::Transport`], never a truncated/wrapped (fabricated) amount. 0G
/// native value is 18-decimal wei, far inside `i128` for any realistic balance, so an out-of-range
/// value signals a malformed/hostile response, not a real settlement.
#[cfg(feature = "live")]
fn hex_to_i128(hex: &str) -> Option<i128> {
    let body = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X"))?;
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    // Fold the hex digits with checked arithmetic so an over-`i128` value is rejected, never wrapped.
    let mut acc: i128 = 0;
    for b in body.bytes() {
        let digit = (b as char).to_digit(16)? as i128;
        acc = acc.checked_mul(16)?.checked_add(digit)?;
    }
    Some(acc)
}

#[cfg(feature = "live")]
impl Source for LiveSource {
    fn read(&mut self, key: &ReadKey) -> ReadResult<Observation> {
        // (1) The receipt is the source of truth for "did this settle". Pass the canonical hash.
        let receipt = match self.rpc_call(
            "eth_getTransactionReceipt",
            serde_json::json!([key.tx_hash()]),
        ) {
            Ok(v) => v,
            Err(u) => return ReadResult::Unavailable(u),
        };
        // A `null` receipt: the chain has no record of this tx (unknown / unmined hash). Loud,
        // honest absence -> Unverified. We do NOT fabricate a value (design SS3 principle 3).
        if receipt.is_null() {
            return ReadResult::Unavailable(Unavailable::Transport {
                detail: format!("no receipt on-chain for {} (unknown or unmined tx)", key.tx_hash()),
            });
        }
        // (2) Read the receipt status. A reverted tx (`0x0`) settled NOTHING -> an on-record read of
        // zero (the honest hollow input), never an Unavailable and never a fabricated nonzero.
        let status = match receipt.get("status").and_then(serde_json::Value::as_str) {
            Some(s) => s,
            None => {
                return ReadResult::Unavailable(Unavailable::Transport {
                    detail: "receipt had no `status` field".to_string(),
                });
            }
        };
        match hex_to_i128(status) {
            Some(0) => return ReadResult::Ok(Observation::new(0)), // reverted -> moved nothing
            Some(1) => {} // success -> read the moved value below
            _ => {
                return ReadResult::Unavailable(Unavailable::Transport {
                    detail: format!("receipt `status` was not 0x0/0x1: {status}"),
                });
            }
        }
        // (3) Success: read the native value moved from the transaction body.
        let tx = match self
            .rpc_call("eth_getTransactionByHash", serde_json::json!([key.tx_hash()]))
        {
            Ok(v) => v,
            Err(u) => return ReadResult::Unavailable(u),
        };
        if tx.is_null() {
            return ReadResult::Unavailable(Unavailable::Transport {
                detail: format!("receipt present but no tx body for {}", key.tx_hash()),
            });
        }
        let value_hex = match tx.get("value").and_then(serde_json::Value::as_str) {
            Some(v) => v,
            None => {
                return ReadResult::Unavailable(Unavailable::Transport {
                    detail: "tx body had no `value` field".to_string(),
                });
            }
        };
        match hex_to_i128(value_hex) {
            // The independently-read native value moved, in minor units (wei). This is the ONLY path
            // that mints an Observation, and it is reached ONLY for a mined, successful tx.
            Some(value) => ReadResult::Ok(Observation::new(value)),
            None => ReadResult::Unavailable(Unavailable::Transport {
                detail: format!("tx `value` was not an i128-range hex quantity: {value_hex}"),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{adjudicate, Ratio, Verdict};

    // A well-formed 32-byte hash (64 hex digits) for keys under test.
    const HASH_A: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";
    const HASH_B: &str = "0xdef0000000000000000000000000000000000000000000000000000000000002";

    fn key(h: &str) -> ReadKey {
        ReadKey::new(h).expect("test hash is well-formed")
    }

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    // --- ReadKey normalization (one canonical key shape; deterministic) -------------------------

    #[test]
    fn readkey_normalizes_case_and_prefix() {
        // Upper/lower hex, with/without 0x, and surrounding whitespace all collapse to one key.
        let canonical = "0xabc0000000000000000000000000000000000000000000000000000000000001";
        let variants = [
            "0xABC0000000000000000000000000000000000000000000000000000000000001",
            "ABC0000000000000000000000000000000000000000000000000000000000001",
            "  0xabc0000000000000000000000000000000000000000000000000000000000001  ",
            "0XAbc0000000000000000000000000000000000000000000000000000000000001",
        ];
        for v in variants {
            assert_eq!(ReadKey::new(v).unwrap().tx_hash(), canonical, "variant {v:?}");
            assert_eq!(ReadKey::new(v).unwrap(), key(canonical));
        }
    }

    #[test]
    fn readkey_rejects_malformed_hashes() {
        // Wrong length, non-hex, and empty are all rejected -- a garbage key never keys a slot.
        assert_eq!(ReadKey::new(""), None);
        assert_eq!(ReadKey::new("0x"), None);
        assert_eq!(ReadKey::new("0x123"), None); // too short
        assert_eq!(
            ReadKey::new("0xzz00000000000000000000000000000000000000000000000000000000000001"),
            None
        ); // non-hex
        assert_eq!(
            ReadKey::new("0xabc00000000000000000000000000000000000000000000000000000000000011"),
            None
        ); // 65 hex digits -- too long
    }

    // --- The spec's two required tests: tape hit -> Ok ; off-tape -> Unavailable ----------------

    #[test]
    fn tape_hit_reads_ok() {
        // SPEC TEST 1/2: a recorded key replays its exact observation as ReadResult::Ok.
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(1_000));
        let got = src.read(&key(HASH_A));
        assert!(got.is_ok(), "a taped key must read Ok");
        assert_eq!(got, ReadResult::Ok(Observation::new(1_000)));
        assert_eq!(observed_amount(&got), Some(1_000));
    }

    #[test]
    fn off_tape_read_is_unavailable() {
        // SPEC TEST 2/2: a key NOT on the tape is Unavailable::OffTape -- never a fabricated value.
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(1_000));
        let got = src.read(&key(HASH_B));
        assert!(got.is_unavailable(), "an off-tape key must be Unavailable");
        assert_eq!(got, ReadResult::Unavailable(Unavailable::OffTape { key: key(HASH_B) }));
        // The bridge yields None -- the shape adjudicate degrades to Unverified.
        assert_eq!(observed_amount(&got), None);
    }

    #[test]
    fn empty_tape_makes_every_read_unavailable() {
        let mut src = TapeSource::new();
        assert!(src.is_empty());
        assert_eq!(src.len(), 0);
        assert!(src.read(&key(HASH_A)).is_unavailable());
    }

    // --- The never-fabricate invariant end to end (design SS3 principles 1 + 3) -----------------

    #[test]
    fn off_tape_read_adjudicates_to_unverified_never_settled() {
        // The whole pivot: an off-tape read flows through the bridge to adjudicate and lands on
        // UNVERIFIED -- never a fabricated SETTLED, no matter the claim.
        let mut src = TapeSource::new(); // empty -> every read off-tape
        let claim = 1_000;
        let read = src.read(&key(HASH_A));
        let verdict = adjudicate(claim, observed_amount(&read), band_15pct());
        assert_eq!(verdict, Verdict::Unverified);
        assert_ne!(verdict, Verdict::Settled, "an unavailable read must NEVER fabricate Settled");
    }

    #[test]
    fn tape_hit_within_band_adjudicates_to_settled() {
        // A real recorded read within tolerance settles -- proving the Ok path reaches adjudicate
        // intact (claimed 1000, observed 1100, 15% band -> Settled).
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(1_100));
        let read = src.read(&key(HASH_A));
        let verdict = adjudicate(1_000, observed_amount(&read), band_15pct());
        assert_eq!(verdict, Verdict::Settled);
    }

    #[test]
    fn tape_hit_outside_band_adjudicates_to_mismatch_not_settled() {
        // A recorded read that disagrees beyond tolerance is Mismatch -- the Ok path does not blanket
        // -settle just because an observation exists (claimed 1000, observed 1300 -> Mismatch).
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(1_300));
        let read = src.read(&key(HASH_A));
        let verdict = adjudicate(1_000, observed_amount(&read), band_15pct());
        assert_eq!(verdict, Verdict::Mismatch);
    }

    #[test]
    fn tape_hit_zero_value_with_zero_claim_is_hollow() {
        // An on-record read of value 0 against a zero claim is Hollow (on-record, moved nothing) --
        // distinct from an off-tape Unavailable. This proves Some(0) and "absent" are different paths.
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(0));
        let read = src.read(&key(HASH_A));
        assert_eq!(observed_amount(&read), Some(0));
        assert_eq!(adjudicate(0, observed_amount(&read), band_15pct()), Verdict::Hollow);
    }

    // --- Determinism: the same tape answers a key identically, every time -----------------------

    #[test]
    fn tape_read_is_deterministic() {
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(42));
        let first = src.read(&key(HASH_A));
        for _ in 0..8 {
            assert_eq!(src.read(&key(HASH_A)), first, "same key -> identical read, every time");
        }
        // And an off-tape key is identically Unavailable each time.
        let miss = src.read(&key(HASH_B));
        for _ in 0..8 {
            assert_eq!(src.read(&key(HASH_B)), miss);
        }
    }

    #[test]
    fn record_overwrites_a_key() {
        let mut src = TapeSource::new();
        src.record(key(HASH_A), Observation::new(1));
        src.record(key(HASH_A), Observation::new(2));
        assert_eq!(src.read(&key(HASH_A)), ReadResult::Ok(Observation::new(2)));
        assert_eq!(src.len(), 1);
    }

    // --- ReadResult / Unavailable plumbing ------------------------------------------------------

    #[test]
    fn unavailable_reasons_render_for_the_journal() {
        let off = Unavailable::OffTape { key: key(HASH_A) };
        assert!(off.to_string().contains("off-tape"));
        let nw = Unavailable::NotWired { detail: "no reader" };
        assert!(nw.to_string().contains("not wired"));
        let tr = Unavailable::Transport { detail: "no route".to_string() };
        assert!(tr.to_string().contains("transport"));
    }

    #[test]
    fn observed_amount_is_the_only_unavailable_to_none_bridge() {
        // Ok -> Some(value); every Unavailable arm -> None (so all degrade to Unverified).
        let ok: ReadResult<Observation> = ReadResult::Ok(Observation::new(7));
        assert_eq!(observed_amount(&ok), Some(7));
        for u in [
            Unavailable::OffTape { key: key(HASH_A) },
            Unavailable::NotWired { detail: "x" },
            Unavailable::Transport { detail: "y".to_string() },
        ] {
            let r: ReadResult<Observation> = ReadResult::Unavailable(u);
            assert_eq!(observed_amount(&r), None);
        }
    }

    #[test]
    fn tape_source_is_a_dyn_source() {
        // The seam is object-safe: a TapeSource can be used through &mut dyn Source, so a live and a
        // taped reader are drop-in interchangeable behind one trait.
        let mut src = TapeSource::new().with(key(HASH_A), Observation::new(5));
        let dynamic: &mut dyn Source = &mut src;
        assert_eq!(dynamic.read(&key(HASH_A)), ReadResult::Ok(Observation::new(5)));
        assert!(dynamic.read(&key(HASH_B)).is_unavailable());
    }

    // --- The live leg (feature-gated): the skeleton must NEVER fabricate (design SS3 principle 3) -

    #[cfg(feature = "live")]
    #[test]
    fn live_source_unreachable_endpoint_never_fabricates_a_settlement() {
        // The live read is wired, but pointed at an unreachable endpoint: the transport fails, so per
        // design SS3 principle 3 it must degrade LOUDLY to Unavailable (Transport) -- NEVER an
        // Observation. Proven for an arbitrary key, and end to end through adjudicate, which must land
        // on Unverified, never Settled. (Port 0 is unbindable, so no request can succeed -- this stays
        // hermetic and makes no real network call.)
        let mut live = LiveSource::new("http://127.0.0.1:0"); // unreachable on purpose
        assert_eq!(live.endpoint(), "http://127.0.0.1:0");
        let read = live.read(&key(HASH_A));
        assert!(read.is_unavailable(), "an unreachable read must not fabricate an observation");
        assert!(
            matches!(read, ReadResult::Unavailable(Unavailable::Transport { .. })),
            "an unreachable endpoint is a loud Transport unavailable, never a fabricated value"
        );
        assert_eq!(observed_amount(&read), None);
        let verdict = adjudicate(1_000, observed_amount(&read), band_15pct());
        assert_eq!(verdict, Verdict::Unverified);
        assert_ne!(verdict, Verdict::Settled);
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_source_is_a_dyn_source() {
        // The live reader satisfies the same object-safe seam as the tape, so the two are drop-in
        // interchangeable behind `&mut dyn Source` (only the source of truth differs, not the algebra).
        let mut live = LiveSource::new("http://127.0.0.1:0");
        let dynamic: &mut dyn Source = &mut live;
        assert!(dynamic.read(&key(HASH_A)).is_unavailable());
    }

    // --- hex_to_i128: the exact-integer hex ingest (design SS3 principle 3 + 5) ------------------

    #[cfg(feature = "live")]
    #[test]
    fn hex_to_i128_parses_canonical_quantities() {
        assert_eq!(super::hex_to_i128("0x0"), Some(0));
        assert_eq!(super::hex_to_i128("0x1"), Some(1));
        assert_eq!(super::hex_to_i128("0xff"), Some(255));
        assert_eq!(super::hex_to_i128("0X10"), Some(16)); // upper-case prefix accepted
        // 18-decimal native value (1 token = 10^18 wei) round-trips exactly, well inside i128.
        assert_eq!(super::hex_to_i128("0xde0b6b3a7640000"), Some(1_000_000_000_000_000_000));
    }

    #[cfg(feature = "live")]
    #[test]
    fn hex_to_i128_rejects_malformed_and_oversized() {
        // Not hex, no prefix, empty body -> None (the caller turns this into a loud Unavailable).
        assert_eq!(super::hex_to_i128("123"), None); // no 0x prefix
        assert_eq!(super::hex_to_i128("0x"), None); // empty body
        assert_eq!(super::hex_to_i128("0xzz"), None); // non-hex
        // A 33-byte (66 hex digit) quantity exceeds i128 -> None, NEVER a wrapped/fabricated value.
        let oversized = format!("0x{}", "f".repeat(66));
        assert_eq!(super::hex_to_i128(&oversized), None);
    }
}
