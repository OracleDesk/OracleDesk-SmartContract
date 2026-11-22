import assert from "node:assert/strict";
import test from "node:test";
import { calcBuy, collateralForShares, seedReserves } from "../fpmm.js";
import {
  guaranteedPayout,
  parseRelations,
  planArbitrage,
  scenarios,
  validateRelation,
  type ArbCaps,
  type Holding,
  type MarketSnapshot,
  type RelationDecl,
} from "./arbitrage.js";

const NOW = 1_700_000_000;
const HASH = "ab".repeat(32);
const resolution = { a: { mechanism: "price", source: "reflector:XLM" }, b: { mechanism: "price", source: "reflector:XLM" } };

function market(id: bigint, yesBps: bigint, seed = 10_000_000_000n, feeBps = 100n): MarketSnapshot {
  const r = seedReserves(seed, yesBps);
  return { id, reserveYes: r.reserveYes, reserveNo: r.reserveNo, feeBps, closeTime: BigInt(NOW + 86_400), status: "Open", resolutionHash: HASH };
}

function relation(type: RelationDecl["type"], voidCorrelation: "joint" | "independent" = "joint"): RelationDecl {
  return { id: "r1", type, a: 0, b: 1, resolution, voidCorrelation, maxCloseSkewSecs: 0 };
}

const BIG = 10n ** 15n;
function caps(over: Partial<ArbCaps> = {}): ArbCaps {
  return { maxTrade: BIG, marketHeadroom: new Map([[0n, BIG], [1n, BIG]]), dailyRemaining: BIG, maxNotional: BIG, ...over };
}
const anyProfit = { minProfit: 1n, minProfitBps: 0n };

function plan(rel: RelationDecl, a: MarketSnapshot, b: MarketSnapshot, o: { caps?: ArbCaps; holdings?: Map<bigint, Holding>; thresholds?: typeof anyProfit } = {}) {
  return planArbitrage({
    relation: rel,
    graphHash: "g",
    markets: new Map([[a.id, a], [b.id, b]]),
    holdings: o.holdings ?? new Map(),
    caps: o.caps ?? caps(),
    thresholds: o.thresholds ?? anyProfit,
  });
}

test("a violated implication (P(A) > P(B)) produces a NO-A / YES-B plan", () => {
  const r = plan(relation("implies"), market(0n, 7000n), market(1n, 4000n));
  assert.ok(r.plan, "reason" in r ? r.reason : "");
  const outcomes = Object.fromEntries(r.plan.legs.map((l) => [String(l.marketId), l.outcome]));
  assert.deepEqual(outcomes, { "0": "No", "1": "Yes" });
  assert.ok(r.plan.profit > 0n);
  assert.equal(r.plan.profit, r.plan.payoutGain - r.plan.cost);
});

test("coherent prices produce no plan", () => {
  for (const [type, pa, pb] of [["implies", 4000n, 6000n], ["complement", 3000n, 7000n], ["exclusive", 3000n, 6500n]] as const) {
    const r = plan(relation(type), market(0n, pa), market(1n, pb));
    assert.equal(r.plan, undefined, `${type} ${pa}/${pb}`);
  }
});

test("complement and exclusive violations pick the underpriced side", () => {
  const cheap = plan(relation("complement"), market(0n, 3000n), market(1n, 5000n));
  assert.deepEqual(cheap.plan?.legs.map((l) => l.outcome), ["Yes", "Yes"]);
  const rich = plan(relation("exclusive"), market(0n, 7000n), market(1n, 6000n));
  assert.deepEqual(rich.plan?.legs.map((l) => l.outcome), ["No", "No"]);
});

test("costs include fees, price impact and rounding exactly", () => {
  const r = plan(relation("implies"), market(0n, 7000n), market(1n, 4000n));
  assert.ok(r.plan);
  for (const leg of r.plan.legs) {
    const m = leg.marketId === 0n ? market(0n, 7000n) : market(1n, 4000n);
    const [rB, rO] = leg.outcome === "Yes" ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
    assert.equal(leg.collateral, collateralForShares(rB, rO, leg.shares, m.feeBps));
    assert.equal(leg.expectedShares, calcBuy(rB, rO, leg.collateral, m.feeBps).sharesOut);
  }
  const noFee = plan(relation("implies"), market(0n, 7000n, undefined, 0n), market(1n, 4000n, undefined, 0n));
  assert.ok(noFee.plan && noFee.plan.profit > r.plan.profit, "fees reduce profit");
});

test("the planner finds the brute-force optimum on small reserves", () => {
  for (const [pa, pb, seed] of [[7000n, 4000n, 2_000n], [8000n, 3000n, 900n], [6000n, 5000n, 3_000n]]) {
    const a = market(0n, pa, seed, 100n);
    const b = market(1n, pb, seed, 100n);
    const r = plan(relation("implies"), a, b, { thresholds: { minProfit: 1n, minProfitBps: 0n } });
    let best = 0n;
    const table = scenarios("implies", "joint");
    for (let s = 1n; s <= seed * 4n; s++) {
      try {
        const ca = collateralForShares(a.reserveNo, a.reserveYes, s, 100n);
        const cb = collateralForShares(b.reserveYes, b.reserveNo, s, 100n);
        const sa = calcBuy(a.reserveNo, a.reserveYes, ca, 100n).sharesOut;
        const sb = calcBuy(b.reserveYes, b.reserveNo, cb, 100n).sharesOut;
        const profit = guaranteedPayout(table, { yes: 0n, no: sa }, { yes: sb, no: 0n }) - ca - cb;
        if (profit > best) best = profit;
      } catch {
        break;
      }
    }
    assert.equal(r.plan?.profit ?? 0n, best, `${pa}/${pb} seed ${seed}`);
  }
});

