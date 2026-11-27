/**
 * `PriceRuleFairValue`: the volatility-model estimator as a
 * `MarketFairValueSource` (#331).
 *
 * For a market whose revealed spec is Price, ScaledPrice, Twap or Hybrid
 * (price leg) it reads the committed Reflector feed with the resolver's
 * grid, decimals and staleness rules, estimates per-slot volatility, and
 * prices the rule with `priceModel`. Every input lands in `model` so the
 * trace can be replayed.
 */
import type { FairValueResult, MarketFairValueSource } from "../strategy.js";
import { assetKey, historyWalk, type OracleAssetArg, type ReflectorFeed } from "../reflector.js";
import {
  collectTwapSamples,
  gridSlot,
  readFeedOnGrid,
  twapQuerySlots,
  twapSamplesValid,
  twapWeights,
  type Direction,
  type PriceData,
} from "./grid.js";
import {
  DEFAULT_LAMBDA,
  ewmaEffectiveSamples,
  ewmaVariance,
  garchLite,
  logReturnsReport,
  priceModel,
  SIGMA_FLOOR,
  VOL_MIN_SAMPLES,
  type PriceModel,
} from "./volatility.js";

/** A revealed price rule, decoded from resolver storage. */
export type PriceRule =
  | {
      kind: "spot";
      reflector: string;
      asset: OracleAssetArg;
      threshold: bigint;
      /** ScaledPriceConfig only; null means the threshold is in feed decimals. */
      thresholdDecimals: number | null;
      direction: Direction;
      maxStaleness: bigint;
      /** Present for Hybrid markets (signer fallback after this many secs). */
      hybridFallbackAfter?: bigint;
    }
  | {
      kind: "twap";
      reflector: string;
      asset: OracleAssetArg;
      threshold: bigint;
      direction: Direction;
      window: bigint;
      minSamples: number;
      maxGap: bigint;
    };

export interface PriceRuleFairValueOptions {
  /** Revealed rule lookup (`StellarAdapter.revealedPriceRule`). */
  rules: (marketId: bigint) => Promise<PriceRule | null>;
  feed: ReflectorFeed;
  /** Grid records read for volatility (default 96). */
  historySlots?: number;
  minSamples?: number;
  estimator?: "ewma" | "garch";
  lambda?: number;
  /** Hybrid markets: probability the price leg fails (default 2%). */
  hybridFeedFailureProb?: number;
}

const s = (v: bigint | number) => v.toString();

export class PriceRuleFairValue implements MarketFairValueSource {
  readonly name = "volatility-model";
  constructor(private readonly o: PriceRuleFairValueOptions) {}

  async estimate(m: { marketId: bigint; closeTime: bigint }, now: bigint): Promise<FairValueResult | null> {
    const model = await this.buildModel(m, now);
    if (!model) return null;
    const priced = priceModel(model);
    return {
      fairYesBps: priced.fairYesBps,
      uncertaintyBps: priced.uncertaintyBps,
      source: this.name,
      observedAt: Number(BigInt(model.spotTs)),
      model: model as unknown as Record<string, unknown>,
    };
  }

