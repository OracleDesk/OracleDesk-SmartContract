/**
 * OracleDesk module for issue #145: Complete and version the event surface across all four contracts
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface VersionedContractEventInput {
  contextId: string;
  schemaVersion: number;
  contractCode: number;
  ledgerSequence: number;
  limitThreshold?: number;
}

export interface VersionedContractEvent {
  contextId: string;
  schemaVersion: number;
  contractCode: number;
  ledgerSequence: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function normalizeVersionedEventPayload(input: VersionedContractEventInput): VersionedContractEvent {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("normalizeVersionedEventPayload: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.schemaVersion) ||
    !Number.isFinite(input.contractCode) ||
    !Number.isFinite(input.ledgerSequence)
  ) {
    throw new Error("normalizeVersionedEventPayload: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.schemaVersion));
  const v2 = Math.max(0, Math.trunc(input.contractCode));
  const v3 = Math.max(0, Math.trunc(input.ledgerSequence));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: schemaVersion=${v1}, contractCode=${v2}, ledgerSequence=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, ledgerSequence=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    schemaVersion: v1,
    contractCode: v2,
    ledgerSequence: v3,
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
