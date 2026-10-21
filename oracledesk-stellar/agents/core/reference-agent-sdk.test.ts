import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReferenceAgentCycle } from "./reference-agent-sdk.js";

test("evaluateReferenceAgentCycle returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateReferenceAgentCycle({
    contextId: "market-0",
    marketPriceBps: 120,
    signalFairBps: 80,
    maxOrderStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateReferenceAgentCycle flags blocked status when threshold is breached", () => {
  const res = evaluateReferenceAgentCycle({
    contextId: "market-1",
    marketPriceBps: 600,
    signalFairBps: 400,
    maxOrderStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateReferenceAgentCycle rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateReferenceAgentCycle({
        contextId: "   ",
        marketPriceBps: 10,
        signalFairBps: 20,
        maxOrderStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
