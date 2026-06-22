/**
 * The bridge leg -- `bridge(req)`: a mandate-gated CCIP cross-chain transfer (bridge-IN + bridge-OUT).
 *
 * Design WOW Feature 3 / 3b (Bridge -- XSwap / Chainlink CCIP): "0G's official canonical bridge is XSwap,
 * powered by Chainlink CCIP. ... The guaranteed path is a raw `ccipSend` against the 0G CCIP Router. ...
 * Ahead of the burn the mandate bounds the egress pre-send: it **pins the asset**, pins the **expected
 * `destChainSelector`** (never the decommissioned testnet lane), enforces the cap ..., so **the safest
 * egress failure is the one that never burns on 0G.**" This module is the agent's BUILD of each bridge hop
 * up to the `ccipSend` boundary, with the per-hop mandate gate as the structural pre-condition; the
 * verifier's BRIDGE extension (`verifier/src/bridge.rs`) is the after-send, two-leg, per-hop verdict.
 *
 * ## The two directions, each mandate-gated per hop (design WOW Feature 3 / 3b)
 *
 *  - **bridge-IN** (Ethereum -> 0G, USDC -> USDC.E): a non-CCTP lock-and-mint lane -- lock native USDC on
 *    Ethereum -> mint USDC.E on 0G 1:1, via `IRouterClient.ccipSend(0G-selector, EVM2AnyMessage)` against
 *    the source Router, pinning the 0G destination selector. Cross-chain -> MAINNET-only -> OPERATOR-GATED.
 *  - **bridge-OUT (egress)** (0G -> Ethereum/Arbitrum/Base/BNB): the mirror lane -- BURN USDC.E on 0G ->
 *    release native USDC on Ethereum (CCTP, Ethereum-only), OR LOCK w0G on 0G -> mint w0G on the
 *    destination (CCT direct lanes to Eth/Arb/Base/BNB), via `IRouterClient.ccipSend(dest-selector,
 *    EVM2AnyMessage)` against the 0G Router. Cross-chain -> MAINNET-only -> OPERATOR-GATED.
 *
 * Each hop shares ONE envelope: (1) the MANDATE GATE pre-send (`checkTransfer(agent, token, amount)` must
 * clear, or the hop is refused PRE-BURN -- the kill-switch, design SS5), then (2) BUILD the hop -- the
 * `approve(tokenPool, amount)` on-chain call + the deterministic `ccipSend` descriptor (destSelector +
 * receiver + tokenAmounts + feeToken). The agent's hop NEVER claims `settled` -- that is the verifier's
 * job, and crucially a bridge hop is settled ONLY when the verifier reads BOTH legs (the verdict monopoly,
 * design SS3 principle 2; the hollow-egress catch, design WOW Feature 3b).
 *
 * ## The kill-switch is structural + fail-CLOSED, pinning the EXPECTED destination (design SS3 #3 + SS5)
 *
 * A hop is BUILT only after the mandate gate returns a definitive on-chain `allowed: true`. Beyond the
 * cap, the gate pins the EXPECTED `destChainSelector`: the agent declares which lane it intends, and the
 * build refuses any hop whose selector is not a known, allow-listed CCIP lane (NEVER the decommissioned
 * Galileo testnet lane -- design WOW Feature 3b "pin the expected destChainSelector"). Every other gate
 * outcome -- a `false` verdict, an unreachable RPC, a malformed reply, no transport wired -- yields a
 * refused hop ([`BridgeOutcome.BLOCKED_BY_MANDATE`]); the `ccipSend` is never built, so no burn can occur.
 * The safest egress failure is the one that never burns on 0G.
 *
 * ## MAINNET-only -> the live bridge is OPERATOR-GATED (design SS8 + WOW Feature 3b)
 *
 * CCIP on 0G is MAINNET-only -- **Galileo (16602) CCIP is decommissioned**, so there is NO testnet
 * rehearsal. A live bridge moves REAL value on mainnet (16661) and is OPERATOR-GATED. This module BUILDS
 * every hop end to end (gate + the `ccipSend` descriptor), but its `mode` defaults to
 * [`BridgeExecMode.DRY_RUN`] -- it sends NOTHING, signs NOTHING. A live send requires an explicit
 * `mode: "LIVE"` AND a wired dispatcher, which fails CLOSED with a loud not-wired error otherwise -- it
 * NEVER fabricates a `messageId` / tx hash or a "settled" result (design SS3 principle 3). The exact
 * operator command is documented in `demo/EVIDENCE_BRIDGE.md`.
 *
 * ## Default build needs no network (design SS6, offline-by-default)
 *
 * Without a transport/dispatcher wired, [`bridge`] performs NO network access and signs nothing: it fails
 * CLOSED at the gate (no transport), returning a loud refused hop. The gate is the only network leg, opt-in
 * via the supplied transport. So `tsc` and the default path are fully offline; the `ccipSend` is modelled
 * as a planned, inspectable [`BridgeHopPlan`] (the deterministic build artifact), never a live send.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * `amount` and the derived `minRelease` floor are `bigint`s in MINOR units -- never `number`, never a
 * float. The destination selector is a `bigint` (the exact `uint64` CCIP selector). There is no
 * floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The 0G CCIP Router, the USDC.E / w0G
 * token + pool addresses, and the CCIP destination selectors are PUBLIC protocol facts from design WOW
 * Feature 3 / 3b, supplied via config (never a baked-in private target). The lane is resolved from public
 * config; an unconfigured Router / pool fails the build CLOSED (loud).
 */

