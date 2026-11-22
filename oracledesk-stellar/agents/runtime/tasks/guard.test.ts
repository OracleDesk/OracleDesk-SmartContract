import assert from "node:assert/strict";
import test from "node:test";
import { memoryLogger } from "../log.js";
import { MemoryStateStore } from "../state.js";
import type { TaskContext } from "../runtime.js";
import { guardTask } from "./guard.js";

test("guard trips the kill switch when the treasury drawdown is tripped", async () => {
  const reasons: { code: string; detail: string }[] = [];
  const ctx = {
    signal: new AbortController().signal,
    kill: async (reason: { code: string; detail: string }) => void reasons.push(reason),
    state: new MemoryStateStore(),
    locks: {} as TaskContext["locks"],
    submit: async () => undefined,
    log: memoryLogger(),
    now: () => 1_000,
  } as unknown as TaskContext;
  const task = guardTask(
    {
      adapter: {
        mode: "dry-run",
        drawdownStatus: async () => ({ tripped: true, windowPnl: -20n, maxDrawdown: 10n }),
      },
    },
    { intervalMs: 30_000 },
  );
  await task.run(ctx);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]?.code, "drawdown");
  assert.match(reasons[0]?.detail ?? "", /max drawdown/);
});
