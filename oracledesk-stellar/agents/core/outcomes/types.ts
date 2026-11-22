/**
 * Outcome sources for the proposal watcher (#275). A source independently
 * determines what a market's outcome should be; the watcher compares that to
 * the resolver's proposal and disputes only when sources agree, confidence is
 * high, and the exposure justifies the bond.
 */
import type { AttestedOutcome } from "../events/decode.js";

export interface OutcomeVerdict {
  outcome: AttestedOutcome;
  /** 0..=10_000. Zero means "no usable evidence"; it never triggers a dispute. */
  confidenceBps: number;
  evidence: Record<string, unknown>;
}

/** A market with a pending disputable proposal, as a source sees it. */
export interface WatchedMarket {
  marketId: bigint;
  /** market-core `meta_uri` (where the question metadata lives), if known. */
  metaUri?: string;
  /** market-core `close_time`, unix seconds. */
  closeTime: bigint;
  proposal: { outcome: AttestedOutcome; proposedAt: bigint };
}

export interface OutcomeSource {
  name: string;
  /** Cheap, synchronous: can this source say anything about the market? */
  supports(market: WatchedMarket): boolean;
  /** `undefined` means "no opinion". Must honour `signal`. */
  determine(market: WatchedMarket, signal: AbortSignal): Promise<OutcomeVerdict | undefined>;
}

export type Combined =
  | { kind: "none" }
  | { kind: "agree"; verdict: OutcomeVerdict; sources: string[] }
  | { kind: "conflict"; verdicts: { source: string; verdict: OutcomeVerdict }[] };

/**
 * Sources are combined only when they agree. Agreement takes the lowest
 * confidence (a chain is as strong as its weakest link); any disagreement is
 * a conflict, which the watcher alerts on instead of disputing. A source with
 * zero confidence counts as "no opinion" for agreement but caps the result:
 * it would make the agreed confidence zero, so no dispute follows.
 */
export function combineVerdicts(results: { source: string; verdict: OutcomeVerdict | undefined }[]): Combined {
  const have = results.filter((r): r is { source: string; verdict: OutcomeVerdict } => r.verdict !== undefined);
  if (have.length === 0) return { kind: "none" };
  const first = have[0]!.verdict.outcome;
  if (have.some((r) => r.verdict.outcome !== first)) return { kind: "conflict", verdicts: have };
  return {
    kind: "agree",
    sources: have.map((r) => r.source),
    verdict: {
      outcome: first,
      confidenceBps: Math.min(...have.map((r) => r.verdict.confidenceBps)),
      evidence: Object.fromEntries(have.map((r) => [r.source, r.verdict.evidence])),
    },
  };
}
