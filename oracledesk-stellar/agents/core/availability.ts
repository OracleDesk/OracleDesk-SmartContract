/**
 * Content-integrity probe for reasoning traces (#325).
 *
 * Registry metadata names a CID and a trace hash; neither says anything about
 * whether the bytes are still served. This module never trusts a gateway's
 * HTTP 200: raw CIDv1/sha2-256 blocks are checked against their multihash, and
 * legacy dag-pb blocks are checked against the on-chain `trace_hash` (without
 * decrypting anything). A gateway that serves wrong bytes is reported as a
 * `mismatch` immediately — it is worse than one that is down, because it can
 * make a buyer accept corrupted evidence.
 */
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { readCapped } from "./ipfs-store.js";

const RAW_CODE = 0x55;
const SHA2_256_CODE = 0x12;

export type ProbeStatus = "ok" | "mismatch" | "unreachable" | "unsupported";

export interface ProbeTarget {
  id: bigint;
  cid: string;
  /** Plaintext sha256 from the registry. Not needed for raw/sha2-256 CIDs. */
  traceHash?: string;
}

export interface ProbeResult {
  traceId: bigint;
  cid: string;
  status: ProbeStatus;
  /** The gateway that served bad bytes, or the last gateway that failed. */
  gateway?: string;
  error?: string;
}

export interface ProbeOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Attempts per gateway for transient HTTP failures (default 2). */
  retries?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Strips the URI forms a registry may store; `local://` is handled by the caller. */
export function normalizeCid(raw: string): string {
  return raw.trim().replace(/^ipfs:\/\//, "").replace(/^\/ipfs\//, "");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const value = hash.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function isEncryptedEnvelope(bytes: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object") return false;
    const env = value as Record<string, unknown>;
    return env.v === 1 && env.alg === "A256GCM" && typeof env.traceHash === "string" && typeof env.ct === "string";
  } catch {
    return false;
  }
}

type Expected =
  | { kind: "multihash"; digest: Uint8Array }
  | { kind: "trace-hash"; hash: string }
  | { kind: "unsupported"; reason: string };

/** Decides which proof is possible without ever fetching the content. */
export function expectedProof(cidValue: string, traceHash?: string): Expected {
  if (cidValue.startsWith("local://")) return { kind: "unsupported", reason: "local:// CID is not publicly fetchable" };
  let parsed: CID;
  try {
    parsed = CID.parse(normalizeCid(cidValue));
  } catch {
    return { kind: "unsupported", reason: "invalid CID" };
  }
  const mh = parsed.multihash;
  if (parsed.code === RAW_CODE && mh.code === SHA2_256_CODE) {
    return { kind: "multihash", digest: mh.digest };
  }
  // dag-pb (and any future codec) commits to the stored bytes. Plaintext can
  // still be checked against the on-chain hash; an AES-GCM envelope is
  // detected after the body is read and reported as unsupported.
  const hash = normalizedHash(traceHash);
  if (!hash) return { kind: "unsupported", reason: "no valid trace_hash for this CID" };
  return { kind: "trace-hash", hash };
}

function verify(bytes: Uint8Array, expected: Expected, traceHash?: string): string | undefined {
  if (expected.kind === "multihash") {
    const got = createHash("sha256").update(bytes).digest();
    if (got.length !== expected.digest.length || !got.every((b, i) => b === expected.digest[i])) {
      return `sha256 of served bytes does not match the CID multihash`;
    }
    return undefined;
  }
  if (expected.kind === "trace-hash") {
    if (sha256Hex(bytes) !== expected.hash) return `sha256 of served bytes does not match trace_hash ${traceHash}`;
    return undefined;
  }
  return expected.reason;
}

type FetchOutcome = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

function retryDelayMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 5_000);
  }
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchGateway(
  gateway: string,
  cid: string,
  o: ProbeOptions,
): Promise<FetchOutcome> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const retries = Math.max(1, o.retries ?? 2);
  const url = `${gateway.replace(/\/+$/, "")}/${encodeURIComponent(normalizeCid(cid))}`;
  let last = "no attempt";
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (o.signal?.aborted) return { ok: false, error: "probe aborted" };
    let res: Response;
    try {
      res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      last = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
      if (attempt < retries) await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000), o.signal).catch(() => {});
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      last = `HTTP ${res.status}`;
      await sleep(retryDelayMs(res, attempt), o.signal).catch(() => {});
      continue;
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    try {
      return { ok: true, bytes: await readCapped(res, o.maxBytes) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: last };
}

/** Probes gateways in order until one serves verifiable bytes. */
export async function probeTrace(target: ProbeTarget, gateways: string[], o: ProbeOptions): Promise<ProbeResult> {
  const base: ProbeResult = { traceId: target.id, cid: target.cid, status: "unreachable" };
  const proof = expectedProof(target.cid, target.traceHash);
  if (proof.kind === "unsupported") {
    return { ...base, status: "unsupported", error: proof.reason };
  }

  let lastGateway: string | undefined;
  let lastError = "no gateways configured";
  for (const gateway of gateways) {
    lastGateway = gateway;
    if (o.signal?.aborted) return { ...base, status: "unreachable", gateway, error: "probe aborted" };
    const fetched = await fetchGateway(gateway, target.cid, o);
    if (!fetched.ok) {
      lastError = fetched.error;
      continue;
    }
    if (proof.kind === "trace-hash" && isEncryptedEnvelope(fetched.bytes)) {
      return { ...base, status: "unsupported", gateway, error: "encrypted trace cannot be verified without a key" };
    }
    const error = verify(fetched.bytes, proof, target.traceHash);
    if (error) return { ...base, status: "mismatch", gateway, error };
    return { ...base, status: "ok", gateway };
  }
  return { ...base, status: "unreachable", gateway: lastGateway, error: lastError };
}

/** Retryable statuses that the availability task treats as a failed probe. */
export function isFailedProbe(status: ProbeStatus): boolean {
  return status === "mismatch" || status === "unreachable";
}
