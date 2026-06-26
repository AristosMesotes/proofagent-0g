/**
 * The loop -- `runLoop(query)`: `plan -> mandate-gate -> execute(dry-run) -> verify` (design SS5).
 *
 * Design SS4 (architecture, `agent/loop.ts`): "plan -> mandate-gate -> execute -> verify". Design SS5
 * (the loop) is the canonical spec for this module:
 *
 * ```text
 * plan ──► mandate-gate ──► execute ──► verify
 *  │            │              │           │
 *  LLM      eth_call       capped swap   independent
 *  plan     checkTransfer   on 0G        chain read → verdict
 *           (block if over cap, pre-broadcast)
 * ```
 *
 * and its load-bearing rule: "A failing mandate verdict means **the agent does not execute** -- the cap
 * is a kill-switch, enforced before any broadcast. A failing settlement read means **`UNVERIFIED`**,
 * surfaced loudly -- never a fabricated success."
 *
 * This module is the thin orchestrator that wires the three already-built legs ([`plan`] from
 * `plan.ts`, [`checkMandate`] from `mandate.ts`, [`execute`] from `execute.ts`) plus the verify leg --
 * which invokes the INDEPENDENT Rust verifier binary (design SS2: "an independent Rust verifier reads
 * 0G via raw JSON-RPC and stamps each trade settled / hollow / mismatch / unverified -- it never trusts
 * the UI"). The loop itself mints no verdict of any kind; it only carries each leg's honest output.
 *
 * ## The dry-run is the only path this build runs (design SS8 -- claim only what's live)
 *
 * The end-to-end loop completes with **NO live settlement**. The execute leg runs in
 * [`ExecuteMode.DRY_RUN`] (the default), so NOTHING is signed and NOTHING is broadcast -- the loop
 * produces an inspectable [`SwapPlan`], never a real tx hash. Because nothing settled on-chain, there is
 * no real transaction to verify, so the verify leg in a dry-run is reported HONESTLY as "skipped -- no
 * broadcast to verify" (design SS3 principle 3: never fabricate). The loop NEVER manufactures a tx hash
 * to feed the verifier, and the verifier itself, pointed at any off-record hash, stamps `unverified`
 * (the NEG case, design SS2) -- so even a wired verify leg cannot mint a fake `settled`.
 *
 * ## The kill-switch ordering is structural (design SS5)
 *
 * The legs run in strict order and the gate is a hard stop: if [`checkMandate`] does not return a
 * definitive on-chain `allowed: true`, the loop STOPS before execute -- `execute` is never called, so
 * no broadcast can occur. This mirrors the design's "block if over cap, pre-broadcast": the cap is
 * enforced *before* the executor is even reached, not merely checked alongside it.
 *
 * ## Verdict monopoly (design SS3 principle 2)
 *
 * Only the verifier mints a settlement verdict (`settled / hollow / mismatch / unverified`). The loop
 * carries the verifier's stamp as an opaque string ([`SettlementVerdict`]); it never constructs one. The
 * mandate `allowed` flag is a *spend* decision (the rails proof), not a settlement verdict -- the two
 * are kept distinct in [`LoopResult`].
 *
 * ## Two-source truth at the verify seam (design SS3 principle 1)
 *
 * The verify leg goes through ONE narrow seam -- [`SettlementVerifier`] -- exactly as the mandate gate
 * uses [`EthCallTransport`] and the executor uses `SwapBroadcaster`. The default [`binaryVerifier`]
 * shells out to the independent Rust verifier binary; an offline test double satisfies the same seam, so
 * a recorded verdict and a real one are interchangeable and the loop's logic never changes.
 *
 * ## Default build needs no network / no child process (design SS6, offline-by-default)
 *
 * [`runLoop`] in its default (dry-run, no verifier wired) path performs NO network access, signs
 * nothing, and spawns NO child process -- it is pure orchestration over the offline legs. The verify
 * leg only shells to the verifier binary when a [`SettlementVerifier`] is explicitly supplied AND there
 * is a real broadcast hash to verify (i.e. a LIVE run that actually sent). So `tsc` and the default loop
 * are fully offline; the child-process verify leg is opt-in, supplied by the operator's config.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The verifier binary name/args are
 * the public `verifier verify-tx <hash>` command surface from the design (SS9); the binary path is
 * supplied via config (defaulting to a relative `verifier` on PATH), never a baked-in private path.
 */

import { plan, type Plan, type Allocation, PlanError } from "./plan.js";
import {
  checkMandate,
  type MandateConfig,
  type MandateVerdict,
  type EthCallTransport,
  MandateError,
} from "./mandate.js";
import {
  execute,
  ExecuteMode,
  type SwapRequest,
  type SwapConfig,
  type ExecuteResult,
  type SwapBroadcaster,
  OG_SWAP_DEFAULTS,
  ExecuteError,
} from "./execute.js";

