import assert from "node:assert/strict";
import test from "node:test";
import { jsonLogger } from "./log.js";

test("jsonLogger redacts secrets in fields, errors, and text", () => {
  const lines: string[] = [];
  const logger = jsonLogger((line) => lines.push(line));
  logger.error("request_failed", {
    authorization: "Bearer abc.def",
    detail: new Error("request contained Bearer abc.def"),
    url: "https://example.test/?token=private-value",
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("abc.def"));
  assert.ok(!lines[0]!.includes("private-value"));
  assert.ok(!lines[0]!.includes("Bearer abc.def"));
  assert.match(lines[0]!, /"\[REDACTED\]"/);
});
