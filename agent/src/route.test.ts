/**
 * Tests for the routing leg (design WOW Feature 2: Khalani intent / LI.FI aggregation / JAINE native AMM,
 * each mandate-gated per leg) -- Node's built-in test runner, fully OFFLINE (no network, no signing).
 *
 * They pin the design-WOW-Feature-2 invariants the routing leg must hold:
 *  - The mandate gate is PER LEG and PRE-ROUTE: `checkTransfer(agent, tokenIn, amountIn)` must clear or
 *    the leg is refused pre-broadcast (the kill-switch -- design SS5). An over-cap / unread gate STOPS
 *    the leg; the rail leg is never built.
 *  - DRY_RUN dispatches NOTHING; LIVE is operator-gated and fails CLOSED (loud not-wired) without a wired
 *    dispatcher -- NEVER a fabricated tx hash / order id or "settled".
 *  - The native-AMM (JAINE) rail is TESTNET-able (16602) and builds the standard V3 router calls; the
 *    cross-chain rails (intent/aggregation) are MAINNET-only -> operator-gated.
 *  - SS3 principle 5 (exact-integer money): the quote + floor are `bigint`s; the floor is exact-integer.
 *  - SS3 principle 3 (never fabricate): the leg NEVER claims `settled` (the verifier's job); a refused
 *    leg reports the honest outcome, never a fake success.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  route,
  railIsTestnetable,
  RouteError,
  RouteExecMode,
  RouteOutcome,
  RouteRail,
  OG_ROUTE_VENUE,
  BPS_DENOMINATOR,
  type RouteLegRequest,
  type RouteVenueConfig,
  type RouteDispatcher,
  type RouteLegPlan,
} from "./route.js";
import { slippageFloor, OG_SWAP_DEFAULTS } from "./execute.js";
import { CHECK_TRANSFER_SELECTOR, type EthCallTransport, type MandateConfig } from "./mandate.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = AGENT;
const REGISTRY = "0x675ff5053f434aa3f1d48574813bfc1696fbd345";
const JAINE_ROUTER = "0x3333333333333333333333333333333333333333";
const MANDATE: MandateConfig = { registry: REGISTRY };
// A venue with the JAINE router pinned (the public default leaves it empty until confirmed on-chain).
const VENUE: RouteVenueConfig = { ...OG_ROUTE_VENUE, jaineRouter: JAINE_ROUTER };

/** A routing-leg request on `rail` of `amountIn` minor units with `slippageBps` tolerance. */
function req(
  rail: RouteRail,
  amountIn: bigint,
  slippageBps: number,
  extra: Partial<RouteLegRequest> = {},
): RouteLegRequest {
  return {
    rail,
    agent: AGENT,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    recipient: RECIPIENT,
    amountIn,
    expectedOut: 2_000_000n,
    slippageBps,
    ...extra,
  };
}

/** A `(bool ok, bytes32 reason)` gate reply (two words). `reason` is left-aligned ASCII. */
function gateReply(ok: boolean, reason: string): string {
  const okWord = (ok ? 1n : 0n).toString(16).padStart(64, "0");
  let reasonHex = "";
  for (const ch of reason) reasonHex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  reasonHex = reasonHex.padEnd(64, "0");
  return "0x" + okWord + reasonHex;
}

/** A transport double that answers the gate `checkTransfer` with `(gateOk, gateReason)`. */
function transportDouble(opts: { gateOk?: boolean; gateReason?: string }): {
  transport: EthCallTransport;
  calls: { to: string; data: string }[];
} {
  const calls: { to: string; data: string }[] = [];
  const transport: EthCallTransport = {
    async ethCall(to: string, data: string): Promise<string> {
      calls.push({ to, data });
      if (data.startsWith(CHECK_TRANSFER_SELECTOR)) {
        return gateReply(opts.gateOk ?? true, opts.gateReason ?? "");
      }
      throw new Error(`unexpected eth_call to ${to}`);
    },
  };
  return { transport, calls };
}

/** A transport that throws on every call (a transport failure). */
function throwingTransport(message: string): EthCallTransport {
  return { ethCall: () => Promise.reject(new Error(message)) };
}

/** A dispatcher that records the plan and returns fixed refs (LIVE double). */
function recordingDispatcher(refs: readonly string[] | undefined): {
  dispatcher: RouteDispatcher;
  seen: RouteLegPlan[];
} {
  const seen: RouteLegPlan[] = [];
  const dispatcher: RouteDispatcher = {
    dispatch(plan: RouteLegPlan): Promise<readonly string[] | undefined> {
      seen.push(plan);
      return Promise.resolve(refs);
    },
  };
  return { dispatcher, seen };
}

