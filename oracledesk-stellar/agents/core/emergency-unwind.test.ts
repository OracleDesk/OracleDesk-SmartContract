import { test } from "node:test";
import assert from "node:assert/strict";
import { planEmergencyTreasuryUnwind } from "./emergency-unwind.js";

test("planEmergencyTreasuryUnwind returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = planEmergencyTreasuryUnwind({
    contextId: "market-0",
    positionSharesStroops: 120,
    reserveYesStroops: 80,
    maxSlippageBps: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("planEmergencyTreasuryUnwind flags blocked status when threshold is breached", () => {
  const res = planEmergencyTreasuryUnwind({
    contextId: "market-1",
    positionSharesStroops: 600,
    reserveYesStroops: 400,
    maxSlippageBps: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("planEmergencyTreasuryUnwind rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      planEmergencyTreasuryUnwind({
        contextId: "   ",
        positionSharesStroops: 10,
        reserveYesStroops: 20,
        maxSlippageBps: 30,
      }),
    /contextId must be non-empty/,
  );
});
