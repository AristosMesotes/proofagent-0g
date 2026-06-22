/**
 * onchain.ts -- the READ-ONLY on-chain checks behind the RAILS and SETTLED controls (design §2 the
 * three proofs, §4 web).
 *
 * The demo screen already drives the NEG case (a fabricated hash -> `UNVERIFIED`) in {@link
 * ./proofs.ts}. This module adds the two LIVE, on-chain legs so the page can drive all three proofs
 * from the real web UI -- each a single, key-less, broadcast-free JSON-RPC READ against the public 0G
 * Galileo testnet (chain id 16602):
 *
 *  - **RAILS** -- a read-only `eth_call` of the deployed `MandateRegistry.checkTransfer(agent, native,
 *    OVER-CAP amount)`; the chain answers `(false, OVER_TX_CAP)` (a zero-gas pre-broadcast block), and
 *    this module decodes that into a rendered `OVER_TX_CAP` verdict (design §2 Rails).
 *  - **SETTLED** -- a read-only `eth_getTransactionReceipt` + `eth_getTransactionByHash` of the PINNED
 *    settled tx; the chain answers `status 0x1` (Success) and a native `value`, and this module derives
 *    the verifier's `settled` adjudication for that observation (design §2 Settlement).
 *
 * ## HONESTY (design §3 principle 2/3, §8)
 *
 * Both legs are **READ-ONLY**: no private key, no signed tx, no broadcast -- only `eth_call` /
 * `eth_getTransaction*` reads. Neither leg can move value or change state. The page renders ONLY a
 * verdict that is **independently re-derivable** from the raw chain reply: the RAILS verdict is the
 * decoded on-chain `(ok, reason)` word, and the SETTLED verdict is `adjudicate(claimed, observed)`
 * recomputed in the open from the receipt/value the harness can fetch itself. The web mints NO new
 * verdict alphabet -- it carries the chain's answer (the verdict monopoly, §3 #2) and degrades LOUDLY
 * to `UNVERIFIED`/`UNREAD` on any unreadable/ambiguous reply rather than fabricate a success (§3 #3).
 *
 * ## CLEAN-ROOM (design §6)
 *
 * No proprietary identifier, private path, or secret appears here. Every address/hash/amount mirrors
 * the PUBLIC data spine `proofagent.toml`; the RPC URL is read at run time (env-injected or the public
 * 0G Galileo endpoint), never a private endpoint, and no wallet material is present. The
 * `checkTransfer` selector is derived from the public `checkTransfer(address,address,uint256)`
 * signature of the in-repo `MandateRegistry`.
 */

import { VERDICT, type Verdict } from "./proofs.js";

/* ------------------------------------------------------------------------------------------------ *
 * Public on-chain constants (mirror proofagent.toml -- all PUBLIC, nothing secret).
 *
 * These pin the SAME live surface the demo's `demo/EVIDENCE.md` confirms on the public explorer:
 * the deployed MandateRegistry, the native-asset sentinel, the agent identity, the pinned SETTLED tx,
 * and the per-tx cap -- all on 0G Galileo testnet (chain id 16602).
 *
 * They now live in the single spine source {@link ./spine.ts} so a growing surface cannot drift two
 * copies. They are imported for this module's internal reads AND re-exported byte-identically here, so
 * every existing importer of `onchain.ts` (`main.ts`, the tests, the headless harness) keeps working
 * unchanged against the same values -- same surface, one source.
 * ------------------------------------------------------------------------------------------------ */

import { GALILEO, RAILS_ONCHAIN, SETTLED_ONCHAIN, MANDATE_ASSETS } from "./spine.js";
export { GALILEO, RAILS_ONCHAIN, SETTLED_ONCHAIN, MANDATE_ASSETS };

/* ------------------------------------------------------------------------------------------------ *
 * The read-only transport seam (a thin JSON-RPC reader). A live browser `fetch` reader and an
 * offline test double both satisfy it, so the verdict-derivation logic is identical whether it reads
 * the real chain or a recorded reply (mirrors the agent's `EthCallTransport` and the verifier `Source`).
 * ------------------------------------------------------------------------------------------------ */

/** A loud read failure on the on-chain path (degrade loudly, never fabricate -- design §3 #3). */
export class OnChainReadError extends Error {
  public override readonly name = "OnChainReadError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, OnChainReadError.prototype);
  }
}

