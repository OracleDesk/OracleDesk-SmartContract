/**
 * TypeScript/BigInt mirror of contracts/market-core/src/math.rs and
 * model/fpmm_model.py. Kept in lockstep with both by hand; fpmm.test.ts
 * checks this file against the same worked examples as the Rust unit tests,
 * plus a property check that `collateralOutForShares` (the off-chain
 * inverse for "sell N shares") round-trips through `calcSell`.
 *
 * All amounts are non-negative bigints in collateral base units (USDC on
 * Stellar = 7 decimals). Rounding always favours the pool, matching the
 * contract.
 */

export const BPS = 10_000n;
export const MAX_SETS = 1_000_000_000_000_000n; // 1e15 = 100M USDC (7 dp)
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

/**
 * Integer square root (Newton's method), needed because `sell` takes an
 * exact collateral amount rather than a share count (no on-chain sqrt — see
 * the docstring on `sell` in contracts/market-core/src/lib.rs). This is
 * what makes `grossForShares` computable in BigInt without floating point.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new MathError("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
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
 * Estimated `collateral_out` for selling `sharesIn` shares, rounded down
 * (pool-favoring) so a real `sell` call with this value and a
 * `max_shares_in` slippage bound of `sharesIn` (plus your own safety
 * margin — see docs/frontend-integration.md) should not need more shares
 * than intended.
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
 * YES price in bps of the pool **after** applying an outcome-relative
 * reserve update (the `newReserve*` pair of a BuyQuote/SellQuote). Mirrors
 * math.rs::price_after: pass `outcomeIsYes = false` for a NO trade, where
 * `rAfter` is the NO reserve.
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
 * `buy_v2` limit check.
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

// ---------------------------------------------------------------------------
// Categorical (N-outcome) FPMM — mirrors math_categorical.rs. The binary
// invariant k = rYes * rNo generalises to the product of all reserves; the
// iterative ceil accumulation keeps k non-decreasing with at most n-1 units
// of pool-favouring drift per trade (see the rounding proof in
// math_categorical.rs::calc_buy).
// ---------------------------------------------------------------------------

export const MAX_MARKET_OUTCOMES = 8;
export const PRICE_SCALE = 10n ** 18n; // same reciprocal scale as math_categorical.rs

function catN(reserves: bigint[]): number {
  const n = reserves.length;
  if (n < 2 || n > MAX_MARKET_OUTCOMES) throw new MathError("invalid input");
  for (const r of reserves) if (r <= 0n) throw new MathError("invalid input");
  return n;
}

function catIndex(n: number, outcomeIndex: number): number {
  if (outcomeIndex < 0 || outcomeIndex >= n) throw new MathError("invalid input");
  return outcomeIndex;
}

export interface CatBuyQuote {
  sharesOut: bigint;
  fee: bigint;
  net: bigint;
  newReserves: bigint[];
}

/**
 * Buy `collateralIn` of outcome `outcomeIndex`: mint `net` sets into every
 * other reserve and shrink the bought reserve so the product of all
 * reserves holds. Mirrors math_categorical.rs::calc_buy.
 */
export function catCalcBuy(
  reserves: bigint[],
  outcomeIndex: number,
  collateralIn: bigint,
  feeBps: bigint,
): CatBuyQuote {
  const n = catN(reserves);
  const j = catIndex(n, outcomeIndex);
  if (collateralIn <= 0n) throw new MathError("invalid input");
  const fee = mulDivCeil(collateralIn, feeBps, BPS);
  const net = collateralIn - fee;
  if (net <= 0n) throw new MathError("invalid input");
  const newReserves = [...reserves];
  let acc = reserves[j];
  for (let i = 0; i < n; i++) {
    if (i === j) continue;
    const newOther = reserves[i] + net;
    newReserves[i] = newOther;
    acc = mulDivCeil(acc, reserves[i], newOther);
  }
  newReserves[j] = acc;
  const sharesOut = reserves[j] + net - acc;
  if (sharesOut <= 0n) throw new MathError("invalid input");
  return { sharesOut, fee, net, newReserves };
}

export interface CatSellQuote {
  sharesIn: bigint;
  fee: bigint;
  gross: bigint;
  newReserves: bigint[];
}

/**
 * Sell `outcomeIndex` for an exact `collateralOut` (Gnosis-style, so no
 * square root on-chain). Mirrors math_categorical.rs::calc_sell.
 */
export function catCalcSell(
  reserves: bigint[],
  outcomeIndex: number,
  collateralOut: bigint,
  feeBps: bigint,
): CatSellQuote {
  const n = catN(reserves);
  const j = catIndex(n, outcomeIndex);
  if (collateralOut <= 0n || feeBps >= BPS) throw new MathError("invalid input");
  const gross = mulDivCeil(collateralOut, BPS, BPS - feeBps);
  const fee = gross - collateralOut;
  const newReserves = [...reserves];
  let acc = reserves[j];
  for (let i = 0; i < n; i++) {
    if (i === j) continue;
    if (reserves[i] <= gross) throw new MathError("insufficient liquidity");
    const newOther = reserves[i] - gross;
    newReserves[i] = newOther;
    acc = mulDivCeil(acc, reserves[i], newOther);
  }
  newReserves[j] = acc;
  const sharesIn = acc + gross - reserves[j];
  if (sharesIn <= 0n) throw new MathError("invalid input");
  return { sharesIn, fee, gross, newReserves };
}

/**
 * Spot price of every outcome in bps, `p_j = (1/r_j) / Σ(1/r_i)` evaluated
 * on integer reciprocals. Each price floors, so the n prices sum to at most
 * BPS and at least BPS - n (display-only; never trade math). Mirrors
 * math_categorical.rs::prices_bps.
 */
