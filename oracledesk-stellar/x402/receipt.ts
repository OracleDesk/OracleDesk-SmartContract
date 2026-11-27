/**
 * Signed delivery receipts, `oracledesk-x402-receipt-v1` (#330).
 *
 * Browser-safe: WebCrypto (`crypto.subtle`) only, no `Buffer`, no Node
 * imports. The same module is used by the server to sign and by buyers to
 * verify offline.
 *
 * Encoding (length-prefixed fields, never JSON, so the signed bytes are
 * identical in every runtime):
 *
 *   msg = "oracledesk-x402-receipt-v1" || 0x00
 *       || field(1, kid) || field(2, network) || field(3, paymentId hex)
 *       || field(4, settlementTx hex) || field(5, traceId decimal)
 *       || field(6, traceHash hex) || field(7, verdict tag[:reason])
 *       || field(8, amount decimal base units) || field(9, asset)
 *       || field(10, payTo) || field(11, payer)
 *       || field(12, settledAt unix secs decimal)
 *   field(tag, s) = u8 tag || u32be(len(utf8(s))) || utf8(s)
 *   receipt = base64url(msg) + "." + base64url(ed25519_sign(sha256(msg)))
 */

// Type-only (erased at runtime): WebCrypto types without the DOM lib.
import type { webcrypto } from "node:crypto";
type CryptoKey = webcrypto.CryptoKey;
type SubtleCrypto = webcrypto.SubtleCrypto;
type BufferSource = webcrypto.BufferSource;

export const RECEIPT_DOMAIN = "oracledesk-x402-receipt-v1";

export interface ReceiptFields {
  kid: string;
  network: string;
  paymentId: string;
  settlementTx: string;
  traceId: string;
  traceHash: string;
  /** Registry verdict at sale (`Valid`, `Flagged:reason`, ...) or `unchecked`. */
  verdict: string;
  /** Base units, decimal string: may exceed 2^53. */
  amount: string;
  asset: string;
  payTo: string;
  payer: string;
  /** Issuing server's clock, unix seconds, decimal string. */
  settledAt: string;
}

/** Fixed field order: tag = index + 1. */
export const RECEIPT_FIELD_ORDER: readonly (keyof ReceiptFields)[] = [
  "kid",
  "network",
  "paymentId",
  "settlementTx",
  "traceId",
  "traceHash",
  "verdict",
  "amount",
  "asset",
  "payTo",
  "payer",
  "settledAt",
];

/** A published receipt key: Ed25519 public key (64 hex) and validity window. */
export interface ReceiptPublicKey {
  kid: string;
  publicKey: string;
  /** Unix seconds, inclusive. */
  notBefore: number;
  /** Unix seconds, exclusive. Absent for the active key. */
  notAfter?: number;
}

export interface ReceiptKeySet {
  keys: ReceiptPublicKey[];
}

export type VerifyResult =
  | { ok: true; fields: ReceiptFields; kid: string }
  | { ok: false; reason: string };

export class ReceiptFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptFormatError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const MAX_FIELD_BYTES = 256;

const VALIDATORS: Record<keyof ReceiptFields, (v: string) => boolean> = {
  kid: (v) => HEX16.test(v),
  network: (v) => CAIP2.test(v),
  paymentId: (v) => HEX64.test(v),
  settlementTx: (v) => HEX64.test(v),
  traceId: (v) => DECIMAL.test(v),
  traceHash: (v) => HEX64.test(v),
  verdict: (v) => /^[A-Za-z][A-Za-z0-9_]*(:[^\u0000]{1,128})?$/.test(v),
  amount: (v) => DECIMAL.test(v),
  asset: (v) => v.length > 0,
  payTo: (v) => v.length > 0,
  payer: (v) => v.length > 0,
  settledAt: (v) => DECIMAL.test(v),
};

/** Lowercases hex and strips a `0x` prefix. */
export function normalizeHex(v: string): string {
  return v.toLowerCase().replace(/^0x/, "");
}

/** Throws `ReceiptFormatError` unless every field is present and canonical. */
export function validateFields(fields: ReceiptFields): void {
  const enc = new TextEncoder();
  for (const name of RECEIPT_FIELD_ORDER) {
    const v = fields[name];
    if (typeof v !== "string" || v.length === 0)
      throw new ReceiptFormatError(`missing receipt field ${name}`);
    if (enc.encode(v).length > MAX_FIELD_BYTES)
      throw new ReceiptFormatError(`receipt field ${name} too long`);
    if (!VALIDATORS[name](v))
      throw new ReceiptFormatError(`non-canonical receipt field ${name}`);
  }
}

/** Canonical message bytes. Validates first. */
export function encodeReceipt(fields: ReceiptFields): Uint8Array {
  validateFields(fields);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(RECEIPT_DOMAIN), new Uint8Array([0])];
  RECEIPT_FIELD_ORDER.forEach((name, i) => {
    const value = enc.encode(fields[name]);
    const header = new Uint8Array(5);
    header[0] = i + 1;
    new DataView(header.buffer).setUint32(1, value.length, false);
    parts.push(header, value);
  });
  return concat(parts);
}

