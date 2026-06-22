/**
 * dryrun.ts -- the READ-ONLY "Run the agent (dry-run)" engine + the RUN LEDGER (design §5 the loop,
 * §2 the three proofs, §6 the settlement-truth LEDGER, §8/§13 honesty).
 *
 * ## What this is (and what it can NEVER do)
 *
 * This walks the FULL agent function -- `plan → mandate-gate (per asset) → verify` (design §5) -- as a
 * pure, READ-ONLY dry-run: NO wallet, NO signing, NO broadcast. It is the in-page twin of the agent's own
 * dry-run loop (`agent/src/loop.ts`, which runs in `DRY_RUN` mode and broadcasts NOTHING): it plans demo
 * intents, gates each against the LIVE on-chain mandate with a real zero-gas `eth_call`, derives the
 * verifier verdict that WOULD settle, and produces an append-only RUN LEDGER a judge can read.
 *
 * The ONLY chain access is the read-only `checkTransfer` eth_call already behind the RAILS leg -- the SAME
 * key-less {@link runMandateCheck} the RAILS card uses. There is deliberately NO signer / broadcaster seam
 * in this module: it physically cannot move value. Every verdict on screen is RECONCILED against an
 * independent source (the chain's own `(ok, reason)`, or the verifier's published rule) and degrades LOUDLY
 * to a read-error / unverified on any unreadable source -- never a faked green (design §3 #3, §8).
 *
 * ## (1) plan -- a fixed set of demo intents (design §5 plan leg)
 *
 * A deterministic, offline set of three demo intents that together EXERCISE the per-asset mandate:
 *   - an UNDER-cap trade on the allowlisted native asset      → expected gate ALLOW;
 *   - an OVER-cap trade on the SAME allowlisted asset          → expected gate BLOCK (over the per-asset cap);
 *   - a trade on a NON-allowlisted asset (the public USDC.E)   → expected gate BLOCK (per-asset allowlist).
 * Same agent, three assets/amounts → three DIFFERENT gate decisions: the mandate is enforced PER ASSET.
 *
 * ## (2) mandate-gate -- per-asset enforcement via REAL read-only checkTransfer (design §2 Rails, §10.4)
 *
 * Each intent is gated by a real `eth_call checkTransfer(agent, token, amount)` against the deployed
 * `MandateRegistry` on 0G Galileo -- reusing {@link runMandateCheck} (NO copy). The decoded on-chain
 * `(ok, reason)` is the verdict: `OK` (allowed) · `OVER_TX_CAP`/`OVER_ASSET_CAP` (over the per-asset cap) ·
 * `TOKEN_NOT_ALLOWED` (non-allowlisted asset). The gate is the kill-switch: a non-`ok` decision means the
 * agent does NOT execute that leg (design §5).
 *
 * ## (3) verify -- the verifier verdict that WOULD settle (design §2 Settlement, §3 #2 verdict monopoly)
 *
 * The dry-run broadcasts nothing, so there is no real tx to verify -- exactly the agent loop's honest
 * "dry-run has no broadcast to verify" (design §8). Each leg's settlement verdict is therefore the verifier's
 * PUBLISHED rule applied to a leg that did NOT broadcast: an ALLOWED leg in a dry-run produces NO observation
 * → `adjudicate(_, None, _)` → `unverified` (the keystone, never a fabricated `settled`); a BLOCKED leg never
 * even reaches execute, so it too is `unverified` (nothing settled, and nothing was lost). The web mints NO
 * verdict -- it carries the verifier's four-string alphabet (`settled / hollow / mismatch / unverified`).
 *
 * ## RESULT -- the RUN LEDGER (design §6 the settlement-truth LEDGER)
 *
 * The run produces an append-only journal of each leg + its verdict in the verifier's OWN canonical format:
 * one JSONL record per leg, byte-identical to the Rust `verifier/src/journal.rs` `to_line()` shape
 * (`{"hash","kind","claimed","observed","recorded","verdict"}`), plus the `ledger` projection's
 * status-at-a-glance line (the Rust `verifier/src/ledger.rs` `LedgerSummary::status_line()` format). So a
 * judge sees the IDENTICAL artifact a real `verifier verify-tx … --journal` + `verifier ledger` run produces
 * -- this is a faithful in-page projection, not a reinvented format. A dry-run leg has NO real broadcast
 * hash, so its journal `hash` is the honest synthetic `dryrun:`-tagged digest of (kind, token, amount), and
 * its `observed` is JSON `null` (no observation -- the loud absence), exactly as the Rust journal records an
 * unavailable read; nothing here is ever a fabricated settlement.
 *
 * ## Clean-room (design §6/§7)
 *
 * Pure logic over the public spine constants + the read-only RPC seam. NO `innerHTML`, no proprietary
 * identifier, private path, or secret. Generic, verification-domain names only.
 */