import {
  slippageFloor,
  encodeApprove,
  ExecuteError,
  type PlannedCall,
} from "./execute.js";
import {
  checkMandate,
  type MandateConfig,
  type MandateVerdict,
  type EthCallTransport,
  MandateError,
} from "./mandate.js";

/** The whole-percent basis for the min-release floor math (1 bps = 1/100 of a percent) -- exact-integer. */
export const BPS_DENOMINATOR = 10_000 as const;

/** A loud failure on the bridge leg (design SS3 principle 3 -- degrade loudly, never fabricate). */
export class BridgeError extends Error {
  public override readonly name = "BridgeError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, BridgeError.prototype);
  }
}

/**
 * The PUBLIC CCIP destination-chain selectors (design WOW Feature 3 / 3b -- the `chain-selectors`
 * registry). Each is the exact `uint64` `destChainSelector` the source `ccipSend` pins. Mirrors the
 * verifier's `DestSelector` (`verifier/src/bridge.rs`). These are public protocol facts, safe to commit.
 *
 * The agent pins the EXPECTED selector per hop; the build refuses any selector not in this allow-list
 * (NEVER the decommissioned Galileo testnet lane -- design WOW Feature 3b). They are `bigint`s because the
 * CCIP selector is a `uint64` beyond the safe-integer range when ABI-encoded (exact-integer; design SS3 #5).
 */
export const DEST_SELECTOR = {
  /** Ethereum mainnet CCIP selector (the USDC.E egress destination + the bridge-IN source). */
  ETHEREUM: 5_009_297_550_715_157_269n,
  /** 0G Aristotle mainnet CCIP selector (the bridge-IN destination lane). */
  ZEROG: 4_426_351_306_075_016_396n,
  /** Arbitrum One CCIP selector (a w0G direct egress lane). */
  ARBITRUM: 4_949_039_107_694_359_620n,
  /** Base CCIP selector (a w0G direct egress lane). */
  BASE: 15_971_525_489_660_198_786n,
  /** BNB CCIP selector (a w0G direct egress lane). */
  BNB: 11_344_663_589_394_136_015n,
} as const;

/** The set of allow-listed CCIP destination selectors (the EXPECTED lanes the agent may pin). */
const ALLOWED_SELECTORS: ReadonlySet<bigint> = new Set(Object.values(DEST_SELECTOR));

/**
 * `true` iff `selector` is a known, allow-listed CCIP destination lane (design WOW Feature 3b: "pin the
 * expected `destChainSelector`, never the decommissioned testnet lane"). The decommissioned Galileo
 * (16602) CCIP lane is NOT in this set, so a hop can never pin it.
 */
export function isAllowedSelector(selector: bigint): boolean {
  return typeof selector === "bigint" && ALLOWED_SELECTORS.has(selector);
}

/**
 * Which bridged-asset lane a hop rides (design WOW Feature 3 / 3b; the hub-and-spoke section). Mirrors the
 * verifier's `BridgeLane` (`verifier/src/bridge.rs`).
 *
 * Hub-and-spoke directionality: 0G is the SECURED HUB; the other chains are SPOKES. INBOUND lanes carry
 * value FROM a spoke INTO the hub (the autonomous direction -- value enters the chain we already watch +
 * secure); EGRESS lanes carry value OUT of the hub TO a spoke (the risky direction -- the hollow-egress-prone
 * leg + the value-tiered outbound time-lock's domain). The Arbitrum + BNB inbound lanes are w0G CCT direct
 * lanes (lock w0G on the spoke -> mint w0G on the 0G hub); the Ethereum inbound lane is the USDC lock-and-mint.
 */
