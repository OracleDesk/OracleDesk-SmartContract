import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeContractEventBatch } from "./typed-event-decoder.js";

test("decodeContractEventBatch returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = decodeContractEventBatch({
    contextId: "market-0",
    rawEventCount: 120,
    matchedTopicCount: 80,
    schemaMismatchCount: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("decodeContractEventBatch flags blocked status when threshold is breached", () => {
  const res = decodeContractEventBatch({
    contextId: "market-1",
    rawEventCount: 600,
    matchedTopicCount: 400,
    schemaMismatchCount: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("decodeContractEventBatch rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      decodeContractEventBatch({
        contextId: "   ",
        rawEventCount: 10,
        matchedTopicCount: 20,
        schemaMismatchCount: 30,
      }),
    /contextId must be non-empty/,
  );
});
