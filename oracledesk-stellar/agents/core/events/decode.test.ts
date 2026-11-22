import assert from "node:assert/strict";
import test from "node:test";
import { Contract, xdr } from "@stellar/stellar-sdk";
import { encodeEvent, FakeEventsRpc, IDS, testDecoder, trade, TRADER } from "./testing.js";

async function decodeOne(e: Parameters<FakeEventsRpc["emit"]>[0]) {
  const rpc = await FakeEventsRpc.create();
  rpc.emit(e);
  const page = await rpc.getEvents({ filters: [{ type: "contract" }], startLedger: 1 } as never);
  return (await testDecoder()).decode(page.events[0]);
}

test("a market-core Trade decodes into typed fields from the binding spec", async () => {
  const e = await decodeOne(trade(7n, 250_000_000n, 10));
  assert.equal(e?.kind, "Trade");
  if (e?.kind !== "Trade") return;
  assert.equal(e.marketId, 7n);
  assert.equal(e.trader, TRADER);
  assert.equal(e.outcome, "Yes");
  assert.equal(e.isBuy, true);
  assert.equal(e.collateral, 250_000_000n);
  assert.equal(e.shares, 500_000_000n);
  assert.equal(e.contract, "market_core");
  assert.equal(e.contractId, IDS.market_core);
  assert.equal(e.ledger, 10);
  assert.equal(e.closedAt, 1_700_000_050);
});

test("MarketResolved carries an explicit nullable outcome", async () => {
  const yes = await decodeOne({ contract: "market_core", name: "MarketResolved", ledger: 3, values: { market_id: 1n, outcome: { tag: "No", values: undefined } } });
  assert.deepEqual(yes?.kind === "MarketResolved" && [yes.marketId, yes.outcome], [1n, "No"]);
  const voided = await decodeOne({ contract: "market_core", name: "MarketResolved", ledger: 3, values: { market_id: 2n, outcome: undefined } });
  assert.equal(voided?.kind, "MarketResolved");
  assert.equal(voided?.kind === "MarketResolved" ? voided.outcome : "unset", null);
});

test("resolver proposals, finalization and price resolutions decode", async () => {
  const proposed = await decodeOne({
    contract: "resolver",
    name: "ResolutionProposedV2",
    ledger: 4,
    values: { market_id: 3n, outcome: { tag: "Invalid", values: undefined }, proposed_at: 1_700_000_100n },
  });
  assert.deepEqual(proposed?.kind === "ResolutionProposed" && [proposed.outcome, proposed.proposedAt], ["Invalid", 1_700_000_100n]);
  const finalized = await decodeOne({
    contract: "resolver",
    name: "ResolutionFinalizedV2",
    ledger: 5,
    values: { market_id: 3n, outcome: { tag: "Yes", values: undefined }, finalized_at: 1_700_000_900n },
  });
  assert.equal(finalized?.kind, "ResolutionFinalized");
  for (const name of ["PriceResolution", "PriceResolutionV2"]) {
    const p = await decodeOne({
      contract: "resolver",
      name,
      ledger: 6,
      values: { market_id: 4n, price: 123n, price_timestamp: 99n, outcome: { tag: "No", values: undefined }, from_snapshot: true },
    });
    assert.equal(p?.kind, "PriceResolution");
    assert.equal(p?.kind === "PriceResolution" && p.fromSnapshot, name === "PriceResolutionV2");
  }
});

test("Disputed decodes the disputer, bond and optional alternative", async () => {
  const yes = await decodeOne({
    contract: "resolver",
    name: "Disputed",
    ledger: 5,
    values: { market_id: 8n, disputer: TRADER, bond: 250_000_000n, alternative: { tag: "Yes", values: undefined } },
  });
  assert.equal(yes?.kind, "Disputed");
  if (yes?.kind !== "Disputed") return;
  assert.deepEqual([yes.marketId, yes.disputer, yes.bond, yes.alternative], [8n, TRADER, 250_000_000n, "Yes"]);
  const invalid = await decodeOne({
    contract: "resolver",
    name: "Disputed",
    ledger: 5,
    values: { market_id: 9n, disputer: TRADER, bond: 1n, alternative: undefined },
  });
  assert.equal(invalid?.kind === "Disputed" ? invalid.alternative : "unset", null);
});

test("DisputeSettled decodes the verdict, winner flag and payout", async () => {
  const settled = await decodeOne({
    contract: "resolver",
    name: "DisputeSettled",
    ledger: 6,
    values: { market_id: 8n, verdict: { tag: "No", values: undefined }, disputer_won: true, payout: 250_000_000n },
  });
  assert.equal(settled?.kind, "DisputeSettled");
  if (settled?.kind !== "DisputeSettled") return;
  assert.deepEqual([settled.marketId, settled.verdict, settled.disputerWon, settled.payout], [8n, "No", true, 250_000_000n]);
  const timeout = await decodeOne({
    contract: "resolver",
    name: "DisputeSettled",
    ledger: 7,
    values: { market_id: 9n, verdict: { tag: "Invalid", values: undefined }, disputer_won: false, payout: 1n },
  });
  assert.equal(timeout?.kind === "DisputeSettled" && timeout.verdict, "Invalid");
});

test("registry and treasury events decode through their own specs", async () => {
  const traced = await decodeOne({
    contract: "reasoning_registry",
    name: "TracePublished",
    ledger: 7,
    values: { trace_id: 9n, market_id: 4n, agent: TRADER, action: "buy", trace_hash: Buffer.alloc(32, 0xab), ipfs_cid: "bafy", published_at: 1n },
  });
  assert.deepEqual(traced?.kind === "TracePublished" && [traced.traceId, traced.traceHash], [9n, "ab".repeat(32)]);
  const authorized = await decodeOne({
    contract: "treasury",
    name: "TradeAuthorized",
    ledger: 8,
    values: { market_id: 4n, agent: TRADER, amount: 10n, market_total: 10n, daily_total: 10n },
  });
  assert.equal(authorized?.kind, "Unknown");
  assert.equal(authorized?.kind === "Unknown" && authorized.name, "TradeAuthorized");
  assert.equal(authorized?.kind === "Unknown" && (authorized.data as { amount: bigint }).amount, 10n);
});

test("an event the spec cannot decode is Unknown, and a foreign contract is ignored", async () => {
  const garbage = await decodeOne({ contract: "market_core", ledger: 9, raw: { topic: [xdr.ScVal.scvSymbol("no_such_event")], value: xdr.ScVal.scvVoid() } });
  assert.equal(garbage?.kind, "Unknown");
  assert.equal(garbage?.kind === "Unknown" ? garbage.name : "x", undefined);

  const decoder = await testDecoder();
  const spec = decoder.spec("market_core");
  const { topic, value } = encodeEvent(spec, "MarketResolved", { market_id: 1n, outcome: undefined });
  const foreign = decoder.decode({
    id: "1",
    type: "contract",
    ledger: 1,
    ledgerClosedAt: new Date().toISOString(),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "00",
    contractId: new Contract("CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH"),
    topic,
    value,
  });
  assert.equal(foreign, undefined);
});
