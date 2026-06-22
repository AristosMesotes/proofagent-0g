/**
 * The Brain proof -- `attestInference(...)`: a verifiable "this exact model ran in a hardware enclave"
 * verdict, on the public 0G Compute network (design §9 Depth, design §3).
 *
 * "Brain" is the proof that kills the claim *"you can't know which model ran"*. The honest answer is
 * NOT the model's own words -- a model can say anything. The answer is two independent cryptographic
 * facts, both read from 0G Compute, NEITHER taken from the reply text:
 *
 *   1. a verified provider-SERVICE attestation -- the serving node's remote-attestation report proves
 *      its advertised model image runs inside a genuine TEE, and
 *   2. a verified per-RESPONSE enclave signature -- the attested enclave's key signed THIS response, so
 *      the bytes we got are the bytes the enclave produced.
 *
 * The verdict's [`BrainVerdict.attested`] is the AND of those two verified booleans. The model's
 * self-report is never an input (design §3 #2). Any gap -- an un-allowlisted provider, a failed service
 * attestation, an unverified signature, a missing SDK, an unreachable network -- yields `attested:
 * false` with a loud reason (design §3 #3): the brain degrades LOUDLY to PENDING, exactly as an
 * unreadable settlement degrades to UNVERIFIED. There is no code path on which an unproven brain
 * reports `attested: true`.
 *
 * ## The flow (design §9 Depth)
 *
 *   pre-check the provider's SERVICE attestation  (allowlist gate, cached with a TTL)
 *        └─ trusted?  no -> PENDING (loud, never infer against an un-attested node)
 *        └─ trusted?  yes ->
 *   run the inference                              (the reply `content` is a CLAIM only)
 *        └─
 *   verify the per-RESPONSE enclave signature      (retry while the signature is "not ready")
 *        └─ signatureValid?  no -> PENDING (loud)
 *        └─ signatureValid?  yes ->
 *   attested = service.trusted && response.signatureValid    (the ONLY true path)
 *
 * ## Offline-by-default + the live path is operator-gated (design §6, the honesty bar)
 *
 * This module is pure and dependency-free EXCEPT for [`liveAttestationProvider`], which dynamically
 * imports the public `@0glabs/0g-serving-broker` SDK ONLY when the operator explicitly constructs it
 * with a funded sub-account wallet. The default build, and every test, drives [`attestInference`] with
 * an in-repo stub [`AttestationProvider`] -- so `tsc` and the suite run with no SDK installed and no
 * network reachable. The live broker call (which needs a funded 0G sub-account + a TEE/TeeML provider)
 * is reached only on that opt-in path; the default offline build keeps the Brain stamp PENDING. We
 * NEVER fabricate an attestation.
 *
 * ## Clean-room (design §6)
 *
 * No proprietary identifier, private path, or secret appears here. The only external names are the
 * PUBLIC 0G Compute SDK package name and its documented broker concepts. The provider address, RPC, and
 * the (gitignored) broker wallet key all come from operator config/env, never baked into the source.
 */

import type {
  AttestationProvider,
  BrainVerdict,
  InferenceRequest,
  InferenceResponse,
  ProviderAddress,
  ResponseAttestation,
  ServiceAttestation,
} from "./types.js";

export type {
  AttestationProvider,
  BrainVerdict,
  InferenceRequest,
  InferenceResponse,
  ProviderAddress,
  ResponseAttestation,
  ServiceAttestation,
} from "./types.js";

/** A loud failure on the Brain path (design §3 #3 -- degrade loudly, never fabricate an attestation). */
export class BrainError extends Error {
  public override readonly name = "BrainError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, BrainError.prototype);
  }
}

/** Match a 20-byte EVM provider address: `0x` + exactly 40 hex digits (case-insensitive). */
const PROVIDER_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize + validate a provider address to lowercase `0x` + 40 hex. A malformed address is a loud
 * [`BrainError`] (never silently accepted), because attesting the wrong identity would be a false
 * proof. Surfaced before any allowlist/attestation work.
 */
