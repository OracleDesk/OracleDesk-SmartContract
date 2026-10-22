/**
 * Production {@link TraceStore}: pins the exact trace bytes to IPFS and
 * returns a CID the agent computed and verified itself.
 *
 * The CID is a CIDv1 with the raw codec (0x55) and a sha2-256 multihash, so
 * its digest IS `sha256(bytes)` — the `trace_hash` published next to it in
 * reasoning-registry. Anyone can check CID ↔ hash without fetching anything,
 * and no pinning provider is trusted to name the content: a provider that
 * reports a different CID fails the whole put, because a wrong CID on-chain
 * is permanent. `put` resolves only once enough providers confirmed the pin
 * AND a gateway served bytes hashing to `trace_hash`. See
 * docs/architecture.md, "IPFS trace storage".
 */
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import type { TraceStore } from "./trace.js";

/** One IPFS block: kubo's `chunker=size-1048576` keeps the root a raw leaf. */
export const MAX_TRACE_BYTES = 1024 * 1024;

export class TraceStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceStoreIntegrityError";
  }
}

export interface PinAttempt {
  provider: string;
  attempt: number;
  ok: boolean;
  error?: string;
}

export class TracePinError extends Error {
  constructor(
    message: string,
    readonly attempts: PinAttempt[],
  ) {
    super(message);
    this.name = "TracePinError";
  }
}

export class TraceGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceGatewayError";
  }
}

export async function rawCidForBytes(bytes: Uint8Array): Promise<{ cid: string; digestHex: string }> {
  const mh = await sha256.digest(bytes);
  return { cid: CID.createV1(raw.code, mh).toString(), digestHex: Buffer.from(mh.digest).toString("hex") };
}

/** CID equality by value (codec + multihash), not by string encoding. */
export function sameCid(a: string, b: string): boolean {
  try {
    return CID.parse(a).toV1().equals(CID.parse(b).toV1());
  } catch {
    return false;
  }
}

export interface PinResult {
  cid: string;
  /** false when a pinning service only accepted (queued) the request. */
  confirmed: boolean;
}

export interface PinProvider {
  name: string;
  pin(bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult>;
}

function assertSameCid(provider: string, got: string, expected: string): void {
  if (!sameCid(got, expected)) {
    throw new TraceStoreIntegrityError(`${provider} returned CID ${got}, expected ${expected}`);
  }
}

async function failForStatus(provider: string, res: Response): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`${provider}: HTTP ${res.status}${body ? ` ${body}` : ""}`);
}

/** kubo HTTP RPC `/api/v0/add` as a single raw-leaf block. */
export class KuboProvider implements PinProvider {
  readonly name: string;

  constructor(private readonly o: { apiUrl: string; authHeader?: string; name?: string }) {
    this.name = o.name ?? "kubo";
  }

  async pin(bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult> {
    const url = new URL("api/v0/add", this.o.apiUrl.endsWith("/") ? this.o.apiUrl : `${this.o.apiUrl}/`);
    // Mandatory: default `add` flags produce a dag-pb/UnixFS CID whose
    // digest is not sha256(bytes). The CID check below catches drift.
    for (const [k, v] of Object.entries({
      "cid-version": "1",
      "raw-leaves": "true",
      hash: "sha2-256",
      pin: "true",
      chunker: "size-1048576",
    })) {
      url.searchParams.set(k, v);
    }
    const form = new FormData();
    form.append("file", new Blob([bytes]), "trace.json");
    const headers: Record<string, string> = {};
    if (this.o.authHeader) headers.Authorization = this.o.authHeader;
    const res = await fetch(url, { method: "POST", body: form, headers, signal });
    if (!res.ok) await failForStatus(this.name, res);
    const lines = (await res.text()).split("\n").filter((l) => l.trim() !== "");
    const last = lines.length ? (JSON.parse(lines[lines.length - 1]!) as { Hash?: string }) : {};
    if (!last.Hash) throw new Error(`${this.name}: add response has no Hash`);
    assertSameCid(this.name, last.Hash, expectedCid);
    return { cid: expectedCid, confirmed: true };
  }
}

type PinStatus = "queued" | "pinning" | "pinned" | "failed";

/**
 * IPFS Pinning Service API (`POST /pins`, `GET /pins/{requestid}`). Pins by
 * CID, so the content must already be reachable — typically through the
 * kubo node, whose multiaddrs can be passed as `origins`.
 */
export class PinningServiceProvider implements PinProvider {
  readonly name: string;
  private readonly pollMs: number;

  constructor(
    private readonly o: {
      endpoint: string;
      token: string;
      origins?: string[];
      acceptQueued?: boolean;
      pollIntervalMs?: number;
      name?: string;
    },
  ) {
    this.name = o.name ?? "pinning-service";
    this.pollMs = o.pollIntervalMs ?? 2_000;
  }

