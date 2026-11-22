/**
 * The watcher's dispute decision rule (#275).
 *
 * Economics, from the contract: a correct dispute only refunds the bond (the
 * resolver pays no reward); a wrong one forfeits it to market-core's treasury.
 * The watcher therefore profits from a dispute only by protecting positions
 * the treasury already holds, so the rule weighs expected protected value
 * against expected bond loss:
 *
 *     protected * p  >  bond * (1 - p)          with p = confidenceBps / 10_000
 *
 * evaluated in integer stroops with strict inequality: rounding and ties go
 * toward not disputing.
 */
import type { AttestedOutcome } from "./events/decode.js";

export const BPS = 10_000n;

/** What the treasury holds in the market, in stroops of payout. */
export interface Exposure {
  yes: bigint;
  no: bigint;
  /** Refunded on a void market; payout of an Invalid outcome. */
  costBasis: bigint;
}

/** Collateral the treasury receives when the market settles as `outcome`. */
export function payoutFor(exposure: Exposure, outcome: AttestedOutcome): bigint {
  return outcome === "Yes" ? exposure.yes : outcome === "No" ? exposure.no : exposure.costBasis;
}

/**
 * How much better the treasury does if `verdict` settles instead of
 * `proposal`. Zero when the proposal is already at least as good for it.
 */
export function protectedValue(exposure: Exposure, proposal: AttestedOutcome, verdict: AttestedOutcome): bigint {
  const gain = payoutFor(exposure, verdict) - payoutFor(exposure, proposal);
  return gain > 0n ? gain : 0n;
}

export interface DisputePolicyConfig {
  /** Default 9_500. */
  minConfidenceBps: number;
  /** Seconds of dispute window that must remain. Default 60. */
  minLeadSecs: bigint;
}

export const DEFAULT_POLICY: DisputePolicyConfig = { minConfidenceBps: 9_500, minLeadSecs: 60n };

export interface DisputeInputs {
  proposal: AttestedOutcome;
  verdict: { outcome: AttestedOutcome; confidenceBps: number };
  exposure: Exposure;
  bond: bigint;
  /** Collateral the budget would still let the watcher put at risk, stroops. */
  budgetAvailable: bigint;
  /** Dispute deadline minus the latest ledger close time, seconds (may be negative). */
  secondsLeft: bigint;
}

export type DisputeSkipReason =
  | "AGREES_WITH_PROPOSAL"
  | "LOW_CONFIDENCE"
  | "NOT_WORTH_BOND"
  | "BUDGET"
  | "TOO_LATE";

export type DisputeDecision =
  | { dispute: true; protectedValue: bigint }
  | { dispute: false; reason: DisputeSkipReason; protectedValue: bigint };

export function decideDispute(i: DisputeInputs, cfg: DisputePolicyConfig = DEFAULT_POLICY): DisputeDecision {
  const protectedAmount = protectedValue(i.exposure, i.proposal, i.verdict.outcome);
  const skip = (reason: DisputeSkipReason): DisputeDecision => ({ dispute: false, reason, protectedValue: protectedAmount });
  if (i.verdict.outcome === i.proposal) return skip("AGREES_WITH_PROPOSAL");
  const p = BigInt(Math.max(0, Math.min(10_000, Math.trunc(i.verdict.confidenceBps))));
  if (i.verdict.confidenceBps < cfg.minConfidenceBps) return skip("LOW_CONFIDENCE");
  if (i.secondsLeft < cfg.minLeadSecs) return skip("TOO_LATE");
  if (protectedAmount * p <= i.bond * (BPS - p)) return skip("NOT_WORTH_BOND");
  if (i.budgetAvailable < i.bond) return skip("BUDGET");
  return { dispute: true, protectedValue: protectedAmount };
}

/**
 * The outcome to claim in `dispute(alternative)`. The contract accepts only
 * Yes/No/None (None = Invalid) and rejects an alternative equal to the
 * proposal, so the verdict can be passed straight through.
 */
export function alternativeFor(verdict: AttestedOutcome): "Yes" | "No" | null {
  return verdict === "Invalid" ? null : verdict;
}
