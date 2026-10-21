/**
 * Crash-resilient TWAP and impact-limited multi-slice execution planner and
 * step executor (#113).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BPS } from "../fpmm.js";
import { buildTrace, type TraceStore } from "../trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import { optimalBuySize } from "./sizing.js";

export interface TwapSliceRecord {
  sliceIndex: number;
  executedAt: number;
  collateralIn: bigint;
  sharesOut: bigint;
  postPriceYesBps: number;
  traceHash: string;
  traceCid: string;
}

export interface TwapPlan {
  planId: string;
  marketId: number;
  outcome: "Yes" | "No";
  totalTargetCollateral: bigint;
  filledCollateral: bigint;
  totalShares: bigint;
  maxSlices: number;
  sliceIntervalSecs: number;
  maxSliceImpactBps: number;
  fairYesBps: number;
  minEdgeAfterFeeBps: number;
  closeTime: number;
  closeBufferSecs: number;
  parentTraceHash: string;
  parentTraceCid: string;
  slices: TwapSliceRecord[];
  status: "active" | "completed" | "cancelled";
  cancelReason?: string;
}

export interface TwapPoolState {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: number;
}

export function serializeTwapPlan(plan: TwapPlan): string {
  return JSON.stringify(
    plan,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

export function deserializeTwapPlan(json: string): TwapPlan {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    ...(raw as unknown as TwapPlan),
    totalTargetCollateral: BigInt(raw.totalTargetCollateral as string),
    filledCollateral: BigInt(raw.filledCollateral as string),
    totalShares: BigInt(raw.totalShares as string),
    slices: ((raw.slices as Array<Record<string, unknown>>) ?? []).map((s) => ({
      sliceIndex: Number(s.sliceIndex),
      executedAt: Number(s.executedAt),
      collateralIn: BigInt(s.collateralIn as string),
      sharesOut: BigInt(s.sharesOut as string),
      postPriceYesBps: Number(s.postPriceYesBps),
      traceHash: String(s.traceHash),
      traceCid: String(s.traceCid),
    })),
  };
}

export function saveTwapPlan(path: string, plan: TwapPlan): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTwapPlan(plan), "utf8");
}

export function loadTwapPlan(path: string): TwapPlan | null {
  if (!existsSync(path)) return null;
  return deserializeTwapPlan(readFileSync(path, "utf8"));
}

export async function createTwapPlan(params: {
  planId: string;
  marketId: number;
  outcome: "Yes" | "No";
  pool: TwapPoolState;
  fairYesBps: number;
  maxTotalCollateral: bigint;
  maxSliceImpactBps: number;
  minEdgeAfterFeeBps: number;
  maxSlices?: number;
  sliceIntervalSecs?: number;
  closeBufferSecs?: number;
  traceStore: TraceStore;
  now?: number;
}): Promise<TwapPlan> {
  const unClamped = optimalBuySize({
    reserveYes: params.pool.reserveYes,
    reserveNo: params.pool.reserveNo,
    feeBps: params.pool.feeBps,
    outcome: params.outcome,
    fairYesBps: params.fairYesBps,
    maxImpactBps: 0, // unconstrained impact to find full desired target
    maxCollateral: params.maxTotalCollateral,
    minEdgeAfterFeeBps: params.minEdgeAfterFeeBps,
  });

  const singleSlice = optimalBuySize({
    reserveYes: params.pool.reserveYes,
    reserveNo: params.pool.reserveNo,
    feeBps: params.pool.feeBps,
    outcome: params.outcome,
    fairYesBps: params.fairYesBps,
    maxImpactBps: params.maxSliceImpactBps,
    maxCollateral: params.maxTotalCollateral,
    minEdgeAfterFeeBps: params.minEdgeAfterFeeBps,
  });

  const totalTargetCollateral =
    unClamped.collateralIn > singleSlice.collateralIn
      ? unClamped.collateralIn
      : singleSlice.collateralIn;

  const parentTrace = buildTrace({
    agent: "trader",
    marketId: params.marketId,
    action: "buy",
    reasoning: `TWAP execution plan ${params.planId} targeting ${totalTargetCollateral} stroops on ${params.outcome} with maxSliceImpactBps=${params.maxSliceImpactBps}`,
    inputs: {
      planId: params.planId,
      outcome: params.outcome,
      fairYesBps: params.fairYesBps,
      totalTargetCollateral,
      firstSliceCollateral: singleSlice.collateralIn,
    },
    timestamp: params.now,
  });
  const { cid } = await params.traceStore.put(parentTrace.hash, parentTrace.json);

  return {
    planId: params.planId,
    marketId: params.marketId,
    outcome: params.outcome,
    totalTargetCollateral,
    filledCollateral: 0n,
    totalShares: 0n,
    maxSlices: params.maxSlices ?? 5,
    sliceIntervalSecs: params.sliceIntervalSecs ?? 30,
    maxSliceImpactBps: params.maxSliceImpactBps,
    fairYesBps: params.fairYesBps,
    minEdgeAfterFeeBps: params.minEdgeAfterFeeBps,
    closeTime: params.pool.closeTime,
    closeBufferSecs: params.closeBufferSecs ?? 120,
    parentTraceHash: parentTrace.hash,
    parentTraceCid: cid,
    slices: [],
    status: totalTargetCollateral > 0n ? "active" : "cancelled",
    cancelReason: totalTargetCollateral > 0n ? undefined : "No positive-edge size available",
  };
}

export async function stepTwapPlan(params: {
  plan: TwapPlan;
  pool: TwapPoolState;
  currentFairYesBps: number;
  adapter: StellarAdapter;
  traceStore: TraceStore;
  slippageBps?: bigint;
  deadlineSecs?: number;
  now?: number;
  planFilePath?: string;
}): Promise<TwapPlan> {
  const { plan, pool, currentFairYesBps, adapter, traceStore } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const slippageBps = params.slippageBps ?? 50n;
  const deadlineSecs = params.deadlineSecs ?? 60;

  if (plan.status !== "active") return plan;

  // Guard 1: Market close proximity
  if (now >= plan.closeTime - plan.closeBufferSecs) {
    plan.status = "cancelled";
    plan.cancelReason = "Within close buffer window before market close";
    if (params.planFilePath) saveTwapPlan(params.planFilePath, plan);
    return plan;
  }

  // Guard 2: Interval spacing between slices
  const lastSlice = plan.slices[plan.slices.length - 1];
  if (lastSlice && now - lastSlice.executedAt < plan.sliceIntervalSecs) {
    return plan;
  }

  plan.fairYesBps = currentFairYesBps;
  const remainingCollateral = plan.totalTargetCollateral - plan.filledCollateral;
  if (remainingCollateral <= 0n || plan.slices.length >= plan.maxSlices) {
    plan.status = "completed";
    if (params.planFilePath) saveTwapPlan(params.planFilePath, plan);
    return plan;
  }

  const sized = optimalBuySize({
    reserveYes: pool.reserveYes,
    reserveNo: pool.reserveNo,
    feeBps: pool.feeBps,
    outcome: plan.outcome,
    fairYesBps: currentFairYesBps,
    maxImpactBps: plan.maxSliceImpactBps,
    maxCollateral: remainingCollateral,
    minEdgeAfterFeeBps: plan.minEdgeAfterFeeBps,
  });

  if (sized.collateralIn <= 0n) {
    plan.status = "cancelled";
    plan.cancelReason = "Edge disappeared or moved within fee/impact threshold";
    if (params.planFilePath) saveTwapPlan(params.planFilePath, plan);
    return plan;
  }

  const sliceIndex = plan.slices.length;
  const childTrace = buildTrace({
    agent: "trader",
    marketId: plan.marketId,
    action: "buy",
    reasoning: `TWAP slice ${sliceIndex + 1}/${plan.maxSlices} for plan ${plan.planId} (parent=${plan.parentTraceHash})`,
    inputs: {
      parentTraceHash: plan.parentTraceHash,
      sliceIndex,
      collateralIn: sized.collateralIn,
      expectedShares: sized.expectedShares,
      postPriceYesBps: sized.postPriceYesBps,
      currentFairYesBps,
    },
    timestamp: now,
  });
  const { cid } = await traceStore.put(childTrace.hash, childTrace.json);

  const outcomeArg = { tag: plan.outcome, values: undefined as void };
  const quoted = await adapter.quoteBuy({
    market_id: BigInt(plan.marketId),
    outcome: outcomeArg,
    collateral_in: sized.collateralIn,
  });
  const minSharesOut = (quoted * (BPS - slippageBps)) / BPS;
  const limitPriceBps =
    plan.outcome === "Yes" ? currentFairYesBps : 10_000 - currentFairYesBps;
  const deadline = BigInt(now + deadlineSecs);

  const res = await adapter.agentBuyV2({
    market_id: BigInt(plan.marketId),
    outcome: outcomeArg,
    collateral_in: sized.collateralIn,
    min_shares_out: minSharesOut,
    limit_price_bps: limitPriceBps,
    deadline,
  });
  const actualShares = res.dryRun ? quoted : res.value;

  if (!res.dryRun) {
    await adapter.publishTrace({
      agent: adapter.agent,
      market_id: BigInt(plan.marketId),
      action: "buy",
      trace_hash: Buffer.from(childTrace.hash, "hex"),
      ipfs_cid: cid,
    });
  }

  plan.filledCollateral += sized.collateralIn;
  plan.totalShares += actualShares;
  plan.slices.push({
    sliceIndex,
    executedAt: now,
    collateralIn: sized.collateralIn,
    sharesOut: actualShares,
    postPriceYesBps: sized.postPriceYesBps,
    traceHash: childTrace.hash,
    traceCid: cid,
  });

  if (
    plan.filledCollateral >= plan.totalTargetCollateral ||
    plan.slices.length >= plan.maxSlices
  ) {
    plan.status = "completed";
  }

  if (params.planFilePath) saveTwapPlan(params.planFilePath, plan);
  return plan;
}
