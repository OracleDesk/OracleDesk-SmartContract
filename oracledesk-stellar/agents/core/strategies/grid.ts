/**
 * TypeScript mirror of the resolver's SEP-40 grid reads (#331).
 *
 * Pure functions over a synchronous price lookup, so the same code checks
 * shared vectors (`docs/vectors/price-grid-v1.json`), computes the realised
 * part of a TWAP for the estimator, and replays traces. Every rule follows
 * `contracts/resolver/src/lib.rs` exactly:
 *
 * - `readFeedOnGrid` = `read_feed_on_grid` + `validate_price`
 * - `twapOutcome`    = `twap_outcome` (sampling, dedupe, gap checks,
 *   weights, floored average)
 * - `comparePrice` / `rescale` = `compare_price` / `rescale`
 *
 * All prices stay `bigint` in feed decimals.
 */

export type Direction = "Above" | "AtOrAbove" | "Below" | "AtOrBelow";
export type Outcome = "Yes" | "No";
export type GridError = "StalePrice" | "InvalidPrice" | "PriceUnavailable";

export interface PriceData {
  price: bigint;
  timestamp: bigint;
}

/** Record stored at exactly `ts` (SEP-40 `price(asset, ts)`), or null. Throwing = `PriceUnavailable`. */
export type PriceLookup = (ts: bigint) => PriceData | null | undefined;

export type GridResult<T> = { ok: true; value: T; queried: bigint[] } | { ok: false; error: GridError; queried: bigint[] };

/** `MAX_LOOKBACK_RECORDS` in the resolver. */
export const MAX_LOOKBACK_RECORDS = 12;
/** `MAX_TWAP_SAMPLES` in the resolver. */
export const MAX_TWAP_SAMPLES = 32;

/** The newest grid slot at or before `closeTime`. */
export function gridSlot(closeTime: bigint, resolution: bigint): bigint {
  if (resolution <= 0n) throw new Error("resolution must be positive");
  return closeTime - (closeTime % resolution);
}

export function comparePrice(direction: Direction, price: bigint, threshold: bigint): Outcome {
  const hit =
    direction === "Above" ? price > threshold
    : direction === "AtOrAbove" ? price >= threshold
    : direction === "Below" ? price < threshold
    : price <= threshold;
  return hit ? "Yes" : "No";
}

/** Both sides to `max(priceDecimals, thresholdDecimals)`, as the resolver's `rescale`. */
export function rescale(
  price: bigint,
  priceDecimals: number,
  threshold: bigint,
  thresholdDecimals: number,
): { price: bigint; threshold: bigint; decimals: number } {
  const target = Math.max(priceDecimals, thresholdDecimals);
  return {
    price: price * 10n ** BigInt(target - priceDecimals),
    threshold: threshold * 10n ** BigInt(target - thresholdDecimals),
    decimals: target,
  };
}

function validatePrice(maxStaleness: bigint, closeTime: bigint, data: PriceData): GridError | undefined {
  if (data.price <= 0n) return "InvalidPrice";
  if (data.timestamp > closeTime || closeTime - data.timestamp > maxStaleness) return "StalePrice";
  return undefined;
}

/** `read_feed_on_grid`: aligned slot, then bounded lookback within staleness. */
export function readFeedOnGrid(
  lookup: PriceLookup,
  resolution: bigint,
  maxStaleness: bigint,
  closeTime: bigint,
): GridResult<PriceData> {
  const queried: bigint[] = [];
  if (resolution === 0n) return { ok: false, error: "InvalidPrice", queried };
  let ts = gridSlot(closeTime, resolution);
  let inspected = 1;
  for (;;) {
    queried.push(ts);
    let data: PriceData | null | undefined;
    try {
      data = lookup(ts);
    } catch {
      return { ok: false, error: "PriceUnavailable", queried };
    }
    if (data) {
      const err = validatePrice(maxStaleness, closeTime, data);
      return err ? { ok: false, error: err, queried } : { ok: true, value: data, queried };
    }
    if (ts < resolution || closeTime - ts + resolution > maxStaleness || inspected >= MAX_LOOKBACK_RECORDS) {
      return { ok: false, error: "StalePrice", queried };
    }
    ts -= resolution;
    inspected += 1;
  }
}