  private url(path: string): string {
    return `${this.o.endpoint.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" };
  }

  async pin(_bytes: Uint8Array, expectedCid: string, signal: AbortSignal): Promise<PinResult> {
    const body: Record<string, unknown> = { cid: expectedCid, name: `oracledesk-trace-${expectedCid}` };
    if (this.o.origins?.length) body.origins = this.o.origins;
    const res = await fetch(this.url("/pins"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) await failForStatus(this.name, res);
    let status = (await res.json()) as { requestid: string; status: PinStatus; pin?: { cid?: string } };
    if (!status.requestid) throw new Error(`${this.name}: response has no requestid`);
    if (status.pin?.cid) assertSameCid(this.name, status.pin.cid, expectedCid);

    while (status.status !== "pinned") {
      if (status.status === "failed") throw new Error(`${this.name}: pin ${status.requestid} failed`);
      if (this.o.acceptQueued) return { cid: expectedCid, confirmed: false };
      await sleep(this.pollMs, signal);
      const poll = await fetch(this.url(`/pins/${encodeURIComponent(status.requestid)}`), {
        headers: this.headers(),
        signal,
      });
      if (!poll.ok) await failForStatus(this.name, poll);
      status = (await poll.json()) as typeof status;
      if (status.pin?.cid) assertSameCid(this.name, status.pin.cid, expectedCid);
    }
    return { cid: expectedCid, confirmed: true };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number, baseMs: number): number {
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 10_000);
  return exp / 2 + Math.random() * (exp / 2);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "timed out" : err.message;
  return String(err);
}

/** Reads at most `cap` bytes of a response body; throws past the cap. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > cap) throw new TraceGatewayError(`gateway body ${declared} bytes exceeds cap ${cap}`);
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new TraceGatewayError(`gateway body exceeds cap ${cap}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface IpfsTraceStoreOptions {
  providers: PinProvider[];
  /** Confirmed pins required (default 1). */
  minPins?: number;
  /** Gateway base, e.g. `https://ipfs.io/ipfs` — same one x402 reads from. */
  gatewayUrl: string;
  /** Per-attempt timeout for each provider and the gateway (default 60s). */
  pinTimeoutMs?: number;
  /** Attempts per provider and for the gateway check (default 3). */
  retries?: number;
  backoffBaseMs?: number;
  gatewayTimeoutMs?: number;
  /** Largest gateway body accepted (default MAX_TRACE_BYTES). */
  gatewayMaxBytes?: number;
  /** Count queued (accepted, unconfirmed) pinning-service pins toward minPins. */
  acceptQueued?: boolean;
}

export class IpfsTraceStore implements TraceStore {
  private readonly minPins: number;
  private readonly retries: number;
  private readonly pinTimeoutMs: number;
  private readonly backoffBaseMs: number;

  constructor(private readonly o: IpfsTraceStoreOptions) {
    this.minPins = o.minPins ?? 1;
    this.retries = Math.max(1, o.retries ?? 3);
    this.pinTimeoutMs = o.pinTimeoutMs ?? 60_000;
    this.backoffBaseMs = o.backoffBaseMs ?? 500;
    if (o.providers.length === 0) throw new Error("IpfsTraceStore needs at least one pin provider");
    if (this.minPins < 1 || this.minPins > o.providers.length) {
      throw new Error(`minPins ${this.minPins} must be between 1 and ${o.providers.length} providers`);
    }
  }

  async put(hash: string, json: string): Promise<{ cid: string }> {
    // The exact UTF-8 bytes buildTrace hashed; never re-serialized after this.
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > MAX_TRACE_BYTES) {
      throw new TraceStoreIntegrityError(`trace is ${bytes.byteLength} bytes; the limit is ${MAX_TRACE_BYTES} (one block)`);
    }
    const { cid, digestHex } = await rawCidForBytes(bytes);
    if (digestHex !== hash.toLowerCase().replace(/^0x/, "")) {
      throw new TraceStoreIntegrityError(`trace hash ${hash} does not match sha256 of the json bytes (${digestHex})`);
    }

    const attempts: PinAttempt[] = [];
    const results = await Promise.all(this.o.providers.map((p) => this.pinWithRetry(p, bytes, cid, attempts)));
    const integrity = results.find((r): r is TraceStoreIntegrityError => r instanceof TraceStoreIntegrityError);
    if (integrity) throw integrity;
    const confirmed = results.filter((r) => !(r instanceof Error) && (r.confirmed || this.o.acceptQueued)).length;
    if (confirmed < this.minPins) {
      throw new TracePinError(`only ${confirmed} of required ${this.minPins} pin(s) confirmed for ${cid}`, attempts);
    }

    await this.verifyGateway(cid, digestHex);
    return { cid };
  }

  private async pinWithRetry(
    provider: PinProvider,
    bytes: Uint8Array,
    cid: string,
    attempts: PinAttempt[],
  ): Promise<PinResult | Error> {
    let last: Error = new Error("no attempts");
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const result = await provider.pin(bytes, cid, AbortSignal.timeout(this.pinTimeoutMs));
        assertSameCid(provider.name, result.cid, cid);
        attempts.push({ provider: provider.name, attempt, ok: true });
        return result;
      } catch (err) {
        attempts.push({ provider: provider.name, attempt, ok: false, error: errorText(err) });
        // A wrong CID is misconfiguration or malice, not a transient fault.
        if (err instanceof TraceStoreIntegrityError) return err;
        last = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < this.retries) await sleep(backoffMs(attempt, this.backoffBaseMs));
    }
    return last;
  }

  /** GETs the CID from the gateway (following redirects) and re-hashes the body. */
  private async verifyGateway(cid: string, digestHex: string): Promise<void> {
    const base = this.o.gatewayUrl.replace(/\/+$/, "");
    const cap = this.o.gatewayMaxBytes ?? MAX_TRACE_BYTES;
    const timeoutMs = this.o.gatewayTimeoutMs ?? this.pinTimeoutMs;
    let last = "";
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const res = await fetch(`${base}/${cid}`, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new TraceGatewayError(`gateway HTTP ${res.status}`);
        const body = await readCapped(res, cap);
        const got = createHash("sha256").update(body).digest("hex");
        if (got !== digestHex) {
          throw new TraceStoreIntegrityError(`gateway served ${cid} with sha256 ${got}, expected ${digestHex}`);
        }
        return;
      } catch (err) {
        if (err instanceof TraceStoreIntegrityError) throw err;
        last = errorText(err);
      }
      if (attempt < this.retries) await sleep(backoffMs(attempt, this.backoffBaseMs));
    }
    throw new TraceGatewayError(`trace ${cid} not retrievable from ${base}: ${last}`);
  }
}
