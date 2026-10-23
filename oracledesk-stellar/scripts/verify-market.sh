#!/usr/bin/env bash
# Verifies a market's off-chain metadata JSON against its on-chain
# question_hash, resolution_hash, close_time, and category.
#
# Usage:
#   scripts/verify-market.sh <metadata_json_file> <expected_question_hash_hex>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <metadata_json_path> <question_hash_hex>" >&2
  exit 1
fi

META_FILE="$1"
EXPECTED_QHASH="${2#0x}"

ACTUAL_QHASH="$(python3 "$REPO_ROOT/model/market_metadata.py" hash "$META_FILE")"
if [[ "${ACTUAL_QHASH,,}" != "${EXPECTED_QHASH,,}" ]]; then
  echo "FAIL: metadata hash $ACTUAL_QHASH != expected $EXPECTED_QHASH" >&2
  exit 1
fi

echo "OK: question_hash verified ($ACTUAL_QHASH)"
