#!/usr/bin/env bash
# Files the issues seeded in docs/wave-issues/ to GitHub via `gh issue
# create`. NOT run automatically by anything — a maintainer runs this by
# hand once they've reviewed the seeded issues and are ready to publish
# them (they reference this repo's file layout, not a placeholder).
#
# Usage: scripts/create-issues.sh [--dry-run]
# Requires: `gh` authenticated against this repo.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY_RUN=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

shopt -s nullglob
for f in docs/wave-issues/*.md; do
  title=$(sed -n 's/^# //p' "$f" | head -1)
  complexity=$(awk 'match($0, /complexity\/[a-z]+/) { print substr($0, RSTART, RLENGTH); exit }' "$f")
  if [ -z "$complexity" ]; then
    echo "warning: no complexity label found in $f — creating issue without --label" >&2
  fi
  echo "==> filing: $title (${complexity:-no complexity label found})" >&2
  cmd=(gh issue create --title "$title" --body-file "$f")
  if [ -n "$complexity" ]; then
    cmd+=(--label "$complexity")
  fi
  if [ "$DRY_RUN" = "true" ]; then
    printf 'dry-run:' >&2
    printf ' %q' "${cmd[@]}" >&2
    printf '\n' >&2
  else
    "${cmd[@]}"
  fi
done
