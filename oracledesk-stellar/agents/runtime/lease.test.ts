import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLease, LeaseHeldError, type LeaseRecord } from "./lease.js";

async function dir(t: test.TestContext) {
  const d = await mkdtemp(join(tmpdir(), "lease-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return join(d, "agent.lock");
}

const opts = { ttlMs: 1_000, heartbeatMs: 60_000, host: "h1", bootTime: () => 0 };

test("FileLease prevents second instance and takes over stale lock", async (t) => {
  const path = await dir(t);
  let clock = 10_000;
  const now = () => clock;
  const alive = new Set<number>([111, 222]);
  const a = new FileLease(path, { ...opts, pid: 111, now, isAlive: (p) => alive.has(p) });
  const b = new FileLease(path, { ...opts, pid: 222, now, isAlive: (p) => alive.has(p) });

  await a.acquire();
  const rec = JSON.parse(await readFile(path, "utf8")) as LeaseRecord;
  assert.equal(rec.pid, 111);
  assert.equal(rec.host, "h1");
  await assert.rejects(b.acquire(), LeaseHeldError);

  // Heartbeat keeps it fresh; past the TTL but with a live owner it is still held.
  clock += 5_000;
  await assert.rejects(b.acquire(), LeaseHeldError);

  // Owner died: stale heartbeat + dead PID on this host => takeover.
  alive.delete(111);
  let lost: string | undefined;
  a.onLost = (r) => (lost = r);
  await b.acquire();
  assert.equal((JSON.parse(await readFile(path, "utf8")) as LeaseRecord).pid, 222);
  // The old holder notices on its next heartbeat and never writes again.
  await a.heartbeat();
  assert.match(lost!, /taken over by pid 222/);
  assert.equal(a.held, false);
  await a.release();
  assert.equal((JSON.parse(await readFile(path, "utf8")) as LeaseRecord).pid, 222, "a's release leaves b's lock alone");
  await b.release();
  await assert.rejects(readFile(path), /ENOENT/);
});

test("FileLease: fresh heartbeat is never taken over, even with a dead PID", async (t) => {
  const path = await dir(t);
  await writeFile(path, JSON.stringify({ pid: 9, host: "h1", startedAt: 9_500, heartbeatAt: 9_900, token: "x" }));
  const b = new FileLease(path, { ...opts, pid: 2, now: () => 10_000, isAlive: () => false });
  await assert.rejects(b.acquire(), LeaseHeldError);
});

test("FileLease: stale lock from another host, or from before the last boot, is taken over", async (t) => {
  const path = await dir(t);
  // Other host: the PID cannot be checked, the stale heartbeat decides.
  await writeFile(path, JSON.stringify({ pid: 9, host: "h2", startedAt: 1, heartbeatAt: 1, token: "x" }));
  const b = new FileLease(path, { ...opts, pid: 2, now: () => 10_000, isAlive: () => true });
  await b.acquire();
  await b.release();

  // Same host, PID "alive" but the lock predates the boot: PID reuse.
  await writeFile(path, JSON.stringify({ pid: 9, host: "h1", startedAt: 100, heartbeatAt: 100, token: "x" }));
  const c = new FileLease(path, { ...opts, pid: 3, now: () => 10_000, isAlive: () => true, bootTime: () => 5_000 });
  await c.acquire();
  await c.release();

  // A torn lock file counts as stale.
  await writeFile(path, '{"pid": 9, "ho');
  const d = new FileLease(path, { ...opts, pid: 4, now: () => 10_000, isAlive: () => true });
  await d.acquire();
  await d.release();
});
