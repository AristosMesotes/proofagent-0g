/**
 * dryrun.test.ts -- the honesty invariants of the READ-ONLY "Run the agent (dry-run)" engine + RUN LEDGER.
 *
 * These lock the dry-run's load-bearing honesty rules (design §2/§3 #2/#3, §5, §6, §8) so a future edit
 * cannot silently:
 *   - turn a BLOCKED per-asset gate decision into an ALLOW, or coerce a read failure into an allow,
 *   - fabricate a `settled` in a dry-run (a dry-run broadcasts nothing → every leg is `unverified`),
 *   - drift the RUN LEDGER away from the verifier's OWN canonical journal/ledger byte-format,
 *   - paint an all-`unverified` dry-run ledger as a GREEN status line (it must read DEFECTS).
 *
 * Pure logic + an OFFLINE recorded-reply transport double (no DOM, no network) -- runs under
 * `node --test` against the compiled `dist/` ESM, fully offline. The recorded replies are exactly what the
 * deployed registry answers (EVIDENCE.md): the native sentinel under cap → (true, OK); over cap →
 * (false, OVER_TX_CAP); the non-allowlisted USDC.E → (false, TOKEN_NOT_ALLOWED).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runDryRun,
  runDryRunLeg,
  classifyMandate,
  buildLedgerRow,
  ledgerRowToJournalLine,
  summarizeRunLedger,
  runLedgerStatusLine,
  dryRunLegHash,
  DRY_RUN_INTENTS,
  MANDATE_DECISION,
  type DryRunIntent,
} from "./dryrun.js";
import { OnChainReadError, type RpcTransport } from "./onchain.js";
import { VERDICT } from "./proofs.js";

/* ------------------------------------------------------------------------------------------------ *
 * Offline transport double -- routes a recorded reply per (token, amount) calldata suffix.
 * ------------------------------------------------------------------------------------------------ */

