# ProofAgent-0G

**The AI agent that can't lie, and can't overspend.**

An autonomous on-chain agent on **0G** whose three layers are each *independently provable*:

| Proof | Guarantee | How |
|---|---|---|
| **Brain** | the model you think ran, ran | 0G Compute **TEE attestation** — *built + offline-tested; green only on a real enclave proof (see note)* |
| **Rails** | it can't overspend — blocked pre-broadcast, proven by the verifier | an on-chain **spend cap** (the live **`MandateRegistryV4`** on 0G), checked pre-broadcast |
| **Settlement** | the trade really happened | an **independent verifier** that reads 0G itself |

You don't trust the agent. You check the chain.

> **Honest state of the Brain proof.** The Brain leg is an **original clean-room implementation** on 0G's
> public `@0glabs/0g-serving-broker` SDK (no internal dependency), **built + offline-tested**
> (`agent/src/zerog/compute.ts`). Its verdict is `attested:true` ONLY when **two cryptographic facts** both
> hold — a `trusted` provider-service attestation AND a verified per-response enclave signature — **never** the
> model's own words. The live broker call needs a **funded 0G Compute sub-account + a TEE provider**, so it is
> **operator-gated**: the default offline build keeps the Brain stamp **PENDING**, and it goes green only once
> one live verified attestation runs. We never fabricate an attestation. Details: [`docs/PROOFAGENT_0G_EVIDENCE.md`](docs/PROOFAGENT_0G_EVIDENCE.md) §1h.

🌐 **[Open the live Verification Console →](https://aristosmesotes.github.io/proofagent-0g/dashboard.html)** — no install, no wallet, no signup. Run every proof in your browser right now: the four cards, paste **any** 0G tx hash into the Playground, the dry-run RUN LEDGER, the mandate card — all reconciled live against 0G Galileo (the public RPC, read-only).

👉 **[Verify it yourself →](./VERIFY.md)** — for judges, voters & developers: a 1-minute no-tools chain check, the full hands-on CLI/contract reproduction, **and a zero-trust, zero-wallet fullstack browser guide** that walks you through confirming every proof through the real Verification Console (the four cards · the paste-any-hash Playground · the dry-run RUN LEDGER · the mandate card).

### The 30-second proof
Point the verifier at a **fabricated** transaction hash and it stamps **`UNVERIFIED`** — not `SETTLED`.
It isn't rubber-stamping; it's reading the chain.

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
(`0x8e561a5cc096af6e570220a5228b33c7d889f774`) — so its period tier reads a live-enforced figure (the V4 USD
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
