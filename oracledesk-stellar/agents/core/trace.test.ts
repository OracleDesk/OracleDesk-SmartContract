import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrace,
  canonicalize,
  commitmentFor,
  fromTraceAction,
  hashTrace,
  newSalt,
  NO_MARKET,
  toTraceAction,
  type TraceActionType,
} from "./trace.js";

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

// ─── Commit-reveal (#51) ─────────────────────────────────────────────────────


test("commitmentFor matches the Rust golden vector", () => {
  // Same vector as commitment_vector_matches_typescript in
  // contracts/reasoning-registry/src/lib.rs: hash = 0x07 * 32, salt = 0x09 * 32.
  assert.equal(
    commitmentFor("07".repeat(32), "09".repeat(32)),
    "50a630b83f3b4e9c444265cc6af2a094bff7e3848a334f0167fb549d6ca7ee52",
  );
  assert.equal(
    commitmentFor(`0x${"07".repeat(32)}`, "09".repeat(32).toUpperCase()),
    "50a630b83f3b4e9c444265cc6af2a094bff7e3848a334f0167fb549d6ca7ee52",
  );
});

test("commitmentFor rejects inputs that are not 32 bytes", () => {
  assert.throws(() => commitmentFor("07", "09".repeat(32)), /trace hash/);
  assert.throws(() => commitmentFor("07".repeat(32), "abc"), /salt/);
});

test("newSalt returns 32 random bytes as hex", () => {
  const a = newSalt();
  const b = newSalt();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

// ─── TraceAction mapping (#55) ───────────────────────────────────────────────

test("toTraceAction and fromTraceAction cover all canonical variants", () => {
  const canonical: Array<{ str: string; obj: TraceActionType }> = [
    { str: "create_market", obj: { tag: "CreateMarket" } },
    { str: "propose_market", obj: { tag: "ProposeMarket" } },
    { str: "buy", obj: { tag: "Buy" } },
    { str: "sell", obj: { tag: "Sell" } },
    { str: "skip", obj: { tag: "Skip" } },
    { str: "redeem", obj: { tag: "Redeem" } },
    { str: "claim_remainder", obj: { tag: "ClaimRemainder" } },
    { str: "resolve", obj: { tag: "Resolve" } },
  ];

  for (const { str, obj } of canonical) {
    assert.deepEqual(toTraceAction(str), obj);
    assert.equal(fromTraceAction(obj), str);
  }
});

test("toTraceAction and fromTraceAction support Other variant", () => {
  const custom = toTraceAction("other:custom_hook");
  assert.deepEqual(custom, { tag: "Other", values: ["custom_hook"] });
  assert.equal(fromTraceAction(custom), "other:custom_hook");

  const bareCustom = toTraceAction("arbitrary_action");
  assert.deepEqual(bareCustom, { tag: "Other", values: ["arbitrary_action"] });
  assert.equal(fromTraceAction(bareCustom), "other:arbitrary_action");
});

test("NO_MARKET constant is u64::MAX", () => {
  assert.equal(NO_MARKET, 18446744073709551615n);
  assert.equal(NO_MARKET, (1n << 64n) - 1n);
});

// ── #322 action/state validation ─────────────────────────────────────────

import { terminalTraceError, validateActionState, type MarketStateView } from "./trace.js";

const open: MarketStateView = { status: "Open", closeTime: 1_000n, creator: "GAGENT" };

test("validateActionState mirrors the registry table", () => {
  assert.deepEqual(validateActionState("buy", 1n, open, 999n), { ok: true, late: false });
  assert.deepEqual(validateActionState("sell", 1n, open, 1_000n), { ok: true, late: true });
  assert.deepEqual(validateActionState("buy", 1n, open, 1_000n + 3_600n), { ok: false, error: "MarketClosed" });
  assert.deepEqual(validateActionState("buy", 1n, { ...open, status: "Void" }, 10n), { ok: false, error: "MarketClosed" });
  assert.deepEqual(validateActionState("redeem", 1n, open, 2_000n), { ok: false, error: "MarketNotFinal" });
  assert.deepEqual(validateActionState("redeem", 1n, { ...open, status: "Void" }, 2_000n), { ok: true, late: false });
  assert.deepEqual(validateActionState("resolve", 1n, open, 999n), { ok: false, error: "MarketNotClosed" });
  assert.deepEqual(validateActionState("resolve", 1n, open, 1_000n), { ok: true, late: false });
  assert.deepEqual(validateActionState("skip", 1n, { ...open, status: "Resolved" }, 9_999n), { ok: true, late: false });
  assert.deepEqual(validateActionState("propose_market", NO_MARKET, undefined, 0n), { ok: true, late: false });
  assert.deepEqual(validateActionState("propose_market", 1n, open, 0n), { ok: false, error: "ProposalMustUseNoMarket" });
  assert.deepEqual(validateActionState("buy", NO_MARKET, undefined, 0n), { ok: false, error: "MarketRequired" });
  assert.deepEqual(validateActionState("buy", 7n, undefined, 0n), { ok: false, error: "UnknownMarket" });
});

test("validateActionState checks the creator rule for create_market", () => {
  assert.deepEqual(validateActionState("create_market", 1n, open, 0n, 3_600n, { agent: "GAGENT" }), { ok: true, late: false });
  assert.deepEqual(
    validateActionState("create_market", 1n, { ...open, creator: "CTREASURY" }, 0n, 3_600n, { agent: "GAGENT" }),
    { ok: false, error: "NotMarketCreator" },
  );
  assert.deepEqual(
    validateActionState("create_market", 1n, { ...open, creator: "CTREASURY" }, 0n, 3_600n, {
      agent: "GAGENT",
      consumers: ["CTREASURY"],
    }),
    { ok: true, late: false },
  );
  assert.deepEqual(validateActionState("create_market", 1n, open, 1_001n), { ok: false, error: "MarketClosed" });
});

test("terminalTraceError recognises registry codes and names", () => {
  assert.equal(terminalTraceError(new Error("HostError: Error(Contract, #3050)")), "MarketClosed");
  assert.equal(terminalTraceError("simulation failed: NotResolutionSigner"), "NotResolutionSigner");
  assert.equal(terminalTraceError(new Error("Error(Contract, #3001)")), undefined);
  assert.equal(terminalTraceError(new Error("timeout")), undefined);
});