  /** Reads the feed and assembles the replayable model; null when no estimate. */
  async buildModel(m: { marketId: bigint; closeTime: bigint }, now: bigint): Promise<PriceModel | null> {
    const rule = await this.o.rules(m.marketId);
    if (!rule) return null;
    const { feed } = this.o;
    const [decimals, resolution] = await Promise.all([feed.decimals(rule.reflector), feed.resolution(rule.reflector)]);
    if (resolution <= 0n) return null;
    const last = await feed.lastPrice(rule.reflector, rule.asset);
    if (!last || last.price <= 0n) return null;
    const staleLimit = rule.kind === "spot" ? rule.maxStaleness : rule.maxGap;
    // A stale feed gives no estimate: the market might not resolve by price.
    if (now > last.timestamp && now - last.timestamp > staleLimit) return null;

    const history = await historyWalk(feed, rule.reflector, rule.asset, last.timestamp, resolution, this.o.historySlots ?? 96);
    const { returns } = logReturnsReport(
      history.map((p) => ({ ts: p.timestamp, price: p.price })),
      resolution,
    );
    if (returns.length < (this.o.minSamples ?? VOL_MIN_SAMPLES)) return null;
    const lambda = this.o.lambda ?? DEFAULT_LAMBDA;
    const estimator = this.o.estimator ?? "ewma";
    const variance =
      estimator === "garch" ? (garchLite(returns)?.nextVar ?? ewmaVariance(returns, lambda)) : ewmaVariance(returns, lambda);
    const sigma = Math.max(Math.sqrt(Math.max(variance, 0)), SIGMA_FLOOR);
    const nEff = estimator === "garch" ? returns.length : ewmaEffectiveSamples(returns.length, lambda);
    const sigmaStdErr = sigma / Math.sqrt(2 * nEff);
    const slot = gridSlot(m.closeTime, resolution);
    const refs = new Map<bigint, PriceData>();
    for (const p of history) refs.set(p.timestamp, p);
    refs.set(last.timestamp, last);

    const base = {
      reflector: rule.reflector,
      asset: assetKey(rule.asset),
      decimals,
      resolution: s(resolution),
      gridSlot: s(slot),
      threshold: s(rule.threshold),
      direction: rule.direction,
      sigmaPerSlot: sigma,
      sigmaStdErr,
      estimator,
      ...(estimator === "ewma" ? { lambda } : {}),
      samples: returns.length,
    };

    if (rule.kind === "spot") {
      let spot = last;
      let tau = slot > last.timestamp ? Number((slot - last.timestamp) / resolution) : 0;
      if (slot <= last.timestamp) {
        // The closing slot has printed: resolve it exactly like the resolver.
        const prefetched = new Map<bigint, PriceData | null>();
        let ts = slot;
        for (let i = 0; i < 12 && ts >= 0n; i++, ts -= resolution) {
          prefetched.set(ts, await feed.price(rule.reflector, rule.asset, ts));
          if (ts < resolution) break;
        }
        const read = readFeedOnGrid((t) => prefetched.get(t) ?? null, resolution, rule.maxStaleness, m.closeTime);
        if (!read.ok) return null;
        spot = read.value;
        tau = 0;
        refs.set(spot.timestamp, spot);
      }
      return {
        kind: "spot",
        ...base,
        spot: s(spot.price),
        spotTs: s(spot.timestamp),
        thresholdDecimals: rule.thresholdDecimals,
        tau,
        ...(rule.hybridFallbackAfter !== undefined ? { feedFailureProb: this.o.hybridFeedFailureProb ?? 0.02 } : {}),
        priceRefs: priceRefs(refs),
      };
    }

    // TWAP: realised slots come from the feed, future slots are assumed to print.
    const slots = twapQuerySlots(m.closeTime, rule.window, resolution);
    const printed = new Map<bigint, PriceData | null>();
    for (const ts of slots) if (ts <= last.timestamp) printed.set(ts, await feed.price(rule.reflector, rule.asset, ts));
    const collected = collectTwapSamples((t) => printed.get(t) ?? null, rule, resolution, m.closeTime);
    if (!collected.ok) return null;
    const realised = collected.value;
    for (const p of realised) refs.set(p.timestamp, p);
    const futureSlots = slots.filter((t) => t > last.timestamp).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const timeline = [...realised, ...futureSlots.map((timestamp) => ({ timestamp, price: 1n }))];
    if (!twapSamplesValid(timeline, rule, m.closeTime)) return null;
    let realisedTwap: string | undefined;
    if (futureSlots.length === 0) {
      const w = twapWeights(realised.map((p) => p.timestamp), m.closeTime);
      const sum = realised.reduce((acc, p, i) => acc + p.price * w[i]!, 0n);
      realisedTwap = s(sum / w.reduce((a, b) => a + b, 0n));
    }
    return {
      kind: "twap",
      ...base,
      spot: s(last.price),
      spotTs: s(last.timestamp),
      thresholdDecimals: null,
      tau: futureSlots.length ? Number((futureSlots[futureSlots.length - 1]! - last.timestamp) / resolution) : 0,
      twap: {
        window: s(rule.window),
        closeTime: s(m.closeTime),
        minSamples: rule.minSamples,
        maxGap: s(rule.maxGap),
        realised: realised.map((p) => ({ ts: s(p.timestamp), price: s(p.price) })),
        futureSlots: futureSlots.map(s),
        ...(realisedTwap !== undefined ? { realisedTwap } : {}),
      },
      priceRefs: priceRefs(refs),
    };
  }
}

function priceRefs(refs: Map<bigint, PriceData>): { ts: string; price: string }[] {
  return [...refs.values()]
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    .map((p) => ({ ts: s(p.timestamp), price: s(p.price) }));
}
