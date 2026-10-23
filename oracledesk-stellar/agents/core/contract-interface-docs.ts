/**
 * OracleDesk module for issue #136: Build a docs site with rustdoc, TypeDoc and generated contract interface references
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface InterfaceDocManifestInput {
  contextId: string;
  entrypointCount: number;
  documentedCount: number;
  errorEnumCount: number;
  limitThreshold?: number;
}

export interface InterfaceDocManifest {
  contextId: string;
  entrypointCount: number;
  documentedCount: number;
  errorEnumCount: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function buildContractInterfaceManifest(input: InterfaceDocManifestInput): InterfaceDocManifest {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("buildContractInterfaceManifest: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.entrypointCount) ||
    !Number.isFinite(input.documentedCount) ||
    !Number.isFinite(input.errorEnumCount)
  ) {
    throw new Error("buildContractInterfaceManifest: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.entrypointCount));
  const v2 = Math.max(0, Math.trunc(input.documentedCount));
  const v3 = Math.max(0, Math.trunc(input.errorEnumCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: entrypointCount=${v1}, documentedCount=${v2}, errorEnumCount=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, errorEnumCount=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    entrypointCount: v1,
    documentedCount: v2,
    errorEnumCount: v3,
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
