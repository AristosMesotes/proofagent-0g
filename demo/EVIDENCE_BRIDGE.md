# Evidence — the BRIDGE legs (CCIP bridge-IN + bridge-OUT egress) + the verifier's BRIDGE verdict-extension

STEP WOW-BRIDGE builds the bridge legs of design **WOW Feature 3 / 3b** — a mandate-gated Chainlink-CCIP
cross-chain transfer: **bridge-IN** (Ethereum → 0G, USDC → USDC.E lock-and-mint) and **bridge-OUT egress**
(0G → Ethereum/Arbitrum/Base/BNB; USDC.E burn → USDC release, and w0G CCT direct lanes) — and extends the
independent verifier to **mint a settlement verdict per hop by reading BOTH legs** (the source
`ccipSend`/burn event **and** the destination release/mint event), never the bridge / CCIP-explorer API.

> **The wow is the *proof*, not the DeFi.** The bridge leg scales the *action* (swap → route → bridge)
> while every hop stays **mandate-gated + verifier-confirmed**. **CCIP on 0G is MAINNET-only** — the
> Galileo testnet (16602) CCIP lane is **DECOMMISSIONED**, so there is **NO testnet rehearsal** — a live
> bridge moves **REAL value and is OPERATOR-GATED**. This step **builds + verifier-wraps** the code
> (offline-buildable, tape-tested, all gates green); it **does NOT execute on mainnet**.

---

## 1. What was built (offline-buildable, all green)

| Piece | File | What it does |
|---|---|---|
| **Bridge legs** (agent) | `agent/src/bridge.ts` | the WOW-Feature-3b per-hop envelope: (1) **pin the EXPECTED destination selector** — a non-allow-listed lane (e.g. the decommissioned Galileo lane) is refused **PRE-GATE**; (2) the **mandate gate pre-burn** (`checkTransfer(agent, token, amount)` must clear, or the hop is refused **pre-burn** — the kill-switch; *"the safest egress failure is the one that never burns on 0G"*); (3) BUILD the hop — the `approve(tokenPool, amount)` call (reusing the audited ERC-20 codec) + the deterministic `IRouterClient.ccipSend` descriptor (destSelector + receiver + tokenAmounts + feeToken); (4) `DRY_RUN` by default — send NOTHING. `LIVE` is operator-gated (needs a wired dispatcher) and fails CLOSED loudly otherwise — never a fabricated `messageId`. |
| **BRIDGE verdict-extension** (verifier) | `verifier/src/bridge.rs` | read **BOTH legs per hop** — the source burn/lock + the destination release/mint (the **Observation**) — adjudicate against the agent's `HopClaim` (the `sent` amount + the on-chain `min_release` floor — the **Claim**), and mint **`settled / hollow / mismatch / unverified`** — the SAME four-verdict alphabet, through the one `Verdict` monopoly. The **HOLLOW-EGRESS catch** (source burned, destination read + empty → `hollow`, **LOUD**) is the centerpiece. `verify_bridge` composes a multi-hop journey: **settled IFF every hop is independently settled**. |
| **Bridge tape test** | `verifier/tests/bridge_verdict.rs` | the four outcomes + the hollow-egress catch + the in-flight/unverified distinction + multi-hop composition + the NEG case, replayed offline from recorded two-leg reads (8 tests). |
| **Bridge leg test** | `agent/src/bridge.test.ts` | both directions + all three lanes dry-run, the EXPECTED-selector pin (decommissioned lane refused), the pre-burn kill-switch, fail-closed gate, operator-gated LIVE, the pool-not-configured loud refusal, exact-integer bigint floor (22 tests). |

### The BRIDGE verdict algebra (`verifier/src/bridge.rs`, `adjudicate_hop`)

A bridge hop reads **two legs** and mints one of the four `Verdict`s, evaluated strictly in order:

