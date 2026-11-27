// Automatic refunds for settled payments whose trace delivery failed (#279).
//
// A buyer whose download failed after settlement can re-download with the
// same payment for `redeliveryWindowMs` (trace-api.ts). After that window the
// sweeper refunds the payment with a real SEP-41 `transfer` from a dedicated
// refund account. All state lives in the payment ledger (entry state +
// `refunds` table), every transition is a CAS, and the signed transaction and
// its hash are persisted *before* submission, so a crash at any point can
// never produce two refund transactions for one payment.
//
// Lifecycle: settled -> refund_pending -> refunding -> refunded | refund_failed
// (refund_pending carries `refundReview: true` while it waits for an operator).

import { randomUUID } from "node:crypto";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  LedgerConflict,
  type PaymentEntry,
  type PaymentLedger,
  type RefundRecord,
} from "./payment-ledger.js";

export interface RefundPolicy {
  /** How long a settled payment stays re-downloadable before it is refunded. */
  redeliveryWindowMs: number;
  /** Refunds up to this amount (base units) are executed without review. */
  autoApproveMax: bigint;
  /** Max total refunded per rolling `windowMs`; above it refunds wait for review. */
  windowCap: bigint;
  windowMs: number;
  /** Attempts before a refund ends in `refund_failed`. */
  maxAttempts: number;
}

export type RefundClass = "wait" | "auto_refund" | "review" | "ignore";

/** `G...` account or `C...` contract: both can receive a SEP-41 transfer. */
export function isRefundablePayer(payer: string | undefined): payer is string {
  return (
    !!payer &&
    (StrKey.isValidEd25519PublicKey(payer) || StrKey.isValidContract(payer))
  );
}

/**
 * Whether a ledger entry is refund-eligible: settled with no `delivered`
 * transition, with a settlement transaction and a valid payer, and past its
 * redelivery window. The rolling window cap is applied by the sweeper, which
 * needs the refund store.
 */
export function classify(
  e: PaymentEntry,
  now: number,
  p: RefundPolicy,
): RefundClass {
  if (e.state !== "settled") return "ignore";
  if (!e.settlementTx || !isRefundablePayer(e.payer)) return "ignore";
  let amount: bigint;
  try {
    amount = BigInt(e.amount);
  } catch {
    return "ignore";
  }
  if (amount <= 0n) return "ignore";
  const settledAt = e.settledAt ?? e.updatedAt;
  if (now < settledAt + p.redeliveryWindowMs) return "wait";
  return amount > p.autoApproveMax ? "review" : "auto_refund";
}

