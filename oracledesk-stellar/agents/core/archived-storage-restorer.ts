/**
 * OracleDesk module for issue #123: Handle archived storage automatically in clients with restore-footprint flows
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface FootprintRestorePlanInput {
  contextId: string;
  archivedEntryCount: number;
  restoreFeeStroops: number;
  maxBudgetStroops: number;
  limitThreshold?: number;
}

export interface FootprintRestorePlan {
  contextId: string;
  archivedEntryCount: number;
  restoreFeeStroops: number;
  maxBudgetStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function planArchivedStorageRestore(input: FootprintRestorePlanInput): FootprintRestorePlan {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("planArchivedStorageRestore: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.archivedEntryCount) ||
    !Number.isFinite(input.restoreFeeStroops) ||
    !Number.isFinite(input.maxBudgetStroops)
  ) {
    throw new Error("planArchivedStorageRestore: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.archivedEntryCount));
  const v2 = Math.max(0, Math.trunc(input.restoreFeeStroops));
  const v3 = Math.max(0, Math.trunc(input.maxBudgetStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: archivedEntryCount=${v1}, restoreFeeStroops=${v2}, maxBudgetStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, maxBudgetStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    archivedEntryCount: v1,
    restoreFeeStroops: v2,
    maxBudgetStroops: v3,
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
