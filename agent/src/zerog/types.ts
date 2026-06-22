/**
 * Types for the Brain proof -- the 0G Compute TEE attestation seam (design §9 Depth, §3).
 *
 * This file is the ORIGINAL, clean-room vocabulary the Brain leg speaks. It defines exactly one
 * narrow boundary -- [`AttestationProvider`] -- across which a real, network-bound 0G Compute broker
 * and an offline test double are interchangeable, plus the value types that flow over it and the one
 * honest output the loop reads: a [`BrainVerdict`].
 *
 * ## The single load-bearing rule (design §3 #1 / #2 / #3, applied to the Brain)
 *
 * "Brain" kills the claim *"you can't know which model ran"*. The proof is NOT the model's own words.
 * A model can SAY anything -- including "I ran in an enclave". The verdict's `attested` flag is true
 * ONLY when TWO independent cryptographic facts hold, both read from the 0G Compute network, NEITHER
 * derived from the model's reply text:
 *
 *   1. a verified **provider-service attestation** -- the serving node proved (via its remote-attestation
 *      report) that the advertised model image runs inside a genuine hardware enclave (TEE), AND
 *   2. a verified **per-response enclave signature** -- THIS specific response was signed by that same
 *      attested enclave's key, so the bytes we received are the bytes the enclave produced.
 *
 * `attested` is the AND of those two verified booleans. The model's self-report is never an input.
 * Any failure, gap, or unread leg makes `attested` false (never silently true) -- the never-fabricate
 * invariant (design §3 #3) on the Brain side: an unverifiable brain degrades LOUDLY to PENDING, exactly
 * as an unreadable settlement degrades to UNVERIFIED.
 *
 * ## Offline-by-default (design §6, clean-room)
 *
 * These are pure type/interface declarations -- zero runtime dependency, zero I/O. The real 0G broker
 * (`@0glabs/0g-serving-broker`) is imported dynamically ONLY on the operator-gated live path; the
 * default build and the tests satisfy [`AttestationProvider`] with an in-repo stub double. So `tsc`
 * and the test suite run with no SDK installed and no network reachable.
 *
 * ## Clean-room (design §6)
 *
 * No proprietary identifier, private path, or secret appears here. The vocabulary is original to this
 * repo; the only external names are the PUBLIC 0G Compute concepts (provider address, service
 * attestation, response signature) as documented at the public 0G docs.
 */

/**
 * A 0G Compute serving-provider address -- the on-chain identity of the TEE node that will run the
 * inference. It is read from operator config / env (`OG_COMPUTE_PROVIDER`), never hardcoded here, so no
 * live target is baked into the source (the data-spine rule). Shape: `0x` + 40 hex.
 */
export type ProviderAddress = string;

/**
 * The inference request the Brain leg sends to a 0G Compute provider -- the agent's PROMPT plus the
 * wire model id it expects to run. This is only the *request*; whether the named model actually ran in
 * an enclave is established by attestation, NOT by trusting this field or the reply (design §3 #1).
 */
export interface InferenceRequest {
  /** The provider (TEE serving node) to call -- from config/env, allowlist-checked before use. */
  readonly provider: ProviderAddress;
  /**
   * The wire model id the request targets (e.g. an org-prefixed id the provider advertises). It is an
   * EXPECTATION the attestation must corroborate, not a fact -- the verdict pins which model the
   * enclave actually attested, never this requested string.
   */
  readonly model: string;
  /** The system instruction (optional). Part of the prompt the enclave signs over. */
  readonly system?: string;
  /** The user prompt -- the agent's planning query. */
  readonly prompt: string;
}

/**
 * The model's textual reply plus the per-response handle needed to fetch its enclave signature.
 *
 * CRITICAL (design §3 #2): `content` is the model's OUTPUT -- a CLAIM, never trusted as proof. The
 * proof lives entirely in `responseId`, the opaque handle the attestation provider uses to retrieve and
 * verify the enclave's signature over this exact response. The verdict's `attested` flag is computed
 * from that signature verification, NEVER from anything inside `content`.
 */
export interface InferenceResponse {
  /** The provider that produced this response (echoed for the signature lookup). */
  readonly provider: ProviderAddress;
  /**
   * The opaque per-response identifier the enclave-signature check keys on (the public broker's
   * response/chat handle). It is the verifier's input, not a settlement -- present iff a real response
   * came back. Never fabricated.
   */
  readonly responseId: string;
  /** The model's textual output -- a CLAIM ONLY. Never an input to the `attested` decision. */
  readonly content: string;
}

/**
 * The verified result of the provider-service attestation pre-check (design §9 Depth: "the serving node
 * proved its model image runs in a real enclave").
 *
 * This mirrors the two independent checks a 0G Compute service attestation yields, reduced to honest
 * booleans: the enclave's measurement/signer matched the expected values (`signerMatch`), and the
 * deployed compose/image configuration passed (`composeMatch`). The service is TEE-trusted ONLY when
 * BOTH are true (`trusted`). A provider whose attestation does not fully verify is NOT trusted -- it is
 * never partially admitted (design §3 #3: no partial proof passes as a whole).
 */
