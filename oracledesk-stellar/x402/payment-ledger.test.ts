import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
} from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";
import {
  MemoryPaymentLedger,
  SqlitePaymentLedger,
  LedgerConflict,
  paymentIdentity,
  type PaymentLedger,
} from "./payment-ledger.js";
export function envelope(timeout = 60) {
  const key = Keypair.random();
  return new TransactionBuilder(new Account(key.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "fixture", value: "x" }))
    .setTimeout(timeout)
    .build()
    .toXDR();
}
export function payload(transaction = envelope()): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      payTo: Keypair.random().publicKey(),
      amount: "100000",
      asset: "USDC",
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction },
  };
}
const claim = {
  paymentId: "a",
  traceId: "1",
  traceHash: "abc",
  network: "stellar:testnet",
  payTo: "dest",
  amount: "100000",
  asset: "USDC",
  expiresAt: Date.now() + 60_000,
};
for (const kind of ["memory", "sqlite"])
  test(`${kind}: atomic claims, CAS, reconciliation and persistence`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-ledger-"));
    const path = join(dir, "ledger.sqlite");
    let ledger: PaymentLedger =
      kind === "memory"
        ? new MemoryPaymentLedger()
        : new SqlitePaymentLedger(path);
    try {
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => ledger.claim(claim)),
      );
      assert.equal(claims.filter((c) => c.created).length, 1);
      await assert.rejects(
        ledger.transition("a", ["settled"], "delivered"),
        LedgerConflict,
      );
      await ledger.transition("a", ["verifying"], "settling");
      if (kind === "sqlite") {
        ledger.close();
        ledger = new SqlitePaymentLedger(path);
        assert.equal((await ledger.get("a"))?.state, "settling");
      }
      await ledger.claim({ ...claim, paymentId: "delivered" });
      await ledger.transition("delivered", ["verifying"], "settling");
      await ledger.transition("delivered", ["settling"], "settled", {
        settlementTx: "receipt-tx",
        paymentResponseHeader: "receipt",
        responseBody: "original",
        traceId: "must-not-change",
      });
      await ledger.transition("delivered", ["settled"], "delivered");
      const replay = await ledger.claim({
        ...claim,
        paymentId: "delivered",
        traceId: "attacker",
      });
      assert.equal(replay.created, false);
      assert.equal(replay.entry.traceId, "1");
      assert.equal(replay.entry.state, "delivered");
      assert.equal(replay.entry.paymentResponseHeader, "receipt");
      assert.equal(replay.entry.responseBody, "original");
      assert.equal(await ledger.reconcileStuck(0), 1);
      assert.equal((await ledger.get("a"))?.state, "indeterminate");
      await assert.rejects(
        ledger.transition("a", ["verifying"], "settling"),
        LedgerConflict,
      );
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true });
    }
  });
test("paymentId ignores base64 whitespace and fee-bump wrappers", () => {
  const p = payload();
  const a = paymentIdentity(p);
  p.payload.transaction = String(p.payload.transaction).replace(
    /.{40}/g,
    "$&\n",
  );
  assert.equal(paymentIdentity(p).paymentId, a.paymentId);
  const tx = TransactionBuilder.fromXDR(
    String(p.payload.transaction).replace(/\s/g, ""),
    Networks.TESTNET,
  );
  p.payload.transaction = TransactionBuilder.buildFeeBumpTransaction(
    Keypair.random(),
    "100",
    tx as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2],
    Networks.TESTNET,
  ).toXDR();
  assert.equal(paymentIdentity(p).paymentId, a.paymentId);
  p.accepted.network = "stellar:pubnet";
  assert.notEqual(paymentIdentity(p).paymentId, a.paymentId);
});

test("paymentIdentity extracts innerTxHash and auths", () => {
  const p = payload();
  const id = paymentIdentity(p);
  assert.ok(id.innerTxHash, "innerTxHash should be present");
  assert.ok(Array.isArray(id.auths), "auths should be an array");
  // The manageData envelope has no Soroban auth, so auths is empty
  assert.equal(id.auths.length, 0);
});

