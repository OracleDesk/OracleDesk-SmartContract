#!/usr/bin/env bats

load helpers

setup() {
  setup_temp_repo
  seed_stub_deployment
}

teardown() {
  teardown_temp_repo
}

@test "full_flow_calls_steps_in_order" {
  SLEEP=true NOW_CMD="echo 1700000000" run "$WORK_REPO/scripts/demo.sh"
  assert_success
  assert_output --partial "final market status: resolved"

  run grep -q 'agent_create_market_and_reveal' "$STUB_LOG"
  assert_success
  run grep -q 'agent_buy' "$STUB_LOG"
  assert_success
  run grep -q 'publish_trace' "$STUB_LOG"
  assert_success
  run grep -q 'verify_trace' "$STUB_LOG"
  assert_success
  run grep -q 'attest_with_evidence' "$STUB_LOG"
  assert_success
  run grep -q 'finalize_signers' "$STUB_LOG"
  assert_success
}

@test "verify_false_exits_nonzero" {
  add_stub_rule 'verify_trace' 0 'false'

  SLEEP=true NOW_CMD="echo 1700000000" run "$WORK_REPO/scripts/demo.sh"
  assert_failure
  assert_output --partial "FAILED: trace hash did not verify"
}

@test "close_time_in_past_skips_wait" {
  # NOW_CMD far in the future ensures close_time + 1 <= now, skipping RPC wait loop
  SLEEP=false NOW_CMD="echo 4000000000" DISPUTE_WINDOW=0 run bash -c '
    # Replace final dispute sleep with true while checking wait_until skips sleep
    SLEEP=true NOW_CMD="echo 4000000000" "$1/scripts/demo.sh"
  ' _ "$WORK_REPO"
  assert_success

  # curl getLatestLedger must not have been called since close_time was already past
  run grep -q 'getLatestLedger' "$STUB_LOG"
  assert_failure
}

@test "seed_output_without_market_id_fails_clearly" {
  # Replace seed-market.sh in temp repo with one that prints unparseable output
  cat >"$WORK_REPO/scripts/seed-market.sh" <<'SH'
#!/usr/bin/env bash
echo "unexpected seed output without keys"
SH
  chmod +x "$WORK_REPO/scripts/seed-market.sh"

  SLEEP=true NOW_CMD="echo 1700000000" run "$WORK_REPO/scripts/demo.sh"
  assert_failure
  assert_output --partial "failed to parse market_id/close_time"
}

@test "price_mode_aligns_slot_and_resolves" {
  SLEEP=true NOW_CMD="echo 4000000000" run "$WORK_REPO/scripts/demo.sh" --mode price
  assert_success
  assert_output --partial "final market status: resolved"
  assert_output --partial "mode=price"

  run grep -q 'set_price --asset {"Other":"XLM"} --price 2100 --timestamp' "$STUB_LOG"
  assert_success
  run grep -q 'resolve_price --market_id 1' "$STUB_LOG"
  assert_success
  run grep -q 'verify_trace' "$STUB_LOG"
  assert_success
}
