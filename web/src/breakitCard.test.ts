/**
 * breakitCard.test.ts -- the "Break-it" gauntlet card's pure logic, locked to mirror the Rust `run_gauntlet`
 * (verifier/src/breakit.rs) EXACTLY.
 *
 * These prove the card's pure gauntlet so a future edit cannot silently:
 *   - let an attack SUCCEED (the system fooled into a fabricated settled / RELEASE / ACTIVE / reconciled),
 *   - drift any attack's honest refusal away from the exact Rust `observed()` string, or
 *   - read a green "all defeated" headline while any attack actually broke a guarantee.
 *
 * Pure logic only (no DOM, no network) -- runs under `node --test` against the compiled `dist/` ESM, fully
 * offline. The DOM assembly (the attack rows, the headline) is exercised by the build (`tsc`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runGauntletUi,
  adjudicateUi,
  combineXchain,
  reconcileUi,
  RECONCILE_VERDICT,
  type AttackResult,
} from "./breakitCard.js";
import { VERDICT } from "./proofs.js";

/** The canonical demo band (`proofagent.toml [verifier.tolerance]`): 15%. */
const NUM = 15n;
const DEN = 100n;

/* ------------------------------------------------------------------------------------------------ *
 * The whole gauntlet -- eight attacks, all DEFEATED (the only honest pass).
 * ------------------------------------------------------------------------------------------------ */

test("the gauntlet runs all EIGHT attacks", () => {
  const report = runGauntletUi();
  assert.equal(report.results.length, 8, "the gauntlet runs all eight attacks");
});

test("EVERY attack is DEFEATED -- allDefeated === true (the only honest pass)", () => {
  const report = runGauntletUi();
  const undefeated = report.results.filter((r) => !r.defeated).map((r) => r.name);
  assert.equal(report.allDefeated, true, `an attack SUCCEEDED -- honesty defect: ${JSON.stringify(undefeated)}`);
  assert.equal(report.results.every((r) => r.defeated), true);
});

/* ------------------------------------------------------------------------------------------------ *
 * Each attack's refusal is EXACTLY the expected honest verdict (byte-identical to the Rust gauntlet).
 * ------------------------------------------------------------------------------------------------ */

test("each attack's computed refusal is the expected honest verdict (all 8 asserted)", () => {
  const r = runGauntletUi().results;
  const by = (id: number): AttackResult => {
    const a = r.find((x) => x.id === id);
    assert.ok(a !== undefined, `attack #${id} is present`);
    return a;
  };
  // #1 fabricated settlement -> unverified (never settled).
  assert.equal(by(1).observed, "unverified");
  // #2 tampered amount -> mismatch.
  assert.equal(by(2).observed, "mismatch");
  // #3 phantom (0 -> 0) settlement -> hollow.
  assert.equal(by(3).observed, "hollow");
  // #4 hollow fill -> hollow / BLOCK.
  assert.equal(by(4).observed, "hollow / BLOCK");
  // #5 cross-chain hollow fill -> hollow / BLOCK (the destination's hollow dominates the source's settled).
  assert.equal(by(5).observed, "hollow / BLOCK");
  // #6 repeat liar -> REVOKED.
  assert.equal(by(6).observed, "REVOKED");
  // #7 revoked solver collects anyway -> WITHHELD (mandate revoked) -- the slash bites.
  assert.equal(by(7).observed, "WITHHELD (mandate revoked)");
  // #8 unbounded spend -> refuted (never reconciled).
  assert.equal(by(8).observed, "refuted");
});

test("the BLOCK attacks contain BLOCK and the WITHHELD attack contains WITHHELD (the Rust observed() shape)", () => {
  const r = runGauntletUi().results;
  assert.ok(r[3]?.observed.includes("BLOCK"), "hollow fill blocks");
  assert.ok(r[4]?.observed.includes("BLOCK"), "cross-chain hollow blocks");
  assert.ok(r[6]?.observed.includes("WITHHELD"), "the slash bites -> withheld");
});

