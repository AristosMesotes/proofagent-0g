/**
 * The SWAP adapter -- Oku / Uniswap-V3, refactored onto the [`ExecutionConnector`] contract.
 *
 * Design WOW Feature 5 (the Engine): "refactor swap (Oku, from swap.ts) ... into adapters implementing
 * ExecutionConnector. Move the per-protocol logic into the adapters; preserve the on-chain shapes (Oku
 * SwapRouter02 7-field tuple)." This adapter is the swap protocol expressed through the FIVE-method contract
 * -- it reuses the proven swap codecs/quote read (`execute.ts` / `swap.ts`) and preserves the exact 7-field
 * `exactInputSingle` tuple (no deadline -- design WOW Feature 1 footgun); it adds NO new on-chain shape.
 *
 * ## How the five methods map to the proven swap leg (no functionality lost)
 *
 *  - **`quote`** -- the on-chain `QuoterV2.quoteExactInputSingle` staticCall via [`quoteExpectedOut`] (the
 *    SAME read `swap.ts` does), then the exact-integer floor via [`slippageFloor`]. Moves NO value; a failed
 *    read / unconfigured quoter is `quotable: false` with a loud reason (never a fabricated quote).
 *  - **`buildUnsigned`** -- [`planSwap`] builds the two ordered calls (`approve` then the 7-field
 *    `exactInputSingle`) + the floor. PURE/offline; moves NO value.
 *  - **`submit`** -- the ONLY value-moving method: broadcast the ordered calls via `ctx.signer`. Mainnet-only
 *    on 0G, so operator-gated -- without a wired signer it fails CLOSED (loud not-wired), never a fake hash.
 *  - **`status` / `cancel`** -- a swap is a single atomic on-chain tx with no off-chain lifecycle: once
 *    submitted it has moved value (mined or reverted, the broadcast happened), so `status` reports
 *    `valueMoved: true`, and `cancel` REFUSES a value-moved order (it cannot un-send a broadcast tx). A
 *    PLANNED (un-submitted) order cancels trivially (nothing moved).
 *
 * ## value_moved discipline (design WOW Feature 5)
 *
 * The split is exact: `quote` + `buildUnsigned` move nothing (the gateway may fall back freely on a failure
 * here); `submit` is the only method that can move value, and the instant it returns a ref the order is
 * `valueMoved: true` -- the gateway must never retry/fall back it (a re-broadcast could double-spend).
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret. The public Oku/Uniswap-V3 0G addresses come from
 * config ([`SwapVenueConfig`], default [`OG_SWAP_VENUE`]); no baked-in private target.
 */

import {
  quoteExpectedOut,
  OG_SWAP_VENUE,
  SwapError,
  type SwapVenueConfig,
  type SwapLegRequest,
} from "../swap.js";
import { planSwap, slippageFloor, ExecuteError, type SwapPlan, type SwapConfig } from "../execute.js";
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

/** The public swap venue this adapter targets (the Oku router + quoter). Defaults to [`OG_SWAP_VENUE`]. */
export interface SwapAdapterConfig {
  /** The public 0G Oku/Uniswap-V3 venue (router + quoter). */
  readonly venue: SwapVenueConfig;
}

/** Map an [`ExecutionIntent`] to the swap leg's request shape (the fields the swap codec/quote need). */
function toSwapRequest(intent: ExecutionIntent): SwapLegRequest {
  return {
    agent: intent.agent,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    ...(intent.fee !== undefined ? { fee: intent.fee } : {}),
    recipient: intent.recipient,
    amountIn: intent.amountIn,
    slippageBps: intent.slippageBps,
  };
}

/**
 * Build the SWAP adapter -- the Oku/Uniswap-V3 protocol as an [`ExecutionConnector`]. The `config.venue`
 * supplies the public router/quoter (default [`OG_SWAP_VENUE`]); pass an override for a fork/testnet.
 */
