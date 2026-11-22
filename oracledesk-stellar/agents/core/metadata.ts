/**
 * Market metadata schema v1: build, canonicalize, hash, and verify market metadata.
 *
 * Canonical encoding follows RFC 8785 (JCS):
 * - UTF-8 encoding
 * - Keys sorted by UTF-16 code unit order (not UTF-8)
 * - NFC normalization of all strings
 * - No whitespace
 * - ECMAScript number serialization
 *
 * Hash = sha256(canonical_bytes)
 */

import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MarketCategory = "Crypto" | "Macro" | "Geopolitics" | "Sports" | "Culture" | "Other";
export type ResolutionMode = "price" | "signers" | "market";
export type LinkedResult = "yes" | "no" | "void";
export type PriceDirection = "above" | "at_or_above" | "below" | "at_or_below";

export interface PriceSpec {
  reflector: string;
  asset: string;
  threshold: number;
  direction: PriceDirection;
  max_staleness: number;
}

export interface SignersSpec {
  signers: string[];
  threshold: number;
  dispute_window: number;
}

export interface MarketSpec {
  source_market_id: number;
  on_yes: LinkedResult;
  on_no: LinkedResult;
  on_void: LinkedResult;
  max_wait: number;
}

export type ResolutionSpec = PriceSpec | SignersSpec | MarketSpec;

export interface ResolutionObject {
  mode: ResolutionMode;
  criteria: string;
  spec: ResolutionSpec;
  resolution_hash: string;
}

export interface Source {
  name: string;
  url: string;
}

export interface MarketMetadataV1 {
  schema: "oracledesk.market-metadata/1";
  question: string;
  description?: string;
  category: MarketCategory;
  close_time: number;
  resolution: ResolutionObject;
  sources?: Source[];
  created_by: string;
  language?: string;
}

export class MetadataError extends Error {
  constructor(
    public path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = "MetadataError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export function validateMetadata(m: unknown): MarketMetadataV1 {
  if (!m || typeof m !== "object") {
    throw new MetadataError("$", "must be an object");
  }

  const obj = m as Record<string, unknown>;

  // Top-level fields
  if (obj.schema !== "oracledesk.market-metadata/1") {
    throw new MetadataError("$.schema", "must equal 'oracledesk.market-metadata/1'");
  }

  if (typeof obj.question !== "string") {
    throw new MetadataError("$.question", "must be a string");
  }
  if (obj.question.length > 280) {
    throw new MetadataError("$.question", "must be ≤ 280 characters");
  }

  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new MetadataError("$.description", "must be a string");
  }
  if (typeof obj.description === "string" && obj.description.length > 2000) {
    throw new MetadataError("$.description", "must be ≤ 2000 characters");
  }

  if (typeof obj.category !== "string" || !isValidCategory(obj.category)) {
    throw new MetadataError("$.category", "must be a valid Category");
  }

  if (typeof obj.close_time !== "number" || !Number.isInteger(obj.close_time)) {
    throw new MetadataError("$.close_time", "must be an integer");
  }

  if (typeof obj.created_by !== "string") {
    throw new MetadataError("$.created_by", "must be a Stellar address");
  }

  if (obj.language !== undefined && typeof obj.language !== "string") {
    throw new MetadataError("$.language", "must be a string (ISO 639-1 code)");
  }

  // Resolution object
  const resolution = validateResolutionObject(obj.resolution);

  // Sources
  let sources: Source[] | undefined;
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) {
      throw new MetadataError("$.sources", "must be an array");
    }
    if (obj.sources.length > 10) {
      throw new MetadataError("$.sources", "must have ≤ 10 items");
    }
    sources = obj.sources.map((s, i) => validateSource(s, `$.sources[${i}]`));
  }

  return {
    schema: "oracledesk.market-metadata/1",
    question: obj.question as string,
    description: obj.description as string | undefined,
    category: obj.category as MarketCategory,
    close_time: obj.close_time as number,
    resolution,
    sources,
    created_by: obj.created_by as string,
    language: (obj.language as string | undefined) || "en",
  };
}

function isValidCategory(cat: string): cat is MarketCategory {
  return ["Crypto", "Macro", "Geopolitics", "Sports", "Culture", "Other"].includes(cat);
}

