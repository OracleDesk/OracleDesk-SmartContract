import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactString, REDACTED } from "./redact.js";

test("redacts sensitive fields recursively without mutating the input", () => {
  const source = {
    agent: "trader",
    privateKey: "private-value",
    nested: { api_token: "token-value", count: 2 },
    messages: [{ text: "safe" }],
  };
  const result = redact(source);
  assert.deepEqual(result, {
    agent: "trader",
    privateKey: REDACTED,
    nested: { api_token: REDACTED, count: 2 },
    messages: [{ text: "safe" }],
  });
  assert.equal(source.privateKey, "private-value");
});

test("redacts Stellar secret seeds, bearer credentials, and URL query secrets in text", () => {
  const secret = `S${"A".repeat(55)}`;
  assert.equal(
    redactString(`seed=${secret} Bearer abc.def token?api_key=topsecret`),
    `seed=${REDACTED} Bearer ${REDACTED} token?api_key=${REDACTED}`,
  );
});

test("handles cyclic values", () => {
  const value: { self?: unknown; password: string } = { password: "hidden" };
  value.self = value;
  const result = redact(value) as typeof value;
  assert.equal(result.password, REDACTED);
  assert.equal(result.self, result);
});
