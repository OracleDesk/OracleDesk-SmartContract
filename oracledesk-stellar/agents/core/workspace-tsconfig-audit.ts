/**
 * OracleDesk module for issue #129: Convert the TS packages into an npm workspace with shared tsconfig, ESLint and builds
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface WorkspaceBuildAuditInput {
  contextId: string;
  packageCount: number;
  circularDepCount: number;
  strictModeEnabled: number;
  limitThreshold?: number;
}

export interface WorkspaceBuildAudit {
  contextId: string;
  packageCount: number;
  circularDepCount: number;
  strictModeEnabled: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyWorkspacePackageGraph(input: WorkspaceBuildAuditInput): WorkspaceBuildAudit {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyWorkspacePackageGraph: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.packageCount) ||
    !Number.isFinite(input.circularDepCount) ||
    !Number.isFinite(input.strictModeEnabled)
  ) {
    throw new Error("verifyWorkspacePackageGraph: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.packageCount));
  const v2 = Math.max(0, Math.trunc(input.circularDepCount));
  const v3 = Math.max(0, Math.trunc(input.strictModeEnabled));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: packageCount=${v1}, circularDepCount=${v2}, strictModeEnabled=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, strictModeEnabled=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    packageCount: v1,
    circularDepCount: v2,
    strictModeEnabled: v3,
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
