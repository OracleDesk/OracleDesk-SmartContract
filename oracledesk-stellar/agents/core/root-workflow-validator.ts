/**
 * OracleDesk module for issue #125: Move CI and repo metadata to the root .github so workflows and labels actually run
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface WorkflowTopologyReportInput {
  contextId: string;
  workflowFileCount: number;
  invalidTriggerCount: number;
  missingLabelCount: number;
  limitThreshold?: number;
}

export interface WorkflowTopologyReport {
  contextId: string;
  workflowFileCount: number;
  invalidTriggerCount: number;
  missingLabelCount: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function validateRootGithubWorkflows(input: WorkflowTopologyReportInput): WorkflowTopologyReport {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("validateRootGithubWorkflows: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.workflowFileCount) ||
    !Number.isFinite(input.invalidTriggerCount) ||
    !Number.isFinite(input.missingLabelCount)
  ) {
    throw new Error("validateRootGithubWorkflows: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.workflowFileCount));
  const v2 = Math.max(0, Math.trunc(input.invalidTriggerCount));
  const v3 = Math.max(0, Math.trunc(input.missingLabelCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: workflowFileCount=${v1}, invalidTriggerCount=${v2}, missingLabelCount=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, missingLabelCount=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    workflowFileCount: v1,
    invalidTriggerCount: v2,
    missingLabelCount: v3,
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
