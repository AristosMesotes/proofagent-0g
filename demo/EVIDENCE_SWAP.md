# Evidence — the SWAP leg (Oku/Uniswap-V3) + the verifier's SWAP verdict-extension

STEP WOW-SWAP builds the swap leg of design **WOW Feature 1** — an exact-input single-hop Uniswap-V3
swap via Oku's `SwapRouter02` on 0G — and extends the independent verifier to **mint a settlement
verdict for a swap** by decoding the on-chain `Swap` event's realized `amountOut`.

> **Oku/Uniswap-V3 is MAINNET-only on 0G** (there is **no** 16602 testnet deployment), so the **live
> swap moves REAL value and is OPERATOR-GATED**. This step **builds + verifier-wraps** the code
> (offline-buildable, tape-tested, all gates green); it **does NOT execute on mainnet**. The exact
> operator command to run the live swap and capture the on-chain evidence is documented below.

---

## 1. What was built (offline-buildable, all green)

| Piece | File | What it does |
|---|---|---|
| **Swap leg** (agent) | `agent/src/swap.ts` | the full WOW-Feature-1 path: (1) read the `QuoterV2` quote on-chain → `expectedOut`; (2) derive the exact-integer `amountOutMinimum` floor; (3) the **mandate gate pre-swap** (`checkTransfer(agent, tokenIn, amountIn)` must clear, or the leg is refused **pre-broadcast**); (4) `approve` → (5) `exactInputSingle` |
| **SWAP verdict-extension** (verifier) | `verifier/src/swap.rs` | decode the pool's `Swap` event → the realized `amountOut` (the **Observation**), adjudicate it against the agent's quoted `expectedOut` + the on-chain `amountOutMinimum` floor (the **Claim**), and mint **`settled / hollow / mismatch / unverified`** — the SAME four-verdict alphabet, through the one `Verdict` monopoly |
| **Swap tape test** | `verifier/tests/swap_verdict.rs` | the four outcomes, replayed offline from recorded `Swap`-event reads |
| **Swap leg test** | `agent/src/swap.test.ts` | quote read, the pre-swap kill-switch, dry-run / operator-gated LIVE — all offline |

### The SWAP verdict algebra (`verifier/src/swap.rs`, `adjudicate_swap`)

A swap mints one of the four `Verdict`s from the realized `amountOut`, evaluated strictly in order:

