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
  | "failed_unconfirmed"
  | "failed_final"
  | "needs_operator"
  | "indeterminate"
  // Refund pipeline (refunds.ts): settled-but-undelivered payments past the
  // redelivery window. Every step is a ledger CAS.
  | "refund_pending"
  | "refunding"
  | "refunded"
  | "refund_failed";

export interface AuthCredential {
  address: string;
  nonce: string;
  expirationLedger: number;
}

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
  facilitatorTx?: string;
  innerTxHash?: string;
  maxLedger?: number;
  auths?: AuthCredential[];
  paymentResponseHeader?: string;
  responseBody?: string;
  traceBytes?: string;
  requirementsKey?: string;
  error?: string;
  /** When the payment reached `settled`; starts the redelivery window. */
  settledAt?: number;
  refundId?: string;
  /** Hash of the confirmed refund transaction. */
  refundTx?: string;
  refundAttempts?: number;
  refundLastError?: string;
  /** Above the auto-approve threshold or the window cap: waits for an operator. */
  refundReview?: boolean;
  reconciledAt?: number;
  reconcileReason?: string;
  /** #330: issuing server's clock (unix secs) when settlement was recorded. */
  settledAt?: number;
  /** #330: signed `oracledesk-x402-receipt-v1`, issued once in the settled CAS. */
  receipt?: string;
  /** #330: receipt issued lazily on replay for a pre-receipt settlement. */
  receiptBackfilled?: boolean;
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
  /** Entries in `states` not updated for `olderThanMs`, oldest first. */
  listByState(
    states: PaymentState[],
    olderThanMs: number,
    limit: number,
  ): Promise<PaymentEntry[]>;
  /** Refund records: one per payment (`payment_id` is unique). */
  refunds: RefundStore;
  /** #328: entries per state, sampled by the metrics scrape (not per request). */
  countByState(): Promise<Partial<Record<PaymentState, number>>>;
  close(): void;
}

export type RefundState =
  | "review"
  | "pending"
  | "submitted"
  | "succeeded"
  | "failed"
  | "rejected";
export interface RefundRecord {
  refundId: string;
  paymentId: string;
  state: RefundState;
  amount: string;
  asset: string;
  payer: string;
  /** Hash and signed XDR, persisted *before* `sendTransaction`. */
  txHash?: string;
  txXdr?: string;
  createdAt: number;
  updatedAt: number;
}
export interface RefundStore {
  /** Inserts; `false` if the payment already has a refund record. */
  insert(r: RefundRecord): Promise<boolean>;
  get(paymentId: string): Promise<RefundRecord | undefined>;
  update(
    paymentId: string,
    patch: Partial<Omit<RefundRecord, "refundId" | "paymentId" | "createdAt">>,
  ): Promise<RefundRecord>;
  /** Sum of `amount` over records created after `since`, excluding rejected ones. */
  sumSince(since: number): Promise<bigint>;
  list(
    state: RefundState | undefined,
    cursor: number,
    limit: number,
  ): Promise<{ items: RefundRecord[]; next?: number }>;
}
export class LedgerConflict extends Error {}
function updated(
  entry: PaymentEntry,
  to: PaymentState,
  patch: Partial<PaymentEntry>,
): PaymentEntry {
  // Identity and expiry are immutable, even if an adapter passes a broad patch.
  const {
    payer,
    settlementTx,
    facilitatorTx,
    innerTxHash,
    maxLedger,
    auths,
    paymentResponseHeader,
    responseBody,
    error,
    reconciledAt,
    reconcileReason,
    settledAt,
    refundId,
    refundTx,
    refundAttempts,
    refundLastError,
    refundReview,
    receipt,
    receiptBackfilled,
  } = patch;
  return {
    ...entry,
    ...Object.fromEntries(
      Object.entries({
        payer,
        settlementTx,
        facilitatorTx,
        innerTxHash,
        maxLedger,
        auths,
        paymentResponseHeader,
        responseBody,
        error,
        reconciledAt,
        reconcileReason,
        settledAt,
        refundId,
        refundTx,
        refundAttempts,
        refundLastError,
        refundReview,
        receipt,
        receiptBackfilled,
      }).filter(([, v]) => v !== undefined),
    ),
    state: to,
    updatedAt: Date.now(),
  };
}
class MemoryRefundStore implements RefundStore {
  private records = new Map<string, RefundRecord>();
  async insert(r: RefundRecord) {
    if (this.records.has(r.paymentId)) return false;
    this.records.set(r.paymentId, structuredClone(r));
    return true;
  }
  async get(id: string) {
    const r = this.records.get(id);
    return r && structuredClone(r);
  }
  async update(id: string, patch: Partial<RefundRecord>) {
    const r = this.records.get(id);
    if (!r) throw new LedgerConflict(`Refund for ${id}: not found`);
    const next = { ...r, ...patch, updatedAt: Date.now() };
    this.records.set(id, next);
    return structuredClone(next);
  }
  async sumSince(since: number) {
    let sum = 0n;
    for (const r of this.records.values())
      if (r.createdAt > since && r.state !== "rejected") sum += BigInt(r.amount);
    return sum;
  }
  async list(state: RefundState | undefined, cursor: number, limit: number) {
    const all = [...this.records.values()]
      .filter((r) => !state || r.state === state)
      .sort((a, b) => a.createdAt - b.createdAt || a.refundId.localeCompare(b.refundId));
    const items = all.slice(cursor, cursor + limit).map((r) => structuredClone(r));
    return { items, next: cursor + limit < all.length ? cursor + limit : undefined };
  }
}

