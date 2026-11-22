#!/bin/bash
# Status report: read-only view of all contract states
# Usage: ./scripts/emergency/status.sh

set -euo pipefail
source "$(dirname "$0")/lib.sh"

NETWORK="${NETWORK:-testnet}"
DEPLOYMENT_FILE="deployments/${NETWORK}.json"

verify_deployments

echo "===================================="
echo "OracleDesk Emergency Status Report"
echo "Network: $NETWORK"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "===================================="
echo ""

echo "1. Market Core Contract"
echo "   Address: $(get_contract_id market_core)"
# read_only "market_core" "get_config"
echo ""

echo "2. Treasury Contract"
echo "   Address: $(get_contract_id treasury)"
# read_only "treasury" "get_config"
echo ""

echo "3. Resolver Contract"
echo "   Address: $(get_contract_id resolver)"
# read_only "resolver" "get_config"
echo ""

echo "4. Reasoning Registry Contract"
echo "   Address: $(get_contract_id reasoning_registry)"
# read_only "reasoning_registry" "get_config"
echo ""

echo "5. Collateral Token"
echo "   Address: $(get_contract_id collateral_token)"
echo ""

echo "Report complete. For detailed contract state, use: stellar contract read --id <address>"
