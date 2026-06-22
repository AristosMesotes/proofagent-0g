/**
 * onchain.test.ts -- the honesty invariants of the two READ-ONLY on-chain controls (RAILS + SETTLED).
 *
 * These lock the design's honesty doctrine on the live legs (§2 the three proofs, §3 #2/#3 verdict
 * monopoly / never fabricate, §8 claim only what's live) so a future edit cannot:
 *   - turn the RAILS over-cap probe into a silent ALLOW (it must decode the on-chain block),
 *   - fabricate a `settled` for an off-record / failed / unreadable tx (it must degrade loudly),
 *   - drift the calldata / verdict away from being independently re-derivable.
 *
 * Pure logic + an OFFLINE recorded-reply transport double (no DOM, no network) -- runs under
 * `node --test` against the compiled `dist/` ESM, fully offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runRailsCheck,
  runSettledCheck,
  encodeCheckTransfer,
  decodeCheckTransfer,
  adjudicate,
  parseHexQuantity,
  CHECK_TRANSFER_SELECTOR,
  RAILS_ONCHAIN,
  SETTLED_ONCHAIN,
  GALILEO,
  OnChainReadError,
  type RpcTransport,
  type RpcReceipt,
  type RpcTx,
} from "./onchain.js";
import { VERDICT } from "./proofs.js";

/* ------------------------------------------------------------------------------------------------ *
 * Offline transport doubles -- a recorded reply, exactly like the real chain answered (EVIDENCE.md).
 * ------------------------------------------------------------------------------------------------ */