/**
 * The canonical settlement-verdict alphabet (design SS2): the four stamps the INDEPENDENT verifier may
 * mint. These mirror the Rust `Verdict::canonical_string()` exactly (`verifier/src/verdict.rs`). The
 * loop never constructs one of these (the verdict monopoly, design SS3 principle 2) -- it only carries
 * what the verifier printed. `"skipped"` below is NOT one of these; it is the loop's own honest marker
 * that the verify leg did not run (a dry-run has no broadcast to verify), kept deliberately distinct so
 * a skipped verify can NEVER be read as a `settled`.
 */
export const SETTLEMENT_VERDICT = {
  /** The trade settled on-chain exactly as claimed (the only success stamp). */
  SETTLED: "settled",
  /** The tx exists/succeeded but the expected economic effect is absent. */
  HOLLOW: "hollow",
  /** The tx settled but the observed amount disagrees with the claim beyond tolerance. */
  MISMATCH: "mismatch",
  /** The chain could not confirm the claim (not found / unreadable / off-record) -- the NEG case. */
  UNVERIFIED: "unverified",
} as const;

/** A settlement verdict string minted by the independent verifier (design SS2 alphabet). */
export type SettlementVerdict = (typeof SETTLEMENT_VERDICT)[keyof typeof SETTLEMENT_VERDICT];

/** The full set of valid verdict strings, for validating what the verifier printed. */
const VALID_VERDICTS: ReadonlySet<string> = new Set<string>(Object.values(SETTLEMENT_VERDICT));

/**
 * The FILL-PROOF ORACLE decision (the LI.FI-Intents frontier): RELEASE the solver's funds, or BLOCK.
 * Mirrors the Rust `FillDecision::canonical_string()` exactly (`verifier/src/fillproof.rs`). The loop
 * never constructs one (the verdict monopoly, design SS3 principle 2) -- it only carries what the
 * independent fill-proof oracle returned. RELEASE only on a chain-confirmed `settled` fill; a `hollow` /
 * `mismatch` / `unverified` fill is BLOCK (fail-closed -- never a fabricated release).
 */
export const FILL_DECISION = {
  /** The chain confirmed a within-band fill -> release the solver's funds. */
  RELEASE: "RELEASE",
  /** The fill is hollow / out-of-band / unreadable -> block release (fail-closed). */
  BLOCK: "BLOCK",
} as const;

/** A fill-proof oracle decision string minted by the independent verifier (`fillproof.rs`). */
export type FillDecision = (typeof FILL_DECISION)[keyof typeof FILL_DECISION];

/** The valid decision strings, for validating what the fill-proof oracle printed. */
const VALID_FILL_DECISIONS: ReadonlySet<string> = new Set<string>(Object.values(FILL_DECISION));

/**
 * The loud failure of the loop itself (design SS3 principle 3 -- degrade loudly, never fabricate).
 * Thrown only for a programmer error in the loop's own *inputs* (a malformed loop config / swap shape
 * the planner produced). An operational failure of a *leg* (a blocked gate, an unreadable verifier) is
 * NOT thrown -- it is reported in the [`LoopResult`] as the leg honestly stopping, so the caller always
 * gets a definitive account of how far the loop got.
 */
export class LoopError extends Error {
  public override readonly name = "LoopError";
  public constructor(message: string) {
    super(message);
    // Keep a correct prototype chain under transpilation targets that need it.
    Object.setPrototypeOf(this, LoopError.prototype);
  }
}

/**
 * Where the loop stopped -- a strict, ordered progression that mirrors design SS5
 * (`plan -> mandate-gate -> execute -> verify`). A run advances stage by stage and stops at the FIRST
 * leg that does not pass; the stage names the furthest leg that completed (or the gate that blocked).
 */
export const LOOP_STAGE = {
  /** Planning failed loudly (an unplannable query) -- nothing downstream ran. */
  PLAN_FAILED: "plan_failed",
  /** The mandate gate did not return `allowed: true` -- the kill-switch STOPPED the loop pre-execute. */
  BLOCKED_BY_MANDATE: "blocked_by_mandate",
  /** Plan + gate passed; the executor produced a dry-run plan (NOTHING broadcast). */
  EXECUTED_DRY_RUN: "executed_dry_run",
  /** A live broadcast actually sent AND the verify leg ran -> a settlement verdict is attached. */
  VERIFIED: "verified",
  /**
   * The swap tx settled, but the wired FILL-PROOF ORACLE independently read the delivery as NOT a
   * within-band fill (hollow / mismatch / unreadable) and returned BLOCK -- the loop refuses to release
   * on an unproven fill (the LI.FI-Intents frontier, the honest way; design SS3 principle 3). This stage
   * is reachable ONLY when a [`FillProofOracle`] is wired and the settlement was `settled`.
   */
  BLOCKED_BY_FILL_PROOF: "blocked_by_fill_proof",
} as const;

