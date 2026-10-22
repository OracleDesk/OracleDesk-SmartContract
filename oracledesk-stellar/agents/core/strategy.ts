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

import { calcBuy, priceAfterBuy, priceYesBps } from "./fpmm.js";

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
  /** For signals about an oracle-tracked asset: the price rule the market
   * should resolve by (`asset` is `stellar:<address>` or `other:<symbol>`).
   * Selects a PriceConfig spec in the market-maker (see core/spec.ts). */
  priceRule?: {
    asset: string;
    threshold: string;
    direction: "above" | "at-or-above" | "below" | "at-or-below";
  };
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
  /** Pool reserves in stroops, if known. Required when the caller sets
   * `maxImpactBps` on `decideTrade`. */
  reserveYesStroops?: bigint;
  reserveNoStroops?: bigint;
  /** The market's snapshotted trading fee, if known. Required when the
   * caller sets `maxImpactBps` on `decideTrade`. */
  feeBps?: number;
}

export interface TraderDecision {
  action: "buy" | "skip";
  reasoning: string;
  outcome?: "Yes" | "No";
  collateralInStroops?: bigint;
}

/**
 * Largest `size <= maxSize` whose estimated price impact stays at or below
 * `maxImpactBps`, found by binary search over `calcBuy` (impact is
 * monotone in size for buys). Sizes whose fee consumes the whole amount
 * are treated as infeasible. Returns 0n when even the smallest executable
 * size would move the price too far.
 */
function clampSizeToImpact(
  market: MarketState,
  outcome: "Yes" | "No",
  maxSize: bigint,
  maxImpactBps: number,
): bigint {
  const { reserveYesStroops: rYes, reserveNoStroops: rNo, feeBps } = market;
  if (rYes === undefined || rNo === undefined || feeBps === undefined) {
    throw new Error(
      "decideTrade: maxImpactBps requires reserveYesStroops, reserveNoStroops and feeBps on the market state",
    );
  }
  const takenIsYes = outcome === "Yes";
  const rBought = takenIsYes ? rYes : rNo;
  const rOther = takenIsYes ? rNo : rYes;
  const pre = priceYesBps(rYes, rNo);
  const cap = BigInt(maxImpactBps);
  const impact = (size: bigint): bigint | null => {
    if (size <= 0n) return 0n;
    let post: bigint;
    try {
      post = priceAfterBuy(takenIsYes, calcBuy(rBought, rOther, size, BigInt(feeBps)));
    } catch {
      return null; // fee consumes the whole amount — not executable at all
    }
    return post > pre ? post - pre : pre - post;
  };
  let lo = 0n;
  let hi = maxSize;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const m = impact(mid);
    if (m !== null && m <= cap) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Compares a market's implied probability to a fair-value estimate and
 * decides whether the mispricing is worth trading. Trades toward whichever
 * side the market is *underpricing* relative to the estimate.
 *
 * With `maxImpactBps` set to a positive value, the trade size is clamped
 * so the estimated price impact stays below the market's on-chain breaker
 * (the market state must then carry reserves and `feeBps`); if even the
 * smallest size would trip it, the decision is a skip instead of a
 * guaranteed revert. `0` or omitted disables the clamp, matching the
 * on-chain breaker's "0 = disabled" semantics.
 */
export function decideTrade(
  market: MarketState,
  fairValueBps: number,
  opts: { minEdgeBps: number; tradeSizeStroops: bigint; maxImpactBps?: number },
): TraderDecision {
  const edge = fairValueBps - market.yesBps; // positive => YES underpriced
  if (Math.abs(edge) < opts.minEdgeBps) {
    return {
      action: "skip",
      reasoning: `edge ${edge}bps on market ${market.marketId} is below the ${opts.minEdgeBps}bps threshold`,
    };
  }
  const outcome = edge > 0 ? "Yes" : "No";
  let collateralInStroops = opts.tradeSizeStroops;
  let clampNote = "";
  if (opts.maxImpactBps !== undefined && opts.maxImpactBps > 0) {
    collateralInStroops = clampSizeToImpact(market, outcome, opts.tradeSizeStroops, opts.maxImpactBps);
    if (collateralInStroops <= 0n) {
      return {
        action: "skip",
        reasoning: `every size up to ${opts.tradeSizeStroops} stroops would move market ${market.marketId}'s price by more than ${opts.maxImpactBps}bps — the on-chain breaker would reject the trade`,
      };
    }
    if (collateralInStroops < opts.tradeSizeStroops) {
      clampNote = `; size clamped from ${opts.tradeSizeStroops} to ${collateralInStroops} stroops to stay under the ${opts.maxImpactBps}bps impact breaker`;
    }
  }
  return {
    action: "buy",
    reasoning: `market ${market.marketId} prices YES at ${market.yesBps}bps vs fair value ${fairValueBps}bps (edge ${edge}bps) — buying ${outcome}${clampNote}`,
    outcome,
    collateralInStroops,
  };
}
