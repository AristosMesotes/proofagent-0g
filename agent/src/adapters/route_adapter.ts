/**
 * The ROUTE adapter -- Khalani (intent) / LI.FI (aggregation) / JAINE (native-AMM), onto [`ExecutionConnector`].
 *
 * Design WOW Feature 5 (the Engine): "refactor ... route (Khalani/LI.FI/JAINE, from route.ts) ... into
 * adapters implementing ExecutionConnector ... preserve ... the route SDKs. The JAINE native-AMM adapter
 * stays code-only + fails CLOSED (its router is unpublished on testnet -- see demo/EVIDENCE_ROUTE.md)." This
 * module is the routing protocol expressed through the FIVE-method contract, ONE adapter per rail. It reuses
 * the proven route-leg codecs/shapes (`route.ts` / `execute.ts`) and adds NO new on-chain shape.
 *
 * ## One adapter per rail (the agent never names a rail)
 *
 * [`makeRouteAdapter(rail, config)`] builds an adapter for a single public rail. The gateway registers the
 * rail adapters it wants; the agent expresses a protocol-agnostic intent and the gateway picks one by
 * quote/priority. Each rail adapter is a faithful [`ExecutionConnector`]:
 *
 *  - **native-AMM (JAINE)** -- builds the standard V3 `approve` -> `exactInputSingle` (the SAME audited 7-field
 *    codec the swap leg uses). Its router comes from config; the public default leaves it EMPTY, so the build
 *    **fails CLOSED loudly** (`ROUTE_NATIVE_AMM_NOT_CONFIGURED`) -- JAINE's router is unpublished on testnet
 *    (demo/EVIDENCE_ROUTE.md). It quotes off the agent-supplied rail quote (a quoter is also unpublished).
 *  - **intent (Khalani)** / **aggregation (LI.FI)** -- cross-chain rails: the build is a deterministic,
 *    secret-free REST/SDK request DESCRIPTOR (no on-chain calls in this offline build); mainnet-only -> the
 *    live submit is operator-gated.
 *
 * ## quote: the rail quote is the agent's Claim (two-source truth, design SS3 #1)
 *
 * Unlike the swap adapter (which READS the quote on-chain via Oku's QuoterV2), the route rails' quotes come
 * from the rail's own API (Khalani `POST /v1/quotes`, LI.FI `GET /v1/quote`, the JAINE quoter). In this
 * offline build the adapter takes the agent-supplied `expectedOut` (via the intent extension) as the rail's
 * quoted Claim and derives the exact-integer floor; the verifier's ROUTE extension reads the chain to mint
 * the verdict (it never trusts the rail API). An intent missing `expectedOut` is `quotable: false` (loud).
 *
 * ## value_moved discipline (design WOW Feature 5)
 *
 * `quote` + `buildUnsigned` move nothing; `submit` is the only value-moving method. A submitted route order
 * (an on-chain swap ref, or an intent order id whose deposit was submitted) is `valueMoved: true` -- the
 * gateway never retries/falls back it. `cancel` may safely cancel a PRE-deposit intent (no value moved) but
 * REFUSES a value-moved order.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret. The public rail endpoints + the JAINE V3 router come
 * from config ([`RouteVenueConfig`], default [`OG_ROUTE_VENUE`] -- empty JAINE router => fail-closed).
 */

import {
  RouteRail,
  railIsTestnetable,
  OG_ROUTE_VENUE,
  type RouteVenueConfig,
} from "../route.js";
import {
  slippageFloor,
  encodeApprove,
  encodeExactInputSingle,
  DEFAULT_FEE_TIER,
  ExecuteError,
  type PlannedCall,
} from "../execute.js";
import {
  ConnectorError,
  ProtocolKind,
  OrderState,
  type ExecutionConnector,
  type ExecutionIntent,
  type ConnectorContext,
  type Quote,
  type UnsignedTx,
  type UnsignedCall,
  type OrderId,
  type OrderStatus,
} from "../connector.js";

/**
 * The intent extension the route rails need beyond the base [`ExecutionIntent`]: the rail-supplied quote.
 * The route rails (unlike the swap adapter) get `expectedOut` from the rail's own API, so it rides on the
 * intent as the agent's Claim. An intent without it is not routable (the floor cannot be derived).
 */
export interface RouteIntent extends ExecutionIntent {
  /** The rail's quoted output for this leg, MINOR units, `bigint` -- the Claim the floor is derived from. */
  readonly expectedOut?: bigint;
}

