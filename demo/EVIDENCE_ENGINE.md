# Evidence — the ENGINE (the `ExecutionConnector` contract + adapters + the protocol-agnostic gateway)

STEP ENGINE-CONTRACT builds design **WOW Feature 5** — ONE clean, enforced execution contract that every
public 0G protocol satisfies identically, the protocol-specific adapters that wrap the existing legs behind
it, and a **protocol-agnostic gateway** the agent dispatches through. The agent calls
`gateway.execute(intent)` and **NEVER a specific protocol**; the gateway quotes every adapter, orders them by
a **priced fallback**, runs the **mandate `checkTransfer` gate PRE-submit for every adapter**, and applies
the **fund-loss-safe `value_moved` short-circuit** — once value has moved on-chain it **never** retries or
falls back (no double-spend).

> **The wow is the *proof*, not the DeFi.** The Engine does not add a new action — it unifies the three
> proven actions (swap → route → bridge) behind one bounded seam so the agent expresses *intent* and the
> safety envelope (mandate gate + independent verifier) wraps **every** dispatch identically. This step is a
> **pure refactor**: it moves the per-protocol logic into adapters and adds the gateway **without losing any
> functionality or regressing a single existing test** (every prior agent test still passes). The live
> submit stays **operator-gated** (mainnet legs move REAL value); the default build dispatches NOTHING.

---

## 1. What was built (offline-buildable, all green)

| Piece | File | What it does |
|---|---|---|
| **The contract** | `agent/src/connector.ts` | `ExecutionConnector` — ONE bounded, five-method seam every protocol satisfies identically: `quote(intent) → Quote` · `buildUnsigned(intent) → UnsignedTx` · `submit(signed) → OrderId` · `status(orderId) → OrderStatus` · `cancel(orderId)`. The methods are ordered by the **fund-loss-safe lifecycle**: `quote`+`buildUnsigned` move NOTHING (the gateway may fall back freely on a failure here); `submit` is the ONLY value-mover. `OrderStatus.valueMoved` is the load-bearing short-circuit signal. The agent expresses ONE protocol-agnostic `ExecutionIntent`; recipient rides on the intent, the live signer is the one narrow `submit` seam. |
| **SWAP adapter** | `agent/src/adapters/swap_adapter.ts` | Oku/Uniswap-V3 as an `ExecutionConnector`. `quote` reads the on-chain `QuoterV2` quote (the SAME read the swap leg does) + derives the exact-integer floor; `buildUnsigned` reuses `planSwap` (the preserved **7-field `exactInputSingle` tuple, no deadline**, selector `0x04e45aaf`). Mainnet-only → `submit` is operator-gated (fails CLOSED, never a fake hash). |
| **ROUTE adapter** | `agent/src/adapters/route_adapter.ts` | Khalani (intent) / LI.FI (aggregation) / JAINE (native-AMM) — ONE adapter per rail. `quote` takes the rail's own quoted Claim (the rail API's quote, two-source truth) + derives the floor; native-AMM reuses the audited V3 codec. The **JAINE native-AMM adapter stays code-only + fails CLOSED** (`ROUTE_NATIVE_AMM_NOT_CONFIGURED`) — its router is unpublished on testnet (see `demo/EVIDENCE_ROUTE.md` §3a). Cross-chain rails are mainnet-only → operator-gated. |
| **BRIDGE adapter** | `agent/src/adapters/bridge_adapter.ts` | Chainlink CCIP bridge-in / bridge-out — ONE adapter per lane (USDC inbound / USDC.E egress / w0G egress). `quote` is a 1:1 lock/burn-and-mint (`expectedOut == amountIn`) gated on a **pinned, allow-listed `destSelector`** (never the decommissioned Galileo testnet lane); `buildUnsigned` reuses the `approve(tokenPool, amount)` codec + the deterministic `ccipSend` descriptor (preserved on-chain shape). CCIP is mainnet-only → `submit` operator-gated; an unconfigured pool fails CLOSED. |
| **The gateway** | `agent/src/gateway.ts` | `gateway.execute(intent)` — protocol-agnostic dispatch. (1) **quote** every registered adapter (read-only, moves nothing); (2) **order** the quotable candidates by **priced fallback** — best `expectedOut` first, ties broken by the lower registration priority (deterministic); (3) for each, build → **mandate `checkTransfer` PRE-submit** (the kill-switch, for EVERY adapter) → submit; (4) the **fund-loss-safe `value_moved` short-circuit**. |
| **Adapter-conformance test** | `agent/src/adapters/adapters.test.ts` | every adapter (swap/route/bridge) satisfies the five-method contract **identically** — the shared matrix (quote/build/submit/status/cancel + the value_moved discipline) plus the preserved on-chain shapes + each fail-closed (16 tests). |
| **Gateway test** | `agent/src/gateway.test.ts` | protocol-agnostic surface, priced fallback (best quote first, tie-break, build-fail fallback, not-quotable skip), the PRE-submit mandate kill-switch, and **the HARD invariant — the value_moved short-circuit** (23 tests). |

### The five-method contract (`agent/src/connector.ts`)

