/**
 * Builds the real task dependencies, state store, lease and runtime options
 * from the environment. Shared by bin/agentd.ts and the one-shot CLIs so
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
import { agentCredentials, loadDeployments, StellarAdapter, type AgentRole, type Deployments } from "../stellar/adapter.js";
import { intEnv, type AgentMode } from "./config.js";
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

export function rpcUrl(env: NodeJS.ProcessEnv): string {
  return env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
}

export function buildAdapter(role: AgentRole, mode: AgentMode, env: NodeJS.ProcessEnv, deployments: Deployments): StellarAdapter {
  return new StellarAdapter({
    mode,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    rpcUrl: rpcUrl(env),
    ...agentCredentials(role, env, deployments),
    deployments,
  });
}

function stateReader(env: NodeJS.ProcessEnv, deployments: Deployments) {
  return new ChainStateReader({
    marketContractId: deployments.contracts.market_core,
    portfolioContractId: deployments.contracts.treasury,
    server: new Server(rpcUrl(env)),
  });
}

/** Chain-state market source: tradable markets the treasury can afford. */
export function chainCandidates(env: NodeJS.ProcessEnv, deployments: Deployments): () => Promise<TraderCandidate[]> {
  const reader = stateReader(env, deployments);
  const cache = new SnapshotCache();
  const tradeSize = BigInt(env.TRADE_SIZE_STROOPS ?? "100000000");
  return async () => {
    const snapshot = await cache.get(() => reader.readSnapshot([]));
    if (availableCapital(snapshot) < tradeSize) return [];
    return tradableMarkets(snapshot).map((m) => {
      const market = toMarketState(m);
      return {
        market,
        // No external oracle yet: env override or the market's own price (strategy.ts decides edge).
        fairValueBps: Number(env.FAIR_VALUE_BPS ?? String(market.yesBps)),
        creator: m.creator,
        questionHash: m.questionHash,
        ledger: snapshot.ledgers.max,
      };
    });
  };
}

export function makerDeps(env: NodeJS.ProcessEnv, adapter: StellarAdapter, deployments: Deployments): MakerDeps {
  const reader = stateReader(env, deployments);
  return {
    adapter,
    traceStore: new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces"),
    signals: demoSignalSource,
    knownQuestionHashes: async () => existingQuestionHashes(await reader.readSnapshot([])),
    confidenceThresholdBps: Number(env.CONFIDENCE_THRESHOLD_BPS ?? 1000),
    defaultSeedStroops: BigInt(env.DEFAULT_SEED_STROOPS ?? "1500000000"),
    closeInSecs: Number(env.MARKET_CLOSE_IN_SECS ?? 3600),
  };
}

/**
 * Trader deps. With deployments, markets come from chain state; without
 * (tests, an adapter not bound to a deployment) from the demo fixture.
 */
export function traderDeps(
  env: NodeJS.ProcessEnv,
  adapter: TraderDeps["adapter"],
  deployments: Deployments | undefined,
  nowSecs: () => number,
): TraderDeps {
  return {
    adapter,
    traceStore: new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces"),
    candidates: deployments ? chainCandidates(env, deployments) : () => fixtureCandidates(nowSecs()),
    treasury: deployments?.contracts.treasury,
    minEdgeBps: Number(env.MIN_EDGE_BPS ?? 500),
    tradeSizeStroops: BigInt(env.TRADE_SIZE_STROOPS ?? "100000000"),
    slippageBps: BigInt(env.SLIPPAGE_BPS ?? 50),
    deadlineSecs: Number(env.DEADLINE_SECS ?? 60),
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

export { loadDeployments };