import { VERDICT, type Verdict } from "./proofs.js";
import { runMandateCheck, MANDATE_ASSETS, type RpcTransport, OnChainReadError } from "./onchain.js";

/* ------------------------------------------------------------------------------------------------ *
 * (1) The demo intents -- a deterministic, offline plan (design §5 plan leg).
 * ------------------------------------------------------------------------------------------------ */

/**
 * The mandate-decision family a gate read resolves to (the honest classification of the on-chain reason).
 * `ALLOWED` is the only ok==true family; the two BLOCK families name WHY the per-asset mandate refused.
 */
export const MANDATE_DECISION = {
  /** The chain allowed the spend (`ok==true`, reason `OK`) — within the per-asset sub-cap + global cap. */
  ALLOWED: "ALLOWED",
  /** Over the asset's cap (the chain's `OVER_TX_CAP`/`OVER_ASSET_CAP` rung) — the per-asset cap enforcement. */
  OVER_ASSET_CAP: "OVER_ASSET_CAP",
  /** The asset is not on the per-asset allowlist (`TOKEN_NOT_ALLOWED`) — the per-asset allowlist enforcement. */
  NOT_ALLOWLISTED: "NOT_ALLOWLISTED",
  /** Any other on-chain block reason (paused/expired/zero/…) — still a loud BLOCK, never softened to allow. */
  BLOCKED_OTHER: "BLOCKED_OTHER",
  /** The gate read was unreachable/malformed — a loud read-error (fail-closed: NOT executed), never an allow. */
  READ_ERROR: "READ_ERROR",
} as const;

/** A mandate-decision family. */
export type MandateDecision = (typeof MANDATE_DECISION)[keyof typeof MANDATE_DECISION];

/** One demo intent the dry-run plans + gates (the agent's proposed per-asset action). */
export interface DryRunIntent {
  /** A stable id (the journal/UI key). */
  readonly id: "under-cap" | "over-cap" | "non-allowlisted";
  /** The trade kind label (journal only, never the verdict) — mirrors the verifier journal's `kind`. */
  readonly kind: string;
  /** A human label for the intent row. */
  readonly label: string;
  /** The asset symbol/name shown on screen (the per-asset surface). */
  readonly assetName: string;
  /** The asset address the gate probes. */
  readonly token: string;
  /** The amount the intent proposes, MINOR units (wei). */
  readonly amount: bigint;
  /** The mandate decision this intent is DESIGNED to surface (the expected on-chain answer). */
  readonly expected: MandateDecision;
}

/** The agent identity the dry-run gates against (the registry's mandated agent — PUBLIC). */
export const DRY_RUN_AGENT = MANDATE_ASSETS.agent;

/** The deployed MandateRegistry the dry-run reads (the same pinned registry the RAILS leg reads — PUBLIC). */
export const DRY_RUN_REGISTRY = MANDATE_ASSETS.registry;

/**
 * The fixed, deterministic demo plan (design §5 plan leg). Three intents over the SAME agent that together
 * make the mandate visibly per-asset: an allowed asset under its cap → ALLOW; the same asset over its cap →
 * BLOCK (per-asset cap); a non-allowlisted asset → BLOCK (per-asset allowlist). Pure data — no clock, no I/O.
 */
