/**
 * System-level invariants for the trader and market-maker runtime tasks,
 * running the real live adapter against the fake RPC (#106):
 *   - a transaction is never submitted twice for one intent;
 *   - every executed trade has a published trace or a journaled pending one;
 *   - repeated failures halt the agent instead of spending fees forever.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { SIGNALS } from "../../runtime/tasks/maker.js";
import { TRACES, type PendingTrace } from "../../runtime/tasks/traces.js";
import { FaultPlan } from "../fake-rpc/faults.js";
import { artifacts, blockRealNetwork, startFakeNetwork, type FakeNetwork } from "../fake-rpc/network.js";
import { eventValue } from "../fake-rpc/server.js";
import { LIFECYCLE_ISSUE, makerFor, runtimeFor, tick, tracelessTrades, tradeJournal, traderFor } from "./helpers.js";

let unblock: () => void;
before(() => {
  unblock = blockRealNetwork();
});
after(() => unblock());

const registryFits = (await artifacts()).reasoning_registry.fits;
const registryDrift = registryFits
  ? false
  : `the served reasoning_registry spec does not take publish_trace(action: TraceAction) (${(await artifacts()).reasoning_registry.rejected.join("; ")})`;

async function withNet<T>(plan: FaultPlan, fn: (net: FakeNetwork) => Promise<T>): Promise<T> {
  const net = await startFakeNetwork({ plan });
  try {
    return await fn(net);
  } finally {
    await net.stop();
  }
}

const buys = (net: FakeNetwork) => net.rpc.applied.filter((s) => s.fn === "agent_buy_v2");

test("the trader buys once per tick, journals the trade, and never leaves it traceless", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const { runtime, state } = runtimeFor(net, await traderFor(net));
    await tick(runtime);
    assert.equal(buys(net).length, 1);
    assert.deepEqual(tradeJournal(state).map((t) => t.status), ["done"]);
    assert.deepEqual(tracelessTrades(net, state), []);
  });
});

test("the trade's trace is published", { todo: registryDrift }, async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const { runtime } = runtimeFor(net, await traderFor(net));
    await tick(runtime);
    assert.equal(net.rpc.applied.filter((s) => s.fn === "publish_trace").length, 1);
  });
});

test("a failed trace publication leaves the trace journaled as pending", async () => {
  const plan = FaultPlan.script([{ method: "simulateTransaction", fn: "publish_trace", times: Infinity, fault: { kind: "http", status: 503 } }]);
  await withNet(plan, async (net) => {
    const { runtime, state } = runtimeFor(net, await traderFor(net));
    const err = await tick(runtime);
    assert.ok(err, "the tick reports the failed publication");
    assert.equal(buys(net).length, 1);
    const pending = state.entries<PendingTrace>(TRACES).filter(([, t]) => t.status === "pending");
    assert.equal(pending.length, 1);
    assert.deepEqual(tracelessTrades(net, state), []);
  });
});

test("a journaled pending trace blocks new trades until it is published", async () => {
  const plan = FaultPlan.script([{ method: "simulateTransaction", fn: "publish_trace", times: 3, fault: { kind: "http", status: 503 } }]);
  await withNet(plan, async (net) => {
    const { runtime, state } = runtimeFor(net, await traderFor(net));
    for (let i = 0; i < 3; i++) await tick(runtime);
    // Ticks 2 and 3 retried the trace first and stopped; they did not trade again.
    assert.equal(buys(net).length, 1);
    assert.deepEqual(tracelessTrades(net, state), []);
  });
});

test("rejected submissions (txBAD_SEQ) trade nothing and journal only an intent", async () => {
  const plan = FaultPlan.script([{ method: "sendTransaction", fn: "agent_buy_v2", fault: { kind: "tx-error", code: "txBAD_SEQ" } }]);
  await withNet(plan, async (net) => {
    const { runtime, state } = runtimeFor(net, await traderFor(net));
    assert.ok(await tick(runtime));
    assert.equal(buys(net).length, 0);
    assert.deepEqual(tradeJournal(state).map((t) => t.status), ["intent"]);
  });
});

test("repeated fee-burning failures open the circuit and halt the agent", async () => {
  // Simulation passes and every application fails, so each included buy
  // costs a fee, and the registry is unreachable. The agent must stop rather
  // than keep paying.
  const plan = FaultPlan.script([
    { method: "sendTransaction", fn: "agent_buy_v2", times: Infinity, fault: { kind: "apply-failure", error: "SlippageExceeded" } },
    { method: "simulateTransaction", fn: "publish_trace", times: Infinity, fault: { kind: "http", status: 503 } },
  ]);
  await withNet(plan, async (net) => {
    const { runtime, log } = runtimeFor(net, await traderFor(net), { maxConsecutiveFailures: 3 });
    await runtime.start();
    assert.equal(runtime.exitCode, 1);
    assert.ok(log.lines.some((l) => l.event === "CIRCUIT_OPEN"));
    const spent = net.rpc.submissions.length;
    assert.ok(spent <= 3, `at most one fee-charged submission per failed tick before halting, got ${spent}`);
  });
});

test("a submission rejected every time halts the agent without spending fees", async () => {
  const plan = FaultPlan.script([{ method: "sendTransaction", times: Infinity, fault: { kind: "try-again-later" } }]);
  await withNet(plan, async (net) => {
    const { runtime } = runtimeFor(net, await traderFor(net), { maxConsecutiveFailures: 4 });
    await runtime.start();
    assert.equal(runtime.exitCode, 1);
    assert.equal(net.rpc.submissions.length, 0);
    assert.equal(net.rpc.requests.filter((r) => r.method === "sendTransaction").length, 4);
  });
});

test(
  "a trade whose response is lost is not repeated on the next tick",
  { todo: `trader must reconcile an "intent" before trading again: ${LIFECYCLE_ISSUE}` },
  async () => {
    const plan = FaultPlan.script([{ method: "sendTransaction", fn: "agent_buy_v2", fault: { kind: "reset-after-accept" } }]);
    await withNet(plan, async (net) => {
      const { runtime, state } = runtimeFor(net, await traderFor(net));
      await tick(runtime);
      await tick(runtime);
      assert.equal(buys(net).length, 1);
      assert.deepEqual(tracelessTrades(net, state), []);
    });
  },
);

test("the maker creates the market once and journals it", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const { runtime, state } = runtimeFor(net, await makerFor(net));
    await tick(runtime);
    await tick(runtime);
    assert.equal(net.rpc.applied.filter((s) => s.fn === "agent_create_market").length, 1);
    assert.equal(state.entries<{ status: string }>(SIGNALS)[0]?.[1].status, "created");
    const pending = state.entries<PendingTrace>(TRACES);
    assert.ok(pending.length === 1 && (pending[0][1].status === "pending" || pending[0][1].status === "published"));
  });
});

test("a create whose response is lost is never retried blindly", async () => {
  const plan = FaultPlan.script([{ method: "sendTransaction", fn: "agent_create_market", fault: { kind: "reset-after-accept" } }]);
  await withNet(plan, async (net) => {
    const { runtime, state } = runtimeFor(net, await makerFor(net));
    assert.ok(await tick(runtime));
    await tick(runtime);
    await tick(runtime);
    assert.equal(net.rpc.applied.filter((s) => s.fn === "agent_create_market").length, 1);
    assert.equal(state.entries<{ status: string }>(SIGNALS)[0]?.[1].status, "intent");
  });
});

test(
  "an ambiguous create is reconciled and its trace published",
  { todo: `the maker leaves an ambiguous create as "intent" for an operator: ${LIFECYCLE_ISSUE}` },
  async () => {
    const plan = FaultPlan.script([{ method: "sendTransaction", fn: "agent_create_market", fault: { kind: "reset-after-accept" } }]);
    await withNet(plan, async (net) => {
      const { runtime, state } = runtimeFor(net, await makerFor(net));
      await tick(runtime);
      await tick(runtime);
      assert.equal(state.entries<{ status: string }>(SIGNALS)[0]?.[1].status, "created");
    });
  },
);

test("trade events are served as decodable XDR through getEvents", async () => {
  await withNet(FaultPlan.none(), async (net) => {
    const { runtime } = runtimeFor(net, await traderFor(net));
    await tick(runtime);
    const server = new rpc.Server(net.url, { allowHttp: true });
    const res = await server.getEvents({ startLedger: 1, filters: [{ type: "contract", contractIds: [net.deployments.contracts.treasury] }] });
    assert.equal(res.events.length, 1);
    const ev = res.events[0];
    assert.equal(ev.topic[0].sym().toString(), "trade");
    assert.equal((eventValue(ev.value.toXDR("base64")) as { market_id: bigint }).market_id, net.market.id);
  });
});

test("the guard refuses any non-loopback request", async () => {
  await assert.rejects(fetch("https://soroban-testnet.stellar.org"), /must not reach the real network/);
});

// ─── Seeded chaos ────────────────────────────────────────────────────────────

async function chaosRun(seed: bigint) {
  const plan = FaultPlan.chaos(seed, { rate: 0.3 });
  return withNet(plan, async (net) => {
    const { runtime, state } = runtimeFor(net, await traderFor(net), { maxConsecutiveFailures: 100 });
    for (let i = 0; i < 6; i++) await tick(runtime);
    return {
      faults: plan.history.map((f) => `${f.seq}:${f.method}:${f.fn ?? ""}:${f.fault.kind}`),
      submissions: net.rpc.submissions.map((s) => `${s.fn}:${s.status}`),
      intents: tradeJournal(state).filter((t) => t.status === "intent").length,
      traceless: tracelessTrades(net, state),
      buys: buys(net).length,
    };
  });
}

test("a chaos seed reproduces the same faults and the same outcome", async () => {
  const [a, b] = [await chaosRun(7n), await chaosRun(7n)];
  assert.deepEqual(a, b);
  assert.ok(a.faults.length > 0, "the seed injected faults");
  const c = await chaosRun(8n);
  assert.notDeepEqual(c.faults, a.faults);
});

for (const seed of [1n, 2n, 3n, 7n, 9n]) {
  test(`chaos seed ${seed}: no trade is left without a trace unless its outcome was ambiguous`, async () => {
    const r = await chaosRun(seed);
    // Each traceless trade must be explained by an ambiguous "intent" left
    // in the journal (a lost response); anything else is an agent bug.
    assert.ok(r.traceless.length <= r.intents, `${r.traceless.join("; ")} with ${r.intents} ambiguous intents`);
  });
}

