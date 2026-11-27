/**
 * Tests for verdict-watcher.ts (#306).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  processBatch,
  MemoryCursorStore,
  MemoryPaymentQueryStore,
  type EventSource,
  type RegistryEvent,
} from "./verdict-watcher.js";

const WINDOW = 86_400; // 1 day refund window

function makeEventSource(events: RegistryEvent[]): EventSource {
  return {
    async getRegistryEvents(_afterLedger: number) {
      return events;
    },
  };
}

test("flag event marks recent payments refund_pending", async () => {
  const cursorStore = new MemoryCursorStore();
  const paymentStore = new MemoryPaymentQueryStore();
  const now = Math.floor(Date.now() / 1000);

  paymentStore.addPayment({
    paymentId: "pay-1",
    traceId: "42",
    agent: "GAGENT",
    settledAt: now - 60, // 1 minute ago — within window
  });

  const result = await processBatch({
    eventSource: makeEventSource([
      { kind: "TraceFlagged", traceId: 42n, reason: "fabricated", ledger: 100, timestamp: now },
    ]),
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });

  assert.equal(result.processed, 1);
  assert.equal(result.cursor, 100);
  const payments = paymentStore.getPayments();
  assert.equal(payments[0].state, "refund_pending");
  assert.ok(payments[0].refundReason?.includes("Flagged"));
});

test("flag event outside window is ignored", async () => {
  const cursorStore = new MemoryCursorStore();
  const paymentStore = new MemoryPaymentQueryStore();
  const now = Math.floor(Date.now() / 1000);

  paymentStore.addPayment({
    paymentId: "pay-old",
    traceId: "7",
    agent: "GAGENT",
    settledAt: now - WINDOW - 100, // outside window
  });

  const result = await processBatch({
    eventSource: makeEventSource([
      { kind: "TraceFlagged", traceId: 7n, reason: "stale", ledger: 50, timestamp: now },
    ]),
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });

  assert.equal(result.processed, 0);
  const payments = paymentStore.getPayments();
  assert.equal(payments[0].state, "settled"); // unchanged
});

test("agent revoked event marks recent payments refund_pending", async () => {
  const cursorStore = new MemoryCursorStore();
  const paymentStore = new MemoryPaymentQueryStore();
  const now = Math.floor(Date.now() / 1000);

  paymentStore.addPayment({
    paymentId: "pay-2",
    traceId: "10",
    agent: "GCOMPROMISED",
    settledAt: now - 300,
  });

  await processBatch({
    eventSource: makeEventSource([
      {
        kind: "AgentRevoked",
        agent: "GCOMPROMISED",
        effectiveFrom: 1000n,
        ledger: 200,
        timestamp: now,
      },
    ]),
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });

  const payments = paymentStore.getPayments();
  assert.equal(payments[0].state, "refund_pending");
  assert.ok(payments[0].refundReason?.includes("AgentRevokedAfter"));
});

test("cursor is persisted across restarts", async () => {
  const cursorStore = new MemoryCursorStore();
  const paymentStore = new MemoryPaymentQueryStore();
  const now = Math.floor(Date.now() / 1000);

  await processBatch({
    eventSource: makeEventSource([
      { kind: "TraceFlagged", traceId: 1n, reason: "r", ledger: 777, timestamp: now },
    ]),
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });

  assert.equal(await cursorStore.getCursor(), 777);

  // Simulate restart — cursor is preserved
  const result2 = await processBatch({
    eventSource: makeEventSource([]), // no new events
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });
  assert.equal(result2.cursor, 777);
});

test("empty event batch returns zero processed and unchanged cursor", async () => {
  const cursorStore = new MemoryCursorStore();
  const paymentStore = new MemoryPaymentQueryStore();

  const result = await processBatch({
    eventSource: makeEventSource([]),
    cursorStore,
    paymentStore,
    refundWindowSecs: WINDOW,
  });
  assert.equal(result.processed, 0);
  assert.equal(result.cursor, 0);
});
