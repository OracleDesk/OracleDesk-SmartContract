import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbConfig } from "../../core/config.js";
import { calcBuy, seedReserves } from "../../core/fpmm.js";
import { MemoryArbJournal } from "../../core/strategies/arb-executor.js";
import { LocalTraceStore } from "../../core/trace.js";
import { NoLease } from "../lease.js";
import { Runtime } from "../runtime.js";
import { MemoryStateStore } from "../state.js";
import { arbitrageTask, type ArbAdapter } from "./arbitrage.js";

const NOW = 1_700_000_000;
const HASH = "00".repeat(32);

function fakeAdapter(mode: "live" | "dry-run", calls: string[]): ArbAdapter {
  const pools = new Map(
    [
      [0n, seedReserves(20_000_000_000n, 7000n)],
      [1n, seedReserves(5_000_000_000n, 4000n)],
    ].map(([id, r]) => [id as bigint, { yes: (r as { reserveYes: bigint }).reserveYes, no: (r as { reserveNo: bigint }).reserveNo }]),
  );
  const held = new Map<string, bigint>();
  return {
    mode,
    agent: "GAGENT",
    getMarket: async (id) => {
      const p = pools.get(id);
      return p && { creator: "C", questionHash: "", resolutionHash: HASH, closeTime: BigInt(NOW + 86_400), status: "Open", reserveYes: p.yes, reserveNo: p.no, feeBps: 100n };
    },
    treasuryPosition: async (id) => ({ yes: held.get(`${id}:Yes`) ?? 0n, no: held.get(`${id}:No`) ?? 0n }),
    riskCaps: async () => ({ maxTrade: 10n ** 12n, maxMarket: 10n ** 13n, maxDaily: 10n ** 13n, dailyUsed: 0n }),
    marketSpent: async () => 0n,
    agentBuy: async (a) => {
      calls.push(`buy:${a.market_id}:${a.outcome.tag}`);
      if (mode === "dry-run") return { dryRun: true, contractId: "T", method: "agent_buy", args: a };
      const p = pools.get(a.market_id)!;
      const yes = a.outcome.tag === "Yes";
      const q = calcBuy(yes ? p.yes : p.no, yes ? p.no : p.yes, a.collateral_in, 100n);
      if (yes) [p.yes, p.no] = [q.newReserveBought, q.newReserveOther];
      else [p.no, p.yes] = [q.newReserveBought, q.newReserveOther];
      held.set(`${a.market_id}:${a.outcome.tag}`, (held.get(`${a.market_id}:${a.outcome.tag}`) ?? 0n) + q.sharesOut);
      return { dryRun: false, value: q.sharesOut };
    },
    agentSell: async (a) => {
      calls.push(`sell:${a.market_id}`);
      return { dryRun: false, value: 0n };
    },
    publishTrace: async () => {
      calls.push("trace");
      return { dryRun: false, value: 0n };
    },
  } as ArbAdapter;
}

const CFG: ArbConfig = {
  enabled: true,
  relationsFile: "relations.json",
  journalFile: "unused",
  maxNotional: 2_000_000_000n,
  minProfit: 1n,
  minProfitBps: 0n,
  maxUnhedged: 10n ** 12n,
  marketHeadroomBps: 2_000n,
  maxLegLoss: 10_000_000n,
  maxOpenLegs: 4,
  maxUnwindRetries: 2,
};

function relations(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    relations: [
      {
        id: "imp",
        type: "implies",
        a: 0,
        b: 1,
        resolution: { a: { mechanism: "price", source: "reflector:XLM" }, b: { mechanism: "price", source: "reflector:XLM" } },
        voidCorrelation: "joint",
        ...over,
      },
    ],
  });
}

async function run(mode: "live" | "dry-run", file = relations()) {
  const calls: string[] = [];
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const at = (event: string, fields?: Record<string, unknown>) => void events.push({ event, fields });
  const journal = new MemoryArbJournal();
  const task = arbitrageTask(
    { adapter: fakeAdapter(mode, calls), cfg: CFG, traceStore: new LocalTraceStore(mkdtempSync(join(tmpdir(), "arb-"))), nowSecs: () => NOW, journal, readFile: () => file },
    { intervalMs: 0 },
  );
  const runtime = new Runtime({
    tasks: [task],
    state: new MemoryStateStore(),
    lease: new NoLease(),
    shutdownGraceMs: 1_000,
    maxConsecutiveFailures: 3,
    failureWindowMs: 60_000,
    maxFailuresInWindow: 10,
    log: { info: at, warn: at, error: at },
  });
  await runtime.runOnce();
  return { calls, events, journal };
}

test("dry-run plans the arbitrage and logs it without trading", async () => {
  const r = await run("dry-run");
  assert.ok(r.events.some((e) => e.event === "ARB_PLAN"));
  assert.deepEqual(r.calls, []);
  assert.equal(r.journal.log.length, 0);
});

test("live mode executes both legs, less liquid market first, and publishes the trace", async () => {
  const r = await run("live");
  assert.deepEqual(r.calls, ["buy:1:Yes", "buy:0:No", "trace"]);
  const result = r.events.find((e) => e.event === "ARB_RESULT");
  assert.equal(result?.fields?.status, "completed");
  assert.equal(r.journal.log.at(-1)!.step, "closed");
});

test("an incompatible relation is rejected before anything executes", async () => {
  const r = await run("live", relations({ resolution: { a: { mechanism: "price", source: "reflector:XLM" }, b: { mechanism: "signers", source: "committee-1" } } }));
  assert.ok(r.events.some((e) => e.event === "ARB_RELATION_REJECTED"));
  assert.deepEqual(r.calls, []);
});
