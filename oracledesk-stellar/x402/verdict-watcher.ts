/**
 * x402/verdict-watcher.ts — Issue #306
 *
 * Polls the reasoning-registry for TraceFlagged and AgentRevoked events.
 * For each affected trace, marks in-window settled/delivered payments as
 * refund_pending so the refund executor can process them.
 *
 * The cursor (last-seen event sequence) is persisted in the SQLite ledger's
 * kv table so restarts don't reprocess or miss events.
 *
 * External dependencies (registry RPC, getEvents) are mocked via the
 * EventSource interface so this module is testable without a live network.
 */

export interface FlaggedEvent {
  kind: "TraceFlagged";
  traceId: bigint;
  reason: string;
  ledger: number;
  timestamp: number;
}

export interface AgentRevokedEvent {
  kind: "AgentRevoked";
  agent: string;
  effectiveFrom: bigint;
  ledger: number;
  timestamp: number;
}

export type RegistryEvent = FlaggedEvent | AgentRevokedEvent;

/** Source of on-chain registry events (injected; production uses getEvents). */
export interface EventSource {
  /** Returns events after `afterLedger`, up to a reasonable batch size. */
  getRegistryEvents(afterLedger: number): Promise<RegistryEvent[]>;
}

/** Persistent cursor store (backed by SQLite kv in production). */
export interface CursorStore {
  getCursor(): Promise<number>;
  setCursor(ledger: number): Promise<void>;
}

/** Payment query interface (backed by SqlitePaymentLedger in production). */
export interface PaymentQueryStore {
  /**
   * Returns payment ids for payments in state settled or delivered whose
   * traceId matches and whose settlement is within `windowSecs` seconds of now.
   */
  findRecentByTraceId(
    traceId: string,
    windowSecs: number,
  ): Promise<string[]>;
  /**
   * Returns payment ids for payments backed by traces published by `agent`
   * that are in state settled or delivered and within the refund window.
   */
  findRecentByAgent(
    agent: string,
    windowSecs: number,
  ): Promise<string[]>;
  /** Marks payments refund_pending with the given reason. */
  markRefundPending(paymentIds: string[], reason: string): Promise<void>;
}

export interface VerdictWatcherOptions {
  eventSource: EventSource;
  cursorStore: CursorStore;
  paymentStore: PaymentQueryStore;
  /** Seconds after settlement during which a flagged/revoked trace triggers a refund. */
  refundWindowSecs: number;
  /** Polling interval in milliseconds. */
  pollIntervalMs?: number;
}

/**
 * Processes one batch of events, updating affected payments and advancing
 * the cursor. Returns the number of payments marked refund_pending.
 */
export async function processBatch(
  opts: VerdictWatcherOptions,
): Promise<{ processed: number; cursor: number }> {
  const cursor = await opts.cursorStore.getCursor();
  const events = await opts.eventSource.getRegistryEvents(cursor);
  if (events.length === 0) return { processed: 0, cursor };

  let marked = 0;
  let maxLedger = cursor;

  for (const event of events) {
    maxLedger = Math.max(maxLedger, event.ledger);

    if (event.kind === "TraceFlagged") {
      const paymentIds = await opts.paymentStore.findRecentByTraceId(
        event.traceId.toString(),
        opts.refundWindowSecs,
      );
      if (paymentIds.length > 0) {
        await opts.paymentStore.markRefundPending(
          paymentIds,
          `verdict:Flagged:${event.reason}`,
        );
        marked += paymentIds.length;
      }
    } else if (event.kind === "AgentRevoked") {
      const paymentIds = await opts.paymentStore.findRecentByAgent(
        event.agent,
        opts.refundWindowSecs,
      );
      if (paymentIds.length > 0) {
        await opts.paymentStore.markRefundPending(
          paymentIds,
          `verdict:AgentRevokedAfter:${event.effectiveFrom}`,
        );
        marked += paymentIds.length;
      }
    }
  }

  if (maxLedger > cursor) {
    await opts.cursorStore.setCursor(maxLedger);
  }

  return { processed: marked, cursor: maxLedger };
}

/** In-memory cursor store for testing. */
export class MemoryCursorStore implements CursorStore {
  private cursor = 0;
  async getCursor() { return this.cursor; }
  async setCursor(ledger: number) { this.cursor = ledger; }
}

/** In-memory payment store for testing. */
export class MemoryPaymentQueryStore implements PaymentQueryStore {
  private payments: Array<{
    paymentId: string;
    traceId: string;
    agent: string;
    settledAt: number;
    state: string;
    refundReason?: string;
  }> = [];

  addPayment(p: { paymentId: string; traceId: string; agent: string; settledAt: number }) {
    this.payments.push({ ...p, state: "settled" });
  }

  async findRecentByTraceId(traceId: string, windowSecs: number): Promise<string[]> {
    const cutoff = Date.now() / 1000 - windowSecs;
    return this.payments
      .filter(
        (p) =>
          p.traceId === traceId &&
          (p.state === "settled" || p.state === "delivered") &&
          p.settledAt >= cutoff,
      )
      .map((p) => p.paymentId);
  }

  async findRecentByAgent(agent: string, windowSecs: number): Promise<string[]> {
    const cutoff = Date.now() / 1000 - windowSecs;
    return this.payments
      .filter(
        (p) =>
          p.agent === agent &&
          (p.state === "settled" || p.state === "delivered") &&
          p.settledAt >= cutoff,
      )
      .map((p) => p.paymentId);
  }

  async markRefundPending(paymentIds: string[], reason: string): Promise<void> {
    for (const id of paymentIds) {
      const p = this.payments.find((x) => x.paymentId === id);
      if (p) {
        p.state = "refund_pending";
        p.refundReason = reason;
      }
    }
  }

  getPayments() { return this.payments; }
}