export const BridgeLane = {
  /** Bridge-IN (spoke -> hub): Ethereum -> 0G, native USDC locked -> USDC.E minted on 0G (1:1 lock-and-mint). */
  USDC_INBOUND: "usdc-inbound",
  /** Bridge-IN (spoke -> hub): Arbitrum -> 0G, w0G locked on Arbitrum -> w0G minted on the 0G hub (CCT direct). */
  W0G_INBOUND_ARBITRUM: "w0g-inbound-arbitrum",
  /** Bridge-IN (spoke -> hub): BNB -> 0G, w0G locked on BNB -> w0G minted on the 0G hub (CCT direct). */
  W0G_INBOUND_BNB: "w0g-inbound-bnb",
  /** Bridge-OUT (hub -> spoke): 0G -> Ethereum, USDC.E burned -> native USDC released on Ethereum (CCTP). */
  USDC_EGRESS: "usdc-egress",
  /** Bridge-OUT (hub -> spoke): 0G -> {Eth/Arb/Base/BNB}, w0G locked on 0G -> w0G minted on the spoke (CCT direct). */
  W0G_EGRESS: "w0g-egress",
} as const;

/** A bridged-asset lane identifier (one of [`BridgeLane`]). */
export type BridgeLane = (typeof BridgeLane)[keyof typeof BridgeLane];

/** The set of all known bridged-asset lanes (the lane allow-list for request validation). */
const KNOWN_LANES: ReadonlySet<string> = new Set(Object.values(BridgeLane));

/** `true` iff `lane` is a known bridged-asset lane (one of [`BridgeLane`]). */
export function isKnownLane(lane: string): lane is BridgeLane {
  return KNOWN_LANES.has(lane);
}

/**
 * `true` iff the lane is an EGRESS lane (value leaving the 0G hub TO a spoke) -- the hollow-egress-prone
 * direction + the value-tiered outbound time-lock's domain (the hub-and-spoke section).
 */
export function laneIsEgress(lane: BridgeLane): boolean {
  return lane === BridgeLane.USDC_EGRESS || lane === BridgeLane.W0G_EGRESS;
}

/**
 * `true` iff the lane is an INBOUND lane (value entering the 0G hub FROM a spoke) -- the AUTONOMOUS
 * direction (the hub-and-spoke section: bridge-IN into the secured hub is autonomous). The exact
 * complement of [`laneIsEgress`] over the known lanes.
 */
export function laneIsInbound(lane: BridgeLane): boolean {
  return (
    lane === BridgeLane.USDC_INBOUND ||
    lane === BridgeLane.W0G_INBOUND_ARBITRUM ||
    lane === BridgeLane.W0G_INBOUND_BNB
  );
}

/**
 * How the bridge hop is allowed to act once the gate clears (design SS8 -- claim only what's live).
 *
 * `DRY_RUN` (default, the only path this build runs): build the hop plan, send NOTHING. `LIVE`:
 * operator-gated -- needs an explicit opt-in AND a wired dispatcher. CCIP on 0G is mainnet-only (Galileo
 * decommissioned), so a live bridge moves REAL value. Passing `LIVE` without a dispatcher fails CLOSED with
 * a loud not-wired reason -- it never fabricates a `messageId` / tx hash.
 */
export const BridgeExecMode = {
  /** Plan-only: build the hop, dispatch nothing (the default; the only path this build runs). */
  DRY_RUN: "DRY_RUN",
  /** Operator-gated live `ccipSend` (needs a wired dispatcher; mainnet-only -- moves REAL value). */
  LIVE: "LIVE",
} as const;

/** The bridge execution mode -- `DRY_RUN` (default, offline) or `LIVE` (operator-gated dispatch). */
export type BridgeExecMode = (typeof BridgeExecMode)[keyof typeof BridgeExecMode];

/**
 * Where the bridge hop ended -- a strict, ordered progression. A run advances stage by stage and stops at
 * the FIRST step that does not pass (mirrors the route leg's [`RouteOutcome`]).
 */