export interface ServiceAttestation {
  /** The provider this attestation is for. */
  readonly provider: ProviderAddress;
  /** `true` iff the enclave's signer/measurement matched the expected attested values. */
  readonly signerMatch: boolean;
  /** `true` iff the deployed compose/image configuration verified. */
  readonly composeMatch: boolean;
  /**
   * `true` iff the provider's service is fully TEE-trusted -- the AND of `signerMatch` and
   * `composeMatch`. The ONLY value on which a provider may be allowlisted for inference.
   */
  readonly trusted: boolean;
}

/**
 * The verified result of the per-response enclave-signature check (design §9 Depth: "this exact
 * response was signed by the attested enclave").
 *
 * `signatureValid` is the second of the two cryptographic facts behind a green Brain stamp. It is the
 * broker's verification that the enclave's key signed THIS response (`responseId`) -- not a check of the
 * response text. A failed, missing, or not-yet-ready signature is `signatureValid: false` (never
 * coerced to true).
 */
export interface ResponseAttestation {
  /** The provider that signed (or should have signed) the response. */
  readonly provider: ProviderAddress;
  /** The response whose enclave signature was checked. */
  readonly responseId: string;
  /** `true` iff the enclave's signature over THIS response cryptographically verified. */
  readonly signatureValid: boolean;
}

/**
 * The Brain leg's single, honest output -- the verdict the loop and the web "brain" stamp read.
 *
 * `attested` is the proof. It is `true` ONLY when a verified [`ServiceAttestation`] (`trusted`) AND a
 * verified [`ResponseAttestation`] (`signatureValid`) both hold for this inference -- two independent
 * cryptographic facts, NEITHER taken from the model's reply (design §3 #1/#2). Every other outcome --
 * an un-allowlisted provider, a failed service attestation, an unverified response signature, a missing
 * SDK, an unreachable network -- yields `attested: false` with a loud `reason` (design §3 #3). There is
 * NO path on which an unproven brain reports `attested: true`.
 *
 * The web stamp maps `attested === true` -> green "LIVE" and everything else -> "PENDING" (design §9:
 * the default offline build keeps the stamp PENDING; only a real enclave attestation flips it green).
 */
export interface BrainVerdict {
  /**
   * `true` IFF the inference is provably enclave-attested -- service attestation trusted AND the
   * per-response enclave signature verified. The model's self-report is NEVER an input. This is the
   * green/PENDING bit the UI renders.
   */
  readonly attested: boolean;
  /** The provider that (claims to have) served the inference -- the journal/UI label. */
  readonly provider: ProviderAddress;
  /** The model id the service attestation pinned, when available -- "which model actually ran". */
  readonly model: string | undefined;
  /**
   * The per-response handle the attestation keyed on -- the auditable reference (like a tx hash for the
   * verifier). Present iff a real response came back; never fabricated.
   */
  readonly responseId: string | undefined;
  /**
   * The verified service-attestation result, when the pre-check ran. `undefined` iff the provider was
   * not allowlisted / the pre-check could not run -- in which case `attested` is `false`.
   */
  readonly service: ServiceAttestation | undefined;
  /**
   * The verified per-response signature result, when the response check ran. `undefined` iff no
   * response/signature was checkable -- in which case `attested` is `false`.
   */
  readonly response: ResponseAttestation | undefined;
  /**
   * A human-readable, journal/UI-only note: WHY the brain is PENDING (the loud degrade reason), or a
   * confirmation tag when attested. Never the source of truth -- `attested` is the only fact.
   */
  readonly reason: string;
}

/**
 * The narrow attestation seam (mirrors the verifier's `Source` trait and the mandate gate's
 * `EthCallTransport`): the ONE boundary the Brain leg reads its cryptographic facts across. A live 0G
 * Compute broker adapter and an offline test double both satisfy it, so the verdict logic is identical
 * whether it talks to a real enclave or a recorded reply.
 *
 * Every method returns a *verified boolean fact* (or throws on a transport failure, which the caller
 * maps to a fail-closed PENDING). No method returns, or trusts, model output.
 */
export interface AttestationProvider {
  /**
   * Run the provider-service attestation PRE-CHECK and return the verified [`ServiceAttestation`].
   *
   * This is the allowlist gate's input: a provider is admitted for inference ONLY if the returned
   * attestation is `trusted`. An implementation performs the remote-attestation verification (the live
   * broker's `verifyService`) and reduces it to the honest booleans. It THROWS on a transport/SDK
   * failure (the caller treats a throw as not-trusted -- never as trusted).
   */
  verifyService(provider: ProviderAddress): Promise<ServiceAttestation>;

  /**
   * Run the inference against the (already allowlisted) provider and return its [`InferenceResponse`].
   *
   * The returned `content` is a CLAIM (never trusted); the returned `responseId` is the handle the
   * signature check keys on. THROWS on a transport/SDK failure.
   */
  infer(request: InferenceRequest): Promise<InferenceResponse>;

  /**
   * Verify the per-response ENCLAVE SIGNATURE for `responseId` and return the verified
   * [`ResponseAttestation`].
   *
   * GOTCHA the live implementation must handle (design §9 Depth, from the proven 0G Compute leg): the
   * enclave signature is NOT immediately available the instant a response completes -- the provider
   * needs a brief settle window before the signature is fetchable. A live implementation retries with
   * backoff while the signature is "not ready", and surfaces a definitive `signatureValid` once it can.
   * It THROWS only on a non-recoverable transport/SDK failure (the caller treats a throw, or a `false`,
   * as not-verified).
   */
  verifyResponse(provider: ProviderAddress, responseId: string): Promise<ResponseAttestation>;
}
