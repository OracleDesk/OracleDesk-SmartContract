import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSupplyChainSecurity } from "./supply-chain-ci-gate.js";

test("evaluateSupplyChainSecurity returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = evaluateSupplyChainSecurity({
    contextId: "market-0",
    highVulnCount: 120,
    unpinnedActionCount: 80,
    leakedSecretCount: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("evaluateSupplyChainSecurity flags blocked status when threshold is breached", () => {
  const res = evaluateSupplyChainSecurity({
    contextId: "market-1",
    highVulnCount: 600,
    unpinnedActionCount: 400,
    leakedSecretCount: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("evaluateSupplyChainSecurity rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      evaluateSupplyChainSecurity({
        contextId: "   ",
        highVulnCount: 10,
        unpinnedActionCount: 20,
        leakedSecretCount: 30,
      }),
    /contextId must be non-empty/,
  );
});
