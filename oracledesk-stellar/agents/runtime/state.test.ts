import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStateStore } from "./state.js";

async function file(t: test.TestContext) {
  const d = await mkdtemp(join(tmpdir(), "state-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return join(d, "state.json");
}

test("FileStateStore round-trips, keeps bigints, and isolates scopes", async (t) => {
  const path = await file(t);
  const a = await new FileStateStore(path, { scope: "CTREASURY1" }).load();
  a.set("maker.signals", "s1", { status: "created", marketId: 7n });
  a.set("traces", "b", 1);
  a.set("traces", "a", 2);
  await a.flush();

  const b = await new FileStateStore(path, { scope: "CTREASURY2" }).load();
  assert.equal(b.get("maker.signals", "s1"), undefined, "a redeploy (new treasury) starts clean");
  b.set("x", "y", true);
  await b.flush();

  const a2 = await new FileStateStore(path, { scope: "CTREASURY1" }).load();
  assert.deepEqual(a2.get("maker.signals", "s1"), { status: "created", marketId: 7n });
  assert.deepEqual(a2.entries("traces"), [["a", 2], ["b", 1]]);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.deepEqual(Object.keys(raw.scopes).sort(), ["CTREASURY1", "CTREASURY2"]);
});

test("FileStateStore survives crash between temp write and rename", async (t) => {
  const path = await file(t);
  const good = await new FileStateStore(path, { scope: "S", debounceMs: 0 }).load();
  good.set("ns", "k", "before");
  await good.flush();

  const crashing = await new FileStateStore(path, {
    scope: "S",
    debounceMs: 0,
    rename: async () => {
      throw new Error("simulated crash before rename");
    },
  }).load();
  crashing.set("ns", "k", "after");
  await assert.rejects(crashing.flush(), /simulated crash/);

  // The file still holds the last complete write; no temp file is left behind.
  const reloaded = await new FileStateStore(path, { scope: "S" }).load();
  assert.equal(reloaded.get("ns", "k"), "before");
  assert.deepEqual((await readdir(join(path, ".."))).sort(), ["state.json"]);

  // A torn temp file from a hard crash is ignored.
  await writeFile(`${path}.123.abcd.tmp`, '{"version":1,"sco');
  assert.equal((await new FileStateStore(path, { scope: "S" }).load()).get("ns", "k"), "before");
});

test("FileStateStore rejects an unknown version", async (t) => {
  const path = await file(t);
  await writeFile(path, JSON.stringify({ version: 99, scopes: {} }));
  await assert.rejects(new FileStateStore(path, { scope: "S" }).load(), /unsupported state version 99/);
});
