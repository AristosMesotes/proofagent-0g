# ProofAgent-0G — verifier-verdict LEDGER (the FULL verdict surface)

> **The ledger IS the truth.** This file is *generated from the verifier's append-only verdict journal*
> (`demo/proofagent.demo.journal`), not from the agent's report and not from any UI. The agent's word is a
> **claim** (kept in §6, never trusted); the chain read is the **observation**; the verifier `adjudicate`s
> the two and journals the verdict. This ledger carries the **full verifier-verdict surface** — not
> settlement alone:
>
> - **§1 settlement** — `settled / hollow / mismatch / unverified`
> - **§2 money-safety** — gas-floor + net-worth: `confirmed / refuted / unverified`
> - **§3 cross-chain** — time-lock + per-spoke isolation: `confirmed / refuted / unverified`
> - **§4 mandate-gate decisions** — per-tier `TierVerdict`: `confirmed / refuted / unverified`
> - **§5 the I14-R reconciler** — `reconciled / refuted / unverified`
> - **§6 agent claims** — RAILS / Brain, kept strictly separate from the chain-truth
>
> **Every verdict type is one `pub(crate)` monopoly**, each `#[non_exhaustive]`, no `Default`, so an absent
> read can only become a loud `unverified` — never a fabricated success. Regenerate with the verifier
> itself, never by hand:
>
> ```bash
> # mint + journal each live SETTLEMENT verdict (the two genuine settlements + the NEG), then project + audit:
> verifier verify-tx 0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0 --journal demo/proofagent.demo.journal
> verifier verify-tx 0xfb18bfc1a3a12b78843549f0023ccca62746513036e54523ab8d23aaf04f6290 --journal demo/proofagent.demo.journal
> verifier verify-tx 0x424962775526f9783a2781daebefcb799168e624c54ce5bd055bb262caf8b4b6 --journal demo/proofagent.demo.journal  # fresh live spend (block 40232225)
> verifier verify-tx 0xdeadbeef00000000000000000000000000000000000000000000000000000000 --journal demo/proofagent.demo.journal
> verifier ledger --journal demo/proofagent.demo.journal     # §1 + §2 settlement projection
> verifier audit  --journal demo/proofagent.demo.journal     # surfaces the NEG row LOUDLY (exit 1)
> # the money-safety / cross-chain / mandate-tier / reconciler verdicts (§2–§5) are minted by the
> # corresponding adjudicators over the offline tapes (gasfloor.rs / networth.rs / timelock.rs /
> # mandate.rs / reconciler.rs); the live eth_call / eth_getBalance reads are feature-gated + operator-gated.
> ```

