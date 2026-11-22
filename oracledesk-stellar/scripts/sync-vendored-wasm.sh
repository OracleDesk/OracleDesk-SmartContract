#!/usr/bin/env bash
# Copies freshly built cross-contract wasm into every vendored copy listed in
# scripts/wasm-sync-manifest.json and refreshes the committed sha256 pins.
#
# `contractimport!` reads the vendored wasm at compile time, so a stale copy
# silently links against an old interface. Each crate's build.rs verifies the
# copy against its <name>.wasm.sha256 pin, turning a mismatch into a compile
# error. This script is the one supported way to refresh both artefact and pin
# so they can never be committed apart (issue #311).
#
# Topological order is taken from the manifest's topo_order field, so running
# this script without arguments syncs the entire dependency graph in order.
#
# Usage:
#   ./scripts/sync-vendored-wasm.sh               # sync everything in topo order
#   ./scripts/sync-vendored-wasm.sh market_core   # sync one artifact only
#   ./scripts/sync-vendored-wasm.sh --dry-run      # print what would happen
#
# Environment:
#   WASM_DIR   override for the build output directory
#              (default: target/wasm32v1-none/release)
#   MANIFEST   override for the manifest path
#              (default: scripts/wasm-sync-manifest.json)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WASM_DIR=${WASM_DIR:-target/wasm32v1-none/release}
MANIFEST=${MANIFEST:-scripts/wasm-sync-manifest.json}
DRY_RUN=false
FILTER=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) FILTER="$arg" ;;
  esac
done

if [ ! -f "$MANIFEST" ]; then
  echo "error: manifest not found: $MANIFEST" >&2
  exit 1
fi

# Require jq for manifest parsing
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to parse $MANIFEST" >&2
  exit 1
fi

# sha256 helper — works on Linux (sha256sum) and macOS (shasum)
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "error: neither sha256sum nor shasum is installed" >&2
  exit 1
fi

sync_artifact() {  # <artifact_name>
  local name="$1"
  local built="$WASM_DIR/$name.wasm"

  if [ ! -f "$built" ]; then
    echo "error: $built is missing — run 'stellar contract build' for $name first" >&2
    return 1
  fi

  local copies
  copies=$(jq -r --arg n "$name" \
    '.artifacts[] | select(.name == $n) | .copies[] | "\(.destination)\t\(.pin_file)"' \
    "$MANIFEST")

  if [ -z "$copies" ]; then
    echo "warning: no copies defined for $name in $MANIFEST" >&2
    return 0
  fi

  local hash
  hash=$(sha256_of "$built")

  while IFS=$'\t' read -r dest pin; do
    if [ "$DRY_RUN" = "true" ]; then
      echo "[dry-run] would sync $built -> $dest  (pin: $hash)"
    else
      mkdir -p "$(dirname "$dest")"
      cp "$built" "$dest"
      echo "$hash" > "$pin"
      echo "synced  $dest  ($hash)"
    fi
  done <<< "$copies"
}

# Collect artifact names sorted by topo_order, optionally filtered
if [ -n "$FILTER" ]; then
  # Validate the name exists in the manifest
  found=$(jq -r --arg n "$FILTER" '.artifacts[] | select(.name == $n) | .name' "$MANIFEST")
  if [ -z "$found" ]; then
    echo "error: '$FILTER' is not an artifact listed in $MANIFEST" >&2
    echo "available artifacts: $(jq -r '[.artifacts[].name] | join(", ")' "$MANIFEST")" >&2
    exit 1
  fi
  artifacts=("$FILTER")
else
  mapfile -t artifacts < <(jq -r '.artifacts | sort_by(.topo_order) | .[].name' "$MANIFEST")
fi

for name in "${artifacts[@]}"; do
  sync_artifact "$name"
done

if [ "$DRY_RUN" = "true" ]; then
  echo "[dry-run] done — no files were modified"
else
  echo "wasm-sync complete"
fi
