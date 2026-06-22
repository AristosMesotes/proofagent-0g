/**
 * Tests for the bridge leg (design WOW Feature 3 / 3b: bridge-IN Eth->0G + bridge-OUT egress 0G->{Eth/Arb/
 * Base/BNB} via Chainlink CCIP `ccipSend`, each mandate-gated per hop) -- Node's built-in test runner,
 * fully OFFLINE (no network, no signing).
 *
 * They pin the design-WOW-Feature-3b invariants the bridge leg must hold:
 *  - The mandate gate is PER HOP and PRE-BURN: `checkTransfer(agent, token, amount)` must clear or the hop
 *    is refused pre-burn (the kill-switch -- design SS5). An over-cap / unread gate STOPS the hop; the
 *    `ccipSend` is never built ("the safest egress failure is the one that never burns on 0G").
 *  - The EXPECTED destination selector is PINNED + allow-list-checked: a non-allow-listed selector (e.g.
 *    the decommissioned Galileo testnet lane) is a loud refusal PRE-GATE (design WOW Feature 3b).
 *  - DRY_RUN sends NOTHING; LIVE is operator-gated and fails CLOSED (loud not-wired) without a wired
 *    dispatcher -- NEVER a fabricated messageId / tx hash or "settled". CCIP is MAINNET-only.
 *  - SS3 principle 5 (exact-integer money): the amount + minRelease floor are `bigint`s; the floor is exact.
 *  - SS3 principle 3 (never fabricate): the hop NEVER claims `settled` (the verifier's job -- and a bridge
 *    hop is settled ONLY when the verifier reads BOTH legs); a refused hop reports the honest outcome.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridge,
  isAllowedSelector,
  isKnownLane,
  laneIsEgress,
  laneIsInbound,
  BridgeError,
  BridgeExecMode,
  BridgeOutcome,
  BridgeLane,
  DEST_SELECTOR,
  OG_BRIDGE_VENUE,
  BPS_DENOMINATOR,
  type BridgeHopRequest,
  type BridgeVenueConfig,
  type BridgeDispatcher,
  type BridgeHopPlan,
} from "./bridge.js";
import { slippageFloor } from "./execute.js";
import { CHECK_TRANSFER_SELECTOR, type EthCallTransport, type MandateConfig } from "./mandate.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN = "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e"; // USDC.e (public; design WOW F3b)
const RECEIVER = AGENT;
const REGISTRY = "0x675ff5053f434aa3f1d48574813bfc1696fbd345";
const TOKEN_POOL = "0x0a3d8ed619ecf1e984488710eb2cece4fdbd83ca"; // USDC.E burnMint pool (public; design WOW F3b)
const MANDATE: MandateConfig = { registry: REGISTRY };
// A venue with the token pool pinned (the public default leaves it empty until confirmed on-chain).
const VENUE: BridgeVenueConfig = { ...OG_BRIDGE_VENUE, tokenPool: TOKEN_POOL };

/** A bridge-hop request on `lane` of `amount` minor units with `toleranceBps`, to `destSelector`. */
function req(
  lane: BridgeLane,
  amount: bigint,
  toleranceBps: number,
  destSelector: bigint,
  extra: Partial<BridgeHopRequest> = {},
): BridgeHopRequest {
  return {
    lane,
    agent: AGENT,
    token: TOKEN,
    receiver: RECEIVER,
    destSelector,
    amount,
    toleranceBps,
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
  dispatcher: BridgeDispatcher;
  seen: BridgeHopPlan[];
} {
  const seen: BridgeHopPlan[] = [];
  const dispatcher: BridgeDispatcher = {
    dispatch(plan: BridgeHopPlan): Promise<readonly string[] | undefined> {
      seen.push(plan);
      return Promise.resolve(refs);
    },
  };
  return { dispatcher, seen };
}

// --- isAllowedSelector / laneIsEgress: the public CCIP lanes + the egress direction --------------

test("isAllowedSelector: the five public CCIP lanes are allowed; the decommissioned testnet lane is not", () => {
  assert.equal(isAllowedSelector(DEST_SELECTOR.ETHEREUM), true);
  assert.equal(isAllowedSelector(DEST_SELECTOR.ZEROG), true);
  assert.equal(isAllowedSelector(DEST_SELECTOR.ARBITRUM), true);
  assert.equal(isAllowedSelector(DEST_SELECTOR.BASE), true);
  assert.equal(isAllowedSelector(DEST_SELECTOR.BNB), true);
  // The decommissioned Galileo testnet CCIP lane (and any unknown selector) is NOT allow-listed.
  assert.equal(isAllowedSelector(16602n), false, "the decommissioned Galileo lane is never allowed");
  assert.equal(isAllowedSelector(0n), false);
});

test("laneIsEgress: the USDC.E + w0G egress lanes leave the 0G hub; the inbound lanes do not", () => {
  assert.equal(laneIsEgress(BridgeLane.USDC_EGRESS), true);
  assert.equal(laneIsEgress(BridgeLane.W0G_EGRESS), true);
  assert.equal(laneIsEgress(BridgeLane.USDC_INBOUND), false);
  assert.equal(laneIsEgress(BridgeLane.W0G_INBOUND_ARBITRUM), false);
  assert.equal(laneIsEgress(BridgeLane.W0G_INBOUND_BNB), false);
});

test("laneIsInbound: the hub-and-spoke inbound lanes enter the 0G hub; it is the exact complement of egress", () => {
  // The hub-and-spoke section: every lane is exactly one of inbound (INTO the secured hub, autonomous) or
  // egress (OUT to a spoke, the risky/time-locked direction). The Arbitrum + BNB inbound lanes are new.
  assert.equal(laneIsInbound(BridgeLane.USDC_INBOUND), true);
  assert.equal(laneIsInbound(BridgeLane.W0G_INBOUND_ARBITRUM), true, "Arbitrum->0G is inbound (into the hub)");
  assert.equal(laneIsInbound(BridgeLane.W0G_INBOUND_BNB), true, "BNB->0G is inbound (into the hub)");
  assert.equal(laneIsInbound(BridgeLane.USDC_EGRESS), false);
  assert.equal(laneIsInbound(BridgeLane.W0G_EGRESS), false);
  // Inbound is the exact complement of egress over every known lane.
  for (const lane of Object.values(BridgeLane)) {
    assert.notEqual(laneIsInbound(lane), laneIsEgress(lane), `${lane} is exactly one of inbound/egress`);
  }
});

test("isKnownLane: the five lanes are known; an unknown lane string is rejected", () => {
  assert.equal(isKnownLane(BridgeLane.USDC_INBOUND), true);
  assert.equal(isKnownLane(BridgeLane.W0G_INBOUND_ARBITRUM), true);
  assert.equal(isKnownLane(BridgeLane.W0G_INBOUND_BNB), true);
  assert.equal(isKnownLane(BridgeLane.USDC_EGRESS), true);
  assert.equal(isKnownLane(BridgeLane.W0G_EGRESS), true);
  assert.equal(isKnownLane("teleport"), false, "an unknown lane is not known");
});

// --- bridge-OUT (USDC.E egress) DRY_RUN: gate ALLOWED, approve + ccipSend BUILT, send NOTHING -----

test("bridge USDC egress DRY_RUN: gate ALLOWED, approve + ccipSend BUILT, send NOTHING (design WOW F3b)", async () => {
  const { transport, calls } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.lane, BridgeLane.USDC_EGRESS);
  assert.equal(r.mandate?.allowed, true);
  assert.equal(r.minRelease, slippageFloor(1_000_000n, 50), "floor derived from the amount + tolerance");
  assert.equal(r.destSelector, DEST_SELECTOR.ETHEREUM.toString());
  assert.equal(r.plan?.calls.length, 1, "the approve(tokenPool, amount) call");
  assert.equal(r.plan?.calls[0]?.label, "approve");
  assert.equal(r.plan?.calls[0]?.to, TOKEN, "approve targets the bridged token");
  assert.equal(r.plan?.ccipSend.router, OG_BRIDGE_VENUE.ccipRouter, "ccipSend targets the public 0G CCIP Router");
  assert.equal(r.plan?.ccipSend.destSelector, DEST_SELECTOR.ETHEREUM.toString());
  assert.equal(r.plan?.ccipSend.tokenAmount.amount, "1000000");
  assert.equal(r.dispatched, false, "a dry-run sends NOTHING");
  assert.equal(r.refs, undefined, "never a fabricated ref (SS3 #3)");
  // Only the gate eth_call happened (no CCIP send in the offline build).
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.data.startsWith(CHECK_TRANSFER_SELECTOR));
  // The hop NEVER claims settled -- that is the verifier's two-leg job.
  assert.match(r.note, /NEVER claims settled/);
});

