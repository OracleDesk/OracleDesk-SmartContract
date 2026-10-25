/**
 * Typed, validated agent configuration (#107). Every agent entrypoint calls
 * `loadAgentConfig()` instead of reading `process.env`, so a bad value fails
 * startup with every problem listed at once, before any RPC call is made.
 *
 * Order of checks:
 *   1. environment variables (EnvSchema), strictly parsed;
 *   2. the deployment record (DeploymentsSchema), its network, and the
 *      documented *_CONTRACT_ID overrides;
 *   3. the signing key (live only) against the deployment's agent address;
 *   4. the mainnet interlock;
 *   5. network probes: RPC passphrase and contract instances. Mandatory in
 *      live mode, best effort in dry-run, skipped by --offline (dry-run only)
 *      and by --print-config.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import { ConfigError, type AgentMode } from "../runtime/config.js";
import type { AgentRole, Deployments } from "../stellar/adapter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Canonical passphrase and default RPC for each supported network. Mainnet
 * has no default RPC on purpose: pointing an agent at real funds must be an
 * explicit choice. */
export const NETWORKS = {
  testnet: { passphrase: "Test SDF Network ; September 2015", rpcUrl: "https://soroban-testnet.stellar.org" },
  futurenet: { passphrase: "Test SDF Future Network ; October 2022", rpcUrl: "https://rpc-futurenet.stellar.org" },
  local: { passphrase: "Standalone Network ; February 2017", rpcUrl: "http://localhost:8000/soroban/rpc" },
  mainnet: { passphrase: "Public Global Stellar Network ; September 2015", rpcUrl: undefined },
} as const;

export type NetworkName = keyof typeof NETWORKS;
const NETWORK_NAMES = Object.keys(NETWORKS) as [NetworkName, ...NetworkName[]];

/** Exact value AGENT_ALLOW_MAINNET must hold before mainnet is allowed. */
export const MAINNET_OPT_IN = "I_ACCEPT_REAL_FUNDS_";

/** Largest amount a contract i128 can hold. */
export const MAX_STROOPS = (1n << 127n) - 1n;
/** 100 USDC: the smallest seed a new market may be opened with. */
export const MIN_SEED_STROOPS = 1_000_000_000n;
const BPS_MAX = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Documented contract id overrides, applied after the deployment record is validated. */
export const CONTRACT_OVERRIDES = {
  USDC_CONTRACT_ID: "usdc",
  MARKET_CORE_CONTRACT_ID: "market_core",
  RESOLVER_CONTRACT_ID: "resolver",
  TREASURY_CONTRACT_ID: "treasury",
  REASONING_REGISTRY_CONTRACT_ID: "reasoning_registry",
} as const satisfies Record<string, keyof Deployments["contracts"]>;

/** Thrown for any invalid configuration. `issues` holds every problem found. */
export class AgentConfigError extends ConfigError {
  constructor(readonly issues: string[]) {
    super(`invalid agent configuration:\n  - ${issues.join("\n  - ")}`);
  }
}

// ─── Field parsers ───────────────────────────────────────────────────────────
// Unset (undefined) takes the default. A set value, including "", must parse.

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function intField(fallback: number | undefined, min: number, max: number) {
  return z.string().optional().transform((raw, ctx): number | undefined => {
    if (raw === undefined) return fallback;
    const n = DECIMAL.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: `must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}` });
      return z.NEVER;
    }
    return n;
  });
}

const bpsField = (fallback?: number) => intField(fallback, 0, BPS_MAX);

function stroopsField(fallback: bigint, min = 1n) {
  return z.string().optional().transform((raw, ctx): bigint => {
    if (raw === undefined) return fallback;
    if (!DECIMAL.test(raw)) {
      ctx.addIssue({ code: "custom", message: `must be a whole number of stroops, got ${JSON.stringify(raw)}` });
      return z.NEVER;
    }
    const n = BigInt(raw);
    if (n < min || n > MAX_STROOPS) {
      ctx.addIssue({ code: "custom", message: `must be from ${min} to ${MAX_STROOPS} stroops, got ${raw}` });
      return z.NEVER;
    }
    return n;
  });
}

