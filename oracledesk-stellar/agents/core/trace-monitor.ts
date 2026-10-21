/**
 * Trace availability monitor, multi-gateway content-addressed fetcher, and
 * automatic re-pinning / archive replication (#116).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashTrace, type ReasoningTrace } from "./trace.js";

export interface TraceGateway {
  name: string;
  fetchByCid(cid: string): Promise<string | null>;
}

export interface PinningTarget {
  name: string;
  pinTrace(traceJson: string, expectedHash: string): Promise<{ cid: string }>;
}

export class LocalHashArchive {
  constructor(private readonly rootDir: string) {}

  private pathForHash(traceHashHex: string): string {
    const clean = traceHashHex.toLowerCase().replace(/^0x/, "");
    return join(this.rootDir, clean.slice(0, 2), `${clean}.json`);
  }

  save(traceHashHex: string, rawJson: string): string {
    const filePath = this.pathForHash(traceHashHex);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, rawJson, "utf8");
    return filePath;
  }

  load(traceHashHex: string): string | null {
    const filePath = this.pathForHash(traceHashHex);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  }
}

export interface TraceProbeTarget {
  traceHash: string;
  cid: string;
}

export interface TraceProbeResult {
  traceHash: string;
  cid: string;
  status: "available" | "recovered_and_repinned" | "hash_mismatch" | "unavailable";
  resolvedFrom?: string;
  repinnedTo?: string[];
}

export async function probeAndRecoverTrace(
  target: TraceProbeTarget,
  opts: {
    gateways: TraceGateway[];
    archive: LocalHashArchive;
    pinTargets?: PinningTarget[];
  },
): Promise<TraceProbeResult> {
  const expectedHash = target.traceHash.toLowerCase().replace(/^0x/, "");
  const cleanCid = target.cid.replace(/^ipfs:\/\//, "");

  let rawJson: string | null = null;
  let sourceName: string | undefined;
  let failedPrimaryGateway = false;

  for (let i = 0; i < opts.gateways.length; i++) {
    const gw = opts.gateways[i];
    try {
      const candidate = await gw.fetchByCid(cleanCid);
      if (candidate !== null) {
        rawJson = candidate;
        sourceName = gw.name;
        break;
      }
      if (i === 0) failedPrimaryGateway = true;
    } catch {
      if (i === 0) failedPrimaryGateway = true;
    }
  }

  if (rawJson === null) {
    const archived = opts.archive.load(expectedHash);
    if (archived !== null) {
      rawJson = archived;
      sourceName = "local-archive";
      failedPrimaryGateway = true;
    }
  }

  if (rawJson === null) {
    return {
      traceHash: expectedHash,
      cid: target.cid,
      status: "unavailable",
    };
  }

  let parsed: ReasoningTrace;
  try {
    parsed = JSON.parse(rawJson) as ReasoningTrace;
  } catch {
    return {
      traceHash: expectedHash,
      cid: target.cid,
      status: "hash_mismatch",
      resolvedFrom: sourceName,
    };
  }

  const computed = hashTrace(parsed);
  if (computed !== expectedHash) {
    return {
      traceHash: expectedHash,
      cid: target.cid,
      status: "hash_mismatch",
      resolvedFrom: sourceName,
    };
  }

  // Always ensure the verified trace is mirrored into the content-addressed archive
  opts.archive.save(expectedHash, rawJson);

  const repinnedTo: string[] = [];
  if (failedPrimaryGateway && opts.pinTargets && opts.pinTargets.length > 0) {
    for (const pinTarget of opts.pinTargets) {
      try {
        await pinTarget.pinTrace(rawJson, expectedHash);
        repinnedTo.push(pinTarget.name);
      } catch {
        // continue trying remaining pinning targets
      }
    }
    return {
      traceHash: expectedHash,
      cid: target.cid,
      status: "recovered_and_repinned",
      resolvedFrom: sourceName,
      repinnedTo,
    };
  }

  return {
    traceHash: expectedHash,
    cid: target.cid,
    status: "available",
    resolvedFrom: sourceName,
  };
}
