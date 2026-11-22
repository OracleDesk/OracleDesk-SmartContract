/**
 * PriceRuleSource (#275): re-derives a price market's outcome from the
 * Reflector (SEP-40) feed, reading the same record the resolver's
 * `read_feed_on_grid` reads: the newest record on the oracle's resolution grid
 * at or before `close_time`, walking back while it is still within
 * `max_staleness`, at most {@link MAX_LOOKBACK_RECORDS} records.
 */
import type { AttestedOutcome } from "../events/decode.js";
import type { OracleAsset, PriceQuestion } from "./question.js";
import type { OutcomeSource, OutcomeVerdict, WatchedMarket } from "./types.js";

/** Mirrors the resolver's MAX_LOOKBACK_RECORDS. */
export const MAX_LOOKBACK_RECORDS = 12;

export interface PriceRecord {
  price: bigint;
  /** Record timestamp, unix seconds. */
  timestamp: bigint;
}

/** The read side of a Reflector contract. */
export interface ReflectorReader {
  /** Seconds between records. */
  resolution(): Promise<number>;
  /** `undefined` when the oracle has no record at exactly `timestamp`. */
  price(asset: OracleAsset, timestamp: bigint): Promise<PriceRecord | undefined>;
}

export interface PriceRuleOptions {
  /** Reads the question the market's `meta_uri` declares; `undefined` = not a price market. */
  loadQuestion: (metaUri: string, signal: AbortSignal) => Promise<PriceQuestion | undefined>;
  reflector: (address: string) => ReflectorReader;
  /** A margin at least this wide (bps of the threshold) earns the maximum confidence. Default 100 (1%). */
  fullConfidenceMarginBps?: number;
  /** Margins up to this many price units from the threshold are "within a tick": confidence 0. Default 1. */
  tickUnits?: bigint;
}

/** Highest confidence this source ever reports: the feed is a witness, not a proof. */
export const PRICE_MAX_CONFIDENCE_BPS = 9_900;
const BPS = 10_000n;

export function compare(direction: PriceQuestion["direction"], price: bigint, threshold: bigint): AttestedOutcome {
  const hit =
    direction === "Above" ? price > threshold
    : direction === "AtOrAbove" ? price >= threshold
    : direction === "Below" ? price < threshold
    : price <= threshold;
  return hit ? "Yes" : "No";
}

/**
 * Confidence from the margin between price and threshold. Within `tickUnits`
 * of the threshold a single feed tick could flip the outcome, so confidence is
 * zero. Beyond it, confidence rises linearly from 5_000 to the cap as the
 * margin approaches `fullMarginBps` of the threshold.
 */
export function marginConfidenceBps(price: bigint, threshold: bigint, tickUnits: bigint, fullMarginBps: number): number {
  const margin = price > threshold ? price - threshold : threshold - price;
  if (margin <= tickUnits) return 0;
  const base = threshold === 0n ? price : threshold;
  const marginBps = base === 0n ? 0n : (margin * BPS) / (base < 0n ? -base : base);
  const full = BigInt(fullMarginBps);
  if (marginBps >= full) return PRICE_MAX_CONFIDENCE_BPS;
  const span = BigInt(PRICE_MAX_CONFIDENCE_BPS - 5_000);
  return Number(5_000n + (marginBps * span) / full);
}

export class PriceRuleSource implements OutcomeSource {
  readonly name = "price-rule";
  constructor(private readonly o: PriceRuleOptions) {}

  supports(m: WatchedMarket): boolean {
    return m.metaUri !== undefined && m.metaUri !== "";
  }

  async determine(m: WatchedMarket, signal: AbortSignal): Promise<OutcomeVerdict | undefined> {
    if (!m.metaUri) return undefined;
    const q = await this.o.loadQuestion(m.metaUri, signal);
    if (!q) return undefined;
    const closeTime = BigInt(q.closeTime);
    const feed = this.o.reflector(q.reflector);
    const found = await readOnGrid(feed, q, closeTime);
    if (!found) {
      // History retention can drop the close-time record: no evidence, no dispute.
      return { outcome: "Invalid", confidenceBps: 0, evidence: { reason: "no record on the close-time grid", closeTime: closeTime.toString() } };
    }
    const threshold = BigInt(q.threshold);
    return {
      outcome: compare(q.direction, found.price, threshold),
      confidenceBps: marginConfidenceBps(found.price, threshold, this.o.tickUnits ?? 1n, this.o.fullConfidenceMarginBps ?? 100),
      evidence: {
        asset: q.asset,
        direction: q.direction,
        threshold: threshold.toString(),
        price: found.price.toString(),
        recordTimestamp: found.timestamp.toString(),
        closeTime: closeTime.toString(),
      },
    };
  }
}

/** The resolver's grid read, in TypeScript. */
export async function readOnGrid(feed: ReflectorReader, q: PriceQuestion, closeTime: bigint): Promise<PriceRecord | undefined> {
  const res = BigInt(await feed.resolution());
  if (res <= 0n) return undefined;
  const maxStaleness = BigInt(q.maxStaleness);
  let ts = closeTime - (closeTime % res);
  for (let inspected = 1; ; inspected++) {
    const rec = await feed.price(q.asset, ts);
    if (rec) {
      // validate_price: positive, not after close, not older than max_staleness.
      if (rec.price <= 0n || rec.timestamp > closeTime || closeTime - rec.timestamp > maxStaleness) return undefined;
      return rec;
    }
    if (ts < res || closeTime - ts + res > maxStaleness || inspected >= MAX_LOOKBACK_RECORDS) return undefined;
    ts -= res;
  }
}
