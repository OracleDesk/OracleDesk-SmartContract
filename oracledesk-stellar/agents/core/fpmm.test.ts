import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BPS,
  buyWithinLimit,
  calcBuy,
  calcSell,
  calcSellShares,
  collateralOutForShares,
  grossForShares,
  mulDivCeil,
  mulDivFloor,
  priceAfter,
  priceAfterBuy,
  priceAfterSell,
  priceYesBps,
  seedReserves,
  sellWithinLimit,
  settleValue,
  collateralForShares,
  MathError,
} from "./fpmm.js";

// Same worked examples as math.rs's unit tests and model/fpmm_model.py's
// _check_known_values — catches a porting mistake between the three
// languages immediately.
test("calcBuy matches the reference example", () => {
  const q = calcBuy(1000n, 1000n, 100n, 0n);
  assert.equal(q.sharesOut, 190n);
  assert.equal(q.newReserveBought, 910n);
  assert.equal(q.newReserveOther, 1100n);
});

test("calcSell matches the reference example", () => {
  const q = calcSell(1000n, 1000n, 100n, 0n);
  assert.equal(q.sharesIn, 212n);
  assert.equal(q.gross, 100n);
  assert.equal(q.newReserveSold, 1112n);
  assert.equal(q.newReserveOther, 900n);
});

test("seedReserves opens at the requested probability", () => {
  for (const p of [100n, 2500n, 5000n, 7300n, 9900n]) {
    const s = seedReserves(10_000_000_000n, p);
    const price = priceYesBps(s.reserveYes, s.reserveNo);
    const diff = price > p ? price - p : p - price;
    assert.ok(diff <= 1n, `p=${p} price=${price}`);
    assert.ok(s.creatorYes === 0n || s.creatorNo === 0n);
  }
});

test("k never decreases and a round trip never profits", () => {
  // Same small LCG as math.rs's property test, so both suites explore a
  // comparable input space.
  let x = 0x9e3779b97f4a7c15n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & mask;
    return x >> 33n;
  };
  for (let i = 0; i < 2000; i++) {
    const ry = 1_000_000n + (next() % 1_000_000_000n);
    const rn = 1_000_000n + (next() % 1_000_000_000n);
    const amt = 1n + (next() % ((ry < rn ? ry : rn) / 2n));
    const fee = next() % 300n;
    const k0 = ry * rn;
    const q = calcBuy(ry, rn, amt, fee);
    assert.ok(q.newReserveBought * q.newReserveOther >= k0);
    try {
      const s = calcSell(q.newReserveBought, q.newReserveOther, amt, fee);
      assert.ok(s.sharesIn >= q.sharesOut, "free money");
    } catch {
      // insufficient liquidity to sell back out is fine, not what's tested here
    }
  }
});

test("void settlement never overpays", () => {
  assert.equal(settleValue("void", 3n, 4n), 3n);
  assert.ok(settleValue("void", 5n, 5n) <= 5n);
});

test("collateralOutForShares round-trips through calcSell within one unit of rounding", () => {
  // Deterministic pseudo-random inputs (same LCG as above) so this is
  // reproducible without a test-framework property library dependency.
  let x = 12345n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & mask;
    return x >> 33n;
  };
  let checked = 0;
  const trials = 500;
  for (let i = 0; i < trials; i++) {
    const rSold = 1_000_000n + (next() % 1_000_000_000n);
    const rOther = 1_000_000n + (next() % 1_000_000_000n);
    const feeBps = next() % 300n;
    const collateralOut = 1n + (next() % (rOther / 4n || 1n));
    let forward;
    try {
      forward = calcSell(rSold, rOther, collateralOut, feeBps);
    } catch {
      continue;
    }
    let estimatedOut: bigint;
    try {
      estimatedOut = collateralOutForShares(rSold, rOther, forward.sharesIn, feeBps);
    } catch {
      continue;
    }
    if (estimatedOut <= 0n) continue;
    const back = calcSell(rSold, rOther, estimatedOut, feeBps);
    assert.ok(back.sharesIn <= forward.sharesIn + 1n, `forward=${forward.sharesIn} back=${back.sharesIn}`);
    checked++;
  }
  assert.ok(checked > trials / 2, "too many trials skipped, weakens the property check");
});

test("BPS matches the contract's basis-point scale", () => {
  assert.equal(BPS, 10_000n);
});

test("priceAfter maps both outcomes to the same YES price", () => {
  assert.equal(priceAfter(true, 1000n, 1000n), 5000n);
  assert.equal(priceAfter(false, 1000n, 1000n), 5000n);
  assert.equal(priceAfter(true, 910n, 1100n), priceYesBps(910n, 1100n));
  assert.equal(priceAfter(false, 910n, 1100n), priceYesBps(1100n, 910n));
});

