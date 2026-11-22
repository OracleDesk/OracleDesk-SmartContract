import {
  BPS,
  MAX_SETS,
  MathError,
  calcBuy,
  calcSell,
  collateralOutForShares,
  priceYesBps,
} from "./fpmm.js";

const MAX_COLLATERAL = (1n << 127n) - 1n;

export interface PoolView {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  setsMinted: bigint;
}

export interface Holdings {
  yes: bigint;
  no: bigint;
}

export interface CapsView {
  maxTrade: bigint;
  maxMarket: bigint;
  marketExposure: bigint;
  maxDaily: bigint;
  dailyUsed: bigint;
  dailyHeadroom?: bigint;
  availableCapital: bigint;
}

export interface Belief {
  fairYesBps: bigint;
  uncertaintyBps: bigint;
}

export interface SizingParams {
  kellyFractionNumerator: bigint;
  kellyFractionDenominator: bigint;
  bufferBps: bigint;
  slippageBps: bigint;
  minTradeStroops: bigint;
}

export type Binding =
  | "impact"
  | "kelly"
  | "max_trade"
  | "max_market"
  | "max_daily"
  | "capital"
  | "max_sets"
  | "dust";

export interface SizingReport {
  inputs: {
    pool: PoolView;
    holdings: Holdings;
    caps: CapsView;
    belief: Belief;
    params: SizingParams;
    effectiveProbabilityBps: bigint;
    targetBps: bigint;
    bankroll: bigint;
  };
  impactC: bigint;
  kellyC: bigint;
  limits: Record<Exclude<Binding, "dust">, bigint>;
  size: bigint;
  binding: Binding;
}

export interface SizedBuy {
  outcome: "Yes" | "No";
  collateralIn: bigint;
  minSharesOut: bigint;
  expectedShares: bigint;
  priceAfterBps: bigint;
  binding: Binding;
  report: SizingReport;
}

export interface SizeBuyResult {
  buy?: SizedBuy;
  report: SizingReport;
}

export interface SizedSell {
  outcome: "Yes" | "No";
  collateralOut: bigint;
  maxSharesIn: bigint;
  expectedSharesIn: bigint;
  priceAfterBps: bigint;
}

function orient(pool: PoolView, outcome: "Yes" | "No"): [bigint, bigint] {
  return outcome === "Yes"
    ? [pool.reserveYes, pool.reserveNo]
    : [pool.reserveNo, pool.reserveYes];
}

function validateParams(params: SizingParams): void {
  if (
    params.kellyFractionDenominator <= 0n ||
    params.kellyFractionNumerator <= 0n ||
    params.kellyFractionNumerator > params.kellyFractionDenominator ||
    params.bufferBps < 0n ||
    params.slippageBps < 0n ||
    params.slippageBps > BPS ||
    params.minTradeStroops < 0n
  ) {
    throw new RangeError("invalid sizing parameters");
  }
}

function boundedBelief(
  pool: PoolView,
  belief: Belief,
  outcome: "Yes" | "No",
): { probability: bigint; currentPrice: bigint } {
  if (belief.fairYesBps < 0n || belief.fairYesBps > BPS || belief.uncertaintyBps < 0n) {
    throw new RangeError("belief must be within basis-point bounds");
  }
  const currentYes = priceYesBps(pool.reserveYes, pool.reserveNo);
  const currentPrice = outcome === "Yes" ? currentYes : BPS - currentYes;
  const fair = outcome === "Yes" ? belief.fairYesBps : BPS - belief.fairYesBps;
  const direction = fair >= currentPrice ? 1n : -1n;
  let probability = fair - direction * belief.uncertaintyBps;
  probability = direction > 0n
    ? (probability < currentPrice ? currentPrice : probability)
    : (probability > currentPrice ? currentPrice : probability);
  if (probability < 0n) probability = 0n;
  if (probability > BPS) probability = BPS;
  return { probability, currentPrice };
}

function priceAfterBuy(pool: PoolView, outcome: "Yes" | "No", collateral: bigint): bigint | null {
  if (collateral === 0n) {
    const yesPrice = priceYesBps(pool.reserveYes, pool.reserveNo);
    return outcome === "Yes" ? yesPrice : BPS - yesPrice;
  }
  const [bought, other] = orient(pool, outcome);
  try {
    const quote = calcBuy(bought, other, collateral, pool.feeBps);
    return (quote.newReserveOther * BPS) / (quote.newReserveBought + quote.newReserveOther);
  } catch (error) {
    if (error instanceof MathError) return null;
    throw error;
  }
}

/**
 * For increasing collateral, the rounded-up fee grows by at most one per
 * stroop, so net collateral is non-decreasing. The other reserve therefore
 * increases, the bought reserve (rounded up) never increases, and the
 * floored marginal price is monotone non-decreasing.
 */