export function normalizeProvider(provider: ProviderAddress): ProviderAddress {
  if (typeof provider !== "string" || !PROVIDER_RE.test(provider.trim())) {
    throw new BrainError(`provider must be a 0x + 40 hex address, got ${String(provider)}`);
  }
  return provider.trim().toLowerCase();
}

// ----------------------------------------------------------------------------------------------
// The attested-provider allowlist -- a TTL cache of providers whose SERVICE attestation verified.
// Redesigned as a pure, injectable value object (a `clock` is passed in) so it is deterministic and
// testable offline -- no hidden wall-clock, no module-global singleton (design §3 #4).
// ----------------------------------------------------------------------------------------------

/** A monotonic-ish time source in milliseconds. Injected so the allowlist is deterministic in tests. */
export type Clock = () => number;

/** The default real clock (epoch ms). Used only when a caller does not inject its own. */
export const systemClock: Clock = () => Date.now();

/** One hour, in ms -- the default re-attestation interval (a provider is re-verified hourly). */
export const DEFAULT_ATTESTATION_TTL_MS = 3_600_000;

/**
 * A TTL allowlist of providers whose SERVICE attestation has verified (design §9 Depth: "gate calls
 * behind a successful pre-flight service attestation").
 *
 * A provider is admitted only after [`verifyService`] returns `trusted`, and stays admitted for `ttlMs`
 * (re-attested after that). The allowlist holds ONLY providers that genuinely attested -- it is never
 * pre-seeded and an entry expires, so a node that loses its TEE status is re-checked. The cache keys on
 * the normalized address; `record` stores the attesting moment, `isFresh` answers "still within TTL".
 *
 * This is a redesigned, self-contained value object (no locks, no globals, an injected clock) -- chosen
 * because the agent's Brain path is single-threaded async and determinism (design §3 #4) matters more
 * here than the cross-thread safety the proven reference needed.
 */
export class AttestationAllowlist {
  private readonly attestedAt = new Map<ProviderAddress, number>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  public constructor(options?: { readonly clock?: Clock; readonly ttlMs?: number }) {
    this.clock = options?.clock ?? systemClock;
    const ttl = options?.ttlMs ?? DEFAULT_ATTESTATION_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new BrainError(`attestation TTL must be a positive, finite ms value, got ${String(ttl)}`);
    }
    this.ttlMs = ttl;
  }

  /** `true` iff `provider` attested within the TTL window (so its service proof is still fresh). */
  public isFresh(provider: ProviderAddress): boolean {
    const at = this.attestedAt.get(normalizeProvider(provider));
    if (at === undefined) {
      return false;
    }
    return this.clock() - at < this.ttlMs;
  }

  /** Record a successful service attestation for `provider` at the current clock time. */
  public record(provider: ProviderAddress): void {
    this.attestedAt.set(normalizeProvider(provider), this.clock());
  }

  /** Forget `provider` (force a re-attestation on its next use). */
  public forget(provider: ProviderAddress): void {
    this.attestedAt.delete(normalizeProvider(provider));
  }

  /** Drop every entry (e.g. a config change) -- the next call re-attests from scratch. */
  public clear(): void {
    this.attestedAt.clear();
  }
}

// ----------------------------------------------------------------------------------------------
// attestInference -- the Brain verdict. Pre-check service attestation (allowlisted, TTL) -> infer ->
// verify the per-response enclave signature -> attested = AND of the two verified facts. Fail-closed.
// ----------------------------------------------------------------------------------------------

/**
 * Options for [`attestInference`] -- the injected seams and policy, all optional with safe defaults.
 */
export interface AttestOptions {
  /**
   * The allowlist of already-service-attested providers (TTL-cached). Inject a shared instance to reuse
   * a recent attestation across calls; omit to use a fresh per-call allowlist (always re-attests).
   */
  readonly allowlist?: AttestationAllowlist;
  /**
   * `true` (default) re-runs the SERVICE attestation pre-check unless the provider is fresh in the
   * allowlist. There is no way to SKIP the pre-check -- a provider with no fresh attestation is always
   * verified before inference. (This flag exists only to let a caller force a re-check by passing a
   * fresh-but-stale allowlist; it can never turn the gate OFF.)
   */
  readonly reattest?: boolean;
}

