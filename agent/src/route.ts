/**
 * The routing leg -- `route(req)`: a mandate-gated routed action across the public 0G routing rails.
 *
 * Design WOW Feature 2 (Routing -- Khalani / LI.FI / JAINE / CCIP): "Four live rails ... every leg is
 * bounded *before* it fires (`checkTransfer` per leg -- cap, allow-listed asset/route, recipient),
 * composing with [the intent rail's] own 'funds never move if constraints unmet' as defense-in-depth.
 * After settlement the verifier reads 0G directly (never the aggregator API) and mints one verdict per
 * leg." This module is the agent's BUILD of each routed leg up to the broadcast/publish boundary, with
 * the per-leg mandate gate as the structural pre-condition; the verifier's ROUTE extension
 * (`verifier/src/route.rs`) is the after-settlement verdict.
 *
 * ## The three public rails, each mandate-gated per leg (design WOW Feature 2)
 *
 *  - **intent** (Khalani, REST `api.hyperstream.dev`): publish one intent -> atomic **settle-or-refund**.
 *    `GET /v1/chains|tokens` -> `POST /v1/quotes` -> `POST /v1/deposit/build` -> `PUT /v1/deposit/submit`
 *    -> `GET /v1/orders/{addr}` (`deposited -> filled` | `refund_pending -> refunded`). A `refunded` is a
 *    NON-settlement terminal state (the verifier treats it as such -- never a fabricated settle).
 *    Cross-chain -> MAINNET-only -> the value-bearing publish is OPERATOR-GATED.
 *  - **aggregation** (LI.FI, `@lifi/sdk`, 0G key `zerog`): `GET /v1/quote` (`toChain=16661`) -> sign the
 *    `transactionRequest` -> `GET /v1/status`. Cross-chain/aggregated -> MAINNET-only -> OPERATOR-GATED.
 *  - **native-amm** (JAINE V3 router on 0G): a same-chain 0G swap via the standard V3 router shape. This
 *    is the **TESTNET-able rail (16602)** -- a same-chain route can run under the full mandate-gate +
 *    verifier wrap at $0 risk on Galileo.
 *
 * Each leg shares ONE envelope: (1) the MANDATE GATE pre-route (`checkTransfer(agent, token, amount)`
 * must clear, or the leg is refused PRE-BROADCAST -- the kill-switch, design SS5), then (2) BUILD the
 * leg through the rail's public SDK/REST shape (offline-buildable -- the build is a deterministic plan,
 * not a live call). The agent's leg NEVER claims `settled` -- that is the verifier's job (the verdict
 * monopoly, design SS3 principle 2).
 *
 * ## The kill-switch is structural + fail-CLOSED (design SS3 principle 3 + SS5)
 *
 * A leg's plan is BUILT only after the mandate gate returns a definitive on-chain `allowed: true`. Every
 * other gate outcome -- a `false` verdict, an unreachable RPC, a malformed reply, or no transport wired
 * -- yields a refused leg ([`RouteOutcome.BLOCKED_BY_MANDATE`]); the rail call is never planned, so no
 * broadcast/publish can occur. There is no code path in which an unread/failed gate lets a leg proceed.
 *
 * ## MAINNET-only rails -> the live action is OPERATOR-GATED (design SS8)
 *
 * The cross-chain rails (intent / aggregation) are MAINNET-only on 0G (Khalani has no testnet; LI.FI's
 * 0G entry is 16661-only), so a live route moves REAL value and is OPERATOR-GATED. The native-AMM rail
 * (JAINE) is testnet-able on 16602. This module BUILDS every leg end to end (gate + the rail-shaped
 * plan), but its `mode` defaults to [`RouteExecMode.DRY_RUN`] -- it broadcasts/publishes NOTHING, signs
 * NOTHING. A live action requires an explicit `mode: "LIVE"` AND a wired dispatcher, which fails CLOSED
 * with a loud not-wired error otherwise -- it NEVER fabricates a tx hash / order id or a "settled"
 * result (design SS3 principle 3). The exact operator commands are documented in `demo/EVIDENCE_ROUTE.md`.
 *
 * ## Default build needs no network (design SS6, offline-by-default)
 *
 * Without a transport/dispatcher wired, [`route`] performs NO network access and signs nothing: it fails
 * CLOSED at the gate (no transport), returning a loud refused leg. The gate is the only network leg, and
 * it is opt-in via the supplied transport. So `tsc` and the default path are fully offline; the rail SDK
 * calls are modelled as a planned, inspectable [`RouteLegPlan`] (the deterministic build artifact),
 * never a live REST/sign call in this build.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * `amountIn`, the quoted `expectedOut`, and the derived `minOut` are `bigint`s in MINOR units -- never
 * `number`, never a float. The min-output floor is exact-integer (the same `slippageFloor` the swap leg
 * uses). There is no floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The rail endpoints + the JAINE router
 * address are PUBLIC protocol facts from design WOW Feature 2, supplied via config (never a baked-in
 * private target). The intent/aggregation REST hosts are named only as the public documented endpoints.
 */

