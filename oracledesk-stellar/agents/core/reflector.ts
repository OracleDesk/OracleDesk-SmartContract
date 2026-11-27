/**
 * Simulation-only Reflector (SEP-40) feed client for the fair-value
 * estimator (#331). Never signs or submits.
 *
 * - `decimals()`, `resolution()`, `lastprice(asset)`, `price(asset, ts)`
 * - per-call timeouts
 * - an LRU cache of historical records keyed by `(reflector, asset, ts)`:
 *   a past grid record never changes, so repeat estimates are cheap
 * - a bounded history walk on the grid
 *
 * Prices stay `bigint` in feed decimals. The transport (`call`) is injected:
 * the live adapter passes `StellarAdapter.simulateRead`, tests pass fakes.
 */
import type { PriceData } from "./strategies/grid.js";

/** Asset exactly as committed in the resolver spec: `OracleAsset`. */
export type OracleAssetArg = { tag: "Stellar"; value: string } | { tag: "Other"; value: string };

export function assetKey(a: OracleAssetArg): string {
  return `${a.tag === "Stellar" ? "stellar" : "other"}:${a.value}`;
}

export interface ReflectorFeed {
  decimals(reflector: string): Promise<number>;
  resolution(reflector: string): Promise<bigint>;
  lastPrice(reflector: string, asset: OracleAssetArg): Promise<PriceData | null>;
  price(reflector: string, asset: OracleAssetArg, ts: bigint): Promise<PriceData | null>;
}

/** Raw SEP-40 transport: simulate `method` on `reflector` and decode the result. */
export interface ReflectorTransport {
  decimals(reflector: string): Promise<number>;
  resolution(reflector: string): Promise<number | bigint>;
  lastPrice(reflector: string, asset: OracleAssetArg): Promise<{ price: bigint; timestamp: bigint } | null | undefined>;
  price(reflector: string, asset: OracleAssetArg, ts: bigint): Promise<{ price: bigint; timestamp: bigint } | null | undefined>;
}

export class FeedTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`reflector ${what} timed out after ${ms}ms`);
    this.name = "FeedTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FeedTimeoutError(what, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Small insertion-ordered LRU. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  has(k: K): boolean {
    return this.map.has(k);
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  get size(): number {
    return this.map.size;
  }
}

export interface ReflectorClientOptions {
  timeoutMs?: number;
  cacheSize?: number;
}

/** A cached, timed `ReflectorFeed` over a transport. */
export function createReflectorFeed(t: ReflectorTransport, opts: ReflectorClientOptions = {}): ReflectorFeed & {
  cache: Lru<string, PriceData | null>;
} {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cache = new Lru<string, PriceData | null>(opts.cacheSize ?? 4_096);
  const meta = new Map<string, Promise<unknown>>();
  const norm = (r: { price: bigint; timestamp: bigint } | null | undefined): PriceData | null =>
    r ? { price: BigInt(r.price), timestamp: BigInt(r.timestamp) } : null;
  return {
    cache,
    decimals(reflector) {
      const k = `dec:${reflector}`;
      if (!meta.has(k)) meta.set(k, withTimeout(t.decimals(reflector), timeoutMs, "decimals()").then(Number).catch((e) => {
        meta.delete(k);
        throw e;
      }));
      return meta.get(k) as Promise<number>;
    },
    resolution(reflector) {
      const k = `res:${reflector}`;
      if (!meta.has(k)) meta.set(k, withTimeout(t.resolution(reflector), timeoutMs, "resolution()").then((r) => BigInt(r)).catch((e) => {
        meta.delete(k);
        throw e;
      }));
      return meta.get(k) as Promise<bigint>;
    },
    async lastPrice(reflector, asset) {
      return norm(await withTimeout(t.lastPrice(reflector, asset), timeoutMs, "lastprice()"));
    },
    async price(reflector, asset, ts) {
      const k = `${reflector}|${assetKey(asset)}|${ts}`;
      if (cache.has(k)) return cache.get(k) ?? null;
      const r = norm(await withTimeout(t.price(reflector, asset, ts), timeoutMs, "price()"));
      cache.set(k, r);
      return r;
    },
  };
}

/**
 * Walks the grid back from `fromTs` (inclusive) one `resolution` at a time,
 * reading at most `maxReads` records. Missing records are skipped. Returns
 * ascending, de-duplicated points.
 */
export async function historyWalk(
  feed: ReflectorFeed,
  reflector: string,
  asset: OracleAssetArg,
  fromTs: bigint,
  resolution: bigint,
  maxReads: number,
): Promise<PriceData[]> {
  const seen = new Map<bigint, PriceData>();
  let ts = fromTs - (fromTs % resolution);
  for (let i = 0; i < maxReads && ts >= 0n; i++) {
    const r = await feed.price(reflector, asset, ts);
    if (r && r.price > 0n && !seen.has(r.timestamp)) seen.set(r.timestamp, r);
    if (ts < resolution) break;
    ts -= resolution;
  }
  return [...seen.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}
