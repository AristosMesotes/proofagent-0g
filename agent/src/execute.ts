/**
 * The execute leg -- `execute(req)`: a single capped swap on 0G (Oku `SwapRouter02`).
 *
 * Design SS4 (architecture, `agent/execute.ts`): "a single capped swap on 0G". Design SS5 (the loop):
 * `execute` is the THIRD leg of `plan -> mandate-gate -> execute -> verify`; it runs ONLY after the
 * mandate gate has returned a definitive on-chain `allowed: true` -- "a failing mandate verdict means
 * the agent does not execute -- the cap is a kill-switch, enforced before any broadcast." Design SS8
 * (security & honesty doctrine): "testnet / dev only" live legs, "a per-trade cap", "a fresh demo
 * wallet", and -- the load-bearing rule for THIS step -- "claim only what is live" + "never fabricate".
 *
 * ## What this step builds, and what it deliberately does NOT (design SS8 -- claim only what's live)
 *
 * This module builds the swap leg END TO END *up to the broadcast boundary*, all OFFLINE and
 * deterministic:
 *   - the pure ABI codecs for the three swap-path calls -- `approve(spender,amount)`,
 *     `exactInputSingle(params)` (Oku/Uniswap-V3 `SwapRouter02`), and the `QuoterV2` quote read;
 *   - the exact-integer slippage floor `amountOutMinimum = expectedOut - expectedOut*slippageBps/10000`
 *     (no float on the money path -- design SS3 principle 5);
 *   - a planned, signed-nothing **SwapPlan** (the two calldatas + the floor) that a viewer can inspect.
 *
 * It does NOT broadcast. The live broadcast -- signing with a funded wallet's PRIVATE_KEY and sending
 * `eth_sendRawTransaction` -- needs a funded demo wallet and a real on-chain send, which is
 * **operator-gated** (design SS8: testnet/dev only, fresh wallet, per-trade cap). So broadcast is
 * guarded behind an EXPLICIT [`ExecuteMode.LIVE`] flag the caller must pass, and even then the live
 * signer is a LOUD not-wired stub (see the `// TODO(operator-gated live broadcast)` below). The
 * default and the only path this build exercises is [`ExecuteMode.DRY_RUN`]: it returns the inspectable
 * `SwapPlan` and broadcasts NOTHING. There is no code path that fabricates a tx hash or a "settled"
 * result -- an un-broadcast swap degrades LOUDLY to a dry-run plan, never silently to a fake success
 * (design SS3 principle 3). The verifier remains the sole authority on whether anything settled.
 *
 * ## The swap path (design WOW Feature 1 -- Oku/Uniswap-V3 `exactInputSingle`)
 *
 * A standard Uniswap-V3 exact-input single-hop swap through Oku's deployment of the canonical
 * Uniswap-V3 periphery: (1) `tokenIn.approve(SwapRouter02, amountIn)`; (2)
 * `SwapRouter02.exactInputSingle({tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum,
 * sqrtPriceLimitX96: 0})`. The on-chain `amountOutMinimum` floor is the protocol-native complement to
 * the mandate cap: the input is mandate-bounded (the gate), the output is slippage-bounded (this floor).
 *
 * **Footgun pinned (design WOW Feature 1):** `SwapRouter02`'s `ExactInputSingleParams` has **NO
 * `deadline`** -- it is 7 fields, not 8 (`tokenIn, tokenOut, fee, recipient, amountIn,
 * amountOutMinimum, sqrtPriceLimitX96`). Encoding an 8-field struct against `SwapRouter02` would
 * mis-decode on-chain; the codec here encodes exactly 7 head words and a test pins the field count.
 *
 * ## Two-source truth at the broadcast seam (design SS3 principle 1)
 *
 * The swap is BROADCAST through one narrow seam -- [`SwapBroadcaster`] -- mirroring the verifier's
 * `Source` trait and the mandate gate's `EthCallTransport`. The DRY-RUN broadcaster (the default, used
 * everywhere here) records the would-be calls and returns no hash; a LIVE broadcaster (operator-wired,
 * out of scope for this step) would sign + send. Swapping one for the other never changes what the
 * planned `SwapPlan` *means* -- the plan is computed identically; only whether it leaves the machine
 * differs.
 *
 * ## Default build needs no network (design SS6, clean-room / offline-by-default)
 *
 * Every codec and the slippage math are std-only -- zero runtime dependencies, no I/O. [`execute`]
 * called in `DRY_RUN` (the default) performs NO network access and signs nothing; it just plans. The
 * live broadcaster is opt-in and, in this step, a loud not-wired stub. So `tsc` and the default loop
 * are fully offline.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * `amountIn`, `expectedOut`, and the derived `amountOutMinimum` are `bigint`s in MINOR units -- never
 * `number`, never a float. The slippage floor is computed with exact-integer arithmetic
 * (`expectedOut - expectedOut * slippageBps / 10000`, integer division), ABI-encoded as 256-bit words.
 * There is no floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The function selectors are derived
 * from the public ERC-20 / Uniswap-V3 `SwapRouter02` / `QuoterV2` signatures; the contract addresses
 * are the public 0G mainnet (16661) values from the design appendix / WOW Feature 1, and they are
 * supplied via config (never a baked-in target beyond the documented public defaults).
 */

