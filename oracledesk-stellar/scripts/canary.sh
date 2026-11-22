#!/usr/bin/env bash
# Scheduled Stellar testnet canary (#130).
#
# Verifies:
#   1. Existence: all 5 recorded contracts and deployer/agent accounts exist
#      and RPC latestLedger has not regressed.
#   2. Wiring: market-core & treasury configs match deployments/testnet.json,
#      agent is registered in reasoning-registry, and treasury available_capital
#      clears the minimum threshold.
#   3. Cycle: runs a cheap create -> buy -> resolve -> redeem/claim -> trace
#      cycle using ONLY the dedicated `oracledesk-canary` identity, asserting
#      collateral is recovered minus fees + rounding.
#
# Usage:
#   ./scripts/canary.sh [--phase existence|wiring|cycle|all] [--out canary-result.json] [--state-file .canary-state.json]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STELLAR_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${STELLAR_DIR}"

PHASE="all"
OUT_FILE="canary-result.json"
STATE_FILE="${CANARY_STATE_FILE:-.canary-state.json}"
NETWORK="${NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}"
DEPLOYMENTS_FILE="${DEPLOYMENTS_FILE:-deployments/${NETWORK}.json}"
MIN_TREASURY_CAPITAL="${CANARY_MIN_TREASURY_CAPITAL:-1000000000}" # 100 USDC
MAX_CYCLE_LOSS_STROOPS="${CANARY_MAX_CYCLE_LOSS_STROOPS:-5000000}" # 0.5 USDC max fees + dust

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    --state-file) STATE_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

for cmd in curl jq node stellar; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: required command '$cmd' not found" >&2
    exit 1
  }
done

prev_ledger="null"
prev_rpc_failures=0
if [[ -f "${STATE_FILE}" ]]; then
  prev_ledger="$(jq -r '.latestLedger // "null"' "${STATE_FILE}")"
  prev_rpc_failures="$(jq -r '.consecutiveRpcFailures // 0' "${STATE_FILE}")"
fi

emit_verdict() {
  local obs_json="$1"
  local verdict
  verdict="$(OBS_JSON="${obs_json}" node --input-type=module -e '
    import { classifyCanaryRun } from "./scripts/canary/classify.mjs";
    const obs = JSON.parse(process.env.OBS_JSON);
    const result = classifyCanaryRun(obs);
    process.stdout.write(JSON.stringify({ ...result, latestLedger: obs.latestLedger ?? null, checkedAt: new Date().toISOString() }, null, 2));
  ')"
  printf '%s\n' "${verdict}" > "${OUT_FILE}"

  # Persist updated state for subsequent scheduled runs.
  local next_ledger next_failures
  next_ledger="$(printf '%s' "${verdict}" | jq -r '.latestLedger // "null"')"
  next_failures="$(printf '%s' "${verdict}" | jq -r '.consecutiveRpcFailures // 0')"
  jq -n \
    --argjson latestLedger "${next_ledger}" \
    --argjson consecutiveRpcFailures "${next_failures}" \
    '{latestLedger: $latestLedger, consecutiveRpcFailures: $consecutiveRpcFailures}' > "${STATE_FILE}"

  cat "${OUT_FILE}"
  local status
  status="$(printf '%s' "${verdict}" | jq -r '.status')"
  [[ "${status}" == "healthy" ]]
}

# --- Phase 0: RPC getLatestLedger --------------------------------------------
rpc_resp="$(curl -fsS --max-time 20 -X POST "${RPC_URL}" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' 2>&1)" || {
  obs="$(jq -n --arg err "${rpc_resp}" --argjson prev "${prev_rpc_failures}" \
    '{rpcError: $err, consecutiveRpcFailures: $prev}')"
  emit_verdict "${obs}"
  exit 1
}

latest_ledger="$(printf '%s' "${rpc_resp}" | jq -r '.result.sequence // empty')"
if [[ -z "${latest_ledger}" ]]; then
  obs="$(jq -n --arg err "missing result.sequence from getLatestLedger" --argjson prev "${prev_rpc_failures}" \
    '{rpcError: $err, consecutiveRpcFailures: $prev}')"
  emit_verdict "${obs}"
  exit 1
