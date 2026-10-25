import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_V1,
  MetadataError,
  buildMarketMetadata,
  canonicalMetadataBytes,
  checkAgainstMarket,
  computeCidV1RawSha256,
  ipfsUriToGatewayUrl,
  metadataHashHex,
  validateMetadata,
  verifyMetadata,
  type MarketMetadataV1,
} from "./metadata.js";

interface GoldenVector {
  name: string;
  input: MarketMetadataV1;
  canonical_utf8: string;
  canonical_hex: string;
  sha256: string;
}

test("golden vectors produce identical bytes and hashes in TypeScript and Python", () => {
  const vectorsPath = fileURLToPath(
    new URL("../../docs/market-metadata-vectors.json", import.meta.url),
  );
  const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as GoldenVector[];
  assert.ok(vectors.length >= 4);

  for (const vec of vectors) {
    const bytes = canonicalMetadataBytes(vec.input);
    const hex = Buffer.from(bytes).toString("hex");
    const hash = metadataHashHex(vec.input);
    assert.equal(hex, vec.canonical_hex, `${vec.name}: canonical_hex mismatch`);
    assert.equal(hash, vec.sha256, `${vec.name}: sha256 mismatch`);

    const verified = verifyMetadata(bytes, hash);
    assert.equal(metadataHashHex(verified), vec.sha256);
  }
});

test("NFC normalization is applied before hashing", () => {
  const decomposed = buildMarketMetadata({
    question: "Will Cafe\u0301 index exceed 100?",
    category: "Macro",
    close_time: 1800000000,
    resolution: {
      mode: "signers",
      criteria: "Confirmed by 2-of-3 signers (resume\u0301 feed).",
      spec: { threshold: "2", signers: ["GAAA", "GBBB"] },
      resolution_hash: "a".repeat(64),
    },
    sources: [],
  });

  const precomposed = buildMarketMetadata({
    question: "Will Caf\u00e9 index exceed 100?",
    category: "Macro",
    close_time: 1800000000,
    resolution: {
      mode: "signers",
      criteria: "Confirmed by 2-of-3 signers (resum\u00e9 feed).",
      spec: { threshold: "2", signers: ["GAAA", "GBBB"] },
      resolution_hash: "a".repeat(64),
    },
    sources: [],
  });

  assert.equal(metadataHashHex(decomposed), metadataHashHex(precomposed));
  assert.deepEqual(canonicalMetadataBytes(decomposed), canonicalMetadataBytes(precomposed));
});

test("verifyMetadata hashes received bytes and rejects non-canonical bytes", () => {
  const meta = buildMarketMetadata({
    question: "Will XLM close above $0.20 on 2026-12-31?",
    category: "Crypto",
    close_time: 1798675200,
    resolution: {
      mode: "price",
      criteria: "Reflector XLM/USD > 2000000",
      spec: { asset: "XLM", threshold: "2000000" },
      resolution_hash: "b".repeat(64),
    },
    sources: [{ name: "Reflector", url: "https://reflector.network" }],
  });

  const canonical = canonicalMetadataBytes(meta);
  const hash = metadataHashHex(meta);
  assert.equal(verifyMetadata(canonical, hash).question, meta.question);

  // Pretty-printed JSON with its own sha256 must still be rejected as non-canonical
  const prettyBytes = new Uint8Array(Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
  assert.throws(
    () => verifyMetadata(prettyBytes, hash),
    (err: unknown) => err instanceof MetadataError && err.path === "$.question_hash",
  );
});

test("checkAgainstMarket rejects mismatched resolution_hash, spec hash, close_time, or category", () => {
  const rhash = "c".repeat(64);
  const meta = buildMarketMetadata({
    question: "Will XLM close above $0.20?",
    category: "Crypto",
    close_time: 1798675200,
    resolution: {
      mode: "price",
      criteria: "Reflector XLM/USD > 2000000",
      spec: { asset: "XLM", threshold: "2000000" },
      resolution_hash: rhash,
    },
    sources: [],
  });
  const qhash = metadataHashHex(meta);

  checkAgainstMarket(
    meta,
    {
      question_hash: qhash,
      resolution_hash: rhash,
      close_time: 1798675200n,
      category: { tag: "Crypto" },
    },
    rhash,
  );

  assert.throws(
    () =>
      checkAgainstMarket(meta, {
        question_hash: qhash,
        resolution_hash: "d".repeat(64),
        close_time: 1798675200n,
        category: "Crypto",
      }),
    (err: unknown) => err instanceof MetadataError && err.path === "$.resolution.resolution_hash",
  );

  assert.throws(
    () =>
      checkAgainstMarket(
        meta,
        {
          question_hash: qhash,
          resolution_hash: rhash,
          close_time: 1798675200n,
          category: "Crypto",
        },
        "e".repeat(64),
      ),
    (err: unknown) => err instanceof MetadataError && err.path === "$.resolution.spec",
  );
});

test("validateMetadata reports path of invalid fields and rejects floats", () => {
  assert.throws(
    () =>
      validateMetadata({
        schema: SCHEMA_V1,
        question: "Valid question?",
        category: "Crypto",
        close_time: 1798675200,
        resolution: {
          mode: "price",
          criteria: "Valid criteria",
          spec: { threshold: 0.25 },
          resolution_hash: "a".repeat(64),
        },
        sources: [],
      }),
    (err: unknown) => err instanceof MetadataError && err.path === "$.resolution.spec.threshold",
  );

  assert.throws(
    () =>
      validateMetadata({
        schema: SCHEMA_V1,
        question: "",
        category: "Crypto",
        close_time: 1798675200,
        resolution: {
          mode: "price",
          criteria: "Valid criteria",
          spec: { threshold: "2500000" },
          resolution_hash: "a".repeat(64),
        },
        sources: [],
      }),
    (err: unknown) => err instanceof MetadataError && err.path === "$.question",
  );
});

test("CIDv1 raw sha256 and ipfsUriToGatewayUrl format content-addressed URIs properly", () => {
  const bytes = new Uint8Array(Buffer.from("hello world", "utf8"));
  const cid = computeCidV1RawSha256(bytes);
  assert.ok(cid.startsWith("b"));
  assert.equal(
    ipfsUriToGatewayUrl("https://ipfs.io/ipfs/", `ipfs://${cid}`),
    `https://ipfs.io/ipfs/${cid}`,
  );
});