import {
  slippageFloor,
  encodeExactInputSingle,
  encodeApprove,
  DEFAULT_FEE_TIER,
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

/** The whole-percent basis for the min-output floor math (1 bps = 1/100 of a percent) -- exact-integer. */
export const BPS_DENOMINATOR = 10_000 as const;

/** A loud failure on the routing leg (design SS3 principle 3 -- degrade loudly, never fabricate). */
export class RouteError extends Error {
  public override readonly name = "RouteError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RouteError.prototype);
  }
}

/**
 * Which public routing rail a leg rides (design WOW Feature 2). Mirrors the verifier's `RouteRail`
 * (`verifier/src/route.rs`): intent (Khalani) · aggregation (LI.FI) · native AMM (JAINE V3 on 0G).
 */
export const RouteRail = {
  /** Intent rail (Khalani) -- publish one intent, atomic settle-or-REFUND. Cross-chain, MAINNET. */
  INTENT: "intent",
  /** Aggregation rail (LI.FI) -- aggregated DEX/cross-chain route. Cross-chain, MAINNET. */
  AGGREGATION: "aggregation",
  /** Native AMM rail (JAINE V3 on 0G) -- same-chain swap. TESTNET-able (16602). */
  NATIVE_AMM: "native-amm",
} as const;

/** A routing rail identifier (one of [`RouteRail`]). */
export type RouteRail = (typeof RouteRail)[keyof typeof RouteRail];

/**
 * `true` iff the rail is TESTNET-able on 0G Galileo (16602). Only the native-AMM rail (JAINE) is -- the
 * cross-chain rails (intent/aggregation) are MAINNET-only (design WOW Feature 2 "testnet-safe vs
 * mainnet-only"). This drives the operator-gating: a value-bearing live action on a mainnet-only rail is
 * operator-gated; the native-AMM rail can run a $0 same-chain demo on 16602.
 */
export function railIsTestnetable(rail: RouteRail): boolean {
  return rail === RouteRail.NATIVE_AMM;
}

/**
 * How the routing leg is allowed to act once the gate clears (design SS8 -- claim only what's live).
 *
 * `DRY_RUN` (default, the only path this build runs): build the leg plan, broadcast/publish NOTHING.
 * `LIVE`: operator-gated -- needs an explicit opt-in AND a wired dispatcher. For a mainnet-only rail a
 * live action moves REAL value. Passing `LIVE` without a dispatcher fails CLOSED with a loud not-wired
 * reason -- it never fabricates a hash / order id.
 */
export const RouteExecMode = {
  /** Plan-only: build the leg, dispatch nothing (the default; the only path this build runs). */
  DRY_RUN: "DRY_RUN",
  /** Operator-gated live dispatch (needs a wired dispatcher; mainnet-only rails move REAL value). */
  LIVE: "LIVE",
} as const;

/** The route execution mode -- `DRY_RUN` (default, offline) or `LIVE` (operator-gated dispatch). */
export type RouteExecMode = (typeof RouteExecMode)[keyof typeof RouteExecMode];

/**
 * Where the routing leg ended -- a strict, ordered progression. A run advances stage by stage and stops
 * at the FIRST step that does not pass (mirrors the swap leg's [`SwapOutcome`]).
 */