export function catPrices(reserves: bigint[]): bigint[] {
  const n = catN(reserves);
  const recs = reserves.slice(0, n).map((r) => PRICE_SCALE / r);
  let total = 0n;
  for (const rec of recs) total += rec;
  if (total <= 0n) throw new MathError("insufficient liquidity");
  return recs.map((rec) => mulDivFloor(BPS, rec, total));
}

export interface CatSeed {
  reserves: bigint[];
  creatorShares: bigint[];
}

/**
 * Open a pool at the requested probabilities: each reserve is
 * `seed * pMin / p_i` (floored), the creator keeps `seed - r_i` of every
 * outcome. `probsBps` must have length 2..=MAX_MARKET_OUTCOMES, every entry
 * >= MIN_PROB_BPS, and the entries must sum to exactly BPS. Mirrors
 * math_categorical.rs::seed_reserves.
 */
export function catSeed(seed: bigint, probsBps: number[]): CatSeed {
  const n = probsBps.length;
  if (n < 2 || n > MAX_MARKET_OUTCOMES || seed <= 0n) throw new MathError("invalid input");
  let sum = 0;
  for (const p of probsBps) {
    if (BigInt(p) < MIN_PROB_BPS) throw new MathError("invalid input");
    sum += p;
  }
  if (sum !== 10_000) throw new MathError("invalid input");
  const pMin = BigInt(Math.min(...probsBps));
  const reserves: bigint[] = [];
  const creatorShares: bigint[] = [];
  for (const p of probsBps) {
    const r = mulDivFloor(seed, pMin, BigInt(p));
    if (r <= 0n) throw new MathError("invalid input");
    reserves.push(r);
    creatorShares.push(seed - r);
  }
  return { reserves, creatorShares };
}

/**
 * Collateral value of one holder's per-outcome balances once final.
 * `resolved = w` pays the winning balance; `resolved = null` (void) pays
 * `floor(Σ balances / n)`. Every complete set is worth exactly 1 and every
 * rounding floors, so the total paid across holders never exceeds
 * setsMinted. Mirrors math_categorical.rs::settle_value.
 */
export function catSettleValue(resolved: number | null, balances: bigint[]): bigint {
  const n = balances.length;
  if (n < 2 || n > MAX_MARKET_OUTCOMES) throw new MathError("invalid input");
  if (resolved === null) {
    let sum = 0n;
    for (const b of balances) {
      if (b < 0n) throw new MathError("invalid input");
      sum += b;
    }
    return sum / BigInt(n);
  }
  catIndex(n, resolved);
  return balances[resolved];
}

// ---------------------------------------------------------------------------
// Scalar (range) market settlement — mirrors math.rs::scalarPayout, which
// backs the Rust `Settlement::Scalar(p)` variant. `scalarPayout(BPS, ...)`
// equals YES and `(0, ...)` equals NO.
// ---------------------------------------------------------------------------

/**
 * Collateral value of a (yes, no) share pair when the resolved value maps
 * to `payoutLongBps` LONG per complete set. Both legs floor independently,
 * so no holder ever beats their exact rational share.
 */
export function scalarPayout(payoutLongBps: bigint, yes: bigint, no: bigint): bigint {
  return (yes * payoutLongBps) / BPS + (no * (BPS - payoutLongBps)) / BPS;
}

// ---------------------------------------------------------------------------
// Dynamic fee schedule — mirrors math.rs::effectiveFeeBps. Deterministic
// integer math shared with the contract and model/fpmm_model.py via
// model/fee_fixtures.json; every floor rounds toward the trader (a lower
// fee never harms the pool, whose protection is calc* rounding).
// ---------------------------------------------------------------------------

export const MAX_RAMP_SECS = 30n * 86_400n;
export const MAX_SKEW_MULT_BPS = 1_000n;

export interface FeeSchedule {
  baseBps: bigint;
  maxBps: bigint;
  rampSecs: bigint;
  skewMultBps: bigint;
}

/**
 * Fee in bps for a trade at `now` with the given pre-trade reserves:
 * `min(max, base + timeRamp + skew)`. The ramp adds up to `max - base`
 * linearly over the last `rampSecs` before close (0 disables it, and any
 * timestamp at or past close clamps to the full ramp); the skew term adds
 * `skewMultBps` per 1000 bps of distance from a 50/50 price. Guaranteed
 * `base <= result <= max`, and `max < BPS` is validated so `calcSell` is
 * always well-defined.
 */
export function effectiveFeeBps(
  schedule: FeeSchedule,
  now: bigint,
  closeTime: bigint,
  rYes: bigint,
  rNo: bigint,
): bigint {
  if (schedule.baseBps > schedule.maxBps || schedule.maxBps >= BPS) {
    throw new MathError("invalid input");
  }
  let t = 0n;
  if (schedule.rampSecs !== 0n) {
    const intoRamp =
      now >= closeTime
        ? schedule.rampSecs
        : closeTime - now >= schedule.rampSecs
          ? 0n
          : schedule.rampSecs - (closeTime - now);
    t = mulDivFloor(intoRamp, schedule.maxBps - schedule.baseBps, schedule.rampSecs);
  }
  const p = priceYesBps(rYes, rNo);
  const midpoint = BPS / 2n;
  const d = p >= midpoint ? p - midpoint : midpoint - p;
  const skew = mulDivFloor(d, schedule.skewMultBps, 1_000n);
  const total = schedule.baseBps + t + skew;
  return total > schedule.maxBps ? schedule.maxBps : total;
}
