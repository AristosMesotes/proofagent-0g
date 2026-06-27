/**
 * The planner -- `plan(query) -> { chain, allocations[] }`.
 *
 * Design SS4 (architecture, `agent/plan.ts`): "LLM: query -> { chain, allocations }". Design SS5
 * (the loop): `plan` is the first leg of `plan -> mandate-gate -> execute -> verify`; its output is
 * the proposed action the mandate gate then checks against the on-chain cap *before* any broadcast.
 *
 * ## Honestly-labelled stub (design SS7 + SS8 "claim only what's live")
 *
 * Design SS7 (build roadmap, MVP): "Brain is a hosted LLM at this stage, honestly labelled." Design
 * SS8 (honesty doctrine): "Claim only what is live ... every later 0G capability is an
 * honestly-labelled bracket-delta." So this MVP planner is a **deterministic, offline rule stub** --
 * NOT a model. It contains no network call, no LLM, no `0G Compute` TEE leg. The live brain (a hosted
 * LLM now, then the 0G Compute TEE-attested call) is a later bracket-delta that will replace
 * [`planStub`] behind the same [`plan`] signature; see [`PlannerKind`] and [`Plan.brain`], which
 * label on the wire exactly which brain produced a plan so the UI can never present a stub plan as a
 * TEE-verified one.
 *
 * ## Determinism (design SS3 principle 4)
 *
 * "The same chain reads always produce the same verdict and the same reproducibility digest." The
 * planner mirrors that invariant on the *plan* side: [`plan`] is a **pure function of its query** --
 * no wall-clock, no randomness, no I/O, no ambient state. The same query string always yields a
 * byte-identical [`Plan`]. This makes a plan reproducible and reviewable, and lets the loop's later
 * legs (and tests) pin an exact expected plan.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * "Amounts are compared in minor units with exact-integer tolerance bands -- no floating point on the
 * money path." Allocations are therefore expressed in **integer basis points** (`bps`, 1/100 of a
 * percent), never float fractions/percentages. The whole portfolio is `TOTAL_BPS` (= 10000 = 100%);
 * every allocation `bps` is a non-negative integer and the set sums to exactly `TOTAL_BPS`. There is
 * no `number` used as a fraction and no floating-point arithmetic anywhere in this module.
 *
 * ## Never fabricate (design SS3 principle 3)
 *
 * "An unavailable, off-record, or unreadable result degrades loudly." A query the stub cannot map to
 * a well-formed, fully-allocated plan is a **loud** [`PlanError`] (thrown) -- it never silently
 * returns a partial, zero, or made-up allocation that a downstream leg could mistake for a real
 * instruction. The mandate gate and verifier remain the authorities on spend and settlement; the
 * planner only proposes, and it proposes honestly or not at all.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The chain/token constants are the
 * public 0G values from the design appendix.
 */

import type { BrainVerdict } from "./zerog/types.js";

/**
 * The whole portfolio in basis points (1 bps = 1/100 of a percent), so `TOTAL_BPS = 10000 = 100%`.
 *
 * Design SS3 principle 5 (exact-integer money): allocations are integer `bps`, never float percents,
 * and a valid plan's allocations sum to exactly this value.
 */
export const TOTAL_BPS = 10_000 as const;

/**
 * The public 0G chains from the design appendix (the only two this agent targets).
 *
 * Design appendix (constants & sources): "0G chain id `16661` (Aristotle); testnet Galileo `16602`".
 * Design SS8 (security doctrine): live legs run "Testnet / dev only" -- the planner can target either,
 * but it is the loop/operator config (not the planner) that gates which one actually broadcasts.
 */
export const CHAINS = {
  /** 0G Aristotle mainnet. */
  aristotle: { id: 16661, name: "0G Aristotle" },
  /** 0G Galileo testnet (the default, demo-safe target -- design SS8). */
  galileo: { id: 16602, name: "0G Galileo" },
} as const;

/** A 0G chain selection in a [`Plan`] -- the chain the proposed action would execute on. */
export interface ChainRef {
  /** EVM chain id (e.g. `16661` Aristotle, `16602` Galileo). */
  readonly id: number;
  /** Human-readable chain name, for the journal/UI (never the source of truth -- design SS3). */
  readonly name: string;
}

