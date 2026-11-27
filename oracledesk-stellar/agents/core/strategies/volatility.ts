/**
 * Volatility-model fair value for price-threshold markets (#331, completes #112).
 *
 * Driftless lognormal model on the feed's own grid: one "slot" is one
 * `resolution()` step, so σ² is a per-slot variance and τ an exact slot
 * count. Prices stay `bigint` in feed decimals until they are converted to
 * floats right before taking logs.
 *
 * - Spot rules (Price / ScaledPrice / Hybrid price leg): a digital option,
 *   `P(S_T ≥ m) = Φ((ln(S/K) − σ²τ/2) / (σ√τ))` with `K = m − ½ tick`
 *   (continuity correction on the integer feed grid). `m` is the smallest
 *   feed-unit price that resolves YES, derived from the direction and the
 *   resolver's rescaling, so `Above` / `AtOrAbove` differ by exactly a tick.
 * - TWAP rules: the realised samples are weighted exactly as the resolver
 *   does; the future weighted sum is moment-matched to a lognormal
 *   (Turnbull–Wakeman / Levy) and compared against the floored average.
 * - Uncertainty: delta method on σ's standard error, plus a floor, so
 *   `Belief.uncertaintyBps` shrinks sizing automatically.
 *
 * `priceModel(model)` is the single pricing entry point used live and by
 * trace replay, so a trace's recorded `model` always reproduces its `bps`.
 */
import type { Direction } from "./grid.js";

export const BPS = 10_000;

/** Minimum log returns before any estimate is made. */
export const VOL_MIN_SAMPLES = 20;
/** Per-slot σ floor: a flat series never claims certainty. */
export const SIGMA_FLOOR = 1e-6;
/** Default EWMA decay (RiskMetrics' 0.94, per slot). */
export const DEFAULT_LAMBDA = 0.94;
/** Uncertainty floor in bps for every estimate. */
export const UNCERTAINTY_FLOOR_BPS = 100;
/** Extra uncertainty when σ hit the floor (zero-volatility series). */
export const FLAT_SERIES_UNCERTAINTY_BPS = 500;

// ── statistics ─────────────────────────────────────────────────────────────

