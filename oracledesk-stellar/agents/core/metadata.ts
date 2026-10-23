/**
 * Reference TypeScript implementation of OracleDesk Market Metadata Schema v1
 * (`oracledesk.market-metadata/1`).
 *
 * Implements:
 * - Unicode NFC normalization on all object keys and strings
 * - Schema v1 validation (`MetadataError` with field path)
 * - RFC 8785 JSON Canonicalization Scheme (JCS) with UTF-16 code unit key ordering
 * - `canonicalMetadataBytes`, `metadataHash`, `verifyMetadata`, `checkAgainstMarket`
 * - Content-addressed CIDv1 (`raw` codec + `sha2-256`) and `LocalMetadataStore`
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_V1 = "oracledesk.market-metadata/1" as const;

export const VALID_CATEGORIES = [
  "Sports",
  "Crypto",
  "Geopolitics",
  "Culture",
  "Macro",
  "Other",
] as const;

export type MarketCategory = (typeof VALID_CATEGORIES)[number];
export type ResolutionMode = "price" | "signers";

export interface MarketMetadataSource {
  name: string;
  url: string;
}

export interface MarketMetadataResolution {
  mode: ResolutionMode;
  criteria: string;
  spec: Record<string, unknown>;
  resolution_hash: string;
}

export interface MarketMetadataV1 {
  schema: typeof SCHEMA_V1;
  question: string;
  description?: string;
  category: MarketCategory;
  close_time: number;
  resolution: MarketMetadataResolution;
  sources: MarketMetadataSource[];
  created_by?: string;
  language?: string;
}

export class MetadataError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "MetadataError";
  }
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const CATEGORY_SET = new Set<string>(VALID_CATEGORIES);

function normalizeNfcValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new MetadataError(
        path,
        "floating-point numbers are not allowed; use integers or decimal strings",
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new MetadataError(
        path,
        "integer exceeds IEEE-754 safe integer range; use a decimal string",
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => normalizeNfcValue(item, `${path}[${idx}]`));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
      if (rawVal === undefined) continue;
      const nk = rawKey.normalize("NFC");
      out[nk] = normalizeNfcValue(rawVal, `${path}.${nk}`);
    }
    return out;
  }
  throw new MetadataError(path, `unsupported JSON type ${typeof value}`);
}

export function buildMarketMetadata(
  input: Omit<MarketMetadataV1, "schema"> & { schema?: typeof SCHEMA_V1 },
): MarketMetadataV1 {
  return validateMetadata({
    ...input,
    schema: SCHEMA_V1,
  });
}

export function validateMetadata(raw: unknown): MarketMetadataV1 {
  const m = normalizeNfcValue(raw, "$");
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    throw new MetadataError("$", "metadata must be a JSON object");
  }
  const obj = m as Record<string, unknown>;
  const allowedTop = new Set([
    "schema",
    "question",
    "description",
    "category",
    "close_time",
    "resolution",
    "sources",
    "created_by",
    "language",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowedTop.has(k)) {
      throw new MetadataError(`$.${k}`, "unknown field in MarketMetadataV1");
    }
  }

  if (obj.schema !== SCHEMA_V1) {
    throw new MetadataError("$.schema", `expected ${JSON.stringify(SCHEMA_V1)}`);
  }

  if (typeof obj.question !== "string" || obj.question.trim().length === 0) {
    throw new MetadataError("$.question", "must be a non-empty string");
  }
  if ([...obj.question].length > 280) {
    throw new MetadataError("$.question", `exceeds 280 chars (${[...obj.question].length})`);
  }

  if (obj.description !== undefined) {
    if (typeof obj.description !== "string") {
      throw new MetadataError("$.description", "must be a string");
    }
    if ([...obj.description].length > 4000) {
      throw new MetadataError("$.description", `exceeds 4000 chars (${[...obj.description].length})`);
    }
  }

  if (typeof obj.category !== "string" || !CATEGORY_SET.has(obj.category)) {
    throw new MetadataError("$.category", `must be one of ${VALID_CATEGORIES.join(", ")}`);
  }

  if (
    typeof obj.close_time !== "number" ||
    !Number.isSafeInteger(obj.close_time) ||
    obj.close_time <= 0
  ) {
    throw new MetadataError("$.close_time", "must be a positive integer");
  }

  if (obj.resolution === null || typeof obj.resolution !== "object" || Array.isArray(obj.resolution)) {
    throw new MetadataError("$.resolution", "must be an object");
  }
  const res = obj.resolution as Record<string, unknown>;
  const allowedRes = new Set(["mode", "criteria", "spec", "resolution_hash"]);
  for (const rk of Object.keys(res)) {
    if (!allowedRes.has(rk)) {
      throw new MetadataError(`$.resolution.${rk}`, "unknown field in resolution");
    }
  }

  if (res.mode !== "price" && res.mode !== "signers") {
    throw new MetadataError("$.resolution.mode", "must be 'price' or 'signers'");
  }
  if (typeof res.criteria !== "string" || res.criteria.trim().length === 0) {
    throw new MetadataError("$.resolution.criteria", "must be a non-empty string");
  }
  if ([...res.criteria].length > 4000) {
    throw new MetadataError("$.resolution.criteria", `exceeds 4000 chars (${[...res.criteria].length})`);
  }
  if (
    res.spec === null ||
    typeof res.spec !== "object" ||
    Array.isArray(res.spec) ||
    Object.keys(res.spec as Record<string, unknown>).length === 0
  ) {
    throw new MetadataError("$.resolution.spec", "must be a non-empty object");
  }
  if (typeof res.resolution_hash !== "string" || !HEX64_RE.test(res.resolution_hash)) {
    throw new MetadataError(
      "$.resolution.resolution_hash",
      "must be a 64-char lowercase hex sha256 string",
    );
  }

  if (!Array.isArray(obj.sources)) {
    throw new MetadataError("$.sources", "must be an array");
  }
  if (obj.sources.length > 10) {
    throw new MetadataError("$.sources", `exceeds max 10 sources (${obj.sources.length})`);
  }
  obj.sources.forEach((src, idx) => {
    const spath = `$.sources[${idx}]`;
    if (src === null || typeof src !== "object" || Array.isArray(src)) {
      throw new MetadataError(spath, "must be an object");
    }
    const sObj = src as Record<string, unknown>;
    for (const sk of Object.keys(sObj)) {
      if (sk !== "name" && sk !== "url") {
        throw new MetadataError(`${spath}.${sk}`, "unknown field in source");
      }
    }
    if (typeof sObj.name !== "string" || sObj.name.trim().length === 0) {
      throw new MetadataError(`${spath}.name`, "must be a non-empty string");
    }
    if (typeof sObj.url !== "string" || sObj.url.trim().length === 0) {
      throw new MetadataError(`${spath}.url`, "must be a non-empty string");
    }
  });

  if (obj.created_by !== undefined) {
    if (typeof obj.created_by !== "string" || obj.created_by.trim().length === 0) {
      throw new MetadataError("$.created_by", "must be a non-empty string");
    }
  }
  if (obj.language !== undefined) {
    if (typeof obj.language !== "string" || obj.language.trim().length === 0) {
      throw new MetadataError("$.language", "must be a non-empty string");
    }
  }

  return obj as unknown as MarketMetadataV1;
}

function compareUtf16CodeUnits(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function jcsEscapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += s[i];
        }
    }
  }
  out += '"';
  return out;
}

export function jcsSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return jcsEscapeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => jcsSerialize(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    entries.sort(([ka], [kb]) => compareUtf16CodeUnits(ka, kb));
    return (
      "{" +
      entries.map(([k, v]) => `${jcsEscapeString(k)}:${jcsSerialize(v)}`).join(",") +
      "}"
    );
  }
  throw new TypeError(`Unsupported JCS value: ${typeof value}`);
}

export function canonicalMetadataString(m: MarketMetadataV1): string {
  const validated = validateMetadata(m);
  return jcsSerialize(validated);
}

export function canonicalMetadataBytes(m: MarketMetadataV1): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalMetadataString(m), "utf8"));
}

export function metadataHash(m: MarketMetadataV1): Buffer {
  return createHash("sha256").update(canonicalMetadataBytes(m)).digest();
}

export function metadataHashHex(m: MarketMetadataV1): string {
  return metadataHash(m).toString("hex");
}

function assertNoFloatTokensInJson(text: string): void {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < text.length && /[-+0-9.eE]/.test(text[j])) j++;
      const token = text.slice(i, j);
      if (token.includes(".") || token.includes("e") || token.includes("E")) {
        throw new MetadataError(
          "$",
          `floating-point or exponential number literal ${JSON.stringify(token)} is not allowed`,
        );
      }
      i = j - 1;
    }
  }
}

/**
 * Verifies received metadata bytes against an expected `question_hash`:
 * 1. Hashes the raw received bytes first (never a re-serialization).
 * 2. Parses and validates against Schema v1.
 * 3. Re-canonicalizes and asserts byte-for-byte equality with `bytes`,
 *    rejecting non-canonical whitespace, key ordering, or unnormalized strings.
 */
