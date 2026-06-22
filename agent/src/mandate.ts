/**
 * The mandate gate -- `checkMandate(agent, token, amount)`, the loop's pre-broadcast kill-switch.
 *
 * Design SS4 (architecture, `agent/mandate.ts`): "eth_call checkTransfer(agent, token, amount) --
 * pre-broadcast gate". Design SS5 (the loop): the gate is the second leg of
 * `plan -> mandate-gate -> execute -> verify`, and "a failing mandate verdict means the agent does
 * not execute -- the cap is a kill-switch, enforced before any broadcast." Design SS2 (the Rails
 * proof): the on-chain `MandateRegistry.checkTransfer()` "rejects any spend over the cap, before
 * broadcast, as a zero-gas `eth_call`."
 *
 * This module is the OFF-CHAIN half of that gate: it builds the `checkTransfer` calldata, performs
 * the `eth_call` against the deployed registry, decodes the on-chain `(bool ok, bytes32 reason)`
 * answer, and turns it into a single, honest **execute / DO-NOT-EXECUTE** decision the loop obeys.
 *
 * ## The kill-switch is fail-CLOSED (design SS3 principle 3 + SS5)
 *
 * "An unavailable, off-record, or unreadable result degrades loudly ... never silently to a
 * fabricated `SETTLED`." The mandate gate mirrors that on the spend side: a transfer executes ONLY
 * on a definitive on-chain `ok == true`. Every other outcome -- a `false` verdict, an unreachable
 * RPC, a malformed response, or **no transport wired at all** -- yields `allowed: false`. There is
 * no code path in which an unread or failed gate returns `allowed: true`; the kill-switch fails
 * CLOSED, so a buggy or hijacked agent cannot spend by making the check merely *fail to answer*.
 *
 * ## Two-source truth at the read boundary (design SS3 principle 1)
 *
 * The on-chain registry is the authority on spend, exactly as the chain (not the app's word) is the
 * authority on settlement for the verifier. The agent's plan is only a *proposal*; the chain's
 * `checkTransfer` is the *fact*. The read goes through one narrow seam -- [`EthCallTransport`] --
 * which a live JSON-RPC reader and an offline test double both satisfy, so swapping a real call for
 * a recorded one never changes what a verdict *means* (this mirrors the verifier's `Source` trait).
 *
 * ## Default build needs no network (design SS6, clean-room / offline-by-default)
 *
 * The pure ABI codec ([`encodeCheckTransfer`] / [`decodeCheckTransfer`]) and the decision logic are
 * std-only -- zero runtime dependencies, no I/O. The only network leg is [`fetchEthCallTransport`],
 * which a caller must *explicitly* construct with an RPC endpoint; [`checkMandate`] called without a
 * transport performs NO network access and returns a loud not-wired DO-NOT-EXECUTE. So `tsc` and the
 * default loop are fully offline; the live `eth_call` is opt-in, supplied by the operator's config.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * `amount` is a `bigint` in the token's MINOR units -- never a `number`, never a float. It is
 * ABI-encoded as a 256-bit word and compared on-chain with exact `uint256` arithmetic. There is no
 * floating-point arithmetic anywhere on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The function selector is derived
 * from the public `checkTransfer(address,address,uint256)` signature of the in-repo MandateRegistry.
 */

/**
 * The on-chain reason codes returned by `MandateRegistry.checkTransfer` (its second return value).
 *
 * These mirror the contract's `bytes32` reason constants EXACTLY (the MVP `MandateRegistry.sol`, the
 * four-tier `MandateRegistryV3.sol`, and the CONSOLIDATED-HARDENED `MandateRegistryV4.sol` REASON_*).
 * They are ASCII tags so the off-chain gate / the web UI can render WHY a spend was blocked without a
 * side lookup. `OK` (the zero word) is the only `ok == true` reason.
 *
 * The KILL-SWITCH is reason-AGNOSTIC: the gate refuses on ANY `ok !== true` (fail-closed), so a NEW
 * reason tag the contract introduces is enforced PRE-broadcast automatically -- this map only gives the
 * journal/UI a human label. The consolidated registry's hardened tags (NOT_STARTED, EPOCH_STALE,
 * BELOW_MIN_SPEND, SPENDER_NOT_ALLOWED, OVER_DEST_CAP, OVER_PERIOD_CAP, OVER_TXCOUNT_CAP,
 * PRICE_UNAVAILABLE, BELOW_MIN_USD, OVER_USD_CAP, AGENT_PAUSED) are listed here for that rendering.
 *
 * HONEST framing (advisory + verifier-enforced + non-custodial): "the mandate blocks it pre-broadcast
 * and the verifier proves it", NEVER "physically can't overspend".
 */
