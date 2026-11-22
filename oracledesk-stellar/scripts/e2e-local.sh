#!/usr/bin/env bash
# Hermetic end-to-end harness on the Stellar quickstart image.
#
# Phases (each prints PASS on success):
#   1. start quickstart + register the `local` network
#   2. deploy all contracts, the SAC and the local test oracle
#   3. signer-mode demo (attest + finalize + registry trace)
#   4. price-mode demo through the deployed mock oracle
#   5. TypeScript trader agent in live mode, asserting on-chain position
#   6. x402 registry lookup + on-chain trace-hash verification
#
# This script is CI's source of truth. It needs Docker, stellar CLI, jq,
# Rust, Node and Python 3. It never touches testnet or mainnet.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=local
RPC_URL=${SOROBAN_RPC_URL:-http://localhost:8000/soroban/rpc}
PASSPHRASE="Standalone Network ; February 2017"
CONTAINER=${E2E_CONTAINER_NAME:-oracledesk-e2e}
X402_PORT=${X402_PORT:-3001}
TRACE_PORT=${TRACE_PORT:-8099}
TRACE_DIR=deployments/traces-local
DEPLOYMENTS=deployments/local.json
IDENTITY_PREFIX=oracledesk-e2e
export NETWORK IDENTITY_PREFIX DEPLOYMENTS SOROBAN_RPC_URL="$RPC_URL"

STAGES="core"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stages)
      STAGES="${2:-}"
      shift 2
      ;;
    *) shift ;;
  esac
done

source scripts/e2e/lib.sh
mkdir -p deployments
printf '{"stages":{}}\n' >"$REPORT"