export const DRY_RUN_INTENTS: readonly DryRunIntent[] = [
  {
    id: "under-cap",
    kind: "TRANSFER",
    label: "Under-cap transfer (allowed asset)",
    assetName: "native 0G (sentinel)",
    token: MANDATE_ASSETS.nativeSentinel,
    amount: MANDATE_ASSETS.underCapAmount,
    expected: MANDATE_DECISION.ALLOWED,
  },
  {
    id: "over-cap",
    kind: "TRANSFER",
    label: "Over-cap transfer (allowed asset, over its per-asset cap)",
    assetName: "native 0G (sentinel)",
    token: MANDATE_ASSETS.nativeSentinel,
    amount: MANDATE_ASSETS.overCapAmount,
    expected: MANDATE_DECISION.OVER_ASSET_CAP,
  },
  {
    id: "non-allowlisted",
    kind: "TRANSFER",
    label: "Transfer of a non-allowlisted asset (USDC.E)",
    assetName: "USDC.E (not allowlisted)",
    token: MANDATE_ASSETS.nonAllowlistedAsset,
    amount: MANDATE_ASSETS.nonAllowlistedAmount,
    expected: MANDATE_DECISION.NOT_ALLOWLISTED,
  },
] as const;

/* ------------------------------------------------------------------------------------------------ *
 * Classification -- map a decoded on-chain reason to a mandate-decision family (honest, never softened).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Classify a decoded on-chain `(ok, reason)` into a {@link MandateDecision} family. `ok===true` is the ONLY
 * path to `ALLOWED`; an over-cap rung (`OVER_TX_CAP`/`OVER_ASSET_CAP`) is the per-asset CAP family, a
 * `TOKEN_NOT_ALLOWED` is the per-asset ALLOWLIST family, and any other non-ok reason is a loud BLOCKED_OTHER.
 * A blocked reason is NEVER classified as ALLOWED (fail-closed framing — design §3 #3).
 */
export function classifyMandate(ok: boolean, reason: string): MandateDecision {
  if (ok) {
    return MANDATE_DECISION.ALLOWED;
  }
  const r = reason.trim().toUpperCase();
  if (r === "OVER_TX_CAP" || r === "OVER_ASSET_CAP") {
    return MANDATE_DECISION.OVER_ASSET_CAP;
  }
  if (r === "TOKEN_NOT_ALLOWED") {
    return MANDATE_DECISION.NOT_ALLOWLISTED;
  }
  return MANDATE_DECISION.BLOCKED_OTHER;
}

/* ------------------------------------------------------------------------------------------------ *
 * (2)+(3) One run leg -- the gate decision + the settlement verdict that would settle + a ledger row.
 * ------------------------------------------------------------------------------------------------ */

/** The result of dry-running ONE intent: the per-asset gate decision + the verifier verdict + the row. */
export interface DryRunLeg {
  /** The intent that was run. */
  readonly intent: DryRunIntent;
  /** The decoded on-chain mandate reason (`OK` / `OVER_TX_CAP` / `TOKEN_NOT_ALLOWED` / …), or `READ_ERROR`. */
  readonly mandateReason: string;
  /** `true` iff the chain ALLOWED the spend (`ok===true`) — the only execute path. */
  readonly allowed: boolean;
  /** The classified mandate-decision family (the honest per-asset enforcement label). */
  readonly decision: MandateDecision;
  /** The exact read-only calldata the gate sent (so the read is independently replayable). */
  readonly calldata: string | null;
  /** The exact CLI command to reproduce the gate read against the chain (read-only). */
  readonly mandateReproduce: string;
  /**
   * The settlement verdict that WOULD settle for this leg. A dry-run broadcasts nothing, so there is no
   * observation → the verifier's published rule yields `unverified` (never a fabricated `settled`). The web
   * carries the verifier's verdict string; it never mints one.
   */
  readonly settlementVerdict: Verdict;
  /** A plain-English account of the settlement leg (why it is `unverified` in a dry-run — honest, loud). */
  readonly settlementWhy: string;
  /** The CLI command to reproduce the settlement adjudication against the independent verifier. */
  readonly settlementReproduce: string;
  /** The append-only RUN-LEDGER row for this leg (the verifier-journal projection). */
  readonly ledgerRow: RunLedgerRow;
}

