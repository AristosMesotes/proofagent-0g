# ProofAgent-0G

[![ci](https://github.com/AristosMesotes/proofagent-0g/actions/workflows/ci.yml/badge.svg)](https://github.com/AristosMesotes/proofagent-0g/actions/workflows/ci.yml)

**The AI agent that can't lie, and can't overspend — every layer live on 0G, and it still won't fake what it can't prove.**

## Point it at a transaction that never happened — it refuses to rubber-stamp it.

ProofAgent-0G is an autonomous on-chain agent on **0G**. You don't trust the agent — you check the chain.
Here's the proof the proof is real: the same verifier, two hashes, two honest verdicts.

```bash
# A fabricated, well-formed-but-unknown hash → it reads 0G, finds nothing, and degrades LOUDLY:
cargo run -p verifier -- verify-tx 0xdeadbeef00000000000000000000000000000000000000000000000000000000
# -> UNVERIFIED   (exit 1)  — it will NOT print SETTLED for a tx that doesn't exist

# A real, settled transfer on 0G Galileo (block 39,996,100, 1,000,000 wei) → it reads the chain and confirms:
cargo run -p verifier -- verify-tx 0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0
# -> SETTLED      (exit 0)  — confirmable on the public explorer, no trust required
```

Two code paths — *"I could not read it"* and *"it settled"* — that can never be confused. That's the whole pitch:
the agent can't lie because an independent reader, not the agent, gets the last word.

👉 **[Verify it yourself →](./VERIFY.md)** — for judges, voters & developers: a 1-minute no-tools chain check, the full hands-on CLI/contract reproduction, **and a zero-trust, zero-wallet fullstack browser guide** that walks you through confirming every proof through the real Verification Console (the four cards · the paste-any-hash Playground · the dry-run RUN LEDGER · the mandate card).

🌐 **[Open the live Verification Console →](https://aristosmesotes.github.io/proofagent-0g/dashboard.html)** — no install, no wallet, no signup. Run every proof in your browser right now: the four cards, paste **any** 0G tx hash into the Playground, the dry-run RUN LEDGER, the mandate card — all reconciled live against 0G Galileo (read-only).

### Every layer is LIVE on 0G — five primitives, one honest agent (and we still never fake what we can't prove)

| 0G layer | What it proves | Status | How |
|---|---|---|---|
| **0G Chain** — *gates + settles* | can't overspend **and** can't lie | 🟢 **LIVE** | the on-chain **`MandateRegistryV4`** ([`0x8e561a…f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774) on Galileo `16602`) blocks an over-cap spend **pre-broadcast**; an **independent Rust verifier** reads 0G itself and stamps `SETTLED` only on a real on-chain receipt |
| **0G Compute** — *reasons* | which model actually ran | 🟢 **LIVE** | a real **TEE attestation** verified on 0G Compute (`processResponse === true`, official **`@0gfoundation/0g-compute-ts-sdk`**): provider [`0xa48f…7836`](https://chainscan-galileo.0g.ai/address/0xa48f01287233509FD694a22Bf840225062E67836), model `qwen/qwen2.5-omni-7b` — `attested` only when the per-response enclave signature verifies (**never** the model's word). Re-runnable with the official SDK |
| **0G Storage** — *attests* | the proof itself lives on 0G | 🟢 **LIVE** | the verifier's verdict bundle **published immutably to 0G Storage** via the official **`@0gfoundation/0g-storage-ts-sdk`** → content-addressed `rootHash` [`0x6b51c0…3f6b`](https://storagescan-galileo.0g.ai) (txHash `0xb7e7f0…f6582`) — anyone can re-fetch the bundle by its root |
| **0G iNFT (ERC-7857)** — *identifies* | the agent's sovereign Agentic ID | 🟢 **LIVE** | ProofAgent's identity is an **ERC-7857 intelligent-NFT** ([`AgentIdentity 0x3A91…c4B1`](https://chainscan-galileo.0g.ai/address/0x3A915428775fA8AF3CAd01AAb8F801EC1fc0c4B1), token #1) binding its rails + TEE oracle + the 0G Storage mind-handle — and it does **real work**: `canSpend(1,…)` staticcalls the live mandate on-chain → **`OVER_TX_CAP`** for an over-cap spend. Launchpad-mintable (the AIverse Agentic-ID model) |

**All five 0G primitives are LIVE on 0G and checkable** — **Chain** carries both money proofs (can't-overspend **and** can't-lie), **Storage** (which rides on 0G **DA**) holds a real published verdict bundle, **Compute** attested a real enclave inference (`processResponse === true`, re-runnable), and the **ERC-7857 iNFT** is the agent's sovereign identity that enforces its own cap on-chain. *And we still never paint green what we can't prove* — the negative paths are right there: a fabricated hash → `UNVERIFIED`, an over-cap spend → refused **pre-broadcast**, an un-attested reply → **no `tee` label**. That refusal-to-fake is the property that makes the agent trustworthy; the difference now is that **every honest layer is live**, not merely claimed (compare the field, where "0G" is too often a label on a mock).

**Proof you can check yourself** — no rival publishes a single verifiable hash; here are all of ours:

```text
0G Chain    MandateRegistryV4   0x8e561a5cc096af6e570220a5228b33c7d889f774        chainscan-galileo.0g.ai
0G Chain    settled transfer    block 39,996,100 · 1,000,000 wei → SETTLED        (independent Rust verifier)
0G Storage  verdict rootHash    0x6b51c075fccac9fff9ab461fee61252d93cd676010ffcb5f79972d8432fe3f6b
            publish txHash      0xb7e7f04f2450a08e60f4c53bccbd6e070b3875a8868e89e39dd2b506748f6582   storagescan-galileo.0g.ai
0G Compute  TEE attestation     processResponse === true · provider 0xa48f01287233509FD694a22Bf840225062E67836
            model / responseId  qwen/qwen2.5-omni-7b · 8a389c56-b252-428c-a44c-b098f03b9b35   (re-run via @0gfoundation/0g-compute-ts-sdk)
0G iNFT     AgentIdentity       0x3A915428775fA8AF3CAd01AAb8F801EC1fc0c4B1  · token #1        chainscan-galileo.0g.ai
            deploy / mint tx    0x5dd5a81258baf0b026629d83491f5035c55ab82aa02394ed39703a4fcae6d418 · 0x4ed8e1a2884dc3c0a436e2ccc34cc831fa45e61ab283c7df90302e7054a62bc4
            canSpend(over-cap)  staticcall MandateRegistryV4 → OVER_TX_CAP   (the iNFT enforces the rails on-chain)
```
Every line is independently re-checkable on a public scan — except the one-time TEE enclave signature, which is **reproducible** with the official SDK + a funded ledger (that's the honest nature of an attestation, stated plainly).

**Run it yourself — no trust, no wallet, no signup:**
- **▶ Watch it refuse a lie** — one click runs the NEG case live (a fabricated hash → `UNVERIFIED`).
- **Real vs fake, zero typing** — two buttons: a real settlement → `SETTLED`, a fabricated one → `UNVERIFIED`.
- **Run it with YOUR wallet (Tier-2)** — connect your own wallet and run the same mandate gate with your own key: over-cap is refused pre-broadcast (nothing to sign), under-cap you sign and the independent verifier confirms *your* tx.
- **Watch the agent's wallet on 0G** — read-only, key-free: the live balance + nonce, straight from chain.

<details>
<summary><strong>Honest state of the Brain proof</strong> — LIVE, TEE-attested (and how it stays honest)</summary>

> The Brain leg is an **original implementation** on 0G's official
> **`@0gfoundation/0g-compute-ts-sdk`** broker (no internal dependency), **built + tested**
> (`agent/src/zerog/computeBrain.ts`). A plan is labelled `"tee"` ONLY when **`processResponse`** verifies the
> per-response enclave signature — **never** the model's own words. A real verified attestation ran this session
> (provider `0xa48f…7836`, model `qwen/qwen2.5-omni-7b`, `processResponse === true`), so the Brain stamp is
> **LIVE**. A TEE attestation is a *one-time* enclave signature, so the durable proof is the **reproducible**
> broker call (re-run it with the official SDK + a funded ledger) + the recorded evidence — and the stamp drops
> back to PENDING the instant an attestation is absent or un-attested. We never fabricate one. Details:
> [`docs/PROOFAGENT_0G_EVIDENCE.md`](docs/PROOFAGENT_0G_EVIDENCE.md) §1h.

</details>

### Run the agent without spending a cent (dry-run)
The web **Verification Console** ([**live**](https://aristosmesotes.github.io/proofagent-0g/dashboard.html) · `web/dashboard.html`) has a **"Run the agent (dry-run)"** card that walks the
full agent loop READ-ONLY — **no wallet, no signing, nothing broadcast**. It plans three demo trades, gates each
**per asset** with a real zero-gas `checkTransfer` `eth_call` on the deployed mandate (an allowlisted asset under
its cap → **ALLOWED**; over its cap → **OVER_TX_CAP**; a non-allowlisted asset → **TOKEN_NOT_ALLOWED**), and
produces a **RUN LEDGER** in the verifier's own journal format. A dry-run broadcasts nothing, so every leg is
honestly `unverified` — never a fabricated `settled`. The Brain stamp is **LIVE** — TEE-attested (a real enclave
attestation verified, `processResponse === true`); the dry-run itself broadcasts nothing, so its trade legs stay honestly `unverified`.

### See the mandate, read straight from chain
On the **Verification Console** the **RAILS card is a read-only mirror of the deployed mandate registry**: a 0G
chain badge, a tri-state **reconciled-vs-deployed** pill (the on-chain read is the baseline — `Reconciled` /
`Drifted` / `Unverified`, never a faked green), a **per-asset table** (allowlist + per-tx caps; blocked assets
greyed), and a **wallet-free `checkTransfer` simulator** (pick an asset + amount → a real zero-gas `eth_call` →
**`ALLOWED` / `BLOCKED` / `UNVERIFIED`** with the binding reason). No wallet, no signing, no broadcast. The card
now reads the consolidated, hardened **`MandateRegistryV4`** — **LIVE on 0G Galileo testnet `16602`**
([`0x8e561a5cc096af6e570220a5228b33c7d889f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774)) — so its period tier reads a live-enforced figure (the V4 USD
cap stays opt-in/off by default, labelled so — never a number the card does not read).

### Stack
Rust (verifier) · Solidity (mandate) · TypeScript (agent · 0G SDKs · web).
Self-contained, AGPL-3.0-or-later, talks to 0G only through public SDKs.

### Design
See [`docs/PROOFAGENT_0G_DESIGN.md`](docs/PROOFAGENT_0G_DESIGN.md).

### Quick start
```bash
cp .env.example .env      # your own 0G RPC + a FRESH demo wallet — never a shared key
cargo run -p verifier -- verify-tx <hash>      # -> SETTLED / HOLLOW / MISMATCH / UNVERIFIED
```

### Built for
[0G Zero Cup](https://0g.ai/arena/zero-cup).

### License
AGPL-3.0-or-later (GNU Affero General Public License v3.0) — see [LICENSE](LICENSE).
