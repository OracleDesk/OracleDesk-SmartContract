import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTraceRepository, validationClass } from "./audit.js";

test("validation class follows the registry verdict (#322)", () => {
  assert.equal(validationClass({ tag: "Valid" }), "ok");
  assert.equal(validationClass({ tag: "Late" }), "late");
  assert.equal(validationClass(undefined), "legacy-unchecked");
});

test("loadTraceRepository requires a reasoning_registry deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const file = join(dir, "deployments.json");
  writeFileSync(file, JSON.stringify({ contracts: {} }));
  const prev = process.env.DEPLOYMENTS_FILE;
  process.env.DEPLOYMENTS_FILE = file;
  try {
    await assert.rejects(loadTraceRepository(), /reasoning_registry/);
  } finally {
    if (prev === undefined) delete process.env.DEPLOYMENTS_FILE;
    else process.env.DEPLOYMENTS_FILE = prev;
  }
});
