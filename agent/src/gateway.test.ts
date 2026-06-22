/**
 * Tests for the gateway -- protocol-agnostic dispatch + priced fallback + the fund-loss-safe value_moved
 * short-circuit + the PRE-submit mandate gate (design WOW Feature 5: the Engine). Node's built-in test
 * runner, fully OFFLINE (recorded transport/signer doubles; no network, no signing).
 *
 * They pin the design-WOW-Feature-5 invariants the gateway must hold:
 *  - **protocol-agnostic**: the agent calls `gateway.execute(intent)` ONLY; the gateway picks an adapter by
 *    quote/priority -- the agent never names a protocol.
 *  - **priced fallback**: candidates are tried best-`expectedOut`-first; a PRE-submit failure (not quotable /
 *    build failed / gate blocked / signer not wired) falls back to the next candidate -- nothing moved.
 *  - **PRE-submit mandate gate, for EVERY adapter**: `checkTransfer(agent, tokenIn, amountIn)` runs in the
 *    gateway before submit; a non-allowed gate STOPS that candidate (the kill-switch) and falls back.
 *  - **the fund-loss-safe value_moved short-circuit (the HARD invariant)**: the instant `submit` puts value
 *    in flight (returns an OrderId), the gateway STOPS -- it NEVER retries or falls back (no double-spend).
 *    An AMBIGUOUS submit throw (a possibly-broadcast live-signer failure) also STOPS (never falls back).
 *  - SS3 principle 3 (never fabricate): the gateway reports dispatch, NEVER settlement (the verifier's job).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeGateway,
  GatewayOutcome,
  GatewayError,
  AttemptStage,
  statusOf,
  type GatewayConfig,
  type RegisteredAdapter,
} from "./gateway.js";
import {
  ProtocolKind,
  ConnectorError,
  OrderState,
  type ExecutionConnector,
  type ExecutionIntent,
  type ConnectorContext,
  type LiveSigner,
  type Quote,
  type UnsignedTx,
  type OrderId,
  type OrderStatus,
} from "./connector.js";
import { CHECK_TRANSFER_SELECTOR, type EthCallTransport, type MandateConfig } from "./mandate.js";
import { GAS_FLOOR_REASON, type GasFloorConfig, type NativeBalanceSource } from "./gasfloor.js";

// --- Fixtures -------------------------------------------------------------------------------------
const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = AGENT;
const REGISTRY = "0x675ff5053f434aa3f1d48574813bfc1696fbd345";
const MANDATE: MandateConfig = { registry: REGISTRY };

function word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

/** A box that counts the gate `checkTransfer` calls a transport double has served. */
interface GateCounter {
  readonly transport: EthCallTransport;
  /** How many `checkTransfer` eth_calls this transport has answered so far. */
  count: number;
}

/** A transport double answering the gate `checkTransfer` with `(gateOk, reason)`; counts the gate calls. */
function gateTransport(opts: { gateOk?: boolean; gateReason?: string } = {}): GateCounter {
  const box: GateCounter = {
    count: 0,
    transport: {
      ethCall(to: string, data: string): Promise<string> {
        if (data.startsWith(CHECK_TRANSFER_SELECTOR)) {
          box.count += 1;
          const ok = opts.gateOk ?? true;
          const reason = opts.gateReason ?? "";
          let reasonHex = "";
          for (const ch of reason) reasonHex += ch.charCodeAt(0).toString(16).padStart(2, "0");
          reasonHex = reasonHex.padEnd(64, "0");
          return Promise.resolve("0x" + word(ok ? 1n : 0n) + reasonHex);
        }
        return Promise.reject(new Error(`unexpected eth_call to ${to}`));
      },
    },
  };
  return box;
}

function intent(amountIn = 1_000_000n, slippageBps = 50): ExecutionIntent {
  return { agent: AGENT, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, recipient: RECIPIENT, amountIn, slippageBps };
}