export const BridgeOutcome = {
  /** The mandate gate did not return `allowed: true` -- the kill-switch STOPPED the hop pre-burn. */
  BLOCKED_BY_MANDATE: "blocked_by_mandate",
  /** The gate passed; the `ccipSend` hop was BUILT (dry-run -- NOTHING sent). */
  PLANNED_DRY_RUN: "planned_dry_run",
  /** A live dispatch actually sent the `ccipSend` (operator-gated). */
  DISPATCHED_LIVE: "dispatched_live",
} as const;

/** The furthest step the bridge hop reached on a run. */
export type BridgeOutcome = (typeof BridgeOutcome)[keyof typeof BridgeOutcome];

/**
 * The bridge hop to perform -- the agent's proposal. The `amount` is the amount sent into CCIP (the amount
 * the verifier expects to arrive 1:1); the on-chain `minRelease` floor is derived from it + the tolerance.
 * All amounts are `bigint` MINOR units; the destination selector is a `bigint` (`uint64` CCIP selector).
 */
export interface BridgeHopRequest {
  /** Which bridged-asset lane this hop rides. */
  readonly lane: BridgeLane;
  /** The agent address (must equal the registry's mandated agent -- checked by the gate). */
  readonly agent: string;
  /** The asset being bridged (USDC.e / w0G -- the mandate-bounded, gate-checked token). */
  readonly token: string;
  /** The receiver on the destination chain (the demo wallet; the CCIP `receiver`). */
  readonly receiver: string;
  /** The EXPECTED CCIP destination-chain selector (`uint64` `bigint`) -- pinned + allow-list-checked. */
  readonly destSelector: bigint;
  /** Exact amount sent into CCIP, MINOR units, `bigint` -- the amount the mandate caps + the pool pulls. */
  readonly amount: bigint;
  /** Release tolerance in bps (`0..=10000`). `minRelease = amount - amount*bps/10000` (CCIP fee allowance). */
  readonly toleranceBps: number;
}

/** The public 0G CCIP venue config -- the Router + the per-lane token pool + the fee token. */
export interface BridgeVenueConfig {
  /** The CCIP Router for the SOURCE chain (`IRouterClient.ccipSend` `to`). For egress: the 0G Router. */
  readonly ccipRouter: string;
  /**
   * The token pool to `approve` for the bridged asset (the burnMint / lockRelease pool). The agent
   * `approve`s the pool to pull `amount` of the token before `ccipSend`. Empty until pinned in config
   * (claim only what's live) -> an unconfigured pool fails the build CLOSED (loud).
   */
  readonly tokenPool: string;
  /**
   * The CCIP fee token (`address(0)` sentinel for native gas, or LINK/W0G). Carried in the descriptor;
   * the `approve` is for the bridged token's pool, not the fee token, in this build's lock/burn lanes.
   */
  readonly feeToken: string;
}

/**
 * The default public 0G CCIP venue from design WOW Feature 3b. The Router is the PUBLIC 0G CCIP Router
 * (`0x0aA145a6...f755`), a documented public protocol fact -- safe to commit, not a secret. `tokenPool`
 * is `""` until the on-chain burnMint / lockRelease pool is pinned in `proofagent.toml [bridge]` (claim
 * only what's live); an empty pool fails the build CLOSED (loud), never a baked-in target. `feeToken` is
 * the native-gas sentinel (`address(0)`) by default (the operator may override with LINK/W0G).
 */
export const OG_BRIDGE_VENUE: BridgeVenueConfig = {
  // The PUBLIC 0G CCIP Router (design WOW Feature 3b table). Safe to commit -- a documented protocol fact.
  ccipRouter: "0x0aA145a62153190B8f0D3cA00c441e451529f755",
  // Pinned via config once confirmed on-chain (design data-spine). Empty default -> the build fails
  // closed with a loud not-configured reason (never a baked-in target).
  tokenPool: "",
  // The native-gas fee-token sentinel (address(0)); CCIP fee paid as msg.value. Operator may override.
  feeToken: "0x0000000000000000000000000000000000000000",
};

/**
 * A deterministic, inspectable descriptor of the `IRouterClient.ccipSend` the operator would dispatch --
 * the clean-room, secret-free summary of the CCIP send shape (design WOW Feature 3 / 3b). It is journal/UI
 * data only, never the source of truth. It carries the public Router + the bounded args (destSelector,
 * receiver, tokenAmounts, feeToken), NEVER a key. The full `EVM2AnyMessage` is built by the dispatcher at
 * LIVE time; this descriptor pins exactly what WOULD be sent so a viewer (or the verifier) can inspect it.
 */
