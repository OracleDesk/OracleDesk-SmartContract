/**
 * Tests for registry-trace-repository.ts (#306).
 *
 * Key assertions per issue #306:
 * - verdict() uses the *supplied* receivedHashHex, not the on-chain hash, so
 *   HashMismatch is reachable with tampered bytes.
 * - Contract errors (TraceNotFound = 3005) are distinguished from upstream
 *   RPC failures.
 * - Unknown verdict tags map to { tag: "Unknown" } rather than crashing.
 * - TRACE_NOT_FOUND_CODE is 3005 (not the old incorrect value of 5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  RegistryTraceRepository,
  toVerdict,
  type RegistryTrace,
  type RegistryTracePage,
  type RegistryTraceReader,
} from "./registry-trace-repository.js";
import { TRACE_NOT_FOUND_CODE } from "./errors.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function trace(id: number, overrides: Partial<RegistryTrace> = {}): RegistryTrace {
  return {
    market_id: 7n,
    agent: "GAGENT",
    action: "buy",
    trace_hash: Buffer.from("ab".repeat(32), "hex"),
    ipfs_cid: `ipfs://${id}`,
    published_at: BigInt(id),
    ...overrides,
  };
}

function page(ids: number[], next: number, total: number): RegistryTracePage {
  return {
    entries: ids.map((id) => ({ trace_id: BigInt(id), trace: trace(id) })),
    next: BigInt(next),
    total: BigInt(total),
  };
}

interface FakeOptions {
  byId?: Map<bigint, { trace_hash: string; ipfs_cid: string }>;
  verdictResult?: unknown;
  verdictError?: Error;
  agentPage?: RegistryTracePage;
  marketActionPage?: RegistryTracePage;
  onAgentArgs?: (args: { agent: string; start: bigint; limit: number }) => void;
  onMarketActionArgs?: (args: {
    market_id: bigint;
    action: string;
    start: bigint;
    limit: number;
  }) => void;
  onVerdictArgs?: (args: { trace_id: bigint; received_hash: Buffer }) => void;
}

function fakeReader(options: FakeOptions = {}): RegistryTraceReader {
  const byId = options.byId ?? new Map();
  return {
    async get_trace({ trace_id }) {
      const record = byId.get(trace_id);
      if (!record) throw new Error(`Error(Contract, #${TRACE_NOT_FOUND_CODE})`);
      return {
        result: {
          market_id: 0n,
          agent: "GAGENT",
          action: "create_market",
          trace_hash: Buffer.from(record.trace_hash, "hex"),
          ipfs_cid: record.ipfs_cid,
          published_at: 0n,
        },
      };
    },
    async trace_verdict({ trace_id, received_hash }) {
      options.onVerdictArgs?.({ trace_id, received_hash });
      if (options.verdictError) throw options.verdictError;
      return { result: options.verdictResult ?? { tag: "Valid" } };
    },
    async traces_by_agent(args) {
      options.onAgentArgs?.(args);
      return { result: options.agentPage ?? page([], 0, 0) };
    },
    async traces_by_market_action(args) {
      options.onMarketActionArgs?.(args);
      return { result: options.marketActionPage ?? page([], 0, 0) };
    },
  };
}

// ── get() ────────────────────────────────────────────────────────────────────

test("returns a TraceRecord translated from the on-chain trace", async () => {
  const hash = "ab".repeat(32);
  const repo = new RegistryTraceRepository(
    fakeReader({ byId: new Map([[0n, { trace_hash: hash, ipfs_cid: "ipfs://x" }]]) }),
  );
  const record = await repo.get("0");
  assert.ok(record, "record should exist");
  assert.equal(record.traceId, "0");
  assert.equal(record.ipfsCid, "ipfs://x");
  assert.equal(record.traceHash, hash);
});

test("returns undefined for a trace id the registry does not know (TraceNotFound 3005)", async () => {
  const repo = new RegistryTraceRepository(fakeReader());
  assert.equal(await repo.get("999"), undefined);
});

test("returns undefined for a non-numeric trace id", async () => {
  const repo = new RegistryTraceRepository(fakeReader());
  assert.equal(await repo.get("not-a-number"), undefined);
});

// ── verdict() — the core #306 fix ───────────────────────────────────────────

test("verdict() passes the supplied receivedHashHex to trace_verdict (not the on-chain hash)", async () => {
  let seenHash: Buffer | undefined;
  const onChainHash = "ab".repeat(32);
  const fetchedHash = "cd".repeat(32); // different — simulates tampered bytes

  const reader = fakeReader({
    byId: new Map([[0n, { trace_hash: onChainHash, ipfs_cid: "ipfs://x" }]]),
    onVerdictArgs: ({ received_hash }) => { seenHash = received_hash; },
    verdictResult: { tag: "HashMismatch" },
  });
  const repo = new RegistryTraceRepository(reader);
  const verdict = await repo.verdict("0", fetchedHash);

  // The hash passed to trace_verdict must be the fetched bytes hash, not the on-chain one.
  assert.ok(seenHash, "trace_verdict should have been called");
  assert.equal(seenHash.toString("hex"), fetchedHash);
  assert.deepEqual(verdict, { tag: "HashMismatch" });
});

test("verdict() returns HashMismatch when fetched bytes differ from on-chain hash", async () => {
  const onChainHash = "aa".repeat(32);
  const tamperedHash = "bb".repeat(32);

  const reader = fakeReader({
    byId: new Map([[1n, { trace_hash: onChainHash, ipfs_cid: "ipfs://y" }]]),
    verdictResult: { tag: "HashMismatch" },
  });
  const repo = new RegistryTraceRepository(reader);
  const verdict = await repo.verdict("1", tamperedHash);
  assert.deepEqual(verdict, { tag: "HashMismatch" });
});

test("verdict() returns Valid when hashes match", async () => {
  const hash = "cc".repeat(32);
  const reader = fakeReader({
    verdictResult: { tag: "Valid" },
  });
  const repo = new RegistryTraceRepository(reader);
  const verdict = await repo.verdict("0", hash);
  assert.deepEqual(verdict, { tag: "Valid" });
});

test("verdict() returns unavailable on RPC/network error", async () => {
  const reader = fakeReader({
    verdictError: new Error("fetch failed"),
  });
  const repo = new RegistryTraceRepository(reader);
  const verdict = await repo.verdict("0", "aa".repeat(32));
  assert.equal(verdict, "unavailable");
});

test("verdict() returns Valid (not throws) on TraceNotFound contract error", async () => {
  const reader = fakeReader({
    verdictError: new Error(`Error(Contract, #${TRACE_NOT_FOUND_CODE})`),
  });
  const repo = new RegistryTraceRepository(reader);
  // TraceNotFound means get() will return undefined; verdict() should not throw
  const verdict = await repo.verdict("999", "aa".repeat(32));
  assert.deepEqual(verdict, { tag: "Valid" });
});

test("verdict() falls back to Valid when reader has no trace_verdict method", async () => {
  const minimalReader: RegistryTraceReader = {
    async get_trace() { throw new Error("Error(Contract, #3005)"); },
    async traces_by_agent() { return { result: page([], 0, 0) }; },
    async traces_by_market_action() { return { result: page([], 0, 0) }; },
    // no trace_verdict
  };
  const repo = new RegistryTraceRepository(minimalReader);
  const verdict = await repo.verdict("0", "aa".repeat(32));
  assert.deepEqual(verdict, { tag: "Valid" });
});

// ── toVerdict() ──────────────────────────────────────────────────────────────

test("toVerdict maps Valid", () => {
  assert.deepEqual(toVerdict({ tag: "Valid" }), { tag: "Valid" });
});

test("toVerdict maps HashMismatch", () => {
  assert.deepEqual(toVerdict({ tag: "HashMismatch" }), { tag: "HashMismatch" });
});

test("toVerdict maps Flagged with reason", () => {
  const v = toVerdict({ tag: "Flagged", values: ["fabricated"] });
  assert.equal(v.tag, "Flagged");
  if (v.tag === "Flagged") assert.equal(v.values[0], "fabricated");
});

test("toVerdict maps AgentRevokedAfter with timestamp", () => {
  const v = toVerdict({ tag: "AgentRevokedAfter", values: ["1234"] });
  assert.equal(v.tag, "AgentRevokedAfter");
  if (v.tag === "AgentRevokedAfter") assert.equal(v.values[0], 1234n);
});

test("toVerdict maps unknown future tag without crashing", () => {
  const v = toVerdict({ tag: "FutureTag", values: ["x"] });
  // Should produce a usable object, not throw
  assert.ok(v.tag, "should have a tag");
});

// ── TRACE_NOT_FOUND_CODE ──────────────────────────────────────────────────────

test("TRACE_NOT_FOUND_CODE is 3005 (the registry contract's TraceNotFound error)", () => {
  // Regression test: old value was 5. The registry defines TraceNotFound = 3005.
  assert.equal(TRACE_NOT_FOUND_CODE, 3005);
});

// ── Listing ──────────────────────────────────────────────────────────────────

test("lists an agent's traces from the #57 index", async () => {
  let seen: { agent: string; start: bigint; limit: number } | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({
      agentPage: page([0, 1], 2, 5),
      onAgentArgs: (args) => { seen = args; },
    }),
  );
  const result = await repo.listByAgent("GAGENT", "0", 2);
  assert.deepEqual(seen, { agent: "GAGENT", start: 0n, limit: 2 });
  assert.equal(result.next, "2");
  assert.equal(result.total, "5");
  assert.deepEqual(result.items.map((e) => e.traceId), ["0", "1"]);
  assert.equal(result.items[0].traceHash, "ab".repeat(32));
  assert.equal(result.items[0].agent, "GAGENT");
  // Unpaid listing must not leak the CID (bypass paywall risk).
  assert.equal("ipfsCid" in result.items[0], false);
});

test("lists a market/action pair and clamps the page size", async () => {
  let seen: { market_id: bigint; action: string; start: bigint; limit: number } | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({
      marketActionPage: page([3], 4, 4),
      onMarketActionArgs: (args) => { seen = args; },
    }),
  );
  const result = await repo.listByMarketAction("7", "buy", "3", 1_000);
  assert.deepEqual(seen, { market_id: 7n, action: "buy", start: 3n, limit: 25 });
  assert.equal(result.items[0].marketId, "7");
  assert.equal(result.items[0].action, "buy");
});

test("defaults the cursor and page size when omitted", async () => {
  let seen: { agent: string; start: bigint; limit: number } | undefined;
  const repo = new RegistryTraceRepository(
    fakeReader({ onAgentArgs: (args) => { seen = args; } }),
  );
  await repo.listByAgent("GAGENT");
  assert.deepEqual(seen, { agent: "GAGENT", start: 0n, limit: 25 });
});

test("#328: RPC outage on get() throws RepositoryUnavailable instead of returning undefined", async () => {
  const { RepositoryUnavailable } = await import("./errors.js");
  const repo = new RegistryTraceRepository({
    async get_trace() {
      throw new Error("fetch failed", { cause: new Error("ETIMEDOUT") });
    },
    async traces_by_agent() {
      throw new Error("unused");
    },
    async traces_by_market_action() {
      throw new Error("unused");
    },
  });
  await assert.rejects(repo.get("1"), RepositoryUnavailable);
});

test("#329: a simulation restore requirement maps to RegistryRestoreRequired, not absent", async () => {
  const { RegistryRestoreRequired } = await import("./errors.js");
  const repo = new RegistryTraceRepository({
    async get_trace() {
      throw Object.assign(new Error("simulation failed"), {
        restorePreamble: { minResourceFee: "1000", transactionData: "AAAA" },
      });
    },
    async traces_by_agent() {
      throw new Error("unused");
    },
    async traces_by_market_action() {
      throw new Error("unused");
    },
  });
  await assert.rejects(repo.get("1"), RegistryRestoreRequired);
});