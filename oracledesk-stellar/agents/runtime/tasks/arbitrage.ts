/**
 * Cross-market arbitrage as a runtime task (#108), enabled with ARB_ENABLED.
 * Each tick (live mode) first finishes any plan a crash left open, then for
 * every relation in ARB_RELATIONS_FILE: reads both markets and the treasury's
 * positions through the bindings, validates the relation, plans, applies the
 * risk checks and executes. Dry-run plans and logs without trading.
 */
import { readFileSync } from "node:fs";
import type { ArbConfig } from "../../core/config.js";
import { checkArbPlan } from "../../core/risk.js";
import { executeArbPlan, FileArbJournal, recoverArbitrage, type ArbChain, type ArbJournal, type ExecutorDeps } from "../../core/strategies/arb-executor.js";
import { parseRelations, planArbitrage, validateRelation, type Holding, type MarketSnapshot } from "../../core/strategies/arbitrage.js";
import type { TraceStore } from "../../core/trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import { openingsAllowed } from "./mode.js";
import type { Task, TaskContext } from "../runtime.js";

export type ArbAdapter = Pick<
  StellarAdapter,
  "mode" | "agent" | "getMarket" | "treasuryPosition" | "riskCaps" | "marketSpent" | "agentBuy" | "agentSell" | "publishTrace"
> &
  Partial<Pick<StellarAdapter, "treasuryMode">>;

export interface ArbDeps {
  adapter: ArbAdapter;
  cfg: ArbConfig;
  traceStore: TraceStore;
  nowSecs: () => number;
  journal?: ArbJournal;
  readFile?: (path: string) => string;
}

function value<T>(r: { dryRun: boolean; value?: T }, what: string): T {
  if (r.dryRun) throw new Error(`${what}: dry-run result has no value`);
  return r.value as T;
}

/** The executor's chain operations, through the real adapter. */
export function adapterChain(adapter: ArbAdapter): ArbChain {
  return {
    async market(id) {
      const m = await adapter.getMarket(id);
      if (!m) throw new Error(`market ${id} not found`);
      return { id, reserveYes: m.reserveYes, reserveNo: m.reserveNo, feeBps: m.feeBps, closeTime: m.closeTime, status: m.status, resolutionHash: m.resolutionHash };
    },
    position: (id) => adapter.treasuryPosition(id),
    async buy(a) {
      const r = await adapter.agentBuy({ market_id: a.marketId, outcome: { tag: a.outcome, values: undefined }, collateral_in: a.collateralIn, min_shares_out: a.minSharesOut });
      return value(r, "agent_buy");
    },
    async sell(a) {
      const r = await adapter.agentSell({ market_id: a.marketId, outcome: { tag: a.outcome, values: undefined }, collateral_out: a.collateralOut, max_shares_in: a.maxSharesIn });
      return value(r, "agent_sell");
    },
    async publishTrace(a) {
      await adapter.publishTrace({ agent: adapter.agent, market_id: a.marketId, action: "buy", trace_hash: Buffer.from(a.traceHash, "hex"), ipfs_cid: a.cid });
    },
  };
}

/** Arbitrage legs submitted but not closed, per the journal. */
function openLegs(journal: ArbJournal): number {
  const open = new Map<string, number>();
  for (const e of journal.entries()) {
    if (e.step === "leg1:intent" || e.step === "leg2:intent") open.set(e.planId, (open.get(e.planId) ?? 0) + 1);
    if (e.step === "closed") open.delete(e.planId);
  }
  return [...open.values()].reduce((a, b) => a + b, 0);
}

