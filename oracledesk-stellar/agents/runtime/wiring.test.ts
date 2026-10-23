import assert from "node:assert/strict";
import test from "node:test";
import { applyEffectiveFees } from "./wiring.js";
import type { TraderCandidate } from "./tasks/trader.js";

/** Two markets carrying the flat `get_market.fee_bps` snapshot. */
function candidates(): TraderCandidate[] {
  return [
    {
      market: { marketId: 7, question: "q7", yesBps: 4000, closeTime: 2_000_000, feeBps: 100 },
      fairValueBps: 6000,
    },
    {
      market: { marketId: 8, question: "q8", yesBps: 5500, closeTime: 2_000_000, feeBps: 100 },
      fairValueBps: 6000,
    },
  ];
}

test("applyEffectiveFees replaces the flat fee snapshot with current_fee_bps", async () => {
  const seen: bigint[] = [];
  const out = await applyEffectiveFees(candidates(), async (marketId) => {
    seen.push(marketId);
    return marketId === 7n ? 321 : 250;
  });

  assert.deepEqual(seen, [7n, 8n]);
  assert.deepEqual(
    out.map((c) => c.market.feeBps),
    [321, 250],
  );
});

test("applyEffectiveFees leaves every other market field untouched", async () => {
  const [first] = await applyEffectiveFees(candidates(), async () => 321);
  const [source] = candidates();

  assert.deepEqual(
    { ...first!.market, feeBps: source!.market.feeBps },
    source!.market,
  );
  assert.equal(first!.fairValueBps, source!.fairValueBps);
});