/** Grid timestamps a TWAP queries, newest first, capped at `MAX_TWAP_SAMPLES`. */
export function twapQuerySlots(closeTime: bigint, window: bigint, resolution: bigint): bigint[] {
  const end = gridSlot(closeTime, resolution);
  const start = closeTime > window ? closeTime - window : 0n;
  const out: bigint[] = [];
  let ts = end;
  while (ts > start && out.length < MAX_TWAP_SAMPLES) {
    out.push(ts);
    if (ts < resolution) break;
    ts -= resolution;
  }
  return out;
}

/**
 * Weight of each sample (ascending timestamps): time to the next sample,
 * and `closeTime - last + 1` for the newest (ADR 0001).
 */
export function twapWeights(sampleTs: readonly bigint[], closeTime: bigint): bigint[] {
  return sampleTs.map((ts, i) => (i + 1 < sampleTs.length ? sampleTs[i + 1]! : closeTime + 1n) - ts);
}

export interface TwapRule {
  threshold: bigint;
  direction: Direction;
  window: bigint;
  minSamples: number;
  maxGap: bigint;
}

export interface TwapValue {
  twap: bigint;
  samples: PriceData[];
  firstTs: bigint;
  lastTs: bigint;
  outcome: Outcome;
}

/** Collects TWAP samples exactly as `twap_outcome` does (ascending, deduped). */
export function collectTwapSamples(
  lookup: PriceLookup,
  rule: Pick<TwapRule, "window">,
  resolution: bigint,
  closeTime: bigint,
): GridResult<PriceData[]> {
  const queried: bigint[] = [];
  if (resolution === 0n) return { ok: false, error: "InvalidPrice", queried };
  const start = closeTime > rule.window ? closeTime - rule.window : 0n;
  const samples: PriceData[] = [];
  for (const ts of twapQuerySlots(closeTime, rule.window, resolution)) {
    queried.push(ts);
    let data: PriceData | null | undefined;
    try {
      data = lookup(ts);
    } catch {
      return { ok: false, error: "PriceUnavailable", queried };
    }
    if (!data) continue;
    if (data.price <= 0n) return { ok: false, error: "InvalidPrice", queried };
    if (data.timestamp > closeTime) return { ok: false, error: "StalePrice", queried };
    if (data.timestamp > start) {
      const head = samples[0];
      if (!(head && data.timestamp >= head.timestamp)) samples.unshift(data);
    }
  }
  return { ok: true, value: samples, queried };
}

/** Min-samples and the three gap checks of `twap_outcome`. */
export function twapSamplesValid(
  samples: readonly PriceData[],
  rule: Pick<TwapRule, "window" | "minSamples" | "maxGap">,
  closeTime: bigint,
): boolean {
  if (samples.length < rule.minSamples || samples.length === 0) return false;
  const start = closeTime > rule.window ? closeTime - rule.window : 0n;
  const first = samples[0]!.timestamp;
  const last = samples[samples.length - 1]!.timestamp;
  if (first - start > rule.maxGap || closeTime - last > rule.maxGap) return false;
  for (let i = 1; i < samples.length; i++)
    if (samples[i]!.timestamp - samples[i - 1]!.timestamp > rule.maxGap) return false;
  return true;
}

/** `twap_outcome`: floored, time-weighted average compared with the threshold. */
export function twapOutcome(
  lookup: PriceLookup,
  rule: TwapRule,
  resolution: bigint,
  closeTime: bigint,
): GridResult<TwapValue> {
  const collected = collectTwapSamples(lookup, rule, resolution, closeTime);
  if (!collected.ok) return collected;
  const samples = collected.value;
  if (!twapSamplesValid(samples, rule, closeTime))
    return { ok: false, error: "StalePrice", queried: collected.queried };
  const weights = twapWeights(samples.map((s) => s.timestamp), closeTime);
  let sum = 0n;
  let total = 0n;
  samples.forEach((s, i) => {
    sum += s.price * weights[i]!;
    total += weights[i]!;
  });
  const twap = sum / total; // bigint division floors for positive values
  return {
    ok: true,
    queried: collected.queried,
    value: {
      twap,
      samples,
      firstTs: samples[0]!.timestamp,
      lastTs: samples[samples.length - 1]!.timestamp,
      outcome: comparePrice(rule.direction, twap, rule.threshold),
    },
  };
}