fi

# --- Phase 1: Existence ------------------------------------------------------
DEPLOYER="$(jq -r '.deployer' "${DEPLOYMENTS_FILE}")"
AGENT="$(jq -r '.agent' "${DEPLOYMENTS_FILE}")"
USDC="$(jq -r '.contracts.usdc' "${DEPLOYMENTS_FILE}")"
MARKET_CORE="$(jq -r '.contracts.market_core' "${DEPLOYMENTS_FILE}")"
RESOLVER="$(jq -r '.contracts.resolver' "${DEPLOYMENTS_FILE}")"
TREASURY="$(jq -r '.contracts.treasury' "${DEPLOYMENTS_FILE}")"
REGISTRY="$(jq -r '.contracts.reasoning_registry' "${DEPLOYMENTS_FILE}")"

check_contract_exists() {
  local id="$1"
  stellar contract fetch --id "${id}" --network "${NETWORK}" --out-file /dev/null >/dev/null 2>&1
}

usdc_ok=false; check_contract_exists "${USDC}" && usdc_ok=true
mc_ok=false; check_contract_exists "${MARKET_CORE}" && mc_ok=true
res_ok=false; check_contract_exists "${RESOLVER}" && res_ok=true
tr_ok=false; check_contract_exists "${TREASURY}" && tr_ok=true
reg_ok=false; check_contract_exists "${REGISTRY}" && reg_ok=true

deployer_ok=false
if curl -fsS --max-time 15 "${HORIZON_URL}/accounts/${DEPLOYER}" >/dev/null 2>&1; then
  deployer_ok=true
fi

contracts_json="$(jq -n \
  --argjson usdc "${usdc_ok}" \
  --argjson market_core "${mc_ok}" \
  --argjson resolver "${res_ok}" \
  --argjson treasury "${tr_ok}" \
  --argjson reasoning_registry "${reg_ok}" \
  '{usdc: $usdc, market_core: $market_core, resolver: $resolver, treasury: $treasury, reasoning_registry: $reasoning_registry}')"

if [[ "${PHASE}" == "existence" ]] || [[ "${usdc_ok}" != "true" ]] || [[ "${mc_ok}" != "true" ]] || [[ "${res_ok}" != "true" ]] || [[ "${tr_ok}" != "true" ]] || [[ "${reg_ok}" != "true" ]] || [[ "${deployer_ok}" != "true" ]] || { [[ "${prev_ledger}" != "null" ]] && (( latest_ledger < prev_ledger )); }; then
  obs="$(jq -n \
    --argjson latestLedger "${latest_ledger}" \
    --argjson previousLatestLedger "${prev_ledger}" \
    --argjson contractsPresent "${contracts_json}" \
    --argjson deployerPresent "${deployer_ok}" \
    '{latestLedger: $latestLedger, previousLatestLedger: $previousLatestLedger, contractsPresent: $contractsPresent, deployerPresent: $deployerPresent}')"
  emit_verdict "${obs}"
  exit $?
fi

# --- Phase 2: Read-only wiring checks ----------------------------------------
wiring_errors="[]"
add_wiring_err() {
  wiring_errors="$(jq -nc --argjson arr "${wiring_errors}" --arg msg "$1" '$arr + [$msg]')"
}

mc_cfg="$(stellar contract invoke --id "${MARKET_CORE}" --network "${NETWORK}" --send=no -- get_config 2>/dev/null || echo '{}')"
[[ "$(printf '%s' "${mc_cfg}" | jq -r '.resolver // empty')" == "${RESOLVER}" ]] || add_wiring_err "market_core.resolver mismatch"
[[ "$(printf '%s' "${mc_cfg}" | jq -r '.treasury // empty')" == "${TREASURY}" ]] || add_wiring_err "market_core.treasury mismatch"
[[ "$(printf '%s' "${mc_cfg}" | jq -r '.collateral // empty')" == "${USDC}" ]] || add_wiring_err "market_core.collateral mismatch"

