#!/usr/bin/env bats

load helpers

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "renames_each_package" {
  run "$WORK_REPO/scripts/gen-bindings.sh"
  assert_success

  for pkg in market-core resolver reasoning-registry treasury timelock router test-oracle; do
    assert_equal "$(jq -r '.name' "$WORK_REPO/packages/bindings/$pkg/package.json")" "@oracledesk/bindings-$pkg"
    assert [ -f "$WORK_REPO/packages/bindings/$pkg/interface.json" ]
  done
}

@test "builds_when_wasm_missing" {
  rm -f "$WORK_REPO/target/wasm32v1-none/release/market_core.wasm"

  run "$WORK_REPO/scripts/gen-bindings.sh"
  assert_success

  run grep -q 'stellar contract build' "$STUB_LOG"
  assert_success
}

@test "works_under_bash3_compatible_mode" {
  # Ensure script has no bash 4+ associative arrays (`declare -A`) and runs cleanly in --posix mode
  run grep -q 'declare -A' "$WORK_REPO/scripts/gen-bindings.sh"
  assert_failure

  run bash --posix "$WORK_REPO/scripts/gen-bindings.sh"
  assert_success
}
