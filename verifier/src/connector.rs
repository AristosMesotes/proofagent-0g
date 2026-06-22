//! The UNIFIED connector-settlement entry -- one door that adjudicates ANY adapter's settlement.
//!
//! Design SS2 (the Settlement proof): "an independent Rust verifier reads 0G via raw JSON-RPC and stamps
//! each trade settled / hollow / mismatch / unverified -- it never trusts the UI." Design SS3 principle 2
//! (the verdict monopoly): "Only the verifier mints a verdict ... The agent, the LLM, and the web UI
//! produce claims and facts -- never a verdict."
//!
//! ## What this module unifies, and what it does NOT change
//!
//! The verifier grew one settlement leg per protocol family: the MVP value leg ([`crate::verify_tx`] /
//! [`crate::adjudicate`]), the SWAP extension ([`crate::adjudicate_swap`]), the ROUTE extension
//! ([`crate::adjudicate_route_leg`]), and the BRIDGE extension ([`crate::adjudicate_hop`]). Each reads a
//! DIFFERENT on-chain fact (native value moved / a pool `Swap`-event output / a rail settle-event delivery
//! / a two-leg burn+release), but every one of them mints one of the SAME four [`crate::Verdict`]s through
//! the same crate-private monopoly. They were, until now, four separate public entry points -- a caller had
//! to KNOW which protocol it held to call the right `adjudicate_*`.
//!
//! This module adds the ONE entry that closes that gap: [`verify_connector_settlement`]. Given a connector
//! [`ConnectorKind`] (the protocol family) and a [`ConnectorObservation`] (the verifier's own on-chain read,
//! shaped per protocol), adjudicated against the matching [`ConnectorClaim`], it mints a single
//! [`crate::Verdict`] by DISPATCHING to the existing per-protocol algebra. Crucially:
//!
//! - **No new verdict enum.** The four-verdict alphabet (design SS2) is unchanged; this composes the
//!   existing extensions, it does not widen the alphabet or add a fifth outcome.
//! - **The per-protocol decode stays.** Each protocol keeps its own Claim / Observation shape and its own
//!   `adjudicate_*`; the unifying entry only routes to them. A swap is still adjudicated by the swap algebra
//!   (the on-chain `amountOutMinimum` floor, the `Swap`-event output), a bridge hop still by the two-leg
//!   hollow-egress algebra, etc. Nothing about WHAT a verdict means changes.
//! - **The monopoly is preserved (design SS3 principle 2).** Every path here ends in a crate-private
//!   `adjudicate_*` that mints the verdict; no caller outside the crate can construct a [`crate::Verdict`],
//!   only obtain one from this entry (or the per-protocol entries it composes).
//!
//! The shape mismatch -- a [`ConnectorClaim::Swap`] paired with a [`ConnectorObservation::Bridge`] -- is a
//! loud [`ConnectorMismatch`], NEVER a fabricated `settled` (design SS3 principle 3): a verdict can only be
//! minted when the claim and the observation are the same protocol family. This is the type-level twin of
//! the two-source-truth rule -- the Claim and the Observation must describe the same action to be adjudicated.
//!
//! ## Width-by-data: a new adapter is a manifest entry + the adapter, zero gateway change
//!
//! Design WOW Feature 5 (the Engine) + the data-spine doctrine ("a new check or corpus entry is a config
//! edit, not a code change"): an adapter declares itself in a typed [`ConnectorManifest`] -- one
//! [`ConnectorEntry`] per `[[connector]]` block in `proofagent.toml` -- carrying its **shape** (the
//! [`ConnectorKind`]), its **chains**, its **priority** (the gateway's priced-fallback tie-break), and
//! **which checks gate it** (the named gates that MUST pass before it is trusted). The manifest is the
//! width-by-data seam: the verifier reads it to know a connector's kind without a code change, and the
//! recipe (`docs/ADD_AN_ADAPTER.md`) turns "add a protocol" into "implement the connector + declare the
//! manifest entry + the gate proves it", with the verifier confirming the settlement through THIS one entry.
//!
//! ## Determinism + exact-integer money (design SS3 principles 4 + 5)
//!
//! [`verify_connector_settlement`] is pure over `(kind, claim, observation, tol)` -- no wall-clock, no
//! global state. Every amount on every path is an exact `i128` in minor units; there is no float anywhere.
//! The manifest parse is pure over the file bytes and preserves declaration order.

use crate::{
    adjudicate, adjudicate_hop, adjudicate_route_leg, adjudicate_swap, HopClaim, HopObservation,
    Ratio, RouteClaim, RouteObservation, SwapClaim, SwapObservation, Verdict,
};
use core::fmt;

