/**
 * The ExecutionConnector contract -- ONE bounded execution interface every protocol satisfies identically.
 *
 * Design WOW Feature 5 (the Engine): "Define ONE clean, enforced execution contract" so the agent calls a
 * protocol-AGNOSTIC gateway, never a specific protocol. This module is the contract itself: a small,
 * five-method seam (`quote` / `buildUnsigned` / `submit` / `status` / `cancel`) that swap (Oku), route
 * (Khalani / LI.FI / JAINE), and bridge-in/out (CCIP) all implement the SAME way. The per-protocol legs
 * (`swap.ts` / `route.ts` / `bridge.ts`) keep their proven on-chain shapes; the adapters in `adapters/`
 * wrap them behind THIS contract, and the gateway (`gateway.ts`) dispatches over it.
 *
 * ## Why a uniform contract (design WOW Feature 5 -- "the Engine")
 *
 * Every protocol differs in its wire shape (Oku's 7-field `exactInputSingle` tuple, CCIP's `ccipSend`
 * `EVM2AnyMessage`, the route SDKs' REST/intent flows). The agent must not know any of that: it expresses an
 * `ExecutionIntent` and the gateway picks an adapter, quotes it, builds it, gates it, and -- only when the
 * operator wires a live signer -- submits it. The contract is the boundary that makes "the agent calls
 * `gateway.execute(intent)`, NEVER a specific protocol" structurally true.
 *
 * ## The fund-loss-safe lifecycle (design WOW Feature 5 -- the `value_moved` short-circuit)
 *
 * The five methods are ordered so the gateway can apply its hard invariant: **once value has moved on-chain,
 * NEVER retry or fall back** (it would double-spend). The split between `buildUnsigned` (pure, no value
 * moves) and `submit` (the ONLY method that can move value) is what lets the gateway fall back freely on a
 * PRE-broadcast failure (a bad quote, a failed build, a blocked gate -- nothing has moved) yet refuse ALL
 * retry/fallback the instant `submit` has put value in flight. The `OrderStatus.valueMoved` flag is the
 * load-bearing signal: an adapter sets it `true` the moment it has broadcast anything that could move funds.
 *
 * ## Offline-by-default + never-fabricate (design SS6 + SS3 principle 3)
 *
 * `quote` and `buildUnsigned` are OFFLINE/PURE for every adapter in this build (a quote read goes through
 * the same `EthCallTransport` seam the gate uses; the build is a deterministic plan). `submit` is the ONLY
 * method that can touch a live signer, and it is operator-gated + fails CLOSED (loud not-wired) -- it NEVER
 * fabricates an order id, a tx hash, or a `settled`. `status` / `cancel` likewise degrade loudly; a
 * settlement verdict remains the independent verifier's monopoly (design SS3 principle 2), never minted here.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * Every amount on this contract is a `bigint` in MINOR units -- never `number`, never a float. There is no
 * floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The contract is generic over any public
 * 0G protocol; the protocol-specific public facts (addresses, selectors, endpoints) live in the adapters and
 * come from config (the data spine), never baked in here.
 */

import type { EthCallTransport } from "./mandate.js";
import type { NativeBalanceSource } from "./gasfloor.js";

/** A loud failure on the execution-contract path (design SS3 principle 3 -- degrade loudly, never fabricate). */
export class ConnectorError extends Error {
  public override readonly name = "ConnectorError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }
}

/**
 * The protocol family an adapter serves -- the public 0G execution surfaces the Engine unifies (design WOW
 * Features 1 / 2 / 3 / 3b). This is an HONESTY label for the journal/UI (which protocol actually ran), never
 * the source of truth. The agent never selects by this; the gateway dispatches over the adapters' quotes.
 */
