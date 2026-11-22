import type { MarketSnapshot } from './types.ts';

/**
 * Mirrors `settle_value` from `contracts/market-core` and `model/fpmm_model.py`.
 *
 * - Resolved Yes: each Yes share settles at 1:1 collateral (`yes`).
 * - Resolved No: each No share settles at 1:1 collateral (`no`).
 * - Void (`outcome === null`): each pair settles at 0.5 collateral per share,
 *   floored via integer division (`(yes + no) / 2n`), so void payouts can leave
 *   a small positive dust surplus in `market-core`.
 */
export function computeSettleValue(
  yesShares: bigint,
  noShares: bigint,
  outcome: 'Yes' | 'No' | null
): bigint {
  if (outcome === 'Yes') return yesShares;
  if (outcome === 'No') return noShares;
  return (yesShares + noShares) / 2n;
}

/**
 * Compute remaining collateral obligation for a single market.
 *
 * - Open: `setsMinted + feesAccrued`.
 * - Resolved / Void: `setsMinted - redeemedPayoutTotal - claimedPool + feesAccrued`,
 *   clamped at `0n`. Because void payouts floor per holder, `setsMinted` is an
 *   upper bound on pre-redemption payouts and may leave harmless positive dust.
 */
export function computeMarketObligation(market: MarketSnapshot): bigint {
  if (market.status === 'Open') {
    return market.setsMinted + market.feesAccrued;
  }

  let claimedPool = market.claimedPoolPayout ?? 0n;
  if (market.lpClaimed && market.claimedPoolPayout === undefined && market.reservesAtResolution) {
    claimedPool = computeSettleValue(
      market.reservesAtResolution.yes,
      market.reservesAtResolution.no,
      market.outcome
    );
  }

  const remaining =
    market.setsMinted - market.redeemedPayoutTotal - claimedPool + market.feesAccrued;
  return remaining > 0n ? remaining : 0n;
}

export interface SolvencyEvaluation {
  totalObligations: bigint;
  collateralBalance: bigint;
  /** Positive = surplus (e.g., void rounding dust); negative = deficit. */
  surplusStroops: bigint;
  deficit: boolean;
  approximateMode: boolean;
}

/**
 * Evaluate aggregate market-core solvency across all tracked markets.
 *
 * Alerts ONLY when `balance < totalObligations - tolerance`. Positive surplus
 * (such as void dust) is exposed as a metric and never triggers a deficit alert.
 */
export function evaluateSolvency(
  collateralBalance: bigint,
  markets: readonly MarketSnapshot[],
  toleranceStroops: bigint = 0n,
  approximateMode = false
): SolvencyEvaluation {
  let totalObligations = 0n;
  for (const market of markets) {
    if (approximateMode && market.status !== 'Open') {
      // Without full historical Redeemed events, only Open markets carry exact
      // obligations; resolved markets contribute a conservative 0n lower bound.
      continue;
    }
    totalObligations += computeMarketObligation(market);
  }

  const surplusStroops = collateralBalance - totalObligations;
  const deficit = collateralBalance < totalObligations - toleranceStroops;

  return {
    totalObligations,
    collateralBalance,
    surplusStroops,
    deficit,
    approximateMode,
  };
}
