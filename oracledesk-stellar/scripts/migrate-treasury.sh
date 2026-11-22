#!/usr/bin/env bash
# Migrate an old OracleDesk treasury deployment to a fresh one, one market
# at a time. Writes nothing until the new treasury is deployed; re-running
# is safe (already-migrated markets have empty positions and are skipped by
# the on-chain logic).
#
# What it does, against the `testnet` network only (hardcoded, like
# deploy-testnet.sh — this script never touches mainnet):
#   1. reads the old treasury + market-core addresses from
#      deployments/testnet.json and the old treasury's RiskConfig on-chain
#      (agent, collateral, caps),
#   2. deploys a new treasury with the same config,
#   3. queues set_successor(new) on the OLD treasury, waits out the
#      timelock, then executes it,
#   4. queues one migrate_markets([0..market_count]) call, waits out the
#      timelock, then executes it, moving every market's position and (if
#      still held) LP ownership to the new treasury.
#
# It does NOT rewire market-core (`propose_treasury`) — that is a separate,
# deliberate cutover step, because it changes the fee recipient for future
# markets. The recorded successor id lands in
# deployments/testnet.json under `.contracts.treasury_successor`.
#
# Requires: stellar CLI, jq.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
OUT=deployments/testnet.json
WASM_DIR=target/wasm32v1-none/release

log() { echo "==> $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required but not installed" >&2
    exit 1
  }
}
require_cmd stellar
require_cmd jq

[ -f "$OUT" ] || {
  echo "error: $OUT not found — run scripts/deploy-testnet.sh first" >&2
  exit 1
}
json_get() { jq -r "$1 // empty" "$OUT"; }
json_set() {
  local tmp
  tmp=$(mktemp)
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

OLD_TREASURY=$(json_get .contracts.treasury)
MARKET_CORE=$(json_get .contracts.market_core)
[ -n "$OLD_TREASURY" ] && [ -n "$MARKET_CORE" ] || {
  echo "error: $OUT has no contracts.treasury / contracts.market_core" >&2
  exit 1
}
log "old treasury: $OLD_TREASURY"
log "market-core:  $MARKET_CORE"

[ -f "$WASM_DIR/treasury.wasm" ] || {
  log "missing $WASM_DIR/treasury.wasm — running stellar contract build first"
  stellar contract build
}

# --- read the old treasury's live config ------------------------------------
CONFIG=$(stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- get_config)
AGENT=$(jq -r '.agent' <<<"$CONFIG")
COLLATERAL=$(jq -r '.collateral' <<<"$CONFIG")
CONFIG_MARKET_CORE=$(jq -r '.market_core' <<<"$CONFIG")
MAX_TRADE=$(jq -r '.max_trade' <<<"$CONFIG")
MAX_MARKET=$(jq -r '.max_market' <<<"$CONFIG")
MAX_DAILY=$(jq -r '.max_daily' <<<"$CONFIG")
# Treasuries deployed before the net cap have no get_net_cap; fall back to an
# explicit MAX_NET_EXPOSURE, else max_daily (the contract's own fallback).
if [ -z "${MAX_NET_EXPOSURE:-}" ]; then
  MAX_NET_EXPOSURE=$(stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- get_net_cap 2>/dev/null | tr -d '"' || true)
  MAX_NET_EXPOSURE=${MAX_NET_EXPOSURE:-$MAX_DAILY}
fi
# Treasuries deployed before the config timelock have no config_delay.
if [ -z "${CONFIG_DELAY:-}" ]; then
  CONFIG_DELAY=$(stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- config_delay 2>/dev/null | tr -d '"' || true)
  CONFIG_DELAY=${CONFIG_DELAY:-86400}
fi
if [ "$CONFIG_MARKET_CORE" != "$MARKET_CORE" ]; then
  log "warning: old treasury points at $CONFIG_MARKET_CORE, $OUT records $MARKET_CORE"
fi
DEPLOYER=$(stellar keys address "$DEPLOYER_KEY")

# --- deploy the successor with the same config ------------------------------
NEW_TREASURY=$(json_get .contracts.treasury_successor)
if [ -z "$NEW_TREASURY" ]; then
  log "deploying successor treasury (same agent/collateral/caps)"
  NEW_TREASURY=$(stellar contract deploy \
    --wasm "$WASM_DIR/treasury.wasm" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$DEPLOYER" \
    --agent "$AGENT" \
    --collateral "$COLLATERAL" \
    --market_core "$MARKET_CORE" \
    --max_trade "$MAX_TRADE" \
    --max_market "$MAX_MARKET" \
    --max_daily "$MAX_DAILY" \
    --max_net_exposure "$MAX_NET_EXPOSURE" \
    --config_delay "$CONFIG_DELAY")
  json_set --arg id "$NEW_TREASURY" '.contracts.treasury_successor = $id'
else
  log "successor treasury already recorded: $NEW_TREASURY"
fi

# --- record the successor on the old treasury --------------------------------
SET_FOR=$(json_get .migration.successor_set_for)
if [ "$SET_FOR" != "$NEW_TREASURY" ]; then
  log "old treasury: queue set_successor($NEW_TREASURY)"
  stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- set_successor --successor "$NEW_TREASURY"
  log "waiting ${CONFIG_DELAY}s for the successor proposal timelock"
  sleep "$CONFIG_DELAY"
  log "old treasury: execute successor (op kind 2)"
  stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- execute_op --kind 2
  json_set --arg id "$NEW_TREASURY" '.migration.successor_set_for = $id'
else
  log "old treasury already points at the successor"
fi

# --- migrate every market in one delayed batch ------------------------------
MARKET_COUNT=$(stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- market_count)
log "migrating $MARKET_COUNT market(s)"
if [ "$MARKET_COUNT" -gt 0 ]; then
  MARKET_IDS=$(jq -nc --argjson n "$MARKET_COUNT" '[range(0; $n)]')
  log "old treasury: queue migrate_markets($MARKET_IDS)"
  stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- migrate_markets --market_ids "$MARKET_IDS"
  log "waiting ${CONFIG_DELAY}s for the migration proposal timelock"
  sleep "$CONFIG_DELAY"
  log "old treasury: execute migration (op kind 3)"
  stellar contract invoke --id "$OLD_TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- execute_op --kind 3
  json_set --arg n "$MARKET_COUNT" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.migration.markets_migrated = ($n | tonumber) | .migration.completed_at = $ts'
else
  log "no markets to migrate"
fi

log "done. Successor: $NEW_TREASURY"
log "next steps (deliberate, operator-owned):"
log "  1. rewire market-core's fee recipient to the new treasury (#61, ADR 0006):"
log "     market-core.propose_treasury($NEW_TREASURY); then the new treasury calls"
log "     accept_market_core_role() to authenticate the wiring"
log "  2. update .contracts.treasury in $OUT and restart the agents against it"