/**
 * The whole-percent basis for slippage and any proportional money math (1 bps = 1/100 of a percent),
 * so `BPS_DENOMINATOR = 10000 = 100%`. Mirrors `plan.ts`'s `TOTAL_BPS` -- exact-integer, no float
 * (design SS3 principle 5).
 */
export const BPS_DENOMINATOR = 10_000 as const;

/**
 * How [`execute`] is allowed to act on the swap plan (design SS8 -- claim only what's live).
 *
 * `DRY_RUN` (the default, the ONLY path this build exercises): compute + return the inspectable
 * `SwapPlan`, broadcast NOTHING, sign NOTHING, touch no network. `LIVE`: the operator-gated broadcast
 * path -- it requires an explicit opt-in AND a wired live broadcaster (a funded demo wallet signer),
 * which is out of scope for this step and is a LOUD not-wired stub. Passing `LIVE` without a wired
 * broadcaster fails CLOSED with a loud not-wired reason -- it never fabricates a hash.
 */
export const ExecuteMode = {
  /** Plan-only: return the `SwapPlan`, broadcast nothing (the default; the only path this build runs). */
  DRY_RUN: "DRY_RUN",
  /** Operator-gated live broadcast (needs a funded wallet + wired signer; a loud not-wired stub here). */
  LIVE: "LIVE",
} as const;

/** The execution mode -- `DRY_RUN` (default, offline) or `LIVE` (operator-gated broadcast). */
export type ExecuteMode = (typeof ExecuteMode)[keyof typeof ExecuteMode];

/**
 * A loud execution failure on the swap path (design SS3 principle 3 -- never fabricate; degrade
 * loudly). Thrown for a programmer error in the *request* (malformed address/amount/fee/slippage),
 * surfaced before any planning or broadcast -- never coerced into a partial or fake plan.
 */
export class ExecuteError extends Error {
  public override readonly name = "ExecuteError";
  public constructor(message: string) {
    super(message);
    // Keep a correct prototype chain under transpilation targets that need it.
    Object.setPrototypeOf(this, ExecuteError.prototype);
  }
}

// ----------------------------------------------------------------------------------------------
// Public 0G constants (design appendix + WOW Feature 1). Defaults only; a caller may override via
// SwapConfig. These are PUBLIC protocol addresses on 0G mainnet (16661) -- not secrets, not private.
// ----------------------------------------------------------------------------------------------

/**
 * The public Oku/Uniswap-V3 contract addresses on 0G Aristotle (chain id 16661), from design WOW
 * Feature 1. These are public protocol facts (confirmable on the explorer), provided as the DEFAULTS
 * for [`SwapConfig`]; a caller may override them (e.g. for a fork/testnet) via config. They are not
 * secrets and not proprietary -- they are the canonical Uniswap-V3 periphery as deployed by Oku on 0G.
 */
