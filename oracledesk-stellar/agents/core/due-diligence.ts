export type DueDiligenceReasonCode =
  | "CHAIN_STATE_UNAVAILABLE"
  | "STALE_MARKET_STATE"
  | "COMMITMENT_MISMATCH"
  | "METADATA_UNAVAILABLE"
  | "METADATA_MALFORMED"
  | "QUESTION_HASH_MISMATCH"
  | "RESOLUTION_UNAVAILABLE"
  | "ORACLE_UNTRUSTED"
  | "SIGNERS_UNTRUSTED"
  | "VERIFICATION_UNAVAILABLE";

export type VerificationStatus = "verified" | "failed" | "unavailable" | "not_applicable";

export interface DueDiligenceVerdict {
  outcome: "allow" | "reject";
  reasons: Array<{ code: DueDiligenceReasonCode; explanation: string }>;
  commitments: VerificationStatus;
  metadata: VerificationStatus;
  resolutionPath: VerificationStatus;
  oracleTrust: VerificationStatus;
  signerTrust: VerificationStatus;
  marketId: string;
  stateFingerprint?: string;
  checkedAt: number;
}

export function unavailableDueDiligence(marketId: bigint | string, checkedAt = Date.now()): DueDiligenceVerdict {
  return {
    outcome: "reject",
    reasons: [{
      code: "VERIFICATION_UNAVAILABLE",
      explanation: "No chain-backed commitment, metadata, resolution, and trust verifier is configured.",
    }],
    commitments: "unavailable",
    metadata: "unavailable",
    resolutionPath: "unavailable",
    oracleTrust: "unavailable",
    signerTrust: "unavailable",
    marketId: marketId.toString(),
    checkedAt,
  };
}

export function isDueDiligenceApproved(
  verdict: DueDiligenceVerdict,
  expectedMarketId: string,
  nowMs = Date.now(),
  maxAgeMs = 30_000,
): boolean {
  return verdict.outcome === "allow" &&
    verdict.commitments === "verified" &&
    verdict.metadata === "verified" &&
    verdict.resolutionPath === "verified" &&
    (verdict.oracleTrust === "verified" || verdict.oracleTrust === "not_applicable") &&
    (verdict.signerTrust === "verified" || verdict.signerTrust === "not_applicable") &&
    verdict.reasons.length === 0 &&
    verdict.marketId === expectedMarketId &&
    verdict.stateFingerprint !== undefined &&
    verdict.stateFingerprint.length > 0 &&
    Number.isFinite(verdict.checkedAt) &&
    verdict.checkedAt <= nowMs &&
    nowMs - verdict.checkedAt <= maxAgeMs;
}

export function rejectChangedState(verdict: DueDiligenceVerdict): DueDiligenceVerdict {
  return {
    ...verdict,
    outcome: "reject",
    reasons: [
      ...verdict.reasons,
      {
        code: "STALE_MARKET_STATE",
        explanation: "The verified market fingerprint changed between due-diligence checks.",
      },
    ],
  };
}
