import assert from "node:assert/strict";
import test from "node:test";
import { decideMarketProposal, decideTrade, twapFromObservations } from "./strategy.js";

test("decideMarketProposal skips a signal with no actionable estimate", () => {
  const d = decideMarketProposal(
    { summary: "vague news", source: "test", observedAt: 0 },
    { confidenceThresholdBps: 500, defaultSeedStroops: 1_000_000_000n },
  );
  assert.equal(d.action, "skip");
});

test("decideMarketProposal skips a low-confidence estimate", () => {
  const d = decideMarketProposal(
    {
      summary: "coin flip",
      proposedQuestion: "Will X happen?",
      fairValueBps: 5100,
      source: "test",
      observedAt: 0,
    },
    { confidenceThresholdBps: 500, defaultSeedStroops: 1_000_000_000n },
  );
  assert.equal(d.action, "skip");
});

test("decideMarketProposal proposes a market for a confident estimate", () => {
  const d = decideMarketProposal(
    {
      summary: "strong signal",
      proposedQuestion: "Will X happen?",
      fairValueBps: 7500,
      source: "test",
      observedAt: 0,
    },
    { confidenceThresholdBps: 500, defaultSeedStroops: 1_000_000_000n },
  );
  assert.equal(d.action, "propose_market");
  assert.equal(d.initialYesBps, 7500);
  assert.equal(d.seedAmountStroops, 1_000_000_000n);
});

test("decideTrade skips when the edge is below threshold", () => {
  const d = decideTrade(
    { marketId: 1, question: "q", yesBps: 5000, closeTime: 0 },
    5050,
    { minEdgeBps: 100, tradeSizeStroops: 10_000_000n },
  );
  assert.equal(d.action, "skip");
});

test("decideTrade buys Yes when the market underprices it", () => {
  const d = decideTrade(
    { marketId: 1, question: "q", yesBps: 4000, closeTime: 0 },
    6000,
    { minEdgeBps: 100, tradeSizeStroops: 10_000_000n },
  );
  assert.equal(d.action, "buy");
  assert.equal(d.outcome, "Yes");
});

test("decideTrade buys No when the market overprices Yes", () => {
  const d = decideTrade(
    { marketId: 1, question: "q", yesBps: 8000, closeTime: 0 },
    3000,
    { minEdgeBps: 100, tradeSizeStroops: 10_000_000n },
  );
  assert.equal(d.action, "buy");
  assert.equal(d.outcome, "No");
});

test("decideTrade uses twapBps when priceSource is twap", () => {
  // Spot sits right on the fair value (no edge), but the TWAP reveals the
  // real mispricing the spot price was dragged away from.
  const d = decideTrade(
    { marketId: 7, question: "q", yesBps: 6000, twapBps: 4000, closeTime: 0 },
    6000,
    { minEdgeBps: 100, tradeSizeStroops: 10_000_000n, priceSource: "twap" },
  );
  assert.equal(d.action, "buy");
  assert.equal(d.outcome, "Yes");
  assert.match(d.reasoning, /4000bps \(twap\)/);

  // The same market read as spot skips.
  const spot = decideTrade(
    { marketId: 7, question: "q", yesBps: 6000, twapBps: 4000, closeTime: 0 },
    6000,
    { minEdgeBps: 100, tradeSizeStroops: 10_000_000n, priceSource: "spot" },
  );
  assert.equal(spot.action, "skip");
});

test("decideTrade with priceSource twap requires a twap price", () => {
  assert.throws(
    () =>
      decideTrade(
        { marketId: 7, question: "q", yesBps: 6000, closeTime: 0 },
        6000,
        { minEdgeBps: 100, tradeSizeStroops: 10_000_000n, priceSource: "twap" },
      ),
    /twapBps/,
  );
});

test("twapFromObservations matches contract example", () => {
  // Mirrors market-core's `twap_weights_by_time` arithmetic with round
  // numbers: seeded at 6800bps, trade at t=1000 leaving 5000bps, trade at
  // t=1100 leaving 6000bps, then the live edge counterfactually extended to
  // t=1400. The 400s window from t=1000 to t=1400 averages
  // (5000*100 + 6000*300) / 400 = 5750.
  const observations = [
    { ts: 0, cumulative: 0n },
    { ts: 1000, cumulative: 6_800_000n },
    { ts: 1100, cumulative: 6_800_000n + 100n * 5_000n },
    { ts: 1400, cumulative: 6_800_000n + 100n * 5_000n + 300n * 6_000n },
  ];
  assert.equal(twapFromObservations(observations, 400), 5750);
  // The last 300s were held at 6000bps exactly.
  assert.equal(twapFromObservations(observations, 300), 6000);
  // Windows may start strictly between observations (interpolated chord):
  // t = 950 sits in the seeded-price stretch, so cum(950) = 6800 * 950.
  assert.equal(
    twapFromObservations(observations, 450),
    Math.floor((9_100_000 - (6_800_000 * 950) / 1000) / 450),
  );
});

test("twapFromObservations throws when the window predates the ring", () => {
  const observations = [
    { ts: 1000, cumulative: 0n },
    { ts: 2000, cumulative: 5_000_000n },
  ];
  assert.throws(() => twapFromObservations(observations, 1001), /ObservationTooOld/);
  assert.throws(() => twapFromObservations([], 100), /no observations/);
  assert.throws(() => twapFromObservations(observations, 0), /positive integer/);
});
