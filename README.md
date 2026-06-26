# ProofAgent-0G

[![ci](https://github.com/AristosMesotes/proofagent-0g/actions/workflows/ci.yml/badge.svg)](https://github.com/AristosMesotes/proofagent-0g/actions/workflows/ci.yml)

**The AI agent that can't lie, and can't overspend — live on 0G, and it won't fake the rest.**

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

### Every layer is built on 0G — the Chain layer is LIVE, and we never fake the rest

| 0G layer | What it proves | Status | How |
|---|---|---|---|
| **0G Chain** — *gates + settles* | can't overspend **and** can't lie | 🟢 **LIVE** | the on-chain **`MandateRegistryV4`** ([`0x8e561a…f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774) on Galileo `16602`) blocks an over-cap spend **pre-broadcast**; an **independent Rust verifier** reads 0G itself and stamps `SETTLED` only on a real on-chain receipt |
| **0G Compute** — *reasons* | which model actually ran | 🟡 **operator-gated** | a **TEE attestation** on 0G Compute — `attested` only when a service attestation **and** a per-response enclave signature both verify (never the model's word); built + offline-tested, green on a live enclave proof |
| **0G Storage** — *attests* | the proof itself lives on 0G | 🟡 **operator-gated** | the verifier's verdict bundle, **published immutably to 0G Storage** → a content-addressed `rootHash` anyone can re-derive; built + offline-tested — the live leg already computes the genuine 0G `rootHash`, with the on-chain anchor currently gated by a 0G testnet storage-flow outage |

**0G Chain is LIVE and chain-checkable right now** (it carries both money proofs — can't-overspend **and** can't-lie; verify them yourself above). **0G Compute** (the brain) and **0G Storage** (the proof bundle) are **built + offline-tested**, and they read **honestly PENDING** — their green flip is **operator-gated** on a real live attestation / a real live publish. *That is the point, not a gap:* we **never paint a layer green until the chain proves it** — the same refusal-to-fake that makes the agent itself trustworthy. A skeptic who notices Compute/Storage aren't live yet has just confirmed the pitch. (Details below.)

**Run it yourself — no trust, no wallet, no signup:**
- **▶ Watch it refuse a lie** — one click runs the NEG case live (a fabricated hash → `UNVERIFIED`).
- **Real vs fake, zero typing** — two buttons: a real settlement → `SETTLED`, a fabricated one → `UNVERIFIED`.
- **Run it with YOUR wallet (Tier-2)** — connect your own wallet and run the same mandate gate with your own key: over-cap is refused pre-broadcast (nothing to sign), under-cap you sign and the independent verifier confirms *your* tx.
- **Watch the agent's wallet on 0G** — read-only, key-free: the live balance + nonce, straight from chain.

<details>
<summary><strong>Honest state of the Brain proof</strong> — why it reads PENDING, not green</summary>

> The Brain leg is an **original implementation** on 0G's
> public `@0glabs/0g-serving-broker` SDK (no internal dependency), **built + offline-tested**
> (`agent/src/zerog/compute.ts`). Its verdict is `attested:true` ONLY when **two cryptographic facts** both
> hold — a `trusted` provider-service attestation AND a verified per-response enclave signature — **never** the
> model's own words. The live broker call needs a **funded 0G Compute sub-account + a TEE provider**, so it is
> **operator-gated**: the default offline build keeps the Brain stamp **PENDING**, and it goes green only once
> one live verified attestation runs. We never fabricate an attestation. Details: [`docs/PROOFAGENT_0G_EVIDENCE.md`](docs/PROOFAGENT_0G_EVIDENCE.md) §1h.

</details>

### Run the agent without spending a cent (dry-run)
The web **Verification Console** ([**live**](https://aristosmesotes.github.io/proofagent-0g/dashboard.html) · `web/dashboard.html`) has a **"Run the agent (dry-run)"** card that walks the
full agent loop READ-ONLY — **no wallet, no signing, nothing broadcast**. It plans three demo trades, gates each
**per asset** with a real zero-gas `checkTransfer` `eth_call` on the deployed mandate (an allowlisted asset under
its cap → **ALLOWED**; over its cap → **OVER_TX_CAP**; a non-allowlisted asset → **TOKEN_NOT_ALLOWED**), and
produces a **RUN LEDGER** in the verifier's own journal format. A dry-run broadcasts nothing, so every leg is
honestly `unverified` — never a fabricated `settled`. The Brain stamp stays **PENDING** (its green flip is
operator-gated on a real TEE attestation).

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
