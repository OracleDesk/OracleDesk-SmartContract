/** Agent-facing types of the simulator. */
import type { Outcome, Position } from "./market.js";
import type { Rng } from "./rng.js";

export interface MarketView {
  id: number;
  yesBps: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  closeTime: bigint;
  creator: string;
}

export interface Observation {
  t: bigint;
  /** Markets still open for trading at `t`, by id. */
  markets: ReadonlyArray<MarketView>;
  /** Orders already submitted this step (only shown to mempool watchers). */
  mempool: ReadonlyArray<PendingOrder>;
  /** The observing agent's collateral balance and positions. */
  balance: bigint;
  positions: Readonly<Record<number, Position>>;
}

export type Order = (
  | { kind: "buy"; marketId: number; outcome: Outcome; collateralIn: bigint; minSharesOut: bigint }
  | { kind: "sell"; marketId: number; outcome: Outcome; collateralOut: bigint; maxSharesIn: bigint }
  /** Client-side "sell N shares": converted at execution to the largest
   * `collateral_out` whose `calcSell` needs at most `shares`. */
  | { kind: "sellShares"; marketId: number; outcome: Outcome; shares: bigint | "all" }
  | { kind: "create"; seed: bigint; yesBps: bigint; closeIn: bigint }
) & {
  /** Sandwich placement relative to mempool index `victim` (sandwich policy only). */
  sandwich?: { victim: number; leg: "front" | "back" };
  /** Free-form numbers the engine records with the fill (e.g. fair value). */
  meta?: Record<string, number>;
};

export type PendingOrder = Order & { agentId: string; seq: number };

/** Privileged sim-only information an agent may be given at construction. */
export interface AgentContext {
  /** Noisy private estimate of market `marketId`'s latent p at `t`, in bps.
   * Agents passing the same `group` receive identical noise. */
  signal(group: string, marketId: number, t: bigint, noiseBps: number): number;
  /** Same, for the market the next `create` will open. */
  nextMarketSignal(group: string, t: bigint, noiseBps: number): number;
}

export interface SimAgent {
  id: string;
  /** Ledger account whose PnL this agent is judged on (its treasury, if any). */
  account: string;
  /** Treasury this agent trades through, if any. */
  treasury?: string;
  /** Sees the mempool and may sandwich (acts after everyone else). */
  watchesMempool?: boolean;
  act(obs: Observation, rng: Rng): Order[];
}
