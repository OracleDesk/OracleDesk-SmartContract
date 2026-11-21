/**
 * Trace availability service (#325).
 *
 * Walks every reasoning-registry trace from a persisted cursor, verifies what
 * the gateways serve (see core/availability.ts), re-pins from the agent's own
 * verified archive when possible, and raises a narrowly scoped `unavail` flag
 * only after a trace has failed for long enough across distinct ticks.
 */
import { probeTrace, type ProbeStatus } from "../../core/availability.js";
import type { PinProvider } from "../../core/ipfs-store.js";
import { classifySorobanError } from "../../stellar/errors.js";
import type { AdapterResult } from "../../stellar/adapter.js";
import type { AgentMode } from "../config.js";
import type { Task, TaskContext } from "../runtime.js";

export const AVAILABILITY_NS = "availability";
export const AVAILABILITY_KEY = "checkpoint";

export interface AvailabilityFailure {
  cid: string;
  firstSeen: number;
  lastSeen: number;
  /** Ids of the task ticks that saw a failure; one probe per id per tick. */
  seenTicks: number[];
  attempts: number;
  status: ProbeStatus | "archived";
  error?: string;
  flagged?: boolean;
  flaggedAt?: number;
}

export interface AvailabilityState {
  cursor: bigint;
  cycle: number;
  /** Monotonic task-tick counter; distinct from the registry scan cycle. */
  tick: number;
  failures: Record<string, AvailabilityFailure>;
}

export interface AvailabilityAdapter {
  mode: AgentMode;
  agent: string;
  traceCount(): Promise<bigint>;
  traceMetadata(traceId: bigint): Promise<{ cid: string; traceHash: string }>;
  reportUnavailable(args: { reporter: string; trace_id: bigint }): Promise<AdapterResult<void>>;
  clearUnavailable(args: { reporter: string; trace_id: bigint }): Promise<AdapterResult<void>>;
}

export interface AvailabilityArchive {
  readArchived(cid: string): Promise<Uint8Array | undefined>;
}

export interface AvailabilityDeps {
  adapter: AvailabilityAdapter;
  gateways: string[];
  /** Providers from the same IpfsTraceStore that published the trace. */
  providers: readonly PinProvider[];
  archive?: AvailabilityArchive;
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  flagAfterSecs?: number;
  flagAfterProbes?: number;
  /** Minimum seconds between toggles; mirrors the registry's rate limit. */
  minToggleSecs?: number;
  /** Test seam; defaults to core/availability's probeTrace. */
  probe?: typeof probeTrace;
}

export interface AvailabilityTaskOptions {
  intervalMs: number;
  jitterMs?: number;
}

const emptyState = (): AvailabilityState => ({ cursor: 0n, cycle: 0, tick: 0, failures: {} });

function isFailed(status: ProbeStatus | "archived"): boolean {
  return status === "mismatch" || status === "unreachable";
}

function distinctTicks(failure: AvailabilityFailure): number {
  return new Set(failure.seenTicks).size;
}