/// The protocol family of a connector -- the SHAPE label that selects which per-protocol algebra a
/// settlement is adjudicated through (design WOW Feature 5, the Engine; design SS2's verdict alphabet is
/// shared by all of them).
///
/// This mirrors the agent-side `ProtocolKind` (the TS execution contract) plus the MVP native-value
/// settlement leg, so a connector's declared kind in the manifest names the same family end to end. It is
/// `#[non_exhaustive]` so a future protocol family can be added without breaking external matches -- but
/// adding one is a deliberate edit here (the canonical string match below forces it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ConnectorKind {
    /// The MVP native-value settlement leg -- a transaction's native value moved (wei), the
    /// [`crate::verify_tx`] / [`crate::adjudicate`] algebra. The default connector shape.
    Settlement,
    /// A Uniswap-V3 single-hop swap -- the pool `Swap`-event realized output, the [`adjudicate_swap`]
    /// algebra (design WOW Feature 1).
    Swap,
    /// A routed action (intent / aggregation / native AMM) -- the rail settle/refund event + delivered
    /// amount, the [`adjudicate_route_leg`] algebra (design WOW Feature 2).
    Route,
    /// A CCIP bridge hop -- both legs (source burn/lock + destination release/mint), the [`adjudicate_hop`]
    /// algebra with the hollow-egress catch (design WOW Feature 3 / 3b).
    Bridge,
}

impl ConnectorKind {
    /// The canonical, stable, snake_case string for this connector kind (the manifest / journal form).
    ///
    /// Deterministic (design SS3 principle 4): the same kind always renders to the same bytes. There is no
    /// wildcard arm, so adding a [`ConnectorKind`] variant forces a deliberate canonical string here.
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            ConnectorKind::Settlement => "settlement",
            ConnectorKind::Swap => "swap",
            ConnectorKind::Route => "route",
            ConnectorKind::Bridge => "bridge",
        }
    }

    /// Parse a connector kind from its canonical snake_case string (the manifest `shape` value).
    ///
    /// Returns `None` for an unrecognized shape -- a loud "this is not a known connector kind", never a
    /// silently-defaulted family (design SS3 principle 3). The match is exact + case-sensitive on the
    /// canonical spelling. (Named `from_canonical`, not `from_str`, to keep it distinct from the
    /// `FromStr` trait -- it is an `Option`-returning lookup, not a fallible-`Result` parse.)
    #[must_use]
    pub fn from_canonical(s: &str) -> Option<ConnectorKind> {
        match s {
            "settlement" => Some(ConnectorKind::Settlement),
            "swap" => Some(ConnectorKind::Swap),
            "route" => Some(ConnectorKind::Route),
            "bridge" => Some(ConnectorKind::Bridge),
            _ => None,
        }
    }
}

impl fmt::Display for ConnectorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The agent's recorded **Claim** for ONE connector settlement -- the protocol-tagged union of the
/// per-protocol claim shapes (design SS3 principle 1, two-source truth: this is the agent's word, never
/// trusted on its own).
///
/// Each variant carries exactly the existing per-protocol Claim, so the unifying entry adds NO new claim
/// shape -- it only wraps the proven ones so one function can accept any of them. The native-value
/// settlement leg's claim is a bare `i128` (the claimed amount in minor units), matching [`crate::adjudicate`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorClaim {
    /// The native-value claim -- a claimed amount in minor units (the [`crate::adjudicate`] shape).
    Settlement(i128),
    /// A swap claim (the quoted `expected_out` + the on-chain `amountOutMinimum` floor).
    Swap(SwapClaim),
    /// A routed-leg claim (the rail + the quoted `expected_out` + the on-chain `min_out` floor).
    Route(RouteClaim),
    /// A bridge-hop claim (the lane + the expected selector + the `sent` amount + the `min_release` floor).
    Bridge(HopClaim),
}

impl ConnectorClaim {
    /// The connector kind this claim is for (the family it belongs to).
    #[must_use]
    pub const fn kind(&self) -> ConnectorKind {
        match self {
            ConnectorClaim::Settlement(_) => ConnectorKind::Settlement,
            ConnectorClaim::Swap(_) => ConnectorKind::Swap,
            ConnectorClaim::Route(_) => ConnectorKind::Route,
            ConnectorClaim::Bridge(_) => ConnectorKind::Bridge,
        }
    }
}

/// The verifier's own independent on-chain **Observation** for ONE connector settlement -- the
/// protocol-tagged union of the per-protocol observation shapes (design SS3 principle 1, two-source truth:
/// the verifier's read, never the agent's word, never the UI).
///
/// Each variant carries exactly the existing per-protocol Observation; an `Option` inside each variant is
/// the loud absence the per-protocol algebra degrades to `unverified` (the keystone, design SS3 principle
/// 3). The unifying entry adds NO new observation shape -- it only wraps the proven ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorObservation {
    /// The native-value observation -- the read settled amount in minor units, or `None` (unreadable ->
    /// `unverified`). Mirrors [`crate::observed_amount`]'s bridge to [`crate::adjudicate`].
    Settlement(Option<i128>),
    /// The swap observation -- the decoded `Swap`-event output, or `None` (unreadable -> `unverified`).
    Swap(Option<SwapObservation>),
    /// The route observation -- the rail terminal + delivered amount, or `None` (unreadable -> `unverified`).
    Route(Option<RouteObservation>),
    /// The bridge observation -- both legs (the inner destination leg may itself be `None` = still
    /// in-flight), or `None` (the source itself unreadable -> `unverified`).
    Bridge(Option<HopObservation>),
}

