import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ewmaVariance,
  garchLite,
  gaussian,
  logReturns,
  logReturnsReport,
  monteCarloProbability,
  normCdf,
  priceModel,
  seededRandom,
  SIGMA_FLOOR,
  type PriceModel,
} from "./volatility.js";
import { PriceRuleFairValue, type PriceRule } from "./price-fair-value.js";
import type { ReflectorFeed } from "../reflector.js";
import type { PriceData } from "./grid.js";

const RES = 300n;

/** Driftless GBM on the grid with per-slot σ, integer prices at `decimals`. */
function gbm(n: number, sigma: number, seed: number, start = 1_000_000_0, t0 = 1_700_000_100n): PriceData[] {
  const z = gaussian(seededRandom(seed));
  let logS = Math.log(start);
  const out: PriceData[] = [];
  const base = t0 - (t0 % RES);
  for (let i = 0; i < n; i++) {
    if (i > 0) logS += -(sigma * sigma) / 2 + sigma * z();
    out.push({ timestamp: base + BigInt(i) * RES, price: BigInt(Math.round(Math.exp(logS))) });
  }
  return out;
}

function spotModel(over: Partial<PriceModel> = {}): PriceModel {
  return {
    kind: "spot",
    reflector: "CFEED",
    asset: "other:XLM",
    decimals: 7,
    resolution: "300",
    gridSlot: "0",
    spot: "1000000",
    spotTs: "0",
    threshold: "1000000",
    thresholdDecimals: null,
    direction: "AtOrAbove",
    sigmaPerSlot: 0.01,
    sigmaStdErr: 0.001,
    estimator: "ewma",
    tau: 12,
    samples: 95,
    priceRefs: [],
    ...over,
  };
}

test("normCdf matches reference values", () => {
  for (const [x, p] of [[0, 0.5], [1, 0.8413447461], [-1.96, 0.0249978951], [3, 0.9986501020]] as const)
    assert.ok(Math.abs(normCdf(x) - p) < 2e-7, `Φ(${x})`);
});

test("EWMA and GARCH-lite recover σ from synthetic GBM", () => {
  for (const sigma of [0.002, 0.01, 0.03]) {
    const series = gbm(3_000, sigma, 7).map((p) => ({ ts: p.timestamp, price: p.price }));
    const r = logReturns(series, RES);
    const ewma = Math.sqrt(ewmaVariance(r, 0.995));
    assert.ok(Math.abs(ewma / sigma - 1) < 0.15, `ewma ${ewma} vs ${sigma}`);
    const g = garchLite(r)!;
    assert.ok(Math.abs(Math.sqrt(g.nextVar) / sigma - 1) < 0.2, `garch ${Math.sqrt(g.nextVar)} vs ${sigma}`);
  }
  assert.equal(garchLite([0.01, -0.01]), null);
});

test("gaps longer than maxGap are skipped and annotated", () => {
  const s = [0n, 300n, 600n, 3_600n, 3_900n].map((ts, i) => ({ ts, price: 100n + BigInt(i) }));
  const r = logReturnsReport(s, RES);
  assert.equal(r.returns.length, 3);
  assert.deepEqual(r.gaps, [600n]);
});

test("spot pricing matches the closed form and a seeded Monte Carlo", () => {
  const m = spotModel({ spot: "1020000", threshold: "1000000", sigmaPerSlot: 0.01, tau: 16 });
  const p = priceModel(m).probability;
  const k = 1_000_000 - 0.5;
  const s = 0.01 * 4;
  const closed = normCdf((Math.log(1_020_000 / k) - (s * s) / 2) / s);
  assert.ok(Math.abs(p - closed) < 1e-12);
  const mc = monteCarloProbability(m, 40_000, 42);
  assert.ok(Math.abs(p - mc) < 0.01, `closed ${p} vs mc ${mc}`);
});

