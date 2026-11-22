/**
 * Trader with a private noisy signal of each market's latent probability:
 * buys whichever side the pool underprices by more than `minEdgeBps`.
 */
import { BPS, calcBuy } from "../../core/fpmm.js";
import type { Rng } from "../rng.js";
import type { AgentContext, Observation, Order, SimAgent } from "../types.js";

export interface InformedTraderOptions {
  activity: number;
  noiseBps: number;
  minEdgeBps: number;
  tradeSize: bigint;
  slippageBps: number;
}

export class InformedTrader implements SimAgent {
  constructor(
    readonly id: string,
    private readonly ctx: AgentContext,
    private readonly o: InformedTraderOptions,
    readonly account = id,
  ) {}

  act(obs: Observation, rng: Rng): Order[] {
    const orders: Order[] = [];
    let budget = obs.balance;
    for (const m of obs.markets) {
      if (!rng.chance(this.o.activity) || budget < this.o.tradeSize) continue;
      const fair = this.ctx.signal(`informed:${this.id}`, m.id, obs.t, this.o.noiseBps);
      const edge = fair - Number(m.yesBps);
      if (Math.abs(edge) < this.o.minEdgeBps) continue;
      const outcome = edge > 0 ? "Yes" : "No";
      const yes = outcome === "Yes";
      let quoted: bigint;
      try {
        quoted = calcBuy(yes ? m.reserveYes : m.reserveNo, yes ? m.reserveNo : m.reserveYes, this.o.tradeSize, m.feeBps).sharesOut;
      } catch {
        continue;
      }
      budget -= this.o.tradeSize;
      orders.push({
        kind: "buy",
        marketId: m.id,
        outcome,
        collateralIn: this.o.tradeSize,
        minSharesOut: (quoted * (BPS - BigInt(this.o.slippageBps))) / BPS,
      });
    }
    return orders;
  }
}
