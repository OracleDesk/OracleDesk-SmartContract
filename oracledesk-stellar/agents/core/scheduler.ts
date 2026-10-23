/**
 * Daemon scheduler, circuit-breaker backoff, atomic state checkpointing, and
 * HTTP health/readiness probe server for OracleDesk agents (#105).
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentDaemonState {
  lastCompletedCycle: number;
  lastProcessedLedger: number;
  consecutiveFailures: number;
  circuitOpenUntilMs: number;
  processedEventIds: string[];
  updatedAtMs: number;
}

export class DaemonStateStore {
  constructor(
    private readonly filePath: string,
    private readonly maxEventIds = 500,
  ) {}

  load(): AgentDaemonState {
    if (!existsSync(this.filePath)) {
      return {
        lastCompletedCycle: 0,
        lastProcessedLedger: 0,
        consecutiveFailures: 0,
        circuitOpenUntilMs: 0,
        processedEventIds: [],
        updatedAtMs: 0,
      };
    }
    return JSON.parse(readFileSync(this.filePath, "utf8")) as AgentDaemonState;
  }

  save(state: AgentDaemonState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const bounded: AgentDaemonState = {
      ...state,
      processedEventIds: state.processedEventIds.slice(-this.maxEventIds),
    };
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(bounded, null, 2), "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

export interface SchedulerConfig {
  intervalMs: number;
  jitterRatio?: number;
  maxConsecutiveFailures?: number;
  circuitCooldownMs?: number;
  maxCycles?: number;
}

export class AgentScheduler {
  private stopping = false;
  private inFlightPromise: Promise<void> | null = null;
  private state: AgentDaemonState;

  constructor(
    private readonly store: DaemonStateStore,
    private readonly cfg: SchedulerConfig,
    private readonly nowFn: () => number = () => Date.now(),
  ) {
    this.state = store.load();
  }

  currentState(): Readonly<AgentDaemonState> {
    return this.state;
  }

  isHealthy(nowMs = this.nowFn()): boolean {
    const maxFail = this.cfg.maxConsecutiveFailures ?? 5;
    if (this.state.consecutiveFailures >= maxFail && nowMs < this.state.circuitOpenUntilMs) {
      return false;
    }
    return true;
  }

  requestStop(): void {
    this.stopping = true;
  }

  async runSingleTick(
    tickFn: (state: AgentDaemonState) => Promise<{ latestLedger?: number; newEventIds?: string[] }>,
  ): Promise<{ executed: boolean; error?: Error }> {
    const now = this.nowFn();
    if (now < this.state.circuitOpenUntilMs) {
      return { executed: false };
    }

    const maxFail = this.cfg.maxConsecutiveFailures ?? 5;
    const cooldown = this.cfg.circuitCooldownMs ?? 60_000;

    const run = async () => {
      const out = await tickFn(this.state);
      const mergedEvents = [
        ...this.state.processedEventIds,
        ...(out.newEventIds ?? []).filter((id) => !this.state.processedEventIds.includes(id)),
      ];
      this.state = {
        lastCompletedCycle: this.state.lastCompletedCycle + 1,
        lastProcessedLedger: out.latestLedger ?? this.state.lastProcessedLedger,
        consecutiveFailures: 0,
        circuitOpenUntilMs: 0,
        processedEventIds: mergedEvents,
        updatedAtMs: this.nowFn(),
      };
      this.store.save(this.state);
    };

    try {
      this.inFlightPromise = run();
      await this.inFlightPromise;
      return { executed: true };
    } catch (err) {
      const failures = this.state.consecutiveFailures + 1;
      const circuitOpenUntilMs = failures >= maxFail ? this.nowFn() + cooldown : 0;
      this.state = {
        ...this.state,
        consecutiveFailures: failures,
        circuitOpenUntilMs,
        updatedAtMs: this.nowFn(),
      };
      this.store.save(this.state);
      return { executed: false, error: err as Error };
    } finally {
      this.inFlightPromise = null;
    }
  }

  async waitForInFlight(): Promise<void> {
    if (this.inFlightPromise) {
      await this.inFlightPromise.catch(() => undefined);
    }
  }
}

export async function startHealthServer(
  scheduler: AgentScheduler,
  port = 0,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const st = scheduler.currentState();
    const healthy = scheduler.isHealthy();
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: healthy ? "ok" : "circuit_open",
          lastCompletedCycle: st.lastCompletedCycle,
          lastProcessedLedger: st.lastProcessedLedger,
          consecutiveFailures: st.consecutiveFailures,
          circuitOpenUntilMs: st.circuitOpenUntilMs,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
