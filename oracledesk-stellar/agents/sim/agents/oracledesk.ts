/**
 * Our own strategies, run unmodified through the simulator:
 * `OracleDeskTrader` wraps `decideTrade` (or any function with its shape)
 * and `OracleDeskMaker` wraps `decideMarketProposal`, both acting through a
 * simulated treasury. N clones are N traders with their own treasuries and
 * the same `signalGroup`, so they see identical signals.
 */
import { BPS, calcBuy } from "../../core/fpmm.js";
import { decideMarketProposal, decideTrade, type MarketState, type TraderDecision } from "../../core/strategy.js";
import type { Rng } from "../rng.js";
import type { AgentContext, Observation, Order, SimAgent } from "../types.js";

export type TradeStrategy = (
  market: MarketState,
  fairValueBps: number,
  opts: { minEdgeBps: number; tradeSizeStroops: bigint; maxImpactBps?: number },
) => TraderDecision;

export interface OracleDeskTraderOptions {
  signalGroup: string;
  signalNoiseBps: number;
  minEdgeBps: number;
  tradeSize: bigint;
  /** "fixed": always `tradeSize`; "edge": `tradeSize * |edge| / edgeScaleBps`, capped at `tradeSize`. */
  sizing: "fixed" | "edge";
  edgeScaleBps?: number;
  /** `min_shares_out = quote * (1 - slippage)`; null sends 0 (no protection). */
  slippageBps: number | null;
  maxImpactBps?: number;
  strategy?: TradeStrategy;
}

export class OracleDeskTrader implements SimAgent {
  constructor(
    readonly id: string,
    readonly treasury: string,
    private readonly ctx: AgentContext,
    private readonly o: OracleDeskTraderOptions,
  ) {}

  get account(): string {
    return this.treasury;
  }

  act(obs: Observation): Order[] {
    const strategy = this.o.strategy ?? decideTrade;
    const orders: Order[] = [];
    for (const m of obs.markets) {
      const fair = this.ctx.signal(this.o.signalGroup, m.id, obs.t, this.o.signalNoiseBps);
      const state: MarketState = {
        marketId: m.id,
        question: `sim market ${m.id}`,
        yesBps: Number(m.yesBps),
        closeTime: Number(m.closeTime),
        reserveYesStroops: m.reserveYes,
        reserveNoStroops: m.reserveNo,
        feeBps: Number(m.feeBps),
      };
      const decision = strategy(state, fair, {
        minEdgeBps: this.o.minEdgeBps,
        tradeSizeStroops: this.o.tradeSize,
        maxImpactBps: this.o.maxImpactBps,
      });
      if (decision.action !== "buy" || !decision.outcome || !decision.collateralInStroops) continue;
      let size = decision.collateralInStroops;
      if (this.o.sizing === "edge") {
        const edge = BigInt(Math.abs(fair - state.yesBps));
        const scaled = (this.o.tradeSize * edge) / BigInt(this.o.edgeScaleBps ?? 2_000);
        size = scaled < size ? scaled : size;
      }
      if (size <= 0n) continue;
      const yes = decision.outcome === "Yes";
      let minSharesOut = 0n;
      if (this.o.slippageBps !== null) {
        try {
          const q = calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, size, m.feeBps);
          minSharesOut = (q.sharesOut * (BPS - BigInt(this.o.slippageBps))) / BPS;
        } catch {
          continue;
        }
      }
      orders.push({
        kind: "buy",
        marketId: m.id,
        outcome: decision.outcome,
        collateralIn: size,
        minSharesOut,
        meta: { fairValueBps: fair, side: yes ? 1 : -1 },
      });
    }
    return orders;
  }
}

export interface OracleDeskMakerOptions {
  signalGroup: string;
  signalNoiseBps: number;
  everySteps: number;
  maxMarkets: number;
  confidenceThresholdBps: number;
  seed: bigint;
  closeIn: bigint;
}

export class OracleDeskMaker implements SimAgent {
  private steps = 0;
  private created = 0;

  constructor(
    readonly id: string,
    readonly treasury: string,
    private readonly ctx: AgentContext,
    private readonly o: OracleDeskMakerOptions,
  ) {}

  get account(): string {
    return this.treasury;
  }

  act(obs: Observation, _rng: Rng): Order[] {
    if (this.steps++ % this.o.everySteps !== 0 || this.created >= this.o.maxMarkets) return [];
    const fair = this.ctx.nextMarketSignal(this.o.signalGroup, obs.t, this.o.signalNoiseBps);
    const decision = decideMarketProposal(
      { summary: "sim signal", proposedQuestion: `sim market @${obs.t}`, fairValueBps: fair, source: this.id, observedAt: Number(obs.t) },
      { confidenceThresholdBps: this.o.confidenceThresholdBps, defaultSeedStroops: this.o.seed },
    );
    if (decision.action !== "propose_market") return [];
    this.created++;
    return [{ kind: "create", seed: decision.seedAmountStroops!, yesBps: BigInt(decision.initialYesBps!), closeIn: this.o.closeIn }];
  }
}
