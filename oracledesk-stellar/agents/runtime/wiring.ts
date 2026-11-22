/**
 * Builds the real task dependencies, state store, lease and runtime options.
 * Trading and network settings come from the validated AgentConfig
 * (core/config.ts); only runtime knobs (lease, state file, backoff) are still
 * read from the environment. Shared by bin/agentd.ts and the one-shot CLIs so
 * all three behave the same.
 */
import { dirname, join } from "node:path";
import { Server } from "@stellar/stellar-sdk/rpc";
import { SnapshotCache } from "../core/state/state_cache.js";
import { ChainStateReader } from "../core/state/reader.js";
import { existingQuestionHashes, tradableMarkets } from "../core/state/select.js";
import { toMarketState } from "../core/state/types.js";
import type { MarketSignal, SignalSource } from "../core/strategy.js";
import { LocalTraceStore } from "../core/trace.js";
import type { AgentConfig, Tunables } from "../core/config.js";
import { evaluateAgentRisk, type AgentRiskState, type AgentRiskEvaluation } from "../core/risk.js";
import type { CapsView, SizingParams } from "../core/sizing.js";
import { StellarAdapter, type Deployments } from "../stellar/adapter.js";
import { BondBudget } from "../core/bond-budget.js";
import { DEFAULT_POLICY } from "../core/dispute-policy.js";
import { EvidenceTraceSource, ManualSource, PriceRuleSource, parsePriceQuestion, type OutcomeSource } from "../core/outcomes/index.js";
import { assertNever, intEnv, type AgentMode } from "./config.js";
import { FileLease, NoLease, type Lease } from "./lease.js";
import { PostgresLease } from "./lease-pg.js";
import type { RuntimeOptions } from "./runtime.js";
import { FileStateStore, MemoryStateStore, type StateStore } from "./state.js";
import type { MakerDeps } from "./tasks/maker.js";
import type { WatcherTaskDeps } from "./tasks/watcher.js";
import { fixtureCandidates, type TraderCandidate, type TraderDeps, type TraderRiskCheck } from "./tasks/trader.js";

/** Placeholder signal source until a real one is wired in (see docs/wave-issues).
 * Deterministic so dry-runs are reproducible. */
export const demoSignalSource: SignalSource = {
  name: "demo-fixture",
  async poll(): Promise<MarketSignal[]> {
    return [
      {
        summary: "Fixture signal for dry-run demonstration",
        proposedQuestion: "Will the OracleDesk Stellar port pass its testnet demo?",
        fairValueBps: 7500,
        source: "demo-fixture",
        observedAt: Math.floor(Date.now() / 1000),
      },
    ];
  },
};

/** The adapter for a validated config. Only live mode is handed the secret. */
export function buildAdapter(
  cfg: AgentConfig,
  sendGuard?: { check?: () => void | Promise<void> },
): StellarAdapter {
  const common = {
    networkPassphrase: cfg.networkPassphrase,
    rpcUrl: cfg.rpcUrl,
    agentAddress: cfg.agentAddress,
    deployments: cfg.deployments,
    beforeSend: () => sendGuard?.check?.(),
  };
  switch (cfg.mode) {
    case "live":
      return new StellarAdapter({ ...common, mode: "live", agentSecret: cfg.agentSecret });
    case "dry-run":
      return new StellarAdapter({ ...common, mode: "dry-run" });
    default:
      return assertNever(cfg.mode, "mode");
  }
}

function stateReader(rpcUrl: string, deployments: Deployments) {
  return new ChainStateReader({
    marketContractId: deployments.contracts.market_core,
    portfolioContractId: deployments.contracts.treasury,
    server: new Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") }),
  });
}

