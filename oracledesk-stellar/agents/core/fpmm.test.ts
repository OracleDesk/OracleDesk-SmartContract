import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BPS,
  buyWithinLimit,
  calcBuy,
  calcSell,
  catCalcBuy,
  catCalcSell,
  catPrices,
  catSeed,
  catSettleValue,
  collateralForShares,
  collateralOutForShares,
  effectiveFeeBps,
  type FeeSchedule,
  grossForShares,
  MathError,
  MAX_MARKET_OUTCOMES,
  MAX_RAMP_SECS,
  MAX_SKEW_MULT_BPS,
  mulDivCeil,
  mulDivFloor,
  priceAfter,
  priceAfterBuy,
  priceAfterSell,
  priceYesBps,
  scalarPayout,
  seedReserves,
  sellWithinLimit,
  settleValue,
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
// Same small LCG as math.rs / fpmm_model.py, so the three suites explore a
// comparable input space without a property-testing dependency.
function lcg(seed: bigint): () => bigint {
  let x = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & mask;
    return x >> 33n;
  };
}

test("catCalcBuy and catCalcSell match the reference 3-outcome example", () => {
  // Same worked examples as math_categorical.rs and model/fpmm_model.py:
  // a 1000/1000/1000 pool, buying/selling 100 of outcome 0 with no fee.
  const q = catCalcBuy([1000n, 1000n, 1000n], 0, 100n, 0n);
  assert.equal(q.sharesOut, 272n);
  assert.deepEqual(q.newReserves, [828n, 1100n, 1100n]);
  const s = catCalcSell([1000n, 1000n, 1000n], 0, 100n, 0n);
  assert.equal(s.sharesIn, 336n);
  assert.deepEqual(s.newReserves, [1236n, 900n, 900n]);

  // An n = 2 categorical pool is the binary FPMM: same fee/net/reserves and
  // a bought outcome within one unit of rounding.
  const bin = calcBuy(1_000_000n, 3_000_000n, 100_000_000n, 100n);
  const cat = catCalcBuy([1_000_000n, 3_000_000n], 0, 100_000_000n, 100n);
  assert.equal(cat.fee, bin.fee);
  assert.equal(cat.net, bin.net);
  assert.equal(cat.newReserves[1], bin.newReserveOther);
  const drift = cat.sharesOut - bin.sharesOut;
  assert.ok(drift <= 1n && drift >= -1n, `drift=${drift}`);
});

test("catCalcBuy keeps k non-decreasing and a round trip never profits", () => {
  const next = lcg(0x9e3779b97f4a7c15n);
  for (let i = 0; i < 2000; i++) {
    const n = 2 + Number(next() % 7n);
    const reserves = Array.from({ length: n }, () => 100n + (next() % 10_000n));
    const j = Number(next() % BigInt(n));
    const amt = 100n + (next() % 100n);
    const fee = next() % 300n;

    const k0 = reserves.reduce((a, b) => a * b, 1n);
    const q = catCalcBuy(reserves, j, amt, fee);
    assert.ok(q.newReserves.reduce((a, b) => a * b, 1n) >= k0, "buy decreased k");
    for (let k = 0; k < n; k++) {
      if (k !== j) assert.equal(q.newReserves[k], reserves[k] + q.net);
    }
    try {
      const s = catCalcSell(q.newReserves, j, amt, fee);
      assert.ok(s.sharesIn >= q.sharesOut, "free money");
    } catch {
      // insufficient liquidity to sell back out is fine, not what's tested here
    }
  }
});

test("catPrices sum to within n of BPS and are flat for equal reserves", () => {
  const next = lcg(0xb1a5e5b1a5b1a5b1n);
  for (let i = 0; i < 2000; i++) {
    const n = 2 + Number(next() % 7n);
    const reserves = Array.from({ length: n }, () => 1_000n + (next() % 1_000_000_000_000n));
    const sum = catPrices(reserves).reduce((a, b) => a + b, 0n);
    assert.ok(sum <= BPS, `prices sum above BPS: n=${n} sum=${sum}`);
    assert.ok(sum + BigInt(n) >= BPS, `prices sum below BPS - n: n=${n} sum=${sum}`);
  }
  for (let n = 2; n <= MAX_MARKET_OUTCOMES; n++) {
    const prices = catPrices(Array.from({ length: n }, () => 7_777n));
    assert.deepEqual(prices, Array.from({ length: n }, () => BigInt(Math.floor(10_000 / n))));
  }
});