/** Secrets and contract ids may be left blank (the .env.example template ships
 * them empty); blank means unset. Anything else must be a valid StrKey. */
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const secretField = z.preprocess(
  blankToUndefined,
  z.string().refine((v) => StrKey.isValidEd25519SecretSeed(v), "must be an S... secret key").optional(),
);
const contractIdField = z.preprocess(
  blankToUndefined,
  z.string().refine((v) => StrKey.isValidContract(v), "must be a C... contract id").optional(),
);
const nonEmptyPath = z.string().min(1, "must not be empty").optional();

export const EnvSchema = z.object({
  AGENT_MODE: z.enum(["dry-run", "live"], { error: (i) => `must be "dry-run" or "live", got ${JSON.stringify(i.input)}` }).default("dry-run"),
  STELLAR_NETWORK: z.enum(NETWORK_NAMES, { error: (i) => `must be one of ${NETWORK_NAMES.join(", ")}, got ${JSON.stringify(i.input)}` }).default("testnet"),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1, "must not be empty").optional(),
  STELLAR_RPC_URL: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }).optional(),
  AGENT_SECRET_KEY: secretField,
  MAKER_SECRET_KEY: secretField,
  TRADER_SECRET_KEY: secretField,
  DEPLOYMENTS_FILE: nonEmptyPath,
  DEPLOYMENTS_PATH: nonEmptyPath,
  TRACE_STORE_DIR: nonEmptyPath,
  MIN_EDGE_BPS: bpsField(500),
  CONFIDENCE_THRESHOLD_BPS: bpsField(1000),
  SLIPPAGE_BPS: bpsField(50),
  FAIR_VALUE_BPS: bpsField(undefined),
  TRADE_SIZE_STROOPS: stroopsField(100_000_000n),
  DEFAULT_SEED_STROOPS: stroopsField(1_500_000_000n, MIN_SEED_STROOPS),
  DEADLINE_SECS: intField(60, 1, 86_400),
  MARKET_CLOSE_IN_SECS: intField(3600, 1, 365 * 86_400),
  AGENT_STARTUP_PROBE_TIMEOUT_MS: intField(DEFAULT_PROBE_TIMEOUT_MS, 1, 600_000),
  AGENT_ALLOW_MAINNET: z.string().optional(),
  EVENTS_STATE_DIR: nonEmptyPath,
  EVENTS_TRADE_THRESHOLD: stroopsField(500_000_000n),
  EVENTS_POLL_INTERVAL_MS: intField(10_000, 100, 3_600_000),
  EVENTS_PAGE_LIMIT: intField(100, 1, 10_000),
  EVENTS_CONCURRENCY: intField(4, 1, 64),
  EVENTS_MAX_ATTEMPTS: intField(5, 1, 100),
  EVENTS_DISPUTE_WINDOW_SECS: intField(600, 0, 30 * 86_400),
  ARB_ENABLED: z.enum(["0", "1", "false", "true"], { error: (i) => `must be 0, 1, false or true, got ${JSON.stringify(i.input)}` }).default("0"),
  ARB_RELATIONS_FILE: nonEmptyPath,
  ARB_JOURNAL_FILE: nonEmptyPath,
  ARB_MAX_NOTIONAL: stroopsField(1_000_000_000n),
  ARB_MIN_PROFIT_STROOPS: stroopsField(1_000_000n, 0n),
  ARB_MIN_PROFIT_BPS: bpsField(50),
  ARB_MAX_UNHEDGED_STROOPS: stroopsField(500_000_000n),
  ARB_MARKET_HEADROOM_BPS: intField(2_000, 0, 9_999),
  ARB_MAX_LEG_LOSS: stroopsField(10_000_000n, 0n),
  ARB_MAX_OPEN_LEGS: intField(2, 2, 64),
  ARB_MAX_UNWIND_RETRIES: intField(3, 1, 20),
  USDC_CONTRACT_ID: contractIdField,
  MARKET_CORE_CONTRACT_ID: contractIdField,
  RESOLVER_CONTRACT_ID: contractIdField,
  TREASURY_CONTRACT_ID: contractIdField,
  REASONING_REGISTRY_CONTRACT_ID: contractIdField,
});
export type ParsedEnv = z.output<typeof EnvSchema>;

const publicKey = z.string().refine((v) => StrKey.isValidEd25519PublicKey(v), "must be a G... public key");
const contractId = z.string().refine((v) => StrKey.isValidContract(v), "must be a C... contract id");

