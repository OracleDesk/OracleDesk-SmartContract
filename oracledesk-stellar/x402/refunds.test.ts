import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  MemoryPaymentLedger,
  type PaymentEntry,
  type PaymentLedger,
} from "./payment-ledger.js";
import {
  RefundExecutor,
  classify,
  sweepRefunds,
  approveRefund,
  type RefundPolicy,
  type RefundRpc,
} from "./refunds.js";

const ASSET = StrKey.encodeContract(Buffer.alloc(32, 7));
const refundKey = Keypair.random();
const policy: RefundPolicy = {
  redeliveryWindowMs: 900_000,
  autoApproveMax: 1_000_000n,
  windowCap: 5_000_000n,
  windowMs: 86_400_000,
  maxAttempts: 2,
};

/** Fake Soroban RPC: records every submission; outcomes are scripted. */
function stubRpc() {
  const sent: Transaction[] = [];
  const known = new Map<string, "SUCCESS" | "FAILED">();
  const s = {
    sent,
    known,
    simulateError: undefined as string | undefined,
    /** Outcome assigned to each sent transaction (default SUCCESS). */
    outcome: "SUCCESS" as "SUCCESS" | "FAILED" | "PENDING",
    seq: 100n,
    rpc: undefined as unknown as RefundRpc,
  };
  s.rpc = {
    async getAccount(address: string) {
      return new Account(address, (s.seq++).toString());
    },
    async simulateTransaction() {
      if (s.simulateError)
        return { id: "1", latestLedger: 1, events: [], _parsed: true, error: s.simulateError } as never;
      return {
        id: "1",
        latestLedger: 1,
        events: [],
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      } as never;
    },
    async sendTransaction(tx: Transaction) {
      sent.push(tx);
      if (s.outcome !== "PENDING") known.set(tx.hash().toString("hex"), s.outcome);
      return { status: "PENDING", hash: tx.hash().toString("hex"), latestLedger: 1, latestLedgerCloseTime: 0 } as never;
    },
    async getTransaction(hash: string) {
      const status = known.get(hash);
      return {
        status:
          status === "SUCCESS"
            ? rpc.Api.GetTransactionStatus.SUCCESS
            : status === "FAILED"
              ? rpc.Api.GetTransactionStatus.FAILED
              : rpc.Api.GetTransactionStatus.NOT_FOUND,
      } as never;
    },
  };
  return s;
}

async function settled(
  ledger: PaymentLedger,
  id: string,
  over: Partial<PaymentEntry> = {},
  settledAt = 0,
) {
  await ledger.claim({
    paymentId: id,
    traceId: "1",
    traceHash: "h",
    network: "stellar:testnet",
    payTo: Keypair.random().publicKey(),
    amount: over.amount ?? "500000",
    asset: ASSET,
    expiresAt: 60_000,
  });
  await ledger.transition(id, ["verifying"], "settling");
  return ledger.transition(id, ["settling"], "settled", {
    settlementTx: "settle-tx",
    payer: over.payer ?? Keypair.random().publicKey(),
    paymentResponseHeader: "receipt",
    settledAt,
  });
}

/** One clock for the ledger (`Date.now`) and the executor/sweeper. */
function setup(now: { t: number }, t?: { after(fn: () => void): void }) {
  const real = Date.now;
  Date.now = () => now.t;
  t?.after(() => {
    Date.now = real;
  });
  const ledger = new MemoryPaymentLedger();
  const stub = stubRpc();
  const logs: Record<string, unknown>[] = [];
  const executor = new RefundExecutor({
    ledger,
    policy,
    secret: refundKey.secret(),
    rpcFor: (network) => {
      assert.equal(network, "stellar:testnet", "RPC chosen from entry.network");
      return stub.rpc;
    },
    now: () => now.t,
    sleep: async () => {},
    log: (e) => logs.push(e),
  });
  const sweep = () =>
    sweepRefunds(ledger, executor, policy, { batch: 10, now: () => now.t, log: (e) => logs.push(e) });
  return { ledger, stub, executor, logs, sweep };
}