export const ProtocolKind = {
  /** Oku / Uniswap-V3 single-hop swap (`swap.ts`) -- design WOW Feature 1. */
  SWAP: "swap",
  /** Khalani / LI.FI / JAINE routed action (`route.ts`) -- design WOW Feature 2. */
  ROUTE: "route",
  /** Chainlink CCIP bridge-in / bridge-out hop (`bridge.ts`) -- design WOW Feature 3 / 3b. */
  BRIDGE: "bridge",
} as const;

/** A protocol-family identifier (one of [`ProtocolKind`]). */
export type ProtocolKind = (typeof ProtocolKind)[keyof typeof ProtocolKind];

/**
 * The protocol-agnostic execution intent the agent expresses -- the SINGLE shape the gateway accepts and
 * each adapter interprets in its own terms. The agent never names a protocol; it states WHAT it wants moved
 * (sell `amountIn` of `tokenIn` for `tokenOut`, to `recipient`, on behalf of `agent`, within `slippageBps`)
 * plus optional adapter-specific hints (`fee` tier, a bridge `destSelector`). An adapter reads only the
 * fields it needs and refuses (loudly, pre-quote) any intent it cannot honor.
 *
 * Two-source truth (design SS3 principle 1): this is the agent's *proposal* (a Claim). The quote read and
 * the mandate gate are the *facts*; the verifier's later read is the settlement truth. Nothing here is ever
 * trusted as a settlement.
 */
export interface ExecutionIntent {
  /** The agent address proposing the action (must equal the registry's mandated agent -- gate-checked). */
  readonly agent: string;
  /** The asset being SOLD / sent (the mandate-bounded, gate-checked input token). */
  readonly tokenIn: string;
  /** The asset being BOUGHT / delivered. */
  readonly tokenOut: string;
  /** Who receives `tokenOut` / the bridged asset (the demo wallet; the gate's recipient bound). */
  readonly recipient: string;
  /** Exact input, MINOR units, `bigint` -- the amount the mandate caps + the protocol pulls. */
  readonly amountIn: bigint;
  /** Slippage / route-quality / release tolerance in bps (`0..=10000`) -- drives the on-chain floor. */
  readonly slippageBps: number;
  /**
   * OPTIONAL adapter hint: the Uniswap-V3 pool fee tier (hundredths of a bip) for the swap / native-AMM
   * adapters. Ignored by adapters that do not use it. Omit to take the adapter's default.
   */
  readonly fee?: number;
  /**
   * OPTIONAL adapter hint: the EXPECTED CCIP destination-chain selector (`uint64` `bigint`) for a bridge
   * adapter -- pinned + allow-list-checked by the bridge leg. Ignored by non-bridge adapters. A bridge
   * adapter refuses (loudly) an intent missing this.
   */
  readonly destSelector?: bigint;
}

/**
 * A protocol-agnostic quote -- the adapter's PRE-build account of what the intent would cost/deliver, used
 * by the gateway to PRICE the fallback (design WOW Feature 5 -- "priced fallback"). It carries the
 * independently-read `expectedOut` (the quote source, e.g. Oku `QuoterV2`, a rail quote, or the bridged 1:1
 * amount) and the derived exact-integer on-chain `minOut` floor. A quote moves NO value and is reproducible.
 *
 * `quotable: false` is the honest "this adapter cannot serve this intent" answer (e.g. an unconfigured
 * venue, a missing required hint) -- the gateway skips it and tries the next, never treating it as a failure
 * that moved value. A `quotable: false` quote carries a loud `reason` and NO amounts.
 */
export interface Quote {
  /** Which protocol family produced this quote (the honesty label). */
  readonly protocol: ProtocolKind;
  /** `true` iff this adapter can serve the intent and produced real amounts; `false` => skip it. */
  readonly quotable: boolean;
  /**
   * The independently-read expected output (MINOR units, `bigint`), present iff `quotable`. For a swap /
   * route this is the on-chain / rail quote; for a 1:1 bridge it is the sent amount. NEVER agent-supplied
   * for the swap adapter -- that adapter READS it on-chain (design WOW Feature 1 step 1).
   */
  readonly expectedOut: bigint | undefined;
  /** The derived exact-integer on-chain floor (`amountOutMinimum` / `minOut` / `minRelease`), iff `quotable`. */
  readonly minOut: bigint | undefined;
  /** A human-readable, journal-only note (e.g. WHY not quotable). Never the source of truth. */
  readonly reason: string;
}

