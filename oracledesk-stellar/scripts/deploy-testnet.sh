#!/usr/bin/env bash
# Idempotent deploy for the OracleDesk contracts (market-core, resolver,
# treasury, reasoning-registry, and optionally the timelock).
#
# NETWORK must be `testnet` (default) or `local` (the Stellar quickstart
# container). Anything else — especially `mainnet` — is rejected before any
# key or contract is touched. Each network gets its own record in
# deployments/<network>.json, so local runs never clobber testnet.
#
# Safe to re-run: each step checks the network's record first and skips
# anything already deployed. Delete an entry (or the whole file) to force
# that piece to redeploy. The deterministic salts make a re-run idempotent.
#
# Requires: stellar CLI, jq. Builds the contracts first if their wasm
# isn't already built (`make build` does this, or run `stellar contract
# build` yourself first).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=${NETWORK:-testnet}
case "$NETWORK" in
  testnet|local) ;;
  *) echo "error: NETWORK must be testnet or local (never mainnet)" >&2; exit 1 ;;
esac

IDENTITY_PREFIX=${IDENTITY_PREFIX:-oracledesk}
DEPLOYER_KEY=${DEPLOYER_KEY:-${IDENTITY_PREFIX}-deployer}
AGENT_KEY=${AGENT_KEY:-${IDENTITY_PREFIX}-agent}
# Least-privilege per-role agents registered in the treasury's agent
# registry: the maker creates/seeds and settles, the trader trades and
# settles. The constructor agent above keeps every role until removed.
MAKER_KEY=${MAKER_KEY:-${IDENTITY_PREFIX}-maker}
TRADER_KEY=${TRADER_KEY:-${IDENTITY_PREFIX}-trader}
OUT=${OUT:-deployments/$NETWORK.json}
WASM_DIR=target/wasm32v1-none/release

# Collateral decimals. market-core reads decimals() from the token at
# construction and derives its MIN_SEED / MAX_SETS bounds from it, so the
# deployer must know the token's precision up front. The self-issued test
# asset below is a Classic asset (7 decimals); set COLLATERAL_DECIMALS to
# match if you point `collateral` at a different SEP-41 token.
COLLATERAL_DECIMALS=${COLLATERAL_DECIMALS:-7}
if ! [[ "$COLLATERAL_DECIMALS" =~ ^[0-9]+$ ]] || [ "$COLLATERAL_DECIMALS" -gt 18 ]; then
  echo "error: COLLATERAL_DECIMALS=$COLLATERAL_DECIMALS must be an integer in 0..=18 (market-core's supported range)" >&2
  exit 1
fi

# treasury's risk caps (7-decimal USDC units). Must comfortably clear
# market-core's MIN_SEED (100 USDC) since agent_create_market's seed amount
# is capped by max_trade. Override via env if you need different limits.
MAX_TRADE=${MAX_TRADE:-2000000000}   # 200 USDC
MAX_MARKET=${MAX_MARKET:-5000000000} # 500 USDC
MAX_DAILY=${MAX_DAILY:-10000000000}  # 1,000 USDC
# Cap on capital deployed in open positions across all markets at once
# (must be >= MAX_TRADE).
MAX_NET_EXPOSURE=${MAX_NET_EXPOSURE:-$MAX_DAILY}
# Drawdown risk controls (Issue #46)
MAX_DRAWDOWN=${MAX_DRAWDOWN:-50000000000} # 5,000 USDC
DRAWDOWN_WINDOW_DAYS=${DRAWDOWN_WINDOW_DAYS:-7}
# Market creation risk controls (Issue #47)
MAX_SEED=${MAX_SEED:-$MAX_MARKET}
MAX_MARKETS_PER_DAY=${MAX_MARKETS_PER_DAY:-20}
# The local E2E harness uses 10-second markets; testnet keeps a 60s floor so
# a market cannot close before the deploy transaction is observable.
if [ "$NETWORK" = "local" ]; then
  MIN_CLOSE_HORIZON=${MIN_CLOSE_HORIZON:-5}
else
  MIN_CLOSE_HORIZON=${MIN_CLOSE_HORIZON:-60}
