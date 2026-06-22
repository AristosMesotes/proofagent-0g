# ProofAgent-0G — Design

> **The AI agent that can't lie, and can't overspend.**
> An autonomous on-chain agent on 0G whose three layers are each *independently provable*:
> its brain ran in a hardware enclave, its spend is hard-capped on-chain, and a separate
> verifier reads the chain itself — never the agent's own word.

| | |
|---|---|
| **Status** | Design — MVP scaffold live; the swap/route/bridge wow legs + the four-tier mandate + the consolidated, hardened `MandateRegistryV4` (folds V3 + TimelockGuard, with the I14-R spend reconciler) built & tested (V4 deploy operator-gated) |
| **License** | MIT |
| **Chain** | 0G — Aristotle (chain id `16661`); Galileo testnet (`16602`) |
| **Stack** | Rust (verifier) · Solidity (mandate) · TypeScript (agent · 0G SDKs · web) |
| **Authors** | **CJ** (first author) · **SweePoh** (second author / support) |

> **One unified design.** This document is the single source of truth for ProofAgent-0G — the three
> proofs, the invariants, the loop, the clean-room gate, **and** the full wow surface (swap · route ·
> bridge-in/out · the four-tier mandate · the consolidated, hardened `MandateRegistryV4` · the Engine), the
> cross-chain hub-and-spoke security model, and
> the money-safety suite (the gas floor + the net-worth floor). The *as-built* evidence record — the live
> on-chain proofs, the full gate matrix, and the design ↔ code conformance verdict — is in
> [`docs/PROOFAGENT_0G_EVIDENCE.md`](PROOFAGENT_0G_EVIDENCE.md); the adapter recipe is in
> [`docs/ADD_AN_ADAPTER.md`](ADD_AN_ADAPTER.md). This is the design; those report what shipped.

---

## 1. The problem

AI agents are now trusted with money and decisions — but you have to take the agent's *word* for three things:

- **which model actually ran** — was it the model it claims, un-tampered?
- **how much it is allowed to spend** — what stops a buggy or hijacked agent from draining a wallet?
- **whether a trade actually settled** — did the money really move, or is the dashboard lying?

**ProofAgent-0G makes all three independently provable on 0G.** You don't trust the agent — you check the chain.

---

## 2. The three proofs

| Proof | The claim it kills | Mechanism (all on 0G) |
|---|---|---|
| **Brain** | "you can't know which model ran" | **0G Compute TEE attestation** — the inference call returns a verifiable *"this exact model ran in a hardware enclave"* verdict. *Built + offline-tested (`agent/src/zerog/compute.ts`); the verdict is `attested:true` only when a `trusted` service attestation AND a verified per-response enclave signature both hold — never the model's own words. The live broker call is operator-gated (a funded 0G Compute sub-account + a TEE provider), so at MVP the stamp stays **PENDING** until one live verified attestation (§9 Depth).* |
| **Rails** | "the agent could overspend" | an on-chain **MandateRegistry** — `checkTransfer()` rejects any spend over the cap, **before broadcast**, as a zero-gas `eth_call` |
| **Settlement** | "the dashboard could be lying" | an **independent Rust verifier** reads 0G via raw JSON-RPC and stamps each trade `settled / hollow / mismatch / unverified` — it never trusts the UI |

**The NEG case (the proof that the proof is real).** Point the verifier at a *fabricated* transaction hash → it stamps **`UNVERIFIED`**. The verifier isn't rubber-stamping; it is reading the chain. This is the single most convincing 30-second clip.

---

## 3. Design principles — the invariants that make "can't lie" real

These are structural guarantees, not slogans:

1. **Two-source truth.** The agent's report of an action is a **Claim** (never trusted). The verifier's independent on-chain read is the **Observation**. The verdict is `adjudicate(Claim, Observation)` — the agent's word is only ever *one* input, checked against the chain.
2. **Verdict monopoly.** Only the verifier mints a verdict (`settled / hollow / mismatch / unverified`). The agent, the LLM, and the web UI produce *claims and facts* — never a verdict. The verdict type's constructor is private to the verifier crate.
3. **Never fabricate.** An unavailable, off-record, or unreadable result degrades **loudly** to `UNVERIFIED` — never silently to a fabricated `SETTLED`. (The NEG case is this rule, on screen.)
4. **Deterministic.** The same chain reads always produce the same verdict and the same reproducibility digest — anyone can re-run a verdict and get a byte-identical result. No wall-clock, no unordered state.
5. **Exact-integer money.** Amounts are compared in minor units with exact-integer tolerance bands — **no floating point** on the money path.
6. **Clean-room boundary.** The repo is self-contained and MIT-licensed; it talks to 0G **only** through 0G's public SDKs. An automated **clean-room firewall** (§7) keeps it free of any proprietary identifier, private filesystem path, or secret.

These six invariants are referenced throughout as `design §3 #1`…`#6`; every wow leg, cross-chain hop, and money-safety guard below reuses them unchanged — it adds **no new trust surface**.

---

## 4. Architecture

```text
proofagent-0g/                  (MIT · fully public · talks to 0G only via public SDKs)
├─ docs/PROOFAGENT_0G_DESIGN.md  this document
├─ README.md                     the pitch + 2-min demo script + the three-proofs diagram
├─ LICENSE                       MIT
├─ .env.example                  documented knobs — NO secrets, NO real keys
├─ .gitignore                    env, keys, build artifacts
├─ proofagent.toml               data spine — chain, RPC (via env), corpus, registry address, checks,
│                                  the [[connector]] manifest, [gas_floor]/[net_worth_floor] knobs
├─ verifier/                     independent Rust verifier — the differentiator
│   └─ src/                        verify-tx + chain-read (raw eth_getTransactionReceipt / eth_call)
│                                  → settled / hollow / mismatch / unverified  (deterministic)
│                                  + the swap/route/bridge verdict extensions, the unified connector
│                                  settlement entry, and the gas-floor / net-worth / timelock confirmations
├─ contracts/
│   ├─ src/MandateRegistry.sol     per-tx cap · per-asset sub-caps · allowlist · expiry  (the MVP "rails")
│   ├─ src/MandateRegistryV3.sol   the four-tier production spend gate (§10.4)
│   ├─ src/MandateRegistryV4.sol   the consolidated, hardened mandate — folds V3 + TimelockGuard into one (§10.4b)
│   ├─ src/TimelockGuard.sol       the value-tiered outbound time-lock + per-spoke caps (§11.2/§11.3)
│   └─ script/Deploy*.s.sol        Foundry deploy + a 0G broadcast
├─ agent/src/zerog/              DIRECT calls to 0G public SDKs (the Depth/Wow legs)
│   ├─ compute.ts                  [BUILT · Depth] TEE inference: service-attest → infer → verify
│   │                                response signature; attestInference → BrainVerdict{attested}.
│   │                                Live broker call OPERATOR-GATED (funded sub-account + TEE provider)
│   └─ storage.ts                  [NOT BUILT · Wow] verdict-bundle storage: upload(bytes) → rootHash
├─ agent/                        minimal autonomous loop  (TS package; sources under agent/src/)
│   └─ src/
│       ├─ plan.ts                 LLM: query → { chain, allocations }
│       ├─ mandate.ts              eth_call checkTransfer(agent, token, amount) — pre-broadcast gate
│       ├─ execute.ts              a single capped swap on 0G
│       ├─ gasfloor.ts             the pre-broadcast "can't deplete gas" kill-switch (§12.1)
│       ├─ connector.ts            the five-method ExecutionConnector seam (§10.5)
│       ├─ gateway.ts              the protocol-agnostic gateway (priced fallback + value_moved) (§10.5)
│       ├─ adapters/               swap_adapter · route_adapter · bridge_adapter (§10.5)
│       ├─ swap.ts · route.ts · bridge.ts   the proven wow legs (§10.1/§10.2/§10.3)
│       └─ loop.ts                 plan → mandate-gate → execute → verify
└─ web/                          thin demo UI (TS package; sources under web/src/): the three
                                  "provable" stamps + the NEG case
```

> **Bracket note (§9, "claim only what's live").** The `zerog/` Depth/Wow legs are honestly-bracketed.
> **`compute.ts`** (0G Compute TEE inference, the **Depth** bracket) is now **built + offline-tested** as an
> original clean-room implementation on the public `@0glabs/0g-serving-broker` SDK — it lives in the agent at
> `agent/src/zerog/{compute,types}.ts` (the agent is already Node, so it calls the public SDK directly; no
> bridge). Its `attested:true` verdict requires a real enclave proof, and the **live broker call is
> operator-gated** (a funded 0G Compute sub-account + a TEE provider), so the default offline build keeps the
> web brain stamp at `PENDING / Phase-2` (never green) until one live verified attestation lifts it.
> **`storage.ts`** (publishing the verdict bundle to 0G Storage, the **Wow** bracket) is **not built**. The
> `agent/` and `web/` TypeScript packages keep their sources under a conventional `src/` subdirectory
> (`agent/src/plan.ts`, `agent/src/zerog/compute.ts`, …); the paths above name the modules, not a flat layout.

**Module responsibilities**
- **`verifier/`** — the "agent can't lie" engine. Reads 0G independently; never trusts the app UI. Carries a corpus of real, already-settled transactions so the demo verifies genuine settlements. Hosts the swap/route/bridge verdict extensions, the unified connector-settlement entry (§10.5), and the gas-floor / net-worth / timelock confirmations (§11–§12).
- **`contracts/`** — the "agent can't overspend" engine. The cap is enforced on-chain; the UI links to the public explorer so viewers confirm it themselves. Hosts the MVP `MandateRegistry`, the four-tier `MandateRegistryV3` (§10.4), the `TimelockGuard` (§11), and the consolidated, hardened `MandateRegistryV4` (§10.4b — folds the MVP registry + V3 + `TimelockGuard` into one).
- **`zerog/`** — the 0G-native depth: TEE-verified inference + auditable storage, both on public SDKs. The TEE-inference leg (`compute.ts`) is the §9 *Depth* bracket and is **built + offline-tested** as an original clean-room implementation on 0G's public `@0glabs/0g-serving-broker` SDK — the agent-side seam (`AttestationProvider`), the `attestInference` verdict, the TTL service-attestation allowlist, and the settle-window retry. Its `attested:true` verdict needs a real enclave proof, and the **live broker call is operator-gated** (a funded 0G Compute sub-account + a TEE provider), so the default offline build keeps the brain **PENDING** until one live verified attestation is on screen. `storage.ts` (publishing the verdict bundle to 0G Storage) is the §9 *Wow* leg and is **not built** (the verifier emits its report in-process only). **[Bracket-delta]**: the live attestation flip is operator-gated, not MVP-default.
- **`agent/`** — a small, readable loop that plans, gates against the mandate, executes, and asks the verifier for a verdict. The Engine (§10.5) gives it one protocol-agnostic entrypoint over every wow leg.
- **`web/`** — one screen, three green stamps (brain / rails / settlement) + the fabricated-hash → `UNVERIFIED` moment.

---

## 5. The loop

```text
plan ──► mandate-gate ──► execute ──► verify
 │            │              │           │
 LLM      eth_call       capped swap   independent
 plan     checkTransfer   on 0G        chain read → verdict
          (block if over cap, pre-broadcast)
```