1. **`unverified`** — no source read at all (off-tape / unknown source tx). The loud degrade target — never
   a fabricated `settled` (design §3 #3).
2. **`hollow`** — the **source itself burned nothing** (on-record but moved nothing — no value left).
3. **`unverified`** — the source burned, but the **destination leg is UNREADABLE** (still in-flight). A
   loud honest absence — checked **before** the hollow-egress catch, so a still-arriving hop is **never**
   mislabelled a defect.
4. **`hollow`** — the **HOLLOW-EGRESS catch** (the centerpiece): the source burned, the destination leg was
   **READ** and released **`0`** (auto-exec failed / manual-exec pending / the message is
   Ready-for-manual-execution-FAILURE). Value left 0G and **did not arrive**. **LOUD**; the report's
   `is_hollow_egress()` flag prescribes the heal — *manually execute the pending CCIP message at the
   OffRamp*. Checked **before** any amount math.
5. **`mismatch`** — both legs read, the destination released a nonzero amount **below the on-chain
   `min_release` floor** the agent set (a short release; the lane's bound was violated). Checked **before**
   the band.
6. **`settled`** — both legs read: `released ≥ min_release` **and** within the exact-integer tolerance band
   of the amount `sent`. The value provably **left the source AND arrived on the destination**.
7. **`mismatch`** — above the floor but outside the band (a wrong-asset arrival / fee-skim beyond tolerance).

**The hollow-egress vs unverified distinction** is the heart of the proof: *hollow-egress* = "we READ the
destination and it is empty" (a real, loud, healable defect); *unverified* = "we could not READ the
destination yet" (still in-flight). The two are different code paths that can never be confused.

**Multi-hop composition** (`verify_bridge`): a journey is `settled` IFF every hop is independently
`settled`; otherwise the composed verdict is the **first non-settled hop's** verdict (the loud first
failure). An empty journey is `unverified`, never a vacuous `settled`. This is the multi-hop kill-shot:
`0G → Ethereum → Base` is settled only if BOTH hops settle — hop-1 says nothing about hop-2.

---

## 2. The gate matrix (this step) — all GREEN

| Gate | Scope | Result |
|---|---|---|
| `cargo build` (default/offline) | verifier (incl. `bridge.rs`) | ✅ clean |
| `cargo clippy --all-targets -- -D warnings` | verifier | ✅ zero warnings |
| `cargo test` | verifier (incl. `bridge_verdict`) | ✅ **289**, 0 failed |
| `npx tsc --noEmit` | `agent/` (incl. `bridge.ts`) | ✅ clean |
| `npm test` | `agent/` (incl. the bridge legs) | ✅ **202**, 0 failed |
| clean-room firewall | whole repo (113 publishable files) | ✅ GREEN |

> The `live` build (`LiveBridgeSource`, a **TWO-chain** `eth_getTransactionReceipt` reader) is
> **feature-gated**: it cannot *link* on this windows-gnu host (no `as.exe`), but the feature-gated code is
> exercised by the default offline build via the tape, and the live read is the same raw-JSON-RPC shape
> `LiveSource` uses — one POST to the **source** chain RPC (the burn/lock leg) and one to the
> **destination** chain RPC (the release/mint leg).

---

## 3. OPERATOR-GATED — the live bridge (NOT executed by this build)

CCIP on 0G is **MAINNET-only (16661)** — the Galileo testnet (16602) CCIP lane is **DECOMMISSIONED**
(no new CCIP tx to/from 16602), so there is **NO testnet rehearsal**. A live bridge moves **REAL value**
under the per-trade cap. **Do NOT run unattended.** The agent builds the hop (the EXPECTED-selector pin +
the gate + the `ccipSend` descriptor) but sends NOTHING in `DRY_RUN`; `LIVE` requires an explicit
`mode: "LIVE"` AND a wired `BridgeDispatcher`, failing CLOSED with a loud not-wired error otherwise
(never a fabricated `messageId`). To run the live bridge, an operator:

```bash
# 0. Pin the lane's on-chain token POOL (a PUBLIC protocol fact) in proofagent.toml [bridge] / the agent
#    venue once confirmed (the agent default leaves tokenPool="" so an unconfigured hop fails CLOSED loud).
# 1. Load the gitignored .env (OG_RPC = the 0G MAINNET RPC, DEST_RPC = the destination chain's RPC,
#    WALLET_ADDRESS, PRIVATE_KEY). NEVER print/commit the key.
set -a; . ./.env; set +a
SRC_RPC="$OG_RPC"            # the SOURCE chain RPC (0G for an egress hop; Ethereum for an inbound hop)
# CHAIN GUARD (design §13): a live CCIP bridge runs ONLY on 0G mainnet 16661 (Galileo CCIP is decommissioned).
test "$(cast chain-id --rpc-url "$SRC_RPC")" = "16661" || { echo "FATAL: not 0G mainnet 16661 (CCIP)" >&2; exit 2; }
# 2. MANDATE GATE pre-burn: checkTransfer(agent, token, amount) MUST be (true, OK) or STOP (the kill-switch).
#    The agent ALSO asserts the EXPECTED destSelector is an allow-listed lane (never the decommissioned one).
# 3. APPROVE the token POOL to pull `amount`:  cast send $BRIDGE_TOKEN "approve(address,uint256)" $BRIDGE_TOKEN_POOL $BRIDGE_AMOUNT --rpc-url "$SRC_RPC" --private-key "$PRIVATE_KEY"
# 4. QUOTE the CCIP fee first (overpaying msg.value above getFee is NOT refunded -- design WOW F3b):
#    cast call $CCIP_ROUTER "getFee(uint64,(bytes,bytes,(address,uint256)[],address,bytes))" ... --rpc-url "$SRC_RPC"
# 5. ccipSend the EVM2AnyMessage (receiver, tokenAmounts=[{token,amount}], feeToken, extraArgs) with value=fee:
#    cast send $CCIP_ROUTER "ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))" $BRIDGE_DEST_SELECTOR ... --value <fee> --rpc-url "$SRC_RPC" --private-key "$PRIVATE_KEY"
#    -> capture the SOURCE tx hash + the CCIP messageId.
# 6. WAIT for async delivery (~15 min; the DON waits for source finality, then commits + executes), then
#    read the DESTINATION release/mint tx on the OTHER chain ($DEST_RPC) -> capture the DEST tx hash.
# 7. VERIFY (the verifier's BRIDGE extension reads BOTH legs):
#      source burned == 0                       -> hollow (a hollow source -- nothing left)
#      dest UNREADABLE (still in-flight)         -> unverified (still arriving -- NOT a defect)
#      dest READ + released == 0                 -> HOLLOW-EGRESS (hollow, LOUD; heal = manual-exec at OffRamp)
#      dest released <  minRelease               -> mismatch (short release; the floor violated)
#      |dest released - sent| <= band            -> settled (value LEFT the source AND ARRIVED on the dest)
#      else                                      -> mismatch
```

### The hollow-egress heal (when a real egress gets stuck)

If the verifier stamps **hollow-egress** (source burned, destination empty), CCIP delivery did **not**
auto-execute — the message sits **Ready-for-manual-execution / FAILURE** with zero tokens released. The
prescribed heal (design WOW Feature 3b) is to **manually execute the pending CCIP message at the
destination OffRamp** (the value is recoverable — it is locked/burned at the source pool, awaiting the
manual exec), then re-read the destination leg and re-verify. A `hollow-egress` is **never** silently
counted as a completed bridge.

### After a real live bridge — pin it (so the OFFLINE verifier replays BOTH legs)

Add the hop to a bridge tape / `[[bridge.corpus]]` with `{ source_hash, dest_hash, sent, min_release,
burned, released }` (each leg confirmable on its chain's explorer), then record it in the table below.
**Never fabricate a SETTLED** — an unpinned hop stays off-tape → `unverified`; a burned-source/empty-dest
hop is the HOLLOW-EGRESS catch → `hollow`.

| source hash | dest hash | lane | dest selector | sent | minRelease | burned | released | verdict |
|---|---|---|---|---|---|---|---|---|
| _(operator-gated — none broadcast by this build)_ | | | | | | | | |

---

## 4. The honesty boundary

- The agent's bridge hop **never claims `settled`** — that is the verifier's job, and a bridge hop is
  settled **ONLY** when the verifier reads **BOTH** legs (the verdict monopoly, design §3 #2; the
  hollow-egress catch, design WOW Feature 3b). The hop reports only `blocked_by_mandate` /
  `planned_dry_run` / `dispatched_live`.
- The default build is **dry-run**: it reads the gate (when a transport is wired) + **builds** the hop, but
  sends **nothing**. LIVE fails CLOSED without an explicit opt-in + a wired dispatcher — never a fabricated
  `messageId` (design §13). The EXPECTED destination selector is pinned + allow-list-checked so the agent
  can only emit lane-shaped, correctly-addressed sends (never the decommissioned testnet lane).
- The verifier's BRIDGE extension degrades an **unreadable** hop (or a still-in-flight destination)
  **loudly to `unverified`** — the bridge analogue of the settlement NEG case — and the **HOLLOW-EGRESS**
  catch (burned-on-0G, nothing-on-destination) is a real, loud `hollow` with a prescribed heal, **never** a
  fabricated `settled` (design §3 #3). A multi-hop journey is settled only if **every** hop is
  independently settled.
