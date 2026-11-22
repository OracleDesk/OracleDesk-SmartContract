import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertTestnetPassphrase, type DeploymentManifest } from "./manifest.ts";
import type { DeploymentRecordV1 } from "./record.ts";

export type ContractName = "market_core" | "resolver" | "treasury" | "reasoning_registry";

export type InstanceStatus = "present" | "archived" | "absent";

export interface MarketCoreLiveConfig {
  admin: string;
  collateral: string;
  treasury: string;
  resolver: string;
  default_fee_bps: number;
  paused: boolean;
}

export interface TreasuryLiveConfig {
  admin?: string;
  agent: string;
  collateral: string;
  market_core: string;
  max_trade: string;
  max_market: string;
  max_daily: string;
}

export interface ResolverLiveInstance {
  admin: string;
  market_core: string;
}

export interface ContractLiveState {
  id?: string;
  status: InstanceStatus;
  wasmHash?: string;
}

export interface LiveChainState {
  networkPassphrase: string;
  deployerAddress: string;
  deployerAccountExists: boolean;
  agentAddress: string;
  usdcId?: string;
  usdcStatus: InstanceStatus;
  contracts: Record<ContractName, ContractLiveState>;
  localWasmHashes: Record<ContractName, string>;
  marketCoreConfig?: MarketCoreLiveConfig;
  treasuryConfig?: TreasuryLiveConfig;
  resolverInstance?: ResolverLiveInstance;
  registeredAgents: Record<string, boolean>;
  treasuryBalance?: string;
}

export interface StateProvider {
  readState(manifest: DeploymentManifest, record: DeploymentRecordV1): Promise<LiveChainState>;
}

