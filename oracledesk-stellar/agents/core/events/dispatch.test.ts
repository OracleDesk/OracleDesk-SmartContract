import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OracleDeskEvent } from "./decode.js";
import { Dispatcher, ProcessedLru } from "./dispatch.js";
import { FakeEventsRpc, testDecoder, trade } from "./testing.js";

async function events(specs: [bigint, number][]): Promise<OracleDeskEvent[]> {
  const rpc = await FakeEventsRpc.create();
  specs.forEach(([market, ledger]) => rpc.emit(trade(market, BigInt(ledger), ledger)));
  const page = await rpc.getEvents({ filters: [{ type: "contract" }], startLedger: 1, limit: 1_000 } as never);
  const d = await testDecoder();
  return page.events.map((e) => d.decode(e)!);
}

const noSleep = async () => undefined;

test("events of one market run in order while different markets run concurrently", async () => {
  // Interleaved: market 0..3, five events each.
  const batch = await events(Array.from({ length: 20 }, (_, i) => [BigInt(i % 4), 10 + i] as [bigint, number]));
  const order = new Map<string, bigint[]>();
  let running = 0;
  let peak = 0;
  const dispatcher = new Dispatcher({
    concurrency: 3,
    sleep: noSleep,
    handlers: [
      {
        name: "slow",
        kinds: ["Trade"],
        async handle(e) {
          if (e.kind !== "Trade") return;
          running++;
          peak = Math.max(peak, running);
          // Deterministic, uneven delays so lanes finish out of step.
          await new Promise((r) => setTimeout(r, Number((e.collateral * 7n) % 5n)));
          order.set(String(e.marketId), [...(order.get(String(e.marketId)) ?? []), e.collateral]);
          running--;
        },
      },
    ],
  });
  await dispatcher.dispatch(batch);
  for (const [market, seen] of order) {
    assert.deepEqual(seen, [...seen].sort((a, b) => Number(a - b)), `market ${market} out of order`);
    assert.equal(seen.length, 5);
  }
  assert.equal(peak, 3, "three markets in flight at once, never more");
});

test("a processed event is not delivered twice", async () => {
  const [e] = await events([[1n, 10]]);
  const calls: string[] = [];
  const lru = new ProcessedLru(2);
  const dispatcher = new Dispatcher({ lru, sleep: noSleep, handlers: [{ name: "h", kinds: ["Trade"], handle: async (x) => void calls.push(x.id) }] });
  await dispatcher.dispatch([e]);
  await dispatcher.dispatch([e]);
  assert.deepEqual(calls, [e.id]);
  lru.add("a");
  lru.add("b");
  assert.equal(lru.has(e.id), false, "the LRU forgets the oldest id at capacity");
});

test("a transient handler failure is retried with backoff", async () => {
  const [e] = await events([[1n, 10]]);
  const waits: number[] = [];
  let attempts = 0;
  const dispatcher = new Dispatcher({
    maxAttempts: 4,
    backoffBaseMs: 100,
    sleep: async (ms) => void waits.push(ms),
    deadLetterPath: join(mkdtempSync(join(tmpdir(), "dl-")), "dead-letter.jsonl"),
    handlers: [{ name: "flaky", kinds: ["Trade"], handle: async () => { if (++attempts < 3) throw new Error("rpc down"); } }],
  });
  await dispatcher.dispatch([e]);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("after retries are exhausted the event is dead-lettered and the batch still completes", async () => {
  const batch = await events([[1n, 10], [2n, 11]]);
  const path = join(mkdtempSync(join(tmpdir(), "dl-")), "nested", "dead-letter.jsonl");
  const handled: bigint[] = [];
  const dispatcher = new Dispatcher({
    maxAttempts: 3,
    sleep: noSleep,
    deadLetterPath: path,
    handlers: [
      {
        name: "poisoned",
        kinds: ["Trade"],
        async handle(e) {
          if (e.kind === "Trade" && e.marketId === 1n) throw new Error("cannot handle market 1");
          if (e.kind === "Trade") handled.push(e.marketId);
        },
      },
    ],
  });
  await dispatcher.dispatch(batch);
  assert.deepEqual(handled, [2n]);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].handler, "poisoned");
  assert.equal(lines[0].attempts, 3);
  assert.equal(lines[0].event.marketId, "1");
  assert.match(lines[0].error, /cannot handle market 1/);
  assert.ok(dispatcher.lru.has(batch[0].id), "a dead-lettered event is not redelivered forever");
});

test("handlers only see the kinds they subscribe to", async () => {
  const [e] = await events([[1n, 10]]);
  let called = false;
  await new Dispatcher({ handlers: [{ name: "final", kinds: ["MarketResolved"], handle: async () => void (called = true) }] }).dispatch([e]);
  assert.equal(called, false);
});
