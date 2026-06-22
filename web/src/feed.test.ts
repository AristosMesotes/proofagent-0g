/**
 * feed.test.ts -- the honesty + behaviour invariants of the LIVE VERDICT FEED store + its pure helpers
 * (design §4.5, §8). Pure logic only (no DOM) -- the store, the explorer-URL builder, the verdict chip, and
 * the clock/reconciliation formatters are the parts that decide what the feed claims, so they are unit-tested
 * under `node --test` against the compiled `dist/` ESM, fully offline.
 *
 * What these lock:
 *   - the feed is NEWEST-FIRST and assigns stable, monotonically-increasing ids (a faithful session log),
 *   - `clear()` empties it and notifies (in-memory only, no persistence),
 *   - the verdict CHIP reuses the repo-wide honesty grammar (only `settled`/`live` is green; `mismatch`/
 *     `hollow` are LOUD red; everything else neutral) -- the feed can NEVER colour a verdict green on its own,
 *   - `explorerTxUrl` links ONLY a real 0x+64hex hash on the PUBLIC 0G explorer (never a coerced half link).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FeedStore,
  explorerTxUrl,
  verdictChip,
  formatClock,
  reconcileLabel,
  reconcileStateClass,
} from "./feed.js";
import { RECONCILE } from "./reconcile.js";
import { GALILEO } from "./spine.js";

/* ------------------------------------------------------------------------------------------------ *
 * The pure FeedStore -- append / newest-first snapshot / clear / subscribe.
 * ------------------------------------------------------------------------------------------------ */

test("FeedStore.append assigns stable monotonically-increasing ids and a clock-stamped time", () => {
  let t = 1000;
  const store = new FeedStore(() => t);
  const a = store.append({ action: "NEG", verdict: "unverified", source: "verifier", hash: null, reconcile: RECONCILE.RECONCILED });
  t = 2000;
  const b = store.append({ action: "RAILS", verdict: "over_tx_cap", source: "0G RPC", hash: null, reconcile: RECONCILE.RECONCILED });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(a.at, 1000);
  assert.equal(b.at, 2000);
  assert.equal(store.size(), 2);
});

test("FeedStore.snapshot is NEWEST-FIRST (the accumulating session log reads top-down by recency)", () => {
  const store = new FeedStore(() => 0);
  store.append({ action: "first", verdict: "unverified", source: "verifier", hash: null, reconcile: RECONCILE.PENDING });
  store.append({ action: "second", verdict: "settled", source: "verifier", hash: null, reconcile: RECONCILE.RECONCILED });
  store.append({ action: "third", verdict: "mismatch", source: "0G RPC", hash: null, reconcile: RECONCILE.MISMATCH });
  const snap = store.snapshot();
  assert.deepEqual(snap.map((e) => e.action), ["third", "second", "first"]);
  // The snapshot is a COPY -- mutating it cannot corrupt the store's order.
  (snap as { length: number }).length = 0;
  assert.equal(store.size(), 3);
});

test("FeedStore.clear empties the feed (in-memory only) and notifies the subscriber", () => {
  const store = new FeedStore(() => 0);
  let lastLen = -1;
  store.subscribe((entries) => {
    lastLen = entries.length;
  });
  store.append({ action: "X", verdict: "settled", source: "verifier", hash: null, reconcile: RECONCILE.RECONCILED });
  assert.equal(lastLen, 1, "append notifies with the new length");
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(lastLen, 0, "clear notifies with the empty length");
});

test("FeedStore records exactly what it is handed -- it MINTS no verdict and alters none (design §8)", () => {
  const store = new FeedStore(() => 0);
  const e = store.append({ action: "Playground", verdict: "some_future_verdict", source: "verifier", hash: "0x" + "a".repeat(64), reconcile: RECONCILE.RECONCILED });
  assert.equal(e.verdict, "some_future_verdict", "the verdict is stored verbatim, never coerced");
  assert.equal(e.action, "Playground");
});

