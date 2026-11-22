# Bindings Release Pipeline Implementation Plan

## Overview
Implementation plan for adding a complete release pipeline for `@oracledesk/bindings-*` packages with semantic versioning, changelogs, npm publishing with provenance, and wasm hash tracking.

## Current State Analysis

### Already Implemented ✅
- `scripts/gen-bindings.sh` preserves versions, CHANGELOG.md, and package-lock.json across regeneration
- Interface snapshots extracted to `interface.json` via `scripts/interface-manifest`
- Packages already at v0.1.0 with scoped names (`@oracledesk/bindings-<name>`)
- Six bindings packages: market-core, resolver, reasoning-registry, treasury, timelock, router

### Missing Components ❌
- `package.json` metadata: `files`, `repository`, `license`, `publishConfig`, `keywords`, `oracledesk.wasmSha256`
- Semantic versioning automation based on contract interface diffs
- Changesets integration for version bumps and changelog generation
- Root-level release workflow (`/.github/workflows/release-bindings.yml`)
- Package validation scripts
- Documentation for downstream consumers
- CI job for testing packed tarballs

## Implementation Steps

### 1. Package Metadata Enhancement

**File:** `oracledesk-stellar/scripts/gen-bindings.sh` (modify)

Add metadata merge step after `stellar contract bindings typescript`:

```bash
# After the bindings generation and before the jq .name/.version step:
# Merge in fixed metadata
tmp=$(mktemp)
jq --arg name "@oracledesk/bindings-$pkg_name" \
   --arg v "$old_version" \
   --arg repo "https://github.com/OracleDesk/OracleDesk-SmartContract" \
   --arg lic "Apache-2.0" \
   '. + {
     name: $name,
     version: $v,
     description: "TypeScript bindings for OracleDesk \($name) Stellar contract",
     license: $lic,
     repository: {
       type: "git",
       url: $repo,
       directory: "oracledesk-stellar/packages/bindings/\($name)"
     },
     files: ["dist", "src", "README.md", "interface.json"],
     publishConfig: {
       access: "public",
       provenance: true
     },
     keywords: ["stellar", "soroban", "oracledesk", "smart-contract", "bindings"],
     oracledesk: {
       wasmSha256: "",
       sourceCommit: ""
     }
   }' "$OUT_DIR/$pkg_name/package.json" > "$tmp"
mv "$tmp" "$OUT_DIR/$pkg_name/package.json"
```

### 2. Semantic Version Diff Tool

**File:** `oracledesk-stellar/scripts/bindings-semver.ts` (new)

