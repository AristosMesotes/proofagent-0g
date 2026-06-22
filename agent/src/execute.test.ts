/**
 * Tests for the execute leg (design SS4 "a single capped swap on 0G" + SS8 money-safety) -- Node's
 * built-in test runner, fully OFFLINE (no network, no signing; a recorded broadcaster double).
 *
 * They pin the design invariants the execute leg must hold:
 *  - SS4 / WOW Feature 1 (the swap path): `approve(SwapRouter02, amountIn)` then
 *    `exactInputSingle(params)` -- the 7-field tuple (NO `deadline`, the footgun) -- with the
 *    `amountOutMinimum` slippage floor.
 *  - SS8 (claim only what's live / money-safety): DRY_RUN broadcasts NOTHING and signs NOTHING; LIVE
 *    is operator-gated and fails CLOSED (loud not-wired) without a wired broadcaster -- NEVER a
 *    fabricated tx hash or "settled" result.
 *  - SS3 principle 5 (exact-integer money): amounts are `bigint`; the slippage floor is exact-integer
 *    (no float), encoded as 256-bit words.
 *  - SS3 principle 4 (deterministic): same request + config -> byte-identical plan.
 *  - SS3 principle 3 (never fabricate): a malformed request throws loudly; an un-sent swap reports
 *    `broadcast:false` / `txHashes:undefined`, never a fake hash.
 *  - Conformance: the pinned selectors match the public ERC-20 / SwapRouter02 / QuoterV2 signatures
 *    (each verified by `cast sig` at build).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  execute,
  planSwap,
  slippageFloor,
  encodeApprove,
  encodeExactInputSingle,
  encodeQuoteExactInputSingle,
  ExecuteError,
  ExecuteMode,
  BPS_DENOMINATOR,
  DEFAULT_FEE_TIER,
  OG_SWAP_DEFAULTS,
  APPROVE_SELECTOR,
  APPROVE_SIGNATURE,
  EXACT_INPUT_SINGLE_SELECTOR,
  EXACT_INPUT_SINGLE_SIGNATURE,
  QUOTE_EXACT_INPUT_SINGLE_SELECTOR,
  QUOTE_EXACT_INPUT_SINGLE_SIGNATURE,
  type SwapRequest,
  type SwapConfig,
  type SwapBroadcaster,
  type PlannedCall,
} from "./execute.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ROUTER = OG_SWAP_DEFAULTS.swapRouter02;
const CONFIG: SwapConfig = { swapRouter02: ROUTER };

/** A swap request of `amountIn` minor units, quoted at `expectedOut`, with `slippageBps` tolerance. */
function req(
  amountIn: bigint,
  expectedOut: bigint,
  slippageBps: number,
  extra: Partial<SwapRequest> = {},
): SwapRequest {
  return { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, recipient: RECIPIENT, amountIn, expectedOut, slippageBps, ...extra };
}

