import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./log.js";
import type { StateStore } from "./state.js";

export type KillCode = "operator" | "risk" | "errors" | "drawdown";

export interface KillReason {
  code: KillCode;
  detail: string;
  at: number;
}

export const KILL_CODES: Record<KillCode, number> = {
  operator: 1,
  risk: 2,
  errors: 3,
  drawdown: 4,
};

export class KilledError extends Error {
  constructor(readonly reason: KillReason) {
    super(`agent killed (${reason.code}): ${reason.detail}`);
    this.name = "KilledError";
  }
}

export interface KillSwitchOptions {
  state: StateStore;
  file: string;
  log: Logger;
  onTrip?: (reason: KillReason) => void | Promise<void>;
}

export const KILL_NS = "killswitch";
export const KILL_REASON_KEY = "reason";
export const KILL_ONCHAIN_KEY = "onchain";

const CODES = new Set<string>(["operator", "risk", "errors", "drawdown"]);
const TRADE_ROLES = 3;
const HALT_RETRY_BASE_MS = 1_000;
const HALT_RETRY_MAX_MS = 60_000;
const haltLoops = new WeakSet<StateStore>();

export interface HaltAdapter {
  mode: "dry-run" | "live";
  agentHalt(reason: number): Promise<{ dryRun: boolean }>;
  getAgent(): Promise<{ active: boolean; roles: number } | undefined>;
}

interface PendingHalt {
  reason: KillReason;
  attempts: number;
  nextAt: number;
}

export interface OnchainHaltOptions {
  state: StateStore;
  log: Logger;
  file: string;
  adapter: () => HaltAdapter | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function defaultStatePath(env: NodeJS.ProcessEnv): string {
  return env.AGENT_STATE_PATH || "./.agent-state/state.json";
}

export function killFilePath(env: NodeJS.ProcessEnv): string {
  return env.AGENT_KILL_FILE || join(dirname(defaultStatePath(env)), "KILLED");
}

export function leaseFilePath(env: NodeJS.ProcessEnv): string {
  return env.AGENT_LEASE_PATH || join(dirname(defaultStatePath(env)), "agent.lock");
}

export function readLeasePid(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const record = JSON.parse(readFileSync(leaseFilePath(env), "utf8")) as { pid?: unknown; host?: unknown };
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
    if (typeof record.host === "string" && record.host !== hostname()) return undefined;
    return record.pid;
  } catch {
    return undefined;
  }
}

function validReason(value: unknown): value is KillReason {
  if (value === null || typeof value !== "object") return false;
  const reason = value as Partial<KillReason>;
  return (
    typeof reason.code === "string" &&
    CODES.has(reason.code) &&
    typeof reason.detail === "string" &&
    typeof reason.at === "number" &&
    Number.isFinite(reason.at)
  );
}

