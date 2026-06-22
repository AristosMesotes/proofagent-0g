# ProofAgent-0G — LIVE-LOOP evidence (the three proofs, live on 0G Galileo testnet 16602)

> Captured by `demo/live_loop.sh` against the **real** chain. Every hash below is confirmable on the
> public testnet explorer **chainscan-galileo.0g.ai**. Money-safety (design §13): testnet only, tiny
> minor-unit transfers bounded by the on-chain cap, the demo wallet only — never a product key.

| | |
|---|---|
| **Chain** | 0G Galileo testnet — chain id `16602` |
| **RPC** | `https://evmrpc-testnet.0g.ai` (read independently, raw JSON-RPC) |
| **Explorer** | `https://chainscan-galileo.0g.ai` |
| **MandateRegistry** | `0x675FF5053F434AA3f1d48574813BFc1696FBD345` |
| **Agent / demo wallet** | `0xc7Af61A1399Aca0bee648D7853AE93f96B86866a` |
| **Native-asset sentinel** | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (the mandate bounds the native transfer against this) |
| **On-chain mandate** | `owner == agent == demo wallet` · `perTxCap = 2_000_000` (minor units) · never-expiry · not paused |

There is **no DEX on the Galileo testnet**, so the live action is a **plain capped native 0G
transfer** (not a swap) — exactly as design §2/§10.6 prescribe for the testnet leg. The verifier reads
the transfer's native `value` (in wei / minor units) and adjudicates it against the agent's claim with
an exact-integer 15% band (`proofagent.toml [verifier.tolerance]`).

---

## Setup (one-time, on-chain) — allowlist the native-asset sentinel

The registry rejects `address(0)` in `setAssetCap`, so the native asset is mandated under the canonical
native-token sentinel. Allowlisted with a per-asset sub-cap of `2_000_000` minor units:

```
setAssetCap(0xEeee…EEeE, 2_000_000, true)
tx 0x6eafa90c7d7ea9be80797868722e79dfb8372bbce03a4712b2415b9167f3cfdb   status 0x1 (success)
```
After it: `allowed[sentinel] == true`, `assetCap[sentinel] == 2_000_000`, `effectiveCap == 2_000_000`.

---

## PROOF 1 — SETTLED ✅

The agent proposes a **within-cap** native transfer (`1_000_000` wei). The mandate gate authorizes it
(`eth_call checkTransfer` against the deployed registry → `(true, OK)`); a **real** capped native 0G
transfer is broadcast; the independent verifier reads it on-chain
(`eth_getTransactionReceipt` → `status 0x1`, then `eth_getTransactionByHash` → `value`) and, because the
observed value equals the claim, stamps **`settled`**.

```
[mandate-gate] checkTransfer(agent, sentinel, 1000000) -> (true, OK)        # AUTHORIZED
[execute]      capped native transfer, value = 1000000 wei (self)           # broadcast on 16602
[verify]       eth_getTransactionReceipt.status = 0x1 ; eth_getTransactionByHash.value = 0xf4240 (1000000)
[verdict]      claimed 1000000 == observed 1000000  -> SETTLED
```

Confirmable settled transfers (both `status 0x1`, `value 1000000` wei):

| tx hash | block | explorer |
|---|---|---|
| `0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0` | 39996100 | https://chainscan-galileo.0g.ai/tx/0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0 |
| `0xfb18bfc1a3a12b78843549f0023ccca62746513036e54523ab8d23aaf04f6290` | 39996470 | https://chainscan-galileo.0g.ai/tx/0xfb18bfc1a3a12b78843549f0023ccca62746513036e54523ab8d23aaf04f6290 |

The first is pinned in `proofagent.toml [[verifier.corpus]]` (with the recorded on-chain `observed`),
so the **offline** Rust verifier also replays this genuine settlement deterministically:

```
$ verifier verify-tx 0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0
settled
verifier: TRANSFER 0x8c59…bfb0 claimed=1000000 observed=1000000 -> settled        # exit 0
```

---

## PROOF 2 — RAILS (over-cap blocked) ✅

The agent proposes an **over-cap** transfer (`3_000_000` wei > `perTxCap 2_000_000`). The mandate gate
returns `(false, OVER_TX_CAP)` as a zero-gas `eth_call`, so the agent **does not execute** — nothing is
broadcast. The cap is a pre-broadcast kill-switch (design §2 Rails).

```
[mandate-gate] checkTransfer(agent, sentinel, 3000000) -> (false, OVER_TX_CAP)    # BLOCKED, zero gas
[execute]      NOT executed — the agent obeys the kill-switch; NOTHING was broadcast
```

The reason word `0x4f5645525f54585f434150…` decodes to ASCII `OVER_TX_CAP`. No transaction exists for
this request — the block is the evidence (a refused spend leaves no on-chain footprint by design).

---

## PROOF 3 — NEG (fabricated hash → UNVERIFIED) ✅

The verifier is pointed at a **fabricated**, well-formed-but-unknown hash. It reads the chain
(`eth_getTransactionReceipt` → `null`, no record) and degrades **loudly** to `unverified` — it never
rubber-stamps a `settled` for an off-record hash (design §2 NEG case / §3 #3 never-fabricate).

```
$ verifier verify-tx 0xdeadbeef00000000000000000000000000000000000000000000000000000000
unverified
verifier: unknown 0xdead…0000 claimed=0 observed=<unavailable> -> unverified        # exit 1
```

The same fabricated hash, read **live** (`eth_getTransactionReceipt` returns `null` on 16602) →
`unverified`. Two code paths ("we could not read it" and "it settled") that can never be confused.

---

## Reproduce

```bash
set -a; . ./.env; set +a            # OG_RPC_TESTNET / WALLET_ADDRESS / MANDATE_REGISTRY_ADDRESS / PRIVATE_KEY
./demo/live_loop.sh                 # read-only: re-verify the pinned SETTLED tx + RAILS + NEG, all live
./demo/live_loop.sh --broadcast     # also broadcast a FRESH capped native transfer and verify it live
```

The script refuses any chain id other than `16602` (money-safety, design §13), reads `PRIVATE_KEY` from
the environment only, and prints/commits no secret. The independent Rust verifier is invoked when a
`verifier` binary built `--features live` is supplied via `VERIFIER_BIN`; otherwise the live read is done
inline with `cast`, mirroring the verifier's `LiveSource` RPC calls (`eth_getTransactionReceipt` +
`eth_getTransactionByHash`) exactly.