export const RouteOutcome = {
  /** The mandate gate did not return `allowed: true` -- the kill-switch STOPPED the leg pre-route. */
  BLOCKED_BY_MANDATE: "blocked_by_mandate",
  /** The gate passed; the rail leg was BUILT (dry-run -- NOTHING dispatched). */
  PLANNED_DRY_RUN: "planned_dry_run",
  /** A live dispatch actually sent/published the leg (operator-gated). */
  DISPATCHED_LIVE: "dispatched_live",
} as const;

/** The furthest step the routing leg reached on a run. */
export type RouteOutcome = (typeof RouteOutcome)[keyof typeof RouteOutcome];

/**
 * The routed leg to perform -- the agent's proposal. The quote (`expectedOut`) is the rail's quote the
 * agent obtained (e.g. Khalani `POST /v1/quotes`, LI.FI `GET /v1/quote`, the JAINE quoter); the on-chain
 * `minOut` floor is derived from it + the slippage tolerance. All amounts are `bigint` MINOR units.
 */
export interface RouteLegRequest {
  /** Which public rail this leg rides. */
  readonly rail: RouteRail;
  /** The agent address (must equal the registry's mandated agent -- checked by the gate). */
  readonly agent: string;
  /** The asset being SOLD (the mandate-bounded, gate-checked input token). */
  readonly tokenIn: string;
  /** The asset being BOUGHT / delivered. */
  readonly tokenOut: string;
  /** Who receives `tokenOut` (the demo wallet; the gate's recipient bound). */
  readonly recipient: string;
  /** Exact input, MINOR units, `bigint` -- the amount the mandate caps + the rail pulls. */
  readonly amountIn: bigint;
  /** The rail's quoted output for this leg, MINOR units, `bigint` -- drives the min-output floor. */
  readonly expectedOut: bigint;
  /** Slippage / route-quality tolerance in bps (`0..=10000`). `minOut = expectedOut - expectedOut*bps/10000`. */
  readonly slippageBps: number;
  /**
   * The pool fee tier for the native-AMM (JAINE V3) leg (hundredths of a bip). Ignored by the
   * cross-chain rails. Defaults to [`DEFAULT_FEE_TIER`] if omitted.
   */
  readonly fee?: number;
}

/** The public 0G routing-rail venue config (the rail endpoints + the native-AMM router address). */
export interface RouteVenueConfig {
  /** The native-AMM (JAINE V3) router address on 0G (the `approve` spender + the swap `to`). */
  readonly jaineRouter: string;
  /** The intent-rail (Khalani) public REST host (documented public endpoint). */
  readonly intentRestHost: string;
  /** The aggregation-rail (LI.FI) 0G integrator key (the public `zerog` key). */
  readonly aggregationKey: string;
}

/**
 * The default public 0G routing venue from design WOW Feature 2. These are PUBLIC protocol facts (the
 * documented rail endpoints + the JAINE V3 router), safe to commit -- not secrets, not proprietary.
 * `jaineRouter` is `""` until the on-chain JAINE V3 router address is pinned in `proofagent.toml`
 * `[route]` (claim only what's live); an empty router fails the native-AMM build CLOSED (loud).
 */
export const OG_ROUTE_VENUE: RouteVenueConfig = {
  // Pinned via config once confirmed on-chain (design data-spine). Empty default -> native-AMM build
  // fails closed with a loud not-configured reason (never a baked-in target).
  jaineRouter: "",
  // The public Khalani REST host (design WOW Feature 2: REST `api.hyperstream.dev`).
  intentRestHost: "https://api.hyperstream.dev",
  // The public LI.FI 0G integrator key (design WOW Feature 2: `@lifi/sdk`, 0G key `zerog`).
  aggregationKey: "zerog",
};

/**
 * A single rail-shaped build of a routed leg -- the inspectable, un-dispatched plan. For the native-AMM
 * rail this is the ordered on-chain calls (`approve` then the V3 router swap); for the cross-chain rails
 * it is the deterministic REST/SDK request descriptor the operator would sign/submit. It dispatches
 * NOTHING -- a viewer (or the verifier, later) can inspect exactly what *would* be sent.
 */
