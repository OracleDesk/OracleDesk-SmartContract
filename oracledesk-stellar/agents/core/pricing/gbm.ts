/**
 * Closed-form Geometric Brownian Motion (GBM) threshold probability model
 * and standard normal CDF approximation (#112).
 */
import { MAX_PROB_BPS, MIN_PROB_BPS } from "../fpmm.js";

export const SECONDS_PER_YEAR = 365.25 * 86_400; // 31,557,600

/**
 * Standard normal cumulative distribution function Phi(x) using
 * Abramowitz & Stegun 26.2.17 rational approximation (max absolute error < 7.5e-8).
 * Guarantees exact symmetry `normCdf(x) + normCdf(-x) === 1`.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) {
    throw new Error("normCdf: x must not be NaN");
  }
  if (x === 0) return 0.5;
  if (x <= -10) return 0;
  if (x >= 10) return 1;

  const absX = Math.abs(x);
  const p = 0.2316419;
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * absX);
  const pdf = Math.exp(-0.5 * absX * absX) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const tail = pdf * poly;

  return x > 0 ? 1 - tail : tail;
}

export interface GbmThresholdParams {
  spot: number;
  strike: number;
  sigmaAnnual: number;
  muAnnual?: number;
  horizonSeconds: number;
  direction: "above" | "below";
}

/**
 * Computes P(S_T > K) (or P(S_T < K) when `direction === "below"`) under GBM:
 *   d2 = (ln(S_t / K) + (mu - 0.5 * sigma^2) * tau) / (sigma * sqrt(tau))
 * Clamped to `[MIN_PROB_BPS / 10000, MAX_PROB_BPS / 10000]` (`[0.01, 0.99]`).
 */
export function gbmThresholdProb(params: GbmThresholdParams): number {
  const { spot, strike, sigmaAnnual, horizonSeconds, direction } = params;
  const muAnnual = params.muAnnual ?? 0;

  if (spot <= 0 || strike <= 0) {
    throw new Error("gbmThresholdProb: spot and strike must be > 0");
  }

  const minProb = Number(MIN_PROB_BPS) / 10_000;
  const maxProb = Number(MAX_PROB_BPS) / 10_000;

  // Expired or zero-volatility boundary: deterministic intrinsic comparison
  if (horizonSeconds <= 0 || sigmaAnnual <= 0) {
    const raw =
      direction === "above"
        ? spot > strike
          ? 1
          : spot < strike
            ? 0
            : 0.5
        : spot < strike
          ? 1
          : spot > strike
            ? 0
            : 0.5;
    return Math.min(maxProb, Math.max(minProb, raw));
  }

  const tau = horizonSeconds / SECONDS_PER_YEAR;
  const volSqrtTau = sigmaAnnual * Math.sqrt(tau);
  const d2 = (Math.log(spot / strike) + (muAnnual - 0.5 * sigmaAnnual * sigmaAnnual) * tau) / volSqrtTau;

  const rawProb = direction === "above" ? normCdf(d2) : normCdf(-d2);
  return Math.min(maxProb, Math.max(minProb, rawProb));
}

export function probToBps(prob: number): number {
  const minBps = Number(MIN_PROB_BPS);
  const maxBps = Number(MAX_PROB_BPS);
  const bps = Math.round(prob * 10_000);
  return Math.min(maxBps, Math.max(minBps, bps));
}