test("treasury caps and ARB_MAX_NOTIONAL bound the plan", () => {
  const a = market(0n, 7000n);
  const b = market(1n, 4000n);
  const free = plan(relation("implies"), a, b).plan!;
  const capped = plan(relation("implies"), a, b, { caps: caps({ maxTrade: free.legs[0].collateral / 4n }) }).plan!;
  assert.ok(capped.legs.every((l) => l.collateral <= free.legs[0].collateral / 4n));
  const notional = plan(relation("implies"), a, b, { caps: caps({ maxNotional: 50_000_000n }) }).plan!;
  assert.ok(notional.cost <= 50_000_000n);
  const headroom = plan(relation("implies"), a, b, { caps: caps({ marketHeadroom: new Map([[0n, 10_000_000n], [1n, BIG]]) }) }).plan!;
  assert.ok(headroom.legs.find((l) => l.marketId === 0n)!.collateral <= 10_000_000n);
  const daily = plan(relation("implies"), a, b, { caps: caps({ dailyRemaining: 0n }) });
  assert.equal(daily.plan, undefined);
});

test("minimum absolute and percentage profit thresholds are enforced", () => {
  const a = market(0n, 7000n);
  const b = market(1n, 4000n);
  const p = plan(relation("implies"), a, b).plan!;
  assert.match((plan(relation("implies"), a, b, { thresholds: { minProfit: p.profit + 1n, minProfitBps: 0n } }) as { reason: string }).reason, /ARB_MIN_PROFIT_STROOPS/);
  assert.match((plan(relation("implies"), a, b, { thresholds: { minProfit: 1n, minProfitBps: p.profitBps + 1n } }) as { reason: string }).reason, /ARB_MIN_PROFIT_BPS/);
});

test("void scenarios are priced in: independent voids can erase the edge", () => {
  // Joint voids: both pay half, so NO-A + YES-B still pays 1 per pair.
  assert.equal(guaranteedPayout(scenarios("implies", "joint"), { yes: 0n, no: 100n }, { yes: 100n, no: 0n }), 100n);
  // Independent: A void (pays 50) while B resolves NO (pays 0) leaves 50.
  assert.equal(guaranteedPayout(scenarios("implies", "independent"), { yes: 0n, no: 100n }, { yes: 100n, no: 0n }), 50n);
  const joint = plan(relation("implies", "joint"), market(0n, 7000n), market(1n, 4000n));
  const independent = plan(relation("implies", "independent"), market(0n, 7000n), market(1n, 4000n));
  assert.ok(joint.plan);
  assert.equal(independent.plan, undefined, "a 30-point gap does not survive a half-paying void leg");
});

test("existing holdings are counted: a position that is already hedged needs less", () => {
  const a = market(0n, 7000n);
  const b = market(1n, 4000n);
  const fresh = plan(relation("implies"), a, b).plan!;
  // Already long NO-A without the YES-B hedge: adding legs is worth more.
  const held = plan(relation("implies"), a, b, { holdings: new Map([[0n, { yes: 0n, no: 5_000_000_000n }]]) }).plan!;
  assert.ok(held.profit > fresh.profit);
});

test("the less liquid market is traded first", () => {
  const r = plan(relation("implies"), market(0n, 7000n, 50_000_000_000n), market(1n, 4000n, 5_000_000_000n));
  assert.equal(r.plan?.legs[0].marketId, 1n);
});

test("relations are validated against the markets and their resolution", () => {
  const a = market(0n, 7000n);
  const b = market(1n, 4000n);
  const markets = new Map([[0n, a], [1n, b]]);
  assert.deepEqual(validateRelation(relation("implies"), markets, NOW), []);
  const unrelated = { ...relation("implies"), resolution: { a: resolution.a, b: { mechanism: "signers", source: "committee-7" } } };
  assert.match(validateRelation(unrelated, markets, NOW).join(), /unrelated resolution mechanisms/);
  const wrongHash = { ...relation("implies"), resolution: { a: { ...resolution.a, resolutionHash: "cd".repeat(32) }, b: resolution.b } };
  assert.match(validateRelation(wrongHash, markets, NOW).join(), /does not match the declared/);
  const closed = new Map([[0n, { ...a, status: "Resolved" as const }], [1n, b]]);
  assert.match(validateRelation(relation("implies"), closed, NOW).join(), /not open/);
  const skewed = new Map([[0n, a], [1n, { ...b, closeTime: b.closeTime + 7_200n }]]);
  assert.match(validateRelation(relation("implies"), skewed, NOW).join(), /close times differ/);
  assert.match(validateRelation({ ...relation("implies"), b: 9 }, markets, NOW).join(), /does not exist/);
});

test("a relations file without compatibility declarations is rejected, and the graph hash is stable", () => {
  assert.throws(() => parseRelations(JSON.stringify({ relations: [{ id: "x", type: "implies", a: 0, b: 1, voidCorrelation: "joint" }] })), /resolution/);
  assert.throws(() => parseRelations(JSON.stringify({ relations: [{ ...relation("implies"), voidCorrelation: undefined }] })), /voidCorrelation/);
  const g1 = parseRelations(JSON.stringify({ relations: [relation("implies")] }));
  const reordered = JSON.parse(JSON.stringify({ relations: [relation("implies")] }), (_k, v) => v);
  const g2 = parseRelations(JSON.stringify({ relations: [Object.fromEntries(Object.entries(reordered.relations[0]).reverse())] }));
  assert.equal(g1.hash, g2.hash);
  assert.match(g1.hash, /^[0-9a-f]{64}$/);
});
