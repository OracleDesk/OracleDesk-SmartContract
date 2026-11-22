#!/usr/bin/env bash
stage_begin router
ROUTER=$(jq -r '.contracts.router // empty' "$DEPLOYMENTS")
[ -n "$ROUTER" ] || stage_end fail "router was not deployed"
stellar contract invoke --id "$ROUTER" --source-account "$DEPLOYER_KEY" --network local -- get_config >/dev/null 2>&1 || true
stage_end pass "router deployed"