// --- bridge-IN (USDC inbound) + w0G egress DRY_RUN: gate ALLOWED, hop BUILT ------------------------

test("bridge USDC inbound (Eth->0G) DRY_RUN: gate ALLOWED, ccipSend pins the 0G destination selector", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.USDC_INBOUND, 1_000_000n, 50, DEST_SELECTOR.ZEROG), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.lane, BridgeLane.USDC_INBOUND);
  assert.equal(r.plan?.ccipSend.destSelector, DEST_SELECTOR.ZEROG.toString(), "the inbound hop pins the 0G lane");
  assert.equal(r.dispatched, false);
});

test("bridge w0G inbound (Arbitrum->0G hub) DRY_RUN: gate ALLOWED, ccipSend pins the 0G hub destination", async () => {
  // The hub-and-spoke section: a spoke->hub inbound lane is AUTONOMOUS (value enters the secured hub), but
  // STILL mandate-gated pre-send + verifier-confirmed two-leg after. The hop pins the 0G hub as destination.
  const { transport } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.W0G_INBOUND_ARBITRUM, 1_000_000n, 50, DEST_SELECTOR.ZEROG), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.lane, BridgeLane.W0G_INBOUND_ARBITRUM);
  assert.equal(laneIsInbound(r.lane), true, "the Arbitrum->0G lane is inbound (into the hub)");
  assert.equal(r.plan?.ccipSend.destSelector, DEST_SELECTOR.ZEROG.toString(), "the inbound hop pins the 0G hub lane");
  assert.equal(r.dispatched, false);
});

