#!/usr/bin/env bash
# Files the issues seeded in docs/wave-issues/ to GitHub via `gh issue
# create`. NOT run automatically by anything — a maintainer runs this by
# hand once they've reviewed the seeded issues and are ready to publish
# them (they reference this repo's file layout, not a placeholder).
#
# Requires: `gh` authenticated against this repo.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for f in docs/wave-issues/*.md; do
  title=$(sed -n 's/^# //p' "$f" | head -1)
  complexity=$(sed -n 's/^`\(complexity\/[a-z]*\)`$/\1/p' "$f" | head -1)
  echo "==> filing: $title (${complexity:-no complexity label found})" >&2
  gh issue create \
    --title "$title" \
    --body-file "$f" \
    --label "$complexity"
done
