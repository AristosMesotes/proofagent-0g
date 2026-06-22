/**
 * proofs.test.ts -- the honesty invariants of the demo model, as node:test cases.
 *
 * These lock the design's honesty doctrine (§8 "claim only what is live", §3 #2/#3 verdict monopoly /
 * never fabricate, §2 the NEG case) so a future edit cannot silently light a green brain stamp or make the
 * NEG case fabricate a `settled`.
 *
 * Pure logic only (no DOM) -- runs under `node --test` against the compiled `dist/` ESM, fully offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStamps,
  runNegCase,
  FABRICATED_HASH,
  STAMP_LEVEL,
  VERDICT,
  type Stamp,
} from "./proofs.js";

/** Find the one stamp for a proof, or throw (also narrows the type for the strict compiler). */
function stampFor(proof: Stamp["proof"]): Stamp {
  const found = buildStamps().find((s) => s.proof === proof);
  if (found === undefined) {
    throw new Error(`missing stamp for proof: ${proof}`);
  }
  return found;
}

test("brain stamp is NEVER green at MVP (design §7/§8 -- TEE is a Phase-2 Depth bracket)", () => {
  const brain = stampFor("brain");
  assert.notEqual(brain.level, STAMP_LEVEL.LIVE, "brain must not render green");
  assert.equal(brain.level, STAMP_LEVEL.PENDING, "brain is pending / Phase-2");
  assert.equal(brain.bracket, "Depth", "brain is the Depth bracket, not MVP");
});

test("the three proofs are present exactly once each (design §2)", () => {
  const proofs = buildStamps().map((s) => s.proof);
  assert.deepEqual([...proofs].sort(), ["brain", "rails", "settlement"]);
});

test("rails is ARMED (not green) while no registry address is pinned (design §8)", () => {
  // The spine's MANDATE.registryAddress is "" in this MVP -> ARMED, never a green on-chain claim.
  const rails = stampFor("rails");
  assert.notEqual(rails.level, STAMP_LEVEL.LIVE, "rails must not be green without an on-chain address");
  assert.equal(rails.level, STAMP_LEVEL.ARMED);
});

test("settlement stamp asserts NO settled while the corpus is empty (design §6/§8)", () => {
  const settlement = stampFor("settlement");
  // It is LIVE (the verifier + NEG case are runnable) but its claim must not assert a `settled`.
  assert.equal(settlement.level, STAMP_LEVEL.LIVE);
  assert.ok(
    !settlement.claim.toLowerCase().includes("settled,"),
    "the settlement stamp must not assert a settlement while the corpus is empty",
  );
});

test("the NEG case ALWAYS returns `unverified`, never `settled` (design §2/§3 #3)", () => {
  const result = runNegCase(FABRICATED_HASH);
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.notEqual(result.verdict, VERDICT.SETTLED);
  assert.equal(result.recorded, false, "a fabricated hash is off-record");
  assert.match(result.reproduceCommand, /verify-tx/, "shows the real verifier CLI to reproduce");
});

test("the NEG case is faithful across well-formed fabricated hashes (off-record -> unverified)", () => {
  for (const h of [
    "0x" + "0".repeat(64),
    "0x" + "f".repeat(64),
    "0x" + "a1b2c3d4".repeat(8),
  ]) {
    assert.equal(runNegCase(h).verdict, VERDICT.UNVERIFIED, `off-record ${h} must be unverified`);
  }
});

test("a non-hash input is a USAGE error, not a verdict (mirrors the verifier binary)", () => {
  assert.throws(() => runNegCase("not-a-hash"), RangeError);
  assert.throws(() => runNegCase("0x1234"), RangeError, "too short is a usage error");
  assert.throws(() => runNegCase(""), RangeError);
});

test("the fabricated hash constant is a well-formed 32-byte hash (so it exercises adjudication, not the shape gate)", () => {
  assert.match(FABRICATED_HASH, /^0x[0-9a-fA-F]{64}$/);
});