/** The furthest leg the loop reached on a run (design SS5 ordering). */
export type LoopStage = (typeof LOOP_STAGE)[keyof typeof LOOP_STAGE];

/**
 * The verify leg's input -- a concrete on-chain transaction hash to point the INDEPENDENT verifier at,
 * exactly as the design's `verifier verify-tx <hash>` (SS9). The loop only ever has a real hash on a
 * LIVE run that actually broadcast; a dry-run has none (it broadcasts nothing), so the verify leg is
 * honestly skipped (it NEVER fabricates a hash -- design SS3 principle 3).
 */
export interface SettlementVerifier {
  /**
   * Verify one transaction hash by invoking the independent verifier and return its minted verdict
   * string (one of [`SettlementVerdict`]). An implementation shells to the Rust `verifier verify-tx`
   * binary (the default [`binaryVerifier`]) or replays a recorded verdict (a test double). It MUST
   * return only a verdict the verifier actually minted -- never a fabricated `settled`.
   *
   * @param txHash the broadcast transaction hash to verify.
   * @returns the verifier's verdict string.
   * @throws on a usage failure (a malformed hash, or the verifier binary being unreadable) -- the loop
   *   maps a throw to a loud, honest "could not verify" (it never coerces a throw into a `settled`).
   */
  verify(txHash: string): Promise<SettlementVerdict>;
}

/**
 * The FILL-PROOF ORACLE seam (the LI.FI-Intents frontier) -- the verifier's INDEPENDENT proof that a
 * solver's claimed delivery (the *fill*) actually landed on-chain, before any funds are RELEASED.
 *
 * Two-source truth (design SS3 principle 1): the solver's claimed fill amount is only ever one input; the
 * oracle reads the destination fill ITSELF (by tx hash) and returns a [`FillDecision`]. RELEASE only on a
 * chain-confirmed within-band fill; a `hollow` fill (the delivery the chain says never happened) returns
 * BLOCK -- exactly where a hash-only oracle would have paid. An implementation shells to the Rust
 * `verifier fill-proof --fill-tx <hash> --claimed <n>` binary ([`binaryFillProof`]) or replays a recorded
 * decision (a test double). It MUST return only a decision the oracle actually minted -- never a
 * fabricated RELEASE.
 */
export interface FillProofOracle {
  /**
   * Prove a solver's fill: read the destination fill `fillTxHash` independently and return RELEASE or
   * BLOCK against the `claimedFill` (minor units, `bigint`). A hollow / out-of-band / unreadable fill is
   * BLOCK (fail-closed). Throws on a usage failure (a malformed hash / unreadable binary) -- which the
   * loop maps to a loud "could not prove the fill", never coerced into a RELEASE.
   */
  proveFill(fillTxHash: string, claimedFill: bigint): Promise<FillDecision>;
}

/**
 * The agent identity + spend the mandate gate checks, plus the swap the executor would run. The loop
 * derives the concrete spend (token, amount) for a given allocation from this, so the SAME plan can be
 * gated and (in a live run) executed. All amounts are `bigint` MINOR units (exact-integer; design SS3
 * principle 5).
 */
export interface LoopSpend {
  /** The agent address proposing the spend (must equal the registry's mandated agent). */
  readonly agent: string;
  /** The asset the agent would SELL (the mandate-bounded, gate-checked input token). */
  readonly tokenIn: string;
  /** The asset the agent would BUY. */
  readonly tokenOut: string;
  /** Who receives `tokenOut` (the demo wallet). */
  readonly recipient: string;
  /** The exact input amount in `tokenIn` MINOR units (`bigint`) -- the amount the gate caps. */
  readonly amountIn: bigint;
  /** The `QuoterV2` quote for the swap in `tokenOut` MINOR units (`bigint`) -- drives the floor. */
  readonly expectedOut: bigint;
  /** Slippage tolerance in basis points (`0..=10000`). */
  readonly slippageBps: number;
}

/**
 * Everything the loop needs to run one query end to end. Each sub-config is the SAME config the
 * corresponding leg already accepts, so the loop wires them without reinterpreting any of them.
 */
export interface LoopConfig {
  /** The concrete spend/swap (agent, tokens, amounts) the gate checks and the executor would run. */
  readonly spend: LoopSpend;
  /** The mandate registry to gate against (from operator config; `""` => fail-closed, never allow). */
  readonly mandate: MandateConfig;
  /** The public 0G swap-venue config (router address). Defaults to the public [`OG_SWAP_DEFAULTS`]. */
  readonly swap?: SwapConfig;
  /**
   * The execution mode. DEFAULT and the ONLY path this build exercises: [`ExecuteMode.DRY_RUN`] --
   * broadcasts NOTHING (design SS8). `LIVE` is operator-gated and needs a wired broadcaster.
   */
  readonly mode?: ExecuteMode;
}

