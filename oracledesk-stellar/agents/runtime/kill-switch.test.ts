import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgentd } from "../bin/agentd.js";
import { KillSwitch } from "./kill-switch.js";
import { memoryLogger } from "./log.js";
import { MemoryStateStore } from "./state.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-kill-"));
}

test("kill reason survives a restart and rearm removes the marker", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "KILLED");
    const statePath = join(dir, "state.json");
    const log = memoryLogger();
    const reason = { code: "operator" as const, detail: "incident", at: 1_700_000_000_000 };
    await new KillSwitch({ state: new MemoryStateStore(), file, log }).trip(reason);
    const restarted = new KillSwitch({ state: new MemoryStateStore(), file, log });
    assert.deepEqual(restarted.tripped(), reason);
    await restarted.rearm("alice");
    assert.equal(restarted.tripped(), undefined);
    assert.ok(log.entries.some((e) => e.event === "KILL_SWITCH_TRIPPED"));
    assert.ok(log.entries.some((e) => e.event === "KILL_SWITCH_REARMED"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tripped marker refuses to start and never acquires the lease", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "KILLED");
    writeFileSync(file, `${JSON.stringify({ code: "risk", detail: "model breach", at: 1 })}\n`);
    let runs = 0;
    let acquires = 0;
    const code = await runAgentd(
      ["--once", "--tasks", "fake"],
      {
        AGENT_MODE: "dry-run",
        AGENT_STATE_PATH: join(dir, "state.json"),
        AGENT_KILL_FILE: file,
        AGENT_LEASE: "none",
      },
      {
        handleSignals: false,
        log: memoryLogger(),
        state: new MemoryStateStore(),
        lease: {
          acquire: async () => void acquires++,
          release: async () => {},
        },
        taskFactories: {
          fake: async () => ({
            name: "fake",
            intervalMs: 1,
            run: async () => void runs++,
          }),
        },
      },
    );
    assert.equal(code, 3);
    assert.equal(runs, 0);
    assert.equal(acquires, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
