#!/usr/bin/env bash
# In-place upgrade of one OracleDesk contract, plus the bounded schema
# migration that must follow it (issue #18).
#
#   scripts/upgrade.sh <contract> [--migrate]
#
# <contract> is `market_core` or `resolver` — the two contracts this script
# knows how to move. `treasury` and `reasoning_registry` are deliberately NOT
# wired up here: they are the named follow-up (docs/adr/0010). Asking for one
# fails loudly instead of half-upgrading it.
#
# Reads the deployment record exactly the way scripts/deploy-testnet.sh does
# (deployments/<network>.json, `.contracts.<name>` for the id), then:
#
#   1. installs the new wasm           (stellar contract install)
#   2. records the pre-upgrade version (schema_version)
#   3. invokes `upgrade --new_wasm_hash <sha256>`  — admin-gated, and the
#      contract's own doc comment explains why the hash must already be
#      installed: `update_current_contract_wasm` does NOT run the new
#      version's `__constructor`, so step 4 is mandatory, not optional.
#   4. with --migrate: loops `migrate --batch $BATCH` until the stored
#      `schema_version` flips (that flip is the contract's `done` signal: a
#      partial sweep leaves the version alone), then re-reads and records it.
#   5. writes `.wasm_hashes.<name>` and `.schema_versions.<name>` into the
#      deployment record, mirroring the `.salts` / `.contracts` layout.
#
# NETWORK must be `testnet` (default) or `local`; `mainnet` is rejected before
# anything is touched, same as deploy-testnet.sh.
#
# Env: NETWORK, IDENTITY_PREFIX, DEPLOYER_KEY, OUT, WASM_DIR, BATCH (default 50,
# which is market-core's MAX_MIGRATION_BATCH), MAX_ROUNDS (default 200, the
# stall bound), ADMIN (address; defaults to the deployer identity),
# TARGET_SCHEMA_VERSION (optional; hard-asserted after --migrate),
# DRY_RUN=1 (print the commands, change nothing).
#
# Requires: stellar CLI, jq.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  echo "usage: $(basename "${BASH_SOURCE[0]}") <market_core|resolver> [--migrate]" >&2
  echo "  (treasury / reasoning_registry are the deferred follow-up — see docs/adr/0010)" >&2
}

# --- arguments ---------------------------------------------------------------
MIGRATE=0
NAME=""
for arg in "$@"; do
  case "$arg" in
    --migrate) MIGRATE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [ -n "$NAME" ]; then
        echo "error: expected exactly one contract name, got a second: $arg" >&2
        usage
        exit 1
      fi
      NAME="$arg"
      ;;
  esac
done

if [ -z "$NAME" ]; then
  usage
  exit 1
fi

# The two contracts in scope, and only these. `wasm` is the file `make build`
# produces; `fn_names` are the entrypoints compiled into that wasm.
case "$NAME" in
  market_core | market-core | core)
    NAME=market_core
    WASF=market_core.wasm
    ;;
  resolver)
    WASF=resolver.wasm
    ;;
  treasury | reasoning_registry | registry | router | timelock)
    echo "error: $NAME is not wired for in-place upgrade by this script." >&2
    echo "       issue #18 shipped the mechanism on market-core + resolver only;" >&2
    echo "       treasury/reasoning-registry are a named follow-up (docs/adr/0010)." >&2
    exit 1
    ;;
  *)
    echo "error: unknown contract '$NAME'" >&2
    usage
    exit 1
    ;;
esac

# --- network / identities ----------------------------------------------------
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
OUT=${OUT:-deployments/$NETWORK.json}
WASM_DIR=${WASM_DIR:-target/wasm32v1-none/release}
BATCH=${BATCH:-50}
MAX_ROUNDS=${MAX_ROUNDS:-200}
DRY_RUN=${DRY_RUN:-0}

log() { echo "==> $*" >&2; }
die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required but not installed" >&2
    exit 1
  }
}
require_cmd stellar
require_cmd jq

# `sha256sum` is GNU coreutils (Linux/CI); `shasum -a 256` is the macOS
# equivalent. Same fallback pair as scripts/sync-vendored-wasm.sh.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "neither sha256sum nor shasum is installed"
fi

# --- the deployment record, read exactly like deploy-testnet.sh does ---------
[ -f "$OUT" ] || die "no deployment record at $OUT — run scripts/deploy-testnet.sh first"

json_get() { jq -r "$1 // empty" "$OUT"; }
json_set() {
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: not writing to $OUT (jq $*)"
    return 0
  fi
  local tmp
  tmp=$(mktemp)
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

CONTRACT_ID=$(json_get ".contracts.$NAME")
[ -n "$CONTRACT_ID" ] || die "$OUT has no .contracts.$NAME — nothing to upgrade"

ADMIN_ADDR=${ADMIN:-$(stellar keys address "$DEPLOYER_KEY" 2>/dev/null || echo "")}

# --- where is the new wasm? --------------------------------------------------
# `make build` output by default; OVERRIDE_WASM points at a pre-built artifact
# (e.g. the cross-compiled one CI produced) without re-running the toolchain.
WASM=${OVERRIDE_WASM:-$WASM_DIR/$WASF}
[ -f "$WASM" ] || die "no $WASM — run 'make build' (or set OVERRIDE_WASM)"

# --- command runners ---------------------------------------------------------
# Everything goes through these two so DRY_RUN=1 is a real dry run and the
# network/source-account flags are never repeated inconsistently.
invoke() {
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: stellar contract invoke --id \"$CONTRACT_ID\" --source-account \"$DEPLOYER_KEY\" --network \"$NETWORK\" -- $*"
    return 0
  fi
  stellar contract invoke --id "$CONTRACT_ID" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- "$@"
}

invoke_view() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "0"
    return 0
  fi
  stellar contract invoke --id "$CONTRACT_ID" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" --send no --is-view -- "$@"
}

