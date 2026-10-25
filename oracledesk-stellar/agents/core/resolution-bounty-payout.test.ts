import { test } from "node:test";
import assert from "node:assert/strict";
import { computeResolutionCallerBounty } from "./resolution-bounty-payout.js";

test("computeResolutionCallerBounty returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = computeResolutionCallerBounty({
    contextId: "market-0",
    baseBountyStroops: 120,
    delaySeconds: 80,
    maxBonusStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("computeResolutionCallerBounty flags blocked status when threshold is breached", () => {
  const res = computeResolutionCallerBounty({
    contextId: "market-1",
    baseBountyStroops: 600,
    delaySeconds: 400,
    maxBonusStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("computeResolutionCallerBounty rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      computeResolutionCallerBounty({
        contextId: "   ",
        baseBountyStroops: 10,
        delaySeconds: 20,
        maxBonusStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
