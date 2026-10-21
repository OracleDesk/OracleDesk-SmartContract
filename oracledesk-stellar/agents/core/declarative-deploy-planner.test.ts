import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeclarativeDeployDiff } from "./declarative-deploy-planner.js";

test("computeDeclarativeDeployDiff returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = computeDeclarativeDeployDiff({
    contextId: "market-0",
    desiredWasmHashCode: 120,
    liveWasmHashCode: 80,
    configDriftCount: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("computeDeclarativeDeployDiff flags blocked status when threshold is breached", () => {
  const res = computeDeclarativeDeployDiff({
    contextId: "market-1",
    desiredWasmHashCode: 600,
    liveWasmHashCode: 400,
    configDriftCount: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("computeDeclarativeDeployDiff rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      computeDeclarativeDeployDiff({
        contextId: "   ",
        desiredWasmHashCode: 10,
        liveWasmHashCode: 20,
        configDriftCount: 30,
      }),
    /contextId must be non-empty/,
  );
});