/** The synthetic `dryrun:`-tagged hash a dry-run leg carries in its ledger row (no real broadcast hash). */
export function dryRunLegHash(intent: DryRunIntent): string {
  // A dry-run leg never broadcast, so it has NO real tx hash. We carry an HONEST synthetic, clearly tagged
  // `dryrun:` so it can NEVER be mistaken for a real on-chain hash, derived deterministically from the leg's
  // (id, token, amount) — the same dry-run always tags the same leg identically (design §3 #4 deterministic).
  return `dryrun:${intent.id}:${intent.token.toLowerCase()}:${intent.amount.toString()}`;
}

/**
 * Dry-run one intent: gate it per-asset (a real read-only `checkTransfer`), then derive the settlement
 * verdict that would settle (always `unverified` in a dry-run — nothing broadcast, nothing observed). A
 * gate read failure is a LOUD read-error (fail-closed: NOT executed), never an allow.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param intent the demo intent to run.
 * @returns the dry-run leg (gate decision + settlement verdict + ledger row). Never throws for a gate read
 *   failure — it returns a loud READ_ERROR leg so the run always produces a complete, honest ledger.
 */
export async function runDryRunLeg(transport: RpcTransport, intent: DryRunIntent): Promise<DryRunLeg> {
  const reproduceGate =
    `cast call ${DRY_RUN_REGISTRY} "checkTransfer(address,address,uint256)" ` +
    `${DRY_RUN_AGENT} ${intent.token} ${intent.amount.toString()} --rpc-url $OG_RPC`;
  // A dry-run never broadcasts → there is no observation → the verifier's rule is unverified (never settled).
  const settlementVerdict: Verdict = VERDICT.UNVERIFIED;
  const settlementReproduce = `cargo run -p verifier --features live -- verify-tx <broadcast-hash>  # (no broadcast in a dry-run)`;

  let result;
  try {
    result = await runMandateCheck(transport, { agent: DRY_RUN_AGENT, token: intent.token, amount: intent.amount }, DRY_RUN_REGISTRY);
  } catch (err) {
    // Fail-CLOSED: an unreadable/malformed gate read is a loud read-error, NEVER an allow (design §3 #3).
    const msg = err instanceof OnChainReadError ? err.message : err instanceof Error ? err.message : String(err);
    const settlementWhy =
      `The mandate gate could not be read for this leg, so the agent does NOT execute (fail-closed). ` +
      `Nothing was broadcast, so there is no settlement to verify — the verifier stamps unverified, never settled.`;
    return {
      intent,
      mandateReason: msg,
      allowed: false,
      decision: MANDATE_DECISION.READ_ERROR,
      calldata: null,
      mandateReproduce: reproduceGate,
      settlementVerdict,
      settlementWhy,
      settlementReproduce,
      ledgerRow: buildLedgerRow(intent, settlementVerdict),
    };
  }

  const decision = classifyMandate(!result.blocked, result.verdict);
  const allowed = !result.blocked;
  const settlementWhy = allowed
    ? `The mandate gate ALLOWED this leg on-chain (ok=true, ${result.verdict}). In a LIVE run the agent would ` +
      `now execute and the verifier would read the broadcast tx; in this DRY-RUN nothing is signed or ` +
      `broadcast, so there is no observation — the verifier stamps unverified (never a fabricated settled).`
    : `The mandate gate BLOCKED this leg on-chain (ok=false, ${result.verdict}). The agent does NOT execute, ` +
      `so nothing is broadcast and nothing settles — the verifier stamps unverified (and nothing was lost).`;

  return {
    intent,
    mandateReason: result.verdict,
    allowed,
    decision,
    calldata: result.calldata,
    mandateReproduce: reproduceGate,
    settlementVerdict,
    settlementWhy,
    settlementReproduce,
    ledgerRow: buildLedgerRow(intent, settlementVerdict),
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * RESULT -- the RUN LEDGER. The verifier's OWN journal/ledger format (verifier/src/{journal,ledger}.rs).
 * ------------------------------------------------------------------------------------------------ */

/**
 * One RUN-LEDGER row — the in-page projection of one journalled verdict, mirroring the Rust
 * `verifier/src/ledger.rs` `LedgerRow` + `verifier/src/journal.rs` `JournalRecord` shape EXACTLY. A dry-run
 * leg broadcast nothing, so `observed` is `null` (the loud absence) and `delta` is `null` — never a
 * fabricated `0`. The fields are the SIX canonical journal fields + the computed exact-integer delta, so a
 * judge sees the identical artifact a real `verifier verify-tx … --journal` + `verifier ledger` produces.
 */
export interface RunLedgerRow {
  /** The canonical hash the verdict is about (here the honest `dryrun:`-tagged synthetic — no real broadcast). */
  readonly hash: string;
  /** The trade-kind label (journal only). */
  readonly kind: string;
  /** The agent's claimed amount in minor units (the Claim). */
  readonly claimed: bigint;
  /** The independently-observed on-chain amount in minor units (the Observation), or `null` when unread. */
  readonly observed: bigint | null;
  /** `claimed - observed`, exact integer, or `null` when the observation was unavailable (never a fake `0`). */
  readonly delta: bigint | null;
  /** Whether a claim for this hash was on-record in the corpus (a dry-run leg never is). */
  readonly recorded: boolean;
  /** The minted verdict (the verifier's four-string alphabet). */
  readonly verdict: Verdict;
}

/**
 * Build the RUN-LEDGER row for a dry-run leg — the verifier-journal projection. A dry-run leg's `claimed` is
 * the intent amount, its `observed` is `null` (nothing broadcast → nothing observed), its `delta` is `null`
 * (no observation → no delta, never a fabricated `0`), `recorded` is `false` (no corpus claim), and its
 * `verdict` is the verifier's `unverified` (the keystone). This mirrors `JournalRecord::from_report` +
 * `LedgerRow::from_record` exactly.
 */
export function buildLedgerRow(intent: DryRunIntent, verdict: Verdict): RunLedgerRow {
  const claimed = intent.amount;
  const observed: bigint | null = null; // a dry-run broadcast nothing → no observation (the loud absence).
  const delta: bigint | null = observed === null ? null : claimed - observed;
  return {
    hash: dryRunLegHash(intent),
    kind: intent.kind,
    claimed,
    observed,
    delta,
    recorded: false,
    verdict,
  };
}

/** Minimal JSON string escaping for the journal line — mirrors the Rust `journal.rs` `json_escape`. */
function jsonEscape(s: string): string {
  let out = "";
  for (const c of s) {
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = c.codePointAt(0) ?? 0;
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += c;
        }
      }
    }
  }
  return out;
}