/**
 * The honest, structured account of one loop run (design SS3 principle 3). It states exactly how far
 * the loop got ([`stage`]) and carries each completed leg's output. Nothing here is ever a fabricated
 * success: a blocked gate yields `executed: undefined`; a dry-run yields `settlement: undefined` (no
 * broadcast to verify); only a real live verify yields a `settlement` verdict.
 */
export interface LoopResult {
  /** The furthest leg the loop reached (design SS5 ordering). */
  readonly stage: LoopStage;
  /** The plan produced by the plan leg (always present once planning succeeds). */
  readonly plan: Plan;
  /** The mandate gate's verdict -- the kill-switch decision (the rails proof). */
  readonly mandate: MandateVerdict;
  /**
   * The executor's result, present iff the gate ALLOWED execution and the executor ran. In a dry-run
   * this carries the inspectable [`SwapPlan`] with `broadcast: false` / `txHashes: undefined` -- NOTHING
   * was sent. `undefined` iff the gate blocked the loop before execute (the kill-switch).
   */
  readonly executed: ExecuteResult | undefined;
  /**
   * The settlement verdict from the INDEPENDENT verifier, present ONLY when a live broadcast actually
   * sent a tx AND the verify leg ran against it. `undefined` for a dry-run (nothing was broadcast, so
   * there is nothing to verify) -- a deliberately distinct value from any verdict string, so a skipped
   * verify can NEVER be mistaken for a `settled` (design SS3 principle 3).
   */
  readonly settlement: SettlementVerdict | undefined;
  /**
   * A human-readable, journal-only note for the UI/log explaining how the run ended (e.g. WHY the gate
   * blocked, or that the dry-run completed with no settlement). Never the source of truth -- the typed
   * fields above are (design SS3 principle 1). Never carries a verdict it did not actually earn.
   */
  readonly note: string;
}

// ----------------------------------------------------------------------------------------------
// runLoop -- the orchestrator. plan -> mandate-gate -> execute(dry-run) -> verify. Offline by default.
// ----------------------------------------------------------------------------------------------

/**
 * Run the agent loop for one natural-language `query` (design SS4/SS5):
 * `plan -> mandate-gate -> execute(dry-run) -> verify`.
 *
 * The legs run in strict order and the gate is a HARD STOP (design SS5 -- the cap is a kill-switch,
 * enforced before any broadcast):
 *
 *  1. **plan** -- [`plan(query)`] -> a deterministic [`Plan`]. An unplannable query throws [`PlanError`],
 *     re-thrown as a [`LoopError`] (loud; nothing downstream runs).
 *  2. **mandate-gate** -- [`checkMandate`] performs the pre-broadcast `eth_call`. If it does NOT return
 *     a definitive on-chain `allowed: true`, the loop STOPS here: `execute` is never called, so no
 *     broadcast can occur. `stage = BLOCKED_BY_MANDATE`.
 *  3. **execute(dry-run)** -- [`execute`] in [`ExecuteMode.DRY_RUN`] (the default) plans the swap and
 *     broadcasts NOTHING. `stage = EXECUTED_DRY_RUN`; `settlement` is `undefined` (no broadcast to
 *     verify -- a dry-run completes with NO live settlement, design SS8).
 *  4. **verify** -- ONLY on a LIVE run that actually broadcast a tx AND a [`SettlementVerifier`] is
 *     wired: the independent verifier is invoked on the real tx hash and its verdict attached.
 *     `stage = VERIFIED`. The loop mints NO verdict itself (the verdict monopoly, design SS3 #2).
 *
 * The function NEVER throws for an operational leg failure (a blocked gate, an unreadable verifier) --
 * those are reported in the returned [`LoopResult`] so the caller always gets a definitive account. It
 * DOES throw [`LoopError`] for a programmer error in the loop's own inputs (an unplannable query, a
 * malformed spend) surfaced before any broadcast decision.
 *
 * Offline by default (design SS6): with `mode` defaulting to `DRY_RUN` and no transport/broadcaster/
 * verifier wired, this performs NO network access, signs nothing, and spawns NO child process.
 *
 * @param query     The natural-language intent to plan from.
 * @param config    The spend/swap + mandate registry + venue (and optional mode). See [`LoopConfig`].
 * @param transport OPTIONAL `eth_call` transport for the mandate gate. Omit it for the offline build:
 *                  the gate then fails CLOSED (loud not-wired) and the loop stops at the gate.
 * @param broadcaster OPTIONAL live swap broadcaster. Used ONLY in `LIVE`. Omit it for the dry-run.
 * @param verifier  OPTIONAL settlement verifier (the verify leg). Used ONLY when a live broadcast
 *                  actually sent. Omit it for the offline dry-run (the verify leg is then skipped).
 * @throws {LoopError} on an unplannable query or a malformed spend (loud, before any broadcast).
 */