fi
MAX_CLOSE_HORIZON=${MAX_CLOSE_HORIZON:-7776000} # 90 days
ALLOWED_CATEGORIES=${ALLOWED_CATEGORIES:-63}     # 0x3F (Crypto, Forex, Equities, Commodities, Macro, Politics)
# Timelock (seconds, >= 86400) on every loosening treasury change: raising a
# cap, adding or widening an agent, switching market-core or collateral.
CONFIG_DELAY=${CONFIG_DELAY:-86400}
# Per-agent sub-budgets, within the global caps above. The maker's max_trade
# must clear market-core's 100 USDC MIN_SEED.
MAKER_MAX_TRADE=${MAKER_MAX_TRADE:-$MAX_TRADE}
MAKER_MAX_DAILY=${MAKER_MAX_DAILY:-5000000000}   # 500 USDC
TRADER_MAX_TRADE=${TRADER_MAX_TRADE:-$MAX_TRADE}
TRADER_MAX_DAILY=${TRADER_MAX_DAILY:-5000000000} # 500 USDC
ROLE_CREATE=1
ROLE_TRADE=2
ROLE_SETTLE=4
# Deterministic deploy salts (#61). The contract id for a `deploy --salt` is
# derived from (network, source account, salt) — not the constructor — so the
# real resolver and treasury addresses are known *before* market-core's
# constructor runs and no placeholder window ever exists. Changing a salt
# re-deploys that contract at a new address; delete its entry in
# deployments/testnet.json to force a fresh deploy at the recorded salt.
MARKET_CORE_SALT=${MARKET_CORE_SALT:-6f7261636c656465736b2d6d61726b65742d636f72652d7631}
RESOLVER_SALT=${RESOLVER_SALT:-6f7261636c656465736b2d7265736f6c7665722d7631}
TREASURY_SALT=${TREASURY_SALT:-6f7261636c656465736b2d74726561737572792d7631}
REGISTRY_SALT=${REGISTRY_SALT:-6f7261636c656465736b2d72656769737472792d7631}
TIMELOCK_SALT=${TIMELOCK_SALT:-6f7261636c656465736b2d74696d656c6f636b2d7631}
# Local-only Reflector-shaped oracle (contracts/test-oracle). Never deployed
# on testnet, so nobody can commit a real market to a fake feed.
TEST_ORACLE_SALT=${TEST_ORACLE_SALT:-6f7261636c656465736b2d746573742d6f7261636c652d7631}
# #63: when 1 every contract's admin is the timelock, passed in the
# constructor, so no single key can act instantly. It stays 0 by default
# because it turns the rest of this script's admin setup into timelocked
# schedule/execute calls (testnet cannot fast-forward the delay), and the
# deployer-admin path is the one exercised end to end. Set USE_TIMELOCK=1 once
# the operational keys exist; see docs/adr/0008-governance-timelock.md for the
# full procedure and scripts/wire-timelock.sh for moving an existing
# deployment to the timelock via the two-step admin handover.
USE_TIMELOCK=${USE_TIMELOCK:-0}
# Timelock proposer/canceller/executor/emergency all default to the deployer
# for bootstrap. Point them at real operational keys for anything but testnet.
TIMELOCK_PROPOSER_KEY=${TIMELOCK_PROPOSER_KEY:-$DEPLOYER_KEY}
TIMELOCK_CANCELLER_KEY=${TIMELOCK_CANCELLER_KEY:-$DEPLOYER_KEY}
# Timelock default delay floor (seconds, >= 86400).
TIMELOCK_DELAY=${TIMELOCK_DELAY:-86400}
DEFAULT_FEE_BPS=${DEFAULT_FEE_BPS:-100} # 1%
# Portion of each fee kept by the protocol treasury (bps). The remainder
# accrues to the market creator, claimable before resolution. 10000 = the
# protocol keeps everything (pre-#8 behavior).
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

mkdir -p deployments
[ -f "$OUT" ] || echo '{}' >"$OUT"

json_get() { jq -r "$1 // empty" "$OUT"; }
json_set() {
  local tmp
  tmp=$(mktemp)
  jq "$@" "$OUT" >"$tmp" && mv "$tmp" "$OUT"
}

# Predict the address a `--salt` deploy will land at, without deploying.
# The id is a pure function of (network, source account, salt), so this is
# stable across runs and independent of the constructor arguments.
predict_id() {
  stellar contract id wasm \
    --salt "$1" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK"
}

# Generate a 32-byte hex salt if the caller has not pinned one.
new_salt() { openssl rand -hex 32; }

