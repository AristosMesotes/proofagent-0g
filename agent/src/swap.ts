/**
 * The swap leg -- `swap(req)`: an exact-input single-hop Uniswap-V3 swap via Oku, mandate-gated.
 *
 * Design WOW Feature 1 (Swap -- Oku/Uniswap-V3): the full proven envelope around ONE swap action:
 *
 *   (1) `QuoterV2.quoteExactInputSingle(...)` staticCall -> `expectedOut`   (read the quote ON-CHAIN)
 *   (2) `amountOutMinimum = expectedOut - expectedOut*slippageBps/10000`     (exact-integer floor)
 *   (3) the MANDATE GATE pre-swap: `checkTransfer(agent, tokenIn, amountIn)` MUST clear, or the leg is
 *       refused PRE-BROADCAST (the cap is a kill-switch -- design SS5: "a failing mandate verdict means
 *       the agent does not execute, enforced before any broadcast")
 *   (4) `tokenIn.approve(SwapRouter02, amountIn)`                            (let the router pull input)
 *   (5) `SwapRouter02.exactInputSingle({...})`                              (the swap; 7-field tuple)
 *
 * design WOW Feature 1 ("wrapped by the proofs"): "before `exactInputSingle`, `checkTransfer` must clear
 * `tokenIn`/`amountIn`/recipient (asset allowlist, per-trade cap, expiry) or the leg is refused
 * *pre-broadcast*; the Uniswap `amountOutMinimum` floor is the protocol-native complement (input
 * mandate-bounded, output slippage-bounded, both on-chain). After broadcast the verifier reads 0G
 * directly, decodes the `Swap` event + realized deltas, and mints settled / hollow / mismatch /
 * unverified." This module is steps (1)-(5); the verifier's SWAP extension (`verifier/src/swap.rs`) is
 * the after-broadcast verdict.
 *
 * ## This is the COMPOSING leg, not a re-implementation
 *
 * The pure swap codecs (`approve` / `exactInputSingle` / the `QuoterV2` quote encoder), the exact-integer
 * `slippageFloor`, the `SwapPlan` shape, and the dry-run/live `execute` boundary already live in
 * `execute.ts`; the mandate `checkTransfer` gate lives in `mandate.ts`. This module COMPOSES them into
 * the one design-WOW-Feature-1 path: read the quote on-chain, gate the spend pre-swap, then plan/execute
 * the swap. It adds the two on-chain READS the bare executor does not do -- the `QuoterV2` quote
 * (step 1) and the `checkTransfer` gate (step 3) -- through the SAME `EthCallTransport` seam the gate
 * already uses, so the whole leg shares one narrow read boundary.
 *
 * ## The kill-switch is structural + fail-CLOSED (design SS3 principle 3 + SS5)
 *
 * The swap is BUILT only after the mandate gate returns a definitive on-chain `allowed: true`. Every
 * other gate outcome -- a `false` verdict, an unreachable RPC, a malformed reply, or no transport wired
 * -- yields a refused leg ([`SwapOutcome.BLOCKED_BY_MANDATE`]); `exactInputSingle` is never planned, so
 * no broadcast can occur. There is no code path in which an unread/failed gate lets the swap proceed.
 *
 * ## MAINNET-only -> the live broadcast is OPERATOR-GATED (design SS8)
 *
 * Oku/Uniswap-V3 is MAINNET-only on 0G (no 16602 deployment), so the live swap moves REAL value and is
 * OPERATOR-GATED. This module BUILDS the leg end to end (quote read + gate + plan), but its `execute`
 * boundary defaults to [`SwapExecMode.DRY_RUN`] -- it broadcasts NOTHING, signs NOTHING. A live send
 * requires an explicit `mode: "LIVE"` AND a wired broadcaster (a funded demo-wallet signer), which fails
 * CLOSED with a loud not-wired error otherwise -- it NEVER fabricates a tx hash or a "settled" result
 * (design SS3 principle 3). The exact operator command to run the live swap is documented in
 * `demo/EVIDENCE_SWAP.md`.
 *
 * ## Default build needs no network (design SS6, offline-by-default)
 *
 * Without a transport/broadcaster wired, [`swap`] performs NO network access and signs nothing: it
 * fails CLOSED at the quote read (no transport) or the gate, returning a loud refused leg. The quote
 * read and the gate are the only network legs, both opt-in via the supplied transport. So `tsc` and the
 * default path are fully offline.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * `amountIn`, the quoted `expectedOut`, and the derived `amountOutMinimum` are `bigint`s in MINOR units
 * -- never `number`, never a float. The slippage floor is exact-integer (`execute.ts`'s `slippageFloor`).
 * There is no floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The contract addresses are the public
 * 0G mainnet (16661) Oku/Uniswap-V3 values from the design appendix / WOW Feature 1, supplied via config.
 */

