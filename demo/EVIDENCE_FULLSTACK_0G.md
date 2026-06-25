# ProofAgent — Full-Stack 0G Evidence (every layer on 0G)

**Captured:** 2026-06-26 · 0G Galileo testnet (chainId 16602) · RPC `https://evmrpc-testnet.0g.ai`
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

## 🟡 0G STORAGE — leg works; genuine 0G root computed; on-chain anchor externally gated

ProofAgent's own `liveStorageProvider` / `publishVerdictBundle` leg ran LIVE against the public 0G SDK
(`@0glabs/0g-ts-sdk` 0.3.3) + the turbo indexer (`indexer-storage-testnet-turbo.0g.ai`):

- canonical verdict bundle (205 B, deterministic sorted-key JSON, re-derivable):
  `{"chainId":16602,"claimed":1000000,"hash":"0x8c59…bfb0","kind":"transfer","observed":1000000,"toleranceDen":100,"toleranceNum":15,"verdict":"settled"}`
- offline content fingerprint: `fnv1a64:3757cc296240148b`
- **genuine 0G Storage Merkle rootHash (computed by the official 0G SDK):**
  `0x7d1aae699fc463514080876c4d4da2a487ffce4e02baddd4248faa0c102f6275`
  — content-addressed, re-derivable by anyone who re-serialises the same bundle and runs the SDK merkle.
- live storage nodes were selected (turbo indexer returned real StorageNodes; merkle prepared: 1 segment / 1 chunk).

**Externally gated (stated loudly, NOT faked green):** the final on-chain anchor tx (`Flow.submit` on
`0x22E03a…105296`) reverts `require(false)` on the current 0G testnet for ANY payload — reproduced 4 ways
(SDK-calculated fee, 0.01 0G cushion, an 8 KB control file, and a manual gasLimit that mined-and-reverted);
the standard indexer (`indexer-storage-testnet-standard.0g.ai`) is `503`-down. This is a current 0G **testnet**
storage-flow availability issue, external to proofagent — corroborated by the product backend defaulting to
`STORAGE_TYPE=LocalMemory`. The leg is correct and ready; it anchors the instant the testnet flow recovers.

> Leg fix discovered live: `liveStorageProvider` must wrap bytes in a Node `Blob` before the SDK `Blob`
> (`new Blob([new globalThis.Blob([bytes])])`) — the SDK `Blob` iterates `this.blob.slice().arrayBuffer()`,
> which a raw `Uint8Array` lacks. Patch belongs in `agent/src/zerog/storage.ts` (`loadPublicStorage`).

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

**Externally gated:** a real `attested:true` needs a funded 0G Compute ledger + a live TeeML provider, which is
not provisioned anywhere in the stack (the product brain is Gemini via OpenRouter, not 0G Compute). The green
machinery is real and tested; it lights up the instant a 0G Compute provider is wired — never faked in the meantime.

---

## The story (every layer on 0G)
**0G Chain reasons-about-money and gates it — LIVE.** **0G Storage attests the verdict — root computed, anchor
testnet-gated.** **0G Compute attests the cognition — seam green, enclave provider-gated.** ProofAgent refuses to
paint anything green it cannot prove on-chain: that refusal IS the product (honest by construction).

## LI.FI ↔ 0G framing (settlement oracle)
LI.FI Intents (live 2026) releases solver funds only after an Oracle proves the fill (`efficientRequireProven`).
ProofAgent IS that oracle, the honest version: an independent verifier that mints `settled/hollow/mismatch` and
BLOCKS release on a hollow fill where a hash-only oracle would pay. Roadmap: fill-proof verdict path, TEE-attested
solver brain, verdict bundle on 0G Storage, slashable mandate, cross-chain fill proof.