/**
 * A fully-controllable fake adapter -- a faithful [`ExecutionConnector`] whose every method behaviour is
 * injectable. It lets a gateway test drive the exact quote / build / submit outcomes per candidate without
 * any real protocol. It records how many times each method was called (to PROVE the short-circuit).
 */
interface FakeOpts {
  readonly protocol: ProtocolKind;
  readonly expectedOut?: bigint; // the quote's expectedOut (drives the ordering); omit => quotable:false
  readonly quotable?: boolean;
  readonly buildThrows?: string; // if set, buildUnsigned throws a ConnectorError with this message
  /** submit behaviour: "refs" (returns refs -> value moved), "not-wired" (throws *_NOT_WIRED), "ambiguous" (throws other). */
  readonly submit?: "refs" | "not-wired" | "ambiguous";
  readonly refs?: readonly string[];
}
interface Fake {
  readonly adapter: ExecutionConnector;
  readonly calls: { quote: number; build: number; submit: number };
}
function makeFake(opts: FakeOpts): Fake {
  const calls = { quote: 0, build: 0, submit: 0 };
  const protocol = opts.protocol;
  const quotable = opts.quotable ?? opts.expectedOut !== undefined;
  const adapter: ExecutionConnector = {
    protocol,
    quote(_intent: ExecutionIntent, _ctx: ConnectorContext): Promise<Quote> {
      calls.quote += 1;
      if (!quotable) {
        return Promise.resolve({
          protocol,
          quotable: false,
          expectedOut: undefined,
          minOut: undefined,
          reason: `${protocol} fake: not quotable`,
        });
      }
      return Promise.resolve({
        protocol,
        quotable: true,
        expectedOut: opts.expectedOut,
        minOut: opts.expectedOut,
        reason: `${protocol} fake quote=${opts.expectedOut}`,
      });
    },
    buildUnsigned(_intent: ExecutionIntent, _ctx: ConnectorContext): Promise<UnsignedTx> {
      calls.build += 1;
      if (opts.buildThrows !== undefined) {
        return Promise.reject(new ConnectorError(opts.buildThrows));
      }
      return Promise.resolve({
        protocol,
        calls: [],
        minOut: opts.expectedOut ?? 0n,
        descriptor: { kind: "fake", protocol },
      });
    },
    submit(_tx: UnsignedTx, _ctx: ConnectorContext): Promise<OrderId> {
      calls.submit += 1;
      switch (opts.submit) {
        case "refs":
          return Promise.resolve({ protocol, refs: opts.refs ?? ["0xref"] });
        case "ambiguous":
          return Promise.reject(new ConnectorError(`${protocol} live signer exploded mid-broadcast`));
        case "not-wired":
        default:
          return Promise.reject(
            new ConnectorError(`${protocol.toUpperCase()}_SUBMIT_NOT_WIRED: operator-gated; no signer`),
          );
      }
    },
    status(orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      const has = orderId.refs.length > 0;
      return Promise.resolve({
        protocol,
        state: has ? OrderState.SUBMITTED : OrderState.PLANNED,
        valueMoved: has,
        note: `${protocol} fake status`,
      });
    },
    cancel(_orderId: OrderId, _ctx: ConnectorContext): Promise<OrderStatus> {
      return Promise.resolve({ protocol, state: OrderState.FAILED, valueMoved: false, note: "fake cancel" });
    },
  };
  return { adapter, calls };
}

function reg(fake: Fake, priority: number): RegisteredAdapter {
  return { adapter: fake.adapter, priority };
}

// ==================================================================================================
// construction + protocol-agnostic surface
// ==================================================================================================

test("makeGateway requires at least one adapter (a gateway with nothing to dispatch over is a loud error)", () => {
  assert.throws(() => makeGateway({ mandate: MANDATE, adapters: [] }), GatewayError);
});

test("the gateway exposes ONLY execute -- the agent never names a protocol (protocol-agnostic)", () => {
  const fake = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)] });
  assert.equal(typeof gw.execute, "function");
  // There is no per-protocol method on the gateway surface.
  assert.deepEqual(Object.keys(gw), ["execute"]);
});

