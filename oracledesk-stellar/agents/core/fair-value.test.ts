import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fairValueFor, firstEstimate, type MarketFairValueSource } from "./strategy.js";
import { buildTraceV2, type BuyInputs } from "./trace.js";
import { replayFairValue } from "./fair-value-replay.js";
import { priceModel, gaussian, seededRandom, type PriceModel } from "./strategies/volatility.js";
import { buildReport, calibrationGate, parsePriceCsv, reportHash, reportMarkdown, runCalibration, DEFAULT_CALIBRATION } from "./calibration.js";

const m = { marketId: 1n, closeTime: 10_000n };
const none: MarketFairValueSource = { name: "none", estimate: async () => null };
const est = { fairYesBps: 6_200, uncertaintyBps: 340, source: "volatility-model", observedAt: 5 };
const ok: MarketFairValueSource = { name: "ok", estimate: async () => est };

test("firstEstimate asks sources in order and isolates a throwing source", async () => {
  const errors: string[] = [];
  const broken: MarketFairValueSource = {
    name: "broken",
    estimate: async () => {
      throw new Error("feed down");
    },
  };
  assert.equal(await firstEstimate([none, broken], m, 0n, (s) => errors.push(s)), null);
  assert.deepEqual(errors, ["broken"]);
  assert.equal(await firstEstimate([broken, ok], m, 0n), est);
});

test("fairValueFor: no estimate means not traded; never the market's own price", async () => {
  assert.equal(await fairValueFor([none], undefined, m, 0n), undefined);
  assert.deepEqual(await fairValueFor([none, ok], 9_000, m, 0n), {
    fairValueBps: 6_200,
    uncertaintyBps: 340,
    fairValue: est,
  });
  // FAIR_VALUE_BPS is a last-resort test/dry-run override (rejected live by config).
  assert.deepEqual(await fairValueFor([none], 7_000, m, 0n), { fairValueBps: 7_000 });
});

const model: PriceModel = {
  kind: "spot",
  reflector: "CFEED",
  asset: "other:XLM",
  decimals: 7,
  resolution: "300",
  gridSlot: "3600",
  spot: "1020000",
  spotTs: "0",
  threshold: "1000000",
  thresholdDecimals: null,
  direction: "AtOrAbove",
  sigmaPerSlot: 0.01,
  sigmaStdErr: 0.001,
  estimator: "ewma",
  lambda: 0.94,
  tau: 12,
  samples: 95,
  priceRefs: [{ ts: "0", price: "1020000" }],
};

function buyTrace(bps: number) {
  const inputs: BuyInputs = {
    marketId: "3",
    ledgerSequence: 100,
    ledgerCloseTime: 1_700_000_000,
    reserveYes: "600",
    reserveNo: "400",
    feeBps: 100,
    priceYesBps: 4000,
    fairValue: { bps, source: "volatility-model", observedAt: 0, model: model as unknown as Record<string, unknown> },
    order: { outcome: "yes", collateralIn: "100", minSharesOut: "90" },
    contracts: { marketCore: "CMC", treasury: "CTR" },
  };
  return buildTraceV2({ agent: "trader", marketId: "3", action: "buy", reasoning: "r", inputs });
}

test("v2 trace accepts fairValue.model and replay reproduces bps", () => {
  const bps = priceModel(model).fairYesBps;
  const built = buyTrace(bps);
  const parsed = JSON.parse(built.json);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.inputs.fairValue.model.kind, "spot");
  assert.deepEqual(replayFairValue(built.trace), { recordedBps: bps, replayedBps: bps, matches: true });
  // An edited trace no longer replays.
  assert.equal(replayFairValue(buyTrace(bps + 1).trace)!.matches, false);
});

test("trace schema documents the fair-value model", () => {
  const schema = JSON.parse(readFileSync(new URL("./trace.schema.json", import.meta.url), "utf8"));
  assert.ok(schema.$defs.fairValueModel);
  const props = schema.$defs.fairValueModel.required as string[];
  for (const key of props) assert.ok(key in model || key === "twap", key);
});

// ── calibration ───────────────────────────────────────────────────────────

function gbmCsv(n: number, sigma: number, seed: number): string {
  const z = gaussian(seededRandom(seed));
  let logS = Math.log(0.1);
  const lines = ["ts,price"];
  for (let i = 0; i < n; i++) {
    if (i > 0) logS += -(sigma * sigma) / 2 + sigma * z();
    lines.push(`${1_700_000_100 - (1_700_000_100 % 300) + i * 300},${Math.exp(logS).toFixed(7)}`);
  }
  return lines.join("\n");
}

test("calibration on synthetic GBM beats the persistence baseline", () => {
  const csv = gbmCsv(1_500, 0.004, 9);
  const { points, decimals } = parsePriceCsv(csv);
  assert.equal(decimals, 7);
  assert.equal(points.length, 1_500);
  const run = runCalibration(points, { ...DEFAULT_CALIBRATION, resolution: 300n, decimals });
  const report = buildReport(run, { file: "gbm.csv", sha256: "x", points: points.length, asset: "GBM", params: {} }, "2026-01-01T00:00:00Z");
  assert.ok(report.markets > 1_000);
  assert.ok(report.brier < report.baselineBrier, `${report.brier} vs ${report.baselineBrier}`);
  assert.equal(report.reliability.length, 10);
  assert.equal(report.reliability.reduce((s, b) => s + b.count, 0), report.markets);
  assert.match(reportMarkdown(report), /Brier score/);
  const json = JSON.stringify(report);
  assert.deepEqual(calibrationGate(json, reportHash(json)), { ok: true, reasons: [] });
});

test("calibration gate rejects a wrong hash or a report that loses to the baseline", () => {
  const good = JSON.stringify({ version: 1, markets: 10, brier: 0.1, baselineBrier: 0.2 });
  assert.ok(!calibrationGate(good, "0".repeat(64)).ok);
  assert.ok(!calibrationGate(good, undefined).ok);
  const bad = JSON.stringify({ version: 1, markets: 10, brier: 0.3, baselineBrier: 0.2 });
  const r = calibrationGate(bad, reportHash(bad));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /does not beat/);
});
