import { createHash, createPublicKey, verify } from "node:crypto";
import { verifyBatchTraceProof } from "../agents/core/merkle.js";
export type { BatchTraceProof, TraceLeafV2 } from "../agents/core/merkle.js";

export type TraceVerdict =
  | { tag: "Valid"; values?: void }
  | { tag: "HashMismatch"; values?: void }
  | { tag: "Flagged"; values: [string] | readonly [string] }
  | { tag: "AgentRevokedAfter"; values: [bigint] | readonly [bigint] }
  | { tag: "KeyCompromised"; values: [bigint] | readonly [bigint] };

export interface TraceRecord {
  traceId: string;
  ipfsCid: string;
  traceHash: string;
  marketId?: bigint;
  agent?: string;
  /** #299: verdict from the registry's `trace_verdict`, if available. */
  verdict?: TraceVerdict;
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyTraceHash(content: Uint8Array, expectedHash: string): boolean {
  const normalized = expectedHash.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(normalized) && sha256Hex(content) === normalized;
}

export function ipfsUrl(gateway: string, cid: string): string {
  const base = gateway.endsWith("/") ? gateway.slice(0, -1) : gateway;
  return `${base}/${encodeURIComponent(cid)}`;
}

export type TraceLocator =
  | { kind: "ipfs"; cid: string; path: string[] }
  | { kind: "local"; path: string }
  | { kind: "unsupported"; reason: string };

export function parseTraceLocator(raw: string): TraceLocator {
  const trimmed = raw.trim();

  if (trimmed.startsWith("ipfs://")) {
    const rest = trimmed.slice(7);
    const [cidPart, ...pathParts] = rest.split("/").filter((s) => s);
    if (!cidPart) return { kind: "unsupported", reason: "empty ipfs:// URI" };
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (trimmed.startsWith("/ipfs/")) {
    const rest = trimmed.slice(6);
    const [cidPart, ...pathParts] = rest.split("/").filter((s) => s);
    if (!cidPart) return { kind: "unsupported", reason: "empty /ipfs/ path" };
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (trimmed.startsWith("local://")) {
    const path = trimmed.slice(8);
    if (!path) return { kind: "unsupported", reason: "empty local:// path" };
    return { kind: "local", path };
  }

  if (/^[Qm]/.test(trimmed) || /^bafy/.test(trimmed) || /^ba[a-z2-7]+/.test(trimmed)) {
    const [cidPart, ...pathParts] = trimmed.split("/").filter((s) => s);
    return { kind: "ipfs", cid: cidPart, path: pathParts };
  }

  if (
    trimmed.startsWith("ipns://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    return { kind: "unsupported", reason: `unsupported scheme or format: ${trimmed}` };
  }

  return { kind: "unsupported", reason: `unrecognized locator format: ${trimmed}` };
}

export type CidCheck = { level: "cid-multihash"; ok: boolean } | { level: "trace-hash-only" };

export function checkCidAgainstTraceHash(loc: TraceLocator, traceHash: string): CidCheck {
  if (loc.kind !== "ipfs" || loc.path.length > 0) {
    return { level: "trace-hash-only" };
  }
  return { level: "trace-hash-only" };
}

export function gatewayUrl(gateway: string, cid: string, path: string[] = []): string {
  const base = gateway.endsWith("/") ? gateway.slice(0, -1) : gateway;
  const pathSegments = [cid, ...path.map((p) => encodeURIComponent(p))];
  return `${base}/${pathSegments.join("/")}`;
}

export interface ChainEntry {
  seq: bigint;
  traceHash: string;
  prevTraceHash: string;
}

export type ChainVerdict =
  | { ok: true }
  | { ok: false; reason: "gap" | "broken-link" | "bad-genesis"; atSeq: bigint };

const GENESIS_HASH = "0".repeat(64);

function normalizeHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "");
}

export function verifyChain(
  entries: ChainEntry[],
  fromGenesis: boolean,
  verdicts?: (TraceVerdict | undefined)[],
): ChainVerdict & { tainted: bigint[] } {
  const tainted: bigint[] = [];

  if (entries.length === 0) return { ok: true, tainted };

  const first = entries[0];
  if (fromGenesis && (first.seq !== 1n || normalizeHash(first.prevTraceHash) !== GENESIS_HASH)) {
    return { ok: false, reason: "bad-genesis", atSeq: first.seq, tainted };
  }

  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.seq !== prev.seq + 1n) {
      return { ok: false, reason: "gap", atSeq: prev.seq + 1n, tainted };
    }
    if (normalizeHash(cur.prevTraceHash) !== normalizeHash(prev.traceHash)) {
      return { ok: false, reason: "broken-link", atSeq: cur.seq, tainted };
    }
  }

  // #299: report compromised links without failing the chain.
  if (verdicts) {
    for (let i = 0; i < entries.length && i < verdicts.length; i += 1) {
      const v = verdicts[i];
      if (v && v.tag === "KeyCompromised") {
        tainted.push(entries[i].seq);
      }
    }
  }

  return { ok: true, tainted };
}

// ---------------------------------------------------------------------------
// Batch inclusion verification (issue #308)
// ---------------------------------------------------------------------------

export interface BatchInclusionResult {
  verified: boolean;
  root: string;
  index: number;
  traceHash: string;
  agent: string;
  marketId: bigint;
  action: string;
}

/**
 * Verifies that a trace is included in an on-chain Merkle batch, using the v2
 * leaf encoding that binds agent/market/action/position.
 *
 * The `batchRoot` must come from the on-chain `publish_trace_batch` call;
 * the `batchProof` is produced by `prove_batched_trace`.
 *
 * Returns `verified: false` rather than throwing so callers can handle
 * partial-batch scenarios gracefully.
 */
export function verifyBatchInclusion(
  batchRoot: string,
  batchProof: BatchTraceProof,
): BatchInclusionResult {
  const normalizedRoot = batchRoot.toLowerCase().replace(/^0x/, "");
  const proofWithRoot = { ...batchProof, root: normalizedRoot };
  const verified = verifyBatchTraceProof(proofWithRoot);
  return {
    verified,
    root: normalizedRoot,
    index: batchProof.index,
    traceHash: batchProof.leaf.traceHash,
    agent: batchProof.leaf.agent,
    marketId: batchProof.leaf.marketId,
    action: batchProof.leaf.action,
  };
}

// ─── Ed25519 trace attestations (#53) ───────────────────────────────────────

/**
 * Verifies an Ed25519 signature over a message using Node's standard crypto.
 * Can be run completely offline with no network or registry access.
 */
export function verifyEd25519Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([spkiPrefix, Buffer.from(publicKey)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

