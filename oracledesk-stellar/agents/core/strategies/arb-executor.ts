/**
 * Sequential execution of an arbitrage plan through the existing treasury
 * entrypoints (#108). The legs are separate transactions, so the executor is
 * a journaled state machine:
 *
 *   planned -> leg1:intent -> leg1:done -> leg2:intent -> leg2:done -> closed
 *                                       \-> unwind:intent -> unwind:done -> closed
 *
 * 1. Leg one, the less liquid market, is re-quoted against fresh reserves
 *    and bought with min_shares_out = the plan's share count.
 * 2. Market two is re-read and its cost recomputed. If it moved against the
 *    plan by more than ARB_MAX_LEG_LOSS, leg one is unwound with agent_sell.
 * 3. Otherwise leg two is bought with the same min_shares_out.
 *
 * Every step is journaled before and after its submission (ARB_JOURNAL_FILE),
 * so `recoverArbitrage` can finish or unwind a plan a crash interrupted,
 * reading the treasury's positions to settle any ambiguous submission.
 * A trace with the relation, graph hash, snapshots, plan and leg results is
 * published once a plan completes or is unwound.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { calcSell, collateralForShares, MathError } from "../fpmm.js";
import { buildTrace, type TraceStore } from "../trace.js";
import type { ArbLeg, ArbPlan, MarketSnapshot, Side } from "./arbitrage.js";

export type ArbStep =
  | "planned"
  | "leg1:intent"
  | "leg1:done"
  | "leg1:failed"
  | "leg2:intent"
  | "leg2:done"
  | "leg2:failed"
  | "unwind:intent"
  | "unwind:done"
  | "unwind:failed"
  | "trace:published"
  | "closed";

export type ArbStatus = "completed" | "unwound" | "aborted" | "unwind-failed";

export interface JournalEntry {
  planId: string;
  step: ArbStep;
  at: number;
  data?: Record<string, unknown>;
}

export interface ArbJournal {
  append(e: JournalEntry): void;
  entries(): JournalEntry[];
}

const encode = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x));
const decode = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === "object" && "$bigint" in x ? BigInt(x.$bigint) : x));

/** Append-only JSON Lines journal; bigints round-trip exactly. */
export class FileArbJournal implements ArbJournal {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  append(e: JournalEntry): void {
    appendFileSync(this.path, encode(e) + "\n");
  }
  entries(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => decode(l) as JournalEntry);
  }
}

export class MemoryArbJournal implements ArbJournal {
  readonly log: JournalEntry[] = [];
  append(e: JournalEntry): void {
    this.log.push(structuredClone(e));
  }
  entries(): JournalEntry[] {
    return structuredClone(this.log);
  }
}

/** The chain operations the executor needs; the adapter supplies them in production. */
export interface ArbChain {
  market(id: bigint): Promise<MarketSnapshot>;
  /** The treasury's shares of each side in a market. */
  position(id: bigint): Promise<{ yes: bigint; no: bigint }>;
  /** agent_buy; resolves to the shares received. */
  buy(a: { marketId: bigint; outcome: Side; collateralIn: bigint; minSharesOut: bigint }): Promise<bigint>;
  /** agent_sell; resolves to the shares sold. */
  sell(a: { marketId: bigint; outcome: Side; collateralOut: bigint; maxSharesIn: bigint }): Promise<bigint>;
  publishTrace(a: { marketId: bigint; traceHash: string; cid: string }): Promise<void>;
}

export interface ExecutorDeps {
  chain: ArbChain;
  journal: ArbJournal;
  traceStore: TraceStore;
  /** ARB_MAX_LEG_LOSS: how much more leg two may cost than planned. */
  maxLegLoss: bigint;
  /** ARB_MAX_UNWIND_RETRIES */
  maxUnwindRetries: number;
  now: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface ArbResult {
  planId: string;
  status: ArbStatus;
  leg1?: { collateral: bigint; shares: bigint };
  leg2?: { collateral: bigint; shares: bigint };
  unwind?: { collateralOut: bigint; sharesIn: bigint };
  reason?: string;
}

export function planIdOf(plan: ArbPlan): string {
  return `${plan.relationId}:${plan.graphHash.slice(0, 12)}:${plan.snapshots.map((s) => `${s.id}@${s.reserveYes}/${s.reserveNo}`).join(",")}`;
}

/**
 * The most collateral selling at most `shares` returns, exactly. The
 * closed-form collateralOutForShares ignores calc_sell's rounding, so it can
 * need one share more than is held (or reject a small pool outright), so this
 * binary-searches calcSell directly. collateral_out is always below rOther.
 */
export function sellableCollateral(rSold: bigint, rOther: bigint, shares: bigint, feeBps: bigint): bigint {
  const sharesIn = (c: bigint): bigint | undefined => {
    try {
      return calcSell(rSold, rOther, c, feeBps).sharesIn;
    } catch (err) {
      if (err instanceof MathError) return undefined;
      throw err;
    }
  };
  let hi = rOther;
  let lo = 0n;
  // Invariant: lo sells within `shares` (or is 0); hi does not.
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const n = sharesIn(mid);
    if (n !== undefined && n <= shares) lo = mid;
    else hi = mid;
  }
  if (lo === 0n) throw new MathError("nothing sellable");
  return lo;
}