# Run an admin-gated call. When the admin is the deployer (`USE_TIMELOCK=0`)
# it invokes directly; when the timelock owns admin it prints the
# `schedule`/`execute` pair an operator must run and reports a skip. Building
# `Vec<Val>` arguments for `schedule` needs the ScVal encoding, which is left
# to the operator on purpose: an automatic, unverified encoding is how a
# governance bypass would slip in. See docs/adr/0008-governance-timelock.md.
admin_invoke() {
  local target=$1 fn=$2
  shift 2
  if [ "$ADMIN" = "$DEPLOYER" ]; then
    stellar contract invoke --id "$target" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- "$fn" "$@"
    return 0
  fi
  log "timelock owns admin: schedule $fn on $target through $TIMELOCK"
  log "  stellar contract invoke --id $TIMELOCK --source-account $TIMELOCK_PROPOSER_KEY \\"
  log "    --network $NETWORK -- schedule --target $target --fn_name $fn --args '<scval-json>'"
  log "  then execute after ${TIMELOCK_DELAY}s; skipped for now"
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

# --- wasm must already be built -------------------------------------------
EXTRA_WASM=""
[ "$NETWORK" = "local" ] && EXTRA_WASM="test_oracle"
for f in market_core resolver reasoning_registry treasury timelock router $EXTRA_WASM; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    log "missing $WASM_DIR/$f.wasm — building all contracts first"
    stellar contract build
    break
  fi
done

# contractimport! (resolver, treasury, router) reads a vendored copy of
# market-core's wasm at *their* compile time — keep it fresh before
# rebuilding them. See docs/adr/0002-cross-contract-calls.md.
cp "$WASM_DIR/market_core.wasm" contracts/resolver/market_core.wasm
cp "$WASM_DIR/market_core.wasm" contracts/treasury/market_core.wasm
cp "$WASM_DIR/market_core.wasm" contracts/reasoning-registry/market_core.wasm
cp "$WASM_DIR/reasoning_registry.wasm" contracts/resolver/reasoning_registry.wasm
cp "$WASM_DIR/market_core.wasm" contracts/router/market_core.wasm
cp "$WASM_DIR/resolver.wasm" contracts/router/resolver.wasm
cp "$WASM_DIR/reasoning_registry.wasm" contracts/router/reasoning_registry.wasm
cp "$WASM_DIR/resolver.wasm" contracts/treasury/resolver.wasm
stellar contract build

# --- identities -------------------------------------------------------------
ensure_identity "$DEPLOYER_KEY"
ensure_identity "$AGENT_KEY"
ensure_identity "$MAKER_KEY"
ensure_identity "$TRADER_KEY"
DEPLOYER=$(stellar keys address "$DEPLOYER_KEY")
AGENT=$(stellar keys address "$AGENT_KEY")
MAKER=$(stellar keys address "$MAKER_KEY")
TRADER=$(stellar keys address "$TRADER_KEY")
# `.agent` stays for tools that predate the registry.
json_set --arg d "$DEPLOYER" --arg a "$AGENT" --arg m "$MAKER" --arg t "$TRADER" \
  '.deployer = $d | .agent = $a | .agents = {maker: $m, trader: $t}'

# --- timelock (#63) ----------------------------------------------------------
# Deployed before the four core contracts so its address can be passed as their
# admin in the constructor (the "timelock owns admin from birth" path). The
# timelock needs no other contract's address, so it is not part of the
# resolver/treasury/market-core circular ordering.
TIMELOCK_PROPOSER=$(stellar keys address "$TIMELOCK_PROPOSER_KEY")
TIMELOCK_CANCELLER=$(stellar keys address "$TIMELOCK_CANCELLER_KEY")
if [ "$USE_TIMELOCK" = "1" ]; then
  TIMELOCK=$(json_get .contracts.timelock)
  [ -n "$TIMELOCK" ] || TIMELOCK=$(predict_id "$TIMELOCK_SALT")
  json_set --arg s "$TIMELOCK_SALT" '.salts.timelock = $s'
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
    [ "$DEPLOYED" = "$TIMELOCK" ] || {
      echo "error: timelock landed at $DEPLOYED, expected $TIMELOCK" >&2
      exit 1
    }
    json_set --arg id "$TIMELOCK" '.contracts.timelock = $id'
  else
    log "timelock already deployed: $TIMELOCK"
  fi
  ADMIN="$TIMELOCK"
else
  ADMIN="$DEPLOYER"
fi

# --- USDC test asset ---------------------------------------------------------
# Self-issued testnet "USDC": a real SEP-41 token (7 decimals, matching the
# design doc) with no dependency on guessing a real issuer's contract id.
# <!-- TODO(maintainer): point `collateral` at Circle's real testnet USDC
# issuer if/when this needs to interoperate with other testnet apps. -->
# market-core's __constructor calls decimals() on this token, so it must be
# deployed before market-core below (it is). Keep COLLATERAL_DECIMALS in
# sync with the asset deployed here.
USDC=$(json_get .contracts.usdc)
if [ -z "$USDC" ]; then
  log "deploying self-issued testnet USDC (SEP-41)"
  USDC=$(stellar contract asset deploy \
    --asset "USDC:$DEPLOYER" \
    --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK")
  json_set --arg id "$USDC" '.contracts.usdc = $id'
else
  log "USDC already deployed: $USDC"
fi

# --- deterministic addresses (#61) -------------------------------------------
# Predict the resolver and treasury ids up front so market-core's constructor
# can receive the *real* addresses (never the deployer EOA). The predicted id
# is a pure function of (network, source account, salt), so it is stable and
# available before either contract is deployed.
RESOLVER=$(json_get .contracts.resolver)
TREASURY=$(json_get .contracts.treasury)
MARKET_CORE=$(json_get .contracts.market_core)
REGISTRY=$(json_get .contracts.reasoning_registry)

[ -n "$RESOLVER" ] || RESOLVER=$(predict_id "$RESOLVER_SALT")
[ -n "$TREASURY" ] || TREASURY=$(predict_id "$TREASURY_SALT")
[ -n "$MARKET_CORE" ] || MARKET_CORE=$(predict_id "$MARKET_CORE_SALT")
[ -n "$REGISTRY" ] || REGISTRY=$(predict_id "$REGISTRY_SALT")

# Persist the salts so a re-run (or a migration) can reproduce the ids.
json_set --arg r "$RESOLVER_SALT" --arg t "$TREASURY_SALT" \
  --arg mc "$MARKET_CORE_SALT" --arg rg "$REGISTRY_SALT" \
  '.salts = {market_core: $mc, resolver: $r, treasury: $t, reasoning_registry: $rg}'

# --- resolver (deployed first: it only needs market-core's *predicted* id) ---
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
  [ "$DEPLOYED" = "$RESOLVER" ] || {
    echo "error: resolver landed at $DEPLOYED, expected $RESOLVER" >&2
    exit 1
  }
  json_set --arg id "$RESOLVER" '.contracts.resolver = $id'
else
  log "resolver already deployed: $RESOLVER"
fi

# --- treasury ------------------------------------------------------------
TREASURY=$(json_get .contracts.treasury)
if [ -z "$TREASURY" ]; then
  log "deploying treasury"
  CREATION_POLICY=$(jq -nc \
    --argjson max_seed "$MAX_SEED" \
    --argjson max_markets "$MAX_MARKETS_PER_DAY" \
    --argjson window_secs 86400 \
    --argjson min_h "$MIN_CLOSE_HORIZON" \
    --argjson max_h "$MAX_CLOSE_HORIZON" \
    --argjson cats "$ALLOWED_CATEGORIES" \
    '{"max_seed": $max_seed, "max_markets_per_window": $max_markets, "creation_window_secs": $window_secs, "min_close_horizon": $min_h, "max_close_horizon": $max_h, "allowed_categories": $cats}')
  TREASURY=$(stellar contract deploy \
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
  json_set --arg id "$TREASURY" '.contracts.treasury = $id'
else
  log "treasury already deployed: $TREASURY"
fi

# --- market-core (constructor receives the real resolver/treasury) ----------
if [ "$(json_get .contracts.market_core)" = "" ]; then
  # __constructor reads collateral.decimals() and rejects anything above 18
  # with Error::UnsupportedDecimals (#19). The token must already be live.
  log "deploying market-core with real resolver/treasury in the constructor (collateral decimals: $COLLATERAL_DECIMALS)"
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
  [ "$DEPLOYED" = "$MARKET_CORE" ] || {
    echo "error: market-core landed at $DEPLOYED, expected $MARKET_CORE" >&2
    exit 1
  }
  json_set --argjson d "$COLLATERAL_DECIMALS" '.collateral_decimals = $d'
  json_set --arg id "$MARKET_CORE" '.contracts.market_core = $id'
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
  [ "$DEPLOYED" = "$REGISTRY" ] || {
    echo "error: reasoning-registry landed at $DEPLOYED, expected $REGISTRY" >&2
    exit 1
  }
  json_set --arg id "$REGISTRY" '.contracts.reasoning_registry = $id'
else
  log "reasoning-registry already deployed: $REGISTRY"
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
    json_set '.agent_registered = true'
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
    json_set '.role_agents_registered = true'
  fi
else
  log "maker and trader already registered with reasoning-registry"
fi

# --- maker / trader policies in the treasury's agent registry ---------------
# New agents are a loosening, so set_agent only queues them; they go live
# once execute_agent runs after CONFIG_DELAY. Re-run this script after the
# delay to execute (until then the constructor agent keeps every role).
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
      json_set --arg n "$name" '.agent_policies[$n] = "proposed"'
    fi
  fi
  if [ "$(json_get ".agent_policies.$name")" = "proposed" ]; then
    if stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" -- execute_agent --agent "$addr" >/dev/null 2>&1; then
      log "treasury.execute_agent($name): live"
      json_set --arg n "$name" '.agent_policies[$n] = "active"'
    else
      log "treasury.execute_agent($name): still timelocked, re-run after the delay"
    fi
  else
    log "$name agent already active in the treasury"
  fi
}
propose_agent maker "$MAKER" $((ROLE_CREATE | ROLE_SETTLE)) "$MAKER_MAX_TRADE" "$MAKER_MAX_DAILY"
propose_agent trader "$TRADER" $((ROLE_TRADE | ROLE_SETTLE)) "$TRADER_MAX_TRADE" "$TRADER_MAX_DAILY"

# --- fund the treasury with test USDC ---------------------------------------
# The treasury is a share vault: collateral sent to it directly would be a
# donation to existing shareholders, so the deployer mints to itself and
# deposits, receiving shares (docs/adr/0005-treasury-vault.md).
# FUND_AMOUNT is in raw token units, so scale it by the collateral's
# decimals: 1,000,000 tokens at 7 decimals is 1e13, at 18 decimals 1e24.
TREASURY_FUNDED=$(json_get .treasury_funded_amount)
FUND_AMOUNT=${TREASURY_FUND_AMOUNT:-$((1000000 * 10 ** COLLATERAL_DECIMALS))} # 1,000,000 tokens
if [ "$TREASURY_FUNDED" != "$FUND_AMOUNT" ]; then
  log "minting $FUND_AMOUNT stroops of test USDC and depositing it into the treasury"
  stellar contract invoke --id "$USDC" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- mint --to "$DEPLOYER" --amount "$FUND_AMOUNT"
  stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
    --network "$NETWORK" -- deposit --from "$DEPLOYER" --amount "$FUND_AMOUNT"
  json_set --arg a "$FUND_AMOUNT" '.treasury_funded_amount = $a'
else
  log "treasury already funded with $FUND_AMOUNT stroops"
fi

# --- local-only test oracle --------------------------------------------------
# Price-mode resolution needs a Reflector-shaped feed. It exists only on the
# quickstart network; the testnet path must keep using the real resolver
# rules and never a fake oracle.
if [ "$NETWORK" = "local" ]; then
  TEST_ORACLE=$(json_get .contracts.test_oracle)
  [ -n "$TEST_ORACLE" ] || TEST_ORACLE=$(predict_id "$TEST_ORACLE_SALT")
  json_set --arg s "$TEST_ORACLE_SALT" '.salts.test_oracle = $s'
  if [ "$(json_get .contracts.test_oracle)" = "" ]; then
    log "deploying local test oracle at deterministic address $TEST_ORACLE"
    DEPLOYED=$(stellar contract deploy \
      --wasm "$WASM_DIR/test_oracle.wasm" \
      --salt "$TEST_ORACLE_SALT" \
      --source-account "$DEPLOYER_KEY" \
      --network "$NETWORK" \
      -- \
      --admin "$ADMIN")
    [ "$DEPLOYED" = "$TEST_ORACLE" ] || {
      echo "error: test oracle landed at $DEPLOYED, expected $TEST_ORACLE" >&2
      exit 1
    }
    json_set --arg id "$TEST_ORACLE" '.contracts.test_oracle = $id'
  else
    log "test oracle already deployed: $TEST_ORACLE"
  fi
fi

json_set --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_deployed_at = $ts'

log "done. Deployment record: $OUT"
cat "$OUT"