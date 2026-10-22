/**
 * Async coordination primitives: a FIFO mutex (the global submission
 * mutex), keyed mutexes (per-market advisory locks), and the maker/trader
 * handshake over which of our own markets are safe to trade.
 */
import type { StateStore } from "./state.js";

/** FIFO async mutex: callers run strictly one at a time, in arrival order. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get queued(): number {
    return this.waiting;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    this.waiting--;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** One {@link AsyncMutex} per key, dropped once idle. */
export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: AsyncMutex; users: number }>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) this.locks.set(key, (entry = { mutex: new AsyncMutex(), users: 0 }));
    entry.users++;
    try {
      return await entry.mutex.run(fn);
    } finally {
      if (--entry.users === 0) this.locks.delete(key);
    }
  }
}

export type OwnMarketStatus = "created" | "revealed";

const MARKETS = "markets";
const CREATING = "markets.creating";

/**
 * Per-market advisory locks plus the persisted lifecycle of markets this
 * agent creates. The maker calls {@link markCreating} (keyed by
 * question hash, since the id is unknown) before submitting a create,
 * {@link markCreated} once the id is known and {@link markRevealed} after
 * its spec reveal. The trader asks {@link ownMarketTradable} and skips our
 * own markets until they are revealed — trading a market whose resolution
 * spec is not registered yet would put capital into a market that may never
 * resolve normally.
 */
export class MarketLocks {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly state: StateStore) {}

  withLock<T>(marketId: bigint | number | string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(`market:${marketId}`, fn);
  }

  markCreating(questionHash: string): void {
    this.state.set(CREATING, questionHash, { since: Date.now() });
  }

  clearCreating(questionHash: string): void {
    this.state.delete(CREATING, questionHash);
  }

  isCreating(questionHash: string): boolean {
    return this.state.get(CREATING, questionHash) !== undefined;
  }

  markCreated(marketId: bigint | number | string, questionHash: string): void {
    this.state.set<{ status: OwnMarketStatus; questionHash: string }>(MARKETS, String(marketId), { status: "created", questionHash });
  }

  markRevealed(marketId: bigint | number | string): void {
    const prev = this.state.get<{ questionHash: string }>(MARKETS, String(marketId));
    this.state.set(MARKETS, String(marketId), { status: "revealed", questionHash: prev?.questionHash });
  }

  status(marketId: bigint | number | string): OwnMarketStatus | undefined {
    return this.state.get<{ status: OwnMarketStatus }>(MARKETS, String(marketId))?.status;
  }

  /** For a market created by this agent's treasury: tradable only once revealed. */
  ownMarketTradable(marketId: bigint | number | string, questionHash?: string): boolean {
    if (questionHash && this.isCreating(questionHash)) return false;
    return this.status(marketId) === "revealed";
  }
}
