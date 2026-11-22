import { computeSettleValue } from './solvency.ts';
import type { MarketSnapshot, MonitorEvent } from './types.ts';

/**
 * Determine which market IDs should be polled in the current tick:
 *   - All currently Open markets
 *   - Markets resolved but not yet `lpClaimed`
 *   - Markets touched by an event in the current tick
 *   - Or ALL markets (`1..marketCount`) when `fullSweep` is true (hourly).
 */
export function selectMarketsToPoll(
  marketCount: number,
  cachedMarkets: ReadonlyMap<number, MarketSnapshot>,
  recentEvents: readonly MonitorEvent[],
  fullSweep: boolean
): number[] {
  if (fullSweep) {
    return Array.from({ length: marketCount }, (_, i) => i + 1);
  }

  const ids = new Set<number>();

  for (const [id, m] of cachedMarkets.entries()) {
    if (m.status === 'Open' || !m.lpClaimed) {
      ids.add(id);
    }
  }

  // Always poll any newly created market IDs beyond the cache
  for (let id = 1; id <= marketCount; id++) {
    if (!cachedMarkets.has(id)) {
      ids.add(id);
    }
  }

  for (const evt of recentEvents) {
    if ('marketId' in evt && typeof evt.marketId === 'number' && evt.marketId > 0) {
      ids.add(evt.marketId);
    }
  }

  return Array.from(ids).sort((a, b) => a - b);
}

/**
 * Reconcile a freshly polled market with its previous cached state and any
 * newly arrived `Redeemed` events:
 *   - Accumulates `redeemedPayoutTotal` from `Redeemed` events
 *   - Latches `reservesAtResolution` when a market is Resolved/Void before `lpClaimed` flips
 *   - Computes `claimedPoolPayout = settle_value(reservesAtResolution)` when `lpClaimed` flips from false to true.
 */
export function reconcilePolledMarket(
  fresh: MarketSnapshot,
  previous: MarketSnapshot | undefined,
  recentEvents: readonly MonitorEvent[]
): MarketSnapshot {
  let redeemedPayoutTotal = previous?.redeemedPayoutTotal ?? fresh.redeemedPayoutTotal ?? 0n;
  for (const evt of recentEvents) {
    if (evt.kind === 'redeemed' && evt.marketId === fresh.marketId) {
      redeemedPayoutTotal += evt.payout;
    }
  }

  let reservesAtResolution = previous?.reservesAtResolution ?? fresh.reservesAtResolution;
  if (fresh.status !== 'Open' && !fresh.lpClaimed) {
    reservesAtResolution = {
      yes: fresh.reserveYes,
      no: fresh.reserveNo,
    };
  }

  let claimedPoolPayout = previous?.claimedPoolPayout ?? fresh.claimedPoolPayout;
  if (fresh.lpClaimed && claimedPoolPayout === undefined && reservesAtResolution) {
    claimedPoolPayout = computeSettleValue(
      reservesAtResolution.yes,
      reservesAtResolution.no,
      fresh.outcome
    );
  }

  return {
    ...fresh,
    redeemedPayoutTotal,
    reservesAtResolution,
    claimedPoolPayout,
  };
}
