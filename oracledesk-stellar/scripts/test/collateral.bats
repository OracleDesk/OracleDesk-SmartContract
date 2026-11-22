#!/usr/bin/env bats

load helpers

CIRCLE_ASSET="USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "self_issued_mode_unchanged" {
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  assert_equal "$(jq -r '.collateral.mode' "$WORK_REPO/deployments/testnet.json")" "self-issued"
  assert_equal "$(jq -r '.collateral.decimals' "$WORK_REPO/deployments/testnet.json")" "7"
  run grep -q -- '-- mint --to' "$STUB_LOG"
  assert_success
}

@test "existing_mode_rejects_bad_asset_format" {
  COLLATERAL_MODE=existing COLLATERAL_ASSET="NOT_A_VALID_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure
  assert_output --partial "malformed COLLATERAL_ASSET"
}

@test "existing_mode_aborts_on_non_7_decimals" {
  add_stub_rule '-- decimals' 0 '6'
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure
  assert_output --partial "MIN_SEED"
  assert_output --partial "7 decimals"
}

@test "existing_mode_aborts_on_auth_required_issuer" {
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":true,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure
  assert_output --partial "auth_required=true"
}

@test "warns_on_clawback_enabled" {
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":true,"auth_clawback_enabled":true},"balances":[]}'
  add_stub_rule '-- balance --id' 0 '10000000000'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success
  assert_output --partial "WARNING:"
  assert_output --partial "auth_clawback_enabled=true"
  assert_equal "$(jq -r '.collateral.issuer_flags.auth_clawback_enabled' "$WORK_REPO/deployments/testnet.json")" "true"
}

@test "creates_missing_trustlines_once" {
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'
  add_curl_rule 'accounts/G' 0 '{"balances":[]}'
  add_stub_rule '-- balance --id' 0 '10000000000'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  # Deployer and agent G-accounts both received change-trust; no C-address ever did.
  assert_equal "$(grep -c 'tx new change-trust' "$STUB_LOG")" "2"
  run grep -q 'change-trust .* C[A-Z2-7]' "$STUB_LOG"
  assert_failure

  # Second run where Horizon reports existing trustlines skips change-trust.
  : >"$STUB_LOG"
  : >"$STUB_CURL_SCENARIO"
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'
  add_curl_rule 'accounts/G' 0 '{"balances":[{"asset_code":"USDC","asset_issuer":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","balance":"1000.0"}]}'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success
  run grep -q 'tx new change-trust' "$STUB_LOG"
  assert_failure
}

@test "insufficient_balance_exits_3_with_instructions" {
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'
  add_curl_rule 'accounts/G' 0 '{"balances":[{"asset_code":"USDC","asset_issuer":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","balance":"1.0"}]}'
  add_stub_rule '-- balance --id' 0 '10000000'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_equal "$status" 3
  assert_output --partial "https://faucet.circle.com/"
  assert_output --partial "action required"
}

@test "deposits_instead_of_minting" {
  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'
  add_curl_rule 'accounts/G' 0 '{"balances":[{"asset_code":"USDC","asset_issuer":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","balance":"1000.0"}]}'
  add_stub_rule '-- balance --id' 0 '10000000000'

  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  run grep -q -- '-- deposit --from .* --amount 5000000000' "$STUB_LOG"
  assert_success
  run grep -q -- '-- mint --to' "$STUB_LOG"
  assert_failure
  assert_equal "$(jq -r '.treasury_deposited_total' "$WORK_REPO/deployments/testnet.json")" "5000000000"
}

@test "refuses_collateral_switch_without_force" {
  # Initial self-issued deploy
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  add_curl_rule 'accounts/GBBD47' 0 '{"flags":{"auth_required":false,"auth_revocable":false,"auth_clawback_enabled":false},"balances":[]}'
  add_curl_rule 'accounts/G' 0 '{"balances":[{"asset_code":"USDC","asset_issuer":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","balance":"1000.0"}]}'
  add_stub_rule '-- balance --id' 0 '10000000000'

  # Switching to existing Circle USDC without FORCE_REDEPLOY=1 must fail
  COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure
  assert_output --partial "FORCE_REDEPLOY=1"

  # With FORCE_REDEPLOY=1 it succeeds and updates collateral record
  FORCE_REDEPLOY=1 COLLATERAL_MODE=existing COLLATERAL_ASSET="$CIRCLE_ASSET" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success
  assert_equal "$(jq -r '.collateral.mode' "$WORK_REPO/deployments/testnet.json")" "existing"
}
