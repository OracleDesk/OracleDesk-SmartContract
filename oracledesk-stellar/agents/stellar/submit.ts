import { rpc, Transaction, xdr, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import {
  createJournalRecord,
  type JournalStage,
  type TransactionJournal,
  type TransactionJournalRecord,
} from "./journal.js";
import { classifySorobanError, SorobanPendingError, SorobanSubmissionError } from "./errors.js";

type SendEnvelope = Transaction | FeeBumpTransaction;

export interface ReplacementPolicy {
  afterPolls: number;
  deadlineUnix?: number;
  maxBumps?: number;
  bump(inner: Transaction, attempt: number): Promise<FeeBumpTransaction | undefined> | FeeBumpTransaction | undefined;
}

export interface SorobanSubmitOptions {
  id: string;
  transaction: Transaction;
  server: Pick<rpc.Server, "sendTransaction" | "getTransaction">;
  journal: TransactionJournal;
  maxAttempts?: number;
  maxPollsPerAttempt?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  beforeSend?: (hash: string, attempt: number) => void | Promise<void>;
  replacement?: ReplacementPolicy;
  nowUnix?: () => number;
  /** Journal lineage: a restore's id on the dependent action, or the action's
   * id on a re-simulation after an archival race. */
  dependsOn?: string;
  kind?: "action" | "restore";
}

export type SorobanSubmitResult = Extract<Awaited<ReturnType<rpc.Server["getTransaction"]>>, { status: "SUCCESS" }>;

interface ActiveEnvelope {
  envelope: SendEnvelope;
  hash: string;
  envelopeXdr: string;
  outerHash?: string;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function feeChargedOf(result: unknown): string | undefined {
  try {
    const raw = (result as { resultXdr?: string }).resultXdr;
    if (typeof raw !== "string") return undefined;
    return xdr.TransactionResult.fromXDR(raw, "base64").feeCharged().toString();
  } catch {
    return undefined;
  }
}

function isFeeError(value: unknown): boolean {
  return classifySorobanError(value).kind === "fee";
}

function makeError(value: unknown, hash: string): SorobanSubmissionError {
  const classification = classifySorobanError(value);
  return new SorobanSubmissionError(classification.message, { ...classification, terminal: true }, {
    cause: value,
    transactionHash: hash,
  });
}

export async function submitSorobanTransaction(options: SorobanSubmitOptions): Promise<SorobanSubmitResult> {
  const {
    id,
    transaction,
    server,
    journal,
    maxAttempts = 4,
    maxPollsPerAttempt = 4,
    retryDelayMs = 250,
    sleep = defaultSleep,
    beforeSend,
    replacement,
    nowUnix = () => Math.floor(Date.now() / 1000),
    dependsOn,
    kind,
  } = options;
  if (!id) throw new TypeError("transaction journal id is required");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
  if (!Number.isInteger(maxPollsPerAttempt) || maxPollsPerAttempt < 0) {
    throw new RangeError("maxPollsPerAttempt must be a non-negative integer");
  }
  if (replacement && (!Number.isInteger(replacement.afterPolls) || replacement.afterPolls < 1)) {
    throw new RangeError("replacement.afterPolls must be a positive integer");
  }

  const innerHash = transaction.hash().toString("hex");
  const innerXdr = transaction.toXDR();
  let active: ActiveEnvelope = { envelope: transaction, hash: innerHash, envelopeXdr: innerXdr };
  const outerHashes: string[] = [];
  let bumpCount = 0;
  let lastError: unknown;

  const log = (
    stage: JournalStage,
    attempt?: number,
    detail?: string,
    extra: Partial<TransactionJournalRecord> = {},
  ) =>
    journal.append(createJournalRecord({
      id,
      stage,
      hash: innerHash,
      envelopeXdr: innerXdr,
      attempt,
      detail,
      ...extra,
      ...(dependsOn && { dependsOn }),
      ...(kind && { kind }),
    }));

  const canBump = () =>
    replacement !== undefined &&
    bumpCount < (replacement.maxBumps ?? 3) &&
    (replacement.deadlineUnix === undefined || nowUnix() < replacement.deadlineUnix);

  const tryBump = async (attempt: number): Promise<boolean> => {
    if (!replacement || !canBump()) return false;
    let bump: FeeBumpTransaction | undefined;
    try {
      bump = await replacement.bump(transaction, bumpCount + 1);
    } catch (error) {
      lastError = error;
      return false;
    }
    if (!bump) return false;
    bumpCount += 1;
    const outerHash = bump.hash().toString("hex");
    const feeOffered = BigInt(bump.fee).toString();
    outerHashes.push(outerHash);
    active = { envelope: bump, hash: outerHash, envelopeXdr: bump.toXDR(), outerHash };
    await log("bumped", attempt, undefined, {
      envelopeXdr: active.envelopeXdr,
      innerHash,
      outerHash,
      feeOffered,
    });
    return true;
  };

  const lookupAnyFinalized = async () => {
    for (const hash of [innerHash, ...outerHashes]) {
      const result = await lookupFinalized(server, hash);
      if (result) return { result, hash };
    }
    return undefined;
  };

  const finish = async (
    found: { result: Awaited<ReturnType<rpc.Server["getTransaction"]>>; hash: string },
    attempt: number,
  ): Promise<SorobanSubmitResult> => {
    const extra = {
      innerHash,
      feeCharged: feeChargedOf(found.result),
      ...(found.hash !== innerHash && { outerHash: found.hash }),
    };
    if (found.result.status === "SUCCESS") {
      await log("confirmed", attempt, undefined, extra);
      return found.result;
    }
    const error = makeError(found.result, innerHash);
    const detail = error.classification.kind === "archived_entry"
      ? "footprint entry archived before apply; re-simulate the action"
      : "transaction finalized with FAILED status";
    await log("failed", attempt, detail, extra);
    throw error;
  };

  await log("signed");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await beforeSend?.(active.hash, attempt);
    } catch (error) {
      const fenced = error instanceof Error && error.name === "FenceLostError";
      if (fenced) {
        const fence = (error as Error & { fence?: { name: string; epoch: bigint } }).fence;
        await log("fenced", attempt, errorMessage(error), fence
          ? { fence: { name: fence.name, epoch: fence.epoch.toString() } }
          : {});
      } else {
        await log("cancelled", attempt, errorMessage(error));
      }
      throw error;
    }
    await log("submitting", attempt);
    let sendResponse: Awaited<ReturnType<typeof server.sendTransaction>> | undefined;
    try {
      sendResponse = await server.sendTransaction(active.envelope);
    } catch (error) {
      lastError = error;
      if (isFeeError(error) && await tryBump(attempt)) {
        if (attempt < maxAttempts) await sleep(retryDelayMs);
        continue;
      }
      const final = await lookupAnyFinalized();
      if (final) return await finish(final, attempt);
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      break;
    }

    if (sendResponse.status === "ERROR") {
      lastError = sendResponse.errorResult ?? sendResponse;
      const classification = classifySorobanError(lastError);
      if (classification.kind === "fee" && await tryBump(attempt)) {
        if (attempt < maxAttempts) await sleep(retryDelayMs);
        continue;
      }
      await log("failed", attempt, classification.message);
      throw new SorobanSubmissionError(`Soroban RPC rejected transaction ${innerHash}: ${classification.message}`, classification, {
        cause: lastError,
        transactionHash: innerHash,
      });
    }

    if (sendResponse.status === "PENDING" || sendResponse.status === "DUPLICATE") {
      if (!replacement) await log("submitted", attempt, sendResponse.status);
      let missedPolls = 0;
      for (let poll = 0; poll < maxPollsPerAttempt; poll += 1) {
        if (poll > 0 || retryDelayMs > 0) await sleep(retryDelayMs);
        try {
          const found = await lookupAnyFinalized();
          if (found) return await finish(found, attempt);
          missedPolls += 1;
        } catch (error) {
          if (error instanceof SorobanSubmissionError) throw error;
          lastError = error;
        }
      }
      if (replacement && missedPolls >= replacement.afterPolls && await tryBump(attempt)) {
        if (attempt < maxAttempts) await sleep(retryDelayMs);
        continue;
      }
    } else {
      lastError = new Error(`Soroban RPC returned ${sendResponse.status}`);
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  await log("uncertain", maxAttempts, lastError === undefined ? undefined : errorMessage(lastError));
  throw new SorobanPendingError(
    `Transaction ${innerHash} was not confirmed after ${maxAttempts} bounded submission attempts; its signed envelope may still land. Resume by resending the same envelope or checking this hash.`,
    innerHash,
    { cause: lastError },
  );
}

export function transactionFromJournal(
  envelopeXdr: string,
  networkPassphrase: string,
): Transaction {
  return new Transaction(envelopeXdr, networkPassphrase);
}

export function journaledHashes(id: string, records: readonly TransactionJournalRecord[]): string[] {
  const hashes: string[] = [];
  for (const record of records) {
    if (record.id !== id) continue;
    if (!hashes.includes(record.hash)) hashes.push(record.hash);
    if (record.outerHash && !hashes.includes(record.outerHash)) hashes.push(record.outerHash);
  }
  return hashes;
}

async function lookupFinalized(
  server: Pick<rpc.Server, "getTransaction">,
  hash: string,
): Promise<Awaited<ReturnType<rpc.Server["getTransaction"]>> | undefined> {
  try {
    const result = await server.getTransaction(hash);
    return result.status === "NOT_FOUND" ? undefined : result;
  } catch {
    return undefined;
  }
}
