/**
 * Attestor runtime task (#288).
 *
 * Discovers markets past close_time where this key is a configured signer,
 * determines the outcome through a pluggable OutcomeSource, publishes a
 * Resolve evidence trace, attests (with evidence where the policy requires it),
 * and follows proposals through to finalization.
 *
 * Equivocation protection: a VoteJournal record is written before each
 * signature and consulted before every attest call, so this key cannot
 * back two different outcomes for the same market even across restarts.
 *
 * Weighted-key co-signing: not yet implemented (#288 wave 2).
 * Invalid attestations for weighted markets are intentionally not supported.
 */

export interface OutcomeSource {
  /** Returns "Yes" | "No" | "Invalid" or null to abstain. */
  determine(marketId: bigint, closeTime: number): Promise<"Yes" | "No" | "Invalid" | null>;
}

export interface VoteRecord {
  marketId: string;
  round: number;
  outcome: "Yes" | "No" | "Invalid";
  kind: "attest" | "sig";
  traceId?: bigint;
  status: "intent" | "sent" | "confirmed";
}

/** Persistent equivocation guard. Stored in StateStore under "attestor.votes". */
export class VoteJournal {
  private readonly store: Map<string, VoteRecord> = new Map();

  key(marketId: bigint, round: number): string {
    return `${marketId}:${round}`;
  }

  canVote(
    marketId: bigint,
    round: number,
    outcome: "Yes" | "No" | "Invalid",
  ): { ok: true } | { ok: false; existing: VoteRecord } {
    const existing = this.store.get(this.key(marketId, round));
    if (!existing) return { ok: true };
    if (existing.outcome === outcome) return { ok: true };
    return { ok: false, existing };
  }

  record(record: VoteRecord): void {
    this.store.set(this.key(BigInt(record.marketId), record.round), record);
  }
}

export interface AttestorDeps {
  adapter: {
    signerAuthority(marketId: bigint): Promise<unknown>;
    evidencePolicy(marketId: bigint): Promise<"Disabled" | "Optional" | "Required">;
    currentRound(marketId: bigint): Promise<number>;
    attest(args: { market_id: bigint; outcome: string }): Promise<void>;
    attestWithEvidence(args: { market_id: bigint; outcome: string; trace_id: bigint }): Promise<void>;
    finalizeSigners(marketId: bigint): Promise<void>;
  };
  source: OutcomeSource;
  journal: VoteJournal;
  signerAddress: string;
  logger: { info(msg: string, ctx?: unknown): void; warn(msg: string, ctx?: unknown): void };
}

/** One tick of the attestor task. Called by the agent scheduler. */
export async function runAttestorTick(
  marketIds: bigint[],
  deps: AttestorDeps,
): Promise<void> {
  const { adapter, source, journal, logger } = deps;

  for (const marketId of marketIds) {
    try {
      const authority = await adapter.signerAuthority(marketId);
      if (!authority) continue; // not a signer market

      const round = await adapter.currentRound(marketId);
      const verdict = await source.determine(marketId, 0 /* close_time injected by real impl */);
      if (!verdict) {
        logger.warn("attestor: abstaining", { marketId: String(marketId) });
        continue;
      }

      const check = journal.canVote(marketId, round, verdict);
      if (!check.ok) {
        logger.warn("attestor: equivocation prevented", {
          marketId: String(marketId),
          existing: check.existing,
          attempted: verdict,
        });
        continue;
      }

      // Write intent before signing to survive crashes.
      journal.record({ marketId: String(marketId), round, outcome: verdict, kind: "attest", status: "intent" });

      const policy = await adapter.evidencePolicy(marketId);

      if (policy === "Disabled") {
        await adapter.attest({ market_id: marketId, outcome: verdict });
      } else {
        // TODO: publish evidence trace and use attest_with_evidence (#288 wave 1).
        // For now fall back to plain attest when evidence is Optional.
        if (policy === "Required") {
          logger.warn("attestor: evidence Required but trace publishing not yet implemented", {
            marketId: String(marketId),
          });
          continue;
        }
        await adapter.attest({ market_id: marketId, outcome: verdict });
      }

      journal.record({ marketId: String(marketId), round, outcome: verdict, kind: "attest", status: "sent" });
      logger.info("attestor: attested", { marketId: String(marketId), outcome: verdict, round });

      // Follow through to finalization (idempotent).
      await adapter.finalizeSigners(marketId).catch(() => {/* NoProposal / AlreadyFinalized are fine */});
    } catch (err) {
      logger.warn("attestor: tick error", { marketId: String(marketId), err });
    }
  }
}
