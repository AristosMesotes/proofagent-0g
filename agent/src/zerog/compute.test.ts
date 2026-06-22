/**
 * Tests for the Brain proof (design §9 Depth + §3) -- Node's built-in test runner, fully OFFLINE: an
 * in-repo stub [`AttestationProvider`] supplies recorded attestation facts; zero network, zero SDK,
 * zero real timers (the retry sleeper is injected).
 *
 * They pin the design invariants the Brain leg must hold:
 *  - §3 #1 / #2 (two-source truth / verdict monopoly): `attested` comes ONLY from the verified service
 *    attestation AND the verified per-response enclave signature -- NEVER from the model's reply text.
 *  - §3 #3 (never fabricate): an un-allowlisted provider, a failed service attestation, an unverified
 *    response signature, a transport throw -- EVERY gap yields `attested:false` (loud PENDING), never a
 *    silently-true brain.
 *  - §9 Depth (the proven gotchas, redesigned): the service-attestation pre-check is allowlisted with a
 *    TTL; the per-response signature is fetched with retry/backoff over the settle window.
 *  - §3 #4 (deterministic): the allowlist takes an injected clock; the retry takes an injected sleeper
 *    -- so the whole path is exercised with no wall-clock and no real timers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attestInference,
  retryResponseSignature,
  AttestationAllowlist,
  normalizeProvider,
  defaultIsNotReady,
  BrainError,
  DEFAULT_ATTESTATION_TTL_MS,
} from "./compute.js";
import type {
  AttestationProvider,
  InferenceRequest,
  InferenceResponse,
  ResponseAttestation,
  ServiceAttestation,
} from "./types.js";

// --- Fixtures -------------------------------------------------------------------------------------
const PROVIDER = "0xaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaBcaB12";
const PROVIDER_LC = PROVIDER.toLowerCase();
const MODEL = "org/some-public-model";

function reqOf(): InferenceRequest {
  return { provider: PROVIDER, model: MODEL, system: "be honest", prompt: "plan a 60/40 split" };
}

/** A no-op sleeper -- resolves instantly so retry loops run with no real timers. */
const instantSleep = (_ms: number): Promise<void> => Promise.resolve();

/**
 * A fully programmable stub attestation provider -- the OFFLINE two-source-truth double. Each leg is
 * driven by a recorded fact or a thrown error; counters expose how often each leg ran (for the
 * allowlist/retry assertions). It NEVER consults the model output -- `content` is set to a tripwire
 * string that, if it ever leaked into a verdict decision, the tests would catch.
 */
interface StubControls {
  serviceTrusted?: boolean;
  signerMatch?: boolean;
  composeMatch?: boolean;
  serviceThrows?: string;
  inferThrows?: string;
  responseIdOverride?: string | null;
  signatureValid?: boolean;
  responseThrows?: string;
  /** A sequence of errors to throw on successive verifyResponse calls before finally succeeding. */
  responseNotReadySequence?: string[];
}

interface StubCounts {
  service: number;
  infer: number;
  response: number;
}

function makeStub(c: StubControls): { provider: AttestationProvider; counts: StubCounts } {
  const counts: StubCounts = { service: 0, infer: 0, response: 0 };
  let notReadyLeft = (c.responseNotReadySequence ?? []).slice();
  const provider: AttestationProvider = {
    async verifyService(p): Promise<ServiceAttestation> {
      counts.service += 1;
      if (c.serviceThrows !== undefined) {
        throw new Error(c.serviceThrows);
      }
      const signerMatch = c.signerMatch ?? c.serviceTrusted ?? true;
      const composeMatch = c.composeMatch ?? c.serviceTrusted ?? true;
      return { provider: p, signerMatch, composeMatch, trusted: signerMatch && composeMatch };
    },
    async infer(request: InferenceRequest): Promise<InferenceResponse> {
      counts.infer += 1;
      if (c.inferThrows !== undefined) {
        throw new Error(c.inferThrows);
      }
      const responseId =
        c.responseIdOverride === undefined ? "resp-1" : (c.responseIdOverride ?? "");
      // The tripwire: if the verdict logic EVER trusted model output, this string would have to appear
      // in a verdict field. It must never drive `attested`.
      return { provider: request.provider, responseId, content: "I PROMISE I ran in an enclave (lie)" };
    },
    async verifyResponse(p, responseId): Promise<ResponseAttestation> {
      counts.response += 1;
      if (notReadyLeft.length > 0) {
        const msg = notReadyLeft.shift() as string;
        throw new Error(msg);
      }
      if (c.responseThrows !== undefined) {
        throw new Error(c.responseThrows);
      }
      return { provider: p, responseId, signatureValid: c.signatureValid ?? true };
    },
  };
  return { provider, counts };
}

