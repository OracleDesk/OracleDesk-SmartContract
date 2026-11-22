#!/usr/bin/env bash
# Verifies that `oracledesk-stellar/toolchain.env` is in exact sync with:
#   - oracledesk-stellar/rust-toolchain.toml
#   - oracledesk-stellar/stellar-cli.version
#   - .devcontainer/Dockerfile
#   - flake.nix
#
# Exits non-zero on any drift so CI catches uncoordinated toolchain edits (#135).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STELLAR_DIR="${ORACLEDESK_STELLAR_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
REPO_ROOT="${ORACLEDESK_REPO_ROOT:-$(cd "${STELLAR_DIR}/.." && pwd)}"

TOOLCHAIN_ENV="${STELLAR_DIR}/toolchain.env"
RUST_TOOLCHAIN_TOML="${STELLAR_DIR}/rust-toolchain.toml"
STELLAR_VERSION_FILE="${STELLAR_DIR}/stellar-cli.version"
DEVCONTAINER_DOCKERFILE="${REPO_ROOT}/.devcontainer/Dockerfile"
FLAKE_NIX="${REPO_ROOT}/flake.nix"

if [[ ! -f "${TOOLCHAIN_ENV}" ]]; then
  echo "ERROR: missing ${TOOLCHAIN_ENV}" >&2
  exit 1
fi

# shellcheck source=../toolchain.env
source "${TOOLCHAIN_ENV}"

errors=0

fail() {
  echo "DRIFT: $1" >&2
  errors=$((errors + 1))
}

check_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"
  if [[ ! -f "${file}" ]]; then
    fail "${label}: missing file ${file}"
    return
  fi
  if ! grep -Fq -- "${expected}" "${file}"; then
    fail "${label}: expected '${expected}' in ${file}"
  fi
}

# 1. rust-toolchain.toml
check_contains "${RUST_TOOLCHAIN_TOML}" "channel = \"${RUST_VERSION}\"" "rust-toolchain.toml channel"
check_contains "${RUST_TOOLCHAIN_TOML}" "\"${RUST_WASM_TARGET}\"" "rust-toolchain.toml target"

# 2. stellar-cli.version
if [[ ! -f "${STELLAR_VERSION_FILE}" ]]; then
  fail "stellar-cli.version: missing file ${STELLAR_VERSION_FILE}"
else
  actual_stellar="$(tr -d '[:space:]' < "${STELLAR_VERSION_FILE}")"
  if [[ "${actual_stellar}" != "${STELLAR_CLI_VERSION}" ]]; then
    fail "stellar-cli.version: got '${actual_stellar}', expected '${STELLAR_CLI_VERSION}'"
  fi
fi

# 3. .devcontainer/Dockerfile
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG RUST_VERSION=${RUST_VERSION}" "Dockerfile RUST_VERSION"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG RUST_WASM_TARGET=${RUST_WASM_TARGET}" "Dockerfile RUST_WASM_TARGET"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG STELLAR_CLI_VERSION=${STELLAR_CLI_VERSION}" "Dockerfile STELLAR_CLI_VERSION"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG NODE_VERSION=${NODE_VERSION}" "Dockerfile NODE_VERSION"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG JQ_VERSION=${JQ_VERSION}" "Dockerfile JQ_VERSION"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG STELLAR_CLI_SHA256_X86_64=${STELLAR_CLI_SHA256_X86_64}" "Dockerfile STELLAR_CLI_SHA256_X86_64"
check_contains "${DEVCONTAINER_DOCKERFILE}" "ARG STELLAR_CLI_SHA256_ARM64=${STELLAR_CLI_SHA256_ARM64}" "Dockerfile STELLAR_CLI_SHA256_ARM64"

# 4. flake.nix
check_contains "${FLAKE_NIX}" "rustVersion = \"${RUST_VERSION}\";" "flake.nix rustVersion"
check_contains "${FLAKE_NIX}" "\"${RUST_WASM_TARGET}\"" "flake.nix wasm target"
check_contains "${FLAKE_NIX}" "stellarCliVersion = \"${STELLAR_CLI_VERSION}\";" "flake.nix stellarCliVersion"
check_contains "${FLAKE_NIX}" "sha256 = \"${STELLAR_CLI_SHA256_X86_64}\";" "flake.nix x86_64 sha256"
check_contains "${FLAKE_NIX}" "sha256 = \"${STELLAR_CLI_SHA256_ARM64}\";" "flake.nix arm64 sha256"

if (( errors > 0 )); then
  echo "Toolchain sync check failed with ${errors} mismatch(es)." >&2
  exit 1
fi

echo "OK: toolchain.env is synchronized across rust-toolchain.toml, stellar-cli.version, .devcontainer/Dockerfile, and flake.nix."