tr_cfg="$(stellar contract invoke --id "${TREASURY}" --network "${NETWORK}" --send=no -- get_config 2>/dev/null || echo '{}')"
[[ "$(printf '%s' "${tr_cfg}" | jq -r '.market_core // empty')" == "${MARKET_CORE}" ]] || add_wiring_err "treasury.market_core mismatch"
[[ "$(printf '%s' "${tr_cfg}" | jq -r '.collateral // empty')" == "${USDC}" ]] || add_wiring_err "treasury.collateral mismatch"

agent_reg="$(stellar contract invoke --id "${REGISTRY}" --network "${NETWORK}" --send=no -- is_registered --agent "${AGENT}" 2>/dev/null || echo 'false')"
[[ "${agent_reg}" == "true" ]] || add_wiring_err "agent not registered on reasoning_registry"

avail_cap="$(stellar contract invoke --id "${TREASURY}" --network "${NETWORK}" --send=no -- available_capital 2>/dev/null | tr -d '"' || echo '0')"
if (( avail_cap < MIN_TREASURY_CAPITAL )); then
  add_wiring_err "treasury available_capital (${avail_cap}) below minimum (${MIN_TREASURY_CAPITAL})"
fi

if [[ "${PHASE}" == "wiring" ]] || [[ "$(printf '%s' "${wiring_errors}" | jq 'length')" != "0" ]]; then
  obs="$(jq -n \
    --argjson latestLedger "${latest_ledger}" \
    --argjson previousLatestLedger "${prev_ledger}" \
    --argjson contractsPresent "${contracts_json}" \
    --argjson deployerPresent "${deployer_ok}" \
    --argjson wiringErrors "${wiring_errors}" \
    '{latestLedger: $latestLedger, previousLatestLedger: $previousLatestLedger, contractsPresent: $contractsPresent, deployerPresent: $deployerPresent, wiringErrors: $wiringErrors}')"
  emit_verdict "${obs}"
  exit $?
fi

