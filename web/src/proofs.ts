/**
 * proofs.ts -- the honest data model behind the three demo stamps + the NEG case.
 *
 * Design §2 (the three proofs): Brain (0G Compute TEE attestation), Rails (on-chain MandateRegistry
 * `checkTransfer()`), Settlement (the independent Rust verifier's verdict). Design §2 also defines THE
 * NEG case: "Point the verifier at a *fabricated* transaction hash -> it stamps **`UNVERIFIED`**." Design
 * §4 (web): "one screen, three green stamps (brain / rails / settlement) + the fabricated-hash ->
 * `UNVERIFIED` moment". Design §8 (honesty doctrine): "Claim only what is live -- the pitch leads with the
 * legs that are provable on screen; every later 0G capability is an honestly-labelled bracket-delta."
 *
 * ## HONESTY: the brain stamp is green ONLY when a real enclave attestation backs it (design §7 / §8 / §9)
 *
 * Design §7 (build roadmap) puts the TEE brain proof in the **Depth** bracket, NOT the MVP: at the MVP
 * "Brain is a hosted LLM at this stage, honestly labelled", and design §9 Depth is explicit -- "surface a
 * real green 'brain' verdict on screen for a live plan call." So the brain stamp is `PENDING` (Phase-2) in
 * the DEFAULT offline build -- showing a green brain the MVP cannot back would violate design §8 ("claim
 * only what is live"). It lifts to a green `LIVE` ONLY when {@link buildStamps} is handed a REAL verified
 * brain attestation whose `attested === true` (the Depth leg, on screen) -- the single, gated condition.
 * No attestation, or a non-attested one, keeps the stamp PENDING. The same honesty governs Rails (the
 * registry address is not yet pinned on-chain, so the stamp is `ARMED` -- enforced in code pre-broadcast --
 * not a green "live on-chain" claim) and Settlement (the corpus is empty, so no `SETTLED` is asserted; the
 * one live, runnable proof is the NEG case -> `UNVERIFIED`).
 *
 * ## VERDICT MONOPOLY: this module mints NO verdict (design §3 principle 2)
 *
 * "Only the verifier mints a verdict (`settled / hollow / mismatch / unverified`). The agent, the LLM, and
 * the web UI produce claims and facts -- never a verdict." The web therefore NEVER constructs a `settled`.
 * The NEG case below reproduces the verifier's PUBLISHED adjudication RULE for an in-page demo
 * (off-record claim -> no observation -> `unverified`), faithful to the Rust `adjudicate(claimed, None,
 * tol)` in `verifier/src/adjudicate.rs`; it can only ever produce `unverified`, and it surfaces the exact
 * CLI command so a viewer reproduces the verdict against the REAL independent binary. The page never
 * fabricates a `settled` (design §3 principle 3).
 *
 * ## CLEAN-ROOM (design §6)
 *
 * No proprietary identifier, private filesystem path, or secret appears here. Every constant below mirrors
 * the PUBLIC data spine `proofagent.toml`; the RPC endpoint and any wallet material are read from the
 * environment at run time elsewhere, never baked in here.
 */

/* ------------------------------------------------------------------------------------------------ *
 * Spine-derived public constants (mirror proofagent.toml -- nothing secret).
 *
 * These now live in the single spine source {@link ./spine.ts} so a growing surface cannot drift two
 * copies. They are RE-EXPORTED here byte-identically, so every existing importer of `proofs.ts`
 * (`main.ts`, the tests, the headless harness) keeps working unchanged. Same values, one source.
 * ------------------------------------------------------------------------------------------------ */

import { CHAIN, MANDATE, VERIFIER } from "./spine.js";
// Re-export the spine constants under the same names this module has always exposed (backward-compatible).
export { CHAIN, MANDATE, VERIFIER };

