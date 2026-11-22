#!/usr/bin/env bash
# Verifies local or CI developer toolchain versions against `toolchain.env` (#135).
# Safe to run non-interactively when CI=true.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STELLAR_DIR="${ORACLEDESK_STELLAR_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
TOOLCHAIN_ENV="${STELLAR_DIR}/toolchain.env"

if [[ ! -f "${TOOLCHAIN_ENV}" ]]; then
  echo "ERROR: missing ${TOOLCHAIN_ENV}" >&2
  exit 1
fi

# shellcheck source=../toolchain.env
source "${TOOLCHAIN_ENV}"

if [[ "${CI:-}" == "true" || ! -t 1 ]]; then
  MARK_OK="[OK]"
  MARK_WARN="[WARN]"
  MARK_FAIL="[FAIL]"
else
  MARK_OK="✔"
  MARK_WARN="⚠"
  MARK_FAIL="✖"
fi

hard_failures=0
warnings=0

report_ok() {
  printf "%-6s %-18s %-20s %s\n" "${MARK_OK}" "$1" "$2" "$3"
}

report_warn() {
  warnings=$((warnings + 1))
  printf "%-6s %-18s %-20s %s\n" "${MARK_WARN}" "$1" "$2" "$3"
}

report_fail() {
  hard_failures=$((hard_failures + 1))
  printf "%-6s %-18s %-20s %s\n" "${MARK_FAIL}" "$1" "$2" "$3"
}

version_ge() {
  # Returns 0 if $1 >= $2 (dot-separated major.minor comparison).
  local a_maj a_min b_maj b_min
  IFS='.' read -r a_maj a_min _ <<< "$1"
  IFS='.' read -r b_maj b_min _ <<< "$2"
  a_maj="${a_maj:-0}"; a_min="${a_min:-0}"
  b_maj="${b_maj:-0}"; b_min="${b_min:-0}"
  if (( a_maj > b_maj )); then return 0; fi
  if (( a_maj == b_maj && a_min >= b_min )); then return 0; fi
  return 1
}

printf "%-6s %-18s %-20s %s\n" "STATUS" "TOOL" "DETECTED" "EXPECTED / HINT"
printf "%-6s %-18s %-20s %s\n" "------" "----" "--------" "---------------"

# 1. rustc
if command -v rustc >/dev/null 2>&1; then
  rustc_ver="$(rustc --version | awk '{print $2}')"
  if [[ "${rustc_ver}" == "${RUST_VERSION}" ]]; then
    report_ok "rustc" "${rustc_ver}" "matches ${RUST_VERSION}"
  else
    report_fail "rustc" "${rustc_ver}" "expected ${RUST_VERSION} (run: rustup toolchain install ${RUST_VERSION})"
  fi
else
  report_fail "rustc" "missing" "install Rust ${RUST_VERSION} via rustup or use the devcontainer"
fi

# 2. wasm32v1-none target
if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed 2>/dev/null | grep -qx "${RUST_WASM_TARGET}"; then
    report_ok "wasm-target" "${RUST_WASM_TARGET}" "installed"
  else
    report_fail "wasm-target" "missing" "run: rustup target add ${RUST_WASM_TARGET}"
  fi
else
  report_fail "wasm-target" "rustup missing" "install rustup and run: rustup target add ${RUST_WASM_TARGET}"
fi

# 3. stellar CLI
if command -v stellar >/dev/null 2>&1; then
  stellar_ver="$(stellar --version | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [[ "${stellar_ver}" == "${STELLAR_CLI_VERSION}" ]]; then
    report_ok "stellar" "${stellar_ver}" "matches ${STELLAR_CLI_VERSION}"
  else
    report_fail "stellar" "${stellar_ver:-unknown}" "expected ${STELLAR_CLI_VERSION} (download release v${STELLAR_CLI_VERSION})"
  fi
else
  report_fail "stellar" "missing" "install stellar-cli v${STELLAR_CLI_VERSION} or use the devcontainer"
fi

# 4. node
if command -v node >/dev/null 2>&1; then
  node_ver="$(node --version | sed 's/^v//')"
  if [[ "${node_ver}" == "${NODE_VERSION}" ]]; then
    report_ok "node" "${node_ver}" "matches ${NODE_VERSION}"
  else
    report_fail "node" "${node_ver}" "expected ${NODE_VERSION} (use nvm, Nix, or devcontainer)"
  fi
else
  report_fail "node" "missing" "install Node.js ${NODE_VERSION}"
fi

# 5. python3 (soft minimum >= PYTHON_MIN_VERSION)
if command -v python3 >/dev/null 2>&1; then
  py_ver="$(python3 --version 2>&1 | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1 || true)"
  if [[ -n "${py_ver}" ]] && version_ge "${py_ver}" "${PYTHON_MIN_VERSION}"; then
    if [[ "${py_ver}" == "${PYTHON_VERSION}"* ]]; then
      report_ok "python3" "${py_ver}" "matches ${PYTHON_VERSION}.x (>= ${PYTHON_MIN_VERSION})"
    else
      report_warn "python3" "${py_ver}" "pinned is ${PYTHON_VERSION}.x (soft minimum >= ${PYTHON_MIN_VERSION} satisfied)"
    fi
  else
    report_fail "python3" "${py_ver:-unknown}" "expected >= ${PYTHON_MIN_VERSION}"
  fi
else
  report_fail "python3" "missing" "install Python >= ${PYTHON_MIN_VERSION}"
fi

# 6. jq
if command -v jq >/dev/null 2>&1; then
  jq_ver="$(jq --version | sed 's/^jq-//')"
  if [[ "${jq_ver}" == "${JQ_VERSION}" ]]; then
    report_ok "jq" "${jq_ver}" "matches ${JQ_VERSION}"
  else
    report_fail "jq" "${jq_ver}" "expected ${JQ_VERSION}"
  fi
else
  report_fail "jq" "missing" "install jq ${JQ_VERSION}"
fi

# 7. bash (>= 4 for associative arrays in gen-bindings.sh)
if command -v bash >/dev/null 2>&1; then
  bash_ver="$(bash --version | head -n1 | grep -Eo '[0-9]+\.[0-9]+' | head -n1 || true)"
  if [[ -n "${bash_ver}" ]] && version_ge "${bash_ver}" "4.0"; then
    report_ok "bash" "${bash_ver}" ">= 4.0"
  else
    report_fail "bash" "${bash_ver:-unknown}" "expected bash >= 4.0"
  fi
else
  report_fail "bash" "missing" "install bash >= 4.0"
fi

# 8. Optional container runtime for `stellar container start local`
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
  report_ok "container-rt" "available" "needed only for local network (e2e-local)"
else
  report_warn "container-rt" "missing" "optional: install Docker or Podman for 'stellar container start local'"
fi

echo ""
if (( hard_failures > 0 )); then
  echo "doctor: ${hard_failures} hard mismatch(es), ${warnings} warning(s)." >&2
  exit 1
fi

echo "doctor: all required tools verified (${warnings} warning(s))."