# --- Phase 3: End-to-end cycle with dedicated canary identity ----------------
cycle_error="null"
run_cycle() {
  local tmp_cfg
  tmp_cfg="$(mktemp -d "${RUNNER_TEMP:-/tmp}/oracledesk-canary.XXXXXX")"
  trap 'rm -rf "${tmp_cfg}"' RETURN

  if [[ -z "${TESTNET_CANARY_SECRET:-}" ]]; then
    echo "TESTNET_CANARY_SECRET is not set; cannot execute live canary cycle" >&2
    return 1
  fi

  # Import secret non-interactively into a throwaway config dir (never printed).
  STELLAR_SECRET_KEY="${TESTNET_CANARY_SECRET}" stellar keys add oracledesk-canary \
    --config-dir "${tmp_cfg}" --secret-key >/dev/null
  local canary_pub
  canary_pub="$(stellar keys address oracledesk-canary --config-dir "${tmp_cfg}")"

  local bal_before bal_after
  bal_before="$(stellar contract invoke --id "${USDC}" --network "${NETWORK}" --send=no -- balance --id "${canary_pub}" | tr -d '"')"

  local dispute_window=5
  local res_hash
  res_hash="$(cargo run --quiet --manifest-path scripts/spec-hash/Cargo.toml -- signers 1 "${dispute_window}" "${canary_pub}")"
  local q_hash
  q_hash="$(printf 'canary-%s' "${GITHUB_RUN_ID:-local}" | sha256sum | awk '{print $1}')"

  local now_ts close_time
  now_ts="$(date -u +%s)"
  close_time=$((now_ts + 60))

  local market_id
  market_id="$(stellar contract invoke --config-dir "${tmp_cfg}" --id "${MARKET_CORE}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    create_market \
    --creator "${canary_pub}" \
    --question_hash "${q_hash}" \
    --resolution_hash "${res_hash}" \
    --meta_uri "canary://${GITHUB_RUN_ID:-local}" \
    --category '"Other"' \
    --close_time "${close_time}" \
    --seed_amount 1000000000 \
    --initial_yes_bps 5000 | tr -d '"')"

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${RESOLVER}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    register_signer_spec \
    --market_id "${market_id}" \
    --signers "[\"${canary_pub}\"]" \
    --threshold 1 \
    --dispute_window "${dispute_window}" >/dev/null

  local quote min_shares
  quote="$(stellar contract invoke --id "${MARKET_CORE}" --network "${NETWORK}" --send=no -- \
    quote_buy --market_id "${market_id}" --outcome '"Yes"' --collateral_in 10000000 | tr -d '"')"
  min_shares=$(( (quote * 99) / 100 ))

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${MARKET_CORE}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    buy --trader "${canary_pub}" --market_id "${market_id}" --outcome '"Yes"' \
    --collateral_in 10000000 --min_shares_out "${min_shares}" >/dev/null

  # Poll ledger close time until market closes.
  while (( $(date -u +%s) <= close_time + 5 )); do
    sleep 5
  done

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${RESOLVER}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    attest --signer "${canary_pub}" --market_id "${market_id}" --outcome '"Yes"' >/dev/null

  sleep $((dispute_window + 6))

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${RESOLVER}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    finalize_signers --market_id "${market_id}" >/dev/null

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${MARKET_CORE}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    redeem --holder "${canary_pub}" --market_id "${market_id}" >/dev/null

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${MARKET_CORE}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    claim_pool_remainder --market_id "${market_id}" >/dev/null

  stellar contract invoke --config-dir "${tmp_cfg}" --id "${MARKET_CORE}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    sweep_fees --market_id "${market_id}" >/dev/null

  local trace_hash trace_id verified
  trace_hash="$(printf '{"canary":"%s","market":"%s"}' "${GITHUB_RUN_ID:-local}" "${market_id}" | sha256sum | awk '{print $1}')"
  trace_id="$(stellar contract invoke --config-dir "${tmp_cfg}" --id "${REGISTRY}" \
    --source-account oracledesk-canary --network "${NETWORK}" -- \
    publish_trace --agent "${canary_pub}" --market_id "${market_id}" \
    --action '"BuyYes"' --trace_hash "${trace_hash}" --cid '"ipfs://canary-trace"' | tr -d '"')"
  verified="$(stellar contract invoke --id "${REGISTRY}" --network "${NETWORK}" --send=no -- \
    verify_trace --trace_id "${trace_id}" --expected_hash "${trace_hash}")"
  [[ "${verified}" == "true" ]] || { echo "verify_trace returned ${verified}" >&2; return 1; }

  bal_after="$(stellar contract invoke --id "${USDC}" --network "${NETWORK}" --send=no -- balance --id "${canary_pub}" | tr -d '"')"
  BEFORE="${bal_before}" AFTER="${bal_after}" MAX_LOSS="${MAX_CYCLE_LOSS_STROOPS}" node --input-type=module -e '
    import { assertBalanceDeltaWithinBound } from "./scripts/canary/classify.mjs";
    assertBalanceDeltaWithinBound(process.env.BEFORE, process.env.AFTER, process.env.MAX_LOSS);
  '
}

if [[ "${PHASE}" == "cycle" || "${PHASE}" == "all" ]]; then
  if ! cycle_err_msg="$(run_cycle 2>&1)"; then
    cycle_error="$(jq -Rn --arg s "${cycle_err_msg}" '$s')"
  fi
fi

obs="$(jq -n \
  --argjson latestLedger "${latest_ledger}" \
  --argjson previousLatestLedger "${prev_ledger}" \
  --argjson contractsPresent "${contracts_json}" \
  --argjson deployerPresent "${deployer_ok}" \
  --argjson wiringErrors "${wiring_errors}" \
  --argjson cycleError "${cycle_error}" \
  '{latestLedger: $latestLedger, previousLatestLedger: $previousLatestLedger, contractsPresent: $contractsPresent, deployerPresent: $deployerPresent, wiringErrors: $wiringErrors, cycleError: $cycleError}')"
emit_verdict "${obs}"
