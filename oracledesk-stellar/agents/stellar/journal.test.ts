import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJournalRecord, TransactionJournal } from "./journal.js";

function journalPath(): string {
  return join(process.cwd(), `.transaction-journal-${randomUUID()}.jsonl`);
}

const record = (id: string, stage: "signed" | "submitted" = "signed") =>
  createJournalRecord({
    id,
    stage,
    hash: "ab".repeat(32),
    envelopeXdr: "signed-envelope-xdr",
  });

test("journal appends durable JSONL records and returns latest state by id", async () => {
  const path = journalPath();
  const journal = new TransactionJournal(path);
  try {
    await journal.append(record("trade-1"));
    await journal.append(record("trade-1", "submitted"));
    await journal.append(record("trade-2"));

    const records = await journal.readAll();
    assert.deepEqual(records.map(({ id, stage }) => [id, stage]), [
      ["trade-1", "signed"],
      ["trade-1", "submitted"],
      ["trade-2", "signed"],
    ]);
    assert.equal((await journal.latestById()).get("trade-1")?.stage, "submitted");
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(path, { force: true });
  }
});

test("journal warns and ignores only a torn final record", async () => {
  const path = journalPath();
  const warnings: string[] = [];
  const journal = new TransactionJournal(path, { warn: (message) => warnings.push(message) });
  try {
    await writeFile(path, `${JSON.stringify(record("trade-1"))}\n{"version":1,"id":"torn"`, "utf8");
    assert.equal((await journal.readAll()).length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /torn final/);
  } finally {
    await rm(path, { force: true });
  }
});

test("journal rejects malformed complete records and repairs a torn tail before appending", async () => {
  const path = journalPath();
  const warnings: string[] = [];
  const journal = new TransactionJournal(path, { warn: (message) => warnings.push(message) });
  try {
    await writeFile(path, `${JSON.stringify(record("trade-1"))}\nnot-json\n`, "utf8");
    await assert.rejects(journal.readAll(), /invalid transaction journal record at line 2/);

    await writeFile(path, `${JSON.stringify(record("trade-1"))}\n{"broken":`, "utf8");
    await journal.append(record("trade-2"));
    assert.deepEqual((await journal.readAll()).map(({ id }) => id), ["trade-1", "trade-2"]);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(path, { force: true });
  }
});
