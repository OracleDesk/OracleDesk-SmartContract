import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFpmmPoolAnalytics } from "./python-fpmm-analytics.js";

test("computeFpmmPoolAnalytics returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = computeFpmmPoolAnalytics({
    contextId: "market-0",
    reserveYesStroops: 120,
    reserveNoStroops: 80,
    volume24hStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("computeFpmmPoolAnalytics flags blocked status when threshold is breached", () => {
  const res = computeFpmmPoolAnalytics({
    contextId: "market-1",
    reserveYesStroops: 600,
    reserveNoStroops: 400,
    volume24hStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("computeFpmmPoolAnalytics rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      computeFpmmPoolAnalytics({
        contextId: "   ",
        reserveYesStroops: 10,
        reserveNoStroops: 20,
        volume24hStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
