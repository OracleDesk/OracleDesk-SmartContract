/**
 * EvidenceTraceSource (#275): for markets with no machine-readable rule, reads
 * the reasoning traces that signers linked to their attestations
 * (resolver `AttestationEvidence`), verifies each trace against its on-chain
 * hash, and returns the outcome the verified traces conclude, with confidence
 * taken from how many of them agree.
 *
 * Unverifiable traces (fetch failure, hash mismatch, no readable conclusion)
 * stay in the denominator, so a signer set that publishes junk lowers
 * confidence instead of vanishing from it.
 */
import { createHash } from "node:crypto";
import type { AttestedOutcome } from "../events/decode.js";
import type { OutcomeSource, OutcomeVerdict, WatchedMarket } from "./types.js";

export interface LinkedEvidence {
  signer: string;
  /** The outcome the signer attested. */
  attested: AttestedOutcome;
  traceId: bigint;
  /** sha256 of the trace's canonical JSON, lowercase hex, as recorded on-chain. */
  traceHash: string;
}

export interface EvidenceTraceOptions {
  evidence: (marketId: bigint) => Promise<LinkedEvidence[]>;
  /** The trace JSON the registry's CID points to; `undefined` if unavailable. */
  fetchTrace: (e: LinkedEvidence, signal: AbortSignal) => Promise<string | undefined>;
  /** At least this many verified traces must agree. Default 2. */
  minVerified?: number;
  /** Confidence never exceeds this: traces are claims, not proofs. Default 9_500. */
  maxConfidenceBps?: number;
}

const OUTCOMES = new Set(["Yes", "No", "Invalid"]);

/** The conclusion a trace states: `inputs.concludedOutcome`, else `inputs.outcome`. */
export function concludedOutcome(json: string): AttestedOutcome | undefined {
  try {
    const inputs = (JSON.parse(json) as { inputs?: Record<string, unknown> }).inputs ?? {};
    const v = inputs.concludedOutcome ?? inputs.outcome;
    return typeof v === "string" && OUTCOMES.has(v) ? (v as AttestedOutcome) : undefined;
  } catch {
    return undefined;
  }
}

export class EvidenceTraceSource implements OutcomeSource {
  readonly name = "evidence-trace";
  constructor(private readonly o: EvidenceTraceOptions) {}

  supports(): boolean {
    return true;
  }

  async determine(m: WatchedMarket, signal: AbortSignal): Promise<OutcomeVerdict | undefined> {
    const linked = await this.o.evidence(m.marketId);
    if (linked.length === 0) return undefined;
    const tally = new Map<AttestedOutcome, number>();
    const rejected: { signer: string; reason: string }[] = [];
    for (const e of linked) {
      if (signal.aborted) return undefined;
      const json = await this.o.fetchTrace(e, signal);
      if (json === undefined) {
        rejected.push({ signer: e.signer, reason: "trace unavailable" });
        continue;
      }
      if (createHash("sha256").update(json).digest("hex") !== e.traceHash.toLowerCase()) {
        rejected.push({ signer: e.signer, reason: "hash mismatch" });
        continue;
      }
      const outcome = concludedOutcome(json);
      if (!outcome) {
        rejected.push({ signer: e.signer, reason: "no conclusion" });
        continue;
      }
      tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    }
    const verified = [...tally.values()].reduce((a, b) => a + b, 0);
    if (verified === 0) return undefined;
    const [outcome, votes] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const ties = [...tally.values()].filter((v) => v === votes).length > 1;
    const agree = Math.floor((votes * 10_000) / linked.length);
    const enough = votes >= (this.o.minVerified ?? 2) && !ties;
    return {
      outcome,
      confidenceBps: enough ? Math.min(agree, this.o.maxConfidenceBps ?? 9_500) : 0,
      evidence: { linked: linked.length, verified, votes, tally: Object.fromEntries(tally), rejected },
    };
  }
}
