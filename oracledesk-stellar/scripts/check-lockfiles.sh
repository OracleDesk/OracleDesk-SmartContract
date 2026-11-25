#!/usr/bin/env bash
# Verify that every Cargo workspace in oracledesk-stellar has a committed
# Cargo.lock that is in sync with its Cargo.toml dependency graph.
#
# Run with no arguments from the repo root or from oracledesk-stellar.
# Exits non-zero on the first workspace whose lockfile is out of date.
#
# --locked tells Cargo to fail if Cargo.lock would need updating rather
# than silently refreshing it, which is what we want in CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STELLAR_DIR="${ORACLEDESK_STELLAR_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

WORKSPACES=(
  "."
  "contracts/budget-tests"
  "fuzz"
  "scripts/interface-manifest"
  "scripts/spec-hash"
  "scripts/fpmm-diff/oracle"
)

errors=0

for ws in "${WORKSPACES[@]}"; do
  abs="${STELLAR_DIR}/${ws}"
  if [[ ! -f "${abs}/Cargo.toml" ]]; then
    echo "SKIP: no Cargo.toml in ${abs}" >&2
    continue
  fi
  if [[ ! -f "${abs}/Cargo.lock" ]]; then
    echo "MISSING: Cargo.lock not committed for workspace ${ws}" >&2
    errors=$((errors + 1))
    continue
  fi
  if ! cargo metadata --locked --manifest-path "${abs}/Cargo.toml" --no-deps --format-version 1 >/dev/null 2>&1; then
    echo "STALE: Cargo.lock is out of date for workspace ${ws}" >&2
    echo "  Run: cargo update --manifest-path ${abs}/Cargo.toml" >&2
    errors=$((errors + 1))
  else
    echo "OK: ${ws}"
  fi
done

if ((errors > 0)); then
  echo "check-lockfiles: ${errors} workspace(s) failed." >&2
  exit 1
fi

echo "All Cargo.lock files are present and up to date."