export function makeSwapAdapter(
  config: SwapAdapterConfig = { venue: OG_SWAP_VENUE },
): ExecutionConnector {
  const venue = config.venue;
  const swapConfig: SwapConfig = { swapRouter02: venue.swapRouter02 };

  return {
    protocol: ProtocolKind.SWAP,

    async quote(intent: ExecutionIntent, ctx: ConnectorContext): Promise<Quote> {
      // Validate the spend shape loudly (a malformed intent is a programmer error, not an unservable one).
      if (typeof intent.amountIn !== "bigint" || intent.amountIn <= 0n) {
        throw new ConnectorError(
          `swap.quote: amountIn must be a positive bigint in minor units, got ${String(intent.amountIn)}`,
        );
      }
      // No transport => offline => the on-chain quote cannot be read => NOT quotable (skip, never fabricate).
      if (ctx.transport === undefined) {
        return {
          protocol: ProtocolKind.SWAP,
          quotable: false,
          expectedOut: undefined,
          minOut: undefined,
          reason:
            "SWAP_QUOTE_NOT_WIRED: no eth_call transport -- the on-chain QuoterV2 quote could not be read " +
            "(offline-by-default; the gateway skips this adapter).",
        };
      }
      let expectedOut: bigint;
      try {
        expectedOut = await quoteExpectedOut(toSwapRequest(intent), venue, ctx.transport);
      } catch (err) {
        if (err instanceof SwapError) {
          // A transport / malformed-reply / unconfigured-quoter failure -> NOT quotable (loud reason).
          return {
            protocol: ProtocolKind.SWAP,
            quotable: false,
            expectedOut: undefined,
            minOut: undefined,
            reason: `swap quote read failed: ${err.message} (never a fabricated quote -- SS3 #3).`,
          };
        }
        throw err;
      }
      let minOut: bigint;
      try {
        minOut = slippageFloor(expectedOut, intent.slippageBps);
      } catch (err) {
        if (err instanceof ExecuteError) {
          throw new ConnectorError(`swap.quote: floor derivation failed: ${err.message}`);
        }
        throw err;
      }
      return {
        protocol: ProtocolKind.SWAP,
        quotable: true,
        expectedOut,
        minOut,
        reason: `Oku QuoterV2 quote=${expectedOut}, floor=${minOut}.`,
      };
    },

    async buildUnsigned(intent: ExecutionIntent, ctx: ConnectorContext): Promise<UnsignedTx> {
      // Build needs the on-chain quote to derive the floor -- the same read quote() does (so a stale quote is
      // never trusted). Re-quote here so the built tx is internally consistent + deterministic for the intent.
      const q = await this.quote(intent, ctx);
      if (!q.quotable || q.expectedOut === undefined) {
        throw new ConnectorError(
          `swap.buildUnsigned: cannot build -- the intent is not quotable (${q.reason}). ` +
            "Build needs the on-chain quote to derive the floor.",
        );
      }
      let plan: SwapPlan;
      try {
        plan = planSwap(
          {
            tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut,
            ...(intent.fee !== undefined ? { fee: intent.fee } : {}),
            recipient: intent.recipient,
            amountIn: intent.amountIn,
            expectedOut: q.expectedOut,
            slippageBps: intent.slippageBps,
          },
          swapConfig,
        );
      } catch (err) {
        if (err instanceof ExecuteError) {
          throw new ConnectorError(`swap.buildUnsigned: planning failed: ${err.message}`);
        }
        throw err;
      }
      const calls: readonly UnsignedCall[] = plan.calls.map((c) => ({
        label: c.label,
        to: c.to,
        data: c.data,
        value: c.value,
      }));
      return {
        protocol: ProtocolKind.SWAP,
        calls,
        minOut: plan.amountOutMinimum,
        descriptor: { kind: "swap", params: plan.params, router: venue.swapRouter02 },
      };
    },

    async submit(tx: UnsignedTx, ctx: ConnectorContext): Promise<OrderId> {
      // The ONLY value-moving method. Mainnet-only swap -> operator-gated. No signer => fail CLOSED.
      if (ctx.signer === undefined) {
        throw new ConnectorError(
          "SWAP_SUBMIT_NOT_WIRED: live broadcast is operator-gated and no LiveSigner was supplied; " +
            "refusing to broadcast (Oku/Uniswap-V3 is mainnet-only on 0G -- real value). Never a fake hash.",
        );
      }
      let refs: readonly string[] | undefined;
      try {
        refs = await ctx.signer.sign(tx);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ConnectorError(`swap.submit: live signer failed: ${detail} (never a fabricated success).`);
      }
      if (refs === undefined || refs.length === 0) {
        throw new ConnectorError(
          "swap.submit: the live signer reported no reference -- nothing was broadcast (honest no-op, " +
            "never a fabricated OrderId -- SS3 #3).",
        );
      }
      return { protocol: ProtocolKind.SWAP, refs };
    },

    status(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      // A swap is a single atomic on-chain tx: the broadcast happened, so value HAS moved (mined or reverted
      // is the verifier's read, not this lifecycle's). An order with refs is SUBMITTED + valueMoved.
      const has = orderId.refs.length > 0;
      return Promise.resolve({
        protocol: ProtocolKind.SWAP,
        state: has ? OrderState.SUBMITTED : OrderState.PLANNED,
        valueMoved: has,
        note: has
          ? `swap broadcast (${orderId.refs.length} tx) -- value moved; the independent verifier mints the ` +
            "settlement verdict (this adapter never claims settled)."
          : "no submission ref -- the swap was planned but not broadcast (no value moved).",
      });
    },

    cancel(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      // A broadcast swap CANNOT be cancelled (it cannot be un-sent). Refuse loudly for a value-moved order;
      // a never-submitted (no-ref) order cancels trivially (nothing moved).
      if (orderId.refs.length > 0) {
        return Promise.resolve({
          protocol: ProtocolKind.SWAP,
          state: OrderState.SUBMITTED,
          valueMoved: true,
          note:
            "swap.cancel: REFUSED -- a broadcast swap has moved value and cannot be cancelled (it cannot be " +
            "un-sent). The gateway never retries/falls back a value-moved order (design WOW Feature 5).",
        });
      }
      return Promise.resolve({
        protocol: ProtocolKind.SWAP,
        state: OrderState.FAILED,
        valueMoved: false,
        note: "swap.cancel: a never-submitted swap was cancelled (nothing moved).",
      });
    },
  };
}