export class MemoryPaymentLedger implements PaymentLedger {
  private entries = new Map<string, PaymentEntry>();
  readonly refunds: RefundStore = new MemoryRefundStore();
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
  async listByState(states: PaymentState[], olderThanMs: number, limit: number) {
    const cutoff = Date.now() - olderThanMs;
    return [...this.entries.values()]
      .filter((e) => states.includes(e.state) && e.updatedAt <= cutoff)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }
  async countByState() {
    const counts: Partial<Record<PaymentState, number>> = {};
    for (const e of this.entries.values())
      counts[e.state] = (counts[e.state] ?? 0) + 1;
    return counts;
  }
  close() {}
}

/** Current SQLite schema version (v2: refunds table, #279). */
export const LEDGER_SCHEMA_VERSION = 2;
export class SqlitePaymentLedger implements PaymentLedger {
  private db: Database.Database;
  readonly refunds: RefundStore;
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS payments (payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, entry TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payments_state ON payments(state);`);
    const versions = this.db
      .prepare("SELECT version FROM schema_version")
      .all() as { version: number }[];
    if (versions.length !== 1 || versions[0]?.version !== 1) {
      this.db.close();
      throw new Error("Unsupported payment ledger schema");
    }
    this.refunds = new SqliteRefundStore(this.db);
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
  async listByState(states: PaymentState[], olderThanMs: number, limit: number) {
    if (!states.length) return [];
    const rows = this.db
      .prepare(
        `SELECT entry FROM payments WHERE state IN (${states.map(() => "?").join(",")}) AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(...states, Date.now() - olderThanMs, limit) as { entry: string }[];
    return rows.map((r) => JSON.parse(r.entry) as PaymentEntry);
  }
  async countByState() {
    // Index-only GROUP BY over `payments_state`; run on scrape only.
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM payments GROUP BY state")
      .all() as { state: PaymentState; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n])) as Partial<
      Record<PaymentState, number>
    >;
  }
  close() {
    this.db.close();
  }
}

