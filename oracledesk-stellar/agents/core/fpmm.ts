/*
 * TypeScript/BigInt mirror of contracts/market-core/src/math.rs and
 * model/fpm_model.py. Kept in lockstep with both by hand; fpmm.test.ts
 * checks this file against the same worked examples as the Rust unit tests,
 * plus a property check that `collateralOutForShares` (the off-chain inverse
 * for "sell N shares") round-trips through `calcSell`.
 *
 * All amounts are non-negative bigints in collateral base units (USDC on
 * Stellar = 7 decimals). Rounding always favours the pool, matching the
 * contract.
 */

export const BPS = 10_000n;
export const MAX_SETS = 1_000_000_000_000_000_000n; // 1e15 = 100M USDC (7 dp)
export const MIN_PROB_BPS = 100n; // 1%
export const MAX_PROB_BPS = 9_900n; // 99%

export class MathError extends Error {}

export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (a < 0n || b < 0n || c <= 0n) throw new MathError("invalid input");
  return (a * b) / c;
}

export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (a < 0n || b < 0n || c <= 0n) throw new MathError("invalid input");
  const p = a * b;
  const q = p / c;
  return p % c !== 0n ? q + 1n : q;
}

export function priceYesBps(reserveYes: bigint, reserveNo: bigint): bigint {
  const total = reserveYes + reserveNo;
  if (total <= 0n) throw new MathError("insufficient liquidity");
  return mulDivFloor(reserveNo, BPS, total);
}

export interface SeedReserves {
  reserveYes: bigint;
  reserveNo: bigint;
  creatorYes: bigint;
  creatorNo: bigint;
}

export function seedReserves(seed: bigint, yesBps: bigint): SeedReserves {
  if (seed <= 0n || yesBps < MIN_PROB_BPS || yesBps > MAX_PROB_BPS) {
    throw new MathError("invalid input");
  }
  const p = yesBps;
  let reserveYes: bigint;
  let reserveNo: bigint;
  if (p >= BPS / 2n) {
    reserveYes = mulDivFloor(seed, BPS - p, p);
    reserveNo = seed;
  } else {
    reserveYes = seed;
    reserveNo = mulDivFloor(seed, p, BPS - p);
  }
  if (reserveYes <= 0n || reserveNo <= 0n) throw new MathError("invalid input");
  return { reserveYes, reserveNo, creatorYes: seed - reserveYes, creatorNo: seed - reserveNo };
}

export interface BuyQuote {
  sharesOut: bigint;
  fee: bigint;
  net: bigint;
  newReserveBought: bigint;
  newReserveOther: bigint;
}

export function calcBuy(
  rBought: bigint,
  rOther: bigint,
  collateralIn: bigint,
  feeBps: bigint,
): BuyQuote {
  if (collateralIn <= 0n || rBought <= 0n || rOther <= 0n) throw new MathError("invalid input");
  const fee = mulDivCeil(collateralIn, feeBps, BPS);
  const net = collateralIn - fee;
  if (net <= 0n) throw new MathError("invalid input");
  const newOther = rOther + net;
  const newBought = mulDivCeil(rBought, rOther, newOther);
  const sharesOut = rBought + net - newBought;
  if (sharesOut <= 0n) throw new MathError("invalid input");
  return { sharesOut, fee, net, newReserveBought: newBought, newReserveOther: newOther };
}

export interface SellQuote {
  sharesIn: bigint;
  fee: bigint;
  gross: bigint;
  newReserveSold: bigint;
  newReserveOther: bigint;
}

export function calcSell(
  rSold: bigint,
  rOther: bigint,
  collateralOut: bigint,
  feeBps: bigint,
): SellQuote {
  if (collateralOut <= 0n || rSold <= 0n || rOther <= 0n || feeBps >= BPS) {
    throw new MathError("invalid input");
  }
  const gross = mulDivCeil(collateralOut, BPS, BPS - feeBps);
  const fee = gross - collateralOut;
  if (gross >= rOther) throw new MathError("insufficient liquidity");
  const newOther = rOther - gross;
  const newSold = mulDivCeil(rSold, rOther, newOther);
  const sharesIn = newSold + gross - rSold;
  if (sharesIn <= 0n) throw new MathError("invalid input");
  return { sharesIn, fee, gross, newReserveSold: newSold, newReserveOther: newOther };
}

export type Settlement = "yes" | "no" | "void";

export function settleValue(kind: Settlement, yes: bigint, no: bigint): bigint {
  if (kind === "yes") return yes;
  if (kind === "no") return no;
  return (yes + no) / 2n;
}