1. **`unverified`** — the chain could not be read (off-tape / unknown tx). The loud degrade target —
   never a fabricated `settled` (design §3 #3).
2. **`hollow`** — the tx is on-record and succeeded but the swap realized **nothing** (no `Swap` event,
   or a decoded `amountOut == 0`).
3. **`mismatch`** — the realized `amountOut` is **below the on-chain `amountOutMinimum` floor** the agent
   set (the protocol's own slippage protection was violated). Checked **before** the band, so a
   below-floor output can **never** settle — even at the expected amount.
4. **`settled`** — `amountOut ≥ floor` **and** within the exact-integer tolerance band of `expectedOut`.
5. **`mismatch`** — above the floor but outside the band (the chain disagrees with the claim).

The realized output is the **pool-negative side** of the `Swap` event's `(amount0, amount1)` deltas (the
token leaving the pool to the recipient). The event topic0 is pinned (`SWAP_EVENT_TOPIC0`):
`keccak("Swap(address,address,int256,int256,uint160,uint128,int24)")` =
`0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`.

---

## 2. The gate matrix (this step) — all GREEN

| Gate | Scope | Result |
|---|---|---|
| `cargo build` (default/offline) | verifier (incl. `swap.rs`) | ✅ clean |
| `cargo clippy --all-targets -- -D warnings` | verifier | ✅ zero warnings |
| `cargo test` | verifier (incl. `swap_verdict`) | ✅ **289**, 0 failed |
| `cargo check --features live` | the `LiveSwapSource` decoder compiles | ✅ clean (the `live` build can't *link* on this windows-gnu host — no `as.exe` — but the feature-gated code compiles) |
| `npx tsc --noEmit` | `agent/` (incl. `swap.ts`) | ✅ clean |
| `npm test` | `agent/` (incl. the swap leg) | ✅ **202**, 0 failed |
| `forge build` / `forge test` | `contracts/` | ✅ **181**, 0 failed |
| clean-room firewall | whole repo | ✅ GREEN |

---

## 3. OPERATOR-GATED — the exact live-swap command (mainnet 16661, REAL value)

**Do NOT run this unattended.** It broadcasts a value-bearing swap on 0G mainnet under the per-trade
cap. Run it only with operator confirmation, a funded fresh demo wallet, and a hard per-trade cap.

```bash
# 0. Load the gitignored .env (OG_RPC_MAINNET, WALLET_ADDRESS, PRIVATE_KEY, SWAP_* knobs, MANDATE_REGISTRY_ADDRESS).
set -a; . ./.env; set +a

RPC="$OG_RPC_MAINNET"                       # 0G Aristotle (16661)
ROUTER="${SWAP_ROUTER02:-0x807F4E281B7A3B324825C64ca53c69F0b418dE40}"
QUOTER="${QUOTER_V2:-0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455}"
TOKEN_IN="$SWAP_TOKEN_IN"; TOKEN_OUT="$SWAP_TOKEN_OUT"
FEE="${SWAP_FEE_TIER:-10000}"; AMT_IN="$SWAP_AMOUNT_IN"; SLIP_BPS="${SWAP_SLIPPAGE_BPS:-50}"
SELF="$WALLET_ADDRESS"

# CHAIN GUARD (design §13): refuse anything but mainnet 16661.
test "$(cast chain-id --rpc-url "$RPC")" = "16661" || { echo "FATAL: not 0G mainnet 16661" >&2; exit 2; }

# 1. QUOTE on-chain (QuoterV2.quoteExactInputSingle) -> expectedOut (word 0 of the return).
EXPECTED_OUT="$(cast call "$QUOTER" \
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" \
  "($TOKEN_IN,$TOKEN_OUT,$AMT_IN,$FEE,0)" --rpc-url "$RPC" | sed -n '1p')"

# 2. FLOOR = expectedOut - expectedOut*SLIP_BPS/10000 (exact-integer; matches agent/execute.ts slippageFloor).
FLOOR=$(( EXPECTED_OUT - EXPECTED_OUT * SLIP_BPS / 10000 ))

# 3. MANDATE GATE pre-swap: checkTransfer(agent, tokenIn, amountIn) MUST be (true, OK) or STOP (kill-switch).
GATE="$(cast call "$MANDATE_REGISTRY_ADDRESS" "checkTransfer(address,address,uint256)(bool,bytes32)" \
  "$SELF" "$TOKEN_IN" "$AMT_IN" --rpc-url "$RPC" | sed -n '1p')"
test "$GATE" = "true" || { echo "BLOCKED by mandate (the agent does NOT execute) -- $GATE" >&2; exit 1; }

# 4. APPROVE the router to pull amountIn of tokenIn.
cast send "$TOKEN_IN" "approve(address,uint256)" "$ROUTER" "$AMT_IN" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY"

# 5. SWAP: exactInputSingle (7-field tuple, NO deadline). amountOutMinimum = FLOOR, sqrtPriceLimitX96 = 0.
TX="$(cast send "$ROUTER" \
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
  "($TOKEN_IN,$TOKEN_OUT,$FEE,$SELF,$AMT_IN,$FLOOR,0)" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json | sed -n 's/.*"transactionHash":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
echo "swap tx: https://chainscan.0g.ai/tx/$TX"

# 6. VERIFY (the verifier's SWAP extension): read the Swap event -> realized amountOut -> verdict.
#    The `live` build can't link on this host; the read is the same one LiveSwapSource performs:
RECEIPT="$(cast rpc eth_getTransactionReceipt "$TX" --rpc-url "$RPC")"
#    -> find the log whose topic0 == 0xc42079f9...cca67 (the Swap event), decode amount0/amount1 (int256),
#       the realized amountOut is the magnitude of the NEGATIVE delta. Then:
#         amountOut == 0                  -> hollow
#         amountOut <  FLOOR              -> mismatch (slippage floor violated)
#         |amountOut - EXPECTED_OUT| <= band(EXPECTED_OUT, 15%)  -> settled
#         else                            -> mismatch
```

### After a real live swap — pin it (so the OFFLINE verifier replays it)

Add a `[[swap.corpus]]` entry to `proofagent.toml` with `{ hash, expected_out, amount_out_minimum,
observed = <realized amountOut from the Swap event> }`, then record it in this file's table below.
**Never fabricate a SETTLED** — an unpinned swap stays off-tape → `unverified`.

| tx hash | tokenIn → tokenOut | amountIn | expectedOut | floor | realized amountOut | verdict |
|---|---|---|---|---|---|---|
| _(operator-gated — none broadcast by this build)_ | | | | | | |

---

## 4. The honesty boundary

- The agent's swap leg **never claims `settled`** — that is the verifier's job (the verdict monopoly,
  design §3 #2). The leg reports only `quote_failed` / `blocked_by_mandate` /
  `planned_dry_run` / `broadcast_live`.
- The default build is **dry-run**: it reads the quote + gate (when a transport is wired) and **plans**
  the swap, but broadcasts **nothing**. LIVE fails CLOSED without an explicit opt-in + a wired
  broadcaster — never a fabricated tx hash (design §13).
- The verifier's SWAP extension degrades an unreadable swap **loudly to `unverified`** — the swap
  analogue of the settlement NEG case — and never mints a fabricated `settled` (design §3 #3).
