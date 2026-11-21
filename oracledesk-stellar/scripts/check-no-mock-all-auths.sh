#!/usr/bin/env bash
# The auth matrix and the system model must prove authorization with *targeted*
# mocks: a blanket `mock_all_auths()` would make every positive test pass for
# the wrong reason. The bounded-exhaustive treasury-cap search is deliberately
# out of scope — it explores invariants over state, not authorization, and its
# header documents that choice. This guard fails CI if a blanket mock appears
# anywhere in the scoped set.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Scoped on purpose. `tests/treasury_caps_exhaustive/` is allow-listed: its
# sim.rs/search.rs use mock_all_auths because auth is out of scope there.
paths=(
  contracts/integration-tests/src
  contracts/integration-tests/tests/auth_matrix
  contracts/integration-tests/tests/auth_matrix.rs
  contracts/integration-tests/tests/system_model.rs
)

matches=$(grep -RIn --include='*.rs' -E '\.?mock_all_auths[[:space:]]*\(' "${paths[@]}" 2>/dev/null || true)
if [ -n "$matches" ]; then
  echo "error: scoped auth tests must not use mock_all_auths:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "ok: auth matrix and system model use targeted mocks only (no mock_all_auths)"
