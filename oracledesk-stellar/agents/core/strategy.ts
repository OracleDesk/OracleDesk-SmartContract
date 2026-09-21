/**
 * Chain-agnostic strategy interfaces for the two agent roles.
 *
 * Note on provenance: the Arc-era `oracledesk-contracts/agents/*.ts` files
 * this repo was ported from turned out to contain only EVM/Circle/Polymarket
 * *execution* plumbing (ABI encoding, Circle Developer-Controlled Wallets,
 * EIP-712 order signing) — exactly what the design brief says to remove.
 * There was no reusable chain-agnostic "mispricing detection" or
 * "fair value estimate" algorithm to port; this file is a fresh, minimal
 * implementation of the roles described in the design doc, not a port.
 */

export interface MarketSignal {
  /** Free-text description of what was observed (a news event, an oracle
   * feed update, a Polymarket price move, etc). */
  summary: string;
  /** A proposed question for a new market, if this signal is strong enough
   * to act on. */
  proposedQuestion?: string;
  /** The market maker's estimate of the true probability, in basis points
   * (0..=10000), if this signal implies one. */
  fairValueBps?: number;
  source: string;
  observedAt: number; // unix seconds
}

export interface SignalSource {
  name: string;
  poll(): Promise<MarketSignal[]>;
}

/**
 * A read-only, execution-free reference price. Polymarket may be used as
 * one of these (never for execution — see the design doc) but this
 * interface has no Polymarket-specific shape, so any comparable public
 * market's mid-price can implement it too.
 */
export interface ReferencePriceSource {
  name: string;
  /** Best available estimate of true probability for a described question,
   * in basis points, or `null` if no comparable reference exists. */
  fairValueBps(question: string): Promise<number | null>;
}

export interface MarketMakerDecision {
  action: "propose_market" | "skip";
  reasoning: string;
  question?: string;
  initialYesBps?: number;
  seedAmountStroops?: bigint;
}

/**
 * Turns a signal into a market-creation decision. `confidenceThresholdBps`
 * is how far from 50/50 a signal's fair value must be before it's worth
 * seeding a market at all — a low-confidence signal is skipped rather than
 * creating a market nobody would trade.
 */
export function decideMarketProposal(
  signal: MarketSignal,
  opts: { confidenceThresholdBps: number; defaultSeedStroops: bigint },
): MarketMakerDecision {
  if (!signal.proposedQuestion || signal.fairValueBps === undefined) {
    return { action: "skip", reasoning: `signal from ${signal.source} has no actionable question/estimate` };
  }
  const distanceFrom50 = Math.abs(signal.fairValueBps - 5000);
  if (distanceFrom50 < opts.confidenceThresholdBps) {
    return {
      action: "skip",
      reasoning: `fair value ${signal.fairValueBps}bps is within ${opts.confidenceThresholdBps}bps of 50/50 — not confident enough to seed a market`,
    };
  }
  return {
    action: "propose_market",
    reasoning: `${signal.source} implies fair value ${signal.fairValueBps}bps, ${distanceFrom50}bps from 50/50: "${signal.summary}"`,
    question: signal.proposedQuestion,
    initialYesBps: signal.fairValueBps,
    seedAmountStroops: opts.defaultSeedStroops,
  };
}

export interface MarketState {
  marketId: number;
  question: string;
  yesBps: number; // current market-implied probability
  closeTime: number;
}

export interface TraderDecision {
  action: "buy" | "skip";
  reasoning: string;
  outcome?: "Yes" | "No";
  collateralInStroops?: bigint;
}

/**
 * Compares a market's implied probability to a fair-value estimate and
 * decides whether the mispricing is worth trading. Trades toward whichever
 * side the market is *underpricing* relative to the estimate.
 */
export function decideTrade(
  market: MarketState,
  fairValueBps: number,
  opts: { minEdgeBps: number; tradeSizeStroops: bigint },
): TraderDecision {
  const edge = fairValueBps - market.yesBps; // positive => YES underpriced
  if (Math.abs(edge) < opts.minEdgeBps) {
    return {
      action: "skip",
      reasoning: `edge ${edge}bps on market ${market.marketId} is below the ${opts.minEdgeBps}bps threshold`,
    };
  }
  const outcome = edge > 0 ? "Yes" : "No";
  return {
    action: "buy",
    reasoning: `market ${market.marketId} prices YES at ${market.yesBps}bps vs fair value ${fairValueBps}bps (edge ${edge}bps) — buying ${outcome}`,
    outcome,
    collateralInStroops: opts.tradeSizeStroops,
  };
}