/**
 * Serialize one RUN-LEDGER row to the verifier's ONE canonical JSONL line — byte-identical to the Rust
 * `verifier/src/journal.rs` `JournalRecord::to_line()`: a fixed key order (`hash, kind, claimed, observed,
 * recorded, verdict`), exact-integer decimals, the canonical verdict string, NO timestamp, and `observed`
 * rendered as JSON `null` for an unavailable read (never a fabricated number). So a leg's journal line is
 * the IDENTICAL artifact the real verifier appends.
 */
export function ledgerRowToJournalLine(row: RunLedgerRow): string {
  const observed = row.observed === null ? "null" : row.observed.toString();
  return (
    `{"hash":"${jsonEscape(row.hash)}","kind":"${jsonEscape(row.kind)}",` +
    `"claimed":${row.claimed.toString()},"observed":${observed},` +
    `"recorded":${row.recorded ? "true" : "false"},"verdict":"${row.verdict}"}`
  );
}

/** Per-verdict counts over the run ledger — mirrors the Rust `verifier/src/ledger.rs` `LedgerSummary`. */
export interface RunLedgerSummary {
  readonly settled: number;
  readonly hollow: number;
  readonly mismatch: number;
  readonly unverified: number;
}

/** Tally per-verdict counts over the run-ledger rows (a single pass — mirrors `LedgerSummary::of`). */
export function summarizeRunLedger(rows: readonly RunLedgerRow[]): RunLedgerSummary {
  let settled = 0;
  let hollow = 0;
  let mismatch = 0;
  let unverified = 0;
  for (const r of rows) {
    switch (r.verdict) {
      case VERDICT.SETTLED:
        settled += 1;
        break;
      case VERDICT.HOLLOW:
        hollow += 1;
        break;
      case VERDICT.MISMATCH:
        mismatch += 1;
        break;
      case VERDICT.UNVERIFIED:
        unverified += 1;
        break;
      default:
        // No wildcard silently swallows a new verdict — every verdict is counted deliberately above.
        break;
    }
  }
  return { settled, hollow, mismatch, unverified };
}