test("bridge w0G inbound (BNB->0G hub) DRY_RUN: gate ALLOWED, ccipSend pins the 0G hub destination", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.W0G_INBOUND_BNB, 1_000_000n, 50, DEST_SELECTOR.ZEROG), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.lane, BridgeLane.W0G_INBOUND_BNB);
  assert.equal(laneIsInbound(r.lane), true, "the BNB->0G lane is inbound (into the hub)");
  assert.equal(r.plan?.ccipSend.destSelector, DEST_SELECTOR.ZEROG.toString(), "the inbound hop pins the 0G hub lane");
});

test("bridge w0G egress (0G->Base) DRY_RUN: gate ALLOWED, ccipSend pins the Base destination selector", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.W0G_EGRESS, 1_000_000n, 50, DEST_SELECTOR.BASE), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.lane, BridgeLane.W0G_EGRESS);
  assert.equal(r.plan?.ccipSend.destSelector, DEST_SELECTOR.BASE.toString(), "the w0G egress pins the Base lane");
});

// --- the EXPECTED-destination pin: a non-allow-listed selector is refused PRE-GATE ----------------

test("bridge refuses a non-allow-listed destSelector PRE-GATE (never the decommissioned Galileo lane)", async () => {
  const { transport, calls } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, 16602n), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.match(err.message, /BRIDGE_DEST_NOT_ALLOWED/);
      return true;
    },
  );
  // The refusal is PRE-GATE: no eth_call was even made (the safest egress never reaches the gate/burn).
  assert.equal(calls.length, 0, "a non-allow-listed selector is refused before any gate read");
});

// --- the per-hop kill-switch: an over-cap / unread gate STOPS the hop pre-burn ---------------------

test("bridge is BLOCKED_BY_MANDATE when the gate returns over-cap -- the hop never burns (kill-switch)", async () => {
  const { transport } = transportDouble({ gateOk: false, gateReason: "OVER_TX_CAP" });
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 3_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, BridgeOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.mandate?.reason, "OVER_TX_CAP");
  assert.equal(r.plan, undefined, "the hop was NEVER built (refused pre-burn)");
  assert.equal(r.dispatched, false);
  assert.equal(r.refs, undefined);
});

test("bridge fails CLOSED with no transport (offline) -- the gate cannot read, hop refused PRE-BURN", async () => {
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE });
  assert.equal(r.outcome, BridgeOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.mandate?.verified, false);
  assert.equal(r.plan, undefined);
  assert.match(r.note, /BRIDGE_GATE_NOT_WIRED/);
  assert.match(r.note, /never burns on 0G/);
});

test("bridge stops at the gate (fail-closed) when the gate transport fails -- hop never burns", async () => {
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, throwingTransport("rpc down"));
  assert.equal(r.outcome, BridgeOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.plan, undefined, "no plan when the gate could not be read");
});