test("Above and AtOrAbove differ by exactly one feed tick", () => {
  // At the money with a tiny horizon the half-tick shift is visible.
  const atOr = priceModel(spotModel({ spot: "100", threshold: "100", direction: "AtOrAbove", sigmaPerSlot: 0.001, tau: 1 }));
  const above = priceModel(spotModel({ spot: "100", threshold: "100", direction: "Above", sigmaPerSlot: 0.001, tau: 1 }));
  assert.ok(atOr.probability > 0.99, `${atOr.probability}`);
  assert.ok(above.probability < 0.01, `${above.probability}`);
  // Below is the complement of AtOrAbove at the same threshold.
  const below = priceModel(spotModel({ spot: "1000000", threshold: "1010000", direction: "Below" }));
  const atOrAbove = priceModel(spotModel({ spot: "1000000", threshold: "1010000", direction: "AtOrAbove" }));
  assert.ok(Math.abs(below.probability + atOrAbove.probability - 1) < 1e-12);
});

test("scaled thresholds use the resolver's rescaling", () => {
  // Feed 7 decimals, threshold 0.10 with 2 decimals = 1_000_000 feed units.
  const scaled = priceModel(spotModel({ threshold: "10", thresholdDecimals: 2 }));
  const raw = priceModel(spotModel({ threshold: "1000000", thresholdDecimals: null }));
  assert.equal(scaled.probability, raw.probability);
});

test("τ = 0 is deterministic and zero volatility widens uncertainty", () => {
  assert.equal(priceModel(spotModel({ spot: "1000001", tau: 0 })).fairYesBps, 10_000);
  assert.equal(priceModel(spotModel({ spot: "999999", tau: 0 })).fairYesBps, 0);
  const flat = priceModel(spotModel({ sigmaPerSlot: SIGMA_FLOOR, sigmaStdErr: 0 }));
  const normal = priceModel(spotModel({ sigmaPerSlot: 0.01, sigmaStdErr: 0 }));
  assert.ok(flat.uncertaintyBps > normal.uncertaintyBps);
});

test("uncertainty grows with σ's standard error (delta method)", () => {
  const tight = priceModel(spotModel({ sigmaStdErr: 0.0001 }));
  const loose = priceModel(spotModel({ sigmaStdErr: 0.005 }));
  assert.ok(loose.uncertaintyBps > tight.uncertaintyBps);
  // Off-the-money estimates are more sensitive to σ than deep in-the-money ones.
  const deep = priceModel(spotModel({ spot: "2000000", sigmaStdErr: 0.005 }));
  assert.ok(deep.uncertaintyBps < loose.uncertaintyBps);
});

test("TWAP pricing matches a seeded Monte Carlo, including floor semantics", () => {
  const close = 30_000n;
  const realised = [27_300n, 27_600n, 27_900n].map((ts) => ({ ts: ts.toString(), price: "1000000" }));
  const futureSlots = [];
  for (let t = 28_200n; t <= 30_000n; t += RES) futureSlots.push(t.toString());
  const base: PriceModel = {
    ...spotModel({ spotTs: "27900", spot: "1000000", sigmaPerSlot: 0.01 }),
    kind: "twap",
    gridSlot: close.toString(),
    twap: { window: "3000", closeTime: close.toString(), minSamples: 3, maxGap: "600", realised, futureSlots },
  };
  for (const [threshold, direction] of [["1000000", "AtOrAbove"], ["1005000", "Above"], ["995000", "Below"], ["1000000", "AtOrBelow"]] as const) {
    const m = { ...base, threshold, direction };
    const p = priceModel(m).probability;
    const mc = monteCarloProbability(m, 30_000, 7);
    assert.ok(Math.abs(p - mc) < 0.02, `${direction} ${threshold}: model ${p} vs mc ${mc}`);
  }
  // Fully realised: deterministic, and the floored average decides.
  const done = { ...base, twap: { ...base.twap!, futureSlots: [] }, threshold: "1000000" };
  assert.equal(priceModel({ ...done, direction: "AtOrAbove" }).fairYesBps, 10_000);
  assert.equal(priceModel({ ...done, direction: "Above" }).fairYesBps, 0);
});

// ── the estimator source over a fake feed ─────────────────────────────────

function fakeFeed(points: PriceData[], opts: { last?: PriceData | null; decimals?: number } = {}): ReflectorFeed {
  const byTs = new Map(points.map((p) => [p.timestamp, p]));
  return {
    decimals: async () => opts.decimals ?? 7,
    resolution: async () => RES,
    lastPrice: async () => (opts.last === undefined ? points[points.length - 1]! : opts.last),
    price: async (_r, _a, ts) => byTs.get(ts) ?? null,
  };
}