// ==================================================================================================
// priced fallback -- best expectedOut first; PRE-submit failures fall back
// ==================================================================================================

test("priced fallback: the BEST expectedOut is tried first (the agent never picks the protocol)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const lo = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 1_000_000n, submit: "refs", refs: ["0xLO"] });
  const hi = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 3_000_000n, submit: "refs", refs: ["0xHI"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(lo, 0), reg(hi, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE, "the higher quote dispatched");
  assert.deepEqual(r.order?.refs, ["0xHI"]);
  // The losing (lower-quote) adapter was never built or submitted -- it lost the ordering.
  assert.equal(lo.calls.build, 0);
  assert.equal(lo.calls.submit, 0);
});

test("priced fallback: an equal quote is tie-broken by the LOWER registration priority (deterministic)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const a = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n, submit: "refs", refs: ["0xA"] });
  const b = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 2_000_000n, submit: "refs", refs: ["0xB"] });
  // b has the LOWER priority -> b wins the tie even though a registered first.
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(a, 5), reg(b, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE);
  assert.deepEqual(r.order?.refs, ["0xB"]);
});

test("priced fallback: a build failure on the best candidate falls back to the next (nothing moved)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const best = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 3_000_000n, buildThrows: "SWAP build boom" });
  const next = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "refs", refs: ["0xNEXT"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(best, 0), reg(next, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE);
  // The best candidate tried to build (and failed), and was NEVER submitted; the gateway fell back.
  assert.equal(best.calls.build, 1);
  assert.equal(best.calls.submit, 0);
  const bestAttempt = r.attempts.find((x) => x.protocol === ProtocolKind.SWAP);
  assert.equal(bestAttempt?.refusedAt, AttemptStage.BUILD_FAILED);
});

test("priced fallback: a not-quotable adapter is recorded + skipped (never treated as a failure)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const skip = makeFake({ protocol: ProtocolKind.SWAP, quotable: false });
  const ok = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 2_000_000n, submit: "refs", refs: ["0xOK"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(skip, 0), reg(ok, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE);
  const skipAttempt = r.attempts.find((x) => x.protocol === ProtocolKind.SWAP);
  assert.equal(skipAttempt?.refusedAt, AttemptStage.NOT_QUOTABLE);
  assert.equal(skip.calls.build, 0, "a not-quotable adapter is never built");
});

test("NO_CANDIDATE when every adapter is not quotable (nothing built / gated / dispatched)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const a = makeFake({ protocol: ProtocolKind.SWAP, quotable: false });
  const b = makeFake({ protocol: ProtocolKind.BRIDGE, quotable: false });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(a, 0), reg(b, 1)] });
  const r = await gw.execute(intent(), { transport });
  assert.equal(r.outcome, GatewayOutcome.NO_CANDIDATE);
  assert.equal(r.order, undefined);
  assert.equal(a.calls.build + b.calls.build, 0);
});

// ==================================================================================================
// the PRE-submit mandate gate -- for EVERY adapter, the kill-switch
// ==================================================================================================

test("the mandate checkTransfer gate runs PRE-submit for the candidate (the kill-switch)", async () => {
  const t = gateTransport({ gateOk: true });
  const fake = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n, submit: "refs", refs: ["0xR"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)] });
  const r = await gw.execute(intent(), { transport: t.transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(t.count, 1, "the gate eth_call ran exactly once, PRE-submit");
  assert.equal(r.attempts[0]?.mandate?.allowed, true);
});

test("a BLOCKED gate STOPS the candidate PRE-submit and falls back (the cap is a kill-switch)", async () => {
  const { transport } = gateTransport({ gateOk: false, gateReason: "OVER_TX_CAP" });
  const blocked = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 3_000_000n, submit: "refs", refs: ["0xNO"] });
  // The second adapter would also be gate-blocked (same transport) -> NO_DISPATCH overall.
  const next = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "refs", refs: ["0xNO2"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(blocked, 0), reg(next, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH, "every candidate was gate-blocked -> nothing dispatched");
  // Neither candidate submitted -- the gate is the kill-switch, PRE-submit.
  assert.equal(blocked.calls.submit, 0);
  assert.equal(next.calls.submit, 0);
  assert.equal(r.attempts[0]?.refusedAt, AttemptStage.BLOCKED_BY_MANDATE);
  assert.equal(r.attempts[0]?.mandate?.reason, "OVER_TX_CAP");
});

