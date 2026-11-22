import assert from "node:assert/strict";
import test from "node:test";
import { BPS } from "./fpmm.js";
import { planUnwind } from "./unwind.js";

const pool = { reserveYes: 1_000_000n, reserveNo: 1_000_000n, feeBps: 0n };

test("plans both outcomes when the floor is zero", () => {
  const plans = planUnwind(
    [{ marketId: 7n, pool }],
    new Map([[7n, { yes: 1000n, no: 2000n }]]),
    { exitFloorBps: 0n },
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].remaining, { yes: 0n, no: 0n });
  assert.deepEqual(plans[0].legs.map((l) => [l.outcome, l.sharesIn]), [["Yes", 1000n], ["No", 2000n]]);
  for (const leg of plans[0].legs) {
    assert.ok(leg.collateralOut > 0n);
    assert.ok(leg.priceBps >= 0n && leg.priceBps <= BPS);
  }
});

test("stops before a slice below the exit floor", () => {
  const plans = planUnwind(
    [{ marketId: 1n, pool }],
    new Map([[1n, { yes: 1000n, no: 0n }]]),
    { exitFloorBps: BPS },
  );
  assert.equal(plans[0].legs.length, 0);
  assert.equal(plans[0].remaining.yes, 1000n);
  assert.match(plans[0].reasons[0], /below floor/);
});

test("slices large inventory and reports when maxSlices is reached", () => {
  const plans = planUnwind(
    [{ marketId: 2n, pool }],
    new Map([[2n, { yes: 1000n, no: 0n }]]),
    { exitFloorBps: 0n, maxSharesPerTrade: 300n, maxSlices: 2 },
  );
  assert.deepEqual(plans[0].legs.map((l) => l.sharesIn), [300n, 300n]);
  assert.equal(plans[0].remaining.yes, 400n);
  assert.match(plans[0].reasons.at(-1)!, /maxSlices=2/);
});

test("skips markets with no inventory and rejects bad options", () => {
  assert.equal(planUnwind([{ marketId: 3n, pool }], new Map(), { exitFloorBps: 0n }).length, 0);
  assert.throws(() => planUnwind([], new Map(), { exitFloorBps: BPS + 1n }), /exit floor/);
  assert.throws(() => planUnwind([], new Map(), { exitFloorBps: 0n, maxSharesPerTrade: 0n }), /positive/);
});
