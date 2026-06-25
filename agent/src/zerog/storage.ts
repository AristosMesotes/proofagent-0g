/**
 * The Storage proof -- `publishVerdictBundle(...)`: the verifier's verdict, published to 0G Storage as
 * IMMUTABLE, content-addressed, auditable evidence (design §9 Wow, §3, §6 "the proof itself lives on 0G").
 *
 * The whole project's thesis is "you don't trust it, you check the chain." The settlement verdict the
 * independent Rust verifier mints (settled / hollow / mismatch / unverified) is the proof that the money
 * moved. But today that verdict is emitted in-process only -- the PROOF lives off-0G. This leg closes the
 * loop: it serialises the verdict bundle CANONICALLY (deterministic bytes), publishes it to 0G Storage,
 * and carries back the on-0G Merkle **rootHash** -- a content-addressed handle anyone can re-derive and
 * re-download. The proof of settlement now lives on 0G, beside the settlement it proves. A second 0G
 * pillar (Storage), genuinely on-chain, not a slogan.
 *
 * ## Honest by construction (design §3 #2 / #3)
 *
 * The leg MINTS no verdict -- it carries the verifier's. It NEVER fabricates a rootHash: a publish failure,
 * a missing SDK, an unreachable indexer, or a malformed root is a loud [`StorageError`], never a guessed
 * handle. The rootHash is the 0G Storage Merkle root (a 32-byte `0x`-hex), re-derivable by anyone who
 * re-serialises the same bundle and recomputes the tree -- so the evidence is checkable, not asserted. The
 * local [`bundleDigest`] (a pure FNV-1a fingerprint of the canonical bytes) lets a reader confirm the bytes
 * are the bytes BEFORE trusting any network round-trip.
 *
 * ## Offline-by-default + the live path is operator-gated (design §6, the honesty bar)
 *
 * This module is pure and dependency-free EXCEPT for [`liveStorageProvider`], which dynamically imports
 * the public `@0glabs/0g-ts-sdk` + `ethers` ONLY when the operator constructs it with a funded wallet.
 * The default build, and every test, drives [`publishVerdictBundle`] with an in-repo stub
 * [`StorageProvider`] -- so `tsc` and the suite run with no SDK installed and no network reachable. The
 * single live publish (which needs a funded 0G wallet for storage gas) is reached only on that opt-in
 * path; the default offline build pins NO rootHash and keeps the Storage stamp PENDING.
 *
 * ## Clean-room (design §6)
 *
 * No proprietary identifier, private path, or secret appears here. The only external names are the PUBLIC
 * `@0glabs/0g-ts-sdk` storage-SDK package name and its documented `Indexer.upload` concept. The wallet
 * key, the EVM RPC, and the indexer RPC all come from operator config/env, never baked into the source.
 */

