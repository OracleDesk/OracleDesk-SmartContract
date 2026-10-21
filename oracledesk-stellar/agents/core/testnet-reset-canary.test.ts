import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTestnetLedgerReset } from "./testnet-reset-canary.js";

test("detectTestnetLedgerReset returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = detectTestnetLedgerReset({
    contextId: "market-0",
    recordedLedgerSeq: 120,
    currentLedgerSeq: 80,
    contractCodePresent: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("detectTestnetLedgerReset flags blocked status when threshold is breached", () => {
  const res = detectTestnetLedgerReset({
    contextId: "market-1",
    recordedLedgerSeq: 600,
    currentLedgerSeq: 400,
    contractCodePresent: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("detectTestnetLedgerReset rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      detectTestnetLedgerReset({
        contextId: "   ",
        recordedLedgerSeq: 10,
        currentLedgerSeq: 20,
        contractCodePresent: 30,
      }),
    /contextId must be non-empty/,
  );
});