/** Standard normal CDF via the Numerical Recipes `erfc` Chebyshev fit (|err| < 1.2e-7). */
export function normCdf(x: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

export interface SeriesPoint {
  ts: bigint;
  price: bigint;
}

export interface ReturnsReport {
  /** Per-slot-normalised log returns: `ln(p2/p1) / √k` for a `k`-slot step. */
  returns: number[];
  /** Steps skipped because they exceeded `maxGap` (start timestamps). */
  gaps: bigint[];
}

/**
 * Log returns on the feed grid. Steps longer than `maxGap` (default four
 * slots) are skipped and reported; non-positive prices are dropped.
 */
export function logReturnsReport(
  series: readonly SeriesPoint[],
  resolution: bigint,
  maxGap: bigint = resolution * 4n,
): ReturnsReport {
  const sorted = [...series].filter((p) => p.price > 0n).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const returns: number[] = [];
  const gaps: bigint[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const dt = b.ts - a.ts;
    if (dt <= 0n) continue;
    if (dt > maxGap) {
      gaps.push(a.ts);
      continue;
    }
    const k = Number(dt) / Number(resolution);
    returns.push((Math.log(Number(b.price)) - Math.log(Number(a.price))) / Math.sqrt(k));
  }
  return { returns, gaps };
}

export function logReturns(series: readonly SeriesPoint[], resolution: bigint, maxGap?: bigint): number[] {
  return logReturnsReport(series, resolution, maxGap).returns;
}

/** EWMA per-slot variance, seeded with the mean square of the first returns. */
export function ewmaVariance(returns: readonly number[], lambda = DEFAULT_LAMBDA): number {
  if (returns.length === 0) return 0;
  const seedN = Math.min(returns.length, 10);
  let v = returns.slice(0, seedN).reduce((s, r) => s + r * r, 0) / seedN;
  for (let i = seedN; i < returns.length; i++) v = lambda * v + (1 - lambda) * returns[i]! ** 2;
  return v;
}

/** Effective sample size of an EWMA with decay λ (capped by the data). */
export function ewmaEffectiveSamples(n: number, lambda = DEFAULT_LAMBDA): number {
  return Math.min(n, (1 + lambda) / (1 - lambda));
}

/**
 * GARCH(1,1)-lite: variance-targeted (`ω = v̄(1−α−β)`) grid search over
 * (α, β) maximising the Gaussian log-likelihood. Returns the one-step-ahead
 * variance, or null below `VOL_MIN_SAMPLES` returns.
 */
export function garchLite(
  returns: readonly number[],
): { omega: number; alpha: number; beta: number; nextVar: number } | null {
  if (returns.length < VOL_MIN_SAMPLES) return null;
  const mean = returns.reduce((s, r) => s + r * r, 0) / returns.length;
  if (mean <= 0) return { omega: 0, alpha: 0, beta: 0, nextVar: 0 };
  let best: { omega: number; alpha: number; beta: number; nextVar: number; ll: number } | null = null;
  for (let alpha = 0.02; alpha <= 0.3 + 1e-9; alpha += 0.02) {
    for (let beta = 0.5; beta <= 0.98 + 1e-9; beta += 0.02) {
      if (alpha + beta >= 0.999) continue;
      const omega = mean * (1 - alpha - beta);
      let v = mean;
      let ll = 0;
      for (const r of returns) {
        ll += -0.5 * (Math.log(v) + (r * r) / v);
        v = omega + alpha * r * r + beta * v;
      }
      if (!best || ll > best.ll) best = { omega, alpha, beta, nextVar: v, ll };
    }
  }
  const { ll: _ll, ...out } = best!;
  return out;
}

// ── model ──────────────────────────────────────────────────────────────────

/** Everything needed to reprice an estimate; recorded verbatim in traces. */
export interface PriceModel {
  kind: "spot" | "twap";
  reflector: string;
  /** `stellar:<address>` or `other:<symbol>`, exactly as committed. */
  asset: string;
  decimals: number;
  resolution: string;
  /** Grid slot covering `close_time` (the resolver's lookup timestamp). */
  gridSlot: string;
  /** Latest observed feed price (feed decimals). */
  spot: string;
  /** Timestamp of `spot`. */
  spotTs: string;
  /** Committed threshold, in `thresholdDecimals` (feed decimals when null). */
  threshold: string;
  thresholdDecimals: number | null;
  direction: Direction;
  /** Per-slot σ used for pricing (after the floor). */
  sigmaPerSlot: number;
  /** Standard error of σ (delta-method input). */
  sigmaStdErr: number;
  estimator: "ewma" | "garch";
  lambda?: number;
  /** Exact slots from `spotTs` to `gridSlot` (spot rules). */
  tau: number;
  /** Number of returns σ was estimated from. */
  samples: number;
  /** TWAP only: realised samples and the future slots still to print. */
  twap?: {
    window: string;
    closeTime: string;
    minSamples: number;
    maxGap: string;
    realised: { ts: string; price: string }[];
    futureSlots: string[];
    realisedTwap?: string;
  };
  /** Hybrid markets: probability the price leg fails and signers decide. */
  feedFailureProb?: number;
  /** Every price point read, for replay and audit. */
  priceRefs: { ts: string; price: string }[];
}

export interface FairValueModelResult {
  fairYesBps: number;
  uncertaintyBps: number;
  probability: number;
}

/** Smallest feed-unit price that resolves YES for an "above" rule; largest for "below". */
export function boundaryFeedUnits(
  direction: Direction,
  threshold: bigint,
  thresholdDecimals: number | null,
  feedDecimals: number,
): bigint {
  // Rescale (resolver `rescale`): YES iff price·f ⋈ T, with f = 10^(target−feed).
  const target = thresholdDecimals === null ? feedDecimals : Math.max(feedDecimals, thresholdDecimals);
  const T = thresholdDecimals === null ? threshold : threshold * 10n ** BigInt(target - thresholdDecimals);
  const f = 10n ** BigInt(target - feedDecimals);
  const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
  const ceilDiv = (a: bigint, b: bigint) => -floorDiv(-a, b);
  switch (direction) {
    case "Above":
      return floorDiv(T, f) + 1n; // price ≥ this
    case "AtOrAbove":
      return ceilDiv(T, f);
    case "Below":
      return ceilDiv(T, f) - 1n; // price ≤ this
    case "AtOrBelow":
      return floorDiv(T, f);
  }
}

const isAbove = (d: Direction) => d === "Above" || d === "AtOrAbove";

/** P(S_τ ≥ k) for a driftless lognormal; τ in slots, σ per slot. */
export function probAtLeast(spot: number, k: number, sigma: number, tau: number): number {
  if (k <= 0) return 1;
  if (tau <= 0 || sigma <= 0) return spot >= k ? 1 : 0;
  const s = sigma * Math.sqrt(tau);
  return normCdf((Math.log(spot / k) - (s * s) / 2) / s);
}

function spotProbability(m: PriceModel, sigma: number): number {
  const spot = Number(BigInt(m.spot));
  const boundary = Number(boundaryFeedUnits(m.direction, BigInt(m.threshold), m.thresholdDecimals, m.decimals));
  if (isAbove(m.direction)) return probAtLeast(spot, boundary - 0.5, sigma, m.tau);
  return 1 - probAtLeast(spot, boundary + 0.5, sigma, m.tau);
}

/**
 * TWAP: A = (R + F) / W with R the realised weighted sum, F the future
 * weighted sum of lognormal prices (moment-matched), W the total weight.
 * Floor semantics: floor(A) ≥ K ⇔ A ≥ K for integer K.
 */
function twapProbability(m: PriceModel, sigma: number): number {
  const t = m.twap!;
  const close = BigInt(t.closeTime);
  const realised = t.realised.map((p) => ({ ts: BigInt(p.ts), price: BigInt(p.price) }));
  const future = t.futureSlots.map(BigInt);
  const all = [...realised.map((p) => p.ts), ...future];
  const weights = all.map((ts, i) => Number((i + 1 < all.length ? all[i + 1]! : close + 1n) - ts));
  const W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0) return 0.5;
  let R = 0;
  realised.forEach((p, i) => (R += Number(p.price) * weights[i]!));
  const K = Number(BigInt(m.threshold));
  // floor(A) > K ⇔ A ≥ K+1; floor(A) ≥ K ⇔ A ≥ K; "below" is the complement.
  const m0 = m.direction === "Above" || m.direction === "AtOrBelow" ? K + 1 : K;
  const need = W * m0 - R; // YES-above iff F ≥ need
  let pAtLeast: number;
  if (future.length === 0) {
    pAtLeast = need <= 0 ? 1 : 0;
  } else if (need <= 0) {
    pAtLeast = 1;
  } else {
    const spot = Number(BigInt(m.spot));
    const spotTs = BigInt(m.spotTs);
    const res = BigInt(m.resolution);
    const fw = weights.slice(realised.length);
    const k = future.map((ts) => Math.max(0, Number((ts - spotTs) / res)));
    const m1 = spot * fw.reduce((s, w) => s + w, 0);
    let m2 = 0;
    const v = sigma * sigma;
    for (let i = 0; i < future.length; i++)
      for (let j = 0; j < future.length; j++) m2 += fw[i]! * fw[j]! * Math.exp(v * Math.min(k[i]!, k[j]!));
    m2 *= spot * spot;
    const s2 = Math.max(Math.log(m2 / (m1 * m1)), 1e-18);
    const mu = Math.log(m1) - s2 / 2;
    pAtLeast = normCdf((mu - Math.log(need)) / Math.sqrt(s2));
  }
  return isAbove(m.direction) ? pAtLeast : 1 - pAtLeast;
}

