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
**Demo moment:** feed a deliberately **hollow** fill (filler claims payment, no on-chain transfer) → ProofAgent
mints `hollow` and **blocks release**, where a hash-only oracle would have paid.

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
the reputation gap intent protocols leave open, closed on-chain. (Contract change → operator-gated deploy.)
**Demo moment:** two hollow verdicts in a row → mandate auto-revoked; the agent can no longer spend.

### 5 — Cross-Chain Intent Settlement Proof  ·  layers: 0G Chain (+ external read)  ·  effort: L
Accept a cross-chain intent, independently verify BOTH legs landed (source lock + destination fill), and mint a
single cross-chain `settled` verdict — the trust-minimised referee over a real bridge. Highest ceiling, heaviest
(two-chain verification + testnet bridge liquidity).
**Demo moment:** bridge a small transfer; ProofAgent catches a real destination-leg failure as `mismatch`.

## Sequencing

1. **#1 Fill-Proof verdict path** (champion move; reuses the existing verifier — lowest risk, highest narrative payoff).
2. **#3 Storage anchor** (smallest; lands automatically when the 0G testnet storage-flow recovers — see
   `demo/EVIDENCE_FULLSTACK_0G.md`).
3. **#2 TEE brain** (wire a live 0G Compute provider to the proven `attested:true` seam).
4. **#4 Slashable mandate** (contract rev → operator-gated deploy, paired with `/diff-code-review`).
5. **#5 Cross-chain proof** (capstone).

All five keep the doctrine: independent two-source verdicts, loud degrade, never-fake-green, testnet-only,
per-trade cap. The oracle is only as valuable as it is honest.