/** A loud PENDING verdict helper -- `attested:false` with the given reason, carrying any known facts. */
function pending(
  provider: ProviderAddress,
  reason: string,
  facts?: {
    readonly model?: string | undefined;
    readonly responseId?: string | undefined;
    readonly service?: ServiceAttestation | undefined;
    readonly response?: ResponseAttestation | undefined;
  },
): BrainVerdict {
  return {
    attested: false,
    provider,
    model: facts?.model,
    responseId: facts?.responseId,
    service: facts?.service,
    response: facts?.response,
    reason,
  };
}

/**
 * Produce the Brain [`BrainVerdict`] for an inference request -- the green/PENDING "which model ran"
 * proof (design §9 Depth, §3).
 *
 * The verdict's `attested` is `true` ONLY when BOTH cryptographic facts verify -- a `trusted` service
 * attestation AND a `signatureValid` per-response enclave signature -- NEITHER derived from the model's
 * reply (design §3 #1/#2). Fail-CLOSED everywhere else (design §3 #3):
 *
 *  - malformed provider address     => loud [`BrainError`] thrown (a programmer error in the request).
 *  - service attestation not trusted => PENDING (never infer against an un-attested node).
 *  - service attestation read throws => PENDING (loud transport reason).
 *  - inference call throws           => PENDING (loud transport reason; no response to attest).
 *  - response signature not valid    => PENDING (the response is unproven).
 *  - response check throws           => PENDING (loud transport reason).
 *  - BOTH verified                   => attested:true (the ONLY true path).
 *
 * The function NEVER throws for an OPERATIONAL failure -- it returns a loud PENDING so the loop always
 * gets a definitive attested/PENDING answer. It DOES throw [`BrainError`] for a programmer error in the
 * request (a malformed provider address), surfaced before any network work.
 *
 * @param request   The inference request (provider, model, prompt). `provider` is allowlist-checked.
 * @param attestor  The attestation seam -- a live 0G Compute broker adapter OR an offline test double.
 * @param options   Optional allowlist (TTL-cached service attestations) + re-attest policy.
 */