const spotRule = (over: Partial<Extract<PriceRule, { kind: "spot" }>> = {}): PriceRule => ({
  kind: "spot",
  reflector: "CFEED",
  asset: { tag: "Other", value: "XLM" },
  threshold: 10_000_000n,
  thresholdDecimals: null,
  direction: "AtOrAbove",
  maxStaleness: 900n,
  ...over,
});

test("estimator: spot rule estimate is replayable from its model", async () => {
  const points = gbm(200, 0.004, 3);
  const last = points[points.length - 1]!;
  const src = new PriceRuleFairValue({ rules: async () => spotRule(), feed: fakeFeed(points) });
  const close = last.timestamp + 12n * RES + 17n;
  const r = await src.estimate({ marketId: 1n, closeTime: close }, last.timestamp + 10n);
  assert.ok(r);
  const model = r.model as unknown as PriceModel;
  assert.equal(model.tau, 12);
  assert.equal(model.gridSlot, (close - (close % RES)).toString());
  assert.equal(model.asset, "other:XLM");
  assert.ok(model.priceRefs.length >= 90);
  assert.equal(priceModel(model).fairYesBps, r.fairYesBps);
  assert.ok(r.uncertaintyBps >= 100);
});

test("estimator: stale feed, short history and non-price markets give no estimate", async () => {
  const points = gbm(200, 0.004, 3);
  const last = points[points.length - 1]!;
  const m = { marketId: 1n, closeTime: last.timestamp + 3_600n };
  const stale = new PriceRuleFairValue({ rules: async () => spotRule({ maxStaleness: 600n }), feed: fakeFeed(points) });
  assert.equal(await stale.estimate(m, last.timestamp + 601n), null);
  const short = new PriceRuleFairValue({ rules: async () => spotRule(), feed: fakeFeed(points.slice(-10)) });
  assert.equal(await short.estimate(m, last.timestamp), null);
  const none = new PriceRuleFairValue({ rules: async () => null, feed: fakeFeed(points) });
  assert.equal(await none.estimate(m, last.timestamp), null);
  const noPrice = new PriceRuleFairValue({ rules: async () => spotRule(), feed: fakeFeed(points, { last: null }) });
  assert.equal(await noPrice.estimate(m, last.timestamp), null);
});

test("estimator: hybrid markets are discounted toward 50% by the feed-failure probability", async () => {
  const points = gbm(200, 0.004, 3);
  const last = points[points.length - 1]!;
  const m = { marketId: 1n, closeTime: last.timestamp + 3_600n };
  const rule = spotRule({ threshold: last.price / 2n });
  const plain = await new PriceRuleFairValue({ rules: async () => rule, feed: fakeFeed(points) }).estimate(m, last.timestamp);
  const hybrid = await new PriceRuleFairValue({
    rules: async () => ({ ...rule, hybridFallbackAfter: 86_400n }),
    feed: fakeFeed(points),
    hybridFeedFailureProb: 0.1,
  }).estimate(m, last.timestamp);
  assert.equal(plain!.fairYesBps, 10_000);
  assert.equal(hybrid!.fairYesBps, 9_500);
  assert.ok(hybrid!.uncertaintyBps > plain!.uncertaintyBps);
});

test("estimator: TWAP rule splits realised and future slots on the grid", async () => {
  const points = gbm(200, 0.004, 5);
  const last = points[points.length - 1]!;
  const close = last.timestamp + 5n * RES;
  const rule: PriceRule = {
    kind: "twap",
    reflector: "CFEED",
    asset: { tag: "Stellar", value: "CASSET" },
    threshold: last.price,
    direction: "AtOrAbove",
    window: 10n * RES,
    minSamples: 5,
    maxGap: 2n * RES,
  };
  const r = await new PriceRuleFairValue({ rules: async () => rule, feed: fakeFeed(points) }).estimate(
    { marketId: 2n, closeTime: close },
    last.timestamp,
  );
  assert.ok(r);
  const model = r.model as unknown as PriceModel;
  assert.equal(model.twap!.futureSlots.length, 5);
  assert.equal(model.twap!.realised.length, 5);
  assert.equal(priceModel(model).fairYesBps, r.fairYesBps);
  const mc = monteCarloProbability(model, 30_000, 11);
  assert.ok(Math.abs(r.fairYesBps / 10_000 - mc) < 0.02, `${r.fairYesBps} vs mc ${mc}`);
});
