/**
 * Closed-form + binary-search FPMM optimal trade sizing under price-impact,
 * fair-value overshoot, fee-adjusted minimum edge, and capital caps (#113).
 */
import {
  BPS,
  calcBuy,
  calcSell,
  collateralOutForShares,
  priceAfterBuy,
  priceAfterSell,
  priceYesBps,
} from "../fpmm.js";

export interface OptimalBuyParams {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  outcome: "Yes" | "No";
  fairYesBps: number;
  maxImpactBps: number;
  maxCollateral: bigint;
  minEdgeAfterFeeBps: number;
}

export interface OptimalBuyResult {
  collateralIn: bigint;
  expectedShares: bigint;
  postPriceYesBps: number;
  avgPriceBps: number;
  expectedEdgeStroops: bigint;
}

export interface OptimalSellParams {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  outcome: "Yes" | "No";
  fairYesBps: number;
  maxImpactBps: number;
  maxShares: bigint;
  minEdgeAfterFeeBps: number;
}

export interface OptimalSellResult {
  collateralOut: bigint;
  expectedSharesIn: bigint;
  postPriceYesBps: number;
  avgPriceBps: number;
  expectedEdgeStroops: bigint;
}

const ZERO_BUY: OptimalBuyResult = {
  collateralIn: 0n,
  expectedShares: 0n,
  postPriceYesBps: 0,
  avgPriceBps: 0,
  expectedEdgeStroops: 0n,
};

const ZERO_SELL: OptimalSellResult = {
  collateralOut: 0n,
  expectedSharesIn: 0n,
  postPriceYesBps: 0,
  avgPriceBps: 0,
  expectedEdgeStroops: 0n,
};

export function optimalBuySize(params: OptimalBuyParams): OptimalBuyResult {
  const {
    reserveYes,
    reserveNo,
    feeBps,
    outcome,
    fairYesBps,
    maxImpactBps,
    maxCollateral,
    minEdgeAfterFeeBps,
  } = params;

  if (reserveYes <= 0n || reserveNo <= 0n || maxCollateral <= 0n) {
    return ZERO_BUY;
  }

  const preYesBps = Number(priceYesBps(reserveYes, reserveNo));
  const isYes = outcome === "Yes";
  const fairOutcomeBps = isYes ? fairYesBps : 10_000 - fairYesBps;
  const preOutcomeBps = isYes ? preYesBps : 10_000 - preYesBps;

  if (fairOutcomeBps <= preOutcomeBps) {
    return { ...ZERO_BUY, postPriceYesBps: preYesBps };
  }

  const rBought = isYes ? reserveYes : reserveNo;
  const rOther = isYes ? reserveNo : reserveYes;

  const evalAt = (c: bigint): (OptimalBuyResult & { feasible: boolean }) | null => {
    if (c <= 0n) return null;
    try {
      const q = calcBuy(rBought, rOther, c, feeBps);
      const postYes = Number(priceAfterBuy(isYes, q));
      const impact = Math.abs(postYes - preYesBps);
      const noOvershoot = isYes ? postYes <= fairYesBps : postYes >= fairYesBps;
      const impactOk = maxImpactBps <= 0 || impact <= maxImpactBps;
      const avgPriceBps = Number((c * BPS + q.sharesOut - 1n) / q.sharesOut);
      const edgeOk = fairOutcomeBps - avgPriceBps >= minEdgeAfterFeeBps;
      const expectedValue = (q.sharesOut * BigInt(fairOutcomeBps)) / BPS;
      const expectedEdgeStroops = expectedValue - c;
      return {
        collateralIn: c,
        expectedShares: q.sharesOut,
        postPriceYesBps: postYes,
        avgPriceBps,
        expectedEdgeStroops,
        feasible: noOvershoot && impactOk && edgeOk && expectedEdgeStroops > 0n,
      };
    } catch {
      return null;
    }
  };

  // Step 1: Find the largest c in [1, maxCollateral] that satisfies impact,
  // no-overshoot, and minEdgeAfterFeeBps constraints (all three are monotonic in c).
  let lo = 1n;
  let hi = maxCollateral;
  let maxFeasible = 0n;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const ev = evalAt(mid);
    if (!ev) {
      // Very small c may round net to 0; step upward
      lo = mid + 1n;
      continue;
    }
    if (ev.feasible) {
      maxFeasible = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }

  if (maxFeasible === 0n) {
    return { ...ZERO_BUY, postPriceYesBps: preYesBps };
  }

  // Step 2: Ternary search on concave expectedEdgeStroops(c) over [1, maxFeasible]
  let tLo = 1n;
  let tHi = maxFeasible;
  let best = evalAt(maxFeasible)!;

  for (let i = 0; i < 48 && tHi - tLo > 3n; i++) {
    const m1 = tLo + (tHi - tLo) / 3n;
    const m2 = tHi - (tHi - tLo) / 3n;
    const e1 = evalAt(m1);
    const e2 = evalAt(m2);
    if (e1 && e1.feasible && e1.expectedEdgeStroops > best.expectedEdgeStroops) best = e1;
    if (e2 && e2.feasible && e2.expectedEdgeStroops > best.expectedEdgeStroops) best = e2;

    const v1 = e1 && e1.feasible ? e1.expectedEdgeStroops : -1_000_000_000_000_000_000n;
    const v2 = e2 && e2.feasible ? e2.expectedEdgeStroops : -1_000_000_000_000_000_000n;
    if (v1 < v2) {
      tLo = m1;
    } else {
      tHi = m2;
    }
  }

  for (let c = tLo; c <= tHi; c++) {
    const ev = evalAt(c);
    if (ev && ev.feasible && ev.expectedEdgeStroops > best.expectedEdgeStroops) {
      best = ev;
    }
  }

  if (!best.feasible || best.expectedEdgeStroops <= 0n) {
    return { ...ZERO_BUY, postPriceYesBps: preYesBps };
  }

  return {
    collateralIn: best.collateralIn,
    expectedShares: best.expectedShares,
    postPriceYesBps: best.postPriceYesBps,
    avgPriceBps: best.avgPriceBps,
    expectedEdgeStroops: best.expectedEdgeStroops,
  };
}

