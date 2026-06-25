# ProofAgent-0G — See it, check it, verify it yourself

**The AI agent that can't lie, and can't overspend — on 0G.** This page is for anyone: a judge, a voter, or a developer. It explains what the project is in 30 seconds, lets you **check the proofs on-chain with nothing installed**, gives the full hands-on **CLI/contract** reproduction, and — for a zero-trust, zero-wallet walkthrough in the browser — a **fullstack judge/voter guide** (below) that drives every proof through the real UI. The whole point of the project is that you don't have to trust us — you check the chain.

---

## What this is (30 seconds)
Most AI agents *tell you* what they did. ProofAgent-0G makes that **independently provable**:
- **Can't lie** — an independent Rust verifier reads 0G itself and stamps every claim `settled / hollow / mismatch / unverified`. Hand it a transaction that never happened and it says **`unverified`** — it refuses to rubber-stamp.
- **Can't overspend** — an on-chain mandate (`checkTransfer`) gates every spend with per-tx / per-period / per-asset / USD caps. Over-cap → blocked **before** anything is broadcast.
- **Can't drain itself** — gas-floor + net-worth-floor guards, each independently verifier-confirmed.

Everything below is **reproducible by you** — that's the proof.

---

## 🔎 Quick look — no tools, just click *(for judges & voters)*
You can confirm the project is real in under a minute, with **nothing installed**:

**▶ Fastest path — [open the live Verification Console](https://aristosmesotes.github.io/proofagent-0g/dashboard.html)** and run every proof in your browser: the proof cards, paste **any** 0G tx hash into the Playground, the dry-run RUN LEDGER, the mandate card — all reconciled live against 0G Galileo. No install, no wallet, no signup.

The console opens on the **"every layer on 0G"** strip (0G Compute · 0G Chain · 0G Storage) and these self-serve hooks — no trust, no wallet needed:
- **▶ Watch it refuse a lie** — one click runs the NEG case live: a fabricated hash → `UNVERIFIED`.
- **Real vs fake, zero typing** — two buttons: a real settlement → `SETTLED`, a fabricated one → `UNVERIFIED`.
- **Run it with YOUR wallet (Tier-2)** — connect your own wallet and run the *same* mandate gate with your own key (over-cap refused pre-broadcast; under-cap you sign and the verifier confirms your tx). The console never sees your key.
- **Watch the agent's wallet on 0G** — read-only, key-free: the live native balance + nonce, straight from chain.

Then confirm it's all real on-chain:

1. **Watch the demo** → the [`demo` release](https://github.com/AristosMesotes/proofagent-0g/releases/tag/demo) (the comprehensive ~4-minute master cut + a 30s short).
2. **Check the chain yourself** — these are **real transactions** on the public 0G-Galileo explorer. Click and look:
   - ✅ **A real settlement** → [`0x8c59…bfb0`](https://chainscan-galileo.0g.ai/tx/0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0) — should read **Success**, value **1,000,000 wei**, block 39,996,100.
   - 🟢 **The live mandate contract** (the consolidated, hardened **`MandateRegistryV4`**) → [`0x8e561a…f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774) — deployed on 0G Galileo `16602`, block 40,213,222.

The demo video *shows* the commands; these explorer pages are **the chain proving them**. No setup, no trust required.

---

## 🛠️ Verify it yourself — hands-on *(for technical judges & developers)*
Read-only — **no private key or funds needed.**

**Prerequisites:** Rust/`cargo`, Node 18+, a browser (optional Foundry `cast` for the mandate check).
```bash
git clone https://github.com/AristosMesotes/proofagent-0g && cd proofagent-0g
```
Network: 0G-Galileo testnet `16602` · RPC [`https://evmrpc-testnet.0g.ai`](https://evmrpc-testnet.0g.ai) · explorer [`https://chainscan-galileo.0g.ai`](https://chainscan-galileo.0g.ai).

### Proof 1 — NEG: it can't lie  *(CLI **and** UI)*
```bash
cargo run -p verifier -- verify-tx 0xdeadbeef00000000000000000000000000000000000000000000000000000000
# → unverified   (exit 1)   — a transaction that never happened; it refuses to confirm it
```
**On screen too:** `cd web && npm install && npm run build && npx serve -l 3100 .` → open `http://localhost:3100` → click **"Run the NEG case"** → the page stamps **`UNVERIFIED`**. It must equal the CLI verdict — the UI is never trusted; the verifier re-derives it from the chain.

### Proof 2 — RAILS: it can't overspend  *(contract — the LIVE `MandateRegistryV4`)*
The pinned mandate is the consolidated, hardened **`MandateRegistryV4`**, LIVE on 0G Galileo `16602` at
[`0x8e561a5cc096af6e570220a5228b33c7d889f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774). Read it yourself — read the **agent FROM-CHAIN** (never a key):
```bash
REG=0x8e561a5cc096af6e570220a5228b33c7d889f774
RPC=https://evmrpc-testnet.0g.ai
AGENT=$(cast call $REG "agent()(address)" --rpc-url $RPC)   # the mandated agent, READ FROM-CHAIN (== owner)
NATIVE=0x0000000000000000000000000000000000000001            # the V4 native sentinel (cast call $REG "NATIVE()(address)")

# the over-cap block (the headline) — 3_000_000 > the 2_000_000 per-tx cap:
cast call $REG "checkTransfer(address,address,uint256)(bool,bytes32)" $AGENT $NATIVE 3000000 --rpc-url $RPC
# → false  (reason decodes to OVER_TX_CAP) — over the cap, blocked pre-broadcast, zero gas
```

#### Check the live V4 yourself — the full reconciliation
Every number the dashboard reconciles against is independently readable from the live V4 (read-only, zero gas):
```bash
REG=0x8e561a5cc096af6e570220a5228b33c7d889f774
RPC=https://evmrpc-testnet.0g.ai
NATIVE=0x0000000000000000000000000000000000000001
AGENT=$(cast call $REG "agent()(address)" --rpc-url $RPC)

cast call $REG "owner()(address)"      --rpc-url $RPC   # == agent (the demo agent owns the registry)
cast call $REG "perTxCap()(uint256)"   --rpc-url $RPC   # → 2000000  (the global per-tx cap, wei)
cast call $REG "assetCap(address)(uint256)" $NATIVE --rpc-url $RPC   # → 2000000  (the native sentinel sub-cap)
cast call $REG "allowed(address)(bool)"     $NATIVE --rpc-url $RPC   # → true     (native sentinel allowlisted)
cast call $REG "periodSeconds()(uint64)"    --rpc-url $RPC   # → 3600  (leaky-bucket window, 1h)
cast call $REG "periodCap()(uint256)"       --rpc-url $RPC   # → 1500000 (leaky-bucket cap, wei)
cast call $REG "paused()(bool)"             --rpc-url $RPC   # → false

# the three by-asset gate answers the dry-run / mandate card reconcile against:
cast call $REG "checkTransfer(address,address,uint256)(bool,bytes32)" $AGENT $NATIVE 1000000 --rpc-url $RPC  # → true,  (OK)            — under cap → ALLOWED
cast call $REG "checkTransfer(address,address,uint256)(bool,bytes32)" $AGENT $NATIVE 2500000 --rpc-url $RPC  # → false, OVER_TX_CAP     — over cap → BLOCKED
cast call $REG "checkTransfer(address,address,uint256)(bool,bytes32)" $AGENT 0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E 1000000 --rpc-url $RPC  # → false, TOKEN_NOT_ALLOWED — non-allowlisted asset → BLOCKED
```

### Proof 3 — SETTLED: prove a real settlement  *(CLI + explorer)*
```bash
cargo run -p verifier -- verify-tx 0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0
# → settled   (exit 0)   — cross-check the explorer link in the Quick-look above
```

### Run the agent (dry-run) — on screen, no wallet, no broadcast
Open the **Verification Console** and click **"Run the agent (dry-run)"**:
```bash
cd web && npm install && npm run build && npx serve -l 3100 .   # then open http://localhost:3100/dashboard.html
```
It walks the full agent loop READ-ONLY — **no wallet, no signing, nothing broadcast** (the only chain access is the
same zero-gas `checkTransfer` `eth_call` as Proof 2). It plans three demo trades and gates each **per asset** against
the deployed mandate, live:
- an **allowlisted** asset (native sentinel) **under** its cap → `(true, OK)` → **ALLOWED**;
- the **same** asset **over** its cap → `(false, OVER_TX_CAP)` → **BLOCKED (over the asset's cap)**;
- a **non-allowlisted** asset (USDC.E) → `(false, TOKEN_NOT_ALLOWED)` → **BLOCKED (asset not on the allowlist)**.

The same agent gets a **different** decision per asset — the mandate is enforced **by asset**. Because a dry-run
broadcasts nothing, every leg's settlement verdict is `unverified` (never a fabricated `settled`), and the card
prints a **RUN LEDGER** in the verifier's own journal format (`{"hash","kind","claimed","observed","recorded","verdict"}`
+ the `ledger` status line) — the identical artifact a real `verifier verify-tx … --journal` + `verifier ledger`
produces. Confirm the gate answers yourself with the `cast call` from Proof 2 (vary the asset/amount).

### See the mandate, read straight from chain (the RAILS card)
On the same Verification Console, the **RAILS card is a READ-ONLY mirror of the deployed mandate registry**: a
0G chain badge, a tri-state **reconciled-vs-deployed** pill (the on-chain read is the baseline — `Reconciled`
only when the card's stated config matches the chain's own `checkTransfer` answer; `Drifted` if they disagree;
`Unverified` if the RPC is unreachable — never a faked green), a **per-asset table** (allowlist + per-tx caps;
non-allowlisted assets greyed), and a **wallet-free `checkTransfer` simulator** — pick an asset + amount and
the card runs the **same zero-gas `eth_call` as Proof 2**, rendering `ALLOWED` / `BLOCKED` / `UNVERIFIED` with
the binding on-chain reason. No wallet, no signing, no broadcast. The card now reads the consolidated
**`MandateRegistryV4`**, **LIVE on `16602`** ([`0x8e561a…f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774)); its period cap reads a live-enforced figure
(the V4 USD cap stays opt-in/off by default, labelled so). Confirm any verdict the simulator shows with the
`cast call` from Proof 2.

### Audit the ledger
```bash
cargo run -p verifier -- ledger    # the full verifier-verdict journal
cargo run -p verifier -- audit     # exits LOUD + non-zero if any defect is present (the NEG is surfaced, never hidden)
```
The ledger is generated from the verifier's append-only journal — **never from the UI** ([`LEDGER.md`](./LEDGER.md)).

---

## 🖥️ Verify it yourself, in the browser — the fullstack judge/voter guide *(zero trust, zero wallet)*

The section above is the **CLI/contract** path. This one is the **interactive** path: a judge or voter opens
the **Verification Console** (`web/dashboard.html`) and confirms *every* proof through the real UI —
**no wallet, no signing, nothing broadcast** — with each on-screen verdict **reconciled against an independent
source** the UI does not control. The console mints **no** verdict of its own; every green you see is a verdict
an independent re-read agrees with, and the one card that *can't* be confirmed yet (Brain) stays honestly
**PENDING** by construction.

### 0 — Open the console (offline, no framework, no CDN)
**Hosted (no install)** → just open **<https://aristosmesotes.github.io/proofagent-0g/dashboard.html>** — the *same* console, built from this repo by CI and served on GitHub Pages. Everything below works there too.

**Or build & serve it locally** (identical output — `tsc`, no bundler):
```bash
cd web && npm install && npm run build      # tsc → dist/dashboard.js  (dev-only: typescript; no network)
npx serve -l 3100 .                          # any static server works
# then open http://localhost:3100/dashboard.html
```
There is **no signing/broadcast surface** in the page by construction — the only chain access is the public,
key-less, zero-gas 0G Galileo read endpoint ([`https://evmrpc-testnet.0g.ai`](https://evmrpc-testnet.0g.ai)). The page paints all four cards in
their honest default states **before any network round-trip**, then enriches with live reads in the background;
the top **network pill** reads `0G Galileo ●live` only when the page's own RPC answers, or `infra-gated` (grey)
on a read failure — never a faked green.

### 1 — Verify all four proof cards (each reconciled through the real UI)
The card grid carries the four proofs. Each card shows a three-altitude verdict block **and** a
*"reconciled vs an independent source"* badge — the badge greens **only** when an independent re-read agrees
with the painted verdict, never from the UI's own state. The **at-a-glance rollup strip** above the grid
narrates the aggregate (`N reconciled · 1 pending(brain) · 0 mismatch`) and is the green face **only** when
every confirmable card has reconciled with zero mismatch.

| Card | Click | On-screen verdict | Reconciled against (independent source) |
|---|---|---|---|
| **NEG — refuse a fabricated tx** | *Run the NEG case → expect UNVERIFIED* | **`UNVERIFIED`** (amber) | the verifier's published `adjudicate` rule, re-derived from scratch on the same fabricated hash — there is **deliberately no code path to `settled`** here |
| **BRAIN — which model ran (0G Compute TEE)** | *(status card — no button)* | **`PENDING / Phase-2 (Depth)`** (amber) | **none yet** — the badge is permanently `awaiting real attestation`; it can **never** green here (the flip is operator-gated on a real enclave attestation, §1h of the [evidence](./docs/PROOFAGENT_0G_EVIDENCE.md)) |
| **RAILS — it cannot overspend** | *(self-enriches; or use the simulator)* | reconcile pill **`Reconciled`** / **`Drifted`** / **`Unverified`** + per-pick **`ALLOWED`/`BLOCKED`/`UNVERIFIED`** | the deployed `MandateRegistry`'s own `checkTransfer` `eth_call` (the chain is the baseline, never the UI) |
| **SETTLEMENT — the trade really happened** | *Check on-chain → expect SETTLED* | **`SETTLED`** (green) | a second, independent re-fetch of the pinned tx's receipt + value, re-running `adjudicate` in the open |

**The honesty you can see:** only `settled` / `live` renders green. **NEG** can only ever be `UNVERIFIED`;
**BRAIN** is never green here; **RAILS** frames the on-chain block (`OVER_TX_CAP`) as the system *working*; and
an unreachable RPC degrades **loudly** (`read-error`, grey, *source unavailable — infra-gated*) — never a faked
green. Open **"raw evidence ↗"** on any card to read the exact raw reads, the calldata, the reconciliation log,
and a copy-safe `cast`/`verify-tx` command to reproduce that card's verdict yourself.

### 2 — Use the paste-any-hash Playground (test the claim with YOUR hash)
Scroll to **Playground — paste ANY 0G tx hash**. Paste any `0x + 64 hex` 0G transaction hash and click
**Check**. The **same** verifier pipeline that backs the SETTLEMENT card reads 0G independently and stamps a
verdict live — narrating each wait state (*validating → fetching receipt → cross-checking chain → confirmed*)
and showing **claimed vs observed side by side** (the cross-check **is** the verdict, never a bare checkmark):
- a **real, in-corpus** settlement → `SETTLED` (green) — e.g. paste `0x8c59…bfb0` from the Quick-look;
- a **fabricated / off-record** hash → `UNVERIFIED` (a pasted hash has no recorded claim, so the only reachable
  verdicts are `unverified` / `mismatch` / `hollow` — there is **no** path to a fabricated `settled`);
- a **malformed** input → a loud **usage error**, *not* a verdict (no `data-verdict` is minted — the absence is
  the honest signal);
- an **unreachable** RPC → `READ-ERROR (infra-gated)`, never a faked pass.
Every produced verdict is reconciled by an independent re-read (the badge), appended to the **live verdict
feed**, and reproducible from the verbatim `verify-tx(<hash>) → …` line.

### 3 — Use "Run the agent (dry-run)" — read the run LEDGER, watch the per-asset rail fire
Find the **"Run the agent (dry-run)"** card and click *Run the agent (dry-run) → gate 3 intents, project the run
ledger*. It walks the **full agent loop READ-ONLY** — **NO wallet, NO signing, NOTHING broadcast** (the only
chain access is the same key-less, zero-gas `checkTransfer` `eth_call` behind RAILS) — and gates three demo
intents **per asset** against the deployed mandate, live and reconciled:

| Intent (the *same* agent) | asset | amount | on-chain `(ok, reason)` | dry-run decision |
|---|---|---|---|---|
| under-cap, allowlisted | native sentinel `0x00…0001` | `1_000_000` | `(true, OK)` | **ALLOWED** |
| over its cap, same asset | native sentinel `0x00…0001` | `3_000_000` | `(false, OVER_TX_CAP)` | **BLOCKED — over the asset's cap** |
| non-allowlisted asset | USDC.E [`0x1f3AA82…473E`](https://chainscan-galileo.0g.ai/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E) | `1_000_000` | `(false, TOKEN_NOT_ALLOWED)` | **BLOCKED — asset not on the allowlist** |

**Watch the mandate rail fire per asset:** the same agent gets a *different* decision per asset — the gate is
enforced **by asset**, and each leg's decision is reconciled against an independent re-read of the same gate.
Because a dry-run broadcasts nothing, every leg's settlement verdict is **`unverified`** (never a fabricated
`settled`), and the card prints a **RUN LEDGER** in the verifier's **own** journal format — one canonical JSONL
record per leg (`{"hash","kind","claimed","observed","recorded","verdict"}`, byte-identical to
`verifier/src/journal.rs`) plus the `verifier ledger` status line `DEFECTS … 3 unverified`. It is the **identical
artifact** a real `verifier verify-tx … --journal` + `verifier ledger` produces — an all-`unverified` dry-run is
**NOT** green, and `audit` over it would exit `1`. Confirm any leg yourself with the `cast call` from Proof 2
(vary the asset / amount).

### 4 — Read the mandate card (per-asset rules + the wallet-free checkTransfer sim)
The **RAILS card is the deployed mandate, read straight from chain** — a READ-ONLY mirror of the deployed,
LIVE `MandateRegistryV4` ([`0x8e561a…f774`](https://chainscan-galileo.0g.ai/address/0x8e561a5cc096af6e570220a5228b33c7d889f774) on `16602`; still one of the four cards, not a fifth). Top to bottom it shows:
- a **0G chain badge** + the tri-state **reconciled-vs-deployed pill** (the chain's own `checkTransfer` answer is
  the baseline: `Reconciled` green when the stated config matches it · `Drifted` loud if they disagree ·
  `Unverified` grey if the RPC is unreachable — never a faked green);
- a **global period/USD-cap bar** carrying the consolidated **`MandateRegistryV4`**, now **LIVE +
  tier-configured on-chain** (`[mandate_v4].address=0x8e561a…f774`; `setPeriodConfig(3600, 1_500_000)`
  confirmed), so its period figure reads **live (V4)** (the V4 USD cap stays opt-in/off by default, labelled
  so — never a number the bar does not read);
- a **per-asset table** — one row per asset (allowlist state · symbol · address · decimals · per-tx cap by the
  asset's decimals); a non-allowlisted asset is greyed with a `—` cap (default-deny);
- a **wallet-free `checkTransfer` simulator** — pick an asset + amount → a real zero-gas `eth_call` →
  **`ALLOWED` / `BLOCKED` / `UNVERIFIED`** naming the binding on-chain reason. **No wallet, no signing, no
  broadcast.** A usage error (non-numeric / money-truncating amount) mints **no** verdict; an unreachable RPC
  shows `UNVERIFIED`, never a faked allow.

Confirm any simulator verdict with the `cast call` from Proof 2 — the on-chain answer the card paints is
byte-identically re-derivable.

### 5 — *(optional)* How the headless live fullstack run works — no human in the loop
All three published proofs (NEG · RAILS · SETTLED) are **also driven *through* this same real UI under headless
automation, zero human input** — the **fullstack-target** leg (gate #10 in the
[evidence](./docs/PROOFAGENT_0G_EVIDENCE.md) §1g). A headless browser scrolls each real control into view,
screenshots BEFORE, clicks it with a user gesture, polls the durable DOM `data-verdict` stamp to a terminal
value, screenshots AFTER, then **reconciles** each on-screen verdict against its independent source: the Rust
verifier `verify-tx` for NEG (`unverified`) + SETTLED (`settled`), and an independent `eth_call` of the deployed
`checkTransfer` over-cap probe for RAILS (`OVER_TX_CAP`). `settled` is the only green verdict and PASSes **only**
when the independent source also confirms `settled`; a **doctored** UI fabricating `settled` is caught LOUD
(exit 1), and a proof whose independent source is unreachable is honestly **infra-gated**, never faked into a
PASS. The harness + screenshots live out-of-tree so this public repo stays clean — what you can confirm here is
that the *same* affordances you click by hand are the ones the automation drives, and that what they render is
exactly what the chain/verifier independently re-derive.

### What stays honest (the scope you can hold us to)
- **Brain stays PENDING.** The brain stamp goes green **only** on a real, verified 0G Compute **TEE
  attestation** (a `trusted` provider-service attestation **AND** a verified per-response enclave signature —
  never the model's words). The live broker call needs a funded 0G Compute sub-account + a TEE provider, so it
  is **operator-gated**; the default build keeps the stamp PENDING. We never fabricate an attestation.
- **The dry-run is a dry-run.** Nothing is signed or broadcast; the only chain access is the **read-only**
  `checkTransfer` `eth_call` (a real, zero-gas read). Every dry-run leg settles to `unverified` by construction.
- **`MandateRegistryV4` is now LIVE.** The consolidated, hardened gate is deployed + tier-configured on 0G
  Galileo `16602` (`[mandate_v4].address=0x8e561a…f774`), so the per-asset gate + the period cap the dashboard
  reconciles against are live-enforced figures, independently readable from chain (Proof 2). The V4 USD cap
  stays opt-in/off by default, labelled so — never a number the card does not read. The MVP MandateRegistry +
  the four-tier V3 remain on-chain as historical provenance, superseded by V4 as the pinned mandate.
- **Nothing is faked green.** Every on-screen verdict is reconciled against an independent source; an
  unreachable source shows an honest `infra-gated` / `Unverified`, never a coerced pass.

---

## Honest scope (we claim only what's live)
- **All three proofs — NEG, RAILS, SETTLED — are now driven *through* the real web UI** under headless automation (zero human input), and each on-screen `data-verdict` is reconciled against an independent second source: the Rust verifier `verify-tx` for **NEG** (`unverified`) and **SETTLED** (`settled`), and an independent `eth_call` of the deployed `checkTransfer` over-cap probe for **RAILS** (`OVER_TX_CAP`).
- The UI is still **never trusted**: **RAILS** and **SETTLED** remain independently verifiable *below* the UI too (contract `checkTransfer` / verifier `verify-tx`, the buttons above) — the UI leg adds the reconciled on-screen rendering, it does not replace the chain/CLI ground truth. `settled` is the only green verdict and passes ONLY when the independent source also confirms `settled`; a fabricated `settled` on either side is a loud failure, and a proof whose independent source is unreachable is honestly infra-gated, never faked.
- This formal three-proof fullstack target (the next-milestone upgrade) is now done; its per-proof before/after screenshots + reconciliation journal are the evidence behind gate #10 in [`docs/PROOFAGENT_0G_EVIDENCE.md`](./docs/PROOFAGENT_0G_EVIDENCE.md) §1g.

## Learn more
[`docs/PROOFAGENT_0G_DESIGN.md`](./docs/PROOFAGENT_0G_DESIGN.md) — architecture · [`docs/PROOFAGENT_0G_EVIDENCE.md`](./docs/PROOFAGENT_0G_EVIDENCE.md) — the feature→proof matrix + gate results · [`LEDGER.md`](./LEDGER.md) — the settlement truth.