export interface RouteLegPlan {
  /** Which rail this plan rides. */
  readonly rail: RouteRail;
  /** The ordered on-chain calls for an on-chain rail (native-AMM); empty for a pure REST/SDK rail. */
  readonly calls: readonly PlannedCall[];
  /**
   * The deterministic rail request descriptor (a human/inspectable summary of the public SDK/REST call
   * the operator would dispatch). Carries no secret -- the endpoint shape + the bounded args only.
   */
  readonly request: RouteRequestDescriptor;
  /** The exact-integer on-chain min-output floor (`minOut`) bound on this leg (MINOR units). */
  readonly minOut: bigint;
}

/**
 * A deterministic, inspectable descriptor of the public rail call the operator would dispatch -- the
 * clean-room, secret-free summary of the rail's SDK/REST shape (design WOW Feature 2). It is journal/UI
 * data only, never the source of truth. It carries the public endpoint + the bounded args, NEVER a key.
 */
export interface RouteRequestDescriptor {
  /** The rail this descriptor is for. */
  readonly rail: RouteRail;
  /** A human-readable label of the public SDK/REST entrypoint (e.g. `"Khalani POST /v1/quotes"`). */
  readonly endpoint: string;
  /** The bounded args the operator would dispatch (input/output token, amount, recipient, minOut). */
  readonly args: {
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly amountIn: string;
    readonly recipient: string;
    readonly minOut: string;
  };
}

/**
 * The honest, structured account of one routing-leg run (design SS3 principle 3). It states exactly how
 * far the leg got ([`outcome`]) and carries each completed step's output. Nothing here is ever a
 * fabricated success: a blocked gate yields `plan: undefined`; a dry-run yields `dispatched: false` /
 * `refs: undefined` (no live send); only a real live dispatch yields a tx hash / order id.
 */
export interface RouteLegResult {
  /** The rail this leg rode. */
  readonly rail: RouteRail;
  /** The furthest step the leg reached. */
  readonly outcome: RouteOutcome;
  /** The mandate gate's verdict -- the kill-switch decision (the rails proof), present once gated. */
  readonly mandate: MandateVerdict | undefined;
  /** The derived on-chain min-output floor `minOut` (minor units), present once the leg is built. */
  readonly minOut: bigint | undefined;
  /** The built leg plan, present iff the gate ALLOWED the leg. `undefined` iff the gate blocked. */
  readonly plan: RouteLegPlan | undefined;
  /** `true` iff a live dispatcher actually sent/published the leg; `false` for a dry-run. */
  readonly dispatched: boolean;
  /**
   * The real on-chain tx hash(es) / order reference(s) iff `dispatched === true`; `undefined` for a
   * dry-run. NEVER fabricated (design SS3 principle 3).
   */
  readonly refs: readonly string[] | undefined;
  /** A human-readable, journal-only note explaining how the run ended. Never the source of truth. */
  readonly note: string;
}

/**
 * A live route dispatcher -- the one narrow seam across which a built leg could leave the machine
 * (mirrors the swap leg's `SwapBroadcaster`). A `DRY_RUN` never reaches it. A `LIVE` dispatcher
 * (operator-wired) would: for the native-AMM rail, sign + `eth_sendRawTransaction` the ordered calls;
 * for a cross-chain rail, sign the rail's `transactionRequest` / submit the intent deposit. The build is
 * identical either way (two-source truth, design SS3 principle 1) -- only whether it leaves the machine.
 */
export interface RouteDispatcher {
  /**
   * Dispatch (or, for a dry-run, merely record) the built leg.
   * @returns the tx hash(es) / order reference(s) on a real dispatch, or `undefined` for a no-op.
   * @throws on any signing/transport failure -- [`route`] maps a throw to a loud failure, never to a
   *   fabricated success.
   */
  dispatch(plan: RouteLegPlan): Promise<readonly string[] | undefined>;
}

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ----------------------------------------------------------------------------------------------
// Per-rail leg builders -- pure, offline. Each returns a deterministic, inspectable RouteLegPlan.
// ----------------------------------------------------------------------------------------------

/**
 * Build the deterministic request descriptor (the public endpoint + bounded args) for a leg. Pure +
 * secret-free -- it names the public SDK/REST entrypoint and echoes the bounded args, NEVER a key.
 */