impl ConnectorObservation {
    /// The connector kind this observation is for (the family it belongs to).
    #[must_use]
    pub const fn kind(&self) -> ConnectorKind {
        match self {
            ConnectorObservation::Settlement(_) => ConnectorKind::Settlement,
            ConnectorObservation::Swap(_) => ConnectorKind::Swap,
            ConnectorObservation::Route(_) => ConnectorKind::Route,
            ConnectorObservation::Bridge(_) => ConnectorKind::Bridge,
        }
    }
}

/// A loud refusal to adjudicate -- the Claim and the Observation describe DIFFERENT connector families.
///
/// Design SS3 principle 3 (never fabricate): a swap claim paired with a bridge observation cannot be
/// adjudicated (they describe different actions), so the unifying entry refuses LOUDLY rather than coerce a
/// verdict. This is the type-level guard that keeps two-source truth honest -- the Claim and the
/// Observation must be the SAME family to meet in an algebra. It is deliberately NOT a [`crate::Verdict`]
/// (it is never rendered as a settlement); it is a usage error the caller must fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectorMismatch {
    /// The connector kind of the supplied claim.
    pub claim_kind: ConnectorKind,
    /// The connector kind of the supplied observation.
    pub observation_kind: ConnectorKind,
}

impl fmt::Display for ConnectorMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "connector shape mismatch: a {} claim cannot be adjudicated against a {} observation \
             (the claim and the observation must be the same connector family)",
            self.claim_kind, self.observation_kind,
        )
    }
}

impl std::error::Error for ConnectorMismatch {}

/// The UNIFIED settlement entry -- adjudicate ANY connector's settlement through the ONE [`Verdict`]
/// monopoly, by dispatching to the matching per-protocol algebra.
///
/// This is the single door the gateway / the journal / the LEDGER can call for any adapter, without
/// knowing which protocol it holds: it reads the [`ConnectorClaim`] + [`ConnectorObservation`] kinds and
/// routes to [`crate::adjudicate`] / [`adjudicate_swap`] / [`adjudicate_route_leg`] / [`adjudicate_hop`].
/// Each of those mints one of the SAME four [`Verdict`]s (design SS2), so there is NO new verdict enum and
/// the monopoly (design SS3 principle 2) is preserved -- this entry only composes the proven extensions.
///
/// # Errors
///
/// Returns [`ConnectorMismatch`] (a loud usage error, NEVER a fabricated `settled`) when the claim and the
/// observation are different connector families -- they describe different actions and cannot be
/// adjudicated against each other (design SS3 principle 3). A same-family pair always yields a real
/// [`Verdict`] on the `Ok` path (including the honest `unverified` for an unreadable observation).
///
/// # Examples
///
/// ```
/// use verifier::{
///     verify_connector_settlement, ConnectorClaim, ConnectorObservation, Ratio, Verdict,
/// };
/// let tol = Ratio::new(15, 100).unwrap();
/// // A native-value settlement: claimed 1000, observed 1100, within the 15% band -> Settled.
/// let v = verify_connector_settlement(
///     &ConnectorClaim::Settlement(1_000),
///     &ConnectorObservation::Settlement(Some(1_100)),
///     tol,
/// )
/// .unwrap();
/// assert_eq!(v, Verdict::Settled);
/// // An unreadable observation degrades LOUDLY to Unverified -- never a fabricated settled.
/// let u = verify_connector_settlement(
///     &ConnectorClaim::Settlement(1_000),
///     &ConnectorObservation::Settlement(None),
///     tol,
/// )
/// .unwrap();
/// assert_eq!(u, Verdict::Unverified);
/// ```
pub fn verify_connector_settlement(
    claim: &ConnectorClaim,
    observation: &ConnectorObservation,
    tol: Ratio,
) -> Result<Verdict, ConnectorMismatch> {
    // The Claim and the Observation must describe the SAME connector family to be adjudicated. A
    // cross-family pair is a loud refusal (design SS3 principle 3) -- NEVER a coerced/fabricated verdict.
    match (claim, observation) {
        // The MVP native-value leg -- the exact-integer settlement algebra (design SS3 principle 1 + 5).
        (ConnectorClaim::Settlement(claimed), ConnectorObservation::Settlement(observed)) => {
            Ok(adjudicate(*claimed, *observed, tol))
        }
        // The SWAP extension -- the on-chain floor + the `Swap`-event output (design WOW Feature 1).
        (ConnectorClaim::Swap(c), ConnectorObservation::Swap(o)) => Ok(adjudicate_swap(c, *o, tol)),
        // The ROUTE extension -- the rail terminal + delivered amount (design WOW Feature 2).
        (ConnectorClaim::Route(c), ConnectorObservation::Route(o)) => {
            Ok(adjudicate_route_leg(c, *o, tol))
        }
        // The BRIDGE extension -- both legs + the hollow-egress catch (design WOW Feature 3 / 3b).
        (ConnectorClaim::Bridge(c), ConnectorObservation::Bridge(o)) => Ok(adjudicate_hop(c, *o, tol)),
        // Any cross-family pair: a loud mismatch, never a fabricated verdict.
        (c, o) => Err(ConnectorMismatch { claim_kind: c.kind(), observation_kind: o.kind() }),
    }
}

