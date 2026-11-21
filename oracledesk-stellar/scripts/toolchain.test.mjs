import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stellarDir = resolve(__dirname, '..');
const repoRoot = resolve(stellarDir, '..');

function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

describe('hermetic toolchain synchronization (#135)', () => {
  const env = parseEnvFile(readFileSync(resolve(stellarDir, 'toolchain.env'), 'utf8'));

  test('toolchain.env defines all pinned versions and real 64-hex SHA-256 digests', () => {
    assert.match(env.RUST_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(env.RUST_WASM_TARGET, 'wasm32v1-none');
    assert.match(env.STELLAR_CLI_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(env.NODE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(env.JQ_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(env.STELLAR_CLI_SHA256_X86_64, /^[0-9a-f]{64}$/);
    assert.match(env.STELLAR_CLI_SHA256_ARM64, /^[0-9a-f]{64}$/);
  });

  test('rust-toolchain.toml and stellar-cli.version match toolchain.env', () => {
    const rustToml = readFileSync(resolve(stellarDir, 'rust-toolchain.toml'), 'utf8');
    assert.ok(rustToml.includes(`channel = "${env.RUST_VERSION}"`));
    assert.ok(rustToml.includes(`"${env.RUST_WASM_TARGET}"`));

    const cliVer = readFileSync(resolve(stellarDir, 'stellar-cli.version'), 'utf8').trim();
    assert.equal(cliVer, env.STELLAR_CLI_VERSION);
  });

  test('.devcontainer/Dockerfile matches toolchain.env', () => {
    const dockerfile = readFileSync(resolve(repoRoot, '.devcontainer/Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes('@sha256:'), 'base image must be digest-pinned');
    assert.ok(dockerfile.includes(`ARG RUST_VERSION=${env.RUST_VERSION}`));
    assert.ok(dockerfile.includes(`ARG RUST_WASM_TARGET=${env.RUST_WASM_TARGET}`));
    assert.ok(dockerfile.includes(`ARG STELLAR_CLI_VERSION=${env.STELLAR_CLI_VERSION}`));
    assert.ok(dockerfile.includes(`ARG NODE_VERSION=${env.NODE_VERSION}`));
    assert.ok(dockerfile.includes(`ARG JQ_VERSION=${env.JQ_VERSION}`));
    assert.ok(dockerfile.includes(`ARG STELLAR_CLI_SHA256_X86_64=${env.STELLAR_CLI_SHA256_X86_64}`));
    assert.ok(dockerfile.includes(`ARG STELLAR_CLI_SHA256_ARM64=${env.STELLAR_CLI_SHA256_ARM64}`));
  });

  test('flake.nix matches toolchain.env', () => {
    const flake = readFileSync(resolve(repoRoot, 'flake.nix'), 'utf8');
    assert.ok(flake.includes(`rustVersion = "${env.RUST_VERSION}";`));
    assert.ok(flake.includes(`"${env.RUST_WASM_TARGET}"`));
    assert.ok(flake.includes(`stellarCliVersion = "${env.STELLAR_CLI_VERSION}";`));
    assert.ok(flake.includes(`sha256 = "${env.STELLAR_CLI_SHA256_X86_64}";`));
    assert.ok(flake.includes(`sha256 = "${env.STELLAR_CLI_SHA256_ARM64}";`));
  });
});
