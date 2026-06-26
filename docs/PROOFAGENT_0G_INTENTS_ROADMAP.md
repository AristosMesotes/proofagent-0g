# ProofAgent on 0G — the Settlement-Oracle Roadmap (intents-grade verifiability)

> The frontier the whole cross-chain industry is racing toward is **"don't pay the filler until an
> independent oracle proves the fill."** That is *already* what ProofAgent does — an independent verifier
> that reads the chain and mints `settled / hollow / mismatch / unverified`. This roadmap sharpens
> ProofAgent into a **0G-native settlement oracle**: the honest referee for agent money and intent fills.

## Why this is the right bet (the intents analogue)

Modern intent protocols release a solver's funds only after an **Oracle** proves the destination fill landed
(an `efficientRequireProven`-style gate over a hash-based fill attestation). The gap in that design is
**honesty under adversarial fills**: a hash-only oracle pays whatever it is told proved. ProofAgent is the
*honest* version of that oracle — it independently re-reads the chain (two-source: claim vs observation),
and it **refuses to release on a hollow fill**. On 0G, that referee runs across all three layers:

- **0G Chain** — gates the spend (on-chain `MandateRegistry.checkTransfer`) and is the settlement source of truth.
- **0G Compute** — attests the *decision* (TEE-signed brain), so cognition is verifiable, not just money.
- **0G Storage** — attests the *verdict* (content-addressed verdict bundle), so evidence is tamper-evident.

Honest by construction: only the verifier mints a verdict; nothing is painted green that the chain has not
confirmed; every degrade is loud. That refusal-to-fake IS the product.

## The five features (ranked — champion-first)

### 1 ⭐ Fill-Proof Verifier — ProofAgent as a 0G settlement oracle  ·  layer: 0G Chain  ·  effort: M
Reframe the verifier as an intent-settlement oracle: ingest an intent (source-lock + a *claimed* destination
fill), independently read the chain, and mint `settled / hollow / mismatch / unverified` that **gates fund
release**. This is the exact primitive intent protocols need — built the honest way.

**✅ SHIPPED (verifier `fillproof` leg).** `adjudicate_fill` / `verify_fill` reuse the sealed `adjudicate`
algebra and the four-verdict monopoly, deriving a `RELEASE` / `BLOCK` decision — RELEASE only on `settled`;
`hollow` / `mismatch` / `unverified` all BLOCK, fail-closed (never a fabricated release). 11 tests green;
clippy zero-warning (the verifier suite is 243 green).
**Demo moment (runnable):** `verifier fill-proof --claimed 1000000 --observed 0` → `hollow BLOCK` — the solver
claims payment for a delivery the chain says never happened; a hash-only oracle would RELEASE, ProofAgent **BLOCKS**
(exit non-zero). The honest fill `--observed 1000000` → `settled RELEASE`; an unreadable fill `--unreadable`
→ `unverified BLOCK`. The live two-source mode reads the chain itself: `--fill-tx <hash> --claimed <n>`.
**Wired into the agent loop:** `runLoop` now has a live **`BLOCKED_BY_FILL_PROOF`** stage — after a swap settles
it shells to `verifier fill-proof --fill-tx <hash> --claimed <n>` (the `FillProofOracle` / `binaryFillProof`
seam) and BLOCKS release on a hollow fill, where a hash-only oracle would pay. 244 agent tests green.

### 2 — TEE-Attested Solver Brain (0G Compute proof-of-decision)  ·  layers: 0G Compute + Chain  ·  effort: M
Run the trade/intent-selection brain inside 0G Compute (TeeML); verify each decision's per-response enclave
signature and bind the TEE attestation into the verdict bundle. Answers "was the agent's *decision* honest?",
not just "did the money move?". The green machinery already exists (`agent/src/zerog/compute.ts`,
`attested:true` is the single true path); this wires a live provider.
**Demo moment:** show the signed response handle; flip one byte → attestation fails → verdict downgrades to `unverified`.

### 3 — Verdict Bundle on 0G Storage (content-addressed evidence)  ·  layers: 0G Storage + Chain  ·  effort: S
Publish each verdict bundle (intent, tx hashes, TEE signature, settled/hollow result) to 0G Storage keyed by
its Merkle root, and embed that root in the on-chain verdict. "Check the chain" becomes one-click, tamper-evident
retrieval with a Merkle proof. The leg exists (`agent/src/zerog/storage.ts`) and already computes the genuine
re-derivable 0G root; it anchors the instant the testnet storage-flow recovers.
**Demo moment:** read the root from the chain event, fetch from 0G Storage `withProof`, show byte-identical evidence.

### 4 — Slashable Mandate / Solver-Honesty Scoreboard  ·  layer: 0G Chain  ·  effort: S–M
Extend `MandateRegistry` so each verdict updates a per-agent honesty score; N consecutive `hollow/mismatch`
verdicts auto-revoke the mandate (slashing the dishonest filler). Converts honesty into *enforced economics* —
the reputation gap intent protocols leave open, closed on-chain.

