/**
 * Agent observability: OpenTelemetry-compatible span tracer, Prometheus text
 * metrics registry, and tamper-evident SHA-256 hash-chained JSONL decision
 * audit log (#109).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { canonicalize } from "./trace.js";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
  errorMessage?: string;
}

export class AgentTracer {
  private readonly completedSpans: SpanRecord[] = [];

  async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: { setAttribute: (k: string, v: string | number | boolean) => void }) => Promise<T> | T,
    parentSpanId?: string,
  ): Promise<T> {
    const traceId = randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const startTimeMs = Date.now();
    const attrs = { ...attributes };

    try {
      const result = await fn({
        setAttribute(k, v) {
          attrs[k] = v;
        },
      });
      const endTimeMs = Date.now();
      this.completedSpans.push({
        traceId,
        spanId,
        parentSpanId,
        name,
        startTimeMs,
        endTimeMs,
        durationMs: Math.max(0, endTimeMs - startTimeMs),
        status: "ok",
        attributes: attrs,
      });
      return result;
    } catch (err) {
      const endTimeMs = Date.now();
      this.completedSpans.push({
        traceId,
        spanId,
        parentSpanId,
        name,
        startTimeMs,
        endTimeMs,
        durationMs: Math.max(0, endTimeMs - startTimeMs),
        status: "error",
        attributes: attrs,
        errorMessage: (err as Error).message,
      });
      throw err;
    }
  }

  spans(): readonly SpanRecord[] {
    return this.completedSpans;
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  incCounter(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const key = this.formatKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.formatKey(name, labels);
    this.gauges.set(key, value);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.formatKey(name, labels);
    const list = this.histograms.get(key) ?? [];
    list.push(value);
    this.histograms.set(key, list);
  }

  private formatKey(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    const labelStr = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",");
    return `${name}{${labelStr}}`;
  }

  /** Renders all registered metrics in Prometheus text exposition format (0.0.4). */
  toPrometheusText(): string {
    const lines: string[] = [];
    for (const [key, val] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} ${val}`);
    }
    for (const [key, val] of [...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} ${val}`);
    }
    for (const [key, samples] of [...this.histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sum = samples.reduce((a, b) => a + b, 0);
      lines.push(`${key}_count ${samples.length}`);
      lines.push(`${key}_sum ${sum}`);
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }
}

export interface AuditLogEntryInput {
  timestamp: number;
  agent: "maker" | "trader";
  marketId: number | null;
  decisionAction: string;
  traceHash: string;
  traceCid: string;
  txHash?: string;
  onChainResult?: Record<string, unknown>;
  untracedTradeAlert?: boolean;
}

export interface AuditLogEntry extends AuditLogEntryInput {
  seq: number;
  prevHash: string;
  entryHash: string;
}

const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * Append-only SHA-256 hash-chained JSONL decision audit log linking each
 * agent decision to its `traceHash`, `txHash`, and on-chain result.
 */
export class HashChainedAuditLog {
  private seq = 0;
  private lastHash = GENESIS_PREV_HASH;

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8").trim();
      if (raw.length > 0) {
        const lines = raw.split("\n");
        const last = JSON.parse(lines[lines.length - 1]) as AuditLogEntry;
        this.seq = last.seq + 1;
        this.lastHash = last.entryHash;
      }
    }
  }

  append(input: AuditLogEntryInput): AuditLogEntry {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = {
      seq: this.seq,
      prevHash: this.lastHash,
      ...input,
    };
    const entryHash = createHash("sha256").update(canonicalize(payload)).digest("hex");
    const entry: AuditLogEntry = {
      ...payload,
      entryHash,
    };
    appendFileSync(this.filePath, canonicalize(entry) + "\n", "utf8");
    this.seq += 1;
    this.lastHash = entryHash;
    return entry;
  }

  static verifyFile(filePath: string): { valid: boolean; count: number; brokenAtSeq?: number } {
    if (!existsSync(filePath)) return { valid: true, count: 0 };
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return { valid: true, count: 0 };
    const lines = raw.split("\n");
    let expectedPrev = GENESIS_PREV_HASH;

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]) as AuditLogEntry;
      if (parsed.seq !== i || parsed.prevHash !== expectedPrev) {
        return { valid: false, count: lines.length, brokenAtSeq: i };
      }
      const { entryHash, ...rest } = parsed;
      const recomputed = createHash("sha256").update(canonicalize(rest)).digest("hex");
      if (recomputed !== entryHash) {
        return { valid: false, count: lines.length, brokenAtSeq: i };
      }
      expectedPrev = entryHash;
    }
    return { valid: true, count: lines.length };
  }
}