/**
 * The tokens the planner can allocate to -- the public 0G demo assets from the design appendix.
 *
 * Design appendix: "Tokens: USDC.e, W0G." The decimals mirror `proofagent.toml [tokens.*]` and matter
 * because every downstream amount is in that token's **minor units** (exact-integer; design SS3
 * principle 5) -- but the planner deals only in *proportions* (bps), so it never converts to minor
 * units itself; that is the executor's job once a concrete notional is known.
 */
export const TOKENS = {
  "USDC.e": { symbol: "USDC.e", decimals: 6 },
  W0G: { symbol: "W0G", decimals: 18 },
} as const;

/** A token symbol the planner is allowed to allocate to. */
export type TokenSymbol = keyof typeof TOKENS;

/** A single proposed allocation: a target token and its integer basis-point weight. */
export interface Allocation {
  /** The target token symbol (must be one of [`TOKENS`]). */
  readonly token: TokenSymbol;
  /**
   * The weight in integer basis points (`0..=TOTAL_BPS`). Across a plan, the `bps` sum to exactly
   * `TOTAL_BPS` (design SS3 principle 5 -- exact-integer, no float). A `0`-bps allocation is never
   * emitted (it would be a no-op leg); only tokens that receive weight appear.
   */
  readonly bps: number;
}

/**
 * Which brain produced a plan -- the honesty label (design SS7 / SS8, "claim only what's live").
 *
 * The wire carries this so no UI can ever present a deterministic stub plan as a TEE-verified one.
 * Today only `"stub"` is produced; `"hosted-llm"` and `"tee"` are the later bracket-deltas that will
 * back the SAME [`plan`] signature once they are live on screen.
 */
export type PlannerKind = "stub" | "hosted-llm" | "tee";

/**
 * The planner's output -- design SS4: `{ chain, allocations }`.
 *
 * `brain` is an honesty label beyond the minimal `{chain, allocations}` shape (design SS8): it states
 * which brain produced the plan, so a stub plan is never silently dressed up as a TEE-verified one.
 */
export interface Plan {
  /** The 0G chain the proposed action targets. */
  readonly chain: ChainRef;
  /**
   * The proposed allocations, in a deterministic, stable order (design SS3 principle 4). Non-empty;
   * every `bps` is a positive integer and the set sums to exactly `TOTAL_BPS`.
   */
  readonly allocations: readonly Allocation[];
  /** Which brain produced this plan (the honesty label -- design SS7/SS8). */
  readonly brain: PlannerKind;
}

/**
 * A loud planning failure (design SS3 principle 3 -- never fabricate; degrade loudly).
 *
 * Thrown -- never returned as a fake `Plan` -- when the stub cannot map a query to a well-formed,
 * fully-allocated plan, or when a produced plan would violate the exact-integer allocation invariant.
 * A caller (the loop) treats a thrown `PlanError` as "no actionable plan", never as an empty/zero
 * action.
 */
export class PlanError extends Error {
  public override readonly name = "PlanError";
  public constructor(message: string) {
    super(message);
    // Keep a correct prototype chain under transpilation targets that need it.
    Object.setPrototypeOf(this, PlanError.prototype);
  }
}

/**
 * The deterministic stub rule-set: query intent -> a fixed, fully-allocated plan.
 *
 * Each rule is an exact-integer allocation over [`TOKENS`] that sums to `TOTAL_BPS`. The rules are a
 * small, readable, OFFLINE proxy for the brain (design SS7 MVP). They are intentionally simple and
 * fully covered by tests; the live brain (a hosted LLM, then the 0G Compute TEE call) replaces this
 * table behind the same [`plan`] signature as a later bracket-delta (design SS8).
 *
 * The order of `allocations` within each rule is the deterministic emit order (design SS3
 * principle 4) -- it is preserved exactly into the returned [`Plan`].
 */