export function optimalSellSize(params: OptimalSellParams): OptimalSellResult {
  const {
    reserveYes,
    reserveNo,
    feeBps,
    outcome,
    fairYesBps,
    maxImpactBps,
    maxShares,
    minEdgeAfterFeeBps,
  } = params;

  if (reserveYes <= 0n || reserveNo <= 0n || maxShares <= 0n) {
    return ZERO_SELL;
  }

  const preYesBps = Number(priceYesBps(reserveYes, reserveNo));
  const isYes = outcome === "Yes";
  const fairOutcomeBps = isYes ? fairYesBps : 10_000 - fairYesBps;
  const preOutcomeBps = isYes ? preYesBps : 10_000 - preYesBps;

  if (preOutcomeBps <= fairOutcomeBps) {
    return { ...ZERO_SELL, postPriceYesBps: preYesBps };
  }

  const rSold = isYes ? reserveYes : reserveNo;
  const rOther = isYes ? reserveNo : reserveYes;

  let maxCout = 0n;
  try {
    maxCout = collateralOutForShares(rSold, rOther, maxShares, feeBps);
  } catch {
    maxCout = (rOther * (BPS - feeBps)) / BPS / 2n;
  }
  if (maxCout <= 0n) {
    return { ...ZERO_SELL, postPriceYesBps: preYesBps };
  }

  const evalAt = (cout: bigint): (OptimalSellResult & { feasible: boolean }) | null => {
    if (cout <= 0n) return null;
    try {
      const q = calcSell(rSold, rOther, cout, feeBps);
      const postYes = Number(priceAfterSell(isYes, q));
      const impact = Math.abs(postYes - preYesBps);
      const noOvershoot = isYes ? postYes >= fairYesBps : postYes <= fairYesBps;
      const impactOk = maxImpactBps <= 0 || impact <= maxImpactBps;
      const sharesOk = q.sharesIn <= maxShares;
      const avgPriceBps = Number((cout * BPS) / q.sharesIn);
      const edgeOk = avgPriceBps - fairOutcomeBps >= minEdgeAfterFeeBps;
      const fairShareValue = (q.sharesIn * BigInt(fairOutcomeBps)) / BPS;
      const expectedEdgeStroops = cout - fairShareValue;
      return {
        collateralOut: cout,
        expectedSharesIn: q.sharesIn,
        postPriceYesBps: postYes,
        avgPriceBps,
        expectedEdgeStroops,
        feasible: noOvershoot && impactOk && sharesOk && edgeOk && expectedEdgeStroops > 0n,
      };
    } catch {
      return null;
    }
  };

  let lo = 1n;
  let hi = maxCout;
  let maxFeasible = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const ev = evalAt(mid);
    if (!ev) {
      lo = mid + 1n;
      continue;
    }
    if (ev.feasible) {
      maxFeasible = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }

  if (maxFeasible === 0n) {
    return { ...ZERO_SELL, postPriceYesBps: preYesBps };
  }

  let tLo = 1n;
  let tHi = maxFeasible;
  let best = evalAt(maxFeasible)!;

  for (let i = 0; i < 48 && tHi - tLo > 3n; i++) {
    const m1 = tLo + (tHi - tLo) / 3n;
    const m2 = tHi - (tHi - tLo) / 3n;
    const e1 = evalAt(m1);
    const e2 = evalAt(m2);
    if (e1 && e1.feasible && e1.expectedEdgeStroops > best.expectedEdgeStroops) best = e1;
    if (e2 && e2.feasible && e2.expectedEdgeStroops > best.expectedEdgeStroops) best = e2;

    const v1 = e1 && e1.feasible ? e1.expectedEdgeStroops : -1_000_000_000_000_000_000n;
    const v2 = e2 && e2.feasible ? e2.expectedEdgeStroops : -1_000_000_000_000_000n;
    if (v1 < v2) {
      tLo = m1;
    } else {
      tHi = m2;
    }
  }

  for (let c = tLo; c <= tHi; c++) {
    const ev = evalAt(c);
    if (ev && ev.feasible && ev.expectedEdgeStroops > best.expectedEdgeStroops) {
      best = ev;
    }
  }

  if (!best.feasible || best.expectedEdgeStroops <= 0n) {
    return { ...ZERO_SELL, postPriceYesBps: preYesBps };
  }

  return {
    collateralOut: best.collateralOut,
    expectedSharesIn: best.expectedSharesIn,
    postPriceYesBps: best.postPriceYesBps,
    avgPriceBps: best.avgPriceBps,
    expectedEdgeStroops: best.expectedEdgeStroops,
  };
}
