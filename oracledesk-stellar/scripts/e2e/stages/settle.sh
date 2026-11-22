#!/usr/bin/env bash
stage_begin settle
CORE=$(jq -r .contracts.market_core "$DEPLOYMENTS")
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
stellar contract invoke --id "$CORE" --source-account "$DEPLOYER_KEY" --network local -- market_count >/dev/null
stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" --network local -- nav >/dev/null
stage_end pass "settlement views reachable"