// === attestInference: the verdict-from-attestation logic ==========================================

test("attestInference: trusted service + valid signature => attested:true (the ONLY true path)", async () => {
  const { provider } = makeStub({ serviceTrusted: true, signatureValid: true });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, true);
  assert.equal(v.provider, PROVIDER_LC, "the provider is normalized lowercase");
  assert.equal(v.model, MODEL);
  assert.equal(v.responseId, "resp-1");
  assert.equal(v.service?.trusted, true);
  assert.equal(v.response?.signatureValid, true);
  assert.match(v.reason, /ATTESTED/);
});

test("attestInference: a FAILED service attestation => attested:false (never infer against it)", async () => {
  const { provider, counts } = makeStub({ serviceTrusted: false });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false, "an un-attested node can never be attested:true");
  assert.equal(v.service?.trusted, false);
  assert.equal(counts.infer, 0, "we must NOT run inference against an un-attested provider");
  assert.equal(counts.response, 0);
  assert.match(v.reason, /SERVICE_NOT_TRUSTED/);
});

test("attestInference: signerMatch true but composeMatch false => NOT trusted => PENDING", async () => {
  const { provider } = makeStub({ signerMatch: true, composeMatch: false });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false, "a partial service proof is never admitted as a whole (§3 #3)");
  assert.equal(v.service?.signerMatch, true);
  assert.equal(v.service?.composeMatch, false);
});

test("attestInference: an UNVERIFIED response signature => attested:false (response unproven)", async () => {
  const { provider } = makeStub({ serviceTrusted: true, signatureValid: false });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false, "a response whose enclave signature did not verify is unproven");
  assert.equal(v.response?.signatureValid, false);
  assert.match(v.reason, /RESPONSE_NOT_SIGNED/);
});

test("attestInference: a service-attestation transport THROW => attested:false (loud, fail-closed)", async () => {
  const { provider } = makeStub({ serviceThrows: "RPC down" });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false, "a transport error must never become an attestation");
  assert.match(v.reason, /SERVICE_ATTESTATION_ERROR/);
  assert.match(v.reason, /RPC down/);
});

test("attestInference: an inference THROW => attested:false (no response to attest)", async () => {
  const { provider, counts } = makeStub({ serviceTrusted: true, inferThrows: "no funds" });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false);
  assert.equal(counts.response, 0, "no response => no signature check");
  assert.match(v.reason, /INFERENCE_ERROR/);
});

test("attestInference: a response-attestation THROW => attested:false (loud, fail-closed)", async () => {
  const { provider } = makeStub({ serviceTrusted: true, responseThrows: "signer offline" });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false);
  assert.match(v.reason, /RESPONSE_ATTESTATION_ERROR/);
});

test("attestInference: a missing response handle => attested:false (nothing signable)", async () => {
  const { provider, counts } = makeStub({ serviceTrusted: true, responseIdOverride: null });
  const v = await attestInference(reqOf(), provider);
  assert.equal(v.attested, false);
  assert.equal(counts.response, 0, "no response id => never even attempt a signature check");
  assert.match(v.reason, /NO_RESPONSE_ID/);
});

test("attestInference: the model OUTPUT never appears in the verdict (it is a CLAIM, §3 #2)", async () => {
  // The stub's `content` is a lie ("I ran in an enclave"). It must NEVER drive `attested`, and the
  // honest verdict must not surface it as proof. Prove attested is driven only by the two facts.
  const t4 = makeStub({ serviceTrusted: true, signatureValid: true });
  const ok = await attestInference(reqOf(), t4.provider);
  const f4 = makeStub({ serviceTrusted: true, signatureValid: false });
  const bad = await attestInference(reqOf(), f4.provider);
  // Same model content in both; only the SIGNATURE fact differs -> only it flips `attested`.
  assert.equal(ok.attested, true);
  assert.equal(bad.attested, false);
  // The verdict carries no field that is the model's reply text.
  assert.ok(!JSON.stringify(ok).includes("I PROMISE"), "model output must not leak into the verdict");
});