// =================================================================================================
// The adapter MANIFEST -- width-by-data: a new adapter is a `[[connector]]` block, zero gateway change.
// =================================================================================================

/// One declared connector in the adapter manifest -- shape · chains · priority · which checks gate it.
///
/// Design WOW Feature 5 (the Engine) + the data-spine doctrine: an adapter declares itself in the manifest
/// rather than being wired into a gateway switch, so adding a protocol is a config edit (a `[[connector]]`
/// block) plus the adapter, with NO change to the verifier's dispatch. Every field is a public, secret-free
/// fact (design SS6 clean-room).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorEntry {
    /// A stable, human-readable connector name (the adapter's id; for the journal / the gateway registry).
    pub name: String,
    /// The connector SHAPE -- which per-protocol settlement algebra the verifier adjudicates it through
    /// (the [`ConnectorKind`]). The width-by-data seam: the verifier reads this to know the family.
    pub shape: ConnectorKind,
    /// The chain ids this connector operates on (e.g. `[16661]` for a mainnet-only Oku swap; `[16602]` for
    /// a testnet-able native-AMM leg). Exact integers (no float) -- the venue's chain id(s).
    pub chains: Vec<u64>,
    /// The gateway's priced-fallback tie-break priority (lower = preferred on an equal quote). Mirrors the
    /// agent `RegisteredAdapter.priority`.
    pub priority: i64,
    /// WHICH named checks gate this connector -- the gates that MUST pass before it is trusted (e.g.
    /// `["settlement", "mandate-cap"]`). An adapter CANNOT vote itself in: it is trusted only when these
    /// named gates pass. The names match the `[[check]]` entries in the data spine.
    pub gates: Vec<String>,
}

/// The typed adapter manifest -- every declared connector, in declaration order.
///
/// Design WOW Feature 5 + SS3 principle 4 (deterministic): parsed from the `[[connector]]` blocks of
/// `proofagent.toml`, in the order written, with no clock and no env. The manifest is the single source of
/// truth for "which adapters exist + how each is gated" -- the width-by-data registry.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConnectorManifest {
    entries: Vec<ConnectorEntry>,
}

impl ConnectorManifest {
    /// An empty manifest -- no connectors declared.
    #[must_use]
    pub fn new() -> ConnectorManifest {
        ConnectorManifest { entries: Vec::new() }
    }

    /// The declared connectors, in declaration order (deterministic; design SS3 principle 4).
    #[must_use]
    pub fn entries(&self) -> &[ConnectorEntry] {
        &self.entries
    }

    /// How many connectors are declared.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` iff no connectors are declared.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Look up a declared connector by its (case-sensitive) name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&ConnectorEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    /// Parse the manifest from `proofagent.toml` text -- the `[[connector]]` blocks only.
    ///
    /// Reads every `[[connector]]` table (`name`, `shape`, `chains`, `priority`, `gates`) in declaration
    /// order; every other section is skipped. An absent / empty manifest is valid (it yields an empty
    /// manifest -- the verifier honestly has no declared connectors). A malformed field is a loud
    /// [`ManifestError`] (design SS3 principle 3: never silently proceed with a half-read entry).
    ///
    /// This is a focused, std-only reader for exactly the `[[connector]]` subset -- it is NOT a general
    /// TOML parser (design SS6, offline-by-default + zero default dependencies), mirroring the spine reader.
    pub fn parse(text: &str) -> Result<ConnectorManifest, ManifestError> {
        let mut entries: Vec<ConnectorEntry> = Vec::new();
        let mut pending: Option<PendingConnector> = None;

        for (idx, raw) in text.lines().enumerate() {
            let lineno = idx + 1;
            let line = strip_comment(raw).trim();
            if line.is_empty() {
                continue;
            }

            if let Some(header) = line.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
                // An array-of-tables header. Flush any in-progress connector first.
                flush_connector(&mut pending, &mut entries, lineno)?;
                if header.trim() == "connector" {
                    pending = Some(PendingConnector::default());
                }
                continue;
            }
            if line.strip_prefix('[').and_then(|s| s.strip_suffix(']')).is_some() {
                // A plain table header ends any in-progress connector.
                flush_connector(&mut pending, &mut entries, lineno)?;
                continue;
            }

            // A `key = value` line. Only consume it when inside a `[[connector]]` block; otherwise skip.
            let Some(p) = pending.as_mut() else {
                continue;
            };
            let Some((key, value)) = line.split_once('=') else {
                return Err(ManifestError::Malformed { line: lineno, text: line.to_string() });
            };
            let key = key.trim();
            let value = value.trim();
            match key {
                "name" => p.name = Some(parse_string(value, lineno, "connector.name")?),
                "shape" => p.shape = Some(parse_string(value, lineno, "connector.shape")?),
                "priority" => p.priority = Some(parse_i64(value, lineno, "connector.priority")?),
                "chains" => p.chains = Some(parse_u64_array(value, lineno, "connector.chains")?),
                "gates" => p.gates = Some(parse_string_array(value, lineno, "connector.gates")?),
                _ => {} // ignore unrecognized connector keys (forward-compatible)
            }
        }
        // Flush a trailing connector at EOF.
        flush_connector(&mut pending, &mut entries, text.lines().count())?;

