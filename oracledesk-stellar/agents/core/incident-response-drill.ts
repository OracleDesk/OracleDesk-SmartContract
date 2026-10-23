/**
 * OracleDesk module for issue #139: Create an incident response toolkit: emergency scripts, runbooks and drills
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface IncidentRunbookPlanInput {
  contextId: string;
  affectedMarketId: number;
  detectedAnomalyBps: number;
  pauseDelaySecs: number;
  limitThreshold?: number;
}

export interface IncidentRunbookPlan {
  contextId: string;
  affectedMarketId: number;
  detectedAnomalyBps: number;
  pauseDelaySecs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function buildIncidentDrillPlaybook(input: IncidentRunbookPlanInput): IncidentRunbookPlan {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("buildIncidentDrillPlaybook: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.affectedMarketId) ||
    !Number.isFinite(input.detectedAnomalyBps) ||
    !Number.isFinite(input.pauseDelaySecs)
  ) {
    throw new Error("buildIncidentDrillPlaybook: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.affectedMarketId));
  const v2 = Math.max(0, Math.trunc(input.detectedAnomalyBps));
  const v3 = Math.max(0, Math.trunc(input.pauseDelaySecs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: affectedMarketId=${v1}, detectedAnomalyBps=${v2}, pauseDelaySecs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, pauseDelaySecs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    affectedMarketId: v1,
    detectedAnomalyBps: v2,
    pauseDelaySecs: v3,
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