test("classify waits inside the redelivery window and ignores unrefundable entries", async (t) => {
  const ledger = new MemoryPaymentLedger();
  const e = await settled(ledger, "p", {}, 1_000);
  assert.equal(classify(e, 1_000 + 899_999, policy), "wait");
  assert.equal(classify(e, 1_000 + 900_000, policy), "auto_refund");
  assert.equal(classify({ ...e, state: "delivered" }, 10e9, policy), "ignore");
  assert.equal(classify({ ...e, payer: "test-payer" }, 10e9, policy), "ignore");
  assert.equal(classify({ ...e, settlementTx: undefined }, 10e9, policy), "ignore");
  assert.equal(classify({ ...e, amount: "1000001" }, 10e9, policy), "review");
});

test("undelivered settled payment past the window is auto-refunded with a signed SEP-41 transfer", async (t) => {
  const now = { t: Date.now() };
  const f = setup(now, t);
  await settled(f.ledger, "p", {}, now.t);
  // Inside the window: nothing happens.
  assert.equal(await f.sweep(), 0);
  now.t += policy.redeliveryWindowMs + 1;
  assert.equal(await f.sweep(), 1);
  const e = (await f.ledger.get("p"))!;
  assert.equal(e.state, "refunded");
  assert.equal(f.stub.sent.length, 1);
  const tx = f.stub.sent[0];
  assert.equal(e.refundTx, tx.hash().toString("hex"));
  assert.equal(tx.networkPassphrase, Networks.TESTNET);
  assert.equal(tx.source, refundKey.publicKey());
  assert.equal(tx.signatures.length, 1);
  const call = tx.operations[0] as { type: string; func: xdr.HostFunction };
  assert.equal(call.type, "invokeHostFunction");
  const invoke = call.func.invokeContract();
  assert.equal(invoke.functionName().toString(), "transfer");
  const rec = (await f.ledger.refunds.get("p"))!;
  assert.equal(rec.state, "succeeded");
  assert.equal(rec.txHash, e.refundTx);
  assert.ok(rec.txXdr, "signed XDR persisted");
});

test("amount above autoApproveMax goes to review and waits for an operator", async (t) => {
  const now = { t: 10_000_000 };
  const f = setup(now, t);
  await settled(f.ledger, "big", { amount: "2000000" }, 0);
  f.ledger["entries"].get("big")!.updatedAt = 0;
  await f.sweep();
  let e = (await f.ledger.get("big"))!;
  assert.equal(e.state, "refund_pending");
  assert.equal(e.refundReview, true);
  assert.equal((await f.ledger.refunds.get("big"))!.state, "review");
  await f.sweep();
  assert.equal(f.stub.sent.length, 0, "review blocks execution");
  await approveRefund(f.ledger, "big");
  await f.sweep();
  e = (await f.ledger.get("big"))!;
  assert.equal(e.state, "refunded");
  assert.equal(f.stub.sent.length, 1);
});

test("window cap defers further refunds to review", async (t) => {
  const now = { t: 10_000_000 };
  const f = setup(now, t);
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    await settled(f.ledger, id, { amount: "1000000" }, 0);
    f.ledger["entries"].get(id)!.updatedAt = 0;
  }
  await f.sweep();
  const states = await Promise.all(
    ["a", "b", "c", "d", "e", "f"].map(async (id) => (await f.ledger.get(id))!),
  );
  // 5 x 1_000_000 reach the 5_000_000 cap; the sixth waits for review.
  assert.equal(states.filter((e) => e.state === "refunded").length, 5);
  const parked = states.filter((e) => e.state === "refund_pending");
  assert.equal(parked.length, 1);
  assert.equal(parked[0].refundReview, true);
  assert.ok(f.logs.some((l) => l.event === "x402_refund_cap_reached"));
});