export function modelProbability(m: PriceModel, sigma = m.sigmaPerSlot): number {
  const p = m.kind === "spot" ? spotProbability(m, sigma) : twapProbability(m, sigma);
  const f = m.feedFailureProb ?? 0;
  return (1 - f) * p + f * 0.5;
}

/** Prices a recorded model: the one function live estimates and replay share. */
export function priceModel(m: PriceModel): FairValueModelResult {
  const sigma = m.sigmaPerSlot;
  const p = modelProbability(m, sigma);
  const h = Math.max(sigma * 1e-3, 1e-9);
  const dPdSigma = (modelProbability(m, sigma + h) - modelProbability(m, Math.max(sigma - h, 0))) / (sigma + h - Math.max(sigma - h, 0));
  let uncertainty = Math.abs(dPdSigma) * m.sigmaStdErr * BPS + UNCERTAINTY_FLOOR_BPS;
  if (sigma <= SIGMA_FLOOR) uncertainty += FLAT_SERIES_UNCERTAINTY_BPS;
  if (m.feedFailureProb) uncertainty += m.feedFailureProb * (BPS / 2);
  return {
    probability: p,
    fairYesBps: Math.min(BPS, Math.max(0, Math.round(p * BPS))),
    uncertaintyBps: Math.min(BPS, Math.round(uncertainty)),
  };
}

