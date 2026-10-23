/**
 * Deterministic strategy registry and decision replay/audit verifier (#114).
 *
 * Re-executes the recorded `strategyId@version` against the recorded trace
 * inputs, compares the re-derived decision with both the recorded trace
 * decision and optional on-chain execution records, and produces a signed
 * machine-readable audit report. Legacy traces without a `strategy` block are
 * reported as `"not_replayable"`, never as a failure.
 */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  decideMarketProposal,
  decideTrade,
  type MarketMakerDecision,
  type MarketSignal,
  type MarketState,
  type TraderDecision,
} from "./strategy.js";
import { canonicalize, hashTrace, type ReasoningTrace } from "./trace.js";

export interface TraceStrategyDescriptor {
  id: string;
  version: string;
  gitCommit?: string;
  params: Record<string, unknown>;
}

export interface ReplayableTrace extends ReasoningTrace {
  strategy?: TraceStrategyDescriptor;
}

export type ReplayStatus =
  | "verified"
  | "not_replayable"
  | "hash_mismatch"
  | "unknown_strategy"
  | "decision_mismatch"
  | "onchain_mismatch";

export interface OnChainEffectRecord {
  action: "buy" | "sell" | "create_market" | "skip";
  marketId: number;
  outcome?: "Yes" | "No";
  collateralStroops?: bigint;
  seedAmountStroops?: bigint;
  initialYesBps?: number;
}

export interface ReplayAuditReport {
  status: ReplayStatus;
  traceHash: string;
  expectedTraceHash?: string;
  strategyKey?: string;
  recordedDecision?: unknown;
  rederivedDecision?: unknown;
  onChainEffect?: OnChainEffectRecord;
  detail: string;
  reportHash: string;
  signatureHex?: string;
  signerPublicKey?: string;
}

export type PureStrategyFn = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
) => unknown;

export class StrategyRegistry {
  private readonly handlers = new Map<string, PureStrategyFn>();

  register(id: string, version: string, fn: PureStrategyFn): void {
    this.handlers.set(`${id}@${version}`, fn);
  }

  get(id: string, version: string): PureStrategyFn | undefined {
    return this.handlers.get(`${id}@${version}`);
  }
}

function toBigInt(v: unknown, fallback = 0n): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return fallback;
}

export function createDefaultStrategyRegistry(): StrategyRegistry {
  const reg = new StrategyRegistry();

  reg.register("decideTrade", "1", (inputs, params) => {
    const rawMarket = inputs.market as Record<string, unknown>;
    const market: MarketState = {
      marketId: Number(rawMarket.marketId),
      question: String(rawMarket.question ?? ""),
      yesBps: Number(rawMarket.yesBps),
      closeTime: Number(rawMarket.closeTime),
      reserves:
        rawMarket.reserves && typeof rawMarket.reserves === "object"
          ? {
              reserveYes: toBigInt((rawMarket.reserves as Record<string, unknown>).reserveYes),
              reserveNo: toBigInt((rawMarket.reserves as Record<string, unknown>).reserveNo),
              feeBps: BigInt(Number((rawMarket.reserves as Record<string, unknown>).feeBps ?? 0)),
            }
          : undefined,
    };
    const fairValueBps = Number(inputs.fairValueBps);
    return decideTrade(market, fairValueBps, {
      minEdgeBps: Number(params.minEdgeBps ?? 500),
      tradeSizeStroops: toBigInt(params.tradeSizeStroops, 100_000_000n),
      maxImpactBps:
        params.maxImpactBps !== undefined ? Number(params.maxImpactBps) : undefined,
    });
  });

  reg.register("decideMarketProposal", "1", (inputs, params) => {
    const rawSignal = inputs.signal as MarketSignal;
    return decideMarketProposal(rawSignal, {
      confidenceThresholdBps: Number(params.confidenceThresholdBps ?? 1_000),
      defaultSeedStroops: toBigInt(params.defaultSeedStroops, 1_500_000_000n),
    });
  });

  return reg;
}

function decisionsEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function matchesOnChainEffect(
  decision: TraderDecision | MarketMakerDecision,
  effect: OnChainEffectRecord,
): { ok: boolean; reason: string } {
  if (decision.action === "buy") {
    const td = decision as TraderDecision;
    if (effect.action !== "buy") {
      return { ok: false, reason: `expected on-chain buy, got ${effect.action}` };
    }
    if (effect.outcome && td.outcome !== effect.outcome) {
      return { ok: false, reason: `outcome mismatch: decision=${td.outcome}, chain=${effect.outcome}` };
    }
    if (
      effect.collateralStroops !== undefined &&
      td.collateralInStroops !== undefined &&
      td.collateralInStroops !== effect.collateralStroops
    ) {
      return {
        ok: false,
        reason: `collateral mismatch: decision=${td.collateralInStroops}, chain=${effect.collateralStroops}`,
      };
    }
    return { ok: true, reason: "on-chain buy matches re-derived decision" };
  }

  if (decision.action === "propose_market") {
    const md = decision as MarketMakerDecision;
    if (effect.action !== "create_market") {
      return { ok: false, reason: `expected on-chain create_market, got ${effect.action}` };
    }
    if (
      effect.initialYesBps !== undefined &&
      md.initialYesBps !== effect.initialYesBps
    ) {
      return {
        ok: false,
        reason: `initialYesBps mismatch: decision=${md.initialYesBps}, chain=${effect.initialYesBps}`,
      };
    }
    return { ok: true, reason: "on-chain create_market matches re-derived decision" };
  }

  if (effect.action !== "skip") {
    return { ok: false, reason: `decision was skip but on-chain action was ${effect.action}` };
  }
  return { ok: true, reason: "skip matches" };
}

export interface AuditTraceOptions {
  expectedTraceHash?: string;
  registry?: StrategyRegistry;
  onChainEffect?: OnChainEffectRecord;
  signerKeypair?: Keypair;
}

export function auditTraceReplay(
  trace: ReplayableTrace,
  opts: AuditTraceOptions = {},
): ReplayAuditReport {
  const computedHash = hashTrace(trace);
  if (
    opts.expectedTraceHash &&
    computedHash !== opts.expectedTraceHash.toLowerCase().replace(/^0x/, "")
  ) {
    return finalizeReport(
      {
        status: "hash_mismatch",
        traceHash: computedHash,
        expectedTraceHash: opts.expectedTraceHash,
        detail: `computed trace hash ${computedHash} != expected ${opts.expectedTraceHash}`,
      },
      opts.signerKeypair,
    );
  }

  const strategy =
    trace.strategy ?? (trace.inputs?.strategy as TraceStrategyDescriptor | undefined);
  if (!strategy || !strategy.id || !strategy.version) {
    return finalizeReport(
      {
        status: "not_replayable",
        traceHash: computedHash,
        expectedTraceHash: opts.expectedTraceHash,
        detail: "legacy trace has no strategy descriptor (not replayable)",
      },
      opts.signerKeypair,
    );
  }

  const registry = opts.registry ?? createDefaultStrategyRegistry();
  const strategyKey = `${strategy.id}@${strategy.version}`;
  const fn = registry.get(strategy.id, strategy.version);
  if (!fn) {
    return finalizeReport(
      {
        status: "unknown_strategy",
        traceHash: computedHash,
        expectedTraceHash: opts.expectedTraceHash,
        strategyKey,
        detail: `strategy ${strategyKey} is not registered in StrategyRegistry`,
      },
      opts.signerKeypair,
    );
  }

  const recordedDecision = trace.inputs?.decision;
  const rederivedDecision = fn(trace.inputs, strategy.params ?? {});

  if (!decisionsEqual(recordedDecision, rederivedDecision)) {
    return finalizeReport(
      {
        status: "decision_mismatch",
        traceHash: computedHash,
        expectedTraceHash: opts.expectedTraceHash,
        strategyKey,
        recordedDecision,
        rederivedDecision,
        detail: "re-derived decision does not match recorded trace decision",
      },
      opts.signerKeypair,
    );
  }

  if (opts.onChainEffect) {
    const chainCheck = matchesOnChainEffect(
      rederivedDecision as TraderDecision | MarketMakerDecision,
      opts.onChainEffect,
    );
    if (!chainCheck.ok) {
      return finalizeReport(
        {
          status: "onchain_mismatch",
          traceHash: computedHash,
          expectedTraceHash: opts.expectedTraceHash,
          strategyKey,
          recordedDecision,
          rederivedDecision,
          onChainEffect: opts.onChainEffect,
          detail: chainCheck.reason,
        },
        opts.signerKeypair,
      );
    }
  }

  return finalizeReport(
    {
      status: "verified",
      traceHash: computedHash,
      expectedTraceHash: opts.expectedTraceHash,
      strategyKey,
      recordedDecision,
      rederivedDecision,
      onChainEffect: opts.onChainEffect,
      detail: `strategy ${strategyKey} deterministically reproduced recorded decision`,
    },
    opts.signerKeypair,
  );
}

function finalizeReport(
  partial: Omit<ReplayAuditReport, "reportHash">,
  signer?: Keypair,
): ReplayAuditReport {
  const payload = canonicalize(partial);
  const reportHash = createHash("sha256").update(payload).digest("hex");
  if (!signer) {
    return { ...partial, reportHash };
  }
  const sig = signer.sign(Buffer.from(reportHash, "hex"));
  return {
    ...partial,
    reportHash,
    signatureHex: Buffer.from(sig).toString("hex"),
    signerPublicKey: signer.publicKey(),
  };
}
