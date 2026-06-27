/**
 * Tests for the Storage proof (design §9 Wow + §3) -- Node's built-in test runner, fully OFFLINE: an
 * in-repo stub [`StorageProvider`] supplies a recorded rootHash (or a thrown error); zero network, zero
 * SDK. They pin the invariants the Storage leg must hold:
 *  - §3 #4 (deterministic): `serializeVerdictBundle` yields byte-identical canonical output for the same
 *    bundle (so the on-0G rootHash is re-derivable), with keys in sorted order.
 *  - §3 #3 (never fabricate): a publish throw, a malformed/absent rootHash -> a loud `StorageError`, NEVER
 *    a guessed handle. The receipt's rootHash is exactly what the seam returned, never invented.
 *  - §6 (offline-by-default + operator-gated live path): `liveStorageProvider` is fail-closed without the
 *    operator's wallet/RPC/indexer config -- it throws before any dynamic SDK import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeVerdictBundle,
  publishVerdictBundle,
  liveStorageProvider,
  localStorageProvider,
  contentAddress,
  fnv1a64,
  StorageError,
  type VerdictBundle,
  type StorageProvider,
  type StoragePublishResult,
} from "./storage.js";

// --- Fixtures -------------------------------------------------------------------------------------

const HASH = `0x${"8c".repeat(32)}`; // a 0x + 64-hex subject tx hash

function bundleOf(over?: Partial<VerdictBundle>): VerdictBundle {
  return {
    hash: HASH,
    kind: "settled",
    verdict: "settled",
    claimed: "1000000",
    observed: "1000000",
    chainId: 16602,
    toleranceNum: 15,
    toleranceDen: 100,
    ...over,
  };
}

/** A programmable stub storage seam -- records the published bytes; returns a recorded root or throws. */
function stubStorage(opts: {
  rootHash?: string;
  txHash?: string;
  throws?: string;
}): StorageProvider & { calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  return {
    calls,
    async publish(bytes: Uint8Array): Promise<StoragePublishResult> {
      calls.push(bytes);
      if (opts.throws !== undefined) {
        throw new Error(opts.throws);
      }
      return { rootHash: opts.rootHash ?? `0x${"ab".repeat(32)}`, txHash: opts.txHash };
    },
  };
}

// --- serialise / fingerprint ----------------------------------------------------------------------

test("serializeVerdictBundle is deterministic + canonical (sorted keys)", () => {
  const a = serializeVerdictBundle(bundleOf());
  const b = serializeVerdictBundle(bundleOf());
  assert.equal(a.json, b.json);
  assert.equal(a.digest, b.digest);
  assert.deepEqual([...a.bytes], [...b.bytes]);
  // keys are sorted -> chainId, claimed, hash, kind, observed, toleranceDen, toleranceNum, verdict.
  assert.ok(a.json.startsWith('{"chainId":16602,"claimed":"1000000","hash":'));
  assert.ok(a.json.endsWith('"verdict":"settled"}'));
});

test("serializeVerdictBundle keeps null amounts (the keystone -- never a fabricated zero)", () => {
  const { json } = serializeVerdictBundle(bundleOf({ claimed: null, observed: null, verdict: "unverified" }));
  assert.ok(json.includes('"claimed":null'));
  assert.ok(json.includes('"observed":null'));
});

test("serializeVerdictBundle rejects a malformed subject hash", () => {
  assert.throws(() => serializeVerdictBundle(bundleOf({ hash: "nope" })), StorageError);
});

test("fnv1a64 is stable + input-sensitive", () => {
  const d1 = fnv1a64(new TextEncoder().encode("proofagent"));
  assert.equal(d1, fnv1a64(new TextEncoder().encode("proofagent")));
  assert.match(d1, /^fnv1a64:[0-9a-f]{16}$/);
  assert.notEqual(d1, fnv1a64(new TextEncoder().encode("proofagent!")));
});

// --- publish --------------------------------------------------------------------------------------

