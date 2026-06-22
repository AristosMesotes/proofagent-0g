# Evidence — the ROUTE leg (Khalani / LI.FI / JAINE) + the verifier's ROUTE verdict-extension

STEP WOW-ROUTING builds the routing leg of design **WOW Feature 2** — a mandate-gated routed action
across the three public 0G routing rails (intent / aggregation / native-AMM) — and extends the
independent verifier to **mint a settlement verdict per routed leg** by reading the rail's on-chain
settle/refund event + delivered amount, never the aggregator API.

> **The wow is the *proof*, not the DeFi.** The route leg scales the *action* (swap → route) while every
> leg stays **mandate-gated + verifier-confirmed**. The cross-chain rails (intent/aggregation) are
> **MAINNET-only** on 0G (Khalani has no testnet; LI.FI's 0G entry is 16661-only), so a live route moves
> **REAL value and is OPERATOR-GATED**. The native-AMM rail (JAINE) is the one *structurally*
> testnet-able rail, BUT a live $0 demo on 16602 was researched (2026-06-22) and is **infeasible today —
> JAINE has no usable testnet venue on Galileo (16602): the router/factory have no on-chain code, the
> wallet holds no tradeable JAINE token, and the listed test token is a dormant shell** (the precise,
> reproducible blocker is in **§3a**). So the route leg stays **honestly code-only** (claim only what's
> live — no SETTLED fabricated). This step **builds + verifier-wraps** the code (offline-buildable,
> tape-tested, all gates green); it **does NOT execute on mainnet** and **cannot execute on 16602** until
> JAINE publishes a live router with a funded pool.

---

## 1. What was built (offline-buildable, all green)

| Piece | File | What it does |
|---|---|---|
| **Route leg** (agent) | `agent/src/route.ts` | the WOW-Feature-2 per-leg envelope: (1) the **mandate gate pre-route** (`checkTransfer(agent, tokenIn, amountIn)` must clear, or the leg is refused **pre-broadcast** — the kill-switch); (2) BUILD the rail-shaped leg — for native-AMM the ordered `approve` → V3 `exactInputSingle` calls (reusing the audited swap codec), for the cross-chain rails a deterministic, secret-free REST/SDK request descriptor; (3) `DRY_RUN` by default — dispatch NOTHING. `LIVE` is operator-gated (needs a wired dispatcher) and fails CLOSED loudly otherwise — never a fabricated ref. |
| **ROUTE verdict-extension** (verifier) | `verifier/src/route.rs` | read the rail's settle/refund event + delivered amount (the **Observation**), adjudicate it against the agent's `RouteClaim` (the quoted `expected_out` + the on-chain `min_out` floor — the **Claim**), and mint **`settled / hollow / mismatch / unverified`** — the SAME four-verdict alphabet, through the one `Verdict` monopoly. `verify_route` composes a multi-leg route: **settled IFF every leg is independently settled**. |
| **Route tape test** | `verifier/tests/route_verdict.rs` | the four outcomes + the Khalani `refunded` rule + multi-leg composition + the NEG case, replayed offline from recorded rail reads (6 tests). |
| **Route leg test** | `agent/src/route.test.ts` | all three rails dry-run, the pre-route kill-switch, fail-closed gate, operator-gated LIVE, the native-AMM-not-configured loud refusal, exact-integer bigint floor (16 tests). |

### The ROUTE verdict algebra (`verifier/src/route.rs`, `adjudicate_route_leg`)

A routed leg mints one of the four `Verdict`s, evaluated strictly in order:

1. **`unverified`** — the chain could not be read (off-tape / unknown leg tx). The loud degrade target —
   never a fabricated `settled` (design §3 #3).
2. **`hollow`** — a **non-settlement terminal** (`refunded` / `failed`). The **Khalani `refunded` rule**
   (design WOW Feature 2): a refunded intent leg returned the funds and delivered nothing — checked
   **before** any amount math, so a refund can **never** settle, and a rail that *reports* `filled` while
   the chain shows a refund is caught here, not trusted.
3. **`hollow`** — a `filled` status whose independently-observed delivery is **`0`** (an API false-`filled`).
4. **`mismatch`** — `filled` with a delivered amount **below the on-chain `min_out` floor** the agent set
   (the leg's own slippage / route-quality bound was violated). Checked **before** the band.
5. **`settled`** — `delivered ≥ min_out` **and** within the exact-integer tolerance band of `expected_out`.
6. **`mismatch`** — above the floor but outside the band (slippage / wrong-asset / short fill).

**Multi-leg composition** (`verify_route`): a route is `settled` IFF every leg is independently `settled`;
otherwise the composed verdict is the **first non-settled leg's** verdict (the loud first failure). An
empty route is `unverified`, never a vacuous `settled`.

---

## 2. The gate matrix (this step) — all GREEN

| Gate | Scope | Result |
|---|---|---|
| `cargo build` (default/offline) | verifier (incl. `route.rs`) | ✅ clean |
| `cargo clippy --all-targets -- -D warnings` | verifier | ✅ zero warnings |
| `cargo test` | verifier (incl. `route_verdict`) | ✅ **289**, 0 failed |
| `npx tsc --noEmit` | `agent/` (incl. `route.ts`) | ✅ clean |
| `npm test` | `agent/` (incl. the route leg) | ✅ **202**, 0 failed |
| `forge build` / `forge test` | `contracts/` (incl. MandateRegistryV3) | ✅ **181**, 0 failed |
| `npx tsc --noEmit` / `npm test` | `web/` | ✅ clean / **8** pass |
| clean-room firewall | whole repo (116 publishable files) | ✅ GREEN |

> The `live` build (`LiveRouteSource`, a real `eth_getTransactionReceipt` reader) is **feature-gated**:
> it cannot *link* on this windows-gnu host (no `as.exe`), but the feature-gated code is exercised by the
> default offline build via the tape, and the live read is the same raw-JSON-RPC shape `LiveSource` uses.

---

## 3. OPERATOR-GATED — the live route actions (NOT executed by this build)

### 3a. Native-AMM (JAINE) — the would-be TESTNET-able rail — BLOCKED: no usable venue on 16602

> **Researched 2026-06-22 (claim only what's live).** The native-AMM rail is the *one* WOW rail that is
> structurally testnet-able (a same-chain swap can run under the full mandate-gate + verifier wrap at $0).
> A live $0 JAINE swap on Galileo (16602) was investigated end-to-end and is **infeasible right now** —
> JAINE has **no usable testnet venue on 16602**. The leg therefore stays **honestly code-only**:
> `jaineRouter` is `""` in `OG_ROUTE_VENUE`, so the native-AMM build **fails CLOSED loudly** rather than
> target a non-existent / baked-in address (tested by *"route native-AMM fails CLOSED when the JAINE
> router is not configured"*). **No SETTLED is fabricated** (design §3 #3).

#### The precise blocker — exactly what is missing (each line independently confirmable)

1. **No published JAINE router / factory / quoter address.** The official JAINE docs
   (`github.com/0gfoundation/jaine-docs`, `docs/developers/smart-contracts.md`) list the **SwapRouter,
   Factory, NFT Position Manager, and Quoter all as `TBD`** on the 0G testnet — every other docs page
   (`sdk.md`, `integration-guides.md`, `first-swap.md`, `subgraph.md`) contains **zero** `0x…40-hex`
   addresses. There is no router address to gate, approve, or swap through.
2. **The only candidate addresses that exist anywhere have NO code on 16602.** A third-party adapter
   (`github.com/mdlog/aegis-vault`, `JaineVenueAdapter.sol`) pins JAINE SwapRouter
   `0x8b598a7c136215a95ba0282b4d832b9f9801f2e2` and Factory `0x9bdcA5798E52e592A08e3b34d3F18EeF76Af7ef4`;
   the older zer0/Newton tooling (`github.com/desu777/zer0dex_interactionchecker`, `src/config/config.js`)
   pins SWAP `0xe233d75ce6f04c04610947188dec7c55790bef3b` + APPROVE `0x1E0D871472973c562650E991ED8006549F8CBEfc`.
   **`cast code` returns `0x` (no bytecode) for all of them on 16602** — they were the **Newton** testnet
   (Chain ID **16600**, now decommissioned; per `chainscan-galileo.0g.ai/llms.txt`), not Galileo (16602).
3. **No tradeable input token in the wallet, and the listed test tokens are dormant shells.** The demo
   wallet holds **only native 0G (~0.59)** and **0 W0G** (`0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c`).
   The JAINE-docs testnet tokens *do* have code on 16602 — `0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf`
   reports `symbol() = "ZER0-V3"` — but it is a non-functional shell: `totalSupply() == 41` (wei),
   `decimals()` **reverts**, the wallet's balance is **0**, and a **Transfer-event scan over ~50,000
   recent blocks found ZERO transfers** (the token, and the testnet DEX, are dormant).
4. **Therefore no pool with liquidity is reachable.** With no router/factory code, no quoter, no
   wallet-held tradeable token, and a dormant token with no transfers, there is **no pool the demo wallet
   can swap against** — a quote/approve/`exactInputSingle` cannot be built against a live venue.
5. **ABI note (a second, independent block even if an address appeared).** JAINE's published `ISwapRouter`
   (`smart-contracts.md`) uses the **8-field** `ExactInputSingleParams` **with a `deadline`** (the original
   Uniswap-V3 `SwapRouter` shape), whereas this build's route leg encodes the **7-field, no-deadline**
   `SwapRouter02` tuple (selector `0x04e45aaf`). A live JAINE swap would also need the agent codec switched
   to the 8-field router ABI first — tracked, not silently assumed compatible.

**Reproduce the blocker (all reads on testnet 16602; RPC = `https://evmrpc-testnet.0g.ai`):**

```bash
RPC=https://evmrpc-testnet.0g.ai
cast chain-id --rpc-url "$RPC"                                   # -> 16602 (Galileo)
# JAINE router/factory candidates -> NO code (empty 0x) on 16602:
cast code 0x8b598a7c136215a95ba0282b4d832b9f9801f2e2 --rpc-url "$RPC"   # -> 0x   (adapter's SwapRouter)
cast code 0x9bdcA5798E52e592A08e3b34d3F18EeF76Af7ef4 --rpc-url "$RPC"   # -> 0x   (adapter's Factory)
cast code 0xe233d75ce6f04c04610947188dec7c55790bef3b --rpc-url "$RPC"   # -> 0x   (zer0/Newton SWAP)
# The docs' testnet token has code but is a dormant shell with no wallet balance:
cast call 0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf "symbol()(string)"     --rpc-url "$RPC"  # -> "ZER0-V3"
cast call 0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf "totalSupply()(uint256)" --rpc-url "$RPC" # -> 41
cast call 0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf "balanceOf(address)(uint256)" \
  0xc7Af61A1399Aca0bee648D7853AE93f96B86866a --rpc-url "$RPC"                                  # -> 0
# Control: the gate (MandateRegistryV3) IS live on 16602 -> proves the read path is sound:
cast code 0xC24A325dB118cfFD586E72b9D085FB71D5202BD2 --rpc-url "$RPC" | head -c 12             # -> 0x60806040…
```

#### IF JAINE later publishes a router on 16602 — the live $0 runbook (operator)

The verifier-wrap and the agent's per-leg envelope are already built; only the live venue is missing. Once
JAINE publishes (and confirms on `chainscan-galileo.0g.ai`) a SwapRouter **with a liquid pool** for a pair
the wallet can fund, an operator pins it and runs:

```bash
# 0. Pin the CONFIRMED on-chain JAINE V3 router (a PUBLIC protocol fact) in proofagent.toml [route]:
#      [route]
#      jaine_router = "0x..."     # JAINE V3 router on 16602, with cast-code-confirmed bytecode + a funded pool
#    (and switch the agent codec to JAINE's 8-field `ExactInputSingleParams` WITH `deadline` — block #5 above)
# 1. Load the gitignored .env (ZEROG_RPC_URL = https://evmrpc-testnet.0g.ai, WALLET_ADDRESS, PRIVATE_KEY).
set -a; . ./.env; set +a
RPC="$ZEROG_RPC_URL"
# CHAIN GUARD (design §13): refuse anything but testnet 16602.
test "$(cast chain-id --rpc-url "$RPC")" = "16602" || { echo "FATAL: not 0G testnet 16602" >&2; exit 2; }
# 2. QUOTE on-chain (JAINE quoter) -> expectedOut; derive the exact-integer minOut floor.
# 3. MANDATE GATE pre-route: checkTransfer(agent, tokenIn, amountIn) MUST be (true, OK) or STOP (kill-switch).
# 4. APPROVE the JAINE router -> exactInputSingle (JAINE's 8-field router shape).
# 5. VERIFY (the verifier's ROUTE extension): read the settle event -> delivered amount -> verdict.
#      delivered == 0                       -> hollow (API false-fill)
#      delivered <  minOut                  -> mismatch (floor violated)
#      |delivered - expectedOut| <= band    -> settled
#      else                                 -> mismatch
```

### 3b. Cross-chain rails (Khalani intent · LI.FI aggregation) — MAINNET-only (REAL value)

These rails have **no 16602 testnet venue** — a live route moves REAL value on mainnet (16661) under the
per-trade cap. **Do NOT run unattended.** The agent builds the leg (gate + the rail's deterministic
REST/SDK descriptor) but dispatches NOTHING in `DRY_RUN`; `LIVE` requires an explicit `mode: "LIVE"` AND
a wired `RouteDispatcher`, failing CLOSED with a loud not-wired error otherwise (never a fabricated order
id / tx hash). The operator path:

```bash
# Intent (Khalani):     POST /v1/quotes -> POST /v1/deposit/build -> PUT /v1/deposit/submit
#                       -> GET /v1/orders/{addr} (deposited->filled | refund_pending->refunded)
# Aggregation (LI.FI):  GET /v1/quote (toChain=16661) -> sign the transactionRequest -> GET /v1/status
# Each leg is gate-checked PRE-dispatch; the verifier reads 0G directly per leg and mints the verdict.
# A `refunded` intent leg is a NON-settlement terminal (hollow), NEVER a fabricated settle.
```

### After a real live route — pin it (so the OFFLINE verifier replays it)

Add the route-leg read to a route tape / corpus with `{ hash, expected_out, min_out, terminal, delivered }`,
then record it in the table below. **Never fabricate a SETTLED** — an unpinned leg stays off-tape →
`unverified`.

| tx hash | rail | tokenIn → tokenOut | amountIn | expectedOut | minOut | terminal | delivered | verdict |
|---|---|---|---|---|---|---|---|---|
| _(operator-gated — none broadcast by this build)_ | | | | | | | | |

---

## 4. The honesty boundary

- The agent's route leg **never claims `settled`** — that is the verifier's job (the verdict monopoly,
  design §3 #2). The leg reports only `blocked_by_mandate` / `planned_dry_run` / `dispatched_live`.
- The default build is **dry-run**: it reads the gate (when a transport is wired) and **plans** the leg,
  but dispatches **nothing**. LIVE fails CLOSED without an explicit opt-in + a wired dispatcher — never a
  fabricated hash / order id (design §13).
- The verifier's ROUTE extension degrades an unreadable leg **loudly to `unverified`** — the route
  analogue of the settlement NEG case — and a `refunded` / `failed` terminal is a real, loud `hollow`,
  never a fabricated `settled` (design §3 #3; the Khalani `refunded` rule).
