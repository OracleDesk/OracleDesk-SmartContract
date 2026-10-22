import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSignal } from "../core/strategy.js";
import type { TraceStore } from "../core/trace.js";
import { NoLease } from "./lease.js";
import { MarketLocks } from "./locks.js";
import { memoryLogger } from "./log.js";
import { Runtime, type Task } from "./runtime.js";
import { MemoryStateStore } from "./state.js";
import { makerTask, SIGNALS, type MakerDeps } from "./tasks/maker.js";
import { TRACES, type PendingTrace } from "./tasks/traces.js";
import { traderTask, type TraderCandidate, type TraderDeps } from "./tasks/trader.js";

const TREASURY = "CTREASURY";
const traceStore: TraceStore = { put: async (hash) => ({ cid: `local://${hash}` }) };

async function once(state: MemoryStateStore, task: Task) {
  const rt = new Runtime({
    tasks: [task],
    state,
    lease: new NoLease(),
    shutdownGraceMs: 1_000,
    maxConsecutiveFailures: 10,
    failureWindowMs: 1_000,
    maxFailuresInWindow: 10,
    log: memoryLogger(),
  });
  await rt.runOnce();
}

function liveTrader(buys: unknown[]): TraderDeps["adapter"] {
  return {
    mode: "live",
    agent: "GTRADER",
    quoteBuy: async () => 1_000_000n,
    agentBuyV2: async (args: unknown) => {
      buys.push(args);
      return { dryRun: false as const, value: 999n };
    },
    publishTrace: async () => ({ dryRun: false as const, value: 1n }),
  } as unknown as TraderDeps["adapter"];
}

function traderDeps(adapter: TraderDeps["adapter"], candidates: TraderCandidate[]): TraderDeps {
  return {
    adapter,
    traceStore,
    candidates: async () => candidates,
    treasury: TREASURY,
    minEdgeBps: 500,
    tradeSizeStroops: 100_000_000n,
    slippageBps: 50n,
    deadlineSecs: 60,
    nowSecs: () => 1_000,
  };
}

const market = (marketId: number) => ({ marketId, question: "q", yesBps: 4_000, closeTime: 10_000 });

test("trader skips own market until maker marks it revealed", async () => {
  const state = new MemoryStateStore();
  const buys: unknown[] = [];
  const own: TraderCandidate = { market: market(5), fairValueBps: 6_000, creator: TREASURY, questionHash: "qh5" };
  const task = traderTask(traderDeps(liveTrader(buys), [own]), { intervalMs: 1 });
  // The maker's side of the handshake, over the same state the runtime hands the trader.
  const locks = new MarketLocks(state);

  await once(state, task);
  assert.equal(buys.length, 0, "unknown own market: not tradable");

  locks.markCreating("qh5");
  await once(state, task);
  assert.equal(buys.length, 0, "still being created");

  locks.markCreated(5, "qh5");
  locks.clearCreating("qh5");
  await once(state, task);
  assert.equal(buys.length, 0, "created but unrevealed");

  locks.markRevealed(5);
  await once(state, task);
  assert.equal(buys.length, 1, "revealed: trades");

  // Someone else's market follows the chain-state rules only.
  const foreign: TraderCandidate = { market: market(6), fairValueBps: 6_000, creator: "COTHER" };
  await once(state, traderTask(traderDeps(liveTrader(buys), [foreign]), { intervalMs: 1 }));
  assert.equal(buys.length, 2);

  // The trace of a live trade is queued and published.
  const traces = state.entries<PendingTrace>(TRACES);
  assert.ok(traces.length >= 2 && traces.every(([, t]) => t.status === "published"));
});

function makerDeps(calls: string[], state: MemoryStateStore, mode: "live" | "dry-run" = "live"): MakerDeps {
  const signal: MarketSignal = { summary: "s", proposedQuestion: "Will X?", fairValueBps: 8_000, source: "src", observedAt: 42 };
  return {
    adapter: {
      mode,
      agent: "GMAKER",
      agentCreateMarket: async () => {
        // Intent and "creating" are durable before the submission.
        const [[, entry]] = state.entries<{ status: string }>(SIGNALS);
        calls.push(`create(${entry!.status},creating=${state.entries("markets.creating").length})`);
        return mode === "live" ? { dryRun: false as const, value: 3n } : { dryRun: true as const, contractId: "C", method: "m", args: {} };
      },
      publishTrace: async () => {
        calls.push("publish");
        return { dryRun: false as const, value: 1n };
      },
    } as unknown as MakerDeps["adapter"],
    traceStore,
    signals: { name: "fixture", poll: async () => [signal] },
    knownQuestionHashes: async () => new Set(),
    reveal: async (id) => void calls.push(`reveal(${id})`),
    confidenceThresholdBps: 1_000,
    defaultSeedStroops: 1_500_000_000n,
    closeInSecs: 3_600,
  };
}

test("maker records intent before submitting, reveals, and never re-processes a signal", async () => {
  const state = new MemoryStateStore();
  const calls: string[] = [];
  const task = makerTask(makerDeps(calls, state), { intervalMs: 1 });
  await once(state, task);
  assert.deepEqual(calls, ["create(intent,creating=1)", "reveal(3)", "publish"]);
  assert.deepEqual(state.get("markets", "3"), { status: "revealed", questionHash: state.get<{ questionHash: string }>("markets", "3")!.questionHash });
  assert.equal(state.entries("markets.creating").length, 0);

  await once(state, task);
  assert.equal(calls.length, 3, "same signal is skipped the second time");
});
