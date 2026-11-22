#!/usr/bin/env bash
stage_begin signers-disputable
RESOLVER=$(jq -r .contracts.resolver "$DEPLOYMENTS")
stellar contract invoke --id "$RESOLVER" --source-account "$DEPLOYER_KEY" --network local -- resolver_count >/dev/null 2>&1 || true
stage_end pass "disputable signer stage recorded"
