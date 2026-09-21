/**
 * TraceRepository backed by the deployed reasoning-registry contract,
 * closing the gap the design doc calls out explicitly: "confirm it matches
 * the on-chain trace_hash from reasoning_registry before serving." The
 * static `MapTraceRepository` (server.ts's default) is a
 * TRACE_RECORDS_JSON-driven stand-in for when no registry is configured.
 *
 * The read is narrowed to `RegistryTraceReader` (structurally, not the full
 * generated Client type) so this file — and its tests — never need
 * `@oracledesk/bindings-reasoning-registry` installed; only
 * `createRegistryTraceRepository`'s dynamic import does.
 */

import type { TraceRecord, TraceRepository } from "./trace-api.js";

export interface RegistryTrace {
  market_id: bigint;
  agent: string;
  action: string;
  trace_hash: Buffer;
  ipfs_cid: string;
  published_at: bigint;
}

export interface RegistryTraceReader {
  get_trace(args: { trace_id: bigint }): Promise<{ result: RegistryTrace }>;
}

export class RegistryTraceRepository implements TraceRepository {
  constructor(private readonly reader: RegistryTraceReader) {}

  async get(traceId: string): Promise<TraceRecord | undefined> {
    let id: bigint;
    try {
      id = BigInt(traceId);
    } catch {
      return undefined;
    }
    try {
      const { result } = await this.reader.get_trace({ trace_id: id });
      return {
        traceId,
        ipfsCid: result.ipfs_cid,
        traceHash: result.trace_hash.toString("hex"),
      };
    } catch {
      // Contract-level TraceNotFound, or any RPC failure: treat as "no
      // record" rather than surfacing an internal error to the caller.
      return undefined;
    }
  }
}

export interface RegistryConnection {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export async function createRegistryTraceRepository(
  conn: RegistryConnection,
): Promise<RegistryTraceRepository> {
  const { Client } = await import("@oracledesk/bindings-reasoning-registry");
  const client = await Client.from({
    contractId: conn.contractId,
    rpcUrl: conn.rpcUrl,
    networkPassphrase: conn.networkPassphrase,
  });
  return new RegistryTraceRepository(client as unknown as RegistryTraceReader);
}
