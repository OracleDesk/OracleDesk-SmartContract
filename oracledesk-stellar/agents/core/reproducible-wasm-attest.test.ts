import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReproducibleWasmBuild } from "./reproducible-wasm-attest.js";

test("verifyReproducibleWasmBuild returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = verifyReproducibleWasmBuild({
    contextId: "market-0",
    sourceTreeHashCode: 120,
    compiledWasmHashCode: 80,
    expectedWasmHashCode: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("verifyReproducibleWasmBuild flags blocked status when threshold is breached", () => {
  const res = verifyReproducibleWasmBuild({
    contextId: "market-1",
    sourceTreeHashCode: 600,
    compiledWasmHashCode: 400,
    expectedWasmHashCode: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("verifyReproducibleWasmBuild rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      verifyReproducibleWasmBuild({
        contextId: "   ",
        sourceTreeHashCode: 10,
        compiledWasmHashCode: 20,
        expectedWasmHashCode: 30,
      }),
    /contextId must be non-empty/,
  );
});
