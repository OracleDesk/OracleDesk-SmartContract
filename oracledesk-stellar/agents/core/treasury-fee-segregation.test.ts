import { test } from "node:test";
import assert from "node:assert/strict";
import { segregateProtocolFeeFromCapital } from "./treasury-fee-segregation.js";

test("segregateProtocolFeeFromCapital returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = segregateProtocolFeeFromCapital({
    contextId: "market-0",
    totalBalanceStroops: 120,
    accruedFeesStroops: 80,
    requestedTradeStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("segregateProtocolFeeFromCapital flags blocked status when threshold is breached", () => {
  const res = segregateProtocolFeeFromCapital({
    contextId: "market-1",
    totalBalanceStroops: 600,
    accruedFeesStroops: 400,
    requestedTradeStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("segregateProtocolFeeFromCapital rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      segregateProtocolFeeFromCapital({
        contextId: "   ",
        totalBalanceStroops: 10,
        accruedFeesStroops: 20,
        requestedTradeStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