/**
 * The narrow READ-ONLY JSON-RPC seam the two controls read through. Only the three read methods the
 * demo needs are exposed -- there is deliberately NO `eth_sendRawTransaction` / signing surface here,
 * so the transport CANNOT broadcast or move value by construction.
 */
export interface RpcTransport {
  /** `eth_call({ to, data }, "latest")` -> raw `0x`-prefixed hex result. Throws on transport failure. */
  ethCall(to: string, data: string): Promise<string>;
  /** `eth_getTransactionReceipt(hash)` -> the receipt object, or `null` when off-record. Throws on RPC failure. */
  getTransactionReceipt(hash: string): Promise<RpcReceipt | null>;
  /** `eth_getTransactionByHash(hash)` -> the tx object, or `null` when off-record. Throws on RPC failure. */
  getTransactionByHash(hash: string): Promise<RpcTx | null>;
}

/** The receipt fields the SETTLED derivation reads (a successful tx has `status === "0x1"`). */
export interface RpcReceipt {
  /** `"0x1"` (Success) | `"0x0"` (failed). Any other shape is treated as unreadable. */
  readonly status: string;
}

/** The tx fields the SETTLED derivation reads (`value` is the native amount moved, hex wei). */
export interface RpcTx {
  /** The native value moved, `0x`-prefixed hex wei (the independent on-chain Observation). */
  readonly value: string;
}

/* ------------------------------------------------------------------------------------------------ *
 * ABI codec for checkTransfer(address,address,uint256) -> (bool ok, bytes32 reason).
 *
 * Pure, std-only, no deps -- mirrors agent/src/mandate.ts EXACTLY (same selector 0xcc1dd94f, same
 * encode/decode), so the RAILS verdict the page renders is byte-identically re-derivable.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The 4-byte selector for `checkTransfer(address,address,uint256)` -- the first 4 bytes of
 * `keccak256("checkTransfer(address,address,uint256)")`. Pinned as a constant (no keccak dep, stays
 * offline/std-only); `cast sig "checkTransfer(address,address,uint256)"` => `0xcc1dd94f`, and it equals
 * the in-repo `MandateRegistry` artifact's method id (the agent's `CHECK_TRANSFER_SELECTOR`).
 */
export const CHECK_TRANSFER_SELECTOR = "0xcc1dd94f" as const;

/** The on-chain reason the over-cap block returns -- the contract's `REASON_OVER_TX_CAP` bytes32. */
export const REASON_OVER_TX_CAP = "OVER_TX_CAP" as const;

/** Match a 20-byte EVM address (`0x` + 40 hex). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Match a 32-byte tx hash (`0x` + 64 hex). */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate + lowercase a 20-byte address, or throw loudly (never silently pad/truncate). */
function normalizeAddress(label: string, addr: string): string {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr.trim())) {
    throw new OnChainReadError(`${label} must be a 20-byte 0x address (0x + 40 hex), got ${String(addr)}`);
  }
  return addr.trim().toLowerCase();
}

/** Left-pad a validated address to a 32-byte (64-hex) ABI word (addresses are right-aligned). */
function addressWord(addr: string): string {
  return addr.slice(2).padStart(64, "0");
}

/** Encode a non-negative `uint256` (bigint, minor units) to a 32-byte ABI word; loud on out-of-range. */
function uint256Word(label: string, value: bigint): string {
  if (value < 0n) {
    throw new OnChainReadError(`${label} must be non-negative, got ${value.toString()}`);
  }
  const MAX_U256 = (1n << 256n) - 1n;
  if (value > MAX_U256) {
    throw new OnChainReadError(`${label} exceeds uint256 range: ${value.toString()}`);
  }
  return value.toString(16).padStart(64, "0");
}

/**
 * Build the ABI calldata for `checkTransfer(agent, token, amount)` -- selector ++ word(agent) ++
 * word(token) ++ word(amount). Pure + deterministic; identical to the agent's `encodeCheckTransfer`.
 */
export function encodeCheckTransfer(agent: string, token: string, amount: bigint): string {
  const a = normalizeAddress("agent", agent);
  const t = normalizeAddress("token", token);
  const v = uint256Word("amount", amount);
  return CHECK_TRANSFER_SELECTOR + addressWord(a) + addressWord(t) + v;
}