/* ------------------------------------------------------------------------------------------------ *
 * The verdict CHIP -- reuses the repo-wide honesty grammar (only settled/live is green).
 * ------------------------------------------------------------------------------------------------ */

test("verdictChip: ONLY settled/live get the green chip; mismatch/hollow are LOUD red; else neutral (the iron rule)", () => {
  assert.equal(verdictChip("settled").stateClass, "is-settled");
  assert.equal(verdictChip("live").stateClass, "is-settled");
  assert.equal(verdictChip("SETTLED").glyph, "✓", "settled uses the affirmative glyph");

  assert.equal(verdictChip("mismatch").stateClass, "is-mismatch");
  assert.equal(verdictChip("hollow").stateClass, "is-mismatch");
  assert.equal(verdictChip("mismatch").glyph, "⚠", "an anomaly uses the warning glyph");

  for (const neutral of ["unverified", "pending", "over_tx_cap", "read-error", "some_future_verdict"]) {
    const chip = verdictChip(neutral);
    assert.notEqual(chip.stateClass, "is-settled", `${neutral} must NEVER chip green`);
    assert.equal(chip.glyph, "·", `${neutral} gets the neutral glyph`);
  }
});

test("verdictChip.label is the lower-cased verdict word (the compact row verdict)", () => {
  assert.equal(verdictChip("  UNVERIFIED  ").label, "unverified");
});

/* ------------------------------------------------------------------------------------------------ *
 * explorerTxUrl -- a PUBLIC 0G explorer link only for a real tx hash (never a coerced half link).
 * ------------------------------------------------------------------------------------------------ */

test("explorerTxUrl: builds a PUBLIC 0G Galileo explorer link for a real 0x+64hex hash", () => {
  const hash = "0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0";
  const url = explorerTxUrl(hash);
  assert.equal(url, `${GALILEO.explorer}/tx/${hash}`);
  assert.ok(url.startsWith("https://"), "an absolute https link");
  assert.ok(url.includes("0g.ai"), "the public 0G explorer host");
});

test("explorerTxUrl: returns null for a non-hash (no coerced/broken link is ever built)", () => {
  assert.equal(explorerTxUrl(null), null);
  assert.equal(explorerTxUrl(""), null);
  assert.equal(explorerTxUrl("not-a-hash"), null);
  assert.equal(explorerTxUrl("0x123"), null);
  assert.equal(explorerTxUrl("0x" + "a".repeat(63)), null, "one hex short -> no link");
});

/* ------------------------------------------------------------------------------------------------ *
 * The clock + reconciliation formatters -- stable, honest, never green from nothing.
 * ------------------------------------------------------------------------------------------------ */

test("formatClock renders a stable zero-padded HH:MM:SS", () => {
  // 1970-01-01T00:00:00Z is the epoch; the clock renders local HH:MM:SS, always 8 chars and zero-padded.
  const s = formatClock(0);
  assert.match(s, /^\d{2}:\d{2}:\d{2}$/);
});

test("reconcileLabel/reconcileStateClass: ONLY `reconciled` is green; the rest are honest not-yet/anomaly", () => {
  assert.equal(reconcileStateClass(RECONCILE.RECONCILED), "is-settled");
  assert.equal(reconcileLabel(RECONCILE.RECONCILED), "reconciled");

  assert.equal(reconcileStateClass(RECONCILE.MISMATCH), "is-mismatch");
  assert.equal(reconcileStateClass(RECONCILE.UNAVAILABLE), "is-read-error");
  // Every non-reconciled state must NOT be the green class.
  for (const s of [RECONCILE.PENDING, RECONCILE.CHECKING, RECONCILE.MISMATCH, RECONCILE.UNAVAILABLE, RECONCILE.AWAITING]) {
    assert.notEqual(reconcileStateClass(s), "is-settled", `${s} must never be green`);
  }
});