/** Chain-state market source: tradable markets the treasury can afford. */
export function chainCandidates(
  t: Tunables,
  deployments: Deployments,
  adapter: TraderDeps["adapter"],
): () => Promise<TraderCandidate[]> {
  const reader = stateReader(t.rpcUrl, deployments);
  const cache = new SnapshotCache();
  return async () => {
    const snapshot = await cache.get(() => reader.readSnapshot([]));
    const risk = await adapter.riskCaps?.();
    const canSize = risk !== undefined && adapter.marketExposure !== undefined && adapter.treasuryPosition !== undefined;
    const dailyHeadroom = risk?.dailyHeadroom ?? (risk ? risk.maxDaily - risk.dailyUsed : 0n);
    if (canSize && (snapshot.portfolio.availableCapital <= 0n || dailyHeadroom <= 0n)) return [];
    const markets = tradableMarkets(snapshot);
    return Promise.all(markets.map(async (m) => {
      const market = toMarketState(m);
      let holdings;
      let caps: CapsView | undefined;
      if (canSize && risk !== undefined) {
        const [position, exposure] = await Promise.all([
          adapter.treasuryPosition!(m.marketId),
          adapter.marketExposure!(m.marketId),
        ]);
        holdings = position;
        const available = snapshot.portfolio.availableCapital < dailyHeadroom
          ? snapshot.portfolio.availableCapital
          : dailyHeadroom;
        caps = {
          maxTrade: risk.maxTrade < t.trading.tradeSizeStroops ? risk.maxTrade : t.trading.tradeSizeStroops,
          maxMarket: risk.maxMarket,
          marketExposure: exposure,
          maxDaily: risk.maxDaily,
          dailyUsed: risk.dailyUsed,
          dailyHeadroom,
          availableCapital: available,
        };
      }
      return {
        market,
        // No external oracle yet: FAIR_VALUE_BPS or the market's own price (strategy.ts decides edge).
        fairValueBps: t.trading.fairValueBps ?? market.yesBps,
        creator: m.creator,
        questionHash: m.questionHash,
        ledger: snapshot.ledgers.max,
        holdings,
        caps,
        setsMinted: m.setsMinted,
      };
    }));
  };
}

export function traderRiskCheck(
  adapter: Pick<StellarAdapter, "riskCaps" | "getAgent" | "marketExposure">,
): TraderRiskCheck {
  return async (input) => {
    try {
      const [caps, policy, exposure] = await Promise.all([
        adapter.riskCaps(),
        adapter.getAgent(),
        adapter.marketExposure(input.marketId),
      ]);
      if (!policy) {
        return { violations: [], unverifiable: ["treasury agent policy is unavailable"] };
      }
      const now = BigInt(Math.floor(Date.now() / 1_000));
      const hour = now / 3_600n;
      const emptyWindow = () => ({ headHour: hour, headIdx: 0, amounts: Array.from({ length: 25 }, () => 0n) });
      const state: AgentRiskState = {
        now,
        global: {
          maxTrade: caps.maxTrade,
          maxMarket: caps.maxMarket,
          maxDaily: caps.maxDaily,
          maxNetExposure: caps.maxMarket * 128n,
        },
        agent: {
          active: policy.active,
          roles: policy.roles,
          maxTrade: caps.maxTrade,
          maxDaily: caps.maxDaily,
        },
        usage: { global: emptyWindow(), agent: emptyWindow() },
        idleCapital: input.amount,
        queueReservedCapital: 0n,
        netExposure: 0n,
        marketExposure: exposure,
        marketNetPosition: { collateralIn: 0n, collateralOut: 0n },
        yieldLiquidity: { enabled: false, available: 0n },
        price: {
          maxBuyPriceBps: 10_000n,
          minSellPriceBps: 0n,
          maxImpactBps: 10_000n,
          maxSlippageBps: 10_000n,
        },
      };
      return evaluateAgentRisk({
        kind: "buy",
        amount: input.amount,
        priceBeforeBps: input.priceBeforeBps,
        priceAfterBps: input.priceAfterBps,
        quotedShares: input.quotedShares,
        minSharesOut: input.minSharesOut,
      }, state) satisfies AgentRiskEvaluation;
    } catch (err) {
      return { violations: [], unverifiable: [err instanceof Error ? err.message : String(err)] };
    }
  };
}