/**
 * A single un-signed, un-broadcast on-chain call within a built transaction -- the inspectable unit. Mirrors
 * the legs' `PlannedCall` exactly (so an adapter can forward a leg's plan unchanged). Building these moves NO
 * value; only a live signer over `submit` can.
 */
export interface UnsignedCall {
  /** A human label for the journal/UI (e.g. `"approve"`, `"exactInputSingle"`, `"ccipSend"`). */
  readonly label: string;
  /** The contract to call. */
  readonly to: string;
  /** The ABI-encoded calldata (selector + args) -- deterministic, inspectable, signs nothing. */
  readonly data: string;
  /** Native value to attach (MINOR units, `bigint`). `0n` for an ERC-20 path; a CCIP fee for a native send. */
  readonly value: bigint;
}

/**
 * A protocol-agnostic UNSIGNED transaction -- the deterministic build artifact `buildUnsigned` returns. It
 * is the ordered un-signed calls plus the gate-relevant facts (the input token + amount the mandate checks,
 * the floor, the protocol). It moves NOTHING. The gateway runs the mandate `checkTransfer` against
 * (`agent`, `tokenIn`, `amountIn`) from the originating intent BEFORE `submit`, for every adapter identically
 * (design WOW Feature 5 -- "the mandate `checkTransfer` runs PRE-submit in the gateway for every adapter").
 */
export interface UnsignedTx {
  /** Which protocol family built this (the honesty label). */
  readonly protocol: ProtocolKind;
  /** The ordered un-signed calls to broadcast (in order). Empty for a pure REST/SDK rail descriptor. */
  readonly calls: readonly UnsignedCall[];
  /** The exact-integer on-chain floor bound on this tx (MINOR units) -- the slippage/release floor. */
  readonly minOut: bigint;
  /**
   * The protocol-specific, secret-free descriptor of what WOULD be submitted (the rail REST shape, the
   * `ccipSend` shape, or the swap plan). Journal/UI data only, never the source of truth, never a secret.
   * Typed `unknown` so the contract stays protocol-agnostic; an adapter/consumer narrows it.
   */
  readonly descriptor: unknown;
}

/**
 * The canonical lifecycle state of a submitted order -- the adapter's HONEST account of where a submission
 * stands, and (critically) whether value has moved (design WOW Feature 5 -- the `value_moved` short-circuit).
 *
 * `valueMoved` is the load-bearing invariant signal: it is `true` the instant the adapter has broadcast
 * anything that could move funds on-chain (a `submit` that returned a ref). Once `true`, the gateway will
 * NEVER retry or fall back for that intent -- doing so could double-spend. A non-settlement state (failed /
 * refunded) does NOT clear a `valueMoved: true` (a refund is a separate on-chain event the verifier reads);
 * the gateway's only safe move after value has moved is to STOP and hand off to the independent verifier.
 *
 * This is NOT a settlement verdict (that is the verifier's monopoly, design SS3 principle 2). It is the
 * execution lifecycle only -- "did the submission go out, and could it have moved value", never "did it
 * settle".
 */
export const OrderState = {
  /** Built but not submitted (a dry-run, or pre-submit). NO value moved. */
  PLANNED: "planned",
  /** Submitted and in flight (broadcast/published). Value MAY have moved -- treat as moved (`valueMoved`). */
  SUBMITTED: "submitted",
  /** The submission failed on-chain or was rejected (status read says so). `valueMoved` reflects reality. */
  FAILED: "failed",
  /** The adapter could not read the order's state (off-record / unreadable) -- the loud degrade target. */
  UNKNOWN: "unknown",
} as const;