export function impactLimit(
  pool: PoolView,
  outcome: "Yes" | "No",
  targetBps: bigint,
  hi: bigint,
): bigint {
  if (targetBps < 0n || targetBps > BPS || hi < 0n) throw new RangeError("invalid impact search bounds");
  let low = 0n;
  let high = hi;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (netAt(pool, outcome, mid) > 0n) high = mid;
    else low = mid + 1n;
  }
  const firstTradable = low;
  if (firstTradable > hi) return 0n;
  const firstPrice = priceAfterBuy(pool, outcome, firstTradable);
  if (firstPrice === null) return 0n;
  if (firstPrice > targetBps) return 0n;
  low = firstTradable;
  high = hi;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const yesPrice = priceAfterBuy(pool, outcome, mid);
    if (yesPrice !== null && yesPrice <= targetBps) low = mid;
    else high = mid - 1n;
  }
  return low;
}

function netAt(pool: PoolView, outcome: "Yes" | "No", collateral: bigint): bigint {
  if (collateral <= 0n) return 0n;
  const [bought, other] = orient(pool, outcome);
  try {
    return calcBuy(bought, other, collateral, pool.feeBps).net;
  } catch (error) {
    if (error instanceof MathError) return 0n;
    throw error;
  }
}

function maxSetsLimit(pool: PoolView, outcome: "Yes" | "No", hi: bigint): bigint {
  if (pool.setsMinted >= MAX_SETS) return 0n;
  const remaining = MAX_SETS - pool.setsMinted;
  let low = 0n;
  let high = hi;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (netAt(pool, outcome, mid) <= remaining) low = mid;
    else high = mid - 1n;
  }
  return low;
}

function expectedLogWealth(
  pool: PoolView,
  outcome: "Yes" | "No",
  holdings: Holdings,
  probabilityBps: bigint,
  bankroll: bigint,
  collateral: bigint,
): number {
  const [bought, other] = orient(pool, outcome);
  const heldBought = outcome === "Yes" ? holdings.yes : holdings.no;
  const heldOther = outcome === "Yes" ? holdings.no : holdings.yes;
  let shares = 0n;
  if (collateral > 0n) {
    try {
      shares = calcBuy(bought, other, collateral, pool.feeBps).sharesOut;
    } catch (error) {
      if (error instanceof MathError) return Number.NEGATIVE_INFINITY;
      throw error;
    }
  }
  const wealthBought = bankroll - collateral + heldBought + shares;
  const wealthOther = bankroll - collateral + heldOther;
  if (bankroll <= 0n) return Number.NEGATIVE_INFINITY;
  const q = Number(probabilityBps) / Number(BPS);
  let value = 0;
  if (probabilityBps > 0n) {
    if (wealthBought <= 0n) return Number.NEGATIVE_INFINITY;
    value += q * Math.log(Number(wealthBought) / Number(bankroll));
  }
  if (probabilityBps < BPS) {
    if (wealthOther <= 0n) return Number.NEGATIVE_INFINITY;
    value += (1 - q) * Math.log(Number(wealthOther) / Number(bankroll));
  }
  return value;
}

function kellyOptimum(
  pool: PoolView,
  outcome: "Yes" | "No",
  holdings: Holdings,
  probabilityBps: bigint,
  bankroll: bigint,
  hi: bigint,
): bigint {
  if (hi <= 0n || bankroll <= 0n) return 0n;
  let low = 0n;
  let high = hi;
  while (high - low > 8n) {
    const third = (high - low) / 3n;
    const m1 = low + third;
    const m2 = high - third;
    const g1 = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, m1);
    const g2 = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, m2);
    if (g1 < g2) low = m1 + 1n;
    else high = m2 - 1n;
  }
  let best = low;
  let bestValue = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, low);
  for (let candidate = low + 1n; candidate <= high; candidate += 1n) {
    const value = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, candidate);
    if (value > bestValue) {
      best = candidate;
      bestValue = value;
    }
  }
  return best;
}

