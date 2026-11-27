import assert from "node:assert/strict";
import test from "node:test";
import { publishPendingTraces, recordPendingTrace, TRACES, type PendingTrace } from "./traces.js";
import type { TaskContext } from "../runtime.js";

function fakeCtx() {
  const store = new Map<string, unknown>();
  const logs: Array<[string, string]> = [];
  const ctx = {
    signal: new AbortController().signal,
    state: {
      set: (_ns: string, key: string, value: unknown) => store.set(key, value),
      entries: () => [...store.entries()],
    },
    submit: <T>(fn: () => Promise<T>) => fn(),
    log: {
      info: (event: string) => logs.push(["info", event]),
      warn: (event: string) => logs.push(["warn", event]),
    },
  } as unknown as TaskContext;
  return { ctx, store, logs };
}

test("a trace the registry rejects terminally is dropped, not retried (#322)", async () => {
  const { ctx, store, logs } = fakeCtx();
  recordPendingTrace(ctx, { marketId: 1n, action: "buy", traceHash: "ab".repeat(32), cid: "ipfs://t" });
  let calls = 0;
  const adapter = {
    agent: "GAGENT",
    publishTrace: async () => {
      calls += 1;
      throw new Error("HostError: Error(Contract, #3050)");
    },
  };
  await publishPendingTraces(adapter as never, ctx);
  const [entry] = [...store.values()] as PendingTrace[];
  assert.equal(entry.status, "rejected");
  assert.equal(entry.rejection, "MarketClosed");
  assert.ok(logs.some(([, e]) => e === "TRACE_REJECTED"));
  // A later tick does not resubmit it.
  await publishPendingTraces(adapter as never, ctx);
  assert.equal(calls, 1);
  assert.equal(TRACES, "traces");
});

test("a transient failure keeps the trace pending and rethrows", async () => {
  const { ctx, store } = fakeCtx();
  recordPendingTrace(ctx, { marketId: 1n, action: "buy", traceHash: "cd".repeat(32), cid: "ipfs://t" });
  const adapter = {
    agent: "GAGENT",
    publishTrace: async () => {
      throw new Error("timeout");
    },
  };
  await assert.rejects(publishPendingTraces(adapter as never, ctx), /timeout/);
  const [entry] = [...store.values()] as PendingTrace[];
  assert.equal(entry.status, "pending");
  assert.equal(entry.attempts, 1);
});
