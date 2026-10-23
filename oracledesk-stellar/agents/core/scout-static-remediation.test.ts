import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScoutSecurityGate } from "./scout-static-remediation.js";

test("evaluateScoutSecurityGate returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateScoutSecurityGate({
    contextId: "market-0",
    criticalFindings: 120,
    highFindings: 80,
    mediumFindings: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateScoutSecurityGate flags blocked status when threshold is breached", () => {
  const res = evaluateScoutSecurityGate({
    contextId: "market-1",
    criticalFindings: 600,
    highFindings: 400,
    mediumFindings: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateScoutSecurityGate rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateScoutSecurityGate({
        contextId: "   ",
        criticalFindings: 10,
        highFindings: 20,
        mediumFindings: 30,
      }),
    /contextId must be non-empty/,
  );
});
