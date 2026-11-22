#!/usr/bin/env bash
# Creates one market through the deployed treasury (agent_create_market) and
# reveals its signer-mode resolution spec, using the addresses recorded in
# deployments/testnet.json by scripts/deploy-testnet.sh.
#
# Signer mode uses the deployment's agent as the sole signer (threshold 1).
# Price mode uses contracts.test_oracle and the PRICE_* defaults below. Both
# commit through the same salted ResolutionSpecV2 envelope.
#
# The commitment is a salted ResolutionSpecV2 (docs/adr/0004-spec-versioning.md).
# The salt is the only secret protecting the rule until reveal and is needed to
# reveal it, so it is written to deployments/specs/<resolution_hash>.json and
# read back BEFORE the market is created: if that fails, no market is created.
#
# By default the market is created and its spec revealed atomically through
# treasury.agent_create_market_and_reveal (#64), so a crash can't leave an
# unresolvable market. Pass --commit-only to keep the legacy two-step
# behaviour (agent_create_market, then register_spec_v2 separately).
#
# The market-maker agent runs the same commit -> persist -> create -> reveal
# flow itself, with crash recovery: see agents/core/maker-flow.ts and
# docs/adr/0001-resolution-commitment.md ("Agent flow and recovery").
#
# Usage: scripts/seed-market.sh [--commit-only] [--mode signer|price] \
#   [seed_amount_stroops] [initial_yes_bps] [close_in_seconds] [dispute_window_secs] [question_text]
# Price mode env: PRICE_ASSET=other:XLM|stellar:<addr> (default other:XLM),
#   PRICE_THRESHOLD (2000), PRICE_DIRECTION (above|at-or-above|below|at-or-below),
#   PRICE_MAX_STALENESS (3600).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet) NETWORK_PASSPHRASE="Test SDF Network ; September 2015" ;;
  local) NETWORK_PASSPHRASE="Standalone Network ; February 2017" ;;
  *)
    echo "error: NETWORK must be testnet or local (never mainnet)" >&2
    exit 1
    ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
DEPLOYMENTS=${DEPLOYMENTS:-deployments/$NETWORK.json}
SPECS_DIR=${SPECS_DIR:-deployments/specs-$NETWORK}
ATOMIC=true
MODE=${MODE:-signer}

# Allow flags anywhere among the positional arguments.
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit-only)
      ATOMIC=false
      shift
      ;;
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
      ARGS+=("$1")
      shift
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
if [ "${#ARGS[@]}" -gt 0 ]; then
  set -- "${ARGS[@]}"
else
  set --
fi

SEED_AMOUNT=${1:-1500000000} # 150 USDC, comfortably above the 100 USDC MIN_SEED
INITIAL_YES_BPS=${2:-5000}   # 50/50
if [ "$NETWORK" = "local" ]; then
  DEFAULT_CLOSE_IN=10
  DEFAULT_DISPUTE=3
else
  DEFAULT_CLOSE_IN=90
  DEFAULT_DISPUTE=5
fi
CLOSE_IN_SECONDS=${3:-$DEFAULT_CLOSE_IN}
DISPUTE_WINDOW=${4:-$DEFAULT_DISPUTE}
QUESTION_TEXT=${5:-"Demo market seeded by scripts/seed-market.sh"}

if [ ! -f "$DEPLOYMENTS" ]; then
  echo "error: $DEPLOYMENTS not found — run NETWORK=$NETWORK scripts/deploy-testnet.sh first" >&2
  exit 1
fi

TREASURY=$(jq -r '.contracts.treasury // empty' "$DEPLOYMENTS")
RESOLVER=$(jq -r '.contracts.resolver // empty' "$DEPLOYMENTS")
MARKET_CORE=$(jq -r '.contracts.market_core // empty' "$DEPLOYMENTS")
AGENT=$(jq -r '.agent // empty' "$DEPLOYMENTS")
if [ -z "$TREASURY" ] || [ -z "$MARKET_CORE" ]; then
  echo "error: no treasury/market_core address in $DEPLOYMENTS" >&2
  exit 1
fi
if [ -z "$RESOLVER" ]; then
  echo "error: no resolver address in $DEPLOYMENTS" >&2
  exit 1
fi

if [ "$MODE" = "price" ]; then
  ORACLE=$(jq -r '.contracts.test_oracle // empty' "$DEPLOYMENTS")
  if [ -z "$ORACLE" ]; then
    echo "error: price mode requires contracts.test_oracle in $DEPLOYMENTS" >&2
    exit 1
  fi
  PRICE_ASSET=${PRICE_ASSET:-other:XLM}
  PRICE_THRESHOLD=${PRICE_THRESHOLD:-2000}
  PRICE_DIRECTION=${PRICE_DIRECTION:-above}
  PRICE_MAX_STALENESS=${PRICE_MAX_STALENESS:-3600}
  case "$PRICE_ASSET" in
    other:*) PRICE_ASSET_JSON=$(jq -nc --arg s "${PRICE_ASSET#other:}" '{Other:$s}') ;;
    stellar:*) PRICE_ASSET_JSON=$(jq -nc --arg a "${PRICE_ASSET#stellar:}" '{Stellar:$a}') ;;
    *)
      echo "error: PRICE_ASSET must be other:<symbol> or stellar:<address>" >&2
      exit 2
      ;;
  esac
  case "$PRICE_DIRECTION" in
    above) PRICE_DIRECTION_ENUM=Above ;;
    at-or-above) PRICE_DIRECTION_ENUM=AtOrAbove ;;
    below) PRICE_DIRECTION_ENUM=Below ;;
    at-or-below) PRICE_DIRECTION_ENUM=AtOrBelow ;;
    *)
      echo "error: unknown PRICE_DIRECTION '$PRICE_DIRECTION'" >&2
      exit 2
      ;;
  esac