```
quote(intent, ctx)        -> Quote        // PRE-build, read-only. quotable:false => the gateway SKIPS. Moves nothing.
buildUnsigned(intent,ctx) -> UnsignedTx   // PURE/offline: ordered un-signed calls + the floor + a descriptor. Moves nothing.
submit(tx, ctx)           -> OrderId      // the ONLY value-mover. Operator-gated: no signer => fail CLOSED (loud not-wired).
status(orderId, ctx)      -> OrderStatus  // carries valueMoved. An unreadable order => UNKNOWN (loud degrade).
cancel(orderId, ctx)      -> OrderStatus  // REFUSES a value-moved order (it cannot un-move funds). Never a fake "cancelled".
```

### The fund-loss-safe short-circuit (`agent/src/gateway.ts`) — the hard invariant

The gateway tracks ONE boundary — the first `submit` call. Everything strictly before it (quote, build, the
mandate gate) is **fallback-safe** (a failure moved nothing → try the next candidate). At `submit`:

1. **`submit` RETURNS an `OrderId`** ⇒ value moved ⇒ **STOP** (short-circuit). Never try another candidate —
   a re-dispatch could double-spend. The verdict is then the independent verifier's job.
2. **`submit` THROWS a `*_NOT_WIRED` error** ⇒ a *guaranteed* pre-broadcast refusal (the adapter contract:
   `submit` fails CLOSED **before** touching the live signer) ⇒ nothing moved ⇒ **safe to fall back**.
3. **`submit` THROWS anything else** (a live-signer failure that *could* have broadcast) ⇒ **AMBIGUOUS** ⇒
   the fund-loss-safe rule **STOPS** and refuses to fall back (never risk a double-spend on an unknown
   broadcast state). The conservative default — it errs toward STOP, never toward retry.

The gateway **never mints a settlement verdict** — it reports only *which adapter dispatched, with what order
id* (or *every candidate was refused pre-submit, here is each reason*). "Did it settle?" remains the
independent verifier's monopoly (design §3 #2); a defect is never fabricated into a `settled`.

---

## 2. The gate matrix (this step) — all GREEN

| Gate | Scope | Result |
|---|---|---|
| `npx tsc --noEmit` | `agent/` (incl. `connector.ts` + `gateway.ts` + 3 adapters) | ✅ clean |
| `npm test` | `agent/` (incl. the adapter-conformance + gateway suites) | ✅ **202**, 0 failed |
| `cargo build` (default/offline) | verifier | ✅ clean |
| `cargo clippy --all-targets -- -D warnings` | verifier | ✅ zero warnings |
| `cargo test` (default/offline) | verifier (incl. integration) | ✅ **289**, 0 failed |
| `forge build` / `forge test` | `contracts/` | ✅ **181**, 0 failed |
| `npx tsc --noEmit` / `npm test` | `web/` | ✅ clean / **8** pass |
| clean-room firewall | whole repo (113 publishable files) | ✅ GREEN |

> **No regression.** The Engine is a refactor: the existing swap/route/bridge legs (`swap.ts` / `route.ts` /
> `bridge.ts`) and their tests are **untouched and still green** — the adapters *wrap* them, reusing the
> proven codecs (`encodeExactInputSingle` / `encodeApprove` / the `ccipSend` descriptor); no on-chain shape
> changed. The agent gained a protocol-agnostic entrypoint, not a new action.

---

## 3. OPERATOR-GATED — the live dispatch (NOT executed by this build)

`gateway.execute` with no wired `LiveSigner` (`ctx.signer` omitted — the default build) plans + gates every
candidate and **dispatches NOTHING** (`GatewayOutcome.NO_DISPATCH`). A live dispatch requires the operator to
wire a funded-demo-wallet signer into `ctx.signer`; even then:

- the **mainnet legs move REAL value** (Oku swap, the cross-chain route rails, CCIP bridge) — operator-gated,
  per-trade cap, fresh demo wallet (design §13). **Do NOT run unattended.**
- the **JAINE native-AMM** adapter has **no live venue on testnet** (router unpublished — `EVIDENCE_ROUTE.md`
  §3a), so it **fails CLOSED** until a router is pinned in `proofagent.toml [route]`.
- **Never fabricate a SETTLED.** The gateway reports dispatch only; the independent verifier reads the chain
  to mint the per-action verdict.

---

## 4. The honesty boundary

- The agent calls `gateway.execute(intent)` — **never a specific protocol**. The gateway picks an adapter by
  quote/priority; the agent expresses *what it wants moved*, not *how*.
- `quote` + `buildUnsigned` are read-only/pure (offline-by-default, design §13); `submit` is the one
  value-moving seam, operator-gated and fail-CLOSED (loud not-wired — never a fabricated `OrderId`).
- The **fund-loss-safe `value_moved` short-circuit** is a structural invariant with a dedicated test: once a
  `submit` puts value in flight, the gateway **never** retries or falls back. An ambiguous (possibly-broadcast)
  submit failure also STOPS — the conservative, double-spend-safe default.
- The gateway **never claims `settled`** — settlement is the independent verifier's monopoly (design §3
  #2/#3). It reports dispatch + an honest per-candidate trail, never a fake success.
