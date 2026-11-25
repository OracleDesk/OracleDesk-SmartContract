# Shared bats test helpers for OracleDesk shell scripts (Issues #132, #134).

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"

load "$TEST_DIR/test_helper/bats-support/load"
load "$TEST_DIR/test_helper/bats-assert/load"

setup_temp_repo() {
  WORK_REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p \
    "$WORK_REPO/scripts" \
    "$WORK_REPO/deployments" \
    "$WORK_REPO/target/wasm32v1-none/release" \
    "$WORK_REPO/contracts/resolver" \
    "$WORK_REPO/contracts/treasury" \
    "$WORK_REPO/contracts/reasoning-registry" \
    "$WORK_REPO/contracts/router" \
    "$WORK_REPO/packages/bindings" \
    "$WORK_REPO/docs/wave-issues"

  cp "$REPO_ROOT"/scripts/*.sh "$WORK_REPO/scripts/"
  cp "$REPO_ROOT/scripts/toolchain.env" "$WORK_REPO/scripts/"
  # scripts/toolchain.env is a shim that sources the repo-root copy (#135).
  cp "$REPO_ROOT/toolchain.env" "$WORK_REPO/toolchain.env"
  chmod +x "$WORK_REPO"/scripts/*.sh

  for w in market_core resolver reasoning_registry treasury timelock router test_oracle; do
    printf 'fake-wasm-%s\n' "$w" >"$WORK_REPO/target/wasm32v1-none/release/${w}.wasm"
  done

  export STUB_LOG="$BATS_TEST_TMPDIR/stub.log"
  export STUB_SCENARIO="$BATS_TEST_TMPDIR/scenario.tsv"
  export STUB_CURL_SCENARIO="$BATS_TEST_TMPDIR/curl-scenario.tsv"
  export STUB_STATE_DIR="$BATS_TEST_TMPDIR/state"
  export STUB_FIXTURES="$TEST_DIR/fixtures/cli-outputs.tsv"
  mkdir -p "$STUB_STATE_DIR"
  : >"$STUB_LOG"
  : >"$STUB_SCENARIO"
  : >"$STUB_CURL_SCENARIO"

  export ORIG_PATH="$PATH"
  export PATH="$TEST_DIR/stubs:$PATH"
}

teardown_temp_repo() {
  if [ -n "${ORIG_PATH:-}" ]; then
    export PATH="$ORIG_PATH"
  fi
}

add_stub_rule() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STUB_SCENARIO"
}

add_curl_rule() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$STUB_CURL_SCENARIO"
}

seed_stub_deployment() {
  cat >"$WORK_REPO/deployments/testnet.json" <<'JSON'
{
  "deployer": "GDEPLOYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "agent": "GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "contracts": {
    "usdc": "CUSDCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "market_core": "CMARKETCOREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "resolver": "CRESOLVERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "treasury": "CTREASURYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "reasoning_registry": "CREGISTRYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "test_oracle": "CTESTORACLEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }
}
JSON
}