function buildRequestDescriptor(req: RouteLegRequest, minOut: bigint): RouteRequestDescriptor {
  const endpoint =
    req.rail === RouteRail.INTENT
      ? "Khalani intent: POST /v1/quotes -> /v1/deposit/build -> PUT /v1/deposit/submit"
      : req.rail === RouteRail.AGGREGATION
        ? "LI.FI aggregation: GET /v1/quote (toChain=16661) -> sign transactionRequest"
        : "JAINE V3 router: exactInputSingle (same-chain 0G)";
  return {
    rail: req.rail,
    endpoint,
    args: {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn.toString(),
      recipient: req.recipient,
      minOut: minOut.toString(),
    },
  };
}

/**
 * Build the native-AMM (JAINE V3) leg's ordered on-chain calls: `approve(router, amountIn)` then the V3
 * router `exactInputSingle` with `amountOutMinimum = minOut`. This reuses the SAME audited V3 codec the
 * swap leg uses (`encodeApprove` / `encodeExactInputSingle`, 7-field tuple, no deadline -- the JAINE V3
 * router is a standard Uniswap-V3-style router). The router address comes from config (the public JAINE
 * V3 router on 0G, pinned in `proofagent.toml [route]`); an unconfigured router fails CLOSED (loud).
 */
function buildNativeAmmCalls(
  req: RouteLegRequest,
  jaineRouter: string,
  minOut: bigint,
): readonly PlannedCall[] {
  if (typeof jaineRouter !== "string" || !ADDRESS_RE.test(jaineRouter.trim())) {
    throw new RouteError(
      `ROUTE_NATIVE_AMM_NOT_CONFIGURED: the JAINE V3 router address is unset/invalid (${String(
        jaineRouter,
      )}); pin it in proofagent.toml [route] before building the native-AMM leg`,
    );
  }
  const router = jaineRouter.trim().toLowerCase();
  const fee = req.fee ?? DEFAULT_FEE_TIER;
  // Call 1: approve the router to pull amountIn of tokenIn.
  const approveCall: PlannedCall = {
    label: "approve",
    to: req.tokenIn,
    data: encodeApprove(router, req.amountIn),
    value: 0n,
  };
  // Call 2: the V3 router swap (7-field tuple, no deadline; amountOutMinimum = minOut, sqrtPriceLimit 0).
  const swapCall: PlannedCall = {
    label: "exactInputSingle",
    to: router,
    data: encodeExactInputSingle({
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      fee,
      recipient: req.recipient,
      amountIn: req.amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }),
    value: 0n,
  };
  return [approveCall, swapCall];
}

// ----------------------------------------------------------------------------------------------
// route -- the leg. mandate-gate -> build (per rail) -> dispatch (dry-run default; live operator-gated).
// ----------------------------------------------------------------------------------------------

/**
 * Perform one mandate-gated routing leg (design WOW Feature 2): gate the spend pre-route, then BUILD the
 * leg through the rail's public shape. The kill-switch ordering is structural -- the leg is BUILT only
 * after the gate returns a definitive on-chain `allowed: true`.
 *
 * Steps:
 *   1. **mandate-gate** (the kill-switch, PRE-ROUTE) -- [`checkMandate`] performs `checkTransfer(agent,
 *      tokenIn, amountIn)`. If it does NOT return `allowed: true`, the leg STOPS (`outcome =
 *      BLOCKED_BY_MANDATE`); the rail leg is never built, so no broadcast/publish can occur.
 *   2. **build** -- derive the exact-integer `minOut` floor from the quote + slippage, then build the
 *      rail-shaped plan: for native-AMM, the ordered on-chain calls; for the cross-chain rails, the
 *      deterministic request descriptor. (`outcome = PLANNED_DRY_RUN` for the default dry-run.)
 *   3. **dispatch** -- `DRY_RUN` (default) dispatches NOTHING. `LIVE` is operator-gated and needs a wired
 *      dispatcher (mainnet-only for the cross-chain rails -- real value).
 *
 * The function NEVER throws for an operational leg failure (a blocked gate) -- that is reported in the
 * returned [`RouteLegResult`]. It DOES throw [`RouteError`] for a programmer error in the request (a
 * malformed address/amount/slippage, an unconfigured native-AMM router) or a `LIVE`-not-wired failure --
 * loud, before any dispatch.
 *
 * @param req         The routed-leg proposal (rail, agent, tokens, amountIn, quote, slippage).
 * @param config      The mandate registry (gate) + the public routing venue (rail endpoints/router).
 * @param mode        `DRY_RUN` (default) or `LIVE` (operator-gated; needs a dispatcher).
 * @param transport   The `eth_call` transport for the gate. Omit for the offline path (the leg then
 *                    fails CLOSED at the gate -- design SS6).
 * @param dispatcher  OPTIONAL live dispatcher. Used ONLY in `LIVE`. Omit it for the dry-run.
 * @throws {RouteError} on a malformed request or a `LIVE`-not-wired failure (loud, before any dispatch).
 */