import {
  planSwap,
  execute,
  ExecuteMode,
  OG_SWAP_DEFAULTS,
  DEFAULT_FEE_TIER,
  encodeQuoteExactInputSingle,
  ExecuteError,
  type SwapPlan,
  type SwapConfig,
  type SwapBroadcaster,
  type ExecuteResult,
} from "./execute.js";
import {
  checkMandate,
  type MandateConfig,
  type MandateVerdict,
  type EthCallTransport,
  MandateError,
} from "./mandate.js";

/**
 * The whole-percent basis for slippage math (1 bps = 1/100 of a percent), so `BPS_DENOMINATOR = 10000`.
 * Re-exported alias of `execute.ts`'s constant for callers of this leg -- exact-integer, no float.
 */
export const BPS_DENOMINATOR = 10_000 as const;

/** A loud failure on the swap leg (design SS3 principle 3 -- degrade loudly, never fabricate). */
export class SwapError extends Error {
  public override readonly name = "SwapError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SwapError.prototype);
  }
}

/**
 * How the swap leg is allowed to act once the gate clears (design SS8 -- claim only what's live).
 *
 * `DRY_RUN` (default, the only path this build runs): plan the swap, broadcast NOTHING. `LIVE`:
 * operator-gated -- needs an explicit opt-in AND a wired broadcaster (a funded demo-wallet signer);
 * Oku/Uniswap-V3 is mainnet-only on 0G, so a live swap moves REAL value. Passing `LIVE` without a
 * broadcaster fails CLOSED with a loud not-wired reason -- it never fabricates a hash.
 */
export const SwapExecMode = {
  /** Plan-only: build the swap, broadcast nothing (the default; the only path this build runs). */
  DRY_RUN: "DRY_RUN",
  /** Operator-gated live broadcast (needs a funded wallet + wired signer; mainnet-only). */
  LIVE: "LIVE",
} as const;

/** The swap execution mode -- `DRY_RUN` (default, offline) or `LIVE` (operator-gated broadcast). */
export type SwapExecMode = (typeof SwapExecMode)[keyof typeof SwapExecMode];

/**
 * Where the swap leg ended -- a strict, ordered progression mirroring design WOW Feature 1's path.
 * A run advances stage by stage and stops at the FIRST step that does not pass.
 */
export const SwapOutcome = {
  /** The on-chain quote read failed (no transport / RPC error / malformed reply) -- nothing downstream ran. */
  QUOTE_FAILED: "quote_failed",
  /** The mandate gate did not return `allowed: true` -- the kill-switch STOPPED the leg pre-swap. */
  BLOCKED_BY_MANDATE: "blocked_by_mandate",
  /** Quote + gate passed; the swap was PLANNED (dry-run -- NOTHING broadcast). */
  PLANNED_DRY_RUN: "planned_dry_run",
  /** A live broadcast actually sent the swap (operator-gated). */
  BROADCAST_LIVE: "broadcast_live",
} as const;

/** The furthest step the swap leg reached on a run (design WOW Feature 1 ordering). */
export type SwapOutcome = (typeof SwapOutcome)[keyof typeof SwapOutcome];

/**
 * The swap to perform -- the agent's proposal for the swap leg. The quote and the floor are derived
 * ON-CHAIN by this leg (the agent does not supply `expectedOut`; that is the QuoterV2 read).
 */
