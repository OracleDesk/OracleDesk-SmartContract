import {
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

export type ActionClass = "trade" | "create" | "trace" | "maintenance";
export type FeePercentile = "p50" | "p70" | "p90" | "p95" | "p99";

export interface FeeDistribution {
  max: string;
  min: string;
  mode: string;
  p10: string;
  p20: string;
  p30: string;
  p40: string;
  p50: string;
  p60: string;
  p70: string;
  p80: string;
  p90: string;
  p95: string;
  p99: string;
  transactionCount: string;
  ledgerCount: number;
}

export interface FeeStatsResponse {
  sorobanInclusionFee: FeeDistribution;
  inclusionFee: FeeDistribution;
  latestLedger: number;
}

export interface FeeRule {
  percentile: FeePercentile;
  minInclusion: bigint;
  maxInclusion: bigint;
  resourceMarginBps: number;
  maxTotalFee: bigint;
  bumpMultiplier: number;
  maxBumps: number;
}

export interface FeePolicy {
  policyFile?: string;
  feePayerSecret?: string;
  policies: Record<ActionClass, FeeRule>;
  maxDailyFees: Record<ActionClass, bigint>;
}

export const DEFAULT_FEE_POLICY: Record<ActionClass, FeeRule> = {
  trade: {
    percentile: "p90",
    minInclusion: 100n,
    maxInclusion: 10_000n,
    resourceMarginBps: 1_500,
    maxTotalFee: 50_000_000n,
    bumpMultiplier: 10,
    maxBumps: 3,
  },
  create: {
    percentile: "p70",
    minInclusion: 100n,
    maxInclusion: 5_000n,
    resourceMarginBps: 1_000,
    maxTotalFee: 30_000_000n,
    bumpMultiplier: 10,
    maxBumps: 2,
  },
  trace: {
    percentile: "p70",
    minInclusion: 100n,
    maxInclusion: 5_000n,
    resourceMarginBps: 1_000,
    maxTotalFee: 20_000_000n,
    bumpMultiplier: 10,
    maxBumps: 2,
  },
  maintenance: {
    percentile: "p50",
    minInclusion: 100n,
    maxInclusion: 2_000n,
    resourceMarginBps: 500,
    maxTotalFee: 10_000_000n,
    bumpMultiplier: 10,
    maxBumps: 1,
  },
};

const TRADE_METHODS = new Set([
  "agent_buy",
  "agent_buy_v2",
  "agent_buy_traced",
  "agent_sell",
  "agent_sell_v2",
  "agent_sell_traced",
  "trade_and_publish_trace",
  "agent_trade_and_publish_trace",
]);
const CREATE_METHODS = new Set([
  "agent_create_market",
  "agent_create_market_traced",
  "agent_create_market_and_reveal",
  "agent_create_market_and_reveal_traced",
]);
const TRACE_METHODS = new Set([
  "publish_trace",
  "publish_trace_batch",
  "publish_trace_signed",
  "publish_chained_trace",
  "publish_chained_trace_signed",
  "publish_decision_trace",
  "publish_chained_decision_trace",
]);

export function feePolicyFor(method: string): ActionClass {
  if (TRADE_METHODS.has(method)) return "trade";
  if (CREATE_METHODS.has(method)) return "create";
  if (TRACE_METHODS.has(method)) return "trace";
  return "maintenance";
}

export function inclusionBid(stats: FeeStatsResponse, rule: FeeRule): bigint {
  const observed = BigInt(stats.sorobanInclusionFee[rule.percentile]);
  if (observed < rule.minInclusion) return rule.minInclusion;
  if (observed > rule.maxInclusion) return rule.maxInclusion;
  return observed;
}

export function resourceFeeOf(tx: Transaction): bigint {
  const envelope = tx.toEnvelope();
  if (envelope.switch().value !== 1) return 0n;
  const ext = envelope.v1().tx().ext();
  if (ext.switch().value !== 1) return 0n;
  const data = ext.value() as xdr.SorobanTransactionData | undefined;
  return data ? data.resourceFee().toBigInt() : 0n;
}

export function applyResourceMargin(tx: Transaction, marginBps: number): Transaction {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new RangeError("resourceMarginBps must be an integer from 0 to 10000");
  }
  if (marginBps === 0) return tx;
  if (tx.signatures.length > 0) {
    throw new TypeError("resource fee margin must be applied before signing");
  }

  const envelope = tx.toEnvelope();
  if (envelope.switch().value !== 1) return tx;
  const ext = envelope.v1().tx().ext();
  if (ext.switch().value !== 1) return tx;
  const data = ext.value() as xdr.SorobanTransactionData | undefined;
  if (!data) return tx;

  const resourceFee = data.resourceFee().toBigInt();
  const margin = (resourceFee * BigInt(marginBps) + 9_999n) / 10_000n;
  if (margin === 0n) return tx;

  const updated = new SorobanDataBuilder(data).setResourceFee(resourceFee + margin).build();
  const inclusionPerOp = BigInt(tx.fee);
  if (inclusionPerOp <= 0n) throw new RangeError("transaction inclusion fee must be positive");

  const builder = TransactionBuilder.cloneFrom(tx, { fee: inclusionPerOp.toString() });
  builder.setSorobanData(updated);
  return builder.build();
}
