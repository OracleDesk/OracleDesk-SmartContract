#!/usr/bin/env bash
# Resume-safe testnet migration for OracleDesk generation 1 -> generation 2.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
OUT=${OUT:-deployments/testnet.json}
JOURNAL=${JOURNAL:-deployments/testnet-migration.json}
PLAN=${PLAN:-deployments/testnet-migration-plan.json}

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required" >&2; exit 1; }; }
require_cmd stellar
require_cmd jq
[ "$NETWORK" = "testnet" ] || { echo "error: migration may only run against testnet" >&2; exit 1; }
[ -f "$OUT" ] || { echo "error: $OUT not found" >&2; exit 1; }

mkdir -p deployments snapshots
[ -f "$JOURNAL" ] || cat >"$JOURNAL" <<'EOF'
{"phase":0,"started_at":"","steps":{}}
EOF
if [ -z "$(jq -r '.started_at' "$JOURNAL")" ]; then
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg ts "$ts" '.started_at=$ts' "$JOURNAL" >"$JOURNAL.tmp" && mv "$JOURNAL.tmp" "$JOURNAL"
fi

json_get() { jq -r "$1 // empty" "$OUT"; }
step_done() { [ "$(jq -r --arg id "$1" '.steps[$id].status // empty' "$JOURNAL")" = "done" ]; }
step_done_check() {
  local id=$1 check=$2
  if step_done "$id"; then return 0; fi
  if eval "$check"; then
    jq --arg id "$id" '.steps[$id]={"status":"done","observed":"precondition already holds"}' "$JOURNAL" >"$JOURNAL.tmp" && mv "$JOURNAL.tmp" "$JOURNAL"
  fi
}
record_step() {
  local id=$1 tx=${2:-} observed=${3:-}
  jq --arg id "$id" --arg tx "$tx" --arg observed "$observed" \
    '.steps[$id]={"status":"done","tx":$tx,"observed":$observed}' "$JOURNAL" >"$JOURNAL.tmp" && mv "$JOURNAL.tmp" "$JOURNAL"
}
set_phase() { jq --argjson p "$1" '.phase=$p' "$JOURNAL" >"$JOURNAL.tmp" && mv "$JOURNAL.tmp" "$JOURNAL"; }

log() { echo "==> $*" >&2; }

# Phase 0: freeze and snapshot the legacy deployment.
set_phase 0
if ! step_done freeze-legacy; then
  legacy_market=$(json_get .contracts.market_core)
  legacy_resolver=$(json_get '.contracts.resolver')
  legacy_treasury=$(json_get '.contracts.treasury')
  legacy_registry=$(json_get '.contracts.reasoning_registry')
  ledger=$(stellar env | jq -r '.ledger // "unknown"' 2>/dev/null || echo unknown)
  snapshot="snapshots/gen1-$ledger.json"
  cat >"$snapshot" <<EOF
{"ledger":"$ledger","contracts":{"market_core":"$legacy_market","resolver":"$legacy_resolver","treasury":"$legacy_treasury","reasoning_registry":"$legacy_registry"}}
EOF
  stellar contract invoke --id "$legacy_treasury" --source-account oracledesk-deployer --network "$NETWORK" -- set_paused --paused true
  record_step freeze-legacy "set_paused(true)" "snapshot=$snapshot"
fi

# Phase 1: settle legacy markets according to an explicitly reviewed plan.
set_phase 1
if [ ! -f "$PLAN" ]; then
  echo "error: reviewed plan required at $PLAN (JSON object market_id -> resolve|void|leave)" >&2
  exit 1
