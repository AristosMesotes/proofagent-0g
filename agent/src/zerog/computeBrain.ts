/**
 * computeBrain.ts -- the 0G COMPUTE brain (`planZeroGCompute`): the agent reasons INSIDE a 0G Compute TEE,
 * and the plan is labelled `"tee"` ONLY when the per-response enclave attestation VERIFIES. Everything on 0G.
 *
 * ## What this is
 *
 * The `"tee"` value of the [`PlannerKind`] seam, backed by the official `@0gfoundation/0g-compute-ts-sdk`
 * broker: `createZGComputeNetworkBroker` -> `inference.listService` (discover a TEE provider) ->
 * `getRequestHeaders` (single-use signed headers) -> an OpenAI-compatible `/chat/completions` inference ->
 * `processResponse`, which VERIFIES the provider's TEE signature for THIS response. The reply `content` is a
 * CLAIM only; `attested` is `processResponse(...) === true` -- NEITHER taken from the model's words. A `"tee"`
 * plan is minted ONLY on a verified attestation; any gap (no provider, a failed/declined attestation, a
 * transport error) is a loud [`ComputeBrainError`] -- never a fabricated `"tee"` (design SS3 #3, SS8 "claim
 * only what's live"). The downstream legs still verify the result on-chain -- the brain is never trusted.
 *
 * ## Offline-by-default + clean-room (design SS6)
 *
 * The SDK + `ethers` are dynamically imported ONLY on the live path (or an injected broker is used in tests),
 * so the default build and every test need no SDK and no network. The wallet key is read at runtime from a
 * gitignored env, used only by the broker, and NEVER logged or committed. No proprietary identifier appears
 * here -- only the PUBLIC 0G Compute SDK package + its documented broker concepts, and public 0G chain values.
 */

import { makePlan, PlanError, TOKENS, TOTAL_BPS, type Allocation, type Plan, type TokenSymbol } from "../plan.js";

/** A loud failure on the 0G Compute brain path (degrade loudly; never fabricate a `"tee"` plan -- SS3 #3). */
export class ComputeBrainError extends Error {
  public override readonly name = "ComputeBrainError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ComputeBrainError.prototype);
  }
}

/** The minimal PUBLIC shape this module needs from the `@0gfoundation/0g-compute-ts-sdk` inference broker. */
export interface ComputeBroker {
  readonly inference: {
    listService(): Promise<Array<{ provider: string; model?: string; serviceType?: string }>>;
    getServiceMetadata(provider: string): Promise<{ endpoint: string; model: string }>;
    getRequestHeaders(provider: string, content?: string): Promise<Record<string, string>>;
    processResponse(provider: string, chatId: string, content?: string): Promise<boolean>;
    acknowledgeProviderSigner?(provider: string): Promise<void>;
  };
}

/** Operator config for the live 0G Compute brain. Every field is operator-supplied; the key is gitignored-only. */
export interface ZeroGComputeConfig {
  /** The funded 0G wallet PRIVATE KEY (gitignored env only -- never logged/committed). */
  readonly walletPrivateKey: string;
  /** The 0G EVM JSON-RPC the broker connects to (default: the public Galileo testnet endpoint). */
  readonly rpcUrl?: string;
  /** An explicit TEE provider address (`0x...`); if unset, the first chatbot provider from `listService`. */
  readonly provider?: string;
  /** Injectable broker -- tests pass a hermetic stub; the default dynamically imports the public SDK. */
  readonly brokerFactory?: (config: ZeroGComputeConfig) => Promise<ComputeBroker>;
  /** Injectable `fetch` -- tests pass a stub; the default uses `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Inference request timeout (ms, default 45s). */
  readonly timeoutMs?: number;
}

/** The default public 0G Galileo testnet EVM RPC (never a hardcoded key -- only a public host). */
export const DEFAULT_COMPUTE_RPC = "https://evmrpc-testnet.0g.ai";

/**
 * Read the live 0G Compute brain config from the env, or `null` if not configured (so the caller keeps the
 * stub). Configured iff a wallet key is present; the brain is opt-in and offline-by-default.
 */
