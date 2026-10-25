/**
 * OracleDesk module for issue #138: Add signer staking with slashing for equivocation and liveness failures
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface SignerSlashEvaluationInput {
  contextId: string;
  stakedBondStroops: number;
  equivocationCount: number;
  missedEpochs: number;
  limitThreshold?: number;
}

export interface SignerSlashEvaluation {
  contextId: string;
  stakedBondStroops: number;
  equivocationCount: number;
  missedEpochs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateSignerEquivocationSlash(input: SignerSlashEvaluationInput): SignerSlashEvaluation {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateSignerEquivocationSlash: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.stakedBondStroops) ||
    !Number.isFinite(input.equivocationCount) ||
    !Number.isFinite(input.missedEpochs)
  ) {
    throw new Error("evaluateSignerEquivocationSlash: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.stakedBondStroops));
  const v2 = Math.max(0, Math.trunc(input.equivocationCount));
  const v3 = Math.max(0, Math.trunc(input.missedEpochs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: stakedBondStroops=${v1}, equivocationCount=${v2}, missedEpochs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, missedEpochs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    stakedBondStroops: v1,
    equivocationCount: v2,
    missedEpochs: v3,
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