/** Keeps the persisted failure list bounded without losing the first-seen time. */
function remember(
  failure: AvailabilityFailure,
  tick: number,
  seenAtMs: number,
  status: ProbeStatus | "archived",
  error?: string,
): AvailabilityFailure {
  const seenTicks = failure.seenTicks.includes(tick) ? failure.seenTicks : [...failure.seenTicks, tick];
  return {
    ...failure,
    lastSeen: Math.floor(seenAtMs / 1000),
    seenTicks: seenTicks.slice(-64),
    attempts: failure.attempts + 1,
    status,
    error,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function availabilityTask(d: AvailabilityDeps, o: AvailabilityTaskOptions): Task {
  const batchSize = d.batchSize ?? 25;
  const concurrency = d.concurrency ?? 4;
  const timeoutMs = d.timeoutMs ?? 30_000;
  const maxBytes = d.maxBytes ?? 1024 * 1024;
  const flagAfterSecs = d.flagAfterSecs ?? 6 * 3600;
  const flagAfterProbes = d.flagAfterProbes ?? 3;
  const minToggleSecs = d.minToggleSecs ?? 24 * 3600;
  const probe = d.probe ?? probeTrace;

  async function rePin(ctx: TaskContext, id: bigint, cid: string): Promise<boolean> {
    if (!d.archive || d.providers.length === 0 || ctx.signal.aborted) return false;
    const bytes = await d.archive.readArchived(cid).catch((err) => {
      ctx.log.warn("AVAIL_ARCHIVE_READ_FAILED", { trace: id, err: String(err) });
      return undefined;
    });
    if (!bytes) return false;
    const results = await Promise.allSettled(
      d.providers.map((p) => p.pin(bytes, cid, AbortSignal.timeout(timeoutMs))),
    );
    const confirmed = results.filter((r) => r.status === "fulfilled").length;
    ctx.log.info("AVAIL_REPIN", { trace: id, cid, providers: d.providers.length, confirmed });
    if (confirmed === 0) return false;
    const again = await probe(
      { id, cid },
      d.gateways,
      { timeoutMs, maxBytes, signal: ctx.signal },
    );
    ctx.log.info("AVAIL_REPIN_PROBE", { trace: id, status: again.status, gateway: again.gateway });
    return again.status === "ok";
  }

  return {
    name: "availability",
    intervalMs: o.intervalMs,
    jitterMs: o.jitterMs,
    mode: d.adapter.mode,
    async run(ctx) {
      const state = ctx.state.get<AvailabilityState>(AVAILABILITY_NS, AVAILABILITY_KEY) ?? emptyState();
      state.tick += 1;
      const tick = state.tick;
      const total = await d.adapter.traceCount();
      const ids: bigint[] = [];
      const wrapped = total > 0n && state.cursor >= total;
      const cursor = wrapped ? 0n : state.cursor;
      for (let i = 0; i < batchSize && cursor + BigInt(i) < total; i++) ids.push(cursor + BigInt(i));
      const nextCursor = cursor + BigInt(ids.length);

      await mapWithConcurrency(ids, concurrency, async (id) => {
        if (ctx.signal.aborted) return;
        let meta: { cid: string; traceHash: string };
        try {
          meta = await d.adapter.traceMetadata(id);
        } catch (err) {
          if (classifySorobanError(err).kind === "archived_entry") {
            ctx.log.info("TRACE_ARCHIVED", { trace: id, cycle: state.cycle });
            delete state.failures[id.toString()];
          } else {
            ctx.log.warn("AVAIL_METADATA_FAILED", { trace: id, err: String(err) });
          }
          return;
        }

        const key = id.toString();
        const result = await probe(
          { id, cid: meta.cid, traceHash: meta.traceHash },
          d.gateways,
          { timeoutMs, maxBytes, signal: ctx.signal },
        );
        ctx.log.info("AVAIL_PROBE", { trace: id, status: result.status, gateway: result.gateway, cycle: state.cycle });

        if (result.status === "ok") {
          const prior = state.failures[key];
          if (prior?.flagged) {
            if (Math.floor(ctx.now() / 1000) - (prior.flaggedAt ?? 0) < minToggleSecs) {
              state.failures[key] = { ...prior, status: "ok", error: "toggle rate limit" };
              ctx.log.info("AVAIL_CLEAR_DEFERRED", { trace: id, waitSecs: minToggleSecs });
              return;
            }
            const call = () => d.adapter.clearUnavailable({ reporter: d.adapter.agent, trace_id: id });
            await ctx.submit(call, "availability.clear");
            if (d.adapter.mode === "dry-run") ctx.log.info("AVAIL_CLEAR_PLANNED", { trace: id });
            else ctx.log.info("AVAIL_CLEAR", { trace: id });
          }
          delete state.failures[key];
          return;
        }

        if (result.status === "unsupported") {
          // local:// CIDs are expected in dry-run; they are not a registry fault.
          if (meta.cid.startsWith("local://")) ctx.log.info("TRACE_LOCAL_CID", { trace: id, cycle: state.cycle });
          delete state.failures[key];
          return;
        }

        let final = result;
        if (isFailed(final.status) && (await rePin(ctx, id, meta.cid))) {
          final = { traceId: id, cid: meta.cid, status: "ok", gateway: "archive" };
          ctx.log.info("AVAIL_RECOVERED", { trace: id });
          const prior = state.failures[key];
          if (prior?.flagged) {
            if (Math.floor(ctx.now() / 1000) - (prior.flaggedAt ?? 0) < minToggleSecs) {
              state.failures[key] = { ...prior, status: "ok", error: "toggle rate limit" };
              return;
            }
            await ctx.submit(() => d.adapter.clearUnavailable({ reporter: d.adapter.agent, trace_id: id }), "availability.clear");
            ctx.log.info(d.adapter.mode === "dry-run" ? "AVAIL_CLEAR_PLANNED" : "AVAIL_CLEAR", { trace: id });
          }
          delete state.failures[key];
          return;
        }

        const prior = state.failures[key] ?? {
          cid: meta.cid,
          firstSeen: Math.floor(ctx.now() / 1000),
          lastSeen: 0,
          seenTicks: [],
          attempts: 0,
          status: final.status,
        };
        const failure = remember(prior, tick, ctx.now(), final.status, final.error);
        const elapsed = failure.lastSeen - failure.firstSeen;
        if (
          !failure.flagged &&
          distinctTicks(failure) >= flagAfterProbes &&
          failure.attempts >= flagAfterProbes &&
          elapsed >= flagAfterSecs &&
          !ctx.signal.aborted
        ) {
          await ctx.submit(() => d.adapter.reportUnavailable({ reporter: d.adapter.agent, trace_id: id }), "availability.flag");
          failure.flagged = d.adapter.mode !== "dry-run";
          failure.flaggedAt = Math.floor(ctx.now() / 1000);
          ctx.log.info(d.adapter.mode === "dry-run" ? "AVAIL_FLAG_PLANNED" : "AVAIL_FLAG", { trace: id, attempts: failure.attempts });
        }
        state.failures[key] = failure;
      });

      // Cursor is written only after every result is recorded: a crash must
      // re-probe, never silently skip a trace.
      state.cursor = nextCursor >= total ? 0n : nextCursor;
      if (total > 0n && (wrapped || nextCursor >= total)) state.cycle += 1;
      ctx.state.set(AVAILABILITY_NS, AVAILABILITY_KEY, state);
      await ctx.state.flush();
      ctx.log.info("AVAIL_CYCLE", { cycle: state.cycle, probed: ids.length, cursor: state.cursor.toString(), failures: Object.keys(state.failures).length });
    },
  };
}
