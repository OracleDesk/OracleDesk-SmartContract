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