export async function runLoop(
  query: string,
  config: LoopConfig,
  transport?: EthCallTransport,
  broadcaster?: SwapBroadcaster,
  verifier?: SettlementVerifier,
  fillProof?: FillProofOracle,
  planner?: (query: string) => Plan | Promise<Plan>,
): Promise<LoopResult> {
  // --- (1) plan -------------------------------------------------------------------------------
  // The brain: a deterministic offline stub by default, or an injected async planner (the configurable
  // hosted-LLM brain). Either way the plan is a CLAIM the downstream legs verify -- an unplannable query
  // or a hosted-LLM failure is a loud LoopError, never a fake plan and never a silent brain swap (SS3 #3).
  let thePlan: Plan;
  try {
    thePlan = await (planner ?? plan)(query);
  } catch (err) {
    if (err instanceof PlanError) {
      throw new LoopError(`plan leg failed: ${err.message}`);
    }
    throw err;
  }

  const spend = config.spend;
  const swapConfig: SwapConfig = config.swap ?? { swapRouter02: OG_SWAP_DEFAULTS.swapRouter02 };
  const mode: ExecuteMode = config.mode ?? ExecuteMode.DRY_RUN;

  // --- (2) mandate-gate (the kill-switch -- design SS5) ---------------------------------------
  // The pre-broadcast eth_call. A malformed spend (bad address/amount) is a loud LoopError surfaced
  // here, before any execute decision. An operational failure (no transport, RPC error, malformed
  // reply, over-cap) is NOT thrown -- it is a fail-closed verdict that STOPS the loop pre-execute.
  let mandate: MandateVerdict;
  try {
    mandate = await checkMandate(
      { agent: spend.agent, token: spend.tokenIn, amount: spend.amountIn },
      config.mandate,
      transport,
    );
  } catch (err) {
    if (err instanceof MandateError) {
      // A programmer error in the request (malformed address/amount) -- loud, before any broadcast.
      throw new LoopError(`mandate leg rejected the spend request: ${err.message}`);
    }
    throw err;
  }

  if (!mandate.allowed) {
    // THE KILL-SWITCH (design SS5): a non-allowed gate STOPS the loop. `execute` is never called, so
    // no broadcast can occur. This is the structural enforcement of "block if over cap, pre-broadcast".
    return {
      stage: LOOP_STAGE.BLOCKED_BY_MANDATE,
      plan: thePlan,
      mandate,
      executed: undefined,
      settlement: undefined,
      note:
        `mandate gate BLOCKED execution (reason: ${String(mandate.reason)}; ` +
        `verified=${String(mandate.verified)}) -- the loop did NOT execute and broadcast NOTHING ` +
        `(the cap is a kill-switch, enforced pre-broadcast -- design SS5).`,
    };
  }

  // --- (3) execute (dry-run by default -- design SS8: NO live settlement) ----------------------
  // The gate ALLOWED the spend. Build the concrete swap from the spend and run the executor. In
  // DRY_RUN (the default + only path this build runs) NOTHING is signed or broadcast.
  const swapReq: SwapRequest = {
    tokenIn: spend.tokenIn,
    tokenOut: spend.tokenOut,
    recipient: spend.recipient,
    amountIn: spend.amountIn,
    expectedOut: spend.expectedOut,
    slippageBps: spend.slippageBps,
  };
  let executed: ExecuteResult;
  try {
    executed = await execute(swapReq, swapConfig, mode, broadcaster);
  } catch (err) {
    if (err instanceof ExecuteError) {
      // A malformed swap or a LIVE-not-wired failure -- loud, never a fabricated broadcast (design SS8).
      throw new LoopError(`execute leg failed: ${err.message}`);
    }
    throw err;
  }

  // --- (4) verify (independent verifier) -------------------------------------------------------
  // A dry-run broadcasts NOTHING, so there is no real tx to verify -- the verify leg is HONESTLY
  // skipped (settlement: undefined; design SS3 principle 3 -- never fabricate a settled). The verify
  // leg runs ONLY when a live broadcast actually sent a tx AND a verifier is wired.
  if (!executed.broadcast || executed.txHashes === undefined || executed.txHashes.length === 0) {
    return {
      stage: LOOP_STAGE.EXECUTED_DRY_RUN,
      plan: thePlan,
      mandate,
      executed,
      settlement: undefined,
      note:
        `dry-run complete: gate ALLOWED, swap PLANNED (${executed.plan.calls.length} calls), ` +
        `broadcast NOTHING (mode=${executed.mode}) -- NO live settlement, so the verify leg is ` +
        `skipped (never a fabricated settled -- design SS3 principle 3, SS8).`,
    };
  }

  // A live broadcast actually sent. Verify the first broadcast tx with the independent verifier.
  if (verifier === undefined) {
    // Broadcast happened but no verifier is wired -- we CANNOT confirm settlement, so we degrade
    // LOUDLY to unverified (design SS3 principle 3), NEVER a fabricated settled. The loop did not mint
    // this; it is the honest "no independent read was available" report, distinct from a verifier read.
    return {
      stage: LOOP_STAGE.EXECUTED_DRY_RUN,
      plan: thePlan,
      mandate,
      executed,
      settlement: undefined,
      note:
        `a live broadcast sent (${executed.txHashes.length} tx) but NO verifier is wired -- ` +
        `settlement is UNCONFIRMED. Wire a SettlementVerifier to stamp it; the loop NEVER fabricates ` +
        `a settled (design SS3 principle 3).`,
    };
  }

  // Verify the broadcast tx. The verifier is the SOLE minter of the verdict (design SS3 principle 2);
  // the loop only carries what it returns. A verifier throw (usage error / unreadable binary) is the
  // honest "could not verify" -- mapped to a loud LoopError, never coerced into a settled.
  const txHash = executed.txHashes[0] as string;
  let settlement: SettlementVerdict;
  try {
    settlement = await verifier.verify(txHash);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LoopError(
      `verify leg could not adjudicate tx ${txHash}: ${detail} -- the loop does NOT treat an ` +
        `unverifiable broadcast as a success (design SS3 principle 3).`,
    );
  }

  // --- (5) fill-proof RELEASE gate (the LI.FI-Intents oracle) ----------------------------------
  // If the swap settled AND a fill-proof oracle is wired, INDEPENDENTLY prove the delivery (the fill)
  // before declaring release. A hollow fill (the delivery the chain says never happened) BLOCKS release
  // even though the tx settled -- ProofAgent refuses to release on an unproven fill, where a hash-only
  // oracle would have paid (design SS3 principle 3). The loop mints no decision; the oracle does.
  if (settlement === SETTLEMENT_VERDICT.SETTLED && fillProof !== undefined) {
    let decision: FillDecision;
    try {
      decision = await fillProof.proveFill(txHash, spend.expectedOut);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new LoopError(
        `fill-proof leg could not adjudicate the fill for tx ${txHash}: ${detail} -- the loop does ` +
          `NOT release an unprovable fill (design SS3 principle 3).`,
      );
    }
    if (decision === FILL_DECISION.BLOCK) {
      return {
        stage: LOOP_STAGE.BLOCKED_BY_FILL_PROOF,
        plan: thePlan,
        mandate,
        executed,
        settlement,
        note:
          `fill-proof oracle BLOCKED release: the swap tx ${txHash} settled, but the INDEPENDENT ` +
          `fill-proof read of the delivery (claimed ${spend.expectedOut.toString()}) is NOT a ` +
          `within-band fill (a hollow / mismatch / unreadable fill). ProofAgent refuses to release on ` +
          `an unproven fill -- where a hash-only oracle would have paid (the LI.FI-Intents frontier, ` +
          `the honest way; design SS3 principle 3).`,
      };
    }
  }

  const fillNote =
    settlement === SETTLEMENT_VERDICT.SETTLED && fillProof !== undefined
      ? ` The fill-proof oracle independently RELEASED the delivery (a within-band fill).`
      : ``;
  return {
    stage: LOOP_STAGE.VERIFIED,
    plan: thePlan,
    mandate,
    executed,
    settlement,
    note:
      `live run complete: gate ALLOWED, swap broadcast (${executed.txHashes.length} tx), ` +
      `independent verifier stamped tx ${txHash}: ${settlement}. The verdict is the verifier's ` +
      `(verdict monopoly -- design SS3 principle 2); the loop only carries it.${fillNote}`,
  };
}

