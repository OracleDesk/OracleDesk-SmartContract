/**
 * OracleDesk module for issue #126: Add supply-chain security to CI: cargo-deny, npm audit, gitleaks, SBOM, pinned actions
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface SupplyChainAuditResultInput {
  contextId: string;
  highVulnCount: number;
  unpinnedActionCount: number;
  leakedSecretCount: number;
  limitThreshold?: number;
}

export interface SupplyChainAuditResult {
  contextId: string;
  highVulnCount: number;
  unpinnedActionCount: number;
  leakedSecretCount: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateSupplyChainSecurity(input: SupplyChainAuditResultInput): SupplyChainAuditResult {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateSupplyChainSecurity: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.highVulnCount) ||
    !Number.isFinite(input.unpinnedActionCount) ||
    !Number.isFinite(input.leakedSecretCount)
  ) {
    throw new Error("evaluateSupplyChainSecurity: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.highVulnCount));
  const v2 = Math.max(0, Math.trunc(input.unpinnedActionCount));
  const v3 = Math.max(0, Math.trunc(input.leakedSecretCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: highVulnCount=${v1}, unpinnedActionCount=${v2}, leakedSecretCount=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, leakedSecretCount=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    highVulnCount: v1,
    unpinnedActionCount: v2,
    leakedSecretCount: v3,
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
