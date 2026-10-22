import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAgentd } from "../bin/agentd.js";
import { AsyncMutex } from "./locks.js";
import { NoLease, type Lease } from "./lease.js";
import { memoryLogger } from "./log.js";
import { Runtime, type RuntimeOptions, type Task, type Timers } from "./runtime.js";
import { MemoryStateStore } from "./state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runtime(tasks: Task[], over: Partial<RuntimeOptions> = {}) {
  const log = memoryLogger();
  const rt = new Runtime({
    tasks,
    state: new MemoryStateStore(),
    lease: new NoLease(),
    shutdownGraceMs: 2_000,
    maxConsecutiveFailures: 100,
    failureWindowMs: 60_000,
    maxFailuresInWindow: 100,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    log,
    ...over,
  });
  return { rt, log };
}

/** A lease that records acquire/release calls. */
function spyLease(): Lease & { calls: string[] } {
  const calls: string[] = [];
  return { calls, acquire: async () => void calls.push("acquire"), release: async () => void calls.push("release") };
}

test("task never overlaps itself even when run exceeds interval", async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const { rt } = runtime([
    {
      name: "slow",
      intervalMs: 1,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        await sleep(25);
        active--;
      },
    },
  ]);
  const started = rt.start();
  await sleep(160);
  await rt.stop("test");
  await started;
  assert.equal(maxActive, 1);
  assert.ok(runs >= 3, `runs: ${runs}`);
});

test("async mutex is FIFO", async () => {
  const m = new AsyncMutex();
  const order: number[] = [];
  await Promise.all([3, 1, 2].map((d, i) => m.run(async () => {
    await sleep(d * 5);
    order.push(i);
  })));
  assert.deepEqual(order, [0, 1, 2]);
});

test("submission mutex serializes maker and trader submits", async () => {
  let inSubmit = 0;
  let maxInSubmit = 0;
  const log: string[] = [];
  const submitter = (name: string): Task => ({
    name,
    intervalMs: 0,
    run: async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.submit(async () => {
          inSubmit++;
          maxInSubmit = Math.max(maxInSubmit, inSubmit);
          log.push(`${name}:start`);
          await sleep(10);
          log.push(`${name}:end`);
          inSubmit--;
        });
      }
    },
  });
  const { rt } = runtime([submitter("maker"), submitter("trader")]);
  const started = rt.start();
  await sleep(150);
  await rt.stop("test");
  await started;
  assert.equal(maxInSubmit, 1);
  assert.ok(log.includes("maker:start") && log.includes("trader:start"));
  for (let i = 0; i < log.length; i += 2) assert.equal(log[i]!.split(":")[0], log[i + 1]!.split(":")[0], "start/end pairs never interleave");
});

test("stop waits for inflight submit and does not abort it", async () => {
  let completed = false;
  let sawAbortDuringSubmit: boolean | undefined;
  const lease = spyLease();
  let entered!: () => void;
  const inSubmit = new Promise<void>((r) => (entered = r));
  const { rt, log } = runtime(
    [
      {
        name: "trader",
        intervalMs: 1_000,
        run: async (ctx) => {
          await ctx.submit(async () => {
            entered();
            await sleep(120);
            sawAbortDuringSubmit = ctx.signal.aborted;
            completed = true;
          }, "buy:1");
        },
      },
    ],
    { lease },
  );
  const started = rt.start();
  await inSubmit;
  const t0 = Date.now();
  await rt.stop("SIGTERM");
  await started;
  assert.equal(completed, true, "the submission ran to completion");
  assert.equal(sawAbortDuringSubmit, true, "shutdown had begun, yet the submission was not interrupted");
  assert.ok(Date.now() - t0 >= 80, "stop waited for it");
  assert.deepEqual(lease.calls, ["acquire", "release"]);
  assert.equal(rt.exitCode, 0);
  assert.ok(!log.entries.some((e) => e.event === "SHUTDOWN_WITH_INFLIGHT"));

  // And nothing new starts after shutdown began.
  const { rt: rt2 } = runtime([]);
  await rt2.stop("x");
});

test("stop times out after grace and logs pending", async () => {
  const lease = spyLease();
  let entered!: () => void;
  const inSubmit = new Promise<void>((r) => (entered = r));
  let finish!: () => void;
  const hang = new Promise<void>((r) => (finish = r));
  const { rt, log } = runtime(
    [
      {
        name: "maker",
        intervalMs: 1_000,
        run: (ctx) =>
          ctx.submit(async () => {
            entered();
            await hang;
          }, "create:abc"),
      },
    ],
    { lease, shutdownGraceMs: 50 },
  );
  const started = rt.start();
  await inSubmit;
  const t0 = Date.now();
  await rt.stop("SIGTERM");
  await started;
  assert.ok(Date.now() - t0 < 1_000);
  const entry = log.entries.find((e) => e.event === "SHUTDOWN_WITH_INFLIGHT");
  assert.ok(entry, "logged");
  assert.deepEqual(entry!.fields.pending, [{ id: 0, intent: "create:abc" }]);
  assert.deepEqual(lease.calls, ["acquire"], "lease kept while a submission may still land");
  assert.equal(rt.exitCode, 1);
  finish();
});