/** Parses message bytes back into fields; strict about order and trailing bytes. */
export function decodeMessage(msg: Uint8Array): ReceiptFields {
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: true });
  const prefix = enc.encode(RECEIPT_DOMAIN);
  if (msg.length < prefix.length + 1)
    throw new ReceiptFormatError("receipt too short");
  for (let i = 0; i < prefix.length; i++)
    if (msg[i] !== prefix[i]) throw new ReceiptFormatError("wrong receipt domain");
  if (msg[prefix.length] !== 0) throw new ReceiptFormatError("wrong receipt domain");
  let off = prefix.length + 1;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const out: Partial<ReceiptFields> = {};
  RECEIPT_FIELD_ORDER.forEach((name, i) => {
    if (off + 5 > msg.length) throw new ReceiptFormatError("truncated receipt");
    if (msg[off] !== i + 1) throw new ReceiptFormatError("unexpected receipt field tag");
    const len = view.getUint32(off + 1, false);
    off += 5;
    if (len > MAX_FIELD_BYTES || off + len > msg.length)
      throw new ReceiptFormatError("truncated receipt");
    out[name] = dec.decode(msg.subarray(off, off + len));
    off += len;
  });
  if (off !== msg.length) throw new ReceiptFormatError("trailing receipt bytes");
  const fields = out as ReceiptFields;
  validateFields(fields);
  return fields;
}

/** Splits `base64url(msg).base64url(sig)` and decodes the fields. */
export function decodeReceipt(receipt: string): {
  fields: ReceiptFields;
  msg: Uint8Array;
  signature: Uint8Array;
} {
  const parts = receipt.split(".");
  if (parts.length !== 2) throw new ReceiptFormatError("malformed receipt");
  const msg = base64urlDecode(parts[0]!);
  const signature = base64urlDecode(parts[1]!);
  if (signature.length !== 64) throw new ReceiptFormatError("bad signature length");
  return { fields: decodeMessage(msg), msg, signature };
}

/** `kid` = first 8 bytes (hex) of sha256(raw 32-byte public key). */
export async function kidFor(publicKeyHex: string): Promise<string> {
  const digest = await sha256(hexToBytes(normalizeHex(publicKeyHex)));
  return bytesToHex(digest.subarray(0, 8));
}

/**
 * Signs with an Ed25519 `CryptoKey`. Ed25519 is deterministic (RFC 8032),
 * so the same fields and key always give the same receipt bytes.
 */
export async function signReceipt(
  fields: ReceiptFields,
  privateKey: CryptoKey,
): Promise<string> {
  const msg = encodeReceipt(fields);
  const digest = await sha256(msg);
  const sig = new Uint8Array(
    await subtle().sign("Ed25519", privateKey, digest as BufferSource),
  );
  return `${base64urlEncode(msg)}.${base64urlEncode(sig)}`;
}

/** Imports a raw 32-byte Ed25519 seed (hex) as a signing key. */
export async function importSigningKey(
  seedHex: string,
  publicKeyHex: string,
): Promise<CryptoKey> {
  return subtle().importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      d: base64urlEncode(hexToBytes(normalizeHex(seedHex))),
      x: base64urlEncode(hexToBytes(normalizeHex(publicKeyHex))),
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/**
 * Verifies a receipt offline against a published key set: canonical
 * encoding, known `kid` whose id matches its public key, signature, and
 * `settledAt` inside the key's `[notBefore, notAfter)` window. With `now`,
 * a `settledAt` more than `maxSkewSecs` in the future is rejected too.
 */
export async function verifyReceipt(
  receipt: string,
  keySet: ReceiptKeySet,
  opts: { now?: number; maxSkewSecs?: number } = {},
): Promise<VerifyResult> {
  let decoded: ReturnType<typeof decodeReceipt>;
  try {
    decoded = decodeReceipt(receipt);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const { fields, msg, signature } = decoded;
  const key = keySet.keys.find((k) => k.kid === fields.kid);
  if (!key) return { ok: false, reason: "unknown kid" };
  if (!HEX64.test(normalizeHex(key.publicKey)))
    return { ok: false, reason: "bad public key" };
  if ((await kidFor(key.publicKey)) !== key.kid)
    return { ok: false, reason: "kid does not match public key" };
  const settledAt = Number(fields.settledAt);
  if (settledAt < key.notBefore || (key.notAfter !== undefined && settledAt >= key.notAfter))
    return { ok: false, reason: "settledAt outside key window" };
  if (opts.now !== undefined && settledAt > opts.now + (opts.maxSkewSecs ?? 300))
    return { ok: false, reason: "settledAt in the future" };
  let valid = false;
  try {
    const pub = await subtle().importKey(
      "raw",
      hexToBytes(normalizeHex(key.publicKey)) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await subtle().verify(
      "Ed25519",
      pub,
      signature as BufferSource,
      (await sha256(msg)) as BufferSource,
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  return { ok: true, fields, kid: key.kid };
}

// ── byte helpers (no Buffer) ───────────────────────────────────────────────

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto unavailable");
  return s;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex))
    throw new ReceiptFormatError("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

export function base64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1)
    throw new ReceiptFormatError("bad base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of s) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Reject non-canonical trailing bits so each receipt has one encoding.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0)
    throw new ReceiptFormatError("bad base64url");
  return out.subarray(0, o);
}