/* ------------------------------------------------------------------------------------------------ *
 * The verdict alphabet (design §2) -- mirrored from the Rust `Verdict` enum, read-only.
 * The web NEVER mints one; it only ever READS / DISPLAYS a verdict string (verdict monopoly, §3 #2).
 * ------------------------------------------------------------------------------------------------ */

/** The four settlement verdict strings the independent verifier may mint (design §2 alphabet). */
export const VERDICT = {
  SETTLED: "settled",
  HOLLOW: "hollow",
  MISMATCH: "mismatch",
  UNVERIFIED: "unverified",
} as const;

/** A settlement verdict string. Minted ONLY by the verifier; the web merely carries the string. */
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

/* ------------------------------------------------------------------------------------------------ *
 * The three stamps -- each carries an HONEST status the MVP can actually back (design §8).
 * ------------------------------------------------------------------------------------------------ */

/**
 * A stamp's honesty level. Only `LIVE` renders green. `PENDING` (a phase-2 / depth bracket-delta) and
 * `ARMED` (enforced in code, but the on-chain leg is not yet pinned/deployed) render amber -- NEVER green,
 * so the screen claims only what is live (design §8).
 */
export const STAMP_LEVEL = {
  /** Provable on screen, right now -> green. */
  LIVE: "live",
  /** Enforced in code (pre-broadcast), but the on-chain leg is not yet pinned/deployed -> amber. */
  ARMED: "armed",
  /** Designed for a later bracket (design §7 Depth/Wow); not yet live -> amber, honestly labelled. */
  PENDING: "pending",
} as const;

/** A stamp honesty level. */
export type StampLevel = (typeof STAMP_LEVEL)[keyof typeof STAMP_LEVEL];

/** One proof stamp on the demo screen. */
export interface Stamp {
  /** The proof name (design §2): "brain" | "rails" | "settlement". */
  readonly proof: "brain" | "rails" | "settlement";
  /** The headline shown on the stamp face. */
  readonly title: string;
  /** The honesty level -- drives the colour. Only `LIVE` is green (design §8). */
  readonly level: StampLevel;
  /** The short status word on the stamp (e.g. "PENDING", "ARMED", "READY"). */
  readonly status: string;
  /** A one-line honest claim the MVP can actually back. */
  readonly claim: string;
  /** A bracket label per design §7 (MVP | Depth | Wow), so every later capability is honestly labelled. */
  readonly bracket: "MVP" | "Depth" | "Wow";
}

/**
 * The honest brain-attestation fact the brain stamp reads -- the web's OWN, clean-room view of a verified
 * 0G Compute TEE attestation (design §9 Depth, §3).
 *
 * This is the web's narrow, ORIGINAL boundary type (the web package is standalone DOM TypeScript; it never
 * imports the agent). It mirrors only the ONE load-bearing fact the design's brain proof produces: a single
 * `attested` boolean that is `true` IFF a real enclave proof verified -- a `trusted` provider-service
 * attestation AND a verified per-response enclave signature, NEITHER taken from the model's reply text
 * (design §3 #1/#2). The remaining fields are journal/UI-only context, never the source of truth.
 *
 * The stamp's green lift keys on `attested` alone: a non-attested (`attested === false`) verdict, or no
 * verdict at all, keeps the brain stamp PENDING -- there is NO path on which the UI lights a green brain the
 * attestation does not back (design §8: claim only what's live; §3 #3: never fabricate).
 */
export interface BrainAttestation {
  /** `true` IFF a REAL enclave attestation verified (the ONLY condition that lifts the stamp green). */
  readonly attested: boolean;
  /** The 0G Compute provider the attestation is for -- a journal/UI label (never the proof itself). */
  readonly provider?: string;
  /** Which model the attestation pinned -- "which model actually ran" (UI context only). */
  readonly model?: string;
  /** The per-response handle the signature keyed on -- the auditable reference (UI context only). */
  readonly responseId?: string;
  /** A human-readable note: a confirmation tag when attested, or the loud PENDING reason. UI-only. */
  readonly reason?: string;
}

