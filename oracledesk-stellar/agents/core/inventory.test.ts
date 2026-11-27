import test from "node:test";
import assert from "node:assert/strict";
import { inventoryOf } from "./inventory.js";

test("creator seed starts balanced at every supported price", () => {
  for (const p of [100n, 2500n, 5000n, 7500n, 9900n]) {
    const seed = 1_000_000_000n;
    const r = p >= 5000n ? seed * (10_000n - p) / p : seed;
    const n = p >= 5000n ? seed : seed * p / (10_000n - p);
    const i = inventoryOf({ pool: { reserveYes: r, reserveNo: n, feeBps: 100n }, position: { yes: seed - r, no: seed - n }, lpOwned: true, lpFees: 0n, costBasis: seed });
    assert.equal(i.payoutYes, seed);
    assert.equal(i.payoutNo, seed);
    assert.equal(i.delta, 0n);
  }
});

test("void payout uses market-core rounding", () => {
  assert.equal(inventoryOf({ pool: { reserveYes: 7n, reserveNo: 4n, feeBps: 0n }, position: { yes: 2n, no: 3n }, lpOwned: false, lpFees: 1n, costBasis: 5n }).payoutVoid, 3n);
});