export function startOnchainHalt(o: OnchainHaltOptions): Promise<void> {
  if (haltLoops.has(o.state)) return Promise.resolve();
  haltLoops.add(o.state);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const loop = async (): Promise<void> => {
    try {
      for (;;) {
        const reason = new KillSwitch({ state: o.state, file: o.file, log: o.log }).tripped();
        if (!reason) return;
        const pending = o.state.get<PendingHalt>(KILL_NS, KILL_ONCHAIN_KEY);
        const attempts = pending?.reason.at === reason.at ? pending.attempts : 0;
        const nextAt = pending?.reason.at === reason.at ? pending.nextAt : 0;
        if (Date.now() < nextAt) {
          await sleep(nextAt - Date.now());
          continue;
        }
        const adapter = o.adapter();
        if (!adapter) {
          o.log.warn("KILL_ONCHAIN_PENDING", { code: reason.code, detail: "adapter unavailable", attempts });
          o.state.set(KILL_NS, KILL_ONCHAIN_KEY, { reason, attempts: attempts + 1, nextAt: Date.now() + HALT_RETRY_BASE_MS } satisfies PendingHalt);
          await o.state.flush().catch((err) => o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
          await sleep(HALT_RETRY_BASE_MS);
          continue;
        }
        if (adapter.mode !== "live") {
          o.log.warn("KILL_ONCHAIN_DRY_RUN", { code: reason.code });
          o.state.delete(KILL_NS, KILL_ONCHAIN_KEY);
          await o.state.flush().catch((err) => o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
          return;
        }
        try {
          const policy = await adapter.getAgent();
          if (!policy || !policy.active || (policy.roles & TRADE_ROLES) === 0) {
            o.log.error("KILL_ONCHAIN_CONFIRMED", { code: reason.code, roles: policy?.roles });
            o.state.delete(KILL_NS, KILL_ONCHAIN_KEY);
            await o.state.flush().catch((err) => o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
            return;
          }
          const result = await adapter.agentHalt(KILL_CODES[reason.code]);
          if (result.dryRun) throw new Error("agentHalt returned a dry-run result in live mode");
          o.log.warn("KILL_ONCHAIN_PENDING", { code: reason.code, detail: "awaiting confirmation", attempts: attempts + 1 });
        } catch (err) {
          o.log.warn("KILL_ONCHAIN_PENDING", { code: reason.code, detail: err instanceof Error ? err.message : String(err), attempts: attempts + 1 });
        }
        const delay = Math.min(HALT_RETRY_BASE_MS * 2 ** attempts, HALT_RETRY_MAX_MS);
        o.state.set(KILL_NS, KILL_ONCHAIN_KEY, { reason, attempts: attempts + 1, nextAt: Date.now() + delay } satisfies PendingHalt);
        await o.state.flush().catch((err) => o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
        await sleep(delay);
      }
    } finally {
      haltLoops.delete(o.state);
    }
  };
  void loop();
  return Promise.resolve();
}

export class KillSwitch {
  private current: KillReason | undefined;
  private notified = false;

  constructor(private readonly o: KillSwitchOptions) {
    this.current = o.state.get<KillReason>(KILL_NS, KILL_REASON_KEY);
    const marker = this.readMarker();
    if (marker) this.current = marker;
  }

  tripped(): KillReason | undefined {
    const marker = this.readMarker();
    if (!marker) return undefined;
    if (!this.current || marker.at >= this.current.at) {
      this.current = marker;
      this.o.state.set(KILL_NS, KILL_REASON_KEY, marker);
    }
    return this.current;
  }

  async trip(reason: KillReason): Promise<void> {
    if (!validReason(reason)) throw new TypeError("invalid kill reason");
    if (this.notified && this.current) return;
    this.current ??= reason;
    this.o.state.set(KILL_NS, KILL_REASON_KEY, this.current);
    await this.o.state.flush().catch((err) => this.o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
    await this.writeMarker(this.current);
    this.o.log.error("KILL_SWITCH_TRIPPED", { ...this.current });
    await this.deliver(this.current);
  }

  async rearm(operator: string): Promise<void> {
    this.current = undefined;
    this.notified = false;
    this.o.state.delete(KILL_NS, KILL_REASON_KEY);
    this.o.state.delete(KILL_NS, KILL_ONCHAIN_KEY);
    await this.o.state.flush().catch((err) => this.o.log.error("KILL_STATE_FLUSH_FAILED", { err }));
    await unlink(this.o.file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    this.o.log.warn("KILL_SWITCH_REARMED", { operator });
  }

  async notify(): Promise<void> {
    const reason = this.tripped();
    if (reason) await this.deliver(reason);
  }

  async check(): Promise<KillReason | undefined> {
    const reason = this.tripped();
    if (reason) await this.trip(reason);
    return reason;
  }

  private readMarker(): KillReason | undefined {
    let text: string;
    try {
      text = readFileSync(this.o.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      this.o.log.warn("KILL_MARKER_READ_FAILED", { err });
      return undefined;
    }
    try {
      const marker = JSON.parse(text) as unknown;
      return validReason(marker) ? marker : undefined;
    } catch (err) {
      this.o.log.warn("KILL_MARKER_INVALID", { err });
      return undefined;
    }
  }

  private async writeMarker(reason: KillReason): Promise<void> {
    await mkdir(dirname(this.o.file), { recursive: true });
    const tmp = `${this.o.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(JSON.stringify(reason) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.o.file);
    try {
      const dh = await open(dirname(this.o.file), "r");
      await dh.sync().finally(() => dh.close());
    } catch (err) {
      if (process.platform !== "win32") this.o.log.warn("KILL_MARKER_DIR_SYNC_FAILED", { err });
    }
  }

  private async deliver(reason: KillReason): Promise<void> {
    if (this.notified) return;
    this.notified = true;
    try {
      await this.o.onTrip?.(reason);
    } catch (err) {
      this.o.log.error("KILL_ONTRIP_FAILED", { err });
    }
  }
}