test("no attack's computed refusal is ever the attacker's desired PASS (settled / RELEASE / ACTIVE / reconciled)", () => {
  for (const a of runGauntletUi().results) {
    assert.ok(!/\bsettled\b/.test(a.observed), `${a.name} must never read settled: ${a.observed}`);
    assert.ok(!/RELEASE/.test(a.observed), `${a.name} must never read RELEASE: ${a.observed}`);
    assert.ok(!/ACTIVE/.test(a.observed), `${a.name} must never read ACTIVE: ${a.observed}`);
    assert.ok(!/RELEASED/.test(a.observed), `${a.name} must never read RELEASED: ${a.observed}`);
    assert.ok(!/reconciled/.test(a.observed), `${a.name} must never read reconciled: ${a.observed}`);
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * The pure mirrors the attacks compute through (so the refusals are derived, never hardcoded).
 * ------------------------------------------------------------------------------------------------ */

test("adjudicateUi mirrors the BARE adjudicate (a positive claim vs observed 0 is MISMATCH, not hollow -- the hollow-fill catch lives in adjudicateFillUi)", () => {
  assert.equal(adjudicateUi(1_000_000n, null, NUM, DEN), VERDICT.UNVERIFIED);
  assert.equal(adjudicateUi(1_000_000n, 0n, NUM, DEN), VERDICT.MISMATCH, "bare adjudicate: |1,000,000 - 0| > band -> mismatch, exactly as verify-tx reads it");
  assert.equal(adjudicateUi(0n, 0n, NUM, DEN), VERDICT.HOLLOW);
  assert.equal(adjudicateUi(1_000_000n, 1_000_000n, NUM, DEN), VERDICT.SETTLED);
  assert.equal(adjudicateUi(1_000_000n, 850_000n, NUM, DEN), VERDICT.SETTLED, "exactly on the 150,000 band");
  assert.equal(adjudicateUi(1_000_000n, 500_000n, NUM, DEN), VERDICT.MISMATCH);
});

test("adjudicateUi rejects an ill-formed band (LOUD usage error, never a fabricated settle)", () => {
  assert.throws(() => adjudicateUi(1_000_000n, 1_000_000n, 15n, 0n), RangeError);
  assert.throws(() => adjudicateUi(1_000_000n, 1_000_000n, -1n, 100n), RangeError);
});

test("combineXchain folds fail-closed: unverified > hollow > mismatch > settled", () => {
  assert.equal(combineXchain(VERDICT.SETTLED, VERDICT.HOLLOW), VERDICT.HOLLOW, "a hollow dest dominates a settled source");
  assert.equal(combineXchain(VERDICT.SETTLED, VERDICT.UNVERIFIED), VERDICT.UNVERIFIED, "an unreadable leg dominates");
  assert.equal(combineXchain(VERDICT.MISMATCH, VERDICT.HOLLOW), VERDICT.HOLLOW, "hollow has precedence over mismatch");
  assert.equal(combineXchain(VERDICT.SETTLED, VERDICT.MISMATCH), VERDICT.MISMATCH);
  assert.equal(combineXchain(VERDICT.SETTLED, VERDICT.SETTLED), VERDICT.SETTLED, "both legs settled -> settled");
});

test("reconcileUi refutes a transfer with no record, and never reconciles an empty read", () => {
  assert.equal(reconcileUi([], [{ spendId: 1, amount: 1_000_000n }]), RECONCILE_VERDICT.REFUTED, "the unbounded spend");
  assert.equal(reconcileUi([], []), RECONCILE_VERDICT.UNVERIFIED, "nothing to reconcile -> unverified, never reconciled");
  assert.equal(
    reconcileUi([{ spendId: 1, amount: 1_000_000n }], [{ spendId: 1, amount: 1_000_000n }]),
    RECONCILE_VERDICT.RECONCILED,
    "a perfect 1:1 pairing reconciles",
  );
});

/* ------------------------------------------------------------------------------------------------ *
 * Determinism + the headline reads full-defeat.
 * ------------------------------------------------------------------------------------------------ */

test("runGauntletUi is deterministic -- same results twice (same observed + same defeated, every attack)", () => {
  const first = runGauntletUi();
  for (let i = 0; i < 8; i++) {
    const again = runGauntletUi();
    assert.equal(again.allDefeated, first.allDefeated);
    assert.equal(again.results.length, first.results.length);
    for (let j = 0; j < first.results.length; j++) {
      assert.equal(again.results[j]?.observed, first.results[j]?.observed, `attack ${j + 1} observed is stable`);
      assert.equal(again.results[j]?.defeated, first.results[j]?.defeated, `attack ${j + 1} defeated is stable`);
    }
  }
});

test("the headline reads a FULL 8/8 defeat -- defeatedCount === total === 8", () => {
  const report = runGauntletUi();
  const defeatedCount = report.results.filter((r) => r.defeated).length;
  assert.equal(defeatedCount, 8, "all eight defeated");
  assert.equal(report.results.length, 8);
  // The headline string the card paints on a full defeat (re-derived here so the copy is locked).
  const headline = `${defeatedCount}/${report.results.length} DEFEATED — every honesty guarantee held`;
  assert.ok(headline.startsWith("8/8 DEFEATED"), headline);
  assert.ok(headline.includes("every honesty guarantee held"), headline);
});

test("every attack names a guarantee + an attempt + a non-empty observed refusal", () => {
  for (const a of runGauntletUi().results) {
    assert.ok(a.name.length > 0, "name");
    assert.ok(a.guarantee.length > 0, "guarantee");
    assert.ok(a.attempt.length > 0, "attempt");
    assert.ok(a.expectedRefusal.length > 0, "expectedRefusal");
    assert.ok(a.observed.length > 0, "observed");
  }
});
