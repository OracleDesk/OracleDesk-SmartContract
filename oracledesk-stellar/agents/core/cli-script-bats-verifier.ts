/**
 * OracleDesk module for issue #132: Test the shell scripts with bats against a stubbed stellar CLI and enforce shellcheck
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ShellScriptVerificationInput {
  contextId: string;
  exitStatusCode: number;
  retryAttempts: number;
  networkTimeoutSecs: number;
  limitThreshold?: number;
}

export interface ShellScriptVerification {
  contextId: string;
  exitStatusCode: number;
  retryAttempts: number;
  networkTimeoutSecs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyDeployScriptInvocation(input: ShellScriptVerificationInput): ShellScriptVerification {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyDeployScriptInvocation: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.exitStatusCode) ||
    !Number.isFinite(input.retryAttempts) ||
    !Number.isFinite(input.networkTimeoutSecs)
  ) {
    throw new Error("verifyDeployScriptInvocation: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.exitStatusCode));
  const v2 = Math.max(0, Math.trunc(input.retryAttempts));
  const v3 = Math.max(0, Math.trunc(input.networkTimeoutSecs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: exitStatusCode=${v1}, retryAttempts=${v2}, networkTimeoutSecs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, networkTimeoutSecs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    exitStatusCode: v1,
    retryAttempts: v2,
    networkTimeoutSecs: v3,
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
