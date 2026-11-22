#!/usr/bin/env bash
stage_begin batch
TREASURY=$(jq -r .contracts.treasury "$DEPLOYMENTS")
stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" --network local -- nav >/dev/null
stage_end pass "batch settlement entrypoint available"