export interface SwapLegRequest {
  /** The agent address (must equal the registry's mandated agent -- checked by the gate). */
  readonly agent: string;
  /** The asset being sold (the mandate-bounded, gate-checked input token). */
  readonly tokenIn: string;
  /** The asset being bought. */
  readonly tokenOut: string;
  /** The pool fee tier (hundredths of a bip). Defaults to [`DEFAULT_FEE_TIER`] if omitted. */
  readonly fee?: number;
  /** Who receives `tokenOut` (the demo wallet). */
  readonly recipient: string;
  /** Exact input, MINOR units, `bigint` -- the amount the mandate caps + the router pulls. */
  readonly amountIn: bigint;
  /** Slippage tolerance in bps (`0..=10000`). The floor = `expectedOut - expectedOut*bps/10000`. */
  readonly slippageBps: number;
}

/** The public 0G swap venue: the router + the quoter addresses (defaults = [`OG_SWAP_DEFAULTS`]). */
export interface SwapVenueConfig {
  /** `SwapRouter02` (the `approve` spender + the `exactInputSingle` `to`). */
  readonly swapRouter02: string;
  /** `QuoterV2` (the `quoteExactInputSingle` staticCall `to`). */
  readonly quoterV2: string;
}

/** The default public 0G mainnet (16661) venue from design WOW Feature 1. */
export const OG_SWAP_VENUE: SwapVenueConfig = {
  swapRouter02: OG_SWAP_DEFAULTS.swapRouter02,
  quoterV2: OG_SWAP_DEFAULTS.quoterV2,
};

/**
 * The honest, structured account of one swap-leg run (design SS3 principle 3). It states exactly how
 * far the leg got ([`outcome`]) and carries each completed step's output. Nothing here is ever a
 * fabricated success: a blocked gate yields `plan: undefined`; a dry-run yields
 * `broadcast: false` / `txHashes: undefined` (no live send); only a real live send yields a hash.
 */
export interface SwapLegResult {
  /** The furthest step the leg reached (design WOW Feature 1 ordering). */
  readonly outcome: SwapOutcome;
  /** The on-chain `QuoterV2` quote `expectedOut` (minor units), present once the quote read succeeded. */
  readonly expectedOut: bigint | undefined;
  /** The derived on-chain slippage floor `amountOutMinimum` (minor units), present once quoted. */
  readonly amountOutMinimum: bigint | undefined;
  /** The mandate gate's verdict -- the kill-switch decision (the rails proof), present once gated. */
  readonly mandate: MandateVerdict | undefined;
  /**
   * The planned swap (the two ordered calls + the floor), present iff the gate ALLOWED the swap. In a
   * dry-run this is the inspectable plan with `broadcast: false`; `undefined` iff the gate blocked.
   */
  readonly plan: SwapPlan | undefined;
  /** `true` iff a live broadcaster actually sent the swap; `false` for a dry-run (nothing sent). */
  readonly broadcast: boolean;
  /** The real tx hash(es) iff `broadcast === true`; `undefined` for a dry-run. NEVER fabricated. */
  readonly txHashes: readonly string[] | undefined;
  /** A human-readable, journal-only note explaining how the run ended. Never the source of truth. */
  readonly note: string;
}

// ----------------------------------------------------------------------------------------------
// The QuoterV2 quote read -- a staticCall through the same EthCallTransport seam the gate uses.
// ----------------------------------------------------------------------------------------------

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Decode the first 32-byte word of a `QuoterV2.quoteExactInputSingle` staticCall return as the
 * `amountOut` (`uint256`). The full return is `(uint256 amountOut, uint160 sqrtPriceX96After,
 * uint32 initializedTicksCrossed, uint256 gasEstimate)` -- four words; `amountOut` is word 0.
 *
 * A reply that is not at least one full 32-byte word is a loud [`SwapError`] (a malformed quote must
 * never be coerced into a fabricated `expectedOut`). Returns the quoted output as a `bigint`.
 */
