import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calcBuy, priceAfterBuy, priceYesBps, seedReserves } from "../fpmm.js";
import { LocalTraceStore } from "../trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import { optimalBuySize, optimalSellSize } from "./sizing.js";
import { createTwapPlan, loadTwapPlan, saveTwapPlan, stepTwapPlan } from "./twap.js";

test("optimalBuySize never overshoots fairYesBps across 500 random pool states", () => {
  let state = 987654321;
  const rand = (min: number, max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };

  for (let i = 0; i < 500; i++) {
    const preYes = rand(1500, 8500);
    const s = seedReserves(BigInt(rand(50_000_000, 1_000_000_000)), BigInt(preYes));
    const outcome = rand(0, 1) === 0 ? ("Yes" as const) : ("No" as const);
    const fairYes =
      outcome === "Yes"
        ? Math.min(9800, preYes + rand(300, 2500))
        : Math.max(200, preYes - rand(300, 2500));
    const maxImpactBps = rand(100, 800);
    const feeBps = BigInt(rand(0, 200));

    const res = optimalBuySize({
      reserveYes: s.reserveYes,
      reserveNo: s.reserveNo,
      feeBps,
      outcome,
      fairYesBps: fairYes,
      maxImpactBps,
      maxCollateral: 500_000_000n,
      minEdgeAfterFeeBps: 50,
    });

    if (res.collateralIn > 0n) {
      if (outcome === "Yes") {
        assert.ok(res.postPriceYesBps <= fairYes, `overshot fairYes: ${res.postPriceYesBps} > ${fairYes}`);
      } else {
        assert.ok(res.postPriceYesBps >= fairYes, `overshot fairYes on NO: ${res.postPriceYesBps} < ${fairYes}`);
      }
    }
  }
});

test("optimalBuySize respects maxImpactBps and returns 0 when edge does not clear fee + minEdgeAfterFeeBps", () => {
  const s = seedReserves(1_000_000_000n, 4000n);
  const preYes = Number(priceYesBps(s.reserveYes, s.reserveNo));

  const clamped = optimalBuySize({
    reserveYes: s.reserveYes,
    reserveNo: s.reserveNo,
    feeBps: 100n,
    outcome: "Yes",
    fairYesBps: 7500,
    maxImpactBps: 300,
    maxCollateral: 1_000_000_000n,
    minEdgeAfterFeeBps: 100,
  });
  assert.ok(clamped.collateralIn > 0n);
  assert.ok(Math.abs(clamped.postPriceYesBps - preYes) <= 300);

  // Small edge (4000 -> 4150 bps = 150 bps) with 200 bps fee + 100 bps minEdge -> 0 size
  const noEdge = optimalBuySize({
    reserveYes: s.reserveYes,
    reserveNo: s.reserveNo,
    feeBps: 200n,
    outcome: "Yes",
    fairYesBps: 4150,
    maxImpactBps: 500,
    maxCollateral: 500_000_000n,
    minEdgeAfterFeeBps: 100,
  });
  assert.equal(noEdge.collateralIn, 0n);
});

test("optimalSellSize sizes profitable sells without overshooting fairYesBps", () => {
  // Pool prices YES at 7500 bps, fair value is 5000 bps -> sell YES
  const s = seedReserves(1_000_000_000n, 7500n);
  const res = optimalSellSize({
    reserveYes: s.reserveYes,
    reserveNo: s.reserveNo,
    feeBps: 50n,
    outcome: "Yes",
    fairYesBps: 5000,
    maxImpactBps: 400,
    maxShares: 500_000_000n,
    minEdgeAfterFeeBps: 100,
  });
  assert.ok(res.collateralOut > 0n);
  assert.ok(res.postPriceYesBps >= 5000);
  assert.ok(res.expectedEdgeStroops > 0n);
});

test("TWAP splits a large order across slices, links child traces to parent, and cancels when edge disappears or close approaches", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "twap-test-"));
  const traceStore = new LocalTraceStore(join(tmp, "traces"));
  const planFile = join(tmp, "plan.json");

  const s = seedReserves(1_000_000_000n, 3500n);
  let ry = s.reserveYes;
  let rn = s.reserveNo;
  const feeBps = 50n;
  const closeTime = 2_000_000;

  const plan = await createTwapPlan({
    planId: "twap-1",
    marketId: 7,
    outcome: "Yes",
    pool: { reserveYes: ry, reserveNo: rn, feeBps, closeTime },
    fairYesBps: 7000,
    maxTotalCollateral: 600_000_000n,
    maxSliceImpactBps: 250,
    minEdgeAfterFeeBps: 100,
    maxSlices: 5,
    sliceIntervalSecs: 30,
    closeBufferSecs: 120,
    traceStore,
    now: 1_000_000,
  });

  assert.equal(plan.status, "active");
  assert.ok(plan.totalTargetCollateral > 0n);

  const fakeAdapter = {
    mode: "dry-run",
    agent: "GTRADER",
    async quoteBuy({ collateral_in }: { collateral_in: bigint }) {
      const q = calcBuy(ry, rn, collateral_in, feeBps);
      return q.sharesOut;
    },
    async agentBuyV2({ collateral_in }: { collateral_in: bigint }) {
      const q = calcBuy(ry, rn, collateral_in, feeBps);
      ry = q.newReserveBought;
      rn = q.newReserveOther;
      return { dryRun: true as const, contractId: "CTREASURY", method: "agent_buy_v2", args: {} };
    },
  } as unknown as StellarAdapter;

  // Slice 0 at t = 1_000_000
  await stepTwapPlan({
    plan,
    pool: { reserveYes: ry, reserveNo: rn, feeBps, closeTime },
    currentFairYesBps: 7000,
    adapter: fakeAdapter,
    traceStore,
    now: 1_000_000,
    planFilePath: planFile,
  });
  assert.equal(plan.slices.length, 1);
  assert.ok(plan.slices[0].collateralIn < plan.totalTargetCollateral, "should split into multiple slices");

  // Reload from disk to verify crash-resilient persistence
  const reloaded = loadTwapPlan(planFile)!;
  assert.equal(reloaded.slices.length, 1);
  assert.equal(reloaded.parentTraceHash, plan.parentTraceHash);

  // Slice 1 at t = 1_000_040 when fair value drops to 3800 bps (edge disappears) -> cancels
  await stepTwapPlan({
    plan: reloaded,
    pool: { reserveYes: ry, reserveNo: rn, feeBps, closeTime },
    currentFairYesBps: 3800,
    adapter: fakeAdapter,
    traceStore,
    now: 1_000_040,
    planFilePath: planFile,
  });
  assert.equal(reloaded.status, "cancelled");

  // Test close-time buffer cancellation
  reloaded.status = "active";
  saveTwapPlan(planFile, reloaded);
  await stepTwapPlan({
    plan: reloaded,
    pool: { reserveYes: ry, reserveNo: rn, feeBps, closeTime },
    currentFairYesBps: 7000,
    adapter: fakeAdapter,
    traceStore,
    now: closeTime - 60, // inside 120s buffer
  });
  assert.equal(reloaded.status, "cancelled");
  assert.match(reloaded.cancelReason ?? "", /close buffer/);
});
