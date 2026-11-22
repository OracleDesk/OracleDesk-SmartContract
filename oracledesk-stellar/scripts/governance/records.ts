import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallIntent } from "./encode.js";
import type { SimulationSummary } from "./simulate.js";

export type ProposalStatus = "draft" | "scheduled" | "executed" | "cancelled" | "expired";

export interface ProposalRecord {
  schema: 1;
  id: string;
  network: "local" | "testnet";
  timelock: string;
  title: string;
  intent: CallIntent;
  argsXdr: string[];
  argsVecXdr: string;
  argsEcho: unknown;
  simulation: SimulationSummary;
  status: ProposalStatus;
  eta?: string;
  expires?: string;
  scheduleTx?: string;
  executeTx?: string;
  cancelTx?: string;
  opHash?: string;
  opHashSource?: "local-preview" | "hook";
  batchId?: string;
  batchIndex?: number;
  predecessors?: number[];
  error?: string;
}

export function proposalDir(network: string, root = process.cwd()): string {
  return resolve(root, "governance", "proposals", network);
}

function recordPath(network: string, id: string): string {
  return join(proposalDir(network), `${id}.json`);
}

export function newDraftId(): string {
  return `draft-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function saveRecord(record: ProposalRecord): string {
  const path = recordPath(record.network, record.id);
  mkdirSync(proposalDir(record.network), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function loadRecord(network: string, id: string): ProposalRecord {
  const path = recordPath(network, id);
  if (!existsSync(path)) throw new Error(`no proposal record at ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as ProposalRecord;
}

export function listRecords(network: string): ProposalRecord[] {
  const dir = proposalDir(network);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ProposalRecord);
}

export function finalizeDraft(
  network: string,
  draftId: string,
  id: string,
  patch: Partial<ProposalRecord>,
): ProposalRecord {
  const record = { ...loadRecord(network, draftId), ...patch, id } as ProposalRecord;
  const path = saveRecord(record);
  if (draftId !== id) renameSync(recordPath(network, draftId), path);
  return record;
}

/** Stable topological order for client-side batches; stops on a cycle. */
export function batchOrder(records: ProposalRecord[]): ProposalRecord[] {
  const byIndex = new Map(records.map((r) => [r.batchIndex, r]));
  const done = new Set<number>();
  const order: ProposalRecord[] = [];
  while (order.length < records.length) {
    const next = records.find(
      (r) =>
        !done.has(r.batchIndex!) &&
        (r.predecessors ?? []).every((p) => done.has(p)),
    );
    if (!next) throw new Error("batch has a dependency cycle");
    order.push(next);
    done.add(next.batchIndex!);
  }
  if (byIndex.size !== records.length) throw new Error("batch has duplicate indices");
  return order;
}
