/**
 * OracleDesk module for issue #117: Create a typed event-decoding package generated from the contract specs
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface DecodedContractEventSummaryInput {
  contextId: string;
  rawEventCount: number;
  matchedTopicCount: number;
  schemaMismatchCount: number;
  limitThreshold?: number;
}

export interface DecodedContractEventSummary {
  contextId: string;
  rawEventCount: number;
  matchedTopicCount: number;
  schemaMismatchCount: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function decodeContractEventBatch(input: DecodedContractEventSummaryInput): DecodedContractEventSummary {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("decodeContractEventBatch: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.rawEventCount) ||
    !Number.isFinite(input.matchedTopicCount) ||
    !Number.isFinite(input.schemaMismatchCount)
  ) {
    throw new Error("decodeContractEventBatch: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.rawEventCount));
  const v2 = Math.max(0, Math.trunc(input.matchedTopicCount));
  const v3 = Math.max(0, Math.trunc(input.schemaMismatchCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: rawEventCount=${v1}, matchedTopicCount=${v2}, schemaMismatchCount=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, schemaMismatchCount=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    rawEventCount: v1,
    matchedTopicCount: v2,
    schemaMismatchCount: v3,
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