| | |
|---|---|
| **Chain** | 0G Galileo testnet — chain id `16602` |
| **Explorer** | [`https://chainscan-galileo.0g.ai`](https://chainscan-galileo.0g.ai) |
| **Tolerance band** | exact-integer `15/100` (`proofagent.toml [verifier.tolerance]`) — no float on the money path |
| **Source of truth** | the verifier's append-only verdict journal (`demo/proofagent.demo.journal`) — read independently, never the UI |
| **Doctrine** | zero-loss · two-source truth · never-fabricate · verdict monopoly (design §3 #1/#2/#3, §6, §13) |

---

## §0 — The mandate's on-chain transactions (smart-contract provenance)

The spend-gate **`MandateRegistryV4`** (`0x8e561a…f774`) and its tier configuration are real, confirmable
transactions on 0G Galileo testnet (chain `16602`). The contract is **advisory + non-custodial** — it holds
no funds — so these are the gate's *setup* transactions; each is a Success (`status 0x1`) you can open on the
explorer. (Provenance, read from the committed broadcast receipts / `proofagent.toml`, distinct from the
verifier-minted verdicts in §1–§5.)

| Block | Smart-contract call | Transaction | Status |
|---|---|---|---|
| 40,213,222 | **deploy** `MandateRegistryV4` → `0x8e561a…f774` | [`0xd88d8a49…58db50`](https://chainscan-galileo.0g.ai/tx/0xd88d8a4959a122289a6c26101f13ab6420e61952043210d8c361d58d0f58db50) | ✅ Success |
| (same broadcast) | `addAllowedAsset(NATIVE, 2_000_000, 18)` | [`0xbb316c95…3998f25`](https://chainscan-galileo.0g.ai/tx/0xbb316c959e13f56c396e715e212d1384b2a53a555902fe150ed7acb573998f25) | ✅ Success |
| (same broadcast) | `setPeriodConfig(3600, 1_500_000)` | [`0xa04c95df…20df8ed`](https://chainscan-galileo.0g.ai/tx/0xa04c95df4f18804cc3730211212a01eb96a704d53f3401fa316e4fd2520df8ed) | ✅ Success |
| (same broadcast) | `setParamDelay(86400)` | [`0x833120f8…b0cd3d51`](https://chainscan-galileo.0g.ai/tx/0x833120f8a5639a9e1d3bed168ccafb05fce5d6d967f06976aa574e13b0cd3d51) | ✅ Success |

The agent's **V4-gated spends** read this live contract via a zero-gas `eth_call checkTransfer(agent, token,
amount)` **before** broadcast (under-cap → `(true, OK)`; over-cap → `(false, OVER_TX_CAP)`; non-allowlisted →
`(false, TOKEN_NOT_ALLOWED)`), and the verifier independently confirms each authorized settlement on-chain (§1).

---

## §1 — Settlement verdicts (chain-observed; `settled / hollow / mismatch / unverified`)

Each row is one journalled settlement verdict. **Amount** is in minor units (wei). A verdict is minted only
by the verifier from an *independent* on-chain read (`eth_getTransactionReceipt → status`, then
`eth_getTransactionByHash → value`) adjudicated against the claim. A `settled` row means the chain confirmed
the money moved exactly as claimed (Δ within band). The `unverified` row is the **NEG case**: a fabricated
hash the verifier refuses to rubber-stamp. (Verdict type: `verifier/src/verdict.rs` `enum Verdict`.)

| Date | Chain | Kind | Token | Amount (claimed / observed, wei) | Verdict | Settlement-link |
|---|---|---|---|---|---|---|
| 2026-06-22 (block 39996100) | 0G Galileo `16602` | TRANSFER | native 0G (wei) | `1000000` / `1000000` (Δ `0`) | **`settled`** ✅ | [0x8c59…bfb0](https://chainscan-galileo.0g.ai/tx/0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0) |
| 2026-06-22 (block 39996470) | 0G Galileo `16602` | TRANSFER | native 0G (wei) | `1000000` / `1000000` (Δ `0`) | **`settled`** ✅ | [0xfb18…6290](https://chainscan-galileo.0g.ai/tx/0xfb18bfc1a3a12b78843549f0023ccca62746513036e54523ab8d23aaf04f6290) |
| 2026-06-23 (block 40232225) | 0G Galileo `16602` | TRANSFER | native 0G (wei) | `1000000` / `1000000` (Δ `0`) | **`settled`** ✅ | [0x4249…b4b6](https://chainscan-galileo.0g.ai/tx/0x424962775526f9783a2781daebefcb799168e624c54ce5bd055bb262caf8b4b6) — **fresh live spend**, V4-gate-authorized then independently verified |
| — (no on-chain record) | 0G Galileo `16602` | unknown | — | claimed `0` / observed `unavailable` (Δ `unavailable`) | **`unverified`** 🛑 (NEG) | [0xdead…0000](https://chainscan-galileo.0g.ai/tx/0xdeadbeef00000000000000000000000000000000000000000000000000000000) — *no receipt; the verifier reads `null` and degrades LOUDLY* |

**Settlement summary (from the journal):**

```
ledger --journal demo/proofagent.demo.journal
DEFECTS -- 4 verdict(s): 3 settled / 0 hollow / 0 mismatch / 1 unverified (1 defect(s))
```

| Verdict | Count | Meaning |
|---|---|---|
| `settled` | **3** | chain-confirmed the money moved exactly as claimed (Δ within the 15% band) — incl. the fresh live spend `0x4249…b4b6` (block 40,232,225) |
| `hollow` | 0 | on-record but moved nothing (no economic effect) |
| `mismatch` | 0 | chain disagreed with the claim beyond tolerance |
| `unverified` | **1** | the deliberate **NEG** case (fabricated hash → loud degrade) |

> **Why the NEG row is in the truth table, not hidden.** Design §3 #3 (never fabricate): an off-record /
> unreadable hash degrades *loudly* to `unverified` — never silently a `settled`. The `audit` surfaces this
> row as a defect on purpose (`audit RED`, exit `1`); it is the hero invariant on screen, not a loss.
> `Δ` (delta) is the exact-integer `claimed − observed` in minor units; `unavailable` when the chain could
> not be read (never a fabricated `0`).

---

## §2 — Money-safety verdicts (gas-floor + net-worth; `confirmed / refuted / unverified`)

The asset cap bounds how much of an *asset* moves; two subtler depletions slip past it. Each money-safety
guard is a pre-broadcast kill-switch the verifier then **independently confirms** from its OWN chain read —
the agent's "still above the floor" is a *claim*, never an input to the verdict. (Verdict types:
`verifier/src/gasfloor.rs` `enum GasFloorVerdict`; `verifier/src/networth.rs` `enum NetWorthVerdict`.)

### §2a — Gas floor (`adjudicate_gas_floor`, `verifier/src/gasfloor.rs`)

The agent must never spend the native gas token below `minGasReserve` (a bricked wallet can't pay its own
next tx, can't `cancelBridgeOut`, can't recover). The verifier reads the **post-action** native balance
(`eth_getBalance`) and adjudicates it against the reserve.

| Read | Claim (`minGasReserve`) | Observation (post-action balance) | Verdict |
|---|---|---|---|
| reserve held | `minGasReserve` | `post_balance ≥ minGasReserve` | **`confirmed`** ✅ (kept enough native gas for the next tx) |
| reserve held exactly | `minGasReserve` | `post_balance == minGasReserve` | **`confirmed`** ✅ (the boundary holds) |
| depletion | `minGasReserve` | `post_balance < minGasReserve` | **`refuted`** 🛑 (a depletion the gate should have blocked — proven, not assumed) |
| unreadable | `minGasReserve` | balance `None` | **`unverified`** 🛑 (degrades LOUDLY, never a fabricated `confirmed`) |

### §2b — Net-worth floor (`adjudicate_net_worth`, `verifier/src/networth.rs`)

The portfolio as a whole (Σ holdings × price) must never drop below `effective_floor = max(absolute,
drawdown)`, where `drawdown = session_start × num/den` (e.g. < 70% of session-start → HALT). The verifier
computes the total from its OWN multi-balance reads × a public feed; **a partial read degrades the WHOLE
total to `unverified`** (a missing leg could hide a depletion).

| Read | Claim (`effective_floor`) | Observation (verifier's own Σ) | Verdict |
|---|---|---|---|
| floor held | `max(absolute, drawdown)` | every holding read + priced + summed; `total ≥ floor` | **`confirmed`** ✅ |
| portfolio depletion | `max(absolute, drawdown)` | `total < floor` (e.g. < 70% of session-start) | **`refuted`** 🛑 (the agent's rosy report can't rescue a real on-chain depletion) |
| partial read | — | any single holding unreadable (`unreadable_legs > 0`) | **`unverified`** 🛑 (a partial sum is never passed off as a total) |
| priced-sum overflow | — | `priced_total() == None` (checked-arith overflow) | **`unverified`** 🛑 (degrades loudly, never a wrapped total) |

> Both floors are **offline-buildable** (a deterministic `GasFloorTape` / `NetWorthTape`); the live
> `eth_getBalance` / multi-balance reads are feature-gated + operator-gated. Both are wired as
> **money-critical presence gates** (gate ladder #12–#14) — renaming either half turns the gate RED.

---

## §3 — Cross-chain verdicts (time-lock + per-spoke isolation; `confirmed / refuted / unverified`)

0G is the secured **hub**; every other chain is a **spoke**; egress (hub → spoke) is the risky direction and
gets a value-tiered outbound time-lock the inbound never needs. (Verdict types: `verifier/src/timelock.rs`
`enum TimelockVerdict`; per-spoke isolation is confirmed through the mandate `TierVerdict` over
`checkTransferTo` in `verifier/tests/spoke_isolation.rs`.)

### §3a — Time-lock (`adjudicate_timelock`, `verifier/src/timelock.rs`)

A value-tiered egress lock: small egress → `Small` (short delay), large → `Big` (24h-style long lock,
`longDelay ≥ shortDelay`). The verifier proves the lock held — it does not take the contract's word.

| Read | Verdict |
|---|---|
| executed at/after `executableAt`, right tier delay | **`confirmed`** ✅ (no bypass; the delay was honored) |
| still safely pending, right tier delay | **`confirmed`** ✅ (a holding lock is the lock doing its job) |
| cancelled in-window | **`confirmed`** ✅ (the human-in-the-loop kill window worked) |
| executed **before** `executableAt` | **`refuted`** 🛑 (the NO-BYPASS proof — the verifier confirms it *did not* happen) |
| wrong tier delay (e.g. big value under the short delay) / malformed schedule | **`refuted`** 🛑 (not as designed) |
| guard state unreadable | **`unverified`** 🛑 (degrades LOUDLY, never a fabricated `confirmed`) |

`LockStatus` mirrors the on-chain enum: `pending / executed / cancelled`. `ValueTier`: `small:short-delay`
/ `big:long-lock`.

### §3b — Per-spoke isolation (`confirm_tier` over `checkTransferTo`, `verifier/tests/spoke_isolation.rs`)

A weak spoke is capped to **at most that spoke's cap** (V3 Tier-4 `destCap` keyed by
`spokeSpender(destSelector)`), never the hub and never another spoke. The verifier reads
`checkTransferTo(agent, token, amount, spokeSpender)` per spoke and confirms the gate enforces it.

| Spoke read | Expected gate | Verdict |
|---|---|---|
| weak spoke, over its 0.5M cap (0.6M egress) | `(false, OVER_DEST_CAP)` | **`confirmed`** ✅ (the per-spoke cap is enforced) |
| healthy spoke, same amount within its cap | `(true, OK)` | **`confirmed`** ✅ (one spoke's tight cap never constrains another) |
| the hub's own on-hub spend (no-spoke sentinel) | within global+asset caps | **`confirmed`** ✅ (the hub stays the security floor) |
| a gate that **failed** to enforce a per-spoke cap | reads back within-mandate when it should block | **`refuted`** 🛑 (never a fabricated `confirmed`) |
| the gate read is unreadable | — | **`unverified`** 🛑 |

> The TimelockGuard + the V4-folded time-lock are **your own contracts** → deployable + demoable on `16602`
> at $0; the deploy + the live `eth_call` read are **operator-gated**. The CCIP value legs are MAINNET-only
> (Galileo CCIP decommissioned). The §11.4 ZK / Filler hardenings are **roadmap, never claimed live**.

---

## §4 — Mandate-gate decisions (per-tier `TierVerdict`; `confirmed / refuted / unverified`)

Each tier of the spend gate is independently verifier-confirmed: `confirm_tier` adjudicates the live
`(ok, reason)` gate read against an `ExpectedGate` and mints a `TierVerdict` through the same monopoly. A
gate that lets an over-cap spend pass reads `refuted` (never a fabricated `confirmed`); an unreadable gate
reads `unverified`. (Verdict type: `verifier/src/mandate.rs` `enum TierVerdict`; tier labels: `enum Tier`.)

| Tier (label) | What the verdict confirms | Verdict on a correct gate |
|---|---|---|
| `tier1:period-cap` | the cumulative window cap holds (looping-drain blocked) | **`confirmed`** ✅ |
| `tier2:expiry` · `tier2:spender-allowlist` | the mandate is unexpired · the destination is allow-listed | **`confirmed`** ✅ |
| `tier3:asset-cap` · `tier3:pause` · `tier3:usd-cap` | the per-asset sub-cap · the pause kill-switch · the USD cap holds | **`confirmed`** ✅ |
| `tier4:dest-cap` · `tier4:within-mandate` | the per-destination cap · an in-mandate spend | **`confirmed`** ✅ |
| `v4:not-started` · `v4:epoch` | the `[start, expiry)` window · the money-path epoch (`bumpEpoch` strands grants) | **`confirmed`** ✅ |
| `v4:txcount-cap` · `v4:min-spend` · `v4:min-usd` | the tx-count bucket · the raw + USD dust floors | **`confirmed`** ✅ |
| `v4:usd-staleness` | the USD feed staleness/sanity guard (fail-closed) | **`confirmed`** ✅ |
| `v4:spoke-default-deny` | typed per-spoke default-deny isolation | **`confirmed`** ✅ |
| `v4:execute-re-gate` · `v4:egress-reservation` | the folded time-lock re-gates at execute · reserves period headroom | **`confirmed`** ✅ |
| **any tier, gate lets an over-cap spend pass** | the gate does NOT enforce as designed | **`refuted`** 🛑 |
| **any tier, gate read unreadable** | — | **`unverified`** 🛑 |

The first-failing reason follows a fixed, documented precedence (V4's 18-rung order, design §10.4b) — the
gate is deterministic. Live tier reads are recorded for the offline tape; the live `eth_call` now reconciles
against the **pinned, LIVE `MandateRegistryV4`** (`0x8e561a…f774` on `16602`) — the dashboard's RAILS proof,
mandate card, and dry-run per-asset gate all read it (under-cap → `(true, OK)`; over-cap → `OVER_TX_CAP`;
non-allowlisted → `TOKEN_NOT_ALLOWED`), independently confirmable via `cast` (VERIFY.md Proof 2).

---

## §5 — The I14-R spend reconciler (`reconciled / refuted / unverified`)

The named system invariant backing the **advisory, non-custodial** mandate: every `SpendRecorded(spendId, …)`
accrual is paired **1:1** against the on-chain `Transfer` the verifier reads. A **transfer with no matching
record** is the dangerous unbounded spend → a LOUD `refuted`; an empty read degrades to `unverified` (never
`reconciled`). (Verdict type: `verifier/src/reconciler.rs` `enum ReconcileVerdict`; orphan reasons:
`enum OrphanKind`.)

| Reconciliation case | Orphan kind | Verdict |
|---|---|---|
| every `spendId` paired 1:1 (agent/token/amount match) | — | **`reconciled`** ✅ |
| a `Transfer` with no `SpendRecorded` (the **dangerous unbounded spend**) | `transfer-without-record` | **`refuted`** 🛑 (the spend that bypassed the accrual) |
| a `SpendRecorded` with no on-chain `Transfer` | `record-without-transfer` | **`refuted`** 🛑 (accrued but never spent — phantom) |
| a paired record + transfer that DISAGREE on agent/token/amount | `mismatch` | **`refuted`** 🛑 |
| both records and transfers empty (nothing to reconcile) | — | **`unverified`** 🛑 (an empty read never reconciles) |

> The reconciler is an **off-chain trust component** (the contract is non-custodial — it holds no funds), but
> it is a *named system invariant with tests*. It is the honest framing of the money-safety model: the cap is
> **enforced PRE-broadcast by the gateway** (fail-closed) and **proven by the reconciler** (a spend with no
> accrual is a LOUD `refuted`) — never *"physically can't overspend"* (design §10.4b).

---

## §6 — Agent claims (NOT the truth table — the agent's word, kept separate)

Two-source truth (design §3 #1): the agent's *report* is a **claim** and never an entry in §1–§5 until the
chain confirms it. These are recorded here, distinct from the chain-observed verdicts above.

| Proof | Agent's claim | Independent on-chain confirmation | Result |
|---|---|---|---|
| **RAILS (over-cap blocked)** | "an over-cap transfer of `3_000_000` wei (> `perTxCap 2_000_000`) will be **blocked pre-broadcast**, nothing broadcast" | `eth_call checkTransfer(agent, native-sentinel `0x..0001`, 3000000)` on the deployed, LIVE `MandateRegistryV4` (`0x8e561a5cc096af6e570220a5228b33c7d889f774`) → `(false, OVER_TX_CAP)`, a zero-gas read; **no transaction exists** (a refused spend leaves no on-chain footprint). Also re-derived *through* the real UI under headless automation (the fullstack-target leg): on-screen `data-verdict="OVER_TX_CAP"` reconciled == an INDEPENDENT `eth_call` reason `OVER_TX_CAP` (the UI is never the source of truth — the independent `eth_call` is) | ✅ claim upheld on-chain — *no §1 settlement row, because nothing settled (and nothing was lost)* |
| **SETTLED (within-cap transfer)** | "a `1_000_000`-wei transfer settled" | the verifier's independent read → `settled` (§1 rows). Also re-derived *through* the real UI under headless automation: on-screen `data-verdict="settled"` reconciled == the independent verifier `verify-tx 0x8c59…bfb0 → settled` | ✅ promoted to §1 (chain-confirmed) |
| **Brain (TEE-attested model)** | *not claimed live* — the brain is an honestly-labelled hosted-LLM stub (web stamp = `PENDING / Phase-2 (Depth)`, `web/src/proofs.ts`) | — (0G Compute TEE attestation is the §9 **Depth** bracket-delta; not on-chain yet) | ⏳ honestly deferred, never pre-claimed |

> The RAILS proof is an **agent/on-chain claim**, not a §1 settlement: a *blocked* spend produces no
> transaction, so there is nothing for the settlement verifier to read. Its evidence is the on-chain
> `checkTransfer` verdict `(false, OVER_TX_CAP)` — confirmable by anyone via a zero-gas `eth_call` against
> the public registry. The mandate is the **rails** proof; the journal is the **settlement** proof; the
> money-safety / cross-chain / tier / reconciler adjudicators (§2–§5) are the **safety** proofs — all kept in
> different sections so the agent's word is never laundered into a chain-truth table.
>
> **All three published proofs (NEG · RAILS · SETTLED) were also re-derived *through* the real web UI** under
> headless automation (zero human — the fullstack-target leg), each on-screen `data-verdict` reconciled
> against its independent source (the verifier for NEG/SETTLED, an independent `eth_call` for RAILS). This
> does **not** change this ledger: it is still generated from the verifier's journal, never the UI — the UI
> rendering is *reconciled against* the same independent truth, never promoted into §1 on its own word. The
> two `settled` rows and the one NEG `unverified` row stand exactly as journalled.

### §6a — The "Run the agent (dry-run)" RUN LEDGER (a DRY-RUN projection — NOT a §1 settlement)

The Verification Console's **"Run the agent (dry-run)"** card (`web/src/dryrun.ts`) walks the full agent loop
**READ-ONLY** — no wallet, no signing, nothing broadcast — and produces a **RUN LEDGER** in *this exact
format*: one canonical JSONL record per leg (`{"hash","kind","claimed","observed","recorded","verdict"}`,
byte-identical to `verifier/src/journal.rs`) + the `LedgerSummary::status_line()` projection
(`verifier/src/ledger.rs`). It is a **dry-run** projection, kept strictly out of the §1 chain-truth table:

- It gates three demo intents **per asset** with real read-only `checkTransfer` `eth_call`s — an allowlisted
  asset under its cap (`OK`), the same asset over its cap (`OVER_TX_CAP`), and a non-allowlisted asset
  (`TOKEN_NOT_ALLOWED`) — proving the mandate is enforced **by asset** (§6 RAILS claim, generalized).
- A dry-run **broadcasts nothing**, so each leg's `observed` is `null` (the loud absence — never a fabricated
  `0`), its synthetic `hash` is a clearly-tagged `dryrun:…` (never a real `0x` tx hash), and its verdict is
  **`unverified`** — so the run-ledger status line reads, honestly, `DEFECTS -- 3 verdict(s): 0 settled / 0
  hollow / 0 mismatch / 3 unverified (3 defect(s))`. An all-`unverified` dry-run is **NOT** green, and `audit`
  over it would exit `1` — it can **never** mint a `settled` (design §3 #2/#3, §13).

This RUN LEDGER is the **identical artifact** a real `verifier verify-tx … --journal` + `verifier ledger`
run produces, so a judge sees the same settlement-truth shape — but it claims **nothing** in §1, because a
dry-run settles nothing (and nothing was lost).

**The RAILS card mirror (`web/src/mandateCard.ts`) is a READ-ONLY view, not a ledger entry.** The Verification
Console's expanded RAILS card mirrors the deployed, LIVE `MandateRegistryV4` — a tri-state **reconciled-vs-deployed**
pill (the stated config reconciled against the chain's own over-cap `checkTransfer` answer: `Reconciled` /
`Drifted` / `Unverified`, never a faked green), a per-asset table (allowlist + sub-caps), and a wallet-free
`checkTransfer` simulator (a real zero-gas `eth_call` per pick → `ALLOWED` / `BLOCKED` / `UNVERIFIED`). Like the
RAILS claim in §6, it is a **read of the on-chain mandate**, never a settlement — it adds **no §1 row** (a read
moves no money). It reads the consolidated **`MandateRegistryV4`**, now **LIVE on `16602`**
(`[mandate_v4].address=0x8e561a…f774`; `setPeriodConfig(3600, 1_500_000)` confirmed on-chain), so its period
tier reads a live-enforced figure (the V4 USD cap stays opt-in/off by default, labelled so).

> **Reading this ledger on screen (the judge/voter path).** To produce + read this RUN LEDGER interactively —
> and to confirm every other proof through the real UI with zero wallet and zero trust — follow the **fullstack
> judge/voter guide** in the repo-root [`VERIFY.md`](./VERIFY.md) ("Verify it yourself, in the browser"). It
> drives the same dry-run card whose RUN LEDGER is described here; the projection a judge reads on screen is
> byte-identical to this file's `verifier journal` + `ledger` format, and — being a dry-run — it claims nothing
> in §1.

---

## Status at a glance

- **Settlement: 3 / 3 chain-verified `settled`** (Δ `0`, all confirmable on the explorer — incl. the fresh
  live spend `0x4249…b4b6`, block 40,232,225); 0 `hollow`, 0 `mismatch`; 1 deliberate NEG `unverified`. No
  claimed settlement is hollow or off-amount (zero-loss).
- **The mandate's smart-contract transactions are in §0** — the V4 deploy + `addAllowedAsset` /
  `setPeriodConfig` / `setParamDelay`, each a Success on 0G-Galileo (16602), explorer-confirmable.
- **Money-safety (§2):** every depletion path adjudicates to `refuted` (a breach) or `unverified` (an
  unreadable/partial read) — **never** a fabricated `confirmed`; the floor-held path is `confirmed`.
- **Cross-chain (§3):** the time-lock no-bypass + the per-spoke isolation read `confirmed` when the guard
  holds, `refuted` on a bypass / unenforced cap, `unverified` when unreadable.
- **Mandate tiers (§4):** each tier `confirmed` on a correct gate; `refuted` if the gate lets an over-cap
  spend pass; `unverified` if unreadable.
- **Reconciler (§5):** `reconciled` when every spend pairs 1:1; the dangerous transfer-without-record →
  `refuted`; an empty read → `unverified`.
- **The NEG row + every `refuted`/`unverified` is surfaced LOUD** by the audit, never silently counted as
  success (design §13, zero-loss). Excluding the deliberate NEG, the live journal is GREEN — every real
  settlement the agent claimed was independently chain-verified, and no safety verdict is a fabricated pass.

---

*Generated from `demo/proofagent.demo.journal` by the independent verifier (`verifier ledger` / `audit`),
with the money-safety / cross-chain / mandate-tier / reconciler verdicts (§2–§5) minted by the corresponding
adjudicators (`gasfloor.rs` / `networth.rs` / `timelock.rs` / `mandate.rs` / `reconciler.rs`) over the
offline tapes. The journal is append-only, deterministic, and redacted (no home path, no secret, no
wall-clock — design §5a / §6). The `Date` column is the on-chain block, not the machine clock.*
