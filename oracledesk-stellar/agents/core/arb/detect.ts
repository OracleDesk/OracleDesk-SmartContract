/**
 * Cross-market Dutch-book and monotonic-violation arbitrage detector and
 * optimal multi-leg FPMM trade sizer (#108).
 */
import { BPS, calcBuy, collateralForShares, priceYesBps } from "../fpmm.js";
import type {
  ArbMarketSnapshot,
  ExhaustivePartitionRelation,
  MarketRelation,
  MonotonicChainRelation,
  MutuallyExclusiveRelation,
} from "./relations.js";

export interface ArbLeg {
  marketId: number;
  outcome: "Yes" | "No";
  collateralIn: bigint;
  expectedShares: bigint;
  limitPriceBps: number;
}

export interface ArbOpportunity {
  relation: MarketRelation;
  kind: "dutch_book_yes" | "dutch_book_no" | "monotonic_violation";
  legs: ArbLeg[];
  totalCollateralIn: bigint;
  /** Guaranteed minimum payout across all valid joint outcome resolutions. */
  guaranteedPayout: bigint;
  /** Guaranteed net profit (`guaranteedPayout - totalCollateralIn`) in stroops. */
  guaranteedProfit: bigint;
  reasoning: string;
}

export interface ArbDetectOptions {
  /** Minimum guaranteed profit in stroops to emit an opportunity (default 1000). */
  minProfitStroops?: bigint;
  /** Maximum total collateral across all legs for one opportunity. */
  maxTotalCollateralStroops?: bigint;
}

function reservesForOutcome(
  m: ArbMarketSnapshot,
  outcome: "Yes" | "No",
): { rBought: bigint; rOther: bigint } {
  return outcome === "Yes"
    ? { rBought: m.reserveYes, rOther: m.reserveNo }
    : { rBought: m.reserveNo, rOther: m.reserveYes };
}

/**
 * Computes the total collateral needed to acquire `targetShares` on every leg,
 * along with the guaranteed net profit for the bundle.
 *
 * - For an N-leg `dutch_book_yes` on an exhaustive partition, exactly 1 YES
 *   resolves to 1 stroop per share, so `guaranteedPayout = targetShares`.
 * - For an N-leg `dutch_book_no` on mutually exclusive markets (or exhaustive
 *   partition), at least `N - 1` markets resolve NO, so buying `targetShares`
 *   of NO on every leg pays at least `(N - 1) * targetShares`.
 * - For a 2-leg `monotonic_violation` (`YES` on lower threshold `A`, `NO` on
 *   higher threshold `B` where `YES_B => YES_A`), the valid joint states
 *   `(NO_A, NO_B)`, `(YES_A, NO_B)`, `(YES_A, YES_B)` pay `s`, `2s`, `s`
 *   respectively, so `guaranteedPayout = targetShares`.
 */
export function evaluateBundleAtShares(
  markets: ArbMarketSnapshot[],
  outcomes: Array<"Yes" | "No">,
  payoutMultiplier: bigint,
  targetShares: bigint,
): {
  legs: ArbLeg[];
  totalCollateralIn: bigint;
  guaranteedPayout: bigint;
  guaranteedProfit: bigint;
} | null {
  if (targetShares <= 0n) return null;
  let totalCollateralIn = 0n;
  const legs: ArbLeg[] = [];

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const outcome = outcomes[i];
    const { rBought, rOther } = reservesForOutcome(m, outcome);
    try {
      const c = collateralForShares(rBought, rOther, targetShares, m.feeBps);
      const q = calcBuy(rBought, rOther, c, m.feeBps);
      const avgPriceBps = Number((c * BPS + q.sharesOut - 1n) / q.sharesOut);
      const limitPriceBps = Math.min(9999, Math.max(1, avgPriceBps + 25));
      totalCollateralIn += c;
      legs.push({
        marketId: m.marketId,
        outcome,
        collateralIn: c,
        expectedShares: q.sharesOut,
        limitPriceBps,
      });
    } catch {
      return null;
    }
  }

  const minShares = legs.reduce(
    (acc, l) => (l.expectedShares < acc ? l.expectedShares : acc),
    legs[0].expectedShares,
  );
  const guaranteedPayout = minShares * payoutMultiplier;
  const guaranteedProfit = guaranteedPayout - totalCollateralIn;
  return {
    legs,
    totalCollateralIn,
    guaranteedPayout,
    guaranteedProfit,
  };
}

