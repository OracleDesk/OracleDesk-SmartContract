/**
 * Polls Soroban RPC `getEvents` and hands decoded OracleDesk events to a
 * batch handler (#105). This is a trigger system, not an indexer: it keeps
 * only a cursor, the last ledger it covered and recently processed ids.
 *
 * - The checkpoint `{cursor, lastLedger}` is written only after the batch
 *   handler resolves (acknowledges). A crash before that redelivers the batch.
 * - With no checkpoint it starts at the latest ledger; history is not replayed.
 * - If RPC retention has moved past `lastLedger`, the missed events cannot be
 *   fetched: it calls `onResync` for a full state reload and restarts at the tip.
 * - Idle polls still advance the checkpoint, so a quiet period never looks
 *   like a retention gap.
 * - Events from failed contract calls are dropped; filters are checked
 *   against the RPC's limits up front.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { rpc } from "@stellar/stellar-sdk";
import type { EventDecoder, OracleDeskEvent } from "./decode.js";

/** Soroban RPC getEvents limits. */
export const RPC_LIMITS = { filters: 5, contractIds: 5, topicFilters: 5, topicSegments: 4, pageLimit: 10_000 } as const;

export interface Checkpoint {
  cursor?: string;
  /** Highest ledger whose events have all been acknowledged. */
  lastLedger?: number;
  /** Recently processed event ids (the dispatcher's LRU), oldest first. */
  processed: string[];
}

export interface CheckpointStore {
  load(): Promise<Checkpoint>;
  save(cp: Checkpoint): Promise<void>;
}

/** The two RPC calls the subscriber needs; `rpc.Server` satisfies it. */
export interface EventsRpc {
  getEvents: rpc.Server["getEvents"];
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * One JSON file per (network, contract set) under `dir`, written atomically
 * (temp file + rename) so a crash never leaves a torn checkpoint.
 */
export class FileCheckpointStore implements CheckpointStore {
  readonly path: string;

  constructor(dir: string, key: { network: string; contractIds: string[] }) {
    mkdirSync(dir, { recursive: true });
    const identity = createHash("sha256").update([...key.contractIds].sort().join(",")).digest("hex").slice(0, 16);
    this.path = join(dir, `${key.network}-${identity}.json`);
  }

  async load(): Promise<Checkpoint> {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Checkpoint>;
      return { cursor: raw.cursor, lastLedger: raw.lastLedger, processed: raw.processed ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { processed: [] };
      throw err;
    }
  }

  async save(cp: Checkpoint): Promise<void> {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp, null, 2));
    renameSync(tmp, this.path);
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  saved: Checkpoint = { processed: [] };
  saves = 0;
  async load(): Promise<Checkpoint> {
    return structuredClone(this.saved);
  }
  async save(cp: Checkpoint): Promise<void> {
    this.saved = structuredClone(cp);
    this.saves++;
  }
}

export interface SubscriberOptions {
  rpc: EventsRpc;
  decoder: EventDecoder;
  checkpoints: CheckpointStore;
  /** Defaults to one contract filter over every contract the decoder knows. */
  filters?: rpc.Api.EventFilter[];
  pageLimit?: number;
  pollIntervalMs?: number;
  /** Handles one page of events; resolving acknowledges it. */
  onBatch: (events: OracleDeskEvent[]) => Promise<void>;
  /** Called after a retention gap, before restarting at the tip. */
  onResync: (reason: string) => Promise<void>;
  /** The dispatcher's processed ids, persisted with each checkpoint. */
  processedIds?: () => string[];
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class RpcFilterError extends Error {}

/** Throws if `filters` exceed what Soroban RPC accepts. */
export function checkFilters(filters: rpc.Api.EventFilter[]): void {
  if (filters.length === 0) throw new RpcFilterError("at least one event filter is required");
  if (filters.length > RPC_LIMITS.filters) throw new RpcFilterError(`at most ${RPC_LIMITS.filters} filters per request, got ${filters.length}`);
  for (const [i, f] of filters.entries()) {
    if ((f.contractIds?.length ?? 0) > RPC_LIMITS.contractIds) {
      throw new RpcFilterError(`filter ${i}: at most ${RPC_LIMITS.contractIds} contract ids, got ${f.contractIds!.length}`);
    }
    if ((f.topics?.length ?? 0) > RPC_LIMITS.topicFilters) {
      throw new RpcFilterError(`filter ${i}: at most ${RPC_LIMITS.topicFilters} topic filters, got ${f.topics!.length}`);
    }
    for (const t of f.topics ?? []) {
      if (t.length === 0 || t.length > RPC_LIMITS.topicSegments) {
        throw new RpcFilterError(`filter ${i}: a topic filter needs 1-${RPC_LIMITS.topicSegments} segments, got ${t.length}`);
      }
    }
  }
}

/** True when an RPC error means the requested ledger or cursor is outside retention. */
export function isRetentionError(err: unknown): boolean {
  const message = typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return /oldest ledger|out of (?:the )?(?:retention|range)|ledger range|before the oldest|cursor .*(?:too old|not found|invalid)/i.test(message);
}

export class EventSubscriber {
  private readonly filters: rpc.Api.EventFilter[];
  private readonly pageLimit: number;
  private stopped = false;