export function verifyMetadata(bytes: Uint8Array, questionHashHex: string): MarketMetadataV1 {
  const expected = questionHashHex.toLowerCase().replace(/^0x/, "");
  if (!HEX64_RE.test(expected)) {
    throw new MetadataError("$.question_hash", "expected 64-char lowercase hex sha256");
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expected) {
    throw new MetadataError(
      "$.question_hash",
      `sha256 mismatch: got ${actualHash}, expected ${expected}`,
    );
  }

  const text = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MetadataError("$", `invalid JSON: ${(err as Error).message}`);
  }
  assertNoFloatTokensInJson(text);

  const validated = validateMetadata(parsed);
  const canonical = canonicalMetadataBytes(validated);
  if (Buffer.compare(Buffer.from(canonical), Buffer.from(bytes)) !== 0) {
    throw new MetadataError("$", "received bytes are not in canonical JCS+NFC form");
  }
  return validated;
}

export interface OnChainMarketCommitment {
  question_hash: Buffer | Uint8Array | string;
  resolution_hash: Buffer | Uint8Array | string;
  close_time: bigint | number;
  category: string | { tag: string };
}

function toHex32(val: Buffer | Uint8Array | string): string {
  if (typeof val === "string") {
    return val.toLowerCase().replace(/^0x/, "");
  }
  return Buffer.from(val).toString("hex").toLowerCase();
}

