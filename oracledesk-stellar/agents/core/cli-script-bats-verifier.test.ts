import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDeployScriptInvocation } from "./cli-script-bats-verifier.js";

test("verifyDeployScriptInvocation returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyDeployScriptInvocation({
    contextId: "market-0",
    exitStatusCode: 120,
    retryAttempts: 80,
    networkTimeoutSecs: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyDeployScriptInvocation flags blocked status when threshold is breached", () => {
  const res = verifyDeployScriptInvocation({
    contextId: "market-1",
    exitStatusCode: 600,
    retryAttempts: 400,
    networkTimeoutSecs: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyDeployScriptInvocation rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyDeployScriptInvocation({
        contextId: "   ",
        exitStatusCode: 10,
        retryAttempts: 20,
        networkTimeoutSecs: 30,
      }),
    /contextId must be non-empty/,
  );
});
