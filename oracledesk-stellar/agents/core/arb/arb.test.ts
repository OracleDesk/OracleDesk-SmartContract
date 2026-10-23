import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTraceStore } from "../trace.js";
import { seedReserves } from "../fpmm.js";
import {
  discoverMonotonicChains,
  RelationValidationError,
  validateRelations,
  type ArbMarketSnapshot,
  type ExhaustivePartitionRelation,
  type MonotonicChainRelation,
} from "./relations.js";
import { detectDutchBook, detectMonotonicViolation, sizeDutchBook } from "./detect.js";
import { executeArbitrage } from "./execute.js";
import type { StellarAdapter } from "../../stellar/adapter.js";

function makeMarket(
  marketId: number,
  yesBps: bigint,
  seed: bigint = 1_000_000_000n,
  feeBps: bigint = 100n,
  priceSpec?: ArbMarketSnapshot["priceSpec"],
): ArbMarketSnapshot {
  const s = seedReserves(seed, yesBps);
  return {
    marketId,
    status: "Open",
    reserveYes: s.reserveYes,
    reserveNo: s.reserveNo,
    feeBps,
    closeTime: 1800000000,
    priceSpec,
  };
}

test("detectDutchBook identifies a profitable 3-way exhaustive partition underpricing YES", () => {
  // 28% + 28% + 28% = 84% (< 100%)
  const m1 = makeMarket(1, 2800n);
  const m2 = makeMarket(2, 2800n);
  const m3 = makeMarket(3, 2800n);
  const map = new Map([
    [1, m1],
    [2, m2],
    [3, m3],
  ]);
  const rel: ExhaustivePartitionRelation = {
    kind: "exhaustive_partition",
    markets: [1, 2, 3],
    label: "3-way election winner",
  };

  const opp = detectDutchBook(rel, map, { minProfitStroops: 100n });
  assert.ok(opp, "expected Dutch book opportunity");
  assert.equal(opp.kind, "dutch_book_yes");
  assert.equal(opp.legs.length, 3);
  assert.ok(opp.guaranteedProfit > 0n);

  // Guaranteed payout must exceed total collateral in ALL 3 partition outcomes
  for (const winningLeg of opp.legs) {
    assert.ok(
      winningLeg.expectedShares - opp.totalCollateralIn >= opp.guaranteedProfit,
      "every partition resolution must yield >= guaranteedProfit",
    );
  }
});

test("detectDutchBook skips when fees erase a narrow mispricing", () => {
  // 33% + 33% + 33% = 99% (100 bps raw edge), but 200 bps fee per leg erases profit
  const m1 = makeMarket(1, 3300n, 1_000_000_000n, 200n);
  const m2 = makeMarket(2, 3300n, 1_000_000_000n, 200n);
  const m3 = makeMarket(3, 3300n, 1_000_000_000n, 200n);
  const map = new Map([
    [1, m1],
    [2, m2],
    [3, m3],
  ]);
  const rel: ExhaustivePartitionRelation = {
    kind: "exhaustive_partition",
    markets: [1, 2, 3],
    label: "tight partition",
  };

  const opp = detectDutchBook(rel, map, { minProfitStroops: 100n });
  assert.equal(opp, null);
});

test("detectDutchBook buys NO on all legs when mutually exclusive YES probabilities sum > 100%", () => {
  // 45% + 45% + 45% = 135% (> 100%)
  const m1 = makeMarket(10, 4500n);
  const m2 = makeMarket(11, 4500n);
  const m3 = makeMarket(12, 4500n);
  const map = new Map([
    [10, m1],
    [11, m2],
    [12, m3],
  ]);
  const rel: ExhaustivePartitionRelation = {
    kind: "exhaustive_partition",
    markets: [10, 11, 12],
    label: "overpriced partition",
  };

  const opp = detectDutchBook(rel, map, { minProfitStroops: 100n });
  assert.ok(opp, "expected NO-bundle Dutch book");
  assert.equal(opp.kind, "dutch_book_no");
  assert.ok(opp.legs.every((l) => l.outcome === "No"));
  assert.ok(opp.guaranteedProfit > 0n);
});

