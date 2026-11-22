import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEGIN_MARKER,
  END_MARKER,
  renderAddressTable,
  replaceMarkedSection,
} from './render-addresses.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stellarDir = resolve(__dirname, '..');
const repoRoot = resolve(stellarDir, '..');

describe('render-addresses.mjs (#130)', () => {
  test('rendering deployments/testnet.json reproduces the root README table byte-for-byte', () => {
    const deployment = JSON.parse(readFileSync(resolve(stellarDir, 'deployments/testnet.json'), 'utf8'));
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const rendered = renderAddressTable(deployment, 'testnet');
    const rebuilt = replaceMarkedSection(readme, rendered);
    assert.equal(rebuilt, readme);
  });

  test('throws when a required contract address is missing or markers are absent', () => {
    assert.throws(() => renderAddressTable({ contracts: {} }), /Missing contract address/);
    assert.throws(() => replaceMarkedSection('no markers here', '| a |'), new RegExp(BEGIN_MARKER));
    assert.ok(END_MARKER.includes('END:DEPLOYED_ADDRESSES'));
  });
});