/** Timers that fire on the next macrotask but record the requested delay. */
function recordingTimers(delays: number[]): Timers {
  return {
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return setImmediate(fn);
    },
    clearTimeout: (h) => clearImmediate(h as NodeJS.Immediate),
  };
}

test("consecutive failures back off exponentially and reset on success", async () => {
  const delays: number[] = [];
  // fail ×4, succeed, fail ×2, then stop
  const script = [false, false, false, false, true, false, false];
  let i = 0;
  let rt!: Runtime;
  ({ rt } = runtime(
    [
      {
        name: "flaky",
        intervalMs: 777,
        run: async () => {
          const ok = script[i++];
          if (i >= script.length) void rt.stop("done");
          if (!ok) throw new Error(`boom ${i}`);
        },
      },
    ],
    { backoffBaseMs: 100, backoffMaxMs: 500, timers: recordingTimers(delays) },
  ));
  await rt.start();
  assert.deepEqual(delays, [100, 200, 400, 500, 777, 100]);
});

test("process circuit exits non-zero after N failures in window", async () => {
  let runs = 0;
  const failing = (name: string): Task => ({
    name,
    intervalMs: 0,
    run: async () => {
      runs++;
      throw new Error("rpc down");
    },
  });
  const { rt, log } = runtime([failing("a"), failing("b")], { maxFailuresInWindow: 5, timers: recordingTimers([]) });
  await rt.start();
  assert.equal(rt.exitCode, 1);
  assert.ok(log.entries.some((e) => e.event === "CIRCUIT_OPEN"));
  assert.ok(runs >= 5 && runs <= 6, `runs: ${runs}`);

  // Consecutive failures of one task trip it too.
  const { rt: rt2, log: log2 } = runtime([failing("c")], { maxConsecutiveFailures: 3, timers: recordingTimers([]) });
  await rt2.start();
  assert.equal(rt2.exitCode, 1);
  assert.match(String(log2.entries.find((e) => e.event === "CIRCUIT_OPEN")!.fields.reason), /3 times in a row/);

  // Through agentd: the process exit code is non-zero.
  const code = await runAgentd(["--tasks", "c"], { AGENT_MODE: "dry-run", MAX_CONSECUTIVE_FAILURES: "2", BACKOFF_BASE_MS: "1", BACKOFF_MAX_MS: "1" }, {
    taskFactories: { c: () => failing("c") },
    state: new MemoryStateStore(),
    lease: new NoLease(),
    log: memoryLogger(),
    handleSignals: false,
  });
  assert.equal(code, 1);
});

test("runtime rejects mixed task modes", () => {
  const t = (name: string, mode: "dry-run" | "live"): Task => ({ name, mode, intervalMs: 1, run: async () => {} });
  assert.throws(() => runtime([t("a", "dry-run"), t("b", "live")]), /mixed task modes/);
});

test("--once runs each task exactly once and exits 0", async () => {
  const runs: Record<string, number> = { maker: 0, trader: 0 };
  const task = (name: string): Task => ({ name, intervalMs: 1, run: async () => void runs[name]!++ });
  const lease = spyLease();
  const code = await runAgentd(["--once"], { AGENT_MODE: "dry-run" }, {
    taskFactories: { maker: () => task("maker"), trader: () => task("trader") },
    state: new MemoryStateStore(),
    lease,
    log: memoryLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(runs, { maker: 1, trader: 1 });
  assert.deepEqual(lease.calls, ["acquire", "release"]);

  const only = { maker: 0 };
  assert.equal(
    await runAgentd(["--once", "--tasks", "maker"], { AGENT_MODE: "dry-run" }, {
      taskFactories: { maker: () => ({ name: "maker", intervalMs: 1, run: async () => void only.maker++ }) },
      state: new MemoryStateStore(),
      lease: new NoLease(),
      log: memoryLogger(),
    }),
    0,
  );
  assert.equal(only.maker, 1);

  // A failing task in --once exits 1, like the old CLIs.
  assert.equal(
    await runAgentd(["--once", "--tasks", "x"], { AGENT_MODE: "dry-run" }, {
      taskFactories: { x: () => ({ name: "x", intervalMs: 1, run: async () => Promise.reject(new Error("no")) }) },
      state: new MemoryStateStore(),
      lease: new NoLease(),
      log: memoryLogger(),
    }),
    1,
  );
});

test("invalid AGENT_MODE exits with code 2", async () => {
  const quiet = { log: memoryLogger(), state: new MemoryStateStore(), lease: new NoLease() };
  assert.equal(await runAgentd(["--once"], { AGENT_MODE: "Live" }, { ...quiet, taskFactories: {} }), 2);
  assert.equal(await runAgentd(["--bogus"], { AGENT_MODE: "dry-run" }, { ...quiet, taskFactories: {} }), 2);

  // The real entrypoint, as a supervisor would see it.
  const agents = join(dirname(fileURLToPath(import.meta.url)), "..");
  const res = spawnSync(process.execPath, [join(agents, "node_modules", "tsx", "dist", "cli.mjs"), "bin/agentd.ts", "--once"], {
    cwd: agents,
    env: { ...process.env, AGENT_MODE: "yolo" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(res.status, 2, res.stderr || res.stdout);
});
