#!/usr/bin/env bash
# ==================================================================================================
# ProofAgent-0G -- LIVE-LOOP demo: the three proofs, LIVE on 0G Galileo testnet (chain id 16602).
#
# Design SS2 (the three proofs), SS5 (the loop: plan -> mandate-gate -> execute -> verify), SS8
# (money-safety: testnet only, tiny amounts, the demo wallet). This script drives the loop END TO END
# against the REAL chain and prints a verdict for each of the three proofs. Every piece of evidence is
# a real, confirmable on-chain fact (tx hashes link to chainscan-galileo.0g.ai).
#
#   1. SETTLED  -- the agent requests a small CAPPED native transfer; the on-chain mandate gate
#                  (eth_call checkTransfer against the DEPLOYED MandateRegistry) AUTHORIZES it; a REAL
#                  capped native 0G transfer is broadcast (there is NO DEX on the testnet, so this is a
#                  plain capped transfer, not a swap); the independent verifier reads it on-chain
#                  (eth_getTransactionReceipt + eth_getTransactionByHash -- exactly the verifier's
#                  LiveSource read) and stamps SETTLED.
#   2. RAILS    -- the agent requests an OVER-cap action; checkTransfer returns (false, OVER_TX_CAP) =>
#                  the agent does NOT execute. The block is recorded as the rails (kill-switch) proof.
#   3. NEG      -- the verifier is pointed at a FABRICATED hash => it stamps UNVERIFIED (it reads the
#                  chain; an off-record / unknown hash degrades LOUDLY, never to a fabricated SETTLED).
#
# MONEY-SAFETY (design SS8): testnet only (the script REFUSES any other chain id), tiny amounts
# (minor-unit/wei transfers bounded by the on-chain cap), the DEMO wallet only -- never a product key.
# The private key is read from the PRIVATE_KEY environment variable and is NEVER printed or committed.
#
# CLEAN-ROOM (design SS6): self-contained; no proprietary identifier, private path, or secret. Reads
# its knobs from the environment (.env is gitignored). Talks to 0G only via public JSON-RPC.
#
# USAGE:
#   set -a; . ./.env; set +a        # load OG_RPC_TESTNET / WALLET_ADDRESS / MANDATE_REGISTRY_ADDRESS /
#                                    # PRIVATE_KEY from the gitignored .env (or export them yourself)
#   ./demo/live_loop.sh             # read-only by default: re-verifies the PINNED settled tx + rails + NEG
#   ./demo/live_loop.sh --broadcast # also broadcast a FRESH capped native transfer and verify it live
#
# Requires: `cast` (Foundry) on PATH. The independent Rust verifier is invoked when a `verifier`
# binary built with `--features live` is provided via VERIFIER_BIN (else the read is done inline with
# `cast`, mirroring the verifier's LiveSource RPC calls exactly).
# ==================================================================================================
set -euo pipefail

# --- knobs (from the environment; never hardcoded) ------------------------------------------------
RPC="${OG_RPC_TESTNET:-https://evmrpc-testnet.0g.ai}"   # 0G Galileo testnet JSON-RPC
EXPECTED_CHAIN_ID=16602                                   # Galileo testnet (design appendix)
EXPLORER="https://chainscan-galileo.0g.ai"
REG="${MANDATE_REGISTRY_ADDRESS:?set MANDATE_REGISTRY_ADDRESS (the deployed MandateRegistry)}"
WALLET="${WALLET_ADDRESS:?set WALLET_ADDRESS (the demo wallet / mandated agent)}"
# The canonical native-asset sentinel the mandate bounds the native transfer against (matches
# proofagent.toml [mandate].native_asset_sentinel). The registry rejects address(0) in setAssetCap.
NATIVE="${NATIVE_ASSET_SENTINEL:-0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE}"
# The pinned SETTLED tx (proofagent.toml [[verifier.corpus]]). Re-verified live every run.
SETTLED_TX="${SETTLED_TX:-0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0}"
# Amounts in MINOR units (wei). Within-cap <= perTxCap (2_000_000); over-cap > perTxCap.
WITHIN_CAP_WEI="${WITHIN_CAP_WEI:-1000000}"
OVER_CAP_WEI="${OVER_CAP_WEI:-3000000}"
# Testnet requires a minimum priority tip; pick safe legacy-ish gas knobs.
GAS_PRICE="${GAS_PRICE:-5000000000}"
PRIO_GAS="${PRIO_GAS:-2500000000}"
# A fabricated, well-formed-but-unknown hash for the NEG case.
FAKE_TX="0xdeadbeef00000000000000000000000000000000000000000000000000000000"
VERIFIER_BIN="${VERIFIER_BIN:-}"   # optional: a `verifier` built with --features live
DO_BROADCAST=0
[ "${1:-}" = "--broadcast" ] && DO_BROADCAST=1

