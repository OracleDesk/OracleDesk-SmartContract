import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stellarDir = resolve(__dirname, '..');
const repoRoot = resolve(stellarDir, '..');

describe('reproducible wasm release pipeline (#127)', () => {
  test('size-budget.json defines positive byte budgets for all four release contracts', () => {
    const budget = JSON.parse(readFileSync(resolve(stellarDir, 'size-budget.json'), 'utf8'));
    for (const name of ['market_core', 'resolver', 'treasury', 'reasoning_registry']) {
      assert.equal(typeof budget.budgets[name], 'number');
      assert.ok(budget.budgets[name] > 0, `expected positive budget for ${name}`);
    }
  });

  test('release-contracts.yml scopes id-token: write only to release job and enforces rebuild-check', () => {
    const wf = readFileSync(resolve(repoRoot, '.github/workflows/release-contracts.yml'), 'utf8');
    assert.ok(wf.includes('contracts-v*'));
    assert.ok(wf.includes('workflow_dispatch'));
    assert.ok(wf.includes('rebuild-check:'));
    assert.ok(wf.includes('diff -u primary-dist/SHA256SUMS'));
    assert.ok(wf.includes('actions/attest-build-provenance@'));

    // Ensure id-token: write appears only inside the release job (after `release:`), never top-level.
    const releaseJobIdx = wf.indexOf('\n  release:\n');
    const idTokenIdx = wf.indexOf('id-token: write');
    assert.ok(releaseJobIdx > 0);
    assert.ok(idTokenIdx > releaseJobIdx, 'id-token: write must be scoped to release job only');
  });

  test('contracts-build.Dockerfile is digest-pinned and aligned with toolchain.env', () => {
    const dockerfile = readFileSync(resolve(stellarDir, 'docker/contracts-build.Dockerfile'), 'utf8');
    const envRaw = readFileSync(resolve(stellarDir, 'toolchain.env'), 'utf8');
    const rustVer = envRaw.match(/^RUST_VERSION=(.+)$/m)?.[1]?.trim();
    const cliVer = envRaw.match(/^STELLAR_CLI_VERSION=(.+)$/m)?.[1]?.trim();

    assert.ok(dockerfile.includes('@sha256:'));
    assert.ok(dockerfile.includes(`ARG RUST_VERSION=${rustVer}`));
    assert.ok(dockerfile.includes(`ARG STELLAR_CLI_VERSION=${cliVer}`));
    assert.ok(dockerfile.includes('SOURCE_DATE_EPOCH'));
    assert.ok(dockerfile.includes('--remap-path-prefix'));
  });

  test('deploy-testnet.sh supports WASM_DIR override and records wasm_sha256', () => {
    const deploy = readFileSync(resolve(stellarDir, 'scripts/deploy-testnet.sh'), 'utf8');
    assert.ok(deploy.includes('WASM_DIR=${WASM_DIR:-target/wasm32v1-none/release}'));
    assert.ok(deploy.includes('.wasm_sha256[$k] = $h'));
  });
});