fi

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  else
    python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"
  fi
}

spec_hash() {
  cargo run --quiet --manifest-path scripts/spec-hash/Cargo.toml -- "$@"
}

# Canonical signer order (lexicographic strkey), shared with the agent
# (agents/core/spec.ts canonicalizeSpec). Vec order is part of the XDR, so
# hashing and the reveal must both use this order.
canonical_signers() {
  printf '%s\n' "$@" | LC_ALL=C sort
}

# $1 = salt. Prints the V2 flags spec-hash expects, one per line.
v2_flags() {
  printf '%s\n' --v2 --salt "$1" --network-passphrase "$NETWORK_PASSPHRASE" --market-core "$MARKET_CORE"
}

echo "==> computing salted V2 resolution commitment (mode=$MODE)" >&2
SALT=$(spec_hash gen-salt)
mapfile -t V2_FLAGS < <(v2_flags "$SALT")

if [ "$MODE" = "price" ]; then
  RULE_HASH_ARGS=(price "$ORACLE" "$PRICE_ASSET" "$PRICE_THRESHOLD" "$PRICE_DIRECTION" "$PRICE_MAX_STALENESS")
  RULE_JSON=$(jq -nc \
    --arg oracle "$ORACLE" --argjson asset "$PRICE_ASSET_JSON" \
    --argjson threshold "$PRICE_THRESHOLD" --arg direction "$PRICE_DIRECTION_ENUM" \
    --argjson staleness "$PRICE_MAX_STALENESS" \
    '{Price:{reflector:$oracle, asset:$asset, threshold:$threshold, direction:$direction, max_staleness:$staleness}}')
else
  echo "==> signers: [$AGENT], threshold 1" >&2
  mapfile -t SIGNERS < <(canonical_signers "$AGENT")
  RULE_HASH_ARGS=(signers 1 "$DISPUTE_WINDOW" "${SIGNERS[@]}")
  RULE_JSON=$(jq -nc \
    --argjson signers "$(printf '%s\n' "${SIGNERS[@]}" | jq -R . | jq -sc .)" \
    --argjson window "$DISPUTE_WINDOW" \
    '{Signers:{dispute_window:$window, signers:$signers, threshold:1}}')
fi

RESOLUTION_HASH=$(spec_hash "${V2_FLAGS[@]}" "${RULE_HASH_ARGS[@]}")

echo "==> persisting the salt to $SPECS_DIR before creating the market" >&2
mkdir -p "$SPECS_DIR"
SPEC_FILE="$SPECS_DIR/$RESOLUTION_HASH.json"
(
  umask 077
  jq -n --arg question "$QUESTION_TEXT" --arg hash "$RESOLUTION_HASH" --arg salt "$SALT" \
    --arg network_id "$(sha256_hex "$NETWORK_PASSPHRASE")" --arg market_core "$MARKET_CORE" \
    --argjson rule "$RULE_JSON" '{
      market_question: $question,
      resolution_hash: $hash,
      salt: $salt,
      spec: {
        version: 2, network_id: $network_id, market_core: $market_core, salt: $salt,
        rule: $rule
      }
    }' >"$SPEC_FILE.tmp"
  mv "$SPEC_FILE.tmp" "$SPEC_FILE"
)
# Prove the stored salt reproduces the commitment before any funds move.
mapfile -t V2_FLAGS < <(v2_flags "$(jq -r .salt "$SPEC_FILE")")
spec_hash verify "$RESOLUTION_HASH" "${V2_FLAGS[@]}" "${RULE_HASH_ARGS[@]}" >/dev/null

QUESTION_HASH=$(sha256_hex "$QUESTION_TEXT")
CLOSE_TIME=$(($(date +%s) + CLOSE_IN_SECONDS))
META_URI_JSON=$(jq -Rn --arg q "$QUESTION_TEXT" '"ipfs://" + ($q | gsub(" "; "-"))')

if [ "$ATOMIC" = "true" ]; then
  echo "==> creating AND revealing market atomically (seed=$SEED_AMOUNT, close_time=$CLOSE_TIME)" >&2
  MARKET_ID=$(stellar contract invoke --id "$TREASURY" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
    agent_create_market_and_reveal \
    --agent "$AGENT" \
    --resolver "$RESOLVER" \
    --question_hash "$QUESTION_HASH" \
    --meta_uri "$META_URI_JSON" \
    --category Macro \
    --close_time "$CLOSE_TIME" \
    --seed_amount "$SEED_AMOUNT" \
    --initial_yes_bps "$INITIAL_YES_BPS" \
    --spec_v2 "$(jq -c .spec "$SPEC_FILE")")
else
  echo "==> creating market (seed=$SEED_AMOUNT, close_time=$CLOSE_TIME)" >&2
  MARKET_ID=$(stellar contract invoke --id "$TREASURY" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
    agent_create_market \
    --agent "$AGENT" \
    --question_hash "$QUESTION_HASH" \
    --resolution_hash "$RESOLUTION_HASH" \
    --meta_uri "$META_URI_JSON" \
    --category Macro \
    --close_time "$CLOSE_TIME" \
    --seed_amount "$SEED_AMOUNT" \
    --initial_yes_bps "$INITIAL_YES_BPS")

  echo "==> revealing the resolution spec to the resolver" >&2
  stellar contract invoke --id "$RESOLVER" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
    register_spec_v2 \
    --market_id "$MARKET_ID" \
    --spec "$(jq -c .spec "$SPEC_FILE")"
fi

echo "market_id=$MARKET_ID"
echo "close_time=$CLOSE_TIME"
echo "dispute_window=$DISPUTE_WINDOW"
echo "mode=$MODE"
echo "spec_file=$SPEC_FILE"