/** Convert a `bytes32` ABI word (64 hex, no `0x`) of left-aligned ASCII to its tag (stop at first NUL). */
function bytes32ToAscii(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i += 2) {
    const byte = Number.parseInt(word.slice(i, i + 2), 16);
    if (byte === 0) {
      break; // first NUL ends the left-aligned ASCII tag (the rest is zero padding).
    }
    if (byte < 0x20 || byte > 0x7e) {
      return ""; // a non-printable byte means this is not a recognizable ASCII tag.
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/** The decoded on-chain answer of `checkTransfer`: `(bool ok, bytes32 reason)`. */
export interface CheckTransferDecoded {
  /** `true` iff the chain says the transfer is within the entire mandate. */
  readonly ok: boolean;
  /** The decoded reason tag (`OK` for the zero word, else the ASCII reason, e.g. `OVER_TX_CAP`). */
  readonly reason: string;
}

/**
 * Decode the raw `eth_call` hex of `checkTransfer` into `(ok, reason)`. Two static 32-byte words:
 * word0 = `bool ok`, word1 = `bytes32 reason`. A reply that is not exactly two words, or a non-0/1
 * bool word, is a loud {@link OnChainReadError} -- a malformed/empty reply is NEVER coerced into
 * `ok: true` (design §3 #3). Pure + deterministic; mirrors the agent's `decodeCheckTransfer`.
 */
export function decodeCheckTransfer(raw: string): CheckTransferDecoded {
  if (typeof raw !== "string") {
    throw new OnChainReadError("eth_call result must be a hex string");
  }
  const hex = raw.trim().toLowerCase();
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 128 || !/^[0-9a-f]*$/.test(body)) {
    throw new OnChainReadError(`malformed checkTransfer return (expected two 32-byte words): ${raw}`);
  }
  const okWord = body.slice(0, 64);
  const reasonWord = body.slice(64, 128);
  if (!/^0{63}[01]$/.test(okWord)) {
    throw new OnChainReadError(`malformed bool in checkTransfer return: 0x${okWord}`);
  }
  const ok = okWord.endsWith("1");
  const reasonAscii = bytes32ToAscii(reasonWord);
  const reason = reasonAscii === "" ? "OK" : reasonAscii;
  return { ok, reason };
}

/* ------------------------------------------------------------------------------------------------ *
 * The RAILS control -- a read-only checkTransfer of an OVER-cap amount -> OVER_TX_CAP / blocked.
 * ------------------------------------------------------------------------------------------------ */

/** The rendered RAILS outcome -- always derived from the decoded on-chain `(ok, reason)`. */
export interface RailsResult {
  /** `true` iff the chain BLOCKED the over-cap spend (`ok === false`) -- the expected, honest outcome. */
  readonly blocked: boolean;
  /** The decoded on-chain reason tag (`OVER_TX_CAP` for the over-cap block), the page's `data-verdict`. */
  readonly verdict: string;
  /** The agent address probed (the mandated agent). */
  readonly agent: string;
  /** The asset probed (the native-asset sentinel the cap is enforced against). */
  readonly token: string;
  /** The OVER-cap amount probed (minor units, wei) -- strictly above the per-tx cap. */
  readonly amount: bigint;
  /** The exact calldata sent (so the harness can replay the same `eth_call` independently). */
  readonly calldata: string;
  /** A loud, honest one-line explanation of WHAT the chain answered and WHY. */
  readonly explanation: string;
  /** The exact CLI command to reproduce this against the chain (read-only). */
  readonly reproduceCommand: string;
}

/** A PER-ASSET mandate probe: the agent + asset + amount one read-only `checkTransfer` eth_call gates. */
export interface MandateProbe {
  /** The agent address proposing the spend (must equal the registry's mandated `agent`). */
  readonly agent: string;
  /** The asset to probe (the per-asset surface — an allowlisted or a non-allowlisted token). */
  readonly token: string;
  /** The amount to probe, MINOR units (wei). */
  readonly amount: bigint;
}

/**
 * Run ONE per-asset mandate check (the generalized RAILS read): a READ-ONLY `eth_call` of
 * `checkTransfer(agent, token, amount)` against the deployed registry, decoded into the on-chain
 * `(ok, reason)` verdict. NO key, NO broadcast — a pure read. The verdict is ALWAYS the decoded on-chain
 * reason, re-derivable by anyone replaying the same call: `OK` when the chain allows, else the first-failing
 * reason (`OVER_TX_CAP` / `OVER_ASSET_CAP` over a cap, `TOKEN_NOT_ALLOWED` for a non-allowlisted asset).
 *
 * This is the single generalized primitive both the RAILS control and the dry-run's mandate-BY-ASSET leg
 * read through — same codec, same transport seam, no duplicated logic — so swapping the asset/amount never
 * changes what a verdict MEANS.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param probe the per-asset probe (agent, token, amount).
 * @param registry the deployed registry to read (defaults to the spine's pinned MandateRegistry).
 * @returns the rails result whose `verdict` is the decoded on-chain reason for THIS asset+amount.
 * @throws {OnChainReadError} on a transport failure or a malformed reply (a loud degrade, never an allow).
 */
export async function runMandateCheck(
  transport: RpcTransport,
  probe: MandateProbe,
  registry: string = RAILS_ONCHAIN.registry,
): Promise<RailsResult> {
  const { agent, token, amount } = probe;
  const calldata = encodeCheckTransfer(agent, token, amount);
  const raw = await transport.ethCall(registry, calldata);
  const decoded = decodeCheckTransfer(raw);
  const blocked = !decoded.ok;
  return {
    blocked,
    verdict: decoded.reason,
    agent,
    token,
    amount,
    calldata,
    explanation: blocked
      ? `The on-chain MandateRegistry rejected this spend BEFORE broadcast: ` +
        `checkTransfer(agent, ${token}, ${amount.toString()} wei) returned (false, ${decoded.reason}) ` +
        `as a zero-gas eth_call. No transaction was broadcast; the block is the proof.`
      : `The on-chain MandateRegistry ALLOWED this spend as a zero-gas eth_call: ` +
        `checkTransfer(agent, ${token}, ${amount.toString()} wei) returned (true, ${decoded.reason}) — ` +
        `within the per-asset sub-cap and the global per-tx cap. Nothing is broadcast in a dry-run.`,
    reproduceCommand:
      `cast call ${registry} "checkTransfer(address,address,uint256)" ` +
      `${agent} ${token} ${amount.toString()} --rpc-url $OG_RPC`,
  };
}

/**
 * Run the RAILS control (design §2 Rails): a READ-ONLY `eth_call` of `checkTransfer(agent, native,
 * OVER-cap amount)` against the deployed registry. The chain answers `(false, OVER_TX_CAP)` -- a
 * zero-gas, pre-broadcast block -- and this returns that decoded verdict. NO key, NO broadcast: a pure
 * read. The verdict is the decoded on-chain reason, re-derivable by anyone replaying the same call.
 *
 * It now delegates to the generalized {@link runMandateCheck} (the over-cap probe is one per-asset check),
 * so the existing RAILS behaviour is byte-identical — same calldata, same decoded verdict — but the over-cap
 * explanation/anomaly framing is preserved here for the RAILS card's copy.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @returns the rails result whose `verdict` is the decoded on-chain reason (`OVER_TX_CAP` when blocked).
 * @throws {OnChainReadError} on a transport failure or a malformed reply (a loud degrade, never an allow).
 */
export async function runRailsCheck(transport: RpcTransport): Promise<RailsResult> {
  const { registry, agent, nativeSentinel, overCapAmount, perTxCap } = RAILS_ONCHAIN;
  const result = await runMandateCheck(transport, { agent, token: nativeSentinel, amount: overCapAmount }, registry);
  return {
    ...result,
    explanation: result.blocked
      ? `The on-chain MandateRegistry rejected the over-cap spend BEFORE broadcast: ` +
        `checkTransfer(agent, native, ${overCapAmount.toString()} wei) returned (false, ${result.verdict}) ` +
        `as a zero-gas eth_call -- ${overCapAmount.toString()} > the ${perTxCap.toString()}-wei per-tx cap. ` +
        `No transaction was broadcast; the block is the proof.`
      : `Unexpected: the chain ALLOWED an over-cap spend (ok=true, reason=${result.verdict}). ` +
        `That contradicts the pinned per-tx cap -- treat as a LOUD anomaly, never a pass.`,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * The SETTLED control -- read receipt+value of the pinned tx -> derive the verifier's `settled` verdict.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The settlement adjudication, recomputed in the open (mirrors the Rust `adjudicate(claimed,
 * Some(observed), tol)` in `verifier/src/adjudicate.rs`). Exact-integer band, no float (design §3 #5):
 *
 *   - `observed == null`               -> `unverified` (the keystone -- never fabricate a settled)
 *   - `claimed == 0 && observed == 0`  -> `hollow`
 *   - `|claimed - observed| <= floor(|claimed| * num / den)` -> `settled`
 *   - else                              -> `mismatch`
 *
 * The web does NOT mint a new verdict alphabet -- it recomputes the verifier's PUBLISHED rule so the
 * rendered string is re-derivable, and carries the same four-string verdict the verifier owns (§3 #2).
 */
export function adjudicate(
  claimed: bigint,
  observed: bigint | null,
  num: bigint,
  den: bigint,
): Verdict {
  if (den <= 0n || num < 0n) {
    // An ill-formed band has no exact-integer meaning -> refuse to settle (fail loud, never fabricate).
    throw new OnChainReadError(`ill-formed tolerance band ${num.toString()}/${den.toString()}`);
  }
  if (observed === null) {
    return VERDICT.UNVERIFIED; // keystone: no observation -> never a fabricated settled.
  }
  if (claimed === 0n && observed === 0n) {
    return VERDICT.HOLLOW;
  }
  const mag = claimed < 0n ? -claimed : claimed;
  const delta0 = claimed - observed;
  const delta = delta0 < 0n ? -delta0 : delta0;
  const band = (mag * num) / den; // exact-integer floor division (den > 0).
  return delta <= band ? VERDICT.SETTLED : VERDICT.MISMATCH;
}

/** Parse a `0x`-prefixed hex quantity (e.g. a `value` word) to a non-negative bigint, or throw loudly. */
export function parseHexQuantity(label: string, hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex.trim())) {
    throw new OnChainReadError(`${label} must be a 0x hex quantity, got ${String(hex)}`);
  }
  return BigInt(hex.trim());
}

/** The rendered SETTLED outcome -- the verdict derived from the receipt + value the chain returned. */
export interface SettledResult {
  /** The verifier's adjudication of the tx -- `settled` when status 0x1 + value in band against a claim. */
  readonly verdict: Verdict;
  /** `true` iff the receipt reported `status === "0x1"` (Success). */
  readonly success: boolean;
  /** The tx hash that was read (the pinned default, or the pasted hash). */
  readonly hash: string;
  /**
   * The recorded claim, minor units (wei), or `null` when NO claim is on record (a pasted hash the spine
   * corpus does not pin). A `null` claim means there is nothing to verify the observation AGAINST -> the
   * symmetric keystone: no claim on record -> `unverified` (never a fabricated settled, never a false mismatch).
   */
  readonly claimed: bigint | null;
  /** The independent on-chain Observation (the native `value` moved), minor units (wei); `null` if off-record. */
  readonly observed: bigint | null;
  /** A loud, honest one-line explanation of the receipt status + the adjudication. */
  readonly explanation: string;
  /** The exact CLI command to reproduce this against the REAL independent Rust verifier. */
  readonly reproduceCommand: string;
}

/**
 * Run the SETTLED control (design §2 Settlement): a READ-ONLY `eth_getTransactionReceipt` +
 * `eth_getTransactionByHash` of a settled tx -- the PINNED tx by default, or any pasted hash for the
 * playground. A successful receipt (`status 0x1`) and the native `value` are read independently, then
 * the verifier's PUBLISHED adjudication is recomputed in the open -> `settled`. NO key, NO broadcast: a
 * pure read. The verdict is re-derivable by anyone who fetches the same receipt/value and reruns
 * `adjudicate`.
 *
 * ## Generalized for the playground (design §4.3, §11)
 *
 * The pinned-tx behaviour is the BACKWARD-COMPATIBLE default: called with no `hash`, it reads exactly the
 * spine's `SETTLED_ONCHAIN.hash` against its recorded `claimed`, byte-identically to before. Passing a
 * `hash` (the playground's pasted hash) reads THAT tx instead -- a thin generalization, not a reinvention:
 * the SAME receipt+value+`adjudicate` pipeline runs.
 *
 * A pasted hash has NO recorded claim in the spine corpus, so its `claimed` is `null` -- and the SYMMETRIC
 * keystone applies: just as no OBSERVATION yields `unverified` (nothing to confirm), no CLAIM ON RECORD
 * yields `unverified` (nothing to verify the observation AGAINST). The web does not invent a claim of zero
 * and then call a real transfer a `mismatch` against it -- that would fabricate a false anomaly. So a pasted
 * hash can ONLY ever reach `unverified` (off-record, or no claim on record to verify against) or `mismatch`
 * (a genuinely FAILED receipt); it can NEVER reach a fabricated `settled` for a hash the spine does not pin.
 * This preserves the verdict monopoly (the web mints no verdict) and the never-fabricate rule. Only the
 * PINNED default, which carries a real recorded claim, can re-derive `settled`.
 *
 * Honesty (design §3 #3): an off-record hash (`receipt == null`) degrades LOUDLY to `unverified`, and a
 * FAILED receipt (`status != 0x1`) is NEVER rendered as `settled` -- it is surfaced loud, never softened.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param hash OPTIONAL tx hash to read (the playground's pasted hash). Omitted -> the pinned settled tx
 *   (the backward-compatible default). A pasted hash is validated to the `0x + 64 hex` shape and carries a
 *   `null` (no-record) claim, so it can only reach `unverified`/`mismatch`, never a fabricated `settled`.
 * @returns the settled result whose `verdict` is the re-derived adjudication of the read tx.
 * @throws {OnChainReadError} on a transport failure or a malformed reply (a loud degrade, never a fabrication).
 */
export async function runSettledCheck(transport: RpcTransport, hash?: string): Promise<SettledResult> {
  const pinned = hash === undefined;
  // The pinned default carries the spine's recorded claim; a pasted hash has NO claim on record (`null`), so
  // there is nothing to verify the observation against -> the symmetric keystone yields `unverified`.
  const targetHash = pinned ? SETTLED_ONCHAIN.hash : hash;
  const claimed: bigint | null = pinned ? SETTLED_ONCHAIN.claimed : null;
  const { toleranceNum, toleranceDen } = SETTLED_ONCHAIN;
  if (!TX_HASH_RE.test(targetHash)) {
    throw new OnChainReadError(`hash is not a 0x + 64-hex tx hash: ${targetHash}`);
  }
  const receipt = await transport.getTransactionReceipt(targetHash);

  // Off-record: no receipt -> no independent observation -> unverified (the keystone, never settled).
  if (receipt === null) {
    return {
      verdict: VERDICT.UNVERIFIED,
      success: false,
      hash: targetHash,
      claimed,
      observed: null,
      explanation:
        `The chain has no receipt on record for ${targetHash} -- the verifier has nothing confirming a ` +
        `settlement, so it stamps unverified, NEVER settled (it reads the chain; it does not rubber-stamp).`,
      reproduceCommand: `cargo run -p verifier --features live -- verify-tx ${targetHash}`,
    };
  }

  const success = receipt.status === "0x1";
  // A FAILED receipt is real but NOT a settlement -> surface loud, never softened into settled.
  if (!success) {
    return {
      verdict: VERDICT.MISMATCH,
      success: false,
      hash: targetHash,
      claimed,
      observed: 0n,
      explanation:
        `The receipt for ${targetHash} reports status ${String(receipt.status)} (NOT 0x1/Success). ` +
        `A failed transaction moved no settled value -- surfaced loud, NEVER rendered as settled.`,
      reproduceCommand: `cargo run -p verifier --features live -- verify-tx ${targetHash}`,
    };
  }

  // Success -> read the native value moved (the independent Observation) and adjudicate it.
  const tx = await transport.getTransactionByHash(targetHash);
  if (tx === null) {
    return {
      verdict: VERDICT.UNVERIFIED,
      success,
      hash: targetHash,
      claimed,
      observed: null,
      explanation:
        `The receipt for ${targetHash} is Success (0x1) but the tx body is unreadable -- the value cannot ` +
        `be observed, so the verifier degrades LOUDLY to unverified rather than guess a settlement.`,
      reproduceCommand: `cargo run -p verifier --features live -- verify-tx ${targetHash}`,
    };
  }
  const observed = parseHexQuantity("tx.value", tx.value);

  // No claim on record (a pasted hash the spine does not pin): the tx is REAL and Success, but there is
  // nothing recorded to verify its value AGAINST. The symmetric keystone -> `unverified` (never a fabricated
  // settled, and never a FALSE mismatch against an invented zero claim). The observation is shown honestly.
  if (claimed === null) {
    return {
      verdict: VERDICT.UNVERIFIED,
      success,
      hash: targetHash,
      claimed: null,
      observed,
      explanation:
        `The chain confirms ${targetHash}: receipt status 0x1 (Success) and native value ${observed.toString()} wei. ` +
        `But this hash has NO claim on record in the verifier's corpus, so there is nothing to verify the ` +
        `observed value against -- the verifier stamps unverified (it will not invent a claim, and it will ` +
        `not call a real transfer settled without one). Pin this tx in the corpus to adjudicate it.`,
      reproduceCommand: `cargo run -p verifier --features live -- verify-tx ${targetHash}`,
    };
  }

  const verdict = adjudicate(claimed, observed, toleranceNum, toleranceDen);
  return {
    verdict,
    success,
    hash: targetHash,
    claimed,
    observed,
    explanation:
      `The chain confirms ${targetHash}: receipt status 0x1 (Success) and native value ${observed.toString()} wei. ` +
      `The verifier reads that independently and adjudicates claimed ${claimed.toString()} vs observed ` +
      `${observed.toString()} within the ${toleranceNum.toString()}/${toleranceDen.toString()} band -> ` +
      `${verdict}. The verdict is re-derivable: fetch the same receipt+value and rerun adjudicate.`,
    reproduceCommand: `cargo run -p verifier --features live -- verify-tx ${targetHash}`,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * The live browser JSON-RPC transport -- a thin, read-only `fetch` reader (no key, no broadcast).
 * ------------------------------------------------------------------------------------------------ */

/** One JSON-RPC request body (id is fixed -- a single read per call, no batching/state). */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: 1;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** A minimal JSON-RPC reply shape (only the fields the reads need). */
interface JsonRpcReply {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Build a read-only JSON-RPC transport over a public 0G endpoint using the browser `fetch`. It can
 * ONLY perform the three read methods on {@link RpcTransport}; there is no signing/broadcast path.
 *
 * @param rpcUrl the JSON-RPC URL (defaults to the public 0G Galileo endpoint). Env-injected at run
 *               time elsewhere; never a private endpoint. Must be a 0G host on the live surface.
 * @param fetchImpl the `fetch` implementation (defaults to the global `fetch`); injectable for tests.
 */
export function createBrowserRpcTransport(
  rpcUrl: string = GALILEO.rpcUrl,
  fetchImpl: typeof fetch = fetch,
): RpcTransport {
  async function call(method: string, params: readonly unknown[]): Promise<unknown> {
    const body: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };
    let res: Response;
    try {
      res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OnChainReadError(
        `RPC transport failure for ${method}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new OnChainReadError(`RPC ${method} HTTP ${res.status} ${res.statusText}`);
    }
    let reply: JsonRpcReply;
    try {
      reply = (await res.json()) as JsonRpcReply;
    } catch (err) {
      throw new OnChainReadError(
        `RPC ${method} returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (reply.error !== undefined) {
      throw new OnChainReadError(`RPC ${method} error: ${reply.error.message ?? "unknown"}`);
    }
    return reply.result;
  }

  return {
    async ethCall(to: string, data: string): Promise<string> {
      const result = await call("eth_call", [{ to, data }, "latest"]);
      if (typeof result !== "string") {
        throw new OnChainReadError(`eth_call returned a non-string result: ${String(result)}`);
      }
      return result;
    },
    async getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
      const result = await call("eth_getTransactionReceipt", [hash]);
      if (result === null || result === undefined) {
        return null; // off-record -> the caller degrades to unverified.
      }
      if (typeof result !== "object") {
        throw new OnChainReadError(`eth_getTransactionReceipt returned a non-object: ${String(result)}`);
      }
      const status = (result as { status?: unknown }).status;
      if (typeof status !== "string") {
        throw new OnChainReadError(`receipt has no string status: ${JSON.stringify(result)}`);
      }
      return { status };
    },
    async getTransactionByHash(hash: string): Promise<RpcTx | null> {
      const result = await call("eth_getTransactionByHash", [hash]);
      if (result === null || result === undefined) {
        return null;
      }
      if (typeof result !== "object") {
        throw new OnChainReadError(`eth_getTransactionByHash returned a non-object: ${String(result)}`);
      }
      const value = (result as { value?: unknown }).value;
      if (typeof value !== "string") {
        throw new OnChainReadError(`tx has no string value: ${JSON.stringify(result)}`);
      }
      return { value };
    },
  };
}
