/**
 * OracleDesk module for issue #146: Wrap market positions as SEP-41 outcome tokens via a wrapper factory contract
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface Sep41WrapperMintQuoteInput {
  contextId: string;
  marketId: number;
  collateralLockedStroops: number;
  wrapperSupplyStroops: number;
  limitThreshold?: number;
}

export interface Sep41WrapperMintQuote {
  contextId: string;
  marketId: number;
  collateralLockedStroops: number;
  wrapperSupplyStroops: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function computeOutcomeWrapperMint(input: Sep41WrapperMintQuoteInput): Sep41WrapperMintQuote {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("computeOutcomeWrapperMint: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.marketId) ||
    !Number.isFinite(input.collateralLockedStroops) ||
    !Number.isFinite(input.wrapperSupplyStroops)
  ) {
    throw new Error("computeOutcomeWrapperMint: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.marketId));
  const v2 = Math.max(0, Math.trunc(input.collateralLockedStroops));
  const v3 = Math.max(0, Math.trunc(input.wrapperSupplyStroops));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: marketId=${v1}, collateralLockedStroops=${v2}, wrapperSupplyStroops=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, wrapperSupplyStroops=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    marketId: v1,
    collateralLockedStroops: v2,
    wrapperSupplyStroops: v3,
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