function validateResolutionObject(obj: unknown): ResolutionObject {
  if (!obj || typeof obj !== "object") {
    throw new MetadataError("$.resolution", "must be an object");
  }

  const r = obj as Record<string, unknown>;

  if (typeof r.mode !== "string" || !["price", "signers", "market"].includes(r.mode)) {
    throw new MetadataError("$.resolution.mode", "must be 'price', 'signers', or 'market'");
  }

  if (typeof r.criteria !== "string") {
    throw new MetadataError("$.resolution.criteria", "must be a string");
  }
  if (r.criteria.length > 4000) {
    throw new MetadataError("$.resolution.criteria", "must be ≤ 4000 characters");
  }

  if (typeof r.resolution_hash !== "string" || !/^[0-9a-f]{64}$/.test(r.resolution_hash)) {
    throw new MetadataError("$.resolution.resolution_hash", "must be a 64-character hex string");
  }

  const spec = validateSpecForMode(r.spec, r.mode as ResolutionMode);

  return {
    mode: r.mode as ResolutionMode,
    criteria: r.criteria as string,
    spec,
    resolution_hash: r.resolution_hash as string,
  };
}

function validateSpecForMode(spec: unknown, mode: ResolutionMode): ResolutionSpec {
  if (!spec || typeof spec !== "object") {
    throw new MetadataError("$.resolution.spec", "must be an object");
  }

  const s = spec as Record<string, unknown>;

  if (mode === "price") {
    return validatePriceSpec(s);
  } else if (mode === "signers") {
    return validateSignersSpec(s);
  } else if (mode === "market") {
    return validateMarketSpec(s);
  }

  throw new MetadataError("$.resolution.spec", `unknown mode: ${mode}`);
}

function validatePriceSpec(s: Record<string, unknown>): PriceSpec {
  if (typeof s.reflector !== "string") {
    throw new MetadataError("$.resolution.spec.reflector", "must be a Stellar address");
  }
  if (typeof s.asset !== "string") {
    throw new MetadataError("$.resolution.spec.asset", "must be a string ('native' or contract address)");
  }
  if (typeof s.threshold !== "number" || !Number.isInteger(s.threshold)) {
    throw new MetadataError("$.resolution.spec.threshold", "must be an integer");
  }
  if (typeof s.direction !== "string" || !["above", "at_or_above", "below", "at_or_below"].includes(s.direction)) {
    throw new MetadataError("$.resolution.spec.direction", "must be a valid PriceDirection");
  }
  if (typeof s.max_staleness !== "number" || !Number.isInteger(s.max_staleness)) {
    throw new MetadataError("$.resolution.spec.max_staleness", "must be an integer");
  }

  return {
    reflector: s.reflector as string,
    asset: s.asset as string,
    threshold: s.threshold as number,
    direction: s.direction as PriceDirection,
    max_staleness: s.max_staleness as number,
  };
}

function validateSignersSpec(s: Record<string, unknown>): SignersSpec {
  if (!Array.isArray(s.signers)) {
    throw new MetadataError("$.resolution.spec.signers", "must be an array of Stellar addresses");
  }
  for (const [i, signer] of s.signers.entries()) {
    if (typeof signer !== "string") {
      throw new MetadataError(`$.resolution.spec.signers[${i}]`, "must be a string");
    }
  }
  if (typeof s.threshold !== "number" || !Number.isInteger(s.threshold)) {
    throw new MetadataError("$.resolution.spec.threshold", "must be an integer");
  }
  if (typeof s.dispute_window !== "number" || !Number.isInteger(s.dispute_window)) {
    throw new MetadataError("$.resolution.spec.dispute_window", "must be an integer");
  }

  return {
    signers: s.signers as string[],
    threshold: s.threshold as number,
    dispute_window: s.dispute_window as number,
  };
}

function validateMarketSpec(s: Record<string, unknown>): MarketSpec {
  if (typeof s.source_market_id !== "number" || !Number.isInteger(s.source_market_id)) {
    throw new MetadataError("$.resolution.spec.source_market_id", "must be an integer");
  }
  if (!["yes", "no", "void"].includes(String(s.on_yes))) {
    throw new MetadataError("$.resolution.spec.on_yes", "must be 'yes', 'no', or 'void'");
  }
  if (!["yes", "no", "void"].includes(String(s.on_no))) {
    throw new MetadataError("$.resolution.spec.on_no", "must be 'yes', 'no', or 'void'");
  }
  if (!["yes", "no", "void"].includes(String(s.on_void))) {
    throw new MetadataError("$.resolution.spec.on_void", "must be 'yes', 'no', or 'void'");
  }
  if (typeof s.max_wait !== "number" || !Number.isInteger(s.max_wait)) {
    throw new MetadataError("$.resolution.spec.max_wait", "must be an integer");
  }

  return {
    source_market_id: s.source_market_id as number,
    on_yes: s.on_yes as LinkedResult,
    on_no: s.on_no as LinkedResult,
    on_void: s.on_void as LinkedResult,
    max_wait: s.max_wait as number,
  };
}