test("catSeed opens at the requested probabilities and validates inputs", () => {
  for (const probs of [
    [5000, 5000],
    [6800, 3200],
    [5000, 3000, 2000],
    [9000, 500, 400, 100],
  ]) {
    const s = catSeed(1_000_000_000n, probs);
    const prices = catPrices(s.reserves);
    for (let i = 0; i < probs.length; i++) {
      const drift = prices[i] - BigInt(probs[i]);
      assert.ok(drift <= 2n && drift >= -2n, `price drift ${drift} bps at i=${i}`);
      assert.equal(s.reserves[i] + s.creatorShares[i], 1_000_000_000n);
    }
    const minIndex = probs.indexOf(Math.min(...probs));
    assert.equal(s.creatorShares[minIndex], 0n);
  }
  // 8 equal outcomes: prices sum to exactly BPS, creator holds nothing.
  const flat = catSeed(1_000_000_000n, Array(8).fill(1250));
  assert.deepEqual(catPrices(flat.reserves), Array(8).fill(1250n));
  assert.ok(flat.creatorShares.every((c) => c === 0n));

  // Validation: bad sum, below MIN_PROB_BPS, n out of range, seed 0.
  for (const [seed, probs] of [
    [1_000n, [6000, 3000]],
    [1_000n, [9950, 50]],
    [1_000n, [10_000]],
    [1_000n, Array(9).fill(1250)],
    [0n, [5000, 5000]],
  ] as [bigint, number[]][]) {
    assert.throws(
      () => catSeed(seed, probs),
      MathError,
      `catSeed accepted ${probs} seed=${seed}`,
    );
  }
});

test("catSettleValue never overpays and handles void", () => {
  const next = lcg(0xdeadbeefdeadbeefn);
  for (let i = 0; i < 1000; i++) {
    const n = 2 + Number(next() % 7n);
    const sets = 1_000_000n;
    // Three holders share each outcome's `sets` shares with the pool.
    const held: bigint[][] = Array.from({ length: n }, () => {
      let rest = sets;
      return [0, 1, 2].map((h) => {
        const take = h === 2 ? rest : next() % (rest + 1n);
        rest -= take;
        return take;
      });
    });
    const w = Number(next() % BigInt(n));
    let resolvedTotal = 0n;
    let voidTotal = 0n;
    for (let h = 0; h < 3; h++) {
      const balances = held.map((col) => col[h]);
      resolvedTotal += catSettleValue(w, balances);
      voidTotal += catSettleValue(null, balances);
    }
    assert.ok(resolvedTotal <= sets);
    assert.ok(voidTotal <= sets, `void overpaid: ${voidTotal} > ${sets}`);
  }
  assert.equal(catSettleValue(1, [3n, 7n, 11n]), 7n);
  assert.equal(catSettleValue(null, [3n, 7n, 11n]), 7n); // 21 / 3
  assert.equal(catSettleValue(null, Array(7).fill(1n)), 1n);
});

test("scalarPayout matches the binary legs at the extremes and never overpays", () => {
  assert.equal(scalarPayout(BPS, 5n, 7n), settleValue("yes", 5n, 7n));
  assert.equal(scalarPayout(0n, 5n, 7n), settleValue("no", 5n, 7n));
  assert.equal(scalarPayout(5_000n, 1_000n, 1_000n), 1_000n);
  assert.equal(scalarPayout(3_333n, 1_000n, 1_000n), 999n);

  const next = lcg(0x5ca1ab1e5ca1ab1en);
  for (let i = 0; i < 1000; i++) {
    const sets = 1n + (next() % 1_000_000n);
    const payout = next() % (BPS + 1n);
    // Three holders split `sets` YES and `sets` NO shares exactly.
    let yesLeft = sets;
    let noLeft = sets;
    let total = 0n;
    for (let h = 0; h < 3; h++) {
      const takeY = h === 2 ? yesLeft : next() % (yesLeft + 1n);
      const takeN = h === 2 ? noLeft : next() % (noLeft + 1n);
      yesLeft -= takeY;
      noLeft -= takeN;
      total += scalarPayout(payout, takeY, takeN);
    }
    assert.ok(total <= sets, `scalar overpaid: ${total} > ${sets} at p=${payout}`);
  }
});