fi
if ! step_done settle-legacy; then
  legacy_resolver=$(json_get '.contracts.resolver')
  legacy_treasury=$(json_get '.contracts.treasury')
  legacy_market=$(json_get '.contracts.market_core')
  count=$(stellar contract invoke --id "$legacy_market" --source-account oracledesk-deployer --network "$NETWORK" -- market_count)
  jq -r 'to_entries[] | [.key,.value] | @tsv' "$PLAN" | while IFS=$'\t' read -r id action; do
    case "$action" in
      resolve) stellar contract invoke --id "$legacy_resolver" --source-account oracledesk-deployer --network "$NETWORK" -- resolve_price --market_id "$id" || true ;;
      void) stellar contract invoke --id "$legacy_resolver" --source-account oracledesk-deployer --network "$NETWORK" -- guardian_void_market --market_id "$id" || true ;;
      leave) log "leaving market $id for legacy holders" ;;
      *) echo "error: invalid plan action '$action' for market $id" >&2; exit 1 ;;
    esac
  done
  stellar contract invoke --id "$legacy_treasury" --source-account oracledesk-deployer --network "$NETWORK" -- collect_market_fees || true
  record_step settle-legacy "legacy plan $PLAN" "scanned=$count markets"
fi

# Phase 2: preserve legacy IDs and deploy the next generation.
set_phase 2
if ! step_done deploy-generation-2; then
  old=$(mktemp)
  cp "$OUT" "$old"
  source_commit=$(git rev-parse HEAD)
  retired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg sha 97b144a --arg retired "$retired_at" '
    . as $old |
    .legacy = ([{generation:1,source_commit:$sha,contracts:$old.contracts,retired_at:$retired}] + (.legacy // [])) |
    .generation=2 | .schema=2 | .source_commit="" | .contracts={} |
    .wired=false | .agent_registered=false
  ' "$old" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  SKIP_FUNDING=1 USE_TIMELOCK=0 NETWORK=testnet OUT="$OUT" ./scripts/deploy-testnet.sh
  jq --arg sha "$source_commit" --arg ts "$retired_at" '.source_commit=$sha | .generation=2 | .schema=2' "$OUT" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  record_step deploy-generation-2 "deploy-testnet.sh" "generation=2 source_commit=$source_commit"
fi

# Phase 3: move capital (amount is operator supplied and journaled).
set_phase 3
if ! step_done move-capital; then
  if [ -z "${MOVE_CAPITAL_AMOUNT:-}" ]; then
    echo "error: set MOVE_CAPITAL_AMOUNT to the reconciled legacy treasury balance" >&2
    exit 1
  fi
  old_treasury=$(jq -r '.legacy[0].contracts.treasury' "$OUT")
  new_treasury=$(json_get '.contracts.treasury')
  usdc=$(json_get '.contracts.usdc')
  stellar contract invoke --id "$old_treasury" --source-account oracledesk-deployer --network "$NETWORK" -- withdraw --to "$(stellar keys address oracledesk-deployer)" --amount "$MOVE_CAPITAL_AMOUNT"
  stellar contract invoke --id "$new_treasury" --source-account oracledesk-deployer --network "$NETWORK" -- deposit --from "$(stellar keys address oracledesk-deployer)" --amount "$MOVE_CAPITAL_AMOUNT"
  record_step move-capital "$MOVE_CAPITAL_AMOUNT" "usdc=$usdc"
fi

# Phase 4: register agents in the new registry.
set_phase 4
if ! step_done register-agents; then
  registry=$(json_get '.contracts.reasoning_registry')
  for role in agent maker trader; do
    addr=$(stellar keys address "oracledesk-$role" 2>/dev/null || true)
    [ -n "$addr" ] || continue
    stellar contract invoke --id "$registry" --source-account oracledesk-deployer --network "$NETWORK" -- register_agent --agent "$addr" || true
  done
  record_step register-agents "register agents" "registry=$registry"
fi

# Phase 5: timelock handover is performed by the reviewed wire-timelock script.
set_phase 5
log "run USE_TIMELOCK=1 scripts/wire-timelock.sh or scripts/testnet-migration.sh --handover when supported"

set_phase 6
log "migration journal: $JOURNAL"
log "review and publish the new deployment record: $OUT"
