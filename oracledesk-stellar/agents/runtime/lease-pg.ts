import pg from "pg";
import {
  FenceLostError,
  type Fence,
  type FencedLease,
} from "./lease.js";

export interface PostgresLeaseOptions {
  connectionString: string;
  ttlMs: number;
  heartbeatMs: number;
  holder?: string;
  name?: string;
  now?: () => number;
}

export class LeaseHeldErrorPg extends Error {
  constructor(readonly name: string) {
    super(`lease held: ${name}`);
    this.name = "LeaseHeldError";
  }
}

export class PostgresLease implements FencedLease {
  onLost?: (reason: string) => void;
  private readonly pool: pg.Pool;
  private readonly holder: string;
  private heldFence: Fence | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly name: string;

  constructor(private readonly o: PostgresLeaseOptions) {
    this.pool = new pg.Pool({ connectionString: o.connectionString });
    this.holder = o.holder ?? `${process.pid}@${process.env.HOSTNAME ?? "localhost"}:${cryptoRandom()}`;
    this.name = o.name ?? "agent";
  }

  async acquire(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS agent_leases (
      name text PRIMARY KEY,
      epoch bigint NOT NULL,
      holder text NOT NULL,
      expires_at timestamptz NOT NULL,
      inflight_hash text
    )`);
    const ttlSeconds = Math.max(1, Math.ceil(this.o.ttlMs / 1000));
    const result = await this.pool.query(
      `INSERT INTO agent_leases(name, epoch, holder, expires_at, inflight_hash)
       VALUES ($1, 1, $2, now() + ($3::int * interval '1 second'), NULL)
       ON CONFLICT (name) DO UPDATE SET
         epoch = agent_leases.epoch + 1,
         holder = $2,
         expires_at = now() + ($3::int * interval '1 second'),
         inflight_hash = NULL
       WHERE agent_leases.expires_at < now()
       RETURNING epoch, inflight_hash`,
      [this.name, this.holder, ttlSeconds],
    );
    if (result.rowCount !== 1) throw new LeaseHeldErrorPg(this.name);
    this.heldFence = { name: this.name, epoch: BigInt(result.rows[0].epoch) };
    this.timer = setInterval(() => void this.heartbeat(), this.o.heartbeatMs);
  }

  current(): Fence | undefined {
    return this.heldFence;
  }

  async assertHeld(f: Fence): Promise<void> {
    const result = await this.pool.query(
      `SELECT epoch, expires_at > now() AS live
       FROM agent_leases WHERE name = $1`,
      [f.name],
    );
    if (result.rowCount !== 1) throw new FenceLostError(f);
    const row = result.rows[0];
    if (!row.live || BigInt(row.epoch) !== f.epoch) {
      throw new FenceLostError(f, { name: f.name, epoch: BigInt(row.epoch) });
    }
  }

  async heartbeat(): Promise<void> {
    if (!this.heldFence) return;
    const ttlSeconds = Math.max(1, Math.ceil(this.o.ttlMs / 1000));
    const result = await this.pool.query(
      `UPDATE agent_leases SET expires_at = now() + ($3::int * interval '1 second')
       WHERE name = $1 AND epoch = $2 AND holder = $4`,
      [this.name, this.heldFence.epoch.toString(), ttlSeconds, this.holder],
    );
    if (result.rowCount !== 1) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.heldFence = undefined;
      this.onLost?.("postgres lease expired or replaced");
    }
  }

  async noteInflight(f: Fence, hash: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE agent_leases SET inflight_hash = $3
       WHERE name = $1 AND epoch = $2`,
      [f.name, f.epoch.toString(), hash],
    );
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.heldFence) return;
    await this.pool.query(
      `DELETE FROM agent_leases WHERE name = $1 AND epoch = $2 AND holder = $3`,
      [this.name, this.heldFence.epoch.toString(), this.holder],
    );
    this.heldFence = undefined;
  }

  unref(): void {
    this.timer?.unref();
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2);
}