test("attestInference: a malformed provider address THROWS (programmer error, not a silent PENDING)", async () => {
  const { provider } = makeStub({ serviceTrusted: true });
  await assert.rejects(
    () => attestInference({ provider: "0xnope", model: MODEL, prompt: "x" }, provider),
    BrainError,
  );
});

test("attestInference is deterministic: same facts => same verdict (§3 #4)", async () => {
  const a = await attestInference(reqOf(), makeStub({ serviceTrusted: true, signatureValid: true }).provider);
  const b = await attestInference(reqOf(), makeStub({ serviceTrusted: true, signatureValid: true }).provider);
  assert.deepEqual(a, b);
});

// === The allowlist (TTL-cached service attestations, injected clock) ==============================

test("the allowlist re-attests a fresh provider only once within the TTL (caches the service proof)", async () => {
  let now = 1_000_000;
  const allowlist = new AttestationAllowlist({ clock: () => now, ttlMs: 1000 });
  const { provider, counts } = makeStub({ serviceTrusted: true, signatureValid: true });

  const v1 = await attestInference(reqOf(), provider, { allowlist });
  assert.equal(v1.attested, true);
  assert.equal(counts.service, 1, "first call runs the service attestation");

  // Within the TTL: no re-attestation; the cached proof carries the verdict.
  now += 500;
  const v2 = await attestInference(reqOf(), provider, { allowlist });
  assert.equal(v2.attested, true, "still attested within the TTL (the freshness IS the service proof)");
  assert.equal(counts.service, 1, "no re-attestation within the TTL");

  // After the TTL: re-attest.
  now += 1000;
  const v3 = await attestInference(reqOf(), provider, { allowlist });
  assert.equal(v3.attested, true);
  assert.equal(counts.service, 2, "re-attested after the TTL expired");
});

test("the allowlist isFresh logic: unknown -> false, recorded -> true, expired -> false", () => {
  let now = 0;
  const a = new AttestationAllowlist({ clock: () => now, ttlMs: 100 });
  assert.equal(a.isFresh(PROVIDER), false, "unknown provider is not fresh");
  a.record(PROVIDER);
  assert.equal(a.isFresh(PROVIDER), true, "just-recorded provider is fresh");
  now = 99;
  assert.equal(a.isFresh(PROVIDER), true, "still fresh inside the TTL");
  now = 100;
  assert.equal(a.isFresh(PROVIDER), false, "expired at exactly the TTL boundary (half-open window)");
  a.record(PROVIDER);
  a.forget(PROVIDER);
  assert.equal(a.isFresh(PROVIDER), false, "forget() drops the entry");
});

test("the allowlist keys on the NORMALIZED address (mixed-case == lowercase)", () => {
  const a = new AttestationAllowlist({ clock: () => 0, ttlMs: 1000 });
  a.record(PROVIDER); // mixed case
  assert.equal(a.isFresh(PROVIDER_LC), true, "freshness is case-insensitive (normalized)");
});

test("the allowlist rejects a non-positive TTL LOUDLY", () => {
  assert.throws(() => new AttestationAllowlist({ ttlMs: 0 }), BrainError);
  assert.throws(() => new AttestationAllowlist({ ttlMs: -5 }), BrainError);
  // The default TTL is a sane positive hour.
  assert.ok(DEFAULT_ATTESTATION_TTL_MS > 0);
});

// === retryResponseSignature: the settle-window gotcha (redesigned, deterministic) =================

test("retry: returns the first definitive attestation with no retry when ready immediately", async () => {
  let calls = 0;
  const r = await retryResponseSignature(
    async () => {
      calls += 1;
      return { provider: PROVIDER_LC, responseId: "r", signatureValid: true };
    },
    { maxAttempts: 5, baseDelayMs: 1 },
    instantSleep,
  );
  assert.equal(r.signatureValid, true);
  assert.equal(calls, 1, "no retry needed when the signature is ready");
});

