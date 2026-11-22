import assert from "node:assert/strict";
import test from "node:test";
import { BPS, MAX_SETS, calcBuy, calcSell, collateralOutForShares, MathError, priceYesBps } from "./fpmm.js";
import { impactLimit, sizeBuy, sizeBuyDetailed, sizeSell, type CapsView, type PoolView, type SizingParams } from "./sizing.js";

const params: SizingParams = {
  kellyFractionNumerator: 1n,
  kellyFractionDenominator: 4n,
  bufferBps: 25n,
  slippageBps: 50n,
  minTradeStroops: 1n,
};
const pool: PoolView = {
  reserveYes: 1_000_000_000n,
  reserveNo: 1_000_000_000n,
  feeBps: 100n,
  setsMinted: 0n,
};
const caps: CapsView = {
  maxTrade: 100_000_000n,
  maxMarket: 500_000_000n,
  marketExposure: 0n,
  maxDaily: 1_000_000_000n,
  dailyUsed: 0n,
  availableCapital: 200_000_000n,
};

test("impactLimit returns the largest feasible collateral at the floored target price", () => {
  const target = 5_400n;
  const size = impactLimit(pool, "Yes", target, 100_000_000n);
  const q = calcBuy(pool.reserveYes, pool.reserveNo, size, pool.feeBps);
  const post = (q.newReserveOther * BPS) / (q.newReserveBought + q.newReserveOther);
  assert.ok(post <= target);
  const next = calcBuy(pool.reserveYes, pool.reserveNo, size + 1n, pool.feeBps);
  const nextPost = (next.newReserveOther * BPS) / (next.newReserveBought + next.newReserveOther);
  assert.ok(nextPost > target);
});

test("impactLimit returns zero when the first executable trade crosses the target", () => {
  const thin = { ...pool, reserveYes: 100n, reserveNo: 100n };
  assert.equal(impactLimit(thin, "Yes", 5_001n, 100n), 0n);
});

test("sizeBuy clamps to the target, applies fractional Kelly and calculates slippage", () => {
  const buy = sizeBuy(pool, { yes: 0n, no: 0n }, caps, { fairYesBps: 6_000n, uncertaintyBps: 100n }, params);
  assert.ok(buy);
  assert.equal(buy.outcome, "Yes");
  assert.ok(buy.collateralIn > 0n && buy.collateralIn <= caps.maxTrade);
  assert.ok(buy.minSharesOut <= buy.expectedShares);
  const quote = calcBuy(pool.reserveYes, pool.reserveNo, buy.collateralIn, pool.feeBps);
  assert.equal(quote.sharesOut, buy.expectedShares);
  assert.ok(buy.priceAfterBps <= buy.report.inputs.targetBps);
  assert.equal(buy.report.size, buy.collateralIn);
});

test("belief uncertainty that erases the edge skips sizing", () => {
  assert.equal(
    sizeBuy(pool, { yes: 0n, no: 0n }, caps, { fairYesBps: 5_100n, uncertaintyBps: 100n }, params),
    undefined,
  );
});

test("caps report the limiting max-trade constraint", () => {
  const buy = sizeBuy(
    pool,
    { yes: 0n, no: 0n },
    { ...caps, maxTrade: 100_000n, maxMarket: 1_000_000_000n },
    { fairYesBps: 8_000n, uncertaintyBps: 0n },
    { ...params, kellyFractionNumerator: 1n, kellyFractionDenominator: 1n },
  );
  assert.equal(buy?.collateralIn, 100_000n);
  assert.equal(buy?.binding, "max_trade");
});

test("market, daily, capital and MAX_SETS headroom each bind sizing", () => {
  const fullKelly = { ...params, kellyFractionNumerator: 1n, kellyFractionDenominator: 1n };
  const belief = { fairYesBps: 8_000n, uncertaintyBps: 0n };
  const cases: Array<[string, CapsView, PoolView, bigint, string]> = [
    ["max_market", { ...caps, maxMarket: 100_000n }, pool, 8_000n, "max_market"],
    ["max_daily", { ...caps, dailyHeadroom: 100_000n }, pool, 8_000n, "max_daily"],
    ["capital", { ...caps, availableCapital: 100_000n }, pool, 10_000n, "capital"],
    ["max_sets", caps, { ...pool, setsMinted: MAX_SETS - 10_000_000n }, 8_000n, "max_sets"],
  ];
  for (const [, candidateCaps, candidatePool, fairYesBps, expectedBinding] of cases) {
    const result = sizeBuyDetailed(
      candidatePool,
      { yes: 0n, no: 0n },
      candidateCaps,
      { fairYesBps, uncertaintyBps: 0n },
      fullKelly,
    );
    assert.ok(result.buy, expectedBinding);
    assert.equal(result.report.binding, expectedBinding);
  }
});

test("fractional Kelly that falls below the dust floor skips with a dust report", () => {
  const result = sizeBuyDetailed(
    pool,
    { yes: 0n, no: 0n },
    caps,
    { fairYesBps: 8_000n, uncertaintyBps: 0n },
    { ...params, kellyFractionNumerator: 1n, kellyFractionDenominator: 1_000_000n, minTradeStroops: 1_000_000n },
  );
  assert.equal(result.buy, undefined);
  assert.equal(result.report.binding, "dust");
});

