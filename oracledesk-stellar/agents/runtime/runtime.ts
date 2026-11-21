/**
 * Supervised agent runtime: runs interval tasks inside one process with no
 * per-task overlap, one global submission mutex, crash-loop backoff, a
 * process-level circuit breaker, a single-instance lease and a graceful
 * shutdown that never abandons a transaction between "sent" and "recorded".
 * See docs/agent-runtime.md.
 */
import { AsyncMutex, MarketLocks } from "./locks.js";
import { FenceLostError, type Fence, type FencedLease, type Lease } from "./lease.js";
import { jsonLogger, type Logger } from "./log.js";
import type { StateStore } from "./state.js";
import { EXIT_KILLED } from "./config.js";
import { KilledError, type KillReason, type KillSwitch } from "./kill-switch.js";
import { classifySorobanError } from "../stellar/errors.js";

export interface TaskContext {
  /** Aborted when shutdown or the kill switch trips. Honour it between steps, never mid-submit. */
  signal: AbortSignal;
  /** Trips the kill switch, or performs a local kill when no switch is configured. */
  kill: (reason: KillReason) => Promise<void>;
  state: StateStore;
  locks: MarketLocks;
  /**
   * Runs `fn` (one adapter submission) under the global FIFO mutex, so the
   * shared source account never has two transactions in flight. Refuses to
   * *start* once shutdown began; once `fn` is running it is never aborted.
   * State is flushed after every submission.
   */
  submit: <T>(fn: () => Promise<T>, intent?: string) => Promise<T>;
  log: Logger;
  now: () => number;
  fence?: Fence;
}

