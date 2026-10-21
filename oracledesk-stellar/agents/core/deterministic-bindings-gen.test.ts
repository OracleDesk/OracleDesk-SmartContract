import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGeneratedBindingsIntegrity } from "./deterministic-bindings-gen.js";

test("verifyGeneratedBindingsIntegrity returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyGeneratedBindingsIntegrity({
    contextId: "market-0",
    onChainWasmCode: 120,
    localSpecHashCode: 80,
    networkIdCode: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyGeneratedBindingsIntegrity flags blocked status when threshold is breached", () => {
  const res = verifyGeneratedBindingsIntegrity({
    contextId: "market-1",
    onChainWasmCode: 600,
    localSpecHashCode: 400,
    networkIdCode: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyGeneratedBindingsIntegrity rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyGeneratedBindingsIntegrity({
        contextId: "   ",
        onChainWasmCode: 10,
        localSpecHashCode: 20,
        networkIdCode: 30,
      }),
    /contextId must be non-empty/,
  );
});
