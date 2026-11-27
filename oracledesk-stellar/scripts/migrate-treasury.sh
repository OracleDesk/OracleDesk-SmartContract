#!/usr/bin/env bash
# Migrate a treasury through the authenticated, vault-wide migration protocol.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
OUT=deployments/testnet.json
WASM_DIR=target/wasm32v1-none/release
DRY_RUN=${DRY_RUN:-0}
log() { echo "==> $*" >&2; }
for cmd in stellar jq; do command -v "$cmd" >/dev/null || { echo "error: '$cmd' is required" >&2; exit 1; }; done
[ -f "$OUT" ] || { echo "error: $OUT not found" >&2; exit 1; }
json_get() { jq -r "$1 // empty" "$OUT"; }
json_set() {
  local tmp="${OUT}.migrate.tmp"
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}
invoke() {
  local id=$1; shift
  if [ "$DRY_RUN" = 1 ]; then
    stellar contract invoke --id "$id" --source-account "$DEPLOYER_KEY" --network "$NETWORK" --send=no -- "$@"
  else
    stellar contract invoke --id "$id" --source-account "$DEPLOYER_KEY" --network "$NETWORK" -- "$@"
  fi
}
OLD=$(json_get .contracts.treasury)
CORE=$(json_get .contracts.market_core)
[ -n "$OLD" ] && [ -n "$CORE" ] || { echo "error: deployment has no treasury/market_core" >&2; exit 1; }
[ -f "$WASM_DIR/treasury.wasm" ] || stellar contract build
GLOBAL=$(invoke "$OLD" get_global)
AGENT=$(jq -r '.agent // empty' <<<"$(invoke "$OLD" get_config)")
COLLATERAL=$(jq -r '.collateral' <<<"$GLOBAL")
MAX_TRADE=$(jq -r '.max_trade' <<<"$GLOBAL")
MAX_MARKET=$(jq -r '.max_market' <<<"$(invoke "$OLD" get_config)")
MAX_DAILY=$(jq -r '.max_daily' <<<"$GLOBAL")
MAX_NET=$(jq -r '.max_net_exposure' <<<"$GLOBAL")
DELAY=$(invoke "$OLD" config_delay | tr -d '"')
DRAWDOWN=$(invoke "$OLD" drawdown_status)
MAX_DRAWDOWN=$(jq -r '.max_drawdown' <<<"$DRAWDOWN")
WINDOW_DAYS=$(jq -r '.window_days // 1' <<<"$DRAWDOWN")
POLICY=$(invoke "$OLD" get_creation_policy)
SUCCESSOR=$(json_get .contracts.treasury_successor)
if [ -z "$SUCCESSOR" ] && [ "$DRY_RUN" != 1 ]; then
  ADMIN=$(stellar keys address "$DEPLOYER_KEY")
  SUCCESSOR=$(stellar contract deploy --wasm "$WASM_DIR/treasury.wasm" --source-account "$DEPLOYER_KEY" --network "$NETWORK" -- \
    --admin "$ADMIN" --agent "$AGENT" --collateral "$COLLATERAL" --market_core "$CORE" \
    --max_trade "$MAX_TRADE" --max_market "$MAX_MARKET" --max_daily "$MAX_DAILY" --max_net_exposure "$MAX_NET" \
    --config_delay "$DELAY" --max_drawdown "$MAX_DRAWDOWN" --window_days "$WINDOW_DAYS" \
    --creation_policy "$POLICY")
  json_set --arg id "$SUCCESSOR" '.contracts.treasury_successor = $id'
fi
[ -n "$SUCCESSOR" ] || { echo "error: successor required (deploy first or set .contracts.treasury_successor)" >&2; exit 1; }
log "successor: $SUCCESSOR"
invoke "$SUCCESSOR" accept_predecessor --predecessor "$OLD"
invoke "$OLD" begin_migration --successor "$SUCCESSOR"
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run complete"
  log "old NAV: $(invoke "$OLD" nav)"
  log "successor NAV: $(invoke "$SUCCESSOR" nav)"
  exit 0
fi
STATE=$(invoke "$OLD" migration_state)
AFTER=$(jq -r '.migrate_after' <<<"$STATE")
while [ "$(date +%s)" -lt "$AFTER" ]; do sleep 5; done
COUNT=$(invoke "$OLD" open_market_count)
IDS=()
for ((i=0; i<COUNT; i++)); do IDS+=("$(invoke "$OLD" open_market_at --i "$i" | jq -r '.market_id')"); done
[ "${#IDS[@]}" -eq 0 ] || invoke "$OLD" migrate_markets --market_ids "[${IDS[*]}]"
invoke "$OLD" migrate_idle
json_set --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.migration.completed_at = $ts | .contracts.treasury = .contracts.treasury_successor'
log "migration complete: $SUCCESSOR"