/**
 * Finds the target share count `s > 0` maximizing `guaranteedProfit(s)`
 * (`payoutMultiplier * s - sum_i c_i(s)`), which is concave because each
 * FPMM leg's cost `c_i(s)` is strictly convex in `s`.
 */
export function sizeDutchBook(
  markets: ArbMarketSnapshot[],
  outcomes: Array<"Yes" | "No">,
  payoutMultiplier: bigint,
  maxTotalCollateralStroops?: bigint,
): {
  legs: ArbLeg[];
  totalCollateralIn: bigint;
  guaranteedPayout: bigint;
  guaranteedProfit: bigint;
} | null {
  const minReserve = markets.reduce((acc, m) => {
    const r = m.reserveYes < m.reserveNo ? m.reserveYes : m.reserveNo;
    return r < acc ? r : acc;
  }, markets[0].reserveYes);

  let lo = 100n;
  let hi = minReserve;
  if (hi <= lo) hi = lo + 1000n;

  // Ensure hi respects maxTotalCollateralStroops if specified
  if (maxTotalCollateralStroops !== undefined) {
    while (hi > lo) {
      const ev = evaluateBundleAtShares(markets, outcomes, payoutMultiplier, hi);
      if (ev && ev.totalCollateralIn <= maxTotalCollateralStroops) break;
      hi = (lo + hi) / 2n;
    }
  }

  // Ternary search on concave profit function profit(s)
  let best = evaluateBundleAtShares(markets, outcomes, payoutMultiplier, lo);
  for (let iter = 0; iter < 48 && hi - lo > 3n; iter++) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    const e1 = evaluateBundleAtShares(markets, outcomes, payoutMultiplier, m1);
    const e2 = evaluateBundleAtShares(markets, outcomes, payoutMultiplier, m2);
    if (!e1 && !e2) {
      hi = m1;
      continue;
    }
    if (e1 && (!best || e1.guaranteedProfit > best.guaranteedProfit)) best = e1;
    if (e2 && (!best || e2.guaranteedProfit > best.guaranteedProfit)) best = e2;

    const p1 = e1 ? e1.guaranteedProfit : -1_000_000_000_000_000_000n;
    const p2 = e2 ? e2.guaranteedProfit : -1_000_000_000_000_000_000n;
    if (p1 < p2) {
      lo = m1;
    } else {
      hi = m2;
    }
  }

  for (let s = lo; s <= hi; s += (hi - lo > 10n ? (hi - lo) / 10n : 1n)) {
    const ev = evaluateBundleAtShares(markets, outcomes, payoutMultiplier, s);
    if (
      ev &&
      (maxTotalCollateralStroops === undefined ||
        ev.totalCollateralIn <= maxTotalCollateralStroops) &&
      (!best || ev.guaranteedProfit > best.guaranteedProfit)
    ) {
      best = ev;
    }
    if (hi === lo) break;
  }

  if (!best || best.guaranteedProfit <= 0n) return null;
  if (
    maxTotalCollateralStroops !== undefined &&
    best.totalCollateralIn > maxTotalCollateralStroops
  ) {
    return null;
  }
  return best;
}

