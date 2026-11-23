#!/usr/bin/env bash
# Move an existing testnet deployment's admin role to the governance timelock
# (#63, docs/adr/0008-governance-timelock.md) using the two-step admin transfer
# from #62 (docs/adr/0007-two-step-admin-transfer.md).
#
# For each of market-core, resolver, treasury and reasoning-registry:
#   1. the current admin proposes the timelock as the new admin;
#   2. the timelock's `accept_admin` call is scheduled through the timelock and
#      must be executed after the delay (the timelock cannot be a CLI source
#      account, and its auth must be anchored contract-to-contract).
# The script is idempotent: a contract already governed by the timelock is
# skipped. The pending proposal expires after seven days, so execute the
# scheduled accept within that window (the timelock delay is smaller).
#
# After this, every admin action on those contracts must go through
# timelock.schedule / timelock.execute.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
OUT=${OUT:-deployments/$NETWORK.json}

log() { printf '==> %s\n' "$*"; }
json_get() { jq -r "$1 // empty" "$OUT"; }

if [ ! -f "$OUT" ]; then
  echo "error: $OUT not found; run deploy-testnet.sh first" >&2
  exit 1
fi

TIMELOCK=$(json_get .contracts.timelock)
if [ -z "$TIMELOCK" ]; then
  echo "error: no timelock in $OUT; deploy with USE_TIMELOCK=1 first" >&2
  exit 1
fi
log "timelock: $TIMELOCK"

# Hand one contract's admin over to the timelock.
hand_over() {
  local name=$1 id=$2
  if [ -z "$id" ]; then
    log "$name: no address recorded, skipping"
    return 0
  fi
  local current
  current=$(stellar contract invoke --id "$id" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- admin)
  if [ "$current" = "$TIMELOCK" ]; then
    log "$name: already governed by the timelock"
    return 0
  fi
  log "$name: proposing timelock as admin (current: $current)"
  stellar contract invoke --id "$id" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- propose_admin --new_admin "$TIMELOCK"
  # `accept_admin` must be called *by* the timelock, and a contract cannot be a
  # CLI source account. Route it through the timelock instead: schedule the
  # call (no arguments) and execute it once the delay has elapsed. The
  # timelock's own auth is anchored contract-to-contract when it invokes.
  log "$name: scheduling accept_admin through the timelock"
  local op
  op=$(stellar contract invoke --id "$TIMELOCK" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- schedule \
    --target "$id" --fn_name accept_admin --args '[]')
  log "$name: scheduled operation $op; execute it after the timelock delay:"
  log "  stellar contract invoke --id $TIMELOCK --network $NETWORK -- execute --id $op"
}

hand_over market-core "$(json_get .contracts.market_core)"
hand_over resolver "$(json_get .contracts.resolver)"
hand_over treasury "$(json_get .contracts.treasury)"
hand_over reasoning-registry "$(json_get .contracts.reasoning_registry)"

log "done. Proposals are in; execute each scheduled accept_admin after the"
log "timelock delay. Admin actions then go through $TIMELOCK."