export function sha256HexFile(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Computes SHA-256 digests of the local release `.wasm` artifacts referenced by
 * the manifest so the planner can detect code drift against on-chain hashes.
 */
export function readLocalWasmHashes(
  manifest: DeploymentManifest,
  baseDir: string
): Record<ContractName, string> {
  const names: ContractName[] = ["market_core", "resolver", "treasury", "reasoning_registry"];
  const out = {} as Record<ContractName, string>;
  for (const name of names) {
    const abs = resolve(baseDir, manifest.contracts[name].wasm);
    out[name] = existsSync(abs) ? sha256HexFile(abs) : "";
  }
  return out;
}

export interface CliStateProviderOptions {
  baseDir: string;
  rpcUrl?: string;
}

/**
 * Reads live state from Stellar testnet RPC and the `stellar` CLI.
 * Enforces the testnet passphrase interlock before returning state.
 */
export class CliStateProvider implements StateProvider {
  private readonly baseDir: string;
  private readonly rpcUrl: string;

  constructor(options: CliStateProviderOptions) {
    this.baseDir = options.baseDir;
    this.rpcUrl = options.rpcUrl ?? "https://soroban-testnet.stellar.org";
  }

  private async rpcCall<T>(method: string, params?: unknown): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
    });
    if (!res.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) {
      throw new Error(`RPC ${method} error: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    return body.result as T;
  }

  private tryStellar(args: string[]): string | undefined {
    try {
      return execFileSync("stellar", args, {
        cwd: this.baseDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return undefined;
    }
  }

  private invokeReadJson<T>(contractId: string, fn: string, extraArgs: string[] = []): T | undefined {
    const raw = this.tryStellar([
      "contract",
      "invoke",
      "--id",
      contractId,
      "--network",
      "testnet",
      "--send=no",
      "--",
      fn,
      ...extraArgs,
    ]);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private inspectInstance(contractId?: string): ContractLiveState {
    if (!contractId) return { status: "absent" };
    const raw = this.tryStellar([
      "contract",
      "read",
      "--id",
      contractId,
      "--network",
      "testnet",
      "--durability",
      "persistent",
      "--output",
      "json",
    ]);
    if (!raw) {
      // Distinguish archived vs absent via RPC health / simulate check when available
      const sim = this.tryStellar([
        "contract",
        "info",
        "meta",
        "--contract-id",
        contractId,
        "--network",
        "testnet",
      ]);
      if (sim && /archived|restore/i.test(sim)) {
        return { id: contractId, status: "archived" };
      }
      return { id: contractId, status: "absent" };
    }
    const wasmHash = this.tryStellar([
      "contract",
      "fetch",
      "--id",
      contractId,
      "--network",
      "testnet",
      "--out-file",
      "/dev/null",
    ]);
    return {
      id: contractId,
      status: "present",
      wasmHash: wasmHash && /^[0-9a-f]{64}$/i.test(wasmHash) ? wasmHash.toLowerCase() : undefined,
    };
  }

  async readState(
    manifest: DeploymentManifest,
    record: DeploymentRecordV1
  ): Promise<LiveChainState> {
    const network = await this.rpcCall<{ passphrase: string }>("getNetwork");
    assertTestnetPassphrase(network.passphrase);

    const deployerAddress =
      this.tryStellar(["keys", "address", manifest.identities.deployer]) ?? record.deployer ?? "";
    const agentAddress =
      this.tryStellar(["keys", "address", manifest.identities.agent]) ?? record.agent ?? "";

    let deployerAccountExists = false;
    if (deployerAddress) {
      try {
        await this.rpcCall("getAccount", { address: deployerAddress });
        deployerAccountExists = true;
      } catch {
        deployerAccountExists = false;
      }
    }

    const usdcId =
      manifest.collateral.kind === "existing"
        ? manifest.collateral.id
        : record.contracts?.["usdc"] ??
          (deployerAddress
            ? this.tryStellar([
                "contract",
                "id",
                "asset",
                "--asset",
                `${manifest.collateral.code}:${deployerAddress}`,
                "--network",
                "testnet",
              ])
            : undefined);

    const usdcState = this.inspectInstance(usdcId);
    const contracts: Record<ContractName, ContractLiveState> = {
      market_core: this.inspectInstance(record.contracts?.["market_core"]),
      resolver: this.inspectInstance(record.contracts?.["resolver"]),
      treasury: this.inspectInstance(record.contracts?.["treasury"]),
      reasoning_registry: this.inspectInstance(record.contracts?.["reasoning_registry"]),
    };

    const marketCoreConfig =
      contracts.market_core.status === "present" && contracts.market_core.id
        ? this.invokeReadJson<MarketCoreLiveConfig>(contracts.market_core.id, "get_config")
        : undefined;

    const treasuryConfig =
      contracts.treasury.status === "present" && contracts.treasury.id
        ? this.invokeReadJson<TreasuryLiveConfig>(contracts.treasury.id, "get_config")
        : undefined;

    // Resolver has no `get_config()` view: read Admin and MarketCore from instance storage.
    let resolverInstance: ResolverLiveInstance | undefined;
    if (contracts.resolver.status === "present" && contracts.resolver.id) {
      const storageJson = this.tryStellar([
        "contract",
        "read",
        "--id",
        contracts.resolver.id,
        "--network",
        "testnet",
        "--durability",
        "persistent",
        "--output",
        "json",
      ]);
      if (storageJson) {
        try {
          const parsed = JSON.parse(storageJson) as Record<string, unknown>;
          const admin = typeof parsed["Admin"] === "string" ? parsed["Admin"] : "";
          const marketCore = typeof parsed["MarketCore"] === "string" ? parsed["MarketCore"] : "";
          if (admin || marketCore) {
            resolverInstance = { admin, market_core: marketCore };
          }
        } catch {
          // leave undefined so verify/plan surfaces inability to read instance storage
        }
      }
    }

    const registeredAgents: Record<string, boolean> = {};
    if (contracts.reasoning_registry.status === "present" && contracts.reasoning_registry.id && agentAddress) {
      const isReg = this.invokeReadJson<boolean>(
        contracts.reasoning_registry.id,
        "is_registered",
        ["--agent", agentAddress]
      );
      registeredAgents[agentAddress] = Boolean(isReg);
    }

    let treasuryBalance: string | undefined;
    if (usdcState.status === "present" && usdcId && contracts.treasury.id) {
      const bal = this.invokeReadJson<string | number>(usdcId, "balance", [
        "--id",
        contracts.treasury.id,
      ]);
      if (bal !== undefined) {
        treasuryBalance = String(bal).replace(/^"|"$/g, "");
      }
    }

    return {
      networkPassphrase: network.passphrase,
      deployerAddress,
      deployerAccountExists,
      agentAddress,
      usdcId,
      usdcStatus: usdcState.status,
      contracts,
      localWasmHashes: readLocalWasmHashes(manifest, this.baseDir),
      marketCoreConfig,
      treasuryConfig,
      resolverInstance,
      registeredAgents,
      treasuryBalance,
    };
  }
}
