import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore } from "../runtime/state.js";
import { BondBudget } from "./bond-budget.js";

const DAY = 86_400;
const cfg = { maxBondStroops: 100n, budgetStroops: 250n, maxDisputesPerDay: 2 };
const make = () => {
  const state = new MemoryStateStore();
  return { state, budget: new BondBudget(state, cfg) };
};

test("available is the tightest of per-dispute cap, budget left and wallet balance", () => {
  const { budget } = make();
  assert.equal(budget.available(10_000n, 0), 100n, "per-dispute cap");
  assert.equal(budget.available(40n, 0), 40n, "wallet balance");
  budget.commit(1n, 100n, 0);
  budget.commit(2n, 100n, 0);
  assert.equal(budget.available(10_000n, DAY), 50n, "250 total - 200 at risk, on a fresh day");
});

test("totals are derived from records and committed = at-risk + refunded + forfeited", () => {
  const { budget } = make();
  budget.commit(1n, 100n, 0);
  budget.commit(2n, 80n, 0);
  budget.commit(3n, 50n, 0);
  budget.resolve(1n, "refunded");
  budget.resolve(2n, "forfeited");
  assert.deepEqual(budget.totals(), { committed: 230n, atRisk: 50n, refunded: 100n, forfeited: 80n });
});

test("a bond leaves at-risk exactly once and commits are idempotent", () => {
  const { budget } = make();
  budget.commit(1n, 100n, 0);
  budget.commit(1n, 100n, 0);
  assert.equal(budget.totals().committed, 100n);
  budget.resolve(1n, "refunded");
  budget.resolve(1n, "forfeited");
  assert.equal(budget.record(1n)?.status, "refunded");
});

test("a dispute that never opened is released and frees the budget", () => {
  const { budget } = make();
  budget.commit(1n, 100n, 0);
  budget.release(1n);
  assert.equal(budget.totals().committed, 0n);
  budget.commit(2n, 100n, 0);
  budget.resolve(2n, "refunded");
  budget.release(2n);
  assert.equal(budget.record(2n)?.status, "refunded", "a settled bond is never released");
});

test("the daily dispute cap zeroes availability until the next UTC day", () => {
  const { budget } = make();
  budget.commit(1n, 10n, 100);
  budget.commit(2n, 10n, 200);
  assert.equal(budget.disputesToday(300), 2);
  assert.equal(budget.available(10_000n, 300), 0n);
  assert.equal(budget.available(10_000n, DAY + 1), 100n);
});

test("accounting survives a restart: a new BondBudget over the same state sees the same bonds", () => {
  const { state, budget } = make();
  budget.commit(1n, 100n, 0);
  const again = new BondBudget(state, cfg);
  assert.equal(again.totals().atRisk, 100n);
  assert.equal(again.available(10_000n, 0), 100n);
});
