# Reproducible Contract WASM Releases & On-Chain Verification

Every production or testnet contract release is built reproducibly in a pinned Docker container, checked for bit-for-bit reproducibility across two independent builds, checked against per-contract size budgets, attested with SLSA build provenance, and verifiable against live on-chain deployments.

## Metadata Mechanism

Release builds embed `source_repo`, `source_rev`, and `binver` into each contract's `contractmetav0` custom section via `stellar contract build --meta key=val` (natively supported by pinned `stellar-cli 27.1.0`). Using `--meta` at release-build time avoids mutating contract source files or invalidating committed vendored `market_core.wasm` cross-contract pins during normal development.

## Cutting a Release

1. Ensure `develop` is green and `make check-toolchain-sync` passes.
2. Dry-run the workflow first via `workflow_dispatch` on `.github/workflows/release-contracts.yml`.
3. Tag the release commit with `contracts-vX.Y.Z` and push the tag:
   ```bash
   git tag -a contracts-v0.1.0 -m "Contracts release v0.1.0"
   git push origin contracts-v0.1.0
   ```
4. The workflow executes three jobs:
   - `build`: builds `market_core`, `resolver`, `treasury`, and `reasoning_registry` inside `oracledesk-stellar/docker/contracts-build.Dockerfile`, checks vendored WASM drift, runs `stellar contract optimize`, checks `size-budget.json`, and emits `dist/SHA256SUMS` + `dist/manifest.json`.
   - `rebuild-check`: rebuilds cleanly on a second runner in a distinct mount path and diffs `SHA256SUMS` byte-for-byte.
   - `release`: attests every `dist/*.wasm` via `actions/attest-build-provenance` and publishes the GitHub release.

## Reproducing a Release Locally with Docker

```bash
cd oracledesk-stellar
docker build -f docker/contracts-build.Dockerfile -t oracledesk-contracts-build .
docker run --rm \
  -v "$(pwd)/..:/workspace" \
  -w /workspace/oracledesk-stellar \
  -e ORACLEDESK_SOURCE_REV="$(git rev-parse HEAD)" \
  oracledesk-contracts-build \
  ./scripts/build-release.sh --out-dir dist
diff -u dist/SHA256SUMS <downloaded-release>/SHA256SUMS
```

## Deploying from a Release & Verifying On-Chain

Deploy from a downloaded release directory (recording `wasm_sha256` per contract in `deployments/testnet.json`):

```bash
cd oracledesk-stellar
LEGACY_BASH_DEPLOY=1 WASM_DIR=./dist ./scripts/deploy-testnet.sh
```

Verify any deployed contract ID against a GitHub release tag:

```bash
cd oracledesk-stellar
./scripts/verify-release.sh <CONTRACT_ID> contracts-v0.1.0 --network testnet
```

`verify-release.sh` fetches the on-chain executable WASM via `stellar contract fetch`, hashes it, compares against the release's `SHA256SUMS`, verifies the SLSA provenance attestation via `gh attestation verify`, prints the embedded `contractmetav0` fields, and exits non-zero on any mismatch.