# A contract call that the admin must make. When the admin is the deployer we
# can invoke directly. When it is the timelock (issue #63, docs/adr/0008) an
# automatic upgrade would be a governance bypass, so the schedule/execute pair
# is printed for a human instead — exactly the stance deploy-testnet.sh takes in
# its own admin_invoke.
admin_call() {
  if [ "$DRY_RUN" = "1" ]; then
    invoke "$@"
    return 0
  fi
  if [ -n "$ADMIN_ADDR" ] && [ "$ADMIN_ADDR" = "$(json_get .contracts.timelock)" ]; then
    log "the timelock owns admin: cannot auto-upgrade $NAME"
    log "  stellar contract invoke --id $(json_get .contracts.timelock) --source-account \${TIMELOCK_PROPOSER_KEY} \\"
    log "    --network $NETWORK -- schedule --target $CONTRACT_ID --fn_name $1 --args '<scval-json>'"
    log "  then execute after the delay, and re-run this script with --migrate"
    return 1
  fi
  invoke "$@"
}

# Extract a scalar from an invoke result. The CLI prints either JSON or a
# Rust-ish debug form (`Ok(U32(2))`, `Ok(Obj([..., (Symbol("done"),
# Boolean(true))]))`), so accept both and never silently read "nothing".
result_u32() {
  local raw=$1
  local out
  out=$(printf '%s' "$raw" | jq -r '.' 2>/dev/null || true)
  case "$out" in
    '' | null) out=$(printf '%s' "$raw" | grep -oE '[0-9]+' | tail -1 || true) ;;
  esac
  [ -n "$out" ] || die "could not parse a number from: $raw"
  printf '%s' "$out"
}

# -----------------------------------------------------------------------------
log "upgrading $NAME at $CONTRACT_ID on $NETWORK"
log "wasm: $WASM ($(wc -c <"$WASM") bytes, sha256 $(sha256_of "$WASM"))"

OLD_VERSION=$(result_u32 "$(invoke_view schema_version)")
log "current schema_version: $OLD_VERSION"

# 1. install (upload) the new wasm. `upgrade` takes a hash, not bytes: an
#    uninstalled hash must fail on-chain, which market-core's
#    upgrade_rejects_a_wasm_hash_that_was_never_installed test pins.
log "installing $WASM"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: stellar contract install --wasm \"$WASM\" --source-account \"$DEPLOYER_KEY\" --network \"$NETWORK\""
else
  INSTALL_OUT=$(stellar contract install --wasm "$WASM" \
    --source-account "$DEPLOYER_KEY" --network "$NETWORK")
  log "install output: $INSTALL_OUT"
fi
HEX=$(sha256_of "$WASM")

# The CLI accepts `BytesN<32>` as hex; some releases want the `0x` prefix.
# HASH_ARG is the single place that decides, so a pinned CLI version is a
# one-line change (or `HASH_ARG=0x... scripts/upgrade.sh ...`).
HASH_ARG=${HASH_ARG:-$HEX}

# 2 + 3. the swap itself.
log "invoking upgrade --new_wasm_hash $HASH_ARG"
admin_call upgrade --new_wasm_hash "$HASH_ARG"

json_set --arg n "$NAME" --arg h "$HEX" '.wasm_hashes[$n] = $h'
json_set --arg n "$NAME" --arg v "$OLD_VERSION" '.schema_versions[$n] = $v'
log "recorded .wasm_hashes.$NAME = $HEX (pre-upgrade version $OLD_VERSION)"

if [ "$MIGRATE" != "1" ]; then
  log "no --migrate: skipping the schema sweep."
  log "WARNING: if the new build writes a schema above $OLD_VERSION, storage is"
  log "         pre-migration until you run this again with --migrate. The user"
  log "         paths migrate the entry they touch, so funds are never frozen"
  log "         (ADR 0010); the admin sweep is what retires the compatibility view."
  exit 0
fi

# 4. the bounded sweep. Termination is `schema_version` changing: the contract
#    flips the version only when the cursor reaches the end, so a partial sweep
#    keeps the old number and the loop keeps going.
log "migrating in batches of $BATCH (max $MAX_ROUNDS rounds)"
round=0
new_version="$OLD_VERSION"
while [ "$new_version" = "$OLD_VERSION" ]; do
  round=$((round + 1))
  if [ "$round" -gt "$MAX_ROUNDS" ]; then
    die "migration still not done after $MAX_ROUNDS rounds of batch $BATCH — investigate rather than keep guessing"
  fi
  RAW=$(invoke migrate --batch "$BATCH")
  # Best effort: show the operator the progress fields if they are parseable.
  log "round $round: $(printf '%s' "$RAW" | tr -d '\n')"
  new_version=$(result_u32 "$(invoke_view schema_version)")
  log "schema_version now: $new_version"
done

# 5. verify, then record.
[ "$new_version" != "$OLD_VERSION" ] || die "schema_version did not advance"
if [ -n "${TARGET_SCHEMA_VERSION:-}" ] && [ "$new_version" != "$TARGET_SCHEMA_VERSION" ]; then
  die "schema_version is $new_version, expected TARGET_SCHEMA_VERSION=$TARGET_SCHEMA_VERSION"
fi
json_set --arg n "$NAME" --arg v "$new_version" '.schema_versions[$n] = $v'
log "done. $NAME on schema_version $new_version (was $OLD_VERSION), record updated: $OUT"
log "reminder: a market-core upgrade may only ADD entrypoints and append error"
log "codes — see the vendored-interface rule in docs/adr/0010."
