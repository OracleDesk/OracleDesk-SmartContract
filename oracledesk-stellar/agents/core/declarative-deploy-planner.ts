/**
 * OracleDesk module for issue #128: Replace the bash deploy script with a declarative plan/apply deployer with verification
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface DeclarativeDeployPlanInput {
  contextId: string;
  desiredWasmHashCode: number;
  liveWasmHashCode: number;
  configDriftCount: number;
  limitThreshold?: number;
}

export interface DeclarativeDeployPlan {
  contextId: string;
  desiredWasmHashCode: number;
  liveWasmHashCode: number;
  configDriftCount: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function computeDeclarativeDeployDiff(input: DeclarativeDeployPlanInput): DeclarativeDeployPlan {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("computeDeclarativeDeployDiff: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.desiredWasmHashCode) ||
    !Number.isFinite(input.liveWasmHashCode) ||
    !Number.isFinite(input.configDriftCount)
  ) {
    throw new Error("computeDeclarativeDeployDiff: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.desiredWasmHashCode));
  const v2 = Math.max(0, Math.trunc(input.liveWasmHashCode));
  const v3 = Math.max(0, Math.trunc(input.configDriftCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: desiredWasmHashCode=${v1}, liveWasmHashCode=${v2}, configDriftCount=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, configDriftCount=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    desiredWasmHashCode: v1,
    liveWasmHashCode: v2,
    configDriftCount: v3,
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