function validateSource(s: unknown, path: string): Source {
  if (!s || typeof s !== "object") {
    throw new MetadataError(path, "must be an object");
  }

  const source = s as Record<string, unknown>;
  if (typeof source.name !== "string") {
    throw new MetadataError(`${path}.name`, "must be a string");
  }
  if (typeof source.url !== "string") {
    throw new MetadataError(`${path}.url`, "must be a string");
  }

  const totalLen = JSON.stringify(source).length;
  if (totalLen > 500) {
    throw new MetadataError(path, "source object must be ≤ 500 characters when serialized");
  }

  return {
    name: source.name as string,
    url: source.url as string,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization (RFC 8785 JCS + NFC)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize all string values to NFC form.
 */
function normalizeStringsNFC(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.normalize("NFC");
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeStringsNFC);
  }
  if (obj !== null && typeof obj === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      normalized[key] = normalizeStringsNFC(value);
    }
    return normalized;
  }
  return obj;
}

/**
 * Canonicalize a value to RFC 8785 (JCS) JSON.
 * Keys are sorted by UTF-16 code unit order (matching JavaScript's default).
 */
function canonicalizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type === "boolean") {
    return value ? "true" : "false";
  }

  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`Invalid number: ${value}`);
    }
    // ECMAScript serialization: no leading zeros, no + sign
    const num = value as number;
    if (Number.isInteger(num)) {
      return String(num);
    }
    // Decimals: use toLocaleString with C locale behavior
    const str = num.toString();
    // Filter out 'e' notation artifacts and ensure canonical form
    if (str.includes("e")) {
      throw new Error(`Scientific notation not allowed: ${str}`);
    }
    return str;
  }

  if (type === "string") {
    return JSON.stringify(value as string);
  }

  if (Array.isArray(value)) {
    const items = (value as unknown[]).map(canonicalizeValue);
    return "[" + items.join(",") + "]";
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => {
      // UTF-16 code unit order (JavaScript's native string comparison)
      return a.localeCompare(b, "en", { usage: "sort" });
    });

    const pairs = keys.map((key) => {
      const keyStr = JSON.stringify(key);
      const valStr = canonicalizeValue(obj[key]);
      return keyStr + ":" + valStr;
    });

    return "{" + pairs.join(",") + "}";
  }

  throw new Error(`Cannot canonicalize type ${type}`);
}

export function canonicalMetadataBytes(metadata: MarketMetadataV1): Uint8Array {
  // NFC-normalize all strings
  const normalized = normalizeStringsNFC(metadata);

  // Canonicalize to JCS
  const canonical = canonicalizeValue(normalized);

  // UTF-8 encode
  return new TextEncoder().encode(canonical);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

export function metadataHash(metadata: MarketMetadataV1): Buffer {
  const bytes = canonicalMetadataBytes(metadata);
  return createHash("sha256").update(bytes).digest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that received bytes hash to the expected question_hash.
 * Parse and validate the bytes as metadata, then re-canonicalize to confirm
 * the bytes were already in canonical form.
 */
export function verifyMetadata(bytes: Uint8Array, questionHashHex: string): MarketMetadataV1 {
  // Hash the received bytes
  const receivedHash = createHash("sha256").update(bytes).digest("hex");

  if (receivedHash !== questionHashHex) {
    throw new Error(
      `Metadata hash mismatch: expected ${questionHashHex}, got ${receivedHash}`
    );
  }

  // Parse and validate
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse metadata JSON: ${e}`);
  }

  const metadata = validateMetadata(parsed);

  // Re-canonicalize to verify bytes were canonical
  const recanonical = canonicalMetadataBytes(metadata);
  const recanonicalHex = createHash("sha256").update(recanonical).digest("hex");

  if (recanonicalHex !== questionHashHex) {
    throw new Error(
      "Metadata was not in canonical form: bytes do not re-canonicalize to same hash"
    );
  }

  return metadata;
}

/**
 * Check that metadata is consistent with on-chain market fields.
 * - resolution.resolution_hash must match market.resolution_hash
 * - category must match market.category
 * - close_time must match market.close_time
 */
export function checkAgainstMarket(
  metadata: MarketMetadataV1,
  market: {
    question_hash: string;
    resolution_hash: string;
    close_time: number;
    category: string;
  }
): void {
  if (metadata.resolution.resolution_hash !== market.resolution_hash) {
    throw new Error(
      `Resolution hash mismatch: metadata has ${metadata.resolution.resolution_hash}, ` +
      `market has ${market.resolution_hash}`
    );
  }

  if (metadata.category !== market.category) {
    throw new Error(
      `Category mismatch: metadata has ${metadata.category}, market has ${market.category}`
    );
  }

  if (metadata.close_time !== market.close_time) {
    throw new Error(
      `Close time mismatch: metadata has ${metadata.close_time}, market has ${market.close_time}`
    );
  }
}
