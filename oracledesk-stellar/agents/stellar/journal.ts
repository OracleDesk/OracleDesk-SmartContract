import { open, readFile, mkdir, truncate } from "node:fs/promises";
import { dirname } from "node:path";

export type JournalStage = "signed" | "submitting" | "submitted" | "bumped" | "confirmed" | "failed" | "uncertain" | "cancelled" | "fenced";

export interface TransactionJournalRecord {
  version: 1 | 2;
  id: string;
  stage: JournalStage;
  hash: string;
  envelopeXdr: string;
  timestamp: string;
  attempt?: number;
  detail?: string;
  innerHash?: string;
  outerHash?: string;
  feeOffered?: string;
  feeCharged?: string;
  fence?: { name: string; epoch: string };
}

export interface TransactionJournalOptions {
  /** Called when an incomplete final JSONL record is ignored. */
  warn?: (message: string) => void;
}

const stages = new Set<JournalStage>([
  "signed",
  "submitting",
  "submitted",
  "bumped",
  "confirmed",
  "failed",
  "uncertain",
  "cancelled",
  "fenced",
]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function optionalDecimal(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && DECIMAL.test(value));
}

function isJournalRecord(value: unknown): value is TransactionJournalRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<TransactionJournalRecord>;
  return (
    (record.version === 1 || record.version === 2) &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.stage === "string" &&
    stages.has(record.stage as JournalStage) &&
    typeof record.hash === "string" &&
    typeof record.envelopeXdr === "string" &&
    typeof record.timestamp === "string" &&
    (record.attempt === undefined || (Number.isInteger(record.attempt) && record.attempt > 0)) &&
    (record.detail === undefined || typeof record.detail === "string") &&
    (record.innerHash === undefined || typeof record.innerHash === "string") &&
    (record.outerHash === undefined || typeof record.outerHash === "string") &&
    (record.dependsOn === undefined || (typeof record.dependsOn === "string" && record.dependsOn.length > 0)) &&
    (record.kind === undefined || record.kind === "action" || record.kind === "restore") &&
    optionalDecimal(record.feeOffered) &&
    optionalDecimal(record.feeCharged) &&
    (record.fence === undefined ||
      (typeof record.fence === "object" &&
        typeof record.fence.name === "string" &&
        typeof record.fence.epoch === "string"))
  );
}

function validateRecord(record: TransactionJournalRecord): void {
  if (!isJournalRecord(record)) throw new TypeError("invalid transaction journal record");
}

/**
 * Append-only JSONL journal. Each complete record is synced before append()
 * resolves, so callers can safely proceed to the next externally visible stage.
 */
export class TransactionJournal {
  private queue: Promise<void> = Promise.resolve();
  private readonly warn: (message: string) => void;

  constructor(readonly path: string, options: TransactionJournalOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  append(record: TransactionJournalRecord): Promise<void> {
    validateRecord(record);
    const operation = this.queue.then(() => this.appendSerialized(record));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async readAll(): Promise<TransactionJournalRecord[]> {
    await this.queue;
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (content.length === 0) return [];

    const hasFinalNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasFinalNewline) lines.pop();

    const records: TransactionJournalRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) throw new Error(`empty transaction journal record at line ${index + 1}`);
      try {
        const value: unknown = JSON.parse(line);
        if (!isJournalRecord(value)) throw new Error("invalid record fields");
        records.push(value);
      } catch (error) {
        const isIncompleteTail = !hasFinalNewline && index === lines.length - 1;
        if (!isIncompleteTail) {
          throw new Error(`invalid transaction journal record at line ${index + 1}`, { cause: error });
        }
        this.warn(`Ignoring torn final transaction journal record in ${this.path}`);
      }
    }
    return records;
  }

  async latestById(): Promise<Map<string, TransactionJournalRecord>> {
    const latest = new Map<string, TransactionJournalRecord>();
    for (const record of await this.readAll()) latest.set(record.id, record);
    return latest;
  }

  /**
   * Actions left incomplete by a crash after a preamble restore. The adapter
   * uses this at startup: a confirmed restore means the action can simply be
   * re-simulated; an uncertain restore must first be checked by hash (the
   * caller does that through `dependsOn`). Restores are idempotent, so an
   * unconfirmed restore may be rebuilt without risking a double action.
   */
  async resumableActions(): Promise<ResumableAction[]> {
    return resumableActions(await this.readAll());
  }

  private async appendSerialized(record: TransactionJournalRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lastCompleteRecordEnd = existing.endsWith("\n")
      ? existing.length - 1
      : existing.lastIndexOf("\n");
    if (lastCompleteRecordEnd >= 0) {
      const completeRecords = existing.slice(0, lastCompleteRecordEnd).split("\n");
      for (let index = 0; index < completeRecords.length; index += 1) {
        try {
          const value: unknown = JSON.parse(completeRecords[index]);
          if (!isJournalRecord(value)) throw new Error("invalid record fields");
        } catch (error) {
          throw new Error(`invalid transaction journal record at line ${index + 1}`, { cause: error });
        }
      }
    }
    let separator = "";
    if (existing.length > 0 && !existing.endsWith("\n")) {
      const lastLineStart = existing.lastIndexOf("\n") + 1;
      const tail = existing.slice(lastLineStart);
      try {
        const value: unknown = JSON.parse(tail);
        if (!isJournalRecord(value)) throw new Error("invalid record fields");
        separator = "\n";
      } catch {
        this.warn(`Discarding torn final transaction journal record in ${this.path}`);
        await truncate(this.path, Buffer.byteLength(existing.slice(0, lastLineStart), "utf8"));
      }
    }
    const handle = await open(this.path, "a");
    try {
      await handle.writeFile(`${separator}${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export interface ResumableAction {
  actionId: string;
  restore?: TransactionJournalRecord;
  action?: TransactionJournalRecord;
}

/** Pure form of {@link TransactionJournal.resumableActions}, usable in tests. */
export function resumableActions(records: readonly TransactionJournalRecord[]): ResumableAction[] {
  const byId = new Map<string, TransactionJournalRecord>();
  for (const record of records) byId.set(record.id, record);
  const restoreIds = new Set(
    records.filter((r) => r.kind === "restore" || r.id.endsWith(":restore")).map((r) => r.id),
  );
  const out: ResumableAction[] = [];
  for (const restoreId of restoreIds) {
    const restore = byId.get(restoreId)!;
    const actionId = restoreId.replace(/:restore$/, "");
    if (restore.stage !== "confirmed" && restore.stage !== "uncertain") continue;
    const action = byId.get(actionId);
    if (action && !["signed", "submitting", "uncertain"].includes(action.stage)) continue;
    out.push({ actionId, restore, action });
  }
  return out;
}

export function createJournalRecord(
  fields: Omit<TransactionJournalRecord, "version" | "timestamp"> & { timestamp?: string },
): TransactionJournalRecord {
  return {
    ...fields,
    version: 2,
    timestamp: fields.timestamp ?? new Date().toISOString(),
  };
}