const sideShares = (p: { yes: bigint; no: bigint }, side: Side) => (side === "Yes" ? p.yes : p.no);

function buyCostNow(m: MarketSnapshot, leg: ArbLeg): bigint {
  const [rB, rO] = leg.outcome === "Yes" ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
  return collateralForShares(rB, rO, leg.shares, m.feeBps);
}

class Run {
  readonly result: ArbResult;
  constructor(
    readonly plan: ArbPlan,
    readonly d: ExecutorDeps,
    readonly planId: string,
  ) {
    this.result = { planId, status: "aborted" };
  }

  journal(step: ArbStep, data?: Record<string, unknown>): void {
    this.d.journal.append({ planId: this.planId, step, at: this.d.now(), data });
    this.d.log?.("ARB_STEP", { planId: this.planId, step, ...data });
  }

  async leg1(): Promise<boolean> {
    const leg = this.plan.legs[0];
    let collateral: bigint;
    try {
      collateral = buyCostNow(await this.d.chain.market(leg.marketId), leg);
    } catch (err) {
      return this.abort(`leg one cannot be re-quoted: ${message(err)}`);
    }
    if (collateral - leg.collateral > this.d.maxLegLoss) {
      return this.abort(`leg one moved by ${collateral - leg.collateral} before submission, more than ARB_MAX_LEG_LOSS`);
    }
    const before = sideShares(await this.d.chain.position(leg.marketId), leg.outcome);
    this.journal("leg1:intent", { collateral, positionBefore: before });
    try {
      const shares = await this.d.chain.buy({ marketId: leg.marketId, outcome: leg.outcome, collateralIn: collateral, minSharesOut: leg.shares });
      this.result.leg1 = { collateral, shares };
      this.journal("leg1:done", { collateral, shares });
      return true;
    } catch (err) {
      // An error does not prove the buy did not land: check the position.
      return this.settleLeg1(collateral, before, message(err));
    }
  }

  async settleLeg1(collateral: bigint, before: bigint, error: string): Promise<boolean> {
    const leg = this.plan.legs[0];
    const delta = sideShares(await this.d.chain.position(leg.marketId), leg.outcome) - before;
    if (delta >= leg.shares) {
      this.result.leg1 = { collateral, shares: delta };
      this.journal("leg1:done", { collateral, shares: delta, reconciled: true });
      return true;
    }
    this.journal("leg1:failed", { error });
    return this.abort(`leg one failed: ${error}`);
  }

  async leg2(): Promise<void> {
    const leg = this.plan.legs[1];
    let collateral: bigint;
    try {
      collateral = buyCostNow(await this.d.chain.market(leg.marketId), leg);
    } catch (err) {
      return this.unwind(`leg two cannot be re-quoted: ${message(err)}`);
    }
    const adverse = collateral - leg.collateral;
    if (adverse > this.d.maxLegLoss) {
      return this.unwind(`leg two moved against the plan by ${adverse}, more than ARB_MAX_LEG_LOSS=${this.d.maxLegLoss}`);
    }
    const before = sideShares(await this.d.chain.position(leg.marketId), leg.outcome);
    this.journal("leg2:intent", { collateral, positionBefore: before });
    try {
      const shares = await this.d.chain.buy({ marketId: leg.marketId, outcome: leg.outcome, collateralIn: collateral, minSharesOut: leg.shares });
      this.result.leg2 = { collateral, shares };
      this.journal("leg2:done", { collateral, shares });
      this.result.status = "completed";
    } catch (err) {
      await this.settleLeg2(collateral, before, message(err));
    }
  }

  async settleLeg2(collateral: bigint, before: bigint, error: string): Promise<void> {
    const leg = this.plan.legs[1];
    const delta = sideShares(await this.d.chain.position(leg.marketId), leg.outcome) - before;
    if (delta >= leg.shares) {
      this.result.leg2 = { collateral, shares: delta };
      this.journal("leg2:done", { collateral, shares: delta, reconciled: true });
      this.result.status = "completed";
      return;
    }
    this.journal("leg2:failed", { error });
    return this.unwind(`leg two failed: ${error}`);
  }