// --- railIsTestnetable: only the native-AMM (JAINE) rail is testnet-able -------------------------

test("railIsTestnetable: only native-AMM (JAINE) is 16602-able; the cross-chain rails are mainnet-only", () => {
  assert.equal(railIsTestnetable(RouteRail.NATIVE_AMM), true);
  assert.equal(railIsTestnetable(RouteRail.INTENT), false);
  assert.equal(railIsTestnetable(RouteRail.AGGREGATION), false);
});

// --- native-AMM (JAINE) DRY_RUN: gate ALLOWED, leg BUILT (V3 calls), dispatch NOTHING -------------

test("route native-AMM DRY_RUN: gate ALLOWED, V3 calls BUILT, dispatch NOTHING (design WOW Feature 2)", async () => {
  const { transport, calls } = transportDouble({ gateOk: true });
  const r = await route(req(RouteRail.NATIVE_AMM, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, RouteOutcome.PLANNED_DRY_RUN);
  assert.equal(r.rail, RouteRail.NATIVE_AMM);
  assert.equal(r.mandate?.allowed, true);
  assert.equal(r.minOut, slippageFloor(2_000_000n, 50), "floor derived from the quote + slippage");
  assert.equal(r.plan?.calls.length, 2, "approve + exactInputSingle on the JAINE V3 router");
  assert.equal(r.plan?.calls[0]?.label, "approve");
  assert.equal(r.plan?.calls[1]?.label, "exactInputSingle");
  assert.equal(r.plan?.calls[1]?.to, JAINE_ROUTER.toLowerCase(), "the swap targets the JAINE V3 router");
  assert.equal(r.dispatched, false, "a dry-run dispatches NOTHING");
  assert.equal(r.refs, undefined, "never a fabricated ref (SS3 #3)");
  // Only the gate eth_call happened (no rail REST call in the offline build).
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.data.startsWith(CHECK_TRANSFER_SELECTOR));
});

// --- intent (Khalani) + aggregation (LI.FI) DRY_RUN: gate ALLOWED, REST descriptor BUILT ----------

test("route intent (Khalani) DRY_RUN: gate ALLOWED, REST descriptor BUILT, no on-chain calls, no dispatch", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await route(req(RouteRail.INTENT, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, RouteOutcome.PLANNED_DRY_RUN);
  assert.equal(r.rail, RouteRail.INTENT);
  assert.equal(r.plan?.calls.length, 0, "the intent rail is a REST/SDK descriptor, not on-chain calls");
  assert.match(r.plan?.request.endpoint ?? "", /Khalani/);
  assert.equal(r.plan?.request.args.minOut, String(slippageFloor(2_000_000n, 50)));
  assert.equal(r.dispatched, false);
  assert.match(r.note, /MAINNET-only -- a live action is OPERATOR-GATED/);
});

test("route aggregation (LI.FI) DRY_RUN: gate ALLOWED, REST descriptor BUILT (toChain=16661), no dispatch", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await route(req(RouteRail.AGGREGATION, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, RouteOutcome.PLANNED_DRY_RUN);
  assert.equal(r.rail, RouteRail.AGGREGATION);
  assert.match(r.plan?.request.endpoint ?? "", /LI\.FI/);
  assert.match(r.plan?.request.endpoint ?? "", /16661/);
  assert.equal(r.dispatched, false);
});

// --- the per-leg kill-switch: an over-cap / unread gate STOPS the leg pre-route -------------------

test("route is BLOCKED_BY_MANDATE when the gate returns over-cap -- the leg is never built (kill-switch)", async () => {
  const { transport } = transportDouble({ gateOk: false, gateReason: "OVER_TX_CAP" });
  const r = await route(req(RouteRail.NATIVE_AMM, 3_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, RouteOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.mandate?.reason, "OVER_TX_CAP");
  assert.equal(r.plan, undefined, "the leg was NEVER built (refused pre-broadcast)");
  assert.equal(r.dispatched, false);
  assert.equal(r.refs, undefined);
});

test("route fails CLOSED with no transport (offline) -- the gate cannot read, leg refused PRE-ROUTE", async () => {
  const r = await route(req(RouteRail.INTENT, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE });
  assert.equal(r.outcome, RouteOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.mandate?.verified, false);
  assert.equal(r.plan, undefined);
  assert.match(r.note, /ROUTE_GATE_NOT_WIRED/);
});

test("route stops at the gate (fail-closed) when the gate transport fails -- leg never built", async () => {
  const r = await route(req(RouteRail.AGGREGATION, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, throwingTransport("rpc down"));
  assert.equal(r.outcome, RouteOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.plan, undefined, "no plan when the gate could not be read");
});

// --- LIVE: operator-gated, fails closed without a dispatcher; sends with one ----------------------

test("route LIVE without a dispatcher fails CLOSED, loud not-wired -- never a fake ref (SS8)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => route(req(RouteRail.INTENT, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.LIVE, transport),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /ROUTE_LIVE_NOT_WIRED/);
      return true;
    },
  );
});

