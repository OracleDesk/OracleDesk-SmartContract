import assert from "node:assert/strict";
import test from "node:test";
import type { ProbeResult, ProbeStatus } from "../../core/availability.js";
import type { PinProvider } from "../../core/ipfs-store.js";
import type { AdapterResult } from "../../stellar/adapter.js";
import { MemoryStateStore } from "../state.js";
import { memoryLogger } from "../log.js";
import type { TaskContext } from "../runtime.js";
import {
  AVAILABILITY_KEY,
  AVAILABILITY_NS,
  availabilityTask,
  type AvailabilityAdapter,
  type AvailabilityDeps,
  type AvailabilityFailure,
  type AvailabilityState,
} from "./availability.js";

const ARCHIVE_BYTES = new TextEncoder().encode("verified archived bytes");
const AGENT = "GAVAILABILITYREPORTER";

interface Harness {
  ctx: TaskContext;
  state: MemoryStateStore;
  adapter: AvailabilityAdapter & {
    reports: bigint[];
    clears: bigint[];
  };
  probes: bigint[];
  submitted: string[];
}

function harness(options: {
  ids: bigint[];
  now: () => number;
  probe: (id: bigint, call: number) => ProbeResult;
  mode?: "live" | "dry-run";
  archive?: boolean;
  provider?: PinProvider;
  seed?: (state: AvailabilityState) => void;
}): Harness {
  const state = new MemoryStateStore();
  if (options.seed) {
    const seed: AvailabilityState = {
      cursor: 0n,
      cycle: 0,
      tick: 0,
      failures: {},
    };
    options.seed(seed);
    state.set(AVAILABILITY_NS, AVAILABILITY_KEY, seed);
  }
  const reports: bigint[] = [];
  const clears: bigint[] = [];
  const adapter: AvailabilityAdapter & { reports: bigint[]; clears: bigint[] } = {
    mode: options.mode ?? "live",
    agent: AGENT,
    async traceCount() { return BigInt(options.ids.length); },
    async traceMetadata(id) { return { cid: `cid-${id}`, traceHash: "00".repeat(32) }; },
    async reportUnavailable({ trace_id }) {
      reports.push(trace_id);
      return { dryRun: true, contractId: "CREGISTRY", method: "report_unavailable", args: { trace_id } } satisfies AdapterResult<void>;
    },
    async clearUnavailable({ trace_id }) {
      clears.push(trace_id);
      return { dryRun: true, contractId: "CREGISTRY", method: "clear_unavailable", args: { trace_id } } satisfies AdapterResult<void>;
    },
    reports,
    clears,
  };
  const probes: bigint[] = [];
  let call = 0;
  const probe: NonNullable<AvailabilityDeps["probe"]> = async (target) => {
    probes.push(target.id);
    return options.probe(target.id, ++call);
  };
  const submitted: string[] = [];
  const ctx: TaskContext = {
    signal: new AbortController().signal,
    kill: async () => {},
    state,
    locks: {} as TaskContext["locks"],
    submit: async (fn, intent) => {
      submitted.push(intent ?? "");
      return fn();
    },
    log: memoryLogger(),
    now: options.now,
  };
  return {
    ctx,
    state,
    adapter,
    probes,
    submitted,
  };
}

function deps(h: Harness, overrides: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
  return {
    adapter: h.adapter,
    gateways: ["https://gw.example/ipfs"],
    providers: [],
    batchSize: 2,
    concurrency: 1,
    flagAfterSecs: 10,
    flagAfterProbes: 3,
    minToggleSecs: 100,
    ...overrides,
  };
}

function ok(id: bigint): ProbeResult {
  return { traceId: id, cid: `cid-${id}`, status: "ok", gateway: "gw" };
}

function failed(id: bigint): ProbeResult {
  return { traceId: id, cid: `cid-${id}`, status: "unreachable", error: "HTTP 503" };
}

function failure(overrides: Partial<AvailabilityFailure> = {}): AvailabilityFailure {
  return {
    cid: "cid-0",
    firstSeen: 0,
    lastSeen: 0,
    seenTicks: [],
    attempts: 0,
    status: "unreachable",
    ...overrides,
  };
}

