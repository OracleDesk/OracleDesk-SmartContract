import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertTestnetPassphrase, type DeploymentManifest } from "./manifest.ts";
import { computePlan, formatPlanDiff, resolveRef, type PlanStep } from "./plan.ts";
import { migrateV1Record, readRecord, writeRecordAtomic, type DeploymentRecordV2 } from "./record.ts";
import { sha256HexFile, type ContractName, type LiveChainState, type StateProvider } from "./state.ts";
import { formatVerificationReport, verifyDeployment } from "./verify.ts";

export interface ApplyOptions {
  baseDir: string;
  recordPath: string;
  yes: boolean;
  allowRedeploy?: string[];
  stateProvider: StateProvider;
  executor?: StepExecutor;
}

export interface StepResult {
  contractId?: string;
  txHash?: string;
  ledger?: number;
}

export interface StepExecutor {
  execute(
    step: PlanStep,
    manifest: DeploymentManifest,
    record: DeploymentRecordV2,
    state: LiveChainState
  ): Promise<StepResult>;
}

/**
 * Executes deployment steps via the Stellar CLI using the configured testnet
 * identity name. Secret keys are never logged or written to disk.
 */
export class CliStepExecutor implements StepExecutor {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private runStellar(args: string[]): string {
    return execFileSync("stellar", args, {
      cwd: this.baseDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  async execute(
    step: PlanStep,
    manifest: DeploymentManifest,
    record: DeploymentRecordV2,
    state: LiveChainState
  ): Promise<StepResult> {
    assertTestnetPassphrase(state.networkPassphrase);
    const deployerKey = manifest.identities.deployer;

    const refCtx = {
      deployer: record.deployer || state.deployerAddress,
      agent: record.agent || state.agentAddress,
      usdc: record.contracts.usdc ?? state.usdcId,
      contracts: {
        market_core: record.contracts.market_core,
        resolver: record.contracts.resolver,
        treasury: record.contracts.treasury,
        reasoning_registry: record.contracts.reasoning_registry,
      },
    };

    if (step.kind === "fund-identity") {
      this.runStellar(["keys", "fund", deployerKey, "--network", "testnet"]);
      return {};
    }

    if (step.kind === "restore") {
      this.runStellar([
        "contract",
        "restore",
        "--id",
        step.target,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
      ]);
      return {};
    }

    if (step.kind === "deploy" && step.target === "usdc") {
      const id = this.runStellar([
        "contract",
        "asset",
        "deploy",
        "--asset",
        `${manifest.collateral.kind === "self-issued" ? manifest.collateral.code : "USDC"}:${refCtx.deployer}`,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
      ]);
      return { contractId: id };
    }

    if (step.kind === "deploy") {
      const name = step.target as ContractName;
      const spec = manifest.contracts[name];
      const cliArgs = [
        "contract",
        "deploy",
        "--wasm",
        resolve(this.baseDir, spec.wasm),
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
      ];
      for (const [k, v] of Object.entries(spec.args)) {
        const resolved = typeof v === "string" ? resolveRef(v, refCtx) : String(v);
        cliArgs.push(`--${k}`, resolved);
      }
      const id = this.runStellar(cliArgs);
      return { contractId: id };
    }

    if (step.kind === "invoke" && step.id === "set-resolver") {
      const mc = record.contracts.market_core!;
      const resolver = record.contracts.resolver!;
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        mc,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "propose_resolver",
        "--resolver",
        resolver,
      ]);
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        resolver,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "accept_market_core_role",
      ]);
      return {};
    }

    if (step.kind === "invoke" && step.id === "set-treasury") {
      const mc = record.contracts.market_core!;
      const treasury = record.contracts.treasury!;
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        mc,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "propose_treasury",
        "--treasury",
        treasury,
      ]);
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        treasury,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "accept_market_core_role",
      ]);
      return {};
    }

    if (step.kind === "register") {
      const agent = String(step.details?.["agent"] ?? refCtx.agent);
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        record.contracts.reasoning_registry!,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "register_agent",
        "--agent",
        agent,
      ]);
      return {};
    }

    if (step.kind === "mint") {
      const amount = String(step.details?.["amount"] ?? manifest.funding.treasury_min_balance);
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        record.contracts.usdc!,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "mint",
        "--to",
        refCtx.deployer,
        "--amount",
        amount,
      ]);
      this.runStellar([
        "contract",
        "invoke",
        "--id",
        record.contracts.treasury!,
        "--source-account",
        deployerKey,
        "--network",
        "testnet",
        "--",
        "deposit",
        "--from",
        refCtx.deployer,
        "--amount",
        amount,
      ]);
      return {};
    }

    return {};
  }
}

/**
 * Applies a deployment plan step-by-step, writing progress atomically to the v2
 * deployment record after every step so interrupted runs resume cleanly.
 */
export async function applyPlan(
  manifest: DeploymentManifest,
  options: ApplyOptions
): Promise<{ applied: number; verified: boolean }> {
  const rawRecord = readRecord(options.recordPath);
  const initialState = await options.stateProvider.readState(manifest, rawRecord);
  const plan = computePlan(manifest, initialState, { allowRedeploy: options.allowRedeploy });

  console.log(formatPlanDiff(plan));

  if (plan.blocked) {
    throw new Error("Deployment plan is blocked; resolve blocked steps before applying.");
  }
  if (plan.steps.length === 0) {
    return { applied: 0, verified: true };
  }
  if (!options.yes) {
    throw new Error("Refusing to apply without --yes flag.");
  }

  const record: DeploymentRecordV2 = migrateV1Record(rawRecord);
  record.deployer = initialState.deployerAddress || record.deployer;
  record.agent = initialState.agentAddress || record.agent;

  const executor = options.executor ?? new CliStepExecutor(options.baseDir);
  let applied = 0;

  for (const step of plan.steps) {
    if (step.kind === "manual") {
      console.warn(`Manual action required: ${step.reason}`);
      continue;
    }

    const result = await executor.execute(step, manifest, record, initialState);
    const now = new Date().toISOString();

    if (step.kind === "deploy" && result.contractId) {
      record.contracts[step.target] = result.contractId;
      if (step.target !== "usdc") {
        const wasmPath = resolve(options.baseDir, manifest.contracts[step.target as ContractName].wasm);
        record.contracts_meta[step.target] = {
          wasm_hash: initialState.localWasmHashes[step.target as ContractName] || sha256HexFile(wasmPath),
          deployed_ledger: result.ledger ?? 0,
          deploy_tx: result.txHash ?? "",
        };
      }
    } else if (step.id === "set-resolver" || step.id === "set-treasury") {
      record.wired = true;
    } else if (step.kind === "register") {
      record.agent_registered = true;
    } else if (step.kind === "mint") {
      record.treasury_funded_amount = manifest.funding.treasury_min_balance;
    }

    record.last_deployed_at = now;
    record.history.push({
      step_id: step.id,
      kind: step.kind,
      tx_hash: result.txHash,
      ledger: result.ledger,
      at: now,
    });

    // Atomic checkpoint after every step for crash-safe resumption.
    writeRecordAtomic(options.recordPath, record);
    applied += 1;
  }

  const postState = await options.stateProvider.readState(manifest, record);
  const verification = verifyDeployment(manifest, postState);
  console.log(formatVerificationReport(verification));
  if (!verification.ok) {
    throw new Error("Post-apply verification failed.");
  }
  return { applied, verified: true };
}
