# Evidence — MandateRegistryV3, the four-tier production spend gate (LIVE on 0G Galileo testnet 16602)

This file records the **real, confirmable on-chain evidence** for the four-tier production spend gate
(`MandateRegistryV3`) — the production-grade Rails proof of ProofAgent-0G. Every hash below is a genuine
transaction on **0G Galileo testnet (chain id 16602)**, confirmable on the public explorer
**chainscan-galileo.0g.ai**. Nothing here is fabricated; every gate read is an independent on-chain
`eth_call` / `cast call`.

> **The headline:** the **period cap BLOCKS a looping sequence the per-tx cap would pass.** This is the
> single attack the MVP's single per-tx cap cannot stop — and `MandateRegistryV3` closes it on-chain.

---

## 1. The deployed contract

| | |
|---|---|
| **Contract** | `MandateRegistryV3` (clean-room four-tier successor to the MVP `MandateRegistry`) |
| **Address** | `0xC24A325dB118cfFD586E72b9D085FB71D5202BD2` |
| **Chain** | 0G Galileo testnet — chain id **16602** |
| **Explorer** | <https://chainscan-galileo.0g.ai/address/0xC24A325dB118cfFD586E72b9D085FB71D5202BD2> |
| **Owner / Agent** | `0xc7Af61A1399Aca0bee648D7853AE93f96B86866a` (the demo wallet) |
| **`checkTransfer` selector** | `0xcc1dd94f` — **identical** to the MVP (v2-compatible; the agent/verifier/web codecs read V3 unchanged) |

### Deploy + tier-config transactions (all status `0x1`, block `40044208`)

| Tx | Hash |
|---|---|
| `CREATE MandateRegistryV3` | `0x81fe165434d791f643cc56b0ab6df15d1d893b56510f08dd152a24866c8a154c` |
| `setAssetCap(sentinel, 2_000_000, true)` (Tier 3) | `0x42a4a78eda24631eabb997890342fb25d5ce384180ae9e4bd1d2ccc18730169d` |
| `setPeriodConfig(3600, 1_500_000)` (Tier 1) | `0xb451d5e43f2c5e7e380fc2cff5333896faed77a80e49c7f5170905c383a9324e` |

### Independent state read-back (`cast`, never the deploy script's word)

```
owner            = 0xc7Af61A1399Aca0bee648D7853AE93f96B86866a
agent            = 0xc7Af61A1399Aca0bee648D7853AE93f96B86866a
perTxCap         = 2000000
allowed[native]  = true
assetCap[native] = 2000000
periodSeconds    = 3600          # Tier 1 window = 1 hour
periodCap        = 1500000       # Tier 1 cumulative per-period cap (the looping-drain guard)
MAX_LIST         = 16            # Tier 3 bounded-list cap
```

Native-asset sentinel (the allowlisted asset; the registry rejects `address(0)` in `setAssetCap`, so the
native asset is mandated under the canonical sentinel): `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.

---

## 2. THE HEADLINE — the period cap blocks a looping sequence (LIVE)

Run: `MANDATE_V3_ADDRESS=0xC24A325dB118cfFD586E72b9D085FB71D5202BD2 ./demo/mandate_v3_period_cap.sh --accrue`

```
per-tx cap   = 2,000,000 wei        (a single 1,000,000 spend passes it trivially)
period cap   = 1,500,000 wei / hour (Tier 1: the cumulative window)

STEP 1  checkTransfer(1,000,000)            -> (true,  OK)               # within the per-tx cap — the MVP's gate
STEP 2  gateAndRecord(1,000,000)            -> accrued; window = 1,000,000, headroom = 500,000
STEP 3  checkTransfer(1,000,000)  [loop 2]  -> (false, OVER_PERIOD_CAP)  # 1M + 1M = 2M > 1.5M period cap
```

- **The accrue tx (Tier 4, atomic gate+accrue):**
  `0x44e5e4a022d17b91a428b44ce6793116db0d06d383799470dabc60189bdf8556` — status `0x1`, block `40044471`.
  It moves **no value** (the mandate is the registry's own accumulator), so the demo runs at **$0**.
- **Independent confirmation** (`cast`, after the accrue): `accruedInWindow() = 1000000`, and the second
  `checkTransfer(1,000,000)` reads back `(false, OVER_PERIOD_CAP)` directly from the chain.

**The per-tx cap (2,000,000) alone would have passed loop 2. The period cap (1,500,000) blocked it.**
Looping-drain is closed, live on-chain — the headline.

---

## 3. Each tier, read LIVE from the gate (the verifier's Observation)

These are genuine `cast call ... checkTransfer(...)` reads against the deployed registry — the exact
`(ok, reason)` the verifier's tier-confirmation extension (`verifier::confirm_tier`) adjudicates. The
`verifier/tests/mandate_tiers.rs` integration test replays these recorded reads and confirms each tier.

| Probe (`checkTransfer`) | Live on-chain answer | Tier proven |
|---|---|---|
| `(agent, native, 1)` | `(true, OK)` | within-mandate (the gate authorizes a legal spend) |
| `(agent, native, 1_000_000)` *(window full)* | `(false, OVER_PERIOD_CAP)` | **Tier 1 — period cap (the headline)** |
| `(agent, native, 2_000_001)` | `(false, OVER_TX_CAP)` | per-tx cap |
| `(agent, OTHER_TOKEN, 1)` | `(false, TOKEN_NOT_ALLOWED)` | Tier 3 — asset allowlist |
| `(stranger, native, 1)` | `(false, NOT_AGENT)` | Tier 2 — agent identity |
| `(agent, native, 0)` | `(false, ZERO_AMOUNT)` | zero-amount guard |

The remaining tiers (Tier 2 spender-allowlist, Tier 3 pause + USD-cap + bounded-list, Tier 4
dest-cap + atomic accrue) are exhaustively covered by `forge test` (29 tests in
`contracts/test/MandateRegistryV3.t.sol`, one per tier + the full fixed reason-code order) and by the
offline verifier tape tests, so the deployed registry is left in its clean headline-demo state.

---

## 4. The fixed reason-code order (the documented precedence)

`checkTransfer` / `checkTransferTo` return the **first** failing reason, evaluated in a fixed, documented
order so the answer is deterministic (design §3 #4). `forge test` proves every adjacent pair:

```
PAUSED  >  AGENT_PAUSED  >  EXPIRED  >  NOT_AGENT  >  ZERO_AMOUNT  >  TOKEN_NOT_ALLOWED
        >  SPENDER_NOT_ALLOWED  >  OVER_TX_CAP  >  OVER_ASSET_CAP  >  OVER_DEST_CAP
        >  OVER_PERIOD_CAP  >  {PRICE_UNAVAILABLE | OVER_USD_CAP}
```

`REASON_OK` (the zero word) is the only `ok == true` reason. Fail-closed: the gate returns `ok == true`
**only** when the spend clears every enabled tier.

---

## 5. Operator-gated items (NOT executed here)

- **Mainnet (16661) deployment of `MandateRegistryV3`.** The four-tier mandate is your own contract and
  is fully demoable on **testnet (16602) at $0** (this file is that demo), so no mainnet deploy is
  required for the proof. To deploy to mainnet, run the operator command in `script/DeployV3.s.sol` with
  `OG_RPC` pointed at the Aristotle mainnet RPC — **operator-gated** (real gas).
- **The MVP MandateRegistry** (`0x675FF5053F434AA3f1d48574813BFc1696FBD345`) remains live; `V3` is a
  successor on the same `checkTransfer` shape, not a replacement of the pinned MVP corpus.