export function makerDeps(t: Tunables, adapter: StellarAdapter, deployments: Deployments): MakerDeps {
  const reader = stateReader(t.rpcUrl, deployments);
  return {
    adapter,
    traceStore: new LocalTraceStore(t.traceStoreDir),
    signals: demoSignalSource,
    knownQuestionHashes: async () => existingQuestionHashes(await reader.readSnapshot([])),
    confidenceThresholdBps: t.maker.confidenceThresholdBps,
    defaultSeedStroops: t.maker.defaultSeedStroops,
    closeInSecs: t.maker.closeInSecs,
  };
}

/**
 * Trader deps. With deployments, markets come from chain state; without
 * (tests, an adapter not bound to a deployment) from the demo fixture.
 */
export function traderDeps(
  t: Tunables,
  adapter: TraderDeps["adapter"],
  deployments: Deployments | undefined,
  nowSecs: () => number,
  dueDiligence?: TraderDeps["dueDiligence"],
  riskCheck?: TraderDeps["riskCheck"],
): TraderDeps {
  return {
    adapter,
    traceStore: new LocalTraceStore(t.traceStoreDir),
    candidates: deployments ? chainCandidates(t, deployments, adapter) : () => fixtureCandidates(nowSecs()),
    treasury: deployments?.contracts.treasury,
    minEdgeBps: t.trading.minEdgeBps,
    tradeSizeStroops: t.trading.tradeSizeStroops,
    slippageBps: BigInt(t.trading.slippageBps),
    sizingParams: {
      kellyFractionNumerator: t.trading.kellyFraction.numerator,
      kellyFractionDenominator: t.trading.kellyFraction.denominator,
      bufferBps: BigInt(t.trading.sizingBufferBps),
      slippageBps: BigInt(t.trading.slippageBps),
      minTradeStroops: t.trading.minTradeStroops,
    } satisfies SizingParams,
    uncertaintyBps: BigInt(t.trading.fairUncertaintyBps),
    deadlineSecs: t.trading.deadlineSecs,
    nowSecs,
    dueDiligence,
    riskCheck,
  };
}

export function statePath(env: NodeJS.ProcessEnv): string {
  return env.AGENT_STATE_PATH || "./.agent-state/state.json";
}

/**
 * Live: the JSON file at AGENT_STATE_PATH, scoped by treasury contract id.
 * Dry-run: in memory, so a rehearsal never claims real work as processed.
 */
export async function createStateStore(mode: AgentMode, env: NodeJS.ProcessEnv, scope: string): Promise<StateStore> {
  if (mode !== "live") return new MemoryStateStore();
  return new FileStateStore(statePath(env), { scope, debounceMs: intEnv(env, "STATE_FLUSH_DEBOUNCE_MS", 250) }).load();
}

/** `AGENT_LEASE=none` disables the lease (only when exclusivity is guaranteed elsewhere). */
export function createLease(env: NodeJS.ProcessEnv): Lease {
  if (env.AGENT_LEASE === "none") return new NoLease();
  if (env.AGENT_LEASE === "pg") {
    if (!env.AGENT_LEASE_PG_URL) throw new Error("AGENT_LEASE_PG_URL is required when AGENT_LEASE=pg");
    return new PostgresLease({
      connectionString: env.AGENT_LEASE_PG_URL,
      ttlMs: intEnv(env, "LEASE_TTL_MS", 60_000, 1),
      heartbeatMs: intEnv(env, "LEASE_HEARTBEAT_MS", 10_000, 1),
    });
  }
  if (env.AGENT_LEASE !== undefined && env.AGENT_LEASE !== "file") {
    throw new Error(`AGENT_LEASE must be one of none, file, pg; got ${env.AGENT_LEASE}`);
  }
  return new FileLease(env.AGENT_LEASE_PATH || join(dirname(statePath(env)), "agent.lock"), {
    ttlMs: intEnv(env, "LEASE_TTL_MS", 60_000, 1),
    heartbeatMs: intEnv(env, "LEASE_HEARTBEAT_MS", 10_000, 1),
  });
}