export const MANDATE_REASON = {
  /** The transfer is within the mandate -- the only `ok == true` reason (the contract's `bytes32(0)`). */
  OK: "OK",
  /** The mandate is paused (global kill-switch engaged on-chain) -- nothing is permitted. */
  PAUSED: "PAUSED",
  /** This specific agent is paused (per-agent kill-switch). */
  AGENT_PAUSED: "AGENT_PAUSED",
  /** The mandate has not yet started (now < start; the half-open window's lower edge). */
  NOT_STARTED: "NOT_STARTED",
  /** The mandate's expiry has passed. */
  EXPIRED: "EXPIRED",
  /** `agent` is not the mandated agent for this registry. */
  NOT_AGENT: "NOT_AGENT",
  /** The request's epoch != the current epoch -- a revoked / stranded in-flight grant. */
  EPOCH_STALE: "EPOCH_STALE",
  /** `amount` is zero -- a no-op spend is never a valid mandated transfer. */
  ZERO_AMOUNT: "ZERO_AMOUNT",
  /** `amount` is below the raw dust floor `minSpend`. */
  BELOW_MIN_SPEND: "BELOW_MIN_SPEND",
  /** `token` is not on the allowlist. */
  TOKEN_NOT_ALLOWED: "TOKEN_NOT_ALLOWED",
  /** `spender` (router/destination/spoke) is not allowlisted / is an unconfigured spoke (default-deny). */
  SPENDER_NOT_ALLOWED: "SPENDER_NOT_ALLOWED",
  /** `amount` exceeds the global per-transaction cap. */
  OVER_TX_CAP: "OVER_TX_CAP",
  /** `amount` exceeds this token's per-asset sub-cap. */
  OVER_ASSET_CAP: "OVER_ASSET_CAP",
  /** `amount` exceeds the per-destination/spoke 'sandbox' cap (or a blocked dest's zero allowance). */
  OVER_DEST_CAP: "OVER_DEST_CAP",
  /** the spend would push the leaky-bucket level over the period cap (the looping-drain guard). */
  OVER_PERIOD_CAP: "OVER_PERIOD_CAP",
  /** the spend would push the tx-count leaky-bucket over `maxTxPerPeriod`. */
  OVER_TXCOUNT_CAP: "OVER_TXCOUNT_CAP",
  /** a USD cap is on but the price is unavailable/zero/STALE/out-of-band/overflow -> fail-closed. */
  PRICE_UNAVAILABLE: "PRICE_UNAVAILABLE",
  /** the spend priced in USD is below the USD dust floor `minUsdMicros`. */
  BELOW_MIN_USD: "BELOW_MIN_USD",
  /** the spend priced in USD exceeds the USD cap `usdCapMicros`. */
  OVER_USD_CAP: "OVER_USD_CAP",
} as const;

/** A human-readable mandate reason tag (the decoded on-chain `bytes32`, ASCII). */
export type MandateReason = (typeof MANDATE_REASON)[keyof typeof MANDATE_REASON];

/**
 * The pre-broadcast spend proposal the gate checks -- the agent's *claim* it wants to transfer
 * `amount` of `token`. This is only a proposal; the chain's `checkTransfer` is the authority.
 */