export function decodeQuoteAmountOut(raw: string): bigint {
  if (typeof raw !== "string") {
    throw new SwapError("quote staticCall result must be a hex string");
  }
  const hex = raw.trim().toLowerCase();
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 64 || !/^[0-9a-f]*$/.test(body)) {
    throw new SwapError(`malformed quoteExactInputSingle return (need >= one 32-byte word): ${raw}`);
  }
  // word 0 = amountOut (uint256). bigint parse is exact-integer (design SS3 principle 5).
  return BigInt("0x" + body.slice(0, 64));
}

/**
 * Read the `QuoterV2` quote for a swap ON-CHAIN (design WOW Feature 1 step 1) -- a staticCall through
 * the supplied `EthCallTransport`. Returns the quoted `amountOut` (minor units) as a `bigint`.
 *
 * Fails CLOSED with a loud [`SwapError`] if no transport is wired, the quoter address is invalid, the
 * staticCall throws (RPC error), or the reply is malformed -- it never fabricates a quote. The agent
 * does NOT supply `expectedOut`; this read is the source of it.
 *
 * @param req        The swap (tokenIn/tokenOut/fee/amountIn -- the quote inputs).
 * @param venue      The public venue (the `quoterV2` address; default [`OG_SWAP_VENUE`]).
 * @param transport  The `eth_call` transport (the same seam the mandate gate uses). REQUIRED for the read.
 */
export async function quoteExpectedOut(
  req: SwapLegRequest,
  venue: SwapVenueConfig,
  transport: EthCallTransport,
): Promise<bigint> {
  if (transport === undefined || typeof transport.ethCall !== "function") {
    throw new SwapError("SWAP_QUOTE_NOT_WIRED: no eth_call transport supplied; cannot read the quote");
  }
  if (typeof venue.quoterV2 !== "string" || !ADDRESS_RE.test(venue.quoterV2.trim())) {
    throw new SwapError(`SWAP_QUOTE_NOT_CONFIGURED: quoterV2 address invalid: ${String(venue.quoterV2)}`);
  }
  const fee = req.fee ?? DEFAULT_FEE_TIER;
  // encodeQuoteExactInputSingle validates the addresses/amount/fee loudly (execute.ts).
  const data = encodeQuoteExactInputSingle(req.tokenIn, req.tokenOut, req.amountIn, fee, 0n);
  let raw: string;
  try {
    raw = await transport.ethCall(venue.quoterV2.trim().toLowerCase(), data);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SwapError(`SWAP_QUOTE_TRANSPORT_ERROR: ${detail}`);
  }
  return decodeQuoteAmountOut(raw);
}

// ----------------------------------------------------------------------------------------------
// swap -- the leg. quote -> mandate-gate -> plan -> execute (dry-run default; live operator-gated).
// ----------------------------------------------------------------------------------------------

/**
 * Perform the mandate-gated swap leg (design WOW Feature 1): quote on-chain, gate the spend pre-swap,
 * then plan/execute the swap. The kill-switch ordering is structural -- the swap is BUILT only after
 * the gate returns a definitive on-chain `allowed: true`.
 *
 * Steps:
 *   1. **quote** -- [`quoteExpectedOut`] reads `QuoterV2.quoteExactInputSingle` on-chain. A failed read
 *      is a loud refused leg (`outcome = QUOTE_FAILED`); nothing downstream runs.
 *   2. **mandate-gate** -- [`checkMandate`] performs the pre-swap `eth_call` `checkTransfer(agent,
 *      tokenIn, amountIn)`. If it does NOT return `allowed: true`, the leg STOPS (`outcome =
 *      BLOCKED_BY_MANDATE`); the swap is never planned, so no broadcast can occur.
 *   3. **plan** -- the floor is derived from the quote + slippage; [`planSwap`] builds the two ordered
 *      calls (`approve` then `exactInputSingle`).
 *   4. **execute** -- [`execute`] in `DRY_RUN` (default) broadcasts NOTHING (`outcome =
 *      PLANNED_DRY_RUN`). `LIVE` is operator-gated and needs a wired broadcaster (mainnet-only swap).
 *
 * The function NEVER throws for an operational leg failure (a failed quote, a blocked gate) -- those are
 * reported in the returned [`SwapLegResult`] so the caller always gets a definitive account. It DOES
 * throw [`SwapError`] for a programmer error in the request (a malformed address/amount/fee/slippage) or
 * a `LIVE`-not-wired failure -- loud, before any broadcast.
 *
 * @param req         The swap proposal (agent, tokens, amountIn, slippage).
 * @param config      The mandate registry (gate) + the public swap venue (router/quoter).
 * @param mode        `DRY_RUN` (default) or `LIVE` (operator-gated; needs a broadcaster).
 * @param transport   The `eth_call` transport for the quote read + the gate. Omit for the offline path
 *                    (the leg then fails CLOSED at the quote read -- design SS6).
 * @param broadcaster OPTIONAL live broadcaster. Used ONLY in `LIVE`. Omit it for the dry-run.
 * @throws {SwapError} on a malformed request or a `LIVE`-not-wired failure (loud, before any broadcast).
 */
