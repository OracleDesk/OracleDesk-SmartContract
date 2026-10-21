import { test } from "node:test";
import assert from "node:assert/strict";
import { gbmThresholdProb, normCdf, probToBps, SECONDS_PER_YEAR } from "./gbm.js";
import { realizedVolatility, type PricePoint } from "./volatility.js";
import { VolatilityFairValueSource } from "./fair_value.js";

test("normCdf matches reference normal table values and satisfies symmetry", () => {
  assert.equal(normCdf(0), 0.5);
  assert.equal(normCdf(-10), 0);
  assert.equal(normCdf(10), 1);

  const refs: Array<[number, number]> = [
    [1, 0.8413447],
    [1.96, 0.9750021],
    [2.5, 0.9937903],
    [-1, 0.1586553],
  ];
  for (const [x, expected] of refs) {
    assert.ok(Math.abs(normCdf(x) - expected) < 1e-6, `normCdf(${x}) != ${expected}`);
    assert.ok(Math.abs(normCdf(x) + normCdf(-x) - 1) < 1e-12, `symmetry failed at ${x}`);
  }
});

test("gbmThresholdProb satisfies Itô drift, strike monotonicity, and boundary convergence", () => {
  // At-the-money (spot == strike) with mu == 0 is slightly < 0.5 due to -0.5 * sigma^2 * tau
  const atm = gbmThresholdProb({
    spot: 100,
    strike: 100,
    sigmaAnnual: 0.8,
    horizonSeconds: 30 * 86_400,
    direction: "above",
  });
  assert.ok(atm < 0.5 && atm > 0.4, `expected ATM prob in (0.4, 0.5), got ${atm}`);

  // Monotonicity in strike K for "above" and "below"
  const pLowK = gbmThresholdProb({
    spot: 100,
    strike: 90,
    sigmaAnnual: 0.6,
    horizonSeconds: 7 * 86_400,
    direction: "above",
  });
  const pHighK = gbmThresholdProb({
    spot: 100,
    strike: 110,
    sigmaAnnual: 0.6,
    horizonSeconds: 7 * 86_400,
    direction: "above",
  });
  assert.ok(pLowK > pHighK);

  // Expired horizon (tau -> 0) and clamping to [100, 9900] bps
  const expiredItm = probToBps(
    gbmThresholdProb({
      spot: 105,
      strike: 100,
      sigmaAnnual: 0.5,
      horizonSeconds: 0,
      direction: "above",
    }),
  );
  const expiredOtm = probToBps(
    gbmThresholdProb({
      spot: 95,
      strike: 100,
      sigmaAnnual: 0.5,
      horizonSeconds: 0,
      direction: "above",
    }),
  );
  assert.equal(expiredItm, 9900);
  assert.equal(expiredOtm, 100);
});

test("realizedVolatility recovers synthetic GBM volatility and falls back on < 10 samples", () => {
  // Deterministic Box-Muller synthetic series with known annualized sigma = 0.60
  const targetSigma = 0.6;
  const dt = 300; // 5-minute steps
  const stepStd = targetSigma * Math.sqrt(dt / SECONDS_PER_YEAR);
  let state = 1234567;
  const randUniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 1) / 4294967297;
  };
  const randNorm = () => {
    const u1 = randUniform();
    const u2 = randUniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const series: PricePoint[] = [];
  let price = 1_000_000_000;
  let t = 1_700_000_000;
  series.push({ timestamp: t, price: BigInt(Math.round(price)) });
  for (let i = 0; i < 400; i++) {
    t += dt;
    price *= Math.exp(stepStd * randNorm());
    series.push({ timestamp: t, price: BigInt(Math.round(price)) });
  }

  const est = realizedVolatility(series);
  assert.equal(est.lowConfidence, false);
  assert.equal(est.sampleCount, 400);
  assert.ok(
    Math.abs(est.sigmaAnnual - targetSigma) < 0.08,
    `expected sigma ~ ${targetSigma}, got ${est.sigmaAnnual}`,
  );

  // Fallback when fewer than 10 samples exist
  const shortEst = realizedVolatility(series.slice(0, 5), { fallbackSigma: 0.85 });
  assert.equal(shortEst.lowConfidence, true);
  assert.equal(shortEst.sigmaAnnual, 0.85);
});

test("VolatilityFairValueSource rejects stale oracle prices and records full provenance", async () => {
  const nowSec = 1_800_000_000;
  const freshPoints: PricePoint[] = Array.from({ length: 20 }, (_, i) => ({
    timestamp: nowSec - (20 - i) * 300,
    price: BigInt(2_000_000 + i * 5_000),
  }));

  const source = new VolatilityFairValueSource(
    {
      async latestPrice(_oracle, asset) {
        if (asset === "STALE") {
          return { timestamp: nowSec - 3600, price: 2_000_000n };
        }
        return freshPoints[freshPoints.length - 1];
      },
      async history() {
        return freshPoints;
      },
    },
    { now: () => nowSec, maxOracleAgeSeconds: 900, baseMinEdgeBps: 500 },
  );

  const staleRes = await source.estimateMarket({
    oracle: "CORACLE",
    asset: "STALE",
    threshold: 2_100_000n,
    comparison: "Gt",
    closeTime: nowSec + 86_400,
  });
  assert.equal(staleRes, null);

  const validRes = await source.estimateMarket({
    oracle: "CORACLE",
    asset: "XLM",
    threshold: 2_050_000n,
    comparison: "Gt",
    closeTime: nowSec + 86_400,
  });
  assert.ok(validRes);
  assert.ok(validRes.fairValueBps >= 100 && validRes.fairValueBps <= 9900);
  assert.equal(validRes.lowConfidence, false);
  assert.equal(validRes.recommendedMinEdgeBps, 500);
  assert.equal(validRes.inputs.strike, "2050000");
  assert.equal(validRes.inputs.direction, "above");
});
