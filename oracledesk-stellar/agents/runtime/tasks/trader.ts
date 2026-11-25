/**
 * The trader as a runtime task: the body of the old bin/trader.ts main().
 *
 * For each candidate market: skip our own markets until the maker has
 * revealed them (and anything still "creating"); under that market's
 * advisory lock, decide, store the trace, quote, then submit a bounded
 * `agent_buy_v2` (intent recorded first, "done" after) and publish the
 * trace through the pending-trace queue.
 */
import { BPS } from "../../core/fpmm.js";
import { deltaBps, type Inventory } from "../../core/inventory.js";
import { decideTrade, decideTradeSized, type FairValueResult, type MarketState } from "../../core/strategy.js";
import type { CapsView, Holdings, SizingParams } from "../../core/sizing.js";
import { buildTrace, buildTraceV2, decisionHashBuy, type FairValueEstimate, type TraceStore } from "../../core/trace.js";
import {
  isDueDiligenceApproved,
  rejectChangedState,
  unavailableDueDiligence,
  type DueDiligenceVerdict,
} from "../../core/due-diligence.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";
import { openingsAllowed } from "./mode.js";
import { publishPendingTraces, recordPendingTrace } from "./traces.js";

export interface TraderRiskInput {
  marketId: bigint;
  amount: bigint;
  priceBeforeBps: bigint;
  priceAfterBps: bigint;
  quotedShares: bigint;
  minSharesOut: bigint;
}

export interface TraderRiskCheck {
  (input: TraderRiskInput): Promise<{ violations: string[]; unverifiable: string[] }>;
}

export interface TraderCandidate {
  market: MarketState;
  fairValueBps: number;
  /** Estimate-specific uncertainty (#331); overrides `TraderDeps.uncertaintyBps`. */
  uncertaintyBps?: number;
  /** The full estimate, recorded in the buy trace for replay (#331). */
  fairValue?: FairValueResult;
  /** Close time of the ledger the market state was read at (unix secs). */
  ledgerCloseTime?: number;
  /** Creator address, when known (our treasury => one of our own markets). */
  creator?: string;
  questionHash?: string;
  /** Ledger the market state was read at, if known. */
  ledger?: number;
  holdings?: Holdings;
  caps?: CapsView;
  setsMinted?: bigint;
  inventory?: Inventory;
}

export interface TraderDeps {
  adapter: Pick<
    StellarAdapter,
    | "mode"
    | "agent"
    | "quoteBuy"
    | "agentBuyV2"
    | "publishTrace"
    | "publishDecisionTrace"
    | "agentBuyTraced"
  > &
    Partial<
      Pick<
        StellarAdapter,
        "currentFeeBps" | "riskCaps" | "marketExposure" | "treasuryPosition" | "treasuryMode"
      >
    >;
  traceStore: TraceStore;
  candidates: () => Promise<TraderCandidate[]>;
  /** This deployment's treasury contract id (creator of our own markets). */
  treasury?: string;
  /** Contract ids recorded in v2 trade traces. */
  contracts?: { marketCore: string; treasury: string };
  minEdgeBps: number;
  tradeSizeStroops: bigint;
  slippageBps: bigint;
  sizingParams?: SizingParams;
  uncertaintyBps?: bigint;
  inventoryMaxDeltaBps?: bigint;
  deadlineSecs: number;
  /** Unix seconds. */
  nowSecs: () => number;
  /**
   * Must re-read and verify current on-chain state, metadata, commitments,
   * resolution viability, and applicable trust policy. Missing verifier
   * configuration rejects trades.
   */
  dueDiligence?: (marketId: bigint) => Promise<DueDiligenceVerdict>;
  riskCheck?: TraderRiskCheck;
}

export const TRADES = "trader.trades";
export const EVALUATED = "trader.markets";

async function verifyTrade(deps: TraderDeps, marketId: bigint, nowSecs: () => number): Promise<DueDiligenceVerdict> {
  return deps.dueDiligence
    ? deps.dueDiligence(marketId)
    : unavailableDueDiligence(marketId, nowSecs() * 1000);
}