/** A bytes32 ABI word of left-aligned ASCII for a reason tag (e.g. "OVER_TX_CAP"). */
function reasonWord(tag: string): string {
  let hex = "";
  for (let i = 0; i < tag.length; i++) {
    hex += tag.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.padEnd(64, "0");
}

/** The `(ok=false, reason=OVER_TX_CAP)` reply the deployed registry returns for the over-cap probe. */
const OVER_CAP_REPLY = "0x" + "0".repeat(64) + reasonWord("OVER_TX_CAP");
/** The `(ok=true, reason=OK)` reply -- the WRONG answer for an over-cap probe (the anomaly path). */
const OK_REPLY = "0x" + "0".repeat(63) + "1" + "0".repeat(64);

/** Build a transport double from fixed replies; unspecified methods throw (never silently succeed). */
function transportDouble(opts: {
  ethCall?: string;
  receipt?: RpcReceipt | null;
  tx?: RpcTx | null;
  failOn?: "ethCall" | "receipt" | "tx";
}): RpcTransport {
  return {
    async ethCall(): Promise<string> {
      if (opts.failOn === "ethCall") throw new OnChainReadError("recorded RPC failure (eth_call)");
      if (opts.ethCall === undefined) throw new OnChainReadError("no ethCall reply recorded");
      return opts.ethCall;
    },
    async getTransactionReceipt(): Promise<RpcReceipt | null> {
      if (opts.failOn === "receipt") throw new OnChainReadError("recorded RPC failure (receipt)");
      if (opts.receipt === undefined) throw new OnChainReadError("no receipt reply recorded");
      return opts.receipt;
    },
    async getTransactionByHash(): Promise<RpcTx | null> {
      if (opts.failOn === "tx") throw new OnChainReadError("recorded RPC failure (tx)");
      if (opts.tx === undefined) throw new OnChainReadError("no tx reply recorded");
      return opts.tx;
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * ABI codec re-derivability (the RAILS verdict must be reproducible from public inputs).
 * ------------------------------------------------------------------------------------------------ */

test("the checkTransfer selector is the public 0xcc1dd94f (matches the in-repo MandateRegistry / agent)", () => {
  assert.equal(CHECK_TRANSFER_SELECTOR, "0xcc1dd94f");
});

test("encodeCheckTransfer is deterministic head-only calldata (selector ++ 3 static 32-byte words)", () => {
  const data = encodeCheckTransfer(
    RAILS_ONCHAIN.agent,
    RAILS_ONCHAIN.nativeSentinel,
    RAILS_ONCHAIN.overCapAmount,
  );
  // selector (10 chars incl 0x) + 3 * 64 hex words.
  assert.equal(data.length, 10 + 64 * 3);
  assert.ok(data.startsWith(CHECK_TRANSFER_SELECTOR));
  // the amount word is the over-cap amount, right-aligned hex (3_000_000 = 0x2dc6c0).
  assert.ok(data.endsWith((3_000_000).toString(16).padStart(64, "0")));
});

test("decodeCheckTransfer reads (false, OVER_TX_CAP) and never coerces a malformed reply to ok=true", () => {
  const decoded = decodeCheckTransfer(OVER_CAP_REPLY);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.reason, "OVER_TX_CAP");
  // An empty / short reply (reverted/absent call) is a LOUD error, never silently ok.
  assert.throws(() => decodeCheckTransfer("0x"), OnChainReadError);
  assert.throws(() => decodeCheckTransfer("0xdeadbeef"), OnChainReadError);
});

/* ------------------------------------------------------------------------------------------------ *
 * RAILS -- the over-cap probe must render the on-chain BLOCK (OVER_TX_CAP), never an allow.
 * ------------------------------------------------------------------------------------------------ */

test("RAILS: the over-cap amount is strictly ABOVE the on-chain per-tx cap (so the block is deterministic)", () => {
  assert.ok(RAILS_ONCHAIN.overCapAmount > RAILS_ONCHAIN.perTxCap);
});

test("RAILS renders OVER_TX_CAP / blocked from the on-chain (false, OVER_TX_CAP) reply", async () => {
  const result = await runRailsCheck(transportDouble({ ethCall: OVER_CAP_REPLY }));
  assert.equal(result.blocked, true);
  assert.equal(result.verdict, "OVER_TX_CAP", "the data-verdict the page renders");
  // The calldata is re-derivable: it equals encodeCheckTransfer(agent, native, over-cap).
  assert.equal(
    result.calldata,
    encodeCheckTransfer(RAILS_ONCHAIN.agent, RAILS_ONCHAIN.nativeSentinel, RAILS_ONCHAIN.overCapAmount),
  );
  assert.match(result.reproduceCommand, /checkTransfer/);
});

test("RAILS surfaces a chain ALLOW of an over-cap spend as a LOUD anomaly, never softened to a pass", async () => {
  const result = await runRailsCheck(transportDouble({ ethCall: OK_REPLY }));
  // If the chain ever (wrongly) allowed it, blocked is false and the explanation is loud -- not a pass.
  assert.equal(result.blocked, false);
  assert.match(result.explanation, /anomaly|never a pass/i);
});

test("RAILS degrades LOUDLY on a transport failure (throws, never a silent allow)", async () => {
  await assert.rejects(() => runRailsCheck(transportDouble({ failOn: "ethCall" })), OnChainReadError);
});

/* ------------------------------------------------------------------------------------------------ *
 * The adjudication algebra (mirrors verifier/src/adjudicate.rs) -- exact-integer, never-fabricate.
 * ------------------------------------------------------------------------------------------------ */

test("adjudicate: no observation -> unverified (the keystone, never a fabricated settled)", () => {
  assert.equal(adjudicate(1_000_000n, null, 15n, 100n), VERDICT.UNVERIFIED);
});

test("adjudicate: claimed==observed within band -> settled; out of band -> mismatch (exact-integer)", () => {
  assert.equal(adjudicate(1_000_000n, 1_000_000n, 15n, 100n), VERDICT.SETTLED);
  assert.equal(adjudicate(1_000_000n, 1_100_000n, 15n, 100n), VERDICT.SETTLED); // 10% <= 15%
  assert.equal(adjudicate(1_000_000n, 1_200_000n, 15n, 100n), VERDICT.MISMATCH); // 20% > 15%
});

test("adjudicate: claimed 0 and observed 0 -> hollow", () => {
  assert.equal(adjudicate(0n, 0n, 15n, 100n), VERDICT.HOLLOW);
});

test("parseHexQuantity reads a 0x hex value; a non-hex is a LOUD error", () => {
  assert.equal(parseHexQuantity("v", "0xf4240"), 1_000_000n);
  assert.throws(() => parseHexQuantity("v", "1000000"), OnChainReadError);
  assert.throws(() => parseHexQuantity("v", "0xzz"), OnChainReadError);
});

/* ------------------------------------------------------------------------------------------------ *
 * SETTLED -- the pinned tx must derive `settled`; off-record / failed / unreadable degrade loudly.
 * ------------------------------------------------------------------------------------------------ */

test("SETTLED renders `settled` from status 0x1 + value 0xf4240 (the pinned tx -- EVIDENCE.md PROOF 1)", async () => {
  const result = await runSettledCheck(
    transportDouble({ receipt: { status: "0x1" }, tx: { value: "0xf4240" } }),
  );
  assert.equal(result.verdict, VERDICT.SETTLED, "the data-verdict the page renders");
  assert.equal(result.success, true);
  assert.equal(result.observed, 1_000_000n);
  assert.equal(result.hash, SETTLED_ONCHAIN.hash);
  assert.match(result.reproduceCommand, /verify-tx/);
});

test("SETTLED: an off-record hash (receipt == null) degrades LOUDLY to unverified, never settled", async () => {
  const result = await runSettledCheck(transportDouble({ receipt: null }));
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.notEqual(result.verdict, VERDICT.SETTLED);
  assert.equal(result.observed, null);
});

test("SETTLED: a FAILED receipt (status != 0x1) is NEVER rendered as settled", async () => {
  const result = await runSettledCheck(transportDouble({ receipt: { status: "0x0" } }));
  assert.notEqual(result.verdict, VERDICT.SETTLED);
  assert.equal(result.success, false);
});

test("SETTLED: success receipt but unreadable tx body degrades LOUDLY to unverified, never settled", async () => {
  const result = await runSettledCheck(transportDouble({ receipt: { status: "0x1" }, tx: null }));
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.notEqual(result.verdict, VERDICT.SETTLED);
});

test("SETTLED: an out-of-band value yields mismatch, never a fabricated settled", async () => {
  // value 0x1e8480 = 2_000_000 wei vs claimed 1_000_000 -> 100% delta, way outside the 15% band.
  const result = await runSettledCheck(
    transportDouble({ receipt: { status: "0x1" }, tx: { value: "0x1e8480" } }),
  );
  assert.equal(result.verdict, VERDICT.MISMATCH);
});

test("SETTLED degrades LOUDLY on a transport failure (throws, never fabricates a settled)", async () => {
  await assert.rejects(
    () => runSettledCheck(transportDouble({ failOn: "receipt" })),
    OnChainReadError,
  );
});

/* ------------------------------------------------------------------------------------------------ *
 * P2 -- the GENERALIZED runSettledCheck(hash) for the playground: a pasted hash has NO claim on record,
 * so it can NEVER reach a fabricated `settled`, and a real Success with no claim is `unverified`, never a
 * FALSE `mismatch` against an invented zero claim (design §4.3, §8 -- the symmetric keystone).
 * ------------------------------------------------------------------------------------------------ */

/** A well-formed but arbitrary pasted hash (the playground's input) -- not the spine's pinned tx. */
const PASTED_HASH = "0x" + "ab".repeat(32);

test("PLAYGROUND: a pasted hash carries NO claim on record (claimed === null) -- the spine does not pin it", async () => {
  const result = await runSettledCheck(
    transportDouble({ receipt: { status: "0x1" }, tx: { value: "0xf4240" } }),
    PASTED_HASH,
  );
  // Generalized read targets the PASTED hash, and there is no recorded claim to verify against.
  assert.equal(result.hash, PASTED_HASH);
  assert.equal(result.claimed, null, "a pasted hash has no claim on record");
});

test("PLAYGROUND: a real Success tx with NO claim on record is `unverified` -- never a FALSE mismatch, never settled", async () => {
  // A genuine Success receipt + a real native value, but NO claim on record (a pasted hash) -> the symmetric
  // keystone: nothing to verify against -> unverified. The web does NOT invent a zero claim and cry mismatch,
  // and it does NOT fabricate a settled for a hash the spine does not pin.
  const result = await runSettledCheck(
    transportDouble({ receipt: { status: "0x1" }, tx: { value: "0xf4240" } }),
    PASTED_HASH,
  );
  assert.equal(result.verdict, VERDICT.UNVERIFIED, "no claim on record -> unverified (the symmetric keystone)");
  assert.notEqual(result.verdict, VERDICT.SETTLED, "NEVER a fabricated settled for an unpinned hash");
  assert.notEqual(result.verdict, VERDICT.MISMATCH, "NEVER a FALSE mismatch against an invented zero claim");
  assert.equal(result.observed, 1_000_000n, "the real observed value is still shown honestly");
});

test("PLAYGROUND: an off-record pasted hash (receipt == null) degrades LOUDLY to unverified, never settled", async () => {
  const result = await runSettledCheck(transportDouble({ receipt: null }), PASTED_HASH);
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.notEqual(result.verdict, VERDICT.SETTLED);
  assert.equal(result.hash, PASTED_HASH);
});

test("PLAYGROUND: a FAILED pasted-hash receipt is a LOUD mismatch (a real anomaly), never softened to settled", async () => {
  const result = await runSettledCheck(transportDouble({ receipt: { status: "0x0" } }), PASTED_HASH);
  assert.equal(result.verdict, VERDICT.MISMATCH);
  assert.notEqual(result.verdict, VERDICT.SETTLED);
});

test("PLAYGROUND: a malformed pasted hash throws BEFORE any read (a usage error, never a verdict)", async () => {
  // runSettledCheck validates the hash shape and throws loudly rather than read a bad hash.
  await assert.rejects(() => runSettledCheck(transportDouble({ receipt: null }), "not-a-hash"), OnChainReadError);
});

test("PLAYGROUND: the pinned default is UNCHANGED -- no hash arg still reads the pinned tx with its recorded claim", async () => {
  // Backward compatibility: the no-arg form is byte-identical to before (the SETTLEMENT card path).
  const result = await runSettledCheck(transportDouble({ receipt: { status: "0x1" }, tx: { value: "0xf4240" } }));
  assert.equal(result.hash, SETTLED_ONCHAIN.hash);
  assert.equal(result.claimed, SETTLED_ONCHAIN.claimed, "the pinned default still carries the recorded claim");
  assert.equal(result.verdict, VERDICT.SETTLED, "the pinned tx still re-derives settled");
});

/* ------------------------------------------------------------------------------------------------ *
 * Clean-room / live-surface constants are 0G-only (no private path, no non-0G host).
 * ------------------------------------------------------------------------------------------------ */

test("the on-chain reads target 0G Galileo testnet (chain id 16602) on a public 0g.ai host", () => {
  assert.equal(GALILEO.chainId, 16602);
  assert.match(GALILEO.rpcUrl, /0g\.ai/);
  assert.match(GALILEO.explorer, /chainscan-galileo\.0g\.ai/);
  // No private home path leaked into the live-surface constants.
  assert.doesNotMatch(GALILEO.rpcUrl, /SweePoh/);
});

test("the pinned SETTLED hash is a well-formed 32-byte tx hash and matches the spine corpus shape", () => {
  assert.match(SETTLED_ONCHAIN.hash, /^0x[0-9a-fA-F]{64}$/);
  assert.equal(SETTLED_ONCHAIN.claimed, 1_000_000n);
});
