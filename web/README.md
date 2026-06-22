# web/ -- the thin demo UI

One static screen (design §4): the **three honest proof stamps** + the **NEG case**.

| Stamp | What it shows | Honesty (design §7/§8) |
|---|---|---|
| **Brain** | which model ran | `PENDING / Phase-2` -- 0G Compute TEE attestation is the *Depth* bracket; at MVP the brain is a hosted LLM. **Never green here.** |
| **Rails** | it cannot overspend | the on-chain per-tx cap, enforced pre-broadcast. `ARMED` until the MandateRegistry address is pinned on-chain; `LIVE` (with an explorer link) once it is. |
| **Settlement** | the trade really happened | the independent verifier's verdict. Asserts **no** `settled` while the corpus is empty; the live, runnable proof is the **NEG case**. |

**The NEG case** (design §2): the button points the verifier's published adjudication rule at a
*fabricated* transaction hash. Off-record -> no observation -> `adjudicate(_, None, _)` -> **`UNVERIFIED`**.
It can only ever produce `unverified` (never a fabricated `settled`), and it prints the exact CLI command
to reproduce the verdict against the real independent Rust verifier.

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