  constructor(private readonly o: SubscriberOptions) {
    this.filters = o.filters ?? [{ type: "contract", contractIds: o.decoder.contractIds() }];
    checkFilters(this.filters);
    this.pageLimit = o.pageLimit ?? 100;
    if (this.pageLimit < 1 || this.pageLimit > RPC_LIMITS.pageLimit) {
      throw new RpcFilterError(`page limit must be 1-${RPC_LIMITS.pageLimit}, got ${this.pageLimit}`);
    }
  }

  private log(event: string, fields?: Record<string, unknown>): void {
    this.o.log?.(event, fields);
  }

  private async save(cp: Omit<Checkpoint, "processed">): Promise<void> {
    await this.o.checkpoints.save({ ...cp, processed: this.o.processedIds?.() ?? [] });
  }

  private async resync(reason: string, latest: number): Promise<void> {
    this.log("EVENTS_RETENTION_GAP", { reason });
    await this.o.onResync(reason);
    await this.save({ cursor: undefined, lastLedger: latest });
  }

  /**
   * Fetches every page available now, acknowledging each before the next.
   * Returns the number of events delivered.
   */
  async pollOnce(): Promise<number> {
    const cp = await this.o.checkpoints.load();
    const latest = (await this.o.rpc.getLatestLedger()).sequence;
    if (cp.lastLedger === undefined) {
      // No checkpoint: start at the tip rather than replaying history.
      await this.save({ cursor: undefined, lastLedger: latest });
      this.log("EVENTS_START_AT_TIP", { ledger: latest });
      return 0;
    }
    let cursor = cp.cursor;
    let lastLedger = cp.lastLedger;
    let delivered = 0;
    for (;;) {
      const request = (cursor
        ? { filters: this.filters, cursor, limit: this.pageLimit }
        : { filters: this.filters, startLedger: lastLedger + 1, limit: this.pageLimit }) as rpc.Server.GetEventsRequest;
      let page: rpc.Api.GetEventsResponse;
      try {
        page = await this.o.rpc.getEvents(request);
      } catch (err) {
        if (isRetentionError(err)) {
          await this.resync(`ledger ${lastLedger + 1} is outside RPC retention`, latest);
          return delivered;
        }
        throw err;
      }
      if (page.oldestLedger > lastLedger + 1) {
        await this.resync(`RPC retention starts at ledger ${page.oldestLedger}, after ${lastLedger}`, page.latestLedger);
        return delivered;
      }
      const events = page.events
        .filter((e) => e.inSuccessfulContractCall)
        .map((e) => this.o.decoder.decode(e))
        .filter((e): e is OracleDeskEvent => e !== undefined);
      const full = page.events.length >= this.pageLimit;
      if (events.length > 0) await this.o.onBatch(events);
      delivered += events.length;
      cursor = page.cursor || cursor;
      // A full page may stop mid-ledger, so only the ledger before its last event is complete.
      lastLedger = full ? Math.max(lastLedger, page.events.at(-1)!.ledger - 1) : Math.max(lastLedger, page.latestLedger);
      await this.save({ cursor, lastLedger });
      if (!full) return delivered;
    }
  }

  /** Polls until `stop()`; `sleep` is injectable for tests. */
  async run(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce();
      if (!this.stopped) await sleep(this.o.pollIntervalMs ?? 10_000);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
