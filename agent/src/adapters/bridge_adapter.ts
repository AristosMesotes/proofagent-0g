/**
 * The BRIDGE adapter -- Chainlink CCIP bridge-in / bridge-out, refactored onto the [`ExecutionConnector`] contract.
 *
 * Design WOW Feature 5 (the Engine): "refactor ... bridge-in/out (CCIP, from bridge.ts) into adapters
 * implementing ExecutionConnector. Move the per-protocol logic into the adapters; preserve the on-chain shapes
 * (... CCIP `ccipSend`)." This module is the bridge protocol expressed through the FIVE-method contract, ONE
 * adapter per lane. It reuses the proven bridge-leg shapes (`bridge.ts` / `execute.ts`) -- the allow-listed
 * `destSelector` pinning, the `approve(tokenPool, amount)` burn/lock approval, and the deterministic `ccipSend`
 * descriptor -- and adds NO new on-chain shape.
 *
 * ## One adapter per lane (the agent never names a lane)
 *
 * [`makeBridgeAdapter(lane, config)`] builds an adapter for a single public CCIP lane (USDC inbound /
 * USDC.E egress / w0G egress). The gateway registers the lane adapters it wants; the agent expresses a
 * protocol-agnostic intent (carrying the EXPECTED `destSelector` hint) and the gateway picks one. Each lane
 * adapter is a faithful [`ExecutionConnector`]:
 *
 *  - **`quote`** -- a bridge is a 1:1 lock/burn-and-mint, so `expectedOut == amountIn` (the bridged amount is
 *    what is sent into CCIP); the exact-integer floor (`minRelease`) is derived via [`slippageFloor`] (the
 *    CCIP-fee allowance). A missing / non-allow-listed `destSelector` is `quotable: false` with a loud reason
 *    (the agent must pin the EXPECTED lane -- never the decommissioned Galileo testnet lane). Moves NO value.
 *  - **`buildUnsigned`** -- builds the `approve(tokenPool, amount)` burn/lock-approval call + the deterministic
 *    `ccipSend` descriptor (destSelector + receiver + tokenAmounts + feeToken). PURE/offline; moves NO value.
 *    An unconfigured token pool fails CLOSED loudly (its address is pinned in config, never baked in).
 *  - **`submit`** -- the ONLY value-moving method: broadcast via `ctx.signer`. CCIP on 0G is MAINNET-only
 *    (Galileo decommissioned), so operator-gated -- without a wired signer it fails CLOSED (loud not-wired),
 *    never a fake `messageId`.
 *  - **`status` / `cancel`** -- a `ccipSend` is a single source-chain tx: once submitted the source value has
 *    moved (burned/locked on 0G), so `status` reports `valueMoved: true`, and `cancel` REFUSES a value-moved
 *    order (a CCIP message in flight cannot be un-burned -- the destination leg is the verifier's read). A
 *    PLANNED (un-submitted) order cancels trivially.
 *
 * ## value_moved discipline (design WOW Feature 5 + the hollow-egress catch, design WOW Feature 3b)
 *
 * The split is exact: `quote` + `buildUnsigned` move nothing (the gateway may fall back freely on a failure
 * here); `submit` is the only method that can move value, and the instant it returns a ref the order is
 * `valueMoved: true` -- the gateway must never retry/fall back it (a re-`ccipSend` could double-burn). The
 * adapter NEVER claims `settled` -- a bridge hop is settled ONLY when the independent verifier reads BOTH legs
 * (source burn + destination release); a hollow-egress (burned-on-0G, nothing-on-dest) is the verifier's loud
 * catch, never this adapter's word.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret. The public 0G CCIP Router, the per-lane token pool, the
 * fee token, and the CCIP destination selectors come from config ([`BridgeVenueConfig`] / [`DEST_SELECTOR`],
 * default [`OG_BRIDGE_VENUE`] -- empty token pool => fail-closed); no baked-in private target.
 */