test("priceAfterBuy matches the reference example shared with math.rs and the Python model", () => {
  // Buying 10 USDC of YES in a 100-sets pool at 50% with a 1% fee moves
  // YES from 5000 to 5470 bps.
  const q = calcBuy(1_000_000_000n, 1_000_000_000n, 100_000_000n, 100n);
  assert.equal(priceYesBps(1_000_000_000n, 1_000_000_000n), 5000n);
  assert.equal(priceAfterBuy(true, q), 5470n);
  // Selling right back must land below the pre-trade price (two fees).
  const s = calcSell(q.newReserveBought, q.newReserveOther, 100_000_000n, 100n);
  assert.ok(priceAfterSell(true, s) < 5000n);
});

test("committed cross-language vectors match", () => {
  const vectorsPath = fileURLToPath(new URL("../../scripts/fpmm-diff/vectors.jsonl", import.meta.url));
  const lines = readFileSync(vectorsPath, "utf8").trim().split("\n");
  for (const [i, line] of lines.entries()) {
    const c = JSON.parse(line) as { fn: string; args: string[]; ok: Record<string, string> };
    // settle_value's first arg is an outcome name, not a number.
    const a = c.args.map((x) => (/^-?\d+$/.test(x) ? BigInt(x) : 0n));
    let actual: Record<string, string>;
    switch (c.fn) {
      case "calc_buy": {
        const q = calcBuy(a[0], a[1], a[2], a[3]);
        actual = {
          shares_out: q.sharesOut.toString(),
          fee: q.fee.toString(),
          net: q.net.toString(),
          new_reserve_bought: q.newReserveBought.toString(),
          new_reserve_other: q.newReserveOther.toString(),
        };
        break;
      }
      case "calc_sell": {
        const q = calcSell(a[0], a[1], a[2], a[3]);
        actual = {
          shares_in: q.sharesIn.toString(),
          fee: q.fee.toString(),
          gross: q.gross.toString(),
          new_reserve_sold: q.newReserveSold.toString(),
          new_reserve_other: q.newReserveOther.toString(),
        };
        break;
      }
      case "seed_reserves": {
        const s = seedReserves(a[0], a[1]);
        actual = {
          reserve_yes: s.reserveYes.toString(),
          reserve_no: s.reserveNo.toString(),
          creator_yes: s.creatorYes.toString(),
          creator_no: s.creatorNo.toString(),
        };
        break;
      }
      case "mul_div_floor":
        actual = { value: mulDivFloor(a[0], a[1], a[2]).toString() };
        break;
      case "mul_div_ceil":
        actual = { value: mulDivCeil(a[0], a[1], a[2]).toString() };
        break;
      case "price_yes_bps":
        actual = { value: priceYesBps(a[0], a[1]).toString() };
        break;
      case "settle_value":
        actual = { value: settleValue(c.args[0] as "yes" | "no" | "void", a[1], a[2]).toString() };
        break;
      case "gross_for_shares":
        actual = { gross: grossForShares(a[0], a[1], a[2], a[3]).toString() };
        break;
      case "collateral_out_for_shares":
        actual = { collateral_out: collateralOutForShares(a[0], a[1], a[2], a[3]).toString() };
        break;
      default:
        throw new Error(`line ${i + 1}: unknown fn ${c.fn}`);
    }
    assert.deepEqual(actual, c.ok, `shared vector line ${i + 1} (${c.fn})`);
  }
});

test("buyWithinLimit and sellWithinLimit mirror the on-chain boundaries", () => {
  // Exact equality passes, one unit over fails, in both directions.
  assert.equal(buyWithinLimit(100n, 100n, 10_000n), true);
  assert.equal(buyWithinLimit(100n, 101n, 10_000n), true);
  assert.equal(buyWithinLimit(101n, 100n, 10_000n), false);
  assert.equal(buyWithinLimit(100n, 200n, 5_000n), true);
  assert.equal(buyWithinLimit(101n, 200n, 5_000n), false);
  assert.equal(sellWithinLimit(100n, 100n, 10_000n), true);
  assert.equal(sellWithinLimit(99n, 100n, 10_000n), false);
  assert.equal(sellWithinLimit(100n, 200n, 5_000n), true);
  assert.equal(sellWithinLimit(100n, 201n, 5_000n), false);
  // A zero limit is trivially satisfied for sells and binds a buy only at
  // a zero average price.
  assert.equal(sellWithinLimit(0n, 1n, 0n), true);
  assert.equal(buyWithinLimit(1n, 1n, 0n), false);
});

// Known-value fixtures shared bit-for-bit with math.rs's
// `sell_shares_example_matches_model` and model/fpmm_model.py's
// `_check_sell_shares_known_values`. Each entry is
// [rSold, rOther, sharesIn, feeBps, collateralOut, fee, gross,
//  newReserveSold, newReserveOther].
const SELL_SHARES_FIXTURES: ReadonlyArray<
  readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
> = [
  // 1000/1000 pool selling 212 shares at zero fee: gross 100, x = 100.
  [1000n, 1000n, 212n, 0n, 100n, 0n, 100n, 1112n, 900n],
  // Same pool, 1% fee: fee rounds up, collateral_out floors.
  [1000n, 1000n, 212n, 100n, 99n, 1n, 100n, 1112n, 900n],
  // Asymmetric reserves.
  [1_000_000n, 2_000_000n, 500_000n, 0n, 400_000n, 0n, 400_000n, 1_100_000n, 1_600_000n],
];

