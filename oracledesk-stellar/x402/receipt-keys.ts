/**
 * Server receipt key set (#330).
 *
 * `X402_RECEIPT_KEYS` (or the JSON file named by `X402_RECEIPT_KEYS_FILE`)
 * holds an array of
 *   `{ kid, publicKey, notBefore, notAfter?, secret? | secretFile? }`
 * with `publicKey` / `secret` as 64-hex raw Ed25519 public key / seed.
 * Exactly one entry with a secret and no `notAfter` is the active signer.
 *
 * Rotation: add the new key (with its secret), then set `notAfter` on the
 * old one and drop its secret. Retired keys must stay listed indefinitely,
 * or receipts they signed become unverifiable; removing a key declares it
 * compromised.
 *
 * Secrets are never logged or published: `publicKeySet()` returns only
 * `{ kid, publicKey, notBefore, notAfter }`.
 */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  hexToBytes,
  importSigningKey,
  kidFor,
  normalizeHex,
  signReceipt,
  type ReceiptFields,
  type ReceiptKeySet,
  type ReceiptPublicKey,
} from "./receipt.js";

export const KEYS_PATH = "/.well-known/oracledesk-x402-keys.json";

interface RawKey {
  kid?: unknown;
  publicKey?: unknown;
  notBefore?: unknown;
  notAfter?: unknown;
  secret?: unknown;
  secretFile?: unknown;
}

export class ReceiptKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptKeyConfigError";
  }
}

export interface ReceiptSigner {
  /** Active signing key id. */
  kid: string;
  /** Published key set (public keys and windows only). */
  publicKeySet(): ReceiptKeySet;
  /** Signs fields with the active key; `fields.kid` is set by the signer. */
  sign(fields: Omit<ReceiptFields, "kid">): Promise<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parses and validates a key set. Throws `ReceiptKeyConfigError` (with no
 * secret material in the message) on any problem.
 */
export async function loadReceiptSigner(raw: string): Promise<ReceiptSigner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReceiptKeyConfigError("X402_RECEIPT_KEYS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new ReceiptKeyConfigError("X402_RECEIPT_KEYS must be a non-empty array");
  const published: ReceiptPublicKey[] = [];
  let active: { kid: string; publicKey: string; seed: string } | undefined;
  for (const [i, entry] of (parsed as RawKey[]).entries()) {
    const publicKey =
      typeof entry.publicKey === "string" ? normalizeHex(entry.publicKey) : "";
    if (!HEX64.test(publicKey))
      throw new ReceiptKeyConfigError(`receipt key ${i}: publicKey must be 64 hex`);
    const kid = await kidFor(publicKey);
    if (entry.kid !== undefined && entry.kid !== kid)
      throw new ReceiptKeyConfigError(`receipt key ${i}: kid must be ${kid}`);
    if (typeof entry.notBefore !== "number" || !Number.isSafeInteger(entry.notBefore))
      throw new ReceiptKeyConfigError(`receipt key ${kid}: notBefore must be unix seconds`);
    if (
      entry.notAfter !== undefined &&
      (typeof entry.notAfter !== "number" ||
        !Number.isSafeInteger(entry.notAfter) ||
        entry.notAfter <= entry.notBefore)
    )
      throw new ReceiptKeyConfigError(`receipt key ${kid}: bad notAfter`);
    if (published.some((k) => k.kid === kid))
      throw new ReceiptKeyConfigError(`receipt key ${kid}: duplicate`);
    published.push({
      kid,
      publicKey,
      notBefore: entry.notBefore,
      ...(entry.notAfter !== undefined ? { notAfter: entry.notAfter as number } : {}),
    });
    const secret =
      typeof entry.secret === "string"
        ? entry.secret
        : typeof entry.secretFile === "string"
          ? readFileSync(entry.secretFile, "utf8").trim()
          : undefined;
    if (secret !== undefined && entry.notAfter === undefined) {
      if (active)
        throw new ReceiptKeyConfigError("exactly one active receipt signing key is allowed");
      const seed = normalizeHex(secret);
      if (!HEX64.test(seed))
        throw new ReceiptKeyConfigError(`receipt key ${kid}: secret must be 64 hex`);
      active = { kid, publicKey, seed };
    }
  }
  if (!active)
    throw new ReceiptKeyConfigError(
      "no active receipt signing key (one entry needs a secret and no notAfter)",
    );
  let privateKey: webcrypto.CryptoKey;
  try {
    privateKey = await importSigningKey(active.seed, active.publicKey);
  } catch {
    throw new ReceiptKeyConfigError(`receipt key ${active.kid}: secret does not import`);
  }
  // Prove the secret matches its published public key before serving.
  const probe = new TextEncoder().encode("oracledesk-x402-receipt-key-probe");
  const pub = await webcrypto.subtle.importKey(
    "raw",
    hexToBytes(active.publicKey) as webcrypto.BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const probeSig = await webcrypto.subtle.sign("Ed25519", privateKey, probe);
  if (!(await webcrypto.subtle.verify("Ed25519", pub, probeSig, probe)))
    throw new ReceiptKeyConfigError(
      `receipt key ${active.kid}: secret does not match publicKey`,
    );
  const signer = active;
  const keySet: ReceiptKeySet = { keys: published };
  return {
    kid: signer.kid,
    publicKeySet: () => structuredClone(keySet),
    sign: (fields) => signReceipt({ kid: signer.kid, ...fields }, privateKey),
  };
}

/**
 * Reads the key set from the environment. Returns `undefined` when receipts
 * are not configured; throws when they are configured but invalid, so
 * startup fails rather than settling payments it cannot receipt.
 */
export async function receiptSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReceiptSigner | undefined> {
  const raw = env.X402_RECEIPT_KEYS_FILE
    ? readFileSync(env.X402_RECEIPT_KEYS_FILE, "utf8")
    : env.X402_RECEIPT_KEYS;
  if (!raw) {
    if (env.X402_RECEIPTS === "required")
      throw new ReceiptKeyConfigError(
        "X402_RECEIPTS=required but X402_RECEIPT_KEYS is not set",
      );
    return undefined;
  }
  return loadReceiptSigner(raw);
}
