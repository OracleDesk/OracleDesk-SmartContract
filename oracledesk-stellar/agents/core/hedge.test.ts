import test from "node:test";
import assert from "node:assert/strict";
import { planHedge } from "./hedge.js";

test("hedge prefers a bounded sell of the long side", () => {
  const inv = { pool: { reserveYes: 500n, reserveNo: 500n, feeBps: 100n }, position: { yes: 900n, no: 0n }, lpOwned: false, lpFees: 0n, costBasis: 900n };
  const a = planHedge(inv, { maxTrade: 100n, maxMarket: 1000n, marketExposure: 0n, maxDaily: 1000n, dailyUsed: 0n, availableCapital: 1000n }, { maxBuyPriceBps: 10000n, minSellPriceBps: 1n }, { maxDeltaBps: 1000n, targetDeltaBps: 500n, maxTradeStroops: 100n, dailyHeadroom: 100n, minSecsToClose: 60 });
  assert.equal(a.kind, "sell");
});
