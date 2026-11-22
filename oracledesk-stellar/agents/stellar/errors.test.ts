import assert from "node:assert/strict";
import test from "node:test";
import { classifySorobanError, SorobanPendingError, SorobanTerminalError } from "./errors.js";

test("contract and authorization failures are terminal", () => {
  assert.deepEqual(classifySorobanError("HostError: contract invocation failed"), {
    kind: "contract",
    terminal: true,
    message: "HostError: contract invocation failed",
  });
  assert.equal(classifySorobanError("authorization failed: missing signature").terminal, true);
  assert.equal(classifySorobanError("txBadAuth").kind, "auth");
});

test("transport failures are not treated as terminal", () => {
  assert.equal(classifySorobanError(new Error("connection reset by peer")).terminal, false);
  assert.equal(classifySorobanError(new Error("connection reset by peer")).kind, "transient");
});

test("submission error classes preserve the hash and error classification", () => {
  const terminal = new SorobanTerminalError("contract error: invalid state", { transactionHash: "abc" });
  assert.equal(terminal.classification.terminal, true);
  assert.equal(terminal.transactionHash, "abc");

  const pending = new SorobanPendingError("still unresolved", "def");
  assert.equal(pending.classification.terminal, false);
  assert.equal(pending.transactionHash, "def");
});