export async function attestInference(
  request: InferenceRequest,
  attestor: AttestationProvider,
  options?: AttestOptions,
): Promise<BrainVerdict> {
  // Validate the provider up front -- a malformed address is a programmer error (loud throw), distinct
  // from an operational failure (loud PENDING). Normalizing here pins the identity we attest/allowlist.
  const provider = normalizeProvider(request.provider);
  const allowlist = options?.allowlist ?? new AttestationAllowlist();

  // --- Leg 1: the provider-SERVICE attestation pre-check (allowlist gate, TTL-cached) ---
  // We re-attest unless the provider is already fresh in the allowlist. There is no "skip" -- a
  // provider with no fresh attestation is ALWAYS verified before we will infer against it (design §9).
  let service: ServiceAttestation | undefined;
  if (!allowlist.isFresh(provider)) {
    try {
      service = await attestor.verifyService(provider);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return pending(provider, `BRAIN_SERVICE_ATTESTATION_ERROR: ${detail}`);
    }
    if (!service.trusted) {
      // An un-attested node is never inferred against -- the brain stays PENDING, loudly.
      return pending(
        provider,
        `BRAIN_SERVICE_NOT_TRUSTED: provider service attestation failed ` +
          `(signerMatch=${service.signerMatch}, composeMatch=${service.composeMatch})`,
        { service },
      );
    }
    allowlist.record(provider);
  }

  // --- Leg 2: run the inference. The reply `content` is a CLAIM ONLY (design §3 #2) -- it is NEVER an
  // input to `attested`. A failed call yields PENDING (no response exists to attest). ---
  let response: InferenceResponse;
  try {
    response = await attestor.infer({ ...request, provider });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return pending(provider, `BRAIN_INFERENCE_ERROR: ${detail}`, { service });
  }
  if (typeof response.responseId !== "string" || response.responseId.trim() === "") {
    // No per-response handle => no signature to verify => the response is unprovable => PENDING.
    return pending(provider, "BRAIN_NO_RESPONSE_ID: inference returned no signable response handle", {
      service,
    });
  }

  // --- Leg 3: verify the per-RESPONSE enclave signature for THIS response (design §9 Depth). The live
  // implementation handles the "signature not ready" settle window with retry/backoff; here we just
  // read its definitive verified boolean. A throw or a false => PENDING (the response is unproven). ---
  let signature: ResponseAttestation;
  try {
    signature = await attestor.verifyResponse(provider, response.responseId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return pending(provider, `BRAIN_RESPONSE_ATTESTATION_ERROR: ${detail}`, {
      service,
      responseId: response.responseId,
    });
  }
  if (!signature.signatureValid) {
    return pending(provider, "BRAIN_RESPONSE_NOT_SIGNED: enclave signature over the response did not verify", {
      service,
      responseId: response.responseId,
      response: signature,
    });
  }

  // --- The verdict: attested = service.trusted AND signature.signatureValid. BOTH verified facts hold;
  // neither came from the model's reply text. This is the ONLY path to attested:true (design §3 #1/#2).
  // (`service` may be undefined here ONLY when the allowlist was already fresh -- i.e. a prior call in
  // this allowlist's TTL window already verified `trusted`; the freshness IS the service proof.)
  const serviceTrusted = service === undefined ? allowlist.isFresh(provider) : service.trusted;
  const attested = serviceTrusted && signature.signatureValid;
  if (!attested) {
    // Defensive: only reachable if a fresh-allowlist invariant were violated. Never fabricate.
    return pending(provider, "BRAIN_NOT_ATTESTED: service attestation no longer fresh", {
      service,
      responseId: response.responseId,
      response: signature,
    });
  }
  return {
    attested: true,
    provider,
    model: request.model,
    responseId: response.responseId,
    service,
    response: signature,
    reason: "BRAIN_ATTESTED: service attestation trusted AND per-response enclave signature verified",
  };
}

// ----------------------------------------------------------------------------------------------
// The per-response signature retry helper -- the redesigned "settle window" gotcha (design §9 Depth).
// A live signature check must tolerate a brief "not ready" window after a response completes; this is
// a PURE, deterministic, offline-testable retry loop (the delay is injected, so tests need no timers).
// ----------------------------------------------------------------------------------------------

/** A check that returns a definitive [`ResponseAttestation`], or throws "not ready" while it settles. */
export type ResponseSignatureCheck = () => Promise<ResponseAttestation>;

/** A delay function (ms) -> Promise. Injected so tests resolve instantly with no real timers. */
export type Sleeper = (ms: number) => Promise<void>;

/** The default real sleeper (a `setTimeout`-backed delay). Used only on the live path. */
export const systemSleeper: Sleeper = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Tuning for [`retryResponseSignature`] -- max attempts + the exponential-backoff base delay. */
export interface RetryPolicy {
  /** Max attempts before giving up (default 6 -- ~0.5+1+2+4+8s budget at the default base). */
  readonly maxAttempts?: number;
  /** The base backoff delay in ms (default 500). Attempt i waits `base * 2^i`. */
  readonly baseDelayMs?: number;
  /**
   * Classify an error as the recoverable "signature not yet ready" condition. A matching error is
   * retried (after backoff); any other error is non-recoverable and re-thrown immediately. Default:
   * matches the documented "signature not ready / attestation report 404" settle-window errors.
   */
  readonly isNotReady?: (err: unknown) => boolean;
}

/** The documented recoverable settle-window errors (signature not yet fetchable). */
const DEFAULT_NOT_READY = /not\s*ready|signature.*(unavailable|pending|error)|attestation.*404|\b404\b/i;

/** Default classifier: treat the documented settle-window errors as recoverable, everything else fatal. */
export function defaultIsNotReady(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return DEFAULT_NOT_READY.test(msg);
}

/**
 * Verify a per-response enclave signature WITH retry over the "signature not ready" settle window
 * (design §9 Depth -- the proven gotcha: the enclave signature is not fetchable the instant a response
 * completes; the provider needs a brief settle window).
 *
 * It calls `check` up to `maxAttempts` times. On a recoverable "not ready" error it waits an
 * exponential backoff (`baseDelayMs * 2^i`, via the injected `sleep`) and retries; on ANY other error
 * it re-throws immediately (a non-settle-window failure is fatal). It returns the first definitive
 * [`ResponseAttestation`] (whose `signatureValid` may be true or false -- a definitive `false` is a
 * real verdict, not a "not ready", and is returned, not retried). Exhausting the attempts re-throws the
 * last "not ready" error.
 *
 * This is PURE + deterministic given an injected `sleep` (design §3 #4): tests drive it with a no-op
 * sleeper, so the full retry path is exercised with zero real timers and zero network.
 *
 * @param check   The signature check (resolves a definitive attestation, or throws "not ready").
 * @param policy  Attempts + backoff + the not-ready classifier (all defaulted).
 * @param sleep   The delay function (injected; defaults to the real `setTimeout` sleeper).
 */
export async function retryResponseSignature(
  check: ResponseSignatureCheck,
  policy?: RetryPolicy,
  sleep: Sleeper = systemSleeper,
): Promise<ResponseAttestation> {
  const maxAttempts = policy?.maxAttempts ?? 6;
  const baseDelayMs = policy?.baseDelayMs ?? 500;
  const isNotReady = policy?.isNotReady ?? defaultIsNotReady;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new BrainError(`maxAttempts must be a positive integer, got ${String(maxAttempts)}`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new BrainError(`baseDelayMs must be a non-negative finite number, got ${String(baseDelayMs)}`);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // A definitive result (signatureValid true OR false) is returned as-is -- a `false` is a real
      // "the signature did not verify" verdict, NOT a settle-window retry condition.
      return await check();
    } catch (err) {
      lastErr = err;
      const recoverable = isNotReady(err);
      // Last attempt, or a non-recoverable error => bubble up (the caller maps it to PENDING).
      if (attempt === maxAttempts - 1 || !recoverable) {
        throw err;
      }
      // Recoverable settle-window error: back off (injected sleep) and retry with a re-fetch.
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  // Unreachable in practice (the loop returns or throws), but keep the contract total + honest.
  throw lastErr instanceof Error
    ? lastErr
    : new BrainError("retryResponseSignature: exhausted attempts with no definitive result");
}

// ----------------------------------------------------------------------------------------------
// liveAttestationProvider -- the OPERATOR-GATED live path. Dynamically imports the PUBLIC
// @0glabs/0g-serving-broker ONLY here, so the default build / tests never need the SDK or the network.
// This needs a FUNDED 0G sub-account wallet + a TEE/TeeML provider; it is opt-in by construction.
// ----------------------------------------------------------------------------------------------

/**
 * Operator config for the LIVE 0G Compute attestation path. Every field is operator-supplied; NONE is
 * hardcoded. The wallet key is read from a gitignored env var by the caller and passed in here -- it is
 * NEVER logged, printed, or committed (the honesty bar). This path needs a funded 0G sub-account and a
 * TEE/TeeML provider, so it is opt-in and infra-gated.
 */
export interface LiveBrokerConfig {
  /** The broker wallet PRIVATE KEY (from a gitignored env var; never logged/committed). */
  readonly walletPrivateKey: string;
  /** The 0G JSON-RPC endpoint URL (from env -- e.g. `OG_RPC`). Never hardcoded. */
  readonly rpcUrl: string;
  /** A directory the SDK writes the attestation report into (operator-provided scratch path). */
  readonly attestationReportDir: string;
  /** OPTIONAL retry policy for the per-response signature settle window. */
  readonly retry?: RetryPolicy;
}

/**
 * The minimal shape this module needs from the PUBLIC `@0glabs/0g-serving-broker` broker's `inference`
 * surface. Declaring it locally (rather than importing SDK types) keeps `tsc` fully offline -- the real
 * SDK is loaded only at runtime on the live path, and is structurally checked against this shape there.
 *
 * These names mirror the PUBLIC broker API (service verification, request headers, response
 * verification) as documented at the public 0G Compute docs -- no proprietary surface.
 */
interface PublicBrokerInference {
  /** Verify a provider's SERVICE attestation; returns the report (signer/compose verification). */
  verifyService(
    provider: string,
    reportDir: string,
    step: (s: unknown) => void,
  ): Promise<unknown>;
  /** Obtain the single-use, signed request headers for a metered inference call. */
  getRequestHeaders(provider: string): Promise<Record<string, string>>;
  /** Verify a completed RESPONSE's enclave signature; returns/throws per the SDK contract. */
  processResponse(provider: string, responseId: string): Promise<unknown>;
}

/** The minimal PUBLIC broker shape (its `inference` surface) the live adapter needs. */
interface PublicBroker {
  readonly inference: PublicBrokerInference;
}

/** Reduce the SDK's `verifyService` report into the honest [`ServiceAttestation`] booleans. */
function reduceServiceReport(provider: ProviderAddress, report: unknown): ServiceAttestation {
  const rec = (typeof report === "object" && report !== null ? report : {}) as Record<string, unknown>;
  const signerMatch = readNestedFlag(rec["signerVerification"], "allMatch");
  const composeMatch = readNestedFlag(rec["composeVerification"], "passed");
  return { provider, signerMatch, composeMatch, trusted: signerMatch && composeMatch };
}

/** Read a nested boolean flag (`outer[key]`), tolerating a bare boolean `outer`. Defaults to false. */
function readNestedFlag(outer: unknown, key: string): boolean {
  if (typeof outer === "boolean") {
    return outer;
  }
  if (typeof outer === "object" && outer !== null) {
    return Boolean((outer as Record<string, unknown>)[key]);
  }
  return false;
}

/**
 * Construct the LIVE [`AttestationProvider`] backed by the public `@0glabs/0g-serving-broker` SDK
 * (design §9 Depth). The SDK is imported DYNAMICALLY here -- the default offline build and the tests
 * never load it. The returned provider performs real remote attestation + a real metered inference +
 * real per-response signature verification (with the settle-window retry), all against a FUNDED 0G
 * sub-account. This is the operator-gated path; the default build keeps the Brain stamp PENDING.
 *
 * Design note (the inference leg, intentionally infra-gated): a fully metered 0G Compute chat
 * completion is issued through the broker's signed request headers against the provider's
 * OpenAI-compatible endpoint -- a step that genuinely requires the funded sub-account and the live
 * provider URL. Rather than bake an HTTP client + endpoint discovery into the default build, the live
 * `infer` is wired by the operator at deploy time (it is the one leg that cannot be exercised offline);
 * `verifyService` and `verifyResponse` -- the two legs that actually MINT the attestation -- are fully
 * implemented here against the public broker, because they are the proof, and the proof is what must be
 * real. The model output is never the proof, so a not-yet-wired `infer` cannot weaken `attested`.
 *
 * @throws {BrainError} if the SDK or the wallet/RPC cannot be loaded (loud -- never a fake provider).
 */
export async function liveAttestationProvider(
  config: LiveBrokerConfig,
  infer: (request: InferenceRequest, headers: Record<string, string>) => Promise<InferenceResponse>,
): Promise<AttestationProvider> {
  if (typeof config.walletPrivateKey !== "string" || config.walletPrivateKey.trim() === "") {
    throw new BrainError("liveAttestationProvider: a broker wallet key is required (from a gitignored env var)");
  }
  if (typeof config.rpcUrl !== "string" || config.rpcUrl.trim() === "") {
    throw new BrainError("liveAttestationProvider: an RPC endpoint URL is required (from env)");
  }
  if (typeof config.attestationReportDir !== "string" || config.attestationReportDir.trim() === "") {
    throw new BrainError("liveAttestationProvider: an attestation report directory is required");
  }

  // Dynamically import the PUBLIC SDK ONLY here. A missing SDK is a loud BrainError, never a fake
  // attestor. The import is behind a string the offline tsc never resolves (it is opt-in at runtime).
  const broker = await loadPublicBroker(config);

  return {
    async verifyService(provider: ProviderAddress): Promise<ServiceAttestation> {
      const p = normalizeProvider(provider);
      const report = await broker.inference.verifyService(p, config.attestationReportDir, () => undefined);
      return reduceServiceReport(p, report);
    },

    async infer(request: InferenceRequest): Promise<InferenceResponse> {
      const p = normalizeProvider(request.provider);
      // Single-use signed request headers, re-fetched PER attempt (the documented single-use-nonce
      // gotcha: a request header set is consumed once; a retry must re-sign). The operator-wired
      // `infer` performs the metered chat completion against the provider's OpenAI-compatible endpoint.
      const headers = await broker.inference.getRequestHeaders(p);
      return infer({ ...request, provider: p }, headers);
    },

    async verifyResponse(provider: ProviderAddress, responseId: string): Promise<ResponseAttestation> {
      const p = normalizeProvider(provider);
      // The per-response signature is not ready the instant the response completes (the settle-window
      // gotcha) -> retry with backoff over the documented "not ready" errors. A definitive boolean ends
      // the loop; a non-settle-window error is fatal.
      return retryResponseSignature(
        async () => {
          const ok = await broker.inference.processResponse(p, responseId);
          return { provider: p, responseId, signatureValid: Boolean(ok) };
        },
        config.retry,
      );
    },
  };
}

/**
 * Dynamically load the public broker SDK and build the broker against the operator's wallet + RPC.
 * Isolated so the dynamic import + wallet construction is in ONE place and the offline build never
 * resolves it. The SDK package name is the PUBLIC `@0glabs/0g-serving-broker`; `ethers` is its
 * documented peer for the wallet/provider.
 *
 * @throws {BrainError} on any load/construction failure (loud -- never returns a fake broker).
 */
async function loadPublicBroker(config: LiveBrokerConfig): Promise<PublicBroker> {
  // The package names are public; the dynamic import keeps them out of the offline compile graph.
  const sdkName = "@0glabs/0g-serving-broker";
  const ethersName = "ethers";
  let createBroker: (wallet: unknown) => Promise<unknown>;
  let walletCtor: new (key: string, provider: unknown) => unknown;
  let providerCtor: new (rpc: string) => unknown;
  try {
    const sdk = (await import(sdkName)) as {
      createZGComputeNetworkBroker?: (wallet: unknown) => Promise<unknown>;
    };
    const eth = (await import(ethersName)) as {
      Wallet?: new (key: string, provider: unknown) => unknown;
      JsonRpcProvider?: new (rpc: string) => unknown;
    };
    if (typeof sdk.createZGComputeNetworkBroker !== "function") {
      throw new BrainError("the 0G serving-broker SDK did not export createZGComputeNetworkBroker");
    }
    if (typeof eth.Wallet !== "function" || typeof eth.JsonRpcProvider !== "function") {
      throw new BrainError("ethers did not export Wallet / JsonRpcProvider");
    }
    createBroker = sdk.createZGComputeNetworkBroker;
    walletCtor = eth.Wallet;
    providerCtor = eth.JsonRpcProvider;
  } catch (err) {
    if (err instanceof BrainError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new BrainError(`failed to load the public 0G Compute SDK (live path is operator-gated): ${detail}`);
  }

  let broker: unknown;
  try {
    const rpcProvider = new providerCtor(config.rpcUrl.trim());
    const wallet = new walletCtor(config.walletPrivateKey.trim(), rpcProvider);
    broker = await createBroker(wallet);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BrainError(`failed to build the 0G Compute broker (wallet/RPC): ${detail}`);
  }

  if (
    typeof broker !== "object" ||
    broker === null ||
    typeof (broker as { inference?: unknown }).inference !== "object" ||
    (broker as { inference?: unknown }).inference === null
  ) {
    throw new BrainError("the 0G Compute broker is missing its inference surface");
  }
  return broker as PublicBroker;
}
