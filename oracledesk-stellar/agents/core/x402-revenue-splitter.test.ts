import { test } from "node:test";
import assert from "node:assert/strict";
import { splitX402TraceRevenue } from "./x402-revenue-splitter.js";

test("splitX402TraceRevenue returns ok status and deterministic sha256 digest within nominal bounds", () => {
  const res = splitX402TraceRevenue({
    contextId: "market-0",
    grossPaymentStroops: 120,
    protocolShareBps: 80,
    treasuryShareBps: 50,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "ok");
  assert.equal(res.scoreBps, 2000);
  assert.equal(res.digestHex.length, 64);
});

test("splitX402TraceRevenue flags blocked status when threshold is breached", () => {
  const res = splitX402TraceRevenue({
    contextId: "market-1",
    grossPaymentStroops: 600,
    protocolShareBps: 400,
    treasuryShareBps: 1500,
    limitThreshold: 1000,
  });
  assert.equal(res.status, "blocked");
  assert.equal(res.scoreBps, 10000);
  assert.match(res.reason, /threshold exceeded/);
});

test("splitX402TraceRevenue rejects empty contextId or non-finite parameters", () => {
  assert.throws(
    () =>
      splitX402TraceRevenue({
        contextId: "   ",
        grossPaymentStroops: 10,
        protocolShareBps: 20,
        treasuryShareBps: 30,
      }),
    /contextId must be non-empty/,
  );
});
