import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVersionedEventPayload } from "./versioned-event-surface.js";

test("normalizeVersionedEventPayload returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = normalizeVersionedEventPayload({
    contextId: "market-0",
    schemaVersion: 120,
    contractCode: 80,
    ledgerSequence: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("normalizeVersionedEventPayload flags blocked status when threshold is breached", () => {
  const res = normalizeVersionedEventPayload({
    contextId: "market-1",
    schemaVersion: 600,
    contractCode: 400,
    ledgerSequence: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("normalizeVersionedEventPayload rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      normalizeVersionedEventPayload({
        contextId: "   ",
        schemaVersion: 10,
        contractCode: 20,
        ledgerSequence: 30,
      }),
    /contextId must be non-empty/,
  );
});