command -v cast >/dev/null 2>&1 || { echo "FATAL: cast (Foundry) not on PATH" >&2; exit 2; }

hr(){ printf '%s\n' "------------------------------------------------------------------------------------"; }
section(){ echo; hr; echo "$1"; hr; }

# --- chain guard (money-safety, design SS8): refuse anything but the Galileo testnet ---------------
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
if [ "$ACTUAL_CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]; then
  echo "FATAL: connected chain id $ACTUAL_CHAIN_ID != expected testnet $EXPECTED_CHAIN_ID -- refusing (design SS8)." >&2
  exit 2
fi

section "ProofAgent-0G LIVE-LOOP  (0G Galileo testnet $EXPECTED_CHAIN_ID  via $RPC)"
echo "registry (MandateRegistry): $REG   [$EXPLORER/address/$REG]"
echo "agent / demo wallet:        $WALLET"
echo "native-asset sentinel:      $NATIVE"

# ==================================================================================================
# checkTransfer helper -- the off-chain half of the mandate gate (design SS4): an eth_call to the
# DEPLOYED registry. Echoes (ok, reason-ascii). NEVER mutates state; zero gas.
# ==================================================================================================
check_transfer(){ # $1 = amount (wei)
  local amount="$1" out ok reason
  out="$(cast call "$REG" "checkTransfer(address,address,uint256)(bool,bytes32)" "$WALLET" "$NATIVE" "$amount" --rpc-url "$RPC")"
  ok="$(printf '%s\n' "$out" | sed -n '1p')"
  reason="$(printf '%s\n' "$out" | sed -n '2p')"
  local reason_ascii; reason_ascii="$(cast --to-ascii "$reason" 2>/dev/null | tr -d '\0' || true)"
  [ -z "$reason_ascii" ] && reason_ascii="OK"
  echo "$ok|$reason_ascii"
}

# ==================================================================================================
# verify_settlement -- the independent verifier read (design SS2). Uses the real `verifier` binary
# (--features live) when VERIFIER_BIN is set; otherwise mirrors its LiveSource RPC calls inline with
# cast (eth_getTransactionReceipt.status + eth_getTransactionByHash.value). Echoes the verdict string.
# ==================================================================================================
verify_settlement(){ # $1 = tx hash, $2 = claimed (wei)
  local tx="$1" claimed="$2"
  if [ -n "$VERIFIER_BIN" ]; then
    # The DESIGNED path: the independent Rust verifier reads 0G itself via raw JSON-RPC.
    OG_RPC="$RPC" "$VERIFIER_BIN" verify-tx "$tx" 2>/dev/null || true
    return
  fi
  # Inline mirror of the verifier's LiveSource (verifier/src/source.rs):
  local status value_hex value
  status="$(cast rpc eth_getTransactionReceipt "$tx" --rpc-url "$RPC" 2>/dev/null | tr ',{}' '\n' | sed -n 's/.*"status":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
  if [ -z "$status" ]; then echo "unverified"; return; fi          # no receipt -> loud absence -> unverified
  if [ "$status" = "0x0" ]; then echo "hollow"; return; fi         # reverted -> moved nothing
  value_hex="$(cast rpc eth_getTransactionByHash "$tx" --rpc-url "$RPC" 2>/dev/null | tr ',{}' '\n' | sed -n 's/.*"value":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
  if [ -z "$value_hex" ]; then echo "unverified"; return; fi
  value="$(cast --to-dec "$value_hex")"
  # exact-integer adjudication, 15% band (proofagent.toml [verifier.tolerance]); claimed==observed here.
  if [ "$value" = "$claimed" ]; then echo "settled"; else echo "mismatch ($value vs $claimed)"; fi
}

# ==================================================================================================
# PROOF 1 -- SETTLED
# ==================================================================================================
section "PROOF 1 / SETTLED  -- capped native transfer, gate-authorized, chain-verified"
echo "[plan]        agent proposes a capped native transfer of $WITHIN_CAP_WEI wei (within the on-chain cap)"
GATE="$(check_transfer "$WITHIN_CAP_WEI")"
GATE_OK="${GATE%%|*}"; GATE_REASON="${GATE##*|}"
echo "[mandate-gate] checkTransfer($WALLET, $NATIVE, $WITHIN_CAP_WEI) -> ok=$GATE_OK reason=$GATE_REASON"
if [ "$GATE_OK" != "true" ]; then
  echo "RESULT: gate did NOT authorize a within-cap transfer (reason=$GATE_REASON) -- aborting PROOF 1." >&2
  exit 1
fi
echo "[mandate-gate] AUTHORIZED (the cap permits this spend)."

TX="$SETTLED_TX"
if [ "$DO_BROADCAST" = "1" ]; then
  echo "[execute]     broadcasting a FRESH capped native transfer ($WITHIN_CAP_WEI wei, self) ..."
  RAW="$(cast send "$WALLET" --value "$WITHIN_CAP_WEI" --rpc-url "$RPC" --private-key "${PRIVATE_KEY:?set PRIVATE_KEY to broadcast}" --gas-price "$GAS_PRICE" --priority-gas-price "$PRIO_GAS" --json)"
  TX="$(printf '%s\n' "$RAW" | tr ',{}' '\n' | sed -n 's/.*"transactionHash":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
  echo "[execute]     broadcast tx: $TX"
else
  echo "[execute]     re-verifying the PINNED settled transfer (run with --broadcast to send a fresh one)."
fi
echo "[execute]     tx: $TX   [$EXPLORER/tx/$TX]"
VERDICT="$(verify_settlement "$TX" "$WITHIN_CAP_WEI")"
echo "[verify]      independent on-chain read (eth_getTransactionReceipt + eth_getTransactionByHash) -> $VERDICT"
case "$VERDICT" in
  settled) echo "RESULT: PROOF 1 SETTLED  ✅  (claimed=$WITHIN_CAP_WEI wei == observed on-chain)";;
  *)       echo "RESULT: PROOF 1 did NOT settle: $VERDICT" >&2; exit 1;;
