/**
 * Persistent per-task state: processed signals, created markets, last
 * evaluated ledger per market, pending traces. In memory, flushed to one
 * JSON file with a debounce and forced after every submission.
 *
 * File shape: `{version: 1, scopes: {<treasury contract id>: {<ns>: {<key>: value}}}}`.
 * Keying by treasury means a testnet redeploy starts from clean state
 * instead of trusting cursors that describe another deployment.
 *
 * Writes are temp file → fsync → rename → fsync(dir): a crash leaves the
 * previous or the new complete file, never a torn one. bigint values are
 * preserved (`{"$bigint": "..."}`).
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

export interface StateStore {
  get<T>(ns: string, key: string): T | undefined;
  set<T>(ns: string, key: string, v: T): void;
  delete(ns: string, key: string): void;
  /** All entries of a namespace, sorted by key. */
  entries<T>(ns: string): [string, T][];
  flush(): Promise<void>;
}

type Data = Record<string, Record<string, unknown>>;

const encode = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x));
const decode = (s: string) =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$bigint === "string" && Object.keys(x).length === 1 ? BigInt(x.$bigint) : x));

class Namespaces {
  protected data: Data = {};

  get<T>(ns: string, key: string): T | undefined {
    return this.data[ns]?.[key] as T | undefined;
  }

  set<T>(ns: string, key: string, v: T): void {
    (this.data[ns] ??= {})[key] = v;
    this.changed();
  }

  delete(ns: string, key: string): void {
    if (this.data[ns] && key in this.data[ns]!) {
      delete this.data[ns]![key];
      this.changed();
    }
  }

  entries<T>(ns: string): [string, T][] {
    return Object.entries(this.data[ns] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, T][];
  }

  protected changed(): void {}
}

/** Non-durable store (dry-run, tests). */
export class MemoryStateStore extends Namespaces implements StateStore {
  async flush(): Promise<void> {}
}

export interface FileStateStoreOptions {
  /** Scope key, normally the treasury contract id. */
  scope: string;
  debounceMs?: number;
  /** Test seam: replaces the rename step. */
  rename?: (from: string, to: string) => Promise<void>;
}

export class FileStateStore extends Namespaces implements StateStore {
  private other: Record<string, Data> = {};
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly scope: string;
  private readonly debounceMs: number;
  private readonly renameFn: (from: string, to: string) => Promise<void>;

  constructor(
    private readonly path: string,
    opts: FileStateStoreOptions,
  ) {
    super();
    this.scope = opts.scope;
    this.debounceMs = opts.debounceMs ?? 250;
    this.renameFn = opts.rename ?? rename;
  }

  /** Loads the file (missing = empty). Rejects an unknown version. */
  async load(): Promise<this> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this;
      throw err;
    }
    const parsed = decode(text) as { version: number; scopes: Record<string, Data> };
    if (parsed.version !== STATE_VERSION) throw new Error(`${this.path}: unsupported state version ${parsed.version}`);
    const { [this.scope]: mine, ...rest } = parsed.scopes ?? {};
    this.data = mine ?? {};
    this.other = rest;
    return this;
  }

  protected override changed(): void {
    this.dirty = true;
    if (this.timer || this.debounceMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, this.debounceMs);
    this.timer.unref();
  }

  /** Writes now if anything changed; serialized with any write in progress. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writing = this.writing.catch(() => {}).then(() => (this.dirty ? this.write() : undefined));
    return this.writing;
  }

  private async write(): Promise<void> {
    this.dirty = false;
    const body = encode({ version: STATE_VERSION, scopes: { ...this.other, [this.scope]: this.data } });
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(body + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await this.renameFn(tmp, this.path);
    } catch (err) {
      this.dirty = true;
      await unlink(tmp).catch(() => {});
      throw err;
    }
    try {
      const dh = await open(dir, "r");
      await dh.sync().finally(() => dh.close());
    } catch (err) {
      // Windows cannot fsync a directory handle; the rename is already durable there.
      if (process.platform !== "win32") throw err;
    }
  }
}
