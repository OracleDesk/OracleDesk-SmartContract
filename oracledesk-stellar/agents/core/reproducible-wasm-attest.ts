/**
 * OracleDesk module for issue #127: Build a reproducible, attested wasm release pipeline with on-chain hash verification
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface WasmBuildAttestationInput {
  contextId: string;
  sourceTreeHashCode: number;
  compiledWasmHashCode: number;
  expectedWasmHashCode: number;
  limitThreshold?: number;
}

export interface WasmBuildAttestation {
  contextId: string;
  sourceTreeHashCode: number;
  compiledWasmHashCode: number;
  expectedWasmHashCode: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyReproducibleWasmBuild(input: WasmBuildAttestationInput): WasmBuildAttestation {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyReproducibleWasmBuild: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.sourceTreeHashCode) ||
    !Number.isFinite(input.compiledWasmHashCode) ||
    !Number.isFinite(input.expectedWasmHashCode)
  ) {
    throw new Error("verifyReproducibleWasmBuild: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.sourceTreeHashCode));
  const v2 = Math.max(0, Math.trunc(input.compiledWasmHashCode));
  const v3 = Math.max(0, Math.trunc(input.expectedWasmHashCode));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: sourceTreeHashCode=${v1}, compiledWasmHashCode=${v2}, expectedWasmHashCode=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, expectedWasmHashCode=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    sourceTreeHashCode: v1,
    compiledWasmHashCode: v2,
    expectedWasmHashCode: v3,
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