test("offline (no transport): the gate cannot read -> fail-closed -> NO_DISPATCH (nothing moved)", async () => {
  const fake = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n, submit: "refs", refs: ["0xR"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)] });
  const r = await gw.execute(intent(), {}); // no transport, no signer
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH);
  assert.equal(fake.calls.submit, 0, "a fail-closed gate never lets a candidate submit");
  assert.equal(r.attempts[0]?.refusedAt, AttemptStage.BLOCKED_BY_MANDATE);
  assert.equal(r.attempts[0]?.mandate?.verified, false);
});

// ==================================================================================================
// THE HARD INVARIANT -- the fund-loss-safe value_moved short-circuit
// ==================================================================================================

test("VALUE_MOVED SHORT-CIRCUIT: once a submit moves value, the gateway NEVER tries another candidate", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // `moved` has the higher quote, so it is tried FIRST and its submit moves value (returns refs). `tempting`
  // -- a second, fully-dispatchable candidate -- must NEVER be touched: a re-dispatch would double-spend.
  const moved = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 3_000_000n, submit: "refs", refs: ["0xMOVED"] });
  const tempting = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "refs", refs: ["0xNEVER"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(moved, 0), reg(tempting, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(r.dispatchedProtocol, ProtocolKind.SWAP, "the best quote dispatched first and moved value");
  assert.deepEqual(r.order?.refs, ["0xMOVED"]);
  // THE INVARIANT: the second candidate was NEVER built or submitted after value moved.
  assert.equal(tempting.calls.build, 0, "no fallback build after value moved");
  assert.equal(tempting.calls.submit, 0, "no fallback submit after value moved (no double-spend)");
  // The short-circuit is recorded honestly: the gateway stopped at the first dispatch.
  assert.equal(r.attempts.length, 1, "the gateway stopped at the first dispatch -- no further attempts");
  assert.match(r.attempts[0]?.note ?? "", /short-circuit/i);
});

test("VALUE_MOVED SHORT-CIRCUIT: an AMBIGUOUS submit throw STOPS the gateway (never falls back -- fund-loss-safe)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // The best candidate's submit throws a NON-not-wired error (the live signer may have broadcast). The gateway
  // must STOP and refuse to fall back, even though a perfectly-good second candidate exists.
  const ambiguous = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 3_000_000n, submit: "ambiguous" });
  const safe = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "refs", refs: ["0xSAFE"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(ambiguous, 0), reg(safe, 1)] });
  await assert.rejects(
    () => gw.execute(intent(), { transport, signer: dummySigner() }),
    (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.match(err.message, /FUND-LOSS-SAFE STOP/);
      assert.match(err.message, /double-spend/);
      return true;
    },
  );
  // The second candidate was NEVER tried -- the ambiguous broadcast could have moved value.
  assert.equal(safe.calls.build, 0, "no fallback build after an ambiguous (possibly-broadcast) submit");
  assert.equal(safe.calls.submit, 0, "no fallback submit after an ambiguous broadcast (fund-loss-safe)");
});

test("a not-wired submit is PRE-broadcast (guaranteed) -> safe to fall back (it moved nothing)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // The best candidate's submit fails CLOSED not-wired (a guaranteed pre-broadcast refusal). The gateway MAY
  // safely fall back -- nothing was broadcast.
  const notWired = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 3_000_000n, submit: "not-wired" });
  const next = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "refs", refs: ["0xNEXT"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(notWired, 0), reg(next, 1)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED, "the not-wired candidate fell back safely to the next");
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE);
  assert.equal(notWired.calls.submit, 1, "the not-wired submit was attempted (and refused pre-broadcast)");
  assert.equal(next.calls.submit, 1, "the fallback candidate submitted");
  const nwAttempt = r.attempts.find((x) => x.protocol === ProtocolKind.SWAP);
  assert.equal(nwAttempt?.refusedAt, AttemptStage.SUBMIT_NOT_WIRED);
});

