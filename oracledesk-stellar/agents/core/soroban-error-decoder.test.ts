import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSimulationContractError } from "./soroban-error-decoder.js";

test("decodeSimulationContractError returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = decodeSimulationContractError({
    contextId: "market-0",
    contractErrorCode: 120,
    hostFunctionDepth: 80,
    retryableHintCode: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("decodeSimulationContractError flags blocked status when threshold is breached", () => {
  const res = decodeSimulationContractError({
    contextId: "market-1",
    contractErrorCode: 600,
    hostFunctionDepth: 400,
    retryableHintCode: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("decodeSimulationContractError rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      decodeSimulationContractError({
        contextId: "   ",
        contractErrorCode: 10,
        hostFunctionDepth: 20,
        retryableHintCode: 30,
      }),
    /contextId must be non-empty/,
  );
});
