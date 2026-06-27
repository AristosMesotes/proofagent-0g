/**
 * hostedBrain.ts -- the HOSTED-LLM brain (`planHostedLlm`): the agent's reasoning on a configurable hosted
 * model (OpenRouter-compatible `/chat/completions`), behind the SAME [`plan`] seam as the deterministic stub.
 *
 * ## What this is -- and, honestly, what it is NOT
 *
 * This is the `"hosted-llm"` value of [`PlannerKind`] (design SS7: "Brain is a hosted LLM at this stage,
 * honestly labelled"). It lets the agent PLAN with a real, configurable model instead of the deterministic
 * stub. The plan it returns is a CLAIM -- exactly like every plan -- and the honesty story is unchanged: the
 * agent is never trusted; the on-chain VERIFIER checks the result regardless of which brain reasoned.
 *
 * It is NOT the 0G Compute TEE attestation. A hosted LLM reply proves nothing about WHICH model ran -- a
 * model can say anything. That proof is the separate `"tee"` brain ([`crate`-side `attestInference`]), which
 * stays operator-gated/PENDING. So a hosted-LLM plan carries `brain: "hosted-llm"` and is NEVER upgraded to
 * `"tee"`; it never turns the 0G-Compute pillar green. Honest by construction (design SS8, "claim only what's
 * live").
 *
 * ## Offline-by-default + loud-degrade (design SS3 #3, SS6)
 *
 * The brain is OPT-IN: [`hostedBrainConfigFromEnv`] returns `null` unless BOTH an api key AND a model are
 * configured (a gitignored env), so the default build never calls the network and the caller falls back to
 * the stub. Every failure (no transport, non-2xx, non-JSON, no content, a malformed/partial allocation set, an
 * unknown token) is a loud [`HostedBrainError`] -- never a fabricated plan. The api key is read at runtime from
 * the env, passed in, and NEVER logged or committed.
 */

import {
  makePlan,
  PlanError,
  TOKENS,
  TOTAL_BPS,
  type Allocation,
  type Plan,
  type TokenSymbol,
} from "./plan.js";

/** A loud failure on the hosted-LLM brain path (degrade loudly; never fabricate a plan -- design SS3 #3). */
export class HostedBrainError extends Error {
  public override readonly name = "HostedBrainError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, HostedBrainError.prototype);
  }
}

/**
 * Operator config for the hosted-LLM brain. Every field is operator-supplied; NONE is hardcoded. The `apiKey`
 * is read from a gitignored env var by the caller and passed in here -- NEVER logged, printed, or committed.
 */
export interface HostedBrainConfig {
  /** The bearer api key (OpenRouter-compatible). From a gitignored env var; never logged/committed. */
  readonly apiKey: string;
  /** The wire model id to request -- configurable (e.g. from the `BRAIN` env var). */
  readonly model: string;
  /** The chat-completions base URL. Defaults to the OpenRouter public endpoint. */
  readonly baseUrl?: string;
  /** Injectable `fetch` -- the default uses `globalThis.fetch`; tests pass a hermetic stub (no network). */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 30s). */
  readonly timeoutMs?: number;
}

/** The default OpenRouter-compatible chat-completions base URL (never a hardcoded key, only a public host). */
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Read the hosted-LLM brain config from the environment, or `null` if it is NOT configured (so the caller
 * keeps using the offline stub). Configured iff BOTH a key and a model are present -- the brain is opt-in.
 */
export function hostedBrainConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HostedBrainConfig | null {
  const apiKey = (env["OPENROUTER_API_KEY"] ?? env["BRAIN_API_KEY"] ?? "").trim();
  const model = (env["BRAIN_MODEL"] ?? env["OPENROUTER_MODEL"] ?? env["BRAIN"] ?? "").trim();
  if (apiKey === "" || model === "") {
    return null;
  }
  // The endpoint is fully configurable: point BRAIN_BASE_URL at ANY OpenAI-compatible `/chat/completions`
  // host (the OpenRouter public endpoint, a self-hosted vLLM server, etc.) -- generic by design, so no
  // specific provider is baked into the public tree.
  const baseUrl = (env["BRAIN_BASE_URL"] ?? env["OPENROUTER_BASE_URL"] ?? "").trim();
  return baseUrl === "" ? { apiKey, model } : { apiKey, model, baseUrl };
}