// --- LIVE: operator-gated, fails closed without a dispatcher; sends with one -----------------------

test("bridge LIVE without a dispatcher fails CLOSED, loud not-wired -- never a fake ref (SS8)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.LIVE, transport),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.match(err.message, /BRIDGE_LIVE_NOT_WIRED/);
      return true;
    },
  );
});

test("bridge LIVE with a wired dispatcher sends the built hop and returns the real refs (operator-gated)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const { dispatcher, seen } = recordingDispatcher(["0xmessageId1"]);
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.LIVE, transport, dispatcher);
  assert.equal(r.outcome, BridgeOutcome.DISPATCHED_LIVE);
  assert.equal(r.dispatched, true);
  assert.deepEqual(r.refs, ["0xmessageId1"]);
  assert.equal(seen.length, 1, "the dispatcher got the built hop plan");
  assert.equal(seen[0]?.lane, BridgeLane.USDC_EGRESS);
  // The hop NEVER claims settled -- the verifier reads BOTH legs; a hollow-egress is caught LOUD.
  assert.match(r.note, /BOTH legs/);
  assert.match(r.note, /hollow-egress/);
});

test("bridge LIVE dispatcher that returns no ref is an honest no-op (never a fake success)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  const { dispatcher } = recordingDispatcher(undefined);
  const r = await bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.LIVE, transport, dispatcher);
  assert.equal(r.outcome, BridgeOutcome.PLANNED_DRY_RUN);
  assert.equal(r.dispatched, false);
  assert.equal(r.refs, undefined);
});

// --- request validation + pool configuration ------------------------------------------------------

test("bridge throws on a malformed amount before any gate (loud, pre-read)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => bridge(req(BridgeLane.USDC_EGRESS, 0n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.match(err.message, /amount must be a positive bigint/);
      return true;
    },
  );
});

test("bridge fails CLOSED when the CCIP token pool is not configured (loud, never a baked-in target)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  // The public default venue leaves tokenPool empty -> the hop build fails closed.
  await assert.rejects(
    () => bridge(req(BridgeLane.USDC_EGRESS, 1_000_000n, 50, DEST_SELECTOR.ETHEREUM), { mandate: MANDATE, venue: OG_BRIDGE_VENUE }, BridgeExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.match(err.message, /BRIDGE_POOL_NOT_CONFIGURED/);
      return true;
    },
  );
});

test("bridge throws on an unknown lane (loud, pre-gate)", async () => {
  const { transport } = transportDouble({ gateOk: true });
  await assert.rejects(
    () => bridge({ ...req(BridgeLane.USDC_EGRESS, 1n, 0, DEST_SELECTOR.ETHEREUM), lane: "teleport" as unknown as BridgeLane }, { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.match(err.message, /unknown lane/);
      return true;
    },
  );
});

// --- the floor is exact-integer bigint over a huge amount (no float) -------------------------------

test("bridge floor is exact-integer over an amount beyond Number.MAX_SAFE_INTEGER (bigint, no float)", async () => {
  const bigAmount = 123456789012345678901234567890n; // far beyond 2^53
  const { transport } = transportDouble({ gateOk: true });
  const r = await bridge(req(BridgeLane.W0G_EGRESS, bigAmount, 100, DEST_SELECTOR.ARBITRUM), { mandate: MANDATE, venue: VENUE }, BridgeExecMode.DRY_RUN, transport);
  assert.equal(r.minRelease, slippageFloor(bigAmount, 100));
});

// --- the public CCIP selectors are the exact uint64 protocol facts --------------------------------

test("DEST_SELECTOR pins the exact public CCIP uint64 selectors (design WOW Feature 3 / 3b)", () => {
  assert.equal(DEST_SELECTOR.ETHEREUM, 5_009_297_550_715_157_269n);
  assert.equal(DEST_SELECTOR.ZEROG, 4_426_351_306_075_016_396n);
  assert.equal(DEST_SELECTOR.ARBITRUM, 4_949_039_107_694_359_620n);
  assert.equal(DEST_SELECTOR.BASE, 15_971_525_489_660_198_786n);
  assert.equal(DEST_SELECTOR.BNB, 11_344_663_589_394_136_015n);
});

// --- BPS_DENOMINATOR is the 100% basis (conformance with execute.ts) ------------------------------

test("BPS_DENOMINATOR is 10000 (100%) -- exact-integer tolerance basis", () => {
  assert.equal(BPS_DENOMINATOR, 10_000);
});
