import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotSubmittedError } from "../stellar/adapter.js";
import { createMarketWithSpec } from "./maker-flow.js";
import type { SpecJson } from "./spec.js";
import {
  FileSpecStore,
  MemorySpecStore,
  newStoredSpec,
  recoverSpecs,
  type ChainMarketView,
  type RecoveryChain,
  type SpecStore,
  type StoredSpec,
} from "./spec-store.js";

const G1 = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
const TREASURY = "CCILJXZCHKAIBTMJ7NSQE756OGLKTOYNSWNNZXWAYZZA4ECAUEC2CNVF";
const SPEC: SpecJson = { mode: "signers", signers: [G1], threshold: 1, disputeWindow: "5" };
const COMMIT = "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4";
const Q1 = "11".repeat(32);
const Q2 = "22".repeat(32);
const NOW = 1_800_000_000_000;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "spec-store-"));
}

/** In-memory chain: markets by id, set of revealed ids, reveal call log. */
class FakeChain implements RecoveryChain {
  markets: ChainMarketView[] = [];
  revealed = new Set<bigint>();
  reveals: bigint[] = [];
  revealError?: Error;

  addMarket(m: Partial<ChainMarketView> = {}): bigint {
    this.markets.push({
      creator: TREASURY,
      questionHash: Q1,
      resolutionHash: COMMIT,
      closeTime: BigInt(NOW / 1000 + 3600),
      ...m,
    });
    return BigInt(this.markets.length - 1);
  }
  async marketCount() {
    return BigInt(this.markets.length);
  }
  async getMarket(id: bigint) {
    return this.markets[Number(id)];
  }
  async isRevealed(id: bigint) {
    return this.revealed.has(id);
  }
  async reveal(id: bigint) {
    this.reveals.push(id);
    if (this.revealError) throw this.revealError;
    this.revealed.add(id);
  }
}

const fixedHasher = { hash: async () => COMMIT };

function recovery(store: SpecStore, chain: RecoveryChain, now = NOW) {
  return recoverSpecs({ store, chain, creator: TREASURY, pendingTtlSecs: 900, now: () => now, log: () => {} });
}

test("store put/list/byCommitment round-trips and overwrites by id", async () => {
  const dir = await tempDir();
  try {
    const store = new FileSpecStore(dir);
    const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
    await store.put(entry);
    await store.put({ ...entry, state: "created", marketId: "7" });
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.state, "created");
    assert.deepEqual((await store.byCommitment(COMMIT))?.spec, SPEC);
    assert.deepEqual(await store.list("pending_create"), []);
    assert.equal(await new FileSpecStore(join(dir, "missing")).byCommitment(COMMIT), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store put is atomic: crash between temp write and rename leaves no partial file", async () => {
  const dir = await tempDir();
  try {
    const crashing = new FileSpecStore(dir, {
      rename: async () => {
        throw new Error("simulated crash before rename");
      },
    });
    const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
    await assert.rejects(crashing.put(entry), /simulated crash/);
    assert.deepEqual(await readdir(dir), []);

    // A torn temp file from a hard crash is never read as a spec.
    await writeFile(join(dir, `${COMMIT}.${entry.id}.json.123.abcd.tmp`), '{"commitment":"b9');
    const store = new FileSpecStore(dir);
    assert.deepEqual(await store.list(), []);
    await store.put(entry);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no create is submitted if spec store put fails", async () => {
  let creates = 0;
  const failing: SpecStore = {
    put: async () => {
      throw new Error("disk full");
    },
    byCommitment: async () => undefined,
    list: async () => [],
  };
  await assert.rejects(
    createMarketWithSpec({
      spec: SPEC,
      questionHash: Buffer.from(Q1, "hex"),
      closeTime: BigInt(NOW / 1000 + 3600),
      store: failing,
      hasher: fixedHasher,
      chain: new FakeChain(),
      create: async () => {
        creates++;
        return { dryRun: false, value: 0n };
      },
      now: () => NOW,
    }),
    /disk full/,
  );
  assert.equal(creates, 0);
});

test("create is submitted only after the pending_create entry is durable, then revealed", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  const result = await createMarketWithSpec({
    spec: SPEC,
    questionHash: Buffer.from(Q1, "hex"),
    closeTime: BigInt(NOW / 1000 + 3600),
    store,
    hasher: fixedHasher,
    chain,
    create: async (resolutionHash) => {
      assert.equal(resolutionHash.toString("hex"), COMMIT);
      const stored = await store.list("pending_create");
      assert.equal(stored.length, 1, "spec must be stored before create");
      assert.deepEqual(stored[0]!.spec, SPEC);
      return { dryRun: false, value: chain.addMarket() };
    },
    now: () => NOW,
  });
  assert.equal(result.revealed, true);
  assert.deepEqual(chain.reveals, [0n]);
  assert.equal((await store.list("revealed")).length, 1);
});

test("a pre-submit rejection (treasury cap) abandons the entry immediately", async () => {
  const store = new MemorySpecStore();
  await assert.rejects(
    createMarketWithSpec({
      spec: SPEC,
      questionHash: Buffer.from(Q1, "hex"),
      closeTime: BigInt(NOW / 1000 + 3600),
      store,
      hasher: fixedHasher,
      chain: new FakeChain(),
      create: async () => {
        throw new NotSubmittedError("agent_create_market simulation failed: TradeCapExceeded");
      },
      now: () => NOW,
    }),
    NotSubmittedError,
  );
  const [entry] = await store.list();
  assert.equal(entry!.state, "abandoned");
  assert.match(entry!.lastError!, /TradeCapExceeded/);
});

test("recovery reveals a created-but-unrevealed market", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  const id = chain.addMarket();
  const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  await store.put({ ...entry, state: "created", marketId: id.toString() });

  const report = await recovery(store, chain);
  assert.deepEqual(report.revealed, [entry.id]);
  assert.deepEqual(chain.reveals, [id]);
  assert.equal((await store.list("revealed")).length, 1);

  // Idempotent: a second pass has nothing to do.
  const again = await recovery(store, chain);
  assert.deepEqual(again.revealed, []);
  assert.deepEqual(chain.reveals, [id]);
});