/** An order lifecycle state (one of [`OrderState`]). */
export type OrderState = (typeof OrderState)[keyof typeof OrderState];

/**
 * An opaque order reference an adapter returns from `submit` -- the on-chain tx hash / CCIP `messageId` /
 * rail order id. It is opaque to the gateway (it never parses it); it is the handle for `status` / `cancel`
 * and the input the operator feeds the independent verifier. NEVER fabricated -- present only on a real
 * submission (design SS3 principle 3).
 */
export interface OrderId {
  /** Which protocol family owns this order (the honesty label). */
  readonly protocol: ProtocolKind;
  /** The real on-chain/rail reference(s) -- the verifier's input. Non-empty iff a real submission occurred. */
  readonly refs: readonly string[];
}

/**
 * The status of a submitted order -- the adapter's read of an `OrderId`'s lifecycle. It carries the
 * `valueMoved` invariant flag the gateway's short-circuit reads. It is NOT a settlement verdict (the
 * verifier's job); it states only the execution lifecycle and whether value moved.
 */
export interface OrderStatus {
  /** Which protocol family this status is for. */
  readonly protocol: ProtocolKind;
  /** The lifecycle state (one of [`OrderState`]). */
  readonly state: OrderState;
  /**
   * `true` iff value has (or could have) moved on-chain for this order -- the gateway's hard short-circuit
   * signal (design WOW Feature 5). `true` the instant a submission broadcast anything that could move funds;
   * a later FAILED/refund does NOT clear it. Once `true`, the gateway never retries/falls back this intent.
   */
  readonly valueMoved: boolean;
  /** A human-readable, journal-only note. Never the source of truth, never a settlement claim. */
  readonly note: string;
}

/**
 * A live signer seam -- the ONE narrow boundary across which a built `UnsignedTx` could leave the machine
 * (mirrors the legs' `SwapBroadcaster` / `RouteDispatcher` / `BridgeDispatcher`). A `DRY_RUN`/dry path never
 * reaches it. A LIVE signer (operator-wired) signs + broadcasts the ordered calls / submits the rail
 * action. The build is identical with or without it (two-source truth, design SS3 principle 1) -- only
 * whether, and that, value leaves the machine.
 */
export interface LiveSigner {
  /**
   * Sign + broadcast (or, for a recording double, merely record) a built tx's calls.
   * @returns the real on-chain ref(s) on a true submission, or `undefined` for a no-op (NOTHING sent).
   * @throws on any signing/transport failure -- an adapter/gateway maps a throw to a loud failure, never
   *   to a fabricated success.
   */
  sign(tx: UnsignedTx): Promise<readonly string[] | undefined>;
}

/**
 * The execution-contract seam an adapter needs to do its work -- the SAME narrow read/sign seams the legs
 * use, supplied by the gateway. `transport` is the `eth_call` reader for the quote + the gate (offline test
 * doubles satisfy it). `signer` is the OPTIONAL operator-wired live signer for `submit` (omitted => `submit`
 * fails CLOSED, loud not-wired). Passing the seams in (rather than capturing them) keeps every adapter pure
 * and offline-by-default (design SS6).
 */
export interface ConnectorContext {
  /** The `eth_call` transport for the on-chain quote read + the mandate gate. Omit => offline (fail-closed). */
  readonly transport?: EthCallTransport;
  /** The OPTIONAL operator-wired live signer for `submit`. Omit => `submit` fails CLOSED (loud not-wired). */
  readonly signer?: LiveSigner;
  /**
   * The OPTIONAL `eth_getBalance` source for the gateway's PRE-submit GAS-FLOOR gate (design SS3a -- the
   * "can't deplete gas" kill-switch). Omit => the gas floor fails CLOSED (loud not-wired) so the gateway
   * refuses to submit a value-moving action it cannot prove keeps the native reserve above `minGasReserve`.
   * Adapters never read this directly; the gateway uses it to gate every candidate before `submit`.
   */
  readonly balanceSource?: NativeBalanceSource;
}

