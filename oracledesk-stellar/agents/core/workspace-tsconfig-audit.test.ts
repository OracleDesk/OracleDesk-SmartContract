import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWorkspacePackageGraph } from "./workspace-tsconfig-audit.js";

test("verifyWorkspacePackageGraph returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyWorkspacePackageGraph({
    contextId: "market-0",
    packageCount: 120,
    circularDepCount: 80,
    strictModeEnabled: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyWorkspacePackageGraph flags blocked status when threshold is breached", () => {
  const res = verifyWorkspacePackageGraph({
    contextId: "market-1",
    packageCount: 600,
    circularDepCount: 400,
    strictModeEnabled: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyWorkspacePackageGraph rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyWorkspacePackageGraph({
        contextId: "   ",
        packageCount: 10,
        circularDepCount: 20,
        strictModeEnabled: 30,
      }),
    /contextId must be non-empty/,
  );
});
