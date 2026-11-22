import assert from "node:assert/strict";
import test from "node:test";
import type { OracleDeskEvent } from "./decode.js";
import { disputeDeadline, finalityTracker, proposalWatch, tradeReevaluate, type ProposalAlert } from "./handlers.js";

const meta = { id: "1", ledger: 10, closedAt: 1_700_000_000, txHash: "00", contract: "market_core" as const, contractId: "C" };
const tradeOf = (marketId: bigint, collateral: bigint): OracleDeskEvent => ({
  ...meta,
  kind: "Trade",
  marketId,
  trader: "G",
  outcome: "Yes",
  isBuy: true,
  collateral,
  shares: 1n,
  fee: 0n,
  reserveYes: 1n,
  reserveNo: 1n,
});

test("TradeReevaluate queues a market only after a trade above the threshold, and re-reads it first", async () => {
  const queued: bigint[] = [];
  const reads: bigint[] = [];
  const h = tradeReevaluate({
    threshold: 1_000n,
    readMarket: async (id) => {
      reads.push(id);
      return { marketId: id, open: id !== 3n, yesBps: 5000 };
    },
    enqueue: (id) => queued.push(id),
  });
  await h.handle(tradeOf(1n, 999n));
  await h.handle(tradeOf(2n, 1_000n));
  await h.handle(tradeOf(3n, 5_000n)); // closed since the trade
  assert.deepEqual(reads, [2n, 3n], "small trades do not even read the chain");
  assert.deepEqual(queued, [2n]);
});

test("ProposalWatch alerts on a live proposal for a market the treasury is exposed to", async () => {
  const alerts: ProposalAlert[] = [];
  const exposure = new Map([[5n, 300n], [6n, 0n], [7n, 100n]]);
  const state = new Map([[5n, "SignersPending"], [6n, "SignersPending"], [7n, "Finalized"]]);
  const h = proposalWatch({
    exposure: async (id) => exposure.get(id) ?? 0n,
    proposalState: async (id) => state.get(id) ?? "Unconfigured",
    disputeWindowSecs: async () => 600n,
    alert: (a) => void alerts.push(a),
  });
  for (const marketId of [5n, 6n, 7n]) {
    await h.handle({ ...meta, contract: "resolver", kind: "ResolutionProposed", marketId, outcome: "Yes", proposedAt: 1_699_999_900n });
  }
  assert.equal(alerts.length, 1, "no exposure, or a proposal no longer standing (cancelled/finalized), is not alerted");
  assert.deepEqual(alerts[0], {
    marketId: 5n,
    outcome: "Yes",
    exposure: 300n,
    proposedAt: 1_699_999_900n,
    disputeDeadline: 1_700_000_500n,
    secondsLeft: 500n,
  });
});

test("dispute deadlines come from the proposal's ledger timestamp", () => {
  assert.equal(disputeDeadline(1_700_000_000n, 86_400n), 1_700_086_400n);
});

test("FinalityTracker marks a market final from any resolution path", async () => {
  const finals: [bigint, string][] = [];
  const h = finalityTracker({ markFinal: (id, via) => void finals.push([id, via]) });
  assert.deepEqual(h.kinds, ["MarketResolved", "ResolutionFinalized", "PriceResolution"]);
  await h.handle({ ...meta, kind: "MarketResolved", marketId: 1n, outcome: null });
  await h.handle({ ...meta, contract: "resolver", kind: "ResolutionFinalized", marketId: 2n, outcome: "Invalid", finalizedAt: 1n });
  await h.handle({ ...meta, contract: "resolver", kind: "PriceResolution", marketId: 3n, price: 1n, priceTimestamp: 1n, outcome: "No", fromSnapshot: false });
  assert.deepEqual(finals, [[1n, "MarketResolved"], [2n, "ResolutionFinalized"], [3n, "PriceResolution"]]);
});