/**
 * The ExecutionConnector -- the ONE bounded contract every protocol satisfies identically (design WOW
 * Feature 5). Five methods, ordered by the fund-loss-safe lifecycle:
 *
 *  1. **`quote(intent, ctx)`** -- PRE-build, OFFLINE/read-only: produce a [`Quote`] (the priced-fallback
 *     input). Moves NO value. `quotable: false` is the honest "I can't serve this" answer (the gateway
 *     skips). NEVER fabricates a quote -- a failed read is `quotable: false` with a loud reason.
 *  2. **`buildUnsigned(intent, ctx)`** -- PURE/OFFLINE: build the deterministic [`UnsignedTx`] (the ordered
 *     un-signed calls + the floor + the descriptor). Moves NO value. A malformed intent / unconfigured venue
 *     is a loud [`ConnectorError`] (pre-submit).
 *  3. **`submit(tx, ctx)`** -- the ONLY method that can MOVE VALUE: sign + broadcast via `ctx.signer`.
 *     Operator-gated -- without a wired signer it fails CLOSED with a loud not-wired [`ConnectorError`],
 *     never a fabricated [`OrderId`]. The returned [`OrderId`] is the verifier's input.
 *  4. **`status(orderId, ctx)`** -- read an order's lifecycle [`OrderStatus`] (incl. the `valueMoved` flag
 *     the gateway short-circuits on). An unreadable order degrades loudly to `OrderState.UNKNOWN`.
 *  5. **`cancel(orderId, ctx)`** -- best-effort cancel of a PRE-value order (e.g. an un-filled intent). It
 *     MUST refuse to "cancel" anything whose value has already moved (it cannot un-move funds); a value-moved
 *     order returns a loud, honest failure, never a fake "cancelled".
 *
 * Every adapter implements ALL five identically-shaped; the gateway calls only this contract.
 */
export interface ExecutionConnector {
  /** Which protocol family this adapter serves (the honesty label; the gateway dispatches over quotes). */
  readonly protocol: ProtocolKind;

  /**
   * PRE-build, read-only quote -- the priced-fallback input. Moves NO value. NEVER throws for an
   * unservable intent: returns `quotable: false` with a loud reason so the gateway can skip + try the next.
   * @throws {ConnectorError} ONLY for a programmer error in the intent (a malformed address/amount).
   */
  quote(intent: ExecutionIntent, ctx: ConnectorContext): Promise<Quote>;

  /**
   * PURE build of the deterministic un-signed tx. Moves NO value, signs nothing.
   * @throws {ConnectorError} on a malformed intent or an unconfigured venue (loud, pre-submit).
   */
  buildUnsigned(intent: ExecutionIntent, ctx: ConnectorContext): Promise<UnsignedTx>;

  /**
   * The ONLY value-moving method: sign + broadcast via `ctx.signer`. Operator-gated.
   * @throws {ConnectorError} if no live signer is wired (fail-closed, loud not-wired) or on a signer
   *   failure -- never a fabricated [`OrderId`].
   */
  submit(tx: UnsignedTx, ctx: ConnectorContext): Promise<OrderId>;

  /** Read an order's lifecycle status (incl. `valueMoved`). An unreadable order => `OrderState.UNKNOWN`. */
  status(orderId: OrderId, ctx: ConnectorContext): Promise<OrderStatus>;

  /**
   * Best-effort cancel of a PRE-value order. MUST refuse (loudly) anything whose value has moved -- it
   * cannot un-move funds, so it never returns a fake "cancelled" for a value-moved order.
   * @returns the resulting [`OrderStatus`] (a successfully-cancelled order is `FAILED` with `valueMoved:
   *   false`; a value-moved order is the honest "cannot cancel" status with `valueMoved: true`).
   */
  cancel(orderId: OrderId, ctx: ConnectorContext): Promise<OrderStatus>;
}