/** A loud failure on the Storage path (design §3 #3 -- degrade loudly, never fabricate a rootHash). */
export class StorageError extends Error {
  public override readonly name = "StorageError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

/**
 * The canonical verdict bundle -- the verifier's settlement record, the auditable payload published to 0G
 * Storage. A flat, JSON-safe value object: minor-unit amounts are STRINGS (never JS numbers/bigints) so the
 * serialisation is lossless + deterministic, and `null` marks "not on record" (the keystone -- never a
 * fabricated zero). It mirrors the verifier's journal record (design §6): the subject tx, its leg kind, the
 * minted verdict, the claim/observation, and the chain + tolerance band the verdict was derived under.
 */
export interface VerdictBundle {
  /** The subject transaction hash the verdict is about (`0x` + 64 hex). */
  readonly hash: string;
  /** The leg kind (e.g. `settled` / `hollow` / `mismatch` / `unverified`, or a `buy`/`sell`/`swap` leg). */
  readonly kind: string;
  /** The verifier's minted verdict string (the only green word is `settled`). */
  readonly verdict: string;
  /** The agent's recorded claim, MINOR units as a decimal STRING, or `null` when no claim is on record. */
  readonly claimed: string | null;
  /** The independent on-chain observation, MINOR units as a decimal STRING, or `null` when unread. */
  readonly observed: string | null;
  /** The chain id the verdict was derived on (0G Galileo testnet = 16602). */
  readonly chainId: number;
  /** The exact-integer tolerance band numerator the verdict used (design §3 #5, no float). */
  readonly toleranceNum: number;
  /** The exact-integer tolerance band denominator the verdict used. */
  readonly toleranceDen: number;
}

/** The result of a 0G Storage publish -- the on-0G Merkle root (+ the settling storage tx, when returned). */
export interface StoragePublishResult {
  /** The 0G Storage Merkle root hash (`0x` + 64 hex) -- the content-addressed, re-derivable on-0G handle. */
  readonly rootHash: string;
  /** The settling storage transaction hash, when the SDK returns it (`undefined` otherwise). */
  readonly txHash?: string | undefined;
}

/**
 * The narrow STORAGE seam (mirrors the Brain's `AttestationProvider` and the verifier's `Source`): the ONE
 * boundary the Storage leg publishes across. A live `@0glabs/0g-ts-sdk` Indexer adapter and an offline test
 * double both satisfy it, so the publish logic is identical whether it talks to real 0G Storage or a
 * recorded double. The single method returns a real on-0G handle, or THROWS (mapped to a loud StorageError).
 */
export interface StorageProvider {
  /**
   * Publish `bytes` to 0G Storage and return the content-addressed Merkle [`StoragePublishResult`]. THROWS
   * on any transport/SDK/upload failure (the caller maps a throw to a loud StorageError -- never a fake root).
   */
  publish(bytes: Uint8Array): Promise<StoragePublishResult>;
}

/** The receipt of a published verdict bundle -- the local fingerprint + the on-0G handle (design §6). */
export interface BundleReceipt {
  /** A pure, local content fingerprint of the canonical bytes (FNV-1a) -- checkable BEFORE any network. */
  readonly bundleDigest: string;
  /** The 0G Storage Merkle root of the published bundle -- the proof-of-the-proof, live on 0G. */
  readonly rootHash: string;
  /** The settling storage tx hash, when the SDK returned one. */
  readonly txHash: string | undefined;
  /** The byte length of the canonical bundle (for the journal/UI). */
  readonly bytesLength: number;
}

/** Match a 32-byte 0G Storage Merkle root / tx hash: `0x` + exactly 64 hex (case-insensitive). */
const ROOT_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// ------------------------------------------------------------------------------------------------
// Canonical serialisation + a pure content fingerprint (deterministic, dependency-free, offline).
// ------------------------------------------------------------------------------------------------

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = (1n << 64n) - 1n;

/** A pure FNV-1a 64-bit fingerprint of `bytes`, as `fnv1a64:<16-hex>`. Deterministic, no dependency. */
export function fnv1a64(bytes: Uint8Array): string {
  let h = FNV64_OFFSET;
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & FNV64_MASK;
  }
  return `fnv1a64:${h.toString(16).padStart(16, "0")}`;
}

/**
 * Serialise a [`VerdictBundle`] to CANONICAL bytes -- a deterministic JSON object with keys in sorted order
 * (so the same bundle always yields byte-identical output, and thus a byte-identical 0G Storage rootHash).
 * Returns the canonical JSON string, its UTF-8 bytes, and the pure FNV-1a fingerprint of those bytes.
 *
 * Pure + deterministic (design §3 #4): no clock, no I/O. A reader re-runs this on the same bundle and gets
 * the same bytes + the same digest -- the local half of "checkable, not asserted".
 */