export interface MandateRequest {
  /** The agent address proposing the transfer (must equal the registry's mandated `agent`). */
  readonly agent: string;
  /** The asset to transfer (must be allowlisted on the registry). */
  readonly token: string;
  /** The transfer amount in `token`'s MINOR units -- a `bigint`, exact-integer (design SS3 #5). */
  readonly amount: bigint;
}

/**
 * The gate's single, honest decision -- the **kill-switch** output (design SS4/SS5).
 *
 * `allowed` is the loop's instruction: `true` => proceed to broadcast; `false` => DO NOT execute.
 * It is `true` ONLY on a definitive on-chain `ok == true`; every failure, unread, or not-wired case
 * is `allowed: false` (fail-closed -- design SS3 principle 3). `reason` carries the on-chain reason
 * tag (when the chain answered) or a loud off-chain reason for the journal/UI; it never changes the
 * meaning of `allowed`.
 */
export interface MandateVerdict {
  /** `true` iff the transfer is provably within the mandate (a definitive on-chain `ok == true`). */
  readonly allowed: boolean;
  /** The reason tag: an on-chain [`MandateReason`] when read, else a loud off-chain reason string. */
  readonly reason: MandateReason | string;
  /**
   * `true` iff the on-chain `eth_call` actually answered (the verdict reflects a real chain read);
   * `false` iff the gate could not read the chain (no transport, RPC error, malformed reply). When
   * `false`, `allowed` is ALWAYS `false` -- an unread gate never permits a spend (the never-fabricate
   * invariant, design SS3 principle 3, applied to the spend side).
   */
  readonly verified: boolean;
}

/**
 * The address of the deployed `MandateRegistry` to gate against, plus the agent identity.
 *
 * `registry` is read from operator config (`MANDATE_REGISTRY_ADDRESS` / `proofagent.toml [mandate]`)
 * -- never hardcoded here, so no on-chain target is baked into the source (design data-spine). The
 * empty-string default means "not yet deployed/pinned" and makes [`checkMandate`] fail CLOSED with a
 * loud not-configured reason, never silently allow.
 */
export interface MandateConfig {
  /** The deployed `MandateRegistry` address (`0x` + 40 hex). Empty until confirmed on-chain. */
  readonly registry: string;
}

/**
 * The independent on-chain read seam for the gate -- an `eth_call` transport (mirrors the verifier's
 * `Source` trait). A live JSON-RPC reader and an offline test double both satisfy it, so the gate's
 * decision logic is identical whether it reads the real chain or a recorded reply.
 *
 * An implementation returns the raw `0x`-prefixed hex result of `eth_call`, or throws on any
 * transport failure (the gate maps a throw to a loud, fail-closed DO-NOT-EXECUTE -- it never lets a
 * transport error become an allow).
 */
export interface EthCallTransport {
  /**
   * Perform `eth_call({ to, data }, "latest")` and return the raw hex result (`0x...`).
   * @param to    The contract address to call (the `MandateRegistry`).
   * @param data  The ABI-encoded calldata (selector + args).
   * @throws on any transport/RPC failure -- the gate treats a throw as DO-NOT-EXECUTE.
   */
  ethCall(to: string, data: string): Promise<string>;
}

/** A loud planning/gate failure on the spend path (design SS3 principle 3 -- degrade loudly). */
export class MandateError extends Error {
  public override readonly name = "MandateError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, MandateError.prototype);
  }
}

// ----------------------------------------------------------------------------------------------
// ABI codec -- pure, std-only, no deps. Encodes the `checkTransfer(address,address,uint256)` call
// and decodes the `(bool, bytes32)` return, exactly matching contracts/src/MandateRegistry.sol.
// ----------------------------------------------------------------------------------------------

/**
 * The 4-byte function selector for `checkTransfer(address,address,uint256)`.
 *
 * This is the first 4 bytes of `keccak256("checkTransfer(address,address,uint256)")`. It is pinned
 * as a constant (rather than hashed at runtime) so the codec needs NO keccak dependency and stays
 * std-only/offline (design SS6). The selector is verified against the canonical signature by
 * [`CHECK_TRANSFER_SIGNATURE`] in the tests, so a drift from the contract is caught.
 *
 * Derivation (public, reproducible): `cast sig "checkTransfer(address,address,uint256)"` =>
 * `0xcc1dd94f`. It also equals the compiled artifact's `methodIdentifiers["checkTransfer(...)"]`.
 */