export function detectDutchBook(
  relation: ExhaustivePartitionRelation | MutuallyExclusiveRelation,
  marketsById: ReadonlyMap<number, ArbMarketSnapshot>,
  opts: ArbDetectOptions = {},
): ArbOpportunity | null {
  const minProfit = opts.minProfitStroops ?? 1000n;
  const markets: ArbMarketSnapshot[] = [];
  for (const id of relation.markets) {
    const m = marketsById.get(id);
    if (!m || m.status !== "Open") return null;
    markets.push(m);
  }

  const sumYesBps = markets.reduce(
    (acc, m) => acc + priceYesBps(m.reserveYes, m.reserveNo),
    0n,
  );

  // Case 1: Exhaustive partition underpriced YES bundle (sum P(YES_i) < 10000 bps)
  if (relation.kind === "exhaustive_partition" && sumYesBps < BPS) {
    const outcomes = markets.map(() => "Yes" as const);
    const sized = sizeDutchBook(markets, outcomes, 1n, opts.maxTotalCollateralStroops);
    if (sized && sized.guaranteedProfit >= minProfit) {
      return {
        relation,
        kind: "dutch_book_yes",
        ...sized,
        reasoning: `Exhaustive partition "${relation.label}" sums to ${sumYesBps} bps (< 10000 bps); buying YES across [${relation.markets.join(", ")}] locks in ${sized.guaranteedProfit} stroops guaranteed profit.`,
      };
    }
  }

  // Case 2: Overpriced YES bundle (sum P(YES_i) > 10000 bps) -> buy NO on all N legs
  // At most 1 YES can be true, so at least N - 1 legs resolve NO.
  if (sumYesBps > BPS) {
    const outcomes = markets.map(() => "No" as const);
    const payoutMultiplier = BigInt(markets.length - 1);
    const sized = sizeDutchBook(
      markets,
      outcomes,
      payoutMultiplier,
      opts.maxTotalCollateralStroops,
    );
    if (sized && sized.guaranteedProfit >= minProfit) {
      return {
        relation,
        kind: "dutch_book_no",
        ...sized,
        reasoning: `${relation.kind} "${relation.label}" sums to ${sumYesBps} bps (> 10000 bps); buying NO across [${relation.markets.join(", ")}] guarantees at least ${payoutMultiplier} winning legs and ${sized.guaranteedProfit} stroops net profit.`,
      };
    }
  }

  return null;
}

export function detectMonotonicViolation(
  relation: MonotonicChainRelation,
  marketsById: ReadonlyMap<number, ArbMarketSnapshot>,
  opts: ArbDetectOptions = {},
): ArbOpportunity | null {
  const minProfit = opts.minProfitStroops ?? 1000n;
  let bestOpp: ArbOpportunity | null = null;

  for (let i = 0; i < relation.chain.length; i++) {
    const mA = marketsById.get(relation.chain[i].marketId);
    if (!mA || mA.status !== "Open") continue;
    const pA = priceYesBps(mA.reserveYes, mA.reserveNo);

    for (let j = i + 1; j < relation.chain.length; j++) {
      const mB = marketsById.get(relation.chain[j].marketId);
      if (!mB || mB.status !== "Open") continue;
      const pB = priceYesBps(mB.reserveYes, mB.reserveNo);

      // In a valid chain, YES_B => YES_A so P(YES_A) >= P(YES_B).
      // A violation occurs when P(YES_A) < P(YES_B): buy YES_A and buy NO_B.
      if (pA < pB) {
        const sized = sizeDutchBook(
          [mA, mB],
          ["Yes", "No"],
          1n,
          opts.maxTotalCollateralStroops,
        );
        if (
          sized &&
          sized.guaranteedProfit >= minProfit &&
          (!bestOpp || sized.guaranteedProfit > bestOpp.guaranteedProfit)
        ) {
          bestOpp = {
            relation,
            kind: "monotonic_violation",
            ...sized,
            reasoning: `Monotonic violation on ${relation.asset} (${relation.comparison}): market ${mA.marketId} (threshold ${relation.chain[i].threshold}) prices YES at ${pA} bps < market ${mB.marketId} (threshold ${relation.chain[j].threshold}) at ${pB} bps; buying YES_${mA.marketId} + NO_${mB.marketId} locks in ${sized.guaranteedProfit} stroops guaranteed profit.`,
          };
        }
      }
    }
  }

  return bestOpp;
}

export function scanAllArbitrage(
  relations: MarketRelation[],
  marketsById: ReadonlyMap<number, ArbMarketSnapshot>,
  opts: ArbDetectOptions = {},
): ArbOpportunity[] {
  const results: ArbOpportunity[] = [];
  for (const rel of relations) {
    const opp =
      rel.kind === "monotonic_chain"
        ? detectMonotonicViolation(rel, marketsById, opts)
        : detectDutchBook(rel, marketsById, opts);
    if (opp) results.push(opp);
  }
  return results.sort((a, b) =>
    a.guaranteedProfit === b.guaranteedProfit
      ? 0
      : a.guaranteedProfit > b.guaranteedProfit
        ? -1
        : 1,
  );
}
