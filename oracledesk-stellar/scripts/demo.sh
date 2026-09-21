#!/usr/bin/env bash
# End-to-end testnet demo: create a market, trade in it, wait for it to
# close, resolve it, record a reasoning trace, and verify the trace hash
# on-chain. This is the `make demo` target's acceptance flow.
#
# What this script does NOT cover yet: actually buying the trace through the
# x402 HTTP service. That needs a reachable x402 facilitator; run
# `npm start` in x402/ separately and see docs/STATUS.md for the manual
# curl steps and what's unverified about that leg.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
AGENT_KEY=oracledesk-agent
DEPLOYMENTS=deployments/testnet.json
CLOSE_IN_SECONDS=${CLOSE_IN_SECONDS:-90}
DISPUTE_WINDOW=${DISPUTE_WINDOW:-5}

[ -f "$DEPLOYMENTS" ] || { echo "error: run scripts/deploy-testnet.sh first" >&2; exit 1; }

MARKET_CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
REGISTRY=$(jq -r .contracts.reasoning_registry "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")

invoke() { stellar contract invoke --id "$1" --source-account "$2" --network "$NETWORK" -- "${@:3}"; }
read_only() { stellar contract invoke --id "$1" --source-account "$DEPLOYER_KEY" --network "$NETWORK" -- "${@:2}" 2>/dev/null; }

echo "### 1/6 create + seed market (treasury.agent_create_market)"
SEED_OUT=$(./scripts/seed-market.sh 1500000000 5000 "$CLOSE_IN_SECONDS" "$DISPUTE_WINDOW" "OracleDesk demo $(date -u +%Y-%m-%dT%H:%M:%SZ)")
echo "$SEED_OUT"
MARKET_ID=$(echo "$SEED_OUT" | sed -n 's/^market_id=//p')
CLOSE_TIME=$(echo "$SEED_OUT" | sed -n 's/^close_time=//p')
echo

echo "### 2/6 trade (treasury.agent_buy) — price should move off 50/50"
echo "price before: $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
TRADE_TX=$(invoke "$TREASURY" "$AGENT_KEY" agent_buy --market_id "$MARKET_ID" --outcome Yes --collateral_in 100000000 --min_shares_out 0)
echo "shares received: $TRADE_TX"
echo "price after:  $(read_only "$MARKET_CORE" get_price --market_id "$MARKET_ID" --outcome Yes)"
echo

echo "### 3/6 wait for close_time + dispute window, then resolve"
NOW=$(date +%s)
WAIT=$(( CLOSE_TIME - NOW + 1 ))
[ "$WAIT" -gt 0 ] && { echo "waiting ${WAIT}s for the market to close..."; sleep "$WAIT"; }
invoke "$RESOLVER" "$AGENT_KEY" attest --market_id "$MARKET_ID" --signer "$AGENT" --outcome Yes
echo "waiting ${DISPUTE_WINDOW}s dispute window..."
sleep "$(( DISPUTE_WINDOW + 1 ))"
OUTCOME=$(invoke "$RESOLVER" "$AGENT_KEY" finalize_signers --market_id "$MARKET_ID")
echo "resolved outcome: $OUTCOME"
echo

echo "### 4/6 record a reasoning trace"
TRACE_JSON=$(mktemp)
cat >"$TRACE_JSON" <<EOF
{"agent":"market-maker","market_id":$MARKET_ID,"action":"create_market","reasoning":"OracleDesk testnet demo run via scripts/demo.sh.","timestamp":$(date +%s)}
EOF
TRACE_HASH=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$TRACE_JSON")
echo "trace hash: $TRACE_HASH"
TRACE_ID=$(invoke "$REGISTRY" "$AGENT_KEY" publish_trace \
  --agent "$AGENT" --market_id "$MARKET_ID" --action '"create_market"' \
  --trace_hash "$TRACE_HASH" --ipfs_cid '"ipfs://demo-trace-placeholder"')
echo "trace id: $TRACE_ID"
echo

echo "### 5/6 verify the trace hash against the registry"
VERIFIED=$(read_only "$REGISTRY" verify_trace --trace_id "$TRACE_ID" --received_hash "$TRACE_HASH")
echo "verify_trace(correct hash) = $VERIFIED"
[ "$VERIFIED" = "true" ] || { echo "FAILED: trace hash did not verify" >&2; exit 1; }
echo

echo "### 6/6 summary"
echo "market_id=$MARKET_ID"
echo "outcome=$OUTCOME"
echo "trace_id=$TRACE_ID"
echo "trace_hash=$TRACE_HASH"
echo
echo "x402 purchase leg not exercised by this script — see docs/STATUS.md."
rm -f "$TRACE_JSON"