export const OG_SWAP_DEFAULTS = {
  /** Oku `SwapRouter02` on 0G mainnet -- the `exactInputSingle` entrypoint (design WOW Feature 1). */
  swapRouter02: "0x807F4E281B7A3B324825C64ca53c69F0b418dE40",
  /** Oku `QuoterV2` on 0G mainnet -- the `quoteExactInputSingle` staticCall read (design WOW Feature 1). */
  quoterV2: "0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455",
} as const;

/**
 * The Uniswap-V3 fee tier (in hundredths of a bip) for the single-hop pool. Design WOW Feature 1:
 * "try `fee=10000`/1%, fallback `3000`". The default is the 1% tier; a caller may override per pool.
 */
export const DEFAULT_FEE_TIER = 10_000 as const;

// ----------------------------------------------------------------------------------------------
// ABI codec -- pure, std-only, no deps. Pinned selectors (no keccak dependency, offline-by-default,
// design SS6), exactly matching the public ERC-20 / SwapRouter02 / QuoterV2 signatures.
// ----------------------------------------------------------------------------------------------

/**
 * The 4-byte selector for ERC-20 `approve(address,uint256)` -- `0x095ea7b3`. Pinned (not hashed at
 * runtime) so the codec needs no keccak dependency and stays std-only/offline (design SS6). The
 * canonical signature is [`APPROVE_SIGNATURE`]; a test pins the pair.
 */
export const APPROVE_SELECTOR = "0x095ea7b3" as const;
/** The canonical signature `APPROVE_SELECTOR` is derived from (for the conformance test). */
export const APPROVE_SIGNATURE = "approve(address,uint256)" as const;

/**
 * The 4-byte selector for `SwapRouter02.exactInputSingle((address,address,uint24,address,uint256,
 * uint256,uint160))` -- `0x04e45aaf`. This is the **7-field** `ExactInputSingleParams` tuple (NO
 * `deadline` -- design WOW Feature 1 footgun). Pinned (no keccak dep -- design SS6).
 *
 * Derivation (public, reproducible): `cast sig "exactInputSingle((address,address,uint24,address,
 * uint256,uint256,uint160))"` => `0x04e45aaf`; it also equals `SwapRouter02`'s compiled
 * `methodIdentifiers["exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"]`.
 */
export const EXACT_INPUT_SINGLE_SELECTOR = "0x04e45aaf" as const;
/** The canonical signature `EXACT_INPUT_SINGLE_SELECTOR` is derived from (7-field tuple, no deadline). */
export const EXACT_INPUT_SINGLE_SIGNATURE =
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" as const;

/**
 * The 4-byte selector for `QuoterV2.quoteExactInputSingle((address,address,uint256,uint24,uint160))`
 * -- `0xc6a5026a`. The `QuoterV2` params tuple is `(tokenIn, tokenOut, amountIn, fee,
 * sqrtPriceLimitX96)` (note the field ORDER differs from `exactInputSingle`). Pinned (no keccak dep).
 *
 * Derivation: `cast sig "quoteExactInputSingle((address,address,uint256,uint24,uint160))"` =>
 * `0xc6a5026a`.
 */
export const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "0xc6a5026a" as const;
/** The canonical signature `QUOTE_EXACT_INPUT_SINGLE_SELECTOR` is derived from. */
export const QUOTE_EXACT_INPUT_SINGLE_SIGNATURE =
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))" as const;

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize + validate a 20-byte EVM address to lowercase `0x` + 40-hex canonical form. A malformed
 * address is a loud [`ExecuteError`] (never silently zero-padded/truncated) -- a wrong address would
 * swap the wrong asset or send to the wrong recipient.
 */
function normalizeAddress(label: string, addr: string): string {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr.trim())) {
    throw new ExecuteError(
      `${label} must be a 20-byte 0x address (0x + 40 hex), got ${String(addr)}`,
    );
  }
  return addr.trim().toLowerCase();
}