test("default-build dry-run: no signer -> every candidate's submit fails closed -> NO_DISPATCH (nothing moved)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // Real adapters fail closed at submit with no signer. The fakes model that as not-wired.
  const a = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n, submit: "not-wired" });
  const b = makeFake({ protocol: ProtocolKind.ROUTE, expectedOut: 1_000_000n, submit: "not-wired" });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(a, 0), reg(b, 1)] });
  const r = await gw.execute(intent(), { transport }); // NO signer -- the dry-run default
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH);
  assert.equal(r.order, undefined, "nothing dispatched -> no order -> no fabricated settlement");
  assert.equal(r.attempts.every((x) => x.dispatched === false), true);
});

// ==================================================================================================
// honesty surface -- the gateway never claims settled; statusOf reads the owning adapter
// ==================================================================================================

test("the gateway reports DISPATCH, never SETTLEMENT (the verifier's monopoly -- SS3 #2/#3)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const fake = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n, submit: "refs", refs: ["0xR"] });
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.match(r.note, /verifier mints the settlement verdict/i);
  assert.doesNotMatch(r.note.toLowerCase(), /\bsettled\b(?!.*verdict)/);
});

test("statusOf reads the owning adapter's status (valueMoved); unknown protocol throws loudly", async () => {
  const fake = makeFake({ protocol: ProtocolKind.SWAP, expectedOut: 2_000_000n });
  const cfg: GatewayConfig = { mandate: MANDATE, adapters: [reg(fake, 0)] };
  const moved: OrderId = { protocol: ProtocolKind.SWAP, refs: ["0xR"] };
  const s = await statusOf(cfg, moved, {});
  assert.equal(s.valueMoved, true);
  await assert.rejects(
    () => statusOf(cfg, { protocol: ProtocolKind.BRIDGE, refs: ["0xX"] }, {}),
    GatewayError,
  );
});

test("a malformed intent surfaces as a loud GatewayError (programmer error, before any value)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // A fake whose quote throws a ConnectorError on a malformed intent (mirrors the real adapters).
  const strict: ExecutionConnector = {
    protocol: ProtocolKind.SWAP,
    quote: () => Promise.reject(new ConnectorError("swap.quote: amountIn must be a positive bigint")),
    buildUnsigned: () => Promise.reject(new ConnectorError("unreached")),
    submit: () => Promise.reject(new ConnectorError("unreached")),
    status: () => Promise.resolve({ protocol: ProtocolKind.SWAP, state: OrderState.PLANNED, valueMoved: false, note: "" }),
    cancel: () => Promise.resolve({ protocol: ProtocolKind.SWAP, state: OrderState.FAILED, valueMoved: false, note: "" }),
  };
  const gw = makeGateway({ mandate: MANDATE, adapters: [{ adapter: strict, priority: 0 }] });
  await assert.rejects(
    () => gw.execute(intent(0n), { transport }),
    (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.match(err.message, /amountIn must be a positive bigint/);
      return true;
    },
  );
});

/** A dummy live signer (returns a fixed ref) -- used where the gateway must reach a fake's submit. */
function dummySigner(): LiveSigner {
  return { sign: () => Promise.resolve(["0xsigned"]) };
}

// ==================================================================================================
// the PRE-submit GAS-FLOOR gate (design SS3a -- the "can't deplete gas" kill-switch)
// ==================================================================================================

/** A balance-source double returning a fixed native balance (wei) -- the gas-floor read seam. */
function balanceSource(balance: bigint): NativeBalanceSource {
  return { nativeBalance: () => Promise.resolve(balance) };
}

