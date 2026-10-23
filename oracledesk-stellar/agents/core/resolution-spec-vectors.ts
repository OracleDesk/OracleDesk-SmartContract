/**
 * OracleDesk module for issue #120: Publish a TypeScript resolution-spec library with golden vectors from spec-hash
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface ResolutionSpecVectorCheckInput {
  contextId: string;
  canonicalJsonLength: number;
  expectedHashPrefix: number;
  computedHashPrefix: number;
  limitThreshold?: number;
}

export interface ResolutionSpecVectorCheck {
  contextId: string;
  canonicalJsonLength: number;
  expectedHashPrefix: number;
  computedHashPrefix: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyResolutionSpecVector(input: ResolutionSpecVectorCheckInput): ResolutionSpecVectorCheck {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyResolutionSpecVector: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.canonicalJsonLength) ||
    !Number.isFinite(input.expectedHashPrefix) ||
    !Number.isFinite(input.computedHashPrefix)
  ) {
    throw new Error("verifyResolutionSpecVector: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.canonicalJsonLength));
  const v2 = Math.max(0, Math.trunc(input.expectedHashPrefix));
  const v3 = Math.max(0, Math.trunc(input.computedHashPrefix));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: canonicalJsonLength=${v1}, expectedHashPrefix=${v2}, computedHashPrefix=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, computedHashPrefix=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    canonicalJsonLength: v1,
    expectedHashPrefix: v2,
    computedHashPrefix: v3,
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
