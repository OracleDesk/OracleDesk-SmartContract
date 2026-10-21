/**
 * OracleDesk module for issue #140: Integrate Soroban static analysis (Scout) into CI and remediate findings
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ScoutAuditFindingSummaryInput {
  contextId: string;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  limitThreshold?: number;
}

export interface ScoutAuditFindingSummary {
  contextId: string;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateScoutSecurityGate(input: ScoutAuditFindingSummaryInput): ScoutAuditFindingSummary {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateScoutSecurityGate: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.criticalFindings) ||
    !Number.isFinite(input.highFindings) ||
    !Number.isFinite(input.mediumFindings)
  ) {
    throw new Error("evaluateScoutSecurityGate: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.criticalFindings));
  const v2 = Math.max(0, Math.trunc(input.highFindings));
  const v3 = Math.max(0, Math.trunc(input.mediumFindings));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: criticalFindings=${v1}, highFindings=${v2}, mediumFindings=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, mediumFindings=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    criticalFindings: v1,
    highFindings: v2,
    mediumFindings: v3,
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