export function mergeMax(yes: bigint, no: bigint): bigint {
  if (yes < 0n || no < 0n) throw new MathError("invalid input");
  return yes < no ? yes : no;
}

/**
 * Integer square root (Newton's method). This mirrors math.rs::isqrt,
 * which seeds above the root and converges monotonically down to
 * floor(sqrt(n)). The contract uses it inside `calc_sell_shares`; this
 * function is also used by the deprecated off-chain inverse below.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new MathError("isqrt of negative");
  if (n < 2n) return n;
  // Seed at or above the root via bit length, like the Rust version.
  const bits = n.toString(2).length;
  const shift = BigInt(Math.floor((bits + 1) / 2));
  let x = 1n << shift;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export interface SellSharesQuote {
  collateralOut: bigint;
  fee: bigint;
  gross: bigint;
  newReserveSold: bigint;
  newReserveOther: bigint;
}

/**
 * Exact share-to-collateral quote. Mirrors math.rs::calc_sell_shares
 * bit-for-bit. Solves (rSold + sharesIn - x)(rother - x) = rSold *
 * rOther for the smaller root x, then corrects downward until the
 * invariant holds with integer rounding. The correction loop is
 * pool-favoring: newSold * newOther >= rSold * rOther, and the
 * resulting collateralOut is never more than calcSell would charge
 * for the same sharesIn.
 */
export function calcSellShares(
  rSold: bigint,
  rOther: bigint,
  sharesIn: bigint,
  feeBps: bigint,
): SellSharesQuote {
  if (sharesIn <= 0n || rSold <= 0n || rOther <= 0n || feeBps >= BPS) {
    throw new MathError("invalid input");
  }
  const b = rSold + sharesIn + rOther;
  const disc = b * b - 4n * rOther * sharesIn;
  if (disc < 0n) throw new MathError("insufficient liquidity");
  let x = (b - isqrt(disc)) / 2n;
  // Pool-favoring correction: isqrt rounds down, so x can overshoot
  // the real root by at most one. Decrement until the invariant holds.
  const k0 = rSold * rOther;
  while (x > 0n && (rSold + sharesIn - x) * (rOther - x) < k0) {
    x -= 1n;
  }
  if (x <= 0n || x >= rOther) throw new MathError("insufficient liquidity");
  const collateralOut = mulDivFloor(x, BPS - feeBps, BPS);
  if (collateralOut <= 0n) throw new MathError("invalid input");
  const fee = x - collateralOut;
  const newSold = rSold + sharesIn - x;
  const newOther = rOther - x;
  return { collateralOut, fee, gross: x, newReserveSold: newSold, newReserveOther: newOther };
}

/**
 * Off-chain inverse of calcSell: how many complete sets (`gross`) the pool
 * must burn so that selling exactly `sharesIn` shares balances the
 * constant-product invariant, ignoring the contract's integer rounding.
 * Solves (sharesIn + rSold - x)(rOther - x) = rSold * rOther for the
 * smaller root of x.
 */
export function grossForShares(
  rSold: bigint,
  rOther: bigint,
  sharesIn: bigint,
  feeBps: bigint,
): bigint {
  if (sharesIn <= 0n || rSold <= 0n || rOther <= 0n || feeBps >= BPS) {
    throw new MathError("invalid input");
  }
  const a = sharesIn + rSold;
  const b = a + rOther;
  const disc = b * b - 4n * rOther * sharesIn;
  if (disc < 0n) throw new MathError("insufficient liquidity");
  const root = isqrt(disc);
  const gross = (b - root) / 2n;
  if (gross <= 0n || gross >= rOther) throw new MathError("insufficient liquidity");
  return gross;
}

/**
 * @deprecated Use `calcSellShares` for exact share-to-collateral
 * quotes. This off-chain inverse ignores the contract's integer
 * correction and is only approximate.
 */
export function collateralOutForShares(
  rSold: bigint,
  rOther: bigint,
  sharesIn: bigint,
  feeBps: bigint,
): bigint {
  const gross = grossForShares(rSold, rOther, sharesIn, feeBps);
  return mulDivFloor(gross, BPS - feeBps, BPS);
}

/** Search budget for collateralForShares; the bracket needs far fewer steps. */
const COLLATERAL_SEARCH_STEPS = 256;

