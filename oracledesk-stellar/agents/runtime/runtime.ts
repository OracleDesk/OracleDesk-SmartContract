/**
 * Supervised agent runtime: runs interval tasks inside one process with no
 * per-task overlap, one global submission mutex, crash-loop backoff, a
 * process-level circuit breaker, a single-instance lease and a graceful
 * shutdown that never abandons a transaction between "sent" and "recorded".
 * See docs/agent-runtime.md.
 */
import { AsyncMutex, MarketLocks } from "./locks.js";
import type { Lease } from "./lease.js";
import { jsonLogger, type Logger } from "./log.js";
import type { StateStore } from "./state.js";

export interface TaskContext {
  /** Aborted when shutdown starts. Honour it between steps, never mid-submit. */
  signal: AbortSignal;
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

interface Sleep {
  handle: unknown;
  resolve: () => void;
}

export class Runtime {
  /** 0 after a clean stop, 1 if the circuit opened or a --once task failed. */
  exitCode = 0;
  private readonly controller = new AbortController();
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
      void this.stop("lease lost");
    };
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  private context(task: Task): TaskContext {
    return {
      signal: this.controller.signal,
      state: this.o.state,
      locks: this.locks,
      submit: (fn, intent) => this.submit(fn, intent ?? task.name),
      log: {
        info: (e, f) => this.log.info(e, { task: task.name, ...f }),
        warn: (e, f) => this.log.warn(e, { task: task.name, ...f }),
        error: (e, f) => this.log.error(e, { task: task.name, ...f }),
      },
      now: this.now,
    };
  }

  private async submit<T>(fn: () => Promise<T>, intent: string): Promise<T> {
    if (this.controller.signal.aborted) throw new AbortedError();
    return this.mutex.run(async () => {
      // Queued behind another submission when shutdown began: not yet sent, so drop it.
      if (this.controller.signal.aborted) throw new AbortedError();
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
      this.log.error("CIRCUIT_OPEN", { reason });
      this.exitCode = 1;
      void this.stop(`circuit open: ${reason}`);
    }
  }

  private async loop(task: Task): Promise<void> {
    while (!this.controller.signal.aborted) {
      await this.runTask(task);
      if (this.controller.signal.aborted) break;
      await this.sleep(this.delayFor(task, this.consecutive.get(task.name) ?? 0));
    }
  }

  /** Acquires the lease and runs every task on its own loop until {@link stop}. */
  async start(): Promise<void> {
    await this.o.lease.acquire();
    this.log.info("RUNTIME_START", { tasks: this.o.tasks.map((t) => t.name) });
    for (const task of this.o.tasks) this.loops.set(task.name, this.loop(task));
    await this.finished;
  }

  /** Runs each task exactly once, in order, then releases everything (the old CLI behaviour). */
  async runOnce(): Promise<void> {
    await this.o.lease.acquire();
    let firstError: unknown;
    try {
      for (const task of this.o.tasks) {
        try {
          await task.run(this.context(task));
          this.log.info("TASK_OK", { task: task.name, once: true });
        } catch (err) {
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
