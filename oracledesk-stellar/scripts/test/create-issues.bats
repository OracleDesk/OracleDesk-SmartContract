#!/usr/bin/env bats

load helpers

setup() {
  setup_temp_repo
}

teardown() {
  teardown_temp_repo
}

@test "extracts_title_and_label" {
  cat >"$WORK_REPO/docs/wave-issues/01-sample.md" <<'MD'
# Sample Wave Issue

`complexity/medium`

Details here.
MD

  run "$WORK_REPO/scripts/create-issues.sh"
  assert_success

  run grep -q -- 'gh issue create --title Sample Wave Issue --body-file docs/wave-issues/01-sample.md --label complexity/medium' "$STUB_LOG"
  assert_success
}

@test "missing_complexity_line_skips_label_flag_and_warns" {
  cat >"$WORK_REPO/docs/wave-issues/02-nolabel.md" <<'MD'
# Issue Without Complexity

Just a description.
MD

  run "$WORK_REPO/scripts/create-issues.sh"
  assert_success
  assert_output --partial "warning: no complexity label found"

  run grep -q -- '--label' "$STUB_LOG"
  assert_failure
  run grep -q -- 'gh issue create --title Issue Without Complexity --body-file docs/wave-issues/02-nolabel.md' "$STUB_LOG"
  assert_success
}

@test "label_line_with_trailing_space_is_parsed" {
  printf '# Trailing Space Issue\n\n`complexity/high`   \n' >"$WORK_REPO/docs/wave-issues/03-trailing.md"

  run "$WORK_REPO/scripts/create-issues.sh"
  assert_success

  run grep -q -- '--label complexity/high' "$STUB_LOG"
  assert_success
}

@test "dry_run_does_not_invoke_gh" {
  cat >"$WORK_REPO/docs/wave-issues/04-dry.md" <<'MD'
# Dry Run Issue

`complexity/low`
MD

  run "$WORK_REPO/scripts/create-issues.sh" --dry-run
  assert_success
  assert_output --partial "dry-run:"

  assert_equal "$(wc -l <"$STUB_LOG" | tr -d ' ')" "0"
}
