import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyRegistryError,
  isRestoreRequired,
  RegistryRestoreRequired,
  RepositoryUnavailable,
  toX402Error,
  TRACE_NOT_FOUND_CODE,
  X402_ERROR_KINDS,
  X402_ERROR_STATUS,
  X402Error,
} from "./errors.js";

test("TRACE_NOT_FOUND_CODE matches the registry's Error::TraceNotFound", () => {
  const src = readFileSync(
    new URL("../contracts/reasoning-registry/src/lib.rs", import.meta.url),
    "utf8",
  );
  const m = /TraceNotFound\s*=\s*(\d+)/.exec(src);
  assert.ok(m, "TraceNotFound not found in the registry Error enum");
  assert.equal(TRACE_NOT_FOUND_CODE, Number(m[1]));
  assert.equal(TRACE_NOT_FOUND_CODE, 3005);
});

test("classifier vectors", () => {
  const vectors: [unknown, string, number?][] = [
    [new Error("HostError: Error(Contract, #3005)"), "contract", 3005],
    [new Error("simulation failed: Error(Contract, #3016)"), "contract", 3016],
    [{ diagnostic: "event: Error(Contract, #3005)" }, "contract", 3005],
    [new Error("fetch failed", { cause: new Error("ECONNREFUSED") }), "upstream"],
    [new Error("socket hang up"), "upstream"],
    [new Error("RPC returned 503 Service Unavailable"), "upstream"],
    [new Error("something odd"), "unknown"],
  ];
  for (const [e, kind, code] of vectors) {
    const c = classifyRegistryError(e);
    assert.equal(c.kind, kind, String(e));
    if (code !== undefined) assert.deepEqual(c, { kind: "contract", code });
  }
});

test("every kind has a stable status and JSON shape", () => {
  for (const kind of X402_ERROR_KINDS) {
    const e = new X402Error(kind);
    assert.equal(e.status, X402_ERROR_STATUS[kind]);
    assert.deepEqual(Object.keys(e.toJSON()).sort(), ["error", "message"]);
    assert.equal(e.toJSON().error, kind);
  }
  // Statuses clients already relied on.
  assert.equal(X402_ERROR_STATUS.trace_not_found, 404);
  assert.equal(X402_ERROR_STATUS.invalid_envelope, 402);
  assert.equal(X402_ERROR_STATUS.trace_hash_mismatch, 502);
  assert.equal(X402_ERROR_STATUS.registry_unavailable, 503);
});

test("toX402Error classifies by type and stage", () => {
  const timeout = Object.assign(new Error("timed out"), {
    name: "FacilitatorTimeoutError",
  });
  assert.equal(toX402Error(timeout, "settle").kind, "settle_indeterminate");
  assert.equal(toX402Error(timeout, "verify").kind, "verify_unavailable");
  assert.equal(
    toX402Error(new RepositoryUnavailable({ kind: "upstream", cause: "x" }), "prepare").kind,
    "registry_unavailable",
  );
  assert.equal(
    toX402Error(new RegistryRestoreRequired("1"), "prepare").kind,
    "registry_restore_required",
  );
  assert.equal(toX402Error(new Error("boom"), "settle").kind, "settle_indeterminate");
  assert.equal(toX402Error(new Error("boom"), "prepare").kind, "internal");
  const typed = new X402Error("trace_invalid_json");
  assert.equal(toX402Error(typed, "prepare"), typed);
});

test("client messages never echo the cause", () => {
  const secret = "Bearer super-secret-key";
  const e = toX402Error(new Error(secret), "prepare");
  assert.ok(!JSON.stringify(e.toJSON()).includes(secret));
});

test("restore-required detection", () => {
  assert.ok(isRestoreRequired({ restorePreamble: { minResourceFee: "1" } }));
  assert.ok(isRestoreRequired(new Error("simulation: entry archived, restore preamble required")));
  assert.ok(!isRestoreRequired(new Error("Error(Contract, #3005)")));
});
