/**
 * Single-instance lease. Two agents on one source account race on the
 * sequence number and double-spend the treasury's daily budget, so only the
 * lease holder may run.
 *
 * `FileLease` creates the lock file exclusively (`open(path, "wx")`) with
 * `{pid, host, startedAt, heartbeatAt}` and rewrites it every heartbeat. An
 * existing lock is taken over only when it is stale: its heartbeat is older
 * than the TTL AND its owner is provably gone — on this host, the PID is not
 * alive or was started before the last boot (PID reuse); on another host,
 * the stale heartbeat alone decides. Takeover is an atomic rename followed
 * by a read-back, so of two racing takers exactly one wins.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { dirname } from "node:path";

export interface Lease {
  acquire(): Promise<void>;
  release(): Promise<void>;
  /** Called if the lease is lost while held (another process took it). */
  onLost?: (reason: string) => void;
}

export interface LeaseRecord {
  pid: number;
  host: string;
  startedAt: number;
  heartbeatAt: number;
  /** Random per-acquisition token, so a reused PID is never mistaken for us. */
  token: string;
}

export class LeaseHeldError extends Error {
  constructor(readonly holder: LeaseRecord) {
    super(`lease held by pid ${holder.pid} on ${holder.host} (heartbeat ${new Date(holder.heartbeatAt).toISOString()})`);
    this.name = "LeaseHeldError";
  }
}

export interface FileLeaseOptions {
  ttlMs: number;
  heartbeatMs: number;
  pid?: number;
  host?: string;
  now?: () => number;
  /** Whether `pid` is a live process on this host. */
  isAlive?: (pid: number) => boolean;
  /** Unix ms of this host's last boot. */
  bootTime?: () => number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileLease implements Lease {
  onLost?: (reason: string) => void;
  private record: LeaseRecord | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly pid: number;
  private readonly host: string;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly bootTime: () => number;

  constructor(
    readonly path: string,
    private readonly o: FileLeaseOptions,
  ) {
    this.pid = o.pid ?? process.pid;
    this.host = o.host ?? hostname();
    this.now = o.now ?? Date.now;
    this.isAlive = o.isAlive ?? processAlive;
    this.bootTime = o.bootTime ?? (() => Date.now() - uptime() * 1000);
  }

  get held(): boolean {
    return this.record !== undefined;
  }

  private fresh(): LeaseRecord {
    const t = this.now();
    return { pid: this.pid, host: this.host, startedAt: t, heartbeatAt: t, token: randomBytes(8).toString("hex") };
  }

  private async read(): Promise<LeaseRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as LeaseRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A torn/garbled lock counts as stale: its writer never finished.
      if (err instanceof SyntaxError) return { pid: -1, host: "", startedAt: 0, heartbeatAt: 0, token: "" };
      throw err;
    }
  }

  /** Whether `r`'s owner is provably gone. */
  private stale(r: LeaseRecord): boolean {
    if (this.now() - r.heartbeatAt <= this.o.ttlMs) return false;
    if (r.host !== this.host) return true;
    if (r.startedAt < this.bootTime()) return true; // started before the last boot: PID reused
    return !this.isAlive(r.pid);
  }

  private async replace(r: LeaseRecord): Promise<void> {
    const tmp = `${this.path}.${this.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const mine = this.fresh();
    try {
      const fh = await open(this.path, "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify(mine));
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await this.read();
      if (holder && !this.stale(holder)) throw new LeaseHeldError(holder);
      await this.replace(mine);
      const check = await this.read();
      if (check?.token !== mine.token) throw new LeaseHeldError(check ?? mine);
    }
    this.record = mine;
    this.timer = setInterval(() => void this.heartbeat(), this.o.heartbeatMs);
  }

  /** Rewrites the heartbeat; reports loss if someone else now holds the file. */
  async heartbeat(): Promise<void> {
    if (!this.record) return;
    const current = await this.read().catch(() => undefined);
    if (current?.token !== this.record.token) {
      this.stopTimer();
      this.record = undefined;
      this.onLost?.(current ? `taken over by pid ${current.pid} on ${current.host}` : "lock file removed");
      return;
    }
    this.record = { ...this.record, heartbeatAt: this.now() };
    await this.replace(this.record).catch(() => {});
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Lets the process exit even if the heartbeat is still scheduled. */
  unref(): void {
    this.timer?.unref();
  }

  async release(): Promise<void> {
    this.stopTimer();
    if (!this.record) return;
    const current = await this.read().catch(() => undefined);
    if (current?.token === this.record.token) await unlink(this.path).catch(() => {});
    this.record = undefined;
  }
}

/** No-op lease, for tests and embedding where the caller guarantees exclusivity. */
export class NoLease implements Lease {
  async acquire(): Promise<void> {}
  async release(): Promise<void> {}
}