        Ok(ConnectorManifest { entries })
    }
}

/// A connector entry under construction as its `key = value` lines are read.
#[derive(Default)]
struct PendingConnector {
    name: Option<String>,
    shape: Option<String>,
    chains: Option<Vec<u64>>,
    priority: Option<i64>,
    gates: Option<Vec<String>>,
}

/// Finalize the pending connector (if any) into a [`ConnectorEntry`], or error loudly if incomplete /
/// malformed. Clears `pending` either way.
fn flush_connector(
    pending: &mut Option<PendingConnector>,
    entries: &mut Vec<ConnectorEntry>,
    lineno: usize,
) -> Result<(), ManifestError> {
    let Some(p) = pending.take() else {
        return Ok(());
    };
    let name = p.name.ok_or(ManifestError::Incomplete { line: lineno, field: "name" })?;
    let shape_str = p.shape.ok_or(ManifestError::Incomplete { line: lineno, field: "shape" })?;
    let shape = ConnectorKind::from_canonical(&shape_str)
        .ok_or(ManifestError::BadShape { line: lineno, shape: shape_str })?;
    // `chains`, `priority`, and `gates` are required: a connector with no chain, no priority, or no
    // gating is not trustworthy (an adapter that names no gates could "vote itself in" -- design WOW
    // Feature 5 / the recipe: the adapter CANNOT vote itself in; loud-unverified over silent-green).
    let chains = p.chains.ok_or(ManifestError::Incomplete { line: lineno, field: "chains" })?;
    let priority = p.priority.ok_or(ManifestError::Incomplete { line: lineno, field: "priority" })?;
    let gates = p.gates.ok_or(ManifestError::Incomplete { line: lineno, field: "gates" })?;
    if gates.is_empty() {
        return Err(ManifestError::NoGates { line: lineno, name });
    }
    entries.push(ConnectorEntry { name, shape, chains, priority, gates });
    Ok(())
}

/// Strip a `#` line comment, but only when the `#` is OUTSIDE a double-quoted string.
fn strip_comment(line: &str) -> &str {
    let mut in_quote = false;
    for (i, b) in line.bytes().enumerate() {
        match b {
            b'"' => in_quote = !in_quote,
            b'#' if !in_quote => return &line[..i],
            _ => {}
        }
    }
    line
}

/// Strip surrounding double quotes from a value, if present. `None` if not quoted.
fn unquote(value: &str) -> Option<&str> {
    value.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
}

/// Parse a required double-quoted string value.
fn parse_string(value: &str, line: usize, field: &'static str) -> Result<String, ManifestError> {
    unquote(value).map(str::to_string).ok_or(ManifestError::BadString { line, field })
}

/// Parse an exact `i64` from a (possibly underscore-grouped) decimal integer literal (no float).
fn parse_i64(value: &str, line: usize, field: &'static str) -> Result<i64, ManifestError> {
    let cleaned: String = value.chars().filter(|&c| c != '_').collect();
    cleaned.parse::<i64>().map_err(|_| ManifestError::BadInteger {
        line,
        field,
        value: value.to_string(),
    })
}

/// Parse a TOML inline array `[a, b, c]` of exact `u64` integers (no float; the chain ids).
fn parse_u64_array(value: &str, line: usize, field: &'static str) -> Result<Vec<u64>, ManifestError> {
    let body = value
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .ok_or(ManifestError::BadArray { line, field })?;
    let mut out = Vec::new();
    for item in body.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue; // tolerate a trailing comma / an empty array `[]`
        }
        let cleaned: String = item.chars().filter(|&c| c != '_').collect();
        let v = cleaned.parse::<u64>().map_err(|_| ManifestError::BadInteger {
            line,
            field,
            value: item.to_string(),
        })?;
        out.push(v);
    }
    Ok(out)
}

/// Parse a TOML inline array `["a", "b"]` of double-quoted strings (the gate names).
fn parse_string_array(
    value: &str,
    line: usize,
    field: &'static str,
) -> Result<Vec<String>, ManifestError> {
    let body = value
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .ok_or(ManifestError::BadArray { line, field })?;
    let mut out = Vec::new();
    for item in body.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue; // tolerate a trailing comma / an empty array `[]`
        }
        let s = unquote(item).ok_or(ManifestError::BadString { line, field })?;
        out.push(s.to_string());
    }
    Ok(out)
}