/**
 * Exact buy-side inverse of calcBuy (#108): the minimum `collateralIn` for
 * which `calcBuy(rBought, rOther, collateralIn, feeBps).sharesOut` is at
 * least `sharesTarget`.
 *
 * The constant-product solution for the net amount is
 *   n = (sqrt(b^2 + 4·s·rOther) - b) / 2,  b = rBought + rOther - s,
 * grossed up for the fee. calcBuy rounds the fee and the new reserve up, so
 * that estimate can be off by a few units either way; a bracket around it
 * is then binary-searched against calcBuy itself, which makes the result
 * exact. sharesOut never decreases as collateralIn grows, so the search is
 * valid. Mirrors model/fpmm_model.py::collateral_for_shares.
 */
export function collateralForShares(rBought: bigint, rOther: bigint, sharesTarget: bigint, feeBps: bigint): bigint {
  if (sharesTarget <= 0n || rBought <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS) {
    throw new MathError("invalid input");
  }
  const sharesFor = (c: bigint): bigint => {
    if (c <= 0n) return 0n;
    try {
      return calcBuy(rBought, rOther, c, feeBps).sharesOut;
    } catch (err) {
      if (err instanceof MathError) return 0n; // too small to buy anything
      throw err;
    }
  };
  const b = rBought + rOther - sharesTarget;
  const net = (isqrt(b * b + 4n * sharesTarget * rOther) - b) / 2n;
  const estimate = mulDivCeil(net > 0n ? net : 1n, BPS, BPS - feeBps);

  // hi: smallest probe known to reach the target; lo: largest known not to.
  let hi = estimate;
  let steps = 0;
  while (sharesFor(hi) < sharesTarget) {
    hi = hi * 2n + 1n;
    if (++steps > COLLATERAL_SEARCH_STEPS) throw new MathError("target not reachable");
  }
  let lo = hi > 64n ? hi - 64n : 0n;
  while (lo > 0n && sharesFor(lo) >= sharesTarget) {
    lo /= 2n;
    if (++steps > COLLATERAL_SEARCH_STEPS) throw new MathError("search did not converge");
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (sharesFor(mid) >= sharesTarget) hi = mid;
    else lo = mid;
    if (++steps > COLLATERAL_SEARCH_STEPS) throw new MathError("search did not converge");
  }
  return hi;
}

/**
 * YES price in bps of the pool **After** applying an outcome-relative
 * reserve update (the `newReserve*` pair of a BuyQuote/SellQuote). Mirrors
 * math.rs::price_after: pass `outcomeIsYes = false` for a NO trade, where
 * `After` is the NO reserve.
 */
export function priceAfter(outcomeIsYes: boolean, rAfter: bigint, rOtherAfter: bigint): bigint {
  return outcomeIsYes ? priceYesBps(rAfter, rOtherAfter) : priceYesBps(rOtherAfter, rAfter);
}

/**
 * Post-trade YES price of a `calcBuy` quote for the outcome the buyer
 * receives (`takenIsYes = false` for a NO buy). This is what the per-market
 * impact breaker measures against the pre-trade price.
 */
export function priceAfterBuy(takenIsYes: boolean, quote: BuyQuote): bigint {
  return priceAfter(takenIsYes, quote.newReserveBought, quote.newReserveOther);
}

/**
 * Post-trade YES price of a `calcSell` quote for the outcome the seller
 * gave up (`takenIsYes = false` for a NO sell).
 */
export function priceAfterSell(takenIsYes: boolean, quote: SellQuote): bigint {
  return priceAfter(takenIsYes, quote.newReserveSold, quote.newReserveOther);
}

/**
 * True when a buy's average execution price `collateralIn / sharesOut`
 * (fees included) is at most `limitBps` per share. Compared by
 * cross-multiplication so rounding cannot flip the decision; exact
 * equality passes. Mirrors math.rs::buyWithinLimit / the on-chain
 * `buy_v2` imit check.
 */
export function buyWithinLimit(collateralIn: bigint, sharesOut: bigint, limitBps: bigint): boolean {
  if (collateralIn < 0n || sharesOut <= 0n) throw new MathError("invalid input");
  return collateralIn * BPS <= sharesOut * limitBps;
}

/**
 * True when a sell's average execution price `collateralOut / sharesIn`
 * is at least `limitBps` per share. Exact equality passes; a zero limit is
 * trivially satisfied, which buys the caller no protection. Mirrors
 * math.rs::sellWithinLimit / the on-chain `sell_v2` limit check.
 */
export function sellWithinLimit(collateralOut: bigint, sharesIn: bigint, limitBps: bigint): boolean {
  if (collateralOut < 0n || sharesIn <= 0n) throw new MathError("invalid input");
  return collateralOut * BPS >= sharesIn * limitBps;
}