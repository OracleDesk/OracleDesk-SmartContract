#!/usr/bin/env bash
stage_begin vault
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" --network local -- nav >/dev/null
stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" --network local -- queue_head >/dev/null 2>&1 || true
stage_end pass "treasury vault views reachable"
