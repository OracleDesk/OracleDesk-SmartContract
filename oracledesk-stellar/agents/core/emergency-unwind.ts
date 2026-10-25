/**
 * OracleDesk module for issue #150: Add an emergency unwind path that exits all treasury positions within slippage bounds
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface EmergencyUnwindPlanInput {
  contextId: string;
  positionSharesStroops: number;
  reserveYesStroops: number;
  maxSlippageBps: number;
  limitThreshold?: number;
}

export interface EmergencyUnwindPlan {
  contextId: string;
  positionSharesStroops: number;
  reserveYesStroops: number;
  maxSlippageBps: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function planEmergencyTreasuryUnwind(input: EmergencyUnwindPlanInput): EmergencyUnwindPlan {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("planEmergencyTreasuryUnwind: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.positionSharesStroops) ||
    !Number.isFinite(input.reserveYesStroops) ||
    !Number.isFinite(input.maxSlippageBps)
  ) {
    throw new Error("planEmergencyTreasuryUnwind: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.positionSharesStroops));
  const v2 = Math.max(0, Math.trunc(input.reserveYesStroops));
  const v3 = Math.max(0, Math.trunc(input.maxSlippageBps));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: positionSharesStroops=${v1}, reserveYesStroops=${v2}, maxSlippageBps=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, maxSlippageBps=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    positionSharesStroops: v1,
    reserveYesStroops: v2,
    maxSlippageBps: v3,
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
