/**
 * Tests for the swap leg (design WOW Feature 1: Oku/Uniswap-V3 exact-input single-hop, mandate-gated)
 * -- Node's built-in test runner, fully OFFLINE (no network, no signing; recorded transport doubles).
 *
 * They pin the design-WOW-Feature-1 invariants the swap leg must hold:
 *  - Step 1 (quote): the `QuoterV2.quoteExactInputSingle` staticCall is READ on-chain (the agent does
 *    not supply `expectedOut`); a malformed quote reply is a loud refusal, never a fabricated quote.
 *  - Step 3 (mandate gate, PRE-SWAP): `checkTransfer(agent, tokenIn, amountIn)` must clear, or the swap
 *    is refused pre-broadcast (the kill-switch -- design SS5). An over-cap / unread gate STOPS the leg;
 *    `exactInputSingle` is never planned.
 *  - Step 4 (execute): DRY_RUN broadcasts NOTHING; LIVE is operator-gated and fails CLOSED (loud
 *    not-wired) without a wired broadcaster -- NEVER a fabricated tx hash or "settled".
 *  - SS3 principle 5 (exact-integer money): the quote + floor are `bigint`s; the floor is exact-integer.
 *  - SS3 principle 3 (never fabricate): the leg NEVER claims `settled` (the verifier's job); a refused
 *    leg reports the honest outcome, never a fake success.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swap,
  quoteExpectedOut,
  decodeQuoteAmountOut,
  SwapError,
  SwapExecMode,
  SwapOutcome,
  OG_SWAP_VENUE,
  BPS_DENOMINATOR,
  type SwapLegRequest,
  type SwapVenueConfig,
} from "./swap.js";
import {
  slippageFloor,
  OG_SWAP_DEFAULTS,
  type SwapBroadcaster,
  type PlannedCall,
} from "./execute.js";
import {
  CHECK_TRANSFER_SELECTOR,
  type EthCallTransport,
  type MandateConfig,
} from "./mandate.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = AGENT;
const REGISTRY = "0x675ff5053f434aa3f1d48574813bfc1696fbd345";
const MANDATE: MandateConfig = { registry: REGISTRY };
const VENUE: SwapVenueConfig = OG_SWAP_VENUE;

/** A swap-leg request of `amountIn` minor units with `slippageBps` tolerance. */
function req(amountIn: bigint, slippageBps: number, extra: Partial<SwapLegRequest> = {}): SwapLegRequest {
  return { agent: AGENT, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, recipient: RECIPIENT, amountIn, slippageBps, ...extra };
}

/** Encode a uint256 as a 32-byte ABI word (for building fake quote/gate replies). */
function word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

/** A `(bool ok, bytes32 reason)` gate reply (two words). `reason` is left-aligned ASCII. */
function gateReply(ok: boolean, reason: string): string {
  const okWord = (ok ? 1n : 0n).toString(16).padStart(64, "0");
  let reasonHex = "";
  for (const ch of reason) reasonHex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  reasonHex = reasonHex.padEnd(64, "0");
  return "0x" + okWord + reasonHex;
}

/**
 * A transport double that answers the QuoterV2 quote with `quoteOut` and the gate `checkTransfer` with
 * `(gateOk, gateReason)`. It routes by the call's selector / `to` so one transport serves both reads.
 */
