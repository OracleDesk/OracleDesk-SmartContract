/**
 * export-abis.ts — Standalone ABI export
 * Run after forge build to export ABIs without a full redeployment.
 * Useful when you update a contract and need fresh ABIs for the frontend.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const CONTRACTS = [
  "MarketFactory", "PredictionMarket", "TreasuryManager",
  "PositionLedger", "ReasoningRegistry", "MultiSigOracle",
];

function readArtifact(name: string) {
  const p = join("out", `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) throw new Error(`Not found: ${p} — run forge build first`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

async function main() {
  // Always write to artifacts/abis/ — latest ABIs without a version stamp
  const dir = join("artifacts", "abis");
  mkdirSync(dir, { recursive: true });

  const combined: Record<string, any[]> = {};
  let exported = 0;

  for (const name of CONTRACTS) {
    try {
      const artifact = readArtifact(name);
      const abi      = artifact.abi;

      writeFileSync(join(dir, `${name}.json`), JSON.stringify(abi, null, 2));

      // Also export a full artifact (ABI + bytecode) for deployment tools
      const full = { contractName: name, abi, bytecode: artifact.bytecode?.object };
      writeFileSync(join(dir, `${name}.full.json`), JSON.stringify(full, null, 2));

      combined[name] = abi;
      console.log(`  ✓ ${name}`);
      exported++;
    } catch (e: any) {
      console.warn(`  ⚠ Skipped ${name}: ${e.message}`);
    }
  }

  // Combined index for easy import in TypeScript:
  //   import abis from './artifacts/abis/index.json'
  //   const abi = abis.MarketFactory
  writeFileSync(join(dir, "index.json"), JSON.stringify(combined, null, 2));
  console.log(`\n  ✓ Exported ${exported} ABIs to ${dir}/`);
  console.log(`  ✓ Combined index: ${dir}/index.json`);
}

main().catch(console.error);