import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateBulkMarketLedgerEntries } from "./bulk-ledger-market-reader.js";

test("aggregateBulkMarketLedgerEntries returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = aggregateBulkMarketLedgerEntries({
    contextId: "market-0",
    requestedMarkets: 120,
    decodedMarkets: 80,
    missingEntries: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("aggregateBulkMarketLedgerEntries flags blocked status when threshold is breached", () => {
  const res = aggregateBulkMarketLedgerEntries({
    contextId: "market-1",
    requestedMarkets: 600,
    decodedMarkets: 400,
    missingEntries: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("aggregateBulkMarketLedgerEntries rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      aggregateBulkMarketLedgerEntries({
        contextId: "   ",
        requestedMarkets: 10,
        decodedMarkets: 20,
        missingEntries: 30,
      }),
    /contextId must be non-empty/,
  );
});
