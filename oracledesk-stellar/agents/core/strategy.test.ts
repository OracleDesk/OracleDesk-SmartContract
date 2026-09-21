import assert from "node:assert/strict";
import test from "node:test";
import { decideMarketProposal, decideTrade } from "./strategy.js";

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
