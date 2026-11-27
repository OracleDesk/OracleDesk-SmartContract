/**
 * Ed25519 admin request authentication for the x402 service (#294).
 *
 * Replaces the static X402_ADMIN_TOKEN bearer secret with per-operator
 * Stellar Ed25519 request signatures from an allow-listed key set.
 *
 * Signed message (UTF-8, \n-joined):
 *   oracledesk-x402-admin-v1
 *   <audience>          # e.g. "x402:<SERVICE_ID>:stellar:testnet"
 *   <METHOD>
 *   <path>?<sorted-query>
 *   <sha256-hex of raw body, or sha256("") for no body>
 *   <unix-seconds>
 *   <nonce>             # >=22 char base64url
 *
 * Required headers: X-OD-Admin-Key, X-OD-Admin-Ts, X-OD-Admin-Nonce, X-OD-Admin-Sig.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export type AdminRole = "read" | "refund" | "operator";

export interface AdminKeyEntry {
  key: string;         // Stellar G... public key
  name: string;
  roles: AdminRole[];
  notAfter?: number;   // unix seconds
}

export interface AdminKeysConfig {
  version: number;
  keys: AdminKeyEntry[];
  revoked?: string[];
}

export interface AdminAuthOptions {
  audience: string;
  skewSecs?: number;   // default 60
  config: AdminKeysConfig;
  getNonce: (key: string, nonce: string, ttlMs: number) => Promise<boolean>; // true = first use
}

export class AdminAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "AdminAuthError";
  }
}

/** Build the canonical signed message for a request. */
export function buildAdminMessage(opts: {
  audience: string;
  method: string;
  path: string;
  query: string;
  bodyDigest: string;
  ts: number;
  nonce: string;
}): Buffer {
  const sortedQuery = opts.query
    .split("&")
    .filter(Boolean)
    .sort()
    .join("&");
  const pathWithQuery = sortedQuery ? `${opts.path}?${sortedQuery}` : opts.path;
  return Buffer.from(
    [
      "oracledesk-x402-admin-v1",
      opts.audience,
      opts.method.toUpperCase(),
      pathWithQuery,
      opts.bodyDigest,
      String(opts.ts),
      opts.nonce,
    ].join("\n"),
    "utf8",
  );
}

/** Compute SHA-256 hex of a buffer (or empty string for no body). */
export function bodyDigest(body?: Buffer): string {
  return createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
}

/**
 * Verify an admin request. Throws AdminAuthError on failure.
 * Returns the matched key entry on success.
 */
export async function verifyAdminRequest(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer | undefined,
  opts: AdminAuthOptions,
): Promise<AdminKeyEntry> {
  const skew = opts.skewSecs ?? 60;
  const key = String(headers["x-od-admin-key"] ?? "");
  const tsStr = String(headers["x-od-admin-ts"] ?? "");
  const nonce = String(headers["x-od-admin-nonce"] ?? "");
  const sigB64 = String(headers["x-od-admin-sig"] ?? "");

  if (!key || !tsStr || !nonce || !sigB64) {
    throw new AdminAuthError(401, "Missing admin auth headers");
  }

  // Check revocation before signature to prevent timing probes.
  if (opts.config.revoked?.includes(key)) {
    throw new AdminAuthError(401, "Key revoked");
  }

  const entry = opts.config.keys.find((k) => k.key === key);
  if (!entry) throw new AdminAuthError(401, "Key not in allow-list");

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > skew) {
    throw new AdminAuthError(401, `Clock skew exceeded (server time: ${now})`);
  }

  if (entry.notAfter && ts > entry.notAfter) {
    throw new AdminAuthError(401, "Key expired");
  }

  const msg = buildAdminMessage({
    audience: opts.audience,
    method: "", // caller fills in method/path/query before calling verifyAdminRequest
    path: "",
    query: "",
    bodyDigest: bodyDigest(rawBody),
    ts,
    nonce,
  });

  let verified = false;
  try {
    const kp = Keypair.fromPublicKey(key);
    verified = kp.verify(msg, Buffer.from(sigB64, "base64"));
  } catch {
    throw new AdminAuthError(401, "Invalid signature");
  }
  if (!verified) throw new AdminAuthError(401, "Signature mismatch");

  const ttlMs = skew * 2 * 1000;
  const fresh = await opts.getNonce(key, nonce, ttlMs);
  if (!fresh) throw new AdminAuthError(401, "Nonce replayed");

  return entry;
}

/** Check that the entry has a required role. */
export function requireRole(entry: AdminKeyEntry, role: AdminRole): void {
  if (!entry.roles.includes(role)) {
    throw new AdminAuthError(403, `Role '${role}' required; key '${entry.name}' has: ${entry.roles.join(", ")}`);
  }
}