// ── Monte Carlo (tests and offline calibration only, never the hot path) ──

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-300);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

/** Seeded Monte Carlo probability of a model (same payoff and floor rules). */
export function monteCarloProbability(m: PriceModel, paths: number, seed: number): number {
  const norm = gaussian(seededRandom(seed));
  const sigma = m.sigmaPerSlot;
  const spot = Number(BigInt(m.spot));
  let yes = 0;
  if (m.kind === "spot") {
    const boundary = boundaryFeedUnits(m.direction, BigInt(m.threshold), m.thresholdDecimals, m.decimals);
    for (let p = 0; p < paths; p++) {
      const s = spot * Math.exp(-(sigma * sigma * m.tau) / 2 + sigma * Math.sqrt(m.tau) * norm());
      const price = BigInt(Math.round(s));
      const hit = isAbove(m.direction) ? price >= boundary : price <= boundary;
      if (hit) yes++;
    }
  } else {
    const t = m.twap!;
    const close = BigInt(t.closeTime);
    const res = BigInt(m.resolution);
    const spotTs = BigInt(m.spotTs);
    const realised = t.realised.map((x) => ({ ts: BigInt(x.ts), price: BigInt(x.price) }));
    const future = t.futureSlots.map(BigInt);
    const all = [...realised.map((x) => x.ts), ...future];
    const weights = all.map((ts, i) => (i + 1 < all.length ? all[i + 1]! : close + 1n) - ts);
    const W = weights.reduce((s, w) => s + w, 0n);
    const K = BigInt(m.threshold);
    for (let p = 0; p < paths; p++) {
      let sum = 0n;
      realised.forEach((x, i) => (sum += x.price * weights[i]!));
      let logS = Math.log(spot);
      let at = 0;
      future.forEach((ts, j) => {
        const k = Math.max(0, Number((ts - spotTs) / res));
        const steps = k - at;
        if (steps > 0) logS += -(sigma * sigma * steps) / 2 + sigma * Math.sqrt(steps) * norm();
        at = k;
        sum += BigInt(Math.round(Math.exp(logS))) * weights[realised.length + j]!;
      });
      const avg = sum / W;
      const hit =
        m.direction === "Above" ? avg > K
        : m.direction === "AtOrAbove" ? avg >= K
        : m.direction === "Below" ? avg < K
        : avg <= K;
      if (hit) yes++;
    }
  }
  const p = yes / paths;
  const f = m.feedFailureProb ?? 0;
  return (1 - f) * p + f * 0.5;
}
