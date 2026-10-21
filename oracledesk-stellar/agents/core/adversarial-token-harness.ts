/**
 * OracleDesk module for issue #137: Build an adversarial mock library and test all contracts against hostile tokens/oracles
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface HostileOracleSimResultInput {
  contextId: string;
  reentrancyAttempts: number;
  feeOnTransferBps: number;
  staleOracleSecs: number;
  limitThreshold?: number;
}

export interface HostileOracleSimResult {
  contextId: string;
  reentrancyAttempts: number;
  feeOnTransferBps: number;
  staleOracleSecs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function simulateAdversarialTokenBehavior(input: HostileOracleSimResultInput): HostileOracleSimResult {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("simulateAdversarialTokenBehavior: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.reentrancyAttempts) ||
    !Number.isFinite(input.feeOnTransferBps) ||
    !Number.isFinite(input.staleOracleSecs)
  ) {
    throw new Error("simulateAdversarialTokenBehavior: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.reentrancyAttempts));
  const v2 = Math.max(0, Math.trunc(input.feeOnTransferBps));
  const v3 = Math.max(0, Math.trunc(input.staleOracleSecs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: reentrancyAttempts=${v1}, feeOnTransferBps=${v2}, staleOracleSecs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, staleOracleSecs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    reentrancyAttempts: v1,
    feeOnTransferBps: v2,
    staleOracleSecs: v3,
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
