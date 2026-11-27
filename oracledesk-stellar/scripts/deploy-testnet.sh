#!/usr/bin/env bash
# Idempotent deploy for the OracleDesk contracts (market-core, resolver,
# treasury, reasoning-registry, and optionally the timelock).
#
# NETWORK must be `testnet` (default) or `local` (the Stellar quickstart
# container). Anything else — especially `mainnet` — is rejected before any
# key or contract is touched. Each network gets its own record in
# deployments/<network>.json, so local runs never clobber testnet.
#
# Collateral modes (Issue #134):
#   COLLATERAL_MODE=self-issued (default) — deploys self-issued USDC:<deployer>
#   COLLATERAL_MODE=existing              — uses COLLATERAL_ASSET=CODE:G... SAC
#                                           (e.g. Circle testnet USDC), checks
#                                           decimals==7 & issuer flags, adds
#                                           trustlines, funds via deposit only.
#
# Safe to re-run: each step checks the network's record first and skips
# anything already deployed. Delete an entry (or the whole file) to force
# that piece to redeploy. The deterministic salts make a re-run idempotent.
#
# Requires: stellar CLI, jq (and curl in existing collateral mode).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet | local) ;;
  *)
    echo "error: NETWORK must be testnet or local (never mainnet)" >&2
    exit 1
    ;;
esac

COLLATERAL_MODE=${COLLATERAL_MODE:-self-issued}
COLLATERAL_ASSET=${COLLATERAL_ASSET:-}
COLLATERAL_CONTRACT_ID=${COLLATERAL_CONTRACT_ID:-}
FORCE_REDEPLOY=${FORCE_REDEPLOY:-0}
case "$COLLATERAL_MODE" in
  self-issued | existing) ;;
  *)
    echo "error: COLLATERAL_MODE must be self-issued or existing (got '$COLLATERAL_MODE')" >&2
    exit 1
    ;;
esac

if [ "$COLLATERAL_MODE" = "existing" ]; then
  if [ -z "$COLLATERAL_ASSET" ]; then
    echo "error: COLLATERAL_MODE=existing requires COLLATERAL_ASSET=CODE:G..." >&2
    exit 1
  fi
  if ! printf '%s\n' "$COLLATERAL_ASSET" | grep -Eq '^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$'; then
    echo "error: malformed COLLATERAL_ASSET '$COLLATERAL_ASSET' (expected CODE:G<55 base32 chars>)" >&2
    exit 1
  fi
fi

if [ -z "${HORIZON_URL:-}" ]; then
  if [ "$NETWORK" = "local" ]; then
    HORIZON_URL="http://localhost:8000"
  else
    HORIZON_URL="https://horizon-testnet.stellar.org"
  fi
fi

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
MAKER_KEY=${MAKER_KEY:-${IDENTITY_PREFIX}-maker}
TRADER_KEY=${TRADER_KEY:-${IDENTITY_PREFIX}-trader}
OUT=${OUT:-deployments/$NETWORK.json}
WASM_DIR=${WASM_DIR:-target/wasm32v1-none/release}
case "$WASM_DIR" in
  *local-short*)
    [ "$NETWORK" = "local" ] || {
      echo "error: local-short-windows wasm may only be deployed on NETWORK=local" >&2
      exit 1
    }
    ;;
esac

# treasury's risk caps (7-decimal USDC units). Must comfortably clear
# market-core's MIN_SEED (100 USDC) since agent_create_market's seed amount
# is capped by max_trade. Override via env if you need different limits.
MAX_TRADE=${MAX_TRADE:-2000000000}   # 200 USDC
MAX_MARKET=${MAX_MARKET:-5000000000} # 500 USDC
MAX_DAILY=${MAX_DAILY:-10000000000}  # 1,000 USDC
MAX_NET_EXPOSURE=${MAX_NET_EXPOSURE:-$MAX_DAILY}
MAX_DRAWDOWN=${MAX_DRAWDOWN:-50000000000} # 5,000 USDC
DRAWDOWN_WINDOW_DAYS=${DRAWDOWN_WINDOW_DAYS:-7}
MAX_SEED=${MAX_SEED:-$MAX_MARKET}
MAX_MARKETS_PER_DAY=${MAX_MARKETS_PER_DAY:-20}
if [ "$NETWORK" = "local" ]; then
  MIN_CLOSE_HORIZON=${MIN_CLOSE_HORIZON:-5}
else
  MIN_CLOSE_HORIZON=${MIN_CLOSE_HORIZON:-60}