/** A deployment record (deployments/<network>.json). Extra metadata keys are kept. */
export const DeploymentsSchema = z.looseObject({
  network: z.enum(NETWORK_NAMES).optional(),
  deployer: publicKey,
  agent: publicKey,
  agents: z.object({ maker: publicKey, trader: publicKey }).optional(),
  contracts: z.looseObject({
    usdc: contractId,
    market_core: contractId,
    resolver: contractId,
    treasury: contractId,
    reasoning_registry: contractId,
  }),
  wired: z.boolean().optional(),
  agent_registered: z.boolean().optional(),
  treasury_funded_amount: z.string().regex(DECIMAL, "must be a whole number of stroops").optional(),
  last_deployed_at: z.string().optional(),
});
export type ValidatedDeployments = Deployments & { network?: NetworkName };

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`);
}

// ─── Probes ──────────────────────────────────────────────────────────────────

export interface ContractsReport {
  /** No instance entry on the ledger: never deployed here, or a reset network. */
  missing: string[];
  /** Instance entry exists but its TTL has lapsed; restore it before use. */
  archived: string[];
}

/** Network checks run at startup. Injected so tests never touch the network. */
export interface NetworkProbe {
  passphrase(rpcUrl: string): Promise<string>;
  contractsExist(rpcUrl: string, ids: string[]): Promise<ContractsReport>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The real probe: Soroban RPC `getNetwork` and contract-instance ledger entries. */
export function rpcNetworkProbe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): NetworkProbe {
  const server = (url: string) => new rpc.Server(url, { allowHttp: url.startsWith("http://") });
  return {
    async passphrase(rpcUrl) {
      return (await withTimeout(server(rpcUrl).getNetwork(), timeoutMs, "getNetwork")).passphrase;
    },
    async contractsExist(rpcUrl, ids) {
      const s = server(rpcUrl);
      const keys = ids.map((id) =>
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(id).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
          }),
        ),
      );
      const [{ entries }, latest] = await withTimeout(
        Promise.all([s.getLedgerEntries(...keys), s.getLatestLedger()]),
        timeoutMs,
        "getLedgerEntries",
      );
      const live = new Map<string, number | undefined>();
      for (const e of entries) {
        live.set(Address.fromScAddress(e.key.contractData().contract()).toString(), e.liveUntilLedgerSeq);
      }
      return {
        missing: ids.filter((id) => !live.has(id)),
        archived: ids.filter((id) => {
          const until = live.get(id);
          return until !== undefined && until < latest.sequence;
        }),
      };
    },
  };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export interface TradingConfig {
  minEdgeBps: number;
  tradeSizeStroops: bigint;
  slippageBps: number;
  deadlineSecs: number;
  /** Fixed fair-value override; unset means each market's own price. */
  fairValueBps?: number;
}

/** Event-driven triggers (#105), used by `trader --follow`. */
export interface EventsConfig {
  stateDir: string;
  tradeThresholdStroops: bigint;
  pollIntervalMs: number;
  pageLimit: number;
  concurrency: number;
  maxAttempts: number;
  /** Dispute window assumed for alerts, seconds. */
  disputeWindowSecs: number;
}

/** Cross-market arbitrage (#108); off unless ARB_ENABLED. */
export interface ArbConfig {
  enabled: boolean;
  relationsFile?: string;
  journalFile: string;
  maxNotional: bigint;
  minProfit: bigint;
  minProfitBps: bigint;
  maxUnhedged: bigint;
  marketHeadroomBps: bigint;
  maxLegLoss: bigint;
  maxOpenLegs: number;
  maxUnwindRetries: number;
}

export interface MakerConfig {
  confidenceThresholdBps: number;
  defaultSeedStroops: bigint;
  closeInSecs: number;
}

/** The settings a trader or maker run needs that do not depend on a deployment. */
export interface Tunables {
  rpcUrl: string;
  traceStoreDir: string;
  trading: TradingConfig;
  maker: MakerConfig;
  events: EventsConfig;
  arb: ArbConfig;
  /** Runtime knobs (lease, state file, backoff, trace store selection) still
   * read by runtime/wiring.ts. Never printed: it may hold secrets. */
  env: NodeJS.ProcessEnv;
}

export interface AgentConfig extends Tunables {
  role: AgentRole;
  mode: AgentMode;
  network: NetworkName;
  networkPassphrase: string;
  /** Present only in live mode. Dry-run never carries the secret. */
  agentSecret?: string;
  /** Address the agent acts as: the secret's public key in live mode. */
  agentAddress: string;
  deployments: ValidatedDeployments;
  deploymentsFile: string;
  contractOverrides: { variable: string; contract: keyof Deployments["contracts"]; from: string; to: string }[];
  probeTimeoutMs: number;
  offline: boolean;
  printConfig: boolean;
}

export interface LoadAgentConfigOptions {
  role: AgentRole;
  env?: NodeJS.ProcessEnv;
  /** CLI arguments; --offline and --print-config are recognised. */
  argv?: string[];
  probe?: NetworkProbe;
  readFile?: (path: string) => string;
  /** Where overrides and dry-run probe warnings are reported. */
  log?: (message: string) => void;
}

/**
 * Parses only the deployment-independent settings. Offline and side-effect
 * free; loadAgentConfig() uses it, and tests can build a run config with it.
 */
export function parseTunables(env: NodeJS.ProcessEnv): Tunables {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new AgentConfigError(formatIssues("", parsed.error));
  return tunablesFrom(parsed.data, env);
}

function tunablesFrom(e: ParsedEnv, env: NodeJS.ProcessEnv): Tunables {
  return {
    rpcUrl: e.STELLAR_RPC_URL ?? NETWORKS[e.STELLAR_NETWORK].rpcUrl ?? "",
    traceStoreDir: e.TRACE_STORE_DIR ?? "./.traces",
    trading: {
      minEdgeBps: e.MIN_EDGE_BPS!,
      tradeSizeStroops: e.TRADE_SIZE_STROOPS,
      slippageBps: e.SLIPPAGE_BPS!,
      deadlineSecs: e.DEADLINE_SECS!,
      fairValueBps: e.FAIR_VALUE_BPS,
    },
    maker: {
      confidenceThresholdBps: e.CONFIDENCE_THRESHOLD_BPS!,
      defaultSeedStroops: e.DEFAULT_SEED_STROOPS,
      closeInSecs: e.MARKET_CLOSE_IN_SECS!,
    },
    events: {
      stateDir: e.EVENTS_STATE_DIR ?? "./.events",
      tradeThresholdStroops: e.EVENTS_TRADE_THRESHOLD,
      pollIntervalMs: e.EVENTS_POLL_INTERVAL_MS!,
      pageLimit: e.EVENTS_PAGE_LIMIT!,
      concurrency: e.EVENTS_CONCURRENCY!,
      maxAttempts: e.EVENTS_MAX_ATTEMPTS!,
      disputeWindowSecs: e.EVENTS_DISPUTE_WINDOW_SECS!,
    },
    arb: {
      enabled: e.ARB_ENABLED === "1" || e.ARB_ENABLED === "true",
      relationsFile: e.ARB_RELATIONS_FILE,
      journalFile: e.ARB_JOURNAL_FILE ?? "./.arb/journal.jsonl",
      maxNotional: e.ARB_MAX_NOTIONAL,
      minProfit: e.ARB_MIN_PROFIT_STROOPS,
      minProfitBps: BigInt(e.ARB_MIN_PROFIT_BPS!),
      maxUnhedged: e.ARB_MAX_UNHEDGED_STROOPS,
      marketHeadroomBps: BigInt(e.ARB_MARKET_HEADROOM_BPS!),
      maxLegLoss: e.ARB_MAX_LEG_LOSS,
      maxOpenLegs: e.ARB_MAX_OPEN_LEGS!,
      maxUnwindRetries: e.ARB_MAX_UNWIND_RETRIES!,
    },
    env,
  };
}

/** Every unmet mainnet condition, empty when mainnet is fully opted into. */
export function mainnetInterlock(e: ParsedEnv, deploymentsFile: string, deployments?: { network?: string }): string[] {
  const unmet: string[] = [];
  const passphrase = e.STELLAR_NETWORK_PASSPHRASE ?? NETWORKS.mainnet.passphrase;
  if (passphrase !== NETWORKS.mainnet.passphrase) unmet.push(`STELLAR_NETWORK_PASSPHRASE must be "${NETWORKS.mainnet.passphrase}"`);
  if (basename(deploymentsFile) === "testnet.json") unmet.push(`deployment file must not be testnet.json (got ${deploymentsFile})`);
  if (deployments?.network !== "mainnet") unmet.push(`deployment record must declare "network": "mainnet"`);
  if (e.AGENT_ALLOW_MAINNET !== MAINNET_OPT_IN) unmet.push(`AGENT_ALLOW_MAINNET must be exactly ${MAINNET_OPT_IN}`);
  if (!e.STELLAR_RPC_URL) unmet.push("STELLAR_RPC_URL must be set explicitly (mainnet has no default)");
  return unmet.map((m) => `mainnet refused: ${m}`);
}

export async function loadAgentConfig(o: LoadAgentConfigOptions): Promise<AgentConfig> {
  const env = o.env ?? process.env;
  const argv = o.argv ?? process.argv.slice(2);
  const log = o.log ?? ((m: string) => console.warn(m));
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const offline = argv.includes("--offline");
  const printConfig = argv.includes("--print-config");
  const issues: string[] = [];

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new AgentConfigError(formatIssues("", parsed.error));
  const e = parsed.data;
  const mode: AgentMode = e.AGENT_MODE;
  const network = e.STELLAR_NETWORK;
  const canonical = NETWORKS[network].passphrase;
  if (e.STELLAR_NETWORK_PASSPHRASE !== undefined && e.STELLAR_NETWORK_PASSPHRASE !== canonical) {
    issues.push(`STELLAR_NETWORK_PASSPHRASE "${e.STELLAR_NETWORK_PASSPHRASE}" does not match STELLAR_NETWORK=${network} ("${canonical}")`);
  }
  if (offline && mode === "live") issues.push("--offline is only allowed in dry-run: live mode must verify the network first");
  if ((e.ARB_ENABLED === "1" || e.ARB_ENABLED === "true") && !e.ARB_RELATIONS_FILE) issues.push("ARB_ENABLED needs ARB_RELATIONS_FILE");

  // Deployment record.
  if (e.DEPLOYMENTS_FILE && e.DEPLOYMENTS_PATH && e.DEPLOYMENTS_FILE !== e.DEPLOYMENTS_PATH) {
    issues.push(`DEPLOYMENTS_FILE (${e.DEPLOYMENTS_FILE}) and DEPLOYMENTS_PATH (${e.DEPLOYMENTS_PATH}) disagree; set one`);
  }
  const deploymentsFile = e.DEPLOYMENTS_FILE ?? e.DEPLOYMENTS_PATH ?? join(REPO_ROOT, "deployments", `${network}.json`);
  let deployments: ValidatedDeployments | undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(deploymentsFile));
  } catch (err) {
    issues.push(`cannot read deployment record ${deploymentsFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw !== undefined) {
    const d = DeploymentsSchema.safeParse(raw);
    if (!d.success) {
      const missing = d.error.issues.filter((i) => i.path[0] === "contracts" && i.code === "invalid_type").map((i) => i.path.join("."));
      if (missing.length > 0) {
        issues.push(`deployment record ${deploymentsFile} is stale: missing ${missing.join(", ")}. Re-run scripts/deploy-testnet.sh or point DEPLOYMENTS_FILE at a current record`);
      }
      issues.push(...formatIssues(`${basename(deploymentsFile)}: `, d.error).filter((m) => !missing.some((p) => m.includes(`${p}:`))));
    } else {
      deployments = structuredClone(d.data) as ValidatedDeployments;
      const declared = deployments.network ?? "testnet";
      if (declared !== network) {
        issues.push(`deployment record ${deploymentsFile} is for ${declared}${deployments.network ? "" : " (no network field, assumed testnet)"}, but STELLAR_NETWORK=${network}`);
      }
    }
  }

  const contractOverrides: AgentConfig["contractOverrides"] = [];
  if (deployments) {
    for (const [variable, contract] of Object.entries(CONTRACT_OVERRIDES) as [keyof typeof CONTRACT_OVERRIDES, keyof Deployments["contracts"]][]) {
      const to = e[variable];
      if (to === undefined) continue;
      const from = deployments.contracts[contract];
      contractOverrides.push({ variable, contract, from, to });
      deployments.contracts[contract] = to;
      log(`[config] ${variable} overrides contracts.${contract}: ${from} -> ${to}`);
    }
  }

  // Signing identity. Each role prefers its own key and registered address.
  const roleSecret = o.role === "maker" ? e.MAKER_SECRET_KEY : e.TRADER_SECRET_KEY;
  const secret = roleSecret ?? e.AGENT_SECRET_KEY;
  const expected = deployments ? deployments.agents?.[o.role] ?? deployments.agent : undefined;
  let agentAddress = expected ?? "";
  if (mode === "live") {
    if (!secret) {
      issues.push(`live mode needs ${o.role === "maker" ? "MAKER_SECRET_KEY" : "TRADER_SECRET_KEY"} or AGENT_SECRET_KEY`);
    } else {
      const pub = Keypair.fromSecret(secret).publicKey();
      if (expected && pub !== expected) {
        issues.push(`signing key ${pub} does not match the deployment's ${deployments?.agents?.[o.role] ? `agents.${o.role}` : "agent"} ${expected}`);
      }
      agentAddress = pub;
    }
  }

  if (network === "mainnet") issues.push(...mainnetInterlock(e, deploymentsFile, deployments));

  if (issues.length > 0 || !deployments) throw new AgentConfigError(issues);

  const cfg: AgentConfig = {
    ...tunablesFrom(e, env),
    role: o.role,
    mode,
    network,
    networkPassphrase: canonical,
    agentSecret: mode === "live" ? secret : undefined,
    agentAddress,
    deployments,
    deploymentsFile,
    contractOverrides,
    probeTimeoutMs: e.AGENT_STARTUP_PROBE_TIMEOUT_MS!,
    offline,
    printConfig,
  };

  if (printConfig || (offline && mode === "dry-run")) return cfg;
  await verifyNetwork(cfg, o.probe ?? rpcNetworkProbe(cfg.probeTimeoutMs), log);
  return cfg;
}

