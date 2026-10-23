/**
 * OracleDesk module for issue #122: Add bulk direct ledger-entry reads of market state to the SDK
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface BulkMarketSnapshotInput {
  contextId: string;
  requestedMarkets: number;
  decodedMarkets: number;
  missingEntries: number;
  limitThreshold?: number;
}

export interface BulkMarketSnapshot {
  contextId: string;
  requestedMarkets: number;
  decodedMarkets: number;
  missingEntries: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function aggregateBulkMarketLedgerEntries(input: BulkMarketSnapshotInput): BulkMarketSnapshot {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("aggregateBulkMarketLedgerEntries: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.requestedMarkets) ||
    !Number.isFinite(input.decodedMarkets) ||
    !Number.isFinite(input.missingEntries)
  ) {
    throw new Error("aggregateBulkMarketLedgerEntries: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.requestedMarkets));
  const v2 = Math.max(0, Math.trunc(input.decodedMarkets));
  const v3 = Math.max(0, Math.trunc(input.missingEntries));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: requestedMarkets=${v1}, decodedMarkets=${v2}, missingEntries=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, missingEntries=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    requestedMarkets: v1,
    decodedMarkets: v2,
    missingEntries: v3,
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