function transportDouble(opts: {
  quoteOut?: bigint;
  gateOk?: boolean;
  gateReason?: string;
  quoterAddr?: string;
}): { transport: EthCallTransport; calls: { to: string; data: string }[] } {
  const calls: { to: string; data: string }[] = [];
  const quoter = (opts.quoterAddr ?? VENUE.quoterV2).toLowerCase();
  const transport: EthCallTransport = {
    async ethCall(to: string, data: string): Promise<string> {
      calls.push({ to, data });
      if (data.startsWith(CHECK_TRANSFER_SELECTOR)) {
        return gateReply(opts.gateOk ?? true, opts.gateReason ?? "");
      }
      if (to.toLowerCase() === quoter) {
        // QuoterV2 returns (amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate) -- 4 words.
        return "0x" + word(opts.quoteOut ?? 0n) + word(0n) + word(0n) + word(0n);
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

/** A broadcaster that records the calls and returns fixed hashes (LIVE double). */
function recordingBroadcaster(hashes: readonly string[] | undefined): {
  broadcaster: SwapBroadcaster;
  seen: PlannedCall[][];
} {
  const seen: PlannedCall[][] = [];
  const broadcaster: SwapBroadcaster = {
    broadcast(calls: readonly PlannedCall[]): Promise<readonly string[] | undefined> {
      seen.push([...calls]);
      return Promise.resolve(hashes);
    },
  };
  return { broadcaster, seen };
}

// --- decodeQuoteAmountOut: the QuoterV2 amountOut decode (word 0) ----------------------------------

test("decodeQuoteAmountOut reads amountOut from word 0 of the 4-word QuoterV2 return", () => {
  const raw = "0x" + word(1_234_567n) + word(99n) + word(1n) + word(50000n);
  assert.equal(decodeQuoteAmountOut(raw), 1_234_567n);
});

test("decodeQuoteAmountOut rejects a malformed quote reply LOUDLY (never a fabricated quote)", () => {
  assert.throws(() => decodeQuoteAmountOut("0x"), SwapError);
  assert.throws(() => decodeQuoteAmountOut("0x1234"), SwapError); // < one word
  assert.throws(() => decodeQuoteAmountOut("0xzz".padEnd(66, "z")), SwapError); // non-hex
});

// --- quoteExpectedOut: the on-chain quote read (step 1) -------------------------------------------

test("quoteExpectedOut reads the QuoterV2 quote on-chain via the transport", async () => {
  const { transport, calls } = transportDouble({ quoteOut: 2_000_000n });
  const out = await quoteExpectedOut(req(1_000_000n, 50), VENUE, transport);
  assert.equal(out, 2_000_000n);
  // The quote was a staticCall to the QuoterV2 address.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.to, VENUE.quoterV2.toLowerCase());
});

test("quoteExpectedOut fails CLOSED with no transport (offline) -- never a fabricated quote", async () => {
  await assert.rejects(
    () => quoteExpectedOut(req(1n, 0), VENUE, undefined as unknown as EthCallTransport),
    (err: unknown) => {
      assert.ok(err instanceof SwapError);
      assert.match(err.message, /SWAP_QUOTE_NOT_WIRED/);
      return true;
    },
  );
});

test("quoteExpectedOut surfaces a transport failure LOUDLY", async () => {
  await assert.rejects(
    () => quoteExpectedOut(req(1n, 0), VENUE, throwingTransport("rpc down")),
    (err: unknown) => {
      assert.ok(err instanceof SwapError);
      assert.match(err.message, /SWAP_QUOTE_TRANSPORT_ERROR.*rpc down/);
      return true;
    },
  );
});

// --- swap: the full leg, quote -> gate -> plan -> execute(dry-run) --------------------------------

test("swap DRY_RUN: quote read, gate ALLOWED, swap PLANNED, broadcast NOTHING (design WOW Feature 1)", async () => {
  const { transport } = transportDouble({ quoteOut: 2_000_000n, gateOk: true });
  const r = await swap(req(1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, SwapOutcome.PLANNED_DRY_RUN);
  assert.equal(r.expectedOut, 2_000_000n, "expectedOut came from the on-chain quote");
  assert.equal(r.amountOutMinimum, slippageFloor(2_000_000n, 50), "floor derived from the quote + slippage");
  assert.equal(r.mandate?.allowed, true);
  assert.equal(r.plan?.calls.length, 2, "approve + exactInputSingle");
  assert.equal(r.plan?.calls[0]?.label, "approve");
  assert.equal(r.plan?.calls[1]?.label, "exactInputSingle");
  assert.equal(r.broadcast, false, "a dry-run sends NOTHING");
  assert.equal(r.txHashes, undefined, "never a fabricated hash (SS3 #3)");
});

test("swap is BLOCKED_BY_MANDATE when the gate returns over-cap -- swap never planned (the kill-switch)", async () => {
  const { transport } = transportDouble({ quoteOut: 2_000_000n, gateOk: false, gateReason: "OVER_TX_CAP" });
  const r = await swap(req(3_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN, transport);
  assert.equal(r.outcome, SwapOutcome.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate?.allowed, false);
  assert.equal(r.mandate?.reason, "OVER_TX_CAP");
  assert.equal(r.plan, undefined, "the swap was NEVER planned (refused pre-broadcast)");
  assert.equal(r.broadcast, false);
  assert.equal(r.txHashes, undefined);
});

test("swap fails CLOSED with no transport (offline) -- the quote cannot be read, leg refused", async () => {
  const r = await swap(req(1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN);
  assert.equal(r.outcome, SwapOutcome.QUOTE_FAILED);
  assert.equal(r.expectedOut, undefined);
  assert.equal(r.plan, undefined);
  assert.equal(r.broadcast, false);
  assert.match(r.note, /SWAP_QUOTE_NOT_WIRED/);
});

test("swap reports QUOTE_FAILED (not a throw) when the quote transport fails", async () => {
  const r = await swap(req(1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN, throwingTransport("rpc down"));
  assert.equal(r.outcome, SwapOutcome.QUOTE_FAILED);
  assert.equal(r.plan, undefined, "no plan when the quote could not be read");
  assert.match(r.note, /quote read failed/);
});

test("swap LIVE without a broadcaster fails CLOSED, loud not-wired -- never a fake hash (SS8)", async () => {
  const { transport } = transportDouble({ quoteOut: 2_000_000n, gateOk: true });
  await assert.rejects(
    () => swap(req(1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.LIVE, transport),
    (err: unknown) => {
      assert.ok(err instanceof SwapError);
      assert.match(err.message, /LIVE_NOT_WIRED/);
      return true;
    },
  );
});

test("swap LIVE with a wired broadcaster sends the ordered calls and returns the real hashes (operator-gated)", async () => {
  const { transport } = transportDouble({ quoteOut: 2_000_000n, gateOk: true });
  const { broadcaster, seen } = recordingBroadcaster(["0xfeed"]);
  const r = await swap(req(1_000_000n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.LIVE, transport, broadcaster);
  assert.equal(r.outcome, SwapOutcome.BROADCAST_LIVE);
  assert.equal(r.broadcast, true);
  assert.deepEqual(r.txHashes, ["0xfeed"]);
  // The broadcaster got [approve, exactInputSingle] in order.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.[0]?.label, "approve");
  assert.equal(seen[0]?.[1]?.label, "exactInputSingle");
  // The leg NEVER claims settled -- that is the verifier's job.
  assert.match(r.note, /verifier/i);
});

test("swap throws on a malformed amountIn before any quote/gate (loud, pre-read)", async () => {
  const { transport } = transportDouble({ quoteOut: 2_000_000n, gateOk: true });
  await assert.rejects(
    () => swap(req(0n, 50), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN, transport),
    (err: unknown) => {
      assert.ok(err instanceof SwapError);
      assert.match(err.message, /amountIn must be a positive bigint/);
      return true;
    },
  );
});

test("swap defaults to the public 0G mainnet venue (Oku SwapRouter02 / QuoterV2) when omitted", async () => {
  const { transport, calls } = transportDouble({ quoteOut: 2_000_000n, gateOk: true });
  const r = await swap(req(1_000_000n, 50), { mandate: MANDATE }, SwapExecMode.DRY_RUN, transport);
  // The swap call targets the public default router; the quote hit the public default quoter.
  assert.equal(r.plan?.calls[1]?.to, OG_SWAP_DEFAULTS.swapRouter02.toLowerCase());
  assert.ok(calls.some((c) => c.to.toLowerCase() === OG_SWAP_DEFAULTS.quoterV2.toLowerCase()));
});

test("swap floor is exact-integer over a quote beyond Number.MAX_SAFE_INTEGER (bigint, no float)", async () => {
  const bigQuote = 123456789012345678901234567890n; // far beyond 2^53
  const { transport } = transportDouble({ quoteOut: bigQuote, gateOk: true });
  const r = await swap(req(1_000_000n, 100), { mandate: MANDATE, venue: VENUE }, SwapExecMode.DRY_RUN, transport);
  assert.equal(r.expectedOut, bigQuote);
  assert.equal(r.amountOutMinimum, slippageFloor(bigQuote, 100));
});

// --- BPS_DENOMINATOR is the 100% basis (conformance with execute.ts) ------------------------------

test("BPS_DENOMINATOR is 10000 (100%) -- exact-integer slippage basis", () => {
  assert.equal(BPS_DENOMINATOR, 10_000);
});
