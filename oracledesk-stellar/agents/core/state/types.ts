/**
 * Chain state types for the OracleDesk agent.
 * All bigint values stay bigint — never convert to number.
 */
import type { MarketState } from "../strategy.js";
import { priceYesBps } from "../fpmm.js";

export type MarketStatus = "open" | "resolved_yes" | "resolved_no" | "void";

export interface ChainMarket {
  marketId: bigint;
  creator: string;
  questionHash: string;
  resolutionHash: string;
  metaUri: string;
  category: string;
  closeTime: bigint;
  feeBps: number;
  status: MarketStatus;
  reserveYes: bigint;
  reserveNo: bigint;
  setsMinted: bigint;
  feesAccrued: bigint;
  lpClaimed: boolean;
  closed: boolean;
}

export interface PortfolioState {
  treasury: string;
  config: {
    agent: string;
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
  };
  availableCapital: bigint;
  daily: { dayStart: bigint; amount: bigint };
  positions: Map<bigint, { yes: bigint; no: bigint }>;
}

export interface Snapshot {
  ledgers: { min: number; max: number };
  consistent: boolean;
  ledgerCloseTime: bigint;
  markets: Map<bigint, ChainMarket>;
  portfolio: PortfolioState;
  errors: Array<{ scope: string; marketId?: bigint; message: string }>;
}

/** Convert a ChainMarket to the strategy's MarketState. Derives yesBps from reserves. */
export function toMarketState(m: ChainMarket): MarketState {
  const marketId = Number(m.marketId);
  if (!Number.isSafeInteger(marketId)) {
    throw new RangeError(`marketId ${m.marketId} exceeds safe integer range`);
  }
  return {
    marketId,
    question: m.questionHash,
    yesBps: Number(priceYesBps(m.reserveYes, m.reserveNo)),
    closeTime: Number(m.closeTime),
    reserveYesStroops: m.reserveYes,
    reserveNoStroops: m.reserveNo,
    feeBps: m.feeBps,
  };
}