// ----------------------------------------------------------------------------------------------
// binaryVerifier -- the verify leg shelling to the independent Rust verifier binary (`verifier
// verify-tx <hash>`, design SS9). OPT-IN: a caller constructs it. The default loop / dry-run never
// spawns it (offline-by-default, design SS6).
// ----------------------------------------------------------------------------------------------

/**
 * The honest exit/stdout contract the Rust verifier binary obeys (`verifier/src/main.rs`):
 *  - a REAL verdict prints its canonical string as the one machine-readable line on **stdout** and
 *    exits `0` for `settled`, NON-ZERO for `hollow`/`mismatch`/`unverified` (so an exit-only check can
 *    never read a non-settlement as success);
 *  - the NEG case (a fabricated / off-record hash) is NOT a usage error -- it stamps `unverified` to
 *    stdout and exits non-zero;
 *  - a USAGE failure (a string that is not a tx hash, an unreadable spine, no reader) prints a
 *    diagnostic to **stderr**, prints NO verdict line, and exits non-zero.
 *
 * So the shim reads the verdict from the LAST non-empty stdout line and validates it against the
 * verdict alphabet; a usage failure (no valid verdict line) is a loud throw, NEVER a fabricated verdict.
 */
export interface BinaryVerifierOptions {
  /**
   * How to spawn the verifier and collect its output -- the one process seam (so a test can drive the
   * shim with a fake spawner and the default uses `node:child_process`). Returns the captured
   * stdout/stderr and the exit code.
   */
  readonly spawn: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }>;
  /**
   * The verifier binary to invoke. Defaults to `"verifier"` (resolved on PATH) -- never a baked-in
   * private filesystem path (design SS6). A caller may pass an explicit path (e.g. a built
   * `target/release/verifier`) via operator config.
   */
  readonly binary?: string;
  /**
   * OPTIONAL explicit path to the data spine (`proofagent.toml`); forwarded as `--spine <path>`. Omit
   * it to let the verifier find the spine by walking up from its working directory (design SS4).
   */
  readonly spinePath?: string;
}