export function zeroGComputeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ZeroGComputeConfig | null {
  const walletPrivateKey = (env["OG_COMPUTE_WALLET_KEY"] ?? "").trim();
  if (walletPrivateKey === "") {
    return null;
  }
  const rpcUrl = (env["OG_COMPUTE_RPC_URL"] ?? env["OG_RPC"] ?? "").trim();
  const provider = (env["OG_COMPUTE_PROVIDER"] ?? "").trim();
  const out: ZeroGComputeConfig = { walletPrivateKey };
  return {
    ...out,
    ...(rpcUrl === "" ? {} : { rpcUrl }),
    ...(provider === "" ? {} : { provider }),
  };
}

/** The planner instruction: STRICT JSON allocations over the two known tokens, summing to 100%. */
const SYSTEM_PROMPT =
  "You are an allocation planner for an autonomous on-chain agent on 0G. Read the user's intent and output " +
  'STRICT JSON ONLY (no prose, no markdown fences): {"allocations":[{"token":"USDC.e"|"W0G","bps":<integer>}]}. ' +
  "Rules: use ONLY the tokens USDC.e (a stablecoin) and W0G (the native wrapped 0G asset). Every bps is a " +
  `positive integer and the allocations MUST sum to exactly ${TOTAL_BPS} (=100%). A defensive/stable intent ` +
  "favors USDC.e; an aggressive/native intent favors W0G; a balanced intent splits. Output the JSON object only.";

