/**
 * Multi-leg arbitrage executor with pre-execution re-quoting, single shared
 * reasoning trace, and automatic unwind recovery if a middle leg reverts (#108).
 */
import { BPS, collateralOutForShares } from "../fpmm.js";
import { buildTrace, type TraceStore } from "../trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { ArbLeg, ArbOpportunity } from "./detect.js";
import type { ArbMarketSnapshot } from "./relations.js";

export interface ExecutedArbLeg {
  leg: ArbLeg;
  sharesReceived: bigint;
}

export interface ArbExecutionResult {
  status: "completed" | "aborted_precheck" | "unwound_partial";
  traceHash: string;
  traceCid: string;
  completedLegs: ExecutedArbLeg[];
  unwoundLegs: number[];
  error?: string;
}

export interface ExecuteArbitrageOptions {
  slippageBps?: bigint;
  deadlineSecs?: number;
  now?: () => number;
}

export async function executeArbitrage(
  opp: ArbOpportunity,
  marketsById: ReadonlyMap<number, ArbMarketSnapshot>,
  adapter: StellarAdapter,
  traceStore: TraceStore,
  opts: ExecuteArbitrageOptions = {},
): Promise<ArbExecutionResult> {
  const slippageBps = opts.slippageBps ?? 50n;
  const deadlineSecs = opts.deadlineSecs ?? 60;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const built = buildTrace({
    agent: "trader",
    marketId: opp.legs[0]?.marketId ?? null,
    action: "buy",
    reasoning: opp.reasoning,
    inputs: {
      kind: opp.kind,
      relation: opp.relation,
      legs: opp.legs,
      totalCollateralIn: opp.totalCollateralIn,
      guaranteedPayout: opp.guaranteedPayout,
      guaranteedProfit: opp.guaranteedProfit,
    },
  });
  const { cid } = await traceStore.put(built.hash, built.json);

  // Step 1: Pre-check fresh quotes on all legs before submitting any transaction
  const freshQuotes: bigint[] = [];
  for (const leg of opp.legs) {
    const quoted = await adapter.quoteBuy({
      market_id: BigInt(leg.marketId),
      outcome: { tag: leg.outcome, values: undefined as void },
      collateral_in: leg.collateralIn,
    });
    const minAcceptable = (leg.expectedShares * (BPS - slippageBps)) / BPS;
    if (quoted < minAcceptable) {
      return {
        status: "aborted_precheck",
        traceHash: built.hash,
        traceCid: cid,
        completedLegs: [],
        unwoundLegs: [],
        error: `Pre-quote on market ${leg.marketId} (${quoted}) fell below min_shares_out (${minAcceptable})`,
      };
    }
    freshQuotes.push(quoted);
  }

  // Step 2: Execute legs sequentially with tight slippage and limit_price_bps
  const completedLegs: ExecutedArbLeg[] = [];
  const deadline = BigInt(now() + deadlineSecs);

  for (let i = 0; i < opp.legs.length; i++) {
    const leg = opp.legs[i];
    const quoted = freshQuotes[i];
    const minSharesOut = (quoted * (BPS - slippageBps)) / BPS;
    try {
      const res = await adapter.agentBuyV2({
        market_id: BigInt(leg.marketId),
        outcome: { tag: leg.outcome, values: undefined as void },
        collateral_in: leg.collateralIn,
        min_shares_out: minSharesOut,
        limit_price_bps: leg.limitPriceBps,
        deadline,
      });
      const actualShares = res.dryRun ? quoted : res.value;
      completedLegs.push({ leg, sharesReceived: actualShares });

      if (!res.dryRun) {
        await adapter.publishTrace({
          agent: adapter.agent,
          market_id: BigInt(leg.marketId),
          action: "buy",
          trace_hash: Buffer.from(built.hash, "hex"),
          ipfs_cid: cid,
        });
      }
    } catch (err) {
      // Middle leg failed: unwind already-executed legs in reverse order
      const unwoundLegs: number[] = [];
      for (let j = completedLegs.length - 1; j >= 0; j--) {
        const done = completedLegs[j];
        const snap = marketsById.get(done.leg.marketId);
        let collateralOut = (done.leg.collateralIn * 9500n) / BPS;
        if (snap) {
          const rSold = done.leg.outcome === "Yes" ? snap.reserveYes : snap.reserveNo;
          const rOther = done.leg.outcome === "Yes" ? snap.reserveNo : snap.reserveYes;
          try {
            collateralOut = collateralOutForShares(
              rSold,
              rOther,
              done.sharesReceived,
              snap.feeBps,
            );
          } catch {
            // Fallback to conservative 95% estimate
          }
        }
        try {
          await adapter.agentSellV2({
            market_id: BigInt(done.leg.marketId),
            outcome: { tag: done.leg.outcome, values: undefined as void },
            collateral_out: (collateralOut * (BPS - slippageBps)) / BPS,
            max_shares_in: done.sharesReceived,
            limit_price_bps: 1,
            deadline,
          });
          unwoundLegs.push(done.leg.marketId);
        } catch {
          // Best-effort unwind
        }
      }
      return {
        status: "unwound_partial",
        traceHash: built.hash,
        traceCid: cid,
        completedLegs,
        unwoundLegs,
        error: (err as Error).message,
      };
    }
  }

  return {
    status: "completed",
    traceHash: built.hash,
    traceCid: cid,
    completedLegs,
    unwoundLegs: [],
  };
}
