/**
 * evidence.test.ts -- the honesty invariants of the EVIDENCE DRAWER's pure helpers (design §4.6, §8). Pure
 * logic only (no DOM) -- the drawer's open/close/focus-trap behaviour is exercised by the page; here we lock
 * the reconciliation-log colour mapping, which is the part that decides what colour the drawer claims. Runs
 * under `node --test` against the compiled `dist/` ESM, fully offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reconLogStateClass, evidenceVerdictClass } from "./evidence.js";

test("reconLogStateClass: ONLY `reconciled` is green; `mismatch` is LOUD red; `unavailable` grey; else amber", () => {
  assert.equal(reconLogStateClass("reconciled"), "is-settled");
  assert.equal(reconLogStateClass("RECONCILED"), "is-settled", "case-insensitive");
  assert.equal(reconLogStateClass("mismatch"), "is-mismatch");
  assert.equal(reconLogStateClass("unavailable"), "is-read-error");
  for (const notYet of ["pending", "checking", "awaiting", "something-unknown"]) {
    assert.equal(reconLogStateClass(notYet), "is-pending", `${notYet} -> the honest amber/neutral face`);
    assert.notEqual(reconLogStateClass(notYet), "is-settled", `${notYet} must NEVER be green`);
  }
});

test("evidenceVerdictClass reuses the repo-wide grammar verbatim (only settled/live is green)", () => {
  assert.equal(evidenceVerdictClass("settled"), "is-settled");
  assert.equal(evidenceVerdictClass("live"), "is-settled");
  assert.equal(evidenceVerdictClass("mismatch"), "is-mismatch");
  assert.equal(evidenceVerdictClass("unverified"), "is-pending");
  assert.notEqual(evidenceVerdictClass("unverified"), "is-settled");
});
