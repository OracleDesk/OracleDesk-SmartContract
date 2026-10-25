/**
 * OracleDesk module for issue #142: Write a normative protocol specification with pre/postconditions for every entrypoint
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./trace.js";

export interface EntrypointInvariantCheckInput {
  contextId: string;
  preReserveK: number;
  postReserveK: number;
  feeChargedBps: number;
  limitThreshold?: number;
}

export interface EntrypointInvariantCheck {
  contextId: string;
  preReserveK: number;
  postReserveK: number;
  feeChargedBps: number;
  scoreBps: number;
  status: "ok" | "warning" | "blocked";
  reason: string;
  digestHex: string;
}

export function verifyEntrypointPrePostConditions(input: EntrypointInvariantCheckInput): EntrypointInvariantCheck {
  const contextId = input.contextId.trim();
  if (!contextId) {
    throw new Error("verifyEntrypointPrePostConditions: contextId must be non-empty");
  }
  if (
    !Number.isFinite(input.preReserveK) ||
    !Number.isFinite(input.postReserveK) ||
    !Number.isFinite(input.feeChargedBps)
  ) {
    throw new Error("verifyEntrypointPrePostConditions: numeric inputs must be finite");
  }

  const v1 = Math.max(0, Math.trunc(input.preReserveK));
  const v2 = Math.max(0, Math.trunc(input.postReserveK));
  const v3 = Math.max(0, Math.trunc(input.feeChargedBps));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 1000));

  const scoreBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: "ok" | "warning" | "blocked" = "ok";
  let reason = `nominal: preReserveK=${v1}, postReserveK=${v2}, feeChargedBps=${v3}`;

  if (v3 > limit || scoreBps >= 9000) {
    status = "blocked";
    reason = `threshold exceeded: score=${scoreBps}bps, feeChargedBps=${v3} > limit=${limit}`;
  } else if (scoreBps >= 5000) {
    status = "warning";
    reason = `elevated load: score=${scoreBps}bps for ${contextId}`;
  }

  const payload = {
    contextId,
    preReserveK: v1,
    postReserveK: v2,
    feeChargedBps: v3,
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
