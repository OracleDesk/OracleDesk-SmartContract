#!/bin/bash
# Emergency response library for OracleDesk
# Shared utilities for emergency scripts

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
DEPLOYMENT_FILE="deployments/${NETWORK}.json"
DRY_RUN="${DRY_RUN:-false}"

# Verify deployment file exists and has all required keys
verify_deployments() {
    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        echo "ERROR: Deployment file not found: $DEPLOYMENT_FILE" >&2
        exit 1
    fi

    local required_keys=("market_core" "resolver" "treasury" "reasoning_registry" "collateral_token")
    for key in "${required_keys[@]}"; do
        if ! jq -e ".${key}" "$DEPLOYMENT_FILE" > /dev/null 2>&1; then
            echo "ERROR: Missing '$key' in $DEPLOYMENT_FILE" >&2
            exit 1
        fi
    done
}

# Load contract address from deployment file
get_contract_id() {
    local contract_name="$1"
    jq -r ".${contract_name}" "$DEPLOYMENT_FILE"
}

# Execute a stellar contract invocation
invoke() {
    local contract="$1"
    shift
    local contract_id=$(get_contract_id "$contract")

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[DRY RUN] stellar contract invoke --id $contract_id --" "$@"
        return 0
    fi

    stellar contract invoke --id "$contract_id" -- "$@"
}

# Execute a read-only contract call
read_only() {
    local contract="$1"
    shift
    local contract_id=$(get_contract_id "$contract")

    stellar contract invoke --id "$contract_id" -- "$@"
}

# Confirm action with user
confirm() {
    local prompt="$1"

    if [[ "$DRY_RUN" == "true" ]] || [[ "${SKIP_CONFIRM:-false}" == "true" ]]; then
        echo "$prompt"
        return 0
    fi

    echo ""
    echo "================================"
    echo "ACTION: $prompt"
    echo "Network: $NETWORK"
    echo "================================"
    echo "Type '$NETWORK' to confirm or Ctrl+C to cancel:"
    read -r confirmation

    if [[ "$confirmation" != "$NETWORK" ]]; then
        echo "Cancelled."
        exit 1
    fi
}

# Log incident to append-only file
log_incident() {
    local action="$1"
    local details="$2"

    local log_file="incidents/${NETWORK}_$(date +%Y%m%d_%H%M%S).jsonl"
    mkdir -p incidents
    echo "{\"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"action\": \"$action\", \"details\": $details}" >> "$log_file"
}

# Verify contract is paused
verify_paused() {
    local contract="$1"
    echo "Verifying $contract is paused..."
    local is_paused=$(read_only "$contract" get_config | jq -r '.paused // false')

    if [[ "$is_paused" != "true" ]]; then
        echo "ERROR: $contract is not paused" >&2
        return 1
    fi
    echo "✓ $contract is paused"
}

export NETWORK
export DEPLOYMENT_FILE
export DRY_RUN
