#!/usr/bin/env bash
# In-place upgrade driver for the four OracleDesk contracts (issue #18).
#
# Uploads a freshly-built wasm, swaps it under the *existing* contract
# address with the admin-gated `upgrade` entrypoint (same address, same
# storage), then loops `migrate` in bounded batches until the contract
# reports done, verifies `schema_version`, and records the new wasm hash
# and schema version in deployments/<network>.json next to the contract
# ids written by scripts/deploy-testnet.sh.
#
# Ordering (docs/adr/0010-upgrades.md): resolver and treasury call
# market-core through a *vendored* copy of its interface, so within a
# compatibility window the hub must move first. `all` therefore upgrades
# market-core, then resolver, then treasury, then reasoning-registry.
#
# Usage:
#   NETWORK=testnet ./scripts/upgrade.sh <contract> [--migrate]
#   NETWORK=testnet ./scripts/upgrade.sh all [--migrate]
#   contract = market-core | resolver | treasury | reasoning-registry | all
#
# Without --migrate only the executable is swapped; run `migrate` later
# (it is resumable and idempotent — market-core trading is never blocked
# while a migration is pending). BATCH (default 50) sizes each migrate
# call; MAX_BATCHES (default 1000) bounds the loop.
#
# Requires: stellar CLI, jq. The wasm must already be built (`make build`
# or `stellar contract build`); this script never builds or commits wasm.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet|local) ;;
  *) echo "error: NETWORK must be testnet or local (never mainnet)" >&2; exit 1 ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
OUT=${OUT:-deployments/$NETWORK.json}
WASM_DIR=target/wasm32v1-none/release
BATCH=${BATCH:-50}
MAX_BATCHES=${MAX_BATCHES:-1000}

log() { echo "==> $*" >&2; }
die() { echo "error: $*" >&2; exit 1; }

command -v stellar >/dev/null 2>&1 || die "'stellar' is required but not installed"
command -v jq >/dev/null 2>&1 || die "'jq' is required but not installed"
[ -f "$OUT" ] || die "no deployment record at $OUT — run scripts/deploy-testnet.sh first"
case "$BATCH$MAX_BATCHES" in
  *[!0-9]*) die "BATCH and MAX_BATCHES must be positive integers" ;;
esac
[ "$BATCH" -ge 1 ] || die "BATCH must be at least 1"

usage() {
  echo "usage: $0 <market-core|resolver|treasury|reasoning-registry|all> [--migrate]" >&2
  exit 1
}

json_set() {
  local tmp
  tmp=$(mktemp)
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

# deployments record key == contract name with dashes turned into
# underscores, exactly how deploy-testnet.sh writes .contracts.*
record_key() { echo "$1" | tr '-' '_'; }

upgrade_one() {
  local name=$1
  local key contract wasm_file upload_out hash version done_flag calls out
  key=$(record_key "$name")
  contract=$(jq -r --arg k "$key" '.contracts[$k] // empty' "$OUT")
  [ -n "$contract" ] || die "no $name contract id recorded in $OUT"
  wasm_file="$WASM_DIR/$(record_key "$name").wasm"
  [ -f "$wasm_file" ] || die "$wasm_file not built — run make build first"

  log "uploading $wasm_file"
  upload_out=$(stellar contract upload \
    --network "$NETWORK" \
    --source-account "$DEPLOYER_KEY" \
    --wasm "$wasm_file")
  # `stellar contract upload` prints its result as JSON; the wasm hash has
  # appeared as .hash, .wasm_id.address and .wasm.hash across CLI versions,
  # so accept any of them rather than pinning one output shape.
  hash=$(echo "$upload_out" | jq -r '.hash // .wasm_id.address // .wasm.hash // empty')
  { [ -n "$hash" ] && [ "$hash" != "null" ]; } || die "could not read a wasm hash from: $upload_out"

  log "upgrading $name at $contract to wasm hash $hash"
  stellar contract invoke --id "$contract" --network "$NETWORK" \
    --source-account "$DEPLOYER_KEY" -- upgrade --new_wasm_hash "$hash"
  json_set --arg n "$name" --arg h "$hash" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.wasm_hashes[$n] = $h | .upgraded_at[$n] = $ts'

  if [ "$MIGRATE" = 1 ]; then
    log "migrating $name in batches of $BATCH until done"
    done_flag=false
    calls=0
    while [ "$done_flag" != "true" ]; do
      calls=$((calls + 1))
      [ "$calls" -le "$MAX_BATCHES" ] ||
        die "$name did not finish migrating in $MAX_BATCHES batches — inspect with
      stellar contract invoke --id $contract --network $NETWORK \\
        --source-account $DEPLOYER_KEY -- migrate --batch $BATCH"
      out=$(stellar contract invoke --id "$contract" --network "$NETWORK" \
        --source-account "$DEPLOYER_KEY" -- migrate --batch "$BATCH")
      # `migrate` returns MigrationProgress { from_version, to_version,
      # processed, done }; a batch that processed 0 entries without
      # finishing means the cursor is wedged — stop instead of spinning.
      done_flag=$(echo "$out" | jq -r '.done')
      if [ "$done_flag" != "true" ] &&
        [ "$(echo "$out" | jq -r '.processed')" = "0" ]; then
        die "$name migrate batch made no progress: $out"
      fi
    done
    log "$name migration complete after $calls batch(es)"
  fi

  version=$(stellar contract invoke --id "$contract" --network "$NETWORK" \
    --source-account "$DEPLOYER_KEY" -- schema_version)
  [ "$version" -ge 1 ] 2>/dev/null || die "$name reported an invalid schema_version: $version"
  json_set --arg n "$name" --arg v "$version" \
    '.schema_versions[$n] = ($v | tonumber)'
  log "$name now at schema version $version (wasm $hash)"
}

TARGET=${1:-}
[ -n "$TARGET" ] || usage
shift
MIGRATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) MIGRATE=1 ;;
    *) usage ;;
  esac
  shift
done

case "$TARGET" in
  market-core|resolver|treasury|reasoning-registry)
    upgrade_one "$TARGET"
    ;;
  all)
    # Order fixed by ADR-0010: the hub whose interface others vendor goes
    # first; consumers upgrade (and refresh their vendored copy) after it.
    for name in market-core resolver treasury reasoning-registry; do
      upgrade_one "$name"
    done
    ;;
  *) usage ;;
esac

log "done; records updated in $OUT"