**✅ SHIPPED (verifier `slasher` leg).** `slash(journal, SlashConfig)` projects the settlement-truth journal
(the verifier's OWN verdicts) into a `MandateStatus` — it tracks the trailing run of consecutive dishonest
verdicts (`hollow`/`mismatch`; a `settled` or `unverified` breaks it) and AUTO-REVOKES at the threshold. 11
tests green; clippy zero-warning (the verifier suite is 254 green). The on-chain auto-revoke (the
`MandateRegistry`) is the operator-gated production wiring of this algebra.
**Demo moment (runnable):** a journal ending in two hollow verdicts → `verifier slash` prints `REVOKED`
(`streak=2/2`, exit non-zero) — *the agent can no longer spend.* `--revoke-after <n>` sets the threshold.

### 5 — Cross-Chain Intent Settlement Proof  ·  layers: 0G Chain (+ external read)  ·  effort: L
Accept a cross-chain intent, independently verify BOTH legs landed (source lock + destination fill), and mint a
single cross-chain verdict — the trust-minimised referee over a real bridge.

**✅ SHIPPED (verifier `xchain` leg).** `verify_xchain_fill(...)` reads BOTH legs INDEPENDENTLY (two `Source`
reads, like `bridge`) and mints one cross-chain `Verdict` + a `RELEASE`/`BLOCK` decision: the destination leg
through `adjudicate_fill` (the hollow-fill catch), the source lock through `adjudicate`, folded fail-closed
(unreadable > hollow > mismatch > settled). RELEASE only when BOTH legs settled within band. 8 tests green;
clippy zero-warning (the verifier suite is 262 green). The live two-chain read (a feature-gated per-chain
reader + testnet bridge liquidity) is the operator-gated production wiring.
**Demo moment:** the source LOCKS a million, the destination delivers ZERO → a cross-chain **HOLLOW** fill →
`BLOCK`. A naive integration paid on the source confirmation; ProofAgent refuses.

## ✅ Capstone — the Filler reference loop + on-chain SettlementOracle (SHIPPED)

The five legs above each prove a *fact*; the capstone makes ProofAgent a **deployable settlement primitive**
— the honest oracle wired into a real intent **fill → prove → release** loop, end to end, on both sides of
the trust boundary.

**Off-chain — `verifier filler` (the loop).** `filler::run_filler(...)` is the loop a real Input Settler runs
over a BATCH of solver fill claims, COMPOSING the proven legs: each fill is read INDEPENDENTLY (`verify_fill`)
and the solver is RELEASED only on a chain-confirmed, within-band fill; every hollow / out-of-band /
unreadable fill is BLOCKED (fail-closed). The verifier's OWN verdicts accrue into a settlement journal, and
the `slash` projection GATES the loop: **once a solver lies twice in a row the mandate REVOKES and even an
honest fill is WITHHELD — the slash bites.** No new verdict enum, no new decision type (the monopoly holds);
pure + deterministic over the `Source` seam. 11 tests; the verifier suite is **273 green**, clippy zero-warning.

**On-chain — `contracts/src/SettlementOracle.sol` (the gate).** The on-chain mirror of the off-chain
`FillDecision`: an honest verifier ATTESTS a fill id's verdict, and `requireProven(fillId)` (the
`efficientRequireProven`-style guard the settler calls) **reverts unless the attested verdict is `Settled`** —
fail-closed on the `Unverified` default, on `Hollow`, and on `Mismatch`. Hardened: `Unverified` is ordinal 0
(an un-attested fill is never releasable), attestations are **write-once-final** (a `Hollow` can never be
retroactively flipped to `Settled`), and only the attestor (the verifier operator) may post a verdict.
Non-custodial (holds no funds). 20 forge tests; `forge build` zero-warning; 1,308-byte runtime (a comfortable
margin under EIP-170). Deploy is operator-gated (`contracts/script/DeploySettlementOracle.s.sol`).

**Demo moment (runnable):** `verifier filler` → fill #1 settled → **RELEASED**; two hollow fills → **BLOCKED**
(the mandate auto-revokes); fill #4, a chain-confirmed *settled* fill → **WITHHELD** because the mandate is
already revoked — *the slash bites an honest fill.* Exits non-zero (the honest block signal).

## Sequencing

1. **#1 Fill-Proof verdict path** (champion move; reuses the existing verifier — lowest risk, highest narrative payoff).
2. **#3 Storage anchor** (smallest; lands automatically when the 0G testnet storage-flow recovers — see
   `demo/EVIDENCE_FULLSTACK_0G.md`).
3. **#2 TEE brain** (wire a live 0G Compute provider to the proven `attested:true` seam).
4. **#4 Slashable mandate** (contract rev → operator-gated deploy, paired with `/diff-code-review`).
5. **#5 Cross-chain proof** (capstone).

All five keep the doctrine: independent two-source verdicts, loud degrade, never-fake-green, testnet-only,
per-trade cap. The oracle is only as valuable as it is honest.
