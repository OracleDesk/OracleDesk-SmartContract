import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ipfsUrl, verifyTraceHash } from "./trace-verification.js";

test("verifies the exact bytes received from IPFS", () => {
  const content = new TextEncoder().encode('{"action":"buy","confidence":0.72}');
  const hash = createHash("sha256").update(content).digest("hex");

  assert.equal(verifyTraceHash(content, hash), true);
  assert.equal(verifyTraceHash(content, `0x${hash}`), true);
  assert.equal(verifyTraceHash(new TextEncoder().encode("{}"), hash), false);
  assert.equal(verifyTraceHash(content, "not-a-hash"), false);
});

test("builds an encoded IPFS gateway URL", () => {
  assert.equal(
    ipfsUrl("https://ipfs.example/", "bafy trace"),
    "https://ipfs.example/bafy%20trace",
  );
});
