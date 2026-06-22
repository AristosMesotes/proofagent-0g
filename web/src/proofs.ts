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
 * ## HONESTY: this MVP does NOT show a green brain stamp (design §7 / §8)
 *
 * Design §7 (build roadmap) puts the TEE brain proof in the **Depth** bracket, NOT the MVP: at the MVP
 * "Brain is a hosted LLM at this stage, honestly labelled." So the brain stamp here is `PENDING` (phase-2),
 * never green -- showing a green brain the MVP cannot back would violate design §8 ("claim only what is
 * live"). The same honesty governs Rails (the registry address is not yet pinned on-chain, so the stamp is
 * `ARMED` -- enforced in code pre-broadcast -- not a green "live on-chain" claim) and Settlement (the corpus
 * is empty, so no `SETTLED` is asserted; the one live, runnable proof is the NEG case -> `UNVERIFIED`).
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
 * ------------------------------------------------------------------------------------------------ */

/** The 0G chain + public explorer, mirroring `[chain]` in proofagent.toml. */
export const CHAIN = {
  /** 0G Aristotle chain id (design appendix). */
  id: 16661,
  name: "0G Aristotle",
  /** Galileo testnet chain id -- where live legs run (design §8: testnet/dev only). */
  testnet: 16602,
  /** The public explorer (design appendix: chainscan.0g.ai). Viewers confirm the chain themselves. */
  explorer: "https://chainscan.0g.ai",
} as const;

/**
 * The on-chain spend cap, mirroring `[mandate]` in proofagent.toml. `registryAddress` is empty until the
 * MandateRegistry is confirmed/deployed on-chain (design §8: claim only what's live). An empty address is
 * the HONEST "not yet deployed" signal -- the UI must not render a green "live on-chain" rails stamp while
 * it is empty.
 */
export const MANDATE = {
  /** Per-transaction cap, the public knob from the spine (`per_tx_cap = "2 USD"`). */
  perTxCapUsd: 2,
  /** Deployed registry address, or "" when not yet pinned on-chain (design §8). */
  registryAddress: "" as string,
} as const;

/**
 * The settlement corpus, mirroring `[verifier]` `corpus` in proofagent.toml. Empty until real,
 * already-settled txs are confirmed on-chain (design §6: "Demo against already-public settlements" /
 * §8: claim only what's live). While empty, the UI asserts NO `settled` -- the one live proof is the NEG
 * case below. The exact-integer tolerance band mirrors `[verifier.tolerance]` (15/100 -- design §3 #5).
 */
export const VERIFIER = {
  /** Count of real, already-settled txs pinned in the spine (0 until confirmed on-chain). */
  corpusSize: 0,
  /** Exact-integer tolerance band num/den (no float on the money path -- design §3 principle 5). */
  toleranceNum: 15,
  toleranceDen: 100,
} as const;

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
 * Build the three stamps from the spine-derived constants, honestly (design §2, §7, §8).
 *
 * - **Brain** -> `PENDING` (design §7: TEE attestation is the *Depth* bracket; at MVP the brain is a hosted
 *   LLM, honestly labelled). NEVER green -- the MVP cannot back a TEE-attested brain on screen.
 * - **Rails** -> `ARMED` while `MANDATE.registryAddress` is empty (design §8: the registry is not yet pinned
 *   on-chain), or `LIVE` once an address is pinned (then the explorer link lets a viewer confirm the cap
 *   themselves -- design §4). The cap is enforced in code pre-broadcast either way (design §5 kill-switch).
 * - **Settlement** -> `LIVE` (READY): the independent verifier and its NEG case are runnable on screen right
 *   now. It asserts NO `settled` while the corpus is empty (design §6/§8); the live proof is the NEG case.
 */
export function buildStamps(): readonly [Stamp, Stamp, Stamp] {
  const railsLive = MANDATE.registryAddress.length > 0;
  return [
    {
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
        ? `On-chain MandateRegistry checkTransfer() rejects any spend over the $${MANDATE.perTxCapUsd} ` +
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