/** The pre-chain-state demo pair (YES at 40% vs fair 60%). */
export async function fixtureCandidates(nowSecs: number): Promise<TraderCandidate[]> {
  return [{ market: { marketId: 0, question: "demo", yesBps: 4000, closeTime: nowSecs + 3600 }, fairValueBps: 6000 }];
}

export async function traderTick(deps: TraderDeps, ctx: TaskContext): Promise<void> {
  const live = deps.adapter.mode === "live";
  if (live) await publishPendingTraces(deps.adapter, ctx);
  // The trader only opens exposure: skip the whole tick unless the treasury is Normal.
  if (!(await openingsAllowed(deps.adapter, ctx, "TRADER"))) return;
  const candidates = await deps.candidates();
  if (candidates.length === 0) ctx.log.info("TRADER_NO_MARKETS");
  for (const c of candidates) {
    if (ctx.signal.aborted) return;
    const { market, fairValueBps } = c;
    const directional = c.inventory && ((c.inventory.delta > 0n && fairValueBps > market.yesBps) ||
      (c.inventory.delta < 0n && fairValueBps < market.yesBps));
    if (c.inventory && directional && deps.inventoryMaxDeltaBps !== undefined &&
        deltaBps(c.inventory, c.inventory.floor > 0n ? c.inventory.floor : 1n) > deps.inventoryMaxDeltaBps) {
      ctx.log.info("TRADER_SKIP_INVENTORY_BAND", { market: market.marketId, delta: c.inventory.delta });
      continue;
    }
    const own = deps.treasury !== undefined && c.creator === deps.treasury;
    if (own && !ctx.locks.ownMarketTradable(market.marketId, c.questionHash)) {
      ctx.log.info("TRADER_SKIP_UNREVEALED", { market: market.marketId, status: ctx.locks.status(market.marketId) ?? "unknown" });
      continue;
    }
    await ctx.locks.withLock(market.marketId, async () => {
      ctx.state.set(EVALUATED, String(market.marketId), { at: ctx.now(), ledger: c.ledger, yesBps: market.yesBps });
      const pool = market.reserveYesStroops !== undefined && market.reserveNoStroops !== undefined && market.feeBps !== undefined
        ? {
            reserveYes: market.reserveYesStroops,
            reserveNo: market.reserveNoStroops,
            feeBps: BigInt(market.feeBps),
            setsMinted: c.setsMinted ?? 0n,
          }
        : undefined;
      const sized = pool && c.holdings && c.caps && deps.sizingParams
        ? decideTradeSized(
            market,
            pool,
            c.holdings,
            c.caps,
            {
              fairYesBps: BigInt(fairValueBps),
              uncertaintyBps: c.uncertaintyBps !== undefined ? BigInt(c.uncertaintyBps) : (deps.uncertaintyBps ?? 0n),
            },
            deps.sizingParams,
            deps.minEdgeBps,
          )
        : undefined;
      const decision = sized ?? decideTrade(market, fairValueBps, {
        minEdgeBps: deps.minEdgeBps,
        tradeSizeStroops: deps.tradeSizeStroops,
      });
      ctx.log.info("TRADER_DECISION", { market: market.marketId, action: decision.action, reasoning: decision.reasoning });
      if (decision.action === "skip") return;

      const outcome = { tag: decision.outcome!, values: undefined as void };
      const collateralIn = decision.collateralInStroops!;
      const quoted = await deps.adapter.quoteBuy({ market_id: BigInt(market.marketId), outcome, collateral_in: collateralIn });
      const minSharesOut = sized?.sizedBuy?.minSharesOut
        ?? (quoted * (BPS - deps.slippageBps)) / BPS;
      const limitPriceBps = sized?.sizing
        ? Number(sized.sizing.inputs.targetBps)
        : decision.outcome === "Yes" ? fairValueBps : Number(BPS) - fairValueBps;
      const deadline = BigInt(deps.nowSecs() + deps.deadlineSecs);
      ctx.log.info("TRADER_QUOTE", { quoted, minSharesOut, limitPriceBps, deadline });
      if (deps.riskCheck && live) {
        const risk = await deps.riskCheck({
          marketId: BigInt(market.marketId),
          amount: collateralIn,
          priceBeforeBps: BigInt(limitPriceBps),
          priceAfterBps: BigInt(limitPriceBps),
          quotedShares: quoted,
          minSharesOut,
        });
        if (risk.unverifiable.length > 0) ctx.log.warn("TRADER_RISK_UNVERIFIABLE", { market: market.marketId, reasons: risk.unverifiable });
        if (risk.violations.length > 0) {
          ctx.log.error("TRADER_RISK_VIOLATION", { market: market.marketId, reasons: risk.violations });
          await ctx.kill({ code: "risk", detail: risk.violations.join("; "), at: ctx.now() });
          return;
        }
      }
      if (ctx.signal.aborted) return;

      const verdict = await verifyTrade(deps, BigInt(market.marketId), deps.nowSecs);
      const approved = isDueDiligenceApproved(verdict, String(market.marketId), ctx.now());
      ctx.log.info("TRADER_DUE_DILIGENCE", { market: market.marketId, verdict });
      const v2 = approved
        ? buyTraceV2(deps, c, {
            reasoning: decision.reasoning,
            outcome: decision.outcome!,
            collateralIn,
            minSharesOut,
            extensions: { decision, sizing: sized?.sizing, dueDiligence: verdict, limitPriceBps },
          })
        : undefined;
      const built = v2 ?? buildTrace({
        agent: "trader",
        marketId: market.marketId,
        action: approved ? "buy" : "skip",
        reasoning: approved
          ? decision.reasoning
          : `trade rejected by due diligence: ${verdict.reasons.map((reason) => reason.code).join(", ")}`,
        inputs: { market, fairValueBps, ...(c.fairValue ? { fairValue: c.fairValue } : {}), decision, sizing: sized?.sizing, dueDiligence: verdict },
      });
      const { cid } = await deps.traceStore.put(built.hash, built.json);
      ctx.log.info("TRADER_TRACE", { trace: built.hash, cid });

      if (!approved) {
        if (live) {
          recordPendingTrace(ctx, {
            marketId: BigInt(market.marketId),
            action: "skip",
            traceHash: built.hash,
            cid,
          });
          await publishPendingTraces(deps.adapter, ctx);
        }
        return;
      }

      const key = `${market.marketId}:${built.hash}`;
      if (live) ctx.state.set(TRADES, key, { status: "intent", at: ctx.now() });
      const outcomeTag = decision.outcome === "Yes" ? 0 : 1;
      const decisionHash = decisionHashBuy({
        marketId: BigInt(market.marketId),
        outcome: decision.outcome!,
        collateralIn,
        minSharesOut,
        limitPriceBps,
        deadline,
      });
      let traceId: bigint | undefined;
      if (live) {
        recordPendingTrace(ctx, {
          marketId: BigInt(market.marketId),
          action: "buy",
          traceHash: built.hash,
          cid,
          decisionHash,
        });
        await publishPendingTraces(deps.adapter, ctx);
        traceId = ctx.state.get<{ traceId?: bigint }>("traces", `${BigInt(market.marketId)}:buy:${built.hash}`)?.traceId;
        if (traceId === undefined) throw new Error("trace was not published before trade");
      }
      const submission = await ctx.submit(async () => {
        const observedVerdict = await verifyTrade(deps, BigInt(market.marketId), deps.nowSecs);
        const finalVerdict = observedVerdict.stateFingerprint === verdict.stateFingerprint
          ? observedVerdict
          : rejectChangedState(observedVerdict);
        if (!isDueDiligenceApproved(finalVerdict, String(market.marketId), ctx.now())) {
          return { kind: "rejected" as const, verdict: finalVerdict };
        }
        const args = {
          market_id: BigInt(market.marketId),
          outcome,
          collateral_in: collateralIn,
          min_shares_out: minSharesOut,
          limit_price_bps: limitPriceBps,
          deadline,
        };
        return {
          kind: "submitted" as const,
          result: live && traceId !== undefined
            ? await deps.adapter.agentBuyTraced({
                agent: deps.adapter.agent,
                marketId: args.market_id,
                outcome: outcomeTag,
                collateralIn: args.collateral_in,
                minSharesOut: args.min_shares_out,
                limitPriceBps: args.limit_price_bps,
                deadline: args.deadline,
                traceId,
              })
            : await deps.adapter.agentBuyV2(args),
        };
      }, `buy:${key}`);
      if (submission.kind === "rejected") {
        const rejectedTrace = buildTrace({
          agent: "trader",
          marketId: market.marketId,
          action: "skip",
          reasoning: `trade rejected by final due-diligence recheck: ${submission.verdict.reasons.map((reason) => reason.code).join(", ")}`,
          inputs: { market, fairValueBps, decision, dueDiligence: submission.verdict },
        });
        const rejectedTraceStore = await deps.traceStore.put(rejectedTrace.hash, rejectedTrace.json);
        ctx.log.warn("TRADER_DUE_DILIGENCE_REJECTED", { market: market.marketId, verdict: submission.verdict });
        if (live) {
          recordPendingTrace(ctx, {
            marketId: BigInt(market.marketId),
            action: "skip",
            traceHash: rejectedTrace.hash,
            cid: rejectedTraceStore.cid,
          });
          await publishPendingTraces(deps.adapter, ctx);
        }
        return;
      }
      const result = submission.result;
      ctx.log.info("TRADER_BUY", { result });
      if (result.dryRun) return;
      ctx.state.set(TRADES, key, { status: "done", shares: result.value, traceId, at: ctx.now() });
    });
  }
}

