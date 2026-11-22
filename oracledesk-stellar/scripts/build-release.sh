#!/usr/bin/env bash
# Reproducible release builder for all four OracleDesk Soroban contracts (#127).
#
# Usage:
#   ./scripts/build-release.sh [--update-vendored] [--out-dir dist] [--source-rev <rev>]
#
# Metadata embedding strategy:
#   Uses `stellar contract build --meta key=val` (supported by stellar-cli 27.1.0)
#   to embed `source_repo`, `source_rev`, and `binver` into the release wasm
#   `contractmetav0` custom section without altering contract source code or
#   breaking committed vendored `market_core.wasm` hashes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STELLAR_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${STELLAR_DIR}"

UPDATE_VENDORED=0
OUT_DIR="dist"
SOURCE_REV="${ORACLEDESK_SOURCE_REV:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update-vendored)
      UPDATE_VENDORED=1
      shift
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --source-rev)
      SOURCE_REV="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${SOURCE_REV}" ]]; then
  SOURCE_REV="$(git rev-parse HEAD 2>/dev/null || echo dev)"
fi

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"
export CARGO_INCREMENTAL=0
export RUSTFLAGS="${RUSTFLAGS:---remap-path-prefix=${STELLAR_DIR}=/build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo}"

SOURCE_REPO="github:OracleDesk/OracleDesk-SmartContract"
BINVER="$(grep -E '^version\s*=' Cargo.toml | head -n1 | sed -E 's/.*"([^"]+)".*/\1/' || echo "0.1.0")"
RUSTC_VER="$(rustc --version)"
STELLAR_CLI_VER="$(stellar --version | head -n1)"
SOROBAN_SDK_VER="$(grep -E 'soroban-sdk\s*=' Cargo.toml | head -n1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")"

echo "==> Step 1: Verify vendored cross-contract WASM matches clean build"
stellar contract build --package market-core --locked
stellar contract build --package reasoning-registry --locked

./scripts/sync-vendored-wasm.sh
if [[ "${UPDATE_VENDORED}" != "1" ]]; then
  if ! git diff --exit-code -- \
      contracts/resolver/market_core.wasm \
      contracts/treasury/market_core.wasm \
      contracts/resolver/reasoning_registry.wasm; then
    echo "ERROR: vendored market_core.wasm / reasoning_registry.wasm drifted from committed copy." >&2
    echo "Re-run with --update-vendored only when intentionally updating vendored interfaces." >&2
    exit 1
  fi
fi

echo "==> Step 2: Build release WASM artifacts with embedded contract metadata"
mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/*.wasm "${OUT_DIR}/SHA256SUMS" "${OUT_DIR}/manifest.json"

PACKAGES=(
  "market-core:market_core"
  "resolver:resolver"
  "treasury:treasury"
  "reasoning-registry:reasoning_registry"
)

for entry in "${PACKAGES[@]}"; do
  pkg="${entry%%:*}"
  wasm_name="${entry##*:}"
  echo "  building ${pkg} (${wasm_name}.wasm) with source_rev=${SOURCE_REV}"
  stellar contract build \
    --package "${pkg}" \
    --locked \
    --meta "source_repo=${SOURCE_REPO}" \
    --meta "source_rev=${SOURCE_REV}" \
    --meta "binver=${BINVER}"
  cp "target/wasm32v1-none/release/${wasm_name}.wasm" "${OUT_DIR}/${wasm_name}.wasm"
done

echo "==> Step 3: Optimize WASM artifacts and enforce size-budget.json"
MANIFEST_ENTRIES="[]"

for entry in "${PACKAGES[@]}"; do
  wasm_name="${entry##*:}"
  raw_path="${OUT_DIR}/${wasm_name}.wasm"
  opt_path="${OUT_DIR}/${wasm_name}.optimized.wasm"

  stellar contract optimize --wasm "${raw_path}" --wasm-out "${opt_path}"

  raw_sha="$(sha256sum "${raw_path}" | awk '{print $1}')"
  opt_sha="$(sha256sum "${opt_path}" | awk '{print $1}')"
  raw_size="$(wc -c < "${raw_path}" | tr -d '[:space:]')"
  opt_size="$(wc -c < "${opt_path}" | tr -d '[:space:]')"
  budget="$(jq -r --arg name "${wasm_name}" '.budgets[$name] // 0' size-budget.json)"

  if (( budget > 0 && opt_size > budget )); then
    echo "ERROR: ${wasm_name}.optimized.wasm size (${opt_size} bytes) exceeds budget (${budget} bytes)" >&2
    exit 1
  fi

  MANIFEST_ENTRIES="$(jq -nc \
    --argjson arr "${MANIFEST_ENTRIES}" \
    --arg contract "${wasm_name}" \
    --arg raw_sha256 "${raw_sha}" \
    --arg optimized_sha256 "${opt_sha}" \
    --argjson raw_size_bytes "${raw_size}" \
    --argjson optimized_size_bytes "${opt_size}" \
    --argjson budget_bytes "${budget}" \
    --arg source_repo "${SOURCE_REPO}" \
    --arg source_rev "${SOURCE_REV}" \
    --arg binver "${BINVER}" \
    '$arr + [{
      contract: $contract,
      raw_sha256: $raw_sha256,
      optimized_sha256: $optimized_sha256,
      raw_size_bytes: $raw_size_bytes,
      optimized_size_bytes: $optimized_size_bytes,
      budget_bytes: $budget_bytes,
      metadata: {
        source_repo: $source_repo,
        source_rev: $source_rev,
        binver: $binver
      }
    }]')"
done

echo "==> Step 4: Write deterministic SHA256SUMS and manifest.json"
(
  cd "${OUT_DIR}"
  LC_ALL=C sha256sum market_core.wasm market_core.optimized.wasm \
    resolver.wasm resolver.optimized.wasm \
    treasury.wasm treasury.optimized.wasm \
    reasoning_registry.wasm reasoning_registry.optimized.wasm > SHA256SUMS
)

jq -n \
  --arg source_repo "${SOURCE_REPO}" \
  --arg source_rev "${SOURCE_REV}" \
  --arg binver "${BINVER}" \
  --arg rustc "${RUSTC_VER}" \
  --arg stellar_cli "${STELLAR_CLI_VER}" \
  --arg soroban_sdk "${SOROBAN_SDK_VER}" \
  --argjson source_date_epoch "${SOURCE_DATE_EPOCH}" \
  --argjson contracts "${MANIFEST_ENTRIES}" \
  '{
    schema_version: 1,
    source_repo: $source_repo,
    source_rev: $source_rev,
    binver: $binver,
    source_date_epoch: $source_date_epoch,
    toolchain: {
      rustc: $rustc,
      stellar_cli: $stellar_cli,
      soroban_sdk: $soroban_sdk
    },
    contracts: $contracts
  }' > "${OUT_DIR}/manifest.json"

echo "OK: release artifacts written to ${OUT_DIR}/"
cat "${OUT_DIR}/SHA256SUMS"