interface RefundRow {
  refund_id: string;
  payment_id: string;
  state: RefundState;
  amount: string;
  asset: string;
  payer: string;
  tx_hash: string | null;
  tx_xdr: string | null;
  created_at: number;
  updated_at: number;
}
function fromRow(r: RefundRow): RefundRecord {
  return {
    refundId: r.refund_id,
    paymentId: r.payment_id,
    state: r.state,
    amount: r.amount,
    asset: r.asset,
    payer: r.payer,
    ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
    ...(r.tx_xdr ? { txXdr: r.tx_xdr } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
class SqliteRefundStore implements RefundStore {
  constructor(private readonly db: Database.Database) {}
  async insert(r: RefundRecord) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO refunds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          r.refundId,
          r.paymentId,
          r.state,
          r.amount,
          r.asset,
          r.payer,
          r.txHash ?? null,
          r.txXdr ?? null,
          r.createdAt,
          r.updatedAt,
        ).changes === 1
    );
  }
  async get(id: string) {
    const row = this.db
      .prepare("SELECT * FROM refunds WHERE payment_id = ?")
      .get(id) as RefundRow | undefined;
    return row && fromRow(row);
  }
  async update(id: string, patch: Partial<RefundRecord>) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM refunds WHERE payment_id = ?")
        .get(id) as RefundRow | undefined;
      if (!row) throw new LedgerConflict(`Refund for ${id}: not found`);
      const next = { ...fromRow(row), ...patch, updatedAt: Date.now() };
      this.db
        .prepare(
          "UPDATE refunds SET state=?, tx_hash=?, tx_xdr=?, updated_at=? WHERE payment_id=?",
        )
        .run(next.state, next.txHash ?? null, next.txXdr ?? null, next.updatedAt, id);
      return next;
    })();
  }
  async sumSince(since: number) {
    const rows = this.db
      .prepare(
        "SELECT amount FROM refunds WHERE created_at > ? AND state != 'rejected'",
      )
      .all(since) as { amount: string }[];
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }
  async list(state: RefundState | undefined, cursor: number, limit: number) {
    const rows = (
      state
        ? this.db
            .prepare(
              "SELECT * FROM refunds WHERE state = ? ORDER BY created_at, refund_id LIMIT ? OFFSET ?",
            )
            .all(state, limit + 1, cursor)
        : this.db
            .prepare(
              "SELECT * FROM refunds ORDER BY created_at, refund_id LIMIT ? OFFSET ?",
            )
            .all(limit + 1, cursor)
    ) as RefundRow[];
    return {
      items: rows.slice(0, limit).map(fromRow),
      next: rows.length > limit ? cursor + limit : undefined,
    };
  }
}

/** Inner transaction identity prevents fee-bump wrappers and base64 whitespace bypassing deduplication. */
export function paymentIdentity(
  payload: Pick<PaymentPayload, "accepted" | "payload">,
  now = Date.now(),
): {
  paymentId: string;
  expiresAt: number;
  maxLedger?: number;
  innerTxHash: string;
  auths: AuthCredential[];
} {
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
  const auths: AuthCredential[] = [];
  for (const op of tx.toEnvelope().v1().tx().operations()) {
    if (op.body().switch().name !== "invokeHostFunction") continue;
    for (const auth of op.body().invokeHostFunctionOp().auth()) {
      if (auth.credentials().switch().name !== "sorobanCredentialsAddress")
        continue;
      const addrCreds = auth.credentials().address();
      const expiry = addrCreds.signatureExpirationLedger();
      maxLedger = Math.min(maxLedger ?? expiry, expiry);
      // #300: extract the payer address and auth nonce for chain reconciliation.
      const addrVal = addrCreds.address();
      const nonceVal = addrCreds.nonce();
      auths.push({
        address: addrVal.toString(),
        nonce: nonceVal.toString(),
        expirationLedger: expiry,
      });
    }
  }
  return {
    paymentId: createHash("sha256")
      .update(`${network}\n${tx.hash().toString("hex")}`)
      .digest("hex"),
    expiresAt,
    maxLedger,
    innerTxHash: tx.hash().toString("hex"),
    auths,
  };
}