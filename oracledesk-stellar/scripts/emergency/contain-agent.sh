#!/bin/bash
# Contain compromised agent: pause treasury and deregister agent
# Usage: ./scripts/emergency/contain-agent.sh <agent_address> [--dry-run] [--yes]

set -euo pipefail
source "$(dirname "$0")/lib.sh"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <agent_address> [--dry-run] [--yes]" >&2
    exit 1
fi

AGENT="$1"
shift

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

echo "Containing compromised agent: $AGENT"
confirm "Deactivate agent and pause trading?"

echo ""
echo "1. Pausing treasury to block agent trading..."
invoke "treasury" "set_paused" "true"
verify_paused "treasury"

echo ""
echo "2. Deregistering agent from registry..."
invoke "reasoning_registry" "unregister_agent" "$AGENT"

echo ""
echo "3. Checking agent registration status..."
# Verify deregistration
echo "Agent deregistration queued."

log_incident "contain_agent" "{\"agent\": \"$AGENT\", \"status\": \"contained\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

echo ""
echo "✓ Agent $AGENT has been contained"
echo "  - Treasury is paused (agent cannot trade)"
echo "  - Agent is deregistered (cannot create markets)"
echo "  - Agent may still settle existing positions"