/** Left-pad a validated, lowercased address to a 32-byte (64-hex) right-aligned ABI word. */
function addressWord(addr: string): string {
  return addr.slice(2).padStart(64, "0");
}

/**
 * Encode a non-negative integer (`bigint` minor units OR a small `number` like a fee tier) into a
 * 32-byte ABI word, with an explicit bit-width ceiling. Exact-integer only (design SS3 principle 5):
 * rejects negatives and any value beyond the width -- a loud [`ExecuteError`], never wrapped/truncated.
 */
function uintWord(label: string, value: bigint, bits: number): string {
  if (typeof value !== "bigint") {
    throw new ExecuteError(`${label} must be a bigint (exact-integer money path), got ${typeof value}`);
  }
  if (value < 0n) {
    throw new ExecuteError(`${label} must be non-negative, got ${value.toString()}`);
  }
  const max = (1n << BigInt(bits)) - 1n;
  if (value > max) {
    throw new ExecuteError(`${label} exceeds uint${bits} range: ${value.toString()}`);
  }
  return value.toString(16).padStart(64, "0");
}

/** Validate a Uniswap-V3 fee tier as a `uint24` and return it as a `bigint` (for word encoding). */
function feeToBigint(fee: number): bigint {
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new ExecuteError(`fee tier must be a positive integer (uint24), got ${String(fee)}`);
  }
  const f = BigInt(fee);
  if (f > (1n << 24n) - 1n) {
    throw new ExecuteError(`fee tier exceeds uint24 range: ${fee}`);
  }
  return f;
}

/**
 * Encode `approve(spender, amount)` calldata (ERC-20). Pure/deterministic: head-only, two static
 * 32-byte words after the selector. Validates the spender address and the `bigint` amount loudly.
 *
 * Design WOW Feature 1 step (4): `tokenIn.approve(SwapRouter02, amountIn)` precedes the swap so the
 * router may pull `amountIn`. The `to` of this call is `tokenIn`; the spender is the router.
 */
export function encodeApprove(spender: string, amount: bigint): string {
  const s = normalizeAddress("spender", spender);
  const a = uintWord("approve amount", amount, 256);
  return APPROVE_SELECTOR + addressWord(s) + a;
}

/** The 7 fields of `SwapRouter02.exactInputSingle` -- NO `deadline` (design WOW Feature 1 footgun). */
export interface ExactInputSingleParams {
  /** The asset being sold (mandate-bounded input). */
  readonly tokenIn: string;
  /** The asset being bought. */
  readonly tokenOut: string;
  /** The Uniswap-V3 pool fee tier (hundredths of a bip; e.g. `10000` = 1%). */
  readonly fee: number;
  /** Who receives `tokenOut` (the demo wallet; checked by the mandate gate's recipient/allowlist). */
  readonly recipient: string;
  /** Exact input amount, MINOR units, `bigint` (exact-integer; design SS3 principle 5). */
  readonly amountIn: bigint;
  /** The on-chain slippage FLOOR -- revert if output < this. MINOR units, `bigint`. */
  readonly amountOutMinimum: bigint;
  /** Price-limit (0 = no limit). `uint160`; the swap leg always uses `0` (design WOW Feature 1). */
  readonly sqrtPriceLimitX96: bigint;
}

/**
 * Encode `SwapRouter02.exactInputSingle(params)` calldata. The single tuple argument is STATIC (all 7
 * fields are value types), so the ABI head is the selector followed by exactly 7 inline 32-byte words
 * in struct order: `tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96`.
 *
 * Pure/deterministic. Encoding exactly 7 words (NOT 8) is the design WOW Feature 1 footgun made
 * mechanical: there is no `deadline` word; a test pins the 7-word body length.
 */
