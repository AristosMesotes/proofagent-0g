/**
 * Adapter-conformance tests -- every adapter (swap / route / bridge) satisfies the ONE [`ExecutionConnector`]
 * contract IDENTICALLY (design WOW Feature 5: "a small bounded contract every protocol satisfies identically").
 * Node's built-in test runner, fully OFFLINE (no network, no signing; recorded transport/signer doubles).
 *
 * They pin the design-WOW-Feature-5 invariants every adapter must hold, the SAME way:
 *  - **quote** is PRE-build + read-only: it moves nothing; a not-servable intent is `quotable: false` (skip),
 *    never a throw, never a fabricated quote. A quotable quote carries `expectedOut` + the exact-integer floor.
 *  - **buildUnsigned** is PURE/offline: it moves nothing; a malformed intent / unconfigured venue is a loud
 *    [`ConnectorError`] (pre-submit).
 *  - **submit** is the ONLY value-moving method + is operator-gated: with no wired signer it fails CLOSED with
 *    a loud `*_NOT_WIRED` [`ConnectorError`] -- never a fabricated [`OrderId`]. With a wired signer it returns
 *    the real refs.
 *  - **status / cancel**: a submitted order is `valueMoved: true`; `cancel` REFUSES a value-moved order (it
 *    cannot un-move funds) and returns the honest `valueMoved: true` status -- never a fake "cancelled".
 *  - SS3 principle 3 (never fabricate): NO adapter ever claims `settled` (the verifier's monopoly).
 *  - SS3 principle 5 (exact-integer money): every amount is a `bigint`; the floor is exact-integer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProtocolKind,
  OrderState,
  ConnectorError,
  type ExecutionConnector,
  type ExecutionIntent,
  type ConnectorContext,
  type LiveSigner,
  type UnsignedTx,
  type OrderId,
} from "../connector.js";
import { CHECK_TRANSFER_SELECTOR, type EthCallTransport } from "../mandate.js";
import { slippageFloor, OG_SWAP_DEFAULTS } from "../execute.js";
import { makeSwapAdapter } from "./swap_adapter.js";
import { makeRouteAdapter, type RouteIntent } from "./route_adapter.js";
import { makeBridgeAdapter } from "./bridge_adapter.js";
import { OG_SWAP_VENUE } from "../swap.js";
import { OG_ROUTE_VENUE, RouteRail } from "../route.js";
import { OG_BRIDGE_VENUE, BridgeLane, DEST_SELECTOR } from "../bridge.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = AGENT;
const JAINE_ROUTER = "0x3333333333333333333333333333333333333333";
const TOKEN_POOL = "0x0a3d8ed619ecf1e984488710eb2cece4fdbd83ca";

/** Encode a uint256 as a 32-byte ABI word. */
function word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

/** A transport double answering the QuoterV2 quote with `quoteOut` and the gate with `(gateOk, "")`. */
function transportDouble(opts: { quoteOut?: bigint; quoterAddr?: string } = {}): EthCallTransport {
  const quoter = (opts.quoterAddr ?? OG_SWAP_VENUE.quoterV2).toLowerCase();
  return {
    async ethCall(to: string, data: string): Promise<string> {
      if (data.startsWith(CHECK_TRANSFER_SELECTOR)) {
        return "0x" + word(1n) + word(0n); // (ok=true, reason=OK)
      }
      if (to.toLowerCase() === quoter) {
        return "0x" + word(opts.quoteOut ?? 2_000_000n) + word(0n) + word(0n) + word(0n);
      }
      throw new Error(`unexpected eth_call to ${to}`);
    },
  };
}

/** A live signer double that records the tx it was handed and returns fixed refs. */
function recordingSigner(refs: readonly string[] | undefined): { signer: LiveSigner; seen: UnsignedTx[] } {
  const seen: UnsignedTx[] = [];
  const signer: LiveSigner = {
    sign(tx: UnsignedTx): Promise<readonly string[] | undefined> {
      seen.push(tx);
      return Promise.resolve(refs);
    },
  };
  return { signer, seen };
}

/** The base intent (a quotable swap/route/bridge intent of `amountIn` with `slippageBps`). */
function intent(amountIn: bigint, slippageBps: number, extra: Partial<RouteIntent> = {}): RouteIntent {
  return {
    agent: AGENT,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    recipient: RECIPIENT,
    amountIn,
    slippageBps,
    ...extra,
  };
}

// ----------------------------------------------------------------------------------------------
// The conformance matrix -- each adapter is described by how to make a QUOTABLE intent + its config.
// ----------------------------------------------------------------------------------------------

