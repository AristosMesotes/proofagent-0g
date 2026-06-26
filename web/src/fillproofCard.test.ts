/**
 * fillproofCard.test.ts -- the decision logic of the "Fill-Proof Oracle" card, locked to mirror the Rust
 * `adjudicate_fill` (verifier/src/fillproof.rs) EXACTLY.
 *
 * These prove the card's pure adjudication so a future edit cannot silently:
 *   - pay a HOLLOW fill (a claimed payment the chain says never moved) -- the killer demo,
 *   - RELEASE on anything but a chain-confirmed, in-band `settled` (fail-closed, never fabricate),
 *   - drift the exact-integer 15/100 band (a float on the money path), or
 *   - release an unreadable fill the verifier could not confirm.
 *
 * Pure logic only (no DOM, no network) -- runs under `node --test` against the compiled `dist/` ESM, fully
 * offline. The DOM assembly is exercised by the build (`tsc`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { adjudicateFillUi, fillDecisionFor, FILL_DECISION } from "./fillproofCard.js";
import { VERDICT } from "./proofs.js";

/** The canonical demo band (`proofagent.toml [verifier.tolerance]`): 15%. */
const NUM = 15n;
const DEN = 100n;
/** The fixed claimed fill the scenarios check against the chain. */
const CLAIMED = 1_000_000n;

/* ------------------------------------------------------------------------------------------------ *
 * The three scenario buttons -- the killer moments the card default-loads / surfaces.
 * ------------------------------------------------------------------------------------------------ */

test("HONEST fill (claimed === observed): SETTLED → RELEASE (the only on-chain green path)", () => {
  const r = adjudicateFillUi(CLAIMED, CLAIMED, NUM, DEN);
  assert.equal(r.verdict, VERDICT.SETTLED);
  assert.equal(r.decision, FILL_DECISION.RELEASE);
});

test("HOLLOW fill (claimed 1,000,000 / observed 0): HOLLOW → BLOCK (the killer — a hash-only oracle would pay)", () => {
  const r = adjudicateFillUi(CLAIMED, 0n, NUM, DEN);
  assert.equal(r.verdict, VERDICT.HOLLOW, "claimed payment, moved nothing -> hollow");
  assert.equal(r.decision, FILL_DECISION.BLOCK, "a hollow fill is NEVER released");
  // It is structurally NOT settled -- never a fabricated release.
  assert.notEqual(r.verdict, VERDICT.SETTLED);
});

test("UNREADABLE fill (observed === null): UNVERIFIED → BLOCK (fail-closed, never fabricate)", () => {
  const r = adjudicateFillUi(CLAIMED, null, NUM, DEN);
  assert.equal(r.verdict, VERDICT.UNVERIFIED);
  assert.equal(r.decision, FILL_DECISION.BLOCK);
  assert.equal(r.observed, null);
});

/* ------------------------------------------------------------------------------------------------ *
 * The exact-integer 15/100 band -- the boundary is INCLUSIVE; one minor unit over is a loud mismatch.
 * ------------------------------------------------------------------------------------------------ */

test("within-band under-delivery still RELEASES (|1,000,000 - 900,000| = 100,000 <= floor(1,000,000*15/100) = 150,000)", () => {
  const r = adjudicateFillUi(CLAIMED, 900_000n, NUM, DEN);
  assert.equal(r.verdict, VERDICT.SETTLED);
  assert.equal(r.decision, FILL_DECISION.RELEASE);
});

test("the band boundary is INCLUSIVE: exactly floor(claimed*15/100) off is still SETTLED → RELEASE", () => {
  // band = floor(1,000,000 * 15 / 100) = 150,000. observed = 850,000 -> |delta| = 150,000 == band -> settled.
  const onBand = adjudicateFillUi(CLAIMED, 850_000n, NUM, DEN);
  assert.equal(onBand.verdict, VERDICT.SETTLED, "exactly on the band is in-band (<=)");
  assert.equal(onBand.decision, FILL_DECISION.RELEASE);
  // One minor unit further out (849,999 -> |delta| = 150,001 > band) -> mismatch -> BLOCK.
  const overBand = adjudicateFillUi(CLAIMED, 849_999n, NUM, DEN);
  assert.equal(overBand.verdict, VERDICT.MISMATCH, "one unit past the band is a loud mismatch");
  assert.equal(overBand.decision, FILL_DECISION.BLOCK);
});

test("out-of-band over-delivery is also a MISMATCH → BLOCK (the wrong amount, both directions)", () => {
  // observed far ABOVE the claim, outside the band -> mismatch (delivered, but the wrong amount).
  const r = adjudicateFillUi(CLAIMED, 2_000_000n, NUM, DEN);
  assert.equal(r.verdict, VERDICT.MISMATCH);
  assert.equal(r.decision, FILL_DECISION.BLOCK);
});

test("the (0, 0) no-op resolves to HOLLOW → BLOCK (claimed nothing, got nothing)", () => {
  const r = adjudicateFillUi(0n, 0n, NUM, DEN);
  assert.equal(r.verdict, VERDICT.HOLLOW);
  assert.equal(r.decision, FILL_DECISION.BLOCK);
});

/* ------------------------------------------------------------------------------------------------ *
 * The decision is derived PURELY from the verdict -- RELEASE only on settled, BLOCK on every other.
 * ------------------------------------------------------------------------------------------------ */

test("fillDecisionFor RELEASES only on `settled`; hollow/mismatch/unverified all BLOCK", () => {
  assert.equal(fillDecisionFor(VERDICT.SETTLED), FILL_DECISION.RELEASE);
  assert.equal(fillDecisionFor(VERDICT.HOLLOW), FILL_DECISION.BLOCK);
  assert.equal(fillDecisionFor(VERDICT.MISMATCH), FILL_DECISION.BLOCK);
  assert.equal(fillDecisionFor(VERDICT.UNVERIFIED), FILL_DECISION.BLOCK);
});

test("an ill-formed tolerance band is a LOUD usage error, never a fabricated settle", () => {
  assert.throws(() => adjudicateFillUi(CLAIMED, CLAIMED, 15n, 0n), RangeError);
  assert.throws(() => adjudicateFillUi(CLAIMED, CLAIMED, -1n, 100n), RangeError);
});

test("adjudicate_fill is deterministic -- same inputs, same decision, every time", () => {
  for (let i = 0; i < 8; i++) {
    assert.equal(adjudicateFillUi(CLAIMED, CLAIMED, NUM, DEN).decision, FILL_DECISION.RELEASE);
    assert.equal(adjudicateFillUi(CLAIMED, 0n, NUM, DEN).verdict, VERDICT.HOLLOW);
    assert.equal(adjudicateFillUi(CLAIMED, null, NUM, DEN).decision, FILL_DECISION.BLOCK);
  }
});

test("the default band (omitted args) is the spine's 15/100 -- the same as the explicit band", () => {
  // The card calls adjudicateFillUi with the spine default; prove the default matches the explicit 15/100.
  assert.deepEqual(adjudicateFillUi(CLAIMED, 0n), adjudicateFillUi(CLAIMED, 0n, NUM, DEN));
  assert.deepEqual(adjudicateFillUi(CLAIMED, CLAIMED), adjudicateFillUi(CLAIMED, CLAIMED, NUM, DEN));
});
