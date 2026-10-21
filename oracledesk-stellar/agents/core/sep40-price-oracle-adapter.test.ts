import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSep40OraclePrice } from "./sep40-price-oracle-adapter.js";

test("evaluateSep40OraclePrice returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateSep40OraclePrice({
    contextId: "market-0",
    oraclePriceScaled: 120,
    strikePriceScaled: 80,
    stalenessSecs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateSep40OraclePrice flags blocked status when threshold is breached", () => {
  const res = evaluateSep40OraclePrice({
    contextId: "market-1",
    oraclePriceScaled: 600,
    strikePriceScaled: 400,
    stalenessSecs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateSep40OraclePrice rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateSep40OraclePrice({
        contextId: "   ",
        oraclePriceScaled: 10,
        strikePriceScaled: 20,
        stalenessSecs: 30,
      }),
    /contextId must be non-empty/,
  );
});
