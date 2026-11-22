/**
 * Durable storage for resolution specs the market-maker has committed to,
 * and the recovery loop that guarantees each one is eventually revealed.
 *
 * A market's `resolution_hash` is fixed at creation and only the stored
 * spec reproduces it, so losing the spec between `agent_create_market` and
 * `register_*_spec` makes the market permanently unresolvable. The store is
 * therefore written (fsync + atomic rename) BEFORE the create transaction
 * exists, and its directory (`AGENT_SPEC_DIR`, default `./.specs`) must be
 * backed up — `SPEC_BACKUP_CMD` runs after every write for that.
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeSpec, type SpecJson } from "./spec.js";

export interface StoredSpec {
  /** Unique per create attempt: the same spec may be committed to by
   * several markets, so the commitment alone is not a key. */
  id: string;
  commitment: string;
  spec: SpecJson;
  questionHash: string;
  state: "pending_create" | "created" | "revealed" | "abandoned";
  marketId?: string;
  createdTx?: string;
  /** close_time sent with the create, so recovery can match it exactly. */
  closeTime?: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface SpecStore {
  put(s: StoredSpec): Promise<void>;
  byCommitment(h: string): Promise<StoredSpec | undefined>;
  list(state?: StoredSpec["state"]): Promise<StoredSpec[]>;
}

export function newStoredSpec(args: {
  commitment: string;
  spec: SpecJson;
  questionHash: string;
  closeTime?: bigint;
  now?: number;
}): StoredSpec {
  const now = args.now ?? Date.now();
  return {
    id: `${now}-${randomBytes(4).toString("hex")}`,
    commitment: args.commitment,
    spec: canonicalizeSpec(args.spec),
    questionHash: args.questionHash,
    state: "pending_create",
    closeTime: args.closeTime?.toString(),
    createdAt: now,
    updatedAt: now,
  };
}

function pickByCommitment(all: StoredSpec[], h: string): StoredSpec | undefined {
  const matches = all.filter((s) => s.commitment === h);
  matches.sort((a, b) => Number(a.state === "abandoned") - Number(b.state === "abandoned") || b.updatedAt - a.updatedAt);
  return matches[0];
}

/** Non-durable store for dry-run and tests. */
export class MemorySpecStore implements SpecStore {
  private readonly entries = new Map<string, StoredSpec>();

  async put(s: StoredSpec): Promise<void> {
    this.entries.set(s.id, structuredClone(s));
  }

  async byCommitment(h: string): Promise<StoredSpec | undefined> {
    return pickByCommitment(await this.list(), h);
  }

  async list(state?: StoredSpec["state"]): Promise<StoredSpec[]> {
    return [...this.entries.values()].filter((s) => !state || s.state === state).map((s) => structuredClone(s));
  }
}