/// A loud, deterministic manifest-parse failure (design SS3 principle 3: never silently proceed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    /// A non-empty line inside a `[[connector]]` block that is not a `key = value` assignment.
    Malformed {
        /// 1-based line number.
        line: usize,
        /// The offending (comment-stripped) line text.
        text: String,
    },
    /// A `[[connector]]` block is missing a required field.
    Incomplete {
        /// 1-based line number where the entry was finalized.
        line: usize,
        /// The missing field name.
        field: &'static str,
    },
    /// A field expected to be a quoted string was not quoted.
    BadString {
        /// 1-based line number.
        line: usize,
        /// The field name.
        field: &'static str,
    },
    /// A field expected to be an exact integer did not parse.
    BadInteger {
        /// 1-based line number.
        line: usize,
        /// The field name.
        field: &'static str,
        /// The offending value text.
        value: String,
    },
    /// A field expected to be an inline array `[...]` was not.
    BadArray {
        /// 1-based line number.
        line: usize,
        /// The field name.
        field: &'static str,
    },
    /// A `shape` value was not a recognized [`ConnectorKind`] canonical string.
    BadShape {
        /// 1-based line number.
        line: usize,
        /// The offending shape text.
        shape: String,
    },
    /// A connector declared no gates -- an adapter that names no gating CANNOT be trusted (it would
    /// "vote itself in"; design WOW Feature 5 / the recipe). At least one gate is required.
    NoGates {
        /// 1-based line number where the entry was finalized.
        line: usize,
        /// The offending connector name.
        name: String,
    },
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ManifestError::Malformed { line, text } => {
                write!(f, "manifest line {line}: not an assignment: {text:?}")
            }
            ManifestError::Incomplete { line, field } => {
                write!(f, "manifest line {line}: [[connector]] entry missing `{field}`")
            }
            ManifestError::BadString { line, field } => {
                write!(f, "manifest line {line}: `{field}` must be a double-quoted string")
            }
            ManifestError::BadInteger { line, field, value } => {
                write!(f, "manifest line {line}: `{field}` must be an integer, got {value:?}")
            }
            ManifestError::BadArray { line, field } => {
                write!(f, "manifest line {line}: `{field}` must be an inline array [...]")
            }
            ManifestError::BadShape { line, shape } => {
                write!(
                    f,
                    "manifest line {line}: `shape` {shape:?} is not a known connector kind \
                     (settlement / swap / route / bridge)"
                )
            }
            ManifestError::NoGates { line, name } => {
                write!(
                    f,
                    "manifest line {line}: connector {name:?} declares no gates -- at least one is \
                     required (an adapter cannot vote itself in)"
                )
            }
        }
    }
}

