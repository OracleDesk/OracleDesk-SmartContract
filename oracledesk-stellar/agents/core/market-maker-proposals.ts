/**
 * Market-maker signal ingestion, semantic deduplication, resolution clarity
 * validator, and dynamic seed sizing (#110).
 */

export interface RawCandidateQuestion {
  source: string;
  question: string;
  closeTimeSec: number;
  estimatedYesBps: number;
  confidenceBps: number;
  resolutionSourceUrl?: string;
}

export interface ExistingMarketSummary {
  marketId: number;
  question: string;
  closeTimeSec: number;
  resolved: boolean;
}

const STOPWORDS = new Set([
  "will",
  "the",
  "a",
  "an",
  "be",
  "by",
  "in",
  "on",
  "at",
  "to",
  "of",
  "for",
  "before",
  "after",
  "or",
  "and",
  "is",
  "above",
  "below",
  "exceed",
  "reach",
]);

const SUBJECTIVE_WORDS = [
  "best",
  "good",
  "bad",
  "popular",
  "successful",
  "impressive",
  "mostly",
  "significant",
  "around",
  "approximately",
];

export function tokenizeQuestion(q: string): Set<string> {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Token-level Jaccard similarity in `[0, 1]`. */
export function questionSimilarity(a: string, b: string): number {
  const setA = tokenizeQuestion(a);
  const setB = tokenizeQuestion(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const tok of setA) {
    if (setB.has(tok)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return inter / union;
}

export function isDuplicateQuestion(
  candidate: string,
  existing: ExistingMarketSummary[],
  similarityThreshold = 0.6,
): { duplicate: boolean; matchedMarketId?: number; similarity: number } {
  let bestSim = 0;
  let bestId: number | undefined;
  for (const m of existing) {
    if (m.resolved) continue;
    const sim = questionSimilarity(candidate, m.question);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = m.marketId;
    }
  }
  return {
    duplicate: bestSim >= similarityThreshold,
    matchedMarketId: bestSim >= similarityThreshold ? bestId : undefined,
    similarity: bestSim,
  };
}

export interface ClarityValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that a candidate binary market question is objective, bounded in
 * time, and non-subjective before committing treasury seed capital.
 */
export function validateResolutionClarity(
  candidate: RawCandidateQuestion,
  nowSec: number,
  opts: { minLeadTimeSec?: number; maxHorizonSec?: number } = {},
): ClarityValidationResult {
  const minLead = opts.minLeadTimeSec ?? 3600;
  const maxHorizon = opts.maxHorizonSec ?? 365 * 86_400;
  const q = candidate.question.trim();

  if (q.length < 15 || !q.endsWith("?")) {
    return { valid: false, reason: "question must be a binary interrogative ending with '?'" };
  }
  if (!/^will\s+/i.test(q)) {
    return { valid: false, reason: "question must start with an unambiguous 'Will ...' predicate" };
  }
  const lower = q.toLowerCase();
  for (const word of SUBJECTIVE_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(lower)) {
      return { valid: false, reason: `question contains subjective term '${word}'` };
    }
  }
  if (candidate.closeTimeSec - nowSec < minLead) {
    return { valid: false, reason: "closeTimeSec is too close to current timestamp" };
  }
  if (candidate.closeTimeSec - nowSec > maxHorizon) {
    return { valid: false, reason: "closeTimeSec exceeds maximum market horizon" };
  }
  if (candidate.estimatedYesBps < 500 || candidate.estimatedYesBps > 9500) {
    return { valid: false, reason: "initial probability must lie within [500, 9500] bps" };
  }
  return { valid: true };
}

export interface DynamicSeedConfig {
  minSeedStroops: bigint;
  maxSeedStroops: bigint;
  treasuryRemainingDailyStroops: bigint;
  minConfidenceBps: number;
}

/**
 * Scales seed liquidity between `[minSeedStroops, maxSeedStroops]` proportional
 * to signal confidence while respecting the remaining treasury daily cap.
 */
export function computeDynamicSeedStroops(
  confidenceBps: number,
  cfg: DynamicSeedConfig,
): bigint {
  if (confidenceBps < cfg.minConfidenceBps || cfg.treasuryRemainingDailyStroops < cfg.minSeedStroops) {
    return 0n;
  }
  const spanConfidence = Math.max(1, 10_000 - cfg.minConfidenceBps);
  const clampedConf = Math.min(10_000, Math.max(cfg.minConfidenceBps, confidenceBps));
  const ratioBps = BigInt(
    Math.round(((clampedConf - cfg.minConfidenceBps) * 10_000) / spanConfidence),
  );
  const seedRange = cfg.maxSeedStroops - cfg.minSeedStroops;
  const target = cfg.minSeedStroops + (seedRange * ratioBps) / 10_000n;
  return target <= cfg.treasuryRemainingDailyStroops
    ? target
    : cfg.treasuryRemainingDailyStroops;
}