export async function route(
  req: RouteLegRequest,
  config: { readonly mandate: MandateConfig; readonly venue?: RouteVenueConfig },
  mode: RouteExecMode = RouteExecMode.DRY_RUN,
  transport?: EthCallTransport,
  dispatcher?: RouteDispatcher,
): Promise<RouteLegResult> {
  // Validate the request shape up front (a malformed amount/slippage is a loud programmer error,
  // distinct from an operational failure).
  if (typeof req.amountIn !== "bigint" || req.amountIn <= 0n) {
    throw new RouteError(`amountIn must be a positive bigint in minor units, got ${String(req.amountIn)}`);
  }
  if (req.rail !== RouteRail.INTENT && req.rail !== RouteRail.AGGREGATION && req.rail !== RouteRail.NATIVE_AMM) {
    throw new RouteError(`unknown rail: ${String(req.rail)} (expected intent / aggregation / native-amm)`);
  }

  const venue = config.venue ?? OG_ROUTE_VENUE;

  // --- (1) mandate-gate (the kill-switch, PRE-ROUTE -- design WOW Feature 2) --------------------
  // No transport => offline => the gate cannot read the chain => a loud refused leg (fail-closed, SS6).
  if (transport === undefined) {
    return {
      rail: req.rail,
      outcome: RouteOutcome.BLOCKED_BY_MANDATE,
      mandate: {
        allowed: false,
        reason: "ROUTE_GATE_NOT_WIRED: no eth_call transport supplied; the mandate gate cannot read the chain",
        verified: false,
      },
      minOut: undefined,
      plan: undefined,
      dispatched: false,
      refs: undefined,
      note:
        "ROUTE_GATE_NOT_WIRED: no eth_call transport supplied -- the per-leg mandate gate could not " +
        "read the chain, so the routing leg is refused PRE-ROUTE (offline-by-default; wire a transport).",
    };
  }

  // checkTransfer(agent, tokenIn, amountIn). A malformed spend is a loud RouteError; an operational
  // failure (RPC error, over-cap) is a fail-closed verdict that STOPS the leg.
  let mandate: MandateVerdict;
  try {
    mandate = await checkMandate(
      { agent: req.agent, token: req.tokenIn, amount: req.amountIn },
      config.mandate,
      transport,
    );
  } catch (err) {
    if (err instanceof MandateError) {
      throw new RouteError(`mandate gate rejected the spend request: ${err.message}`);
    }
    throw err;
  }

  if (!mandate.allowed) {
    // THE KILL-SWITCH (design SS5 / WOW Feature 2): a non-allowed gate STOPS the leg PRE-ROUTE. The rail
    // leg is never built, so no broadcast/publish can occur -- "refused *pre-broadcast*", per leg.
    return {
      rail: req.rail,
      outcome: RouteOutcome.BLOCKED_BY_MANDATE,
      mandate,
      minOut: undefined,
      plan: undefined,
      dispatched: false,
      refs: undefined,
      note:
        `mandate gate BLOCKED the ${req.rail} leg (reason: ${String(mandate.reason)}; verified=${String(
          mandate.verified,
        )}) -- the leg did NOT build or dispatch (the cap is a kill-switch, enforced per leg pre-broadcast).`,
    };
  }

  // --- (2) build (derive the floor + the rail-shaped plan) -------------------------------------
  // The gate ALLOWED the spend. Derive the exact-integer min-output floor, then build the leg.
  let minOut: bigint;
  try {
    minOut = slippageFloor(req.expectedOut, req.slippageBps);
  } catch (err) {
    if (err instanceof ExecuteError) {
      throw new RouteError(`route floor derivation failed: ${err.message}`);
    }
    throw err;
  }

  let calls: readonly PlannedCall[];
  try {
    // Only the native-AMM rail has on-chain calls in this build; the cross-chain rails are a REST/SDK
    // request descriptor (the operator dispatches them). The descriptor is built for every rail.
    calls = req.rail === RouteRail.NATIVE_AMM ? buildNativeAmmCalls(req, venue.jaineRouter, minOut) : [];
  } catch (err) {
    if (err instanceof ExecuteError) {
      throw new RouteError(`route leg build failed: ${err.message}`);
    }
    throw err;
  }

  const plan: RouteLegPlan = {
    rail: req.rail,
    calls,
    request: buildRequestDescriptor(req, minOut),
    minOut,
  };

  // --- (3) dispatch (dry-run default; LIVE operator-gated) -------------------------------------
  if (mode !== RouteExecMode.LIVE) {
    // The default + only path this build exercises: nothing is signed or dispatched (design SS8).
    const gating = railIsTestnetable(req.rail)
      ? "this rail is TESTNET-able (16602) -- a $0 same-chain live demo is feasible via cast/the JAINE router"
      : "this rail is MAINNET-only -- a live action is OPERATOR-GATED (real value)";
    return {
      rail: req.rail,
      outcome: RouteOutcome.PLANNED_DRY_RUN,
      mandate,
      minOut,
      plan,
      dispatched: false,
      refs: undefined,
      note:
        `dry-run complete: gate ALLOWED, ${req.rail} leg BUILT (floor=${minOut}, ${calls.length} on-chain ` +
        `calls), dispatched NOTHING (${gating}). The verifier's ROUTE extension mints the per-leg verdict ` +
        `(this leg NEVER claims settled -- design SS3 principle 2/3).`,
    };
  }

  // mode === LIVE: operator-gated dispatch. Requires an explicitly-wired dispatcher.
  if (dispatcher === undefined) {
    throw new RouteError(
      `ROUTE_LIVE_NOT_WIRED: live dispatch of the ${req.rail} leg is operator-gated and no RouteDispatcher ` +
        "was supplied; refusing to dispatch. Wire a dispatcher (a funded-wallet signer / intent submitter) " +
        "to enable LIVE (design SS8). DRY_RUN builds the leg without dispatching; nothing was sent.",
    );
  }

  // A live dispatcher IS wired (operator-supplied). Dispatch the built leg; any throw is a loud failure
  // (never a fabricated success). An `undefined` return is treated as "nothing was sent".
  let refs: readonly string[] | undefined;
  try {
    refs = await dispatcher.dispatch(plan);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RouteError(`route live dispatch failed: ${detail}`);
  }

  if (refs !== undefined && refs.length > 0) {
    // A live dispatch actually sent/published (operator-gated). The verifier's ROUTE extension stamps it.
    return {
      rail: req.rail,
      outcome: RouteOutcome.DISPATCHED_LIVE,
      mandate,
      minOut,
      plan,
      dispatched: true,
      refs,
      note:
        `live ${req.rail} dispatch (${refs.length} ref): gate ALLOWED, floor=${minOut}. The verifier's ` +
        `ROUTE extension reads 0G directly (a refunded intent leg is a non-settlement terminal) + mints the ` +
        `verdict (this leg NEVER claims settled -- design SS3 principle 2/3).`,
    };
  }

  // The dispatcher reported no ref: honestly surface "not dispatched", never a fake success.
  return {
    rail: req.rail,
    outcome: RouteOutcome.PLANNED_DRY_RUN,
    mandate,
    minOut,
    plan,
    dispatched: false,
    refs: undefined,
    note:
      `live dispatch reported no reference for the ${req.rail} leg -- nothing was sent (honest no-op, ` +
      `never a fabricated success -- design SS3 principle 3).`,
  };
}
