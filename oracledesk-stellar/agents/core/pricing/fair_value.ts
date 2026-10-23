/**
 * Fair-value estimator for price-threshold markets backed by Reflector oracle
 * history and GBM tail probabilities (#112).
 */
import type { ReferencePriceSource } from "../strategy.js";
import { gbmThresholdProb, probToBps } from "./gbm.js";
import { realizedVolatility, type PricePoint, type VolatilityOptions } from "./volatility.js";

export interface PriceMarketSpec {
  oracle: string;
  asset: string;
  threshold: bigint;
  comparison: "Gt" | "Gte" | "Lt" | "Lte";
  closeTime: number;
}

export interface ReflectorHistorySource {
  latestPrice(oracle: string, asset: string): Promise<PricePoint | null>;
  history(oracle: string, asset: string, lookbackSeconds: number): Promise<PricePoint[]>;
}

export interface FairValueProvenance {
  spot: string;
  strike: string;
  sigmaAnnual: number;
  horizonSeconds: number;
  sampleCount: number;
  direction: "above" | "below";
}

export interface FairValueEstimate {
  fairValueBps: number;
  confidence: number;
  lowConfidence: boolean;
  recommendedMinEdgeBps: number;
  inputs: FairValueProvenance;
}

export interface VolatilityFairValueOptions extends VolatilityOptions {
  lookbackSeconds?: number;
  maxOracleAgeSeconds?: number;
  baseMinEdgeBps?: number;
  now?: () => number;
}

export class VolatilityFairValueSource implements ReferencePriceSource {
  public readonly name = "gbm-volatility-fair-value";
  private readonly specsByQuestion = new Map<string, PriceMarketSpec>();

  constructor(
    private readonly oracleSource: ReflectorHistorySource,
    private readonly opts: VolatilityFairValueOptions = {},
  ) {}

  registerQuestionSpec(question: string, spec: PriceMarketSpec): void {
    this.specsByQuestion.set(question, spec);
  }

  async estimateMarket(spec: PriceMarketSpec): Promise<FairValueEstimate | null> {
    const now = (this.opts.now ?? (() => Math.floor(Date.now() / 1000)))();
    const maxOracleAge = this.opts.maxOracleAgeSeconds ?? 900; // 15 min
    const lookback = this.opts.lookbackSeconds ?? 7 * 86_400;
    const baseMinEdgeBps = this.opts.baseMinEdgeBps ?? 500;

    const latest = await this.oracleSource.latestPrice(spec.oracle, spec.asset);
    if (!latest || latest.price <= 0n) return null;
    if (now - latest.timestamp > maxOracleAge) {
      // Stale oracle feed — refuse to estimate
      return null;
    }

    const hist = await this.oracleSource.history(spec.oracle, spec.asset, lookback);
    const vol = realizedVolatility(hist, this.opts);
    const horizonSeconds = Math.max(0, spec.closeTime - now);
    const direction: "above" | "below" =
      spec.comparison === "Gt" || spec.comparison === "Gte" ? "above" : "below";

    // Both spot and strike are in the same fixed-point oracle decimals,
    // so the scale factor cancels in spot / strike.
    const spotNum = Number(latest.price);
    const strikeNum = Number(spec.threshold);
    const prob = gbmThresholdProb({
      spot: spotNum,
      strike: strikeNum,
      sigmaAnnual: vol.sigmaAnnual,
      horizonSeconds,
      direction,
    });
    const fairValueBps = probToBps(prob);
    const confidence = vol.lowConfidence ? 0.5 : Math.min(0.95, 0.6 + vol.sampleCount / 100);
    const recommendedMinEdgeBps = vol.lowConfidence
      ? Math.ceil(baseMinEdgeBps * 1.5)
      : baseMinEdgeBps;

    return {
      fairValueBps,
      confidence,
      lowConfidence: vol.lowConfidence,
      recommendedMinEdgeBps,
      inputs: {
        spot: latest.price.toString(),
        strike: spec.threshold.toString(),
        sigmaAnnual: vol.sigmaAnnual,
        horizonSeconds,
        sampleCount: vol.sampleCount,
        direction,
      },
    };
  }

  async fairValueBps(question: string): Promise<number | null> {
    const spec = this.specsByQuestion.get(question);
    if (!spec) return null;
    const est = await this.estimateMarket(spec);
    return est ? est.fairValueBps : null;
  }
}
