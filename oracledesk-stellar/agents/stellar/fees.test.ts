import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FEE_POLICY,
  feePolicyFor,
  inclusionBid,
  type FeeDistribution,
  type FeeStatsResponse,
} from "./fees.js";

type StringField = Exclude<keyof FeeDistribution, "ledgerCount">;

function stats(percentile: StringField, value: string): FeeStatsResponse {
  const distribution: FeeDistribution = {
    max: "1000",
    min: "100",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "100",
    p60: "100",
    p70: "100",
    p80: "100",
    p90: "100",
    p95: "100",
    p99: "100",
    transactionCount: "1",
    ledgerCount: 1,
  };
  distribution[percentile] = value;
  return { sorobanInclusionFee: distribution, inclusionFee: distribution, latestLedger: 1 };
}

test("feePolicyFor groups binding methods by action class", () => {
  assert.equal(feePolicyFor("agent_buy_v2"), "trade");
  assert.equal(feePolicyFor("agent_buy_traced"), "trade");
  assert.equal(feePolicyFor("trade_and_publish_trace"), "trade");
  assert.equal(feePolicyFor("agent_create_market"), "create");
  assert.equal(feePolicyFor("publish_decision_trace"), "trace");
  assert.equal(feePolicyFor("unknown_method"), "maintenance");
});

test("inclusionBid clamps the observed percentile to the configured range", () => {
  const rule = DEFAULT_FEE_POLICY.trade;
  assert.equal(inclusionBid(stats("p90", "1"), rule), rule.minInclusion);
  assert.equal(inclusionBid(stats("p90", "500"), rule), 500n);
  assert.equal(inclusionBid(stats("p90", "999999"), rule), rule.maxInclusion);
});

test("every default rule can pay for at least one bump", () => {
  for (const rule of Object.values(DEFAULT_FEE_POLICY)) {
    assert.ok(rule.bumpMultiplier >= 10);
    assert.ok(rule.maxTotalFee >= rule.maxInclusion);
    assert.ok(rule.minInclusion <= rule.maxInclusion);
  }
});
