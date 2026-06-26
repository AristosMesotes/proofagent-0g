//! `verifier` -- the independent on-chain settlement verifier.
//!
//! Design SS2 (the three proofs): the Settlement proof is "an independent Rust verifier reads 0G
//! via raw JSON-RPC and stamps each trade settled / hollow / mismatch / unverified -- it never
//! trusts the UI."
//!
//! This crate owns the [`Verdict`] type and is the sole minter of verdicts (design SS3 principle 2,
//! the verdict monopoly). It is `std`-only and deterministic by construction (design SS3
//! principle 4). The chain-reading legs (raw `eth_getTransactionReceipt` / `eth_call`) are added in
//! later steps and will be feature-gated so the default build needs no network.
//!
//! STEP VS1 established the workspace and the [`Verdict`] monopoly. STEP VS2 adds the settlement
//! algebra [`adjudicate`] (design SS3 principle 1, two-source truth; principle 5, exact-integer
//! money) -- the in-crate function that mints a [`Verdict`] from a claimed amount and an independent
//! on-chain observation, with no floating point anywhere on the money path. STEP VS3 adds the
//! [`Source`] trait -- the independent on-chain read seam (the **Observation** half of two-source
//! truth, design SS3 principle 1) -- with a deterministic, std-only [`TapeSource`] replay and a
//! feature-gated `LiveSource` that reads 0G itself via raw JSON-RPC (`eth_getTransactionReceipt` +
//! `eth_getTransactionByHash`; only compiled + re-exported under the `live` feature), so the default
//! build stays offline and dependency-free. The
//! [`observed_amount`] bridge ties an unavailable read to [`adjudicate`]'s `Unverified` degrade
//! (design SS3 principle 3, never fabricate).
//!
//! STEP VS4 adds the [`config`] module -- the data spine (`proofagent.toml`) read into a
//! [`SpineConfig`] (the verifier corpus + exact-integer tolerance, design SS4) -- and the
//! [`verify_tx`] one-shot that drives the verify leg of the loop (design SS5): look up the recorded
//! claim for a hash, take an independent [`Source`] read, [`adjudicate`], and return the [`Verdict`].
//! The `verifier verify-tx <hash>` binary is this leg on the command line.
//!
//! STEP VS5 makes the **NEG case** (design SS2) a property of [`verify_tx`]: a fabricated / unknown hash
//! (well-formed, but with no recorded claim) stamps [`Verdict::Unverified`] -- it degrades *loudly*,
//! never to a fabricated [`Verdict::Settled`] (design SS3 principle 3). The only `Err` left is a string
//! that is not a transaction hash at all ([`VerifyError::BadHash`]). This is the single most important
//! demo invariant: `verifier verify-tx <fabricated-hash>` -> `unverified`.
//!
//! STEP WOW-SWAP adds the [`swap`] module -- the SWAP verifier extension (design WOW Feature 1). A
//! Uniswap-V3 single-hop swap does not move native `value`; it moves an ERC-20 output token whose
//! realized `amountOut` is carried in the pool's `Swap` event. [`swap::verify_swap`] reads that event
//! (the realized output -- the **Observation**), adjudicates it against the agent's [`swap::SwapClaim`]
//! (the quoted `expectedOut` + the on-chain `amountOutMinimum` floor -- the **Claim**) through
//! [`swap::adjudicate_swap`], and mints one of the SAME four [`Verdict`]s -- there is no new verdict
//! enum, so the swap leg cannot escape the verdict monopoly (design SS3 principle 2). It is offline-
//! buildable (a deterministic [`swap::SwapTape`]) with a feature-gated `LiveSwapSource`
//! (`eth_getTransactionReceipt` -> the `Swap` log) that reads 0G itself, like the settlement
//! [`LiveSource`].
//!
//! STEP WOW-ROUTING adds the [`route`] module -- the ROUTE verifier extension (design WOW Feature 2). A
//! routed action settles by DELIVERING an output to the recipient on a public rail (intent / aggregation
//! / native AMM) AND carries a rail-level TERMINAL status a naive integration would trust blindly.
//! [`route::verify_route_leg`] reads the leg's settle/refund event + delivered amount (the **Observation**)
//! and adjudicates it against the agent's [`route::RouteClaim`] (the quoted `expected_out` + the on-chain
//! `min_out` floor -- the **Claim**) through [`route::adjudicate_route_leg`], minting one of the SAME four
//! [`Verdict`]s (the monopoly, design SS3 principle 2). The Khalani `refunded` rule (design WOW Feature 2)
//! is structural: a non-settlement terminal (`refunded` / `failed`) is `hollow`, NEVER a fabricated
//! `settled`, checked before any amount math. [`route::verify_route`] composes a multi-leg route -- settled
//! IFF every leg is independently settled. It is offline-buildable (a deterministic [`route::RouteTape`])
//! with a feature-gated `LiveRouteSource` (`eth_getTransactionReceipt` -> the rail's fill/refund log) that
//! reads 0G itself, like the settlement [`LiveSource`].
//!
//! STEP WOW-BRIDGE adds the [`bridge`] module -- the BRIDGE verifier extension (design WOW Feature 3 /
//! 3b). A CCIP bridge hop moves value across TWO chains: it must BURN/LOCK on the source AND
//! RELEASE/MINT on the destination. A naive integration reads only the source `ccipSend` and reports
//! "done"; but CCIP delivery is async + not always automatic, so the destination can fail with ZERO
//! tokens released while the source is confirmed -- the **HOLLOW-EGRESS** trap. [`bridge::verify_hop`]
//! reads BOTH legs (the source burn/lock + the destination release/mint -- the **Observation**) and
//! adjudicates them against the agent's [`bridge::HopClaim`] (the `sent` amount + the on-chain
//! `min_release` floor -- the **Claim**) through [`bridge::adjudicate_hop`], minting one of the SAME four
//! [`Verdict`]s (the monopoly, design SS3 principle 2). The hollow-egress catch (source burned, dest read
//! and empty -> `hollow`, LOUD) is the centerpiece, structurally distinct from `unverified` (dest
//! unreadable / still in-flight). [`bridge::verify_bridge`] composes a multi-hop journey -- settled IFF
//! EVERY hop is independently settled. It is offline-buildable (a deterministic [`bridge::BridgeTape`])
//! with a feature-gated `LiveBridgeSource` (a TWO-chain `eth_getTransactionReceipt` reader) that reads 0G
//! and the remote chain itself, like the settlement [`LiveSource`]. CCIP on 0G is MAINNET-only (Galileo
//! CCIP decommissioned), so the live bridge read is OPERATOR-GATED; the tape proves the algebra at $0.
//!
//! STEP LEDGER adds the settlement-truth LEDGER (design SS5a). Every verdict the verifier mints is
//! journalled as one append-only, deterministic, **redacted** record ([`journal::JournalRecord`] -- no
//! home path, no secret, no wall-clock). [`ledger`] projects that journal read-only (per tx: claimed vs
//! chain-observed minor units, the verdict, and the exact-integer delta), and [`ledger::Audit`] surfaces
//! every non-`settled` row (`hollow` / `mismatch` / `unverified`) LOUDLY (design SS3 principle 3 / SS8,
//! zero-loss). The ledger reads ONLY the journal -- never the agent's report, never the UI: the ledger
//! IS the settlement truth.
//!
//! STEP TIMELOCK adds the [`timelock`] module -- the OUTBOUND TIME-LOCK verifier extension (design
//! "2b.2", the risky hub->spoke direction). Bridging value OUT of the secured 0G hub is asymmetrically
//! risky (it burns on the hub, depends on a remote chain to release), so the on-chain `TimelockGuard`
//! makes a large outbound transfer a two-step, value-tiered time-lock: `queueBridgeOut` (mandate-gated,
//! value-tiered delay) -> `executeBridgeOut` (REVERTS unless the delay elapsed) / `cancelBridgeOut`
//! (owner aborts in-window). [`timelock::adjudicate_timelock`] is the verifier's INDEPENDENT confirmation
//! that the lock held: it reads the guard's queued-request state (the recorded schedule + the actual
//! execution time -- the **Observation**) and adjudicates it against the agent's [`timelock::TimelockClaim`]
//! (the amount + the guard's value-tier config -- the **Claim**), minting a [`timelock::TimelockVerdict`]
//! (`confirmed` / `refuted` / `unverified`) under the same monopoly + never-fabricate doctrine as the
//! [`mandate::TierVerdict`]. The NO-BYPASS proof is structural: a request that executed BEFORE its
//! `executableAt` (a bypass the contract makes impossible) reads as a loud `refuted`, never `confirmed`.
//! It is offline-buildable (a deterministic [`timelock::TimelockTape`]); the live read is OPERATOR-GATED.
//!
//! STEP GAS-GATE adds the [`gasfloor`] module -- the GAS-FLOOR verifier extension (design SS3a, the
//! "can't deplete gas" money-safety primitive). The agent gateway enforces a PRE-broadcast gas floor:
//! before any value-moving action it asserts `nativeBalance - actionNativeCost - estGasFee >=
//! minGasReserve` and REFUSES otherwise, so the agent can never spend its native 0G to ~0 and brick the
//! wallet (stuck -- can't pay any tx, can't `cancelBridgeOut`, can't recover). [`gasfloor::adjudicate_gas_floor`]
//! is the verifier's INDEPENDENT confirmation that the reserve HELD post-action: it reads the agent's own
//! native balance AFTER the action (the **Observation**) and adjudicates it against the configured
//! `min_gas_reserve` (the [`gasfloor::GasFloorClaim`]), minting a [`gasfloor::GasFloorVerdict`] (`confirmed`
//! / `refuted` / `unverified`) under the same monopoly + never-fabricate doctrine as the
//! [`mandate::TierVerdict`] and the [`timelock::TimelockVerdict`]. The depletion catch is structural: a
//! post-action balance that fell BELOW the floor reads a loud `refuted` (a depletion the gate should have
//! blocked -- the verifier proves it did not happen), never `confirmed`. It is offline-buildable (a
//! deterministic [`gasfloor::GasFloorTape`]); the live `eth_getBalance` read is feature-gated.
//!
//! STEP NETWORTH-GATE adds the [`networth`] module -- the NET-WORTH-FLOOR verifier extension (design
//! SS3b, the "can't deplete net worth" PORTFOLIO-level money-safety primitive). The asset cap bounds one
//! asset per action and the gas floor (SS3a) keeps the native token above a reserve, but neither bounds
//! the PORTFOLIO: total net worth -- `Sigma (holdings x price)` across every token + chain -- can still
//! drain via slippage / mismatch / fees / a hack / a string of individually-"settled" but value-losing
//! legs. The net-worth floor is a HARD FLOOR (a kill-switch): HALT if total net worth drops below an
//! ABSOLUTE minimum OR a MAX-DRAWDOWN of session-start (e.g. < 70% -> hard stop, the doctrine).
//! [`networth::adjudicate_net_worth`] is the verifier's INDEPENDENT confirmation that the floor held: it
//! computes net worth from its OWN per-holding chain reads (balances x prices, summed exact-integer -- the
//! **Observation**) and adjudicates it against the configured [`networth::NetWorthFloor`] (the **Claim**),
//! minting a [`networth::NetWorthVerdict`] (`confirmed` / `refuted` / `unverified`) under the same
//! monopoly and never-fabricate doctrine as the [`mandate::TierVerdict`], the [`timelock::TimelockVerdict`],
//! and the [`gasfloor::GasFloorVerdict`]. The agent's self-reported total is NEVER an input (two-source
//! truth). Two
//! structural catches: a total below the floor reads a loud `refuted` (a depletion the kill-switch should
//! have blocked); and a PARTIAL read (ANY one holding unreadable) degrades the WHOLE net worth to
//! `unverified` -- a partial sum is never passed off as a total (a missing leg could hide a depletion). It
//! is offline-buildable (a deterministic [`networth::NetWorthTape`]); the live multi-balance read is
//! feature-gated.
//!
//! STEP MANDATE-V4 extends the [`mandate`] tier set (the consolidated, hardened `MandateRegistry` from the
//! 9-lens adversarial spec) with the new tier labels (`NotStarted`, `Epoch`, `TxCountCap`, `MinSpend`,
//! `MinUsd`, `UsdStaleness`, `SpokeDefaultDeny`, `ExecuteReGate`, `EgressReservation`) -- each confirmed via
//! the SAME two-source [`mandate::confirm_tier`] gate-read algebra (the new reason codes surface on the
//! frozen `checkTransfer` shape, so no new read seam is needed). It adds the [`reconciler`] module -- the
//! named system invariant I14-R that BACKS the ADVISORY, NON-CUSTODIAL mandate: the registry holds no funds,
//! so "the agent can't overspend" is enforced PRE-broadcast by the gateway and PROVEN here by pairing every
//! `SpendRecorded` accrual 1:1 against the on-chain `Transfer` the verifier reads (a transfer with no record
//! is the dangerous unbounded spend -> a LOUD [`reconciler::ReconcileVerdict::Refuted`], never a fabricated
//! `Reconciled`). The HONEST claim everywhere: "the mandate blocks it pre-broadcast and the verifier proves
//! it", NEVER "physically can't overspend".
//!
//! STEP VERIFIER-UNIFY adds the [`connector`] module -- the ONE door that adjudicates ANY adapter's
//! settlement through the SAME four-[`Verdict`] monopoly (design SS3 principle 2). The verifier grew one
//! settlement leg per protocol (the value leg [`verify_tx`] / [`adjudicate`], the SWAP
//! [`adjudicate_swap`], the ROUTE [`adjudicate_route_leg`], the BRIDGE [`adjudicate_hop`]); each reads a
//! DIFFERENT on-chain fact but mints one of the SAME four verdicts.
//! [`connector::verify_connector_settlement`] is the unifying entry: given a [`connector::ConnectorClaim`]
//! and the verifier's own [`connector::ConnectorObservation`] (both protocol-tagged), it DISPATCHES to the
//! matching per-protocol algebra and mints a single [`Verdict`] -- **no new verdict enum**, the
//! per-protocol decode stays, the entry only composes the proven extensions. A cross-family pair is a loud
//! [`connector::ConnectorMismatch`], never a fabricated `settled` (design SS3 principle 3). The
//! [`connector::ConnectorManifest`] (the `[[connector]]` blocks of `proofagent.toml`) is the width-by-data
//! seam -- a new adapter is a manifest entry (shape · chains · priority · which checks gate it) + the
//! adapter, with ZERO change to this dispatch (design WOW Feature 5, the Engine).
//!
//! STEP FILL-PROOF adds the [`fillproof`] module -- the FILL-PROOF ORACLE for cross-chain intents (the
//! LI.FI-Intents frontier). Intent-settlement protocols release a solver's funds only after an oracle
//! proves the fill; a hash-only oracle pays whatever it is *told* proved. [`fillproof::verify_fill`] makes
//! ProofAgent that oracle, the HONEST version: it reads the destination fill INDEPENDENTLY (the
//! **Observation**) and adjudicates it against the solver's [`fillproof::FillClaim`] through the SAME
//! [`adjudicate`] algebra and the SAME four [`Verdict`]s (the monopoly, design SS3 principle 2), then
//! derives a [`fillproof::FillDecision`] -- RELEASE only on [`Verdict::Settled`], BLOCK otherwise. The
//! HOLLOW-FILL catch is the centerpiece: a positive claimed fill with an independently-observed ZERO
//! delivery is a loud [`Verdict::Hollow`] -> BLOCK, exactly where a hash-only oracle would have paid.
//! Fail-closed (design SS3 principle 3): an out-of-band [`Verdict::Mismatch`] or an unreadable
//! [`Verdict::Unverified`] fill also blocks -- the oracle releases ONLY on a chain-confirmed, within-band
//! fill. Offline-buildable over the existing [`Source`] read seam (the live destination read reuses the
//! settlement [`Source`]).

