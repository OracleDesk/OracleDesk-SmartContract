/**
 * Pending-trace bookkeeping shared by the maker and trader tasks. A trace is
 * recorded as pending *before* its `publish_trace` submission and marked
 * published after, so a crash between a trade and its trace leaves a record
 * the next tick publishes instead of silently losing it.
 */
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { TaskContext } from "../runtime.js";

export const TRACES = "traces";

export interface PendingTrace {
  marketId: bigint;
  action: string;
  traceHash: string;
  cid: string;
  decisionHash?: string;
  traceId?: bigint;
  status: "pending" | "published";
  attempts: number;
}

export function recordPendingTrace(ctx: TaskContext, t: Omit<PendingTrace, "status" | "attempts">): void {
  ctx.state.set<PendingTrace>(TRACES, `${t.marketId}:${t.action}:${t.traceHash}`, { ...t, status: "pending", attempts: 0 });
}

export async function publishPendingTraces(
  adapter: Pick<StellarAdapter, "agent" | "publishTrace">
    & Partial<Pick<StellarAdapter, "publishDecisionTrace">>,
  ctx: TaskContext,
): Promise<void> {
  for (const [key, t] of ctx.state.entries<PendingTrace>(TRACES)) {
    if (t.status !== "pending" || ctx.signal.aborted) continue;
    try {
      if (t.decisionHash && typeof adapter.publishDecisionTrace !== "function") {
        throw new Error("adapter cannot publish decision traces");
      }
      const res = await ctx.submit(
        () =>
          t.decisionHash
            ? adapter.publishDecisionTrace!({
                agent: adapter.agent,
                marketId: t.marketId,
                action: t.action,
                traceHash: t.traceHash,
                ipfsCid: t.cid,
                decisionHash: t.decisionHash!,
              })
            : adapter.publishTrace({
                agent: adapter.agent,
                market_id: t.marketId,
                action: t.action,
                trace_hash: Buffer.from(t.traceHash, "hex"),
                ipfs_cid: t.cid,
              }),
        `trace:${key}`,
      );
      const updated: PendingTrace = { ...t, status: "published", attempts: t.attempts + 1 };
      if (t.decisionHash) {
        if (!res || typeof (res as { traceId?: unknown }).traceId !== "bigint") {
          throw new Error("publishDecisionTrace did not return a trace id");
        }
        updated.traceId = (res as { traceId: bigint }).traceId;
      }
      ctx.state.set<PendingTrace>(TRACES, key, updated);
      ctx.log.info("TRACE_PUBLISHED", { key, res });
    } catch (err) {
      ctx.state.set<PendingTrace>(TRACES, key, { ...t, attempts: t.attempts + 1 });
      ctx.log.warn("TRACE_PUBLISH_FAILED", { key, attempts: t.attempts + 1, err });
      throw err;
    }
  }
}