test("publishVerdictBundle carries the on-0G rootHash (never fabricated) + the local digest", async () => {
  const root = `0x${"cd".repeat(32)}`;
  const tx = `0x${"ef".repeat(32)}`;
  const storage = stubStorage({ rootHash: root, txHash: tx });
  const receipt = await publishVerdictBundle(bundleOf(), storage);
  const ser = serializeVerdictBundle(bundleOf());

  assert.equal(receipt.rootHash, root.toLowerCase()); // the seam's root, not an invented one
  assert.equal(receipt.txHash, tx);
  assert.equal(receipt.bundleDigest, ser.digest);
  assert.equal(receipt.bytesLength, ser.bytes.length);
  // the published bytes are EXACTLY the canonical bundle bytes (re-derivable evidence).
  assert.deepEqual([...(storage.calls[0] ?? new Uint8Array())], [...ser.bytes]);
});

test("publishVerdictBundle degrades LOUD on a publish throw (never a fabricated root)", async () => {
  await assert.rejects(
    () => publishVerdictBundle(bundleOf(), stubStorage({ throws: "indexer unreachable" })),
    StorageError,
  );
});

test("publishVerdictBundle rejects a malformed rootHash (never coerced into a handle)", async () => {
  await assert.rejects(() => publishVerdictBundle(bundleOf(), stubStorage({ rootHash: "0xnope" })), StorageError);
});

test("publishVerdictBundle drops a malformed txHash but keeps a valid rootHash", async () => {
  const receipt = await publishVerdictBundle(bundleOf(), stubStorage({ rootHash: `0x${"11".repeat(32)}`, txHash: "garbage" }));
  assert.equal(receipt.txHash, undefined);
  assert.equal(receipt.rootHash, `0x${"11".repeat(32)}`);
});

// --- the operator-gated live path -----------------------------------------------------------------

test("liveStorageProvider is fail-closed without operator config (no key/rpc/indexer)", async () => {
  await assert.rejects(
    () => liveStorageProvider({ walletPrivateKey: "", evmRpcUrl: "x", indexerRpcUrl: "y" }),
    StorageError,
  );
  await assert.rejects(
    () => liveStorageProvider({ walletPrivateKey: "k", evmRpcUrl: "", indexerRpcUrl: "y" }),
    StorageError,
  );
  await assert.rejects(
    () => liveStorageProvider({ walletPrivateKey: "k", evmRpcUrl: "x", indexerRpcUrl: "" }),
    StorageError,
  );
});

// --- the local content-addressed provider (fully-working, network-free) ---------------------------

test("contentAddress is a re-derivable 0x + 64-hex SHA-256 (deterministic)", () => {
  const a = contentAddress(new TextEncoder().encode("proofagent"));
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, contentAddress(new TextEncoder().encode("proofagent"))); // same bytes -> same root
  assert.notEqual(a, contentAddress(new TextEncoder().encode("proofagen"))); // different bytes -> different root
});

test("localStorageProvider publishes a verdict bundle end-to-end (a real content-address, no network)", async () => {
  const storage = localStorageProvider();
  const receipt = await publishVerdictBundle(bundleOf(), storage);
  const ser = serializeVerdictBundle(bundleOf());
  assert.equal(receipt.rootHash, contentAddress(ser.bytes)); // the honest SHA-256 of the canonical bytes
  assert.match(receipt.rootHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.txHash, undefined); // a local store has no settling tx
  assert.equal(receipt.bytesLength, ser.bytes.length);
});

test("localStorageProvider round-trips: retrieve returns byte-identical bytes (re-derivable proof)", async () => {
  const storage = localStorageProvider();
  const ser = serializeVerdictBundle(bundleOf());
  const { rootHash } = await storage.publish(ser.bytes);
  const got = storage.retrieve(rootHash);
  assert.ok(got);
  assert.deepEqual([...got], [...ser.bytes]);
  assert.equal(contentAddress(got), rootHash); // what we got back re-derives the SAME root
  assert.equal(storage.retrieve(`0x${"00".repeat(32)}`), null); // an unknown root -> null
});

test("localStorageProvider rejects empty bytes (loud, never a fake root)", async () => {
  await assert.rejects(() => localStorageProvider().publish(new Uint8Array()), StorageError);
});