export interface CcipSendDescriptor {
  /** The CCIP Router the `ccipSend` targets (the source-chain Router). */
  readonly router: string;
  /** The EXPECTED destination-chain selector (decimal string of the `uint64`). */
  readonly destSelector: string;
  /** The receiver on the destination chain. */
  readonly receiver: string;
  /** The single bridged token + amount in the CCIP `tokenAmounts` (minor units, decimal string). */
  readonly tokenAmount: { readonly token: string; readonly amount: string };
  /** The CCIP fee token (`address(0)` for native gas). */
  readonly feeToken: string;
}

/**
 * A single built bridge hop -- the inspectable, un-sent plan. It carries the ordered on-chain calls (the
 * `approve(tokenPool, amount)` the bridged token needs before the burn/lock) + the deterministic
 * `ccipSend` descriptor. It sends NOTHING -- a viewer (or the verifier, later) can inspect exactly what
 * WOULD be sent.
 */
export interface BridgeHopPlan {
  /** Which lane this plan rides. */
  readonly lane: BridgeLane;
  /** The ordered on-chain calls: `[approve(token -> tokenPool, amount)]` (the burn/lock approval). */
  readonly calls: readonly PlannedCall[];
  /** The deterministic `ccipSend` descriptor the operator would dispatch. */
  readonly ccipSend: CcipSendDescriptor;
  /** The exact-integer on-chain min-release floor (`minRelease`) bound on this hop (MINOR units). */
  readonly minRelease: bigint;
}

/**
 * The honest, structured account of one bridge-hop run (design SS3 principle 3). It states exactly how far
 * the hop got ([`outcome`]) and carries each completed step's output. Nothing here is ever a fabricated
 * success: a blocked gate yields `plan: undefined`; a dry-run yields `dispatched: false` / `refs:
 * undefined` (no live send); only a real live dispatch yields a `messageId` / tx hash. The hop NEVER
 * claims `settled` -- a bridge hop is settled ONLY when the verifier reads BOTH legs (design WOW F3b).
 */
export interface BridgeHopResult {
  /** The lane this hop rode. */
  readonly lane: BridgeLane;
  /** The furthest step the hop reached. */
  readonly outcome: BridgeOutcome;
  /** The EXPECTED destination selector this hop pinned (decimal string), present once validated. */
  readonly destSelector: string;
  /** The mandate gate's verdict -- the kill-switch decision (the rails proof), present once gated. */
  readonly mandate: MandateVerdict | undefined;
  /** The derived on-chain min-release floor `minRelease` (minor units), present once the hop is built. */
  readonly minRelease: bigint | undefined;
  /** The built hop plan, present iff the gate ALLOWED the hop. `undefined` iff the gate blocked. */
  readonly plan: BridgeHopPlan | undefined;
  /** `true` iff a live dispatcher actually sent the `ccipSend`; `false` for a dry-run. */
  readonly dispatched: boolean;
  /**
   * The real on-chain tx hash / CCIP `messageId`(s) iff `dispatched === true`; `undefined` for a dry-run.
   * NEVER fabricated (design SS3 principle 3).
   */
  readonly refs: readonly string[] | undefined;
  /** A human-readable, journal-only note explaining how the run ended. Never the source of truth. */
  readonly note: string;
}

/**
 * A live bridge dispatcher -- the one narrow seam across which a built hop could leave the machine
 * (mirrors the route leg's `RouteDispatcher`). A `DRY_RUN` never reaches it. A `LIVE` dispatcher
 * (operator-wired) would: sign the `approve` + build the full `EVM2AnyMessage`, call `getFee`, and
 * `eth_sendRawTransaction` the `ccipSend{value: fee}`. The build is identical either way (two-source
 * truth, design SS3 principle 1) -- only whether it leaves the machine.
 */
export interface BridgeDispatcher {
  /**
   * Dispatch (or, for a dry-run, merely record) the built hop.
   * @returns the tx hash / CCIP `messageId`(s) on a real dispatch, or `undefined` for a no-op.
   * @throws on any signing/transport failure -- [`bridge`] maps a throw to a loud failure, never to a
   *   fabricated success.
   */
  dispatch(plan: BridgeHopPlan): Promise<readonly string[] | undefined>;
}

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ----------------------------------------------------------------------------------------------
// The hop builder -- pure, offline. Returns a deterministic, inspectable BridgeHopPlan.
// ----------------------------------------------------------------------------------------------

