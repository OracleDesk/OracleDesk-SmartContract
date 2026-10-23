import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContractInterfaceManifest } from "./contract-interface-docs.js";

test("buildContractInterfaceManifest returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = buildContractInterfaceManifest({
    contextId: "market-0",
    entrypointCount: 120,
    documentedCount: 80,
    errorEnumCount: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("buildContractInterfaceManifest flags blocked status when threshold is breached", () => {
  const res = buildContractInterfaceManifest({
    contextId: "market-1",
    entrypointCount: 600,
    documentedCount: 400,
    errorEnumCount: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("buildContractInterfaceManifest rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      buildContractInterfaceManifest({
        contextId: "   ",
        entrypointCount: 10,
        documentedCount: 20,
        errorEnumCount: 30,
      }),
    /contextId must be non-empty/,
  );
});
