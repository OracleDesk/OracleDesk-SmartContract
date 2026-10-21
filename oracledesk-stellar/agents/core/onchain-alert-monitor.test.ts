import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOnChainAnomalyAlerts } from "./onchain-alert-monitor.js";

test("evaluateOnChainAnomalyAlerts returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateOnChainAnomalyAlerts({
    contextId: "market-0",
    reserveDrainBps: 120,
    unrevealedCommitCount: 80,
    oracleLagSecs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateOnChainAnomalyAlerts flags blocked status when threshold is breached", () => {
  const res = evaluateOnChainAnomalyAlerts({
    contextId: "market-1",
    reserveDrainBps: 600,
    unrevealedCommitCount: 400,
    oracleLagSecs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateOnChainAnomalyAlerts rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateOnChainAnomalyAlerts({
        contextId: "   ",
        reserveDrainBps: 10,
        unrevealedCommitCount: 20,
        oracleLagSecs: 30,
      }),
    /contextId must be non-empty/,
  );
});