test("crash after persisting the XDR resumes by hash without a second send", async (t) => {
  const now = { t: 10_000_000 };
  const f = setup(now, t);
  await settled(f.ledger, "p", {}, 0);
  f.ledger["entries"].get("p")!.updatedAt = 0;
  // Simulate a crash right after sendTransaction: the tx is persisted and
  // submitted but the process dies before seeing the result.
  f.stub.outcome = "PENDING";
  const origSend = f.stub.rpc.sendTransaction;
  f.stub.rpc.sendTransaction = async (tx) => {
    await origSend(tx);
    throw new Error("process crashed");
  };
  await f.sweep();
  let e = (await f.ledger.get("p"))!;
  assert.equal(e.state, "refunding", "interrupted refunds stay refunding");
  const rec = (await f.ledger.refunds.get("p"))!;
  assert.ok(rec.txHash && rec.txXdr);
  assert.equal(f.stub.sent.length, 1);
  // Restart: the network now knows the transaction landed.
  f.stub.rpc.sendTransaction = origSend;
  f.stub.known.set(rec.txHash!, "SUCCESS");
  await f.sweep();
  e = (await f.ledger.get("p"))!;
  assert.equal(e.state, "refunded");
  assert.equal(e.refundTx, rec.txHash);
  assert.equal(f.stub.sent.length, 1, "never sent twice");

  // Unknown hash still inside its time bound: wait, never resend.
  const g = setup(now, t);
  await settled(g.ledger, "q", {}, 0);
  g.ledger["entries"].get("q")!.updatedAt = 0;
  g.stub.outcome = "PENDING";
  const send = g.stub.rpc.sendTransaction;
  g.stub.rpc.sendTransaction = async (tx) => {
    await send(tx);
    throw new Error("crash");
  };
  await g.sweep();
  g.stub.rpc.sendTransaction = send;
  let polls = 0;
  const get = g.stub.rpc.getTransaction;
  g.stub.rpc.getTransaction = async (h) => {
    if (++polls > 3) now.t += 10 * 60_000; // time passes while unknown
    return get(h);
  };
  await g.sweep();
  assert.equal(g.stub.sent.length, 1, "no resend while it could still land");
  // After the time bound, a later attempt rebuilds with a fresh sequence.
  g.stub.outcome = "SUCCESS";
  g.stub.rpc.getTransaction = get;
  now.t += 10 * 60_000;
  await g.sweep();
  assert.equal((await g.ledger.get("q"))!.state, "refunded");
  assert.equal(g.stub.sent.length, 2);
  assert.notEqual(
    g.stub.sent[0].sequence,
    g.stub.sent[1].sequence,
    "rebuilt with a fresh sequence number",
  );
});

test("FAILED refund ends in refund_failed after maxAttempts", async (t) => {
  const now = { t: 10_000_000 };
  const f = setup(now, t);
  await settled(f.ledger, "p", {}, 0);
  f.ledger["entries"].get("p")!.updatedAt = 0;
  f.stub.simulateError = "HostError: balance too low";
  await f.sweep();
  let e = (await f.ledger.get("p"))!;
  assert.equal(e.state, "refund_pending");
  assert.equal(e.refundAttempts, 1);
  assert.match(e.refundLastError!, /simulation failed/);
  // Backoff: an immediate tick does not retry.
  await f.sweep();
  assert.equal((await f.ledger.get("p"))!.refundAttempts, 1);
  now.t += 120_000;
  await f.sweep();
  e = (await f.ledger.get("p"))!;
  assert.equal(e.state, "refund_failed");
  assert.equal((await f.ledger.refunds.get("p"))!.state, "failed");
  assert.equal(f.stub.sent.length, 0);
  // Terminal: further sweeps do nothing.
  now.t += 3_600_000;
  await f.sweep();
  assert.equal((await f.ledger.get("p"))!.state, "refund_failed");
});

test("contract payer (C...) receives the SEP-41 transfer", async (t) => {
  const now = { t: 10_000_000 };
  const f = setup(now, t);
  const payer = StrKey.encodeContract(Buffer.alloc(32, 9));
  await settled(f.ledger, "p", { payer }, 0);
  f.ledger["entries"].get("p")!.updatedAt = 0;
  await f.sweep();
  assert.equal((await f.ledger.get("p"))!.state, "refunded");
  const op = f.stub.sent[0].operations[0] as { func: xdr.HostFunction };
  const args = op.func.invokeContract().args();
  const to = args[1].address();
  assert.equal(to.switch().name, "scAddressTypeContract");
  assert.equal(
    StrKey.encodeContract(to.contractId() as unknown as Buffer),
    payer,
  );
  assert.equal(
    StrKey.encodeContract(op.func.invokeContract().contractAddress().contractId() as unknown as Buffer),
    ASSET,
  );
});

test("executor refuses to start without a refund secret", () => {
  assert.throws(
    () =>
      new RefundExecutor({
        ledger: new MemoryPaymentLedger(),
        policy,
        secret: "",
        rpcFor: () => stubRpc().rpc,
      }),
    /X402_REFUND_SECRET/,
  );
  void TransactionBuilder;
});
