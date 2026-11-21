#!/usr/bin/env bash
# Verifies that every Cargo workspace in the repo:
#   1. has a lockfile that `cargo metadata --locked` accepts, and
#   2. resolves the Soroban/Stellar family to the same versions as the root
#      contracts workspace.
# It also fails when a standalone `[workspace]` manifest is not listed here,
# so a new tool cannot silently skip the check.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKSPACES=(
  "."
  "contracts/budget-tests"
  "fuzz"
  "scripts/spec-hash"
  "scripts/interface-manifest"
  "scripts/fpmm-diff/oracle"
)
CRITICAL=(
  soroban-sdk soroban-sdk-macros soroban-env-host soroban-env-common
  soroban-spec stellar-xdr stellar-strkey
)

fail=0

# Prints "name version" for each CRITICAL package in a Cargo.lock.
lock_versions() {
  awk -v want="${CRITICAL[*]}" '
    BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) keep[w[i]] = 1 }
    /^\[\[package\]\]/ { name = ""; ver = "" }
    /^name = / { gsub(/"/, "", $3); name = $3 }
    /^version = / { gsub(/"/, "", $3); ver = $3;
                    if (name in keep) print name, ver }
  ' "$1" | sort
}


root_lines="$(lock_versions Cargo.lock)"

for ws in "${WORKSPACES[@]}"; do
  manifest="$ws/Cargo.toml"
  if ! cargo metadata --locked --format-version 1 --manifest-path "$manifest" >/dev/null 2>&1; then
    echo "STALE LOCKFILE: cargo metadata --locked failed for $manifest"
    fail=1
    continue
  fi
  while read -r name ver; do
    [[ -z "$name" ]] && continue
    # The root may hold two versions of one crate (e.g. stellar-strkey), so
    # the exact name+version pair must exist in the root lockfile.
    if ! grep -qx "$name $ver" <<< "$root_lines"; then
      echo "DIVERGENT: $ws resolves $name $ver, which the root lockfile does not"
      fail=1
    fi
  done < <(lock_versions "$ws/Cargo.lock")
done

# Every standalone workspace must be listed above.
while IFS= read -r manifest; do
  rel="${manifest#./}"
  dir="$(dirname "$rel")"
  [[ "$dir" == "." ]] && continue
  if grep -q '^\[workspace\]' "$manifest"; then
    listed=0
    for ws in "${WORKSPACES[@]}"; do
      [[ "$ws" == "$dir" ]] && listed=1
    done
    if [[ $listed -eq 0 ]]; then
      echo "UNLISTED WORKSPACE: $rel is not in WORKSPACES in scripts/check-lockfiles.sh"
      fail=1
    fi
  fi
done < <(find . -name Cargo.toml -not -path '*/target/*' -not -path './.git/*')

if [[ $fail -ne 0 ]]; then
  echo "check-lockfiles: FAILED"
  exit 1
fi
echo "check-lockfiles: OK (${#WORKSPACES[@]} workspaces)"