#![forbid(unsafe_code)]

mod adjudicate;
pub mod bridge;
mod config;
pub mod connector;
pub mod fillproof;
pub mod gasfloor;
pub mod journal;
pub mod ledger;
pub mod mandate;
pub mod networth;
pub mod reconciler;
pub mod route;
mod source;
pub mod swap;
pub mod timelock;
mod verdict;
mod verify;

pub use adjudicate::{adjudicate, Ratio};
pub use bridge::{
    adjudicate_hop, verify_bridge, verify_hop, BridgeLane, BridgeSource, BridgeTape, DestLeg,
    DestSelector, HopClaim, HopObservation, HopReport, SourceLeg,
};
pub use config::{ConfigError, CorpusEntry, SpineConfig};
pub use connector::{
    verify_connector_settlement, ConnectorClaim, ConnectorEntry, ConnectorKind, ConnectorManifest,
    ConnectorMismatch, ConnectorObservation, ManifestError,
};
pub use fillproof::{adjudicate_fill, verify_fill, FillClaim, FillDecision, FillReport};
pub use gasfloor::{
    adjudicate_gas_floor, confirm_gas_floor_via, GasFloorClaim, GasFloorKey, GasFloorObservation,
    GasFloorReport, GasFloorSource, GasFloorTape, GasFloorVerdict,
};
pub use journal::{append_record, parse_journal, JournalError, JournalRecord};
pub use ledger::{project, Audit, LedgerRow, LedgerSummary};
pub use mandate::{
    confirm_tier, confirm_tier_via, ExpectedGate, GateKey, GateObservation, MandateGateSource,
    MandateProbe, MandateTape, Tier, TierReport, TierVerdict,
};
pub use networth::{
    adjudicate_net_worth, confirm_net_worth_via, HoldingObservation, NetWorthClaim, NetWorthFloor,
    NetWorthKey, NetWorthObservation, NetWorthReport, NetWorthSource, NetWorthTape, NetWorthVerdict,
};
pub use reconciler::{
    reconcile, OnchainTransfer, Orphan, OrphanKind, ReconcileReport, ReconcileVerdict, SpendRecord,
};
pub use route::{
    adjudicate_route_leg, verify_route, verify_route_leg, RouteClaim, RouteObservation, RouteRail,
    RouteReport, RouteSource, RouteTape, RouteTerminal,
};
pub use source::{observed_amount, Observation, ReadKey, ReadResult, Source, TapeSource, Unavailable};
pub use swap::{
    adjudicate_swap, verify_swap, SwapClaim, SwapObservation, SwapReport, SwapSource, SwapTape,
    SWAP_EVENT_TOPIC0,
};
pub use timelock::{
    adjudicate_timelock, confirm_timelock_via, LockStatus, TimelockClaim, TimelockKey,
    TimelockObservation, TimelockReport, TimelockSource, TimelockTape, TimelockVerdict, ValueTier,
};
pub use verdict::Verdict;
pub use verify::{verify_tx, VerifyError, VerifyReport, UNKNOWN_KIND};

#[cfg(feature = "live")]
pub use bridge::LiveBridgeSource;
#[cfg(feature = "live")]
pub use gasfloor::LiveGasFloorSource;
#[cfg(feature = "live")]
pub use mandate::{confirm_tier_live, LiveGateSource};
#[cfg(feature = "live")]
pub use networth::{LiveHolding, LiveNetWorthSource};
#[cfg(feature = "live")]
pub use route::LiveRouteSource;
#[cfg(feature = "live")]
pub use source::LiveSource;
#[cfg(feature = "live")]
pub use swap::LiveSwapSource;
