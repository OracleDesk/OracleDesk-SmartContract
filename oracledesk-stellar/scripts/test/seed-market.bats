#!/usr/bin/env bats

load helpers

setup() {
  setup_temp_repo
  seed_stub_deployment
}

teardown() {
  teardown_temp_repo
}

@test "defaults_produce_expected_invocations" {
  run "$WORK_REPO/scripts/seed-market.sh"
  assert_success

  run grep -q 'agent_create_market_and_reveal' "$STUB_LOG"
  assert_success
  run grep -q -- '--seed_amount 1500000000' "$STUB_LOG"
  assert_success
  run grep -q -- '--initial_yes_bps 5000' "$STUB_LOG"
  assert_success
}

@test "all_five_args_respected" {
  run "$WORK_REPO/scripts/seed-market.sh" 2500000000 6000 120 15 "Custom five arg question"
  assert_success
  assert_output --partial "dispute_window=15"

  run grep -q -- '--seed_amount 2500000000' "$STUB_LOG"
  assert_success
  run grep -q -- '--initial_yes_bps 6000' "$STUB_LOG"
  assert_success
  run grep -q 'Custom-five-arg-question' "$STUB_LOG"
  assert_success
}

@test "question_with_quotes_is_json_escaped" {
  run "$WORK_REPO/scripts/seed-market.sh" 1500000000 5000 90 5 'Will "BTC" hit \100k?'
  assert_success

  # Extract the --meta_uri value logged by stub stellar and verify valid JSON via jq
  meta_arg=$(grep 'agent_create_market_and_reveal' "$STUB_LOG" | sed -n 's/.*--meta_uri \([^ ]*\) --category.*/\1/p')
  assert [ -n "$meta_arg" ]
  decoded=$(printf '%s\n' "$meta_arg" | jq -r .)
  assert_equal "$decoded" 'ipfs://Will-"BTC"-hit-\100k?'
}

@test "missing_resolver_in_record_fails" {
  tmp=$(mktemp)
  jq 'del(.contracts.resolver)' "$WORK_REPO/deployments/testnet.json" >"$tmp"
  mv "$tmp" "$WORK_REPO/deployments/testnet.json"

  run "$WORK_REPO/scripts/seed-market.sh"
  assert_failure
  assert_output --partial "no resolver address"
}

@test "prints_parseable_output" {
  run "$WORK_REPO/scripts/seed-market.sh"
  assert_success

  assert_output --partial "market_id=1"
  assert_output --regexp "close_time=[0-9]+"
  assert_output --partial "dispute_window=5"
  assert_output --partial "mode=signer"
}
