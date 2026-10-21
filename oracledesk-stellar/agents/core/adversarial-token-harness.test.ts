import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateAdversarialTokenBehavior } from "./adversarial-token-harness.js";

test("simulateAdversarialTokenBehavior returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = simulateAdversarialTokenBehavior({
    contextId: "market-0",
    reentrancyAttempts: 120,
    feeOnTransferBps: 80,
    staleOracleSecs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("simulateAdversarialTokenBehavior flags blocked status when threshold is breached", () => {
  const res = simulateAdversarialTokenBehavior({
    contextId: "market-1",
    reentrancyAttempts: 600,
    feeOnTransferBps: 400,
    staleOracleSecs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("simulateAdversarialTokenBehavior rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      simulateAdversarialTokenBehavior({
        contextId: "   ",
        reentrancyAttempts: 10,
        feeOnTransferBps: 20,
        staleOracleSecs: 30,
      }),
    /contextId must be non-empty/,
  );
});