/** A broadcaster that records the calls it was handed and returns a fixed set of hashes (LIVE double). */
function recordingBroadcaster(hashes: readonly string[] | undefined): {
  readonly broadcaster: SwapBroadcaster;
  readonly seen: PlannedCall[][];
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

/** A broadcaster that throws (a signing/transport failure). */
function throwingBroadcaster(message: string): SwapBroadcaster {
  return { broadcast: () => Promise.reject(new Error(message)) };
}

// --- Conformance: the pinned selectors match the canonical signatures (verified by `cast sig`) ----

test("pinned selectors match the canonical signatures (conformance, verified by cast sig)", () => {
  assert.equal(APPROVE_SIGNATURE, "approve(address,uint256)");
  assert.equal(APPROVE_SELECTOR, "0x095ea7b3");
  assert.equal(
    EXACT_INPUT_SINGLE_SIGNATURE,
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  );
  assert.equal(EXACT_INPUT_SINGLE_SELECTOR, "0x04e45aaf");
  assert.equal(
    QUOTE_EXACT_INPUT_SINGLE_SIGNATURE,
    "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
  );
  assert.equal(QUOTE_EXACT_INPUT_SINGLE_SELECTOR, "0xc6a5026a");
});

// --- The footgun: exactInputSingle is a 7-field tuple, NO deadline (design WOW Feature 1) ----------

test("encodeExactInputSingle encodes EXACTLY 7 words -- no deadline (the WOW Feature 1 footgun)", () => {
  const data = encodeExactInputSingle({
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    fee: DEFAULT_FEE_TIER,
    recipient: RECIPIENT,
    amountIn: 1_000_000n,
    amountOutMinimum: 900_000n,
    sqrtPriceLimitX96: 0n,
  });
  // 0x + 8 hex (selector) + 7 * 64 hex (words). An 8th `deadline` word would be 64 more chars.
  assert.equal(data.length, 2 + 8 + 7 * 64, "exactly 7 static words (NOT 8 -- no deadline)");
  assert.ok(data.startsWith(EXACT_INPUT_SINGLE_SELECTOR));
});

test("encodeExactInputSingle lays out the 7 fields in struct order (incl. fee right-aligned)", () => {
  const data = encodeExactInputSingle({
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    fee: 3000,
    recipient: RECIPIENT,
    amountIn: 42n,
    amountOutMinimum: 7n,
    sqrtPriceLimitX96: 0n,
  });
  const body = data.slice(2 + 8); // strip 0x + selector
  const word = (i: number): string => body.slice(i * 64, (i + 1) * 64);
  assert.equal(word(0), TOKEN_IN.slice(2).padStart(64, "0"));
  assert.equal(word(1), TOKEN_OUT.slice(2).padStart(64, "0"));
  assert.equal(BigInt("0x" + word(2)), 3000n, "fee tier in word 3");
  assert.equal(word(3), RECIPIENT.slice(2).padStart(64, "0"));
  assert.equal(BigInt("0x" + word(4)), 42n, "amountIn in word 5");
  assert.equal(BigInt("0x" + word(5)), 7n, "amountOutMinimum in word 6");
  assert.equal(BigInt("0x" + word(6)), 0n, "sqrtPriceLimitX96 in word 7");
});

// --- approve + quote codecs -----------------------------------------------------------------------

test("encodeApprove builds selector ++ spender ++ amount (2 static words)", () => {
  const data = encodeApprove(ROUTER, 1_000_000n);
  assert.equal(data.length, 2 + 8 + 2 * 64);
  assert.ok(data.startsWith(APPROVE_SELECTOR));
  assert.equal(BigInt("0x" + data.slice(data.length - 64)), 1_000_000n);
  // spender word is right-aligned, lowercased.
  const spenderWord = data.slice(2 + 8, 2 + 8 + 64);
  assert.equal(spenderWord, ROUTER.slice(2).toLowerCase().padStart(64, "0"));
});

test("encodeQuoteExactInputSingle uses the QuoterV2 field order (amountIn before fee)", () => {
  const data = encodeQuoteExactInputSingle(TOKEN_IN, TOKEN_OUT, 5n, 10000, 0n);
  assert.ok(data.startsWith(QUOTE_EXACT_INPUT_SINGLE_SELECTOR));
  const body = data.slice(2 + 8);
  // Order: tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96.
  assert.equal(BigInt("0x" + body.slice(2 * 64, 3 * 64)), 5n, "amountIn is word 3 (QuoterV2 order)");
  assert.equal(BigInt("0x" + body.slice(3 * 64, 4 * 64)), 10000n, "fee is word 4 (QuoterV2 order)");
});

// --- Exact-integer slippage floor (design SS3 principle 5 + WOW Feature 1 step 3) ------------------

test("slippageFloor is exact-integer: expectedOut - expectedOut*bps/10000 (no float)", () => {
  // 0.5% of 1_000_000 = 5000 tolerance -> floor 995_000.
  assert.equal(slippageFloor(1_000_000n, 50), 995_000n);
  // 0 bps -> floor == expectedOut (no tolerance given up).
  assert.equal(slippageFloor(1_000_000n, 0), 1_000_000n);
  // 100% (10000 bps) -> floor 0 (entire output may be given up).
  assert.equal(slippageFloor(1_000_000n, BPS_DENOMINATOR), 0n);
});

test("slippageFloor stays exact for amounts beyond Number.MAX_SAFE_INTEGER (bigint, no float)", () => {
  const big = 123456789012345678901234567890n; // far beyond 2^53
  // 1% (100 bps): tolerance = floor(big*100/10000) = floor(big/100).
  const expected = big - big / 100n;
  assert.equal(slippageFloor(big, 100), expected);
});

test("slippageFloor floors the tolerance DOWN -> the floor never under-protects (conservative)", () => {
  // 7 * 33 / 10000 = 0.0231 -> tolerance floors to 0 -> floor stays at expectedOut (>= exact floor).
  assert.equal(slippageFloor(7n, 33), 7n);
});

test("slippageFloor rejects out-of-range bps and non-bigint expectedOut LOUDLY", () => {
  assert.throws(() => slippageFloor(1_000n, -1), ExecuteError);
  assert.throws(() => slippageFloor(1_000n, BPS_DENOMINATOR + 1), ExecuteError);
  assert.throws(() => slippageFloor(1_000n, 1.5), ExecuteError);
  assert.throws(() => slippageFloor(-1n, 50), ExecuteError);
  assert.throws(() => slippageFloor(1000 as unknown as bigint, 50), ExecuteError);
});

// --- planSwap: the two ordered calls + the derived floor (design WOW Feature 1) --------------------

test("planSwap builds [approve, exactInputSingle] in order with the derived floor", () => {
  const p = planSwap(req(1_000_000n, 2_000_000n, 50), CONFIG);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0]?.label, "approve");
  assert.equal(p.calls[0]?.to, TOKEN_IN, "approve is called on tokenIn");
  assert.equal(p.calls[1]?.label, "exactInputSingle");
  assert.equal(p.calls[1]?.to, ROUTER.toLowerCase(), "the swap is called on SwapRouter02");
  // The floor flows into the params + the call.
  assert.equal(p.amountOutMinimum, slippageFloor(2_000_000n, 50));
  assert.equal(p.params.amountOutMinimum, p.amountOutMinimum);
  assert.equal(p.params.sqrtPriceLimitX96, 0n, "single-hop swap uses no price limit");
  assert.equal(p.params.fee, DEFAULT_FEE_TIER, "default fee tier when omitted");
  // All calls carry zero native value (ERC-20 swap).
  for (const c of p.calls) {
    assert.equal(c.value, 0n);
  }
});

