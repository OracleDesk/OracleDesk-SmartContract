#!/usr/bin/env bash
# Creates one market through the deployed treasury (agent_create_market) and
# reveals its signer-mode resolution spec, using the addresses recorded in
# deployments/testnet.json by scripts/deploy-testnet.sh.
#
# The agent itself is the sole signer (threshold 1) with a short dispute
# window — good enough to demonstrate the commit/reveal flow end to end
# without needing a real oracle. For a PriceConfig-based market, compute the
# hash with `spec-hash --v2 ... price ...` instead (same envelope, different
# rule).
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
# Usage: scripts/seed-market.sh [--commit-only] [seed_amount_stroops] [initial_yes_bps] [close_in_seconds]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet) NETWORK_PASSPHRASE="Test SDF Network ; September 2015" ;;
  local) NETWORK_PASSPHRASE="Standalone Network ; February 2017" ;;
  *) echo "error: NETWORK must be testnet or local (never mainnet)" >&2; exit 1 ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
DEPLOYMENTS=${DEPLOYMENTS:-deployments/$NETWORK.json}
SPECS_DIR=${SPECS_DIR:-deployments/specs-$NETWORK}
ATOMIC=true

# Allow --commit-only anywhere in the argument list.
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --commit-only) ATOMIC=false ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]:-}"

SEED_AMOUNT=${1:-1500000000}   # 150 USDC, comfortably above the 100 USDC MIN_SEED
INITIAL_YES_BPS=${2:-5000}     # 50/50
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

[ -f "$DEPLOYMENTS" ] || { echo "error: $DEPLOYMENTS not found — run NETWORK=$NETWORK scripts/deploy-testnet.sh first" >&2; exit 1; }

TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
MARKET_CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
AGENT=$(jq -r .agent "$DEPLOYMENTS")
for addr in "$TREASURY" "$MARKET_CORE"; do
  [ -n "$addr" ] && [ "$addr" != "null" ] || { echo "error: no treasury/market_core address in $DEPLOYMENTS" >&2; exit 1; }
done

sha256_hex() {
  python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"
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

echo "==> computing salted V2 resolution commitment (signers: [$AGENT], threshold 1)" >&2
mapfile -t SIGNERS < <(canonical_signers "$AGENT")
SALT=$(spec_hash gen-salt)
mapfile -t V2_FLAGS < <(v2_flags "$SALT")
RESOLUTION_HASH=$(spec_hash "${V2_FLAGS[@]}" signers 1 "$DISPUTE_WINDOW" "${SIGNERS[@]}")

echo "==> persisting the salt to $SPECS_DIR before creating the market" >&2
mkdir -p "$SPECS_DIR"
SPEC_FILE="$SPECS_DIR/$RESOLUTION_HASH.json"
(
  umask 077
  jq -n --arg question "$QUESTION_TEXT" --arg hash "$RESOLUTION_HASH" --arg salt "$SALT" \
    --arg network_id "$(sha256_hex "$NETWORK_PASSPHRASE")" --arg market_core "$MARKET_CORE" \
    --argjson signers "$(printf '%s\n' "${SIGNERS[@]}" | jq -R . | jq -sc .)" --argjson window "$DISPUTE_WINDOW" '{
      market_question: $question,
      resolution_hash: $hash,
      salt: $salt,
      spec: {
        version: 2, network_id: $network_id, market_core: $market_core, salt: $salt,
        rule: { Signers: { dispute_window: $window, signers: $signers, threshold: 1 } }
      }
    }' >"$SPEC_FILE.tmp"
  mv "$SPEC_FILE.tmp" "$SPEC_FILE"
)
# Prove the stored salt reproduces the commitment before any funds move.
mapfile -t V2_FLAGS < <(v2_flags "$(jq -r .salt "$SPEC_FILE")")
spec_hash verify "$RESOLUTION_HASH" "${V2_FLAGS[@]}" signers 1 "$DISPUTE_WINDOW" "${SIGNERS[@]}" >/dev/null

QUESTION_HASH=$(sha256_hex "$QUESTION_TEXT")
CLOSE_TIME=$(( $(date +%s) + CLOSE_IN_SECONDS ))

if [ "$ATOMIC" = "true" ]; then
  echo "==> creating AND revealing market atomically (seed=$SEED_AMOUNT, close_time=$CLOSE_TIME)" >&2
  MARKET_ID=$(stellar contract invoke --id "$TREASURY" --source-account "$AGENT_KEY" --network "$NETWORK" -- \
    agent_create_market_and_reveal \
    --agent "$AGENT" \
    --resolver "$RESOLVER" \
    --question_hash "$QUESTION_HASH" \
    --meta_uri "\"ipfs://$(echo -n "$QUESTION_TEXT" | tr ' ' '-')\"" \
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
    --meta_uri "\"ipfs://$(echo -n "$QUESTION_TEXT" | tr ' ' '-')\"" \
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
echo "spec_file=$SPEC_FILE"
