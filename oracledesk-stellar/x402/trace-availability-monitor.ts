import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TraceRepository } from "./trace-api.js";

export interface TraceAvailabilityEvent {
  traceId: string;
  status: "available" | "unretrievable" | "verified";
  timestamp: number;
  error?: string;
}

export interface MonitorState {
  lastScanAt: number;
  tracesScanned: number;
  tracesFailed: number;
  lastFailedTraces: Map<string, { error: string; timestamp: number }>;
}

export interface TraceAvailabilityMonitorOptions {
  repository: TraceRepository;
  ipfsGateway: string;
  fallbackGateways?: string[];
  pinArchiveUrl?: string;
  scanIntervalMs?: number;
  concurrency?: number;
  timeoutMs?: number;
}

export class TraceAvailabilityMonitor extends EventEmitter {
  private state: MonitorState;
  private scanTimeout?: NodeJS.Timeout;
  private readonly options: Required<TraceAvailabilityMonitorOptions>;

  constructor(options: TraceAvailabilityMonitorOptions) {
    super();
    this.options = {
      fallbackGateways: options.fallbackGateways ?? [
        "https://ipfs.io/ipfs",
        "https://gateway.pinata.cloud/ipfs",
      ],
      pinArchiveUrl: options.pinArchiveUrl ?? "",
      scanIntervalMs: options.scanIntervalMs ?? 3600000,
      concurrency: options.concurrency ?? 5,
      timeoutMs: options.timeoutMs ?? 30000,
      ...options,
    };
    this.state = {
      lastScanAt: 0,
      tracesScanned: 0,
      tracesFailed: 0,
      lastFailedTraces: new Map(),
    };
  }

  async start(): Promise<void> {
    console.log("[trace-monitor] starting availability monitor");
    await this.scan();
    this.scanTimeout = setInterval(() => this.scan(), this.options.scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimeout) {
      clearInterval(this.scanTimeout);
      this.scanTimeout = undefined;
    }
  }

  private async scan(): Promise<void> {
    const startTime = Date.now();
    console.log("[trace-monitor] starting scan");

    try {
      if (!this.options.repository.trace_count) {
        console.warn("[trace-monitor] repository does not support trace_count");
        return;
      }

      const totalTraces = await this.options.repository.trace_count();
      const traceIds: string[] = [];

      for (let i = 0n; i < totalTraces; i += 100n) {
        // Simplified: assume we can enumerate in batches
        // In production, use the repository's list methods
        traceIds.push(i.toString());
      }

      this.state.tracesScanned = 0;
      this.state.tracesFailed = 0;
      const results = await this.probeTraces(traceIds);

      for (const [traceId, result] of Object.entries(results)) {
        if (result.available) {
          this.emit("trace", {
            traceId,
            status: "verified",
            timestamp: Date.now(),
          } as TraceAvailabilityEvent);
        } else {
          this.state.tracesFailed++;
          this.state.lastFailedTraces.set(traceId, {
            error: result.error || "unknown",
            timestamp: Date.now(),
          });
          this.emit("trace", {
            traceId,
            status: "unretrievable",
            timestamp: Date.now(),
            error: result.error,
          } as TraceAvailabilityEvent);

          if (this.options.pinArchiveUrl) {
            await this.repin(traceId);
          }
        }
      }

      this.state.lastScanAt = Date.now();
      const duration = Date.now() - startTime;
      console.log(
        `[trace-monitor] scan completed in ${duration}ms: ${this.state.tracesScanned} scanned, ${this.state.tracesFailed} failed`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[trace-monitor] scan failed: ${message}`);
      this.emit("error", { error: message, timestamp: Date.now() });
    }
  }

  private async probeTraces(
    traceIds: string[],
  ): Promise<Record<string, { available: boolean; error?: string }>> {
    const results: Record<string, { available: boolean; error?: string }> = {};
    const queue = [...traceIds];
    const inProgress = new Set<string>();

    return new Promise((resolve) => {
      const processNext = async () => {
        if (queue.length === 0 && inProgress.size === 0) {
          resolve(results);
          return;
        }

        while (inProgress.size < this.options.concurrency && queue.length > 0) {
          const traceId = queue.shift();
          if (!traceId) break;

          inProgress.add(traceId);
          this.probeTrace(traceId)
            .then((result) => {
              results[traceId] = result;
              this.state.tracesScanned++;
            })
            .catch((err) => {
              results[traceId] = {
                available: false,
                error: err instanceof Error ? err.message : String(err),
              };
              this.state.tracesScanned++;
            })
            .finally(() => {
              inProgress.delete(traceId);
              processNext();
            });
        }
      };

      processNext();
    });
  }

  private async probeTrace(traceId: string): Promise<{ available: boolean; error?: string }> {
    try {
      const record = await this.options.repository.get(traceId);
      if (!record) {
        return { available: false, error: "trace not found in registry" };
      }

      // Try primary gateway
      const result = await this.fetchFromGateway(
        record.ipfsCid,
        this.options.ipfsGateway,
      );

      if (result.available) {
        return { available: true };
      }

      // Try fallback gateways
      for (const gateway of this.options.fallbackGateways) {
        const fallbackResult = await this.fetchFromGateway(record.ipfsCid, gateway);
        if (fallbackResult.available) {
          return { available: true };
        }
      }

      return {
        available: false,
        error: `CID ${record.ipfsCid} unretrievable from all gateways`,
      };
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }
  }

  private async fetchFromGateway(cid: string, gateway: string): Promise<{ available: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const url = `${gateway}/${cid}`;
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return { available: false };
      }

      const buffer = await response.arrayBuffer();
      // Verify against on-chain hash would go here
      return { available: true };
    } catch {
      return { available: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async repin(traceId: string): Promise<void> {
    if (!this.options.pinArchiveUrl) {
      return;
    }

    try {
      const record = await this.options.repository.get(traceId);
      if (!record) return;

      const response = await fetch(`${this.options.pinArchiveUrl}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cid: record.ipfsCid,
          traceId,
        }),
      });

      if (!response.ok) {
        console.warn(`[trace-monitor] failed to re-pin ${traceId}: ${response.status}`);
      } else {
        console.log(`[trace-monitor] re-pinned ${traceId}`);
      }
    } catch (err) {
      console.error(
        `[trace-monitor] re-pin error for ${traceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  getState(): Readonly<MonitorState> {
    return { ...this.state };
  }
}
