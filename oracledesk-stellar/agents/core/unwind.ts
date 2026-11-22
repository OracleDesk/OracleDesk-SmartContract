/**
 * Exit planner for treasury unwinding mode (#150). Sells the treasury's YES
 * and NO inventory in slices, refusing any slice whose average execution
 * price is below the market's on-chain exit floor. The treasury re-checks the
 * same floor and reverts with `BelowExitFloor`, so this planner only avoids
 * doomed transactions; it is not a trust boundary.
 */
import { BPS, calcSellShares } from "./fpmm.js";

export interface UnwindPool {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
}

export interface UnwindPosition {
  yes: bigint;
  no: bigint;
}

export interface UnwindOptions {
  /** Minimum average USDC-per-share, in bps (the treasury's `exit_floor`). */
  exitFloorBps: bigint;
  /** Largest slice submitted in one call. Defaults to the whole position. */
  maxSharesPerTrade?: bigint;
  /** Slices per outcome. Defaults to unlimited. */
  maxSlices?: number;
}

export interface UnwindLeg {
  marketId: bigint;
  outcome: "Yes" | "No";
  sharesIn: bigint;
  collateralOut: bigint;
  priceBps: bigint;
}

export interface UnwindPlan {
  marketId: bigint;
  legs: UnwindLeg[];
  remaining: UnwindPosition;
  /** Why the plan stopped before selling everything (empty when flat). */
  reasons: string[];
}

function orient(pool: UnwindPool, outcome: "Yes" | "No"): [bigint, bigint] {
  return outcome === "Yes"
    ? [pool.reserveYes, pool.reserveNo]
    : [pool.reserveNo, pool.reserveYes];
}

function validate(opts: UnwindOptions): void {
  if (opts.exitFloorBps < 0n || opts.exitFloorBps > BPS) {
    throw new RangeError("exit floor must be 0..10000 bps");
  }
  if (opts.maxSharesPerTrade !== undefined && opts.maxSharesPerTrade <= 0n) {
    throw new RangeError("maxSharesPerTrade must be positive");
  }
  if (opts.maxSlices !== undefined && (!Number.isInteger(opts.maxSlices) || opts.maxSlices < 1)) {
    throw new RangeError("maxSlices must be a positive integer");
  }
}

function planOutcome(
  marketId: bigint,
  outcome: "Yes" | "No",
  pool: UnwindPool,
  shares: bigint,
  opts: UnwindOptions,
  legs: UnwindLeg[],
  reasons: string[],
): bigint {
  if (shares <= 0n) return 0n;
  let [rSold, rOther] = orient(pool, outcome);
  let remaining = shares;
  let slices = 0;
  while (remaining > 0n && (opts.maxSlices === undefined || slices < opts.maxSlices)) {
    const slice = opts.maxSharesPerTrade !== undefined && remaining > opts.maxSharesPerTrade
      ? opts.maxSharesPerTrade
      : remaining;
    let quote;
    try {
      quote = calcSellShares(rSold, rOther, slice, pool.feeBps);
    } catch (err) {
      reasons.push(`${outcome}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    const priceBps = (quote.collateralOut * BPS) / slice;
    if (priceBps < opts.exitFloorBps) {
      reasons.push(`${outcome}: next ${slice} shares clear at ${priceBps} bps, below floor ${opts.exitFloorBps}`);
      break;
    }
    legs.push({ marketId, outcome, sharesIn: slice, collateralOut: quote.collateralOut, priceBps });
    remaining -= slice;
    slices += 1;
    rSold = quote.newReserveSold;
    rOther = quote.newReserveOther;
  }
  if (remaining > 0n && opts.maxSlices !== undefined && slices >= opts.maxSlices) {
    reasons.push(`${outcome}: reached maxSlices=${opts.maxSlices}`);
  }
  return remaining;
}

/** Plans inventory sales market by market, stopping each at its floor. */
export function planUnwind(
  markets: readonly { marketId: bigint; pool: UnwindPool }[],
  positions: ReadonlyMap<bigint, UnwindPosition>,
  opts: UnwindOptions,
): UnwindPlan[] {
  validate(opts);
  const plans: UnwindPlan[] = [];
  for (const { marketId, pool } of markets) {
    const pos = positions.get(marketId);
    if (!pos || (pos.yes <= 0n && pos.no <= 0n)) continue;
    const legs: UnwindLeg[] = [];
    const reasons: string[] = [];
    const yes = planOutcome(marketId, "Yes", pool, pos.yes, opts, legs, reasons);
    const no = planOutcome(marketId, "No", pool, pos.no, opts, legs, reasons);
    plans.push({ marketId, legs, remaining: { yes, no }, reasons });
  }
  return plans;
}