export function runtimeOptions(env: NodeJS.ProcessEnv): Omit<RuntimeOptions, "tasks" | "state" | "lease"> {
  return {
    shutdownGraceMs: intEnv(env, "SHUTDOWN_GRACE_MS", 30_000),
    maxConsecutiveFailures: intEnv(env, "MAX_CONSECUTIVE_FAILURES", 8, 1),
    failureWindowMs: intEnv(env, "FAILURE_WINDOW_MS", 10 * 60_000, 1),
    maxFailuresInWindow: intEnv(env, "MAX_FAILURES_IN_WINDOW", 20, 1),
    backoffBaseMs: intEnv(env, "BACKOFF_BASE_MS", 1_000, 1),
    backoffMaxMs: intEnv(env, "BACKOFF_MAX_MS", 5 * 60_000, 1),
  };
}

/**
 * Fetches a trace or metadata document by URI: `local://<path>` (the dev trace
 * store), or an IPFS CID / `ipfs://` URI through WATCHER_IPFS_GATEWAY.
 */
export function uriFetcher(env: NodeJS.ProcessEnv): (uri: string, signal: AbortSignal) => Promise<string | undefined> {
  return async (uri, signal) => {
    if (uri.startsWith("local://")) {
      const { readFile } = await import("node:fs/promises");
      return readFile(uri.slice("local://".length), "utf8").catch(() => undefined);
    }
    const gateway = env.WATCHER_IPFS_GATEWAY;
    if (!gateway) return undefined;
    const cid = uri.replace(/^ipfs:\/\//, "");
    const res = await fetch(`${gateway.replace(/\/$/, "")}/ipfs/${cid}`, { signal });
    return res.ok ? res.text() : undefined;
  };
}

/**
 * The watcher's real dependencies: price-rule and evidence-trace sources, an
 * optional operator verdicts file, and a bond budget over the runtime's state.
 * `candidates` scans markets the treasury holds, so a lost proposal event is
 * rediscovered from resolver state.
 */
export function watcherDeps(cfg: AgentConfig, adapter: StellarAdapter): WatcherTaskDeps {
  const fetchUri = uriFetcher(cfg.env);
  const sources: OutcomeSource[] = [
    new PriceRuleSource({
      loadQuestion: async (metaUri, signal) => {
        const raw = await fetchUri(metaUri, signal);
        return raw === undefined ? undefined : parsePriceQuestion(JSON.parse(raw));
      },
      reflector: (address) => ({
        resolution: () => adapter.reflectorResolution(address),
        price: (asset, ts) => adapter.reflectorPrice(address, asset, ts),
      }),
    }),
    new EvidenceTraceSource({
      evidence: async (marketId) =>
        (await adapter.attestationEvidence(marketId)).map((e) => ({ signer: e.signer, attested: e.outcome, traceId: e.traceId, traceHash: e.traceHash })),
      fetchTrace: async (e, signal) => fetchUri(await adapter.traceCid(e.traceId), signal),
    }),
    new ManualSource(cfg.watcher.verdictsFile),
  ];
  const reader = stateReader(cfg.rpcUrl, cfg.deployments);
  return {
    cfg,
    adapter,
    sources,
    traceStore: new LocalTraceStore(cfg.traceStoreDir),
    budget: (state) =>
      new BondBudget(state, {
        maxBondStroops: cfg.watcher.maxBondStroops,
        budgetStroops: cfg.watcher.budgetStroops,
        maxDisputesPerDay: cfg.watcher.maxDisputesPerDay,
      }),
    policy: { ...DEFAULT_POLICY, minConfidenceBps: cfg.watcher.minConfidenceBps, minLeadSecs: BigInt(cfg.watcher.minLeadSecs) },
    marketInfo: async (marketId) => {
      const m = await adapter.readMarket(marketId).catch(() => undefined);
      return m ? { metaUri: m.metaUri, closeTime: BigInt(m.closeTime) } : undefined;
    },
    candidates: async () => {
      const snapshot = await reader.readSnapshot([]);
      return [...snapshot.portfolio.positions]
        .filter(([id, p]) => p.yes + p.no > 0n && snapshot.markets.get(id)?.status === "open")
        .map(([id]) => id);
    },
  };
}
