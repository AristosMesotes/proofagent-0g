/**
 * slasherCard.test.ts -- the decision logic of the "Slashable Mandate" card, locked to mirror the Rust
 * `slash` (verifier/src/slasher.rs) EXACTLY.
 *
 * These prove the card's pure projection so a future edit cannot silently:
 *   - fail to REVOKE after two dishonest verdicts in a row (the killer demo),
 *   - revoke an HONEST agent (a settled breaks the run) or on an unreadable gap (unverified breaks it),
 *   - mis-count the TRAILING streak (it counts backward from the most recent verdict, never the total), or
 *   - revoke at a misconfigured zero/negative threshold.
 *
 * Pure logic only (no DOM, no network) -- runs under `node --test` against the compiled `dist/` ESM, fully
 * offline. The DOM assembly (chips, standing, caption) is exercised by the build (`tsc`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { slashUi, MANDATE_STATUS, REVOKE_AFTER } from "./slasherCard.js";
import { VERDICT } from "./proofs.js";

const { SETTLED, HOLLOW, MISMATCH, UNVERIFIED } = VERDICT;

/* ------------------------------------------------------------------------------------------------ *
 * The design default: revoke_after = 2 (two dishonest verdicts in a row).
 * ------------------------------------------------------------------------------------------------ */

test("the revoke threshold is 2 (two dishonest verdicts in a row), per the design", () => {
  assert.equal(REVOKE_AFTER, 2);
});

/* ------------------------------------------------------------------------------------------------ *
 * The standing -- ACTIVE while the trailing dishonest streak is below 2; REVOKED once it reaches 2.
 * ------------------------------------------------------------------------------------------------ */

test("an EMPTY sequence is ACTIVE (the honest 'nothing dishonest yet' default, never a faked standing)", () => {
  const r = slashUi([]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE);
  assert.equal(r.consecutiveDishonest, 0);
  assert.equal(r.total, 0);
});

test("an all-honest sequence is ACTIVE with a zero streak", () => {
  const r = slashUi([SETTLED, SETTLED, SETTLED]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE);
  assert.equal(r.consecutiveDishonest, 0);
  assert.equal(r.settled, 3);
});

test("ONE hollow is below the threshold -> still ACTIVE (1/2)", () => {
  const r = slashUi([SETTLED, HOLLOW]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE, "1 < 2 -> still active");
  assert.equal(r.consecutiveDishonest, 1);
});

test("THE KILLER: two dishonest verdicts in a row -> REVOKED (the mandate auto-revokes)", () => {
  const r = slashUi([SETTLED, HOLLOW, HOLLOW]);
  assert.equal(r.status, MANDATE_STATUS.REVOKED, "2 consecutive dishonest -> REVOKED");
  assert.equal(r.consecutiveDishonest, 2);
});

test("a MIXED dishonest streak (hollow then mismatch) reaches the threshold -> REVOKED", () => {
  const r = slashUi([HOLLOW, MISMATCH]);
  assert.equal(r.status, MANDATE_STATUS.REVOKED);
  assert.equal(r.consecutiveDishonest, 2);
});

/* ------------------------------------------------------------------------------------------------ *
 * The trailing run -- a settled (honesty) OR an unverified (undetermined) BREAKS the streak.
 * ------------------------------------------------------------------------------------------------ */

test("a SETTLED in the middle breaks the run (hollow, settled, hollow -> trailing streak is just 1)", () => {
  const r = slashUi([HOLLOW, SETTLED, HOLLOW]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE, "an honest settlement breaks the dishonest run");
  assert.equal(r.consecutiveDishonest, 1);
});

test("a trailing SETTLED resets the streak to zero (two dishonest then redemption -> ACTIVE, streak 0)", () => {
  const r = slashUi([HOLLOW, HOLLOW, SETTLED]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE);
  assert.equal(r.consecutiveDishonest, 0);
});

test("an UNVERIFIED breaks the streak -- undetermined never slashes (hollow, unverified, hollow -> streak 1)", () => {
  const r = slashUi([HOLLOW, UNVERIFIED, HOLLOW]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE);
  assert.equal(r.consecutiveDishonest, 1);
  assert.equal(r.unverified, 1);
});

test("the streak is TRAILING, not total: two dishonest split by a settled is still ACTIVE", () => {
  // Total dishonest = 2, but they are NOT consecutive (a settled sits between) -> the trailing run is 1.
  const r = slashUi([HOLLOW, SETTLED, MISMATCH]);
  assert.equal(r.status, MANDATE_STATUS.ACTIVE);
  assert.equal(r.consecutiveDishonest, 1);
  assert.equal(r.hollow, 1);
  assert.equal(r.mismatch, 1);
});

/* ------------------------------------------------------------------------------------------------ *
 * The scoreboard counts + config guards.
 * ------------------------------------------------------------------------------------------------ */

test("the per-verdict counts are an honest tally of the whole sequence", () => {
  const r = slashUi([SETTLED, HOLLOW, MISMATCH, UNVERIFIED, HOLLOW]);
  assert.equal(r.total, 5);
  assert.equal(r.settled, 1);
  assert.equal(r.hollow, 2);
  assert.equal(r.mismatch, 1);
  assert.equal(r.unverified, 1);
});

test("a zero / negative revoke threshold is a LOUD misconfiguration, never a slash", () => {
  assert.throws(() => slashUi([HOLLOW], 0), RangeError);
  assert.throws(() => slashUi([], -1), RangeError);
  assert.throws(() => slashUi([HOLLOW], 1.5), RangeError);
});

test("slash is deterministic -- same sequence + threshold, same standing, every time", () => {
  const seq = [HOLLOW, HOLLOW];
  for (let i = 0; i < 8; i++) {
    assert.equal(slashUi(seq).status, MANDATE_STATUS.REVOKED);
  }
});
