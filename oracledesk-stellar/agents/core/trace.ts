/**
 * Builds and hashes the reasoning traces that get recorded on-chain via
 * reasoning-registry.publish_trace and sold over x402. A trace records why
 * an agent took an action, in a form a paying subscriber can check against
 * the on-chain hash (see x402/trace-verification.ts) before trusting it.
 *
 * The hash is sha256 of the *canonical* JSON encoding — same field order,
 * no whitespace variance — so the same trace object always hashes the same
 * way regardless of how it was constructed or serialized upstream.
 */

import { createHash, randomBytes } from "node:crypto";

export type AgentRole = "market-maker" | "trader";

export const NO_MARKET = 18446744073709551615n; // u64::MAX (#55)

export type TraceActionType =
  | { tag: "CreateMarket"; values?: void }
  | { tag: "ProposeMarket"; values?: void }
  | { tag: "Buy"; values?: void }
  | { tag: "Sell"; values?: void }
  | { tag: "Skip"; values?: void }
  | { tag: "Redeem"; values?: void }
  | { tag: "ClaimRemainder"; values?: void }
  | { tag: "Resolve"; values?: void }
  | { tag: "Other"; values: readonly [string] };

export type TraceActionString =
  | "create_market"
  | "propose_market"
  | "buy"
  | "sell"
  | "skip"
  | "redeem"
  | "claim_remainder"
  | "resolve"
  | `other:${string}`
  | (string & {});

export function toTraceAction(action: string): TraceActionType {
  switch (action) {
    case "create_market":
      return { tag: "CreateMarket" };
    case "propose_market":
      return { tag: "ProposeMarket" };
    case "buy":
      return { tag: "Buy" };
    case "sell":
      return { tag: "Sell" };
    case "skip":
      return { tag: "Skip" };
    case "redeem":
      return { tag: "Redeem" };
    case "claim_remainder":
      return { tag: "ClaimRemainder" };
    case "resolve":
      return { tag: "Resolve" };
    default:
      if (action.startsWith("other:")) {
        return { tag: "Other", values: [action.slice(6)] };
      }
      return { tag: "Other", values: [action] };
  }
}

export function fromTraceAction(action: TraceActionType): TraceActionString {
  switch (action.tag) {
    case "CreateMarket":
      return "create_market";
    case "ProposeMarket":
      return "propose_market";
    case "Buy":
      return "buy";
    case "Sell":
      return "sell";
    case "Skip":
      return "skip";
    case "Redeem":
      return "redeem";
    case "ClaimRemainder":
      return "claim_remainder";
    case "Resolve":
      return "resolve";
    case "Other":
      return `other:${action.values[0]}` as TraceActionString;
  }
}

/** @deprecated Use ReasoningTraceV2 for new traces. V1 traces have no schemaVersion. */
export interface ReasoningTrace {
  agent: AgentRole;
  marketId: number | null; // null for a not-yet-created market (agent proposals)
  action: TraceActionString;
  reasoning: string;
  /** Whatever signals/estimates informed the decision — kept as plain
   * JSON-serializable data so it survives the canonicalization below. */
  inputs: Record<string, unknown>;
  timestamp: number; // unix seconds
}

// ─── V2 trace types ───────────────────────────────────────────────────────────

/**
 * V2 traces carry schemaVersion: 2, use string-encoded u64 marketId to avoid
 * JS number precision loss, and require action-specific inputs validated against
 * trace.schema.json before the trace is hashed. canonicalize is unchanged, so
 * existing v1 hashes remain valid.
 */

export type TraceActionV2 =
  | "buy"
  | "sell"
  | "create_market"
  | "inventory_rebalance"
  | "risk_reject"
  | "skip"
  | "redeem"
  | "claim_remainder"
  | "resolve";

export interface FairValueEstimate {
  bps: number;
  source: string;
  observedAt: number;
}

export interface TradeContracts {
  marketCore: string;
  treasury: string;
}

export interface BuyInputs {
  marketId: string;
  ledgerSequence: number;
  ledgerCloseTime: number;
  reserveYes: string;
  reserveNo: string;
  feeBps: number;
  /** floor(reserveNo * 10000 / (reserveYes + reserveNo)) — must match reserves */
  priceYesBps: number;
  fairValue: FairValueEstimate;
  order: { outcome: "yes" | "no"; collateralIn: string; minSharesOut: string };
  contracts: TradeContracts;
  extensions?: Record<string, unknown>;
}

export interface SellInputs {
  marketId: string;
  ledgerSequence: number;
  ledgerCloseTime: number;
  reserveYes: string;
  reserveNo: string;
  feeBps: number;
  priceYesBps: number;
  fairValue: FairValueEstimate;
  order: { outcome: "yes" | "no"; sharesIn: string; minCollateralOut: string };
  contracts: TradeContracts;
  extensions?: Record<string, unknown>;
}

export interface CreateMarketInputs {
  questionHash: string;
  resolutionCommitment: string;
  initialYesBps: number;
  seedAmount: string;
  closeTime: number;
  category: string;
  extensions?: Record<string, unknown>;
}

export interface InventoryRebalanceInputs {
  marketId: string;
  ledgerSequence: number;
  currentExposure: { yes: string; no: string };
  targetExposure: { yes: string; no: string };
  action: "buy_yes" | "buy_no" | "sell_yes" | "sell_no" | "none";
  extensions?: Record<string, unknown>;
}

export interface RiskRejectInputs {
  marketId: string;
  reason: string;
  checkedAt?: number;
  extensions?: Record<string, unknown>;
}