/**
 * Build a [`SettlementVerifier`] that shells out to the independent Rust verifier binary
 * (`verifier verify-tx <hash>` -- design SS9). This is the verify leg of the loop as the design
 * specifies it: "a thin TS shim that shells to it." It is OPT-IN -- a caller constructs it with a
 * spawner; the default loop / dry-run never spawns a child process (offline-by-default, design SS6).
 *
 * The shim is faithful to the binary's honest exit/stdout contract (see [`BinaryVerifierOptions`]): it
 * reads the canonical verdict from the LAST non-empty **stdout** line and validates it against the
 * verdict alphabet. A run that prints no valid verdict line (a usage failure -- a non-hash input, an
 * unreadable spine, the binary missing) is a loud throw, which [`runLoop`] maps to a loud "could not
 * verify" -- it NEVER coerces a missing verdict into a `settled` (design SS3 principle 3). The exit code
 * is NOT used to decide the verdict (a non-settled verdict legitimately exits non-zero); the stdout
 * verdict string is the source of truth, exactly mirroring the binary's design.
 *
 * @param options the process seam + optional binary path / spine path. See [`BinaryVerifierOptions`].
 */
export function binaryVerifier(options: BinaryVerifierOptions): SettlementVerifier {
  if (typeof options.spawn !== "function") {
    throw new LoopError("binaryVerifier requires a spawn function (the process seam)");
  }
  const binary = options.binary ?? "verifier";
  return {
    async verify(txHash: string): Promise<SettlementVerdict> {
      if (typeof txHash !== "string" || txHash.trim() === "") {
        throw new LoopError("binaryVerifier.verify requires a non-empty transaction hash");
      }
      const args: string[] = ["verify-tx", txHash.trim()];
      if (options.spinePath !== undefined && options.spinePath.trim() !== "") {
        args.push("--spine", options.spinePath.trim());
      }
      const { stdout, stderr, code } = await options.spawn(binary, args);

      // The verdict is the LAST non-empty stdout line (the binary prints exactly one verdict line on
      // stdout; journal rows go to stderr). A usage failure prints NO verdict line on stdout.
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const last = lines.length > 0 ? lines[lines.length - 1] : undefined;

      if (last === undefined || !VALID_VERDICTS.has(last)) {
        // No valid verdict line => a usage failure (not a tx hash, unreadable spine, missing binary).
        // Degrade LOUDLY -- never coerce a missing verdict into a settled (design SS3 principle 3).
        const diag = stderr.trim() === "" ? "<no stderr>" : stderr.trim();
        throw new LoopError(
          `verifier printed no valid verdict line for tx ${txHash} ` +
            `(exit=${String(code)}; stdout=${JSON.stringify(stdout)}; stderr=${diag})`,
        );
      }
      // A valid verdict string from the binary -- carry it as-is (the verifier minted it, not the loop).
      return last as SettlementVerdict;
    },
  };
}

/**
 * Build a [`FillProofOracle`] that shells out to the independent Rust verifier's FILL-PROOF leg
 * (`verifier fill-proof --fill-tx <hash> --claimed <n>` -- the LI.FI-Intents oracle, `verifier/src/
 * fillproof.rs`). It is the loop's fill-proof leg as the design specifies the verify leg: a thin TS shim
 * that shells to the independent verifier, OPT-IN (the default loop / dry-run never spawns it -- design
 * SS6). The oracle reads the destination fill ITSELF; the TS side never reads the chain or mints a
 * decision (the verdict monopoly, design SS3 principle 2).
 *
 * Faithful to the binary's honest output contract: the oracle prints exactly one machine-readable line on
 * **stdout** -- `<verdict> <decision>` (e.g. `hollow BLOCK`). The shim reads the DECISION (the second
 * whitespace token of the LAST non-empty stdout line) and validates it against the decision alphabet. A
 * run that prints no valid decision line (a usage failure -- a non-hash input, an unreadable spine, the
 * binary missing) is a loud throw, which [`runLoop`] maps to a loud "could not prove the fill" -- it NEVER
 * coerces a missing decision into a RELEASE (design SS3 principle 3). The exit code is NOT used to decide
 * (a BLOCK legitimately exits non-zero); the stdout decision is the source of truth.
 *
 * @param options the process seam + optional binary path / spine path (the SAME [`BinaryVerifierOptions`]).
 */
