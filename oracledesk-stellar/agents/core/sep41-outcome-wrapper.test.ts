import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcomeWrapperMint } from "./sep41-outcome-wrapper.js";

test("computeOutcomeWrapperMint returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = computeOutcomeWrapperMint({
    contextId: "market-0",
    marketId: 120,
    collateralLockedStroops: 80,
    wrapperSupplyStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("computeOutcomeWrapperMint flags blocked status when threshold is breached", () => {
  const res = computeOutcomeWrapperMint({
    contextId: "market-1",
    marketId: 600,
    collateralLockedStroops: 400,
    wrapperSupplyStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("computeOutcomeWrapperMint rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      computeOutcomeWrapperMint({
        contextId: "   ",
        marketId: 10,
        collateralLockedStroops: 20,
        wrapperSupplyStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
