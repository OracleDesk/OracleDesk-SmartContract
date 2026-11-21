#!/usr/bin/env node
/**
 * Deterministically renders the root README "Deployed Contract Addresses" table
 * from `oracledesk-stellar/deployments/testnet.json` between marker comments (#130).
 *
 * Usage:
 *   node scripts/render-addresses.mjs --check   # exits 1 if README differs
 *   node scripts/render-addresses.mjs --write   # rewrites README in place
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BEGIN_MARKER = '<!-- BEGIN:DEPLOYED_ADDRESSES -->';
export const END_MARKER = '<!-- END:DEPLOYED_ADDRESSES -->';

const ROWS = [
  { key: 'market_core', label: 'market-core' },
  { key: 'resolver', label: 'resolver' },
  { key: 'treasury', label: 'treasury' },
  { key: 'reasoning_registry', label: 'reasoning-registry' },
  { key: 'usdc', label: 'USDC (self-issued test asset)' },
];

export function renderAddressTable(deployment, network = 'testnet') {
  const contracts = deployment?.contracts ?? {};
  const lines = ['| Contract | Address | Explorer |', '|---|---|---|'];
  for (const row of ROWS) {
    const addr = contracts[row.key];
    if (!addr) {
      throw new Error(`Missing contract address for "${row.key}" in deployment record`);
    }
    lines.push(
      `| ${row.label} | \`${addr}\` | [View](https://stellar.expert/explorer/${network}/contract/${addr}) |`
    );
  }
  return lines.join('\n');
}

export function replaceMarkedSection(readmeContent, tableMarkdown) {
  const startIdx = readmeContent.indexOf(BEGIN_MARKER);
  const endIdx = readmeContent.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README is missing ${BEGIN_MARKER} ... ${END_MARKER} markers`);
  }
  const before = readmeContent.slice(0, startIdx + BEGIN_MARKER.length);
  const after = readmeContent.slice(endIdx);
  return `${before}\n${tableMarkdown}\n${after}`;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--write') ? 'write' : 'check';
  const stellarDir = resolve(__dirname, '..');
  const repoRoot = resolve(stellarDir, '..');
  const deploymentPath = resolve(stellarDir, 'deployments/testnet.json');
  const readmePath = resolve(repoRoot, 'README.md');

  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  const currentReadme = readFileSync(readmePath, 'utf8');
  const expectedTable = renderAddressTable(deployment, 'testnet');
  const updatedReadme = replaceMarkedSection(currentReadme, expectedTable);

  if (mode === 'write') {
    writeFileSync(readmePath, updatedReadme, 'utf8');
    console.log('Updated README.md deployed contract address table from deployments/testnet.json.');
    return;
  }

  if (currentReadme !== updatedReadme) {
    console.error(
      'ERROR: README.md deployed contract address table does not match deployments/testnet.json.\n' +
        'Run: node oracledesk-stellar/scripts/render-addresses.mjs --write'
    );
    process.exit(1);
  }

  console.log('OK: README.md deployed contract address table matches deployments/testnet.json.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