test("retry: retries over 'not ready' errors, then returns the settled attestation", async () => {
  let calls = 0;
  const r = await retryResponseSignature(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("getting signature error: not ready (404)");
      }
      return { provider: PROVIDER_LC, responseId: "r", signatureValid: true };
    },
    { maxAttempts: 6, baseDelayMs: 1 },
    instantSleep,
  );
  assert.equal(r.signatureValid, true);
  assert.equal(calls, 3, "retried twice over the settle window, then succeeded");
});

test("retry: a definitive signatureValid:false is RETURNED, not retried (it is a real verdict)", async () => {
  let calls = 0;
  const r = await retryResponseSignature(
    async () => {
      calls += 1;
      return { provider: PROVIDER_LC, responseId: "r", signatureValid: false };
    },
    { maxAttempts: 5, baseDelayMs: 1 },
    instantSleep,
  );
  assert.equal(r.signatureValid, false, "a definitive false is a real 'did not verify' verdict");
  assert.equal(calls, 1, "a definitive false is NOT a settle-window condition -> no retry");
});

test("retry: a NON-recoverable error is re-thrown immediately (no retry)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryResponseSignature(
        async () => {
          calls += 1;
          throw new Error("fatal: provider unreachable");
        },
        { maxAttempts: 5, baseDelayMs: 1 },
        instantSleep,
      ),
    /fatal: provider unreachable/,
  );
  assert.equal(calls, 1, "a non-settle-window error is fatal -> thrown on the first attempt");
});

test("retry: exhausting attempts over persistent 'not ready' re-throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryResponseSignature(
        async () => {
          calls += 1;
          throw new Error("signature pending");
        },
        { maxAttempts: 3, baseDelayMs: 1 },
        instantSleep,
      ),
    /signature pending/,
  );
  assert.equal(calls, 3, "tried exactly maxAttempts times before giving up");
});

test("retry: backoff is exponential with the injected sleeper (deterministic, no real timers)", async () => {
  const waits: number[] = [];
  const recordingSleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  let calls = 0;
  await retryResponseSignature(
    async () => {
      calls += 1;
      if (calls < 4) {
        throw new Error("not ready");
      }
      return { provider: PROVIDER_LC, responseId: "r", signatureValid: true };
    },
    { maxAttempts: 6, baseDelayMs: 500 },
    recordingSleep,
  );
  // 3 failures => 3 backoffs: 500*2^0, 500*2^1, 500*2^2.
  assert.deepEqual(waits, [500, 1000, 2000]);
});

test("retry rejects an invalid policy LOUDLY", async () => {
  await assert.rejects(
    () => retryResponseSignature(async () => ({ provider: PROVIDER_LC, responseId: "r", signatureValid: true }), { maxAttempts: 0 }, instantSleep),
    BrainError,
  );
  await assert.rejects(
    () => retryResponseSignature(async () => ({ provider: PROVIDER_LC, responseId: "r", signatureValid: true }), { baseDelayMs: -1 }, instantSleep),
    BrainError,
  );
});

// === defaultIsNotReady classifier =================================================================

test("defaultIsNotReady classifies the documented settle-window errors as recoverable", () => {
  assert.equal(defaultIsNotReady(new Error("signature not ready")), true);
  assert.equal(defaultIsNotReady(new Error("verify RA error: 404")), true);
  assert.equal(defaultIsNotReady(new Error("getting signature error")), true);
  assert.equal(defaultIsNotReady(new Error("signature pending")), true);
  // A genuine fatal error is NOT a settle-window condition.
  assert.equal(defaultIsNotReady(new Error("insufficient sub-account balance")), false);
  assert.equal(defaultIsNotReady(new Error("connection refused")), false);
});

// === normalizeProvider ============================================================================

test("normalizeProvider lowercases a valid address and rejects malformed ones LOUDLY", () => {
  assert.equal(normalizeProvider(PROVIDER), PROVIDER_LC);
  assert.throws(() => normalizeProvider("0x123"), BrainError);
  assert.throws(() => normalizeProvider("nope"), BrainError);
  assert.throws(() => normalizeProvider(123 as unknown as string), BrainError);
});