export interface Task {
  name: string;
  intervalMs: number;
  jitterMs?: number;
  /** All tasks of one runtime must share a mode (mixed modes are rejected). */
  mode?: "dry-run" | "live";
  run(ctx: TaskContext): Promise<void>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RuntimeOptions {
  tasks: Task[];
  state: StateStore;
  lease: Lease;
  shutdownGraceMs: number;
  /** Consecutive failures of one task that trip the process circuit. */
  maxConsecutiveFailures: number;
  failureWindowMs: number;
  /** Failures (all tasks) within `failureWindowMs` that trip the circuit. */
  maxFailuresInWindow: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  log?: Logger;
  now?: () => number;
  random?: () => number;
  timers?: Timers;
  killSwitch?: KillSwitch;
}

export class AbortedError extends Error {
  constructor(message = "runtime is shutting down") {
    super(message);
    this.name = "AbortedError";
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

function composeSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

interface Sleep {
  handle: unknown;
  resolve: () => void;
}

export class Runtime {
  /** 0 after a clean stop, 1 if the circuit opened, 3 if killed, 75 if the lease was held. */
  exitCode = 0;
  private readonly controller = new AbortController();
  private readonly killController = new AbortController();
  private readonly leaseController = new AbortController();
  private readonly signal: AbortSignal;
  private readonly mutex = new AsyncMutex();
  private readonly locks: MarketLocks;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: Timers;
  private readonly sleeps = new Set<Sleep>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly consecutive = new Map<string, number>();
  private failures: number[] = [];
  private inFlight = 0;
  private readonly pending = new Map<number, string>();
  private nextIntent = 0;
  private stopping: Promise<void> | undefined;
  private done!: () => void;
  private readonly finished = new Promise<void>((r) => (this.done = r));

  constructor(private readonly o: RuntimeOptions) {
    this.signal = composeSignal(
      composeSignal(this.controller.signal, this.killController.signal),
      this.leaseController.signal,
    );
    const modes = new Set(o.tasks.map((t) => t.mode).filter(Boolean));
    if (modes.size > 1) throw new Error(`mixed task modes ${[...modes].join("/")} in one runtime`);
    const names = new Set<string>();
    for (const t of o.tasks) {
      if (names.has(t.name)) throw new Error(`duplicate task ${t.name}`);
      names.add(t.name);
    }
    this.locks = new MarketLocks(o.state);
    this.log = o.log ?? jsonLogger();
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.timers = o.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
    o.lease.onLost = (reason) => {
      this.log.error("LEASE_LOST", { reason });
      this.exitCode = 1;
      this.leaseController.abort(reason);
      void this.stop("lease lost");
    };
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  kill(reason: KillReason): void {
    if (this.killController.signal.aborted) return;
    this.exitCode = EXIT_KILLED;
    this.log.error("KILLED", { ...reason });
    this.killController.abort(reason);
    for (const s of this.sleeps) {
      this.timers.clearTimeout(s.handle);
      s.resolve();
    }
    this.sleeps.clear();
    void this.stop(`kill:${reason.code}`);
  }

  private context(task: Task): TaskContext {
    const fenced = this.o.lease as FencedLease;
    const fence = fenced.current?.();
    return {
      signal: this.signal,
      kill: (reason) => this.killLocally(reason),
      state: this.o.state,
      locks: this.locks,
      submit: (fn, intent) => this.submit(fn, intent ?? task.name, fence),
      log: {
        info: (e, f) => this.log.info(e, { task: task.name, ...f }),
        warn: (e, f) => this.log.warn(e, { task: task.name, ...f }),
        error: (e, f) => this.log.error(e, { task: task.name, ...f }),
      },
      now: this.now,
      fence,
    };
  }

  private async killLocally(reason: KillReason): Promise<void> {
    if (this.o.killSwitch) await this.o.killSwitch.trip(reason);
    else await this.kill(reason);
  }

  private async assertAlive(): Promise<void> {
    if (this.killController.signal.aborted) throw new KilledError(this.killController.signal.reason as KillReason);
    if (this.o.killSwitch) {
      const reason = await this.o.killSwitch.check();
      if (reason) throw new KilledError(reason);
    }
    if (this.controller.signal.aborted) throw new AbortedError();
    if (this.leaseController.signal.aborted) throw new FenceLostError(
      { name: "lease", epoch: 0n },
    );
  }

  private async submit<T>(fn: () => Promise<T>, intent: string, fence?: Fence): Promise<T> {
    await this.assertAlive();
    return this.mutex.run(async () => {
      // Queued behind another submission when shutdown began: not yet sent, so drop it.
      await this.assertAlive();
      if (fence) {
        const fenced = this.o.lease as FencedLease;
        if (fenced.assertHeld) await fenced.assertHeld(fence);
        this.o.state.setFenceEpoch?.(fence.epoch);
      }
      const id = this.nextIntent++;
      this.inFlight++;
      this.pending.set(id, intent);
      try {
        return await fn();
      } finally {
        this.inFlight--;
        this.pending.delete(id);
        await this.o.state.flush().catch((err) => this.log.error("STATE_FLUSH_FAILED", { err }));
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const entry: Sleep = { handle: undefined, resolve };
      entry.handle = this.timers.setTimeout(() => {
        this.sleeps.delete(entry);
        resolve();
      }, Math.max(0, ms));
      this.sleeps.add(entry);
    });
  }

  /** Delay before `task`'s next run: interval ± jitter, or capped exponential backoff. */
  delayFor(task: Task, failures: number): number {
    if (failures > 0) {
      const base = this.o.backoffBaseMs ?? 1_000;
      return Math.min(base * 2 ** (failures - 1), this.o.backoffMaxMs ?? 5 * 60_000);
    }
    const jitter = task.jitterMs ?? 0;
    return Math.max(0, task.intervalMs + Math.round((this.random() * 2 - 1) * jitter));
  }

  private async runTask(task: Task): Promise<boolean> {
    const started = this.now();
    try {
      await task.run(this.context(task));
      this.consecutive.set(task.name, 0);
      this.log.info("TASK_OK", { task: task.name, ms: this.now() - started });
      return true;
    } catch (err) {
      if (err instanceof KilledError) {
        this.log.warn("TASK_KILLED", { task: task.name, reason: err.reason });
        return true;
      }
      if (err instanceof AbortedError) {
        this.log.info("TASK_ABORTED", { task: task.name });
        return true;
      }
      const n = (this.consecutive.get(task.name) ?? 0) + 1;
      this.consecutive.set(task.name, n);
      this.recordFailure(task, n, err);
      return false;
    }
  }

  private recordFailure(task: Task, consecutive: number, err: unknown): void {
    const t = this.now();
    this.failures = this.failures.filter((x) => t - x < this.o.failureWindowMs);
    this.failures.push(t);
    this.log.error("TASK_FAILED", { task: task.name, consecutive, windowFailures: this.failures.length, err });
    const reason =
      consecutive >= this.o.maxConsecutiveFailures
        ? `${task.name} failed ${consecutive} times in a row`
        : this.failures.length >= this.o.maxFailuresInWindow
          ? `${this.failures.length} failures within ${this.o.failureWindowMs}ms`
          : undefined;
    if (reason && !this.stopping) {
      const classification = classifySorobanError(err);
      if (this.o.killSwitch && classification.kind === "contract") {
        this.log.error("CIRCUIT_OPEN", { reason, kind: classification.kind });
        void this.o.killSwitch.trip({ code: "errors", detail: reason, at: this.now() });
      } else {
        this.log.error("CIRCUIT_OPEN", { reason });
        this.exitCode = 1;
        void this.stop(`circuit open: ${reason}`);
      }
    }
  }

  private async loop(task: Task): Promise<void> {
    while (!this.signal.aborted) {
      await this.runTask(task);
      if (this.signal.aborted) break;
      await this.sleep(this.delayFor(task, this.consecutive.get(task.name) ?? 0));
    }
  }

  /** Acquires the lease and runs every task on its own loop until {@link stop}. */
  async start(): Promise<void> {
    if (this.o.killSwitch) {
      const reason = await this.o.killSwitch.check();
      if (reason) return;
    }
    await this.o.lease.acquire();
    this.log.info("RUNTIME_START", { tasks: this.o.tasks.map((t) => t.name) });
    for (const task of this.o.tasks) this.loops.set(task.name, this.loop(task));
    await this.finished;
  }

  /** Runs each task exactly once, in order, then releases everything (the old CLI behaviour). */
  async runOnce(): Promise<void> {
    if (this.o.killSwitch) {
      const reason = await this.o.killSwitch.check();
      if (reason) return;
    }
    await this.o.lease.acquire();
    let firstError: unknown;
    try {
      for (const task of this.o.tasks) {
        try {
          await task.run(this.context(task));
          this.log.info("TASK_OK", { task: task.name, once: true });
        } catch (err) {
          if (err instanceof KilledError) {
            this.log.warn("TASK_KILLED", { task: task.name, once: true, reason: err.reason });
            this.exitCode = EXIT_KILLED;
            break;
          }
          this.log.error("TASK_FAILED", { task: task.name, once: true, err });
          this.exitCode = 1;
          firstError ??= err;
        }
      }
    } finally {
      await this.o.state.flush();
      await this.o.lease.release();
    }
    if (firstError) throw firstError;
  }

  /**
   * Stops scheduling, wakes sleeping loops, waits up to `shutdownGraceMs`
   * for running ticks (in-flight submissions are never aborted), then
   * flushes state and releases the lease. If submissions are still in flight
   * at the deadline it logs SHUTDOWN_WITH_INFLIGHT and keeps the lease, so a
   * new instance cannot start until the TTL proves this one is gone.
   */
  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.log.info("RUNTIME_STOPPING", { reason, inFlight: this.inFlight });
      this.controller.abort();
      for (const s of this.sleeps) {
        this.timers.clearTimeout(s.handle);
        s.resolve();
      }
      this.sleeps.clear();
      let graceTimer: unknown;
      const timedOut = await Promise.race([
        Promise.allSettled([...this.loops.values()]).then(() => false),
        new Promise<boolean>((r) => (graceTimer = setTimeout(() => r(true), this.o.shutdownGraceMs))),
      ]);
      clearTimeout(graceTimer as NodeJS.Timeout);
      await this.o.state.flush().catch((err) => this.log.error("STATE_FLUSH_FAILED", { err }));
      if (timedOut && this.inFlight > 0) {
        this.log.error("SHUTDOWN_WITH_INFLIGHT", { pending: [...this.pending.entries()].map(([id, intent]) => ({ id, intent })) });
        this.exitCode ||= 1;
        // Keep the lease but let the process exit; its TTL expires on its own.
        (this.o.lease as { unref?: () => void }).unref?.();
      } else {
        await this.o.lease.release();
      }
      this.log.info("RUNTIME_STOPPED", { reason, exitCode: this.exitCode });
      this.done();
    })();
    return this.stopping;
  }
}
