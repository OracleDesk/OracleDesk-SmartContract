#!/usr/bin/env bash
# Regenerates TypeScript client bindings for all four contracts from their
# built wasm into packages/bindings/<contract-name>/. Run after any contract
# interface change (new/changed function signatures, types, or events) and
# commit the result — this is what agents/stellar and any frontend import.
#
# CI runs this and diffs the output against what's committed (see
# .github/workflows/ci.yml) so a forgotten regeneration fails the build
# instead of silently drifting from the deployed contracts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WASM_DIR=target/wasm32v1-none/release
OUT_DIR=packages/bindings

for f in market_core resolver reasoning_registry treasury; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    echo "==> $WASM_DIR/$f.wasm missing — building all contracts first" >&2
    stellar contract build
    break
  fi
done

declare -A NAMES=(
  [market_core]="market-core"
  [resolver]="resolver"
  [reasoning_registry]="reasoning-registry"
  [treasury]="treasury"
)

mkdir -p "$OUT_DIR"
for wasm_name in "${!NAMES[@]}"; do
  pkg_name=${NAMES[$wasm_name]}
  echo "==> generating bindings for $pkg_name" >&2
  stellar contract bindings typescript \
    --wasm "$WASM_DIR/$wasm_name.wasm" \
    --output-dir "$OUT_DIR/$pkg_name" \
    --overwrite
  # The CLI names the package after the wasm (e.g. "treasury"); give it a
  # stable scoped name so agents/ and any frontend can depend on it
  # unambiguously (`file:../packages/bindings/<name>` in package.json).
  tmp=$(mktemp)
  jq --arg name "@oracledesk/bindings-$pkg_name" '.name = $name' \
    "$OUT_DIR/$pkg_name/package.json" >"$tmp"
  mv "$tmp" "$OUT_DIR/$pkg_name/package.json"
done

echo "==> done. See $OUT_DIR/*/README.md for per-package usage." >&2