/**
 * A fake adapter whose built tx attaches `nativeValue` as a call `value` (the native `msg.value` the
 * action would move -- a native CCIP fee / native-token egress). The gateway sums this for the gas-floor
 * gate, so this drives the depletion check. Submit returns refs (value moves) when reached.
 */
function makeNativeFake(protocol: ProtocolKind, expectedOut: bigint, nativeValue: bigint, refs: string): Fake {
  const calls = { quote: 0, build: 0, submit: 0 };
  const adapter: ExecutionConnector = {
    protocol,
    quote(_i: ExecutionIntent, _c: ConnectorContext): Promise<Quote> {
      calls.quote += 1;
      return Promise.resolve({ protocol, quotable: true, expectedOut, minOut: expectedOut, reason: "native fake" });
    },
    buildUnsigned(_i: ExecutionIntent, _c: ConnectorContext): Promise<UnsignedTx> {
      calls.build += 1;
      return Promise.resolve({
        protocol,
        calls: [{ label: "ccipSend", to: "0x" + "9".repeat(40), data: "0x", value: nativeValue }],
        minOut: expectedOut,
        descriptor: { kind: "native-fake", protocol },
      });
    },
    submit(_t: UnsignedTx, _c: ConnectorContext): Promise<OrderId> {
      calls.submit += 1;
      return Promise.resolve({ protocol, refs: [refs] });
    },
    status(o: OrderId, _c: ConnectorContext): Promise<OrderStatus> {
      const has = o.refs.length > 0;
      return Promise.resolve({ protocol, state: has ? OrderState.SUBMITTED : OrderState.PLANNED, valueMoved: has, note: "" });
    },
    cancel(_o: OrderId, _c: ConnectorContext): Promise<OrderStatus> {
      return Promise.resolve({ protocol, state: OrderState.FAILED, valueMoved: false, note: "" });
    },
  };
  return { adapter, calls };
}

const FLOOR_ON: GasFloorConfig = { minGasReserve: 1_000_000n, enabled: true };

test("gas floor ALLOWS a candidate that keeps the native reserve above minGasReserve", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // balance 5_000_000, action native 1_000_000 + est fee 200_000 => remaining 3_800_000 >= reserve 1_000_000.
  const fake = makeNativeFake(ProtocolKind.BRIDGE, 2_000_000n, 1_000_000n, "0xOK");
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)], gasFloor: FLOOR_ON, estGasFee: 200_000n });
  const r = await gw.execute(intent(), { transport, signer: dummySigner(), balanceSource: balanceSource(5_000_000n) });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED, "the gas floor held -> the candidate dispatched");
  assert.equal(fake.calls.submit, 1);
  const a = r.attempts[0];
  assert.equal(a?.gasFloor?.allowed, true);
  assert.equal(a?.gasFloor?.reason, GAS_FLOOR_REASON.OK);
});

test("gas floor BLOCKS (kill-switch) a candidate that would deplete the native reserve -- PRE-submit", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // balance 1_200_000, action native 1_000_000 + est fee 300_000 => remaining -100_000 < reserve -> BLOCK.
  const fake = makeNativeFake(ProtocolKind.BRIDGE, 2_000_000n, 1_000_000n, "0xNO");
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)], gasFloor: FLOOR_ON, estGasFee: 300_000n });
  const r = await gw.execute(intent(), { transport, signer: dummySigner(), balanceSource: balanceSource(1_200_000n) });
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH, "the depleting candidate was refused; nothing dispatched");
  assert.equal(fake.calls.submit, 0, "submit was NEVER reached -- the gas floor stopped it PRE-broadcast");
  const a = r.attempts[0];
  assert.equal(a?.refusedAt, AttemptStage.BLOCKED_BY_GAS_FLOOR);
  assert.equal(a?.gasFloor?.allowed, false);
  assert.equal(a?.gasFloor?.reason, GAS_FLOOR_REASON.WOULD_DEPLETE_RESERVE);
  assert.equal(a?.mandate?.allowed, true, "the mandate cleared FIRST -- the gas floor is the next gate");
});