fi
MAX_CLOSE_HORIZON=${MAX_CLOSE_HORIZON:-7776000} # 90 days
ALLOWED_CATEGORIES=${ALLOWED_CATEGORIES:-63}    # 0x3F
CONFIG_DELAY=${CONFIG_DELAY:-86400}
MAKER_MAX_TRADE=${MAKER_MAX_TRADE:-$MAX_TRADE}
MAKER_MAX_DAILY=${MAKER_MAX_DAILY:-5000000000}
TRADER_MAX_TRADE=${TRADER_MAX_TRADE:-$MAX_TRADE}
TRADER_MAX_DAILY=${TRADER_MAX_DAILY:-5000000000}
ROLE_CREATE=1
ROLE_TRADE=2
ROLE_SETTLE=4

MARKET_CORE_SALT=${MARKET_CORE_SALT:-6f7261636c656465736b2d6d61726b65742d636f72652d7631}
RESOLVER_SALT=${RESOLVER_SALT:-6f7261636c656465736b2d7265736f6c7665722d7631}
TREASURY_SALT=${TREASURY_SALT:-6f7261636c656465736b2d74726561737572792d7631}
REGISTRY_SALT=${REGISTRY_SALT:-6f7261636c656465736b2d72656769737472792d7631}
TIMELOCK_SALT=${TIMELOCK_SALT:-6f7261636c656465736b2d74696d656c6f636b2d7631}
ROUTER_SALT=${ROUTER_SALT:-6f7261636c656465736b2d726f757465722d7631}
# Local-only Reflector-shaped oracle (contracts/test-oracle). Never deployed
# on testnet, so nobody can commit a real market to a fake feed.
TEST_ORACLE_SALT=${TEST_ORACLE_SALT:-6f7261636c656465736b2d746573742d6f7261636c652d7631}
USE_TIMELOCK=${USE_TIMELOCK:-0}
TIMELOCK_PROPOSER_KEY=${TIMELOCK_PROPOSER_KEY:-$DEPLOYER_KEY}
TIMELOCK_CANCELLER_KEY=${TIMELOCK_CANCELLER_KEY:-$DEPLOYER_KEY}
TIMELOCK_DELAY=${TIMELOCK_DELAY:-86400}
DEFAULT_FEE_BPS=${DEFAULT_FEE_BPS:-100}
PROTOCOL_FEE_SHARE_BPS=${PROTOCOL_FEE_SHARE_BPS:-10000}

log() { echo "==> $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required but not installed" >&2
    exit 1
  }
}
require_cmd stellar
require_cmd jq
if [ "$COLLATERAL_MODE" = "existing" ]; then
  require_cmd curl
fi

mkdir -p "$(dirname "$OUT")"
[ -f "$OUT" ] || echo '{}' >"$OUT"

json_get() { jq -r "$1 // empty" "$OUT"; }

