/**
 * OracleDesk module for issue #124: Generate Python contract clients and an analytics toolkit on top of fpmm_model
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface FpmmAnalyticsSummaryInput {
  contextId: string;
  reserveYesStroops: number;
  reserveNoStroops: number;
  volume24hStroops: number;
  limitThreshold?: number;
}

export interface FpmmAnalyticsSummary {
  contextId: string;
  reserveYesStroops: number;
  reserveNoStroops: number;
  volume24hStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function computeFpmmPoolAnalytics(input: FpmmAnalyticsSummaryInput): FpmmAnalyticsSummary {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("computeFpmmPoolAnalytics: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.reserveYesStroops) ||
    !Number.isFinite(input.reserveNoStroops) ||
    !Number.isFinite(input.volume24hStroops)
  ) {
    throw new Error("computeFpmmPoolAnalytics: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.reserveYesStroops));
  const v2 = Math.max(0, Math.trunc(input.reserveNoStroops));
  const v3 = Math.max(0, Math.trunc(input.volume24hStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: reserveYesStroops=${v1}, reserveNoStroops=${v2}, volume24hStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, volume24hStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    reserveYesStroops: v1,
    reserveNoStroops: v2,
    volume24hStroops: v3,
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
