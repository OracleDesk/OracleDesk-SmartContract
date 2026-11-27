/**
 * Calibration reports and the live-use gate for the volatility estimator
 * (#331). `bin/calibrate-volatility.ts` writes a report; live trading on
 * the estimator requires `VOL_CALIBRATION_REPORT` to point at a report whose
 * sha256 equals `VOL_CALIBRATION_REPORT_HASH` and whose Brier score beats
 * the market-price baseline.
 */
import { createHash } from "node:crypto";
import { readFeedOnGrid, type PriceData } from "./strategies/grid.js";
import {
  DEFAULT_LAMBDA,
  ewmaEffectiveSamples,
  ewmaVariance,
  garchLite,
  logReturns,
  priceModel,
  SIGMA_FLOOR,
  VOL_MIN_SAMPLES,
  type PriceModel,
} from "./strategies/volatility.js";

export interface ReliabilityBucket {
  /** Bucket lower bound, probability. */
  lo: number;
  hi: number;
  count: number;
  meanForecast: number;
  observedRate: number;
}

export interface CalibrationReport {
  version: 1;
  generatedAt: string;
  input: { file: string; sha256: string; points: number; asset: string };
  params: Record<string, unknown>;
  markets: number;
  brier: number;
  logLoss: number;
  /** Brier score of the baseline forecaster (the market price proxy). */
  baselineBrier: number;
  baselineLogLoss: number;
  reliability: ReliabilityBucket[];
}

export function brierScore(forecasts: readonly number[], outcomes: readonly (0 | 1)[]): number {
  if (forecasts.length === 0) return NaN;
  return forecasts.reduce((s, p, i) => s + (p - outcomes[i]!) ** 2, 0) / forecasts.length;
}

export function logLoss(forecasts: readonly number[], outcomes: readonly (0 | 1)[], eps = 1e-6): number {
  if (forecasts.length === 0) return NaN;
  return (
    -forecasts.reduce((s, p, i) => {
      const q = Math.min(1 - eps, Math.max(eps, p));
      return s + (outcomes[i] ? Math.log(q) : Math.log(1 - q));
    }, 0) / forecasts.length
  );
}

export function reliabilityTable(forecasts: readonly number[], outcomes: readonly (0 | 1)[], buckets = 10): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const idx = forecasts.map((p, i) => [p, i] as const).filter(([p]) => p >= lo && (b === buckets - 1 ? p <= hi : p < hi));
    const count = idx.length;
    out.push({
      lo,
      hi,
      count,
      meanForecast: count ? idx.reduce((s, [p]) => s + p, 0) / count : 0,
      observedRate: count ? idx.reduce((s, [, i]) => s + outcomes[i]!, 0) / count : 0,
    });
  }
  return out;
}

export function reportHash(reportBytes: string | Uint8Array): string {
  return createHash("sha256").update(reportBytes).digest("hex");
}

/** Whether a report may unlock live use. Returns the reasons it may not. */
export function calibrationGate(reportBytes: string, expectedHash: string | undefined): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!expectedHash) reasons.push("VOL_CALIBRATION_REPORT_HASH is not set");
  else if (reportHash(reportBytes) !== expectedHash.toLowerCase()) reasons.push("calibration report hash does not match VOL_CALIBRATION_REPORT_HASH");
  let report: CalibrationReport | undefined;
  try {
    report = JSON.parse(reportBytes) as CalibrationReport;
  } catch {
    reasons.push("calibration report is not valid JSON");
  }
  if (report) {
    if (report.version !== 1) reasons.push("unsupported calibration report version");
    if (!(Number.isFinite(report.brier) && Number.isFinite(report.baselineBrier))) reasons.push("calibration report has no Brier scores");
    else if (!(report.brier < report.baselineBrier))
      reasons.push(`estimator Brier ${report.brier.toFixed(4)} does not beat the market-price baseline ${report.baselineBrier.toFixed(4)}`);
    if (!(report.markets > 0)) reasons.push("calibration report covers no markets");
  }
  return { ok: reasons.length === 0, reasons };
}

// ─── Calibration run (#331) ────────────────────────────────────────────────



export interface CalibrationOptions {
  /** Feed grid step, seconds. */
  resolution: bigint;
  /** Records of history used per estimate. */
  historySlots: number;
  /** Lead times (slots before the closing slot) to estimate at. */
  leadSlots: number[];
  /** Thresholds as relative moves from the spot at estimate time. */
  relativeThresholds: number[];
  /** Spacing between synthetic close times, in slots. */
  strideSlots: number;
  estimator: "ewma" | "garch";
  lambda: number;
  decimals: number;
}

export const DEFAULT_CALIBRATION: Omit<CalibrationOptions, "resolution" | "decimals"> = {
  historySlots: 96,
  leadSlots: [1, 3, 6, 12, 24],
  relativeThresholds: [-0.03, -0.01, -0.003, 0, 0.003, 0.01, 0.03],
  strideSlots: 6,
  estimator: "ewma",
  lambda: DEFAULT_LAMBDA,
};

/**
 * Synthetic AtOrAbove markets over a price history. Each is estimated with
 * only the history before its estimate time and resolved with the grid
 * mirror, so the score measures exactly what the live estimator would have
 * said. The baseline is a persistence forecast (is the spot already past
 * the threshold?), the stand-in for a market price that only tracks spot.
 */
