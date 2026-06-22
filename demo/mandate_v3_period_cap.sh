#!/usr/bin/env bash
# ==================================================================================================
# ProofAgent-0G -- MandateRegistryV3 LIVE demo: the PERIOD CAP blocks a LOOPING sequence the per-tx
# cap would pass (the four-tier spend gate's headline, LIVE on 0G Galileo testnet 16602).
#
# THE HEADLINE (Tier 1 -- cumulative per-PERIOD cap closes looping-drain): the MVP's single per-tx cap
# happily passes EVERY small in-cap trade, so an attacker LOOPS small trades to drain past the ceiling.
# MandateRegistryV3 adds a cumulative per-period accumulator: each in-cap spend ATOMICALLY accrues into
# a rolling window, and once the window fills, the NEXT in-cap loop is BLOCKED with OVER_PERIOD_CAP --
# even though the per-tx cap alone would let it through. This script proves that on the real chain.
#
#   per-tx cap   = 2,000,000 wei   (a single 1,000,000 spend passes it trivially)
#   period cap   = 1,500,000 wei / hour   (Tier 1: the cumulative window)
#   => loop 1 of 1,000,000  -> gateAndRecord PASSES + accrues (1,000,000 in the window)
#   => loop 2 of 1,000,000  -> checkTransfer is BLOCKED: 1,000,000 + 1,000,000 = 2,000,000 > 1,500,000
#                              (the per-tx cap would have passed it; the PERIOD cap catches it)
#
# Every fact below is a real, confirmable on-chain read (chainscan-galileo.0g.ai). The accrual is a real
# on-chain tx; the gate reads are zero-gas eth_calls. The verifier confirms each tier via the same reads.
#
# MONEY-SAFETY (design SS8): testnet only (the script REFUSES any other chain id); the mandate is YOUR
# OWN contract, so the accrue tx moves NO value (it only updates the registry's accumulator) -- it is a
# $0 demo. The private key is read from PRIVATE_KEY and is NEVER printed or committed.
#
# CLEAN-ROOM (design SS6): self-contained; no proprietary identifier, private path, or secret. Reads its
# knobs from the environment (.env is gitignored). Talks to 0G only via public JSON-RPC.
#
# USAGE:
#   set -a; . ./.env; set +a              # OG_RPC_TESTNET / WALLET_ADDRESS / PRIVATE_KEY from the .env
#   MANDATE_V3_ADDRESS=0x... ./demo/mandate_v3_period_cap.sh             # read-only: probe the gate live
#   MANDATE_V3_ADDRESS=0x... ./demo/mandate_v3_period_cap.sh --accrue    # also send the real accrue tx
#
# Requires: `cast` (Foundry) on PATH.
# ==================================================================================================
set -euo pipefail

RPC="${OG_RPC_TESTNET:-https://evmrpc-testnet.0g.ai}"   # 0G Galileo testnet JSON-RPC
EXPECTED_CHAIN_ID=16602
EXPLORER="https://chainscan-galileo.0g.ai"
REG="${MANDATE_V3_ADDRESS:?set MANDATE_V3_ADDRESS (the deployed MandateRegistryV3)}"
WALLET="${WALLET_ADDRESS:?set WALLET_ADDRESS (the demo wallet / mandated agent)}"
NATIVE="${NATIVE_ASSET_SENTINEL:-0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE}"
LOOP_WEI="${LOOP_WEI:-1000000}"     # each loop amount (within the 2,000,000 per-tx cap)
GAS_PRICE="${GAS_PRICE:-5000000000}"
PRIO_GAS="${PRIO_GAS:-2500000000}"
DO_ACCRUE=0
[ "${1:-}" = "--accrue" ] && DO_ACCRUE=1

command -v cast >/dev/null 2>&1 || { echo "FATAL: cast (Foundry) not on PATH" >&2; exit 2; }

hr(){ printf '%s\n' "------------------------------------------------------------------------------------"; }
section(){ echo; hr; echo "$1"; hr; }