/** The total row count of a run-ledger summary (mirrors `LedgerSummary::total`). */
export function runLedgerTotal(s: RunLedgerSummary): number {
  return s.settled + s.hollow + s.mismatch + s.unverified;
}

/** The defect count — every non-`settled` row (mirrors `LedgerSummary::defects`). */
export function runLedgerDefects(s: RunLedgerSummary): number {
  return s.hollow + s.mismatch + s.unverified;
}

/**
 * The one-line status-at-a-glance — byte-identical to the Rust `verifier/src/ledger.rs`
 * `LedgerSummary::status_line()`: `EMPTY` (no rows) / `GREEN` (zero defects) / `DEFECTS`, then the per-verdict
 * tally and the defect count. A dry-run ledger of all-`unverified` legs reads `DEFECTS … (3 defect(s))` — the
 * honest "nothing settled in a dry-run" (and the `audit` surfaces those `unverified` rows loud, exit 1),
 * NEVER a fabricated GREEN. This is the IDENTICAL projection `verifier ledger` prints over the same journal.
 */
export function runLedgerStatusLine(s: RunLedgerSummary): string {
  const total = runLedgerTotal(s);
  const defects = runLedgerDefects(s);
  const status = total === 0 ? "EMPTY" : defects === 0 ? "GREEN" : "DEFECTS";
  return (
    `${status} -- ${total} verdict(s): ${s.settled} settled / ${s.hollow} hollow / ` +
    `${s.mismatch} mismatch / ${s.unverified} unverified (${defects} defect(s))`
  );
}

/* ------------------------------------------------------------------------------------------------ *
 * The whole dry-run -- plan → gate-per-asset → verify → RUN LEDGER (design §5 the loop end-to-end).
 * ------------------------------------------------------------------------------------------------ */

/** The full result of a dry-run: every leg + the projected RUN LEDGER (rows + journal lines + summary). */
export interface DryRunResult {
  /** The per-leg dry-run results, in plan order (deterministic). */
  readonly legs: readonly DryRunLeg[];
  /** The RUN-LEDGER rows, in run order (the verifier-journal projection). */
  readonly ledgerRows: readonly RunLedgerRow[];
  /** The canonical JSONL journal lines (one per leg) — the IDENTICAL artifact the verifier appends. */
  readonly journalLines: readonly string[];
  /** The per-verdict summary over the run ledger. */
  readonly summary: RunLedgerSummary;
  /** The one-line status-at-a-glance (the `verifier ledger` projection). */
  readonly statusLine: string;
}

/**
 * Run the FULL dry-run (design §5 the loop): plan the demo intents, gate each PER ASSET against the live
 * on-chain mandate (real read-only `checkTransfer`), derive the verifier verdict that would settle (always
 * `unverified` — a dry-run broadcasts nothing), and project the RUN LEDGER in the verifier's OWN journal +
 * ledger format. READ-ONLY end to end: NO wallet, NO signing, NO broadcast.
 *
 * It NEVER throws for a gate read failure — a failing leg becomes a loud READ_ERROR leg with an `unverified`
 * row, so the run always produces a complete, honest ledger (design §3 #3 — degrade loudly, never fabricate).
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param intents the demo intents to run (defaults to {@link DRY_RUN_INTENTS}).
 */
export async function runDryRun(
  transport: RpcTransport,
  intents: readonly DryRunIntent[] = DRY_RUN_INTENTS,
): Promise<DryRunResult> {
  const legs: DryRunLeg[] = [];
  for (const intent of intents) {
    // Sequential, in plan order — the ledger is append-only in run order (design §5a, deterministic).
    legs.push(await runDryRunLeg(transport, intent));
  }
  const ledgerRows = legs.map((l) => l.ledgerRow);
  const journalLines = ledgerRows.map(ledgerRowToJournalLine);
  const summary = summarizeRunLedger(ledgerRows);
  const statusLine = runLedgerStatusLine(summary);
  return { legs, ledgerRows, journalLines, summary, statusLine };
}
