# web/ -- the thin demo UI

Two static screens (design §4):

- **`index.html`** -- the original thin proof page: the **three honest proof stamps** + **three driveable
  controls** -- the **NEG case** and two READ-ONLY on-chain checks (**RAILS** + **SETTLED**), so the headless
  harness can drive all three proofs through the real UI (loads `dist/main.js`).
- **`dashboard.html`** -- the interactive **Verification Console**: the four proof cards (NEG · BRAIN · RAILS ·
  SETTLEMENT) — with **RAILS expanded into a read-only mirror of the deployed MandateRegistry** (a 0G chain
  badge + a tri-state reconciled-vs-deployed pill + a per-asset table + a wallet-free `checkTransfer`
  simulator) — + the paste-any-hash **Playground** + the **"Run the agent (dry-run)"** card + the live verdict
  feed + the evidence drawer (loads `dist/dashboard.js`). It opens on the **"every layer on 0G"** strip
  (0G Compute · 0G Chain · 0G Storage) and adds the vote-lever self-serve hooks — a 1-click **"▶ watch it
  refuse a lie"** (auto-runs the NEG case), a zero-typing **real-vs-fake** rail (a real settlement → `settled`
  vs a fabricated hash → `unverified`), the **Tier-2 "run it with YOUR wallet"** card (connect your own wallet
  and run the same mandate gate with your own key — the console never sees it), and a read-only **wallet watch**
  (the agent's live 0G balance + nonce, key-free). The console mounts dynamically; it adds no new trust
  surface -- every verdict it paints is reconciled against an independent source, and only `settled`/`live` is
  green.

> **Judge/voter walkthrough.** The step-by-step, zero-trust, zero-wallet guide to confirming **every** proof
> through this console — the four cards, the Playground, the dry-run RUN LEDGER, the mandate card, and how the
> headless run drives the same controls — is in the repo-root **`VERIFY.md`** ("Verify it yourself,
> in the browser").

| Stamp | What it shows | Honesty (design §7/§8) |
|---|---|---|
| **Brain** | which model ran | `PENDING / Phase-2` in the **default offline build** -- 0G Compute TEE attestation is the *Depth* bracket. The stamp lifts to a green `LIVE / TEE-attested` ONLY when `buildStamps(brain)` is handed a real verified attestation (`attested === true`) -- a `trusted` provider-service attestation AND a verified per-response enclave signature, neither from the model's words. The brain leg itself is built + offline-tested in the agent (`agent/src/zerog/compute.ts`); the live broker call is **operator-gated** (a funded 0G Compute sub-account + a TEE provider), so by default this stamp is **PENDING until one live verified attestation**. |
| **Rails** | it cannot overspend | the on-chain per-tx cap, enforced pre-broadcast. Now `LIVE` (with an explorer link): the consolidated **`MandateRegistryV4`** address is pinned on-chain (`0x8e561a…f774` on 16602). |
| **Settlement** | the trade really happened | the independent verifier's verdict. Asserts **no** `settled` while the corpus is empty; the live, runnable proof is the **NEG case**. |

## The three driveable controls (each stamps `data-verdict` for the harness)

Each control's output container carries a `data-verdict` attribute the headless harness reads and then
**reconciles independently** against the verifier/contract. All three are honest: the NEG case mints no
`settled`; the on-chain checks are **READ-ONLY** (no key, no broadcast) and render only a verdict that is
re-derivable from the raw chain reply.

| Control | Button id / output id | On-chain read (read-only) | `data-verdict` when run |
|---|---|---|---|
| **NEG** | `#neg-run` / `#neg-output` | none (off-record fabricated hash, in-page rule) | `unverified` |
| **RAILS** | `#rails-run` / `#rails-output` | `eth_call MandateRegistry.checkTransfer(agent, native, OVER-cap)` | `OVER_TX_CAP` (blocked) |
| **SETTLED** | `#settled-run` / `#settled-output` | `eth_getTransactionReceipt` + `eth_getTransactionByHash` of the pinned tx | `settled` (status 0x1 + value in band) |

`data-verdict` lifecycle on each output: absent (not yet run) -> `pending` (read in flight) -> the verdict
above on success, or `read-error` if the read failed (a loud degrade -- **never** a stale/fabricated
verdict). `settled` is the only green render; everything else renders amber.

**The NEG case** (design §2): the button points the verifier's published adjudication rule at a
*fabricated* transaction hash. Off-record -> no observation -> `adjudicate(_, None, _)` -> **`UNVERIFIED`**.
It can only ever produce `unverified` (never a fabricated `settled`), and it prints the exact CLI command
to reproduce the verdict against the real independent Rust verifier.

**The RAILS check** (design §2 Rails): a key-less, zero-gas `eth_call` of the deployed, LIVE
`MandateRegistryV4` on 0G Galileo (16602, `0x8e561a…f774`), asking
`checkTransfer(agent, native-sentinel `0x..0001`, 3_000_000 wei)` -- strictly above the `2_000_000` per-tx
cap. The chain answers `(false, OVER_TX_CAP)` **before any broadcast**; the page decodes that on-chain reason
word into `data-verdict="OVER_TX_CAP"`. Re-derive it: replay the same `eth_call` and decode the second
32-byte word (`cast call 0x8e561a5cc096af6e570220a5228b33c7d889f774 "checkTransfer(address,address,uint256)(bool,bytes32)" …`).

**The SETTLED check** (design §2 Settlement): a key-less read of the **pinned** settled tx
(`[[verifier.corpus]]` / `demo/EVIDENCE.md` PROOF 1) -- `eth_getTransactionReceipt` (`status 0x1`) +
`eth_getTransactionByHash` (native `value`). The page recomputes the verifier's published
`adjudicate(claimed, observed)` in the open -> `data-verdict="settled"`. An off-record / failed / unreadable
read degrades **loudly** (`unverified`/`mismatch`), never a fabricated `settled`. Re-derive it: fetch the
same receipt + value and rerun the adjudication (or `verify-tx` against the independent Rust verifier).

Both on-chain controls read the public 0G Galileo endpoint ([`https://evmrpc-testnet.0g.ai`](https://evmrpc-testnet.0g.ai)) and link the
public testnet explorer ([`https://chainscan-galileo.0g.ai`](https://chainscan-galileo.0g.ai)); the RPC URL is read at run time, never a
private endpoint, and there is **no signing/broadcast surface** in the read transport by construction.

## The "Run the agent (dry-run)" card (dashboard only — design §5 the loop · §6 the run ledger)

The Verification Console adds a **"Run the agent (dry-run)"** affordance (`web/src/dryrun.ts` +
`web/src/dryrunView.ts`) that walks the **full agent function** READ-ONLY: **NO wallet, NO signing, NOTHING
broadcast**. The only chain access is the SAME key-less, zero-gas `checkTransfer` `eth_call` the RAILS proof
uses. It runs the loop `plan → mandate-gate (per asset) → verify` (mirroring the agent's own dry-run loop in
`agent/src/loop.ts`, which broadcasts nothing) and produces a **RUN LEDGER**:

1. **plan** — three deterministic demo intents over ONE agent that EXERCISE the mandate **per asset**:
   an under-cap trade on the allowlisted native asset, an over-cap trade on the SAME asset, and a trade on a
   **non-allowlisted** asset (the public USDC.E).
2. **mandate-gate (BY ASSET)** — each intent is gated by a real read-only `checkTransfer(agent, token, amount)`
   against the deployed `MandateRegistry`, reusing `runMandateCheck` (no copy). The deployed registry answers,
   live and reconciled against an independent re-read:

   | Intent (same agent) | asset | amount | on-chain `(ok, reason)` | dry-run decision |
   |---|---|---|---|---|
   | under-cap, allowed asset | native sentinel `0x00…0001` | `1_000_000` | `(true, OK)` | **ALLOWED** |
   | over its per-asset cap, allowed asset | native sentinel `0x00…0001` | `3_000_000` | `(false, OVER_TX_CAP)` | **BLOCKED — over the asset's cap** |
   | non-allowlisted asset | USDC.E `0x1f3AA82…473E` | `1_000_000` | `(false, TOKEN_NOT_ALLOWED)` | **BLOCKED — asset not on the allowlist** |

   Same agent → three **different** gate decisions: the mandate is enforced **per asset**. (For the native
   sentinel the per-asset sub-cap equals the global per-tx cap (both `2_000_000`), so the over-cap block
   surfaces as the first-failing rung `OVER_TX_CAP` — the honest on-chain answer, never relabelled.)
3. **verify** — a dry-run broadcasts nothing, so there is **no observation** → the verifier's published rule
   stamps **`unverified`** for every leg (the keystone — never a fabricated `settled`), exactly as the agent
   loop honestly skips the verify leg in a dry-run.

**RESULT — the RUN LEDGER.** The run produces an append-only journal of each leg + verdict in the verifier's
**OWN** canonical format — one JSONL record per leg, byte-identical to `verifier/src/journal.rs` `to_line()`
(`{"hash","kind","claimed","observed","recorded","verdict"}`) — plus the `verifier ledger` projection's
status-at-a-glance (the `verifier/src/ledger.rs` `LedgerSummary::status_line()` format). A judge sees the
**identical artifact** a real `verifier verify-tx … --journal` + `verifier ledger` run produces. A dry-run leg
has no real broadcast hash, so its journal `hash` is an honest, clearly-tagged `dryrun:`-prefixed synthetic
(never mistakable for a real `0x` tx hash) and its `observed` is JSON `null` (the loud absence — never a
fabricated `0`). The status line reads `DEFECTS … 3 unverified` honestly — an all-`unverified` dry-run is
**NOT green**, and `audit` would surface those rows loud (exit 1).

## The RAILS card, EXPANDED — the mandate-registry mirror (dashboard only — design §4.2 · §10.4b)

On the Verification Console the **RAILS card is expanded** into a full READ-ONLY mirror of the **deployed
MandateRegistry** (`web/src/mandateCard.ts`). The dashboard still shows **four** cards — this is the RAILS
card, not a fifth. It reuses the same read-only `RpcTransport` + `runRailsCheck` / `runMandateCheck` /
`decodeCheckTransfer` the proofs already read through (no new broadcast surface), and lays out, top to bottom:

- **Header** — the title + a **0G monogram chain badge** (0G has no branded glyph, so a clean-room monogram
  tile + the chain id) + a tri-state **RECONCILED-vs-deployed pill** (`Reconciled` · `Drifted` · `Unverified`).
  The on-chain read is the **baseline**: the card's stated config is reconciled against what `checkTransfer`
  actually answers on-chain (the two-source doctrine — the chain is the arbiter, never the UI). `Reconciled`
  is the only green face; a disagreement is a **loud** `Drifted`; an unreachable RPC is an honest `Unverified`
  (grey), never a faked green.
- **Global period-cap bar** — the consolidated **`MandateRegistryV4`** rolling-window cap (used fraction +
  reset countdown). V4 is now **LIVE + tier-configured on-chain** (`[mandate_v4].address=0x8e561a…f774`;
  `setPeriodConfig(3600, 1_500_000)` confirmed on-chain), so the bar reads a **live (V4)** figure with
  `0 used` (honest — no demo spend has accrued against the live bucket yet); the V4 USD cap stays opt-in/off
  by default, labelled so — never a number the bar does not read.
- **Per-asset table** — one row per asset: a state dot (allowed/blocked) · symbol · truncated address ·
  decimals · per-tx cap (formatted by the asset's decimals). A **blocked** (non-allowlisted) row is greyed
  with a `—` cap (the default-deny). The table body scrolls inside a fixed cap so a long allowlist never blows
  the card height.
- **Wallet-free `checkTransfer` simulator** — an asset dropdown + an amount field → a **real READ-ONLY
  `eth_call`** of `checkTransfer(agent, asset, amount)` against the deployed registry. The decoded on-chain
  `(ok, reason)` becomes a tri-state verdict **`ALLOWED` / `BLOCKED` / `UNVERIFIED`** that spells out the
  binding reason. **No wallet, no signing, no broadcast** — a zero-gas read. A usage error (a non-numeric or
  money-truncating amount) mints **no** verdict; an unreachable RPC shows `UNVERIFIED`, never a faked allow.
- **Footer** — *"Read independently from chain — not the agent's UI."*

The chain context is threaded as one `{chainId, registryAddress, …}` **context object** (`MANDATE_CARD` in
`web/src/spine.ts`), so bringing the consolidated V4 registry live WAS a **data change** (the context was
repointed to `0x8e561a…f774` when V4's deploy landed),
**not** a card redesign. By-chain is the single **0G** badge only — one enforcement chain (proven by
`scripts/0g_only_gate.ps1`); there is deliberately **no chain selector**.

## Build & run (offline, no framework, no CDN)

> **Hosted, no install:** the console is live at
> **<https://aristosmesotes.github.io/proofagent-0g/dashboard.html>** — built from this directory by CI
> (`.github/workflows/pages.yml`) and served on GitHub Pages. The steps below build the *same* output locally.

```bash
cd web
npm install            # dev-only: typescript (offline if cached)
npm run build          # tsc -> dist/main.js + dist/proofs.js
npm test               # tsc + node --test (the honesty invariants)
# then open index.html in a browser (it loads dist/main.js as an ES module)
```

`npm run build` emits plain ESM into `dist/`; `index.html` loads `dist/main.js` via
`<script type="module">`. No bundler and no network are required.

## Honesty (design §3, §8)

The UI mints **no** verdict (the verdict monopoly belongs to the verifier) and fabricates **no** success.
Every constant mirrors the public data spine `proofagent.toml`; the brain stamp is **never green by default**
and lifts to green ONLY on a real verified TEE attestation (`attested === true`), never on the mere presence
of a verdict; the NEG case is faithful to `verifier/src/adjudicate.rs` (off-record -> `unverified`).
