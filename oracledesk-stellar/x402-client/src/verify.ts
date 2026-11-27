/**
 * Verifies that a trace is recorded in the OracleDesk reasoning registry.
 *
 * The registry `get_trace` binding takes `{ trace_id: bigint }` keyed by
 * on-chain id. The trace record is `{ market_id, agent, action, trace_hash,
 * ipfs_cid, published_at }` — payments are off-chain, so this module only
 * asserts that the trace hash is present and matches what was paid for.
 */
import { TraceNotFound, VerificationFailed } from "./errors.js";

export interface RegistryTraceRecord {
  trace_hash: string;
  agent: string;
  market_id: bigint;
  action: string;
  ipfs_cid: string;
  published_at: bigint;
}

export interface RegistryClient {
  get_trace(args: { trace_id: bigint }): Promise<{ result: RegistryTraceRecord | null }>;
}

export interface VerifyOptions {
  /** The expected sha256 hex of the trace content. */
  traceHash: string;
  /** On-chain trace id returned by the facilitator in PAYMENT-RESPONSE. */
  traceId: bigint;
  registry: RegistryClient;
}

export interface VerificationResult {
  verified: boolean;
  traceId: bigint;
  traceHash: string;
  agent: string;
  marketId: bigint;
  action: string;
  ipfsCid: string;
  publishedAt: bigint;
}

export async function verifyTraceOnChain(opts: VerifyOptions): Promise<VerificationResult> {
  const { traceHash, traceId, registry } = opts;

  let record: RegistryTraceRecord | null;
  try {
    const response = await registry.get_trace({ trace_id: traceId });
    record = response.result;
  } catch (e) {
    throw new VerificationFailed(`Registry lookup failed: ${String(e)}`);
  }

  if (!record) {
    throw new TraceNotFound(String(traceId));
  }

  const normalizedExpected = traceHash.toLowerCase().replace(/^0x/, "");
  const normalizedActual = record.trace_hash.toLowerCase().replace(/^0x/, "");
  if (normalizedExpected !== normalizedActual) {
    throw new VerificationFailed(
      `Trace hash mismatch: expected ${normalizedExpected}, got ${normalizedActual}`,
    );
  }

  return {
    verified: true,
    traceId,
    traceHash: normalizedActual,
    agent: record.agent,
    marketId: record.market_id,
    action: record.action,
    ipfsCid: record.ipfs_cid,
    publishedAt: record.published_at,
  };
}
