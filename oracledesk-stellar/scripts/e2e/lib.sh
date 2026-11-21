#!/usr/bin/env bash

REPORT=${REPORT:-deployments/e2e-report.json}
STAGE_START_LEDGER=0

stage_begin() {
  STAGE_NAME=$1
  STAGE_START_LEDGER=$(stellar get latest-ledger --network local 2>/dev/null | jq -r '.sequence // 0')
  echo "==> stage: $STAGE_NAME" >&2
}

stage_end() {
  local status=$1 detail=${2:-""}
  mkdir -p "$(dirname "$REPORT")"
  local tmp="${REPORT}.tmp"
  local current='{}'
  [ -f "$REPORT" ] && current=$(cat "$REPORT")
  jq --arg name "$STAGE_NAME" --arg status "$status" --arg detail "$detail" \
    '.stages[$name] = {status: $status, detail: $detail}' <<<"$current" >"$tmp"
  mv "$tmp" "$REPORT"
  [ "$status" = "pass" ] && pass "stage $STAGE_NAME" || fail "stage $STAGE_NAME: $detail"
}

stage_failure_artifacts() {
  local name=$1
  mkdir -p "deployments/e2e-artifacts/$name"
  stellar events --start-ledger "$STAGE_START_LEDGER" --network local --output json \
    >"deployments/e2e-artifacts/$name/events.json" 2>&1 || true
  docker logs "${CONTAINER:-oracledesk-e2e}" \
    >"deployments/e2e-artifacts/$name/quickstart.log" 2>&1 || true
  cp "$DEPLOYMENTS" "deployments/e2e-artifacts/$name/deployment.json" 2>/dev/null || true
}
