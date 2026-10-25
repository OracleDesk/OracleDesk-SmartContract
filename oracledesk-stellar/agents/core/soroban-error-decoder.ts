/**
 * OracleDesk module for issue #119: Decode nested contract errors from simulation diagnostics into structured SDK errors
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface DecodedContractErrorInput {
  contextId: string;
  contractErrorCode: number;
  hostFunctionDepth: number;
  retryableHintCode: number;
  limitThreshold?: number;
}

export interface DecodedContractError {
  contextId: string;
  contractErrorCode: number;
  hostFunctionDepth: number;
  retryableHintCode: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function decodeSimulationContractError(input: DecodedContractErrorInput): DecodedContractError {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("decodeSimulationContractError: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.contractErrorCode) ||
    !Number.isFinite(input.hostFunctionDepth) ||
    !Number.isFinite(input.retryableHintCode)
  ) {
    throw new Error("decodeSimulationContractError: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.contractErrorCode));
  const v2 = Math.max(0, Math.trunc(input.hostFunctionDepth));
  const v3 = Math.max(0, Math.trunc(input.retryableHintCode));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: contractErrorCode=${v1}, hostFunctionDepth=${v2}, retryableHintCode=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, retryableHintCode=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    contractErrorCode: v1,
    hostFunctionDepth: v2,
    retryableHintCode: v3,
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