/**
 * Build the deterministic `ccipSend` descriptor (the Router + bounded args) for a hop. Pure + secret-free
 * -- it names the public Router + echoes the bounded args (destSelector, receiver, token, amount,
 * feeToken), NEVER a key.
 */
function buildCcipSendDescriptor(
  req: BridgeHopRequest,
  router: string,
  feeToken: string,
): CcipSendDescriptor {
  return {
    router,
    destSelector: req.destSelector.toString(),
    receiver: req.receiver,
    tokenAmount: { token: req.token, amount: req.amount.toString() },
    feeToken,
  };
}

/**
 * Build the bridged-token `approve(tokenPool, amount)` call -- the burn/lock approval CCIP needs before
 * `ccipSend` pulls the token (design WOW Feature 3b step (2): "approve the token pool"). This reuses the
 * SAME audited ERC-20 `approve` codec the swap/route legs use (`encodeApprove`). The pool address comes
 * from config (the public burnMint / lockRelease pool on 0G, pinned in `proofagent.toml [bridge]`); an
 * unconfigured pool fails CLOSED (loud).
 */
function buildApproveCall(req: BridgeHopRequest, tokenPool: string): PlannedCall {
  if (typeof tokenPool !== "string" || !ADDRESS_RE.test(tokenPool.trim())) {
    throw new BridgeError(
      `BRIDGE_POOL_NOT_CONFIGURED: the CCIP token pool address is unset/invalid (${String(
        tokenPool,
      )}); pin it in proofagent.toml [bridge] before building the ${req.lane} hop`,
    );
  }
  const pool = tokenPool.trim().toLowerCase();
  return {
    label: "approve",
    to: req.token,
    data: encodeApprove(pool, req.amount),
    value: 0n,
  };
}

// ----------------------------------------------------------------------------------------------
// bridge -- the hop. mandate-gate (asset + EXPECTED selector + cap) -> build -> dispatch (dry-run default).
// ----------------------------------------------------------------------------------------------

/**
 * Perform one mandate-gated bridge hop (design WOW Feature 3 / 3b): pin + validate the EXPECTED
 * destination selector, gate the spend pre-send, then BUILD the `ccipSend` hop. The kill-switch ordering
 * is structural -- the hop is BUILT only after the gate returns a definitive on-chain `allowed: true`, and
 * the EXPECTED destination selector is asserted PRE-BUILD (never the decommissioned testnet lane).
 *
 * Steps:
 *   1. **pin the expected destination** -- the `destSelector` must be a known, allow-listed CCIP lane
 *      ([`isAllowedSelector`]); a non-allow-listed selector (e.g. the decommissioned Galileo lane) is a
 *      loud refusal PRE-GATE (design WOW Feature 3b -- "pin the expected destChainSelector").
 *   2. **mandate-gate** (the kill-switch, PRE-BURN) -- [`checkMandate`] performs `checkTransfer(agent,
 *      token, amount)`. If it does NOT return `allowed: true`, the hop STOPS (`outcome =
 *      BLOCKED_BY_MANDATE`); the `ccipSend` is never built, so no burn can occur.
 *   3. **build** -- derive the exact-integer `minRelease` floor, then build the hop: the `approve(token ->
 *      pool, amount)` call + the deterministic `ccipSend` descriptor. (`outcome = PLANNED_DRY_RUN`.)
 *   4. **dispatch** -- `DRY_RUN` (default) sends NOTHING. `LIVE` is operator-gated and needs a wired
 *      dispatcher (mainnet-only -- CCIP on Galileo is decommissioned, so this moves REAL value).
 *
 * The function NEVER throws for an operational hop failure (a blocked gate) -- that is reported in the
 * returned [`BridgeHopResult`]. It DOES throw [`BridgeError`] for a programmer error in the request (a
 * malformed address/amount/tolerance, a non-allow-listed selector, an unconfigured pool) or a
 * `LIVE`-not-wired failure -- loud, before any dispatch.
 *
 * @param req         The bridge-hop proposal (lane, agent, token, receiver, destSelector, amount, tolerance).
 * @param config      The mandate registry (gate) + the public CCIP venue (Router/pool/feeToken).
 * @param mode        `DRY_RUN` (default) or `LIVE` (operator-gated; needs a dispatcher).
 * @param transport   The `eth_call` transport for the gate. Omit for the offline path (the hop then fails
 *                    CLOSED at the gate -- design SS6).
 * @param dispatcher  OPTIONAL live dispatcher. Used ONLY in `LIVE`. Omit it for the dry-run.
 * @throws {BridgeError} on a malformed request or a `LIVE`-not-wired failure (loud, before any dispatch).
 */
