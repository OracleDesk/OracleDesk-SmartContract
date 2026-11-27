import { BPS, settleValue } from "./fpmm.js";

export interface InventoryInput {
  pool: { reserveYes: bigint; reserveNo: bigint; feeBps: bigint };
  position: { yes: bigint; no: bigint };
  lpOwned: boolean;
  lpFees: bigint;
  costBasis: bigint;
}

export interface Inventory {
  payoutYes: bigint;
  payoutNo: bigint;
  payoutVoid: bigint;
  delta: bigint;
  floor: bigint;
  impermanentLoss: bigint;
}

/** Conservative, outcome-by-outcome value of the treasury's seed position. */
export function inventoryOf(i: InventoryInput): Inventory {
  const ry = i.lpOwned ? i.pool.reserveYes : 0n;
  const rn = i.lpOwned ? i.pool.reserveNo : 0n;
  const yes = i.position.yes + ry;
  const no = i.position.no + rn;
  const payoutYes = yes + i.lpFees;
  const payoutNo = no + i.lpFees;
  const payoutVoid = settleValue("void", yes, no) + i.lpFees;
  // market_valuation deliberately excludes unclaimed LP fees from its floor.
  const floor = (yes < no ? yes : no);
  return {
    payoutYes,
    payoutNo,
    payoutVoid,
    delta: payoutYes - payoutNo,
    floor,
    impermanentLoss: i.costBasis > floor ? i.costBasis - floor : 0n,
  };
}

export function deltaBps(inv: Inventory, costBasis: bigint): bigint {
  if (costBasis <= 0n) return 0n;
  return (inv.delta < 0n ? -inv.delta : inv.delta) * BPS / costBasis;
}
