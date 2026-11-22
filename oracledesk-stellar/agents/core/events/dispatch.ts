/**
 * Delivers decoded events to handlers (#105).
 *
 * - Events for one market run sequentially, in RPC order; different markets
 *   run concurrently, at most `concurrency` at a time. Events without a
 *   market share one sequential lane.
 * - Delivery is at least once (a crash before acknowledgment redelivers), so
 *   handlers must be idempotent. An LRU of processed event ids, persisted with
 *   the checkpoint, suppresses the common duplicates.
 * - A failing handler is retried with exponential backoff; once retries are
 *   exhausted the event is appended to the dead-letter log and the batch
 *   moves on, so one poisoned event cannot stall every market.
 * - `dispatch` resolves only when every handler for every event has finished
 *   (succeeded or been dead-lettered); that is the batch acknowledgment.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { marketOf, type EventKind, type OracleDeskEvent } from "./decode.js";

export interface EventHandler {
  name: string;
  /** Kinds this handler wants; the dispatcher skips the rest. */
  kinds: EventKind[];
  handle(event: OracleDeskEvent): Promise<void>;
}

/** Fixed-capacity set that forgets the oldest ids first. */
export class ProcessedLru {
  private readonly ids = new Map<string, true>();

  constructor(
    private readonly capacity = 10_000,
    initial: string[] = [],
  ) {
    for (const id of initial) this.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.set(id, true);
    while (this.ids.size > this.capacity) this.ids.delete(this.ids.keys().next().value!);
  }

  /** Oldest first, for persistence. */
  toJSON(): string[] {
    return [...this.ids.keys()];
  }
}

export interface DeadLetter {
  at: string;
  handler: string;
  attempts: number;
  error: string;
  event: OracleDeskEvent;
}

export interface DispatcherOptions {
  handlers: EventHandler[];
  lru?: ProcessedLru;
  concurrency?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** JSON Lines file; default ./.events/dead-letter.jsonl. */
  deadLetterPath?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class Dispatcher {
  readonly lru: ProcessedLru;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly deadLetterPath: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: DispatcherOptions) {
    this.lru = o.lru ?? new ProcessedLru();
    this.concurrency = Math.max(1, o.concurrency ?? 4);
    this.maxAttempts = Math.max(1, o.maxAttempts ?? 5);
    this.deadLetterPath = o.deadLetterPath ?? "./.events/dead-letter.jsonl";
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Delivers one batch; resolves once every event is handled or dead-lettered. */
  async dispatch(events: OracleDeskEvent[]): Promise<void> {
    const lanes = new Map<string, OracleDeskEvent[]>();
    for (const e of events) {
      if (this.lru.has(e.id)) {
        this.o.log?.("EVENT_DUPLICATE", { id: e.id });
        continue;
      }
      const key = marketOf(e)?.toString() ?? "global";
      lanes.set(key, [...(lanes.get(key) ?? []), e]);
    }
    const queue = [...lanes.values()];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift()) {
        for (const e of lane) await this.deliver(e);
      }
    });
    await Promise.all(workers);
  }

  private async deliver(e: OracleDeskEvent): Promise<void> {
    for (const h of this.o.handlers) {
      if (!h.kinds.includes(e.kind)) continue;
      await this.withRetries(h, e);
    }
    this.lru.add(e.id);
  }

  private async withRetries(h: EventHandler, e: OracleDeskEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await h.handle(e);
        return;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (attempt >= this.maxAttempts) {
          this.deadLetter({ at: new Date().toISOString(), handler: h.name, attempts: attempt, error, event: e });
          return;
        }
        this.o.log?.("EVENT_HANDLER_RETRY", { handler: h.name, id: e.id, attempt, error });
        await this.sleep((this.o.backoffBaseMs ?? 500) * 2 ** (attempt - 1));
      }
    }
  }

  private deadLetter(entry: DeadLetter): void {
    mkdirSync(dirname(this.deadLetterPath), { recursive: true });
    appendFileSync(this.deadLetterPath, json(entry) + "\n");
    this.o.log?.("EVENT_DEAD_LETTER", { handler: entry.handler, id: entry.event.id, error: entry.error });
  }
}
