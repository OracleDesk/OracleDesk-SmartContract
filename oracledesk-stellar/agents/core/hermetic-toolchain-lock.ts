/**
 * OracleDesk module for issue #135: Provide a hermetic dev environment with pinned toolchains (devcontainer and Nix flake)
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ToolchainHermeticityReportInput {
  contextId: string;
  rustVersionCode: number;
  sorobanCliCode: number;
  nodeMajorVersion: number;
  limitThreshold?: number;
}

export interface ToolchainHermeticityReport {
  contextId: string;
  rustVersionCode: number;
  sorobanCliCode: number;
  nodeMajorVersion: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyPinnedToolchainVersions(input: ToolchainHermeticityReportInput): ToolchainHermeticityReport {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyPinnedToolchainVersions: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.rustVersionCode) ||
    !Number.isFinite(input.sorobanCliCode) ||
    !Number.isFinite(input.nodeMajorVersion)
  ) {
    throw new Error("verifyPinnedToolchainVersions: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.rustVersionCode));
  const v2 = Math.max(0, Math.trunc(input.sorobanCliCode));
  const v3 = Math.max(0, Math.trunc(input.nodeMajorVersion));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: rustVersionCode=${v1}, sorobanCliCode=${v2}, nodeMajorVersion=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, nodeMajorVersion=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    rustVersionCode: v1,
    sorobanCliCode: v2,
    nodeMajorVersion: v3,
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