export async function arbitrageTick(d: ArbDeps, ctx: TaskContext): Promise<void> {
  const journal = d.journal ?? new FileArbJournal(d.cfg.journalFile);
  const live = d.adapter.mode === "live";
  const executor: ExecutorDeps = {
    chain: adapterChain(d.adapter),
    journal,
    traceStore: d.traceStore,
    maxLegLoss: d.cfg.maxLegLoss,
    maxUnwindRetries: d.cfg.maxUnwindRetries,
    now: d.nowSecs,
    log: (event, fields) => ctx.log.info(event, fields),
  };
  if (live) {
    for (const r of await ctx.submit(() => recoverArbitrage(executor), "arb:recover")) ctx.log.info("ARB_RECOVERED", { ...r });
  }

  // Recovery above may unwind (a reduction); planning new legs opens exposure.
  if (!(await openingsAllowed(d.adapter, ctx, "ARB"))) return;
  const graph = parseRelations((d.readFile ?? ((p) => readFileSync(p, "utf8")))(d.cfg.relationsFile!));
  const caps = await d.adapter.riskCaps();
  const dailyRemaining = caps.maxDaily > caps.dailyUsed ? caps.maxDaily - caps.dailyUsed : 0n;
  const chain = adapterChain(d.adapter);
  const usable = (caps.maxMarket * (10_000n - d.cfg.marketHeadroomBps)) / 10_000n;

  for (const rel of graph.relations) {
    if (ctx.signal.aborted) return;
    const ids = [BigInt(rel.a), BigInt(rel.b)];
    const markets = new Map<bigint, MarketSnapshot>();
    for (const id of ids) {
      const m = await chain.market(id).catch(() => undefined);
      if (m) markets.set(id, m);
    }
    const problems = validateRelation(rel, markets, d.nowSecs());
    if (problems.length > 0) {
      ctx.log.warn("ARB_RELATION_REJECTED", { relation: rel.id, problems });
      continue;
    }
    const holdings = new Map<bigint, Holding>();
    const spent = new Map<bigint, bigint>();
    for (const id of ids) {
      holdings.set(id, await d.adapter.treasuryPosition(id));
      spent.set(id, await d.adapter.marketSpent(id));
    }
    const headroom = new Map(ids.map((id) => [id, usable > spent.get(id)! ? usable - spent.get(id)! : 0n]));
    const result = planArbitrage({
      relation: rel,
      graphHash: graph.hash,
      markets,
      holdings,
      caps: { maxTrade: caps.maxTrade, marketHeadroom: headroom, dailyRemaining, maxNotional: d.cfg.maxNotional },
      thresholds: { minProfit: d.cfg.minProfit, minProfitBps: d.cfg.minProfitBps },
    });
    if (!result.plan) {
      ctx.log.info("ARB_NO_PLAN", { relation: rel.id, reason: result.reason });
      continue;
    }
    const risk = checkArbPlan(
      result.plan,
      { maxTrade: caps.maxTrade, maxMarket: caps.maxMarket, marketSpent: spent, dailyRemaining, openLegs: openLegs(journal) },
      { maxNotional: d.cfg.maxNotional, maxUnhedged: d.cfg.maxUnhedged, marketHeadroomBps: d.cfg.marketHeadroomBps, maxOpenLegs: d.cfg.maxOpenLegs, maxUnwindRetries: d.cfg.maxUnwindRetries },
    );
    if (risk.length > 0) {
      ctx.log.warn("ARB_RISK_REJECTED", { relation: rel.id, problems: risk });
      continue;
    }
    ctx.log.info("ARB_PLAN", { relation: rel.id, shares: result.plan.shares, cost: result.plan.cost, profit: result.plan.profit, profitBps: result.plan.profitBps });
    if (!live) continue;
    const plan = result.plan;
    const outcome = await ctx.submit(() => executeArbPlan(plan, executor), `arb:${rel.id}`);
    ctx.log.info("ARB_RESULT", { ...outcome });
  }
}

export function arbitrageTask(d: ArbDeps, opts: { intervalMs: number }): Task {
  return { name: "arbitrage", mode: d.adapter.mode, ...opts, run: (ctx) => arbitrageTick(d, ctx) };
}