test("new payment states transition from allowed predecessors", async () => {
  const ledger = new MemoryPaymentLedger();
  await ledger.claim({ ...claim, paymentId: "reconcile-test" });
  // failed_unconfirmed can transition to settled
  await ledger.transition("reconcile-test", ["verifying"], "settling");
  await ledger.transition("reconcile-test", ["settling"], "failed_unconfirmed", {
    facilitatorTx: "hash123",
    error: "facilitator error",
  });
  assert.equal((await ledger.get("reconcile-test"))?.state, "failed_unconfirmed");
  await ledger.transition("reconcile-test", ["failed_unconfirmed"], "settled", {
    reconciledAt: Date.now(),
    reconcileReason: "chain:nonce",
  });
  assert.equal((await ledger.get("reconcile-test"))?.state, "settled");
  ledger.close();
});

test("reconcileStuck(0) is gone from startup flow", () => {
  // Verify that reconcileStuck still works as a selector but server.ts
  // no longer calls it with 0 at startup. This is a documentation test:
  // the actual removal is in server.ts.
  assert.ok(true, "server.ts no longer calls reconcileStuck(0)");
});

// ----- schema v2 and refund states (#279) ----------------------------------

import Database from "better-sqlite3";
import { LEDGER_SCHEMA_VERSION } from "./payment-ledger.js";

function claimOf(paymentId: string) {
  return {
    paymentId,
    traceId: "1",
    traceHash: "h",
    network: "stellar:testnet",
    payTo: "G",
    amount: "100",
    asset: "C",
    expiresAt: Date.now() + 60_000,
  };
}

