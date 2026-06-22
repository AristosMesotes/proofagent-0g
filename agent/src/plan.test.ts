/**
 * Tests for the planner (design SS4) -- run on Node's built-in test runner (offline, zero deps).
 *
 * They pin the design invariants the planner must hold:
 *  - SS4 shape: `plan(query) -> { chain, allocations }`.
 *  - SS3 principle 4 (deterministic): same query -> byte-identical plan; pure (no I/O, no clock).
 *  - SS3 principle 5 (exact-integer money): allocations are integer bps summing to exactly 10000.
 *  - SS3 principle 3 (never fabricate): an unplannable query throws loudly, never returns a fake plan.
 *  - SS7/SS8 (claim only what's live): the MVP brain is honestly labelled `"stub"`.
 *
 * NB: this file is excluded from the emitted build by the package layout but typechecked by `tsc`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, attestPlan, PlanError, TOTAL_BPS, CHAINS, TOKENS, type Plan } from "./plan.js";
import type { BrainVerdict } from "./zerog/types.js";

/** Build a brain verdict fixture for the attestPlan tests -- `attested` is the only load-bearing field. */
function verdictOf(attested: boolean): BrainVerdict {
  return {
    attested,
    provider: "0xabcabcabcabcabcabcabcabcabcabcabcabcab12",
    model: "org/some-public-model",
    responseId: attested ? "resp-1" : undefined,
    service: { provider: "0xabcabcabcabcabcabcabcabcabcabcabcabcab12", signerMatch: attested, composeMatch: attested, trusted: attested },
    response: attested ? { provider: "0xabcabcabcabcabcabcabcabcabcabcabcabcab12", responseId: "resp-1", signatureValid: true } : undefined,
    reason: attested ? "BRAIN_ATTESTED" : "BRAIN_RESPONSE_NOT_SIGNED",
  };
}

/** Helper: sum allocation bps with integer addition only (mirrors the money-path invariant). */
function sumBps(p: Plan): number {
  let s = 0;
  for (const a of p.allocations) {
    s += a.bps;
  }
  return s;
}

test("plan returns the design SS4 shape { chain, allocations }", () => {
  const p = plan("go aggressive on the native asset");
  assert.ok(p.chain, "has a chain");
  assert.equal(typeof p.chain.id, "number");
  assert.equal(typeof p.chain.name, "string");
  assert.ok(Array.isArray(p.allocations), "has an allocations array");
  assert.ok(p.allocations.length > 0, "allocations are non-empty");
  assert.equal(p.brain, "stub", "the MVP brain is honestly labelled (SS7/SS8)");
});

test("allocations are exact-integer bps summing to exactly TOTAL_BPS (SS3 principle 5)", () => {
  const queries = [
    "keep it stable and safe",
    "aggressive risk-on growth",
    "balanced hedge between the two",
    "something with no recognized cue at all",
  ];
  for (const q of queries) {
    const p = plan(q);
    for (const a of p.allocations) {
      assert.ok(Number.isInteger(a.bps), `bps is an integer for ${a.token} (no float on money path)`);
      assert.ok(a.bps > 0, `bps is positive for ${a.token} (no zero-weight no-op legs)`);
      assert.ok(a.token in TOKENS, `${a.token} is a known token`);
    }
    assert.equal(sumBps(p), TOTAL_BPS, `allocations for ${JSON.stringify(q)} sum to 100%`);
  }
});

