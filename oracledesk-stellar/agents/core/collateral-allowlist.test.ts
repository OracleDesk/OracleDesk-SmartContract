import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCollateralSelection } from "./collateral-allowlist.js";

test("evaluateCollateralSelection returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateCollateralSelection({
    contextId: "market-0",
    tokenContractId: 120,
    decimals: 80,
    maxMarketCapStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateCollateralSelection flags blocked status when threshold is breached", () => {
  const res = evaluateCollateralSelection({
    contextId: "market-1",
    tokenContractId: 600,
    decimals: 400,
    maxMarketCapStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateCollateralSelection rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateCollateralSelection({
        contextId: "   ",
        tokenContractId: 10,
        decimals: 20,
        maxMarketCapStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