test("effectiveFeeBps matches the shared cross-language fixtures", () => {
  // Same table as math.rs's effective_fee_matches_fixtures and
  // model/fpmm_model.py's _check_effective_fee_known_values: one row per
  // fixture, nine numbers — [base_bps, max_bps, ramp_secs, skew_mult_bps,
  // now, close, r_yes, r_no, expected_fee_bps].
  const rows = JSON.parse(
    readFileSync(new URL("../../model/fee_fixtures.json", import.meta.url), "utf8"),
  ) as number[][];
  assert.ok(rows.length > 0, "fee_fixtures.json has no rows");
  for (const row of rows) {
    assert.equal(row.length, 9);
    const schedule: FeeSchedule = {
      baseBps: BigInt(row[0]),
      maxBps: BigInt(row[1]),
      rampSecs: BigInt(row[2]),
      skewMultBps: BigInt(row[3]),
    };
    const fee = effectiveFeeBps(schedule, BigInt(row[4]), BigInt(row[5]), BigInt(row[6]), BigInt(row[7]));
    assert.equal(fee, BigInt(row[8]), `fixture ${JSON.stringify(row)}`);
  }
});

test("effectiveFeeBps stays within bounds and ramps monotonically", () => {
  const next = lcg(0xfee10beefee10been);
  for (let i = 0; i < 2000; i++) {
    const base = next() % 1_000n;
    const maxBps = base + (next() % (1_000n - base + 1n));
    const schedule: FeeSchedule = {
      baseBps: base,
      maxBps,
      rampSecs: next() % (MAX_RAMP_SECS + 1n),
      skewMultBps: next() % (MAX_SKEW_MULT_BPS + 1n),
    };
    const close = 1_000n + (next() % 2_000_000_000n);
    const now = next() % (close + 10_000n);
    const fee = effectiveFeeBps(schedule, now, close, 1n + (next() % 10n ** 15n), 1n + (next() % 10n ** 15n));
    assert.ok(fee >= base && fee <= maxBps, `fee=${fee} base=${base} max=${maxBps}`);
  }

  // Ramp monotonic in time, full ramp at/past close.
  const sched: FeeSchedule = { baseBps: 100n, maxBps: 800n, rampSecs: 10_000n, skewMultBps: 0n };
  let prev = -1n;
  for (let t = 2_000_000n - 20_000n; t <= 2_000_000n + 5_000n; t += 137n) {
    const fee = effectiveFeeBps(sched, t, 2_000_000n, 1_000n, 1_000n);
    assert.ok(fee >= prev);
    prev = fee;
  }
  assert.equal(prev, 800n);

  // Zero ramp means "no ramp", even at close.
  const flat: FeeSchedule = { baseBps: 100n, maxBps: 800n, rampSecs: 0n, skewMultBps: 0n };
  assert.equal(effectiveFeeBps(flat, 0n, 2_000_000n, 1_000n, 1_000n), 100n);
  assert.equal(effectiveFeeBps(flat, 2_000_000n, 2_000_000n, 1_000n, 1_000n), 100n);

  // Skew is symmetric around 50/50 for representable ratios.
  for (const [a, b] of [
    [1000n, 3000n],
    [900n, 1100n],
    [5000n, 5000n],
    [1n, 4n],
    [7n, 3n],
    [1n, 1n],
  ]) {
    const skewSched: FeeSchedule = { baseBps: 100n, maxBps: 1_000n, rampSecs: 0n, skewMultBps: 500n };
    assert.equal(
      effectiveFeeBps(skewSched, 0n, 1n, a, b),
      effectiveFeeBps(skewSched, 0n, 1n, b, a),
      `skew asymmetry for ${a}/${b}`,
    );
  }

  // The pure function only requires base <= max < BPS (the tighter
  // MAX_FEE_BPS cap is the contract's validate_schedule), so (1000, 1000)
  // is valid here.
  assert.equal(
    effectiveFeeBps({ baseBps: 1_000n, maxBps: 1_000n, rampSecs: 0n, skewMultBps: 0n }, 0n, 1n, 1_000n, 1_000n),
    1_000n,
  );
  assert.throws(
    () => effectiveFeeBps({ baseBps: 500n, maxBps: 100n, rampSecs: 0n, skewMultBps: 0n }, 0n, 1n, 1_000n, 1_000n),
    MathError,
  );
  assert.throws(
    () => effectiveFeeBps({ baseBps: 0n, maxBps: BPS, rampSecs: 0n, skewMultBps: 0n }, 0n, 1n, 1_000n, 1_000n),
    MathError,
  );
});