impl std::error::Error for ManifestError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BridgeLane, DestSelector, RouteRail};

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    // --- the unified entry routes to the RIGHT per-protocol algebra (no new verdict enum) -----------

    #[test]
    fn settlement_kind_routes_to_the_value_algebra() {
        let tol = band_15pct();
        // claimed 1000, observed 1100, 15% band -> Settled (the adjudicate algebra).
        assert_eq!(
            verify_connector_settlement(
                &ConnectorClaim::Settlement(1_000),
                &ConnectorObservation::Settlement(Some(1_100)),
                tol,
            )
            .unwrap(),
            Verdict::Settled
        );
        // observed 1300 -> Mismatch.
        assert_eq!(
            verify_connector_settlement(
                &ConnectorClaim::Settlement(1_000),
                &ConnectorObservation::Settlement(Some(1_300)),
                tol,
            )
            .unwrap(),
            Verdict::Mismatch
        );
        // (0, 0) -> Hollow.
        assert_eq!(
            verify_connector_settlement(
                &ConnectorClaim::Settlement(0),
                &ConnectorObservation::Settlement(Some(0)),
                tol,
            )
            .unwrap(),
            Verdict::Hollow
        );
        // None -> Unverified (the keystone, never fabricated settled).
        assert_eq!(
            verify_connector_settlement(
                &ConnectorClaim::Settlement(1_000),
                &ConnectorObservation::Settlement(None),
                tol,
            )
            .unwrap(),
            Verdict::Unverified
        );
    }

    #[test]
    fn swap_kind_routes_to_the_swap_algebra_floor_and_band() {
        let tol = band_15pct();
        let claim = ConnectorClaim::Swap(SwapClaim::new(1_000, 900));
        // in band, above floor -> Settled.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Swap(Some(SwapObservation::new(1_100))), tol).unwrap(),
            Verdict::Settled
        );
        // below the on-chain floor -> Mismatch (the swap-specific floor rule -- proves the swap algebra ran).
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Swap(Some(SwapObservation::new(800))), tol).unwrap(),
            Verdict::Mismatch
        );
        // realized 0 -> Hollow.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Swap(Some(SwapObservation::new(0))), tol).unwrap(),
            Verdict::Hollow
        );
        // unreadable -> Unverified.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Swap(None), tol).unwrap(),
            Verdict::Unverified
        );
    }

    #[test]
    fn route_kind_routes_to_the_route_algebra_refund_rule() {
        let tol = band_15pct();
        let claim = ConnectorClaim::Route(RouteClaim::new(RouteRail::Intent, 1_000, 900));
        // filled, in band, above floor -> Settled.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Route(Some(RouteObservation::filled(1_050))), tol).unwrap(),
            Verdict::Settled
        );
        // refunded -> Hollow (the Khalani refunded rule -- proves the route algebra ran).
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Route(Some(RouteObservation::refunded())), tol).unwrap(),
            Verdict::Hollow
        );
        // unreadable -> Unverified.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Route(None), tol).unwrap(),
            Verdict::Unverified
        );
    }

    #[test]
    fn bridge_kind_routes_to_the_bridge_algebra_hollow_egress_catch() {
        let tol = band_15pct();
        let claim =
            ConnectorClaim::Bridge(HopClaim::new(BridgeLane::UsdcEgress, DestSelector::Ethereum, 1_000_000, 990_000));
        // both legs read, in band, above floor -> Settled.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Bridge(Some(HopObservation::bridged(1_000_000, 1_000_000))), tol).unwrap(),
            Verdict::Settled
        );
        // source burned, destination read + empty -> Hollow (the HOLLOW-EGRESS catch -- the bridge algebra ran).
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Bridge(Some(HopObservation::hollow_egress(1_000_000))), tol).unwrap(),
            Verdict::Hollow
        );
        // source burned, destination UNREADABLE -> Unverified (still in-flight, NOT a defect).
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Bridge(Some(HopObservation::in_flight(1_000_000))), tol).unwrap(),
            Verdict::Unverified
        );
        // source unreadable -> Unverified.
        assert_eq!(
            verify_connector_settlement(&claim, &ConnectorObservation::Bridge(None), tol).unwrap(),
            Verdict::Unverified
        );
    }

    // --- the shape-mismatch guard: a cross-family pair is a loud refusal, never a fabricated settled --

    #[test]
    fn a_cross_family_claim_observation_pair_is_a_loud_mismatch_never_settled() {
        let tol = band_15pct();
        // A swap claim against a settlement observation -> loud ConnectorMismatch, NEVER a verdict.
        let err = verify_connector_settlement(
            &ConnectorClaim::Swap(SwapClaim::new(1_000, 900)),
            &ConnectorObservation::Settlement(Some(1_000)),
            tol,
        )
        .unwrap_err();
        assert_eq!(err.claim_kind, ConnectorKind::Swap);
        assert_eq!(err.observation_kind, ConnectorKind::Settlement);
        assert!(err.to_string().contains("mismatch"));

        // A bridge claim against a route observation -> loud mismatch as well.
        let err2 = verify_connector_settlement(
            &ConnectorClaim::Bridge(HopClaim::new(BridgeLane::UsdcEgress, DestSelector::Ethereum, 1, 0)),
            &ConnectorObservation::Route(Some(RouteObservation::filled(1))),
            tol,
        )
        .unwrap_err();
        assert_eq!(err2.claim_kind, ConnectorKind::Bridge);
        assert_eq!(err2.observation_kind, ConnectorKind::Route);
    }

    #[test]
    fn claim_and_observation_kinds_match_their_variant() {
        assert_eq!(ConnectorClaim::Settlement(1).kind(), ConnectorKind::Settlement);
        assert_eq!(ConnectorClaim::Swap(SwapClaim::new(1, 0)).kind(), ConnectorKind::Swap);
        assert_eq!(ConnectorObservation::Settlement(None).kind(), ConnectorKind::Settlement);
        assert_eq!(ConnectorObservation::Bridge(None).kind(), ConnectorKind::Bridge);
    }

    #[test]
    fn the_unified_entry_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let tol = band_15pct();
        for _ in 0..8 {
            assert_eq!(
                verify_connector_settlement(
                    &ConnectorClaim::Settlement(1_000),
                    &ConnectorObservation::Settlement(Some(1_100)),
                    tol,
                )
                .unwrap(),
                Verdict::Settled
            );
        }
    }

    #[test]
    fn the_unified_entry_mints_only_the_four_verdict_alphabet() {
        // The unifying entry NEVER widens the alphabet -- every Ok verdict is one of the four (design SS2).
        let tol = band_15pct();
        let cases = [
            (ConnectorClaim::Settlement(1_000), ConnectorObservation::Settlement(Some(1_100))),
            (ConnectorClaim::Settlement(1_000), ConnectorObservation::Settlement(Some(1_300))),
            (ConnectorClaim::Settlement(0), ConnectorObservation::Settlement(Some(0))),
            (ConnectorClaim::Settlement(1_000), ConnectorObservation::Settlement(None)),
        ];
        for (c, o) in cases {
            let v = verify_connector_settlement(&c, &o, tol).unwrap();
            assert!(
                matches!(
                    v,
                    Verdict::Settled | Verdict::Hollow | Verdict::Mismatch | Verdict::Unverified
                ),
                "verdict {v} must be in the four-verdict alphabet"
            );
        }
    }

    // --- connector kind canonical strings ----------------------------------------------------------

    #[test]
    fn connector_kind_canonical_strings_round_trip() {
        for k in [
            ConnectorKind::Settlement,
            ConnectorKind::Swap,
            ConnectorKind::Route,
            ConnectorKind::Bridge,
        ] {
            let s = k.canonical_string();
            assert_eq!(ConnectorKind::from_canonical(s), Some(k), "round-trip {s}");
            assert!(s.chars().all(|c| c.is_ascii_lowercase()), "{s} is lowercase");
        }
        assert_eq!(ConnectorKind::from_canonical("nope"), None, "an unknown shape is a loud None");
        assert_eq!(ConnectorKind::from_canonical("SWAP"), None, "the match is case-sensitive");
    }

    // --- the manifest parse: width-by-data (a `[[connector]]` block) --------------------------------

    fn manifest_text() -> &'static str {
        "\
[chain]
id = 16661