test("planSwap approve authorizes the router for EXACTLY amountIn (mandate-bounded input)", () => {
  const p = planSwap(req(1_234_567n, 2n, 0), CONFIG);
  const approveData = p.calls[0]?.data ?? "";
  // amount is the last 64 hex of approve calldata.
  assert.equal(BigInt("0x" + approveData.slice(approveData.length - 64)), 1_234_567n);
});

test("planSwap is deterministic: same request + config -> byte-identical plan (SS3 principle 4)", () => {
  const a = planSwap(req(1_000_000n, 2_000_000n, 50), CONFIG);
  const b = planSwap(req(1_000_000n, 2_000_000n, 50), CONFIG);
  assert.equal(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.equal(a.calls[1]?.data, b.calls[1]?.data, "the swap calldata is byte-identical");
});

test("planSwap rejects a malformed request LOUDLY -- never a partial/fake plan (SS3 principle 3)", () => {
  assert.throws(() => planSwap(req(0n, 1n, 0), CONFIG), ExecuteError); // zero input
  assert.throws(() => planSwap(req(-1n, 1n, 0), CONFIG), ExecuteError); // negative input
  assert.throws(() => planSwap(req(1n, 1n, 0, { tokenIn: "0xbad" }), CONFIG), ExecuteError);
  assert.throws(() => planSwap(req(1n, 1n, 0, { recipient: "nope" }), CONFIG), ExecuteError);
  assert.throws(() => planSwap(req(1n, 1n, 0, { fee: 0 }), CONFIG), ExecuteError); // fee must be > 0
  assert.throws(() => planSwap(req(1n, 1n, 20000), CONFIG), ExecuteError); // slippage > 100%
});

// --- execute DRY_RUN: broadcasts NOTHING, signs NOTHING (design SS8 -- claim only what's live) -----

test("execute DRY_RUN (default) broadcasts nothing: broadcast:false, txHashes:undefined (SS8)", async () => {
  const r = await execute(req(1_000_000n, 2_000_000n, 50));
  assert.equal(r.mode, ExecuteMode.DRY_RUN);
  assert.equal(r.broadcast, false, "a dry-run sends NOTHING on-chain");
  assert.equal(r.txHashes, undefined, "a dry-run NEVER carries a tx hash (never fabricate, SS3 #3)");
  // The inspectable plan is still produced (the honest dry-run artifact).
  assert.equal(r.plan.calls.length, 2);
  assert.equal(r.plan.amountOutMinimum, slippageFloor(2_000_000n, 50));
});

test("execute DRY_RUN ignores any supplied broadcaster -- it must not send (SS8)", async () => {
  const { broadcaster, seen } = recordingBroadcaster(["0xdeadbeef"]);
  const r = await execute(req(1n, 2n, 0), CONFIG, ExecuteMode.DRY_RUN, broadcaster);
  assert.equal(r.broadcast, false);
  assert.equal(r.txHashes, undefined);
  assert.equal(seen.length, 0, "the broadcaster was NEVER called in a dry-run");
});

// --- execute LIVE: operator-gated. Fails CLOSED without a wired broadcaster (loud, never fabricate) -

test("execute LIVE without a broadcaster fails CLOSED, loud not-wired -- never a fake hash (SS8)", async () => {
  await assert.rejects(
    () => execute(req(1_000_000n, 2_000_000n, 50), CONFIG, ExecuteMode.LIVE),
    (err: unknown) => {
      assert.ok(err instanceof ExecuteError);
      assert.match(err.message, /LIVE_NOT_WIRED/);
      return true;
    },
  );
});

test("execute LIVE with a wired broadcaster sends the ordered calls and returns the real hashes", async () => {
  const { broadcaster, seen } = recordingBroadcaster(["0xabc123"]);
  const r = await execute(req(1_000_000n, 2_000_000n, 50), CONFIG, ExecuteMode.LIVE, broadcaster);
  assert.equal(r.mode, ExecuteMode.LIVE);
  assert.equal(r.broadcast, true);
  assert.deepEqual(r.txHashes, ["0xabc123"]);
  // It handed the broadcaster the [approve, exactInputSingle] calls, in order.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.[0]?.label, "approve");
  assert.equal(seen[0]?.[1]?.label, "exactInputSingle");
});

test("execute LIVE with a broadcaster that returns no hash reports broadcast:false (never fabricate)", async () => {
  const { broadcaster } = recordingBroadcaster(undefined);
  const r = await execute(req(1n, 2n, 0), CONFIG, ExecuteMode.LIVE, broadcaster);
  assert.equal(r.broadcast, false, "no hash returned => honestly NOT broadcast");
  assert.equal(r.txHashes, undefined);
});

test("execute LIVE with a broadcaster that throws surfaces the failure LOUDLY (never a fake success)", async () => {
  await assert.rejects(
    () => execute(req(1n, 2n, 0), CONFIG, ExecuteMode.LIVE, throwingBroadcaster("signer offline")),
    /signer offline/,
  );
});

test("execute throws on a malformed request before any broadcast decision (loud, pre-broadcast)", async () => {
  await assert.rejects(
    () => execute(req(1n, 1n, 0, { tokenOut: "0xbad" }), CONFIG, ExecuteMode.LIVE),
    ExecuteError,
  );
});

// --- Default config points at the public 0G SwapRouter02 (no hardcoded private target, SS6) --------

test("default config targets the public OG SwapRouter02 (design appendix / WOW Feature 1)", async () => {
  const r = await execute(req(1n, 2n, 0));
  // The swap call's `to` is the lowercased public router default.
  assert.equal(r.plan.calls[1]?.to, OG_SWAP_DEFAULTS.swapRouter02.toLowerCase());
});
