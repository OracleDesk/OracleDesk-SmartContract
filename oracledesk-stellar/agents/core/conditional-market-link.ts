/**
 * OracleDesk module for issue #147: Add market-linked resolution so conditional markets resolve from another market's outcome
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface LinkedMarketResolutionInput {
  contextId: string;
  parentMarketId: number;
  parentOutcomeCode: number;
  conditionMappingBps: number;
  limitThreshold?: number;
}

export interface LinkedMarketResolution {
  contextId: string;
  parentMarketId: number;
  parentOutcomeCode: number;
  conditionMappingBps: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function resolveConditionalLinkedMarket(input: LinkedMarketResolutionInput): LinkedMarketResolution {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("resolveConditionalLinkedMarket: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.parentMarketId) ||
    !Number.isFinite(input.parentOutcomeCode) ||
    !Number.isFinite(input.conditionMappingBps)
  ) {
    throw new Error("resolveConditionalLinkedMarket: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.parentMarketId));
  const v2 = Math.max(0, Math.trunc(input.parentOutcomeCode));
  const v3 = Math.max(0, Math.trunc(input.conditionMappingBps));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: parentMarketId=${v1}, parentOutcomeCode=${v2}, conditionMappingBps=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, conditionMappingBps=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    parentMarketId: v1,
    parentOutcomeCode: v2,
    conditionMappingBps: v3,
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
