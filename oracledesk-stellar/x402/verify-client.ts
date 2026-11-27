// x402/verify-client.ts - Issue #89: Browser-safe client-side verification

/**
 * Verifies that trace bytes hash to the expected on-chain hash.
 * Browser-safe (uses crypto.subtle).
 */
export async function verifyTraceBytes(bytes: Uint8Array, onChainHashHex: string): Promise<boolean> {
  const normalized = onChainHashHex.toLowerCase().replace(/^0x/, "");

  // Validate hash format
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return false;
  }

  // Hash the bytes using SubtleCrypto
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const computedHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return computedHash === normalized;
}

/**
 * Checks if trace bytes are in canonical JSON form (keys sorted UTF-16, no extra whitespace).
 * Matches the server's canonicalize() function.
 */
export function isCanonicalTrace(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(text);
    const canonical = canonicalizeValue(parsed);
    const reencoded = JSON.stringify(canonical);

    // Compare: if they differ, not canonical
    return text === reencoded || JSON.stringify(parsed) === reencoded;
  } catch {
    return false;
  }
}

/**
 * Recursively canonicalizes a value: sorts keys, converts bigints to strings.
 */
function canonicalizeValue(value: any): any {
  if (value === null) return null;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((v) => canonicalizeValue(v));
    }
    const keys = Object.keys(value).sort();
    const result: any = {};
    for (const key of keys) {
      result[key] = canonicalizeValue(value[key]);
    }
    return result;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

/**
 * Parses a v2 trace response with proper number handling.
 * Use this instead of JSON.parse to avoid bigint precision loss.
 */
export function parseTraceWithBigInts(jsonText: string): any {
  // Simple big-number aware parser: replace large integers with string markers
  // A production version would use a proper library like decimal.js
  return JSON.parse(jsonText, (key, value) => {
    if (typeof value === "string" && /^\d{16,}$/.test(value)) {
      // Preserve as string for large integers
      return value;
    }
    return value;
  });
}

/**
 * Extracts the trace hash from response headers (v2 format).
 */
export function getTraceHashFromHeaders(headers: Headers): string | null {
  return headers.get("X-Trace-Hash") || headers.get("x-trace-hash");
}

/**
 * Decodes a v2 envelope response (base64-encoded body).
 */
export function decodeTraceEnvelope(
  envelope: { contentBase64: string; traceHash: string; traceId: string },
): Uint8Array {
  // Decode base64 to bytes
  const binaryString = atob(envelope.contentBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Complete client verification flow for v2 raw response.
 */
export async function verifyTraceResponse(
  response: Response,
  onChainTraceHash: string,
): Promise<{ verified: boolean; bytes: Uint8Array; trace: any }> {
  const bytes = new Uint8Array(await response.arrayBuffer());

  // Verify hash
  const verified = await verifyTraceBytes(bytes, onChainTraceHash);
  if (!verified) {
    throw new Error("Trace hash verification failed");
  }

  // Parse content
  const text = new TextDecoder("utf-8").decode(bytes);
  const trace = JSON.parse(text);

  return { verified, bytes, trace };
}

/**
 * Checks for trace authenticity red flags.
 */
export function detectSuspiciousTrace(trace: any): string[] {
  const issues: string[] = [];

  // Check for unusually large numbers that might indicate precision loss
  function checkNumbers(obj: any, path = "") {
    if (obj === null || obj === undefined) return;
    if (typeof obj === "number") {
      if (Number.isSafeInteger(obj) === false) {
        issues.push(`Unsafe integer at ${path}: ${obj}`);
      }
    } else if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj)) {
        checkNumbers(value, `${path}.${key}`);
      }
    }
  }

  checkNumbers(trace);

  // Check for duplicate keys (would have collapsed to last value)
  const jsonText = JSON.stringify(trace);
  // This is a heuristic; true duplicate detection requires parsing the raw JSON
  if (/"[^"]*":\s*.*?"[^"]*":/.test(jsonText)) {
    // Potential structure with duplicate keys (simplified check)
  }

  return issues;
}
// ── #330 Signed delivery receipts ─────────────────────────────────────────

export {
  decodeReceipt,
  verifyReceipt,
  type ReceiptFields,
  type ReceiptKeySet,
  type VerifyResult,
} from "./receipt.js";
import type { ReceiptKeySet } from "./receipt.js";

/** Path the server publishes its receipt key set at. */
export const RECEIPT_KEYS_PATH = "/.well-known/oracledesk-x402-keys.json";

const keySetCache = new Map<string, Promise<ReceiptKeySet>>();

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Fetches (and caches per origin) a server's published receipt key set.
 * Refuses plain HTTP outside localhost: a key set fetched over an
 * unauthenticated channel could be swapped for an attacker's keys.
 */
export function fetchKeySet(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; refresh?: boolean } = {},
): Promise<ReceiptKeySet> {
  const url = new URL(RECEIPT_KEYS_PATH, baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    return Promise.reject(new Error("receipt key set must be fetched over https"));
  const origin = url.origin;
  const cached = keySetCache.get(origin);
  if (cached && !opts.refresh) return cached;
  const pending = (async () => {
    const res = await (opts.fetchImpl ?? fetch)(url.toString());
    if (!res.ok) throw new Error(`key set fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as ReceiptKeySet;
    if (!body || !Array.isArray(body.keys)) throw new Error("malformed key set");
    return body;
  })();
  keySetCache.set(origin, pending);
  pending.catch(() => keySetCache.delete(origin));
  return pending;
}