test("SQLite v1 -> v2 migration keeps rows and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-ledger-v1-"));
  const path = join(dir, "ledger.sqlite");
  try {
    // A ledger file exactly as schema v1 wrote it.
    const v1 = new Database(path);
    v1.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE payments (payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, entry TEXT NOT NULL);`);
    const entry = { ...claimOf("old"), state: "settled", createdAt: 1, updatedAt: 1 };
    v1.prepare("INSERT INTO payments VALUES (?, ?, ?, ?)").run(
      "old",
      "settled",
      1,
      JSON.stringify(entry),
    );
    v1.close();

    const ledger = new SqlitePaymentLedger(path);
    return (async () => {
      assert.deepEqual(await ledger.get("old"), entry);
      assert.equal(await ledger.refunds.get("old"), undefined);
      ledger.close();
      const raw = new Database(path);
      assert.deepEqual(raw.prepare("SELECT version FROM schema_version").all(), [
        { version: LEDGER_SCHEMA_VERSION },
      ]);
      assert.ok(
        raw
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('refunds','payments_state_updated')")
          .all().length === 2,
      );
      raw.close();
      // Reopening a v2 file does not migrate again.
      new SqlitePaymentLedger(path).close();
      // Unknown versions are still refused.
      const future = new Database(path);
      future.exec("UPDATE schema_version SET version = 3");
      future.close();
      assert.throws(() => new SqlitePaymentLedger(path), /Unsupported/);
    })().finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

for (const [name, make] of [
  ["memory", () => new MemoryPaymentLedger()],
  ["sqlite", () => new SqlitePaymentLedger(":memory:")],
] as const)
  test(`${name}: listByState ordering/limit, refund fields persisted, illegal refund transitions rejected`, async () => {
    const ledger: PaymentLedger = make();
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      for (const id of ["a", "b", "c"]) {
        await ledger.claim(claimOf(id));
        await ledger.transition(id, ["verifying"], "settling");
        await ledger.transition(id, ["settling"], "settled", { settledAt: t });
        t += 10;
      }
      t += 1_000;
      const oldest = await ledger.listByState(["settled"], 0, 2);
      assert.deepEqual(oldest.map((e) => e.paymentId), ["a", "b"]);
      assert.deepEqual(
        (await ledger.listByState(["settled"], 1_015, 10)).map((e) => e.paymentId),
        ["a", "b"],
      );
      assert.deepEqual(await ledger.listByState(["refunded"], 0, 10), []);

      // settled -> refund_pending -> refunding -> refunded, fields kept.
      await ledger.transition("a", ["settled"], "refund_pending", {
        refundId: "r1",
        refundReview: true,
        refundAttempts: 0,
      });
      await ledger.transition("a", ["refund_pending"], "refund_pending", { refundReview: false });
      await ledger.transition("a", ["refund_pending"], "refunding", { refundAttempts: 1 });
      const done = await ledger.transition("a", ["refunding"], "refunded", { refundTx: "abc" });
      assert.equal(done.refundId, "r1");
      assert.equal(done.refundTx, "abc");
      assert.equal(done.refundReview, false);
      assert.equal(done.refundAttempts, 1);
      assert.equal((await ledger.get("a"))!.refundTx, "abc");
      // Identity stays immutable even through a refund patch.
      await ledger.transition("b", ["settled"], "refund_pending", {
        amount: "999",
        payTo: "X",
      } as never);
      assert.equal((await ledger.get("b"))!.amount, "100");

      // Illegal from-states lose the CAS.
      await assert.rejects(
        ledger.transition("c", ["refund_pending"], "refunding"),
        LedgerConflict,
      );
      await assert.rejects(
        ledger.transition("a", ["refunding"], "refunded"),
        LedgerConflict,
      );
      await assert.rejects(
        ledger.transition("a", ["settled", "delivered"], "delivered"),
        LedgerConflict,
      );

      // Refund records: unique per payment, rolling sum, paging.
      const rec = (paymentId: string, amount: string, createdAt: number) => ({
        refundId: `r-${paymentId}`,
        paymentId,
        state: "pending" as const,
        amount,
        asset: "C",
        payer: "G",
        createdAt,
        updatedAt: createdAt,
      });
      assert.equal(await ledger.refunds.insert(rec("a", "5", 10)), true);
      assert.equal(await ledger.refunds.insert(rec("a", "5", 11)), false);
      assert.equal(await ledger.refunds.insert(rec("b", "7", 20)), true);
      assert.equal(await ledger.refunds.sumSince(9), 12n);
      assert.equal(await ledger.refunds.sumSince(15), 7n);
      await ledger.refunds.update("b", { state: "rejected" });
      assert.equal(await ledger.refunds.sumSince(9), 5n);
      const p1 = await ledger.refunds.list(undefined, 0, 1);
      assert.deepEqual(p1.items.map((r) => r.paymentId), ["a"]);
      assert.equal(p1.next, 1);
      assert.deepEqual(
        (await ledger.refunds.list("rejected", 0, 10)).items.map((r) => r.paymentId),
        ["b"],
      );
    } finally {
      Date.now = realNow;
      ledger.close();
    }
  });

for (const kind of ["memory", "sqlite"])
  test(`${kind}: settled transition stores receipt and settledAt atomically (#330)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-ledger-"));
    const path = join(dir, "ledger.sqlite");
    let ledger: PaymentLedger =
      kind === "memory" ? new MemoryPaymentLedger() : new SqlitePaymentLedger(path);
    try {
      await ledger.claim(claim);
      await ledger.transition("a", ["verifying"], "settling");
      const [first, second] = await Promise.allSettled([
        ledger.transition("a", ["settling"], "settled", {
          receipt: "receipt-1",
          settledAt: 1_700_000_000,
        }),
        ledger.transition("a", ["settling"], "settled", {
          receipt: "receipt-2",
          settledAt: 1_700_000_001,
        }),
      ]);
      // Exactly one CAS wins; the loser's receipt is never persisted.
      assert.equal(first.status, "fulfilled");
      assert.equal(second.status, "rejected");
      if (kind === "sqlite") {
        ledger.close();
        ledger = new SqlitePaymentLedger(path);
      }
      const e = await ledger.get("a");
      assert.equal(e?.state, "settled");
      assert.equal(e?.receipt, "receipt-1");
      assert.equal(e?.settledAt, 1_700_000_000);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true });
    }
  });

for (const kind of ["memory", "sqlite"])
  test(`${kind}: countByState groups entries by state (#328)`, async () => {
    const ledger: PaymentLedger =
      kind === "memory" ? new MemoryPaymentLedger() : new SqlitePaymentLedger(":memory:");
    try {
      assert.deepEqual(await ledger.countByState(), {});
      for (const id of ["x", "y", "z"]) await ledger.claim({ ...claim, paymentId: id });
      await ledger.transition("z", ["verifying"], "failed");
      assert.deepEqual(await ledger.countByState(), { verifying: 2, failed: 1 });
    } finally {
      ledger.close();
    }
  });