export function encodeExactInputSingle(params: ExactInputSingleParams): string {
  const tokenIn = addressWord(normalizeAddress("tokenIn", params.tokenIn));
  const tokenOut = addressWord(normalizeAddress("tokenOut", params.tokenOut));
  const fee = uintWord("fee", feeToBigint(params.fee), 24);
  const recipient = addressWord(normalizeAddress("recipient", params.recipient));
  const amountIn = uintWord("amountIn", params.amountIn, 256);
  const amountOutMinimum = uintWord("amountOutMinimum", params.amountOutMinimum, 256);
  const sqrtPriceLimitX96 = uintWord("sqrtPriceLimitX96", params.sqrtPriceLimitX96, 160);
  // selector ++ 7 inline static words (struct order). No 8th `deadline` word -- design WOW Feature 1.
  return (
    EXACT_INPUT_SINGLE_SELECTOR +
    tokenIn +
    tokenOut +
    fee +
    recipient +
    amountIn +
    amountOutMinimum +
    sqrtPriceLimitX96
  );
}

/**
 * Encode the `QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96))`
 * staticCall calldata (design WOW Feature 1 step (2): quote -> `expectedOut`). The tuple field ORDER
 * differs from `exactInputSingle` (amountIn before fee). Pure/deterministic.
 */
export function encodeQuoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
  sqrtPriceLimitX96: bigint = 0n,
): string {
  const tIn = addressWord(normalizeAddress("tokenIn", tokenIn));
  const tOut = addressWord(normalizeAddress("tokenOut", tokenOut));
  const amt = uintWord("amountIn", amountIn, 256);
  const f = uintWord("fee", feeToBigint(fee), 24);
  const limit = uintWord("sqrtPriceLimitX96", sqrtPriceLimitX96, 160);
  return QUOTE_EXACT_INPUT_SINGLE_SELECTOR + tIn + tOut + amt + f + limit;
}

// ----------------------------------------------------------------------------------------------
// Slippage floor -- exact-integer, no float (design SS3 principle 5).
// ----------------------------------------------------------------------------------------------

/**
 * Compute the on-chain slippage FLOOR `amountOutMinimum` from a quoted `expectedOut` and a slippage
 * tolerance in basis points -- design WOW Feature 1 step (3):
 * `amountOutMinimum = expectedOut * (1 - slippageBps)`.
 *
 * Computed with EXACT-INTEGER arithmetic (design SS3 principle 5): `floor = expectedOut - expectedOut
 * * slippageBps / 10000`, using integer (`bigint`) multiplication and floor division -- no float, ever.
 * The subtractive form keeps the floor conservative (rounds the *tolerance* down, so the floor can
 * only be >= the exact real-number floor, never below it -- it never under-protects the swap).
 *
 * @param expectedOut  The quoted output (MINOR units, `bigint`, non-negative).
 * @param slippageBps  Tolerance in bps, `0..=BPS_DENOMINATOR` (e.g. `50` = 0.5%). A loud error if out
 *                     of range -- a >100% or negative tolerance is never silently clamped.
 * @returns the floor in MINOR units (`bigint`), `0 <= floor <= expectedOut`.
 */
export function slippageFloor(expectedOut: bigint, slippageBps: number): bigint {
  if (typeof expectedOut !== "bigint") {
    throw new ExecuteError("expectedOut must be a bigint in minor units (exact-integer money path)");
  }
  if (expectedOut < 0n) {
    throw new ExecuteError(`expectedOut must be non-negative, got ${expectedOut.toString()}`);
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > BPS_DENOMINATOR) {
    throw new ExecuteError(
      `slippageBps must be an integer in 0..=${BPS_DENOMINATOR}, got ${String(slippageBps)}`,
    );
  }
  // tolerance = floor(expectedOut * slippageBps / 10000); floor output = expectedOut - tolerance.
  const tolerance = (expectedOut * BigInt(slippageBps)) / BigInt(BPS_DENOMINATOR);
  return expectedOut - tolerance;
}

// ----------------------------------------------------------------------------------------------
// The swap request, the planned (un-broadcast) SwapPlan, and the broadcast seam.
// ----------------------------------------------------------------------------------------------

/**
 * The swap to execute -- the agent's *proposal* for the execute leg. By the time this reaches
 * [`execute`], the mandate gate has already cleared `tokenIn`/`amountIn`/recipient on-chain (design
 * SS5: execute runs only after `allowed: true`); this request is the concrete swap that clears.
 */
