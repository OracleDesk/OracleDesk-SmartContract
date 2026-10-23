/**
 * OracleDesk module for issue #141: Segregate protocol fee revenue from agent trading capital in the treasury
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface SegregatedTreasuryLedgerInput {
  contextId: string;
  totalBalanceStroops: number;
  accruedFeesStroops: number;
  requestedTradeStroops: number;
  limitThreshold?: number;
}

export interface SegregatedTreasuryLedger {
  contextId: string;
  totalBalanceStroops: number;
  accruedFeesStroops: number;
  requestedTradeStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function segregateProtocolFeeFromCapital(input: SegregatedTreasuryLedgerInput): SegregatedTreasuryLedger {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("segregateProtocolFeeFromCapital: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.totalBalanceStroops) ||
    !Number.isFinite(input.accruedFeesStroops) ||
    !Number.isFinite(input.requestedTradeStroops)
  ) {
    throw new Error("segregateProtocolFeeFromCapital: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.totalBalanceStroops));
  const v2 = Math.max(0, Math.trunc(input.accruedFeesStroops));
  const v3 = Math.max(0, Math.trunc(input.requestedTradeStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: totalBalanceStroops=${v1}, accruedFeesStroops=${v2}, requestedTradeStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, requestedTradeStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    totalBalanceStroops: v1,
    accruedFeesStroops: v2,
    requestedTradeStroops: v3,
    scoreBps,
    status,
    reason,
  };
  const digestHex = createHash("sha256").update(canonicalize(payload)).digest("hex");

  return {
    ...payload,
    digestHex,
  };
}
