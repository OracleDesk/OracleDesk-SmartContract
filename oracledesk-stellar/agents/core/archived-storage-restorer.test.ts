import { test } from "node:test";
import assert from "node:assert/strict";
import { planArchivedStorageRestore } from "./archived-storage-restorer.js";

test("planArchivedStorageRestore returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = planArchivedStorageRestore({
    contextId: "market-0",
    archivedEntryCount: 120,
    restoreFeeStroops: 80,
    maxBudgetStroops: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("planArchivedStorageRestore flags blocked status when threshold is breached", () => {
  const res = planArchivedStorageRestore({
    contextId: "market-1",
    archivedEntryCount: 600,
    restoreFeeStroops: 400,
    maxBudgetStroops: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("planArchivedStorageRestore rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      planArchivedStorageRestore({
        contextId: "   ",
        archivedEntryCount: 10,
        restoreFeeStroops: 20,
        maxBudgetStroops: 30,
      }),
    /contextId must be non-empty/,
  );
});