export function checkAgainstMarket(
  m: MarketMetadataV1,
  market: OnChainMarketCommitment,
  recomputedResolutionHash?: Buffer | Uint8Array | string,
): void {
  const validated = validateMetadata(m);
  const marketQHash = toHex32(market.question_hash);
  const computedQHash = metadataHashHex(validated);
  if (computedQHash !== marketQHash) {
    throw new MetadataError(
      "$.question_hash",
      `metadata hash ${computedQHash} != market question_hash ${marketQHash}`,
    );
  }

  const marketRHash = toHex32(market.resolution_hash);
  if (validated.resolution.resolution_hash !== marketRHash) {
    throw new MetadataError(
      "$.resolution.resolution_hash",
      `metadata resolution_hash ${validated.resolution.resolution_hash} != market resolution_hash ${marketRHash}`,
    );
  }

  if (recomputedResolutionHash !== undefined) {
    const specHashHex = toHex32(recomputedResolutionHash);
    if (validated.resolution.resolution_hash !== specHashHex) {
      throw new MetadataError(
        "$.resolution.spec",
        `re-hashed spec ${specHashHex} != metadata resolution_hash ${validated.resolution.resolution_hash}`,
      );
    }
  }

  const marketClose = Number(market.close_time);
  if (validated.close_time !== marketClose) {
    throw new MetadataError(
      "$.close_time",
      `metadata close_time ${validated.close_time} != market close_time ${marketClose}`,
    );
  }

  const marketCat = typeof market.category === "string" ? market.category : market.category.tag;
  if (validated.category !== marketCat) {
    throw new MetadataError(
      "$.category",
      `metadata category ${validated.category} != market category ${marketCat}`,
    );
  }
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32EncodeLower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Computes a deterministic CIDv1 (`b...` multibase base32lower, version 1,
 * raw codec `0x55`, sha2-256 `0x12` `0x20`) over the canonical metadata bytes.
 */
export function computeCidV1RawSha256(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  const cidBytes = new Uint8Array(4 + digest.length);
  cidBytes[0] = 0x01; // CIDv1
  cidBytes[1] = 0x55; // raw multicodec
  cidBytes[2] = 0x12; // sha2-256 multihash code
  cidBytes[3] = 0x20; // 32 bytes
  cidBytes.set(digest, 4);
  return "b" + base32EncodeLower(cidBytes);
}

/**
 * Converts an `ipfs://<cid>[/path]` URI or bare CID into an HTTP gateway URL
 * without URL-encoding the CID slashes.
 */
export function ipfsUriToGatewayUrl(gatewayBase: string, uriOrCid: string): string {
  const base = gatewayBase.replace(/\/+$/, "");
  const stripped = uriOrCid.startsWith("ipfs://")
    ? uriOrCid.slice("ipfs://".length)
    : uriOrCid;
  return `${base}/${stripped.replace(/^\/+/, "")}`;
}

export interface MetadataStore {
  put(bytes: Uint8Array): Promise<{ cid: string; uri: string }>;
  get(uriOrCid: string): Promise<Uint8Array>;
}

export class LocalMetadataStore implements MetadataStore {
  constructor(private readonly dir: string = "./.metadata") {}

  async put(bytes: Uint8Array): Promise<{ cid: string; uri: string }> {
    mkdirSync(this.dir, { recursive: true });
    const cid = computeCidV1RawSha256(bytes);
    writeFileSync(join(this.dir, `${cid}.json`), Buffer.from(bytes));
    return { cid, uri: `ipfs://${cid}` };
  }

  async get(uriOrCid: string): Promise<Uint8Array> {
    const cid = uriOrCid.startsWith("ipfs://") ? uriOrCid.slice("ipfs://".length) : uriOrCid;
    return new Uint8Array(readFileSync(join(this.dir, `${cid}.json`)));
  }
}