export interface SwapRequest {
  /** The asset being sold (must be the mandate-allowlisted, gate-cleared input). */
  readonly tokenIn: string;
  /** The asset being bought. */
  readonly tokenOut: string;
  /** The pool fee tier (hundredths of a bip). Defaults to [`DEFAULT_FEE_TIER`] if omitted. */
  readonly fee?: number;
  /** Who receives `tokenOut` (the demo wallet). */
  readonly recipient: string;
  /** Exact input, MINOR units, `bigint` -- the mandate-bounded, gate-cleared amount. */
  readonly amountIn: bigint;
  /** The `QuoterV2` quote for this swap (MINOR units, `bigint`). Required to derive the floor. */
  readonly expectedOut: bigint;
  /** Slippage tolerance in bps (`0..=10000`). The floor = `expectedOut - expectedOut*bps/10000`. */
  readonly slippageBps: number;
}

/** The public 0G swap-venue config -- the router/quoter addresses (defaults = [`OG_SWAP_DEFAULTS`]). */
export interface SwapConfig {
  /** The `SwapRouter02` address (the `approve` spender + the `exactInputSingle` `to`). */
  readonly swapRouter02: string;
}

/**
 * A single planned on-chain call within the swap path -- the inspectable, un-broadcast unit. A
 * `SwapPlan` is a sequence of these; a DRY-RUN returns them without sending; a LIVE broadcaster (out of
 * scope this step) would sign + send each in order.
 */
export interface PlannedCall {
  /** A human label for the journal/UI (e.g. `"approve"`, `"exactInputSingle"`). Never the truth source. */
  readonly label: string;
  /** The contract to call (`tokenIn` for approve, `SwapRouter02` for the swap). */
  readonly to: string;
  /** The ABI-encoded calldata (selector + args) -- deterministic, inspectable, signs nothing. */
  readonly data: string;
  /** Native value to attach (always `0n` for an ERC-20 swap; pinned for clarity). */
  readonly value: bigint;
}

/**
 * The fully-planned swap -- the deterministic output of the execute leg in `DRY_RUN`. It is the two
 * ordered calls (`approve` then `exactInputSingle`) plus the derived slippage floor, and it broadcasts
 * NOTHING. A viewer (or the verifier, later) can inspect exactly what *would* be sent. This is the
 * honest dry-run artifact: it never carries a tx hash or a "settled" claim (design SS8 -- claim only
 * what's live; design SS3 principle 3 -- never fabricate).
 */
export interface SwapPlan {
  /** The ordered calls to broadcast: `[approve(tokenIn -> router, amountIn), exactInputSingle(...)]`. */
  readonly calls: readonly PlannedCall[];
  /** The decoded `exactInputSingle` params (for the journal/UI), incl. the computed floor. */
  readonly params: ExactInputSingleParams;
  /** The exact-integer slippage floor used as `amountOutMinimum` (MINOR units). */
  readonly amountOutMinimum: bigint;
}

/**
 * The broadcast seam (mirrors the verifier's `Source` trait + the gate's `EthCallTransport`): the one
 * narrow boundary across which a `SwapPlan` could leave the machine. A `DRY_RUN` broadcaster records
 * the calls and returns NO hash; a `LIVE` broadcaster (operator-wired -- out of scope this step) would
 * sign each call with a funded wallet and `eth_sendRawTransaction`. The decision logic + the planned
 * calls are identical either way (two-source truth -- design SS3 principle 1).
 */
export interface SwapBroadcaster {
  /**
   * Broadcast (or, for a dry-run, merely record) the ordered swap calls.
   * @returns the tx hash(es) on a real send, or `undefined` for a dry-run (NOTHING was broadcast).
   * @throws on any signing/transport failure -- [`execute`] maps a throw to a loud failure, never to
   *   a fabricated success.
   */
  broadcast(calls: readonly PlannedCall[]): Promise<readonly string[] | undefined>;
}