/** Live: any failure is fatal. Dry-run: failures are reported and startup continues. */
async function verifyNetwork(cfg: AgentConfig, probe: NetworkProbe, log: (m: string) => void): Promise<void> {
  const problems: string[] = [];
  try {
    const actual = await probe.passphrase(cfg.rpcUrl);
    if (actual !== cfg.networkPassphrase) {
      problems.push(`RPC ${cfg.rpcUrl} serves "${actual}", but STELLAR_NETWORK=${cfg.network} expects "${cfg.networkPassphrase}"`);
    }
  } catch (err) {
    problems.push(`could not read the network passphrase from ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (problems.length === 0) {
    const names = Object.fromEntries(Object.entries(cfg.deployments.contracts).map(([k, v]) => [v, k]));
    try {
      const { missing, archived } = await probe.contractsExist(cfg.rpcUrl, Object.values(cfg.deployments.contracts));
      for (const id of missing) {
        problems.push(`contracts.${names[id]} ${id} does not exist on ${cfg.network}: the deployment record ${cfg.deploymentsFile} is stale (network reset or wrong file). Redeploy with scripts/deploy-testnet.sh or set DEPLOYMENTS_FILE`);
      }
      for (const id of archived) {
        problems.push(`contracts.${names[id]} ${id} is archived on ${cfg.network}: restore it (stellar contract restore --id ${id}) before running the agent`);
      }
    } catch (err) {
      problems.push(`could not check contract instances on ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (problems.length === 0) return;
  if (cfg.mode === "live") throw new AgentConfigError(problems);
  for (const p of problems) log(`[config] warning (dry-run continues): ${p}`);
}

/** A printable copy of the config. The secret becomes its public key; the raw
 * environment is dropped entirely. */
export function describeConfig(cfg: AgentConfig): Record<string, unknown> {
  const { env: _env, agentSecret, trading, maker, events, arb, ...rest } = cfg;
  const strings = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return {
    ...rest,
    arb: strings(arb),
    events: { ...events, tradeThresholdStroops: events.tradeThresholdStroops.toString() },
    agentSecret: agentSecret ? { publicKey: Keypair.fromSecret(agentSecret).publicKey(), redacted: true } : null,
    trading: { ...trading, tradeSizeStroops: trading.tradeSizeStroops.toString() },
    maker: { ...maker, defaultSeedStroops: maker.defaultSeedStroops.toString() },
  };
}

export const TESTNET_PASSPHRASE = NETWORKS.testnet.passphrase;
export const FUTURENET_PASSPHRASE = NETWORKS.futurenet.passphrase;
export const LOCAL_PASSPHRASE = NETWORKS.local.passphrase;
export const MAINNET_PASSPHRASE = NETWORKS.mainnet.passphrase;
export const redactConfig = describeConfig;
