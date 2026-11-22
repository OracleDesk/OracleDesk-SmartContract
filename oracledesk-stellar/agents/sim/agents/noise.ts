/**
 * Uninformed flow: on each step, with probability `activity`, buys or sells
 * a random amount of a random outcome in a random open market. Sells are
 * sized in collateral without checking holdings, so oversized ones revert
 * with `InsufficientShares` exactly as on-chain (never silently clamped).
 */
import type { Rng } from "../rng.js";
import type { Observation, Order, SimAgent } from "../types.js";

export interface NoiseTraderOptions {
  activity: number;
  minTrade: bigint;
  maxTrade: bigint;
  /** Probability an action is a sell rather than a buy. */
  sellProb: number;
}

export class NoiseTrader implements SimAgent {
  constructor(
    readonly id: string,
    private readonly o: NoiseTraderOptions,
    readonly account = id,
  ) {}

  act(obs: Observation, rng: Rng): Order[] {
    if (obs.markets.length === 0 || !rng.chance(this.o.activity)) return [];
    const market = obs.markets[rng.int(obs.markets.length)]!;
    const outcome = rng.chance(0.5) ? "Yes" : "No";
    const amount = rng.bigBetween(this.o.minTrade, this.o.maxTrade);
    if (rng.chance(this.o.sellProb)) {
      const held = obs.positions[market.id]?.[outcome === "Yes" ? "yes" : "no"] ?? 0n;
      if (held === 0n) return [];
      // A loose share bound: market-core checks slippage before holdings, so
      // an oversized sell must get past it to revert with InsufficientShares.
      return [{ kind: "sell", marketId: market.id, outcome, collateralOut: amount / 2n, maxSharesIn: held + amount * 4n }];
    }
    if (obs.balance < amount) return [];
    return [{ kind: "buy", marketId: market.id, outcome, collateralIn: amount, minSharesOut: 0n }];
  }
}
