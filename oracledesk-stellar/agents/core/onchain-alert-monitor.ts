/**
 * OracleDesk module for issue #131: Build an on-chain monitoring and alerting service for deployed contracts
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ContractAlertEvaluationInput {
  contextId: string;
  reserveDrainBps: number;
  unrevealedCommitCount: number;
  oracleLagSecs: number;
  limitThreshold?: number;
}

export interface ContractAlertEvaluation {
  contextId: string;
  reserveDrainBps: number;
  unrevealedCommitCount: number;
  oracleLagSecs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateOnChainAnomalyAlerts(input: ContractAlertEvaluationInput): ContractAlertEvaluation {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateOnChainAnomalyAlerts: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.reserveDrainBps) ||
    !Number.isFinite(input.unrevealedCommitCount) ||
    !Number.isFinite(input.oracleLagSecs)
  ) {
    throw new Error("evaluateOnChainAnomalyAlerts: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.reserveDrainBps));
  const v2 = Math.max(0, Math.trunc(input.unrevealedCommitCount));
  const v3 = Math.max(0, Math.trunc(input.oracleLagSecs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: reserveDrainBps=${v1}, unrevealedCommitCount=${v2}, oracleLagSecs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, oracleLagSecs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    reserveDrainBps: v1,
    unrevealedCommitCount: v2,
    oracleLagSecs: v3,
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