/**
 * The result of the execute leg -- an HONEST report of what happened (design SS3 principle 3).
 *
 * `mode` states which path ran. `plan` is always present (the inspectable, deterministic swap plan).
 * `broadcast` is `false` for a dry-run (NOTHING left the machine) and `true` only when a live
 * broadcaster actually sent; `txHashes` carries the real hash(es) ONLY on a true live send and is
 * `undefined` otherwise -- it is NEVER a fabricated hash. A verdict on whether the swap *settled* is
 * the VERIFIER's job, not this leg's: this report only states "planned" or "broadcast", never "settled".
 */
export interface ExecuteResult {
  /** Which mode ran (`DRY_RUN` or `LIVE`). */
  readonly mode: ExecuteMode;
  /** The deterministic, inspectable swap plan (always present, even for a dry-run). */
  readonly plan: SwapPlan;
  /** `true` iff a live broadcaster actually sent on-chain; `false` for a dry-run (nothing sent). */
  readonly broadcast: boolean;
  /** The real tx hash(es) iff `broadcast === true`; `undefined` for a dry-run. NEVER fabricated. */
  readonly txHashes: readonly string[] | undefined;
}

// ----------------------------------------------------------------------------------------------
// planSwap -- pure, offline: build the two ordered calls + the slippage floor. No broadcast.
// ----------------------------------------------------------------------------------------------

/**
 * Build the deterministic, un-broadcast [`SwapPlan`] for `req` -- the pure core of the execute leg.
 *
 * Steps (design WOW Feature 1): derive `amountOutMinimum` from the quote + slippage (exact-integer
 * floor), then encode the two ordered calls -- `tokenIn.approve(SwapRouter02, amountIn)` and
 * `SwapRouter02.exactInputSingle(params)` (7-field tuple, no deadline). Pure: no I/O, no clock, no
 * randomness; the same request + config always yields a byte-identical plan (design SS3 principle 4).
 * Signs nothing and broadcasts nothing.
 *
 * @throws {ExecuteError} on any malformed field (address/amount/fee/slippage) -- loud, never a partial
 *   or fabricated plan (design SS3 principle 3).
 */
export function planSwap(req: SwapRequest, config: SwapConfig): SwapPlan {
  const tokenIn = normalizeAddress("tokenIn", req.tokenIn);
  const tokenOut = normalizeAddress("tokenOut", req.tokenOut);
  const recipient = normalizeAddress("recipient", req.recipient);
  const router = normalizeAddress("swapRouter02", config.swapRouter02);
  const fee = req.fee ?? DEFAULT_FEE_TIER;

  if (typeof req.amountIn !== "bigint" || req.amountIn <= 0n) {
    // A zero/negative input is never a valid swap (mirrors the mandate's ZERO_AMOUNT block). Loud.
    throw new ExecuteError(
      `amountIn must be a positive bigint in minor units, got ${String(req.amountIn)}`,
    );
  }

  // Exact-integer slippage floor (design WOW Feature 1 step 3, design SS3 principle 5).
  const amountOutMinimum = slippageFloor(req.expectedOut, req.slippageBps);

  const params: ExactInputSingleParams = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    amountIn: req.amountIn,
    amountOutMinimum,
    // Always 0 (no price limit) for the single-hop swap leg (design WOW Feature 1 step 5).
    sqrtPriceLimitX96: 0n,
  };

  // Call 1: approve the router to pull `amountIn` of `tokenIn` (design WOW Feature 1 step 4).
  const approveCall: PlannedCall = {
    label: "approve",
    to: tokenIn,
    data: encodeApprove(router, req.amountIn),
    value: 0n,
  };
  // Call 2: the swap itself (design WOW Feature 1 step 5). 7-field tuple, no deadline.
  const swapCall: PlannedCall = {
    label: "exactInputSingle",
    to: router,
    data: encodeExactInputSingle(params),
    value: 0n,
  };

  return { calls: [approveCall, swapCall], params, amountOutMinimum };
}