/** A bytes32 ABI word of left-aligned ASCII for a reason tag (e.g. "OVER_TX_CAP"). */
function reasonWord(tag: string): string {
  let hex = "";
  for (let i = 0; i < tag.length; i++) {
    hex += tag.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.padEnd(64, "0");
}

const OK_REPLY = "0x" + "0".repeat(63) + "1" + reasonWord(""); // (true, OK)
const OVER_CAP_REPLY = "0x" + "0".repeat(64) + reasonWord("OVER_TX_CAP"); // (false, OVER_TX_CAP)
const NOT_ALLOWED_REPLY = "0x" + "0".repeat(64) + reasonWord("TOKEN_NOT_ALLOWED"); // (false, TOKEN_NOT_ALLOWED)

/**
 * A transport double that answers each leg's checkTransfer by the amount word in the calldata: the under-cap
 * amount → OK, the over-cap amount → OVER_TX_CAP, the non-allowlisted amount → TOKEN_NOT_ALLOWED. (The
 * non-allowlisted leg's amount equals the under-cap amount, so it is disambiguated by the token word.)
 */
function liveLikeTransport(): RpcTransport {
  return {
    async ethCall(_to: string, data: string): Promise<string> {
      const body = data.slice(2);
      // calldata = selector(8) + agent(64) + token(64) + amount(64). Read the token + amount words.
      const tokenWord = body.slice(8 + 64, 8 + 128).toLowerCase();
      const amountWord = body.slice(8 + 128, 8 + 192);
      const amount = BigInt("0x" + amountWord);
      // The non-allowlisted asset (USDC.E) is rejected on the allowlist rung BEFORE any cap.
      if (tokenWord.endsWith("1da6473e")) {
        return NOT_ALLOWED_REPLY;
      }
      if (amount > 2_000_000n) {
        return OVER_CAP_REPLY;
      }
      return OK_REPLY;
    },
    async getTransactionReceipt(): Promise<never> {
      throw new OnChainReadError("the dry-run never reads a receipt (it broadcasts nothing)");
    },
    async getTransactionByHash(): Promise<never> {
      throw new OnChainReadError("the dry-run never reads a tx body (it broadcasts nothing)");
    },
  };
}

/** A transport whose gate read always fails -- the fail-closed read-error path. */
function failingTransport(): RpcTransport {
  return {
    async ethCall(): Promise<string> {
      throw new OnChainReadError("recorded RPC failure (eth_call)");
    },
    async getTransactionReceipt(): Promise<never> {
      throw new OnChainReadError("n/a");
    },
    async getTransactionByHash(): Promise<never> {
      throw new OnChainReadError("n/a");
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * (1) plan -- the three demo intents exercise the per-asset mandate (allowed/over-cap/non-allowlisted).
 * ------------------------------------------------------------------------------------------------ */

test("the demo plan is three intents over ONE agent that exercise the mandate PER ASSET", () => {
  assert.equal(DRY_RUN_INTENTS.length, 3);
  const expected = DRY_RUN_INTENTS.map((i) => i.expected);
  assert.deepEqual(expected, [
    MANDATE_DECISION.ALLOWED,
    MANDATE_DECISION.OVER_ASSET_CAP,
    MANDATE_DECISION.NOT_ALLOWLISTED,
  ]);
  // Two distinct assets are probed (the allowlisted native sentinel + the non-allowlisted USDC.E).
  const tokens = new Set(DRY_RUN_INTENTS.map((i) => i.token.toLowerCase()));
  assert.equal(tokens.size, 2, "the plan probes a DIFFERENT asset to prove the allowlist rung");
});

/* ------------------------------------------------------------------------------------------------ *
 * classify -- ok==true is the ONLY allow; a block is never softened to allow.
 * ------------------------------------------------------------------------------------------------ */

test("classifyMandate: ok===true is the ONLY ALLOWED; every block reason classifies as a BLOCK family", () => {
  assert.equal(classifyMandate(true, "OK"), MANDATE_DECISION.ALLOWED);
  assert.equal(classifyMandate(false, "OVER_TX_CAP"), MANDATE_DECISION.OVER_ASSET_CAP);
  assert.equal(classifyMandate(false, "OVER_ASSET_CAP"), MANDATE_DECISION.OVER_ASSET_CAP);
  assert.equal(classifyMandate(false, "TOKEN_NOT_ALLOWED"), MANDATE_DECISION.NOT_ALLOWLISTED);
  assert.equal(classifyMandate(false, "PAUSED"), MANDATE_DECISION.BLOCKED_OTHER);
  // A blocked reason is NEVER classified ALLOWED, even with an OK-looking reason word.
  assert.notEqual(classifyMandate(false, "OK"), MANDATE_DECISION.ALLOWED);
});

/* ------------------------------------------------------------------------------------------------ *
 * (2) mandate-gate per asset -- the three legs surface the three different on-chain decisions.
 * ------------------------------------------------------------------------------------------------ */

test("each leg surfaces its real per-asset gate decision (ALLOWED / OVER cap / NOT allowlisted)", async () => {
  const transport = liveLikeTransport();
  const [under, over, nonAllow] = DRY_RUN_INTENTS as readonly DryRunIntent[];

  const underLeg = await runDryRunLeg(transport, under!);
  assert.equal(underLeg.allowed, true);
  assert.equal(underLeg.decision, MANDATE_DECISION.ALLOWED);
  assert.equal(underLeg.mandateReason, "OK");

  const overLeg = await runDryRunLeg(transport, over!);
  assert.equal(overLeg.allowed, false, "an over-cap leg is BLOCKED, never allowed");
  assert.equal(overLeg.decision, MANDATE_DECISION.OVER_ASSET_CAP);
  assert.equal(overLeg.mandateReason, "OVER_TX_CAP");

  const nonAllowLeg = await runDryRunLeg(transport, nonAllow!);
  assert.equal(nonAllowLeg.allowed, false, "a non-allowlisted asset is BLOCKED");
  assert.equal(nonAllowLeg.decision, MANDATE_DECISION.NOT_ALLOWLISTED);
  assert.equal(nonAllowLeg.mandateReason, "TOKEN_NOT_ALLOWED");
});

test("a gate READ FAILURE is fail-CLOSED: a loud read-error leg, NEVER an allow (design §3 #3)", async () => {
  const leg = await runDryRunLeg(failingTransport(), DRY_RUN_INTENTS[0]!);
  assert.equal(leg.allowed, false, "a read failure is NEVER an allow");
  assert.equal(leg.decision, MANDATE_DECISION.READ_ERROR);
  assert.equal(leg.calldata, null);
  // The leg still produces an honest unverified ledger row (the run always yields a complete ledger).
  assert.equal(leg.settlementVerdict, VERDICT.UNVERIFIED);
});

/* ------------------------------------------------------------------------------------------------ *
 * (3) verify -- a dry-run broadcasts NOTHING, so EVERY leg's settlement verdict is `unverified`.
 * ------------------------------------------------------------------------------------------------ */

test("EVERY dry-run leg's settlement verdict is `unverified` -- a dry-run broadcasts nothing, never a settled", async () => {
  const result = await runDryRun(liveLikeTransport());
  for (const leg of result.legs) {
    assert.equal(leg.settlementVerdict, VERDICT.UNVERIFIED, "nothing broadcast → nothing settled");
    assert.notEqual(leg.settlementVerdict, VERDICT.SETTLED, "NEVER a fabricated settled in a dry-run");
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * RESULT -- the RUN LEDGER is the verifier's OWN canonical journal/ledger byte-format.
 * ------------------------------------------------------------------------------------------------ */

test("the RUN-LEDGER journal line is BYTE-IDENTICAL to the verifier journal format (fixed key order, null observed, no timestamp)", () => {
  const intent = DRY_RUN_INTENTS[0]!; // the under-cap TRANSFER intent.
  const row = buildLedgerRow(intent, VERDICT.UNVERIFIED);
  const line = ledgerRowToJournalLine(row);
  // The exact shape verifier/src/journal.rs JournalRecord::to_line emits: the six keys in fixed order.
  const expected =
    `{"hash":"${dryRunLegHash(intent)}","kind":"TRANSFER","claimed":${intent.amount.toString()},` +
    `"observed":null,"recorded":false,"verdict":"unverified"}`;
  assert.equal(line, expected);
  // A dry-run leg's observed is JSON null (the loud absence), NEVER a fabricated 0.
  assert.match(line, /"observed":null/);
  assert.doesNotMatch(line, /"observed":0/);
  // No wall-clock field of any kind leaked into the canonical line (deterministic, design §3 #4).
  for (const clocky of ["timestamp", "time", "date", '"ts"', "when"]) {
    assert.ok(!line.includes(clocky), `the journal line must carry no wall-clock field (${clocky})`);
  }
});

test("the run ledger's status line MATCHES the verifier `LedgerSummary::status_line` format and reads DEFECTS for an all-unverified dry-run", async () => {
  const result = await runDryRun(liveLikeTransport());
  // 3 legs, all unverified → the verifier's projection: DEFECTS -- 3 verdict(s): 0 settled / 0 hollow / 0 mismatch / 3 unverified (3 defect(s)).
  assert.equal(
    result.statusLine,
    "DEFECTS -- 3 verdict(s): 0 settled / 0 hollow / 0 mismatch / 3 unverified (3 defect(s))",
  );
  // It is NEVER a fabricated GREEN -- an all-unverified dry-run is honestly DEFECTS (audit would exit 1).
  assert.ok(result.statusLine.startsWith("DEFECTS"));
  assert.ok(!result.statusLine.startsWith("GREEN"));
});

test("summarizeRunLedger partitions the run ledger exactly (every leg counted, total == 3)", () => {
  const rows = DRY_RUN_INTENTS.map((i) => buildLedgerRow(i, VERDICT.UNVERIFIED));
  const s = summarizeRunLedger(rows);
  assert.deepEqual(s, { settled: 0, hollow: 0, mismatch: 0, unverified: 3 });
});

test("runLedgerStatusLine: a (hypothetical) all-settled ledger reads GREEN; an empty ledger reads EMPTY", () => {
  // The status-line projection mirrors the Rust EMPTY/GREEN/DEFECTS branch exactly (format conformance).
  const settledRows = DRY_RUN_INTENTS.map((i) => buildLedgerRow(i, VERDICT.SETTLED));
  assert.equal(
    runLedgerStatusLine(summarizeRunLedger(settledRows)),
    "GREEN -- 3 verdict(s): 3 settled / 0 hollow / 0 mismatch / 0 unverified (0 defect(s))",
  );
  assert.equal(
    runLedgerStatusLine(summarizeRunLedger([])),
    "EMPTY -- 0 verdict(s): 0 settled / 0 hollow / 0 mismatch / 0 unverified (0 defect(s))",
  );
});

/* ------------------------------------------------------------------------------------------------ *
 * The synthetic dry-run hash is clearly tagged + deterministic (never mistakable for a real tx hash).
 * ------------------------------------------------------------------------------------------------ */

test("the dry-run leg hash is clearly `dryrun:`-tagged + deterministic (never a real 0x tx hash)", () => {
  const intent = DRY_RUN_INTENTS[0]!;
  const h = dryRunLegHash(intent);
  assert.ok(h.startsWith("dryrun:"), "a dry-run hash is clearly tagged, never a bare 0x hash");
  assert.doesNotMatch(h, /^0x[0-9a-f]{64}$/, "it can NEVER be mistaken for a real on-chain tx hash");
  // Deterministic: the same intent always tags the same hash (design §3 #4).
  assert.equal(dryRunLegHash(intent), h);
});

/* ------------------------------------------------------------------------------------------------ *
 * The whole run -- a complete, ordered ledger; the journal lines round-trip the rows.
 * ------------------------------------------------------------------------------------------------ */

test("runDryRun produces a complete RUN LEDGER: one journal line per leg, in plan order", async () => {
  const result = await runDryRun(liveLikeTransport());
  assert.equal(result.legs.length, 3);
  assert.equal(result.ledgerRows.length, 3);
  assert.equal(result.journalLines.length, 3);
  // The journal lines are exactly the per-row serializations, in order.
  for (let i = 0; i < result.ledgerRows.length; i++) {
    assert.equal(result.journalLines[i], ledgerRowToJournalLine(result.ledgerRows[i]!));
  }
  // Every row is the honest dry-run shape: claimed set, observed null, delta null, recorded false, unverified.
  for (const row of result.ledgerRows) {
    assert.equal(row.observed, null);
    assert.equal(row.delta, null);
    assert.equal(row.recorded, false);
    assert.equal(row.verdict, VERDICT.UNVERIFIED);
  }
});

test("runDryRun never throws on a gate failure -- it yields a complete ledger with loud read-error legs", async () => {
  const result = await runDryRun(failingTransport());
  assert.equal(result.legs.length, 3);
  for (const leg of result.legs) {
    assert.equal(leg.decision, MANDATE_DECISION.READ_ERROR);
    assert.equal(leg.allowed, false);
  }
  // Even an all-read-error run produces a complete, honest ledger (all unverified → DEFECTS).
  assert.ok(result.statusLine.startsWith("DEFECTS"));
});
