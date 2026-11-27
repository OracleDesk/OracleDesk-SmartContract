import { BPS, calcBuy, calcSell, type SellQuote } from "./fpmm.js";
import { inventoryOf, type InventoryInput } from "./inventory.js";
import type { CapsView } from "./sizing.js";

export interface PricePolicyView {
  maxBuyPriceBps: bigint;
  minSellPriceBps: bigint;
  maxImpactBps?: bigint;
}
export interface HedgeConfig {
  maxDeltaBps: bigint;
  targetDeltaBps: bigint;
  maxTradeStroops: bigint;
  dailyHeadroom: bigint;
  minSecsToClose: number;
  nowSecs?: number;
  closeTimeSecs?: number;
  feeBps?: bigint;
}
export type HedgeAction =
  | { kind: "buy"; outcome: "Yes" | "No"; collateralIn: bigint; minSharesOut: bigint; limitPriceBps: number }
  | { kind: "sell"; outcome: "Yes" | "No"; collateralOut: bigint; maxSharesIn: bigint; limitPriceBps: number }
  | { kind: "none"; reason: string };

const abs = (x: bigint) => x < 0n ? -x : x;
const min = (...xs: bigint[]) => xs.reduce((a, b) => a < b ? a : b);

function none(reason: string): HedgeAction { return { kind: "none", reason }; }

/** Plans one bounded action. Simulation is intentionally integer and re-runs the inventory model. */
export function planHedge(inv: InventoryInput, caps: CapsView, policy: PricePolicyView, cfg: HedgeConfig): HedgeAction {
  const current = inventoryOf(inv);
  const maxDelta = cfg.maxDeltaBps * (inv.costBasis > 0n ? inv.costBasis : 1n) / BPS;
  const target = cfg.targetDeltaBps * (inv.costBasis > 0n ? inv.costBasis : 1n) / BPS;
  if (abs(current.delta) <= maxDelta) return none("inside inventory band");
  if (cfg.nowSecs !== undefined && cfg.closeTimeSecs !== undefined &&
      cfg.closeTimeSecs - cfg.nowSecs <= cfg.minSecsToClose) return none("too close to market close");
  const fee = cfg.feeBps ?? inv.pool.feeBps;
  const long = current.delta > 0n ? "Yes" : "No";
  const short = long === "Yes" ? "No" : "Yes";
  const held = long === "Yes" ? inv.position.yes : inv.position.no;
  const desired = abs(current.delta) - target;
  if (held > 0n) {
    const rSold = long === "Yes" ? inv.pool.reserveYes : inv.pool.reserveNo;
    const rOther = long === "Yes" ? inv.pool.reserveNo : inv.pool.reserveYes;
    let lo = 1n, hi = min(held, cfg.maxTradeStroops, cfg.dailyHeadroom);
    if (hi > 0n) {
      let best: SellQuote | undefined;
      while (lo <= hi) {
        const mid = (lo + hi) / 2n;
        try {
          const c = calcSell(rSold, rOther, mid, fee);
          const next = inventoryOf({ ...inv, position: { ...inv.position, [long === "Yes" ? "yes" : "no"]: held - c.sharesIn }, pool: { ...inv.pool, reserveYes: long === "Yes" ? c.newReserveSold : c.newReserveOther, reserveNo: long === "Yes" ? c.newReserveOther : c.newReserveSold } });
          if (abs(next.delta) <= target || abs(current.delta - next.delta) >= desired) { best = c; lo = mid + 1n; } else { best = c; lo = mid + 1n; }
        } catch { hi = mid - 1n; }
      }
      if (best) return { kind: "sell", outcome: long, collateralOut: best.gross - best.fee, maxSharesIn: best.sharesIn, limitPriceBps: Number(policy.minSellPriceBps || 1n) };
    }
  }
  const budget = min(cfg.maxTradeStroops, cfg.dailyHeadroom, caps.maxTrade, caps.maxMarket > caps.marketExposure ? caps.maxMarket - caps.marketExposure : 0n, caps.availableCapital);
  if (budget <= 0n) return none("max_trade or treasury headroom");
  if (policy.maxBuyPriceBps <= 0n) return none("buy price policy");
  try {
    const q = calcBuy(short === "Yes" ? inv.pool.reserveYes : inv.pool.reserveNo, short === "Yes" ? inv.pool.reserveNo : inv.pool.reserveYes, budget, fee);
    return { kind: "buy", outcome: short, collateralIn: budget, minSharesOut: q.sharesOut, limitPriceBps: Number(policy.maxBuyPriceBps) };
  } catch {
    return none("buy is not executable");
  }
}