esac

# ==================================================================================================
# PROOF 2 -- RAILS (over-cap)
# ==================================================================================================
section "PROOF 2 / RAILS  -- over-cap request is BLOCKED pre-broadcast (the kill-switch)"
echo "[plan]        agent proposes an OVER-cap native transfer of $OVER_CAP_WEI wei (exceeds the on-chain per-tx cap)"
GATE2="$(check_transfer "$OVER_CAP_WEI")"
GATE2_OK="${GATE2%%|*}"; GATE2_REASON="${GATE2##*|}"
echo "[mandate-gate] checkTransfer($WALLET, $NATIVE, $OVER_CAP_WEI) -> ok=$GATE2_OK reason=$GATE2_REASON"
if [ "$GATE2_OK" = "false" ]; then
  echo "[execute]     NOT executed -- the agent obeys the kill-switch; NOTHING was broadcast."
  echo "RESULT: PROOF 2 RAILS  ✅  (over-cap BLOCKED on-chain, reason=$GATE2_REASON; no tx sent)"
else
  echo "RESULT: PROOF 2 FAILED -- an over-cap request was NOT blocked (ok=$GATE2_OK)" >&2
  exit 1
fi

# ==================================================================================================
# PROOF 3 -- NEG (fabricated hash -> UNVERIFIED)
# ==================================================================================================
section "PROOF 3 / NEG  -- a fabricated hash stamps UNVERIFIED (the verifier reads the chain)"
echo "[verify]      verify-tx $FAKE_TX  (well-formed, but NOT on-chain)"
NEG_VERDICT="$(verify_settlement "$FAKE_TX" "$WITHIN_CAP_WEI")"
echo "[verify]      independent on-chain read -> $NEG_VERDICT"
case "$NEG_VERDICT" in
  unverified) echo "RESULT: PROOF 3 NEG  ✅  (a fabricated hash degrades LOUDLY to UNVERIFIED, never a fake SETTLED)";;
  *)          echo "RESULT: PROOF 3 FAILED -- a fabricated hash did NOT stamp unverified: $NEG_VERDICT" >&2; exit 1;;
esac

# ==================================================================================================
section "ALL THREE PROOFS LIVE  ✅   SETTLED / RAILS / NEG  -- all confirmable on $EXPLORER"
echo "SETTLED tx: $EXPLORER/tx/$TX"
echo "RAILS:      over-cap checkTransfer($OVER_CAP_WEI) = (false, $GATE2_REASON)  [no broadcast]"
echo "NEG:        verify-tx $FAKE_TX = unverified"
