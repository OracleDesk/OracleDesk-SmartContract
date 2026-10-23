import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEntrypointPrePostConditions } from "./normative-spec-invariants.js";

test("verifyEntrypointPrePostConditions returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyEntrypointPrePostConditions({
    contextId: "market-0",
    preReserveK: 120,
    postReserveK: 80,
    feeChargedBps: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyEntrypointPrePostConditions flags blocked status when threshold is breached", () => {
  const res = verifyEntrypointPrePostConditions({
    contextId: "market-1",
    preReserveK: 600,
    postReserveK: 400,
    feeChargedBps: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyEntrypointPrePostConditions rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyEntrypointPrePostConditions({
        contextId: "   ",
        preReserveK: 10,
        postReserveK: 20,
        feeChargedBps: 30,
      }),
    /contextId must be non-empty/,
  );
});
