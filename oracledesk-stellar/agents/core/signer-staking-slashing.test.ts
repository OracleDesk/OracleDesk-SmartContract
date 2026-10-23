import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSignerEquivocationSlash } from "./signer-staking-slashing.js";

test("evaluateSignerEquivocationSlash returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateSignerEquivocationSlash({
    contextId: "market-0",
    stakedBondStroops: 120,
    equivocationCount: 80,
    missedEpochs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateSignerEquivocationSlash flags blocked status when threshold is breached", () => {
  const res = evaluateSignerEquivocationSlash({
    contextId: "market-1",
    stakedBondStroops: 600,
    equivocationCount: 400,
    missedEpochs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateSignerEquivocationSlash rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateSignerEquivocationSlash({
        contextId: "   ",
        stakedBondStroops: 10,
        equivocationCount: 20,
        missedEpochs: 30,
      }),
    /contextId must be non-empty/,
  );
});
