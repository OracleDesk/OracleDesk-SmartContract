#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPlan } from "./apply.ts";
import { loadManifest } from "./manifest.ts";
import { computePlan, formatPlanDiff } from "./plan.ts";
import { migrateV1Record, readRecord, writeRecordAtomic, type ContractMeta } from "./record.ts";
import { CliStateProvider, type ContractName } from "./state.ts";
import { formatVerificationReport, verifyDeployment } from "./verify.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(__dirname, "../../..");
const DEFAULT_MANIFEST = resolve(BASE_DIR, "deployments/testnet.manifest.json");
const DEFAULT_RECORD = resolve(BASE_DIR, "deployments/testnet.json");

function parseArgs(argv: string[]): {
  command: string;
  manifestPath: string;
  recordPath: string;
  yes: boolean;
  allowRedeploy: string[];
  rpcUrl?: string;
} {
  const command = argv[0] ?? "plan";
  let manifestPath = DEFAULT_MANIFEST;
  let recordPath = DEFAULT_RECORD;
  let yes = false;
  const allowRedeploy: string[] = [];
  let rpcUrl: string | undefined;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--manifest" && argv[i + 1]) {
      manifestPath = resolve(argv[++i]!);
    } else if (arg === "--record" && argv[i + 1]) {
      recordPath = resolve(argv[++i]!);
    } else if (arg === "--allow-redeploy" && argv[i + 1]) {
      allowRedeploy.push(argv[++i]!);
    } else if (arg === "--rpc-url" && argv[i + 1]) {
      rpcUrl = argv[++i];
    }
  }

  return { command, manifestPath, recordPath, yes, allowRedeploy, rpcUrl };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.manifestPath);
  const provider = new CliStateProvider({ baseDir: BASE_DIR, rpcUrl: args.rpcUrl });
  const record = readRecord(args.recordPath);

  if (args.command === "plan") {
    const state = await provider.readState(manifest, record);
    const plan = computePlan(manifest, state, { allowRedeploy: args.allowRedeploy });
    console.log(formatPlanDiff(plan));
    process.exitCode = plan.exitCode;
    return;
  }

  if (args.command === "apply") {
    await applyPlan(manifest, {
      baseDir: BASE_DIR,
      recordPath: args.recordPath,
      yes: args.yes,
      allowRedeploy: args.allowRedeploy,
      stateProvider: provider,
    });
    return;
  }

  if (args.command === "verify") {
    const state = await provider.readState(manifest, record);
    const result = verifyDeployment(manifest, state);
    console.log(formatVerificationReport(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (args.command === "migrate-record") {
    const state = await provider.readState(manifest, record);
    const meta: Record<string, ContractMeta> = {};
    for (const name of ["market_core", "resolver", "treasury", "reasoning_registry"] as ContractName[]) {
      const live = state.contracts[name];
      if (live.status === "present") {
        meta[name] = {
          wasm_hash: live.wasmHash ?? state.localWasmHashes[name] ?? "",
          deployed_ledger: 0,
          deploy_tx: "",
        };
      }
    }
    const migrated = migrateV1Record(record, meta);
    writeRecordAtomic(args.recordPath, migrated);
    console.log(`Migrated ${args.recordPath} to schema v2.`);
    return;
  }

  console.error(`Unknown command: ${args.command}. Expected: plan | apply | verify | migrate-record`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
