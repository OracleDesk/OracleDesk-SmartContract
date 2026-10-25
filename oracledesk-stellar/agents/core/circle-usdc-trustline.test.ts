import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyUsdcCollateralReadiness } from "./circle-usdc-trustline.js";

test("verifyUsdcCollateralReadiness returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyUsdcCollateralReadiness({
    contextId: "market-0",
    trustlineLimitStroops: 120,
    currentBalanceStroops: 80,
    requiredSeedStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyUsdcCollateralReadiness flags blocked status when threshold is breached", () => {
  const res = verifyUsdcCollateralReadiness({
    contextId: "market-1",
    trustlineLimitStroops: 600,
    currentBalanceStroops: 400,
    requiredSeedStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyUsdcCollateralReadiness rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyUsdcCollateralReadiness({
        contextId: "   ",
        trustlineLimitStroops: 10,
        currentBalanceStroops: 20,
        requiredSeedStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
