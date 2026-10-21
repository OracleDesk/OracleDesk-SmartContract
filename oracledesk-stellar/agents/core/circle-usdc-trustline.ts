/**
 * OracleDesk module for issue #134: Support Circle testnet USDC collateral with trustlines and configurable deployment
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface UsdcTrustlineReadinessInput {
  contextId: string;
  trustlineLimitStroops: number;
  currentBalanceStroops: number;
  requiredSeedStroops: number;
  limitThreshold?: number;
}

export interface UsdcTrustlineReadiness {
  contextId: string;
  trustlineLimitStroops: number;
  currentBalanceStroops: number;
  requiredSeedStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyUsdcCollateralReadiness(input: UsdcTrustlineReadinessInput): UsdcTrustlineReadiness {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyUsdcCollateralReadiness: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.trustlineLimitStroops) ||
    !Number.isFinite(input.currentBalanceStroops) ||
    !Number.isFinite(input.requiredSeedStroops)
  ) {
    throw new Error("verifyUsdcCollateralReadiness: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.trustlineLimitStroops));
  const v2 = Math.max(0, Math.trunc(input.currentBalanceStroops));
  const v3 = Math.max(0, Math.trunc(input.requiredSeedStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: trustlineLimitStroops=${v1}, currentBalanceStroops=${v2}, requiredSeedStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, requiredSeedStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    trustlineLimitStroops: v1,
    currentBalanceStroops: v2,
    requiredSeedStroops: v3,
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