/**
 * Build the three stamps from the spine-derived constants, honestly (design §2, §7, §8, §9).
 *
 * - **Brain** -> `PENDING` by DEFAULT (design §7: TEE attestation is the *Depth* bracket; at MVP the brain
 *   is a hosted LLM, honestly labelled). It lifts to a green `LIVE` ONLY when `brain?.attested === true` --
 *   a REAL verified enclave attestation handed in (design §9 Depth: "a real green brain verdict on screen
 *   for a live plan call"). No attestation, or a non-attested one, stays PENDING. This is the single gated
 *   green path; the MVP default never backs a green brain it cannot prove (design §8 / §3 #3).
 * - **Rails** -> `ARMED` while `MANDATE.registryAddress` is empty (design §8: the registry is not yet pinned
 *   on-chain), or `LIVE` once an address is pinned (then the explorer link lets a viewer confirm the cap
 *   themselves -- design §4). The cap is enforced in code pre-broadcast either way (design §5 kill-switch).
 * - **Settlement** -> `LIVE` (READY): the independent verifier and its NEG case are runnable on screen right
 *   now. It asserts NO `settled` while the corpus is empty (design §6/§8); the live proof is the NEG case.
 *
 * @param brain OPTIONAL verified brain attestation. When `attested === true` the brain stamp renders green
 *   `LIVE` (the operator-gated Depth path); omitted or `attested === false` keeps it PENDING (the default
 *   offline build). It is the ONLY input that can light the brain stamp green.
 */
export function buildStamps(brain?: BrainAttestation): readonly [Stamp, Stamp, Stamp] {
  const railsLive = MANDATE.registryAddress.length > 0;
  // The brain stamp lifts green ONLY for a REAL, explicitly-attested verdict (attested === true). A missing
  // or non-attested verdict leaves it PENDING -- there is no other path to a green brain (design §8/§9/§3 #3).
  const brainAttested = brain?.attested === true;
  return [
    brainAttested
      ? {
          proof: "brain",
          title: "Brain -- which model ran",
          level: STAMP_LEVEL.LIVE,
          status: "LIVE / TEE-attested",
          claim:
            "0G Compute proved this exact model ran inside a hardware enclave (TEE): the provider's " +
            "service attestation verified AND the per-response enclave signature over THIS reply verified " +
            "-- two cryptographic facts, neither taken from the model's own words." +
            (brain?.model !== undefined && brain.model.length > 0 ? ` Attested model: ${brain.model}.` : ""),
          bracket: "Depth",
        }
      : {
          proof: "brain",
          title: "Brain -- which model ran",
          level: STAMP_LEVEL.PENDING,
          status: "PENDING / Phase-2",
          claim:
            "0G Compute TEE attestation is a Phase-2 (Depth) bracket. At MVP the brain is a hosted LLM, " +
            "honestly labelled -- so this stamp is NOT green until a real enclave verdict is on screen.",
          bracket: "Depth",
        },
    {
      proof: "rails",
      title: "Rails -- it cannot overspend",
      level: railsLive ? STAMP_LEVEL.LIVE : STAMP_LEVEL.ARMED,
      status: railsLive ? "LIVE" : "ARMED",
      claim: railsLive
        ? `The live on-chain MandateRegistryV4 checkTransfer() rejects any spend over the $${MANDATE.perTxCapUsd} ` +
          "per-tx cap as a zero-gas eth_call, BEFORE broadcast. Confirm it yourself on the explorer."
        : `The $${MANDATE.perTxCapUsd} per-tx cap is enforced in code pre-broadcast (the kill-switch), ` +
          "but the on-chain registry address is not yet pinned -- so this is ARMED, not a green on-chain claim.",
      bracket: "MVP",
    },
    {
      proof: "settlement",
      title: "Settlement -- the trade really happened",
      level: STAMP_LEVEL.LIVE,
      status: "READY",
      claim:
        "An independent Rust verifier reads 0G itself and stamps settled / hollow / mismatch / unverified " +
        "-- it never trusts the UI. The corpus has no pinned settlements yet, so it asserts NO `settled`; " +
        "the live, runnable proof is the NEG case below.",
      bracket: "MVP",
    },
  ];
}

