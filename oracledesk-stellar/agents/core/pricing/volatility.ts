/**
 * Annualized realized volatility estimator over irregular time-step oracle
 * price series with EWMA weighting and low-sample fallback (#112).
 */
import { SECONDS_PER_YEAR } from "./gbm.js";

export interface PricePoint {
  timestamp: number; // unix seconds
  price: bigint; // fixed-point oracle integer
}

export interface VolatilityOptions {
  /** EWMA decay factor in (0, 1). Default 0.94 (RiskMetrics). */
  ewmaLambda?: number;
  /** Minimum valid return intervals before trusting the sample estimate (default 10). */
  minSamples?: number;
  /** Fallback annualized volatility when samples < minSamples (default 0.80). */
  fallbackSigma?: number;
  /** Maximum allowed gap in seconds between consecutive observations (default 7200 = 2h). */
  maxGapSeconds?: number;
}

export interface VolatilityEstimate {
  sigmaAnnual: number;
  sampleCount: number;
  lowConfidence: boolean;
}

/**
 * Computes annualized volatility from an irregular timestamped oracle series.
 *
 * Each step's log return `r_i = ln(P_i / P_{i-1})` over interval `dt_i` seconds
 * contributes an annualized variance sample `v_i = (r_i^2) * (SECONDS_PER_YEAR / dt_i)`.
 * Intervals with `dt_i <= 0` or `dt_i > maxGapSeconds` (stale feed gap) are
 * skipped rather than interpolated.
 */
export function realizedVolatility(
  series: PricePoint[],
  opts: VolatilityOptions = {},
): VolatilityEstimate {
  const ewmaLambda = opts.ewmaLambda ?? 0.94;
  const minSamples = opts.minSamples ?? 10;
  const fallbackSigma = opts.fallbackSigma ?? 0.8;
  const maxGapSeconds = opts.maxGapSeconds ?? 7_200;

  const sorted = [...series]
    .filter((p) => p.price > 0n && Number.isFinite(p.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const annualizedSqReturns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (dt <= 0 || dt > maxGapSeconds) continue;
    const ratio = Number(sorted[i].price) / Number(sorted[i - 1].price);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const r = Math.log(ratio);
    annualizedSqReturns.push(r * r * (SECONDS_PER_YEAR / dt));
  }

  if (annualizedSqReturns.length < minSamples) {
    return {
      sigmaAnnual: fallbackSigma,
      sampleCount: annualizedSqReturns.length,
      lowConfidence: true,
    };
  }

  // Blend unbiased sample variance and EWMA variance so sudden volatility spikes
  // are captured while maintaining unbiased steady-state recovery on GBM paths.
  const meanVar =
    annualizedSqReturns.reduce((acc, v) => acc + v, 0) / annualizedSqReturns.length;
  let ewmaVar = annualizedSqReturns[0];
  for (let i = 1; i < annualizedSqReturns.length; i++) {
    ewmaVar = ewmaLambda * ewmaVar + (1 - ewmaLambda) * annualizedSqReturns[i];
  }
  const blendedVar = 0.5 * meanVar + 0.5 * ewmaVar;

  return {
    sigmaAnnual: Math.sqrt(Math.max(0, blendedVar)),
    sampleCount: annualizedSqReturns.length,
    lowConfidence: false,
  };
}