export interface FileSpecStoreOptions {
  /** Shell command run after each put (e.g. `rclone copy .specs remote:specs`).
   * Gets `SPEC_DIR` and `SPEC_FILE` in its environment. */
  backupCmd?: string;
  /** Test seam: replaces the rename step. */
  rename?: (from: string, to: string) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * One JSON file per create attempt, `<dir>/<commitment>.<id>.json`, written
 * as temp file → fsync → rename → fsync(dir). A crash at any point leaves
 * either the previous complete file or the new complete file, never a
 * partial one; stray `*.tmp` files are ignored.
 */
export class FileSpecStore implements SpecStore {
  private readonly renameFn: (from: string, to: string) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly dir: string,
    private readonly opts: FileSpecStoreOptions = {},
  ) {
    this.renameFn = opts.rename ?? rename;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  private fileFor(s: StoredSpec): string {
    if (!/^[0-9a-f]{64}$/.test(s.commitment)) throw new Error(`bad commitment ${s.commitment}`);
    if (!/^[A-Za-z0-9-]+$/.test(s.id)) throw new Error(`bad spec id ${s.id}`);
    return join(this.dir, `${s.commitment}.${s.id}.json`);
  }

  async put(s: StoredSpec): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const final = this.fileFor(s);
    const tmp = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(JSON.stringify(s, null, 2) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await this.renameFn(tmp, final);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await this.syncDir();
    await this.backup(final);
  }

  private async syncDir(): Promise<void> {
    try {
      const dh = await open(this.dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch (err) {
      // Windows cannot open/fsync a directory; the rename itself is durable
      // there (MoveFileEx with write-through is what libuv uses).
      if (process.platform !== "win32") throw err;
    }
  }

  private async backup(file: string): Promise<void> {
    if (!this.opts.backupCmd) return;
    await new Promise<void>((resolve) => {
      exec(this.opts.backupCmd!, { env: { ...process.env, SPEC_DIR: this.dir, SPEC_FILE: file } }, (err) => {
        if (err) this.log(`[spec-store] WARNING: SPEC_BACKUP_CMD failed for ${file}: ${err.message}`);
        resolve();
      });
    });
  }

  async byCommitment(h: string): Promise<StoredSpec | undefined> {
    return pickByCommitment(await this.list(), h);
  }

  async list(state?: StoredSpec["state"]): Promise<StoredSpec[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: StoredSpec[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.[A-Za-z0-9-]+\.json$/.test(name)) continue;
      // Final files are only ever produced by rename, so a parse failure is
      // corruption, not a torn write: surface it rather than skip a spec.
      const s = JSON.parse(await readFile(join(this.dir, name), "utf8")) as StoredSpec;
      if (!state || s.state === state) out.push(s);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}

// --- recovery ---------------------------------------------------------------

export interface ChainMarketView {
  creator: string;
  questionHash: string;
  resolutionHash: string;
  closeTime: bigint;
}

/** What recovery needs from the chain; implemented over StellarAdapter. */
export interface RecoveryChain {
  marketCount(): Promise<bigint>;
  getMarket(id: bigint): Promise<ChainMarketView | undefined>;
  /** True once any spec is registered for the market. Price reveals leave
   * `state()` at Unconfigured, so this must also check the spec entry. */
  isRevealed(id: bigint): Promise<boolean>;
  /** register_signer_spec / register_price_spec; throws on failure. */
  reveal(id: bigint, spec: SpecJson): Promise<void>;
}

/** The resolver's `MarketAlreadyConfigured` (#4), however the SDK surfaced it. */
export function isMarketAlreadyConfigured(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /MarketAlreadyConfigured|Error\(Contract, #4\)/.test(msg);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reveals `entry` for its (already known) market and records the outcome.
 * Someone else may reveal first — reveal is permissionless — so
 * `MarketAlreadyConfigured` counts as success once the market's on-chain
 * commitment is confirmed to be ours.
 */
export async function revealStored(
  store: SpecStore,
  chain: RecoveryChain,
  entry: StoredSpec,
  now = Date.now(),
): Promise<StoredSpec> {
  const id = BigInt(entry.marketId!);
  const market = await chain.getMarket(id);
  if (!market) throw new Error(`market ${id} not found for spec ${entry.id}`);
  if (market.resolutionHash !== entry.commitment) {
    throw new Error(`market ${id} commits to ${market.resolutionHash}, not stored spec ${entry.commitment}`);
  }
  if (!(await chain.isRevealed(id))) {
    try {
      await chain.reveal(id, entry.spec);
    } catch (err) {
      if (!isMarketAlreadyConfigured(err)) throw err;
    }
  }
  const revealed: StoredSpec = { ...entry, state: "revealed", updatedAt: now, lastError: undefined };
  await store.put(revealed);
  return revealed;
}

export interface RecoveryOptions {
  store: SpecStore;
  chain: RecoveryChain;
  /** Address markets are created by (the treasury contract). */
  creator: string;
  /** Abandon a pending_create with no matching market after this long. */
  pendingTtlSecs: number;
  /** Most recent market ids to scan for pending_create matches. */
  maxScan?: number;
  /** Warn loudly about created-but-unrevealed markets older than this. */
  staleRevealSecs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RecoveryReport {
  revealed: string[];
  abandoned: string[];
  stillPending: string[];
  failed: string[];
}

/**
 * Drives every non-terminal stored spec forward: `created` entries are
 * revealed if their market is still unconfigured; `pending_create` entries
 * are matched to a market by scanning the newest ids for
 * `resolution_hash == commitment && creator == treasury && question_hash`
 * (and `close_time` when recorded), each market claimed at most once, then
 * revealed — or marked `abandoned` (file kept) once older than the TTL.
 * Never throws for a single entry; failures are reported and retried next run.
 */
export async function recoverSpecs(opts: RecoveryOptions): Promise<RecoveryReport> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m) => console.log(m));
  const maxScan = BigInt(opts.maxScan ?? 200);
  const staleMs = (opts.staleRevealSecs ?? 600) * 1000;
  const report: RecoveryReport = { revealed: [], abandoned: [], stillPending: [], failed: [] };
  const all = await opts.store.list();
  const claimed = new Set(all.filter((s) => s.marketId !== undefined).map((s) => s.marketId!));

  const tryReveal = async (entry: StoredSpec) => {
    try {
      await revealStored(opts.store, opts.chain, entry, now());
      report.revealed.push(entry.id);
      log(`[recovery] revealed spec ${entry.commitment} for market ${entry.marketId}`);
    } catch (err) {
      report.failed.push(entry.id);
      await opts.store.put({ ...entry, lastError: errorText(err), updatedAt: now() });
      const age = now() - entry.createdAt;
      const loud = age > staleMs ? "ALERT: market still UNREVEALED after " + Math.round(age / 60_000) + " min — " : "";
      console.error(`[recovery] ${loud}reveal failed for market ${entry.marketId} (spec ${entry.id}): ${errorText(err)}`);
    }
  };

  for (const entry of all.filter((s) => s.state === "created")) await tryReveal(entry);

  const pending = all.filter((s) => s.state === "pending_create");
  if (pending.length === 0) return report;

  const count = await opts.chain.marketCount();
  const floor = count > maxScan ? count - maxScan : 0n;
  const markets = new Map<bigint, ChainMarketView | undefined>();
  const marketAt = async (id: bigint) => {
    if (!markets.has(id)) markets.set(id, await opts.chain.getMarket(id));
    return markets.get(id);
  };

  for (const entry of pending) {
    let found: bigint | undefined;
    try {
      const minClose = BigInt(Math.floor(entry.createdAt / 1000));
      for (let id = count - 1n; id >= floor; id--) {
        if (claimed.has(id.toString())) continue;
        const m = await marketAt(id);
        if (!m) continue;
        const closeOk = entry.closeTime !== undefined ? m.closeTime === BigInt(entry.closeTime) : m.closeTime >= minClose;
        if (
          m.resolutionHash === entry.commitment &&
          m.creator === opts.creator &&
          m.questionHash === entry.questionHash &&
          closeOk
        ) {
          found = id;
          break;
        }
      }
    } catch (err) {
      report.failed.push(entry.id);
      console.error(`[recovery] scan failed for pending spec ${entry.id}: ${errorText(err)}`);
      continue;
    }

    if (found !== undefined) {
      claimed.add(found.toString());
      const created: StoredSpec = { ...entry, state: "created", marketId: found.toString(), updatedAt: now() };
      await opts.store.put(created);
      log(`[recovery] pending spec ${entry.id} matched market ${found}`);
      await tryReveal(created);
    } else if (now() - entry.createdAt > opts.pendingTtlSecs * 1000) {
      await opts.store.put({ ...entry, state: "abandoned", updatedAt: now() });
      report.abandoned.push(entry.id);
      log(`[recovery] abandoned pending spec ${entry.id}: no market after ${opts.pendingTtlSecs}s`);
    } else {
      report.stillPending.push(entry.id);
    }
  }
  return report;
}
