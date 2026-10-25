import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentScheduler, DaemonStateStore, startHealthServer } from "./scheduler.js";

test("AgentScheduler persists ledger checkpoints and deduplicates processedEventIds across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-"));
  const statePath = join(dir, "state.json");
  let now = 1_750_000_000_000;

  const scheduler1 = new AgentScheduler(
    new DaemonStateStore(statePath),
    { intervalMs: 1000, maxConsecutiveFailures: 3, circuitCooldownMs: 30_000 },
    () => now,
  );

  const r1 = await scheduler1.runSingleTick(async () => ({
    latestLedger: 550,
    newEventIds: ["evt-1", "evt-2"],
  }));
  assert.equal(r1.executed, true);

  // Restart with a new scheduler instance backed by the same state file
  const scheduler2 = new AgentScheduler(
    new DaemonStateStore(statePath),
    { intervalMs: 1000, maxConsecutiveFailures: 3, circuitCooldownMs: 30_000 },
    () => now,
  );
  assert.equal(scheduler2.currentState().lastCompletedCycle, 1);
  assert.equal(scheduler2.currentState().lastProcessedLedger, 550);
  assert.deepEqual(scheduler2.currentState().processedEventIds, ["evt-1", "evt-2"]);
});

test("AgentScheduler trips circuit breaker after N failures and /readyz reports 503 until cooldown expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-cb-"));
  const statePath = join(dir, "state.json");
  let now = 1_750_000_000_000;

  const scheduler = new AgentScheduler(
    new DaemonStateStore(statePath),
    { intervalMs: 1000, maxConsecutiveFailures: 2, circuitCooldownMs: 10_000 },
    () => now,
  );

  await scheduler.runSingleTick(async () => {
    throw new Error("rpc down 1");
  });
  assert.equal(scheduler.isHealthy(now), true);

  await scheduler.runSingleTick(async () => {
    throw new Error("rpc down 2");
  });
  assert.equal(scheduler.isHealthy(now), false);

  const health = await startHealthServer(scheduler, 0);
  try {
    const resp503 = await fetch(`http://127.0.0.1:${health.port}/readyz`);
    assert.equal(resp503.status, 503);

    // Advance clock past cooldown and run a healthy tick
    now += 15_000;
    const recovered = await scheduler.runSingleTick(async () => ({ latestLedger: 600 }));
    assert.equal(recovered.executed, true);

    const resp200 = await fetch(`http://127.0.0.1:${health.port}/healthz`);
    assert.equal(resp200.status, 200);
  } finally {
    await health.close();
  }
});