/** The default broker factory: dynamically import the PUBLIC SDK + ethers ONLY on the live path (SS6). */
async function defaultBrokerFactory(config: ZeroGComputeConfig): Promise<ComputeBroker> {
  const sdkName = "@0gfoundation/0g-compute-ts-sdk";
  const ethersName = "ethers";
  let eth: { JsonRpcProvider: new (url: string) => unknown; Wallet: new (key: string, provider: unknown) => unknown };
  let sdk: { createZGComputeNetworkBroker?: (wallet: unknown) => Promise<ComputeBroker> };
  try {
    eth = (await import(ethersName)) as typeof eth;
    sdk = (await import(sdkName)) as typeof sdk;
  } catch (err) {
    throw new ComputeBrainError(
      `0G Compute SDK not installed (run \`npm i ${sdkName} ${ethersName}\` for the live path): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof sdk.createZGComputeNetworkBroker !== "function") {
    throw new ComputeBrainError(`${sdkName} did not export createZGComputeNetworkBroker`);
  }
  const provider = new eth.JsonRpcProvider(config.rpcUrl ?? DEFAULT_COMPUTE_RPC);
  const wallet = new eth.Wallet(config.walletPrivateKey, provider);
  return sdk.createZGComputeNetworkBroker(wallet);
}

/**
 * Plan an action by reasoning inside a 0G Compute TEE. Returns a [`Plan`] labelled `"tee"` ONLY when the
 * per-response enclave attestation verified; otherwise a loud [`ComputeBrainError`]. The model reply is a
 * CLAIM the on-chain verifier checks -- the brain is never trusted.
 */
export async function planZeroGCompute(query: string, config: ZeroGComputeConfig): Promise<Plan> {
  if (typeof query !== "string" || query.trim() === "") {
    throw new ComputeBrainError("empty query -- no intent to plan from");
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ComputeBrainError("no fetch implementation available for the 0G Compute inference call");
  }
  const broker = await (config.brokerFactory ?? defaultBrokerFactory)(config);

  const services = await broker.inference.listService();
  if (!Array.isArray(services) || services.length === 0) {
    throw new ComputeBrainError("0G Compute: no TEE providers available (listService returned empty)");
  }
  const chosen = config.provider
    ? services.find((s) => s.provider.toLowerCase() === config.provider!.toLowerCase())
    : services.find((s) => s.serviceType === "chatbot") ?? services[0];
  if (!chosen) {
    throw new ComputeBrainError("0G Compute: no suitable chatbot TEE provider found");
  }
  const providerAddr = chosen.provider;
  if (broker.inference.acknowledgeProviderSigner) {
    try {
      await broker.inference.acknowledgeProviderSigner(providerAddr);
    } catch {
      // a pre-acknowledged signer is fine; a real failure surfaces at getRequestHeaders/processResponse.
    }
  }

  const meta = await broker.inference.getServiceMetadata(providerAddr);
  const headers = await broker.inference.getRequestHeaders(providerAddr, query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 45_000);
  let response: Response;
  try {
    response = await fetchImpl(`${meta.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: meta.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ComputeBrainError(`0G Compute inference transport failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new ComputeBrainError(`0G Compute inference returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ComputeBrainError(`0G Compute inference response was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const content = extractContent(body);
  const allocations = parseAllocations(content);

  // The attestation -- the ONLY path to a "tee" plan. `processResponse` verifies the enclave signature for
  // THIS response; we NEVER read attested-ness from the model's reply text (design SS3 #2).
  const chatId = responseId(response, body);
  let attested: boolean;
  try {
    attested = await broker.inference.processResponse(providerAddr, chatId, query);
  } catch (err) {
    throw new ComputeBrainError(`0G Compute attestation check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (attested !== true) {
    throw new ComputeBrainError("0G Compute: the per-response TEE attestation did NOT verify -- refusing a 'tee' plan");
  }

  try {
    // GENUINELY TEE-attested on 0G: the plan carries `brain: "tee"`, reachable ONLY here, only on attested===true.
    return makePlan(allocations, "tee");
  } catch (err) {
    throw new ComputeBrainError(`0G Compute produced an invalid plan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build a planner the agent loop ([`runLoop`]) can use directly: it runs the 0G Compute brain and re-throws
 * any [`ComputeBrainError`] as a [`PlanError`], so the loop's plan-leg handling treats an un-attested or
 * failed brain as a loud "plan leg failed" -- never a silent fallback, never a fabricated `"tee"` (SS3 #3).
 */
export function makeZeroGComputePlanner(config: ZeroGComputeConfig): (query: string) => Promise<Plan> {
  return async (query: string): Promise<Plan> => {
    try {
      return await planZeroGCompute(query, config);
    } catch (err) {
      throw new PlanError(`0G Compute brain: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** Pull the assistant message content out of an OpenAI/0G-Compute-shaped chat-completions reply. */
function extractContent(body: unknown): string {
  const choices = (body as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ComputeBrainError("0G Compute reply had no message content");
  }
  return content;
}

/** The per-response id the broker attests against: the `ZG-Res-Key` response header, else the body `id`. */
function responseId(response: Response, body: unknown): string {
  const headerKey = response.headers?.get?.("ZG-Res-Key");
  if (typeof headerKey === "string" && headerKey.trim() !== "") {
    return headerKey;
  }
  const id = (body as { id?: unknown })?.id;
  if (typeof id === "string" && id.trim() !== "") {
    return id;
  }
  throw new ComputeBrainError("0G Compute reply carried no response id to attest against");
}

/** Extract + validate the allocation set from the model's reply text (a CLAIM). Loud on anything malformed. */
function parseAllocations(content: string): Allocation[] {
  const json = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ComputeBrainError(`0G Compute content was not parseable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = (parsed as { allocations?: unknown })?.allocations;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ComputeBrainError("0G Compute JSON had no non-empty allocations[]");
  }
  const out: Allocation[] = [];
  for (const a of raw) {
    const token = (a as { token?: unknown })?.token;
    const bps = (a as { bps?: unknown })?.bps;
    if (typeof token !== "string" || !(token in TOKENS)) {
      throw new ComputeBrainError(`0G Compute chose an unknown token: ${JSON.stringify(token)}`);
    }
    if (typeof bps !== "number" || !Number.isInteger(bps)) {
      throw new ComputeBrainError(`0G Compute bps is not an integer: ${String(bps)} for ${token}`);
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
    throw new ComputeBrainError("0G Compute reply contained no JSON object");
  }
  return body.slice(start, end + 1);
}