# --- chain guard (money-safety, design SS8): refuse anything but the Galileo testnet ---------------
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
if [ "$ACTUAL_CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]; then
  echo "FATAL: connected chain id $ACTUAL_CHAIN_ID != expected testnet $EXPECTED_CHAIN_ID -- refusing (design SS8)." >&2
  exit 2
fi

# checkTransfer helper -- the zero-gas gate read. Echoes "ok|REASON_ASCII".
check_transfer(){ # $1 = amount (wei)
  local amount="$1" out ok reason reason_ascii
  out="$(cast call "$REG" "checkTransfer(address,address,uint256)(bool,bytes32)" "$WALLET" "$NATIVE" "$amount" --rpc-url "$RPC")"
  ok="$(printf '%s\n' "$out" | sed -n '1p')"
  reason="$(printf '%s\n' "$out" | sed -n '2p')"
  reason_ascii="$(cast --to-ascii "$reason" 2>/dev/null | tr -d '\0' || true)"
  [ -z "$reason_ascii" ] && reason_ascii="OK"
  echo "$ok|$reason_ascii"
}

read_accrued(){ cast call "$REG" "accruedInWindow()(uint256)" --rpc-url "$RPC" | sed 's/ .*//'; }
read_headroom(){ cast call "$REG" "periodHeadroom()(uint256)" --rpc-url "$RPC" | sed 's/ .*//'; }

section "MandateRegistryV3 LIVE  (0G Galileo testnet $EXPECTED_CHAIN_ID  via $RPC)"
echo "registry (MandateRegistryV3): $REG   [$EXPLORER/address/$REG]"
echo "agent / demo wallet:          $WALLET"
echo "native-asset sentinel:        $NATIVE"
echo -n "per-tx cap:   "; cast call "$REG" "perTxCap()(uint256)" --rpc-url "$RPC"
echo -n "period (s):   "; cast call "$REG" "periodSeconds()(uint256)" --rpc-url "$RPC"
echo -n "period cap:   "; cast call "$REG" "periodCap()(uint256)" --rpc-url "$RPC"
echo "accrued now:  $(read_accrued)   headroom: $(read_headroom)"

# ==================================================================================================
section "STEP 1 / the per-tx cap PASSES a single $LOOP_WEI loop (this is what the MVP offers)"
G1="$(check_transfer "$LOOP_WEI")"
echo "[gate] checkTransfer($LOOP_WEI) -> ok=${G1%%|*} reason=${G1##*|}"
if [ "${G1%%|*}" != "true" ]; then
  echo "RESULT: a within-cap loop was NOT authorized (reason=${G1##*|}) -- the window may already be partly full." >&2
  echo "        (Re-run after the period rolls, or deploy a fresh registry, to see the empty-window headline.)" >&2
  exit 1
fi
echo "[gate] AUTHORIZED -- a single $LOOP_WEI spend is within BOTH the per-tx cap AND the current window."

# ==================================================================================================
section "STEP 2 / ACCRUE the first loop atomically (Tier 4: gate AND accrue in one fail-closed call)"
ACCRUED_BEFORE="$(read_accrued)"
if [ "$DO_ACCRUE" = "1" ]; then
  echo "[accrue] gateAndRecord($LOOP_WEI) -- a REAL on-chain tx that moves NO value, only the accumulator ..."
  RAW="$(cast send "$REG" "gateAndRecord(address,address,uint256,address)(bool,bytes32)" "$WALLET" "$NATIVE" "$LOOP_WEI" "0x0000000000000000000000000000000000000000" \
        --rpc-url "$RPC" --private-key "${PRIVATE_KEY:?set PRIVATE_KEY to --accrue}" --gas-price "$GAS_PRICE" --priority-gas-price "$PRIO_GAS" --json)"
  ATX="$(printf '%s\n' "$RAW" | tr ',{}' '\n' | sed -n 's/.*"transactionHash":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
  echo "[accrue] accrue tx: $ATX   [$EXPLORER/tx/$ATX]"
else
  echo "[accrue] (read-only mode) -- re-run with --accrue to send the real gateAndRecord tx."
  echo "         The CURRENT accrued total is read from the chain below; if a prior run accrued, it shows here."
fi
ACCRUED_AFTER="$(read_accrued)"
echo "[state] accrued in window: before=$ACCRUED_BEFORE  after=$ACCRUED_AFTER   headroom now: $(read_headroom)"

# ==================================================================================================
section "STEP 3 / THE HEADLINE -- the SECOND loop is BLOCKED by the PERIOD cap (per-tx would pass it)"
echo "[plan] the agent LOOPS: it proposes ANOTHER $LOOP_WEI -- still within the per-tx cap (2,000,000)."
G2="$(check_transfer "$LOOP_WEI")"
G2_OK="${G2%%|*}"; G2_REASON="${G2##*|}"
echo "[gate] checkTransfer($LOOP_WEI) -> ok=$G2_OK reason=$G2_REASON"
ACC="$(read_accrued)"
if [ "$ACC" = "0" ]; then
  echo "[note] the window currently reads 0 accrued -- accrue first (--accrue) to demonstrate the block live."
  echo "       With 0 accrued, a single $LOOP_WEI loop is correctly authorized (the per-tx AND period both pass)."
fi
if [ "$ACC" != "0" ] && [ "$G2_OK" = "false" ] && [ "$G2_REASON" = "OVER_PERIOD_CAP" ]; then
  echo
  echo "RESULT: HEADLINE PROVEN  ✅"
  echo "  loop 1 ($LOOP_WEI) accrued; loop 2 ($LOOP_WEI) would make the window total $((ACC + LOOP_WEI)) > the 1,500,000 period cap."
  echo "  The per-tx cap (2,000,000) ALONE would have PASSED loop 2 -- but the PERIOD cap BLOCKED it (OVER_PERIOD_CAP)."
  echo "  Looping-drain is closed, LIVE on $EXPLORER."
elif [ "$ACC" != "0" ] && [ "$G2_OK" = "true" ]; then
  echo "RESULT: UNEXPECTED -- with $ACC already accrued, loop 2 should have been blocked by the period cap." >&2
  exit 1
fi
