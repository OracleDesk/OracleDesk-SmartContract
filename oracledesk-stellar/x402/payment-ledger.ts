import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import {
  Networks,
  TransactionBuilder,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";

export type PaymentState =
  | "verifying"
  | "settling"
  | "settled"
  | "delivered"
  | "failed"
  | "indeterminate";
export interface PaymentEntry {
  paymentId: string;
  traceId: string;
  traceHash: string;
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  payer?: string;
  state: PaymentState;
  settlementTx?: string;
  paymentResponseHeader?: string;
  responseBody?: string;
  traceBytes?: string;
  requirementsKey?: string;
  error?: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}
export type PaymentClaim = Omit<
  PaymentEntry,
  "state" | "createdAt" | "updatedAt"
>;
export interface PaymentLedger {
  claim(
    entry: PaymentClaim,
  ): Promise<{ created: boolean; entry: PaymentEntry }>;
  transition(
    id: string,
    from: PaymentState[],
    to: PaymentState,
    patch?: Partial<PaymentEntry>,
  ): Promise<PaymentEntry>;
  get(id: string): Promise<PaymentEntry | undefined>;
  reconcileStuck(olderThanMs: number): Promise<number>;
  close(): void;
}
export class LedgerConflict extends Error {}
function updated(
  entry: PaymentEntry,
  to: PaymentState,
  patch: Partial<PaymentEntry>,
): PaymentEntry {
  // Identity and expiry are immutable, even if an adapter passes a broad patch.
  const { payer, settlementTx, paymentResponseHeader, responseBody, error } =
    patch;
  return {
    ...entry,
    ...Object.fromEntries(
      Object.entries({
        payer,
        settlementTx,
        paymentResponseHeader,
        responseBody,
        error,
      }).filter(([, v]) => v !== undefined),
    ),
    state: to,
    updatedAt: Date.now(),
  };
}
export class MemoryPaymentLedger implements PaymentLedger {
  private entries = new Map<string, PaymentEntry>();
  async claim(e: PaymentClaim) {
    const existing = this.entries.get(e.paymentId);
    if (existing) return { created: false, entry: structuredClone(existing) };
    const entry: PaymentEntry = {
      ...e,
      state: "verifying",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.entries.set(e.paymentId, structuredClone(entry));
    return { created: true, entry };
  }
  async get(id: string) {
    const e = this.entries.get(id);
    return e && structuredClone(e);
  }
  async transition(
    id: string,
    from: PaymentState[],
    to: PaymentState,
    patch: Partial<PaymentEntry> = {},
  ) {
    const e = this.entries.get(id);
    if (!e || !from.includes(e.state))
      throw new LedgerConflict(`Payment ${id}: state conflict`);
    const next = updated(e, to, patch);
    this.entries.set(id, next);
    return structuredClone(next);
  }
  async reconcileStuck(olderThanMs: number) {
    let count = 0;
    for (const [id, e] of this.entries)
      if (
        ["verifying", "settling"].includes(e.state) &&
        e.updatedAt <= Date.now() - olderThanMs
      ) {
        await this.transition(id, [e.state], "indeterminate", {
          error: "Interrupted payment; inspect before reconciliation",
        });
        count++;
      }
    return count;
  }
  close() {}
}
export class SqlitePaymentLedger implements PaymentLedger {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS payments (payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, entry TEXT NOT NULL);`);
    const versions = this.db
      .prepare("SELECT version FROM schema_version")
      .all() as { version: number }[];
    if (versions.length !== 1 || versions[0].version !== 1) {
      this.db.close();
      throw new Error("Unsupported payment ledger schema");
    }
  }
  async claim(e: PaymentClaim) {
    const entry: PaymentEntry = {
      ...e,
      state: "verifying",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const result = this.db
      .prepare("INSERT OR IGNORE INTO payments VALUES (?, ?, ?, ?)")
      .run(e.paymentId, entry.state, entry.updatedAt, JSON.stringify(entry));
    return {
      created: result.changes === 1,
      entry: (await this.get(e.paymentId))!,
    };
  }
  async get(id: string) {
    const row = this.db
      .prepare("SELECT entry FROM payments WHERE payment_id = ?")
      .get(id) as { entry: string } | undefined;
    return row && (JSON.parse(row.entry) as PaymentEntry);
  }
  async transition(
    id: string,
    from: PaymentState[],
    to: PaymentState,
    patch: Partial<PaymentEntry> = {},
  ) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT entry FROM payments WHERE payment_id = ?")
        .get(id) as { entry: string } | undefined;
      const e: PaymentEntry | undefined = row && JSON.parse(row.entry);
      if (!e || !from.includes(e.state))
        throw new LedgerConflict(`Payment ${id}: state conflict`);
      const next = updated(e, to, patch);
      const result = this.db
        .prepare(
          "UPDATE payments SET state=?, updated_at=?, entry=? WHERE payment_id=? AND state=?",
        )
        .run(to, next.updatedAt, JSON.stringify(next), id, e.state);
      if (result.changes !== 1)
        throw new LedgerConflict(`Payment ${id}: state conflict`);
      return next;
    })();
  }
  async reconcileStuck(olderThanMs: number) {
    const rows = this.db
      .prepare(
        "SELECT payment_id FROM payments WHERE state IN ('verifying','settling') AND updated_at <= ?",
      )
      .all(Date.now() - olderThanMs) as { payment_id: string }[];
    for (const row of rows)
      await this.transition(
        row.payment_id,
        ["verifying", "settling"],
        "indeterminate",
        { error: "Interrupted payment; inspect before reconciliation" },
      );
    return rows.length;
  }
  close() {
    this.db.close();
  }
}

/** Inner transaction identity prevents fee-bump wrappers and base64 whitespace bypassing deduplication. */
export function paymentIdentity(
  payload: Pick<PaymentPayload, "accepted" | "payload">,
  now = Date.now(),
): { paymentId: string; expiresAt: number; maxLedger?: number } {
  const network = payload.accepted.network;
  if (network !== "stellar:testnet" && network !== "stellar:pubnet")
    throw new Error("Unsupported payment network");
  if (
    !Number.isFinite(payload.accepted.maxTimeoutSeconds) ||
    payload.accepted.maxTimeoutSeconds <= 0
  )
    throw new Error("Invalid payment timeout");
  if (typeof payload.payload.transaction !== "string")
    throw new Error("Missing Stellar transaction");
  const passphrase =
    network === "stellar:testnet" ? Networks.TESTNET : Networks.PUBLIC;
  const outer = TransactionBuilder.fromXDR(
    payload.payload.transaction.replace(/\s/g, ""),
    passphrase,
  );
  const tx =
    outer instanceof FeeBumpTransaction ? outer.innerTransaction : outer;
  let expiresAt = now + payload.accepted.maxTimeoutSeconds * 1000;
  if (tx.timeBounds && Number(tx.timeBounds.maxTime) > 0)
    expiresAt = Math.min(expiresAt, Number(tx.timeBounds.maxTime) * 1000);
  let maxLedger =
    tx.ledgerBounds && Number(tx.ledgerBounds.maxLedger) > 0
      ? Number(tx.ledgerBounds.maxLedger)
      : undefined;
  // Soroban address authorizations can expire before the transaction itself.
  for (const op of tx.toEnvelope().v1().tx().operations()) {
    if (op.body().switch().name !== "invokeHostFunction") continue;
    for (const auth of op.body().invokeHostFunctionOp().auth()) {
      if (auth.credentials().switch().name !== "sorobanCredentialsAddress")
        continue;
      const expiry = auth.credentials().address().signatureExpirationLedger();
      maxLedger = Math.min(maxLedger ?? expiry, expiry);
    }
  }
  return {
    paymentId: createHash("sha256")
      .update(`${network}\n${tx.hash().toString("hex")}`)
      .digest("hex"),
    expiresAt,
    maxLedger,
  };
}
