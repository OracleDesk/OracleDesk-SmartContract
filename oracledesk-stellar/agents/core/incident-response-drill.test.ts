import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncidentDrillPlaybook } from "./incident-response-drill.js";

test("buildIncidentDrillPlaybook returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = buildIncidentDrillPlaybook({
    contextId: "market-0",
    affectedMarketId: 120,
    detectedAnomalyBps: 80,
    pauseDelaySecs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("buildIncidentDrillPlaybook flags blocked status when threshold is breached", () => {
  const res = buildIncidentDrillPlaybook({
    contextId: "market-1",
    affectedMarketId: 600,
    detectedAnomalyBps: 400,
    pauseDelaySecs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("buildIncidentDrillPlaybook rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      buildIncidentDrillPlaybook({
        contextId: "   ",
        affectedMarketId: 10,
        detectedAnomalyBps: 20,
        pauseDelaySecs: 30,
      }),
    /contextId must be non-empty/,
  );
});
