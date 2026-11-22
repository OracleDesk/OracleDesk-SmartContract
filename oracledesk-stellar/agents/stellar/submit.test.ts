import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Account, Asset, Keypair, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { TransactionJournal } from "./journal.js";
import { journaledHashes, submitSorobanTransaction, transactionFromJournal } from "./submit.js";
import { SorobanPendingError, SorobanSubmissionError } from "./errors.js";

function makeTransaction(): Transaction {
  return {
    toXDR: () => "signed-envelope-xdr",
    hash: () => Buffer.from("ab".repeat(32), "hex"),
  } as unknown as Transaction;
}

function makeSuccess(hash: string) {
  return { status: "SUCCESS", txHash: hash } as never;
}

function makeNotFound(hash: string) {
  return { status: "NOT_FOUND", txHash: hash } as never;
}

function makeJournalPath(): string {
  return join(process.cwd(), `.transaction-submit-${randomUUID()}.jsonl`);
}

test("bounded retries resend the exact transaction and eventually confirm it", async () => {
  const path = makeJournalPath();
  const journal = new TransactionJournal(path);
  const transaction = makeTransaction();
  const sent: Transaction[] = [];
  let polls = 0;
  const server = {
    async sendTransaction(tx: Transaction) {
      sent.push(tx);
      return { status: sent.length === 1 ? "TRY_AGAIN_LATER" : "PENDING", hash: "ab".repeat(32) } as never;
    },
    async getTransaction() {
      polls += 1;
      return polls === 1 ? makeNotFound("ab".repeat(32)) : makeSuccess("ab".repeat(32));
    },
  };
  try {
    const result = await submitSorobanTransaction({
      id: "trade-1",
      transaction,
      server,
      journal,
      maxAttempts: 3,
      maxPollsPerAttempt: 2,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    assert.equal(result.status, "SUCCESS");
    assert.equal(sent.length, 2);
    assert.ok(sent.every((tx) => tx === transaction));
    assert.deepEqual((await journal.readAll()).map(({ stage }) => stage), [
      "signed",
      "submitting",
      "submitting",
      "submitted",
      "confirmed",
    ]);
  } finally {
    await rm(path, { force: true });
  }
});

test("submission exhaustion reports that the signed hash may still land", async () => {
  const path = makeJournalPath();
  const journal = new TransactionJournal(path);
  const tx = makeTransaction();
  const sent: Transaction[] = [];
  const server = {
    async sendTransaction(transaction: Transaction) {
      sent.push(transaction);
      throw new Error("connection reset");
    },
    async getTransaction() {
      return makeNotFound("ab".repeat(32));
    },
  };
  try {
    await assert.rejects(
      submitSorobanTransaction({
        id: "trade-2",
        transaction: tx,
        server,
        journal,
        maxAttempts: 2,
        retryDelayMs: 0,
        sleep: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof SorobanPendingError &&
        error.transactionHash === "ab".repeat(32) &&
        /may still land/.test(error.message),
    );
    assert.equal(sent.length, 2);
    assert.ok(sent.every((sentTx) => sentTx === tx));
    assert.equal((await journal.readAll()).at(-1)?.stage, "uncertain");
  } finally {
    await rm(path, { force: true });
  }
});

test("finalized failures are not retried", async () => {
  const path = makeJournalPath();
  const journal = new TransactionJournal(path);
  let sends = 0;
  const server = {
    async sendTransaction() {
      sends += 1;
      return { status: "PENDING", hash: "ab".repeat(32) } as never;
    },
    async getTransaction() {
      return { status: "FAILED", txHash: "ab".repeat(32) } as never;
    },
  };
  try {
    await assert.rejects(
      submitSorobanTransaction({
        id: "trade-3",
        transaction: makeTransaction(),
        server,
        journal,
        maxAttempts: 3,
        maxPollsPerAttempt: 1,
        retryDelayMs: 0,
      }),
      (error: unknown) =>
        error instanceof SorobanSubmissionError &&
        error.transactionHash === "ab".repeat(32) &&
        error.classification.terminal,
    );
    assert.equal(sends, 1);
    assert.equal((await journal.readAll()).at(-1)?.stage, "failed");
  } finally {
    await rm(path, { force: true });
  }
});

test("contract failures reported during send are terminal and are not retried", async () => {
  const path = makeJournalPath();
  const journal = new TransactionJournal(path);
  let sends = 0;
  const server = {
    async sendTransaction() {
      sends += 1;
      return { status: "ERROR", errorResult: "HostError: contract invocation failed" } as never;
    },
    async getTransaction() {
      return makeNotFound("ab".repeat(32));
    },
  };
  try {
    await assert.rejects(
      submitSorobanTransaction({
        id: "trade-contract-failure",
        transaction: makeTransaction(),
        server,
        journal,
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
      (error: unknown) =>
        error instanceof SorobanSubmissionError &&
        error.classification.kind === "contract" &&
        error.classification.terminal,
    );
    assert.equal(sends, 1);
    assert.equal((await journal.readAll()).at(-1)?.stage, "failed");
  } finally {
    await rm(path, { force: true });
  }
});

test("a fee bump keeps the inner transaction and journals both hashes", async () => {
  const path = makeJournalPath();
  const journal = new TransactionJournal(path);
  const inner = makeTransaction() as Transaction & { fee: string; operations: unknown[] };
  Object.assign(inner, { fee: "100", operations: [{}] });
  const outerHash = "cd".repeat(32);
  const bump = {
    fee: "1000",
    hash: () => Buffer.from(outerHash, "hex"),
    toXDR: () => "fee-bump-envelope-xdr",
  } as unknown as Transaction;
  const sent: Transaction[] = [];
  let bumpAttempt = 0;
  const server = {
    async sendTransaction(tx: Transaction) {
      sent.push(tx);
      return sent.length === 1
        ? ({ status: "ERROR", errorResult: "tx_insufficient_fee" } as never)
        : ({ status: "PENDING", hash: outerHash } as never);
    },
    async getTransaction(hash: string) {
      return hash === outerHash ? makeSuccess(hash) : makeNotFound("ab".repeat(32));
    },
  };
  try {
    const result = await submitSorobanTransaction({
      id: "fee-bump-1",
      transaction: inner,
      server,
      journal,
      maxAttempts: 3,
      maxPollsPerAttempt: 1,
      retryDelayMs: 0,
      sleep: async () => undefined,
      replacement: {
        afterPolls: 1,
        maxBumps: 1,
        bump: (_tx, attempt) => {
          bumpAttempt = attempt;
          return bump as never;
        },
      },
    });
    assert.equal(result.status, "SUCCESS");
    assert.equal(sent[0], inner);
    assert.equal(sent[1], bump);
    assert.equal(bumpAttempt, 1);
    const records = await journal.readAll();
    assert.deepEqual(records.map(({ stage }) => stage), ["signed", "submitting", "bumped", "submitting", "confirmed"]);
    assert.equal(records.find((r) => r.stage === "bumped")?.outerHash, outerHash);
    assert.deepEqual(journaledHashes("fee-bump-1", records), ["ab".repeat(32), outerHash]);
  } finally {
    await rm(path, { force: true });
  }
});

test("journal recovery restores the exact signed XDR", () => {
  const passphrase = "Test SDF Network ; September 2015";
  const keypair = Keypair.random();
  const transaction = new TransactionBuilder(new Account(keypair.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        destination: keypair.publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
  transaction.sign(keypair);
  const envelopeXdr = transaction.toXDR();
  assert.equal(transactionFromJournal(envelopeXdr, passphrase).toXDR(), envelopeXdr);
});
