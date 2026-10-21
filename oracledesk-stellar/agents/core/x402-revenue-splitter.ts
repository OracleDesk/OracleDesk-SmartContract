/**
 * OracleDesk module for issue #148: Build an on-chain revenue splitter for x402 trace sales
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface X402RevenueSplitInput {
  contextId: string;
  grossPaymentStroops: number;
  protocolShareBps: number;
  treasuryShareBps: number;
  limitThreshold?: number;
}

export interface X402RevenueSplit {
  contextId: string;
  grossPaymentStroops: number;
  protocolShareBps: number;
  treasuryShareBps: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function splitX402TraceRevenue(input: X402RevenueSplitInput): X402RevenueSplit {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("splitX402TraceRevenue: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.grossPaymentStroops) ||
    !Number.isFinite(input.protocolShareBps) ||
    !Number.isFinite(input.treasuryShareBps)
  ) {
    throw new Error("splitX402TraceRevenue: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.grossPaymentStroops));
  const v2 = Math.max(0, Math.trunc(input.protocolShareBps));
  const v3 = Math.max(0, Math.trunc(input.treasuryShareBps));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: grossPaymentStroops=${v1}, protocolShareBps=${v2}, treasuryShareBps=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, treasuryShareBps=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    grossPaymentStroops: v1,
    protocolShareBps: v2,
    treasuryShareBps: v3,
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
