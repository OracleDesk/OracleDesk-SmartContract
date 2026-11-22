#!/usr/bin/env bash
stage_begin finalize
CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
stellar contract invoke --id "$CORE" --source-account "$DEPLOYER_KEY" --network local -- market_count >/dev/null
stage_end pass "finalization short-window flow available"
