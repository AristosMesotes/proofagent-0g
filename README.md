# ProofAgent-0G

**The AI agent that can't lie, and can't overspend.**

An autonomous on-chain agent on **0G** whose three layers are each *independently provable*:

| Proof | Guarantee | How |
|---|---|---|
| **Brain** | the model you think ran, ran | 0G Compute **TEE attestation** — *built + offline-tested; green only on a real enclave proof (see note)* |
| **Rails** | it can't overspend — blocked pre-broadcast, proven by the verifier | an on-chain **spend cap**, checked pre-broadcast |
| **Settlement** | the trade really happened | an **independent verifier** that reads 0G itself |

You don't trust the agent. You check the chain.

> **Honest state of the Brain proof.** The Brain leg is an **original clean-room implementation** on 0G's
> public `@0glabs/0g-serving-broker` SDK (no internal dependency), **built + offline-tested**
> (`agent/src/zerog/compute.ts`). Its verdict is `attested:true` ONLY when **two cryptographic facts** both
> hold — a `trusted` provider-service attestation AND a verified per-response enclave signature — **never** the
> model's own words. The live broker call needs a **funded 0G Compute sub-account + a TEE provider**, so it is
> **operator-gated**: the default offline build keeps the Brain stamp **PENDING**, and it goes green only once
> one live verified attestation runs. We never fabricate an attestation. Details: [`docs/PROOFAGENT_0G_EVIDENCE.md`](docs/PROOFAGENT_0G_EVIDENCE.md) §1h.

👉 **[Verify it yourself →](./VERIFY.md)** — for judges, voters & developers: a 1-minute no-tools chain check, then the full hands-on reproduction.

### The 30-second proof
Point the verifier at a **fabricated** transaction hash and it stamps **`UNVERIFIED`** — not `SETTLED`.
It isn't rubber-stamping; it's reading the chain.

### Stack
Rust (verifier) · Solidity (mandate) · TypeScript (agent · 0G SDKs · web).
Self-contained, MIT, talks to 0G only through public SDKs.

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
MIT.
