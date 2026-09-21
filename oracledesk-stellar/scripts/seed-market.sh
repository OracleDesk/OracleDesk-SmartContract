#!/usr/bin/env bash
# Creates one market through the deployed treasury (agent_create_market) and
# reveals its signer-mode resolution spec, using the addresses recorded in
# deployments/testnet.json by scripts/deploy-testnet.sh.
#
# The agent itself is the sole signer (threshold 1) with a short dispute
# window — good enough to demonstrate the commit/reveal flow end to end
# without needing a real oracle. For a PriceConfig-based market, compute the
# hash with `spec-hash price ...` instead and call register_price_spec.
#
# Usage: scripts/seed-market.sh [seed_amount_stroops] [initial_yes_bps] [close_in_seconds]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
AGENT_KEY=oracledesk-agent
DEPLOYMENTS=deployments/testnet.json

SEED_AMOUNT=${1:-1500000000}   # 150 USDC, comfortably above the 100 USDC MIN_SEED
INITIAL_YES_BPS=${2:-5000}     # 50/50
CLOSE_IN_SECONDS=${3:-90}
DISPUTE_WINDOW=${4:-5}
QUESTION_TEXT=${5:-"Demo market seeded by scripts/seed-market.sh"}

[ -f "$DEPLOYMENTS" ] || { echo "error: $DEPLOYMENTS not found — run scripts/deploy-testnet.sh first" >&2; exit 1; }

TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
[ -n "$TREASURY" ] && [ "$TREASURY" != "null" ] || { echo "error: no treasury address in $DEPLOYMENTS" >&2; exit 1; }

question_hash() {
  python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"
}

echo "==> computing resolution commitment (signers: [$AGENT], threshold 1)" >&2
RESOLUTION_HASH=$(cargo run --quiet --manifest-path scripts/spec-hash/Cargo.toml -- \
  signers 1 "$DISPUTE_WINDOW" "$AGENT")
QUESTION_HASH=$(question_hash "$QUESTION_TEXT")
CLOSE_TIME=$(( $(date +%s) + CLOSE_IN_SECONDS ))

echo "==> creating market (seed=$SEED_AMOUNT, close_time=$CLOSE_TIME)" >&2
MARKET_ID=$(stellar contract invoke --id "$TREASURY" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
  agent_create_market \
  --question_hash "$QUESTION_HASH" \
  --resolution_hash "$RESOLUTION_HASH" \
  --meta_uri "\"ipfs://$(echo -n "$QUESTION_TEXT" | tr ' ' '-')\"" \
  --category Macro \
  --close_time "$CLOSE_TIME" \
  --seed_amount "$SEED_AMOUNT" \
  --initial_yes_bps "$INITIAL_YES_BPS")

echo "==> revealing the resolution spec to the resolver" >&2
stellar contract invoke --id "$RESOLVER" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
  register_signer_spec \
  --market_id "$MARKET_ID" \
  --spec "{ \"dispute_window\": $DISPUTE_WINDOW, \"signers\": [ \"$AGENT\" ], \"threshold\": 1 }"

echo "market_id=$MARKET_ID"
echo "close_time=$CLOSE_TIME"
echo "dispute_window=$DISPUTE_WINDOW"