A failing mandate verdict means **the agent does not execute** — the cap is a kill-switch, enforced before any broadcast. A failing settlement read means **`UNVERIFIED`**, surfaced loudly — never a fabricated success.

The wow widens the **action** (swap → route → bridge) and **deepens the mandate** (one per-tx cap → the four-tier gate), but the loop's shape is invariant: every leg is `mandate-gate → execute → verify`, and the Engine (§10.5) makes that loop **protocol-agnostic** — the agent expresses one intent, the gateway picks/prices/gates/dispatches, and the verifier still holds the sole verdict.

**The dry-run is on screen too (the "Run the agent (dry-run)" card).** The Verification Console
(`web/dashboard.html`) drives this exact loop READ-ONLY — **NO wallet, NO signing, NOTHING broadcast** — as a
*"Run the agent (dry-run)"* affordance (`web/src/dryrun.ts` + `dryrunView.ts`), the in-page twin of the
agent's own dry-run loop (`agent/src/loop.ts`, `ExecuteMode.DRY_RUN`, which broadcasts nothing). It (1)
**plans** three demo intents that exercise the mandate **per asset** — an under-cap trade on an allowlisted
asset, an over-cap trade on the same asset, and a trade on a **non-allowlisted** asset; (2) **gates each PER
ASSET** with a real read-only `checkTransfer(agent, token, amount)` `eth_call` against the deployed registry
(reusing the RAILS leg's `checkTransfer` codec, no copy), so the *same* agent gets a *different* decision per
asset — `OK` (allowed) · `OVER_TX_CAP`/`OVER_ASSET_CAP` (over the per-asset cap) · `TOKEN_NOT_ALLOWED`
(non-allowlisted) — each reconciled against an independent re-read; and (3) derives the **verifier verdict
that would settle** — `unverified` for every leg, because a dry-run broadcasts nothing so there is no
observation (the keystone, never a fabricated `settled`). The **RESULT is a RUN LEDGER** in the verifier's
OWN journal/ledger format (§6) — one canonical JSONL record per leg + the `LedgerSummary::status_line()`
projection — so a judge sees the **identical artifact** a real `verifier verify-tx … --journal` + `verifier
ledger` run produces. It is labelled a dry-run, it mints no verdict, and it can never reach a green
`settled` — exactly the honesty doctrine (§3 #2/#3, §13), made visible on a single click.

**The RAILS card is the mandate, read straight from chain (the deployed-registry mirror).** On the
Verification Console the **RAILS card is expanded into a READ-ONLY mirror of the deployed mandate registry**
(`web/src/mandateCard.ts`) — still **one of the four** proof cards, not a fifth. It reuses the RAILS leg's own
read-only `checkTransfer` codec (`runRailsCheck` / `runMandateCheck` / `decodeCheckTransfer` over the
`RpcTransport` seam, no copy, no new broadcast surface) and lays out: a **header** with a **0G monogram chain
badge** (0G has no branded glyph) + a tri-state **RECONCILED-vs-deployed pill** — the on-chain read is the
**baseline**, so the card's stated config is reconciled against what `checkTransfer` actually answers on-chain
(the two-source doctrine, §3 #1: `Reconciled` green / `Drifted` loud-red / `Unverified` grey, never a faked
green); a **global period-cap bar** carrying the consolidated `MandateRegistryV4` (§10.4b) rolling-window cap,
shown as the **V4 spec, built-not-deployed** (its deploy is operator-gated; `[mandate_v4].address=""`) and
labelled so — never a live-enforced number (§8 claim only what's live); a **per-asset table** (state dot ·
symbol · truncated address · decimals · per-tx cap; a non-allowlisted asset greyed with a `—`, capped-scroll);
and a **wallet-free `checkTransfer` simulator** (asset dropdown + amount → a real zero-gas `eth_call` → a
tri-state **`ALLOWED` / `BLOCKED` / `UNVERIFIED`** verdict naming the binding on-chain reason — no wallet, no
broadcast; a usage error mints no verdict; an unreachable RPC is `UNVERIFIED`, never a faked allow). The chain
is threaded as one `{chainId, registryAddress}` **context object** (`MANDATE_CARD` in `web/src/spine.ts`), so
bringing the consolidated V4 registry live is a **data change** (repoint the context), not a redesign;
by-chain is the **single 0G badge** only — one enforcement chain, proven by `scripts/0g_only_gate.ps1` — with
deliberately **no chain selector**. Footer: *"Read independently from chain — not the agent's UI."*

---

## 6. The settlement-truth LEDGER — the journal, the projection, the audit

The verifier's verdict is worthless if it can be quietly overwritten or contradicted by the UI. So the
verdict is **journalled**, and the ledger is read *only from that journal* — never from the agent's report
and never from the dashboard. **The ledger IS the settlement truth.**

- **Journal (append-only, deterministic, redacted).** Every verdict the verifier mints is appended as one
  canonical record to a verdict **journal**. A record carries exactly the fields needed to *reproduce and
  audit* the verdict — the canonical `0x` hash, the trade kind, the claimed minor-units, the
  independently-observed minor-units (or an explicit *unavailable*), the `recorded` flag, and the verdict
  string — and **nothing else**: no wall-clock, no home filesystem path, no key, no secret (design §3 #4
  deterministic, §7 clean-room). Append-only means history is never rewritten; a later run adds rows, it
  never edits or deletes one. The record is emitted by the same verdict monopoly that mints the verdict
  (design §3 #2), so a journal row can only exist because the verifier minted it.

- **`ledger` — the read-only projection.** `proofagent ledger` reads the journal and projects it, per
  transaction: **claimed vs chain-observed** minor units, the **verdict**, and the exact-integer **delta**
  (`claimed − observed`, or *unavailable* when the chain could not be read). It computes nothing new and
  mints no verdict — it is a pure, deterministic *view* of the journalled truth, in journal order. Summary
  counts (per verdict) and a one-line status-at-a-glance accompany the table.

- **`audit` — the loud surface.** `proofagent audit` reads the same journal and surfaces every
  **non-`settled`** verdict — `hollow` / `mismatch` / `unverified` — **LOUDLY**, with a non-zero exit when
  any are present (design §3 #3, never fabricate; §13, a defect is surfaced loud, never silently counted as
  success). A clean journal (every row `settled`) audits GREEN with a zero exit. The audit never *heals* a
  row and never downgrades a defect to success — it only reports.

- **`LEDGER.md` — the human artifact.** The committed `LEDGER.md` is regenerated from the journal in the
  settlement-truth format: **§1** an on-chain-truth table (Date · Chain · Kind · Token · Amount · Verdict ·
  Settlement-link), **§2** summary counts + status-at-a-glance, **§3** the agent's *claims* kept strictly
  separate from the §1 chain truth — the agent's word is a claim, never an entry in the truth table until
  the chain confirms it (design §3 #1, two-source truth).

The ledger/audit add **no** new trust surface: they read the journal the verifier already wrote, and the
journal can only contain verdicts the verifier already minted. Two-source truth (design §3 #1) is preserved
end to end — the agent's claim and the verifier's observation enter by different doors, meet only in
`adjudicate`, and the journal records both alongside the minted verdict so anyone can re-derive it.

---

## 7. Clean-room & IP discipline — the gate

This repo is a **clean-room implementation**: self-contained, MIT-licensed, and built entirely against 0G's **public** SDKs. It contains **no proprietary framework code, no internal identifiers, no private filesystem paths, and no secrets**.

This is enforced, not promised:

- **An automated clean-room firewall** scans every tracked file before any commit or push and **fails (RED)** on any proprietary identifier, private path, or secret pattern. A leak blocks the commit — it is a deterministic gate, not a reviewer's judgement.
- **A self-enforcing 0G-only gate** parses the data spine and asserts the entire **live** surface is on 0G (Aristotle `16661` / Galileo `16602`) — every deployed-contract chain id, every venue, every `[[connector]]` `chains` array — and **fails (RED)** on any non-0G chain id / RPC / explorer that has leaked into the live surface. Cross-chain spoke selectors and the §11.4 roadmap hardenings are allowed strictly as **documented roadmap**, never claimed live — and this gate proves they stay roadmap.
- **Secret hygiene** — `.gitignore` is authored before the first commit; a fresh demo wallet is used; environment is documented via `.env.example` with no real values; nothing sensitive is ever committed.
- **Demo against already-public settlements** — the verifier's corpus is real, already-settled on-chain transactions (each confirmable on the public explorer), so the demo never requires minting fresh live settlements under time pressure.

> The clean-room firewall and its denylist are maintained **outside this repository** so that this repository names nothing it is meant to exclude. This file, and every file here, is written to pass that gate. The 0G-only gate, by contrast, names only public 0G chain ids + public chain names, so it lives **inside** the public repo (`scripts/0g_only_gate.ps1`).

---

## 8. The verification-trio — the moat, in one frame

§2 names the three claims ProofAgent kills *about a given action*. Stepping back, those proofs rest on **three complementary, independently-useful verifications** — and the moat is that ProofAgent ships all three together. Each is a **standalone primitive** (useful on its own, in any agent stack); together they are *an agent you can trust with money*: you don't trust the agent, you **verify the code**, **bound the spend**, and **prove the settlement** — three different doors, three different sources of truth, no single point a lie can pass through.

| Verification | The question it answers | The primitive | Mapped to (existing components) |
|---|---|---|---|
| **Verify the code** | "is the artifact what it claims to be — clean, self-contained, and gated before it is trusted?" | a deterministic gate, not a reviewer's opinion | the **clean-room firewall** (the out-of-tree scanner that fails RED on any proprietary identifier / private path / secret, §7) **+ the zero-defect gate** (cargo build · clippy · forge test · tsc · tests · clean-room firewall — plus the money-critical boot check that a new adapter cannot pass without naming a gate — `docs/ADD_AN_ADAPTER.md`) |
| **Bound the spend** | "what *structurally* stops a buggy or hijacked agent from overspending?" | a pre-broadcast, on-chain, fail-closed spend gate | the **on-chain `MandateRegistry`** (`checkTransfer` as a zero-gas `eth_call` *before* broadcast, §2 Rails) **→ the four-tier production gate** (period cap · expiry + spender-allowlist · asset/USD/pause · atomic gate+accrue — §10.4), each tier independently verifier-confirmed |
| **Prove the settlement** | "did the money actually move — or is the dashboard lying?" | an independent reader that never self-reports | the **independent Rust verifier** (raw JSON-RPC reads → `settled / hollow / mismatch / unverified`, §2 Settlement) — the verdict monopoly (§3 #2), journalled into the settlement-truth LEDGER (§6), generalized over swap / route / bridge through one unified entry (§10.5) |

Read top-to-bottom they compose into the lifecycle: **verify the code** before it runs, **bound the spend** before it broadcasts, **prove the settlement** after it lands — defense in depth, where each layer is meaningful even if you only adopt that one. Read as primitives they are reusable apart: the clean-room firewall + the zero-defect gate guard *any* repo, the mandate gate bounds *any* on-chain agent, and the verifier proves *any* settlement — `claim only what's live`, never self-reported. The three invariants of §3 (two-source truth, the verdict monopoly, never-fabricate) are what keep each verification honest end to end.

---

## 9. Build roadmap — bracket-layered, claim only what's live

The build is layered so a small, honest MVP ships first and depth is added in clearly-labelled increments. **Every capability is claimed only once it is live on screen** — additions are labelled as build-deltas, never pre-claimed.

- **MVP** — `verify-tx → SETTLED` against the on-chain corpus; the on-chain mandate cap, clickable on the explorer; the agent loop (plan → mandate-gate → execute → verify); the thin UI with the **NEG case → `UNVERIFIED`**. The default brain is the deterministic offline planner stub (honestly labelled `brain: "stub"`); the **Depth** TEE leg is built behind the same seam but the web brain stamp stays `PENDING` until a live attestation lifts it.
- **Depth** — **0G Compute TEE inference** — *built + offline-tested* (`agent/src/zerog/compute.ts`, an original clean-room implementation on the public `@0glabs/0g-serving-broker` SDK): the `attestInference` verdict, the TTL service-attestation allowlist, and the settle-window retry, all driven offline by a stub double. It surfaces a real green "brain" verdict on screen ONLY when a live verified attestation backs it (`attested === true`); the live broker call is **operator-gated** (a funded 0G Compute sub-account + a TEE provider), so the MVP default stays PENDING.
- **Wow** — the **wow features** (§10): scale the action (swap → route → bridge) and deepen the mandate (the four-tier `MandateRegistryV3`), then collapse them behind the **Engine**; publish the verifier's verdict bundle to **0G Storage** (independent proof that itself lives on 0G); a shareable companion/arena skin; mint the agent as an on-chain Agentic ID.

> **The wow is the *proof*, not the DeFi.** The MVP proves the pattern — *one capped action, independently
> verified*. The wow scales the **action** (swap → route → bridge) while every leg stays **mandate-gated +
> verifier-confirmed**. The pitch: **proven 0G execution + verifiable safety.** ProofAgent never reproduces
> a trading planner / strategy / portfolio — it does the *minimal* action and **proves** it, against
> **public** protocol SDKs only (the clean-room firewall enforces it).

**Why this is not a copy.** ProofAgent and a 0G trading agent both "touch" swap/route/bridge, but they are **different artifacts**: a trading agent **executes DeFi to make money** — planner, strategy, portfolio (that is its IP); ProofAgent **proves any action is bounded + settled** — a generic safety envelope. ProofAgent is **Rust**, reads the chain **independently via raw RPC** (shares no execution code), calls **public** protocol SDKs directly, and keeps the action **minimal and generic** — the value is the **verdict, not the trade**.

---

## 10. Wow features — scaling the action, deepening the mandate

Each feature ships inside the same envelope — an on-chain **mandate gate** (`checkTransfer`, a pre-action precondition) + an **independent verifier** (reads the chain directly, stamps each leg `settled / hollow / mismatch / unverified`). Canonical chain IDs (0G docs): **mainnet Aristotle = 16661**, **testnet Galileo = 16602**. Explorers: `chainscan.0g.ai` (mainnet) · `chainscan-galileo.0g.ai` (testnet).

| Feature | Public method | SDK / key contracts | Testnet | Effort | Phase |
|---|---|---|---|---|---|
| **Swap** (§10.1) | Uniswap-V3 exact-input single-hop via Oku (`approve → exactInputSingle`, on-chain `amountOutMinimum` floor) | SwapRouter02 `0x807F4E28…dE40` · QuoterV2 `0xaa52bB81…CA455` · V3 Factory `0xcb243677…7A9D` · `@uniswap/v3-sdk` | **No** (mainnet-only) | M | depth |
| **Routing** (§10.2) | intent + aggregated: Khalani · LI.FI · JAINE native AMM · w0G/CCIP | Khalani REST `api.hyperstream.dev` + `@arcadia-network/sdk` · `@lifi/sdk` (0G key `zerog`) · JAINE V3 router | **Partial** (JAINE same-chain on 16602) | S–L | wow |
| **Bridge-in** (§10.3) | CCIP lock-and-mint via XSwap (Ethereum → 0G, USDC → USDC.E); Base→0G is two-hop | `IRouterClient.ccipSend` + `Client.EVM2AnyMessage` · XSwap XPay REST · USDC.E `0x1f3aa822…473e` · 0G selector `4426351306075016396` | **No** (Galileo CCIP decommissioned) | L | wow |
| **Bridge-out** (§10.3) | egress via CCIP: USDC.E burn → USDC (Ethereum only); w0G CCT direct to Eth/Arb/Base/BNB; USDC.E→Base/Arb two-hop | 0G Router `0x0aA145…f755` · USDC.E burnMint pool `0x0A3d…83CA` · w0G lockRelease pool `0xF683…9187` · dest selectors | **No** (Galileo CCIP decommissioned) | S–M | wow |
| **Mandate V3** (§10.4) | four-tier on-chain spend gate: period cap · expiry + spender-allowlist · USD-cap + pause + bounded lists · atomic gate+accrue | fresh Solidity on the v2 `checkTransfer(agent,token,amount)→(ok,reason)` shape + a price-feed interface + a `canTransfer`-style gate | **Yes** (deploy on 16602) | M | wow |
| **The Engine** (§10.5) | one bounded `ExecutionConnector` contract + a protocol-agnostic gateway + a unified verifier settlement entry | `agent/src/connector.ts` + `gateway.ts` + `adapters/*` + `verifier/src/connector.rs` | n/a (refactor) | M | wow |

### 10.1 Swap (Oku / Uniswap-V3) — *depth*

A standard Uniswap-V3 exact-input single-hop swap through Oku's deployment of the canonical Uniswap-V3 periphery on 0G mainnet — the underlying contracts *are* the audited Uniswap-V3 core+periphery.

**Path:** (1) confirm the pool via `UniswapV3Factory.getPool(tokenIn, tokenOut, fee)` ≠ `0x0` (try `fee=10000`/1%, fallback `3000`) — resolve token + pool at runtime, don't hard-code; (2) `QuoterV2.quoteExactInputSingle(...)` staticCall → `expectedOut`; (3) `amountOutMinimum = expectedOut * (1 - slippageBps)`; (4) `tokenIn.approve(SwapRouter02, amountIn)`; (5) `SwapRouter02.exactInputSingle({tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0})`; (6) parse `amountOut` / the `Swap` event.
**Footgun:** SwapRouter02's `ExactInputSingleParams` has **no `deadline`** (7 fields, not 8).

| Contract (16661) | Address |
|---|---|
| SwapRouter02 | `0x807F4E281B7A3B324825C64ca53c69F0b418dE40` |
| QuoterV2 | `0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455` |
| V3 Core Factory | `0xcb2436774C3e191c85056d248EF4260ce5f27A9D` |
| NonfungiblePositionManager | `0x743E03cceB4af2efA3CC76838f6E8B50B63F184c` |
| Universal Router | `0x1b35fbA9357fD9bda7ed0429C8BbAbe1e8CC88fc` |
| Permit2 | `0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2` |

SDKs: canonical `@uniswap/v3-sdk` / `@uniswap/sdk-core` / `swap-router-contracts` ABIs, pointed at the 0G RPC — they work unchanged.

**Wrapped by the proofs:** before `exactInputSingle`, `checkTransfer` must clear `tokenIn`/`amountIn`/recipient (asset allowlist, per-trade cap, expiry) or the leg is refused *pre-broadcast*; the Uniswap `amountOutMinimum` floor is the protocol-native complement (input mandate-bounded, output slippage-bounded, both on-chain). After broadcast the verifier reads 0G directly, decodes the `Swap` event + realized deltas, and mints **settled / hollow / mismatch / unverified** — never the front-end's word.

### 10.2 Routing (Khalani / LI.FI / JAINE / CCIP) — *wow*

Four live rails: **Khalani** (decentralized solver/intent — publish one intent, atomic settle-or-refund; powers "0G Pay"), **JAINE** (native 0G Uniswap-V3-style CLMM at `hub.0g.ai/swap`), **LI.FI** (cross-chain + DEX aggregation; 0G is a first-class registry chain), **w0G via Chainlink CCIP**.

- **Khalani (intent):** REST `api.hyperstream.dev` — `GET /v1/chains|tokens` → `POST /v1/quotes` → `POST /v1/deposit/build` → `PUT /v1/deposit/submit` → `GET /v1/orders/{addr}` (`deposited → filled` | `refund_pending → refunded`); on-chain `IntentBook.publishIntent` / `@arcadia-network/sdk`.
- **LI.FI (aggregation):** `@lifi/sdk` or REST `GET /v1/quote` (`toChain=16661`) → sign the `transactionRequest` → `GET /v1/status`. multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` is on 0G.
- **JAINE (native AMM):** same-chain 0G swaps via the standard V3 quoter+router ABI. Caveat: no documented audit, thin TVL — bound slippage/route quality.

**Wrapped by the proofs:** every leg is bounded *before* it fires (`checkTransfer` per leg — cap, allow-listed asset/route, recipient), composing with Khalani's own "funds never move if constraints unmet" as defense-in-depth. After settlement the verifier reads 0G directly (never the aggregator API) and mints one verdict per leg — for Khalani it treats `refunded` as a **non-settlement terminal state** (mandate-safe) and only `filled`-with-matching-on-chain-transfer as `settled`; it catches API false-`filled` (hollow) and slippage/wrong-asset/refund-as-fill (mismatch). A multi-leg route is **settled IFF every leg settled**.

### 10.3 Bridge (XSwap / Chainlink CCIP) — bridge-in / bridge-out — *wow*

0G's official canonical bridge is **XSwap**, powered by **Chainlink CCIP**.

**Bridge-IN (Ethereum → 0G, USDC → USDC.E).** A non-CCTP lock-and-mint lane (lock native USDC on Ethereum → mint **USDC.E** `0x1f3aa82227281ca364bfb3d253b0f1af1da6473e` on 0G, 1:1). **Base→0G is two-hop** (Base→Ethereum then Ethereum→0G). Path: (1) resolve the 0G Router + onRamp live from the CCIP directory → 0g-mainnet (don't hard-code); (2) `approve(Router, amount)` USDC → build `Client.EVM2AnyMessage{receiver, tokenAmounts=[{USDC, amount}], extraArgs, feeToken}` → `getFee()` → `IRouterClient.ccipSend(4426351306075016396, message)` (0G selector); (3) poll for the `messageId` → USDC.E mints on 0G.

**Bridge-OUT (0G → other chains) — the egress leg, the highest-value verification showcase.** Bridge-OUT is the mirror of bridge-IN: instead of locking value on a remote chain to mint it on 0G, you **burn/lock on 0G and release on the destination**. Three lanes ride out of 0G mainnet (chainId **16661**, CCIP selector **4426351306075016396**), all on **Chainlink CCIP** via XSwap:

- **USDC.E burn → USDC release.** Burn bridged USDC.E (`0x1f3AA82…473E`, burnMint pool on 0G) → **native USDC** minted on **Ethereum** via Circle CCTP. Single destination: **0G → Ethereum only.**
- **w0G CCT egress.** Lock native 0G in the w0G lockRelease pool (`0xF6839B31…9187`) → mint w0G (`0x1Cd0690f…109c`) on the destination via burnMint. **Direct lanes** to Ethereum, Arbitrum One, Base, BNB, Monad, and Solana — no intermediate hop.
- **Multi-hop to Base/Arb via Ethereum.** For USDC.E there is no direct lane off 0G except to Ethereum, so 0G → Base/Arbitrum is a **two-hop journey**: `0G → Ethereum` (CCTP), then a second independent CCIP transfer `Ethereum → {Base 8453 / Arbitrum 42161}`.

| Contract / selector | Value |
| --- | --- |
| 0G CCIP Router | `0x0aA145a62153190B8f0D3cA00c441e451529f755` |
| TokenAdminRegistry | `0x051665f2455116e929b9972c36d23070F5054Ce0` |
| USDC.E (0G) token / burnMint pool | `0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E` / `0x0A3d8eD619ECF1E984488710eB2cEcE4FDbd83CA` |
| W0G (0G) token / lockRelease pool | `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c` / `0xF6839B313671daE8c1B6AbCaB4eBd0bF41259187` |
| Dest selectors | Ethereum `5009297550715157269` · Arbitrum `4949039107694359620` · Base `15971525489660198786` · BNB `11344663589394136015` |
| Entrypoint | `IRouterClient.ccipSend(destSelector, EVM2AnyMessage)` |

**Fees / finality / limits.** Fees are paid **once on the source chain** — **overpaying `msg.value` above `getFee` is NOT refunded; quote first**; each extra hop charges its own fee. Delivery is **asynchronous** (the DON waits for source finality, then commits + executes — minutes-scale). Each pool enforces a per-lane **outbound rate limit** (token bucket); a drained bucket **reverts**, so large withdrawals throttle or split.

**Testnet caveat.** 0G Galileo testnet (16602) is **not in the CCIP directory** — its lane is decommissioned. **No testnet rehearsal**; egress runs only on mainnet (16661) — validate with minimal real value, operator-gated.

**Wrapped by the proofs — egress is the kill-shot.** Egress is exactly where value gets stuck or lost: ingress mints into a chain we already watch, but egress **burns on 0G and depends on a remote chain we don't control.** The kill-shot is **hollow-egress** — *burned-on-0G but nothing-released-on-destination*. CCIP delivery is **not always automatic**: when auto-exec fails (destination `releaseOrMint` over its gas budget, the receiver reverts, or a rate-limit bucket is drained), the message sits **Ready-for-manual-execution / FAILURE** with **zero tokens released** — while the source tx is confirmed and a naive UI shows "done." The verifier **never trusts that UI**: for **every hop** it reads **both legs** independently — the source `ccipSend`/burn event (`chainscan.0g.ai`) and the destination OffRamp `ExecutionStateChanged == SUCCESS` (destination explorer **and** the CCIP Explorer status for that `messageId`) — and stamps a **per-hop** verdict: **settled** (both legs present, released amount in tolerance), **hollow** (source burned, destination empty → **LOUD**, heal = manually execute the pending message at the OffRamp), **mismatch** (destination SUCCESS but amount short), or **unverified** (a leg not yet readable). A multi-hop journey is **settled only if every hop is independently settled** — hop-1 on Ethereum says nothing about hop-2 to Base. Ahead of the burn the **mandate bounds the egress pre-send**: it pins the asset, pins the expected `destChainSelector` (never the decommissioned testnet lane), enforces the cap against current rate-limit headroom, and confirms the `feeToken` is funded — so **the safest egress failure is the one that never burns on 0G.**

### 10.4 Production mandate: the four-tier spend gate — *wow*

The MVP mandate is a single per-tx cap (the "rails" proof). The production wow is a **four-tier on-chain spend gate** — each tier closes a real attack the basic cap misses, and **each tier is independently verifier-confirmed**. Same v2-compatible `checkTransfer(agent, token, amount) → (ok, reason)` zero-gas view; fail-closed; reason codes evaluated in a fixed, documented precedence order.

| Tier | Control | The attack it closes | The verifier's added proof |
|---|---|---|---|
| **1 — Period cap** | cumulative per-window cap (rollover accumulator; `recordSpend` / `gateAndRecord`) | **looping** small in-cap trades to drain past the per-tx ceiling | sums the window's settled spends → flags a breach the per-tx gate would miss |
| **2 — Time + destination** | enforced expiry (real time-box) · spender/router **allowlist** (`checkTransferTo`) · owner-gated delegation | no time-box · sending anywhere · re-delegating a lapsed mandate | confirms the destination was allow-listed + the mandate unexpired |
| **3 — Asset / USD / pause** | per-asset sub-caps · **pause kill-switch** (global + per-agent) · **USD-denominated cap** (price feed, opt-in, fail-closed) · bounded lists (≤16) | flat raw cap · no emergency stop · token-price moves defeat a raw-unit cap · gas-DoS via unbounded lists | prices the spend in USD + confirms the cap held; confirms a paused agent's tx is blocked |
| **4 — Atomic gate+accrue** | per-destination "sandbox" caps (a min that only tightens) · **atomic `gateAndRecord`** (gate AND accrue in one fail-closed call) | low-trust destinations sharing the full cap · the **advisory-recordSpend / TOCTOU double-spend gap** | confirms the accrual matched the spend atomically — no time-of-check/time-of-use drift |

`checkTransfer` returns the **first** failing reason in a fixed precedence order (deterministic, design §3 #4): `PAUSED > AGENT_PAUSED > EXPIRED > NOT_AGENT > ZERO_AMOUNT > TOKEN_NOT_ALLOWED > SPENDER_NOT_ALLOWED > OVER_TX_CAP > OVER_ASSET_CAP > OVER_DEST_CAP > OVER_PERIOD_CAP > {PRICE_UNAVAILABLE | OVER_USD_CAP}`.

Optionally a **human-authorization proof** (a World-ID-style nullifier) binds the mandate to a real human (sybil resistance). Unlike the DeFi legs, the mandate is **your own contract** → fully **deployable + demoable on testnet (16602)** at $0. The verifier's `confirm_tier` adjudicates each tier's live `(ok, reason)` read against an `ExpectedGate` and mints a per-tier `TierVerdict` through the same `Verdict` monopoly.

**Why this is the killer "can't overspend" wow.** The MVP proves *one cap held*; the production gate proves the agent is bounded against **looping-drain, destination abuse, price-volatility, no-emergency-stop, and TOCTOU double-spend** — and the verifier confirms **each tier on-chain**, so "can't overspend" becomes a multi-attack guarantee, not a single number. Clean-room: fresh Solidity on the public `checkTransfer` shape + a public price-feed interface + a `canTransfer`-style token-gate standard; no proprietary framework.

### 10.4b The consolidated, hardened mandate — `MandateRegistryV4` (the single best-in-class gate)

The four-tier gate (§10.4) and the value-tiered outbound time-lock (§11.2) proved their pieces independently. The **consolidated mandate** folds the MVP `MandateRegistry`, the four-tier `MandateRegistryV3`, and the separate `TimelockGuard` into **ONE self-contained `MandateRegistryV4`** — `contracts/src/MandateRegistryV4.sol` — with the hardened, best-in-class feature set distilled from a **nine-lens adversarial review** (TOCTOU/double-spend · asset/value-confusion · gas-grief/unbounded-work · governance-bypass). It keeps the **same v2-compatible `checkTransfer` / `checkTransferTo` selectors byte-identical** (`0xcc1dd94f` / `0x697bb97c`), so every existing reader works unchanged; the hardening is additive, off by default, except for a handful of deliberate correctness fixes.

**The honest money-safety model — ADVISORY + verifier-enforced + NON-CUSTODIAL.** The contract **holds no funds** (no custody, no escrow — consistent with the §11.4 no-shared-pool philosophy). It is the on-chain **source-of-truth for the caps**, read by the agent gateway as a zero-gas `eth_call` *before* it broadcasts, and accrued atomically by the agent via `gateAndRecord`. The off-chain gateway **ENFORCES** by refusing an over-cap action **PRE-broadcast** (a fail-closed kill-switch, never shadow-only); the independent verifier **CATCHES** any violation **LOUD** (it reads the gate itself, two-source). The **honest claim everywhere** is therefore: *"the agent can't overspend — the mandate blocks it pre-broadcast and the verifier proves it"*, **NEVER** *"physically can't overspend"* (a non-custodial contract cannot physically stop a hijacked key that ignores the gate; it makes such a spend **provably out-of-mandate and instantly catchable**). The backing invariant is the **spend reconciler** (`verifier/src/reconciler.rs`, the named system invariant I14-R): it pairs every `SpendRecorded(spendId, …)` accrual **1:1** against the on-chain `Transfer` the verifier reads — **a transfer with no matching record is the dangerous unbounded spend** → a LOUD `refuted`, never a fabricated `reconciled`.

**The hardened feature set (each closes a confirmed adversarial finding):**

- **Per-tx cap** — one call cannot drain in a single shot.
- **Rolling-period limiter — LEAKY BUCKET, overflow-safe refill** + a **tx-count leaky bucket** — closes salami/looping-drain AND the calendar-window boundary doubling. **HONEST BOUND (the corrected claim):** a leaky bucket bounds the *instantaneous level* ≤ cap and the *long-run average rate* ≤ cap/period, but **admits up to ~2× cap over one arbitrary rolling window** (greedy top-up). We advertise that *true* bound — **never** "structurally impossible looping-drain". A deployment needing a hard rolling bound sizes the **enforced** cap at `periodCap/2` (advertise `periodCap`, enforce half), or enables a dual-bucket. The `setPeriodConfig` precondition `periodCap ≤ uint256.max / periodSeconds` makes the refill product overflow-impossible; a retune **carries the level forward** (never a free-cap reset).
- **Expiry `[start, expiry)` + an EPOCH on the money path** — `bumpEpoch()` is a **real revocation** that strands every in-flight grant (`EPOCH_STALE`), not a no-op view; a queued egress is re-checked against its `epochAtQueue` at execute.
- **Spender/router allowlist (default-deny) + TYPED per-spoke isolation (default-deny, namespace-disjoint)** — an **unconfigured spoke authorizes nothing** (a weak spoke never inherits the hub budget); the spoke key is a `uint64` selector in a namespace disjoint from router addresses, so isolation is **structural** (no address can alias a spoke and a router). The two allowlists are **independent gates**: the typed-spoke bridge path is isolated by the spoke selector's **own** default-deny, so it deliberately **skips the address spender-allowlist rung** (which keys on an address and can never admit the `address(0)` sentinel the bridge path passes) — enabling the address allowlist therefore tightens the on-hub spend path **without** bricking bridge-outs. The two default-denies surface **distinct, machine-readable reasons**: the address spender/router deny is `SPENDER_NOT_ALLOWED`; an **unconfigured bridge spoke** is the dedicated `SPOKE_NOT_CONFIGURED` (returned on the `spokeConfigured == false` branch of `queueBridgeOut` / `executeBridgeOut`), so the verifier's two-source story reads honestly at the bridge boundary instead of conflating the two gates.
- **Pause kill-switch — global + per-agent, GUARDIAN-settable, covering in-flight egress** — pause is a low-priv tighten (owner **or** guardian); the folded time-lock **RE-GATES at execute**, so a paused/expired/epoch-bumped/de-allowlisted registry **refuses** a queued egress (`MandateRefused`).
- **Runtime asset allowlist + per-asset raw sub-caps + USD cap** — a 2-return, **staleness-guarded**, sanity-banded, **gas-bounded** (`{gas: 100_000}`), **fail-closed** price feed; decimals **bound to the live `decimals()`** (a config can never silently disagree with the real token); a native-vs-ERC20 sentinel (`0x…01`, decimals 18); overflow-safe `amount * price` (above the ceiling it fail-closes, never reverts). Plus a USD-denominated cap as defense-in-depth alongside the per-asset caps, and **dust floors** (raw `minSpend` + USD `minUsdMicros`).
- **BOUNDED EVERYTHING** — `MAX_LIST=16` lists · `MAX_DESTCAP=16` dest/spoke caps · `MAX_PENDING=16` live time-lock requests · bounded param queue — every owner-grown structure is capped; the hot path is O(1) mapping reads; the pause path never depends on list size.
- **ATOMIC check-and-effect** — `gateAndRecord` is checks-effects under a `nonReentrant` guard; **record == accrual in one tx** (no view-path TOCTOU gap); the advisory `recordSpend` TOCTOU primitive is **deleted**, and only the bound agent may accrue (the owner cannot poison the agent bucket).
- **Folded outbound time-lock — re-gated at execute, bucket-reserving, anti-smurf** — `queueBridgeOut` **reserves** period headroom (so egress is period-bounded; cancel/expire **releases** it), tiers the delay by the **cumulative** egress level (so N small queues that sum past the threshold cross into the long lock), and a Pending request past its `staleAfter` window is **reapable** (inert). The execute **re-gate nets out the request's OWN reservation** from the period rung (the reserved amount is still consumed in the bucket — counting it a second time would double-charge the *same* money and wrongly refuse a valid queued egress whose delay is shorter than the period) and skips the tx-count rung (a queued egress never charged tx-count at queue); **every other rung still re-runs**, so a pause/expiry/epoch-bump/de-allowlist/cap-tighten between queue and execute can only **DENY**, never extend executability. NON-CUSTODIAL: it authorizes + delays the egress; the actual `ccipSend` is the operator step after a cleared execute.
- **Immutable enforcement logic + DELAYED-LOOSENING governance + two-step ownership + guardian** — every **risk-increasing** owner op (raise a cap · extend expiry · **move the start earlier** · change the agent · repoint the feed · disable an allowlist · **shorten the param-delay itself**) is **queued, time-delayed, and guardian-cancellable** (`queueParamChange` → a `*Loosen` setter callable only via `address(this)`); **tighten + pause stay instant** (and low-priv). Crucially the **param-delay can only be RAISED instantly — shortening it is itself gated by the current delay** (`setParamDelayLoosen`), so a hijacked owner key cannot first zero the delay and then instantly loosen every cap (the classic time-lock self-disarm bypass); likewise moving `start` earlier is delayed (`setStartLoosen`), so no risk-increasing op escapes the delay. Ownership transfer is **two-step** (`transferOwnership` → `acceptOwnership`, proving liveness); the guardian may **only** pause + tighten + cancel a pending loosening, never loosen/withdraw/`setAgent`.
- **EVENT-completeness** — every spend/config/queue/exec/cancel carries headroom + epoch + `spendId`, so the verifier reconciles the advisory path 1:1.

**The fixed 18-rung precedence (the consolidated gate's first-failing reason, deterministic, design §3 #4):** `PAUSED > AGENT_PAUSED > NOT_STARTED > EXPIRED > NOT_AGENT > EPOCH_STALE > ZERO_AMOUNT > BELOW_MIN_SPEND > TOKEN_NOT_ALLOWED > SPENDER_NOT_ALLOWED > OVER_TX_CAP > OVER_ASSET_CAP > OVER_DEST_CAP > OVER_PERIOD_CAP > OVER_TXCOUNT_CAP > {PRICE_UNAVAILABLE | BELOW_MIN_USD | OVER_USD_CAP}`. The view gates are **`view` and never revert over any reachable state** (the folded queue path calls the same `_check` from a mutating context, so a revert-free core is load-bearing — a degenerate config or a hostile/gas-bomb feed degrades to `(false, reason)`, never a revert).

**Money-safety boundary (the corrected headline, stated plainly).** For value that physically routes through a custodial escrow, "can't overspend" would be a pure on-chain invariant. **This contract is deliberately non-custodial** (operator mandate: no custody/escrow), so its guarantee is: the cap is **enforced PRE-broadcast by the gateway** (fail-closed) and **proven by the reconciler** (a spend with no accrual is a LOUD `refuted`). The reconciler is a *named system invariant with tests*, but it is an off-chain trust component — the only fully on-chain enforcement is the pre-broadcast gate read + the loud catch. This is the honest framing, never over-trusted.

The fixed-precedence list above is the **`checkTransfer` view-gate's** first-failing reason. The **typed-spoke bridge path** (`queueBridgeOut` / `executeBridgeOut`) runs the same view core but adds **one bridge-boundary reason ahead of it**: an **unconfigured spoke** (`spokeConfigured == false`) is `SPOKE_NOT_CONFIGURED` — a dedicated tag distinct from the view-gate's `SPENDER_NOT_ALLOWED` (the address spender/router deny), so the bridge default-deny is never conflated with the on-hub address-allowlist deny.

**Verifier two-source.** `verifier/src/mandate.rs` extends the `Tier` set with the hardened labels (`NotStarted · Epoch · TxCountCap · MinSpend · MinUsd · UsdStaleness · SpokeDefaultDeny · ExecuteReGate · EgressReservation`), each confirmed via the same `confirm_tier` gate-read algebra (the new reason codes surface on the frozen `checkTransfer` shape, and the `SpokeDefaultDeny` tier reads back the dedicated `SPOKE_NOT_CONFIGURED` at the bridge boundary, so no new read seam is needed); `verifier/src/reconciler.rs` adds the named I14-R reconciler. `contracts/test/MandateRegistryV4.t.sol` proves one invariant per row; the deploy is operator-gated (`contracts/script/DeployV4.s.sol`, 0G-only chain guard), pinned in `proofagent.toml [mandate_v4]` once confirmed.

### 10.5 The Engine: one execution contract, any protocol — *wow*

Features §10.1–§10.3 each added a *new action* (swap → route → bridge), and each grew its own wire shape — Oku's 7-field `exactInputSingle` tuple, the routing rails' REST/intent flows, CCIP's `ccipSend` `EVM2AnyMessage`. The Engine is the wow that makes that width **scale without sprawl**: it collapses every protocol behind **one bounded execution contract**, so the agent expresses *what it wants moved* and a protocol-agnostic gateway picks, prices, gates, and dispatches the action — while **every** dispatch is wrapped by the identical safety envelope (the mandate gate pre-broadcast + the independent verifier after). **The Engine adds no new action — it makes the proof generic over all of them.** It is a *refactor*, landed with **zero regression** to the proven legs.

**One `ExecutionConnector` contract.** Every protocol satisfies the SAME five-method seam, ordered by a **fund-loss-safe lifecycle**:

| Method | Moves value? | Contract |
|---|---|---|
| `quote(intent)` → `Quote` | **No** (read-only) | the priced-fallback input — the independently-read `expectedOut` + the derived exact-integer on-chain floor. An intent it cannot serve is `quotable:false` with a loud reason — it **never throws** for an unservable intent (the gateway skips it). |
| `buildUnsigned(intent)` → `UnsignedTx` | **No** (pure) | the deterministic ordered un-signed calls + the floor + a secret-free descriptor. A malformed intent / unconfigured venue is a loud error, **pre-submit**. |
| `submit(tx)` → `OrderId` | **YES** (the only one) | sign + broadcast via the **operator-wired** signer. With no signer wired it **fails CLOSED** (loud not-wired), never a fabricated order id / tx hash. |
| `status(orderId)` → `OrderStatus` | No | the lifecycle read, carrying the load-bearing **`valueMoved`** flag. Unreadable → loud `UNKNOWN`. |
| `cancel(orderId)` → `OrderStatus` | No | best-effort cancel of a **pre-value** order — MUST refuse (loudly) anything whose value already moved (it cannot un-move funds), never a fake "cancelled". |

The split between `buildUnsigned` (pure — nothing moves) and `submit` (the only value-mover) is the load-bearing line: it lets the gateway fall back freely on a *pre-broadcast* failure, yet refuse all retry the instant value is in flight.

**Adapters** wrap the proven legs behind the contract, reusing the audited codecs (the swap `exactInputSingle` / route V3 / bridge `approve` + `ccipSend` shapes are untouched): a **SWAP** adapter (Oku/Uniswap-V3, `quote` reads the on-chain `QuoterV2`), a **ROUTE** adapter (Khalani / LI.FI / JAINE), and a **BRIDGE** adapter (CCIP in/out, gated on a pinned, allow-listed `destSelector`). Each is mainnet-operator-gated where its venue is mainnet-only.

**The protocol-agnostic gateway.** `gateway.execute(intent)` is the *only* entrypoint the agent calls — it **never** names a protocol. The gateway: (1) **quotes** every registered adapter (read-only — moves nothing), discarding the `quotable:false` ones; (2) orders the candidates by **priced fallback** — best `expectedOut` first, ties broken by the lower registration priority (deterministic); (3) for each, in order, **builds** → runs the **mandate `checkTransfer` gate PRE-submit for every adapter** (the kill-switch) → runs the **gas-floor gate** (§12.1) → **submits**; (4) applies the **fund-loss-safe `value_moved` short-circuit**:

- everything strictly *before* the first `submit` (quote, build, the gates) is fallback-safe — a failure there moved nothing, so the gateway tries the next candidate;
- a `submit` that **returns** an order id ⇒ value moved ⇒ **STOP** — never retry or fall back (a re-dispatch could double-spend);
- a `submit` that **throws a not-wired** error ⇒ a guaranteed pre-broadcast refusal (the contract fails CLOSED *before* touching the signer) ⇒ safe to fall back;
- **any other** `submit` throw (a live-signer failure that *could* have broadcast) is AMBIGUOUS ⇒ the gateway **STOPS** and refuses to fall back (the conservative, double-spend-safe default — it errs toward STOP, never toward retry).

The gateway **never mints a settlement verdict** — it reports only *which adapter dispatched, with what order id*, or *every candidate was refused pre-submit, here is each reason*. "Did it settle?" stays the independent verifier's monopoly.

**The unified verifier settlement entry — ONE door for ANY adapter.** The four legs above each adjudicate a **different** on-chain fact (native value moved · a pool `Swap`-event output · a rail settle/refund delivery · a two-leg burn+release), but every one mints one of the **same four** verdicts through the **same `Verdict` monopoly**. `verifier::verify_connector_settlement` is the ONE entry that closes the gap: given a protocol-tagged `ConnectorClaim` + the verifier's own protocol-tagged `ConnectorObservation`, it **dispatches** to the matching per-protocol algebra (`adjudicate` / `adjudicate_swap` / `adjudicate_route_leg` / `adjudicate_hop`) and mints a single verdict —

- **No new verdict enum.** The four-verdict alphabet is unchanged; the entry *composes* the proven extensions, it never widens the alphabet.
- **The per-protocol decode stays.** A swap is still adjudicated by the swap floor + `Swap`-event rule, a route by the refund rule, a bridge by the hollow-egress catch — the unified entry only routes.
- **Cross-family = loud refusal.** A `swap` claim against a `bridge` observation is a loud `ConnectorMismatch`, **never** a fabricated `settled` (the type-level twin of two-source truth); an unreadable observation for any protocol is `unverified`, never a fabricated success.

**Width-by-data: a new adapter is a `[[connector]]` block + the adapter, ZERO dispatch change.** The typed `ConnectorManifest` (parsed from the `[[connector]]` blocks of `proofagent.toml`) declares each connector's `name`, its `shape` (which settlement algebra adjudicates it), `chains`, `priority`, and **which named gates must pass before it is trusted**. An adapter **cannot vote itself in** — a connector that names **no** gates is *rejected by the manifest parser*, so an unproven leg surfaces **loud-`unverified`** over silent-green. The full recipe — and the four invariants every adapter must preserve (verdict monopoly · two-source truth · never-fabricate · deterministic + exact-integer) — is in `docs/ADD_AN_ADAPTER.md`.

| Connector (manifest `[[connector]]`) | `shape` | Chains | Gated by | Verifier algebra |
|---|---|---|---|---|
| `native-settlement` | `settlement` | 16602 · 16661 | `settlement` | `adjudicate` (native value moved) |
| `oku-swap` | `swap` | 16661 | `settlement` · `mandate-cap` | `adjudicate_swap` (floor + `Swap`-event out) |
| `rail-route` | `route` | 16602 · 16661 | `settlement` · `mandate-cap` | `adjudicate_route_leg` (terminal + delivered) |
| `ccip-bridge` | `bridge` | 16661 | `settlement` · `mandate-cap` | `adjudicate_hop` (both legs + hollow-egress) |

> **The value_moved short-circuit is a hard invariant with a dedicated test.** It is the structural reason the Engine can carry value-bearing mainnet legs safely: once a `submit` puts value in flight, no fallback path exists that could re-broadcast it.

### 10.6 Testnet-safe vs mainnet-only (16602 vs 16661)

- **Testnet-safe on Galileo (16602) today:** only the **JAINE same-chain AMM leg** has a testnet venue — so a same-chain swap demo can run under the full mandate-gate + verifier wrap at **$0 risk on 16602**, proving the envelope end-to-end value-lessly. The four-tier `MandateRegistryV3` is **your own contract**, also fully deployable + demoable on 16602 at $0.
- **Mainnet-only (16661):** Oku/Uniswap-V3 swap (no 16602 deployment); Khalani/LI.FI/CCIP routing; XSwap/CCIP bridge (**Galileo CCIP is decommissioned** — no new CCIP tx to/from 16602).
- **Demo doctrine for mainnet-only legs:** run on 16661 under a hard per-trade cap with recycled dev funds + hard-stop guards, or in dry-run/plan mode — never a value-less testnet rehearsal. For these legs the safety story leans on the cap + mandate gate (a bounded value-bearing send) rather than a free testnet.

---

## 11. Cross-chain security: hub-and-spoke (0G hub)

The three proofs (§2) bound a **single** action on **one** chain. The moment value crosses chains, a new question opens: *which chain's security do you inherit?* ProofAgent answers it structurally — **0G is the SECURED HUB; every other chain is a SPOKE.** Cross-chain value flows through the hub, never directly spoke-to-spoke. This is **hub-and-spoke, not a mesh** — and the distinction is the whole safety argument.

### Hub-and-spoke vs a mesh — why a mesh degrades to the weakest link

A **mesh** connects every chain to every other chain directly. Its safety is the safety of the **weakest chain or bridge in the whole graph**: an agent holding value reachable over a mesh is only as safe as the least-secured lane it can touch, because an attacker picks the weakest edge. Worse, a mesh's risk surface grows combinatorially (every new spoke adds an edge to every existing one), so you cannot reason about it leg by leg.

A **hub-and-spoke** topology routes all cross-chain value through one **secured hub** (0G). Each spoke connects **only to the hub**, never to another spoke. The consequences are load-bearing:

- **The hub's security is the floor, not the weakest spoke's.** Value at rest lives in the hub, under the hub's proofs (the three of §2). A spoke is touched only for a single, bounded, verifier-confirmed hop in or out.
- **Risk is per-spoke and isolated, not combinatorial.** A compromised or weak spoke can endanger **only the value on that one lane** — never the hub and never the other spokes (the per-spoke isolated caps, §11.3). Spoke `A` being weak says nothing about spoke `B`.
- **You reason leg by leg.** Each hop is one bounded action wrapped by the same envelope (mandate gate pre-send + independent two-leg verifier after, §2 Rails + Settlement). A spoke→spoke journey is *two* hub-routed hops (`spoke → 0G`, then `0G → spoke`), each independently gated and independently verified — never one unbounded mesh edge.

### The three proofs, mapped onto the cross-chain envelope

The cross-chain envelope reuses the **exact** primitives of §2 — it adds no new trust surface, it points the existing ones at the bridge boundary:

| Cross-chain control | ProofAgent primitive (§2 / §8) | What it bounds at the bridge boundary |
|---|---|---|
| **Velocity limiter** (rate-bound how fast value can move out) | the **mandate period-cap** (Tier 1 of the four-tier gate — a cumulative per-window cap with an atomic accrue) | caps *cumulative* cross-chain outflow per window, so looping small in-cap hops can't drain past the per-tx ceiling — the on-chain velocity bound |
| **Gasless pre-flight simulation** (reject a bad transfer *before* it broadcasts, at zero gas) | the on-chain **`checkTransfer`** gate (a zero-gas `eth_call`, fail-closed, pre-broadcast) | asserts asset · cap · expiry · the **expected destination selector** *before* any burn — the kill-switch that makes "the safest egress failure is the one that never burns on the hub" true |
| **Settlement engine** (decide whether the cross-chain transfer actually completed) | the independent **Rust verifier** (raw JSON-RPC, the verdict monopoly) | reads **both legs of every hop** (source burn/lock + destination release/mint) and mints `settled / hollow / mismatch / unverified` — never the bridge UI / CCIP-explorer API |

### 11.1 Inbound (spoke → hub) is AUTONOMOUS

Bridging value **into** the secured hub is the **autonomous** direction: it mints into the chain ProofAgent already watches and secures, so a hop that completes simply increases hub-side value under the hub's proofs. The risk of a *failed* inbound hop is bounded by the same two-leg verifier — a missing hub-side mint is caught **loud-`hollow`**, never trusted blind — but a *successful* inbound hop adds no new outward exposure. So inbound bridging needs no extra ceremony beyond the standard envelope.

The inbound lanes are: **Ethereum → 0G** (native USDC locked → USDC.E minted on the hub, 1:1 lock-and-mint) and the **Arbitrum → 0G** and **BNB → 0G** w0G CCT direct lanes (lock w0G on the spoke → mint w0G on the hub). Each is a single CCIP `ccipSend` against the source chain's Router, pinning the **0G hub** as the allow-listed destination selector; each is mandate-gated pre-send and verifier-confirmed two-leg after (the same `verify_hop` algebra, the same four-verdict alphabet). The verifier records **which spoke** an inbound hop bridged from (the lane's source-spoke selector) for the per-spoke audit trail.

### 11.2 Outbound (hub → spoke) is the RISKY direction — and is value-tiered time-locked

Bridging value **out** of the hub is the dangerous direction: the hop **burns/locks on the hub** and then depends on a **remote chain we do not control** to release. This is exactly where value gets stuck or lost — the **hollow-egress** trap (source burned, destination empty), the centerpiece the two-leg verifier catches loud (§2 Settlement). Because egress is asymmetrically risky, it gets an asymmetric control the inbound direction does not need: a **two-step, value-tiered outbound time-lock** that holds a large outbound transfer for a delay before it can execute, giving the owner a window to cancel.

**The `TimelockGuard` contract (`contracts/src/TimelockGuard.sol`).** A fresh, clean-room Solidity guard that composes with the production mandate by **address** (it holds only the `MandateRegistryV3` address and calls its public `checkTransferTo(agent, token, amount, spender) → (ok, reason)` shape — it vendors no registry code). The guard moves **no tokens and holds no funds** — it gates, delays, and records the *authorization* to bridge out; the actual `ccipSend`/burn is the agent/operator step that follows a cleared execute, so a queue/cancel can never strand value. The two-step lifecycle:

- **`queueBridgeOut(token, amount, destSelector, recipient) → queueId`** — runs the mandate gate **HERE**, at queue time (the SAME four-tier fail-closed precondition that bounds an on-hub spend, with the gate's `spender` pinned to the **per-spoke destination sentinel** for `destSelector` so the registry's per-destination Tier-4 cap + spender allowlist bound *this* spoke, §11.3). A **refused** gate **reverts** the queue (`MandateRefused(reason)`, surfacing the registry's own reason tag) — a `queueId` only ever exists for a mandate-cleared egress (fail-closed, §3 #3). On success it records the request with a value-**TIERED** `executableAt`:
  - **`amount ≤ bigValueThreshold`** → a **SHORT** delay (`shortDelaySeconds`) — small, in-cap egress clears fast;
  - **`amount > bigValueThreshold`** → a **LONG** delay (`longDelaySeconds`, the **24h-style lock**) — a large egress is held long enough for the owner to react. The constructor + `setTiers` enforce `longDelay ≥ shortDelay` (the big tier is never the *faster* one).
- **`executeBridgeOut(queueId)`** — **REVERTS with `TooEarly` unless `block.timestamp ≥ executableAt`** (the no-bypass guarantee: a too-early execute can never pass), and reverts `NotPending` if already executed/cancelled (the terminal states are absorbing — a request executes at most once). On success it marks the request `Executed` and **emits `BridgeOutExecuted(queueId, executedAt, executableAt)`** — the on-chain record the verifier reads to confirm the delay was honored.
- **`cancelBridgeOut(queueId)`** — the owner (or the original agent queuer) **aborts a still-pending request in-window**; it reverts `NotPending` once the request has executed (you cannot un-burn). This is the human-in-the-loop window the asymmetry buys: a mistaken or hijacked large egress is stopped **before any value burns on the hub**.

The schedule is **deterministic + exact-integer** (§3 #4/#5): `executableAt = queuedAt + delayFor(amount)`, a pure function of the queue-time block timestamp and the tier delay; a queued request's schedule is **immutable** (re-tuning the tiers affects only future requests).

**The verifier CONFIRMS the lock held (`verifier/src/timelock.rs`).** The verdict is not the contract's word — an independent reader proves it. `adjudicate_timelock` reads the guard's queued-request state (the recorded `queuedAt`/`executableAt` schedule + the actual `executedAt`, or the `cancelled` flag — the **Observation**) and adjudicates it against the agent's `TimelockClaim` (the amount + the guard's public tier config — the **Claim**), minting a `TimelockVerdict` under the same monopoly + never-fabricate doctrine as the mandate `TierVerdict`:
- **`confirmed`** — the value tier's delay was applied AND (if executed) it executed only **at or after** `executableAt` (no bypass), or it is still safely pending / was cancelled in-window;
- **`refuted`** — a loud "the lock did NOT hold as designed": the request executed **before** its `executableAt` (the **NO-BYPASS proof** — the contract makes this impossible, and the verifier confirms it *did not happen* rather than assuming), or the wrong tier delay was applied (e.g. a big-value transfer scheduled with the short delay), or a malformed schedule;
- **`unverified`** — the guard state could not be read; it degrades **loudly**, never to a fabricated `confirmed` (§3 #3).

It is **offline-buildable** (a deterministic `TimelockTape`, like every other verifier leg); the live `eth_call` read of the guard is **OPERATOR-GATED** (the guard is your own contract, deployable + demoable on testnet 16602 at $0, unlike the money-bearing CCIP legs). `contracts/test/TimelockGuard.t.sol` proves every tier + the cancel + the too-early revert + the absorbing terminal states + the authorization gates; `verifier/src/timelock.rs` proves the confirmation algebra (confirmed/refuted/unverified, the no-bypass catch) over the offline tape.

### 11.3 Per-spoke isolated caps — a weak spoke is capped to that spoke

Each spoke lane carries its **own** isolated cap, so a weak-spoke exploit can drain **at most that spoke's cap**, never the hub and never another spoke. The 0G hub itself is untouched by any spoke's compromise.

**The wiring (reusing the V3 per-destination cap surface).** A per-spoke cap is **not** a new mechanism — it reuses `MandateRegistryV3`'s **Tier-4 per-destination `destCap`** (§10.4), keyed by the spoke's **per-spoke sentinel** spender. `TimelockGuard.spokeSpender(destSelector)` derives a deterministic, collision-free address per CCIP selector (`keccak("proofagent:spoke:" ‖ selector)`), and `queueBridgeOut` runs the mandate gate with **that sentinel as the `spender`** (§11.2). So a spoke's isolated cap is exactly `destCap[spokeSpender(destSelector)]`, configured on the registry by the owner (`setDestCap(spokeSpender(sel), cap)`) — the registry owns its own caps; the guard only **reads** them through (`spokeCap(destSelector)` and the effective ceiling `spokeEffectiveCap(token, destSelector) = min(perTxCap, assetCap[token], spokeCap)`). Two distinct selectors map to two distinct sentinels, so **per-spoke caps never collide**.

**The isolation invariant (proven end-to-end).** With a tight per-spoke cap on one lane and a looser one on another:

- an egress to the **weak spoke** above *its* cap is refused **at queue time** (`MandateRefused`, reason `OVER_DEST_CAP`) — even when it is far under the hub's global cap;
- the **same amount** queues fine on a **different spoke** whose own cap allows it — one spoke's tight cap never constrains another (the spokes are isolated);
- an **uncapped spoke** falls back to the hub's global/asset caps (not another spoke's), and is still bounded by them;
- the **0G hub's own on-hub spend** (the `address(0)` / no-spoke spender) is checked against the hub's global+asset caps **only** — a spoke's tight cap never tightens the hub. **The hub stays the security floor.**

`contracts/test/TimelockSpokeIsolation.t.sol` proves this with the **real** `MandateRegistryV3` wired into the real `TimelockGuard` (weak/healthy/uncapped spokes + the untouched hub). And the verifier **independently confirms** the isolation on the gate: `verifier/tests/spoke_isolation.rs` reads `checkTransferTo(agent, token, amount, spokeSpender)` per spoke and confirms the weak spoke reads back `OVER_DEST_CAP` while the healthy spoke + the hub read within-mandate — a gate that *failed* to enforce a per-spoke cap reads `refuted`, never a fabricated `confirmed` (§3 #2/#3).

### 11.4 ROADMAP — two cross-chain hardenings (NOT BUILT — design only)

> **ROADMAP, not built.** Everything in §11.4 is *future design*, deliberately separated from the live
> surface above. It is **not implemented**, **not gated**, and **never claimed live** (claim only what's
> live, §13). The hub-and-spoke envelope shipping today reads the destination leg directly via raw RPC and
> trusts the human/operator + the DON's two-leg delivery; the two hardenings below would *strengthen* that
> trust model, but neither is part of this build. They ride the **same** hub-and-spoke envelope (§11) and
> add no new live trust surface until they are built and gated — at which point they would be claimed as
> their own honestly-labelled bracket-deltas, exactly like every other capability here.

Today's outbound verifier (§11.2) proves the destination leg by **reading it** — `verify_hop` reads the
destination OffRamp `ExecutionStateChanged == SUCCESS` and the released amount via raw JSON-RPC, and the
trust that the *source-chain* burn really happened (and that no human/multisig fabricated the destination
release) rests on the bridge DON's consensus + the operator. Two future hardenings would replace that
remaining human/consensus trust with **math**:

#### Hardening 1 — ZK light-client state proofs (replace "read the chain" with "prove the chain")

**The claim it would kill.** *"You have to trust the bridge's multisig / DON-consensus that the source-chain
transaction really occurred — a compromised committee could attest to a burn that never happened."*

**The mechanism.** A **ZK light client** verifies the **source chain's consensus** inside a succinct proof:
instead of *reading* that the source-chain burn landed (and trusting whoever reported it), the verifier
checks a **zero-knowledge proof that the source-chain block — containing the burn/lock transaction — was
finalized under that chain's own consensus rules**. The destination-side release is gated on that proof
verifying on-chain. Concretely it would compose three pieces, all on the existing envelope:

- a **light-client circuit** that proves "block `H` on the source chain is final, and transaction `T` (the
  burn/lock with amount `A` to the hub) is included in `H`" — a succinct proof of a Merkle-Patricia
  inclusion against a proven-final header, no committee in the loop;
- an **on-hub verifier contract** that checks that proof (a single `verifyProof(...)` call) before the hub
  credits/releases — so a destination release **cannot** happen without a mathematically-valid source-chain
  inclusion proof (fail-closed by construction, the §3 #3 posture lifted to the bridge boundary);
- the **independent Rust verifier** would then adjudicate the *proof's verification event* (the
  Observation) against the agent's hop Claim — minting `settled` only when the on-chain proof-verification
  succeeded, `refuted`/`hollow` when the release happened without a valid proof, `unverified` when the
  proof-verification event is unreadable — the **same four-verdict alphabet + verdict monopoly** (§3 #2),
  now anchored to a proof rather than a read.

**What it buys.** It **eliminates the multi-sig / human-consensus trust** from the cross-chain leg: the
source-chain occurrence is *proven*, not attested. A compromised bridge committee can no longer fabricate a
destination release, because the on-hub verifier rejects any release whose source-inclusion proof does not
verify. This is the strongest form of the two-source-truth invariant (§3 #1) — the "source" becomes a
self-checking mathematical proof, not a reported fact.

**Why it is roadmap, not live.** A production ZK light client for each spoke chain's consensus (plus the
prover infrastructure and the on-hub verifier contract) is a substantial build well beyond this MVP; it is
documented here as the intended end-state of the cross-chain trust model, **not** as a shipped capability.

#### Hardening 2 — the intent-based Filler pipeline (assets never enter a shared pool)

**The claim it would kill.** *"A cross-chain transfer parks your assets in a shared bridge pool / lock
contract — so a single hack of that pool drains everyone, and you are exposed for the whole in-flight
window."*

**The mechanism (lock + publish intent → professional Filler fulfills from their OWN wallet → off-line
settle).** Instead of routing value through a shared lock-and-mint pool, the user **locks their input on the
hub and publishes a signed *intent*** ("I will pay `X` of token `A` on 0G to whoever delivers `Y` of token
`B` to me on spoke `S` by deadline `D`"). A **professional Filler** (a competitive solver) then:

1. **fulfills the intent from the Filler's OWN wallet** — the Filler sends `Y` of token `B` to the user on
   the destination spoke **using the Filler's own capital**, *before* being paid;
2. **settles off-line / out-of-band** — the Filler then claims the user's locked input on the hub by
   presenting proof of fulfillment, in a separate settlement step (atomic **settle-or-refund**: if no Filler
   fulfills by the deadline `D`, the user's locked input is **refunded**, never stranded);
3. so **the user's assets never sit in a shared pool** — they are locked in the user's *own* intent escrow
   on the hub, released only against a proven fulfillment (or refunded on timeout).

**The isolation property — a settlement hack only exposes the Filler.** Because the Filler fronts their own
capital and is reimbursed only after delivering, **the risk of a settlement-layer compromise lands on the
Filler, not the user and not a shared pool.** There is no commingled honeypot: a hack of the settlement
contract can, at worst, expose **a Filler's** working capital for in-flight intents — never the broad pool
of every user's parked value. This is the cross-chain analogue of the per-spoke isolation invariant (§11.3):
blast radius is bounded to one party, never the hub and never the other users.

**How it rides the existing envelope.** The user's lock + intent publication is **mandate-gated pre-send**
(the same `checkTransfer`/`queueBridgeOut` precondition, §11.2 — the intent escrow is just another
destination-pinned, capped, expiry-bounded authorization) and the fulfillment is **verifier-confirmed
two-leg after** (the user's destination receipt + the Filler's hub settlement, adjudicated to
`settled / hollow / mismatch / unverified` under the same monopoly + never-fabricate doctrine, §3 #2/#3).
Khalani-style "funds never move if constraints unmet" composes as defense-in-depth — the verifier still
treats a `refunded` intent as a **non-settlement terminal state** (mandate-safe), and only a fulfilled
intent with a matching on-chain destination transfer as `settled`.

**Why it is roadmap, not live.** The intent escrow, the Filler-settlement contract, and the solver/Filler
network are not implemented in this build. They are documented here as the intended evolution of the
outbound (hub → spoke) direction — replacing the shared-pool exposure with per-Filler-isolated risk — **not**
as a shipped capability (claim only what's live, §13).

#### Both ride the same envelope — and neither relaxes it

ZK light-client proofs harden the **read** (prove the source occurred) and the Filler pipeline hardens the
**custody** (assets never pooled). They are **complementary**: together they would make a cross-chain hop
*proven at the source* and *isolated in custody*, with the hub still the security floor (§11) and every leg
still mandate-gated + verifier-confirmed. Until each is built and gated GREEN, it stays **design-only** and
is **never** counted toward the live three-proofs claim.

---

## 12. Money-safety suite — can't deplete gas, can't deplete net worth

The mandate cap (§2 Rails / §10.4) bounds how much of an *asset* the agent may move. Two subtler depletions slip past a per-asset cap entirely — and the money-safety suite closes both, each as a pre-broadcast kill-switch the verifier then independently confirms.

### 12.1 The gas floor — "can't deplete gas"

There is a second, subtler way an agent can lose access to its own funds: by spending its **native gas token to ~0**. On 0G the native token *is* the gas token. If the agent burns it all on fees — or, worse, **swaps or bridges the native token itself away** — it is left **STUCK**: it can no longer pay for *any* transaction, so it cannot send a recovery tx, cannot `cancelBridgeOut` a still-pending egress (§11.2), and cannot move funds at all. A wallet that cannot afford its own next transaction is, for all practical purposes, **bricked** — even though every individual action passed the asset cap. The gas floor closes this gap.

**The guard — a hard native-reserve floor, enforced PRE-broadcast.** A configured reserve `minGasReserve` (native 0G, in wei) the agent must **never spend below**. Before **any** value-moving action the agent gateway asserts, against the agent's **own on-chain native balance** (a pre-submit `eth_getBalance` — two-source truth, §3 #1: the chain's balance is the *fact*, the agent's plan only a *Claim*), the exact-integer reserve inequality

```text
nativeBalance − actionNativeCost − estGasFee  ≥  minGasReserve
```

and **REFUSES the action pre-broadcast** (the kill-switch) when it does not hold. The terms:

- **`actionNativeCost`** — the native `msg.value` *this* action would move out (a native CCIP fee paid as `value`, a native-token egress amount); `0` for a pure ERC-20 action. It is **summed from the BUILT (un-signed) tx's call `value`s**, so it is exactly what would be broadcast — never the agent's estimate.
- **`estGasFee`** — the conservatively-estimated fee the broadcast itself will burn (gas × price). It is **always** subtracted, so even a `0`-native action must still leave the reserve intact *after* paying its own gas.

The floor lives in the gateway (`agent/src/gasfloor.ts` → `checkGasFloor`, wired into `gateway.ts` as a pre-submit gate **for every adapter**, right after the mandate `checkTransfer` gate) **and** as a config knob in `proofagent.toml [gas_floor]` (`enabled` · `min_gas_reserve` · `est_gas_fee`). It is **fail-CLOSED** (§3 #3): a disabled, not-wired, unread, or breached floor **never** permits a submit — a buggy or hijacked agent cannot deplete the wallet by making the check merely *fail to answer*. A blocked candidate moved **nothing**, so the gateway falls back freely to the next, **less-depleting** candidate (the safest depletion failure is the one that never broadcasts). Every amount is exact-integer `bigint` wei (§3 #5) — no float on this money path.

**The verifier CONFIRMS the reserve held (the verdict monopoly).** The gate is not the verifier's word — an independent reader proves it. `verifier/src/gasfloor.rs` reads the agent's **post-action** native balance itself (the **Observation**) and adjudicates it against the configured `minGasReserve` (the **Claim**), minting a `GasFloorVerdict` under the same monopoly + never-fabricate doctrine (§3 #2/#3):

- **`confirmed`** — the post-action balance is **at or above** the floor: the agent kept enough native gas to pay for its own next transaction;
- **`refuted`** — a loud "the floor did **NOT** hold": the post-action balance fell **below** `minGasReserve` (a **depletion** the pre-broadcast gate should have blocked — the verifier proves it did not happen rather than assuming it);
- **`unverified`** — the post-action balance could not be read; it degrades **loudly**, never to a fabricated `confirmed`.

It is **offline-buildable** (a deterministic `GasFloorTape`, like every other verifier leg); the live `eth_getBalance` read is feature-gated. So a depletion is surfaced **LOUD** via the verdict monopoly, never silently counted as success (§13 zero-loss). The zero-defect gate wires **two** money-critical presence checks — the gateway must enforce `checkGasFloor` pre-submit, and the verifier must carry `adjudicate_gas_floor` — so neither half of the gas floor can silently regress out of the tree.

### 12.2 The net-worth floor — "can't deplete net worth"

The asset cap bounds how much of a **single** asset the agent may move per action, and the gas floor (§12.1) keeps the **native** token above a reserve. But neither bounds the **portfolio as a whole**. Total net worth — **Σ (holdings × price)** across every token and every chain — can still drain even when **every individual leg "settles"**: via slippage on each swap, a price mismatch, accumulated fees, an exploit, or simply a string of value-losing trades that each pass their own per-trade cap. Each leg cleared its asset cap; the **sum** still fell. A wallet whose every action was individually "fine" can still be quietly halved. The net-worth floor closes this portfolio-level gap.

**The guard — a hard net-worth floor (absolute OR max-drawdown), a kill-switch on the SUM.** A configured floor the agent's total net worth must **never drop below**. The floor is the **stricter of two independent bounds** (a breach of *either* halts):

- **Absolute floor** — a hard minimum total net worth, regardless of history (e.g. "never below $50").
- **Max-drawdown floor** — a fraction of the **session-start** net worth: HALT if net worth falls below, say, **70% of where the session started** — exactly the doctrine's *"wallet < 70% of session-start → hard stop."* The drawdown floor is `session_start × num / den` (exact integer division).

The **effective floor** is `max(absolute, drawdown)`, so the portfolio is held to whichever line is tighter. When net worth breaches it, the agent **HALTS** (the portfolio-level kill-switch) — the same fail-closed posture as the asset cap and the gas floor, lifted from one asset to the whole book.

**The VERIFIER computes net worth from INDEPENDENT chain reads (the verdict monopoly).** The breach is **not** the agent's self-report — an independent reader proves it. The agent's "my net worth is still above the floor" is a **Claim** (never trusted, design §3 #1). The verifier reads the chain **itself** — for **every** holding, the token's on-chain balance (native `eth_getBalance` / ERC-20 `balanceOf`) **× its price** (from a public feed) — sums them into the **Observation**, and adjudicates that independently-computed total against the configured floor. `verifier/src/networth.rs` mints a `NetWorthVerdict` under the same monopoly + never-fabricate doctrine (§3 #2/#3):

- **`confirmed`** — the verifier's **own** computed total (every holding read, priced, summed) is **at or above** the effective floor: the portfolio did not drain below the absolute / max-drawdown line.
- **`refuted`** — a loud "the floor did **NOT** hold": the verifier's own total fell **below** the floor (a portfolio depletion the kill-switch should have blocked — the verifier proves it happened rather than assuming it). The agent's rosy self-report can **never** rescue a real on-chain depletion (two-source truth: the agent's `reported_total` is recorded for the journal but is **never an input to the verdict**).
- **`unverified`** — the total could not be computed. Crucially this fires when **any single holding leg is unreadable** (or the priced sum overflows): a **partial** read degrades the **whole** net worth — a partial sum is **never** passed off as a total, because a missing leg could hide a depletion. This is the multi-leg analogue of a single unreadable balance, and the same "settled IFF *every* leg settled" composition the bridge/route verifiers use.

Every amount is exact-integer `i128` value units (`balance minor-units × price micro-USD/minor`), summed with **checked** arithmetic (an overflow degrades **loudly** to `unverified`, never a wrapped total); the drawdown floor is an exact-integer ratio — there is **no floating point** anywhere on this money path (§3 #5). It is **offline-buildable** (a deterministic `NetWorthTape`, like every other verifier leg); the live multi-balance read is feature-gated. So a portfolio depletion is surfaced **LOUD** via the verdict monopoly, never silently counted as success (§13 zero-loss). Like the gas floor, the net-worth floor is wired as a **money-critical presence gate** in the zero-defect gate: the gate **fails** if the verifier's `adjudicate_net_worth` confirmation is missing or renamed — so the portfolio-level guard cannot silently regress out of the tree.

---

## 13. Security & honesty doctrine

- **Testnet / dev only** for live legs; small recycled balances; a **per-trade cap**; a **fresh demo wallet** distinct from any other.
- **Never commit secrets** — no keys, no `.env`, no wallet private material, in any commit.
- **Claim only what is live** — the pitch leads with the legs that are provable on screen; every later 0G capability is an honestly-labelled bracket-delta. The cross-chain roadmap hardenings (§11.4) and the `zerog/` *Wow* storage leg are design-only until built and gated GREEN. The `zerog/` *Depth* leg (`compute.ts`, the TEE brain) is **built + offline-tested** but its live attestation flip is **operator-gated** (a funded 0G Compute sub-account + a TEE provider), so the brain stamp stays PENDING by default and only goes green on a real verified attestation — built, but not *claimed live* until one runs.
- **Zero-loss** — every claimed settlement is chain-verified (`settled / hollow / mismatch / unverified` in the journal); a defect (`hollow` / `mismatch`) is surfaced LOUD and prescribes a heal, never silently counted as success.
- **Demo-safety** — lead with the no-settlement NEG case; verify against the proven corpus rather than fresh live settlements on camera.

---

## 14. Getting started

```bash
cp .env.example .env        # fill in your own 0G RPC + a FRESH demo wallet — never a shared key
# verifier
cargo run -p verifier -- verify-tx <hash>     # → SETTLED / HOLLOW / MISMATCH / UNVERIFIED
cargo run -p verifier -- ledger --journal demo/proofagent.demo.journal   # the settlement-truth projection
cargo run -p verifier -- audit  --journal demo/proofagent.demo.journal   # surfaces defects LOUD (non-zero exit)
# contracts
forge build && forge script script/Deploy.s.sol --rpc-url $OG_RPC --broadcast
# agent + web
npm install && npm run dev
```

SDK versions are pinned in `package.json` / `Cargo.toml`. No real keys ever live in the tree.

---

## Appendix — constants & sources

**Chain / venue**
- 0G chain id **`16661`** (Aristotle); testnet **Galileo `16602`**; public explorers **chainscan.0g.ai** (mainnet) · **chainscan-galileo.0g.ai** (testnet).
- Tokens: **USDC.e**, **W0G**. DEX: **Oku `SwapRouter02`** (Uniswap-V3 periphery); native AMM **JAINE**.
- Bridge: **XSwap** over **Chainlink CCIP**; 0G CCIP selector `4426351306075016396`.

**Public 0G SDKs**
- Storage: `@0glabs/0g-ts-sdk`. Compute: the public broker SDK / `router-api.0g.ai` (OpenAI-compatible endpoint).
- Swap: `@uniswap/v3-sdk` / `@uniswap/sdk-core` / `swap-router-contracts`. Routing: `@arcadia-network/sdk` (Khalani) · `@lifi/sdk`. Bridge: `IRouterClient.ccipSend` + `Client.EVM2AnyMessage`.

**Sources**
- Zero Cup — https://0g.ai/arena/zero-cup
- 0G docs — https://docs.0g.ai/
- 0G Compute — https://compute.0g.ai/
- 0G Builder Hub — https://build.0g.ai/hackathons
- Oku deployed-contracts — https://docs.oku.trade/home/extra-information/deployed-contracts
- CCIP directory → 0G mainnet — https://docs.chain.link/ccip/directory/mainnet/chain/0g-mainnet
- Khalani powers 0G Pay — https://blog.khalani.network/khalani-powers-0g-pay
- LI.FI SDK — https://github.com/lifinance/sdk

*The MandateRegistry / MandateRegistryV3 / TimelockGuard / MandateRegistryV4 addresses and the verifier corpus are pinned in `proofagent.toml` once confirmed on-chain (V4 is built & tested; its deploy + `[mandate_v4]` pin are operator-gated). The as-built evidence record — live on-chain proofs, the full gate matrix, and the design ↔ code conformance verdict: [`docs/PROOFAGENT_0G_EVIDENCE.md`](PROOFAGENT_0G_EVIDENCE.md). The adapter recipe: [`docs/ADD_AN_ADAPTER.md`](ADD_AN_ADAPTER.md).*