export async function bridge(
  req: BridgeHopRequest,
  config: { readonly mandate: MandateConfig; readonly venue?: BridgeVenueConfig },
  mode: BridgeExecMode = BridgeExecMode.DRY_RUN,
  transport?: EthCallTransport,
  dispatcher?: BridgeDispatcher,
): Promise<BridgeHopResult> {
  // Validate the request shape up front (a malformed amount/tolerance is a loud programmer error,
  // distinct from an operational failure).
  if (typeof req.amount !== "bigint" || req.amount <= 0n) {
    throw new BridgeError(`amount must be a positive bigint in minor units, got ${String(req.amount)}`);
  }
  if (!isKnownLane(req.lane)) {
    throw new BridgeError(
      `unknown lane: ${String(req.lane)} (expected usdc-inbound / w0g-inbound-arbitrum / ` +
        "w0g-inbound-bnb / usdc-egress / w0g-egress)",
    );
  }

  // --- (1) pin the EXPECTED destination selector (design WOW Feature 3b -- never the decommissioned lane) ---
  // A non-allow-listed selector (e.g. the decommissioned Galileo CCIP lane) is a loud refusal PRE-GATE:
  // the agent can only emit lane-shaped, correctly-addressed sends.
  if (!isAllowedSelector(req.destSelector)) {
    throw new BridgeError(
      `BRIDGE_DEST_NOT_ALLOWED: destSelector ${String(
        req.destSelector,
      )} is not an allow-listed CCIP lane; the agent must pin the EXPECTED destination (never the ` +
        "decommissioned Galileo testnet lane). Allowed: Ethereum / 0G / Arbitrum / Base / BNB.",
    );
  }

  const venue = config.venue ?? OG_BRIDGE_VENUE;
  const destSelectorStr = req.destSelector.toString();

  // --- (2) mandate-gate (the kill-switch, PRE-BURN -- design WOW Feature 3b) --------------------
  // No transport => offline => the gate cannot read the chain => a loud refused hop (fail-closed, SS6).
  if (transport === undefined) {
    return {
      lane: req.lane,
      outcome: BridgeOutcome.BLOCKED_BY_MANDATE,
      destSelector: destSelectorStr,
      mandate: {
        allowed: false,
        reason: "BRIDGE_GATE_NOT_WIRED: no eth_call transport supplied; the mandate gate cannot read the chain",
        verified: false,
      },
      minRelease: undefined,
      plan: undefined,
      dispatched: false,
      refs: undefined,
      note:
        "BRIDGE_GATE_NOT_WIRED: no eth_call transport supplied -- the per-hop mandate gate could not read " +
        "the chain, so the bridge hop is refused PRE-BURN (offline-by-default; wire a transport). The " +
        "safest egress failure is the one that never burns on 0G.",
    };
  }

  // checkTransfer(agent, token, amount). A malformed spend is a loud BridgeError; an operational failure
  // (RPC error, over-cap) is a fail-closed verdict that STOPS the hop before any burn.
  let mandate: MandateVerdict;
  try {
    mandate = await checkMandate(
      { agent: req.agent, token: req.token, amount: req.amount },
      config.mandate,
      transport,
    );
  } catch (err) {
    if (err instanceof MandateError) {
      throw new BridgeError(`mandate gate rejected the spend request: ${err.message}`);
    }
    throw err;
  }

  if (!mandate.allowed) {
    // THE KILL-SWITCH (design SS5 / WOW Feature 3b): a non-allowed gate STOPS the hop PRE-BURN. The
    // `ccipSend` is never built, so no burn on 0G can occur -- "the safest egress failure never burns".
    return {
      lane: req.lane,
      outcome: BridgeOutcome.BLOCKED_BY_MANDATE,
      destSelector: destSelectorStr,
      mandate,
      minRelease: undefined,
      plan: undefined,
      dispatched: false,
      refs: undefined,
      note:
        `mandate gate BLOCKED the ${req.lane} hop (reason: ${String(mandate.reason)}; verified=${String(
          mandate.verified,
        )}) -- the hop did NOT build or burn (the cap is a kill-switch, enforced per hop pre-burn).`,
    };
  }

  // --- (3) build (derive the floor + the ccipSend descriptor + the approve call) ----------------
  // The gate ALLOWED the spend. Derive the exact-integer min-release floor, then build the hop.
  let minRelease: bigint;
  try {
    minRelease = slippageFloor(req.amount, req.toleranceBps);
  } catch (err) {
    if (err instanceof ExecuteError) {
      throw new BridgeError(`bridge floor derivation failed: ${err.message}`);
    }
    throw err;
  }

  let approveCall: PlannedCall;
  try {
    approveCall = buildApproveCall(req, venue.tokenPool);
  } catch (err) {
    if (err instanceof ExecuteError) {
      throw new BridgeError(`bridge hop build failed: ${err.message}`);
    }
    throw err;
  }

  const plan: BridgeHopPlan = {
    lane: req.lane,
    calls: [approveCall],
    ccipSend: buildCcipSendDescriptor(req, venue.ccipRouter, venue.feeToken),
    minRelease,
  };

  // --- (4) dispatch (dry-run default; LIVE operator-gated -- CCIP mainnet-only, design SS8) ------
  if (mode !== BridgeExecMode.LIVE) {
    // The default + only path this build exercises: nothing is signed or sent (design SS8). CCIP on 0G is
    // MAINNET-only (Galileo decommissioned) -- there is NO testnet rehearsal.
    return {
      lane: req.lane,
      outcome: BridgeOutcome.PLANNED_DRY_RUN,
      destSelector: destSelectorStr,
      mandate,
      minRelease,
      plan,
      dispatched: false,
      refs: undefined,
      note:
        `dry-run complete: gate ALLOWED, ${req.lane} hop BUILT (dest=${destSelectorStr}, floor=${minRelease}, ` +
        `${plan.calls.length} on-chain call), sent NOTHING (CCIP is MAINNET-only -- Galileo decommissioned ` +
        `-- so a live bridge is OPERATOR-GATED). The verifier's BRIDGE extension reads BOTH legs + mints the ` +
        `per-hop verdict (this hop NEVER claims settled; a hollow-egress is caught LOUD -- design WOW F3b).`,
    };
  }

  // mode === LIVE: operator-gated dispatch. Requires an explicitly-wired dispatcher.
  if (dispatcher === undefined) {
    throw new BridgeError(
      `BRIDGE_LIVE_NOT_WIRED: live dispatch of the ${req.lane} hop is operator-gated and no BridgeDispatcher ` +
        "was supplied; refusing to burn/send. CCIP on 0G is MAINNET-only (Galileo decommissioned), so a live " +
        "bridge moves REAL value. Wire a dispatcher (a funded-wallet signer / ccipSend submitter) to enable " +
        "LIVE (design SS8). DRY_RUN builds the hop without sending; nothing was burned.",
    );
  }

  // A live dispatcher IS wired (operator-supplied). Dispatch the built hop; any throw is a loud failure
  // (never a fabricated success). An `undefined` return is treated as "nothing was sent".
  let refs: readonly string[] | undefined;
  try {
    refs = await dispatcher.dispatch(plan);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BridgeError(`bridge live dispatch failed: ${detail}`);
  }

  if (refs !== undefined && refs.length > 0) {
    // A live dispatch actually sent (operator-gated). The verifier's BRIDGE extension stamps it per hop.
    return {
      lane: req.lane,
      outcome: BridgeOutcome.DISPATCHED_LIVE,
      destSelector: destSelectorStr,
      mandate,
      minRelease,
      plan,
      dispatched: true,
      refs,
      note:
        `live ${req.lane} ccipSend (${refs.length} ref): gate ALLOWED, dest=${destSelectorStr}, floor=${minRelease}. ` +
        `The verifier's BRIDGE extension reads BOTH legs (source burn + destination release) + mints the per-hop ` +
        `verdict -- a hollow-egress (burned-on-0G, nothing-on-dest) is caught LOUD (this hop NEVER claims ` +
        `settled -- design SS3 principle 2/3; design WOW Feature 3b).`,
    };
  }

  // The dispatcher reported no ref: honestly surface "not dispatched", never a fake success.
  return {
    lane: req.lane,
    outcome: BridgeOutcome.PLANNED_DRY_RUN,
    destSelector: destSelectorStr,
    mandate,
    minRelease,
    plan,
    dispatched: false,
    refs: undefined,
    note:
      `live dispatch reported no reference for the ${req.lane} hop -- nothing was sent (honest no-op, never ` +
      `a fabricated success -- design SS3 principle 3).`,
  };
}