export function runCalibration(
  points: readonly PriceData[],
  o: CalibrationOptions,
): { forecasts: number[]; baseline: number[]; outcomes: (0 | 1)[] } {
  const byTs = new Map<bigint, PriceData>();
  for (const p of points) byTs.set(p.timestamp, p);
  const sorted = [...byTs.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const forecasts: number[] = [];
  const baseline: number[] = [];
  const outcomes: (0 | 1)[] = [];
  const maxLead = Math.max(...o.leadSlots);
  for (let close = o.historySlots + maxLead; close < sorted.length; close += o.strideSlots) {
    const closeTs = sorted[close]!.timestamp;
    const resolved = readFeedOnGrid((t) => byTs.get(t) ?? null, o.resolution, o.resolution * 2n, closeTs);
    if (!resolved.ok) continue;
    for (const lead of o.leadSlots) {
      const at = close - lead;
      const spot = sorted[at]!;
      const hist = sorted.slice(at - o.historySlots, at + 1);
      const returns = logReturns(hist.map((p) => ({ ts: p.timestamp, price: p.price })), o.resolution);
      if (returns.length < VOL_MIN_SAMPLES) continue;
      const variance = o.estimator === "garch" ? (garchLite(returns)?.nextVar ?? ewmaVariance(returns, o.lambda)) : ewmaVariance(returns, o.lambda);
      const sigma = Math.max(Math.sqrt(variance), SIGMA_FLOOR);
      const tau = Number((closeTs - spot.timestamp) / o.resolution);
      for (const rel of o.relativeThresholds) {
        const threshold = BigInt(Math.max(1, Math.round(Number(spot.price) * (1 + rel))));
        const model: PriceModel = {
          kind: "spot",
          reflector: "calibration",
          asset: "other:calibration",
          decimals: o.decimals,
          resolution: o.resolution.toString(),
          gridSlot: closeTs.toString(),
          spot: spot.price.toString(),
          spotTs: spot.timestamp.toString(),
          threshold: threshold.toString(),
          thresholdDecimals: null,
          direction: "AtOrAbove",
          sigmaPerSlot: sigma,
          sigmaStdErr: sigma / Math.sqrt(2 * ewmaEffectiveSamples(returns.length, o.lambda)),
          estimator: o.estimator,
          tau,
          samples: returns.length,
          priceRefs: [],
        };
        forecasts.push(priceModel(model).probability);
        baseline.push(spot.price >= threshold ? 0.9 : 0.1);
        outcomes.push(resolved.value.price >= threshold ? 1 : 0);
      }
    }
  }
  return { forecasts, baseline, outcomes };
}

/** Parses `ts,price` CSV (optional header, decimal prices) into feed units. */
export function parsePriceCsv(text: string): { points: PriceData[]; decimals: number } {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(","));
  const data = rows.filter((r) => /^\d+$/.test(r[0]!.trim()));
  const decimals = Math.max(0, ...data.map((r) => (r[1]!.trim().split(".")[1] ?? "").length));
  const points = data.map((r) => {
    const [whole, frac = ""] = r[1]!.trim().split(".");
    return {
      timestamp: BigInt(r[0]!.trim()),
      price: BigInt(whole! + frac.padEnd(decimals, "0")),
    };
  });
  return { points, decimals };
}

export function buildReport(
  run: ReturnType<typeof runCalibration>,
  meta: { file: string; sha256: string; points: number; asset: string; params: Record<string, unknown> },
  generatedAt = new Date().toISOString(),
): CalibrationReport {
  return {
    version: 1,
    generatedAt,
    input: { file: meta.file, sha256: meta.sha256, points: meta.points, asset: meta.asset },
    params: meta.params,
    markets: run.forecasts.length,
    brier: brierScore(run.forecasts, run.outcomes),
    logLoss: logLoss(run.forecasts, run.outcomes),
    baselineBrier: brierScore(run.baseline, run.outcomes),
    baselineLogLoss: logLoss(run.baseline, run.outcomes),
    reliability: reliabilityTable(run.forecasts, run.outcomes),
  };
}

export function reportMarkdown(r: CalibrationReport): string {
  const rows = r.reliability
    .map((b) => `| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.count} | ${b.meanForecast.toFixed(3)} | ${b.observedRate.toFixed(3)} |`)
    .join("\n");
  return `# Volatility estimator calibration: ${r.input.asset}

Generated ${r.generatedAt} from \`${r.input.file}\` (${r.input.points} points, sha256 \`${r.input.sha256}\`).

| Metric | Estimator | Baseline (persistence) |
| --- | --- | --- |
| Brier score | ${r.brier.toFixed(4)} | ${r.baselineBrier.toFixed(4)} |
| Log loss | ${r.logLoss.toFixed(4)} | ${r.baselineLogLoss.toFixed(4)} |

Synthetic markets: ${r.markets}. Live use passes the gate only when the estimator's Brier score is below the baseline's.

## Reliability

| Forecast bucket | Markets | Mean forecast | Observed YES rate |
| --- | --- | --- | --- |
${rows}

## Parameters

\`\`\`json
${JSON.stringify(r.params, null, 2)}
\`\`\`
`;
}
