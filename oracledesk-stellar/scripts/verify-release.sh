#!/usr/bin/env bash
# Verifies that an on-chain deployed Soroban contract matches an attested
# GitHub release artifact byte-for-byte (#127).
#
# Usage:
#   ./scripts/verify-release.sh <contract-id> <release-tag> [--network testnet] [--repo OracleDesk/OracleDesk-SmartContract] [--skip-attestation]
#
# Steps:
#   1. Fetch the deployed contract's executable WASM from the network.
#   2. Compute its SHA-256 hash.
#   3. Download SHA256SUMS (and matching WASM) from the GitHub release.
#   4. Assert exact SHA-256 match (exit 1 on mismatch).
#   5. Verify SLSA provenance attestation via `gh attestation verify`.
#   6. Print embedded contract metadata (`source_repo`, `source_rev`, `binver`).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <contract-id> <release-tag> [--network testnet] [--repo owner/repo] [--skip-attestation]" >&2
  exit 2
fi

CONTRACT_ID="$1"
RELEASE_TAG="$2"
shift 2

NETWORK="testnet"
REPO="OracleDesk/OracleDesk-SmartContract"
SKIP_ATTESTATION=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --skip-attestation)
      SKIP_ATTESTATION=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

for cmd in stellar gh sha256sum awk; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: required command '$cmd' not found" >&2
    exit 1
  }
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

ONCHAIN_WASM="${WORKDIR}/onchain.wasm"

echo "==> Fetching executable WASM for ${CONTRACT_ID} on ${NETWORK}"
stellar contract fetch \
  --id "${CONTRACT_ID}" \
  --network "${NETWORK}" \
  --out-file "${ONCHAIN_WASM}"

ONCHAIN_SHA="$(sha256sum "${ONCHAIN_WASM}" | awk '{print $1}')"
echo "On-chain WASM SHA-256: ${ONCHAIN_SHA}"

echo "==> Downloading SHA256SUMS for release ${RELEASE_TAG} from ${REPO}"
gh release download "${RELEASE_TAG}" \
  --repo "${REPO}" \
  --pattern "SHA256SUMS" \
  --dir "${WORKDIR}"

MATCHED_ARTIFACT="$(awk -v hash="${ONCHAIN_SHA}" '$1 == hash { print $2; exit }' "${WORKDIR}/SHA256SUMS")"

if [[ -z "${MATCHED_ARTIFACT}" ]]; then
  echo "ERROR: on-chain WASM hash ${ONCHAIN_SHA} does NOT match any artifact in ${RELEASE_TAG} SHA256SUMS!" >&2
  cat "${WORKDIR}/SHA256SUMS" >&2
  exit 1
fi

echo "Matched release artifact: ${MATCHED_ARTIFACT}"

if [[ "${SKIP_ATTESTATION}" != "1" ]]; then
  echo "==> Downloading ${MATCHED_ARTIFACT} and verifying SLSA build provenance attestation"
  gh release download "${RELEASE_TAG}" \
    --repo "${REPO}" \
    --pattern "${MATCHED_ARTIFACT}" \
    --dir "${WORKDIR}"

  RELEASE_SHA="$(sha256sum "${WORKDIR}/${MATCHED_ARTIFACT}" | awk '{print $1}')"
  if [[ "${RELEASE_SHA}" != "${ONCHAIN_SHA}" ]]; then
    echo "ERROR: downloaded release artifact hash (${RELEASE_SHA}) differs from on-chain hash (${ONCHAIN_SHA})" >&2
    exit 1
  fi

  gh attestation verify "${WORKDIR}/${MATCHED_ARTIFACT}" --repo "${REPO}"
fi

echo "==> Embedded contract metadata (contractmetav0):"
stellar contract info meta --wasm "${ONCHAIN_WASM}" || true

echo "VERIFIED: ${CONTRACT_ID} on ${NETWORK} matches ${REPO}@${RELEASE_TAG} (${MATCHED_ARTIFACT}, sha256=${ONCHAIN_SHA})"