test("route LIVE with a wired dispatcher sends the built leg and returns the real refs (operator-gated)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const { dispatcher, seen } = recordingDispatcher(["0xorder1"]);
  const r = await route(req(RouteRail.NATIVE_AMM, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.LIVE, transport, dispatcher);
  assert.equal(r.outcome, RouteOutcome.DISPATCHED_LIVE);
  assert.equal(r.dispatched, true);
  assert.deepEqual(r.refs, ["0xorder1"]);
  assert.equal(seen.length, 1, "the dispatcher got the built leg plan");
  assert.equal(seen[0]?.rail, RouteRail.NATIVE_AMM);
  // The leg NEVER claims settled -- that is the verifier's job.
  assert.match(r.note, /verifier/i);
});

test("route LIVE dispatcher that returns no ref is an honest no-op (never a fake success)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const { dispatcher } = recordingDispatcher(undefined);
  const r = await route(req(RouteRail.NATIVE_AMM, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.LIVE, transport, dispatcher);
  assert.equal(r.outcome, RouteOutcome.PLANNED_DRY_RUN);
  assert.equal(r.dispatched, false);
  assert.equal(r.refs, undefined);
});

// --- request validation + native-AMM configuration ------------------------------------------------

test("route throws on a malformed amountIn before any gate (loud, pre-read)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => route(req(RouteRail.NATIVE_AMM, 0n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /amountIn must be a positive bigint/);
      return true;
    },
  );
});

test("route native-AMM fails CLOSED when the JAINE router is not configured (loud, never a baked-in target)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  // The public default venue leaves jaineRouter empty -> the native-AMM build fails closed.
  await assert.rejects(
    () => route(req(RouteRail.NATIVE_AMM, 1_000_000n, 50), { mandate: MANDATE, venue: OG_ROUTE_VENUE }, RouteExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /ROUTE_NATIVE_AMM_NOT_CONFIGURED/);
      return true;
    },
  );
});

test("route throws on an unknown rail (loud, pre-gate)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => route({ ...req(RouteRail.INTENT, 1n, 0), rail: "bridge" as unknown as RouteRail }, { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /unknown rail/);
      return true;
    },
  );
});

// --- the cross-chain rails default to mainnet-only gating; floor is exact-integer bigint ----------

test("route floor is exact-integer over a quote beyond Number.MAX_SAFE_INTEGER (bigint, no float)", async () => {
  const bigQuote = 123456789012345678901234567890n; // far beyond 2^53
  const { transport } = transportDouble({ gateOk: true });
  const r = await route(req(RouteRail.AGGREGATION, 1_000_000n, 100, { expectedOut: bigQuote }), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  assert.equal(r.minOut, slippageFloor(bigQuote, 100));
});

test("the native-AMM leg reuses the audited V3 codec (the same router shape the swap leg uses)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await route(req(RouteRail.NATIVE_AMM, 1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, RouteExecMode.DRY_RUN, transport);
  // The exactInputSingle calldata uses the same 7-field-tuple selector the swap leg pins (0x04e45aaf).
  assert.ok(r.plan?.calls[1]?.data.startsWith("0x04e45aaf"), "JAINE V3 exactInputSingle selector (no deadline)");
  // The default Oku swap-venue router is NOT used here -- the route leg targets the JAINE router.
  assert.notEqual(r.plan?.calls[1]?.to, OG_SWAP_DEFAULTS.swapRouter02.toLowerCase());
});

// --- BPS_DENOMINATOR is the 100% basis (conformance with execute.ts) ------------------------------

test("BPS_DENOMINATOR is 10000 (100%) -- exact-integer slippage basis", () => {
  assert.equal(BPS_DENOMINATOR, 10_000);
});
