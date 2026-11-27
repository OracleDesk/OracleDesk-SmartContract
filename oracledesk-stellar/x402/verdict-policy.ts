/**
 * x402/verdict-policy.ts — Issue #306
 *
 * Configurable verdict policy for trace-verdict enforcement.
 * Each non-Valid verdict tag maps to either "refuse" (default) or "sell".
 *
 * Policy is loaded from X402_VERDICT_POLICY (JSON), validated at startup,
 * and applied before any ledger claim is created and again before settlement.
 */

import type { TraceVerdict } from "./trace-verification.js";

export type RefuseAction = { kind: "refuse"; status: 451 | 409 | 503 };
export type SellAction = { kind: "sell"; warn: boolean };
export type VerdictAction = RefuseAction | SellAction;

export interface VerdictPolicy {
  /** What to do when the registry RPC is unavailable. */
  onUnavailable: "refuse" | "sell_unverified";
  /** Per-tag override map. Tags not present fall back to the default (refuse). */
  byTag: Partial<Record<string, VerdictAction>>;
}

/** Default policy: refuse every non-Valid and unknown verdict. */
export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  onUnavailable: "refuse",
  byTag: {
    HashMismatch: { kind: "refuse", status: 409 },
    Flagged: { kind: "refuse", status: 451 },
    AgentRevokedAfter: { kind: "refuse", status: 451 },
    Unknown: { kind: "refuse", status: 451 },
  },
};

/**
 * Loads and validates verdict policy from an env-var JSON string.
 * Returns the default policy if unset.
 */
export function loadVerdictPolicy(env: NodeJS.ProcessEnv): VerdictPolicy {
  const raw = env.X402_VERDICT_POLICY;
  if (!raw) return DEFAULT_VERDICT_POLICY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("X402_VERDICT_POLICY is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("X402_VERDICT_POLICY must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  const onUnavailable = obj["onUnavailable"] ?? "refuse";
  if (onUnavailable !== "refuse" && onUnavailable !== "sell_unverified") {
    throw new Error(
      `X402_VERDICT_POLICY.onUnavailable must be "refuse" or "sell_unverified", got ${String(onUnavailable)}`,
    );
  }

  const byTag: VerdictPolicy["byTag"] = {};
  const rawByTag = obj["byTag"];
  if (rawByTag !== undefined) {
    if (typeof rawByTag !== "object" || rawByTag === null) {
      throw new Error("X402_VERDICT_POLICY.byTag must be an object");
    }
    for (const [tag, action] of Object.entries(rawByTag as Record<string, unknown>)) {
      if (typeof action !== "object" || action === null) {
        throw new Error(`X402_VERDICT_POLICY.byTag.${tag} must be an object`);
      }
      const a = action as Record<string, unknown>;
      if (a["kind"] === "refuse") {
        const status = (a["status"] as number) ?? 451;
        if (status !== 451 && status !== 409 && status !== 503) {
          throw new Error(
            `X402_VERDICT_POLICY.byTag.${tag}.status must be 451, 409, or 503`,
          );
        }
        byTag[tag] = { kind: "refuse", status: status as 451 | 409 | 503 };
      } else if (a["kind"] === "sell") {
        const priceMultiplierBps = a["priceMultiplierBps"];
        if (priceMultiplierBps !== undefined) {
          throw new Error(
            `X402_VERDICT_POLICY: priceMultiplierBps is not supported until the pricing engine is wired (byTag.${tag})`,
          );
        }
        byTag[tag] = { kind: "sell", warn: Boolean(a["warn"] ?? true) };
      } else {
        throw new Error(
          `X402_VERDICT_POLICY.byTag.${tag}.kind must be "refuse" or "sell"`,
        );
      }
    }
  }

  return {
    onUnavailable: onUnavailable as VerdictPolicy["onUnavailable"],
    byTag: { ...DEFAULT_VERDICT_POLICY.byTag, ...byTag },
  };
}

/**
 * Decides what to do with a verdict according to the policy.
 * `"unavailable"` is passed when the RPC call failed (not a contract error).
 */
export function decide(
  verdict: TraceVerdict | "unavailable",
  policy: VerdictPolicy,
): VerdictAction {
  if (verdict === "unavailable") {
    return policy.onUnavailable === "sell_unverified"
      ? { kind: "sell", warn: true }
      : { kind: "refuse", status: 503 };
  }

  const tag = verdict.tag;
  if (tag === "Valid") return { kind: "sell", warn: false };

  const override = policy.byTag[tag];
  if (override) return override;

  // Unknown future tags default to refuse.
  return { kind: "refuse", status: 451 };
}