export function binaryFillProof(options: BinaryVerifierOptions): FillProofOracle {
  if (typeof options.spawn !== "function") {
    throw new LoopError("binaryFillProof requires a spawn function (the process seam)");
  }
  const binary = options.binary ?? "verifier";
  return {
    async proveFill(fillTxHash: string, claimedFill: bigint): Promise<FillDecision> {
      if (typeof fillTxHash !== "string" || fillTxHash.trim() === "") {
        throw new LoopError("binaryFillProof.proveFill requires a non-empty fill tx hash");
      }
      const args: string[] = [
        "fill-proof",
        "--fill-tx",
        fillTxHash.trim(),
        "--claimed",
        claimedFill.toString(),
      ];
      if (options.spinePath !== undefined && options.spinePath.trim() !== "") {
        args.push("--spine", options.spinePath.trim());
      }
      const { stdout, stderr, code } = await options.spawn(binary, args);

      // The DECISION is the second whitespace token of the LAST non-empty stdout line (`<verdict>
      // <decision>`). A usage failure prints NO such line -> degrade LOUDLY (never a fabricated RELEASE).
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
      const decision = last === undefined ? undefined : last.split(/\s+/)[1];

      if (decision === undefined || !VALID_FILL_DECISIONS.has(decision)) {
        const diag = stderr.trim() === "" ? "<no stderr>" : stderr.trim();
        throw new LoopError(
          `fill-proof oracle printed no valid <verdict> <decision> line for fill ${fillTxHash} ` +
            `(exit=${String(code)}; stdout=${JSON.stringify(stdout)}; stderr=${diag})`,
        );
      }
      // A valid decision string from the binary -- carry it as-is (the oracle minted it, not the loop).
      return decision as FillDecision;
    },
  };
}

/**
 * The default process seam for [`binaryVerifier`] -- a real `node:child_process` spawner that runs the
 * verifier binary and captures its stdout/stderr/exit code.
 *
 * This is the ONLY child-process leg in the module and it is OPT-IN: a caller must explicitly pass it to
 * [`binaryVerifier`]. [`runLoop`]'s default (dry-run, no verifier) path NEVER reaches it, so the default
 * build spawns nothing (offline-by-default, design SS6). `node:child_process` is a standard built-in --
 * no runtime dependency is added.
 *
 * It uses `execFile` (NOT a shell) so the arguments are passed as an argv array -- no shell
 * interpolation of the tx hash, so a hostile hash string can never inject a command. A non-zero exit is
 * NOT treated as a spawn failure here (the verifier legitimately exits non-zero for a non-settled
 * verdict, design main.rs); the captured `(stdout, stderr, code)` is returned and [`binaryVerifier`]
 * decides the verdict from the stdout line. A genuine spawn failure (binary missing / not executable)
 * rejects, which the shim surfaces as a loud "could not verify" -- never a fabricated settled.
 *
 * @returns a spawner suitable for [`BinaryVerifierOptions.spawn`].
 */
export function nodeSpawn(): BinaryVerifierOptions["spawn"] {
  return async (command: string, args: readonly string[]) => {
    // Lazy, std-only import so merely loading this module never pulls in child_process unless the
    // operator actually constructs the spawner. `execFile` runs the binary directly (no shell).
    const { execFile } = await import("node:child_process");
    return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
        // A non-zero exit shows up as an `error` with a numeric `.code`; that is NOT a spawn failure --
        // the verifier exits non-zero for any non-settled verdict (design main.rs). Capture and return.
        if (error !== null && typeof (error as { code?: unknown }).code === "number") {
          resolve({ stdout, stderr, code: (error as { code: number }).code });
          return;
        }
        // A real spawn failure (ENOENT / not executable / killed) -> reject; the shim degrades loudly.
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      });
    });
  };
}

// ----------------------------------------------------------------------------------------------
// Small, pure helpers exposed for the journal/UI + tests (design SS3 principle 4 -- deterministic).
// ----------------------------------------------------------------------------------------------

/**
 * `true` iff a loop run reached a definitive settlement verdict AND that verdict is `settled`. This is
 * the ONLY "did the trade really happen?" check, mirroring the verifier's `is_settled` -- nothing but a
 * verifier-minted `settled` reads as success (design SS3 principle 3). A dry-run (no settlement) is
 * `false`; a `hollow`/`mismatch`/`unverified` is `false`.
 */
export function isSettled(result: LoopResult): boolean {
  return result.settlement === SETTLEMENT_VERDICT.SETTLED;
}

/**
 * The largest allocation in a plan (the dominant leg) -- a pure, deterministic helper for the journal
 * (design SS3 principle 4). On a tie it returns the FIRST in the plan's deterministic order (the
 * planner's stable emit order). Returns `undefined` only for an empty allocation set (which a valid
 * [`Plan`] never has).
 */
export function dominantAllocation(thePlan: Plan): Allocation | undefined {
  let best: Allocation | undefined;
  for (const a of thePlan.allocations) {
    if (best === undefined || a.bps > best.bps) {
      best = a;
    }
  }
  return best;
}
