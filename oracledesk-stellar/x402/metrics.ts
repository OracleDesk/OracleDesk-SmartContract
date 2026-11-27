/**
 * Prometheus metrics for the x402 payment pipeline (#328).
 *
 * Every label value comes from a closed set: stage, outcome, configured
 * CAIP-2 network, ledger state, upstream name and error kind. Trace ids,
 * payment ids, payer addresses and URLs are never labels, so cardinality is
 * bounded no matter what clients send.
 *
 * `/metrics` is served by a separate `node:http` listener on `METRICS_PORT`
 * so it is never reachable through the public API port.
 */
import { createServer, type Server } from "node:http";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import { X402_ERROR_KINDS, type Stage, type X402ErrorKind } from "./errors.js";
import type { PaymentState } from "./payment-ledger.js";

export const STAGES: readonly Stage[] = ["prepare", "verify", "settle", "deliver"];
export type Outcome = "ok" | "error" | "timeout" | "replay";
export const OUTCOMES: readonly Outcome[] = ["ok", "error", "timeout", "replay"];
export type Upstream =
  | "facilitator_verify"
  | "facilitator_settle"
  | "registry"
  | "ipfs";
export const PAYMENT_STATES: readonly PaymentState[] = [
  "verifying",
  "settling",
  "settled",
  "delivered",
  "failed",
  "failed_unconfirmed",
  "failed_final",
  "needs_operator",
  "indeterminate",
];

/** Label used for any network outside the configured set. */
export const OTHER_NETWORK = "other";

export interface X402Metrics {
  registry: Registry;
  stage: Counter<"stage" | "outcome" | "network">;
  stageSeconds: Histogram<"stage" | "network">;
  ledgerTransitions: Counter<"from" | "to">;
  ledgerState: Gauge<"state">;
  upstreamSeconds: Histogram<"upstream" | "outcome">;
  errors: Counter<"kind">;
  /** Maps an arbitrary network string onto the closed label set. */
  networkLabel(network: string | undefined): string;
  /** Records one stage outcome (and its duration when given). */
  observeStage(
    stage: Stage,
    outcome: Outcome,
    network: string | undefined,
    seconds?: number,
  ): void;
  observeUpstream(upstream: Upstream, outcome: Outcome, seconds: number): void;
  observeError(kind: X402ErrorKind): void;
  observeTransition(from: readonly PaymentState[], to: PaymentState): void;
}

export interface MetricsOptions {
  /** Configured CAIP-2 network ids; anything else is labelled `other`. */
  networks?: readonly string[];
  /** Sampled on scrape (never per request) for the `ledger_state` gauge. */
  countByState?: () => Promise<Partial<Record<PaymentState, number>>>;
  /** Default process metrics (CPU, heap, event loop lag). */
  defaultMetrics?: boolean;
}

const SECONDS_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

export function createMetrics(options: MetricsOptions = {}): X402Metrics {
  const registry = new Registry();
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry });
  const networks = new Set(options.networks ?? []);
  const stage = new Counter({
    name: "x402_stage_total",
    help: "Payment pipeline stage outcomes",
    labelNames: ["stage", "outcome", "network"] as const,
    registers: [registry],
  });
  const stageSeconds = new Histogram({
    name: "x402_stage_duration_seconds",
    help: "Payment pipeline stage duration",
    labelNames: ["stage", "network"] as const,
    buckets: SECONDS_BUCKETS,
    registers: [registry],
  });
  const ledgerTransitions = new Counter({
    name: "x402_ledger_transitions_total",
    help: "Durable payment ledger state transitions (from = allowed source states)",
    labelNames: ["from", "to"] as const,
    registers: [registry],
  });
  const countByState = options.countByState;
  const ledgerState = new Gauge({
    name: "x402_ledger_entries",
    help: "Payment ledger entries by state, sampled on scrape",
    labelNames: ["state"] as const,
    registers: [registry],
    async collect() {
      if (!countByState) return;
      const counts = await countByState();
      for (const state of PAYMENT_STATES)
        this.set({ state }, counts[state] ?? 0);
    },
  });
  const upstreamSeconds = new Histogram({
    name: "x402_upstream_duration_seconds",
    help: "Latency of facilitator, registry and IPFS gateway calls",
    labelNames: ["upstream", "outcome"] as const,
    buckets: SECONDS_BUCKETS,
    registers: [registry],
  });
  const errors = new Counter({
    name: "x402_errors_total",
    help: "Classified x402 failures by kind",
    labelNames: ["kind"] as const,
    registers: [registry],
  });
  // Pre-initialise the closed label sets so dashboards see zeros.
  for (const kind of X402_ERROR_KINDS) errors.inc({ kind }, 0);

  const networkLabel = (network: string | undefined) =>
    network && networks.has(network) ? network : OTHER_NETWORK;

  return {
    registry,
    stage,
    stageSeconds,
    ledgerTransitions,
    ledgerState,
    upstreamSeconds,
    errors,
    networkLabel,
    observeStage(s, outcome, network, seconds) {
      const n = networkLabel(network);
      stage.inc({ stage: s, outcome, network: n });
      if (seconds !== undefined)
        stageSeconds.observe({ stage: s, network: n }, seconds);
    },
    observeUpstream(upstream, outcome, seconds) {
      upstreamSeconds.observe({ upstream, outcome }, seconds);
    },
    observeError(kind) {
      errors.inc({ kind });
    },
    observeTransition(from, to) {
      ledgerTransitions.inc({ from: [...from].sort().join(","), to });
    },
  };
}

/** Seconds since `start` (a `performance.now()` reading). */
export function since(start: number): number {
  return (performance.now() - start) / 1000;
}

/**
 * Serves `GET /metrics` only, on its own listener. Bind to `METRICS_HOST`
 * (default `0.0.0.0` so a container's published port works).
 */
export function startMetricsServer(
  port: number,
  m: X402Metrics,
  host = process.env.METRICS_HOST ?? "0.0.0.0",
): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url?.split("?")[0] !== "/metrics") {
      res.statusCode = 404;
      res.end();
      return;
    }
    m.registry
      .metrics()
      .then((body) => {
        res.setHeader("Content-Type", m.registry.contentType);
        res.end(body);
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });
  server.listen(port, host);
  return server;
}
