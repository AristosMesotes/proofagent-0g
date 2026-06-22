/**
 * Tests for the mandate gate (design SS4 mandate-gate + SS5 kill-switch) -- Node's built-in test
 * runner, fully OFFLINE (a recorded `eth_call` reply via a mock transport; zero network, zero deps).
 *
 * They pin the design invariants the gate must hold:
 *  - SS4/SS5 (kill-switch): a `false`/unread/not-wired verdict => `allowed: false` => DO NOT execute;
 *    `allowed: true` ONLY on a definitive on-chain `ok == true`. Fail-CLOSED everywhere else.
 *  - SS3 principle 1 (two-source truth): the read goes through one transport seam; a recorded reply
 *    and a live call are interchangeable -- the decision logic is identical.
 *  - SS3 principle 3 (never fabricate): no transport / RPC error / malformed reply NEVER allows.
 *  - SS3 principle 5 (exact-integer money): `amount` is a `bigint`, ABI-encoded as a 256-bit word.
 *  - SS3 principle 4 (deterministic): the same request encodes to byte-identical calldata.
 *  - Conformance: the pinned selector matches `checkTransfer(address,address,uint256)` and the
 *    contract's REASON_* tags.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMandate,
  encodeCheckTransfer,
  decodeCheckTransfer,
  fetchEthCallTransport,
  MandateError,
  MANDATE_REASON,
  CHECK_TRANSFER_SELECTOR,
  CHECK_TRANSFER_SIGNATURE,
  type EthCallTransport,
  type MandateConfig,
  type MandateRequest,
} from "./mandate.js";

// --- Fixtures (well-formed 20-byte addresses; the values are arbitrary public test addresses) ----
const AGENT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0x3333333333333333333333333333333333333333";
const CONFIG: MandateConfig = { registry: REGISTRY };

/** A spend request of `amount` minor units (bigint) of TOKEN by AGENT. */
function req(amount: bigint): MandateRequest {
  return { agent: AGENT, token: TOKEN, amount };
}

/** Build a 32-byte (64-hex) ABI bool word: true => `...01`, false => all zeros. */
function boolWord(v: boolean): string {
  return (v ? "1" : "0").padStart(64, "0");
}