interface AdapterCase {
  readonly name: string;
  readonly protocol: ProtocolKind;
  /** Build the adapter under test. */
  make(): ExecutionConnector;
  /** A quotable intent for this adapter (swap reads on-chain; route/bridge carry the hint). */
  quotableIntent(amountIn: bigint, slippageBps: number): ExecutionIntent;
  /** The ctx that makes the intent quotable (swap needs a transport; route/bridge are offline-quotable). */
  quoteCtx(): ConnectorContext;
  /** The expected `expectedOut` for `quotableIntent(amountIn, ...)` (swap = on-chain quote; others = derived). */
  expectedOutFor(amountIn: bigint): bigint;
  /** The `*_NOT_WIRED` regex the submit fail-closed message must match. */
  readonly notWired: RegExp;
}

const QUOTE_OUT = 2_000_000n;

const CASES: readonly AdapterCase[] = [
  {
    name: "swap (Oku)",
    protocol: ProtocolKind.SWAP,
    make: () => makeSwapAdapter({ venue: OG_SWAP_VENUE }),
    quotableIntent: (amountIn, slippageBps) => intent(amountIn, slippageBps),
    quoteCtx: () => ({ transport: transportDouble({ quoteOut: QUOTE_OUT }) }),
    expectedOutFor: () => QUOTE_OUT, // the on-chain QuoterV2 quote (transport double returns QUOTE_OUT)
    notWired: /SWAP_SUBMIT_NOT_WIRED/,
  },
  {
    name: "route (JAINE native-AMM)",
    protocol: ProtocolKind.ROUTE,
    make: () => makeRouteAdapter(RouteRail.NATIVE_AMM, { venue: { ...OG_ROUTE_VENUE, jaineRouter: JAINE_ROUTER } }),
    quotableIntent: (amountIn, slippageBps) => intent(amountIn, slippageBps, { expectedOut: QUOTE_OUT }),
    quoteCtx: () => ({}), // route quotes off the agent-supplied rail quote (offline)
    expectedOutFor: () => QUOTE_OUT,
    notWired: /ROUTE_SUBMIT_NOT_WIRED/,
  },
  {
    name: "bridge (USDC.E egress / CCIP)",
    protocol: ProtocolKind.BRIDGE,
    make: () => makeBridgeAdapter(BridgeLane.USDC_EGRESS, { venue: { ...OG_BRIDGE_VENUE, tokenPool: TOKEN_POOL } }),
    quotableIntent: (amountIn, slippageBps) =>
      intent(amountIn, slippageBps, { destSelector: DEST_SELECTOR.ETHEREUM }),
    quoteCtx: () => ({}), // a bridge is a 1:1 amount; quotable offline once the dest selector is pinned
    expectedOutFor: (amountIn) => amountIn, // 1:1 lock/burn-and-mint
    notWired: /BRIDGE_SUBMIT_NOT_WIRED/,
  },
];

