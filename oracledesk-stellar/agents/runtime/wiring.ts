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
import { availableCapital, existingQuestionHashes, tradableMarkets } from "../core/state/select.js";
import { toMarketState } from "../core/state/types.js";
import type { MarketSignal, SignalSource } from "../core/strategy.js";
import { LocalTraceStore } from "../core/trace.js";
import type { AgentConfig, Tunables } from "../core/config.js";
import { StellarAdapter, type Deployments } from "../stellar/adapter.js";
import { assertNever, intEnv, type AgentMode } from "./config.js";
import { FileLease, NoLease, type Lease } from "./lease.js";
import type { RuntimeOptions } from "./runtime.js";
import { FileStateStore, MemoryStateStore, type StateStore } from "./state.js";
import type { MakerDeps } from "./tasks/maker.js";
import { fixtureCandidates, type TraderCandidate, type TraderDeps } from "./tasks/trader.js";

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
export function buildAdapter(cfg: AgentConfig): StellarAdapter {
  const common = {
    networkPassphrase: cfg.networkPassphrase,
    rpcUrl: cfg.rpcUrl,
    agentAddress: cfg.agentAddress,
    deployments: cfg.deployments,
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

/** Chain-state market source: tradable markets the treasury can afford.
 * `effectiveFeeBps` (#9) replaces each market's fee before the strategy sees
 * it; without it the flat snapshot from `get_market` is used. */
export function chainCandidates(
  t: Tunables,
  deployments: Deployments,
  effectiveFeeBps?: (marketId: bigint) => Promise<number>,
): () => Promise<TraderCandidate[]> {
  const reader = stateReader(t.rpcUrl, deployments);
  const cache = new SnapshotCache();
  const tradeSize = t.trading.tradeSizeStroops;
  return async () => {
    const snapshot = await cache.get(() => reader.readSnapshot([]));
    if (availableCapital(snapshot) < tradeSize) return [];
    const candidates = tradableMarkets(snapshot).map((m) => {
      const market = toMarketState(m);
      return {
        market,
        // No external oracle yet: FAIR_VALUE_BPS or the market's own price (strategy.ts decides edge).
        fairValueBps: t.trading.fairValueBps ?? market.yesBps,
        creator: m.creator,
        questionHash: m.questionHash,
        ledger: snapshot.ledgers.max,
      };
    });
    return effectiveFeeBps ? applyEffectiveFees(candidates, effectiveFeeBps) : candidates;
  };
}

/**
 * A dynamic `FeeSchedule` (#9) is deliberately invisible in
 * `Market.fee_bps`, so quoting off that snapshot understates the fee near
 * close. Replace it with `current_fee_bps` — the fee the contract actually
 * charges at the current ledger time — so every off-chain impact estimate
 * matches on-chain reality.
 */
export async function applyEffectiveFees(
  candidates: TraderCandidate[],
  feeBps: (marketId: bigint) => Promise<number>,
): Promise<TraderCandidate[]> {
  return Promise.all(
    candidates.map(async (c) => ({
      ...c,
      market: { ...c.market, feeBps: await feeBps(BigInt(c.market.marketId)) },
    })),
  );
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
/**
 * `#9`: only a live adapter that implements the read can supply the
 * effective fee. Dry-run and fake adapters keep the flat snapshot.
 */
function effectiveFeeReader(
  adapter: TraderDeps["adapter"],
): ((marketId: bigint) => Promise<number>) | undefined {
  const read = adapter.currentFeeBps;
  if (adapter.mode !== "live" || !read) return undefined;
  return (marketId) => read.call(adapter, { market_id: marketId });
}

export function traderDeps(
  t: Tunables,
  adapter: TraderDeps["adapter"],
  deployments: Deployments | undefined,
  nowSecs: () => number,
): TraderDeps {
  return {
    adapter,
    traceStore: new LocalTraceStore(t.traceStoreDir),
    candidates: deployments
      ? chainCandidates(t, deployments, effectiveFeeReader(adapter))
      : () => fixtureCandidates(nowSecs()),
    treasury: deployments?.contracts.treasury,
    minEdgeBps: t.trading.minEdgeBps,
    tradeSizeStroops: t.trading.tradeSizeStroops,
    slippageBps: BigInt(t.trading.slippageBps),
    deadlineSecs: t.trading.deadlineSecs,
    nowSecs,
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

