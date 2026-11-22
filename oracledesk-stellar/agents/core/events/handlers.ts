/**
 * Example event handlers (#105). Each is idempotent: handling the same event
 * twice re-reads chain state and reaches the same result, because events are
 * delivered at least once. None trusts the event alone; each re-reads the
 * chain before acting.
 */
import type { OracleDeskEvent } from "./decode.js";
import type { EventHandler } from "./dispatch.js";

type Of<K extends OracleDeskEvent["kind"]> = Extract<OracleDeskEvent, { kind: K }>;

export interface MarketSnapshot {
  marketId: bigint;
  open: boolean;
  yesBps: number;
}

/**
 * After a trade of at least `threshold` stroops, re-reads the market and, if
 * it is still open, queues it for the trader to re-evaluate.
 */
export function tradeReevaluate(deps: {
  threshold: bigint;
  readMarket: (marketId: bigint) => Promise<MarketSnapshot | undefined>;
  enqueue: (marketId: bigint) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): EventHandler {
  return {
    name: "TradeReevaluate",
    kinds: ["Trade"],
    async handle(e) {
      const t = e as Of<"Trade">;
      if (t.collateral < deps.threshold) return;
      const market = await deps.readMarket(t.marketId);
      if (!market?.open) return;
      deps.log?.("EVENT_REEVALUATE", { market: t.marketId, collateral: t.collateral, yesBps: market.yesBps });
      deps.enqueue(t.marketId);
    },
  };
}

/** Unix seconds by which a dispute must be raised, from ledger timestamps. */
export function disputeDeadline(proposedAt: bigint, disputeWindowSecs: bigint): bigint {
  return proposedAt + disputeWindowSecs;
}

export interface ProposalAlert {
  marketId: bigint;
  outcome: string;
  exposure: bigint;
  proposedAt: bigint;
  /** Unix seconds; derived from the proposal's ledger timestamp. */
  disputeDeadline: bigint;
  /** Seconds left at the ledger the event closed in. */
  secondsLeft: bigint;
}

/**
 * Alerts when a resolution is proposed for a market the treasury holds a
 * position in. Proposals can be cancelled without an event, so it checks the
 * resolver's current state first and alerts only while the proposal stands.
 */
export function proposalWatch(deps: {
  exposure: (marketId: bigint) => Promise<bigint>;
  /** The resolver's state tag for the market (e.g. "SignersPending"). */
  proposalState: (marketId: bigint) => Promise<string>;
  disputeWindowSecs: (marketId: bigint) => Promise<bigint>;
  alert: (a: ProposalAlert) => void | Promise<void>;
}): EventHandler {
  return {
    name: "ProposalWatch",
    kinds: ["ResolutionProposed"],
    async handle(e) {
      const p = e as Of<"ResolutionProposed">;
      const exposure = await deps.exposure(p.marketId);
      if (exposure <= 0n) return;
      if ((await deps.proposalState(p.marketId)) !== "SignersPending") return;
      const deadline = disputeDeadline(p.proposedAt, await deps.disputeWindowSecs(p.marketId));
      await deps.alert({
        marketId: p.marketId,
        outcome: p.outcome,
        exposure,
        proposedAt: p.proposedAt,
        disputeDeadline: deadline,
        secondsLeft: deadline - BigInt(p.closedAt),
      });
    },
  };
}

/** Marks a market final once any resolution path reports it. */
export function finalityTracker(deps: { markFinal: (marketId: bigint, via: string) => void | Promise<void> }): EventHandler {
  return {
    name: "FinalityTracker",
    kinds: ["MarketResolved", "ResolutionFinalized", "PriceResolution"],
    async handle(e) {
      await deps.markFinal((e as Of<"MarketResolved" | "ResolutionFinalized" | "PriceResolution">).marketId, e.kind);
    },
  };
}

/**
 * The retention-gap handler: events were missed, so reload every market's
 * state from the chain instead of trusting incremental updates.
 */
export function resync(deps: { reloadAll: () => Promise<void>; log?: (event: string, fields?: Record<string, unknown>) => void }) {
  return async (reason: string): Promise<void> => {
    deps.log?.("EVENTS_RESYNC", { reason });
    await deps.reloadAll();
  };
}
