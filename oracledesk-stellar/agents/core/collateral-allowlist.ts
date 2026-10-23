/**
 * OracleDesk module for issue #151: Allow per-market collateral selection from an admin-managed allow-list
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface CollateralAllowlistPolicyInput {
  contextId: string;
  tokenContractId: number;
  decimals: number;
  maxMarketCapStroops: number;
  limitThreshold?: number;
}

export interface CollateralAllowlistPolicy {
  contextId: string;
  tokenContractId: number;
  decimals: number;
  maxMarketCapStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateCollateralSelection(input: CollateralAllowlistPolicyInput): CollateralAllowlistPolicy {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateCollateralSelection: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.tokenContractId) ||
    !Number.isFinite(input.decimals) ||
    !Number.isFinite(input.maxMarketCapStroops)
  ) {
    throw new Error("evaluateCollateralSelection: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.tokenContractId));
  const v2 = Math.max(0, Math.trunc(input.decimals));
  const v3 = Math.max(0, Math.trunc(input.maxMarketCapStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: tokenContractId=${v1}, decimals=${v2}, maxMarketCapStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, maxMarketCapStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    tokenContractId: v1,
    decimals: v2,
    maxMarketCapStroops: v3,
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