export type ReasoningTraceV2 =
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: "buy"; reasoning: string; inputs: BuyInputs; timestamp: number }
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: "sell"; reasoning: string; inputs: SellInputs; timestamp: number }
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: "create_market"; reasoning: string; inputs: CreateMarketInputs; timestamp: number }
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: "inventory_rebalance"; reasoning: string; inputs: InventoryRebalanceInputs; timestamp: number }
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: "risk_reject"; reasoning: string; inputs: RiskRejectInputs; timestamp: number }
  | { schemaVersion: 2; agent: AgentRole; marketId: string | null; action: Exclude<TraceActionV2, "buy" | "sell" | "create_market" | "inventory_rebalance" | "risk_reject">; reasoning: string; inputs: Record<string, unknown>; timestamp: number };

/**
 * Deterministic JSON encoding: object keys sorted recursively, no
 * insignificant whitespace. Arrays keep their given order (order is
 * significant there). This must stay byte-for-byte stable over time —
 * changing it changes every future trace's hash relative to past ones, so
 * treat it as part of the public interface, not an implementation detail.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  // JSON has no bigint literal; stringify it explicitly rather than
  // letting JSON.stringify throw. Traces regularly carry stroop amounts.
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashTrace(trace: ReasoningTrace): string {
  return createHash("sha256").update(canonicalize(trace)).digest("hex");
}

export interface BuiltTrace {
  trace: ReasoningTrace;
  json: string;
  hash: string;
}

export function buildTrace(input: Omit<ReasoningTrace, "timestamp"> & { timestamp?: number }): BuiltTrace {
  const trace: ReasoningTrace = { ...input, timestamp: input.timestamp ?? Math.floor(Date.now() / 1000) };
  const json = canonicalize(trace);
  return { trace, json, hash: createHash("sha256").update(json).digest("hex") };
}

export interface BuiltTraceV2 {
  trace: ReasoningTraceV2;
  json: string;
  hash: string;
}

/**
 * Build and hash a v2 trace. Injects schemaVersion: 2 and timestamp, then
 * canonicalizes with the same unchanged canonicalize function so v2 hashes use
 * the same algorithm as v1.
 *
 * Cross-field semantic checks are applied before hashing:
 *   - buy/sell: priceYesBps must equal floor(reserveNo*10000/(reserveYes+reserveNo))
 *   - buy/sell: marketId in inputs must match the trace-level marketId
 *
 * Throws if either check fails, so an invalid trace is never hashed.
 */
export function buildTraceV2(
  input: Omit<ReasoningTraceV2, "timestamp" | "schemaVersion"> & { timestamp?: number }
): BuiltTraceV2 {
  const trace = {
    ...input,
    schemaVersion: 2 as const,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
  } as ReasoningTraceV2;

  // Cross-field checks for trade actions
  if (trace.action === "buy" || trace.action === "sell") {
    const inp = trace.inputs as BuyInputs | SellInputs;
    const reserveYes = BigInt(inp.reserveYes);
    const reserveNo = BigInt(inp.reserveNo);
    const total = reserveYes + reserveNo;
    if (total > 0n) {
      const expectedPriceYesBps = Number((reserveNo * 10000n) / total);
      if (inp.priceYesBps !== expectedPriceYesBps) {
        throw new Error(
          `priceYesBps mismatch: trace has ${inp.priceYesBps}, reserves imply ${expectedPriceYesBps}`
        );
      }
    }
    if (trace.marketId !== null && inp.marketId !== trace.marketId) {
      throw new Error(
        `marketId mismatch: trace-level ${trace.marketId}, inputs.marketId ${inp.marketId}`
      );
    }
  }

  const json = canonicalize(trace);
  return { trace, json, hash: createHash("sha256").update(json).digest("hex") };
}

/**
 * Where a built trace's JSON is persisted before its CID goes on-chain.
 * `LocalTraceStore` is the dry-run/dev default (writes under a local
 * directory); a real deployment swaps in an IPFS-pinning implementation of
 * this same interface without touching any calling code.
 */
export interface TraceStore {
  put(hash: string, json: string): Promise<{ cid: string }>;
}

export class LocalTraceStore implements TraceStore {
  constructor(private readonly dir: string) {}

  async put(hash: string, json: string): Promise<{ cid: string }> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${hash}.json`);
    await writeFile(path, json, "utf8");
    // Not a real content identifier — this is the dry-run/dev store. A
    // production TraceStore (pinning to IPFS) returns a real CID here.
    return { cid: `local://${path}` };
  }
}

// ─── Commit-reveal (#51) ─────────────────────────────────────────────────────

/**
 * Domain tag for trace commitments. Must match `COMMIT_DOMAIN_TAG` in
 * contracts/reasoning-registry/src/lib.rs byte-for-byte; the shared golden
 * vector in trace.test.ts and the Rust tests keeps the two from drifting.
 */
export const COMMIT_DOMAIN_TAG = "oracledesk.trace.commit.v1";

function hex32(value: string, name: string): Buffer {
  const normalized = value.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${name} must be 32 bytes of hex`);
  }
  return Buffer.from(normalized, "hex");
}

/**
 * Commitment the agent records before acting:
 * `sha256(COMMIT_DOMAIN_TAG || trace_hash || salt)`, as lowercase hex. It
 * fixes the trace content without revealing it until `reveal_trace`.
 */
export function commitmentFor(hashHex: string, saltHex: string): string {
  return createHash("sha256")
    .update(Buffer.from(COMMIT_DOMAIN_TAG, "utf8"))
    .update(hex32(hashHex, "trace hash"))
    .update(hex32(saltHex, "salt"))
    .digest("hex");
}

/**
 * A fresh 32-byte random salt (hex). It must be random and full-length: a
 * short or predictable salt lets anyone brute-force the trace hash from
 * known trace templates. Keep it — losing it makes the reveal impossible.
 */
export function newSalt(): string {
  return randomBytes(32).toString("hex");
}