const STUB_RULES: ReadonlyArray<{
  /** Lowercased substrings; if ANY appears in the normalized query, this rule matches. */
  readonly cues: readonly string[];
  /** The fixed allocation set for this intent (must sum to `TOTAL_BPS`). */
  readonly allocations: readonly Allocation[];
}> = [
  {
    // "Defensive / stable" intent -> all into the stablecoin.
    cues: ["stable", "defensive", "safe", "cash", "usdc", "preserve"],
    allocations: [{ token: "USDC.e", bps: TOTAL_BPS }],
  },
  {
    // "Aggressive / risk-on / native" intent -> all into the native wrapped asset.
    cues: ["aggressive", "risk", "growth", "native", "w0g", "0g", "long"],
    allocations: [{ token: "W0G", bps: TOTAL_BPS }],
  },
  {
    // "Balanced / hedge / 50-50" intent -> an even, exact-integer split.
    cues: ["balanced", "balance", "hedge", "split", "50/50", "50-50", "even", "diversif"],
    allocations: [
      { token: "USDC.e", bps: TOTAL_BPS / 2 },
      { token: "W0G", bps: TOTAL_BPS / 2 },
    ],
  },
];

/**
 * The fallback plan when no rule cue matches (design SS3 principle 4 -- a deterministic, total
 * function; every accepted query yields a plan). It is the demo-safe, conservative default: fully
 * into the stablecoin. This is NOT a fabricated success -- it is an explicit, documented default
 * allocation, and the mandate gate + verifier remain the authorities on whether anything executes.
 */
const DEFAULT_ALLOCATIONS: readonly Allocation[] = [{ token: "USDC.e", bps: TOTAL_BPS }];

/** The default chain for the demo (design SS8: testnet / dev-only live legs -> Galileo). */
const DEFAULT_CHAIN: ChainRef = CHAINS.galileo;

/**
 * Validate the exact-integer allocation invariant (design SS3 principle 5), loudly.
 *
 * Every `bps` must be a positive, finite, safe integer; every token must be known; the set must be
 * non-empty and sum to exactly `TOTAL_BPS`. Any violation is a [`PlanError`] -- never a silently
 * accepted malformed plan.
 */
function assertAllocations(allocations: readonly Allocation[]): void {
  if (allocations.length === 0) {
    throw new PlanError("plan has no allocations (must be non-empty and sum to 100%)");
  }
  let sum = 0;
  for (const a of allocations) {
    if (!(a.token in TOKENS)) {
      throw new PlanError(`unknown allocation token ${JSON.stringify(a.token)}`);
    }
    if (!Number.isInteger(a.bps)) {
      throw new PlanError(`allocation bps must be an integer, got ${String(a.bps)} for ${a.token}`);
    }
    if (a.bps <= 0 || a.bps > TOTAL_BPS) {
      throw new PlanError(`allocation bps for ${a.token} out of range (1..=${TOTAL_BPS}): ${a.bps}`);
    }
    // Integer addition only -- no float on the money path (design SS3 principle 5).
    sum += a.bps;
  }
  if (sum !== TOTAL_BPS) {
    throw new PlanError(`allocations must sum to exactly ${TOTAL_BPS} bps (100%), got ${sum}`);
  }
}

/**
 * Normalize a query to the deterministic matching form: trimmed, collapsed whitespace, lowercased.
 *
 * Pure and case-insensitive so the same intent always selects the same rule regardless of casing or
 * incidental spacing (design SS3 principle 4). Returns the empty string for whitespace-only input.
 */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The deterministic stub brain: map a normalized query to a fixed, fully-allocated allocation set.
 *
 * Rules are checked in [`STUB_RULES`] order; the FIRST whose any-cue matches wins (a stable,
 * documented precedence -- design SS3 principle 4). No match -> the conservative [`DEFAULT_ALLOCATIONS`].
 * The result is the rule's allocation array as-is (its order is the deterministic emit order).
 */
function planStub(normalized: string): readonly Allocation[] {
  for (const rule of STUB_RULES) {
    if (rule.cues.some((cue) => normalized.includes(cue))) {
      return rule.allocations;
    }
  }
  return DEFAULT_ALLOCATIONS;
}