test("plan is deterministic: same query -> byte-identical plan (SS3 principle 4)", () => {
  const q = "balanced hedge, 50/50 please";
  const a = plan(q);
  const b = plan(q);
  assert.deepEqual(a, b, "two calls produce structurally identical plans");
  // Stable serialization is the strongest determinism witness (a reproducible plan).
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("plan is case- and whitespace-insensitive on intent (SS3 principle 4)", () => {
  const a = plan("AGGRESSIVE   Growth");
  const b = plan("aggressive growth");
  assert.deepEqual(a, b, "casing and extra spacing do not change the plan");
});

test("stub rule: stable/defensive intent -> all USDC.e", () => {
  const p = plan("preserve capital, stay in cash");
  assert.equal(p.allocations.length, 1);
  assert.equal(p.allocations[0]?.token, "USDC.e");
  assert.equal(p.allocations[0]?.bps, TOTAL_BPS);
});

test("stub rule: aggressive/native intent -> all W0G", () => {
  const p = plan("go aggressive, risk-on into the native 0G asset");
  assert.equal(p.allocations.length, 1);
  assert.equal(p.allocations[0]?.token, "W0G");
  assert.equal(p.allocations[0]?.bps, TOTAL_BPS);
});

test("stub rule: balanced intent -> even exact-integer 50/50 split", () => {
  // Use cues unique to the balanced rule -- "stable"/"native" would trip the higher-precedence
  // defensive/aggressive rules (precedence is asserted separately below).
  const p = plan("a balanced 50/50 hedge, diversified");
  assert.equal(p.allocations.length, 2);
  const byToken = new Map(p.allocations.map((a) => [a.token, a.bps]));
  assert.equal(byToken.get("USDC.e"), TOTAL_BPS / 2);
  assert.equal(byToken.get("W0G"), TOTAL_BPS / 2);
  assert.equal(sumBps(p), TOTAL_BPS);
});

test("rule precedence is stable: a query matching defensive before aggressive picks defensive", () => {
  // "safe" (defensive rule, listed first) and "growth" (aggressive rule) both appear; first wins.
  const p = plan("a safe path to growth");
  assert.equal(p.allocations.length, 1);
  assert.equal(p.allocations[0]?.token, "USDC.e", "first matching rule (defensive) wins");
});

test("no recognized cue -> conservative default (all USDC.e), still a valid 100% plan", () => {
  const p = plan("xyzzy plugh nothing here matches a cue");
  assert.equal(p.allocations.length, 1);
  assert.equal(p.allocations[0]?.token, "USDC.e");
  assert.equal(sumBps(p), TOTAL_BPS);
});

test("default chain is the demo-safe testnet (Galileo) per SS8", () => {
  const p = plan("stable");
  assert.equal(p.chain.id, CHAINS.galileo.id);
  assert.equal(p.chain.id, 16602);
});

test("never fabricate: empty / whitespace query throws PlanError, never a fake plan (SS3 principle 3)", () => {
  assert.throws(() => plan(""), PlanError);
  assert.throws(() => plan("   \t\n  "), PlanError);
});

test("never fabricate: a non-string query throws PlanError (defensive against untyped callers)", () => {
  // The type system forbids this, but JS callers could violate it; it must fail loud, not coerce.
  assert.throws(() => plan(undefined as unknown as string), PlanError);
  assert.throws(() => plan(42 as unknown as string), PlanError);
});

test("the default plan brain is the offline stub label, NOT tee (SS7/SS8 -- claim only what's live)", () => {
  // A bare plan() is always the deterministic MVP brain -- never silently TEE-labelled.
  const p = plan("balanced hedge");
  assert.equal(p.brain, "stub", "the offline default brain is honestly labelled stub, not tee");
  assert.notEqual(p.brain, "tee");
});

test("attestPlan labels a plan TEE-attested ONLY when the brain verdict is attested (design §9 Depth)", () => {
  const stub = plan("balanced hedge");
  assert.equal(stub.brain, "stub");
  const attested = attestPlan(stub, verdictOf(true));
  // The TEE label is distinct from the stub label -- a viewer can never confuse the two brains.
  assert.equal(attested.brain, "tee", "a genuine attestation lifts the plan to the distinct tee label");
  assert.notEqual(attested.brain, stub.brain, "the tee plan is labelled distinctly from the stub plan");
  // Only the honesty label changes -- the chain + allocations are byte-identical (the proof is WHICH brain
  // ran, not WHAT it allocates).
  assert.deepEqual(attested.chain, stub.chain);
  assert.deepEqual(attested.allocations, stub.allocations);
});

test("attestPlan REFUSES to TEE-label a plan when the verdict is NOT attested (design §3 #3 -- never fabricate)", () => {
  const stub = plan("aggressive growth");
  // A non-attested verdict can never promote a stub plan to TEE-verified -- it throws, loudly.
  assert.throws(() => attestPlan(stub, verdictOf(false)), PlanError);
  // The original stub plan is untouched (no in-place mutation to a fake tee label).
  assert.equal(stub.brain, "stub");
});

test("attestPlan does not mutate its input plan (the stub plan stays a stub)", () => {
  const stub = plan("keep it stable");
  const attested = attestPlan(stub, verdictOf(true));
  assert.equal(stub.brain, "stub", "the input stub plan is not mutated");
  assert.equal(attested.brain, "tee", "the returned plan carries the tee label");
  assert.notStrictEqual(attested, stub, "attestPlan returns a new plan object, not the same reference");
});
