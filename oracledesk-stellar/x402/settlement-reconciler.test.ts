import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideReconciliation,
  X402_RECONCILE_MARGIN_LEDGERS,
  type ChainReader,
} from "./settlement-reconciler.js";
import type { PaymentEntry } from "./payment-ledger.js";

function makeEntry(overrides: Partial<PaymentEntry> = {}): PaymentEntry {
  return {
    paymentId: "test-1",
    traceId: "1",
    traceHash: "abc",
    network: "stellar:testnet",
    payTo: "GDEST",
    amount: "100000",
    asset: "USDC",
    state: "indeterminate",
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxLedger: 1000,
    auths: [{ address: "GABC", nonce: "42", expirationLedger: 1000 }],
    ...overrides,
  };
}

test("nonce consumed → settled", () => {
  const entry = makeEntry();
  const d = decideReconciliation(entry, 990, [true], undefined, undefined);
  assert.equal(d.outcome, "settled");
  assert.equal(d.reason, "chain:nonce");
});

test("facilitator tx SUCCESS → settled", () => {
  const entry = makeEntry();
  const d = decideReconciliation(entry, 990, [false], "SUCCESS", undefined);
  assert.equal(d.outcome, "settled");
  assert.equal(d.reason, "chain:tx");
});

test("not consumed before expiry → still_pending", () => {
  const entry = makeEntry({ maxLedger: 1000 });
  const d = decideReconciliation(entry, 500, [false], undefined, undefined);
  assert.equal(d.outcome, "still_pending");
});

test("not consumed after expiry + margin → failed_final", () => {
  const entry = makeEntry({ maxLedger: 1000 });
  const d = decideReconciliation(
    entry,
    1000 + X402_RECONCILE_MARGIN_LEDGERS + 1,
    [false],
    undefined,
    undefined,
  );
  assert.equal(d.outcome, "failed_final");
  assert.equal(d.reason, "chain:expired_unconsumed");
});

test("unknown nonce with facilitator tx NOT_FOUND and no transfer events → needs_operator", () => {
  const entry = makeEntry();
  const d = decideReconciliation(
    entry,
    1011,
    ["unknown"],
    "NOT_FOUND",
    [],
  );
  assert.equal(d.outcome, "needs_operator");
  assert.equal(d.reason, "chain:retention_gap");
});

test("unknown nonce with matching transfer event → settled", () => {
  const entry = makeEntry({ amount: "100000" });
  const d = decideReconciliation(
    entry,
    1011,
    ["unknown"],
    "NOT_FOUND",
    [{ amount: 100000n, txHash: "tx1" }],
  );
  assert.equal(d.outcome, "settled");
  assert.equal(d.reason, "chain:tx");
});

test("all nonces consumed → settled (multi-credential)", () => {
  const entry = makeEntry({
    auths: [
      { address: "GA", nonce: "1", expirationLedger: 1000 },
      { address: "GB", nonce: "2", expirationLedger: 1000 },
    ],
  });
  const d = decideReconciliation(entry, 990, [true, true], undefined, undefined);
  assert.equal(d.outcome, "settled");
  assert.equal(d.reason, "chain:nonce");
});

test("one nonce consumed out of multiple → settled", () => {
  const entry = makeEntry({
    auths: [
      { address: "GA", nonce: "1", expirationLedger: 1000 },
      { address: "GB", nonce: "2", expirationLedger: 1000 },
    ],
  });
  const d = decideReconciliation(entry, 990, [true, false], undefined, undefined);
  assert.equal(d.outcome, "settled");
  assert.equal(d.reason, "chain:nonce");
});
