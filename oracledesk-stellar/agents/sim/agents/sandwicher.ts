/**
 * Adversary that watches the mempool: for every pending buy of at least
 * `minVictim` it front-runs with a same-side buy of `frontSize` and
 * back-runs by selling everything it holds of that outcome. Only effective
 * under the "sandwich" ordering policy, which places the legs immediately
 * before and after the victim; under "shuffle" its legs land at random.
 */
import type { Rng } from "../rng.js";
import type { Observation, Order, SimAgent } from "../types.js";

export interface SandwicherOptions {
  minVictim: bigint;
  frontSize: bigint;
  /** Probability of attacking an eligible victim. */
  aggression: number;
}

export class Sandwicher implements SimAgent {
  readonly watchesMempool = true;

  constructor(
    readonly id: string,
    private readonly o: SandwicherOptions,
    readonly account = id,
  ) {}

  act(obs: Observation, rng: Rng): Order[] {
    const orders: Order[] = [];
    const open = new Set(obs.markets.map((m) => m.id));
    const attacked = new Set<string>();
    let budget = obs.balance;
    obs.mempool.forEach((victim, index) => {
      if (victim.kind !== "buy" || victim.agentId === this.id || !open.has(victim.marketId)) return;
      if (victim.collateralIn < this.o.minVictim || budget < this.o.frontSize) return;
      const key = `${victim.marketId}:${victim.outcome}`;
      if (attacked.has(key) || !rng.chance(this.o.aggression)) return;
      attacked.add(key);
      budget -= this.o.frontSize;
      const target = { marketId: victim.marketId, outcome: victim.outcome };
      orders.push({ kind: "buy", ...target, collateralIn: this.o.frontSize, minSharesOut: 0n, sandwich: { victim: index, leg: "front" } });
      orders.push({ kind: "sellShares", ...target, shares: "all", sandwich: { victim: index, leg: "back" } });
    });
    return orders;
  }
}
