#!/usr/bin/env bash
# End-to-end demo: create a market, trade in it, wait for it to close,
# resolve it, record a reasoning trace, and verify the trace hash on-chain.
#
# NETWORK=testnet (default) or NETWORK=local. The local path is what
# scripts/e2e-local.sh drives; it uses tiny close/dispute windows and the
# deployable test oracle for --mode price.
#
# Usage: scripts/demo.sh [--mode signer|price]
#   signer (default): attest through the resolver's signer mode.
#   price:            resolve through a Reflector-shaped oracle. Requires the
#                     `test-oracle` contract recorded in the deployment.
#
# What this script does NOT cover by itself: buying the trace through the x402
# HTTP service. scripts/e2e-local.sh starts x402 against the local registry and
# curls it; see docs/STATUS.md for the manual steps.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet | local) ;;
  *)
    echo "error: NETWORK must be testnet or local (never mainnet)" >&2
    exit 1
    ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
DEPLOYMENTS=${DEPLOYMENTS:-deployments/$NETWORK.json}
SLEEP=${SLEEP:-sleep}
NOW_CMD=${NOW_CMD:-date +%s}
if [ "$NETWORK" = "local" ]; then
  CLOSE_IN_SECONDS=${CLOSE_IN_SECONDS:-10}
  DISPUTE_WINDOW=${DISPUTE_WINDOW:-3}
else
  CLOSE_IN_SECONDS=${CLOSE_IN_SECONDS:-90}
  DISPUTE_WINDOW=${DISPUTE_WINDOW:-5}
fi
MODE=${MODE:-signer}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      if [ "$#" -lt 2 ]; then
        echo "error: --mode needs signer or price" >&2
        exit 2
      fi
      MODE=$2
      shift 2
      ;;
    --mode=*)
      MODE=${1#--mode=}
      shift
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done
case "$MODE" in
  signer | price) ;;
  *)
    echo "error: --mode must be signer or price" >&2
    exit 2
    ;;
esac

if [ ! -f "$DEPLOYMENTS" ]; then
  echo "error: run NETWORK=$NETWORK scripts/deploy-testnet.sh first" >&2
  exit 1
fi