  async unwind(reason: string, shares = this.result.leg1?.shares ?? this.plan.legs[0].shares): Promise<void> {
    const leg = this.plan.legs[0];
    this.result.reason = reason;
    for (let attempt = 1; attempt <= this.d.maxUnwindRetries; attempt++) {
      const before = sideShares(await this.d.chain.position(leg.marketId), leg.outcome);
      let collateralOut: bigint;
      try {
        const m = await this.d.chain.market(leg.marketId);
        const [rS, rO] = leg.outcome === "Yes" ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
        collateralOut = sellableCollateral(rS, rO, shares, m.feeBps);
      } catch (err) {
        this.journal("unwind:failed", { attempt, error: message(err) });
        continue;
      }
      this.journal("unwind:intent", { attempt, collateralOut, shares, positionBefore: before, reason });
      try {
        const sharesIn = await this.d.chain.sell({ marketId: leg.marketId, outcome: leg.outcome, collateralOut, maxSharesIn: shares });
        this.result.unwind = { collateralOut, sharesIn };
        this.journal("unwind:done", { collateralOut, sharesIn });
        this.result.status = "unwound";
        return;
      } catch (err) {
        const sold = before - sideShares(await this.d.chain.position(leg.marketId), leg.outcome);
        if (sold > 0n) {
          this.result.unwind = { collateralOut, sharesIn: sold };
          this.journal("unwind:done", { collateralOut, sharesIn: sold, reconciled: true });
          this.result.status = "unwound";
          return;
        }
        this.journal("unwind:failed", { attempt, error: message(err) });
      }
    }
    this.result.status = "unwind-failed";
    this.d.log?.("ARB_UNHEDGED", { planId: this.planId, market: leg.marketId, shares });
  }

  abort(reason: string): false {
    this.result.status = "aborted";
    this.result.reason = reason;
    return false;
  }

  async finish(): Promise<ArbResult> {
    const status = this.result.status;
    if (status === "completed" || status === "unwound") {
      const built = buildTrace({
        agent: "trader",
        marketId: Number(this.plan.legs[0].marketId),
        action: "buy",
        reasoning: `arbitrage ${this.plan.relationType} ${this.plan.relationId}: ${status}${this.result.reason ? ` (${this.result.reason})` : ""}`,
        inputs: {
          relation: { id: this.plan.relationId, type: this.plan.relationType },
          graphHash: this.plan.graphHash,
          snapshots: this.plan.snapshots,
          plan: this.plan,
          result: this.result,
        },
      });
      try {
        const { cid } = await this.d.traceStore.put(built.hash, built.json);
        await this.d.chain.publishTrace({ marketId: this.plan.legs[0].marketId, traceHash: built.hash, cid });
        this.journal("trace:published", { traceHash: built.hash, cid });
      } catch (err) {
        // The legs are settled either way; a failed trace is reported, not retried here.
        this.d.log?.("ARB_TRACE_FAILED", { planId: this.planId, error: message(err) });
      }
    }
    this.journal("closed", { status, reason: this.result.reason });
    return this.result;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeArbPlan(plan: ArbPlan, d: ExecutorDeps): Promise<ArbResult> {
  const run = new Run(plan, d, planIdOf(plan));
  run.journal("planned", { plan });
  if (await run.leg1()) await run.leg2();
  return run.finish();
}

/**
 * Finishes every plan the journal shows as not closed: a crash between steps
 * leaves a "planned", an intent, or a done without its successor. Ambiguous
 * submissions are settled by reading the treasury's position.
 */
export async function recoverArbitrage(d: ExecutorDeps): Promise<ArbResult[]> {
  const byPlan = new Map<string, JournalEntry[]>();
  for (const e of d.journal.entries()) byPlan.set(e.planId, [...(byPlan.get(e.planId) ?? []), e]);
  const results: ArbResult[] = [];
  for (const [planId, entries] of byPlan) {
    if (entries.some((e) => e.step === "closed")) continue;
    const planned = entries.find((e) => e.step === "planned");
    if (!planned) continue;
    const run = new Run(planned.data!.plan as ArbPlan, d, planId);
    const last = (step: ArbStep) => [...entries].reverse().find((e) => e.step === step);
    const has = (step: ArbStep) => last(step) !== undefined;
    d.log?.("ARB_RECOVER", { planId, last: entries.at(-1)!.step });

    if (has("unwind:done")) run.result.status = "unwound";
    else if (has("leg2:done")) run.result.status = "completed";
    else if (has("unwind:intent")) {
      const u = last("unwind:intent")!.data!;
      await run.unwind(String(u.reason), u.shares as bigint);
    } else if (has("leg2:intent")) {
      const i = last("leg2:intent")!.data!;
      run.result.leg1 = last("leg1:done")!.data as { collateral: bigint; shares: bigint };
      await run.settleLeg2(i.collateral as bigint, i.positionBefore as bigint, "interrupted after submission");
    } else if (has("leg1:done")) {
      run.result.leg1 = last("leg1:done")!.data as { collateral: bigint; shares: bigint };
      await run.leg2();
    } else if (has("leg1:intent")) {
      const i = last("leg1:intent")!.data!;
      if (await run.settleLeg1(i.collateral as bigint, i.positionBefore as bigint, "interrupted after submission")) await run.leg2();
    } else {
      run.abort("interrupted before leg one was submitted");
    }
    results.push(await run.finish());
  }
  return results;
}

