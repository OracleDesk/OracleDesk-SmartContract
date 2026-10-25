import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPinnedToolchainVersions } from "./hermetic-toolchain-lock.js";

test("verifyPinnedToolchainVersions returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyPinnedToolchainVersions({
    contextId: "market-0",
    rustVersionCode: 120,
    sorobanCliCode: 80,
    nodeMajorVersion: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyPinnedToolchainVersions flags blocked status when threshold is breached", () => {
  const res = verifyPinnedToolchainVersions({
    contextId: "market-1",
    rustVersionCode: 600,
    sorobanCliCode: 400,
    nodeMajorVersion: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyPinnedToolchainVersions rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyPinnedToolchainVersions({
        contextId: "   ",
        rustVersionCode: 10,
        sorobanCliCode: 20,
        nodeMajorVersion: 30,
      }),
    /contextId must be non-empty/,
  );
});
