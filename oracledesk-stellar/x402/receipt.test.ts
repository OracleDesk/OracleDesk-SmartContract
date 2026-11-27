import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeReceipt,
  encodeReceipt,
  importSigningKey,
  kidFor,
  ReceiptFormatError,
  signReceipt,
  verifyReceipt,
  type ReceiptFields,
  type ReceiptKeySet,
} from "./receipt.js";
import { generateVectors, testKey, VECTORS_PATH } from "./receipt-vectors.js";
import { loadReceiptSigner, ReceiptKeyConfigError } from "./receipt-keys.js";
import { fetchKeySet } from "./verify-client.js";

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Awaited<
  ReturnType<typeof generateVectors>
>;

test("committed golden vectors match the generator byte for byte", async () => {
  assert.deepEqual(await generateVectors(), vectors);
});

test("golden vectors verify", async () => {
  for (const v of vectors.valid) {
    const r = await verifyReceipt(v.receipt, vectors.keySet);
    assert.equal(r.ok, true, v.name);
    if (r.ok) assert.deepEqual(r.fields, v.fields);
    assert.equal(
      Buffer.from(encodeReceipt(v.fields as ReceiptFields)).toString("hex"),
      v.msgHex,
    );
  }
});

test("negative vectors fail with the labelled reason", async () => {
  for (const v of vectors.invalid) {
    const r = await verifyReceipt(v.receipt, v.keySet as ReceiptKeySet);
    assert.deepEqual(r, { ok: false, reason: v.reason }, v.name);
  }
});

test("encode/decode round-trip", () => {
  const fields = vectors.valid[0]!.fields as ReceiptFields;
  const { fields: decoded } = decodeReceipt(vectors.valid[0]!.receipt);
  assert.deepEqual(decoded, fields);
});

test("flipped byte in the message fails", async () => {
  const [msg, sig] = vectors.valid[0]!.receipt.split(".") as [string, string];
  const bytes = Buffer.from(msg, "base64url");
  // Flip a byte inside the traceId value ("42" -> "43").
  const i = bytes.indexOf(Buffer.from("42"));
  bytes[i + 1] = bytes[i + 1]! ^ 0x07;
  const tampered = `${bytes.toString("base64url")}.${sig}`;
  const r = await verifyReceipt(tampered, vectors.keySet);
  assert.equal(r.ok, false);
});

test("wrong kid fails", async () => {
  const r = await verifyReceipt(vectors.valid[0]!.receipt, {
    keys: vectors.keySet.keys.map((k) => ({ ...k, kid: "0".repeat(16) })),
  });
  assert.deepEqual(r, { ok: false, reason: "unknown kid" });
});

test("settledAt outside key window fails", async () => {
  const k = vectors.keySet.keys[0]!;
  const late = await verifyReceipt(vectors.valid[0]!.receipt, {
    keys: [{ ...k, notBefore: 1_800_000_000 }],
  });
  assert.deepEqual(late, { ok: false, reason: "settledAt outside key window" });
  const future = await verifyReceipt(vectors.valid[0]!.receipt, vectors.keySet, {
    now: 1_700_000_000,
  });
  assert.deepEqual(future, { ok: false, reason: "settledAt in the future" });
});

test("amount above 2^53 preserved", async () => {
  const v = vectors.valid.find((x) => x.name === "pubnet_flagged_large_amount")!;
  const r = await verifyReceipt(v.receipt, vectors.keySet);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.fields.amount, "123456789012345678901234567890");
});

test("non-canonical and missing fields are rejected before signing", () => {
  const base = vectors.valid[0]!.fields as ReceiptFields;
  for (const bad of [
    { amount: "0100" },
    { traceId: "-1" },
    { paymentId: "0x" + base.paymentId },
    { traceHash: base.traceHash.toUpperCase() },
    { payer: "" },
    { settlementTx: "" },
  ])
    assert.throws(() => encodeReceipt({ ...base, ...bad }), ReceiptFormatError);
});

test("signing is deterministic", async () => {
  const { seed, publicKey } = testKey();
  const key = await importSigningKey(seed, publicKey);
  const fields = vectors.valid[0]!.fields as ReceiptFields;
  assert.equal(await signReceipt(fields, key), await signReceipt(fields, key));
  assert.equal(await signReceipt(fields, key), vectors.valid[0]!.receipt);
});

test("browser build has no Buffer or Node runtime imports", () => {
  const src = readFileSync(new URL("./receipt.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bBuffer\b/);
  assert.doesNotMatch(code, /\brequire\(/);
  // Only type-only imports from node: are allowed (erased at runtime).
  for (const m of code.matchAll(/^import\s+(type\s+)?.*from\s+"node:[^"]+";/gm))
    assert.ok(m[1], `runtime node import: ${m[0]}`);
});

test("key loader: active key, kid derivation and fail-fast errors", async () => {
  const { seed, publicKey } = testKey();
  const signer = await loadReceiptSigner(
    JSON.stringify([{ publicKey, secret: seed, notBefore: 1 }]),
  );
  assert.equal(signer.kid, await kidFor(publicKey));
  const published = JSON.stringify(signer.publicKeySet());
  assert.ok(!published.includes(seed), "secret leaked into the key set");
  const bad = [
    "not json",
    "[]",
    JSON.stringify([{ publicKey, notBefore: 1 }]), // no active signer
    JSON.stringify([{ publicKey, secret: "00".repeat(32), notBefore: 1 }]), // mismatch
    JSON.stringify([{ publicKey, secret: seed, notBefore: 1, kid: "ffffffffffffffff" }]),
  ];
  for (const raw of bad)
    await assert.rejects(loadReceiptSigner(raw), (e: Error) => {
      assert.ok(e instanceof ReceiptKeyConfigError);
      assert.ok(!e.message.includes(seed), "secret in error message");
      return true;
    });
});

test("fetchKeySet refuses plain http outside localhost and caches per origin", async () => {
  await assert.rejects(fetchKeySet("http://example.com"), /https/);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify(vectors.keySet));
  }) as typeof fetch;
  const a = await fetchKeySet("http://localhost:3001/x", { fetchImpl });
  const b = await fetchKeySet("http://localhost:3001/y", { fetchImpl });
  assert.deepEqual(a, vectors.keySet);
  assert.equal(b, a);
  assert.equal(calls, 1);
});
