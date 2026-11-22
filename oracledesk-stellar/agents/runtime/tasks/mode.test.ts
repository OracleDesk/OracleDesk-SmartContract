import assert from "node:assert/strict";
import test from "node:test";
import { NoLease } from "../lease.js";
import { memoryLogger } from "../log.js";
import { Runtime, type Task, type TaskContext } from "../runtime.js";
import { MemoryStateStore } from "../state.js";
import type { TreasuryMode } from "../../stellar/adapter.js";
import { openingsAllowed } from "./mode.js";
import { traderTask, type TraderCandidate, type TraderDeps } from "./trader.js";
import type { DueDiligenceVerdict } from "../../core/due-diligence.js";

const approved = (marketId: string): DueDiligenceVerdict => ({
  outcome: "allow",
  reasons: [],
  commitments: "verified",
  metadata: "verified",
  resolutionPath: "verified",
  oracleTrust: "not_applicable",
  signerTrust: "not_applicable",
  marketId,
  stateFingerprint: "fixture-state",
  checkedAt: Date.now(),
});

async function once(task: Task) {
  const log = memoryLogger();
  await new Runtime({
    tasks: [task],
    state: new MemoryStateStore(),
    lease: new NoLease(),
    shutdownGraceMs: 1_000,
    maxConsecutiveFailures: 10,
    failureWindowMs: 1_000,
    maxFailuresInWindow: 10,
    log,
  }).runOnce();
  return log;
}

function trader(mode: TreasuryMode | undefined, buys: unknown[], modeReads: { n: number }): Task {
  const adapter = {
    mode: "live",
    agent: "GTRADER",
    quoteBuy: async () => 1_000_000n,
    agentBuyV2: async (args: unknown) => {
      buys.push(args);
      return { dryRun: false as const, value: 999n };
    },
    publishTrace: async () => ({ dryRun: false as const, value: 1n }),
    ...(mode === undefined
      ? {}
      : {
          treasuryMode: async () => {
            modeReads.n++;
            return mode;
          },
        }),
  } as unknown as TraderDeps["adapter"];
  const candidates: TraderCandidate[] = [1, 2, 3].map((marketId) => ({
    market: { marketId, question: "q", yesBps: 4_000, closeTime: 10_000 },
    fairValueBps: 6_000,
  }));
  return traderTask(
    {
      adapter,
      traceStore: { put: async (hash) => ({ cid: `local://${hash}` }) },
      candidates: async () => candidates,
      dueDiligence: async (id) => approved(id.toString()),
      minEdgeBps: 500,
      tradeSizeStroops: 100_000_000n,
      slippageBps: 50n,
      deadlineSecs: 60,
      nowSecs: () => 1_000,
    },
    { intervalMs: 1 },
  );
}

test("openingsAllowed: only Normal allows opening positions, and the skip is logged with the mode", async () => {
  const lines: { event: string; fields?: Record<string, unknown> }[] = [];
  const ctx = { log: { info: (event: string, fields?: Record<string, unknown>) => lines.push({ event, fields }) } } as unknown as TaskContext;
  for (const mode of ["Normal", "AgentsHalted", "Paused", "Emergency"] as TreasuryMode[]) {
    assert.equal(await openingsAllowed({ treasuryMode: async () => mode }, ctx, "T"), mode === "Normal", mode);
  }
  assert.deepEqual(lines.map((l) => [l.event, l.fields?.mode]), [["T_SKIP_MODE", "AgentsHalted"], ["T_SKIP_MODE", "Paused"], ["T_SKIP_MODE", "Emergency"]]);
});

test("openingsAllowed: an adapter that cannot read the mode is treated as Normal (the contract's gate stays the backstop)", async () => {
  assert.equal(await openingsAllowed({}, { log: { info: () => assert.fail("no skip") } } as unknown as TaskContext, "T"), true);
});

test("the trader reads the mode once per tick and buys only while Normal", async () => {
  const normalBuys: unknown[] = [];
  const reads = { n: 0 };
  await once(trader("Normal", normalBuys, reads));
  assert.equal(reads.n, 1, "one read per tick, not per market");
  assert.ok(normalBuys.length > 0);

  for (const mode of ["AgentsHalted", "Paused", "Emergency"] as TreasuryMode[]) {
    const buys: unknown[] = [];
    const r = { n: 0 };
    const log = await once(trader(mode, buys, r));
    assert.deepEqual(buys, [], `${mode}: no buys are attempted (and none fail in simulation)`);
    assert.equal(r.n, 1);
    assert.ok(log.entries.some((l) => l.event === "TRADER_SKIP_MODE"), mode);
  }
});

test("the trader still trades when the adapter has no treasuryMode", async () => {
  const buys: unknown[] = [];
  await once(trader(undefined, buys, { n: 0 }));
  assert.ok(buys.length > 0);
});
