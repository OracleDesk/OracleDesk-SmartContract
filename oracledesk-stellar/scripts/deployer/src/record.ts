import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ContractMeta {
  wasm_hash: string;
  deployed_ledger: number;
  deploy_tx: string;
}

export interface DeploymentHistoryStep {
  step_id: string;
  kind: string;
  tx_hash?: string;
  ledger?: number;
  at: string;
}

export interface DeploymentRecordV1 {
  deployer?: string;
  agent?: string;
  contracts?: Record<string, string>;
  wired?: boolean;
  agent_registered?: boolean;
  treasury_funded_amount?: string;
  last_deployed_at?: string;
  [extra: string]: unknown;
}

export interface DeploymentRecordV2 extends DeploymentRecordV1 {
  schema: 2;
  network: "testnet";
  deployer: string;
  agent: string;
  contracts: {
    usdc?: string;
    market_core?: string;
    resolver?: string;
    treasury?: string;
    reasoning_registry?: string;
    [extra: string]: string | undefined;
  };
  contracts_meta: Record<string, ContractMeta>;
  history: DeploymentHistoryStep[];
}

export function readRecord(path: string): DeploymentRecordV1 {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecordV1;
}

/**
 * Atomically writes a deployment record using write-temp -> fsync -> rename so
 * a crash or interrupted write never truncates or corrupts `deployments/testnet.json`.
 */
export function writeRecordAtomic(
  path: string,
  record: DeploymentRecordV2,
  options: { simulateCrashBeforeRename?: boolean } = {}
): void {
  const dir = dirname(path);
  const tmpPath = join(dir, `.testnet.json.tmp.${process.pid}.${Date.now()}`);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(tmpPath, payload, "utf8");
  const fd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (options.simulateCrashBeforeRename) {
    throw new Error("Simulated crash before atomic rename");
  }
  renameSync(tmpPath, path);
}

/**
 * Upgrades a v1 deployment record in-place to schema v2 while preserving all
 * v1 top-level keys (`deployer`, `agent`, `contracts.*`, etc.) so existing
 * consumers (`loadDeployments`, `seed-market.sh`, `demo.sh`) work unchanged.
 */
export function migrateV1Record(
  v1: DeploymentRecordV1,
  metaByContract: Record<string, ContractMeta> = {}
): DeploymentRecordV2 {
  const existingMeta =
    v1["contracts_meta"] && typeof v1["contracts_meta"] === "object"
      ? (v1["contracts_meta"] as Record<string, ContractMeta>)
      : {};
  const existingHistory = Array.isArray(v1["history"])
    ? (v1["history"] as DeploymentHistoryStep[])
    : [];

  return {
    ...v1,
    schema: 2,
    network: "testnet",
    deployer: v1.deployer ?? "",
    agent: v1.agent ?? "",
    contracts: { ...(v1.contracts ?? {}) },
    contracts_meta: { ...existingMeta, ...metaByContract },
    history: existingHistory,
  };
}