export function traderTask(deps: TraderDeps, opts: { intervalMs: number; jitterMs?: number }): Task {
  return { name: "trader", mode: deps.adapter.mode, ...opts, run: (ctx) => traderTick(deps, ctx) };
}

/**
 * A schema-v2 buy trace (#331) when the candidate carries everything v2
 * needs (pool reserves, fee, ledger, contracts); otherwise undefined and the
 * caller keeps the v1 shape. The fair value, including the estimator's full
 * `model`, is recorded so the trace replays to the same bps.
 */
export function buyTraceV2(
  deps: TraderDeps,
  c: TraderCandidate,
  order: {
    reasoning: string;
    outcome: "Yes" | "No";
    collateralIn: bigint;
    minSharesOut: bigint;
    extensions: Record<string, unknown>;
  },
) {
  const m = c.market;
  if (
    m.reserveYesStroops === undefined ||
    m.reserveNoStroops === undefined ||
    m.feeBps === undefined ||
    c.ledger === undefined ||
    c.ledgerCloseTime === undefined ||
    !deps.contracts
  )
    return undefined;
  const total = m.reserveYesStroops + m.reserveNoStroops;
  const fairValue: FairValueEstimate = c.fairValue
    ? {
        bps: c.fairValue.fairYesBps,
        source: c.fairValue.source,
        observedAt: c.fairValue.observedAt,
        ...(c.fairValue.model ? { model: c.fairValue.model } : {}),
      }
    : { bps: c.fairValueBps, source: "static", observedAt: c.ledgerCloseTime };
  return buildTraceV2({
    agent: "trader",
    marketId: String(m.marketId),
    action: "buy",
    reasoning: order.reasoning,
    inputs: {
      marketId: String(m.marketId),
      ledgerSequence: c.ledger,
      ledgerCloseTime: c.ledgerCloseTime,
      reserveYes: m.reserveYesStroops.toString(),
      reserveNo: m.reserveNoStroops.toString(),
      feeBps: m.feeBps,
      priceYesBps: total > 0n ? Number((m.reserveNoStroops * 10_000n) / total) : 0,
      fairValue,
      order: {
        outcome: order.outcome === "Yes" ? "yes" : "no",
        collateralIn: order.collateralIn.toString(),
        minSharesOut: order.minSharesOut.toString(),
      },
      contracts: deps.contracts,
      extensions: order.extensions,
    },
  });
}