import {
  isAllowedSelector,
  isKnownLane,
  laneIsEgress,
  BridgeLane,
  OG_BRIDGE_VENUE,
  type BridgeVenueConfig,
  type CcipSendDescriptor,
} from "../bridge.js";
import {
  slippageFloor,
  encodeApprove,
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

/** The public CCIP venue this adapter targets (Router + per-lane token pool + fee token). Default [`OG_BRIDGE_VENUE`]. */
export interface BridgeAdapterConfig {
  /** The public 0G CCIP venue (Router + token pool + fee token). */
  readonly venue: BridgeVenueConfig;
}

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build the bridged-token `approve(tokenPool, amount)` call -- the burn/lock approval CCIP needs before
 * `ccipSend` pulls the token (design WOW Feature 3b step (2): "approve the token pool"). This reuses the SAME
 * audited ERC-20 `approve` codec the swap/route legs use ([`encodeApprove`]). The pool address comes from
 * config; an unconfigured/invalid pool fails CLOSED loudly (never a baked-in target).
 */
function buildApproveCall(intent: ExecutionIntent, tokenPool: string, lane: BridgeLane): PlannedCall {
  if (typeof tokenPool !== "string" || !ADDRESS_RE.test(tokenPool.trim())) {
    throw new ConnectorError(
      `BRIDGE_POOL_NOT_CONFIGURED: the CCIP token pool address is unset/invalid (${String(
        tokenPool,
      )}); pin it in proofagent.toml [bridge] before building the ${lane} hop (never a baked-in target).`,
    );
  }
  const pool = tokenPool.trim().toLowerCase();
  return {
    label: "approve",
    to: intent.tokenIn,
    data: encodeApprove(pool, intent.amountIn),
    value: 0n,
  };
}

/** Build the deterministic, secret-free `ccipSend` descriptor (Router + bounded args; NEVER a key). */
function buildCcipSendDescriptor(
  intent: ExecutionIntent,
  destSelector: bigint,
  router: string,
  feeToken: string,
): CcipSendDescriptor {
  return {
    router,
    destSelector: destSelector.toString(),
    receiver: intent.recipient,
    tokenAmount: { token: intent.tokenIn, amount: intent.amountIn.toString() },
    feeToken,
  };
}

/**
 * Build a BRIDGE adapter for ONE public CCIP lane -- the bridge protocol as an [`ExecutionConnector`]. `lane`
 * selects which lane; `config.venue` supplies the public Router + token pool + fee token (default
 * [`OG_BRIDGE_VENUE`] leaves the token pool empty => the build fails CLOSED).
 */
export function makeBridgeAdapter(
  lane: BridgeLane,
  config: BridgeAdapterConfig = { venue: OG_BRIDGE_VENUE },
): ExecutionConnector {
  if (!isKnownLane(lane)) {
    throw new ConnectorError(`makeBridgeAdapter: unknown lane ${String(lane)}`);
  }
  const venue = config.venue;

  /**
   * Validate the spend + the EXPECTED destination selector, deriving the 1:1 expectedOut + the floor. A
   * malformed amount is a loud throw (programmer error); a missing/non-allow-listed selector is a loud
   * not-quotable [`Quote`] (the agent must pin the EXPECTED lane -- never the decommissioned testnet lane).
   */
  function priceIntent(
    intent: ExecutionIntent,
  ): { ok: true; destSelector: bigint; expectedOut: bigint; minOut: bigint } | { ok: false; quote: Quote } {
    if (typeof intent.amountIn !== "bigint" || intent.amountIn <= 0n) {
      throw new ConnectorError(
        `bridge.quote (${lane}): amountIn must be a positive bigint in minor units, got ${String(intent.amountIn)}`,
      );
    }
    // The EXPECTED CCIP destination selector must be supplied AND allow-listed (never the decommissioned
    // Galileo testnet lane -- design WOW Feature 3b). A missing/bad selector => NOT quotable (skip, never fabricate).
    if (intent.destSelector === undefined || !isAllowedSelector(intent.destSelector)) {
      return {
        ok: false,
        quote: {
          protocol: ProtocolKind.BRIDGE,
          quotable: false,
          expectedOut: undefined,
          minOut: undefined,
          reason:
            `bridge.quote (${lane}): destSelector ${String(intent.destSelector)} is missing or not an ` +
            "allow-listed CCIP lane -- the agent must pin the EXPECTED destination (never the decommissioned " +
            "Galileo testnet lane). The gateway skips this adapter (never a fabricated quote).",
        },
      };
    }
    // A bridge is 1:1 lock/burn-and-mint: the expected output IS the amount sent into CCIP. The floor is the
    // CCIP-fee allowance (exact-integer); a 0-tolerance lane requires the full amount to be released.
    let minOut: bigint;
    try {
      minOut = slippageFloor(intent.amountIn, intent.slippageBps);
    } catch (err) {
      if (err instanceof ExecuteError) {
        throw new ConnectorError(`bridge.quote (${lane}): floor derivation failed: ${err.message}`);
      }
      throw err;
    }
    return { ok: true, destSelector: intent.destSelector, expectedOut: intent.amountIn, minOut };
  }

  return {
    protocol: ProtocolKind.BRIDGE,

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a malformed-intent throw REJECTS
    // (not a synchronous throw) -- the contract's methods always return a settled/rejected Promise.
    async quote(intent: ExecutionIntent, _ctx: ConnectorContext): Promise<Quote> {
      const priced = priceIntent(intent);
      if (!priced.ok) {
        return priced.quote;
      }
      const dir = laneIsEgress(lane) ? "egress (value LEAVES 0G -- hollow-egress-prone)" : "ingress (value ENTERS 0G)";
      return {
        protocol: ProtocolKind.BRIDGE,
        quotable: true,
        expectedOut: priced.expectedOut,
        minOut: priced.minOut,
        reason:
          `${lane} ${dir}: 1:1 bridged amount=${priced.expectedOut}, minRelease floor=${priced.minOut}, ` +
          `dest=${priced.destSelector} (CCIP MAINNET-only -- a live bridge is operator-gated).`,
      };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a build refusal REJECTS (not a
    // synchronous throw) -- the contract's methods always return a settled/rejected Promise.
    async buildUnsigned(intent: ExecutionIntent, _ctx: ConnectorContext): Promise<UnsignedTx> {
      const priced = priceIntent(intent);
      if (!priced.ok) {
        throw new ConnectorError(`bridge.buildUnsigned (${lane}): cannot build -- ${priced.quote.reason}`);
      }
      // The burn/lock approval call (fails CLOSED if the pool is unconfigured) + the ccipSend descriptor.
      const approveCall = buildApproveCall(intent, venue.tokenPool, lane);
      const calls: readonly UnsignedCall[] = [
        { label: approveCall.label, to: approveCall.to, data: approveCall.data, value: approveCall.value },
      ];
      return {
        protocol: ProtocolKind.BRIDGE,
        calls,
        minOut: priced.minOut,
        descriptor: {
          kind: "bridge",
          lane,
          ccipSend: buildCcipSendDescriptor(intent, priced.destSelector, venue.ccipRouter, venue.feeToken),
        },
      };
    },

    async submit(tx: UnsignedTx, ctx: ConnectorContext): Promise<OrderId> {
      // The ONLY value-moving method. CCIP on 0G is MAINNET-only (Galileo decommissioned) -> operator-gated.
      if (ctx.signer === undefined) {
        throw new ConnectorError(
          `BRIDGE_SUBMIT_NOT_WIRED (${lane}): live ccipSend is operator-gated and no LiveSigner was supplied; ` +
            "refusing to burn/send (CCIP on 0G is mainnet-only -- real value). Never a fake messageId.",
        );
      }
      let refs: readonly string[] | undefined;
      try {
        refs = await ctx.signer.sign(tx);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ConnectorError(`bridge.submit (${lane}): live signer failed: ${detail} (never fabricated).`);
      }
      if (refs === undefined || refs.length === 0) {
        throw new ConnectorError(
          `bridge.submit (${lane}): the live signer reported no reference -- nothing was sent (honest no-op, ` +
            "never a fabricated OrderId -- SS3 #3).",
        );
      }
      return { protocol: ProtocolKind.BRIDGE, refs };
    },

    status(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      // A ccipSend is a single source-chain tx: once submitted the source value has burned/locked on 0G, so
      // value HAS moved. Whether the destination released is the verifier's BOTH-leg read, not this lifecycle.
      const has = orderId.refs.length > 0;
      return Promise.resolve({
        protocol: ProtocolKind.BRIDGE,
        state: has ? OrderState.SUBMITTED : OrderState.PLANNED,
        valueMoved: has,
        note: has
          ? `bridge ccipSend (${orderId.refs.length} ref) -- source value moved (burned/locked on 0G); the ` +
            "verifier reads BOTH legs (source + destination) to mint the verdict (a hollow-egress is caught " +
            "LOUD -- this adapter never claims settled)."
          : "no submission ref -- the bridge hop was planned but not sent (no value moved on 0G).",
      });
    },

    cancel(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      // A submitted ccipSend has burned/locked on 0G and CANNOT be cancelled (a CCIP message in flight cannot
      // be un-burned). Refuse loudly for a value-moved order; a never-submitted (no-ref) hop cancels trivially.
      if (orderId.refs.length > 0) {
        return Promise.resolve({
          protocol: ProtocolKind.BRIDGE,
          state: OrderState.SUBMITTED,
          valueMoved: true,
          note:
            "bridge.cancel: REFUSED -- a submitted ccipSend has moved value (burned/locked on 0G) and cannot be " +
            "cancelled (a CCIP message in flight cannot be un-burned). The gateway never retries/falls back a " +
            "value-moved order (design WOW Feature 5).",
        });
      }
      return Promise.resolve({
        protocol: ProtocolKind.BRIDGE,
        state: OrderState.FAILED,
        valueMoved: false,
        note: "bridge.cancel: a never-submitted bridge hop was cancelled (nothing burned on 0G).",
      });
    },
  };
}

/** Re-export the lane enum so a gateway/consumer can register the lane adapters without importing bridge.ts. */
export { BridgeLane };
