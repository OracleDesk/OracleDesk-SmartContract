/**
 * Shared wiring for the chaos suite (#106): runs the real runtime tasks
 * (runtime/tasks/*) with the real live StellarAdapter against the fake RPC.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTraceStore } from "../../core/trace.js";
import type { MarketSignal } from "../../core/strategy.js";
import { NoLease } from "../../runtime/lease.js";
import type { Logger } from "../../runtime/log.js";
import { Runtime, type Task } from "../../runtime/runtime.js";
import { MemoryStateStore } from "../../runtime/state.js";
import { makerTask } from "../../runtime/tasks/maker.js";
import { TRACES, type PendingTrace } from "../../runtime/tasks/traces.js";
import { TRADES, traderTask } from "../../runtime/tasks/trader.js";
import type { FakeNetwork } from "../fake-rpc/network.js";

/**
 * The separate transaction-lifecycle issue (adapter retries, idempotent
 * submission, journaling of ambiguous outcomes). Tests that need its fixes
 * are marked TODO with this link.
 */
export const LIFECYCLE_ISSUE = "https://github.com/OracleDesk/OracleDesk-SmartContract/issues?q=is%3Aissue+transaction+lifecycle";

export function quietLog(): Logger & { lines: { level: string; event: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) => void lines.push({ level, event, fields });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

export async function traceDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chaos-traces-"));
}

/** The trader task against the seeded market, priced 40% YES vs a 60% fair value. */
export async function traderFor(net: FakeNetwork, intervalMs = 1): Promise<Task> {
  const m = net.market;
  return traderTask(
    {
      adapter: net.adapter(),
      traceStore: new LocalTraceStore(await traceDir()),
      candidates: async () => [
        { market: { marketId: Number(m.id), question: "chaos", yesBps: 4000, closeTime: Number(m.closeTime) }, fairValueBps: 6000 },
      ],
      treasury: net.deployments.contracts.treasury,
      minEdgeBps: 500,
      tradeSizeStroops: 100_000_000n,
      slippageBps: 50n,
      deadlineSecs: 60,
      nowSecs: () => net.rpc.clock.closeTime,
    },
    { intervalMs },
  );
}

const SIGNAL: MarketSignal = {
  summary: "chaos fixture signal",
  proposedQuestion: "Will the chaos suite stay deterministic?",
  fairValueBps: 7500,
  source: "chaos",
  observedAt: 1_700_000_000,
};

export async function makerFor(net: FakeNetwork, intervalMs = 1): Promise<Task> {
  return makerTask(
    {
      adapter: net.adapter(),
      traceStore: new LocalTraceStore(await traceDir()),
      signals: { name: "chaos", poll: async () => [SIGNAL] },
      confidenceThresholdBps: 1000,
      defaultSeedStroops: 1_500_000_000n,
      closeInSecs: 3600,
    },
    { intervalMs },
  );
}

export function runtimeFor(net: FakeNetwork, task: Task, opts: { maxConsecutiveFailures?: number; state?: MemoryStateStore } = {}) {
  const state = opts.state ?? new MemoryStateStore();
  const log = quietLog();
  const runtime = new Runtime({
    tasks: [task],
    state,
    lease: new NoLease(),
    shutdownGraceMs: 5_000,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
    failureWindowMs: 60_000,
    maxFailuresInWindow: 100,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    log,
    // The fake ledger clock is the only clock the agent sees.
    now: () => net.rpc.clock.closeTime * 1000,
    random: () => 0.5,
  });
  return { runtime, state, log };
}

/** One `runOnce()` tick; returns its error instead of throwing. */
export async function tick(runtime: Runtime): Promise<unknown> {
  try {
    await runtime.runOnce();
    return undefined;
  } catch (err) {
    return err;
  }
}

/**
 * The trade/trace invariant: every buy that executed on chain has either a
 * published trace or a pending trace in the journal. Returns the violations.
 */
export function tracelessTrades(net: FakeNetwork, state: MemoryStateStore): string[] {
  const buys = net.rpc.applied.filter((s) => s.fn === "agent_buy_v2" || s.fn === "agent_buy");
  const published = net.rpc.applied.filter((s) => s.fn === "publish_trace").map((s) => s.args.market_id);
  const pending = [...state.entries<PendingTrace>(TRACES)].filter(([, t]) => t.status === "pending").map(([, t]) => t.marketId);
  const covered = [...published, ...pending].map(String);
  const violations: string[] = [];
  let used = 0;
  for (const b of buys) {
    const idx = covered.indexOf(String(b.args.market_id), used);
    if (idx === -1) violations.push(`buy ${b.hash} on market ${String(b.args.market_id)} has no published or journaled trace`);
    else used = idx + 1;
  }
  return violations;
}

export function tradeJournal(state: MemoryStateStore): { key: string; status: string }[] {
  return [...state.entries<{ status: string }>(TRADES)].map(([key, v]) => ({ key, status: v.status }));
}
