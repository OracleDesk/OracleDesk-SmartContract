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
  | "VERIFICATION_UNAVAILABLE"
  | "RESOLVER_POLICY";

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

// ─── On-chain resolvability policy (#273) ────────────────────────────────────

/** `resolver::SpecKind`, in the contract's order: the position is the bit in `allowedSpecs`. */
export const SPEC_KINDS = ["None", "Price", "ScaledPrice", "Twap", "Signers", "Disputable", "WeightedKeys", "Committee", "Hybrid"] as const;
export type SpecKind = (typeof SPEC_KINDS)[number];

/** The treasury's `ResolvabilityPolicy`. */
export interface ResolvabilityPolicy {
  requireRevealed: boolean;
  blockWhenDisputed: boolean;
  blockWithOpenProposal: boolean;
  minSecsToClose: bigint;
  allowedSpecs: number;
}

/** The resolver's `trade_status` view. */
export interface TradeStatus {
  spec: SpecKind;
  state: string;
  closeTime: bigint;
  deadline: bigint;
  openProposal: boolean;
}

/**
 * Pre-checks what the treasury's `check_resolvable` will enforce on a buy, in
 * the same order and with the same boundaries, so an agent never submits a
 * transaction that reverts. Returns the reasons it would be refused (empty =
 * allowed). The contract stays the authority; this only saves a failed simulation.
 */
export function resolverPolicyReasons(
  status: TradeStatus,
  policy: ResolvabilityPolicy,
  nowSecs: bigint,
): DueDiligenceVerdict["reasons"] {
  const refuse = (what: string) => [{ code: "RESOLVER_POLICY" as const, explanation: `treasury resolvability policy would refuse this buy: ${what}` }];
  if (policy.requireRevealed && status.spec === "None") return refuse("SpecNotRevealed (the resolution spec was never revealed)");
  if ((policy.allowedSpecs & (1 << SPEC_KINDS.indexOf(status.spec))) === 0) return refuse(`SpecKindNotAllowed (${status.spec})`);
  if (policy.blockWhenDisputed && status.state === "Disputed") return refuse("MarketDisputed");
  if (policy.blockWithOpenProposal && status.openProposal) return refuse("ProposalOpen");
  if (nowSecs >= status.deadline) return refuse("PastResolutionDeadline");
  if (policy.minSecsToClose > 0n && (status.closeTime > nowSecs ? status.closeTime - nowSecs : 0n) < policy.minSecsToClose) {
    return refuse(`TooCloseToClose (needs ${policy.minSecsToClose}s before close)`);
  }
  return [];
}