json_set_str() {
  local path=$1 val=$2 tmp
  tmp=$(mktemp)
  jq --arg p "$path" --arg v "$val" \
    'setpath($p | split(".") | map(select(length > 0)); $v)' \
    "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

json_set_raw() {
  local path=$1 val=$2 tmp
  tmp=$(mktemp)
  jq --arg p "$path" --argjson v "$val" \
    'setpath($p | split(".") | map(select(length > 0)); $v)' \
    "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

json_del() {
  local filter=$1 tmp
  tmp=$(mktemp)
  jq "$filter" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

predict_id() {
  stellar contract id wasm \
    --salt "$1" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK"
}

admin_invoke() {
  local target=$1 fn=$2
  shift 2
  if [ "$ADMIN" = "$DEPLOYER" ]; then
    stellar contract invoke --id "$target" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- "$fn" "$@"
    return 0
  fi
  log "timelock owns admin: schedule $fn on $target through $TIMELOCK"
  log "  cd scripts/governance"
  log "  npm run cli -- propose --network $NETWORK --timelock $TIMELOCK \\"
  log "    --target $target --contract <binding-name> --fn $fn \\"
  log "    --args '<json-object>' --title '<review title>' --submit"
  log "  npm run cli -- status <id> --network $NETWORK"
  log "  npm run cli -- execute <id> --network $NETWORK --submit"
  log "  skipped for now; see docs/governance-cli.md"
  return 1
}

ensure_identity() {
  local name=$1
  if stellar keys address "$name" >/dev/null 2>&1; then
    log "identity '$name' already exists"
  else
    log "generating and funding identity '$name'"
    stellar keys generate "$name" --network "$NETWORK" --fund
  fi
}

ensure_trustline() {
  local key_name=$1 addr=$2 asset=$3 code issuer acct has_tl
  code="${asset%%:*}"
  issuer="${asset#*:}"
  acct=$(curl -sf "$HORIZON_URL/accounts/$addr" || echo '{}')
  has_tl=$(printf '%s\n' "$acct" | jq -r --arg c "$code" --arg i "$issuer" \
    '[.balances[]? | select(.asset_code == $c and .asset_issuer == $i)] | length')
  if [ "${has_tl:-0}" -gt 0 ]; then
    log "trustline for $asset already exists on $key_name ($addr)"
    return 0
  fi
  log "creating classic trustline for $asset on $key_name ($addr)"
  stellar tx new change-trust \
    --source-account "$key_name" \
    --line "$asset" \
    --network "$NETWORK" >/dev/null
}

# --- wasm must already be built -------------------------------------------
WASM_MISSING=0
for f in market_core resolver reasoning_registry treasury timelock router test_oracle; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    log "missing $WASM_DIR/$f.wasm — building all contracts first"
    WASM_MISSING=1
    break
  fi
done
if [ "$WASM_MISSING" = "1" ]; then
  stellar contract build
  cp "$WASM_DIR/market_core.wasm" contracts/resolver/market_core.wasm
  cp "$WASM_DIR/market_core.wasm" contracts/treasury/market_core.wasm
  cp "$WASM_DIR/reasoning_registry.wasm" contracts/resolver/reasoning_registry.wasm
  cp "$WASM_DIR/market_core.wasm" contracts/router/market_core.wasm
  cp "$WASM_DIR/resolver.wasm" contracts/router/resolver.wasm
  cp "$WASM_DIR/reasoning_registry.wasm" contracts/router/reasoning_registry.wasm
  cp "$WASM_DIR/resolver.wasm" contracts/treasury/resolver.wasm
  stellar contract build
fi

# --- identities -------------------------------------------------------------
ensure_identity "$DEPLOYER_KEY"
ensure_identity "$AGENT_KEY"
ensure_identity "$MAKER_KEY"
ensure_identity "$TRADER_KEY"
DEPLOYER=$(stellar keys address "$DEPLOYER_KEY")
AGENT=$(stellar keys address "$AGENT_KEY")
MAKER=$(stellar keys address "$MAKER_KEY")
TRADER=$(stellar keys address "$TRADER_KEY")
json_set_str ".deployer" "$DEPLOYER"
json_set_str ".agent" "$AGENT"
json_set_str ".agents.maker" "$MAKER"
json_set_str ".agents.trader" "$TRADER"

# --- timelock (#63) ----------------------------------------------------------
TIMELOCK_PROPOSER=$(stellar keys address "$TIMELOCK_PROPOSER_KEY")
TIMELOCK_CANCELLER=$(stellar keys address "$TIMELOCK_CANCELLER_KEY")
if [ "$USE_TIMELOCK" = "1" ]; then
  TIMELOCK=$(json_get .contracts.timelock)
  [ -n "$TIMELOCK" ] || TIMELOCK=$(predict_id "$TIMELOCK_SALT")
  json_set_str ".salts.timelock" "$TIMELOCK_SALT"
  if [ "$(json_get .contracts.timelock)" = "" ]; then
    log "deploying timelock at deterministic address $TIMELOCK"
    DEPLOYED=$(stellar contract deploy \
      --wasm "$WASM_DIR/timelock.wasm" \
      --salt "$TIMELOCK_SALT" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" \
      -- \
      --admin "$DEPLOYER" \
      --proposer "$TIMELOCK_PROPOSER" \
      --canceller "$TIMELOCK_CANCELLER" \
      --executor "$DEPLOYER" \
      --emergency "$DEPLOYER" \
      --default_delay "$TIMELOCK_DELAY")
    if [ "$DEPLOYED" != "$TIMELOCK" ]; then
      echo "error: timelock landed at $DEPLOYED, expected $TIMELOCK" >&2
      exit 1
    fi
    json_set_str ".contracts.timelock" "$TIMELOCK"
  else
    log "timelock already deployed: $TIMELOCK"
  fi
  ADMIN="$TIMELOCK"
else
  ADMIN="$DEPLOYER"
fi

# --- Collateral resolution & verification (#134) ----------------------------
PREV_USDC=$(json_get .contracts.usdc)
PREV_MC=$(json_get .contracts.market_core)

if [ "$COLLATERAL_MODE" = "self-issued" ]; then
  USDC="$PREV_USDC"
  if [ -z "$USDC" ]; then
    log "deploying self-issued testnet USDC (SEP-41)"
    USDC=$(stellar contract asset deploy \
      --asset "USDC:$DEPLOYER" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK")
    json_set_str ".contracts.usdc" "$USDC"
  else
    log "USDC already deployed: $USDC"
  fi
  json_set_raw ".collateral" "$(jq -nc --arg asset "USDC:$DEPLOYER" --arg id "$USDC" \
    '{mode: "self-issued", asset: $asset, contract_id: $id, decimals: 7, issuer_flags: null}')"
else
  ASSET_CODE="${COLLATERAL_ASSET%%:*}"
  ASSET_ISSUER="${COLLATERAL_ASSET#*:}"
  if [ -n "$COLLATERAL_CONTRACT_ID" ]; then
    USDC="$COLLATERAL_CONTRACT_ID"
  else
    USDC=$(stellar contract id asset --asset "$COLLATERAL_ASSET" --network "$NETWORK")
  fi

  # Verify SAC exists (deploy it permissionlessly if not yet deployed on testnet).
  DECIMALS=$(stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- decimals 2>/dev/null || true)
  if [ -z "$DECIMALS" ]; then
    log "SAC for $COLLATERAL_ASSET not deployed yet — deploying SAC at $USDC"
    USDC=$(stellar contract asset deploy \
      --asset "$COLLATERAL_ASSET" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK")
    DECIMALS=$(stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- decimals)
  fi
  DECIMALS=$(printf '%s\n' "$DECIMALS" | tr -d '"[:space:]')
  if [ "$DECIMALS" != "7" ]; then
    echo "error: collateral $COLLATERAL_ASSET ($USDC) reports decimals=$DECIMALS; market-core MIN_SEED and MAX_SETS require exactly 7 decimals" >&2
    exit 1
  fi
  TOKEN_NAME=$(stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- name | jq -r '. // empty' 2>/dev/null || echo "$ASSET_CODE")
  TOKEN_SYMBOL=$(stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- symbol | jq -r '. // empty' 2>/dev/null || echo "$ASSET_CODE")

  # Inspect issuer flags via Horizon.
  ISSUER_JSON=$(curl -sf "$HORIZON_URL/accounts/$ASSET_ISSUER")
  AUTH_REQUIRED=$(printf '%s\n' "$ISSUER_JSON" | jq -r '.flags.auth_required // false')
  AUTH_REVOCABLE=$(printf '%s\n' "$ISSUER_JSON" | jq -r '.flags.auth_revocable // false')
  AUTH_CLAWBACK=$(printf '%s\n' "$ISSUER_JSON" | jq -r '.flags.auth_clawback_enabled // false')
  if [ "$AUTH_REQUIRED" = "true" ]; then
    echo "error: issuer $ASSET_ISSUER has auth_required=true; trustlines require manual issuer authorization and cannot be used permissionlessly" >&2
    exit 1
  fi
  if [ "$AUTH_REVOCABLE" = "true" ] || [ "$AUTH_CLAWBACK" = "true" ]; then
    log "WARNING: issuer $ASSET_ISSUER has auth_revocable=$AUTH_REVOCABLE, auth_clawback_enabled=$AUTH_CLAWBACK — frozen or clawed-back SAC balances can break market-core solvency (see docs/collateral.md)"
  fi

  # Refuse silently switching collateral on an existing market-core deployment.
  if [ -n "$PREV_MC" ] && [ -n "$PREV_USDC" ] && [ "$PREV_USDC" != "$USDC" ]; then
    if [ "$FORCE_REDEPLOY" != "1" ]; then
      echo "error: collateral changed ($PREV_USDC -> $USDC) while market_core ($PREV_MC) is already deployed; re-run with FORCE_REDEPLOY=1 to redeploy market-core, resolver, and treasury" >&2
      exit 1
    fi
    log "FORCE_REDEPLOY=1: clearing existing market_core, resolver, treasury, wiring, and funding totals for collateral switch"
    json_del 'del(.contracts.market_core, .contracts.resolver, .contracts.treasury, .wired, .wired_resolver, .wired_treasury, .treasury_minted_total, .treasury_funded_amount, .treasury_deposited_total)'
  fi

  json_set_str ".contracts.usdc" "$USDC"
  FLAGS_JSON=$(jq -nc \
    --argjson req "$AUTH_REQUIRED" \
    --argjson rev "$AUTH_REVOCABLE" \
    --argjson claw "$AUTH_CLAWBACK" \
    '{auth_required: $req, auth_revocable: $rev, auth_clawback_enabled: $claw}')
  json_set_raw ".collateral" "$(jq -nc \
    --arg asset "$COLLATERAL_ASSET" \
    --arg id "$USDC" \
    --arg name "$TOKEN_NAME" \
    --arg symbol "$TOKEN_SYMBOL" \
    --argjson flags "$FLAGS_JSON" \
    '{mode: "existing", asset: $asset, contract_id: $id, decimals: 7, name: $name, symbol: $symbol, issuer_flags: $flags}')"

  # Ensure classic trustlines for deployer and agent G-accounts (never C-addresses).
  ensure_trustline "$DEPLOYER_KEY" "$DEPLOYER" "$COLLATERAL_ASSET"
  ensure_trustline "$AGENT_KEY" "$AGENT" "$COLLATERAL_ASSET"
fi

# --- dependency check when market_core is removed or changed (#132) ---------
RECORDED_MC=$(json_get .contracts.market_core)
RECORDED_RESOLVER=$(json_get .contracts.resolver)
RECORDED_TREASURY=$(json_get .contracts.treasury)
if [ -z "$RECORDED_MC" ] && { [ -n "$RECORDED_RESOLVER" ] || [ -n "$RECORDED_TREASURY" ]; }; then
  log "market_core missing from record while resolver/treasury exist — clearing stale dependents for redeploy"
  json_del 'del(.contracts.resolver, .contracts.treasury, .wired, .wired_resolver, .wired_treasury)'
fi

# --- deterministic addresses (#61) -------------------------------------------
RESOLVER=$(json_get .contracts.resolver)
TREASURY=$(json_get .contracts.treasury)
MARKET_CORE=$(json_get .contracts.market_core)
REGISTRY=$(json_get .contracts.reasoning_registry)

[ -n "$RESOLVER" ] || RESOLVER=$(predict_id "$RESOLVER_SALT")
[ -n "$TREASURY" ] || TREASURY=$(predict_id "$TREASURY_SALT")
[ -n "$MARKET_CORE" ] || MARKET_CORE=$(predict_id "$MARKET_CORE_SALT")
[ -n "$REGISTRY" ] || REGISTRY=$(predict_id "$REGISTRY_SALT")

json_set_str ".salts.market_core" "$MARKET_CORE_SALT"
json_set_str ".salts.resolver" "$RESOLVER_SALT"
json_set_str ".salts.treasury" "$TREASURY_SALT"
json_set_str ".salts.reasoning_registry" "$REGISTRY_SALT"

# --- resolver ----------------------------------------------------------------
if [ "$(json_get .contracts.resolver)" = "" ]; then
  log "deploying resolver at deterministic address $RESOLVER"
  DEPLOYED=$(stellar contract deploy \
    --wasm "$WASM_DIR/resolver.wasm" \
    --salt "$RESOLVER_SALT" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN" \
    --market_core "$MARKET_CORE")
  if [ "$DEPLOYED" != "$RESOLVER" ]; then
    echo "error: resolver landed at $DEPLOYED, expected $RESOLVER" >&2
    exit 1
  fi
  json_set_str ".contracts.resolver" "$RESOLVER"
else
  log "resolver already deployed: $RESOLVER"
fi

# --- treasury ----------------------------------------------------------------
TREASURY_RECORDED=$(json_get .contracts.treasury)
if [ -z "$TREASURY_RECORDED" ]; then
  log "deploying treasury"
  CREATION_POLICY=$(jq -nc \
    --argjson max_seed "$MAX_SEED" \
    --argjson max_markets "$MAX_MARKETS_PER_DAY" \
    --argjson window_secs 86400 \
    --argjson min_h "$MIN_CLOSE_HORIZON" \
    --argjson max_h "$MAX_CLOSE_HORIZON" \
    --argjson cats "$ALLOWED_CATEGORIES" \
    '{"max_seed": $max_seed, "max_markets_per_window": $max_markets, "creation_window_secs": $window_secs, "min_close_horizon": $min_h, "max_close_horizon": $max_h, "allowed_categories": $cats}')
  DEPLOYED=$(stellar contract deploy \
    --wasm "$WASM_DIR/treasury.wasm" \
    --salt "$TREASURY_SALT" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN" \
    --agent "$AGENT" \
    --collateral "$USDC" \
    --market_core "$MARKET_CORE" \
    --max_trade "$MAX_TRADE" \
    --max_market "$MAX_MARKET" \
    --max_daily "$MAX_DAILY" \
    --max_net_exposure "$MAX_NET_EXPOSURE" \
    --config_delay "$CONFIG_DELAY" \
    --max_drawdown "$MAX_DRAWDOWN" \
    --window_days "$DRAWDOWN_WINDOW_DAYS" \
    --creation_policy "$CREATION_POLICY")
  TREASURY="$DEPLOYED"
  json_set_str ".contracts.treasury" "$TREASURY"
else
  TREASURY="$TREASURY_RECORDED"
  log "treasury already deployed: $TREASURY"
fi

# --- market-core -------------------------------------------------------------
if [ "$(json_get .contracts.market_core)" = "" ]; then
  log "deploying market-core with real resolver/treasury in the constructor"
  DEPLOYED=$(stellar contract deploy \
    --wasm "$WASM_DIR/market_core.wasm" \
    --salt "$MARKET_CORE_SALT" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN" \
    --collateral "$USDC" \
    --treasury "$TREASURY" \
    --resolver "$RESOLVER" \
    --default_fee_bps "$DEFAULT_FEE_BPS" \
    --protocol_fee_share_bps "$PROTOCOL_FEE_SHARE_BPS")
  if [ "$DEPLOYED" != "$MARKET_CORE" ]; then
    echo "error: market-core landed at $DEPLOYED, expected $MARKET_CORE" >&2
    exit 1
  fi
  json_set_str ".contracts.market_core" "$MARKET_CORE"
else
  log "market-core already deployed: $MARKET_CORE"
fi

# --- reasoning-registry ------------------------------------------------------
if [ "$(json_get .contracts.reasoning_registry)" = "" ]; then
  log "deploying reasoning-registry at deterministic address $REGISTRY"
  DEPLOYED=$(stellar contract deploy \
    --wasm "$WASM_DIR/reasoning_registry.wasm" \
    --salt "$REGISTRY_SALT" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN")
  if [ "$DEPLOYED" != "$REGISTRY" ]; then
    echo "error: reasoning-registry landed at $DEPLOYED, expected $REGISTRY" >&2
    exit 1
  fi
  json_set_str ".contracts.reasoning_registry" "$REGISTRY"
else
  log "reasoning-registry already deployed: $REGISTRY"
fi

# --- authenticate the resolver/treasury wiring (#61, #132) ------------------
WIRED=$(json_get .wired)
WIRED_RESOLVER=$(json_get .wired_resolver)
WIRED_TREASURY=$(json_get .wired_treasury)
if [ "$WIRED" != "true" ] || [ "$WIRED_RESOLVER" != "$RESOLVER" ] || [ "$WIRED_TREASURY" != "$TREASURY" ]; then
  WIRING_OK=1
  if [ "$WIRED" != "true" ] || [ "$WIRED_RESOLVER" != "$RESOLVER" ]; then
    log "authenticating market-core <-> resolver wiring"
    if admin_invoke "$MARKET_CORE" propose_resolver --resolver "$RESOLVER"; then
      stellar contract invoke --id "$RESOLVER" --source-account "$DEPLOYER_KEY" \
        --network "$NETWORK" -- accept_market_core_role
      json_set_str ".wired_resolver" "$RESOLVER"
    else
      WIRING_OK=0
      log "resolver wiring is timelocked; run scripts/migrate-market-core-wiring.sh after the delay"
    fi
  fi
  if [ "$WIRING_OK" = "1" ] && { [ "$WIRED" != "true" ] || [ "$WIRED_TREASURY" != "$TREASURY" ]; }; then
    log "authenticating market-core <-> treasury wiring"
    if admin_invoke "$MARKET_CORE" propose_treasury --treasury "$TREASURY"; then
      stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
        --network "$NETWORK" -- accept_market_core_role
      json_set_str ".wired_treasury" "$TREASURY"
    else
      WIRING_OK=0
      log "treasury wiring is timelocked; run scripts/migrate-market-core-wiring.sh after the delay"
    fi
  fi
  if [ "$WIRING_OK" = "1" ]; then
    json_del 'del(.needs_treasury_wiring)'
    json_set_raw ".wired" "true"
# --- optional router ---------------------------------------------------------
if [ "${DEPLOY_ROUTER:-0}" = "1" ] || [ "${NETWORK}" = "local" ]; then
  ROUTER=$(json_get .contracts.router)
  [ -n "$ROUTER" ] || ROUTER=$(predict_id "$ROUTER_SALT")
  json_set --arg s "$ROUTER_SALT" '.salts.router = $s'
  if [ "$(json_get .contracts.router)" = "" ]; then
    log "deploying router at deterministic address $ROUTER"
    DEPLOYED=$(stellar contract deploy \
      --wasm "$WASM_DIR/router.wasm" \
      --salt "$ROUTER_SALT" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" \
      -- \
      --market_core "$MARKET_CORE" \
      --resolver "$RESOLVER" \
      --reasoning_registry "$REGISTRY")
    [ "$DEPLOYED" = "$ROUTER" ] || {
      echo "error: router landed at $DEPLOYED, expected $ROUTER" >&2
      exit 1
    }
    json_set --arg id "$ROUTER" '.contracts.router = $id'
  else
    log "router already deployed: $ROUTER"
  fi
fi

# --- authenticate the resolver/treasury wiring (#61) ------------------------
# The constructor already stored the real addresses; this handshake makes each
# downstream contract prove (by calling back `market_core()`) that it is
# configured for this market-core, and emits ResolverChanged/TreasuryChanged.
# It is idempotent: skip once `wired` is recorded.
if [ "$(json_get .wired)" != "true" ]; then
  log "authenticating market-core ↔ resolver wiring"
  if admin_invoke "$MARKET_CORE" propose_resolver --resolver "$RESOLVER"; then
    # The resolver proves the wiring by calling market-core itself; its own
    # signature is not needed (contract-to-contract auth).
    stellar contract invoke --id "$RESOLVER" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- accept_market_core_role

    log "authenticating market-core ↔ treasury wiring"
    admin_invoke "$MARKET_CORE" propose_treasury --treasury "$TREASURY"
    stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- accept_market_core_role

    json_set 'del(.needs_treasury_wiring) | .wired = true'
  else
    log "wiring is timelocked; run scripts/migrate-market-core-wiring.sh after the delay"
  fi
else
  log "market-core already wired to resolver/treasury"
fi

# --- register the agents with reasoning-registry -----------------------------
if [ "$(json_get .agent_registered)" != "true" ]; then
  log "registering agent with reasoning-registry"
  if admin_invoke "$REGISTRY" register_agent --agent "$AGENT"; then
    json_set_raw ".agent_registered" "true"
  fi
else
  log "agent already registered"
fi
if [ "$(json_get .role_agents_registered)" != "true" ]; then
  log "registering maker and trader with reasoning-registry"
  for a in "$MAKER" "$TRADER"; do
    admin_invoke "$REGISTRY" register_agent --agent "$a" || true
  done
  if [ "$ADMIN" = "$DEPLOYER" ]; then
    json_set_raw ".role_agents_registered" "true"
  fi
else
  log "maker and trader already registered with reasoning-registry"
fi

# --- maker / trader policies in the treasury's agent registry ---------------
agent_policy() {
  jq -nc --argjson roles "$1" --arg t "$2" --arg d "$3" \
    '{roles: $roles, max_trade: $t, max_daily: $d, active: true}'
}
propose_agent() {
  local name=$1 addr=$2 roles=$3 max_trade=$4 max_daily=$5
  if [ "$(json_get ".agent_policies.$name")" = "" ]; then
    log "treasury.set_agent($name) — live after ${CONFIG_DELAY}s"
    if admin_invoke "$TREASURY" set_agent --agent "$addr" \
      --policy "$(agent_policy "$roles" "$max_trade" "$max_daily")"; then
      json_set_str ".agent_policies.$name" "proposed"
    fi
  fi
  if [ "$(json_get ".agent_policies.$name")" = "proposed" ]; then
    if stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- execute_agent --agent "$addr" >/dev/null 2>&1; then
      log "treasury.execute_agent($name): live"
      json_set_str ".agent_policies.$name" "active"
    else
      log "treasury.execute_agent($name): still timelocked, re-run after the delay"
    fi
  else
    log "$name agent already active in the treasury"
  fi
}
propose_agent maker "$MAKER" $((ROLE_CREATE | ROLE_SETTLE)) "$MAKER_MAX_TRADE" "$MAKER_MAX_DAILY"
propose_agent trader "$TRADER" $((ROLE_TRADE | ROLE_SETTLE)) "$TRADER_MAX_TRADE" "$TRADER_MAX_DAILY"

# --- fund the treasury (#132, #134) -----------------------------------------
if [ "$COLLATERAL_MODE" = "self-issued" ]; then
  MINTED_TOTAL=$(json_get .treasury_minted_total)
  if [ -z "$MINTED_TOTAL" ]; then
    MINTED_TOTAL=$(json_get .treasury_funded_amount)
  fi
  MINTED_TOTAL=${MINTED_TOTAL:-0}
  FUND_AMOUNT=${TREASURY_FUND_AMOUNT:-10000000000000} # 1,000,000 USDC
  MINT_DELTA=$((FUND_AMOUNT - MINTED_TOTAL))
  if [ "$MINT_DELTA" -gt 0 ]; then
    log "minting $MINT_DELTA stroops of test USDC and depositing into treasury (target total $FUND_AMOUNT)"
    stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- mint --to "$DEPLOYER" --amount "$MINT_DELTA"
    stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- deposit --from "$DEPLOYER" --amount "$MINT_DELTA"
    NEW_TOTAL=$((MINTED_TOTAL + MINT_DELTA))
    json_set_str ".treasury_minted_total" "$NEW_TOTAL"
    json_set_str ".treasury_funded_amount" "$NEW_TOTAL"
  else
    log "treasury already funded with $MINTED_TOTAL stroops (target $FUND_AMOUNT)"
  fi
else
  DEPOSITED_TOTAL=$(json_get .treasury_deposited_total)
  DEPOSITED_TOTAL=${DEPOSITED_TOTAL:-0}
  FUND_AMOUNT=${TREASURY_FUND_AMOUNT:-5000000000} # 500 USDC (faucet-realistic)
  DEPOSIT_DELTA=$((FUND_AMOUNT - DEPOSITED_TOTAL))
  if [ "$DEPOSIT_DELTA" -gt 0 ]; then
    DEPLOYER_BAL=$(stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- balance --id "$DEPLOYER" | tr -d '"[:space:]')
    DEPLOYER_BAL=${DEPLOYER_BAL:-0}
    if [ "$DEPLOYER_BAL" -lt "$DEPOSIT_DELTA" ]; then
      json_set_str ".last_deployed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "action required: deployer $DEPLOYER holds $DEPLOYER_BAL stroops of $COLLATERAL_ASSET, needs $DEPOSIT_DELTA stroops to fund treasury" >&2
      echo "  1. Visit Circle's testnet faucet: https://faucet.circle.com/ (select Stellar Testnet)" >&2
      echo "  2. Fund deployer address: $DEPLOYER" >&2
      echo "  3. Re-run: COLLATERAL_MODE=existing COLLATERAL_ASSET=$COLLATERAL_ASSET ./scripts/deploy-testnet.sh" >&2
      exit 3
    fi
    log "depositing $DEPOSIT_DELTA stroops of $COLLATERAL_ASSET from deployer into treasury (no mint)"
    stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- deposit --from "$DEPLOYER" --amount "$DEPOSIT_DELTA"
    NEW_TOTAL=$((DEPOSITED_TOTAL + DEPOSIT_DELTA))
    json_set_str ".treasury_deposited_total" "$NEW_TOTAL"
  else
    log "treasury already funded with $DEPOSITED_TOTAL stroops via deposit (target $FUND_AMOUNT)"
  fi
fi

# --- test oracle (testnet and local only; never mainnet, #133) --------------
# Deployed with Reflector-aligned defaults (USD base, 14 decimals, 300s
# resolution, 86400s retention) and XLM registered as a supported asset.
TEST_ORACLE_DECIMALS=${TEST_ORACLE_DECIMALS:-14}
TEST_ORACLE_RESOLUTION=${TEST_ORACLE_RESOLUTION:-300}
TEST_ORACLE_PERIOD=${TEST_ORACLE_PERIOD:-86400}
if [ "$NETWORK" = "testnet" ] || [ "$NETWORK" = "local" ]; then
  TEST_ORACLE=$(json_get .contracts.test_oracle)
  [ -n "$TEST_ORACLE" ] || TEST_ORACLE=$(predict_id "$TEST_ORACLE_SALT")
  json_set_str ".salts.test_oracle" "$TEST_ORACLE_SALT"
  if [ "$(json_get .contracts.test_oracle)" = "" ]; then
    log "deploying SEP-40 test oracle at deterministic address $TEST_ORACLE"
    DEPLOYED=$(stellar contract deploy \
      --wasm "$WASM_DIR/test_oracle.wasm" \
      --salt "$TEST_ORACLE_SALT" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" \
      -- \
      --admin "$ADMIN" \
      --base '{"Other":"USD"}' \
      --decimals "$TEST_ORACLE_DECIMALS" \
      --resolution "$TEST_ORACLE_RESOLUTION" \
      --period "$TEST_ORACLE_PERIOD")
    if [ "$DEPLOYED" != "$TEST_ORACLE" ]; then
      echo "error: test oracle landed at $DEPLOYED, expected $TEST_ORACLE" >&2
      exit 1
    fi
    json_set_str ".contracts.test_oracle" "$TEST_ORACLE"
  else
    log "test oracle already deployed: $TEST_ORACLE"
  fi
  if [ "$(json_get .test_oracle_assets_seeded)" != "true" ]; then
    log "registering default asset Other(XLM) on test oracle"
    if admin_invoke "$TEST_ORACLE" add_asset --asset '{"Other":"XLM"}'; then
      json_set_raw ".test_oracle_assets_seeded" "true"
    fi
  else
    log "test oracle default assets already registered"
  fi
fi

json_set_str ".last_deployed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Record SHA-256 hashes of the deployed contract WASM files (additive, #127).
for contract_name in market_core resolver treasury reasoning_registry; do
  if [ -f "$WASM_DIR/${contract_name}.wasm" ]; then
    wasm_hash=$(sha256sum "$WASM_DIR/${contract_name}.wasm" | awk '{print $1}')
    json_set --arg k "$contract_name" --arg h "$wasm_hash" '.wasm_sha256[$k] = $h'
  fi
done

json_set --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_deployed_at = $ts'

log "done. Deployment record: $OUT"
cat "$OUT"
