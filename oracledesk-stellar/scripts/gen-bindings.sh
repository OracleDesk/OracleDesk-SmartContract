#!/usr/bin/env bash
# Regenerates TypeScript client bindings for all six contracts from their
# built wasm into packages/bindings/<contract-name>/. Run after any contract
# interface change (new/changed function signatures, types, or events) and
# commit the result — this is what agents/stellar and any frontend import.
#
# CI runs this and diffs the output against what's committed (see
# .github/workflows/ci.yml) so a forgotten regeneration fails the build
# instead of silently drifting from the deployed contracts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Source toolchain versions for deterministic builds
source scripts/toolchain.env

# Verify stellar CLI version for deterministic bindings generation
INSTALLED_VERSION=$(stellar --version 2>/dev/null | awk '{print $2}' || echo "not found")
if [ "$INSTALLED_VERSION" != "$STELLAR_CLI_VERSION" ]; then
  if [ "${ALLOW_CLI_MISMATCH:-}" = "1" ]; then
    echo "WARNING: stellar CLI version mismatch (expected $STELLAR_CLI_VERSION, got $INSTALLED_VERSION)" >&2
    echo "         Bindings may differ from CI. Set ALLOW_CLI_MISMATCH=1 to suppress this warning." >&2
  else
    echo "ERROR: stellar CLI version mismatch" >&2
    echo "  Expected: $STELLAR_CLI_VERSION" >&2
    echo "  Installed: $INSTALLED_VERSION" >&2
    echo "" >&2
    echo "Install the correct version with:" >&2
    echo "  cargo install --locked stellar-cli --version $STELLAR_CLI_VERSION" >&2
    echo "" >&2
    echo "Or set ALLOW_CLI_MISMATCH=1 to proceed anyway (not recommended)." >&2
    exit 1
  fi
fi

WASM_DIR=target/wasm32v1-none/release
OUT_DIR=packages/bindings

for f in market_core resolver reasoning_registry treasury timelock router; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    echo "==> $WASM_DIR/$f.wasm missing — building all contracts first" >&2
    stellar contract build
    break
  fi
done

# Fixed iteration order for deterministic bindings generation
# Format: wasm_name:pkg_name
CONTRACTS=(
  "market_core:market-core"
  "resolver:resolver"
  "reasoning_registry:reasoning-registry"
  "treasury:treasury"
  "timelock:timelock"
  "router:router"
)

mkdir -p "$OUT_DIR"
for entry in "${CONTRACTS[@]}"; do
  wasm_name="${entry%%:*}"
  pkg_name="${entry##*:}"
  echo "==> generating bindings for $pkg_name" >&2
  # `--overwrite` deletes files it does not generate, including the committed
  # package-lock.json — which would make CI's "bindings are stale" diff fail on
  # every run. Stash the lockfile around the call so regeneration touches only
  # the generated files.
  old_version=$(jq -r .version "$OUT_DIR/$pkg_name/package.json" 2>/dev/null || echo 0.0.0)
  changelog=""
  if [ -f "$OUT_DIR/$pkg_name/CHANGELOG.md" ]; then
    changelog=$(mktemp)
    cp "$OUT_DIR/$pkg_name/CHANGELOG.md" "$changelog"
  fi
  lock=""
  if [ -f "$OUT_DIR/$pkg_name/package-lock.json" ]; then
    lock=$(mktemp)
    cp "$OUT_DIR/$pkg_name/package-lock.json" "$lock"
  fi
  stellar contract bindings typescript \
    --wasm "$WASM_DIR/$wasm_name.wasm" \
    --output-dir "$OUT_DIR/$pkg_name" \
    --overwrite
  if [ -n "$lock" ]; then
    cp "$lock" "$OUT_DIR/$pkg_name/package-lock.json"
    rm -f "$lock"
  fi
  if [ -n "$changelog" ]; then
    cp "$changelog" "$OUT_DIR/$pkg_name/CHANGELOG.md"
    rm -f "$changelog"
  fi
  # The CLI names the package after the wasm (e.g. "treasury"); give it a
  # stable scoped name so agents/ and any frontend can depend on it
  # unambiguously (`file:../packages/bindings/<name>` in package.json).
  tmp=$(mktemp)
  jq --arg name "@oracledesk/bindings-$pkg_name" --arg v "$old_version" '.name = $name | .version = $v' \
    "$OUT_DIR/$pkg_name/package.json" >"$tmp"
  mv "$tmp" "$OUT_DIR/$pkg_name/package.json"
  CARGO_TARGET_DIR=target cargo run --quiet --locked --manifest-path scripts/interface-manifest/Cargo.toml -- \
    extract --wasm "$WASM_DIR/$wasm_name.wasm" --contract "$pkg_name" > "$OUT_DIR/$pkg_name/interface.json"
done

echo "==> done. See $OUT_DIR/*/README.md for per-package usage." >&2
