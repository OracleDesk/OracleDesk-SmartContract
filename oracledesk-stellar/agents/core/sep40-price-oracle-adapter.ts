/**
 * OracleDesk module for issue #133: Add a deployable SEP-40 test oracle contract and a price-mode demo path
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface Sep40PriceResolutionInput {
  contextId: string;
  oraclePriceScaled: number;
  strikePriceScaled: number;
  stalenessSecs: number;
  limitThreshold?: number;
}

export interface Sep40PriceResolution {
  contextId: string;
  oraclePriceScaled: number;
  strikePriceScaled: number;
  stalenessSecs: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function evaluateSep40OraclePrice(input: Sep40PriceResolutionInput): Sep40PriceResolution {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("evaluateSep40OraclePrice: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.oraclePriceScaled) ||
    !Number.isFinite(input.strikePriceScaled) ||
    !Number.isFinite(input.stalenessSecs)
  ) {
    throw new Error("evaluateSep40OraclePrice: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.oraclePriceScaled));
  const v2 = Math.max(0, Math.trunc(input.strikePriceScaled));
  const v3 = Math.max(0, Math.trunc(input.stalenessSecs));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: oraclePriceScaled=${v1}, strikePriceScaled=${v2}, stalenessSecs=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, stalenessSecs=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    oraclePriceScaled: v1,
    strikePriceScaled: v2,
    stalenessSecs: v3,
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
