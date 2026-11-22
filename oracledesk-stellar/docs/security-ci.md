# Supply-Chain Security & Dependency Policy

OracleDesk enforces automated supply-chain security checks in `.github/workflows/security.yml` on every pull request, push to `develop`/`main`, and a weekly scheduled run (Issue #126).

## Controls

1. **`cargo-deny` (`oracledesk-stellar/deny.toml`):**
   - Checks RustSec advisories, SPDX license allowlist, wildcard/duplicate crate bans (`multiple-versions = "warn"` for upstream `soroban-sdk` compatibility, `wildcards = "deny"`), and crates.io-only sources across both the main workspace and `scripts/spec-hash`.
   - Any advisory exception must carry an explicit reason and expiry date (`expires YYYY-MM-DD`).
2. **npm Audit Gate (`scripts/npm-audit-gate.mjs`):**
   - Runs `npm audit --omit=dev --json` across all production npm lockfiles, deduplicates advisories across workspace / `file:` bindings, and fails on any unlisted `high` or `critical` production advisory.
   - Temporary exceptions live in `security/npm-audit-allowlist.json` with `{ id, package, reason, expires }`; expired entries fail the build automatically.
   - Dev-only advisories are logged but do not block merges.
   - Registry outages retry and warn on PRs, and hard-fail on scheduled runs (`NPM_AUDIT_STRICT_NETWORK=1`).
3. **Secrets Scanning (`.gitleaks.toml`):**
   - Runs `gitleaks` on PR diffs and full history on schedule with an explicit Stellar secret-seed rule (`S[A-Z2-7]{55}`).
   - Public Stellar `G...` / `C...` addresses in `deployments/testnet.json` and golden test vectors are allowlisted without disabling entropy detection.
4. **CycloneDX SBOMs:**
   - Produces CycloneDX JSON SBOMs for the Rust workspace (`cargo-cyclonedx`) and npm production dependencies (`@cyclonedx/cyclonedx-npm --omit dev`), uploaded as the `sbom` workflow artifact for future release attestation pipelines.
5. **Pinned GitHub Actions & Least Privilege:**
   - Every `uses:` reference in workflow files is pinned to a full 40-character commit SHA with an inline version comment.
   - All workflows default to `permissions: contents: read`.
   - `.github/dependabot.yml` keeps Actions, Cargo, and npm dependencies updated weekly against `develop`.

## Initial Baseline Triage

| Area | Baseline Status | Resolution / Policy |
|---|---|---|
| Rust workspace (`Cargo.lock`) | Audited via `deny.toml` | Crates.io-only sources, wildcard deps denied, duplicate versions warned for `soroban-sdk` ecosystem. |
| npm production lockfiles | Gated via `npm-audit-gate.mjs` | Zero standing exceptions in `security/npm-audit-allowlist.json`; dev-only advisories excluded via `--omit=dev`. |
| Repository secrets | Covered by `.gitleaks.toml` | Stellar `S...` seed rule enabled; public `G...`/`C...` testnet contract addresses allowlisted. |
| Workflow permissions & pinning | Hardened | Top-level `permissions: contents: read`, SHA-pinned actions, weekly Dependabot targeting `develop`. |
