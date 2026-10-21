/**
 * OracleDesk module for issue #143: Write a third-party agent integration guide with a runnable reference agent
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ReferenceAgentCycleResultInput {
  contextId: string;
  marketPriceBps: number;
  signalFairBps: number;
  maxOrderStroops: number;
  limitThreshold?: number;
}

export interface ReferenceAgentCycleResult {
  contextId: string;
  marketPriceBps: number;
  signalFairBps: number;
  maxOrderStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateReferenceAgentCycle(input: ReferenceAgentCycleResultInput): ReferenceAgentCycleResult {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateReferenceAgentCycle: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.marketPriceBps) ||
    !Number.isFinite(input.signalFairBps) ||
    !Number.isFinite(input.maxOrderStroops)
  ) {
    throw new Error("evaluateReferenceAgentCycle: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.marketPriceBps));
  const v2 = Math.max(0, Math.trunc(input.signalFairBps));
  const v3 = Math.max(0, Math.trunc(input.maxOrderStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: marketPriceBps=${v1}, signalFairBps=${v2}, maxOrderStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, maxOrderStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    marketPriceBps: v1,
    signalFairBps: v2,
    maxOrderStroops: v3,
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
