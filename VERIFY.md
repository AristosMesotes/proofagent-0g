# ProofAgent-0G — See it, check it, verify it yourself

**The AI agent that can't lie, and can't overspend — on 0G.** This page is for anyone: a judge, a voter, or a developer. It explains what the project is in 30 seconds, lets you **check the proofs on-chain with nothing installed**, and gives the full hands-on reproduction steps. The whole point of the project is that you don't have to trust us — you check the chain.

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

1. **Watch the 2-minute demo** → the [`demo` release](../../releases/tag/demo) (master cut + a 30s short).
2. **Check the chain yourself** — these are **real transactions** on the public 0G-Galileo explorer. Click and look:
   - ✅ **A real settlement** → [`0x8c59…bfb0`](https://chainscan-galileo.0g.ai/tx/0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0) — should read **Success**, value **1,000,000 wei**, block 39,996,100.
   - 🟡 **The live mandate contract** → [`0x675FF5…D345`](https://chainscan-galileo.0g.ai/address/0x675FF5053F434AA3f1d48574813BFc1696FBD345).

The demo video *shows* the commands; these explorer pages are **the chain proving them**. No setup, no trust required.

---

## 🛠️ Verify it yourself — hands-on *(for technical judges & developers)*
Read-only — **no private key or funds needed.**

**Prerequisites:** Rust/`cargo`, Node 18+, a browser (optional Foundry `cast` for the mandate check).
```bash
git clone https://github.com/AristosMesotes/proofagent-0g && cd proofagent-0g
```
Network: 0G-Galileo testnet `16602` · RPC `https://evmrpc-testnet.0g.ai` · explorer `https://chainscan-galileo.0g.ai`.

### Proof 1 — NEG: it can't lie  *(CLI **and** UI)*
```bash
cargo run -p verifier -- verify-tx 0xdeadbeef00000000000000000000000000000000000000000000000000000000
# → unverified   (exit 1)   — a transaction that never happened; it refuses to confirm it
```
**On screen too:** `cd web && npm install && npm run build && npx serve -l 3100 .` → open `http://localhost:3100` → click **"Run the NEG case"** → the page stamps **`UNVERIFIED`**. It must equal the CLI verdict — the UI is never trusted; the verifier re-derives it from the chain.

### Proof 2 — RAILS: it can't overspend  *(contract)*
```bash
cast call 0x675FF5053F434AA3f1d48574813BFc1696FBD345 \
  "checkTransfer(address,address,uint256)(bool,bytes32)" \
  0xc7Af61A1399Aca0bee648D7853AE93f96B86866a \
  0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE \
  3000000 --rpc-url https://evmrpc-testnet.0g.ai
# → false  (reason decodes to OVER_TX_CAP) — over the cap, blocked pre-broadcast, zero gas
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
the binding on-chain reason. No wallet, no signing, no broadcast. The consolidated **`MandateRegistryV4`**
USD/period cap is shown as **built-not-deployed** (its deploy is operator-gated), labelled honestly — never as
a live-enforced number. Confirm any verdict the simulator shows with the `cast call` from Proof 2.

### Audit the ledger
```bash
cargo run -p verifier -- ledger    # the full verifier-verdict journal
cargo run -p verifier -- audit     # exits LOUD + non-zero if any defect is present (the NEG is surfaced, never hidden)
```
The ledger is generated from the verifier's append-only journal — **never from the UI** ([`LEDGER.md`](./LEDGER.md)).

---

## Honest scope (we claim only what's live)
- **All three proofs — NEG, RAILS, SETTLED — are now driven *through* the real web UI** under headless automation (zero human input), and each on-screen `data-verdict` is reconciled against an independent second source: the Rust verifier `verify-tx` for **NEG** (`unverified`) and **SETTLED** (`settled`), and an independent `eth_call` of the deployed `checkTransfer` over-cap probe for **RAILS** (`OVER_TX_CAP`).
- The UI is still **never trusted**: **RAILS** and **SETTLED** remain independently verifiable *below* the UI too (contract `checkTransfer` / verifier `verify-tx`, the buttons above) — the UI leg adds the reconciled on-screen rendering, it does not replace the chain/CLI ground truth. `settled` is the only green verdict and passes ONLY when the independent source also confirms `settled`; a fabricated `settled` on either side is a loud failure, and a proof whose independent source is unreachable is honestly infra-gated, never faked.
- This formal three-proof fullstack target (the next-milestone upgrade) is now done; its per-proof before/after screenshots + reconciliation journal are the evidence behind gate #10 in [`docs/PROOFAGENT_0G_EVIDENCE.md`](./docs/PROOFAGENT_0G_EVIDENCE.md) §1g.

## Learn more
[`docs/PROOFAGENT_0G_DESIGN.md`](./docs/PROOFAGENT_0G_DESIGN.md) — architecture · [`docs/PROOFAGENT_0G_EVIDENCE.md`](./docs/PROOFAGENT_0G_EVIDENCE.md) — the feature→proof matrix + gate results · [`LEDGER.md`](./LEDGER.md) — the settlement truth.