test("calcSellShares matches Rust/Python known values", () => {
  for (const [rSold, rOther, sharesIn, feeBps, out, fee, gross, ns, no] of SELL_SHARES_FIXTURES) {
    const q = calcSellShares(rSold, rOther, sharesIn, feeBps);
    assert.equal(q.collateralOut, out, `out r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`);
    assert.equal(q.fee, fee, `fee r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`);
    assert.equal(q.gross, gross, `gross r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`);
    assert.equal(q.newReserveSold, ns, `ns r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`);
    assert.equal(q.newReserveOther, no, `no r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`);
  }
});

test("calcSellShares never decreases k", () => {
  let x = 0x9e3779b97f4a7c15n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & mask;
    return x >> 33n;
  };
  let checked = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    const rSold = 1_000_000n + (next() % 1_000_000_000n);
    const rOther = 1_000_000n + (next() % 1_000_000_000n);
    const sharesIn = 1n + (next() % (rSold / 2n || 1n));
    const feeBps = next() % 300n;
    const k0 = rSold * rOther;
    let q;
    try {
      q = calcSellShares(rSold, rOther, sharesIn, feeBps);
    } catch {
      continue;
    }
    assert.ok(
      q.newReserveSold * q.newReserveOther >= k0,
      `k decreased r=${rSold}/${rOther} s=${sharesIn} f=${feeBps}`,
    );
    checked++;
  }
  assert.ok(checked > trials / 2, "too many trials skipped, weakens the property check");
});

test("calcSellShares never pays more than calcSell charges for the same shares", () => {
  let x = 0xdeadbeefcafebaben;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & mask;
    return x >> 33n;
  };
  let checked = 0;
  const trials = 1000;
  for (let i = 0; i < trials; i++) {
    const rSold = 1_000_000n + (next() % 1_000_000_000n);
    const rOther = 1_000_000n + (next() % 1_000_000_000n);
    const sharesIn = 1n + (next() % (rSold / 2n || 1n));
    const feeBps = next() % 300n;
    let q;
    try {
      q = calcSellShares(rSold, rOther, sharesIn, feeBps);
    } catch {
      continue;
    }
    let back;
    try {
      back = calcSell(rSold, rOther, q.collateralOut, feeBps);
    } catch {
      continue;
    }
    assert.ok(
      back.sharesIn <= sharesIn,
      `overpaid r=${rSold}/${rOther} s=${sharesIn} f=${feeBps} back=${back.sharesIn}`,
    );
    checked++;
  }
  assert.ok(checked > trials / 2, "too many trials skipped, weakens the property check");
});

// ─── collateralForShares (#108) ──────────────────────────────────────────────

function sharesOrZero(rB: bigint, rO: bigint, c: bigint, fee: bigint): bigint {
  if (c <= 0n) return 0n;
  try {
    return calcBuy(rB, rO, c, fee).sharesOut;
  } catch {
    return 0n;
  }
}

test("collateralForShares matches the fpmm_model.py fixtures", () => {
  const path = fileURLToPath(new URL("../../scripts/fpmm-diff/collateral_for_shares.jsonl", import.meta.url));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.ok(lines.length >= 40);
  for (const line of lines) {
    const c = JSON.parse(line) as { args: string[]; collateral_in: string };
    const [rB, rO, s, fee] = c.args.map(BigInt);
    assert.equal(collateralForShares(rB, rO, s, fee).toString(), c.collateral_in, line);
  }
});

test("collateralForShares is the minimum collateral that buys the target (exhaustive, small reserves)", () => {
  for (const [rB, rO] of [[50n, 50n], [7n, 90n], [90n, 7n], [1n, 30n]]) {
    for (const fee of [0n, 100n, 3_000n]) {
      for (let s = 1n; s <= rB * 2n; s++) {
        let brute = 1n;
        while (sharesOrZero(rB, rO, brute, fee) < s) brute++;
        assert.equal(collateralForShares(rB, rO, s, fee), brute, `rB=${rB} rO=${rO} fee=${fee} s=${s}`);
      }
    }
  }
});

test("collateralForShares stays minimal on large random pools", () => {
  let seed = 108n;
  const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n));
  for (let i = 0; i < 500; i++) {
    const rB = (next() % 10n ** 13n) + 1n;
    const rO = (next() % 10n ** 13n) + 1n;
    const fee = [0n, 30n, 100n, 250n][Number(next() % 4n)];
    const s = (next() % (rB * 3n)) + 1n;
    const c = collateralForShares(rB, rO, s, fee);
    assert.ok(sharesOrZero(rB, rO, c, fee) >= s);
    assert.ok(sharesOrZero(rB, rO, c - 1n, fee) < s);
  }
});

test("collateralForShares rejects invalid input", () => {
  assert.throws(() => collateralForShares(0n, 1n, 1n, 0n), MathError);
  assert.throws(() => collateralForShares(1n, 1n, 0n, 0n), MathError);
  assert.throws(() => collateralForShares(1n, 1n, 1n, 10_000n), MathError);
});