/* ------------------------------------------------------------------------------------------------ *
 * The NEG case (design §2: the proof that the proof is real).
 * ------------------------------------------------------------------------------------------------ */

/** A 32-byte (0x + 64 hex) transaction-hash shape. Mirrors the verifier's hash-shape gate. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** The outcome of running the NEG case in-page. */
export interface NegCaseResult {
  /** The fabricated hash that was checked. */
  readonly hash: string;
  /** The verdict -- can ONLY ever be `unverified` for the NEG case (design §2/§3). */
  readonly verdict: Verdict;
  /** Whether the hash was on-record in the corpus (always false here -> the NEG case). */
  readonly recorded: boolean;
  /** A loud, honest one-line explanation of WHY it is unverified -- never softening the stamp. */
  readonly explanation: string;
  /** The exact CLI command to reproduce this against the REAL independent Rust verifier. */
  readonly reproduceCommand: string;
}

/**
 * A well-formed but deliberately FABRICATED transaction hash -- the hero NEG-case input (design §2).
 * It is well-formed (passes the hash-shape gate) yet is not on-record in any corpus, so the verifier has
 * nothing confirming a settlement and must degrade LOUDLY to `unverified`.
 */
export const FABRICATED_HASH =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/**
 * Run the NEG case (design §2): point the verifier at a fabricated hash and get `UNVERIFIED` -- never
 * `settled`. This reproduces the verifier's PUBLISHED adjudication rule for an in-page demo, faithful to
 * the Rust `adjudicate(claimed, None, tol)` in `verifier/src/adjudicate.rs`:
 *
 *   a fabricated hash is OFF-RECORD => there is NO independent observation => `adjudicate(_, None, _)`
 *   returns `unverified` (the keystone branch, design §3 principle 3 -- never fabricate a `settled`).
 *
 * This function is TOTAL and can ONLY ever return `unverified` for a fabricated/off-record hash -- it has
 * no code path that returns `settled` (the verdict monopoly + never-fabricate, design §3 #2/#3). It throws
 * a `RangeError` only for an input that is not a transaction hash at all (a usage error -- distinct from
 * the NEG verdict, mirroring the verifier binary's stderr/usage contract).
 *
 * @param hash the (fabricated) transaction hash to check. Defaults to {@link FABRICATED_HASH}.
 * @returns the NEG-case result -- always `unverified`.
 * @throws {RangeError} if `hash` is not a well-formed 0x + 64-hex transaction hash (a usage error).
 */
export function runNegCase(hash: string = FABRICATED_HASH): NegCaseResult {
  if (!TX_HASH_RE.test(hash)) {
    // A usage error -- NOT a verdict. Mirrors the verifier binary: a non-hash prints a diagnostic and
    // NO verdict line (the absence of a verdict is itself the honest signal).
    throw new RangeError(
      `not a transaction hash (expected 0x + 64 hex): ${JSON.stringify(hash)}`,
    );
  }
  // Off-record: no corpus claim, hence no independent observation. adjudicate(_, None, _) => Unverified.
  // This is the ONLY branch -- there is deliberately no path to `settled` here (design §3 #3).
  return {
    hash,
    verdict: VERDICT.UNVERIFIED,
    recorded: false,
    explanation:
      "No claim is recorded in the corpus for this hash, so the verifier has nothing on-record " +
      "confirming a settlement. It reads the chain independently and finds no observation -- so it " +
      "stamps `unverified`, NEVER `settled`. The verifier isn't rubber-stamping; it's reading the chain.",
    reproduceCommand: `cargo run -p verifier -- verify-tx ${hash}`,
  };
}