export async function swap(
  req: SwapLegRequest,
  config: { readonly mandate: MandateConfig; readonly venue?: SwapVenueConfig },
  mode: SwapExecMode = SwapExecMode.DRY_RUN,
  transport?: EthCallTransport,
  broadcaster?: SwapBroadcaster,
): Promise<SwapLegResult> {
  // Validate the request shape up front (a malformed address/amount/fee is a loud programmer error,
  // distinct from an operational failure). `planSwap` does the full validation, but we need the quote
  // first; encodeQuoteExactInputSingle inside quoteExpectedOut validates the quote inputs loudly.
  if (typeof req.amountIn !== "bigint" || req.amountIn <= 0n) {
    throw new SwapError(`amountIn must be a positive bigint in minor units, got ${String(req.amountIn)}`);
  }

  const venue = config.venue ?? OG_SWAP_VENUE;

  // --- (1) quote (read expectedOut ON-CHAIN; design WOW Feature 1 step 1) ----------------------
  // No transport => offline => the quote cannot be read => a loud refused leg (fail-closed, SS6).
  if (transport === undefined) {
    return {
      outcome: SwapOutcome.QUOTE_FAILED,
      expectedOut: undefined,
      amountOutMinimum: undefined,
      mandate: undefined,
      plan: undefined,
      broadcast: false,
      txHashes: undefined,
      note:
        "SWAP_QUOTE_NOT_WIRED: no eth_call transport supplied -- the on-chain QuoterV2 quote could not " +
        "be read, so the swap leg is refused (offline-by-default; wire a transport to quote + gate).",
    };
  }
  let expectedOut: bigint;
  try {
    expectedOut = await quoteExpectedOut(req, venue, transport);
  } catch (err) {
    if (err instanceof ExecuteError) {
      // A malformed quote input (bad address/amount/fee) -- loud, before any gate or broadcast.
      throw new SwapError(`swap quote rejected the request: ${err.message}`);
    }
    if (err instanceof SwapError) {
      // A transport / malformed-reply failure -- a refused leg, not a throw (the caller gets the account).
      return {
        outcome: SwapOutcome.QUOTE_FAILED,
        expectedOut: undefined,
        amountOutMinimum: undefined,
        mandate: undefined,
        plan: undefined,
        broadcast: false,
        txHashes: undefined,
        note: `quote read failed: ${err.message} -- the swap leg is refused (never a fabricated quote).`,
      };
    }
    throw err;
  }

  // --- (2) mandate-gate (the kill-switch, PRE-SWAP -- design WOW Feature 1 step 3) --------------
  // checkTransfer(agent, tokenIn, amountIn). A malformed spend is a loud SwapError; an operational
  // failure (no transport for the gate, RPC error, over-cap) is a fail-closed verdict that STOPS the leg.
  let mandate: MandateVerdict;
  try {
    mandate = await checkMandate(
      { agent: req.agent, token: req.tokenIn, amount: req.amountIn },
      config.mandate,
      transport,
    );
  } catch (err) {
    if (err instanceof MandateError) {
      throw new SwapError(`mandate gate rejected the spend request: ${err.message}`);
    }
    throw err;
  }

  if (!mandate.allowed) {
    // THE KILL-SWITCH (design SS5 / WOW Feature 1): a non-allowed gate STOPS the leg PRE-SWAP. The swap
    // is never planned, so no broadcast can occur. This is the structural "refused *pre-broadcast*".
    return {
      outcome: SwapOutcome.BLOCKED_BY_MANDATE,
      expectedOut,
      amountOutMinimum: undefined,
      mandate,
      plan: undefined,
      broadcast: false,
      txHashes: undefined,
      note:
        `mandate gate BLOCKED the swap (reason: ${String(mandate.reason)}; verified=${String(mandate.verified)}) ` +
        `-- the leg did NOT plan or broadcast the swap (the cap is a kill-switch, enforced pre-broadcast).`,
    };
  }

  // --- (3) plan (derive the floor from the quote; build approve + exactInputSingle) ------------
  // The gate ALLOWED the spend. Build the swap; planSwap derives amountOutMinimum from expectedOut +
  // slippage (exact-integer floor) and the two ordered calls. A malformed field throws loudly here.
  const swapConfig: SwapConfig = { swapRouter02: venue.swapRouter02 };
  let plan: SwapPlan;
  try {
    plan = planSwap(
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        ...(req.fee !== undefined ? { fee: req.fee } : {}),
        recipient: req.recipient,
        amountIn: req.amountIn,
        expectedOut,
        slippageBps: req.slippageBps,
      },
      swapConfig,
    );
  } catch (err) {
    if (err instanceof ExecuteError) {
      throw new SwapError(`swap planning failed: ${err.message}`);
    }
    throw err;
  }

  // --- (4) execute (dry-run default; LIVE operator-gated -- mainnet-only swap, design SS8) ------
  let executed: ExecuteResult;
  try {
    const execMode = mode === SwapExecMode.LIVE ? ExecuteMode.LIVE : ExecuteMode.DRY_RUN;
    executed = await execute(
      {
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        ...(req.fee !== undefined ? { fee: req.fee } : {}),
        recipient: req.recipient,
        amountIn: req.amountIn,
        expectedOut,
        slippageBps: req.slippageBps,
      },
      swapConfig,
      execMode,
      broadcaster,
    );
  } catch (err) {
    if (err instanceof ExecuteError) {
      // A LIVE-not-wired failure (or a malformed swap) -- loud, never a fabricated broadcast (SS8).
      throw new SwapError(`swap execute failed: ${err.message}`);
    }
    throw err;
  }

  if (executed.broadcast && executed.txHashes !== undefined && executed.txHashes.length > 0) {
    // A live broadcast actually sent (operator-gated). The verifier's SWAP extension stamps the verdict.
    return {
      outcome: SwapOutcome.BROADCAST_LIVE,
      expectedOut,
      amountOutMinimum: plan.amountOutMinimum,
      mandate,
      plan,
      broadcast: true,
      txHashes: executed.txHashes,
      note:
        `live swap broadcast (${executed.txHashes.length} tx): gate ALLOWED, quote=${expectedOut}, ` +
        `floor=${plan.amountOutMinimum}. The verifier's SWAP extension reads the Swap event + mints the ` +
        `verdict (this leg NEVER claims settled -- design SS3 principle 2/3).`,
    };
  }

  // The dry-run (or a live send that reported no hash): NOTHING was broadcast.
  return {
    outcome: SwapOutcome.PLANNED_DRY_RUN,
    expectedOut,
    amountOutMinimum: plan.amountOutMinimum,
    mandate,
    plan,
    broadcast: false,
    txHashes: undefined,
    note:
      `dry-run complete: gate ALLOWED, quote=${expectedOut}, floor=${plan.amountOutMinimum}, swap ` +
      `PLANNED (${plan.calls.length} calls), broadcast NOTHING (mode=${executed.mode}) -- mainnet-only ` +
      `swap is operator-gated; nothing was sent (design SS8).`,
  };
}
