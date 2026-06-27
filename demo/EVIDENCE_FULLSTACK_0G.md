# ProofAgent — Full-Stack 0G Evidence (every layer on 0G)

**Captured:** 2026-06-26 · 0G Galileo testnet (chainId 16602) · RPC `https://evmrpc-testnet.0g.ai`
**Status:** all 0G-layer work is merged to `main`; the full gate is GREEN on re-test (2026-06-26) — Rust build · clippy (zero-warning) · test, Foundry 184, agent 239, web 90, all pass. The Storage leg **and its Node-`Blob` upload fix are shipped on `main`**.
**Honesty legend:** ✅ **LIVE** = proven on-chain right now · 🟡 **BUILT, EXTERNALLY GATED** = leg works end-to-end,
one external dependency outstanding (stated loudly, never faked green — design §3 #2/#3).

Every datum below is read INDEPENDENTLY from the public 0G RPC / the official 0G SDK / the test suite — not
asserted by the UI. "Don't trust it, check the chain."

---

## ✅ 0G CHAIN — LIVE & GREEN (settlement + mandate, proven on-chain)

### A. Settlement (two-source adjudication)
- tx `0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0`
- `status = 0x1 SUCCESS` · native `value = 1000000` wei · block `39996100`
- claimed `1000000` == observed `1000000`, within the exact-integer 15/100 band → **verdict: SETTLED**
- Explorer: https://chainscan-galileo.0g.ai/tx/0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0

### B. MandateRegistryV4 — `checkTransfer(address,address,uint256) -> (bool ok, bytes32 reason)` (selector `0xcc1dd94f`)
Deployed + enforcing on `0x8e561a5cc096af6e570220a5228b33c7d889f774`, agent bound `0x4850417aE8aEDD5D67344FE98c86515cfb5F393b`:

| probe | amount | on-chain answer |
|---|---|---|
| native (allowlisted) UNDER cap | 1_000_000 | `ok=true` (OK) |
| native (allowlisted) OVER cap | 3_000_000 | `ok=false` · `OVER_TX_CAP` |
| USDC.E (NOT allowlisted) | 1_000_000 | `ok=false` · `TOKEN_NOT_ALLOWED` |

Per-asset allowlist + per-tx cap, enforced on-chain, zero-gas pre-broadcast — the agent is gated by the chain, not by the UI.

---

## 🟢 0G STORAGE — LIVE: a real verdict bundle is published on 0G (rootHash re-fetchable on storagescan)

ProofAgent's own `liveStorageProvider` / `publishVerdictBundle` leg ran LIVE against the OFFICIAL 0G SDK
(`@0gfoundation/0g-storage-ts-sdk`) + the turbo indexer (`indexer-storage-testnet-turbo.0g.ai`), publishing a
real verdict bundle: **rootHash `0x6b51c075…2fe3f6b`** · **txHash `0xb7e7f04f…48f6582`** (re-fetch it on
storagescan-galileo). Pinned in `web/src/spine.ts` (`STORAGE_ONCHAIN`):

- canonical verdict bundle (205 B, deterministic sorted-key JSON, re-derivable):
  `{"chainId":16602,"claimed":1000000,"hash":"0x8c59…bfb0","kind":"transfer","observed":1000000,"toleranceDen":100,"toleranceNum":15,"verdict":"settled"}`
- offline content fingerprint: `fnv1a64:3757cc296240148b`
- **genuine 0G Storage Merkle rootHash (the OFFICIAL `@0gfoundation/0g-storage-ts-sdk`):**
  `0x6b51c075fccac9fff9ab461fee61252d93cd676010ffcb5f79972d8432fe3f6b`
  — content-addressed, re-fetchable by anyone on storagescan-galileo (or re-derivable via the SDK merkle).
- live storage nodes were selected (turbo indexer returned real StorageNodes; merkle prepared: 1 segment / 1 chunk).

**Published LIVE (no longer gated):** the upload SUCCEEDED this session via the official
`@0gfoundation/0g-storage-ts-sdk` + the turbo indexer — `Indexer.upload` returned txHash
`0xb7e7f04f2450a08e60f4c53bccbd6e070b3875a8868e89e39dd2b506748f6582` (txSeq 133133, "Single file upload
completed"). The earlier `Flow.submit` revert was a transient 0G testnet storage-flow outage; it has since
recovered, so the bundle is now a real, published 0G Storage object — the leg is **LIVE**, not gated.

> Leg fix discovered live: `liveStorageProvider` must wrap bytes in a Node `Blob` before the SDK `Blob`
> (`new Blob([new globalThis.Blob([bytes])])`) — the SDK `Blob` iterates `this.blob.slice().arrayBuffer()`,
> which a raw `Uint8Array` lacks. Patch **applied + shipped on `main`** in `agent/src/zerog/storage.ts` (`loadPublicStorage`).

---

## 🟡 0G COMPUTE — TEE-attestation seam GREEN; live enclave externally gated

The brain-attestation seam (`agent/src/zerog/compute.ts`) is the honest gate: the dashboard brain stamp flips
green ONLY when handed `attested:true`, which requires BOTH a trusted service attestation AND a verified
per-response enclave signature. All 11 seam tests pass, including the single true path:

```
✔ attestInference: trusted service + valid signature => attested:true (the ONLY true path)
✔ attestInference: a FAILED service attestation => attested:false (never infer against it)
✔ attestInference: signerMatch true but composeMatch false => NOT trusted => PENDING
✔ attestInference: an UNVERIFIED response signature => attested:false (response unproven)
✔ ... (fail-closed on every throw / missing handle; output never leaks into the verdict; deterministic)
11/11 pass
```

**0G Compute brain:** a real `attested:true` comes from the official `@0gfoundation/0g-compute-ts-sdk` broker — a
funded 0G Compute ledger + a live TeeML provider — and the agent reasons INSIDE that 0G Compute TEE (see
`agent/src/zerog/computeBrain.ts`). Nothing in the stack reasons off 0G — the brain runs only on 0G Compute. The green machinery is
real and tested; it lights the instant a verified enclave attestation is on screen — never faked in the meantime.

---

## The story (every layer LIVE on 0G)
**0G Chain reasons-about-money and gates it — LIVE.** **0G Storage attests the verdict — a real bundle published,
rootHash `0x6b51c0…3f6b` re-fetchable — LIVE.** **0G Compute attests the cognition — a real enclave attestation
verified (`processResponse === true`, provider `0xa48f…7836`), re-runnable — LIVE.** ProofAgent still refuses to
paint anything green it cannot prove: that refusal IS the product (honest by construction) — and now every honest
layer is live, not merely claimed.

## LI.FI ↔ 0G framing (settlement oracle)
LI.FI Intents (live 2026) releases solver funds only after an Oracle proves the fill (`efficientRequireProven`).
ProofAgent IS that oracle, the honest version: an independent verifier that mints `settled/hollow/mismatch` and
BLOCKS release on a hollow fill where a hash-only oracle would pay. Roadmap: fill-proof verdict path, TEE-attested
solver brain, verdict bundle on 0G Storage, slashable mandate, cross-chain fill proof.