/**
 * Plan an action from a natural-language `query` -- design SS4: `query -> { chain, allocations }`.
 *
 * Deterministic, offline, and pure (design SS3 principle 4): the same query always yields a
 * byte-identical [`Plan`]. The returned plan's `brain` is `"stub"` -- the honest label for this MVP
 * deterministic brain (design SS7/SS8); the live LLM / 0G Compute TEE brain is a later bracket-delta
 * behind this same signature.
 *
 * @throws {PlanError} if `query` is empty/whitespace-only (no intent to plan from), or if the
 *   produced allocation set would violate the exact-integer invariant (design SS3 principle 3 --
 *   degrade loudly, never fabricate a partial/zero plan).
 */
export function makePlan(
  allocations: readonly Allocation[],
  brain: PlannerKind,
  chain: ChainRef = DEFAULT_CHAIN,
): Plan {
  // Every brain (stub / hosted-llm / tee) routes through the SAME exact-integer allocation invariant,
  // so a hosted LLM's chosen split is held to the identical bar as the stub -- a malformed/partial set
  // is a loud PlanError, never a fabricated plan (design SS3 #3/#5). The `brain` label stays honest:
  // the constructor never upgrades the label, it only records which brain the caller says produced this.
  assertAllocations(allocations);
  return { chain, allocations, brain };
}

/**
 * Plan an action from a natural-language `query` -- the deterministic STUB brain (`brain: "stub"`).
 */
export function plan(query: string): Plan {
  if (typeof query !== "string") {
    // Defensive: callers from untyped JS could pass a non-string; fail loud, never coerce silently.
    throw new PlanError("query must be a string");
  }
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) {
    throw new PlanError("empty query -- no intent to plan from");
  }

  const allocations = planStub(normalized);
  // Enforce the exact-integer allocation invariant on the way out -- a malformed rule (should be
  // impossible given the table, but verified at runtime) is a loud error, never a fabricated plan.
  assertAllocations(allocations);

  return {
    chain: DEFAULT_CHAIN,
    allocations,
    brain: "stub",
  };
}

/**
 * Re-label a deterministic stub plan as TEE-ATTESTED -- design §9 Depth: "surface a real green brain
 * verdict on screen for a live plan call." This is the agent-side honesty seam that lets a plan carry the
 * distinct `"tee"` brain label INSTEAD of `"stub"`, and ONLY when a REAL verified enclave attestation backs
 * it (design §7/§8 "claim only what's live"; §3 #3 "never fabricate").
 *
 * The TEE label is reachable ONLY through a verdict whose `attested === true` -- the same load-bearing
 * boolean the Brain leg ([`attestInference`]) mints from two cryptographic facts (a `trusted` service
 * attestation AND a verified per-response enclave signature), NEITHER taken from the model's reply text. A
 * verdict that is NOT attested is a loud [`PlanError`] -- a stub plan is NEVER silently dressed up as
 * TEE-verified, exactly mirroring the web brain stamp, which lifts green only on `attested === true`.
 *
 * This keeps the offline default honest: [`plan`] always returns `brain: "stub"` (the deterministic MVP
 * brain), and a plan is `brain: "tee"` ONLY after this function is handed a genuine attestation -- so a
 * `"tee"`-labelled plan is, by construction, attestation-backed. The allocations/chain are untouched; only
 * the honesty label changes (the attestation proves WHICH brain ran, not WHAT it should allocate).
 *
 * @param p       The deterministic plan to re-label (typically the output of [`plan`], `brain: "stub"`).
 * @param verdict The brain verdict from the attestation seam. Its `attested` flag is the ONLY gate.
 * @returns the SAME plan re-labelled `brain: "tee"` -- iff the verdict is genuinely attested.
 * @throws {PlanError} if `verdict.attested !== true` -- a non-attested verdict can never label a plan
 *   as TEE-verified (design §3 #3: degrade loudly, never fabricate a proof).
 */
export function attestPlan(p: Plan, verdict: BrainVerdict): Plan {
  if (verdict.attested !== true) {
    // Never mislabel: a non-attested verdict cannot promote a stub plan to TEE-verified. Loud, not silent.
    throw new PlanError(
      `cannot label a plan TEE-attested: the brain verdict is not attested (reason: ${verdict.reason})`,
    );
  }
  // Re-validate the allocation invariant defensively -- the label changes, the money invariant must hold.
  assertAllocations(p.allocations);
  return { ...p, brain: "tee" };
}
