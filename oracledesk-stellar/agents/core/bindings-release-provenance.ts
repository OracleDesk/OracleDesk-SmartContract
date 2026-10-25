/**
 * OracleDesk module for issue #118: Add a release pipeline for bindings: semver, changelogs, built dist and npm provenance
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ReleaseProvenanceCheckInput {
  contextId: string;
  semverMajor: number;
  semverMinor: number;
  provenanceSigned: number;
  limitThreshold?: number;
}

export interface ReleaseProvenanceCheck {
  contextId: string;
  semverMajor: number;
  semverMinor: number;
  provenanceSigned: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function validateBindingsReleaseManifest(input: ReleaseProvenanceCheckInput): ReleaseProvenanceCheck {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("validateBindingsReleaseManifest: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.semverMajor) ||
    !Number.isFinite(input.semverMinor) ||
    !Number.isFinite(input.provenanceSigned)
  ) {
    throw new Error("validateBindingsReleaseManifest: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.semverMajor));
  const v2 = Math.max(0, Math.trunc(input.semverMinor));
  const v3 = Math.max(0, Math.trunc(input.provenanceSigned));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: semverMajor=${v1}, semverMinor=${v2}, provenanceSigned=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, provenanceSigned=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    semverMajor: v1,
    semverMinor: v2,
    provenanceSigned: v3,
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