test("recovery keeps a created entry when the reveal fails, and retries later", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  const id = chain.addMarket();
  const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  await store.put({ ...entry, state: "created", marketId: id.toString() });
  chain.revealError = new Error("rpc timeout");

  const report = await recovery(store, chain);
  assert.deepEqual(report.failed, [entry.id]);
  const [kept] = await store.list("created");
  assert.equal(kept!.lastError, "rpc timeout");

  chain.revealError = undefined;
  assert.deepEqual((await recovery(store, chain)).revealed, [entry.id]);
});

test("recovery finds market id for pending_create by scanning resolution_hash", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  chain.addMarket({ resolutionHash: "00".repeat(32) }); // unrelated
  const target = chain.addMarket();
  chain.addMarket({ creator: G1 }); // same commitment, wrong creator
  const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  await store.put(entry);

  const report = await recovery(store, chain, NOW + 5_000);
  assert.deepEqual(report.revealed, [entry.id]);
  const [revealed] = await store.list("revealed");
  assert.equal(revealed!.marketId, target.toString());
  assert.deepEqual(chain.reveals, [target]);
});

test("recovery maps two pending entries with the same commitment to distinct markets", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  const m1 = chain.addMarket({ questionHash: Q1 });
  const m2 = chain.addMarket({ questionHash: Q2 });
  const e1 = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  const e2 = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q2, now: NOW + 1 });
  await store.put(e1);
  await store.put(e2);

  await recovery(store, chain, NOW + 5_000);
  const byId = new Map((await store.list("revealed")).map((s: StoredSpec) => [s.id, s.marketId]));
  assert.equal(byId.get(e1.id), m1.toString());
  assert.equal(byId.get(e2.id), m2.toString());
});

test("recovery abandons pending_create after TTL when no market matches", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  chain.addMarket({ resolutionHash: "00".repeat(32) });
  const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  await store.put(entry);

  // Within the TTL the create may still be in flight: leave it alone.
  const early = await recovery(store, chain, NOW + 60_000);
  assert.deepEqual(early.stillPending, [entry.id]);

  const late = await recovery(store, chain, NOW + 901_000);
  assert.deepEqual(late.abandoned, [entry.id]);
  const [abandoned] = await store.list();
  assert.equal(abandoned!.state, "abandoned", "file is kept, marked abandoned");
  assert.deepEqual(chain.reveals, []);

  // Terminal: never revisited.
  const after = await recovery(store, chain, NOW + 2_000_000);
  assert.deepEqual(after, { revealed: [], abandoned: [], stillPending: [], failed: [] });
});

test("MarketAlreadyConfigured on reveal is treated as success", async () => {
  const store = new MemorySpecStore();
  const chain = new FakeChain();
  const id = chain.addMarket();
  chain.revealError = new Error("register_signer_spec failed: MarketAlreadyConfigured");
  const entry = newStoredSpec({ commitment: COMMIT, spec: SPEC, questionHash: Q1, now: NOW });
  await store.put({ ...entry, state: "created", marketId: id.toString() });

  const report = await recovery(store, chain);
  assert.deepEqual(report.revealed, [entry.id]);
  assert.equal((await store.list("revealed")).length, 1);

  // But only when the market really commits to our spec.
  const other = new FakeChain();
  const wrong = other.addMarket({ resolutionHash: "00".repeat(32) });
  other.revealError = chain.revealError;
  const store2 = new MemorySpecStore();
  await store2.put({ ...entry, state: "created", marketId: wrong.toString() });
  assert.deepEqual((await recovery(store2, other)).failed, [entry.id]);
});