/** The planner instruction: STRICT JSON allocations over the two known tokens, summing to 100%. */
const SYSTEM_PROMPT =
  "You are an allocation planner for an autonomous on-chain agent on 0G. Read the user's intent and output " +
  'STRICT JSON ONLY (no prose, no markdown fences): {"allocations":[{"token":"USDC.e"|"W0G","bps":<integer>}]}. ' +
  "Rules: use ONLY the tokens USDC.e (a stablecoin) and W0G (the native wrapped 0G asset). Every bps is a " +
  `positive integer and the allocations MUST sum to exactly ${TOTAL_BPS} (=100%). A defensive/stable intent ` +
  "favors USDC.e; an aggressive/native intent favors W0G; a balanced intent splits. Output the JSON object and " +
  "nothing else.";

/**
 * Plan an action from a natural-language `query` using a configurable hosted LLM. Returns a validated [`Plan`]
 * labelled `brain: "hosted-llm"`. The model's reply is a CLAIM: it is parsed into an allocation set and held to
 * the SAME exact-integer invariant ([`makePlan`]) as every brain; anything malformed is a loud
 * [`HostedBrainError`], never a fabricated plan. The api key is used only in the request `Authorization` header.
 */
export async function planHostedLlm(query: string, config: HostedBrainConfig): Promise<Plan> {
  if (typeof query !== "string" || query.trim() === "") {
    throw new HostedBrainError("empty query -- no intent to plan from");
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HostedBrainError("no fetch implementation available for the hosted-LLM call");
  }
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        "x-title": "ProofAgent-0G",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new HostedBrainError(`hosted-LLM transport failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new HostedBrainError(`hosted-LLM returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new HostedBrainError(`hosted-LLM response was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const content = extractContent(body);
  const allocations = parseAllocations(content);
  try {
    // The brain label stays honest: "hosted-llm" (a hosted model reasoned this) -- NEVER "tee" / 0G-attested.
    return makePlan(allocations, "hosted-llm");
  } catch (err) {
    throw new HostedBrainError(
      `hosted-LLM produced an invalid plan: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build a planner the agent loop ([`runLoop`]) can use directly: it runs the hosted-LLM brain and
 * re-throws any [`HostedBrainError`] as a [`PlanError`], so the loop's existing plan-leg handling treats a
 * brain failure as a loud "plan leg failed" -- never a silent fallback to a different brain, never a fake
 * plan (design SS3 #3). Pair with [`hostedBrainConfigFromEnv`]: if it returns `null`, keep the stub.
 */
export function makeBrainPlanner(config: HostedBrainConfig): (query: string) => Promise<Plan> {
  return async (query: string): Promise<Plan> => {
    try {
      return await planHostedLlm(query, config);
    } catch (err) {
      throw new PlanError(`hosted-llm brain: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** Pull the assistant message content out of an OpenAI/OpenRouter-shaped chat-completions reply. */
function extractContent(body: unknown): string {
  const choices = (body as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new HostedBrainError("hosted-LLM reply had no message content");
  }
  return content;
}

/** Extract + validate the allocation set from the model's reply text (a CLAIM). Loud on anything malformed. */
function parseAllocations(content: string): Allocation[] {
  const json = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new HostedBrainError(`hosted-LLM content was not parseable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = (parsed as { allocations?: unknown })?.allocations;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HostedBrainError("hosted-LLM JSON had no non-empty allocations[]");
  }
  const out: Allocation[] = [];
  for (const a of raw) {
    const token = (a as { token?: unknown })?.token;
    const bps = (a as { bps?: unknown })?.bps;
    if (typeof token !== "string" || !(token in TOKENS)) {
      throw new HostedBrainError(`hosted-LLM chose an unknown token: ${JSON.stringify(token)}`);
    }
    if (typeof bps !== "number" || !Number.isInteger(bps)) {
      throw new HostedBrainError(`hosted-LLM bps is not an integer: ${String(bps)} for ${token}`);
    }
    out.push({ token: token as TokenSymbol, bps });
  }
  return out;
}

/** Find the first JSON object in a reply (tolerating ```json fences / surrounding prose). Loud if absent. */
function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new HostedBrainError("hosted-LLM reply contained no JSON object");
  }
  return body.slice(start, end + 1);
}
