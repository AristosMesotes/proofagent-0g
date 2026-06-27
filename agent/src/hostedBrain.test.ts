import test from "node:test";
import assert from "node:assert/strict";

import {
  hostedBrainConfigFromEnv,
  HostedBrainError,
  planHostedLlm,
  type HostedBrainConfig,
} from "./hostedBrain.js";

const KEY = "sk-test-only-not-a-real-key";

interface Seen {
  url?: string | undefined;
  auth?: string | undefined;
  model?: string | undefined;
}

/** Build a hermetic config whose injected `fetch` returns `content` (or fails), capturing what was sent. */
function harness(
  content: string,
  opts: { ok?: boolean; status?: number; transport?: boolean } = {},
): { config: HostedBrainConfig; seen: Seen } {
  const seen: Seen = {};
  const fetchImpl = (async (input: unknown, init: unknown) => {
    seen.url = String(input);
    const i = init as { headers?: Record<string, string>; body?: string };
    seen.auth = i.headers?.["authorization"];
    seen.model = JSON.parse(i.body ?? "{}").model as string;
    if (opts.transport) {
      throw new Error("ECONNREFUSED (simulated transport failure)");
    }
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { config: { apiKey: KEY, model: "test/model", fetchImpl }, seen };
}

test("config from env is null unless BOTH a key and a model are set (opt-in)", () => {
  assert.equal(hostedBrainConfigFromEnv({}), null);
  assert.equal(hostedBrainConfigFromEnv({ OPENROUTER_API_KEY: "k" }), null);
  assert.equal(hostedBrainConfigFromEnv({ BRAIN: "m" }), null);
  const c = hostedBrainConfigFromEnv({ OPENROUTER_API_KEY: "k", BRAIN: "gpt-oss-120b" });
  assert.ok(c);
  assert.equal(c.apiKey, "k");
  assert.equal(c.model, "gpt-oss-120b");
});

test("a valid hosted-LLM reply yields a plan labelled hosted-llm (the key rides only in the header)", async () => {
  const { config, seen } = harness('{"allocations":[{"token":"W0G","bps":10000}]}');
  const p = await planHostedLlm("go aggressive on native", config);
  assert.equal(p.brain, "hosted-llm");
  assert.deepEqual(p.allocations, [{ token: "W0G", bps: 10000 }]);
  assert.equal(seen.auth, `Bearer ${KEY}`);
  assert.equal(seen.model, "test/model");
  assert.match(seen.url ?? "", /chat\/completions$/);
});

test("tolerates ```json fences + surrounding prose", async () => {
  const { config } = harness(
    'Sure — here:\n```json\n{"allocations":[{"token":"USDC.e","bps":5000},{"token":"W0G","bps":5000}]}\n```',
  );
  const p = await planHostedLlm("balanced hedge", config);
  assert.equal(p.brain, "hosted-llm");
  assert.equal(p.allocations.length, 2);
});

test("loud-degrade: a non-2xx HTTP status throws (never a fabricated plan)", async () => {
  const { config } = harness("{}", { ok: false, status: 500 });
  await assert.rejects(() => planHostedLlm("x", config), HostedBrainError);
});

test("loud-degrade: a transport failure throws", async () => {
  const { config } = harness("{}", { transport: true });
  await assert.rejects(() => planHostedLlm("x", config), HostedBrainError);
});

test("loud-degrade: an unknown token is rejected", async () => {
  const { config } = harness('{"allocations":[{"token":"ETH","bps":10000}]}');
  await assert.rejects(() => planHostedLlm("x", config), HostedBrainError);
});

test("loud-degrade: allocations that don't sum to 100% are rejected (the exact-integer invariant)", async () => {
  const { config } = harness('{"allocations":[{"token":"W0G","bps":9999}]}');
  await assert.rejects(() => planHostedLlm("x", config), HostedBrainError);
});

test("loud-degrade: a reply with no JSON object throws", async () => {
  const { config } = harness("sorry, I cannot help with that");
  await assert.rejects(() => planHostedLlm("x", config), HostedBrainError);
});

test("loud-degrade: an empty query throws before any call", async () => {
  const { config } = harness('{"allocations":[{"token":"W0G","bps":10000}]}');
  await assert.rejects(() => planHostedLlm("   ", config), HostedBrainError);
});

test("the hosted-LLM brain is NEVER labelled tee (it is not the 0G Compute attestation)", async () => {
  const { config } = harness('{"allocations":[{"token":"USDC.e","bps":10000}]}');
  const p = await planHostedLlm("keep it stable", config);
  assert.notEqual(p.brain, "tee");
  assert.equal(p.brain, "hosted-llm");
});
