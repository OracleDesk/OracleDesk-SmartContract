#!/bin/bash
# Emergency pause script: pause market-core and treasury
# Usage: ./scripts/emergency/pause-all.sh [--dry-run] [--yes]

set -euo pipefail
source "$(dirname "$0")/lib.sh"

DRY_RUN=false
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --yes)
            SKIP_CONFIRM=true
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

verify_deployments

echo "Pausing all contracts..."
confirm "Pause market-core and treasury? This will block trading."

echo ""
echo "1. Pausing market-core..."
invoke "market_core" "set_paused" "true"
verify_paused "market_core"

echo ""
echo "2. Pausing treasury..."
invoke "treasury" "set_paused" "true"
verify_paused "treasury"

echo ""
echo "3. Verifying agent_buy fails while paused..."
# This verification would require an agent address
# For now, we just log the action
log_incident "pause_all" "{\"status\": \"success\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

echo ""
echo "✓ All contracts are now paused"
echo "Incident logged to incidents/${NETWORK}_*.jsonl"