// ----------------------------------------------------------------------------------------------
// execute -- the leg. DRY_RUN by default (offline, broadcasts nothing). LIVE is operator-gated.
// ----------------------------------------------------------------------------------------------

/**
 * The execute leg -- a single capped swap on 0G (design SS4). It ALWAYS computes the deterministic
 * [`SwapPlan`] (offline); whether that plan is broadcast is governed by `mode`:
 *
 *  - `DRY_RUN` (default): broadcast NOTHING, sign NOTHING, touch no network -- return the inspectable
 *    plan with `broadcast: false` and `txHashes: undefined`. This is the ONLY path this build runs.
 *  - `LIVE`: the operator-gated broadcast path. It REQUIRES an explicit `mode: "LIVE"` AND a wired
 *    `broadcaster` (a funded demo-wallet signer). Without a broadcaster it fails CLOSED with a loud
 *    not-wired error -- it NEVER fabricates a hash or a "settled" result (design SS3 principle 3, SS8).
 *
 * The execute leg never mints a settlement verdict -- "did it settle?" is the VERIFIER's job. This
 * function reports only "planned" (dry-run) or "broadcast" (live send), honestly.
 *
 * @param req         The concrete swap (already mandate-gate-cleared upstream -- design SS5).
 * @param config      The public 0G swap venue (router address; default [`OG_SWAP_DEFAULTS`]).
 * @param mode        `DRY_RUN` (default) or `LIVE` (operator-gated; needs a broadcaster).
 * @param broadcaster OPTIONAL live broadcaster. Used ONLY in `LIVE`. Omit it for the offline dry-run.
 * @throws {ExecuteError} on a malformed request (loud, pre-broadcast) or on `LIVE` without a wired
 *   broadcaster (fail-closed, loud not-wired) -- never a fabricated success.
 */
export async function execute(
  req: SwapRequest,
  config: SwapConfig = { swapRouter02: OG_SWAP_DEFAULTS.swapRouter02 },
  mode: ExecuteMode = ExecuteMode.DRY_RUN,
  broadcaster?: SwapBroadcaster,
): Promise<ExecuteResult> {
  // Always plan first -- a malformed request throws LOUD here, before any broadcast decision.
  const plan = planSwap(req, config);

  if (mode === ExecuteMode.DRY_RUN) {
    // The default + only path this build exercises: nothing is signed or sent (design SS8).
    return { mode: ExecuteMode.DRY_RUN, plan, broadcast: false, txHashes: undefined };
  }

  // mode === LIVE: operator-gated broadcast. Requires an explicitly-wired live broadcaster.
  //
  // TODO(operator-gated live broadcast): the LIVE leg is NOT wired in this build. A real broadcast
  // needs a FUNDED demo wallet (PRIVATE_KEY from a gitignored .env), a signer, and an
  // `eth_sendRawTransaction` transport -- all operator-gated (design SS8: testnet/dev only, fresh
  // wallet, per-trade cap). Until an operator wires a `SwapBroadcaster`, `LIVE` fails CLOSED here.
  // This MUST stay a loud failure: NEVER fabricate a tx hash or a "settled" result for an un-sent swap.
  if (broadcaster === undefined) {
    throw new ExecuteError(
      "EXECUTE_LIVE_NOT_WIRED: live broadcast is operator-gated and no SwapBroadcaster was supplied; " +
        "refusing to broadcast. Wire a funded-wallet signer to enable LIVE (design SS8). " +
        "DRY_RUN plans the swap without sending; nothing was broadcast.",
    );
  }

  // A live broadcaster IS wired (operator-supplied). Broadcast the ordered calls; any throw is a loud
  // failure (never a fabricated success). A `undefined` return is treated as "nothing was sent".
  const txHashes = await broadcaster.broadcast(plan.calls);
  if (txHashes === undefined || txHashes.length === 0) {
    // The broadcaster reported no hash -- honestly surface "not broadcast", never a fake success.
    return { mode: ExecuteMode.LIVE, plan, broadcast: false, txHashes: undefined };
  }
  return { mode: ExecuteMode.LIVE, plan, broadcast: true, txHashes };
}
