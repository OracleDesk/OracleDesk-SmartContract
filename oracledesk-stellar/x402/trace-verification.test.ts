import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ipfsUrl,
  verifyBatchInclusion,
  verifyChain,
  verifyEd25519Signature,
  verifyTraceHash,
  type ChainEntry,
} from "./trace-verification.js";

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

test("ipfsUrl leaves a bare CIDv1 unchanged", () => {
  // What agents/core/ipfs-store.ts publishes: raw-codec CIDv1, base32 lower.
  const cid = "bafkreicecnx2gvntm6fbcrvnc336qze6st5u7qq7457igegamd3bzkx7ri";
  assert.equal(ipfsUrl("https://ipfs.io/ipfs", cid), `https://ipfs.io/ipfs/${cid}`);
  assert.equal(ipfsUrl("https://ipfs.io/ipfs/", cid), `https://ipfs.io/ipfs/${cid}`);
});

// ─── Hash-chained traces (#52) ───────────────────────────────────────────────


const h = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const ZERO = "0".repeat(64);

function chain(n: number): ChainEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: BigInt(i + 1),
    traceHash: h(i + 1),
    prevTraceHash: i === 0 ? ZERO : h(i),
  }));
}

test("verifyChain accepts a valid chain from genesis", () => {
  assert.deepEqual(verifyChain(chain(4), true), { ok: true });
  assert.deepEqual(verifyChain([], true), { ok: true });
});

test("verifyChain accepts a valid middle range without genesis", () => {
  assert.deepEqual(verifyChain(chain(5).slice(2), false), { ok: true });
});

test("verifyChain detects a gap", () => {
  const entries = chain(4);
  entries.splice(2, 1); // drop seq 3
  assert.deepEqual(verifyChain(entries, true), { ok: false, reason: "gap", atSeq: 3n });
});

test("verifyChain detects a broken link", () => {
  const entries = chain(3);
  entries[2] = { ...entries[2], prevTraceHash: h(9) };
  assert.deepEqual(verifyChain(entries, true), { ok: false, reason: "broken-link", atSeq: 3n });
});

test("verifyChain detects a bad genesis", () => {
  assert.deepEqual(verifyChain(chain(4).slice(1), true), { ok: false, reason: "bad-genesis", atSeq: 2n });
  const forged = chain(2);
  forged[0] = { ...forged[0], prevTraceHash: h(7) };
  assert.deepEqual(verifyChain(forged, true), { ok: false, reason: "bad-genesis", atSeq: 1n });
});

// ─── Merkle batch inclusion (#54) ──────────────────────────────────────────

test("verifyBatchInclusion verifies against golden vector", () => {
  // Vector size 2: root cd3a97b9457820450ff6d577b6dd8a13bef94ace08b8ecbabe4e2ca47471e229
  const root = "cd3a97b9457820450ff6d577b6dd8a13bef94ace08b8ecbabe4e2ca47471e229";
  const trace0 = "636eefad93fdbc03a258522c63672af91a5f67624e9bc931bee4f4374e1fab58";
  const sibling1 = "178246c101f82fba9b1bb6303f1e9f13120426556576c5ebc78c42d76a7348b3";

  assert.equal(verifyBatchInclusion(root, 2, trace0, 0, [sibling1]), true);
  assert.equal(verifyBatchInclusion(root, 2, trace0, 1, [sibling1]), false);
  assert.equal(verifyBatchInclusion(root, 2, "00".repeat(32), 0, [sibling1]), false);
  assert.equal(verifyBatchInclusion(root, 2, trace0, 0, ["00".repeat(32)]), false);
});

// ─── Ed25519 trace attestations (#53) ───────────────────────────────────────

test("verifyEd25519Signature verifies valid signatures and rejects bad ones", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPubkey = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const message = Buffer.from("test trace message");
  const signature = sign(null, message, privateKey);

  assert.equal(verifyEd25519Signature(rawPubkey, message, signature), true);

  const tamperedMessage = Buffer.from("tampered trace message");
  assert.equal(verifyEd25519Signature(rawPubkey, tamperedMessage, signature), false);

  const tamperedSig = Buffer.from(signature);
  tamperedSig[0] ^= 0xff;
  assert.equal(verifyEd25519Signature(rawPubkey, message, tamperedSig), false);
});

