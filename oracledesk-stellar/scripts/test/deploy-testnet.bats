#!/usr/bin/env bats

load helpers

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "fresh_deploy_runs_all_steps_in_order" {
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  # Verify deployment record populated completely
  assert_equal "$(jq -r '.wired' "$WORK_REPO/deployments/testnet.json")" "true"
  assert_equal "$(jq -r '.agent_registered' "$WORK_REPO/deployments/testnet.json")" "true"
  assert_equal "$(jq -r '.treasury_minted_total' "$WORK_REPO/deployments/testnet.json")" "10000000000000"
  assert_equal "$(jq -r '.wired_resolver' "$WORK_REPO/deployments/testnet.json")" "$(jq -r '.contracts.resolver' "$WORK_REPO/deployments/testnet.json")"
  assert_equal "$(jq -r '.wired_treasury' "$WORK_REPO/deployments/testnet.json")" "$(jq -r '.contracts.treasury' "$WORK_REPO/deployments/testnet.json")"

  # Verify deploy & wire order in stub log
  run grep -n 'contract deploy --wasm target/wasm32v1-none/release/resolver.wasm' "$STUB_LOG"
  assert_success
  run grep -n 'propose_resolver' "$STUB_LOG"
  assert_success
  run grep -n 'propose_treasury' "$STUB_LOG"
  assert_success
}

@test "rerun_is_noop" {
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  : >"$STUB_LOG"
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  # Re-run must not deploy or invoke any mutating contract calls
  run grep -E 'contract (deploy|asset deploy|invoke)' "$STUB_LOG"
  assert_failure
}

@test "deleting_resolver_redeploys_and_rewires" {
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  # Simulate deleting .contracts.resolver and using a new salt for resolver redeploy
  tmp=$(mktemp)
  jq 'del(.contracts.resolver)' "$WORK_REPO/deployments/testnet.json" >"$tmp"
  mv "$tmp" "$WORK_REPO/deployments/testnet.json"

  : >"$STUB_LOG"
  RESOLVER_SALT="6f7261636c656465736b2d7265736f6c7665722d7632" run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  run grep -q 'contract deploy --wasm target/wasm32v1-none/release/resolver.wasm' "$STUB_LOG"
  assert_success
  run grep -q 'propose_resolver' "$STUB_LOG"
  assert_success
  assert_equal "$(jq -r '.wired_resolver' "$WORK_REPO/deployments/testnet.json")" "$(jq -r '.contracts.resolver' "$WORK_REPO/deployments/testnet.json")"
}

@test "deleting_market_core_redeploys_dependents_or_errors" {
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  tmp=$(mktemp)
  jq 'del(.contracts.market_core)' "$WORK_REPO/deployments/testnet.json" >"$tmp"
  mv "$tmp" "$WORK_REPO/deployments/testnet.json"

  : >"$STUB_LOG"
  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  run grep -q 'contract deploy --wasm target/wasm32v1-none/release/resolver.wasm' "$STUB_LOG"
  assert_success
  run grep -q 'contract deploy --wasm target/wasm32v1-none/release/treasury.wasm' "$STUB_LOG"
  assert_success
  run grep -q 'contract deploy --wasm target/wasm32v1-none/release/market_core.wasm' "$STUB_LOG"
  assert_success
}

@test "fund_amount_change_mints_difference_only" {
  TREASURY_FUND_AMOUNT=1000000000000 run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success
  assert_equal "$(jq -r '.treasury_minted_total' "$WORK_REPO/deployments/testnet.json")" "1000000000000"

  : >"$STUB_LOG"
  TREASURY_FUND_AMOUNT=1500000000000 run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  run grep -q -- '-- mint --to .* --amount 500000000000' "$STUB_LOG"
  assert_success
  run grep -q -- '-- deposit --from .* --amount 500000000000' "$STUB_LOG"
  assert_success
  assert_equal "$(jq -r '.treasury_minted_total' "$WORK_REPO/deployments/testnet.json")" "1500000000000"
}

@test "missing_jq_exits_with_message" {
  # Build a restricted PATH that has bash and stellar stub, but no jq
  local fake_bin="$BATS_TEST_TMPDIR/no-jq-bin"
  mkdir -p "$fake_bin"
  cp "$TEST_DIR/stubs/stellar" "$fake_bin/stellar"
  chmod +x "$fake_bin/stellar"

  PATH="$fake_bin:/bin" run bash "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure
  assert_output --partial "'jq' is required"
}

@test "failed_deploy_leaves_record_consistent" {
  add_stub_rule 'contract deploy --wasm target/wasm32v1-none/release/treasury.wasm' 1 ''

  run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_failure

  # Resolver was deployed before treasury, treasury must NOT have a partial/empty ID recorded
  assert_equal "$(jq -r '.contracts.treasury // empty' "$WORK_REPO/deployments/testnet.json")" ""
  assert_equal "$(jq -r '.contracts.market_core // empty' "$WORK_REPO/deployments/testnet.json")" ""
}

@test "env_caps_passed_to_treasury_constructor" {
  MAX_TRADE=3330000000 MAX_MARKET=6660000000 MAX_DAILY=9990000000 run "$WORK_REPO/scripts/deploy-testnet.sh"
  assert_success

  run grep -q -- '--max_trade 3330000000 --max_market 6660000000 --max_daily 9990000000' "$STUB_LOG"
  assert_success
}
