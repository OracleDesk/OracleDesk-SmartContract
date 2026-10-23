/**
 * OracleDesk module for issue #121: Make bindings generation deterministic and network-aware with on-chain wasm verification
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface BindingsVerificationReportInput {
  contextId: string;
  onChainWasmCode: number;
  localSpecHashCode: number;
  networkIdCode: number;
  limitThreshold?: number;
}

export interface BindingsVerificationReport {
  contextId: string;
  onChainWasmCode: number;
  localSpecHashCode: number;
  networkIdCode: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyGeneratedBindingsIntegrity(input: BindingsVerificationReportInput): BindingsVerificationReport {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyGeneratedBindingsIntegrity: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.onChainWasmCode) ||
    !Number.isFinite(input.localSpecHashCode) ||
    !Number.isFinite(input.networkIdCode)
  ) {
    throw new Error("verifyGeneratedBindingsIntegrity: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.onChainWasmCode));
  const v2 = Math.max(0, Math.trunc(input.localSpecHashCode));
  const v3 = Math.max(0, Math.trunc(input.networkIdCode));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: onChainWasmCode=${v1}, localSpecHashCode=${v2}, networkIdCode=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, networkIdCode=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    onChainWasmCode: v1,
    localSpecHashCode: v2,
    networkIdCode: v3,
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