export function sizeBuyDetailed(
  pool: PoolView,
  holdings: Holdings,
  caps: CapsView,
  belief: Belief,
  params: SizingParams,
): SizeBuyResult {
  validateParams(params);
  const edge = belief.fairYesBps - priceYesBps(pool.reserveYes, pool.reserveNo);
  const outcome = edge >= 0n ? "Yes" : "No";
  const { probability, currentPrice } = boundedBelief(pool, belief, outcome);
  const targetBps = probability > params.bufferBps ? probability - params.bufferBps : 0n;
  const headrooms = {
    max_trade: max0(caps.maxTrade),
    max_market: max0(caps.maxMarket - caps.marketExposure),
    max_daily: max0(caps.dailyHeadroom ?? (caps.maxDaily - caps.dailyUsed)),
    capital: max0(caps.availableCapital),
  };
  if (edge === 0n || probability <= currentPrice) {
    const limits = { impact: 0n, ...headrooms, max_sets: 0n, kelly: 0n };
    return {
      report: {
        inputs: { pool, holdings, caps, belief, params, effectiveProbabilityBps: probability, targetBps, bankroll: caps.availableCapital },
        impactC: 0n,
        kellyC: 0n,
        limits,
        size: 0n,
        binding: "kelly",
      },
    };
  }
  const impactC = impactLimit(pool, outcome, targetBps, MAX_COLLATERAL);
  const maxSets = maxSetsLimit(pool, outcome, impactC);
  const kellyUpper = minBigInt(impactC, maxSets, ...Object.values(headrooms));
  const bankroll = caps.availableCapital;
  const optimum = kellyOptimum(pool, outcome, holdings, probability, bankroll, kellyUpper);
  const kellyC = (optimum * params.kellyFractionNumerator) / params.kellyFractionDenominator;
  const limits = {
    impact: impactC,
    ...headrooms,
    max_sets: maxSets,
    kelly: kellyC,
  };
  const [binding, size] = (Object.entries(limits) as [Exclude<Binding, "dust">, bigint][])
    .reduce(([bestName, bestSize], [name, value]) => value < bestSize ? [name, value] : [bestName, bestSize]);
  const report: SizingReport = {
    inputs: { pool, holdings, caps, belief, params, effectiveProbabilityBps: probability, targetBps, bankroll },
    impactC,
    kellyC,
    limits,
    size,
    binding: size < params.minTradeStroops ? "dust" : binding,
  };
  if (size < params.minTradeStroops) return { report };
  const [bought, other] = orient(pool, outcome);
  const quote = calcBuy(bought, other, size, pool.feeBps);
  const priceAfterBps = priceAfterBuy(pool, outcome, size);
  if (priceAfterBps === null) return { report };
  const slippageFloor = (quote.sharesOut * (BPS - params.slippageBps)) / BPS;
  const buy: SizedBuy = {
    outcome,
    collateralIn: size,
    expectedShares: quote.sharesOut,
    minSharesOut: slippageFloor > 0n ? slippageFloor : 1n,
    priceAfterBps,
    binding: report.binding,
    report,
  };
  return { buy, report };
}

export function sizeBuy(
  pool: PoolView,
  holdings: Holdings,
  caps: CapsView,
  belief: Belief,
  params: SizingParams,
): SizedBuy | undefined {
  return sizeBuyDetailed(pool, holdings, caps, belief, params).buy;
}

export function sizeSell(
  pool: PoolView,
  outcome: "Yes" | "No",
  holdings: Holdings,
  belief: Belief,
  params: SizingParams,
): SizedSell | undefined {
  validateParams(params);
  const { probability, currentPrice } = boundedBelief(pool, belief, outcome);
  const target = probability + params.bufferBps > BPS ? BPS : probability + params.bufferBps;
  const held = outcome === "Yes" ? holdings.yes : holdings.no;
  if (currentPrice <= target || held <= 0n) return undefined;
  const [sold, other] = orient(pool, outcome);
  const quoteAt = (shares: bigint) => {
    const collateral = collateralOutForShares(sold, other, shares, pool.feeBps);
    const quote = calcSell(sold, other, collateral, pool.feeBps);
    return {
      collateral,
      quote,
      price: (quote.newReserveOther * BPS) / (quote.newReserveSold + quote.newReserveOther),
    };
  };
  let low = 0n;
  let high = held;
  while (low < high) {
    const mid = (low + high) / 2n;
    try {
      quoteAt(mid);
      high = mid;
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
      low = mid + 1n;
    }
  }
  const firstTradable = low;
  if (firstTradable > held) return undefined;
  let first;
  try {
    first = quoteAt(firstTradable);
  } catch (error) {
    if (error instanceof MathError) return undefined;
    throw error;
  }
  if (first.price < target) return undefined;
  low = firstTradable;
  high = held;
  while (low < high) {
    const shares = (low + high + 1n) / 2n;
    let price: bigint | null;
    try {
      price = quoteAt(shares).price;
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
      price = null;
    }
    if (price !== null && price >= target) low = shares;
    else high = shares - 1n;
  }
  if (low === 0n) return undefined;
  const { collateral: collateralOut, quote: verified } = quoteAt(low);
  if (verified.sharesIn > low || verified.sharesIn > held) {
    throw new Error("sell quote exceeded its share bound");
  }
  const priceAfterBps = (verified.newReserveOther * BPS) / (verified.newReserveSold + verified.newReserveOther);
  return {
    outcome,
    collateralOut,
    maxSharesIn: verified.sharesIn,
    expectedSharesIn: verified.sharesIn,
    priceAfterBps,
  };
}

function max0(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => value < min ? value : min);
}
