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
  status: "pending" | "published";
  attempts: number;
}

export function recordPendingTrace(ctx: TaskContext, t: Omit<PendingTrace, "status" | "attempts">): void {
  ctx.state.set<PendingTrace>(TRACES, `${t.marketId}:${t.action}:${t.traceHash}`, { ...t, status: "pending", attempts: 0 });
}

export async function publishPendingTraces(
  adapter: Pick<StellarAdapter, "agent" | "publishTrace">,
  ctx: TaskContext,
): Promise<void> {
  for (const [key, t] of ctx.state.entries<PendingTrace>(TRACES)) {
    if (t.status !== "pending" || ctx.signal.aborted) continue;
    try {
      const res = await ctx.submit(
        () =>
          adapter.publishTrace({
            agent: adapter.agent,
            market_id: t.marketId,
            action: t.action,
            trace_hash: Buffer.from(t.traceHash, "hex"),
            ipfs_cid: t.cid,
          }),
        `trace:${key}`,
      );
      ctx.state.set<PendingTrace>(TRACES, key, { ...t, status: "published", attempts: t.attempts + 1 });
      ctx.log.info("TRACE_PUBLISHED", { key, res });
    } catch (err) {
      ctx.state.set<PendingTrace>(TRACES, key, { ...t, attempts: t.attempts + 1 });
      ctx.log.warn("TRACE_PUBLISH_FAILED", { key, attempts: t.attempts + 1, err });
      throw err;
    }
  }
}
