/**
 * The real StellarAdapter, live mode, against the fake Soroban RPC (#106).
 * Every request goes through the production SDK client: WASM fetched from
 * ledger entries, simulation, signing, submission and polling, with real XDR.
 *
 * Artifact path per contract: market_core and treasury use the first fitting
 * WASM (compiled build, else vendored); see test/fake-rpc/artifacts.ts.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { calcBuy } from "../../core/fpmm.js";
import { NotSubmittedError } from "../../stellar/adapter.js";
import { FaultPlan, type Fault } from "../fake-rpc/faults.js";
import { AGENT, blockRealNetwork, startFakeNetwork, type FakeNetwork } from "../fake-rpc/network.js";
import { LIFECYCLE_ISSUE } from "./helpers.js";

const yes = { tag: "Yes" as const, values: undefined as void };
const SIZE = 100_000_000n;
let unblock: () => void;

before(() => {
  unblock = blockRealNetwork();
});
after(() => unblock());

async function withNet<T>(plan: FaultPlan, fn: (net: FakeNetwork) => Promise<T>): Promise<T> {
  const net = await startFakeNetwork({ plan });
  try {
    return await fn(net);
  } finally {
    await net.stop();
  }
}

function buy(net: FakeNetwork, overrides: Partial<{ min_shares_out: bigint; deadline: bigint; collateral_in: bigint }> = {}) {
  return net.adapter().agentBuyV2({
    market_id: net.market.id,
    outcome: yes,
    collateral_in: SIZE,
    min_shares_out: 0n,
    limit_price_bps: 9_000,
    deadline: BigInt(net.rpc.clock.closeTime + 600),
    ...overrides,
  });
}

const sendFault = (fault: Fault) => FaultPlan.script([{ method: "sendTransaction", fault }]);

test("the artifact report names the source used for every contract", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    for (const a of Object.values(net.artifacts)) {
      assert.ok(["compiled", "vendored"].includes(a.source), a.name);
      assert.ok(a.wasm.length > 0 && a.errors.size > 0, `${a.name} spec has an Error enum`);
    }
    assert.equal(net.artifacts.market_core.fits, true);
    assert.equal(net.artifacts.treasury.fits, true);
  });
});

test("a quote is a read call: simulated, never sent", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const shares = await net.adapter().quoteBuy({ market_id: net.market.id, outcome: yes, collateral_in: SIZE });
    const expected = calcBuy(net.market.reserveYes, net.market.reserveNo, SIZE, net.market.feeBps).sharesOut;
    assert.equal(shares, expected);
    assert.equal(net.rpc.requests.filter((r) => r.method === "sendTransaction").length, 0);
  });
});

test("a clean buy is simulated, signed, sent once and decoded from the transaction meta", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const before = net.rpc.sequenceOf(AGENT.publicKey());
    const expected = calcBuy(net.market.reserveYes, net.market.reserveNo, SIZE, net.market.feeBps).sharesOut;
    const r = await buy(net, { min_shares_out: expected });
    assert.deepEqual(r, { dryRun: false, value: expected });
    assert.equal(net.rpc.applied.length, 1);
    assert.equal(net.rpc.sequenceOf(AGENT.publicKey()), before + 1n);
    assert.deepEqual(net.rpc.requests.map((r) => r.method).filter((m) => m !== "getLedgerEntries"), [
      "simulateTransaction",
      "sendTransaction",
      "getTransaction",
    ]);
  });
});

test("a contract error in simulation is NotSubmittedError and sends nothing", async () => {
  await withNet(FaultPlan.script([{ method: "simulateTransaction", fn: "agent_buy_v2", fault: { kind: "contract-error", error: "TradeCapExceeded" } }]), async (net) => {
    await assert.rejects(buy(net), (err: Error) => err instanceof NotSubmittedError && /Error\(Contract, #\d+\)/.test(err.message));
    assert.equal(net.rpc.submissions.length, 0);
  });
});

test("a real model rejection (slippage) also fails in simulation without a submission", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    await assert.rejects(buy(net, { min_shares_out: 10n ** 18n }), NotSubmittedError);
    assert.equal(net.rpc.submissions.length, 0);
  });
});

for (const [label, fault] of [
  ["HTTP 503", { kind: "http", status: 503 }],
  ["a JSON-RPC error", { kind: "rpc-error", code: -32603, message: "internal error" }],
  ["a dropped connection", { kind: "timeout", ms: 10 }],
] as [string, Fault][]) {
  test(`${label} during simulation fails before submission`, async () => {
    await withNet(FaultPlan.script([{ method: "simulateTransaction", fault }]), async (net) => {
      await assert.rejects(buy(net), NotSubmittedError);
      assert.equal(net.rpc.submissions.length, 0);
    });
  });
}

for (const code of ["txBAD_SEQ", "txTOO_LATE", "txINSUFFICIENT_FEE"] as const) {
  test(`${code} is rejected at submission and nothing is applied`, async () => {
    await withNet(sendFault({ kind: "tx-error", code }), async (net) => {
      const seq = net.rpc.sequenceOf(AGENT.publicKey());
      await assert.rejects(buy(net), /Sending the transaction to the network failed/);
      assert.equal(net.rpc.applied.length, 0);
      assert.equal(net.rpc.sequenceOf(AGENT.publicKey()), seq, "a rejected transaction consumes no sequence number");
    });
  });
}

test("TRY_AGAIN_LATER sends nothing, and a fresh attempt succeeds exactly once", async () => {
  await withNet(sendFault({ kind: "try-again-later" }), async (net) => {
    await assert.rejects(buy(net), /TRY_AGAIN_LATER/);
    assert.equal(net.rpc.applied.length, 0);
    await buy(net);
    assert.equal(net.rpc.applied.length, 1);
  });
});

test("a DUPLICATE answer is reported as a failure and applies nothing", async () => {
  await withNet(sendFault({ kind: "duplicate" }), async (net) => {
    await assert.rejects(buy(net), /DUPLICATE/);
    assert.equal(net.rpc.applied.length, 0);
  });
});

test("a transaction that is NOT_FOUND for a while is polled until it lands, and applied once", async () => {
  await withNet(sendFault({ kind: "not-found", polls: 2 }), async (net) => {
    const r = await buy(net);
    assert.equal(r.dryRun, false);
    assert.equal(net.rpc.applied.length, 1);
    assert.equal(net.rpc.requests.filter((r) => r.method === "getTransaction").length, 3);
  });
});

test("latency on every call slows the flow but does not change the outcome", async () => {
  const plan = FaultPlan.script(
    (["getLedgerEntries", "simulateTransaction", "sendTransaction", "getTransaction"] as const).map((method) => ({
      method,
      times: Infinity,
      fault: { kind: "latency", ms: 20 } as Fault,
    })),
  );
  await withNet(plan, async (net) => {
    await buy(net);
    assert.equal(net.rpc.applied.length, 1);
  });
});

test("simulation succeeds but application fails: the fee is spent, the state is not", async () => {
  await withNet(sendFault({ kind: "apply-failure", error: "SlippageExceeded" }), async (net) => {
    const reserves = [net.rpc.state.markets[0].reserveYes, net.rpc.state.markets[0].reserveNo];
    const seq = net.rpc.sequenceOf(AGENT.publicKey());
    // Today the adapter does not read getTransaction's status, so this
    // resolves; the TODO below asserts what it should do.
    await buy(net).catch(() => undefined);
    assert.equal(net.rpc.submissions.at(-1)?.status, "FAILED");
    assert.equal(net.rpc.sequenceOf(AGENT.publicKey()), seq + 1n, "the failed transaction was included");
    assert.deepEqual([net.rpc.state.markets[0].reserveYes, net.rpc.state.markets[0].reserveNo], reserves);
  });
});

test(
  "a transaction that fails on chain is reported as a failure, not a success",
  { todo: `StellarAdapter.run() must check getTransaction's status: ${LIFECYCLE_ISSUE}` },
  async () => {
    await withNet(sendFault({ kind: "apply-failure", error: "SlippageExceeded" }), async (net) => {
      await assert.rejects(buy(net));
    });
  },
);

test("a reset after acceptance surfaces as an error even though the trade executed", async () => {
  await withNet(sendFault({ kind: "reset-after-accept" }), async (net) => {
    const err = await buy(net).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error);
    // The trade is on chain, and the caller cannot tell from the error.
    assert.equal(net.rpc.applied.length, 1);
    assert.ok(!(err instanceof NotSubmittedError), "an ambiguous outcome must not look like a safe-to-retry failure");
  });
});

test(
  "after an ambiguous submission the adapter reconciles instead of letting a retry trade twice",
  { todo: `needs idempotent submission and reconciliation: ${LIFECYCLE_ISSUE}` },
  async () => {
    await withNet(sendFault({ kind: "reset-after-accept" }), async (net) => {
      await buy(net).catch(() => undefined);
      await buy(net).catch(() => undefined); // what a naive caller does next
      assert.equal(net.rpc.applied.filter((s) => s.fn === "agent_buy_v2").length, 1);
    });
  },
);
