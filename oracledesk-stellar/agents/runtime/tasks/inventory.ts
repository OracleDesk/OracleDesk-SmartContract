import { inventoryOf, type InventoryInput } from "../../core/inventory.js";
import { planHedge, type HedgeConfig, type PricePolicyView } from "../../core/hedge.js";
import { buildTrace, type TraceStore } from "../../core/trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";

export interface InventoryCandidate {
  marketId: bigint;
  closeTime: bigint;
  pool: InventoryInput["pool"];
  position: InventoryInput["position"];
  lpOwned: boolean;
  lpFees?: bigint;
  costBasis: bigint;
}
export interface InventoryDeps {
  adapter: Pick<StellarAdapter, "mode" | "agent" | "getAgent" | "getMarket" | "treasuryPosition" | "marketValuation" | "agentBuyV2" | "agentSellV2" | "publishTrace">;
  traceStore: TraceStore;
  candidates: () => Promise<InventoryCandidate[]>;
  treasury: string;
  caps: () => Promise<{ maxTrade: bigint; maxMarket: bigint; maxDaily: bigint; dailyUsed: bigint; dailyHeadroom?: bigint; availableCapital?: bigint; marketExposure?: (id: bigint) => Promise<bigint> }>;
  policy: PricePolicyView;
  hedge: Omit<HedgeConfig, "nowSecs" | "closeTimeSecs" | "feeBps">;
  deadlineSecs: number;
  dryRun?: boolean;
}

export async function inventoryTick(deps: InventoryDeps, ctx: TaskContext): Promise<void> {
  const agent = await deps.adapter.getAgent();
  if (!agent || !agent.active || (agent.roles & 2) === 0) throw new Error("inventory task requires ROLE_TRADE");
  for (const c of await deps.candidates()) {
    if (ctx.signal.aborted) return;
    await ctx.locks.withLock(c.marketId, async () => {
      const input: InventoryInput = { pool: c.pool, position: c.position, lpOwned: c.lpOwned, lpFees: c.lpFees ?? 0n, costBasis: c.costBasis };
      const inv = inventoryOf(input);
      const valuation = await deps.adapter.marketValuation(c.marketId);
      if (inv.floor !== valuation.floor_value) {
        ctx.log.warn("INVENTORY_MODEL_DRIFT", { market: c.marketId, model: inv.floor, chain: valuation.floor_value });
        return;
      }
      const caps = await deps.caps();
      const action = planHedge(input, {
        maxTrade: caps.maxTrade, maxMarket: caps.maxMarket, marketExposure: caps.marketExposure ? await caps.marketExposure(c.marketId) : 0n,
        maxDaily: caps.maxDaily, dailyUsed: caps.dailyUsed, dailyHeadroom: caps.dailyHeadroom, availableCapital: caps.availableCapital ?? 0n,
      }, deps.policy, { ...deps.hedge, nowSecs: Math.floor(ctx.now() / 1000), closeTimeSecs: Number(c.closeTime), feeBps: c.pool.feeBps });
      if (action.kind === "none") { ctx.log.info("INVENTORY_NO_HEDGE", { market: c.marketId, reason: action.reason }); return; }
      const built = buildTrace({ agent: "trader", marketId: Number(c.marketId), action: action.kind, reasoning: "bounded inventory hedge", inputs: { before: inv, action, band: deps.hedge } });
      const stored = await deps.traceStore.put(built.hash, built.json);
      if (deps.adapter.mode === "live") {
        const published = await deps.adapter.publishTrace({ agent: deps.adapter.agent, market_id: c.marketId, action: action.kind, trace_hash: Buffer.from(built.hash, "hex"), ipfs_cid: stored.cid });
        if (published.dryRun) return;
      }
      if (deps.dryRun) return;
      const deadline = BigInt(Math.floor(ctx.now() / 1000) + deps.deadlineSecs);
      await ctx.submit(async () => action.kind === "buy"
        ? deps.adapter.agentBuyV2({ market_id: c.marketId, outcome: { tag: action.outcome, values: undefined }, collateral_in: action.collateralIn, min_shares_out: action.minSharesOut, limit_price_bps: action.limitPriceBps, deadline })
        : deps.adapter.agentSellV2({ market_id: c.marketId, outcome: { tag: action.outcome, values: undefined }, collateral_out: action.collateralOut, max_shares_in: action.maxSharesIn, limit_price_bps: action.limitPriceBps, deadline }), `inventory:${c.marketId}`);
    });
  }
}

export function inventoryTask(deps: InventoryDeps, opts: { intervalMs: number; jitterMs?: number }): Task {
  return { name: "inventory", mode: deps.adapter.mode, ...opts, run: (ctx) => inventoryTick(deps, ctx) };
}