/** The subset of `rpc.Server` the executor uses (stubbed in tests). */
export interface RefundRpc {
  getAccount(address: string): Promise<{ accountId(): string; sequenceNumber(): string; incrementSequenceNumber(): void }>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface RefundExecutorOptions {
  ledger: PaymentLedger;
  policy: RefundPolicy;
  /** Secret of the dedicated refund source account (`X402_REFUND_SECRET`). */
  secret: string;
  /** RPC for a payment's network; chosen per entry, never a global default. */
  rpcFor(network: string): RefundRpc;
  /** Seconds a refund transaction stays valid (its time bound). */
  txTimeoutSecs?: number;
  /** Poll interval while waiting for a submitted transaction. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}

export function passphraseFor(network: string): string {
  if (network === "stellar:testnet") return Networks.TESTNET;
  if (network === "stellar:pubnet") return Networks.PUBLIC;
  throw new Error(`Unsupported refund network ${network}`);
}

class RetryableRefundError extends Error {}

/** Backoff before retry `attempt` (1-based): 1, 2, 4, ... minutes, capped at 1 h. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

export class RefundExecutor {
  private readonly keypair: Keypair;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(private readonly o: RefundExecutorOptions) {
    if (!o.secret) throw new Error("Refunds require X402_REFUND_SECRET");
    this.keypair = Keypair.fromSecret(o.secret);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  }

  get source(): string {
    return this.keypair.publicKey();
  }

  /**
   * Moves a `settled` entry into the refund pipeline (CAS). `review` parks it
   * for an operator. Returns `false` if the entry moved meanwhile (for
   * example a concurrent re-download delivered it).
   */
  async open(e: PaymentEntry, review: boolean): Promise<boolean> {
    const refundId = randomUUID();
    try {
      await this.o.ledger.transition(e.paymentId, ["settled"], "refund_pending", {
        refundId,
        refundReview: review,
        refundAttempts: 0,
      });
    } catch (error) {
      if (error instanceof LedgerConflict) return false;
      throw error;
    }
    const t = this.now();
    await this.o.ledger.refunds.insert({
      refundId,
      paymentId: e.paymentId,
      state: review ? "review" : "pending",
      amount: e.amount,
      asset: e.asset,
      payer: e.payer!,
      createdAt: t,
      updatedAt: t,
    });
    return true;
  }

  /**
   * Executes (or resumes) the refund of an entry in `refund_pending` or
   * `refunding`. Safe to call again after a crash at any point.
   */
  async execute(entryIn: PaymentEntry): Promise<PaymentEntry> {
    const ledger = this.o.ledger;
    let entry = entryIn;
    if (entry.state === "refund_pending") {
      if (entry.refundReview) return entry;
      entry = await ledger.transition(entry.paymentId, ["refund_pending"], "refunding", {
        refundAttempts: (entry.refundAttempts ?? 0) + 1,
      });
    }
    if (entry.state !== "refunding") return entry;
    const record = await ledger.refunds.get(entry.paymentId);
    if (!record) throw new Error(`Refund record missing for ${entry.paymentId}`);
    const server = this.o.rpcFor(entry.network);
    const passphrase = passphraseFor(entry.network);
    try {
      let hash = record.txHash;
      let validUntil = record.txXdr
        ? this.timeBound(record.txXdr, passphrase)
        : 0;
      if (hash) {
        // Crash recovery: the previous attempt may already be on the network.
        const known = await server.getTransaction(hash);
        if (known.status === rpc.Api.GetTransactionStatus.SUCCESS)
          return await this.succeed(entry, hash);
        if (known.status === rpc.Api.GetTransactionStatus.FAILED)
          throw new RetryableRefundError(`refund transaction ${hash} failed`);
        if (this.now() <= validUntil * 1000) {
          // It could still land: never resend, only wait for it.
          return await this.await(entry, server, hash, validUntil);
        }
        hash = undefined; // expired unseen: safe to rebuild with a fresh sequence
      }
      const tx = await this.build(entry, record, server, passphrase);
      hash = tx.hash().toString("hex");
      validUntil = Number(tx.timeBounds?.maxTime ?? 0);
      // Persist before submitting: a crash after this line resumes by hash.
      await ledger.refunds.update(entry.paymentId, {
        state: "submitted",
        txHash: hash,
        txXdr: tx.toXDR(),
      });
      const sent = await server.sendTransaction(tx);
      if (sent.status === "ERROR")
        throw new RetryableRefundError(`sendTransaction rejected the refund`);
      return await this.await(entry, server, hash, validUntil);
    } catch (error) {
      return this.fail(entry, error);
    }
  }

  private timeBound(xdr: string, passphrase: string): number {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
    return Number(tx.timeBounds?.maxTime ?? 0);
  }

  private async build(
    entry: PaymentEntry,
    record: RefundRecord,
    server: RefundRpc,
    passphrase: string,
  ): Promise<Transaction> {
    const account = await server.getAccount(this.source);
    // SEP-41 transfer on the payment's own asset contract. Works for G...
    // and C... payers alike; never a classic payment.
    const op = new Contract(entry.asset).call(
      "transfer",
      new Address(this.source).toScVal(),
      new Address(record.payer).toScVal(),
      nativeToScVal(BigInt(record.amount), { type: "i128" }),
    );
    const tx = new TransactionBuilder(account as never, {
      fee: "100000",
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setTimeout(this.o.txTimeoutSecs ?? 60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim))
      throw new RetryableRefundError(`simulation failed: ${sim.error}`);
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(this.keypair);
    return assembled;
  }

  private async await(
    entry: PaymentEntry,
    server: RefundRpc,
    hash: string,
    validUntil: number,
  ): Promise<PaymentEntry> {
    for (;;) {
      const r = await server.getTransaction(hash);
      if (r.status === rpc.Api.GetTransactionStatus.SUCCESS)
        return this.succeed(entry, hash);
      if (r.status === rpc.Api.GetTransactionStatus.FAILED)
        throw new RetryableRefundError(`refund transaction ${hash} failed`);
      if (validUntil > 0 && this.now() > validUntil * 1000) {
        // Past its time bound and still unknown: it can no longer land.
        // Leave the hash; the next attempt confirms NOT_FOUND and rebuilds.
        throw new RetryableRefundError(`refund transaction ${hash} expired`);
      }
      await this.sleep(this.o.pollMs ?? 1_000);
    }
  }

  private async succeed(entry: PaymentEntry, hash: string) {
    await this.o.ledger.refunds.update(entry.paymentId, { state: "succeeded" });
    const done = await this.o.ledger.transition(entry.paymentId, ["refunding"], "refunded", {
      refundTx: hash,
    });
    this.log({ event: "x402_refunded", paymentId: entry.paymentId, refundTx: hash });
    return done;
  }

  private async fail(entry: PaymentEntry, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = entry.refundAttempts ?? 1;
    // A lost CAS means another worker owns this payment now.
    if (error instanceof LedgerConflict) throw error;
    if (!(error instanceof RetryableRefundError)) {
      // Infrastructure error (RPC unreachable...): leave `refunding`; the
      // sweeper resumes it by hash next tick.
      this.log({ event: "x402_refund_error", paymentId: entry.paymentId, error: message });
      return entry;
    }
    if (attempts >= this.o.policy.maxAttempts) {
      await this.o.ledger.refunds.update(entry.paymentId, { state: "failed" });
      this.log({ event: "x402_refund_failed", paymentId: entry.paymentId, error: message });
      return this.o.ledger.transition(entry.paymentId, ["refunding"], "refund_failed", {
        refundLastError: message,
      });
    }
    // Keep the old tx hash on the record: the next attempt checks it first.
    return this.o.ledger.transition(entry.paymentId, ["refunding"], "refund_pending", {
      refundLastError: message,
    });
  }
}

export interface SweepOptions {
  batch: number;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * One sweeper tick: resumes interrupted refunds, retries pending ones whose
 * backoff elapsed, then opens refunds for settled-but-undelivered payments
 * past the redelivery window, at most `batch` entries in total.
 */
export async function sweepRefunds(
  ledger: PaymentLedger,
  executor: RefundExecutor,
  policy: RefundPolicy,
  o: SweepOptions,
): Promise<number> {
  const now = (o.now ?? Date.now)();
  const log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  let budget = o.batch;
  let processed = 0;
  // 1. Crash recovery: anything left mid-flight.
  for (const e of await ledger.listByState(["refunding"], 0, budget)) {
    await executor.execute(e);
    budget--;
    processed++;
  }
  // 2. Retries (after backoff) of approved pending refunds.
  for (const e of await ledger.listByState(["refund_pending"], 0, Math.max(budget, 0))) {
    if (budget <= 0) break;
    if (e.refundReview) continue;
    const attempts = e.refundAttempts ?? 0;
    if (attempts > 0 && now < e.updatedAt + backoffMs(attempts)) continue;
    await executor.execute(e);
    budget--;
    processed++;
  }
  // 3. New refunds.
  if (budget > 0) {
    const candidates = await ledger.listByState(
      ["settled"],
      policy.redeliveryWindowMs,
      budget,
    );
    for (const e of candidates) {
      const c = classify(e, now, policy);
      if (c === "wait" || c === "ignore") continue;
      let review = c === "review";
      if (!review) {
        const used = await ledger.refunds.sumSince(now - policy.windowMs);
        if (used + BigInt(e.amount) > policy.windowCap) {
          review = true;
          log({
            event: "x402_refund_cap_reached",
            paymentId: e.paymentId,
            used: used.toString(),
            windowCap: policy.windowCap.toString(),
          });
        }
      }
      if (!(await executor.open(e, review))) continue;
      processed++;
      if (!review) {
        const opened = await ledger.get(e.paymentId);
        if (opened) await executor.execute(opened);
      }
    }
  }
  return processed;
}

/** Operator approval of a refund parked for review. */
export async function approveRefund(ledger: PaymentLedger, paymentId: string) {
  const current = await ledger.get(paymentId);
  if (!current || current.state !== "refund_pending" || !current.refundReview)
    throw new LedgerConflict(`Payment ${paymentId}: not awaiting review`);
  const e = await ledger.transition(paymentId, ["refund_pending"], "refund_pending", {
    refundReview: false,
  });
  await ledger.refunds.update(paymentId, { state: "pending" });
  return e;
}

/** Operator rejection: the payment stays paid, nothing is sent. */
export async function rejectRefund(ledger: PaymentLedger, paymentId: string) {
  const e = await ledger.get(paymentId);
  if (!e || e.state !== "refund_pending" || !e.refundReview)
    throw new LedgerConflict(`Payment ${paymentId}: not awaiting review`);
  await ledger.refunds.update(paymentId, { state: "rejected" });
  return ledger.transition(paymentId, ["refund_pending"], "refund_failed", {
    refundLastError: "Rejected by operator",
  });
}

export function refundPolicyFromEnv(env: NodeJS.ProcessEnv): RefundPolicy {
  return {
    redeliveryWindowMs: Number(env.X402_REDELIVERY_WINDOW_SECS ?? 900) * 1000,
    autoApproveMax: BigInt(env.X402_REFUND_AUTO_APPROVE_MAX ?? "1000000"),
    windowCap: BigInt(env.X402_REFUND_WINDOW_CAP ?? "100000000"),
    windowMs: Number(env.X402_REFUND_WINDOW_SECS ?? 86_400) * 1000,
    maxAttempts: Number(env.X402_REFUND_MAX_ATTEMPTS ?? 5),
  };
}
