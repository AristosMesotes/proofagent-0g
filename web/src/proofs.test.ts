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
  type BrainAttestation,
} from "./proofs.js";

/**
 * Find the one stamp for a proof, or throw (also narrows the type for the strict compiler). Optionally
 * pass a verified brain attestation -- the single gated input that can lift the brain stamp green.
 */
function stampFor(proof: Stamp["proof"], brain?: BrainAttestation): Stamp {
  const found = buildStamps(brain).find((s) => s.proof === proof);
  if (found === undefined) {
    throw new Error(`missing stamp for proof: ${proof}`);
  }
  return found;
}

test("brain stamp is NEVER green at the offline-default MVP (design §7/§8 -- TEE is a Phase-2 Depth bracket)", () => {
  // The default offline build (no attestation handed in) must keep the brain PENDING -- never green.
  const brain = stampFor("brain");
  assert.notEqual(brain.level, STAMP_LEVEL.LIVE, "brain must not render green at the offline default");
  assert.equal(brain.level, STAMP_LEVEL.PENDING, "brain is pending / Phase-2");
  assert.equal(brain.bracket, "Depth", "brain is the Depth bracket, not MVP");
});

test("brain stamp LIFTS green ONLY when a real VERIFIED attestation is injected (design §9 Depth)", () => {
  // Inject a real, verified brain attestation (attested:true) -- the operator-gated Depth path. The green
  // brain path is real and reachable; it is gated solely on a genuine enclave attestation being present.
  const verified: BrainAttestation = {
    attested: true,
    provider: "0xaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaB12",
    model: "org/some-public-model",
    responseId: "resp-1",
    reason: "BRAIN_ATTESTED: service attestation trusted AND per-response enclave signature verified",
  };
  const brain = stampFor("brain", verified);
  assert.equal(brain.level, STAMP_LEVEL.LIVE, "a verified attestation lifts the brain stamp to green LIVE");
  assert.match(brain.status, /LIVE/, "the status word reflects the live TEE attestation");
  assert.match(brain.claim.toLowerCase(), /enclave/, "the green claim names the enclave proof");
  // The attested model is surfaced as context (it is which-model-ran, not the proof itself).
  assert.ok(brain.claim.includes("org/some-public-model"), "the attested model is surfaced in the claim");
  // Still honestly labelled as the Depth bracket -- a green brain is a Depth capability, now live on screen.
  assert.equal(brain.bracket, "Depth");
});

test("brain stamp STAYS PENDING for a NON-attested verdict (the gate is attested===true, not 'a verdict exists')", () => {
  // A verdict that is present but NOT attested (attested:false) must NEVER light the stamp green -- the lift
  // keys on the proof, not on the mere presence of a verdict (design §3 #3: never fabricate).
  const notAttested: BrainAttestation = {
    attested: false,
    provider: "0xaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaB12",
    reason: "BRAIN_RESPONSE_NOT_SIGNED: enclave signature over the response did not verify",
  };
  const brain = stampFor("brain", notAttested);
  assert.notEqual(brain.level, STAMP_LEVEL.LIVE, "a non-attested verdict must not render green");
  assert.equal(brain.level, STAMP_LEVEL.PENDING, "a non-attested verdict keeps the brain PENDING");
});

test("the three proofs are present exactly once each (design §2)", () => {
  const proofs = buildStamps().map((s) => s.proof);
  assert.deepEqual([...proofs].sort(), ["brain", "rails", "settlement"]);
});

test("rails is LIVE (green) now the MandateRegistryV4 address is pinned on-chain (design §8: claim only what's live)", () => {
  // The spine's MANDATE.registryAddress is the LIVE MandateRegistryV4 on 16602 -> the rails stamp is a green
  // LIVE on-chain claim (it was ARMED only while the address was empty; V4 is now confirmed on-chain).
  const rails = stampFor("rails");
  assert.equal(rails.level, STAMP_LEVEL.LIVE, "rails is green LIVE once the on-chain registry address is pinned");
  assert.equal(rails.status, "LIVE");
  // The green claim must point the viewer at the explorer to confirm the cap themselves (never trust the UI).
  assert.match(rails.claim, /explorer/i);
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