for (const c of CASES) {
  // --- quote: PRE-build, read-only, carries expectedOut + the exact-integer floor ------------------
  test(`[${c.name}] quote is quotable + carries expectedOut and the exact-integer floor (moves nothing)`, async () => {
    const adapter = c.make();
    const q = await adapter.quote(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    assert.equal(q.protocol, c.protocol, "the quote is labelled with the adapter's protocol");
    assert.equal(q.quotable, true, "a well-formed intent is quotable");
    const expOut = c.expectedOutFor(1_000_000n);
    assert.equal(q.expectedOut, expOut);
    assert.equal(q.minOut, slippageFloor(expOut, 50), "floor is the exact-integer slippage floor");
    assert.equal(typeof q.expectedOut, "bigint", "exact-integer money (no float)");
  });

  // --- buildUnsigned: PURE, the right protocol label + the floor, moves nothing --------------------
  test(`[${c.name}] buildUnsigned is pure + carries the floor + the protocol label (moves nothing)`, async () => {
    const adapter = c.make();
    const tx = await adapter.buildUnsigned(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    assert.equal(tx.protocol, c.protocol);
    assert.equal(tx.minOut, slippageFloor(c.expectedOutFor(1_000_000n), 50));
    assert.ok(Array.isArray(tx.calls), "a built tx exposes its ordered un-signed calls");
    assert.notEqual(tx.descriptor, undefined, "a built tx carries its secret-free descriptor");
  });

  // --- submit: the ONLY value-moving method, operator-gated, fails CLOSED with no signer -----------
  test(`[${c.name}] submit fails CLOSED with no live signer -- loud not-wired, never a fabricated OrderId`, async () => {
    const adapter = c.make();
    const tx = await adapter.buildUnsigned(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    await assert.rejects(
      () => adapter.submit(tx, {}), // no signer in ctx
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError);
        assert.match(err.message, c.notWired);
        return true;
      },
    );
  });

  // --- submit: with a wired signer, returns the real refs (operator-gated live path) ----------------
  test(`[${c.name}] submit with a wired signer returns the real refs (the verifier's input)`, async () => {
    const adapter = c.make();
    const tx = await adapter.buildUnsigned(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    const { signer, seen } = recordingSigner(["0xref"]);
    const order = await adapter.submit(tx, { signer });
    assert.equal(order.protocol, c.protocol);
    assert.deepEqual(order.refs, ["0xref"]);
    assert.equal(seen.length, 1, "the signer was handed the built tx");
  });

  // --- submit: a signer reporting no ref is an honest no-op (never a fabricated OrderId) ------------
  test(`[${c.name}] submit fails LOUDLY when the signer reports no ref (never a fabricated success)`, async () => {
    const adapter = c.make();
    const tx = await adapter.buildUnsigned(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    const { signer } = recordingSigner(undefined);
    await assert.rejects(
      () => adapter.submit(tx, { signer }),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError);
        assert.match(err.message, /no reference|never a fabricated/i);
        return true;
      },
    );
  });

  // --- status: a submitted order is valueMoved; an un-submitted (no-ref) order moved nothing --------
  test(`[${c.name}] status: a submitted order is valueMoved:true; a no-ref order moved nothing`, async () => {
    const adapter = c.make();
    const submitted: OrderId = { protocol: c.protocol, refs: ["0xref"] };
    const planned: OrderId = { protocol: c.protocol, refs: [] };
    const sSubmitted = await adapter.status(submitted, {});
    const sPlanned = await adapter.status(planned, {});
    assert.equal(sSubmitted.valueMoved, true, "a broadcast order has moved value");
    assert.equal(sSubmitted.state, OrderState.SUBMITTED);
    assert.equal(sPlanned.valueMoved, false, "an un-submitted order moved nothing");
    // No status ever POSITIVELY claims a settlement -- the note defers to the independent verifier (the
    // settlement monopoly, SS3 #2). It may say "never claims settled / never a fabricated settle", but it
    // must never assert the order DID settle.
    assert.match(sSubmitted.note.toLowerCase(), /verifier|never (claims settled|a fabricated settle)/);
  });

  // --- cancel: REFUSES a value-moved order (cannot un-move funds); cancels a no-ref order trivially -
  test(`[${c.name}] cancel REFUSES a value-moved order (valueMoved stays true); a no-ref order cancels`, async () => {
    const adapter = c.make();
    const moved: OrderId = { protocol: c.protocol, refs: ["0xref"] };
    const notMoved: OrderId = { protocol: c.protocol, refs: [] };
    const cMoved = await adapter.cancel(moved, {});
    assert.equal(cMoved.valueMoved, true, "cancel cannot un-move funds -- a value-moved order STAYS valueMoved");
    assert.match(cMoved.note, /REFUSED/, "a value-moved cancel is refused loudly");
    const cNotMoved = await adapter.cancel(notMoved, {});
    assert.equal(cNotMoved.valueMoved, false, "a never-submitted order cancels trivially (nothing moved)");
  });

  // --- the value_moved DISCIPLINE: quote + build move nothing; submit is the only value-mover -------
  test(`[${c.name}] value_moved discipline: quote + build never report a moved order; only a submitted one does`, async () => {
    const adapter = c.make();
    // quote + build produce no OrderId at all -- they cannot move value by construction.
    const q = await adapter.quote(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    assert.equal(q.quotable, true);
    const tx = await adapter.buildUnsigned(c.quotableIntent(1_000_000n, 50), c.quoteCtx());
    assert.ok(Array.isArray(tx.calls));
    // A never-submitted order's status reports valueMoved:false; only a submit-with-refs flips it.
    assert.equal((await adapter.status({ protocol: c.protocol, refs: [] }, {})).valueMoved, false);
    const { signer } = recordingSigner(["0xref"]);
    const order = await adapter.submit(tx, { signer });
    assert.equal((await adapter.status(order, {})).valueMoved, true);
  });
}

// ----------------------------------------------------------------------------------------------
// Per-adapter specifics that the shared matrix can't capture (the preserved on-chain shapes).
// ----------------------------------------------------------------------------------------------

test("swap adapter preserves the Oku 7-field exactInputSingle shape (selector 0x04e45aaf, no deadline)", async () => {
  const adapter = makeSwapAdapter({ venue: OG_SWAP_VENUE });
  const tx = await adapter.buildUnsigned(intent(1_000_000n, 50), { transport: transportDouble({ quoteOut: QUOTE_OUT }) });
  assert.equal(tx.calls.length, 2, "approve + exactInputSingle");
  assert.equal(tx.calls[0]?.label, "approve");
  assert.equal(tx.calls[1]?.label, "exactInputSingle");
  assert.ok(tx.calls[1]?.data.startsWith("0x04e45aaf"), "the 7-field SwapRouter02 tuple selector (no deadline)");
  assert.equal(tx.calls[1]?.to, OG_SWAP_DEFAULTS.swapRouter02.toLowerCase());
});

test("swap adapter quote is NOT quotable offline (no transport) -- skipped, never a fabricated quote", async () => {
  const adapter = makeSwapAdapter({ venue: OG_SWAP_VENUE });
  const q = await adapter.quote(intent(1_000_000n, 50), {}); // no transport
  assert.equal(q.quotable, false);
  assert.match(q.reason, /SWAP_QUOTE_NOT_WIRED/);
});

test("route native-AMM adapter fails CLOSED when the JAINE router is unconfigured (loud, never a baked-in target)", async () => {
  const adapter = makeRouteAdapter(RouteRail.NATIVE_AMM, { venue: OG_ROUTE_VENUE }); // empty jaineRouter
  await assert.rejects(
    () => adapter.buildUnsigned(intent(1_000_000n, 50, { expectedOut: QUOTE_OUT }), {}),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.match(err.message, /ROUTE_NATIVE_AMM_NOT_CONFIGURED/);
      return true;
    },
  );
});

test("route adapter is NOT quotable without a rail quote (expectedOut) -- skipped, never fabricated", async () => {
  const adapter = makeRouteAdapter(RouteRail.INTENT, { venue: OG_ROUTE_VENUE });
  const q = await adapter.quote(intent(1_000_000n, 50), {}); // no expectedOut hint
  assert.equal(q.quotable, false);
  assert.match(q.reason, /no rail quote supplied/);
});

test("bridge adapter is NOT quotable without an allow-listed destSelector (never the decommissioned testnet lane)", async () => {
  const adapter = makeBridgeAdapter(BridgeLane.USDC_EGRESS, { venue: { ...OG_BRIDGE_VENUE, tokenPool: TOKEN_POOL } });
  // missing destSelector
  const qMissing = await adapter.quote(intent(1_000_000n, 50), {});
  assert.equal(qMissing.quotable, false);
  assert.match(qMissing.reason, /destSelector .* is missing or not an allow-listed CCIP lane/);
  // a non-allow-listed (e.g. fabricated/testnet) selector
  const qBad = await adapter.quote(intent(1_000_000n, 50, { destSelector: 999_999n }), {});
  assert.equal(qBad.quotable, false);
});

test("bridge adapter fails CLOSED when the token pool is unconfigured (loud, never a baked-in target)", async () => {
  const adapter = makeBridgeAdapter(BridgeLane.USDC_EGRESS, { venue: OG_BRIDGE_VENUE }); // empty tokenPool
  await assert.rejects(
    () => adapter.buildUnsigned(intent(1_000_000n, 50, { destSelector: DEST_SELECTOR.ETHEREUM }), {}),
    (err: unknown) => {
      assert.ok(err instanceof ConnectorError);
      assert.match(err.message, /BRIDGE_POOL_NOT_CONFIGURED/);
      return true;
    },
  );
});

test("bridge adapter builds the approve(tokenPool) call + a ccipSend descriptor pinning the EXPECTED selector", async () => {
  const adapter = makeBridgeAdapter(BridgeLane.USDC_EGRESS, { venue: { ...OG_BRIDGE_VENUE, tokenPool: TOKEN_POOL } });
  const tx = await adapter.buildUnsigned(intent(1_000_000n, 50, { destSelector: DEST_SELECTOR.ETHEREUM }), {});
  assert.equal(tx.calls.length, 1, "the single burn/lock approval call");
  assert.equal(tx.calls[0]?.label, "approve");
  assert.equal(tx.calls[0]?.data.startsWith("0x095ea7b3"), true, "ERC-20 approve selector");
  const desc = tx.descriptor as { kind: string; lane: string; ccipSend: { destSelector: string; router: string } };
  assert.equal(desc.kind, "bridge");
  assert.equal(desc.ccipSend.destSelector, DEST_SELECTOR.ETHEREUM.toString(), "the EXPECTED selector is pinned");
});

test("every adapter throws on a malformed amountIn in quote (loud programmer error, before any value)", async () => {
  for (const c of CASES) {
    const adapter = c.make();
    await assert.rejects(
      () => adapter.quote(c.quotableIntent(0n, 50), c.quoteCtx()),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError, `${c.name}: a malformed amountIn is a loud ConnectorError`);
        assert.match(err.message, /amountIn must be a positive bigint/);
        return true;
      },
    );
  }
});