/** The public route venue this adapter targets (rail endpoints + the JAINE router). Default [`OG_ROUTE_VENUE`]. */
export interface RouteAdapterConfig {
  /** The public 0G routing venue (rail endpoints + the native-AMM router). */
  readonly venue: RouteVenueConfig;
}

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build the native-AMM (JAINE) leg's ordered on-chain calls -- `approve(router, amountIn)` then the V3
 * `exactInputSingle` (the SAME audited 7-field codec the swap leg uses). The router comes from config; an
 * unset/invalid router fails CLOSED loudly (JAINE's router is unpublished on testnet -- demo/EVIDENCE_ROUTE.md).
 */
function buildNativeAmmCalls(
  intent: RouteIntent,
  jaineRouter: string,
  minOut: bigint,
): readonly PlannedCall[] {
  if (typeof jaineRouter !== "string" || !ADDRESS_RE.test(jaineRouter.trim())) {
    throw new ConnectorError(
      `ROUTE_NATIVE_AMM_NOT_CONFIGURED: the JAINE V3 router address is unset/invalid (${String(
        jaineRouter,
      )}); pin it in proofagent.toml [route] before building the native-AMM leg (its router is unpublished ` +
        "on testnet -- the adapter fails CLOSED, never a baked-in target).",
    );
  }
  const router = jaineRouter.trim().toLowerCase();
  const fee = intent.fee ?? DEFAULT_FEE_TIER;
  const approveCall: PlannedCall = {
    label: "approve",
    to: intent.tokenIn,
    data: encodeApprove(router, intent.amountIn),
    value: 0n,
  };
  const swapCall: PlannedCall = {
    label: "exactInputSingle",
    to: router,
    data: encodeExactInputSingle({
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      fee,
      recipient: intent.recipient,
      amountIn: intent.amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }),
    value: 0n,
  };
  return [approveCall, swapCall];
}

/** The deterministic, secret-free REST/SDK descriptor for a cross-chain rail (no key, public endpoint only). */
function railEndpoint(rail: RouteRail): string {
  return rail === RouteRail.INTENT
    ? "Khalani intent: POST /v1/quotes -> /v1/deposit/build -> PUT /v1/deposit/submit"
    : rail === RouteRail.AGGREGATION
      ? "LI.FI aggregation: GET /v1/quote (toChain=16661) -> sign transactionRequest"
      : "JAINE V3 router: exactInputSingle (same-chain 0G)";
}

/**
 * Build a ROUTE adapter for ONE public rail -- the routing protocol as an [`ExecutionConnector`]. `rail`
 * selects which rail; `config.venue` supplies the public endpoints + the JAINE router (default
 * [`OG_ROUTE_VENUE`] leaves the JAINE router empty => native-AMM fails CLOSED).
 */
export function makeRouteAdapter(
  rail: RouteRail,
  config: RouteAdapterConfig = { venue: OG_ROUTE_VENUE },
): ExecutionConnector {
  if (rail !== RouteRail.INTENT && rail !== RouteRail.AGGREGATION && rail !== RouteRail.NATIVE_AMM) {
    throw new ConnectorError(`makeRouteAdapter: unknown rail ${String(rail)}`);
  }
  const venue = config.venue;

  /** Validate the spend + resolve the rail-supplied quote, or return a loud not-quotable [`Quote`]. */
  function priceIntent(intent: RouteIntent): { ok: true; expectedOut: bigint; minOut: bigint } | { ok: false; quote: Quote } {
    if (typeof intent.amountIn !== "bigint" || intent.amountIn <= 0n) {
      throw new ConnectorError(
        `route.quote: amountIn must be a positive bigint in minor units, got ${String(intent.amountIn)}`,
      );
    }
    if (typeof intent.expectedOut !== "bigint" || intent.expectedOut < 0n) {
      return {
        ok: false,
        quote: {
          protocol: ProtocolKind.ROUTE,
          quotable: false,
          expectedOut: undefined,
          minOut: undefined,
          reason:
            `route.quote (${rail}): no rail quote supplied (expectedOut) -- the ${rail} rail's quote comes ` +
            "from its API (Khalani/LI.FI/JAINE); the gateway skips this adapter (never a fabricated quote).",
        },
      };
    }
    let minOut: bigint;
    try {
      minOut = slippageFloor(intent.expectedOut, intent.slippageBps);
    } catch (err) {
      if (err instanceof ExecuteError) {
        throw new ConnectorError(`route.quote: floor derivation failed: ${err.message}`);
      }
      throw err;
    }
    return { ok: true, expectedOut: intent.expectedOut, minOut };
  }

  return {
    protocol: ProtocolKind.ROUTE,

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a malformed-intent throw REJECTS
    // (rather than throwing synchronously) -- the contract's methods always return a settled/rejected Promise.
    async quote(intent: ExecutionIntent, _ctx: ConnectorContext): Promise<Quote> {
      const priced = priceIntent(intent as RouteIntent);
      if (!priced.ok) {
        return priced.quote;
      }
      // For the native-AMM rail, surface (without throwing) that the router must be configured to BUILD --
      // the quote is still valid (the floor derives from the rail quote), but the gateway/operator is warned.
      const gating = railIsTestnetable(rail)
        ? "testnet-able rail (16602) -- but JAINE's router is unpublished, so the build fails closed unless pinned"
        : "mainnet-only rail -- a live submit is operator-gated (real value)";
      return {
        protocol: ProtocolKind.ROUTE,
        quotable: true,
        expectedOut: priced.expectedOut,
        minOut: priced.minOut,
        reason: `${rail} rail quote=${priced.expectedOut}, floor=${priced.minOut} (${gating}).`,
      };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a build refusal REJECTS (not a
    // synchronous throw) -- the contract's methods always return a settled/rejected Promise.
    async buildUnsigned(intent: ExecutionIntent, _ctx: ConnectorContext): Promise<UnsignedTx> {
      const routeIntent = intent as RouteIntent;
      const priced = priceIntent(routeIntent);
      if (!priced.ok) {
        throw new ConnectorError(
          `route.buildUnsigned (${rail}): cannot build -- ${priced.quote.reason}`,
        );
      }
      // native-AMM has on-chain calls (fails CLOSED if the router is unconfigured); the cross-chain rails are
      // a REST/SDK descriptor (no on-chain calls in this offline build).
      let calls: readonly PlannedCall[];
      try {
        calls =
          rail === RouteRail.NATIVE_AMM
            ? buildNativeAmmCalls(routeIntent, venue.jaineRouter, priced.minOut)
            : [];
      } catch (err) {
        if (err instanceof ExecuteError) {
          throw new ConnectorError(`route.buildUnsigned (${rail}): leg build failed: ${err.message}`);
        }
        throw err;
      }
      const unsignedCalls: readonly UnsignedCall[] = calls.map((c) => ({
        label: c.label,
        to: c.to,
        data: c.data,
        value: c.value,
      }));
      return {
        protocol: ProtocolKind.ROUTE,
        calls: unsignedCalls,
        minOut: priced.minOut,
        descriptor: {
          kind: "route",
          rail,
          endpoint: railEndpoint(rail),
          args: {
            tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut,
            amountIn: intent.amountIn.toString(),
            recipient: intent.recipient,
            minOut: priced.minOut.toString(),
          },
        },
      };
    },

    async submit(tx: UnsignedTx, ctx: ConnectorContext): Promise<OrderId> {
      // The ONLY value-moving method. Mainnet-only cross-chain rails + the mainnet swap -> operator-gated.
      if (ctx.signer === undefined) {
        throw new ConnectorError(
          `ROUTE_SUBMIT_NOT_WIRED (${rail}): live dispatch is operator-gated and no LiveSigner was supplied; ` +
            "refusing to dispatch (the cross-chain rails are mainnet-only -- real value). Never a fake ref.",
        );
      }
      let refs: readonly string[] | undefined;
      try {
        refs = await ctx.signer.sign(tx);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ConnectorError(`route.submit (${rail}): live signer failed: ${detail} (never fabricated).`);
      }
      if (refs === undefined || refs.length === 0) {
        throw new ConnectorError(
          `route.submit (${rail}): the live signer reported no reference -- nothing was dispatched (honest ` +
            "no-op, never a fabricated OrderId -- SS3 #3).",
        );
      }
      return { protocol: ProtocolKind.ROUTE, refs };
    },

    status(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      const has = orderId.refs.length > 0;
      return Promise.resolve({
        protocol: ProtocolKind.ROUTE,
        state: has ? OrderState.SUBMITTED : OrderState.PLANNED,
        valueMoved: has,
        note: has
          ? `route dispatched (${orderId.refs.length} ref) -- value moved; the verifier's ROUTE extension ` +
            "mints the verdict (a refunded intent leg is a non-settlement terminal, never a fabricated settle)."
          : "no dispatch ref -- the route was planned but not dispatched (no value moved).",
      });
    },

    cancel(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      // A dispatched route has moved value (an on-chain swap, or a submitted intent deposit) -> cannot cancel.
      if (orderId.refs.length > 0) {
        return Promise.resolve({
          protocol: ProtocolKind.ROUTE,
          state: OrderState.SUBMITTED,
          valueMoved: true,
          note:
            "route.cancel: REFUSED -- a dispatched route has moved value and cannot be cancelled. The " +
            "gateway never retries/falls back a value-moved order (design WOW Feature 5).",
        });
      }
      return Promise.resolve({
        protocol: ProtocolKind.ROUTE,
        state: OrderState.FAILED,
        valueMoved: false,
        note: "route.cancel: a never-dispatched route was cancelled (nothing moved).",
      });
    },
  };
}

/** Re-export the rail enum so a gateway/consumer can register the rail adapters without importing route.ts. */
export { RouteRail };