export const CHECK_TRANSFER_SELECTOR = "0xcc1dd94f" as const;

/** The canonical function signature the selector is derived from (for the conformance test). */
export const CHECK_TRANSFER_SIGNATURE = "checkTransfer(address,address,uint256)" as const;

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize and validate a 20-byte EVM address to its lowercase, `0x`-prefixed 40-hex canonical
 * form. A malformed address is a loud [`MandateError`] (never silently zero-padded or truncated),
 * because a wrong address would gate against the wrong identity/asset.
 */
function normalizeAddress(label: string, addr: string): string {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr.trim())) {
    throw new MandateError(`${label} must be a 20-byte 0x address (0x + 40 hex), got ${String(addr)}`);
  }
  return addr.trim().toLowerCase();
}

/** Left-pad an address to a 32-byte (64-hex) ABI word (addresses are right-aligned in their word). */
function addressWord(addr: string): string {
  // addr is already validated/lowercased; strip 0x, left-pad the 40 hex digits to 64.
  return addr.slice(2).padStart(64, "0");
}

/**
 * Encode a non-negative `uint256` (a `bigint` in minor units) to a 32-byte ABI word.
 *
 * Exact-integer only (design SS3 principle 5): rejects a negative amount and any value that does not
 * fit in 256 bits -- a loud [`MandateError`], never a wrapped/truncated word. No float is involved.
 */
function uint256Word(label: string, value: bigint): string {
  if (typeof value !== "bigint") {
    throw new MandateError(`${label} must be a bigint in minor units (exact-integer money path)`);
  }
  if (value < 0n) {
    throw new MandateError(`${label} must be non-negative, got ${value.toString()}`);
  }
  // 2^256 - 1 is the max uint256; anything larger cannot be a valid on-chain amount.
  const MAX_U256 = (1n << 256n) - 1n;
  if (value > MAX_U256) {
    throw new MandateError(`${label} exceeds uint256 range: ${value.toString()}`);
  }
  return value.toString(16).padStart(64, "0");
}

/**
 * Build the ABI-encoded calldata for `checkTransfer(agent, token, amount)`.
 *
 * Layout (head-only, all three args are static 32-byte words): selector ++ word(agent) ++
 * word(token) ++ word(amount). Pure and deterministic -- the same request always encodes to the
 * same calldata (design SS3 principle 4). Validates each arg loudly before encoding.
 */
export function encodeCheckTransfer(req: MandateRequest): string {
  const agent = normalizeAddress("agent", req.agent);
  const token = normalizeAddress("token", req.token);
  const amount = uint256Word("amount", req.amount);
  return CHECK_TRANSFER_SELECTOR + addressWord(agent) + addressWord(token) + amount;
}

/**
 * Convert a `bytes32` ABI word (64 hex, no `0x`) of ASCII-packed reason bytes to its string tag.
 *
 * The contract stores reason codes as left-aligned ASCII in a `bytes32` (e.g. `"OVER_TX_CAP"`), so
 * trailing zero bytes are padding and are stripped. A non-printable byte would be a malformed reply;
 * we keep only printable ASCII and stop at the first NUL, yielding the exact tag the contract set.
 */
