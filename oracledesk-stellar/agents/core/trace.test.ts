import assert from "node:assert/strict";
import test from "node:test";
import { buildTrace, canonicalize, hashTrace } from "./trace.js";

test("canonicalize sorts object keys regardless of insertion order", () => {
  const a = canonicalize({ b: 1, a: 2 });
  const b = canonicalize({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test("canonicalize sorts nested object keys too", () => {
  const a = canonicalize({ outer: { z: 1, y: 2 } });
  const b = canonicalize({ outer: { y: 2, z: 1 } });
  assert.equal(a, b);
});

test("canonicalize preserves array order", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("canonicalize serializes bigint as a string rather than throwing", () => {
  assert.equal(canonicalize({ amount: 1_500_000_000n }), '{"amount":"1500000000"}');
});

test("hashTrace is deterministic for equivalent traces", () => {
  const base = {
    agent: "trader" as const,
    marketId: 1,
    action: "buy",
    reasoning: "mispricing detected",
    inputs: { fairValueBps: 6200, marketBps: 5400 },
  };
  const h1 = hashTrace({ ...base, timestamp: 1000 });
  const h2 = hashTrace({ ...base, timestamp: 1000 });
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test("hashTrace changes when any field changes", () => {
  const base = {
    agent: "trader" as const,
    marketId: 1,
    action: "buy",
    reasoning: "mispricing detected",
    inputs: { fairValueBps: 6200 },
    timestamp: 1000,
  };
  const changed = { ...base, inputs: { fairValueBps: 6201 } };
  assert.notEqual(hashTrace(base), hashTrace(changed));
});

test("buildTrace's hash matches hashTrace on its own output", () => {
  const built = buildTrace({
    agent: "market-maker",
    marketId: null,
    action: "propose_market",
    reasoning: "new signal detected",
    inputs: {},
    timestamp: 42,
  });
  assert.equal(built.hash, hashTrace(built.trace));
  assert.equal(JSON.parse(built.json).timestamp, 42);
});

test("buildTrace defaults timestamp to now when omitted", () => {
  const before = Math.floor(Date.now() / 1000);
  const built = buildTrace({
    agent: "trader",
    marketId: 1,
    action: "buy",
    reasoning: "test",
    inputs: {},
  });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(built.trace.timestamp >= before && built.trace.timestamp <= after);
});