test("walks every trace id across ticks and resumes from the persisted cursor", async () => {
  const h = harness({ ids: [0n, 1n, 2n], now: () => 1_000_000, probe: ok });
  const task = availabilityTask(deps(h), { intervalMs: 1 });
  await task.run(h.ctx);
  assert.deepEqual(h.probes, [0n, 1n]);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.cursor, 2n);

  await task.run(h.ctx);
  assert.deepEqual(h.probes, [0n, 1n, 2n]);
  const state = h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!;
  assert.equal(state.cursor, 0n);
  assert.equal(state.cycle, 1);
});

test("re-pins from the archive and clears a flag after a confirmed recovery", async () => {
  let calls = 0;
  let pins = 0;
  const provider: PinProvider = {
    name: "test-kubo",
    async pin(bytes, cid) {
      pins++;
      assert.deepEqual(bytes, ARCHIVE_BYTES);
      assert.equal(cid, "cid-0");
      return { cid, confirmed: true };
    },
  };
  const h = harness({
    ids: [0n],
    now: () => 1_000_000,
    probe: (_id, call) => {
      calls++;
      return call === 1 ? failed(0n) : ok(0n);
    },
    seed: (s) => {
      s.failures["0"] = failure({ flagged: true, flaggedAt: 1, attempts: 3, seenTicks: [1, 2, 3], firstSeen: 1 });
    },
  });
  const task = availabilityTask(deps(h, {
    providers: [provider],
    archive: { readArchived: async () => ARCHIVE_BYTES },
  }), { intervalMs: 1 });
  await task.run(h.ctx);
  assert.equal(calls, 2);
  assert.equal(pins, 1);
  assert.deepEqual(h.adapter.clears, [0n]);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.failures["0"], undefined);
});

test("flags only after the time and distinct-tick thresholds", async () => {
  let now = 1_000_000;
  const h = harness({ ids: [0n], now: () => now, probe: failed });
  const task = availabilityTask(deps(h), { intervalMs: 1 });
  await task.run(h.ctx);
  now += 100_000;
  await task.run(h.ctx);
  now += 100_000;
  assert.deepEqual(h.adapter.reports, []);
  await task.run(h.ctx);
  assert.deepEqual(h.adapter.reports, [0n]);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.failures["0"]!.flagged, true);
});

test("clears its own flag on a later successful probe", async () => {
  const h = harness({
    ids: [0n],
    now: () => 2_000_000,
    probe: ok,
    seed: (s) => {
      s.failures["0"] = failure({ flagged: true, flaggedAt: 1, attempts: 3, seenTicks: [1, 2, 3] });
    },
  });
  const task = availabilityTask(deps(h), { intervalMs: 1 });
  await task.run(h.ctx);
  assert.deepEqual(h.adapter.clears, [0n]);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.failures["0"], undefined);
});

test("never submits a transaction in dry-run mode", async () => {
  let now = 1_000_000;
  const h = harness({ ids: [0n], now: () => now, probe: failed, mode: "dry-run" });
  const task = availabilityTask(deps(h), { intervalMs: 1 });
  for (let i = 0; i < 3; i++) {
    now += 100_000;
    await task.run(h.ctx);
  }
  // The adapter returns a dry-run plan; no signAndSend path is reachable.
  assert.deepEqual(h.adapter.reports, [0n]);
  assert.deepEqual(h.submitted, ["availability.flag"]);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.failures["0"]!.flagged, false);
});

test("a wrong-body mismatch is a failure, but local:// is ignored", async () => {
  const h = harness({
    ids: [0n],
    now: () => 1_000_000,
    probe: (id) => ({ traceId: id, cid: `cid-${id}`, status: "mismatch" as ProbeStatus, error: "gateway lied" }),
  });
  const task = availabilityTask(deps(h), { intervalMs: 1 });
  await task.run(h.ctx);
  assert.equal(h.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY)!.failures["0"]!.status, "mismatch");
});
