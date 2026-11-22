#!/usr/bin/env bash
stage_begin timelock
CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
ADMIN=$(stellar contract invoke --id "$CORE" --source-account "$DEPLOYER_KEY" --network local -- admin)
echo "$ADMIN" | jq -e 'length > 0' >/dev/null
stage_end pass "market-core admin view reachable"