export function serializeVerdictBundle(bundle: VerdictBundle): {
  readonly json: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
} {
  if (typeof bundle !== "object" || bundle === null) {
    throw new StorageError("verdict bundle must be a non-null object");
  }
  if (!ROOT_HASH_RE.test(bundle.hash)) {
    throw new StorageError(`verdict bundle hash must be a 0x + 64-hex tx hash, got ${String(bundle.hash)}`);
  }
  // Canonical JSON: sort keys; JSON-encode each value (string | number | null only -- the bundle is flat).
  const record: Record<string, unknown> = {
    hash: bundle.hash,
    kind: bundle.kind,
    verdict: bundle.verdict,
    claimed: bundle.claimed,
    observed: bundle.observed,
    chainId: bundle.chainId,
    toleranceNum: bundle.toleranceNum,
    toleranceDen: bundle.toleranceDen,
  };
  const keys = Object.keys(record).sort();
  const json = `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k] ?? null)}`).join(",")}}`;
  const bytes = new TextEncoder().encode(json);
  return { json, bytes, digest: fnv1a64(bytes) };
}

/**
 * Publish a verifier verdict bundle to 0G Storage and return its [`BundleReceipt`] (design §9 Wow).
 *
 * Serialises the bundle canonically, publishes the bytes across the injected [`StorageProvider`] seam, and
 * validates the returned rootHash to the 32-byte `0x`-hex shape. NEVER fabricates a handle: a publish throw,
 * a malformed root, or a non-`0x` result is a loud [`StorageError`] (design §3 #3). The receipt carries the
 * local FNV-1a fingerprint (checkable offline) AND the on-0G rootHash (the immutable, re-derivable handle).
 *
 * @param bundle   The verifier's verdict bundle (the auditable payload).
 * @param storage  The storage seam -- a live `@0glabs/0g-ts-sdk` Indexer adapter OR an offline test double.
 */
export async function publishVerdictBundle(
  bundle: VerdictBundle,
  storage: StorageProvider,
): Promise<BundleReceipt> {
  const { bytes, digest } = serializeVerdictBundle(bundle);

  let result: StoragePublishResult;
  try {
    result = await storage.publish(bytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StorageError(`0G Storage publish failed (no rootHash minted): ${detail}`);
  }

  if (typeof result !== "object" || result === null || !ROOT_HASH_RE.test(result.rootHash)) {
    // A malformed/absent root is NEVER coerced into a handle -- degrade loud (design §3 #3).
    throw new StorageError(
      `0G Storage returned a malformed rootHash (expected 0x + 64 hex): ${String(result?.rootHash)}`,
    );
  }
  const txHash =
    typeof result.txHash === "string" && ROOT_HASH_RE.test(result.txHash) ? result.txHash : undefined;

  return { bundleDigest: digest, rootHash: result.rootHash.toLowerCase(), txHash, bytesLength: bytes.length };
}

// ------------------------------------------------------------------------------------------------
// liveStorageProvider -- the OPERATOR-GATED live path. Dynamically imports the PUBLIC @0glabs/0g-ts-sdk
// + ethers ONLY here, so the default build / tests never need the SDK or the network. Needs a FUNDED 0G
// wallet (storage gas) + an indexer endpoint; opt-in by construction.
// ------------------------------------------------------------------------------------------------

/**
 * Operator config for the LIVE 0G Storage publish path. Every field is operator-supplied; NONE is
 * hardcoded. The wallet key is read from a gitignored env var by the caller and passed in here -- NEVER
 * logged, printed, or committed (the honesty bar). This path needs a funded 0G wallet for storage gas, so
 * it is opt-in and infra-gated.
 */
export interface LiveStorageConfig {
  /** The publisher wallet PRIVATE KEY (from a gitignored env var; never logged/committed). */
  readonly walletPrivateKey: string;
  /** The 0G EVM JSON-RPC endpoint URL (from env -- e.g. `OG_RPC`). Never hardcoded. */
  readonly evmRpcUrl: string;
  /** The 0G Storage INDEXER RPC endpoint URL (from env -- the documented `Indexer` endpoint). Never hardcoded. */
  readonly indexerRpcUrl: string;
}

/**
 * The minimal PUBLIC shape this module needs from `@0glabs/0g-ts-sdk` -- declared locally (rather than
 * importing SDK types) so `tsc` stays fully offline; the real SDK is loaded only at runtime on the live
 * path and structurally checked there. Mirrors the documented `new Indexer(url)` + `indexer.upload(file,
 * evmRpc, signer) -> [tx, err]` (with `tx.rootHash` / `tx.txHash`) and an in-memory file factory.
 */
interface PublicStorageIndexer {
  upload(
    file: unknown,
    evmRpc: string,
    signer: unknown,
  ): Promise<[{ rootHash?: string; txHash?: string } | null, unknown]>;
}

/** A constructed live publisher: the indexer + the EVM RPC + the signer + an in-memory-file factory. */
interface LiveStorageHandles {
  readonly indexer: PublicStorageIndexer;
  readonly evmRpc: string;
  readonly signer: unknown;
  /** Build the SDK's in-memory file/blob from raw bytes (the SDK's `ZgFile.fromBytes` / `Blob`). */
  readonly fileFromBytes: (bytes: Uint8Array) => unknown;
}

/**
 * Construct the LIVE [`StorageProvider`] backed by the public `@0glabs/0g-ts-sdk` (design §9 Wow). The SDK
 * is imported DYNAMICALLY here -- the default offline build and the tests never load it. The returned
 * provider performs a real `Indexer.upload` against a FUNDED 0G wallet and returns the genuine on-0G Merkle
 * rootHash. This is the operator-gated path; the default build pins no rootHash (Storage stamp PENDING).
 *
 * @throws {StorageError} if the SDK / ethers / wallet / indexer cannot be loaded (loud -- never a fake root).
 */
export async function liveStorageProvider(config: LiveStorageConfig): Promise<StorageProvider> {
  if (typeof config.walletPrivateKey !== "string" || config.walletPrivateKey.trim() === "") {
    throw new StorageError("liveStorageProvider: a publisher wallet key is required (from a gitignored env var)");
  }
  if (typeof config.evmRpcUrl !== "string" || config.evmRpcUrl.trim() === "") {
    throw new StorageError("liveStorageProvider: an EVM RPC endpoint URL is required (from env)");
  }
  if (typeof config.indexerRpcUrl !== "string" || config.indexerRpcUrl.trim() === "") {
    throw new StorageError("liveStorageProvider: a 0G Storage indexer RPC URL is required (from env)");
  }

  const handles = await loadPublicStorage(config);

  return {
    async publish(bytes: Uint8Array): Promise<StoragePublishResult> {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new StorageError("publish requires a non-empty Uint8Array of canonical bundle bytes");
      }
      const file = handles.fileFromBytes(bytes);
      const [tx, err] = await handles.indexer.upload(file, handles.evmRpc, handles.signer);
      if (err !== null && err !== undefined) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new StorageError(`Indexer.upload reported an error: ${detail}`);
      }
      const rootHash = tx?.rootHash;
      if (typeof rootHash !== "string" || !ROOT_HASH_RE.test(rootHash)) {
        throw new StorageError(`Indexer.upload returned no valid rootHash (got ${String(rootHash)})`);
      }
      return { rootHash, txHash: typeof tx?.txHash === "string" ? tx.txHash : undefined };
    },
  };
}

/**
 * Dynamically load the public 0G Storage SDK + ethers and build the live publisher handles. Isolated so the
 * dynamic import + wallet construction live in ONE place and the offline build never resolves them. The
 * package names are the PUBLIC `@0glabs/0g-ts-sdk` + its documented `ethers` peer.
 *
 * @throws {StorageError} on any load/construction failure (loud -- never returns a fake indexer).
 */
async function loadPublicStorage(config: LiveStorageConfig): Promise<LiveStorageHandles> {
  const sdkName = "@0glabs/0g-ts-sdk";
  const ethersName = "ethers";
  try {
    const sdk = (await import(sdkName)) as {
      Indexer?: new (url: string) => PublicStorageIndexer;
      ZgFile?: { fromBytes?: (bytes: Uint8Array) => unknown };
      Blob?: new (data: Uint8Array) => unknown;
    };
    const eth = (await import(ethersName)) as {
      Wallet?: new (key: string, provider: unknown) => unknown;
      JsonRpcProvider?: new (rpc: string) => unknown;
    };
    if (typeof sdk.Indexer !== "function") {
      throw new StorageError("the 0G storage SDK did not export an Indexer constructor");
    }
    if (typeof eth.Wallet !== "function" || typeof eth.JsonRpcProvider !== "function") {
      throw new StorageError("ethers did not export Wallet / JsonRpcProvider");
    }
    // The SDK builds an in-memory file/blob from bytes via ZgFile.fromBytes (newer) or its Blob (in-memory).
    const fromBytes = sdk.ZgFile?.fromBytes;
    const BlobCtor = sdk.Blob;
    let fileFromBytes: (bytes: Uint8Array) => unknown;
    if (typeof fromBytes === "function") {
      fileFromBytes = (bytes) => fromBytes(bytes);
    } else if (typeof BlobCtor === "function") {
      fileFromBytes = (bytes) => new BlobCtor(bytes);
    } else {
      throw new StorageError("the 0G storage SDK exposes no in-memory file factory (ZgFile.fromBytes / Blob)");
    }

    const provider = new eth.JsonRpcProvider(config.evmRpcUrl.trim());
    const signer = new eth.Wallet(config.walletPrivateKey.trim(), provider);
    const indexer = new sdk.Indexer(config.indexerRpcUrl.trim());
    return { indexer, evmRpc: config.evmRpcUrl.trim(), signer, fileFromBytes };
  } catch (err) {
    if (err instanceof StorageError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new StorageError(`failed to load the public 0G Storage SDK (live path is operator-gated): ${detail}`);
  }
}
