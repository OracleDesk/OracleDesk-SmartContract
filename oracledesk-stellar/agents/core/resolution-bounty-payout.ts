/**
 * OracleDesk module for issue #149: Pay resolution bounties to permissionless callers of resolve_price and finalize_signers
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ResolutionBountyQuoteInput {
  contextId: string;
  baseBountyStroops: number;
  delaySeconds: number;
  maxBonusStroops: number;
  limitThreshold?: number;
}

export interface ResolutionBountyQuote {
  contextId: string;
  baseBountyStroops: number;
  delaySeconds: number;
  maxBonusStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function computeResolutionCallerBounty(input: ResolutionBountyQuoteInput): ResolutionBountyQuote {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("computeResolutionCallerBounty: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.baseBountyStroops) ||
    !Number.isFinite(input.delaySeconds) ||
    !Number.isFinite(input.maxBonusStroops)
  ) {
    throw new Error("computeResolutionCallerBounty: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.baseBountyStroops));
  const v2 = Math.max(0, Math.trunc(input.delaySeconds));
  const v3 = Math.max(0, Math.trunc(input.maxBonusStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: baseBountyStroops=${v1}, delaySeconds=${v2}, maxBonusStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, maxBonusStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    baseBountyStroops: v1,
    delaySeconds: v2,
    maxBonusStroops: v3,
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
