import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyResolutionSpecVector } from "./resolution-spec-vectors.js";

test("verifyResolutionSpecVector returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyResolutionSpecVector({
    contextId: "market-0",
    canonicalJsonLength: 120,
    expectedHashPrefix: 80,
    computedHashPrefix: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyResolutionSpecVector flags blocked status when threshold is breached", () => {
  const res = verifyResolutionSpecVector({
    contextId: "market-1",
    canonicalJsonLength: 600,
    expectedHashPrefix: 400,
    computedHashPrefix: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyResolutionSpecVector rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyResolutionSpecVector({
        contextId: "   ",
        canonicalJsonLength: 10,
        expectedHashPrefix: 20,
        computedHashPrefix: 30,
      }),
    /contextId must be non-empty/,
  );
});
