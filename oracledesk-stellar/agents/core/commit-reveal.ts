/**
 * Two-phase commit-reveal execution coordinator for OracleDesk agents (#115).
 *
 * Prevents front-running of public IPFS traces by:
 *   1. Generating a 32-byte salt and computing `commitmentFor(traceHash, salt)`
 *      on-chain BEFORE any trace payload is uploaded to IPFS.
 *   2. Persisting pending `{ traceHash, saltHex, traceJson, marketId, committedAt }`
 *      records in an atomic crash-safe store (`0600` permissions) so a crashed
 *      agent never loses an unrevealed salt.
 *   3. Waiting until the configurable reveal delay (`minRevealDelaySecs` or
 *      `minRevealLedgers`) has elapsed, then pinning the trace to IPFS and
 *      invoking `reveal_trace(agent, commitment, trace_hash, salt, cid)`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildTrace, commitmentFor, newSalt, type ReasoningTrace } from "./trace.js";

export type TracePrivacyMode = "public" | "commit-reveal";

export interface PendingCommitRecord {
  commitmentHex: string;
  traceHashHex: string;
  saltHex: string;
  traceJson: string;
  marketId: number | null;
  action: ReasoningTrace["action"];
  committedAtSec: number;
  committedLedger: number;
  tradeExecuted: boolean;
  revealed: boolean;
  revealedCid?: string;
}

export class PendingCommitStore {
  constructor(private readonly filePath: string) {}

  loadAll(): PendingCommitRecord[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw) as PendingCommitRecord[];
  }

  saveAll(records: PendingCommitRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(records, null, 2), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.filePath);
  }

  upsert(record: PendingCommitRecord): void {
    const all = this.loadAll();
    const idx = all.findIndex((r) => r.commitmentHex === record.commitmentHex);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    this.saveAll(all);
  }

  pendingUnrevealed(): PendingCommitRecord[] {
    return this.loadAll().filter((r) => !r.revealed);
  }
}

export interface CommitRevealChainAdapter {
  commitTrace(params: {
    commitmentHex: string;
    marketId: number | null;
    action: ReasoningTrace["action"];
  }): Promise<void>;

  executeAction(params: {
    commitmentHex: string;
    traceHashHex: string;
  }): Promise<void>;

  pinTraceJson(traceJson: string, traceHashHex: string): Promise<string>;

  revealTrace(params: {
    commitmentHex: string;
    traceHashHex: string;
    saltHex: string;
    cid: string;
  }): Promise<void>;
}

export interface CommitRevealCoordinatorOptions {
  store: PendingCommitStore;
  adapter: CommitRevealChainAdapter;
  minRevealDelaySecs?: number;
  minRevealLedgers?: number;
}

export class CommitRevealCoordinator {
  private readonly minDelaySecs: number;
  private readonly minLedgers: number;

  constructor(private readonly opts: CommitRevealCoordinatorOptions) {
    this.minDelaySecs = opts.minRevealDelaySecs ?? 0;
    this.minLedgers = opts.minRevealLedgers ?? 1;
  }

  /**
   * Phase 1: builds trace in memory, generates a fresh 32-byte salt, persists
   * the pending record to disk BEFORE touching the network, submits
   * `commit_trace` on-chain, and executes the trade without publishing to IPFS.
   */
  async commitAndExecute(
    traceInput: Omit<ReasoningTrace, "timestamp"> & { timestamp?: number },
    nowSec: number,
    currentLedger: number,
    fixedSaltHex?: string,
  ): Promise<PendingCommitRecord> {
    const { trace, json, hash } = buildTrace(traceInput);
    const saltHex = fixedSaltHex ?? newSalt();
    const commitmentHex = commitmentFor(hash, saltHex);

    const record: PendingCommitRecord = {
      commitmentHex,
      traceHashHex: hash,
      saltHex,
      traceJson: json,
      marketId: trace.marketId,
      action: trace.action,
      committedAtSec: nowSec,
      committedLedger: currentLedger,
      tradeExecuted: false,
      revealed: false,
    };

    // Persist salt + trace BEFORE network calls for crash safety
    this.opts.store.upsert(record);

    await this.opts.adapter.commitTrace({
      commitmentHex,
      marketId: trace.marketId,
      action: trace.action,
    });

    await this.opts.adapter.executeAction({
      commitmentHex,
      traceHashHex: hash,
    });

    record.tradeExecuted = true;
    this.opts.store.upsert(record);
    return record;
  }

  /**
   * Phase 2 (also used on startup for crash recovery): scans all unrevealed
   * records, checks whether the reveal window has arrived, pins the trace JSON
   * to IPFS only now, and submits `reveal_trace` on-chain.
   */
  async sweepAndRevealEligible(nowSec: number, currentLedger: number): Promise<PendingCommitRecord[]> {
    const revealedNow: PendingCommitRecord[] = [];
    for (const rec of this.opts.store.pendingUnrevealed()) {
      const elapsedSec = nowSec - rec.committedAtSec;
      const elapsedLedgers = currentLedger - rec.committedLedger;
      if (elapsedSec < this.minDelaySecs || elapsedLedgers < this.minLedgers) {
        continue;
      }

      const cid = await this.opts.adapter.pinTraceJson(rec.traceJson, rec.traceHashHex);
      await this.opts.adapter.revealTrace({
        commitmentHex: rec.commitmentHex,
        traceHashHex: rec.traceHashHex,
        saltHex: rec.saltHex,
        cid,
      });

      rec.revealed = true;
      rec.revealedCid = cid;
      this.opts.store.upsert(rec);
      revealedNow.push(rec);
    }
    return revealedNow;
  }
}
