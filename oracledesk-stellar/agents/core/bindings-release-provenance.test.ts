import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBindingsReleaseManifest } from "./bindings-release-provenance.js";

test("validateBindingsReleaseManifest returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = validateBindingsReleaseManifest({
    contextId: "market-0",
    semverMajor: 120,
    semverMinor: 80,
    provenanceSigned: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("validateBindingsReleaseManifest flags blocked status when threshold is breached", () => {
  const res = validateBindingsReleaseManifest({
    contextId: "market-1",
    semverMajor: 600,
    semverMinor: 400,
    provenanceSigned: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("validateBindingsReleaseManifest rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      validateBindingsReleaseManifest({
        contextId: "   ",
        semverMajor: 10,
        semverMinor: 20,
        provenanceSigned: 30,
      }),
    /contextId must be non-empty/,
  );
});
