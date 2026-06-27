import test from "node:test";
import assert from "node:assert/strict";

import {
  ComputeBrainError,
  planZeroGCompute,
  zeroGComputeConfigFromEnv,
  type ComputeBroker,
  type ZeroGComputeConfig,
} from "./computeBrain.js";

const ENDPOINT = "https://provider.example/v1";
const PROVIDER = "0xa48f01287233509fd694a22bf840225062e67836";

interface MockOpts {
  services?: Array<{ provider: string; model?: string; serviceType?: string }>;
  attested?: boolean;
  /** A per-call attestation sequence (e.g. [false, false, true]) to exercise the settle-retry. */
  attestSequence?: boolean[];
  content?: string;
  httpOk?: boolean;
  status?: number;
}

function harness(opts: MockOpts = {}): { config: ZeroGComputeConfig; seenHeaders: Record<string, string> } {
  const seenHeaders: Record<string, string> = {};
  let attestCalls = 0;
  const broker: ComputeBroker = {
    inference: {
      listService: async () =>
        opts.services ?? [{ provider: PROVIDER, model: "qwen/qwen2.5-omni-7b", serviceType: "chatbot" }],
      getServiceMetadata: async () => ({ endpoint: ENDPOINT, model: "qwen/qwen2.5-omni-7b" }),
      getRequestHeaders: async () => ({ "x-zg-signed": "single-use" }),
      processResponse: async () => {
        if (Array.isArray(opts.attestSequence)) {
          return opts.attestSequence[Math.min(attestCalls++, opts.attestSequence.length - 1)] ?? false;
        }
        return opts.attested ?? true;
      },
      acknowledgeProviderSigner: async () => undefined,
    },
  };
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    Object.assign(seenHeaders, (init as { headers?: Record<string, string> }).headers ?? {});
    return {
      ok: opts.httpOk ?? true,
      status: opts.status ?? 200,
      headers: { get: (k: string) => (k === "ZG-Res-Key" ? "chat-123" : null) },
      json: async () => ({
        id: "chat-123",
        choices: [{ message: { content: opts.content ?? '{"allocations":[{"token":"W0G","bps":10000}]}' } }],
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    config: { walletPrivateKey: "0xkey", brokerFactory: async () => broker, fetchImpl, attestRetryDelayMs: 0 },
    seenHeaders,
  };
}

test("config from env is null unless OG_COMPUTE_WALLET_KEY is set (opt-in)", () => {
  assert.equal(zeroGComputeConfigFromEnv({}), null);
  const c = zeroGComputeConfigFromEnv({ OG_COMPUTE_WALLET_KEY: "0xk", OG_COMPUTE_PROVIDER: PROVIDER });
  assert.ok(c);
  assert.equal(c.walletPrivateKey, "0xk");
  assert.equal(c.provider, PROVIDER);
});

test("a verified attestation yields a plan labelled tee (the genuine 0G Compute brain)", async () => {
  const { config, seenHeaders } = harness({ attested: true });
  const p = await planZeroGCompute("go aggressive on native 0G", config);
  assert.equal(p.brain, "tee"); // reachable ONLY on a verified TEE attestation
  assert.deepEqual(p.allocations, [{ token: "W0G", bps: 10000 }]);
  assert.equal(seenHeaders["x-zg-signed"], "single-use"); // the broker's signed headers were sent
});

test("a transient signature error settles on retry -> tee (waits out provider timing, never fabricated)", async () => {
  // Observed LIVE: processResponse can return a transient false/throw before the enclave signature is
  // registered. The settle-retry waits it out; the plan is STILL minted only on a real attested===true.
  const { config } = harness({ attestSequence: [false, false, true] });
  const p = await planZeroGCompute("balanced", config);
  assert.equal(p.brain, "tee"); // verified on the 3rd attempt -- genuine, not fabricated
});

test("an UNVERIFIED attestation refuses a tee plan (never fabricated)", async () => {
  const { config } = harness({ attested: false });
  await assert.rejects(() => planZeroGCompute("x", config), ComputeBrainError);
});

test("no providers -> loud ComputeBrainError", async () => {
  const { config } = harness({ services: [] });
  await assert.rejects(() => planZeroGCompute("x", config), ComputeBrainError);
});

test("an unknown token from the model is rejected (the exact-integer invariant holds)", async () => {
  const { config } = harness({ content: '{"allocations":[{"token":"ETH","bps":10000}]}' });
  await assert.rejects(() => planZeroGCompute("x", config), ComputeBrainError);
});

test("allocations that don't sum to 100% are rejected", async () => {
  const { config } = harness({ content: '{"allocations":[{"token":"W0G","bps":9000}]}' });
  await assert.rejects(() => planZeroGCompute("x", config), ComputeBrainError);
});

test("a non-2xx inference status throws", async () => {
  const { config } = harness({ httpOk: false, status: 502 });
  await assert.rejects(() => planZeroGCompute("x", config), ComputeBrainError);
});

test("an empty query throws before any call", async () => {
  const { config } = harness({});
  await assert.rejects(() => planZeroGCompute("   ", config), ComputeBrainError);
});

test("the brain is tee, never stub (it IS the 0G Compute attestation)", async () => {
  const { config } = harness({ attested: true, content: '{"allocations":[{"token":"USDC.e","bps":10000}]}' });
  const p = await planZeroGCompute("keep it stable", config);
  assert.equal(p.brain, "tee");
});
