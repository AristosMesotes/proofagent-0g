# web/ -- the thin demo UI

One static screen (design §4): the **three honest proof stamps** + **three driveable controls** -- the
**NEG case** and two READ-ONLY on-chain checks (**RAILS** + **SETTLED**), so the headless harness can drive
all three proofs through the real UI.

| Stamp | What it shows | Honesty (design §7/§8) |
|---|---|---|
| **Brain** | which model ran | `PENDING / Phase-2` -- 0G Compute TEE attestation is the *Depth* bracket; at MVP the brain is a hosted LLM. **Never green here.** |
| **Rails** | it cannot overspend | the on-chain per-tx cap, enforced pre-broadcast. `ARMED` until the MandateRegistry address is pinned on-chain; `LIVE` (with an explorer link) once it is. |
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

**The RAILS check** (design §2 Rails): a key-less, zero-gas `eth_call` of the deployed `MandateRegistry`
on 0G Galileo (16602), asking `checkTransfer(agent, native-sentinel, 3_000_000 wei)` -- strictly above the
`2_000_000` per-tx cap. The chain answers `(false, OVER_TX_CAP)` **before any broadcast**; the page decodes
that on-chain reason word into `data-verdict="OVER_TX_CAP"`. Re-derive it: replay the same `eth_call` and
decode the second 32-byte word (`cast call <registry> "checkTransfer(address,address,uint256)" …`).

**The SETTLED check** (design §2 Settlement): a key-less read of the **pinned** settled tx
(`[[verifier.corpus]]` / `demo/EVIDENCE.md` PROOF 1) -- `eth_getTransactionReceipt` (`status 0x1`) +
`eth_getTransactionByHash` (native `value`). The page recomputes the verifier's published
`adjudicate(claimed, observed)` in the open -> `data-verdict="settled"`. An off-record / failed / unreadable
read degrades **loudly** (`unverified`/`mismatch`), never a fabricated `settled`. Re-derive it: fetch the
same receipt + value and rerun the adjudication (or `verify-tx` against the independent Rust verifier).

Both on-chain controls read the public 0G Galileo endpoint (`https://evmrpc-testnet.0g.ai`) and link the
public testnet explorer (`https://chainscan-galileo.0g.ai`); the RPC URL is read at run time, never a
private endpoint, and there is **no signing/broadcast surface** in the read transport by construction.

## Build & run (offline, no framework, no CDN)

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
Every constant mirrors the public data spine `proofagent.toml`; the brain stamp is never green at MVP; the
NEG case is faithful to `verifier/src/adjudicate.rs` (off-record -> `unverified`).
