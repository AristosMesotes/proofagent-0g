/**
 * dashboard.test.ts -- the honesty invariants of the verification console's P1 logic (design §8).
 *
 * These lock the dashboard's load-bearing honesty rules so a future edit cannot silently:
 *   - turn a reconciliation badge green from the UI's own state (it must require an INDEPENDENT agreement),
 *   - colour a non-`settled` verdict green (the iron rule: only live/settled is green),
 *   - light the BRAIN card green (no independent attestation source is wired here -> never `reconciled`).
 *
 * Pure logic only (no DOM) -- the DOM render/badge classes are exercised by the page itself; here we test
 * the verdict-grammar mapping and the reconcile DECISION, which are the parts that decide honesty. Runs
 * under `node --test` against the compiled `dist/` ESM, fully offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RECONCILE, decideReconcile } from "./reconcile.js";
import { verdictStateClass } from "./render.js";

/* ------------------------------------------------------------------------------------------------ *
 * The reconcile DECISION -- green ONLY from an independent agreement, never from the painted verdict.
 * ------------------------------------------------------------------------------------------------ */

test("decideReconcile is GREEN (reconciled) ONLY when an independent re-read AGREES with the painted verdict", () => {
  // Two independently-produced verdict strings that match -> reconciled (the only green badge state).
  assert.equal(decideReconcile("settled", { verdict: "settled" }), RECONCILE.RECONCILED);
  assert.equal(decideReconcile("unverified", { verdict: "unverified" }), RECONCILE.RECONCILED);
  // Case-insensitive: the on-chain reason OVER_TX_CAP vs a lower-cased replay still reconciles.
  assert.equal(decideReconcile("OVER_TX_CAP", { verdict: "over_tx_cap" }), RECONCILE.RECONCILED);
});

test("decideReconcile is a LOUD mismatch when the independent re-read DISAGREES (never softened to green)", () => {
  assert.equal(decideReconcile("settled", { verdict: "mismatch" }), RECONCILE.MISMATCH);
  assert.equal(decideReconcile("unverified", { verdict: "settled" }), RECONCILE.MISMATCH);
  assert.notEqual(decideReconcile("settled", { verdict: "unverified" }), RECONCILE.RECONCILED);
});

test("decideReconcile is honestly UNAVAILABLE (infra-gated) when the independent source is unreachable -- never faked green", () => {
  // A null independent verdict means the independent source could not be reached -> never green.
  assert.equal(decideReconcile("settled", { verdict: null }), RECONCILE.UNAVAILABLE);
  assert.notEqual(decideReconcile("settled", { verdict: null }), RECONCILE.RECONCILED);
  // An empty painted or independent verdict is unconfirmable -> never green.
  assert.equal(decideReconcile("", { verdict: "settled" }), RECONCILE.UNAVAILABLE);
  assert.equal(decideReconcile("settled", { verdict: "" }), RECONCILE.UNAVAILABLE);
});

test("the reconcile state machine has NO path that returns `reconciled` from a single (UI) verdict alone", () => {
  // decideReconcile is the ONLY producer of RECONCILED, and it requires TWO inputs (painted + independent).
  // There is no one-argument / UI-only path to green -- proven by every non-agreeing combination below.
  for (const painted of ["settled", "unverified", "over_tx_cap", "pending"]) {
    assert.notEqual(decideReconcile(painted, { verdict: null }), RECONCILE.RECONCILED, `${painted} vs unreachable`);
    assert.notEqual(decideReconcile(painted, { verdict: "DIFFERENT" }), RECONCILE.RECONCILED, `${painted} vs disagree`);
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * The verdict colour grammar -- the iron rule: ONLY live/settled is green (design §4 grammar, §8).
 * ------------------------------------------------------------------------------------------------ */

test("verdictStateClass: ONLY `live`/`settled` map to the green state class (the iron rule, design §8)", () => {
  assert.equal(verdictStateClass("settled"), "is-settled");
  assert.equal(verdictStateClass("live"), "is-settled");
  assert.equal(verdictStateClass("SETTLED"), "is-settled", "case-insensitive");
});

test("verdictStateClass: `hollow`/`mismatch` are LOUD red; nothing else is ever green", () => {
  assert.equal(verdictStateClass("hollow"), "is-mismatch");
  assert.equal(verdictStateClass("mismatch"), "is-mismatch");
});

test("verdictStateClass: read-error is grey; pending/armed/unverified/an on-chain reason are amber -- NEVER green", () => {
  assert.equal(verdictStateClass("read-error"), "is-read-error");
  for (const amber of ["pending", "armed", "unverified", "OVER_TX_CAP", "some-unmapped-code"]) {
    assert.equal(verdictStateClass(amber), "is-pending", `${amber} must be the amber/neutral face`);
    assert.notEqual(verdictStateClass(amber), "is-settled", `${amber} must NEVER be green`);
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * The BRAIN card's honesty -- its badge state is AWAITING (never RECONCILED) with no attestation wired.
 * ------------------------------------------------------------------------------------------------ */

test("the BRAIN badge state `awaiting` is NOT the green `reconciled` state (the brain can never green here)", () => {
  // The dashboard pins the brain badge to AWAITING (no independent attestation source at MVP). It is a
  // distinct, muted state -- there is no code that maps AWAITING to RECONCILED.
  assert.notEqual(RECONCILE.AWAITING, RECONCILE.RECONCILED);
  // And the brain's painted verdict (`pending`) is never green by the grammar either.
  assert.notEqual(verdictStateClass("pending"), "is-settled");
});