test("discoverMonotonicChains and detectMonotonicViolation find inverted threshold markets", () => {
  // Market 20: XLM > $0.20 priced at 35% YES
  // Market 21: XLM > $0.30 priced at 60% YES (impossible: >$0.30 implies >$0.20)
  const m20 = makeMarket(20, 3500n, 1_000_000_000n, 50n, {
    oracle: "CORACLE",
    asset: "XLM",
    comparison: "Gt",
    threshold: 2_000_000n,
  });
  const m21 = makeMarket(21, 6000n, 1_000_000_000n, 50n, {
    oracle: "CORACLE",
    asset: "XLM",
    comparison: "Gt",
    threshold: 3_000_000n,
  });

  const chains = discoverMonotonicChains([m21, m20]);
  assert.equal(chains.length, 1);
  assert.deepEqual(
    chains[0].chain.map((c) => c.marketId),
    [20, 21],
  );

  const map = new Map([
    [20, m20],
    [21, m21],
  ]);
  const opp = detectMonotonicViolation(chains[0], map, { minProfitStroops: 100n });
  assert.ok(opp, "expected monotonic violation opportunity");
  assert.equal(opp.kind, "monotonic_violation");
  assert.equal(opp.legs[0].marketId, 20);
  assert.equal(opp.legs[0].outcome, "Yes");
  assert.equal(opp.legs[1].marketId, 21);
  assert.equal(opp.legs[1].outcome, "No");
  assert.ok(opp.guaranteedProfit > 0n);
});

test("sizeDutchBook guaranteedProfit is non-negative across all valid outcomes for random pools", () => {
  let state = 42;
  const rand = (min: number, max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };

  for (let i = 0; i < 40; i++) {
    const p1 = BigInt(rand(1500, 3000));
    const p2 = BigInt(rand(1500, 3000));
    const p3 = BigInt(rand(1500, 3000));
    const markets = [
      makeMarket(1, p1, BigInt(rand(50_000_000, 500_000_000)), BigInt(rand(0, 150))),
      makeMarket(2, p2, BigInt(rand(50_000_000, 500_000_000)), BigInt(rand(0, 150))),
      makeMarket(3, p3, BigInt(rand(50_000_000, 500_000_000)), BigInt(rand(0, 150))),
    ];
    const sized = sizeDutchBook(markets, ["Yes", "Yes", "Yes"], 1n);
    if (sized) {
      assert.ok(sized.guaranteedProfit > 0n);
      for (const leg of sized.legs) {
        assert.ok(leg.expectedShares - sized.totalCollateralIn >= sized.guaranteedProfit);
      }
    }
  }
});

test("validateRelations rejects duplicate/self-referential markets and skips Resolved markets", () => {
  const m1 = makeMarket(1, 4000n);
  const m2 = { ...makeMarket(2, 6000n), status: "Resolved" as const };
  const map = new Map([
    [1, m1],
    [2, m2],
  ]);

  assert.throws(
    () =>
      validateRelations(
        [{ kind: "exhaustive_partition", markets: [1, 1], label: "self-ref" }],
        map,
      ),
    RelationValidationError,
  );

  const active = validateRelations(
    [{ kind: "exhaustive_partition", markets: [1, 2], label: "one resolved" }],
    map,
  );
  assert.equal(active.length, 0);
});

test("executeArbitrage unwinds leg 1 when leg 2 fails in live/simulated execution", async () => {
  const m20 = makeMarket(20, 3000n, 1_000_000_000n, 50n);
  const m21 = makeMarket(21, 6500n, 1_000_000_000n, 50n);
  const map = new Map([
    [20, m20],
    [21, m21],
  ]);
  const rel: MonotonicChainRelation = {
    kind: "monotonic_chain",
    chain: [
      { marketId: 20, threshold: 2_000_000n },
      { marketId: 21, threshold: 3_000_000n },
    ],
    comparison: "Gt",
    asset: "XLM",
  };
  const opp = detectMonotonicViolation(rel, map)!;
  assert.ok(opp);

  const sellCalls: unknown[] = [];
  let buyCallCount = 0;
  const fakeAdapter = {
    mode: "dry-run",
    agent: "GARB",
    async quoteBuy({ market_id }: { market_id: bigint }) {
      const leg = opp.legs.find((l) => BigInt(l.marketId) === market_id)!;
      return leg.expectedShares;
    },
    async agentBuyV2(args: unknown) {
      buyCallCount++;
      if (buyCallCount === 2) {
        throw new Error("Simulated slippage revert on leg 2");
      }
      return { dryRun: true as const, contractId: "CTREASURY", method: "agent_buy_v2", args };
    },
    async agentSellV2(args: unknown) {
      sellCalls.push(args);
      return { dryRun: true as const, contractId: "CTREASURY", method: "agent_sell_v2", args };
    },
  } as unknown as StellarAdapter;

  const traceStore = new LocalTraceStore(mkdtempSync(join(tmpdir(), "arb-test-")));
  const res = await executeArbitrage(opp, map, fakeAdapter, traceStore);
  assert.equal(res.status, "unwound_partial");
  assert.deepEqual(res.unwoundLegs, [20]);
  assert.equal(sellCalls.length, 1);
});