/** Pack an ASCII reason tag into a left-aligned bytes32 word (the contract's encoding). */
function reasonWord(tag: string): string {
  let hex = "";
  for (let i = 0; i < tag.length; i += 1) {
    hex += tag.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.padEnd(64, "0");
}

/** A mock transport that replays a fixed `(ok, reason)` reply -- the OFFLINE two-source-truth double. */
function tapeTransport(ok: boolean, reasonTag: string): EthCallTransport {
  return {
    ethCall(_to: string, _data: string): Promise<string> {
      return Promise.resolve("0x" + boolWord(ok) + reasonWord(reasonTag));
    },
  };
}

/** A mock transport that returns a raw reply verbatim (for malformed-reply tests). */
function rawTransport(raw: string): EthCallTransport {
  return { ethCall: () => Promise.resolve(raw) };
}

/** A mock transport that throws (an RPC/transport failure). */
function throwingTransport(message: string): EthCallTransport {
  return {
    ethCall: () => Promise.reject(new Error(message)),
  };
}

// --- Conformance: the pinned selector matches the canonical signature & contract ------------------

test("the pinned selector matches checkTransfer(address,address,uint256) (conformance)", () => {
  assert.equal(CHECK_TRANSFER_SIGNATURE, "checkTransfer(address,address,uint256)");
  // The contract's compiled methodIdentifiers + `cast sig` both give cc1dd94f (verified at build).
  assert.equal(CHECK_TRANSFER_SELECTOR, "0xcc1dd94f");
});

// --- ABI encode: shape, determinism, exact-integer money (SS3 #5, #4) -----------------------------

test("encodeCheckTransfer builds selector ++ 3 static words (SS4 calldata shape)", () => {
  const data = encodeCheckTransfer(req(1_000_000n));
  // 0x + 8 hex (selector) + 3 * 64 hex (words) = 2 + 8 + 192 = 202 chars.
  assert.equal(data.length, 2 + 8 + 192);
  assert.ok(data.startsWith(CHECK_TRANSFER_SELECTOR), "starts with the checkTransfer selector");
  // The amount word is the right-most 64 hex; 1_000_000 = 0xf4240.
  const amountWord = data.slice(data.length - 64);
  assert.equal(BigInt("0x" + amountWord), 1_000_000n);
});

test("encode places agent and token right-aligned in their 32-byte words", () => {
  const data = encodeCheckTransfer(req(1n));
  const body = data.slice(2 + 8); // strip 0x + selector
  const agentWord = body.slice(0, 64);
  const tokenWord = body.slice(64, 128);
  // Right-aligned: 24 zero bytes (48 hex) of padding then the 40-hex address, lowercased.
  assert.equal(agentWord, AGENT.slice(2).toLowerCase().padStart(64, "0"));
  assert.equal(tokenWord, TOKEN.slice(2).toLowerCase().padStart(64, "0"));
});

test("encode is deterministic: same request -> byte-identical calldata (SS3 principle 4)", () => {
  const a = encodeCheckTransfer(req(42n));
  const b = encodeCheckTransfer(req(42n));
  assert.equal(a, b);
});

test("encode uses bigint amounts (exact-integer money, SS3 principle 5)", () => {
  // A large amount beyond Number.MAX_SAFE_INTEGER must encode exactly (no float).
  const big = 123456789012345678901234567890n;
  const data = encodeCheckTransfer(req(big));
  const amountWord = data.slice(data.length - 64);
  assert.equal(BigInt("0x" + amountWord), big);
});

test("encode rejects a malformed address / negative / oversized amount LOUDLY (never silent)", () => {
  assert.throws(() => encodeCheckTransfer({ agent: "0x123", token: TOKEN, amount: 1n }), MandateError);
  assert.throws(() => encodeCheckTransfer({ agent: AGENT, token: "nope", amount: 1n }), MandateError);
  assert.throws(() => encodeCheckTransfer(req(-1n)), MandateError);
  assert.throws(() => encodeCheckTransfer(req(1n << 256n)), MandateError); // > uint256 max
  // A number (not bigint) amount is a money-path violation -> loud throw.
  assert.throws(
    () => encodeCheckTransfer({ agent: AGENT, token: TOKEN, amount: 5 as unknown as bigint }),
    MandateError,
  );
});

// --- ABI decode: (bool, bytes32) -> (ok, reason); malformed never coerces to ok -------------------

test("decodeCheckTransfer decodes ok=true with the zero reason word as OK", () => {
  const raw = "0x" + boolWord(true) + reasonWord("");
  const r = decodeCheckTransfer(raw);
  assert.equal(r.ok, true);
  assert.equal(r.reason, MANDATE_REASON.OK);
});

test("decodeCheckTransfer decodes ok=false with the on-chain reason tag", () => {
  const raw = "0x" + boolWord(false) + reasonWord(MANDATE_REASON.OVER_TX_CAP);
  const r = decodeCheckTransfer(raw);
  assert.equal(r.ok, false);
  assert.equal(r.reason, MANDATE_REASON.OVER_TX_CAP);
});

test("decode rejects a malformed reply LOUDLY -- never coerces to ok (SS3 principle 3)", () => {
  assert.throws(() => decodeCheckTransfer("0x"), MandateError); // empty (e.g. reverted/absent)
  assert.throws(() => decodeCheckTransfer("0x1234"), MandateError); // too short
  assert.throws(() => decodeCheckTransfer("0x" + "0".repeat(127)), MandateError); // odd length / 1 short
  // A bool word that is neither 0 nor 1 is malformed.
  const badBool = "f".repeat(64) + reasonWord("");
  assert.throws(() => decodeCheckTransfer("0x" + badBool), MandateError);
});

// --- checkMandate: the kill-switch. allowed:true ONLY on on-chain ok==true (SS4/SS5) --------------

test("checkMandate: on-chain ok==true => allowed:true, verified:true (the ONLY allow path)", async () => {
  const v = await checkMandate(req(1n), CONFIG, tapeTransport(true, ""));
  assert.equal(v.allowed, true);
  assert.equal(v.verified, true);
  assert.equal(v.reason, MANDATE_REASON.OK);
});

test("checkMandate: on-chain ok==false => allowed:false (kill-switch), carries the on-chain reason", async () => {
  const v = await checkMandate(req(10n ** 30n), CONFIG, tapeTransport(false, MANDATE_REASON.OVER_TX_CAP));
  assert.equal(v.allowed, false, "an over-cap spend must NOT execute (the cap is a kill-switch)");
  assert.equal(v.verified, true, "the chain answered, so the read is verified");
  assert.equal(v.reason, MANDATE_REASON.OVER_TX_CAP);
});

test("checkMandate: NO transport => allowed:false, verified:false (fail-closed, SS3 #3)", async () => {
  const v = await checkMandate(req(1n), CONFIG);
  assert.equal(v.allowed, false, "an unread gate NEVER permits a spend");
  assert.equal(v.verified, false);
  assert.match(String(v.reason), /NOT_WIRED/);
});

test("checkMandate: unset registry => allowed:false, verified:false (fail-closed, never allow)", async () => {
  const v = await checkMandate(req(1n), { registry: "" }, tapeTransport(true, ""));
  assert.equal(v.allowed, false, "no registry pinned => cannot gate => DO NOT execute");
  assert.equal(v.verified, false);
  assert.match(String(v.reason), /NOT_CONFIGURED/);
});

test("checkMandate: transport throws (RPC error) => allowed:false, verified:false (fail-closed)", async () => {
  const v = await checkMandate(req(1n), CONFIG, throwingTransport("connection refused"));
  assert.equal(v.allowed, false, "an RPC error must never become an allow");
  assert.equal(v.verified, false);
  assert.match(String(v.reason), /TRANSPORT_ERROR/);
  assert.match(String(v.reason), /connection refused/);
});

test("checkMandate: malformed reply => allowed:false, verified:false (fail-closed)", async () => {
  const v = await checkMandate(req(1n), CONFIG, rawTransport("0xdeadbeef"));
  assert.equal(v.allowed, false, "a malformed reply must never become an allow");
  assert.equal(v.verified, false);
  assert.match(String(v.reason), /MALFORMED_REPLY/);
});

test("checkMandate: a malformed REQUEST throws (programmer error), distinct from a fail-closed verdict", async () => {
  // A bad address is a programmer error surfaced LOUD before any call -- not a silent fail-closed.
  await assert.rejects(
    () => checkMandate({ agent: "0xbad", token: TOKEN, amount: 1n }, CONFIG, tapeTransport(true, "")),
    MandateError,
  );
});

test("the gate is deterministic: same request + same recorded reply -> same verdict (SS3 #4)", async () => {
  const t = tapeTransport(true, "");
  const a = await checkMandate(req(7n), CONFIG, t);
  const b = await checkMandate(req(7n), CONFIG, t);
  assert.deepEqual(a, b);
});

// --- The live transport is OPT-IN and validates its endpoint; no network in this test -------------

test("fetchEthCallTransport requires a non-empty endpoint (no hardcoded RPC, SS6)", () => {
  assert.throws(() => fetchEthCallTransport(""), MandateError);
  assert.throws(() => fetchEthCallTransport("   "), MandateError);
  // Constructing with a URL does NOT perform any network call (it just returns a transport object).
  const t = fetchEthCallTransport("http://127.0.0.1:0");
  assert.equal(typeof t.ethCall, "function");
});

// --- Consolidated-hardened (V4) reason tags: decode + reason-agnostic fail-closed enforcement -----

test("the consolidated-hardened (V4) reason tags are present in MANDATE_REASON", () => {
  // The new hardened tags the consolidated MandateRegistry can return (rendered by the journal/UI).
  for (const tag of [
    "AGENT_PAUSED",
    "NOT_STARTED",
    "EPOCH_STALE",
    "BELOW_MIN_SPEND",
    "SPENDER_NOT_ALLOWED",
    "OVER_DEST_CAP",
    "OVER_PERIOD_CAP",
    "OVER_TXCOUNT_CAP",
    "PRICE_UNAVAILABLE",
    "BELOW_MIN_USD",
    "OVER_USD_CAP",
  ]) {
    assert.equal(
      (MANDATE_REASON as Record<string, string>)[tag],
      tag,
      `MANDATE_REASON.${tag} must mirror the contract tag`,
    );
  }
});

test("a hardened V4 reason decodes round-trip and the kill-switch fails CLOSED (reason-agnostic)", async () => {
  // The KILL-SWITCH is reason-agnostic: ANY ok:false blocks PRE-broadcast. A brand-new hardened tag the
  // gate has never seen still decodes to its ASCII and still yields allowed:false -- enforced, not shadow.
  for (const tag of [
    "NOT_STARTED",
    "EPOCH_STALE",
    "OVER_PERIOD_CAP",
    "OVER_TXCOUNT_CAP",
    "SPENDER_NOT_ALLOWED",
    "PRICE_UNAVAILABLE",
  ]) {
    // The raw decoder reads the exact ASCII tag.
    const decoded = decodeCheckTransfer("0x" + boolWord(false) + reasonWord(tag));
    assert.equal(decoded.ok, false);
    assert.equal(decoded.reason, tag, `decodes ${tag} exactly`);
    // The full gate refuses (allowed:false) on that tag -- a verified, definitive on-chain block.
    const v = await checkMandate(req(2_000_001n), CONFIG, tapeTransport(false, tag));
    assert.equal(v.allowed, false, `${tag} must block PRE-broadcast (kill-switch, not shadow)`);
    assert.equal(v.verified, true, "the chain answered -> verified:true, allowed:false");
    assert.equal(v.reason, tag, "the on-chain reason is surfaced for the journal/UI");
  }
});
