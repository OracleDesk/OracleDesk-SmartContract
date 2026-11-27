import { test } from "node:test";
import assert from "node:assert/strict";
import { buyTraceV2, type TraderCandidate, type TraderDeps } from "./trader.js";
import { replayFairValue } from "../../core/fair-value-replay.js";
import { priceModel, type PriceModel } from "../../core/strategies/volatility.js";

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
  tau: 12,
  samples: 95,
  priceRefs: [],
};
const priced = priceModel(model);
const candidate: TraderCandidate = {
  market: { marketId: 4, question: "q", yesBps: 4000, closeTime: 3600, reserveYesStroops: 600n, reserveNoStroops: 400n, feeBps: 100 },
  fairValueBps: priced.fairYesBps,
  uncertaintyBps: priced.uncertaintyBps,
  fairValue: {
    fairYesBps: priced.fairYesBps,
    uncertaintyBps: priced.uncertaintyBps,
    source: "volatility-model",
    observedAt: 0,
    model: model as unknown as Record<string, unknown>,
  },
  ledger: 77,
  ledgerCloseTime: 1_700_000_000,
};
const deps = { contracts: { marketCore: "CMC", treasury: "CTR" } } as TraderDeps;
const order = { reasoning: "edge", outcome: "Yes" as const, collateralIn: 100n, minSharesOut: 90n, extensions: { limitPriceBps: 6000 } };

test("trader buy traces are schema v2 with the full model and replay to the same bps", () => {
  const built = buyTraceV2(deps, candidate, order);
  assert.ok(built);
  const t = JSON.parse(built.json);
  assert.equal(t.schemaVersion, 2);
  assert.equal(t.action, "buy");
  assert.equal(t.inputs.priceYesBps, 4000);
  assert.equal(t.inputs.fairValue.bps, priced.fairYesBps);
  assert.equal(t.inputs.fairValue.model.sigmaPerSlot, 0.01);
  assert.deepEqual(t.inputs.contracts, deps.contracts);
  assert.equal(t.inputs.order.outcome, "yes");
  assert.ok(replayFairValue(built.trace)!.matches);
});

test("without pool or ledger data the trader keeps the v1 trace", () => {
  assert.equal(buyTraceV2(deps, { ...candidate, ledgerCloseTime: undefined }, order), undefined);
  assert.equal(buyTraceV2({} as TraderDeps, candidate, order), undefined);
});