MARKET_CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
REGISTRY=$(jq -r .contracts.reasoning_registry "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
ORACLE=$(jq -r '.contracts.test_oracle // empty' "$DEPLOYMENTS")

invoke() {
  stellar contract invoke --id "$1" --source-account "$2" --network "$NETWORK" -- "${@:3}"
}

read_only() {
  local err_file out rc
  err_file=$(mktemp)
  if out=$(stellar contract invoke --id "$1" --source-account "$DEPLOYER_KEY" --network "$NETWORK" -- "${@:2}" 2>"$err_file"); then
    rm -f "$err_file"
    printf '%s\n' "$out"
    return 0
  else
    rc=$?
    cat "$err_file" >&2
    rm -f "$err_file"
    return "$rc"
  fi
}

now_epoch() {
  local -a cmd
  read -r -a cmd <<<"$NOW_CMD"
  "${cmd[@]}"
}

RPC_URL=${SOROBAN_RPC_URL:-}
if [ -z "$RPC_URL" ]; then
  if [ "$NETWORK" = "local" ]; then
    RPC_URL=http://localhost:8000/soroban/rpc
  else
    RPC_URL=https://soroban-testnet.stellar.org
  fi
fi

wait_until() {
  # Skip waiting if target is already in the past according to NOW_CMD.
  local target=$1 now
  now=$(now_epoch)
  if [ "${now:-0}" -ge "$target" ]; then
    return 0
  fi
  # Poll RPC getLatestLedger instead of sleeping blindly.
  for _ in $(seq 1 120); do
    now=$(curl -sf -X POST "$RPC_URL" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq -r '.result.closeTime // 0')
    if [ "${now:-0}" -ge "$target" ]; then
      return 0
    fi
    "$SLEEP" 1
  done
  return 1
}

if [ "$MODE" = "price" ]; then
  if [ -z "$ORACLE" ]; then
    echo "error: --mode price requires contracts.test_oracle in $DEPLOYMENTS" >&2
    exit 1
  fi
  echo "### 1/5 create salted V2 price-mode market (via scripts/seed-market.sh)"
  QUESTION="OracleDesk price demo $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SEED_OUT=$(NETWORK="$NETWORK" IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
    PRICE_ASSET=other:XLM PRICE_THRESHOLD=2000 PRICE_DIRECTION=above PRICE_MAX_STALENESS=3600 \
    ./scripts/seed-market.sh --mode=price 1500000000 5000 "$CLOSE_IN_SECONDS" "$DISPUTE_WINDOW" "$QUESTION")
  printf '%s\n' "$SEED_OUT"
  MARKET_ID=$(printf '%s\n' "$SEED_OUT" | sed -n 's/^market_id=//p')
  CLOSE_TIME=$(printf '%s\n' "$SEED_OUT" | sed -n 's/^close_time=//p')
  if [ -z "$MARKET_ID" ] || [ -z "$CLOSE_TIME" ]; then
    echo "error: failed to parse market_id/close_time from seed-market.sh output" >&2
    exit 1
  fi
  echo "### 2/5 wait for close"
  wait_until "$((CLOSE_TIME + 1))" || "$SLEEP" "$((CLOSE_IN_SECONDS + 2))"

  # Align price timestamp to the oracle resolution slot after close so
  # test-oracle's FutureTimestamp check passes and slot <= close_time.
  ORACLE_RES=$(read_only "$ORACLE" resolution 2>/dev/null || echo 1)
  if [[ "$ORACLE_RES" =~ ^[0-9]+$ ]] && [ "$ORACLE_RES" -gt 1 ]; then
    PRICE_SLOT=$((CLOSE_TIME - (CLOSE_TIME % ORACLE_RES)))
    ALIGN_OFFSET=$((CLOSE_TIME - PRICE_SLOT))
    if [ "$ALIGN_OFFSET" -gt 0 ]; then
      echo "note: close_time=$CLOSE_TIME was ${ALIGN_OFFSET}s off the ${ORACLE_RES}s oracle grid; posting price at aligned slot $PRICE_SLOT (requires max_staleness >= ${ORACLE_RES}s)"
    else
      echo "note: close_time=$CLOSE_TIME landed exactly on the ${ORACLE_RES}s oracle grid (slot $PRICE_SLOT)"
    fi
  else
    PRICE_SLOT=$CLOSE_TIME
  fi
  echo "### 3/5 post price at aligned slot $PRICE_SLOT and resolve via price"
  invoke "$ORACLE" "$DEPLOYER_KEY" set_price --asset '{"Other":"XLM"}' --price 2100 --timestamp "$PRICE_SLOT"
  OUTCOME=$(invoke "$RESOLVER" "$AGENT_KEY" resolve_price --market_id "$MARKET_ID")
  echo "resolved outcome: $OUTCOME"
  if [ "$(printf '%s' "$OUTCOME" | tr -d '"[:space:]')" != "Yes" ]; then
    echo "FAILED: expected price-mode outcome Yes, got $OUTCOME" >&2
    exit 1
  fi

  echo "### 4/5 publish and verify reasoning trace"
  TRACE_JSON=$(mktemp)
  cat >"$TRACE_JSON" <<TRACE
{"agent":"market-maker","market_id":$MARKET_ID,"action":"create_market","mode":"price","reasoning":"OracleDesk price-mode demo run via scripts/demo.sh.","timestamp":$(now_epoch)}
TRACE
  if command -v sha256sum >/dev/null 2>&1; then
    TRACE_HASH=$(sha256sum "$TRACE_JSON" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    TRACE_HASH=$(shasum -a 256 "$TRACE_JSON" | cut -d' ' -f1)
  else
    TRACE_HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$TRACE_JSON")
  fi
  echo "trace hash: $TRACE_HASH"
  TRACE_CID=${TRACE_CID:-oracledesk-price-demo-trace.json}
  TRACE_DIR=${TRACE_DIR:-deployments/traces-$NETWORK}
  mkdir -p "$TRACE_DIR"
  cp "$TRACE_JSON" "$TRACE_DIR/$TRACE_CID"
  TRACE_ID=$(invoke "$REGISTRY" "$AGENT_KEY" publish_trace \
    --agent "$AGENT" --market_id "$MARKET_ID" --action CreateMarket \
    --trace_hash "$TRACE_HASH" --ipfs_cid "\"$TRACE_CID\"")
  echo "trace id: $TRACE_ID"
  VERIFIED=$(read_only "$REGISTRY" verify_trace --trace_id "$TRACE_ID" --received_hash "$TRACE_HASH")
  echo "verify_trace(correct hash) = $VERIFIED"
  rm -f "$TRACE_JSON"
  if [ "$VERIFIED" != "true" ]; then
    echo "FAILED: trace hash did not verify" >&2
    exit 1
  fi
else
  echo "### 1/6 create + seed market (treasury.agent_create_market)"
  SEED_OUT=$(NETWORK="$NETWORK" IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
    ./scripts/seed-market.sh 1500000000 5000 "$CLOSE_IN_SECONDS" "$DISPUTE_WINDOW" \
    "OracleDesk demo $(date -u +%Y-%m-%dT%H:%M:%SZ)")
  echo "$SEED_OUT"
  MARKET_ID=$(printf '%s\n' "$SEED_OUT" | sed -n 's/^market_id=//p')
  CLOSE_TIME=$(printf '%s\n' "$SEED_OUT" | sed -n 's/^close_time=//p')
  if [ -z "$MARKET_ID" ] || [ -z "$CLOSE_TIME" ]; then
    echo "error: failed to parse market_id/close_time from seed-market.sh output" >&2
    exit 1
  fi
  echo

  echo "### 2/6 trade (treasury.agent_buy) — price should move off 50/50"
  echo "price before: $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
  TRADE_TX=$(invoke "$TREASURY" "$AGENT_KEY" agent_buy --agent "$AGENT" --market_id "$MARKET_ID" --outcome Yes --collateral_in 100000000 --min_shares_out 0)
  echo "shares received: $TRADE_TX"
  echo "price after:  $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
  echo

  echo "### 3/6 wait for close_time, record reasoning trace, then attest with evidence"
  wait_until "$((CLOSE_TIME + 1))" || "$SLEEP" "$((CLOSE_IN_SECONDS + 2))"

  TRACE_JSON=$(mktemp)
  cat >"$TRACE_JSON" <<TRACE
{"agent":"market-maker","market_id":$MARKET_ID,"action":"create_market","reasoning":"OracleDesk demo run via scripts/demo.sh.","timestamp":$(now_epoch)}
TRACE
  if command -v sha256sum >/dev/null 2>&1; then
    TRACE_HASH=$(sha256sum "$TRACE_JSON" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    TRACE_HASH=$(shasum -a 256 "$TRACE_JSON" | cut -d' ' -f1)
  else
    TRACE_HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$TRACE_JSON")
  fi
  echo "trace hash: $TRACE_HASH"
  TRACE_CID=${TRACE_CID:-oracledesk-demo-trace.json}
  TRACE_DIR=${TRACE_DIR:-deployments/traces-$NETWORK}
  mkdir -p "$TRACE_DIR"
  cp "$TRACE_JSON" "$TRACE_DIR/$TRACE_CID"
  TRACE_ID=$(invoke "$REGISTRY" "$AGENT_KEY" publish_trace \
    --agent "$AGENT" --market_id "$MARKET_ID" --action CreateMarket \
    --trace_hash "$TRACE_HASH" --ipfs_cid "\"$TRACE_CID\"")
  echo "trace id: $TRACE_ID"
  echo

  VERIFIED=$(read_only "$REGISTRY" verify_trace --trace_id "$TRACE_ID" --received_hash "$TRACE_HASH")
  echo "verify_trace(correct hash) = $VERIFIED"
  if [ "$VERIFIED" != "true" ]; then
    echo "FAILED: trace hash did not verify" >&2
    rm -f "$TRACE_JSON"
    exit 1
  fi
  echo

  invoke "$RESOLVER" "$AGENT_KEY" attest_with_evidence --market_id "$MARKET_ID" --signer "$AGENT" --outcome Yes --trace_id "$TRACE_ID"
  echo "waiting ${DISPUTE_WINDOW}s dispute window..."
  "$SLEEP" "$((DISPUTE_WINDOW + 1))"
  OUTCOME=$(invoke "$RESOLVER" "$AGENT_KEY" finalize_signers --market_id "$MARKET_ID")
  echo "resolved outcome: $OUTCOME"
  echo
  rm -f "$TRACE_JSON"
fi

STATUS=$(read_only "$MARKET_CORE" get_market --market_id "$MARKET_ID")
if ! printf '%s\n' "$STATUS" | grep -q 'Resolved'; then
  echo "FAILED: market did not resolve: $STATUS" >&2
  exit 1
fi
echo "### final market status: resolved"
echo "market_id=$MARKET_ID"
echo "network=$NETWORK"
echo "mode=$MODE"
echo "trace_file=${TRACE_DIR:-}/${TRACE_CID:-}"
