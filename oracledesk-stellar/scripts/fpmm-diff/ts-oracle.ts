/**
 * JSON-lines RPC over `agents/core/fpmm.ts`, mirroring the Rust oracle in
 * `oracle/src/main.rs`. Started by `diff.py`; one request object per line and
 * one response object per line.
 *
 * Run manually with:
 *   cd agents && npx tsx ../scripts/fpmm-diff/ts-oracle.ts
 * or from the repo root after `npm ci` in agents/:
 *   agents/node_modules/.bin/tsx scripts/fpmm-diff/ts-oracle.ts
 */
import { createInterface } from "node:readline";
import {
  buyWithinLimit,
  calcBuy,
  calcSell,
  calcSellShares,
  collateralOutForShares,
  grossForShares,
  isqrt,
  MathError,
  mergeMax,
  mulDivCeil,
  mulDivFloor,
  priceAfter,
  priceYesBps,
  seedReserves,
  sellWithinLimit,
  settleUpper,
  settleValue,
  splitFee,
  type Settlement,
} from "../../agents/core/fpmm.js";

type Req = { id?: number; fn: string; args: (string | number | boolean)[] };
type Out = Record<string, string>;

function bi(x: string | number | boolean): bigint {
  if (typeof x === "boolean") return x ? 1n : 0n;
  return BigInt(x);
}

function run(req: Req): { ok: Out } | { err: string } {
  try {
    const a = req.args;
    switch (req.fn) {
      case "mul_div_floor":
        return { ok: { value: mulDivFloor(bi(a[0]), bi(a[1]), bi(a[2])).toString() } };
      case "mul_div_ceil":
        return { ok: { value: mulDivCeil(bi(a[0]), bi(a[1]), bi(a[2])).toString() } };
      case "price_yes_bps":
        return { ok: { value: priceYesBps(bi(a[0]), bi(a[1])).toString() } };
      case "seed_reserves": {
        const r = seedReserves(bi(a[0]), bi(a[1]));
        return {
          ok: {
            reserve_yes: r.reserveYes.toString(),
            reserve_no: r.reserveNo.toString(),
            creator_yes: r.creatorYes.toString(),
            creator_no: r.creatorNo.toString(),
          },
        };
      }
      case "calc_buy": {
        const q = calcBuy(bi(a[0]), bi(a[1]), bi(a[2]), bi(a[3]));
        return {
          ok: {
            shares_out: q.sharesOut.toString(),
            fee: q.fee.toString(),
            net: q.net.toString(),
            new_reserve_bought: q.newReserveBought.toString(),
            new_reserve_other: q.newReserveOther.toString(),
          },
        };
      }
      case "calc_sell": {
        const q = calcSell(bi(a[0]), bi(a[1]), bi(a[2]), bi(a[3]));
        return {
          ok: {
            shares_in: q.sharesIn.toString(),
            fee: q.fee.toString(),
            gross: q.gross.toString(),
            new_reserve_sold: q.newReserveSold.toString(),
            new_reserve_other: q.newReserveOther.toString(),
          },
        };
      }
      case "settle_value":
        return { ok: { value: settleValue(String(a[0]) as Settlement, bi(a[1]), bi(a[2])).toString() } };
      case "price_after": {
        const yes = a[0] === true || a[0] === "true" || a[0] === "yes";
        return { ok: { value: priceAfter(yes, bi(a[1]), bi(a[2])).toString() } };
      }
      case "buy_within_limit":
        return { ok: { value: buyWithinLimit(bi(a[0]), bi(a[1]), bi(a[2])).toString() } };
      case "sell_within_limit":
        return { ok: { value: sellWithinLimit(bi(a[0]), bi(a[1]), bi(a[2])).toString() } };
      case "calc_sell_shares": {
        const q = calcSellShares(bi(a[0]), bi(a[1]), bi(a[2]), bi(a[3]));
        return {
          ok: {
            collateral_out: q.collateralOut.toString(),
            fee: q.fee.toString(),
            gross: q.gross.toString(),
            new_reserve_sold: q.newReserveSold.toString(),
            new_reserve_other: q.newReserveOther.toString(),
          },
        };
      }
      case "split_fee": {
        const q = splitFee(bi(a[0]), bi(a[1]));
        return { ok: { protocol: q.protocol.toString(), lp: q.lp.toString() } };
      }
      case "settle_upper":
        return { ok: { value: settleUpper(String(a[0]) as Settlement, bi(a[1]), bi(a[2])).toString() } };
      case "merge_max":
        return { ok: { value: mergeMax(bi(a[0]), bi(a[1])).toString() } };
      case "gross_for_shares":
        return { ok: { gross: grossForShares(bi(a[0]), bi(a[1]), bi(a[2]), bi(a[3])).toString() } };
      case "collateral_out_for_shares":
        return {
          ok: {
            collateral_out: collateralOutForShares(bi(a[0]), bi(a[1]), bi(a[2]), bi(a[3])).toString(),
          },
        };
      case "isqrt":
        return { ok: { value: isqrt(bi(a[0])).toString() } };
      default:
        return { err: "InvalidInput" };
    }
  } catch (e) {
    if (e instanceof MathError) {
      if (e.message === "insufficient liquidity") return { err: "InsufficientLiquidity" };
      if (e.message === "invalid input") return { err: "InvalidInput" };
    }
    // BigInt parse/range failures are the TS analogue of Rust i128 overflow.
    if (e instanceof RangeError || e instanceof SyntaxError) return { err: "Overflow" };
    throw e;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: Req;
  try {
    req = JSON.parse(line) as Req;
  } catch (e) {
    process.stdout.write(JSON.stringify({ fatal: String(e) }) + "\n");
    return;
  }
  const response = { id: req.id ?? null, ...run(req) };
  process.stdout.write(JSON.stringify(response) + "\n");
});
