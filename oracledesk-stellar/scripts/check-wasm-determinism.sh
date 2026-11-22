#!/usr/bin/env bash
# Proves the contract build is deterministic and that the vendored cross-
# contract wasm matches a clean build (issue #58).
#
# The old CI defence was `git diff --exit-code` after rebuilding the vendored
# copies, which is only sound if two clean builds are bit-for-bit identical.
# This script builds the workspace twice into separate target directories and
# fails on any byte difference, then checks the checked-in
# resolver/treasury market_core.wasm (and resolver reasoning_registry.wasm)
# against the fresh build.
#
# Run locally with `make verify-wasm`; CI runs it on every change.
set -euo pipefail

cd "$(dirname "$0")/.."

# `sha256sum` is GNU coreutils (Linux/CI); `shasum -a 256` is the macOS
# default. Accept either so `make verify-wasm` works on a laptop too.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "error: neither sha256sum nor shasum is installed" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for run in a b; do
  echo "== clean build $run =="
  CARGO_TARGET_DIR="$work/$run" stellar contract build
done

status=0
for wasm in market_core resolver treasury reasoning_registry; do
  a="$work/a/wasm32v1-none/release/$wasm.wasm"
  b="$work/b/wasm32v1-none/release/$wasm.wasm"
  if ! cmp -s "$a" "$b"; then
    echo "NON-DETERMINISTIC: $wasm.wasm differs between two clean builds" >&2
    sha256_of "$a" >&2 || true
    sha256_of "$b" >&2 || true
    status=1
  else
    echo "deterministic: $wasm.wasm ($(sha256_of "$a"))"
  fi
done

# Default builds must never carry the local-only short-window meta entry.
for wasm in market_core treasury timelock; do
  wasm_path="$work/a/wasm32v1-none/release/$wasm.wasm"
  if stellar contract info meta --wasm "$wasm_path" 2>/dev/null | grep -q 'local-short-windows'; then
    echo "LOCAL BUILD META IN DEFAULT WASM: $wasm.wasm" >&2
    status=1
  fi
done

check_pin() {
  local vendored="$1" built="$2" pin="$3"
  local expected actual
  expected="$(tr -d '[:space:]' < "$pin")"
  actual="$(sha256_of "$built")"
  if [ "$expected" != "$actual" ]; then
    echo "STALE PIN: $pin says $expected but a clean build hashes $actual" >&2
    echo "  (this is the drift the .sha256 pin is meant to catch)" >&2
    status=1
  fi
  if ! cmp -s "$vendored" "$built"; then
    echo "STALE VENDORED WASM: $vendored differs from a clean build" >&2
    status=1
  else
    echo "in sync: $vendored"
  fi
}

check_pin contracts/resolver/market_core.wasm \
  "$work/a/wasm32v1-none/release/market_core.wasm" \
  contracts/resolver/market_core.wasm.sha256
check_pin contracts/treasury/market_core.wasm \
  "$work/a/wasm32v1-none/release/market_core.wasm" \
  contracts/treasury/market_core.wasm.sha256
check_pin contracts/resolver/reasoning_registry.wasm \
  "$work/a/wasm32v1-none/release/reasoning_registry.wasm" \
  contracts/resolver/reasoning_registry.wasm.sha256
check_pin contracts/treasury/resolver.wasm \
  "$work/a/wasm32v1-none/release/resolver.wasm" \
  contracts/treasury/resolver.wasm.sha256

if [ "$status" -ne 0 ]; then
  echo "wasm determinism/drift check FAILED" >&2
  exit 1
fi
echo "wasm determinism/drift check passed"