[[connector]]
name     = \"native-settlement\"
shape    = \"settlement\"
chains   = [16602, 16661]
priority = 0
gates    = [\"settlement\"]

[[connector]]
name     = \"oku-swap\"
shape    = \"swap\"
chains   = [16661]
priority = 10
gates    = [\"settlement\", \"mandate-cap\"]

[verifier.tolerance]
num = 15
den = 100
"
    }

    #[test]
    fn parses_connector_blocks_in_declaration_order() {
        let m = ConnectorManifest::parse(manifest_text()).expect("well-formed manifest");
        assert_eq!(m.len(), 2);
        let a = &m.entries()[0];
        assert_eq!(a.name, "native-settlement");
        assert_eq!(a.shape, ConnectorKind::Settlement);
        assert_eq!(a.chains, vec![16602, 16661]);
        assert_eq!(a.priority, 0);
        assert_eq!(a.gates, vec!["settlement".to_string()]);
        let b = &m.entries()[1];
        assert_eq!(b.name, "oku-swap");
        assert_eq!(b.shape, ConnectorKind::Swap);
        assert_eq!(b.chains, vec![16661]);
        assert_eq!(b.priority, 10);
        assert_eq!(b.gates, vec!["settlement".to_string(), "mandate-cap".to_string()]);
    }

    #[test]
    fn manifest_get_finds_by_name() {
        let m = ConnectorManifest::parse(manifest_text()).unwrap();
        assert_eq!(m.get("oku-swap").unwrap().shape, ConnectorKind::Swap);
        assert!(m.get("nope").is_none());
    }

    #[test]
    fn an_absent_manifest_is_a_valid_empty_manifest() {
        // A spine with NO [[connector]] block yields an empty manifest -- honestly no declared connectors.
        let m = ConnectorManifest::parse("[chain]\nid = 16661\n").unwrap();
        assert!(m.is_empty());
        assert_eq!(m.len(), 0);
    }

    #[test]
    fn parse_is_deterministic() {
        let a = ConnectorManifest::parse(manifest_text()).unwrap();
        let b = ConnectorManifest::parse(manifest_text()).unwrap();
        assert_eq!(a, b, "same text -> identical manifest (deterministic)");
    }

    #[test]
    fn an_unknown_shape_is_a_loud_error() {
        let text = "\
[[connector]]
name     = \"mystery\"
shape    = \"teleport\"
chains   = [16661]
priority = 0
gates    = [\"settlement\"]
";
        let err = ConnectorManifest::parse(text).unwrap_err();
        assert!(matches!(err, ManifestError::BadShape { .. }));
    }

    #[test]
    fn a_connector_with_no_gates_is_rejected_cannot_vote_itself_in() {
        // The width-by-data safety rule: an adapter that names NO gates cannot be trusted (it would
        // "vote itself in"). An empty gates array is a loud refusal (design WOW Feature 5 / the recipe).
        let text = "\
[[connector]]
name     = \"sneaky\"
shape    = \"swap\"
chains   = [16661]
priority = 0
gates    = []
";
        let err = ConnectorManifest::parse(text).unwrap_err();
        assert!(matches!(err, ManifestError::NoGates { .. }), "no-gates connector must be rejected");
    }

    #[test]
    fn a_missing_required_field_is_a_loud_error() {
        // Missing `gates` entirely.
        let text = "\
[[connector]]
name     = \"incomplete\"
shape    = \"swap\"
chains   = [16661]
priority = 0
";
        let err = ConnectorManifest::parse(text).unwrap_err();
        assert!(matches!(err, ManifestError::Incomplete { field: "gates", .. }));
    }

    #[test]
    fn a_float_chain_id_is_rejected_no_float_on_config() {
        let text = "\
[[connector]]
name     = \"floaty\"
shape    = \"swap\"
chains   = [166.6]
priority = 0
gates    = [\"settlement\"]
";
        let err = ConnectorManifest::parse(text).unwrap_err();
        assert!(matches!(err, ManifestError::BadInteger { field: "connector.chains", .. }));
    }

    #[test]
    fn chains_and_gates_accept_an_empty_inline_array_shape_but_gates_must_be_nonempty() {
        // An empty `chains = []` parses (a connector with no pinned chain is allowed shape-wise), but an
        // empty `gates = []` is the NoGates refusal (asserted above). Here: empty chains, one gate -> ok.
        let text = "\
[[connector]]
name     = \"chainless\"
shape    = \"settlement\"
chains   = []
priority = 0
gates    = [\"settlement\"]
";
        let m = ConnectorManifest::parse(text).unwrap();
        assert_eq!(m.len(), 1);
        assert!(m.entries()[0].chains.is_empty());
        assert_eq!(m.entries()[0].gates, vec!["settlement".to_string()]);
    }
}