test("gas floor falls back to a CHEAPER (less depleting) candidate when the best would deplete", async () => {
  const { transport } = gateTransport({ gateOk: true });
  // Best quote (3_000_000) attaches a huge native cost that depletes the reserve -> blocked; the gateway
  // falls back to the next candidate, whose smaller native cost keeps the reserve intact -> it dispatches.
  const greedy = makeNativeFake(ProtocolKind.SWAP, 3_000_000n, 4_900_000n, "0xGREEDY"); // 4.9M of a 5M balance
  const thrifty = makeNativeFake(ProtocolKind.ROUTE, 1_000_000n, 500_000n, "0xTHRIFTY");
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(greedy, 0), reg(thrifty, 1)], gasFloor: FLOOR_ON, estGasFee: 100_000n });
  const r = await gw.execute(intent(), { transport, signer: dummySigner(), balanceSource: balanceSource(5_000_000n) });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED);
  assert.equal(r.dispatchedProtocol, ProtocolKind.ROUTE, "fell back to the less-depleting candidate");
  assert.equal(greedy.calls.submit, 0, "the greedy candidate was gas-floor-blocked before submit");
  assert.equal(thrifty.calls.submit, 1);
  const greedyAttempt = r.attempts.find((x) => x.protocol === ProtocolKind.SWAP);
  assert.equal(greedyAttempt?.refusedAt, AttemptStage.BLOCKED_BY_GAS_FLOOR);
});

test("gas floor fails CLOSED when no balanceSource is wired but the floor is ENABLED (never an allow)", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const fake = makeNativeFake(ProtocolKind.BRIDGE, 2_000_000n, 1_000_000n, "0xX");
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)], gasFloor: FLOOR_ON });
  // No balanceSource -> the gas floor cannot read the reserve -> fail-closed -> the candidate is refused.
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH);
  assert.equal(fake.calls.submit, 0, "an unread gas floor never permits a submit");
  assert.equal(r.attempts[0]?.gasFloor?.reason, GAS_FLOOR_REASON.NOT_WIRED);
});

test("a DISABLED / absent gas floor SKIPS the gate (backward-compatible) -- no balanceSource needed", async () => {
  const { transport } = gateTransport({ gateOk: true });
  const fake = makeNativeFake(ProtocolKind.BRIDGE, 2_000_000n, 9_999_999n, "0xDISABLED");
  // No gasFloor config at all -> the gate is skipped; even a wildly-depleting native cost dispatches (the
  // floor is OFF). The candidate's gasFloor verdict is undefined (the gate never ran).
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)] });
  const r = await gw.execute(intent(), { transport, signer: dummySigner() });
  assert.equal(r.outcome, GatewayOutcome.DISPATCHED, "with the floor disabled the gate is skipped");
  assert.equal(r.attempts[0]?.gasFloor, undefined, "the gas floor verdict is absent when the gate is skipped");
});

test("the gas floor runs AFTER the mandate gate (a mandate block short-circuits before the gas floor)", async () => {
  const { transport } = gateTransport({ gateOk: false, gateReason: "OVER_TX_CAP" });
  const fake = makeNativeFake(ProtocolKind.BRIDGE, 2_000_000n, 1_000_000n, "0xZ");
  const gw = makeGateway({ mandate: MANDATE, adapters: [reg(fake, 0)], gasFloor: FLOOR_ON, estGasFee: 100_000n });
  // The mandate gate blocks; the gas floor is never reached (its verdict is undefined for this candidate).
  const r = await gw.execute(intent(), { transport, signer: dummySigner(), balanceSource: balanceSource(5_000_000n) });
  assert.equal(r.outcome, GatewayOutcome.NO_DISPATCH);
  assert.equal(r.attempts[0]?.refusedAt, AttemptStage.BLOCKED_BY_MANDATE);
  assert.equal(r.attempts[0]?.gasFloor, undefined, "the gas floor never ran -- the mandate blocked first");
});