function bytes32ToAscii(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i += 2) {
    const byte = Number.parseInt(word.slice(i, i + 2), 16);
    if (byte === 0) {
      break; // first NUL ends the left-aligned ASCII tag (the rest is zero padding).
    }
    // Keep printable ASCII only; a non-ASCII byte means a malformed/non-tag word.
    if (byte < 0x20 || byte > 0x7e) {
      return ""; // signal "not a recognizable ASCII tag" -> the caller treats it as OK-only-if-empty.
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/** The decoded on-chain answer of `checkTransfer`: `(bool ok, bytes32 reason)`. */
export interface CheckTransferResult {
  /** `true` iff the chain says the transfer is within the entire mandate. */
  readonly ok: boolean;
  /** The reason tag (decoded ASCII); empty string for the zero word (i.e. `OK`). */
  readonly reason: MandateReason | string;
}

/**
 * Decode the raw `eth_call` hex result of `checkTransfer` into `(ok, reason)`.
 *
 * The return is two static 32-byte words: word0 = `bool ok` (ABI: zero-padded, `...01` => true),
 * word1 = `bytes32 reason`. A reply that is not exactly two words is a loud [`MandateError`] (a
 * malformed reply must never be coerced into an `ok: true`). Pure and deterministic.
 */
export function decodeCheckTransfer(raw: string): CheckTransferResult {
  if (typeof raw !== "string") {
    throw new MandateError("eth_call result must be a hex string");
  }
  const hex = raw.trim().toLowerCase();
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Exactly two 32-byte words (128 hex digits). An empty/short reply (e.g. a reverted/absent call)
  // is malformed -> loud error, never silently ok.
  if (body.length !== 128 || !/^[0-9a-f]*$/.test(body)) {
    throw new MandateError(`malformed checkTransfer return (expected two 32-byte words): ${raw}`);
  }
  const okWord = body.slice(0, 64);
  const reasonWord = body.slice(64, 128);
  // ABI bool: the whole 32-byte word is 0 (false) or 1 (true). Any non-0/1 word is malformed.
  const okIsZero = /^0{64}$/.test(okWord);
  const okIsOne = /^0{63}1$/.test(okWord);
  if (!okIsZero && !okIsOne) {
    throw new MandateError(`malformed bool in checkTransfer return: 0x${okWord}`);
  }
  const ok = okIsOne;
  const reasonAscii = bytes32ToAscii(reasonWord);
  // A zero reason word decodes to "" which we present as the OK tag for clarity.
  const reason = reasonAscii === "" ? MANDATE_REASON.OK : reasonAscii;
  return { ok, reason };
}

// ----------------------------------------------------------------------------------------------
// The gate -- checkMandate. Builds calldata, eth_calls the registry, decodes, decides. Fail-closed.
// ----------------------------------------------------------------------------------------------

/**
 * The mandate gate -- check whether `req` may execute, as a pre-broadcast `eth_call` to
 * `MandateRegistry.checkTransfer` (design SS4/SS5). Returns a [`MandateVerdict`] whose `allowed` is
 * the loop's kill-switch instruction.
 *
 * Fail-CLOSED in every non-`ok` path (design SS3 principle 3):
 *  - no `transport` supplied        => `verified: false`, `allowed: false` (loud "not wired").
 *  - `config.registry` not set/valid => `verified: false`, `allowed: false` (loud "not configured").
 *  - transport throws (RPC error)    => `verified: false`, `allowed: false` (loud transport reason).
 *  - malformed reply                 => `verified: false`, `allowed: false` (loud decode reason).
 *  - chain answers `ok == false`     => `verified: true`,  `allowed: false` (the on-chain reason).
 *  - chain answers `ok == true`      => `verified: true`,  `allowed: true`  (the ONLY allow path).
 *
 * The function NEVER throws for an operational failure -- it returns a fail-closed verdict so the
 * loop always gets a definitive execute/don't-execute answer. It DOES throw [`MandateError`] for a
 * programmer error in the *request* (a malformed address / amount), surfaced before any call.
 *
 * @param req        The spend proposal (agent, token, amount in minor units).
 * @param config     The registry address to gate against (from operator config; never hardcoded).
 * @param transport  OPTIONAL `eth_call` transport. Omit it for a fully offline call that fails
 *                   closed with a loud not-wired reason (the default build needs no network -- SS6).
 */
export async function checkMandate(
  req: MandateRequest,
  config: MandateConfig,
  transport?: EthCallTransport,
): Promise<MandateVerdict> {
  // Validate + encode the request up front. A malformed request is a programmer error (loud throw),
  // distinct from an operational failure (fail-closed verdict). Encoding also normalizes addresses.
  const data = encodeCheckTransfer(req);

  // No transport wired => honest "we did not read the chain" => DO NOT execute (design SS3 #3).
  // This is the default-build path: zero network, kill-switch fails closed.
  if (transport === undefined) {
    return {
      allowed: false,
      reason: "MANDATE_NOT_WIRED: no eth_call transport supplied; gate cannot read the chain",
      verified: false,
    };
  }

  // Registry must be a real, configured address; "" (not yet pinned) fails closed, never allows.
  let registry: string;
  try {
    registry = normalizeAddress("registry", config.registry);
  } catch {
    return {
      allowed: false,
      reason: "MANDATE_NOT_CONFIGURED: registry address is unset/invalid; cannot gate",
      verified: false,
    };
  }

  // Perform the independent on-chain read. ANY throw is a transport failure -> fail closed.
  let raw: string;
  try {
    raw = await transport.ethCall(registry, data);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      reason: `MANDATE_TRANSPORT_ERROR: ${detail}`,
      verified: false,
    };
  }

  // Decode the on-chain answer. A malformed reply is fail-closed (never coerced to ok).
  let result: CheckTransferResult;
  try {
    result = decodeCheckTransfer(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      reason: `MANDATE_MALFORMED_REPLY: ${detail}`,
      verified: false,
    };
  }

  // The chain answered. `allowed` is true ONLY on a definitive on-chain ok == true; an ok == false
  // carries the on-chain reason and blocks execution (the kill-switch -- design SS4/SS5).
  return {
    allowed: result.ok,
    reason: result.reason,
    verified: true,
  };
}

// ----------------------------------------------------------------------------------------------
// fetchEthCallTransport -- the live raw-JSON-RPC eth_call leg. OPT-IN: a caller constructs it with
// an endpoint. The default build / checkMandate(no transport) never touches the network (SS6).
// ----------------------------------------------------------------------------------------------

/**
 * A live `eth_call` transport over raw JSON-RPC, using the platform `fetch` (design SS2: the
 * verifier "reads 0G via raw JSON-RPC"; the gate uses the same raw transport for `eth_call`).
 *
 * This is the ONLY network leg in the module and it is OPT-IN: a caller must explicitly construct it
 * with an RPC endpoint (read from `OG_RPC` per the data-spine -- never hardcoded here). It adds NO
 * runtime dependency: it uses the standard global `fetch`. [`checkMandate`] called without a
 * transport performs no network access, so the default build stays offline (design SS6).
 *
 * On any non-2xx, malformed JSON, JSON-RPC `error`, or missing `result`, it THROWS -- which
 * [`checkMandate`] maps to a fail-closed DO-NOT-EXECUTE. It never returns a fabricated success.
 *
 * @param endpoint  The JSON-RPC endpoint URL (e.g. from the `OG_RPC` env var).
 */
export function fetchEthCallTransport(endpoint: string): EthCallTransport {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new MandateError("fetchEthCallTransport requires a non-empty RPC endpoint URL");
  }
  const url = endpoint.trim();
  return {
    async ethCall(to: string, data: string): Promise<string> {
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        // `to`/`data` are the encoded call; "latest" reads the current chain head (design SS2).
        params: [{ to, data }, "latest"],
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new MandateError(`eth_call HTTP ${resp.status} ${resp.statusText}`);
      }
      const json: unknown = await resp.json();
      if (typeof json !== "object" || json === null) {
        throw new MandateError("eth_call: non-object JSON-RPC response");
      }
      const rec = json as { error?: { message?: unknown }; result?: unknown };
      if (rec.error !== undefined) {
        const msg =
          typeof rec.error.message === "string" ? rec.error.message : JSON.stringify(rec.error);
        throw new MandateError(`eth_call JSON-RPC error: ${msg}`);
      }
      if (typeof rec.result !== "string") {
        throw new MandateError("eth_call: JSON-RPC response missing a string `result`");
      }
      return rec.result;
    },
  };
}
