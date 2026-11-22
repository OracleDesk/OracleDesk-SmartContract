#!/bin/bash
# Quarantine markets: void a list of market IDs
# Usage: ./scripts/emergency/quarantine-markets.sh <market_id> [market_id ...] [--dry-run] [--yes]

set -euo pipefail
source "$(dirname "$0")/lib.sh"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <market_id> [market_id ...] [--dry-run] [--yes]" >&2
    exit 1
fi

MARKET_IDS=()
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
            MARKET_IDS+=("$1")
            shift
            ;;
    esac
done

verify_deployments

echo "Quarantining ${#MARKET_IDS[@]} markets..."
confirm "Void all specified markets? This is permanent."

echo ""
echo "Markets to quarantine: ${MARKET_IDS[*]}"
echo ""

local_market_ids="${MARKET_IDS[@]}"
for market_id in $local_market_ids; do
    echo "Voiding market $market_id..."
    invoke "resolver" "guardian_void_market" "$market_id" || {
        echo "  Warning: Market $market_id void failed or already finalized (skipping)"
    }
done

log_incident "quarantine_markets" "{\"count\": ${#MARKET_IDS[@]}, \"markets\": \"${MARKET_IDS[*]}\", \"status\": \"quarantined\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

echo ""
echo "✓ Markets quarantined"
echo "  - Voided: ${#MARKET_IDS[@]} markets"
