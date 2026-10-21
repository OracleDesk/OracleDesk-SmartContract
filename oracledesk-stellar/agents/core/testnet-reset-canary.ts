/**
 * OracleDesk module for issue #130: Add a scheduled testnet canary that detects resets and verifies the live deployment
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface TestnetCanaryProbeInput {
  contextId: string;
  recordedLedgerSeq: number;
  currentLedgerSeq: number;
  contractCodePresent: number;
  limitThreshold?: number;
}

export interface TestnetCanaryProbe {
  contextId: string;
  recordedLedgerSeq: number;
  currentLedgerSeq: number;
  contractCodePresent: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function detectTestnetLedgerReset(input: TestnetCanaryProbeInput): TestnetCanaryProbe {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("detectTestnetLedgerReset: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.recordedLedgerSeq) ||
    !Number.isFinite(input.currentLedgerSeq) ||
    !Number.isFinite(input.contractCodePresent)
  ) {
    throw new Error("detectTestnetLedgerReset: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.recordedLedgerSeq));
  const v2 = Math.max(0, Math.trunc(input.currentLedgerSeq));
  const v3 = Math.max(0, Math.trunc(input.contractCodePresent));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: recordedLedgerSeq=${v1}, currentLedgerSeq=${v2}, contractCodePresent=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, contractCodePresent=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    recordedLedgerSeq: v1,
    currentLedgerSeq: v2,
    contractCodePresent: v3,
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
