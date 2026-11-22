/**
 * The watcher's bond budget (#275), kept in the runtime state store so a
 * restart never forgets bonds that are still locked in a dispute.
 *
 * One record per disputed market is the single source of truth; every total
 * is derived from the records, so they cannot drift apart:
 *
 *   committed = at-risk + refunded + forfeited
 *
 * A bond leaves "at risk" exactly once: refunded (the dispute was upheld, or
 * timed out) or forfeited (the proposal was upheld).
 */
import type { StateStore } from "../runtime/state.js";

export const BONDS = "watcher.bonds";

export type BondStatus = "at_risk" | "refunded" | "forfeited";

export interface BondRecord {
  bond: bigint;
  status: BondStatus;
  /** Unix seconds the bond was committed. */
  at: number;
}

export interface BondBudgetConfig {
  /** Largest bond the watcher will escrow in one dispute. */
  maxBondStroops: bigint;
  /** Largest total it will have at risk at once. */
  budgetStroops: bigint;
  /** Disputes it may open per UTC day. */
  maxDisputesPerDay: number;
}

export interface BudgetTotals {
  committed: bigint;
  atRisk: bigint;
  refunded: bigint;
  forfeited: bigint;
}

const DAY = 86_400;

export class BondBudget {
  constructor(
    private readonly state: StateStore,
    private readonly cfg: BondBudgetConfig,
  ) {}

  private records(): [string, BondRecord][] {
    return this.state.entries<BondRecord>(BONDS);
  }

  totals(): BudgetTotals {
    const t: BudgetTotals = { committed: 0n, atRisk: 0n, refunded: 0n, forfeited: 0n };
    for (const [, r] of this.records()) {
      t.committed += r.bond;
      if (r.status === "at_risk") t.atRisk += r.bond;
      else if (r.status === "refunded") t.refunded += r.bond;
      else t.forfeited += r.bond;
    }
    return t;
  }

  disputesToday(nowSecs: number): number {
    const day = Math.floor(nowSecs / DAY);
    return this.records().filter(([, r]) => Math.floor(r.at / DAY) === day).length;
  }

  /**
   * What may still be put at risk: the tightest of the total budget left,
   * the per-dispute cap and the wallet's real balance. Zero once the daily
   * count is used up.
   */
  available(balance: bigint, nowSecs: number): bigint {
    if (this.disputesToday(nowSecs) >= this.cfg.maxDisputesPerDay) return 0n;
    const left = this.cfg.budgetStroops - this.totals().atRisk;
    let a = left < this.cfg.maxBondStroops ? left : this.cfg.maxBondStroops;
    if (balance < a) a = balance;
    return a > 0n ? a : 0n;
  }

  /** Records a bond about to be escrowed. Idempotent per market. */
  commit(marketId: bigint, bond: bigint, nowSecs: number): void {
    if (this.state.get<BondRecord>(BONDS, marketId.toString())) return;
    this.state.set<BondRecord>(BONDS, marketId.toString(), { bond, status: "at_risk", at: nowSecs });
  }

  /** The dispute never opened (the transaction was rejected before inclusion). */
  release(marketId: bigint): void {
    const r = this.state.get<BondRecord>(BONDS, marketId.toString());
    if (r?.status === "at_risk") this.state.delete(BONDS, marketId.toString());
  }

  /** Moves an at-risk bond to its final state. No-op once final. */
  resolve(marketId: bigint, status: "refunded" | "forfeited"): void {
    const r = this.state.get<BondRecord>(BONDS, marketId.toString());
    if (r?.status === "at_risk") this.state.set<BondRecord>(BONDS, marketId.toString(), { ...r, status });
  }

  record(marketId: bigint): BondRecord | undefined {
    return this.state.get<BondRecord>(BONDS, marketId.toString());
  }
}