```typescript
#!/usr/bin/env tsx
/**
 * Classifies contract interface changes as major, minor, or patch according to
 * semver rules. Reads interface.json from the last published package and the
 * freshly built wasm, then outputs a changeset file if the diff is non-empty.
 *
 * For pre-1.0 packages, major changes map to minor (semver 0.x convention).
 *
 * Usage:
 *   tsx scripts/bindings-semver.ts <package-name>
 *   # Outputs .changeset/<hash>.md if interface changed
 */

import { readFileSync } from 'fs';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

interface ContractSpec {
  functions: Array<{ name: string; inputs: any[]; outputs: any[] }>;
  structs: Array<{ name: string; fields: any[] }>;
  enums: Array<{ name: string; cases: any[] }>;
  errors: Array<{ name: string; value: number }>;
  events: Array<{ name: string; fields: any[] }>;
}

type BumpType = 'major' | 'minor' | 'patch' | null;

function loadInterface(path: string): ContractSpec {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function classifyDiff(oldSpec: ContractSpec, newSpec: ContractSpec, currentVersion: string): { bump: BumpType; changes: string[] } {
  const changes: string[] = [];
  let bump: BumpType = null;

  // Check functions
  const oldFuncs = new Map(oldSpec.functions.map(f => [f.name, f]));
  const newFuncs = new Map(newSpec.functions.map(f => [f.name, f]));

  // Removed functions = major
  for (const [name, _] of oldFuncs) {
    if (!newFuncs.has(name)) {
      changes.push(`Removed function: ${name}`);
      bump = 'major';
    }
  }

  // Changed function signatures = major
  for (const [name, newFunc] of newFuncs) {
    const oldFunc = oldFuncs.get(name);
    if (oldFunc && JSON.stringify(oldFunc) !== JSON.stringify(newFunc)) {
      changes.push(`Changed function signature: ${name}`);
      bump = 'major';
    }
  }

  // New functions = minor
  for (const [name, _] of newFuncs) {
    if (!oldFuncs.has(name)) {
      changes.push(`Added function: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check errors
  const oldErrors = new Map(oldSpec.errors.map(e => [e.name, e.value]));
  const newErrors = new Map(newSpec.errors.map(e => [e.name, e.value]));

  for (const [name, oldVal] of oldErrors) {
    const newVal = newErrors.get(name);
    if (newVal !== undefined && newVal !== oldVal) {
      changes.push(`Renumbered error code: ${name}`);
      bump = 'major';
    }
    if (newVal === undefined) {
      changes.push(`Removed error: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newErrors) {
    if (!oldErrors.has(name)) {
      changes.push(`Added error: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check structs (field order matters for hashing per ADR-0001)
  const oldStructs = new Map(oldSpec.structs.map(s => [s.name, s]));
  const newStructs = new Map(newSpec.structs.map(s => [s.name, s]));

  for (const [name, oldStruct] of oldStructs) {
    const newStruct = newStructs.get(name);
    if (!newStruct) {
      changes.push(`Removed struct: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldStruct.fields) !== JSON.stringify(newStruct.fields)) {
      changes.push(`Changed struct fields/order: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newStructs) {
    if (!oldStructs.has(name)) {
      changes.push(`Added struct: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check enums
  const oldEnums = new Map(oldSpec.enums.map(e => [e.name, e]));
  const newEnums = new Map(newSpec.enums.map(e => [e.name, e]));

  for (const [name, oldEnum] of oldEnums) {
    const newEnum = newEnums.get(name);
    if (!newEnum) {
      changes.push(`Removed enum: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldEnum.cases) !== JSON.stringify(newEnum.cases)) {
      changes.push(`Changed enum variants: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newEnums) {
    if (!oldEnums.has(name)) {
      changes.push(`Added enum: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // Check events
  const oldEvents = new Map(oldSpec.events.map(e => [e.name, e]));
  const newEvents = new Map(newSpec.events.map(e => [e.name, e]));

  for (const [name, oldEvent] of oldEvents) {
    const newEvent = newEvents.get(name);
    if (!newEvent) {
      changes.push(`Removed event: ${name}`);
      bump = 'major';
    } else if (JSON.stringify(oldEvent.fields) !== JSON.stringify(newEvent.fields)) {
      changes.push(`Changed event fields: ${name}`);
      bump = 'major';
    }
  }

  for (const [name, _] of newEvents) {
    if (!oldEvents.has(name)) {
      changes.push(`Added event: ${name}`);
      if (!bump || bump === 'patch') bump = 'minor';
    }
  }

  // For pre-1.0 packages, map major → minor (semver 0.x convention)
  if (bump === 'major' && currentVersion.startsWith('0.')) {
    bump = 'minor';
  }

  return { bump, changes };
}

function writeChangeset(packageName: string, bump: BumpType, changes: string[]) {
  const hash = createHash('md5').update(Date.now().toString()).digest('hex').slice(0, 8);
  const changesetDir = '.changeset';
  mkdirSync(changesetDir, { recursive: true });

  const content = `---
"@oracledesk/bindings-${packageName}": ${bump}
---

${changes.map(c => `- ${c}`).join('\n')}
`;

  const filename = `${changesetDir}/${hash}-${packageName}.md`;
  writeFileSync(filename, content);
  console.log(`Created changeset: ${filename}`);
}

// Main
const [, , packageName] = process.argv;
if (!packageName) {
  console.error('Usage: tsx scripts/bindings-semver.ts <package-name>');
  process.exit(1);
}

const oldInterface = loadInterface(`packages/bindings/${packageName}/interface.json`);
const newInterface = loadInterface(`packages/bindings/${packageName}/interface.json`); // TODO: Load from fresh wasm

const packageJson = JSON.parse(readFileSync(`packages/bindings/${packageName}/package.json`, 'utf-8'));
const currentVersion = packageJson.version;

const { bump, changes } = classifyDiff(oldInterface, newInterface, currentVersion);

if (bump && changes.length > 0) {
  writeChangeset(packageName, bump, changes);
} else {
  console.log(`No interface changes detected for ${packageName}`);
}
```

**Note:** The tool above is a skeleton. The actual implementation would need to:
- Load the OLD interface from the last published npm package or committed snapshot
- Load the NEW interface from the freshly extracted interface.json
- Handle all edge cases mentioned in the issue

### 3. Changesets Configuration

**File:** `oracledesk-stellar/.changeset/config.json` (new)

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**File:** `oracledesk-stellar/package.json` (new or modify)

```json
{
  "private": true,
  "workspaces": [
    "packages/bindings/*"
  ],
  "scripts": {
    "changeset": "changeset",
    "version": "changeset version",
    "release": "changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0"
  }
}
```

### 4. Release Workflow

**File:** `/.github/workflows/release-bindings.yml` (new, at repository root)

```yaml
name: Release Bindings

on:
  push:
    branches: [main]
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write
  id-token: write

defaults:
  run:
    working-directory: oracledesk-stellar

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8 # v4.0.2
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Setup Rust toolchain
        uses: dtolnay/rust-toolchain@1482605bfc5719782e1267fd0c0cc350fe7646b8 # v1
        with:
          toolchain: stable
          targets: wasm32-unknown-unknown

      - name: Install Stellar CLI
        run: cargo install --locked stellar-cli --version 27.1.0

      - name: Build contracts
        run: make build

      - name: Regenerate bindings
        run: ./scripts/gen-bindings.sh

      - name: Verify bindings are committed
        run: |
          if ! git diff --exit-code -- packages/bindings; then
            echo "Bindings are out of sync with source. Run ./scripts/gen-bindings.sh and commit." >&2
            exit 1
          fi

      - name: Record wasm hashes
        run: |
          for pkg in market-core resolver reasoning-registry treasury timelock router; do
            wasm_name=$(echo "$pkg" | tr '-' '_')
            hash=$(sha256sum "target/wasm32v1-none/release/${wasm_name}.wasm" | cut -d' ' -f1)
            commit=$(git rev-parse HEAD)
            tmp=$(mktemp)
            jq --arg h "$hash" --arg c "$commit" \
              '.oracledesk.wasmSha256 = $h | .oracledesk.sourceCommit = $c' \
              "packages/bindings/$pkg/package.json" > "$tmp"
            mv "$tmp" "packages/bindings/$pkg/package.json"
          done

      - name: Install dependencies and build
        run: |
          for pkg in market-core resolver reasoning-registry treasury timelock router; do
            (cd "packages/bindings/$pkg" && npm ci && npm run build)
          done

      - name: Create release PR or publish
        id: changesets
        uses: changesets/action@aba318e9165b45b7948c60273e0b72fce0a64eb9 # v1.4.7
        with:
          version: npm run version
          publish: npm run release
          commit: "chore: version packages"
          title: "chore: version bindings packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Tag releases
        if: steps.changesets.outputs.published == 'true'
        run: |
          published='${{ steps.changesets.outputs.publishedPackages }}'
          echo "$published" | jq -c '.[]' | while read -r pkg; do
            name=$(echo "$pkg" | jq -r '.name')
            version=$(echo "$pkg" | jq -r '.version')
            pkg_dir=$(echo "$name" | sed 's/@oracledesk\/bindings-//')
            wasm_hash=$(jq -r '.oracledesk.wasmSha256' "packages/bindings/$pkg_dir/package.json")
            commit=$(jq -r '.oracledesk.sourceCommit' "packages/bindings/$pkg_dir/package.json")
            
            git tag -a "$name@$version" -m "$name@$version

wasm sha256: $wasm_hash
source commit: $commit"
            git push origin "$name@$version"
          done
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 5. Validation Script

**File:** `oracledesk-stellar/scripts/check-bindings-package.ts` (new)

```typescript
#!/usr/bin/env tsx
/**
 * Pre-publish validation for bindings packages.
 * Asserts that dist/ is built, version is not 0.0.0, and wasm hash is set.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const [, , packageName] = process.argv;
if (!packageName) {
  console.error('Usage: tsx scripts/check-bindings-package.ts <package-name>');
  process.exit(1);
}

const pkgDir = `packages/bindings/${packageName}`;
const pkgJson = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf-8'));

// Check version
if (pkgJson.version === '0.0.0') {
  console.error(`❌ ${packageName}: version is 0.0.0`);
  process.exit(1);
}

// Check dist
if (!existsSync(`${pkgDir}/dist/index.js`) || !existsSync(`${pkgDir}/dist/index.d.ts`)) {
  console.error(`❌ ${packageName}: dist/ not built`);
  process.exit(1);
}

// Check wasm hash
if (!pkgJson.oracledesk?.wasmSha256 || pkgJson.oracledesk.wasmSha256 === '') {
  console.error(`❌ ${packageName}: oracledesk.wasmSha256 not set`);
  process.exit(1);
}

console.log(`✅ ${packageName}: ready for publish`);
```

### 6. CI Check for Interface Changes

**File:** `oracledesk-stellar/.github/workflows/bindings-check.yml` (new)

```yaml
name: Bindings Interface Check

on:
  pull_request:
    branches: [develop]
    paths:
      - 'contracts/**'
      - 'packages/bindings/**'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
        with:
          fetch-depth: 0

      - uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8 # v4.0.2
        with:
          node-version: '20'

      - name: Check for changesets
        run: |
          cd oracledesk-stellar
          # If interface.json changed, ensure a changeset exists
          if git diff origin/develop --name-only | grep -q 'packages/bindings/.*/interface.json'; then
            if [ -z "$(ls .changeset/*.md 2>/dev/null | grep -v README)" ]; then
              echo "Interface changes detected but no changeset found"
              echo "Run: npx changeset add"
              exit 1
            fi
          fi
```

### 7. In-Repo Consumer Testing

**File:** `oracledesk-stellar/.github/workflows/test-packed.yml` (new)

```yaml
name: Test Packed Bindings

on:
  pull_request:
    paths:
      - 'packages/bindings/**'
      - 'agents/**'

jobs:
  test-packed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1

      - uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8 # v4.0.2
        with:
          node-version: '20'

      - name: Pack bindings
        run: |
          cd oracledesk-stellar
          for pkg in market-core resolver reasoning-registry treasury timelock router; do
            (cd "packages/bindings/$pkg" && npm ci && npm run build && npm pack)
          done

      - name: Test agents with packed bindings
        run: |
          cd oracledesk-stellar
          # Create scratch copy and install from tarballs
          cp -r agents /tmp/agents-test
          cd /tmp/agents-test
          # Replace file: dependencies with packed tarballs
          # (implementation depends on agents/package.json structure)
          npm ci
          npm run build
```

### 8. Documentation

**File:** `oracledesk-stellar/docs/bindings-releases.md` (new)

```markdown
# Bindings Releases

## Overview

The `@oracledesk/bindings-*` packages provide TypeScript bindings for OracleDesk Stellar smart contracts. Each package is versioned independently according to its contract's interface changes.

## Version Mapping

- **Major (breaking)**: Removed functions, changed signatures, renumbered errors, struct field reordering
- **Minor (additive)**: New functions, new errors, new events, new types
- **Patch (non-breaking)**: Documentation changes, SDK dependency bumps

For pre-1.0 packages, major changes are released as minor (semver 0.x convention).

## Pinning a Version

In your `package.json`:

```json
{
  "dependencies": {
    "@oracledesk/bindings-market-core": "0.3.1",
    "@oracledesk/bindings-treasury": "0.2.5"
  }
}
```

## Verifying Against Deployed Contracts

Each package includes `oracledesk.wasmSha256` in `package.json`:

```json
{
  "oracledesk": {
    "wasmSha256": "abc123...",
    "sourceCommit": "def456..."
  }
}
```

Compare this hash against your deployed contract wasm to ensure the bindings match.

## Changelog

Each package has a `CHANGELOG.md` listing interface changes by version.

## Sync Script Recommendation

**Before (copying from git checkout):**
```bash
cp ../OracleDesk-SmartContract/oracledesk-stellar/packages/bindings/market-core/dist/* ./src/generated/
```

**After (installing pinned version):**
```bash
npm install @oracledesk/bindings-market-core@0.3.1
cp node_modules/@oracledesk/bindings-market-core/dist/* ./src/generated/
```
```

### 9. Bootstrap First Release

**File:** `oracledesk-stellar/.changeset/init-release.md` (new)

```markdown
---
"@oracledesk/bindings-market-core": minor
"@oracledesk/bindings-resolver": minor
"@oracledesk/bindings-reasoning-registry": minor
"@oracledesk/bindings-treasury": minor
"@oracledesk/bindings-timelock": minor
"@oracledesk/bindings-router": minor
---

Initial release of TypeScript bindings with versioning, changelog, and npm provenance.
```

## Testing Strategy

### Unit Tests

**File:** `oracledesk-stellar/scripts/bindings-semver.test.ts`

```typescript
#!/usr/bin/env tsx
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('bindings-semver', () => {
  it('classifies removed function as major', () => {
    // TODO: Test with fixture specs
  });

  it('classifies new function as minor', () => {
    // TODO
  });

  it('classifies struct field reorder as major', () => {
    // TODO
  });

  it('classifies new error code as minor', () => {
    // TODO
  });

  it('classifies renumbered error as major', () => {
    // TODO
  });

  it('maps pre-1.0 major to minor', () => {
    // TODO
  });
});
```

### Integration Tests

1. Run `scripts/gen-bindings.sh` twice, assert version/metadata preserved
2. Run `scripts/check-bindings-package.ts` on a valid and invalid package
3. Dry-run workflow with `act` against local Verdaccio registry

## File Summary

### New Files
- `/.github/workflows/release-bindings.yml` - Main release workflow
- `oracledesk-stellar/.changeset/config.json` - Changesets config
- `oracledesk-stellar/.changeset/init-release.md` - Bootstrap changeset
- `oracledesk-stellar/scripts/bindings-semver.ts` - Interface diff classifier
- `oracledesk-stellar/scripts/bindings-semver.test.ts` - Tests
- `oracledesk-stellar/scripts/check-bindings-package.ts` - Pre-publish validation
- `oracledesk-stellar/.github/workflows/bindings-check.yml` - PR check
- `oracledesk-stellar/.github/workflows/test-packed.yml` - Packaging test
- `oracledesk-stellar/docs/bindings-releases.md` - Documentation
- `oracledesk-stellar/package.json` - Workspace config

### Modified Files
- `oracledesk-stellar/scripts/gen-bindings.sh` - Add metadata merge step

## Next Steps

1. ✅ Review this implementation plan
2. Implement metadata merge in `gen-bindings.sh`
3. Create `bindings-semver.ts` with full interface diff logic
4. Set up Changesets configuration
5. Create release workflow
6. Add validation and testing scripts
7. Write documentation
8. Bootstrap first release with changeset
9. Test workflow dry-run on fork
10. Submit PR to `develop` branch

## Notes

- **PR Target:** This PR must be opened against `develop`, not `main`
- **NPM_TOKEN:** Required in repository secrets for publishing
- **Provenance:** Requires public repository and supported GitHub runner
- **Pre-1.0:** All packages currently at 0.x, so major changes map to minor bumps
- **Six Packages:** Issue mentions four, but repository has six (market-core, resolver, reasoning-registry, treasury, timelock, router)

---

Closes #118