test("No-side sizing mirrors Yes-side sizing on swapped reserves", () => {
  const noPool = { ...pool, reserveYes: 700_000_000n, reserveNo: 1_300_000_000n };
  const currentNo = BPS - priceYesBps(noPool.reserveYes, noPool.reserveNo);
  const noTarget = 4_500n;
  const maxNoSize = impactLimit(noPool, "No", noTarget, 100_000_000n);
  const noQuote = calcBuy(noPool.reserveNo, noPool.reserveYes, maxNoSize, noPool.feeBps);
  const noPostPrice = (noQuote.newReserveOther * BPS) / (noQuote.newReserveBought + noQuote.newReserveOther);
  assert.ok(currentNo < noPostPrice && noPostPrice <= noTarget);
  const upperNoQuote = calcBuy(noPool.reserveNo, noPool.reserveYes, 1_000_000_000n, noPool.feeBps);
  const upperNoPrice = (upperNoQuote.newReserveOther * BPS) / (upperNoQuote.newReserveBought + upperNoQuote.newReserveOther);
  assert.ok(upperNoPrice > noTarget);

  const noBuy = sizeBuy(
    noPool,
    { yes: 0n, no: 0n },
    caps,
    { fairYesBps: 4_000n, uncertaintyBps: 0n },
    params,
  );
  assert.equal(noBuy?.outcome, "No");
  assert.ok(noBuy && noBuy.priceAfterBps <= noBuy.report.inputs.targetBps);
});

test("sell sizing round-trips its returned collateral and share limit", () => {
  const sell = sizeSell(
    pool,
    "Yes",
    { yes: 100_000_000n, no: 0n },
    { fairYesBps: 3_000n, uncertaintyBps: 0n },
    params,
  );
  assert.ok(sell);
  const quote = calcSell(pool.reserveYes, pool.reserveNo, sell.collateralOut, pool.feeBps);
  assert.ok(quote.sharesIn <= sell.maxSharesIn);
  assert.ok(quote.sharesIn <= 100_000_000n);
  assert.equal(sell.collateralOut, collateralOutForShares(pool.reserveYes, pool.reserveNo, quote.sharesIn, pool.feeBps));
  assert.ok(sell.priceAfterBps >= 3_025n);
});

test("No-side sell prices and targets are expressed in No probability", () => {
  const noPool = { ...pool, reserveYes: 700_000_000n, reserveNo: 1_300_000_000n };
  const sell = sizeSell(
    noPool,
    "No",
    { yes: 0n, no: 100_000_000n },
    { fairYesBps: 7_000n, uncertaintyBps: 0n },
    params,
  );
  assert.ok(sell);
  const quote = calcSell(noPool.reserveNo, noPool.reserveYes, sell.collateralOut, noPool.feeBps);
  const noPrice = (quote.newReserveOther * BPS) / (quote.newReserveSold + quote.newReserveOther);
  assert.equal(sell.priceAfterBps, noPrice);
  assert.ok(sell.priceAfterBps >= 3_025n);
});

test("price impact is monotone over deterministic pool/fee samples", () => {
  let seed = 0x12345678;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 5_000; i += 1) {
    const rYes = BigInt(next() % 1_000_000 + 100);
    const rNo = BigInt(next() % 1_000_000 + 100);
    const fee = BigInt(next() % 1_001);
    let previous = priceYesBps(rYes, rNo);
    for (let collateral = 1; collateral <= 20; collateral += 1) {
      try {
        const q = calcBuy(rYes, rNo, BigInt(collateral), fee);
        const current = (q.newReserveOther * BPS) / (q.newReserveBought + q.newReserveOther);
        assert.ok(current >= previous, `sample ${i}, collateral ${collateral}`);
        previous = current;
      } catch (error) {
        if (!(error instanceof MathError)) throw error;
        // A zero-net/zero-share buy is a non-tradable point at the curve origin.
      }
    }
  }
});

test("impactLimit never selects a buy beyond its floored target", () => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 500; i += 1) {
    const rYes = BigInt(next() % 10_000_000 + 10_000);
    const rNo = BigInt(next() % 10_000_000 + 10_000);
    const feeBps = BigInt(next() % 1_001);
    const candidate = { ...pool, reserveYes: rYes, reserveNo: rNo, feeBps };
    const rawTarget = priceYesBps(rYes, rNo) + BigInt(next() % 2_000);
    const target = rawTarget > BPS ? BPS : rawTarget;
    const size = impactLimit(candidate, "Yes", target, 10_000_000n);
    if (size === 0n) continue;
    const quote = calcBuy(rYes, rNo, size, feeBps);
    const post = (quote.newReserveOther * BPS) / (quote.newReserveBought + quote.newReserveOther);
    assert.ok(post <= target, `sample ${i}: post=${post}, target=${target}`);
  }
});