log() { echo "==> $*" >&2; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || fail "docker is required"
command -v stellar >/dev/null || fail "stellar CLI is required"
command -v jq >/dev/null || fail "jq is required"
command -v python3 >/dev/null || fail "python3 is required"

# --- 1. network -------------------------------------------------------------
log "starting quickstart container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Pin QUICKSTART_IMAGE in CI; `testing` tracks the current protocol and is the
# upstream image `stellar container start` uses. Record the resolved digest in
# the CI log so a protocol bump is visible.
QUICKSTART_IMAGE=${QUICKSTART_IMAGE:-stellar/quickstart:testing}
docker run -d --name "$CONTAINER" -p 8000:8000 "$QUICKSTART_IMAGE" --local --limits unlimited >/dev/null

log "waiting for RPC health"
for _ in $(seq 1 90); do
  if curl -sf -X POST "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq -e '.result.status == "healthy"' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf -X POST "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq -e '.result.status == "healthy"' >/dev/null \
  || fail "RPC did not become healthy"
stellar network rm local >/dev/null 2>&1 || true
stellar network add local --rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE"
pass "quickstart network ($QUICKSTART_IMAGE)"

# --- 2. deploy --------------------------------------------------------------
log "deploying contracts (idempotent)"
NETWORK=local IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" ./scripts/deploy-testnet.sh
[ -f "$DEPLOYMENTS" ] || fail "deployment record missing"
for key in market_core resolver treasury reasoning_registry test_oracle; do
  jq -e --arg k "$key" '.contracts[$k] | length > 0' "$DEPLOYMENTS" >/dev/null \
    || fail "missing contracts.$key in $DEPLOYMENTS"
done
pass "deploy"

CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
REGISTRY=$(jq -r .contracts.reasoning_registry "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
DEPLOYER_KEY=${IDENTITY_PREFIX}-deployer
AGENT_KEY=${IDENTITY_PREFIX}-agent

# --- 3. signer-mode demo ----------------------------------------------------
log "running signer-mode demo"
SIGNER_OUT=$(NETWORK=local IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
  ./scripts/demo.sh --mode signer)
printf '%s\n' "$SIGNER_OUT"
echo "$SIGNER_OUT" | grep -q 'final market status: resolved' || fail "signer demo did not resolve"
TRACE_ID=$(echo "$SIGNER_OUT" | sed -n 's/^trace id: //p')
TRACE_HASH=$(echo "$SIGNER_OUT" | sed -n 's/^trace hash: //p')
pass "signer-mode demo (trace $TRACE_ID)"

# --- 4. price-mode demo -----------------------------------------------------
log "running price-mode demo"
PRICE_OUT=$(NETWORK=local IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
  ./scripts/demo.sh --mode price)
printf '%s\n' "$PRICE_OUT"
echo "$PRICE_OUT" | grep -q 'final market status: resolved' || fail "price demo did not resolve"
pass "price-mode demo"

# --- 5. agents live ---------------------------------------------------------
log "creating a fresh market for the live trader"
AGENT_MARKET_OUT=$(NETWORK=local IDENTITY_PREFIX="$IDENTITY_PREFIX" DEPLOYMENTS="$DEPLOYMENTS" \
  ./scripts/seed-market.sh 1500000000 4000 90 3 "Agent live E2E market")
printf '%s\n' "$AGENT_MARKET_OUT"
AGENT_MARKET=$(echo "$AGENT_MARKET_OUT" | sed -n 's/^market_id=//p')
[ -n "$AGENT_MARKET" ] || fail "agent market id missing"

# The per-role maker/trader policies are timelocked for config_delay, so use
# the constructor agent (all roles) for this live check.
jq 'del(.agents)' "$DEPLOYMENTS" >deployments/local-agent.json
AGENT_SECRET=$(stellar keys secret "$AGENT_KEY")
(
  cd agents
  AGENT_MODE=live \
  AGENT_SECRET_KEY="$AGENT_SECRET" \
  DEPLOYMENTS_PATH="../deployments/local-agent.json" \
  STELLAR_RPC_URL="$RPC_URL" \
  STELLAR_NETWORK_PASSPHRASE="$PASSPHRASE" \
  TRADER_MARKET_ID="$AGENT_MARKET" \
  TRADER_MARKET_YES_BPS=4000 \
  TRADER_FAIR_VALUE_BPS=6000 \
  TRACE_STORE_DIR="../deployments/traces-local" \
  npm run trader
)
POSITION=$(stellar contract invoke --id "$CORE" --source-account "$DEPLOYER_KEY" --network local -- \
  get_position --market_id "$AGENT_MARKET" --holder "$TREASURY")
echo "treasury position: $POSITION"
echo "$POSITION" | jq -e '(.yes | tonumber) > 0' >/dev/null || fail "agent did not open a position"
pass "agents live (treasury position grew)"

# --- 6. x402 registry-backed trace ------------------------------------------
log "serving traces and starting x402"
mkdir -p "$TRACE_DIR"
python3 -m http.server "$TRACE_PORT" --directory "$TRACE_DIR" >/tmp/oracledesk-trace-http.log 2>&1 &
TRACE_PID=$!
(
  cd x402
  REASONING_REGISTRY_CONTRACT_ID="$REGISTRY" \
  STELLAR_RPC_URL="$RPC_URL" \
  STELLAR_NETWORK_PASSPHRASE="$PASSPHRASE" \
  IPFS_GATEWAY_URL="http://127.0.0.1:$TRACE_PORT" \
  PAYMENTS_DISABLED=1 \
  PORT="$X402_PORT" \
  npm start >/tmp/oracledesk-x402.log 2>&1
) &
X402_PID=$!
trap 'kill $TRACE_PID $X402_PID >/dev/null 2>&1 || true; cleanup' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$X402_PORT/traces/$TRACE_ID" >/dev/null 2>&1 && break
  sleep 1
done
BODY=$(curl -sf "http://127.0.0.1:$X402_PORT/traces/$TRACE_ID") || {
  cat /tmp/oracledesk-x402.log >&2
  fail "x402 server did not serve trace $TRACE_ID"
}
echo "$BODY" | jq -e --arg h "$TRACE_HASH" '.traceHash == $h' >/dev/null \
  || fail "x402 traceHash mismatch (expected $TRACE_HASH): $BODY"
pass "x402 registry fetch + trace hash ($TRACE_ID)"

IFS=',' read -ra STAGE_LIST <<<"$STAGES"
for stage in "${STAGE_LIST[@]}"; do
  stage="$(echo "$stage" | xargs)"
  [ "$stage" = "core" ] && continue
  stage_script="scripts/e2e/stages/$stage.sh"
  [ -f "$stage_script" ] || fail "unknown E2E stage: $stage"
  source "$stage_script"
done

echo
echo "E2E OK on $NETWORK"
