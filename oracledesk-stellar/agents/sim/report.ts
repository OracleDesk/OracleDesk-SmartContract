/**
 * Turns runs into statistics. Collateral stays bigint inside a run; only
 * here are amounts converted to floats (USDC) for means, quantiles and
 * bootstrap confidence intervals. Everything is deterministic: the
 * bootstrap draws from an Rng seeded by the experiment seed.
 */
import type { RunResult, SimConfig } from "./engine.js";
import { runSimulation } from "./engine.js";
import { Rng, splitmix64 } from "./rng.js";

const USDC = 10_000_000;
const usdc = (x: bigint) => Number(x) / USDC;

export interface RunMetrics {
  seed: string;
  /** Per account PnL in USDC. */
  pnl: Record<string, number>;
  /** LP PnL in USDC, summed per creator account. */
  lpPnl: Record<string, number>;
  feesSwept: number;
  voidDust: number;
  voidCount: number;
  voidLpPnl: number;
  brier: number | null;
  /** Brier of the latent p at close, the benchmark a perfectly informed price would score. */
  brierLatent: number | null;
  meanAbsMispricingBps: number;
  overshootMeanBps: number | null;
  overshootP95Bps: number | null;
  /** Share of OracleDesk fills that left the price past their own fair value. */
  overshootRate: number | null;
  capBindings: Record<string, Record<string, number>>;
  capBindingRate: Record<string, number>;
  peakDailyUtil: Record<string, number>;
  peakMarketUtil: Record<string, number>;
  reverts: Record<string, number>;
  fills: number;
  /** [price bin 0..9, resolved yes 0/1] per resolved market, for calibration. */
  calibration: [number, number][];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/** Nearest-rank quantile on a sorted copy. */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export function runMetrics(r: RunResult): RunMetrics {
  const resolved = r.markets.filter((m) => m.resolution !== "void");
  const voided = r.markets.filter((m) => m.resolution === "void");
  const outcome = (m: (typeof r.markets)[number]) => (m.resolution === "yes" ? 1 : 0);
  const lpPnl: Record<string, number> = {};
  for (const m of r.markets) lpPnl[m.creator] = (lpPnl[m.creator] ?? 0) + usdc(m.lpPnl);
  const capBindings: Record<string, Record<string, number>> = {};
  const capBindingRate: Record<string, number> = {};
  const peakDailyUtil: Record<string, number> = {};
  const peakMarketUtil: Record<string, number> = {};
  for (const [account, s] of Object.entries(r.caps)) {
    capBindings[account] = s.bindings;
    const bound = Object.values(s.bindings).reduce((a, b) => a + b, 0);
    capBindingRate[account] = s.attempts ? bound / s.attempts : 0;
    peakDailyUtil[account] = s.peakDailyUtil;
    peakMarketUtil[account] = s.peakMarketUtil;
  }
  const os = r.overshootBps;
  return {
    seed: r.seed,
    pnl: Object.fromEntries(Object.entries(r.pnl).map(([k, v]) => [k, usdc(v)])),
    lpPnl,
    feesSwept: usdc(r.markets.reduce((a, m) => a + m.feesSwept, 0n)),
    voidDust: usdc(voided.reduce((a, m) => a + m.dust, 0n)),
    voidCount: voided.length,
    voidLpPnl: usdc(voided.reduce((a, m) => a + m.lpPnl, 0n)),
    brier: resolved.length ? mean(resolved.map((m) => (m.finalPriceBps / 10_000 - outcome(m)) ** 2)) : null,
    brierLatent: resolved.length ? mean(resolved.map((m) => (m.finalLatentP - outcome(m)) ** 2)) : null,
    meanAbsMispricingBps: mean(r.markets.map((m) => m.meanAbsMispricingBps)),
    overshootMeanBps: os.length ? mean(os) : null,
    overshootP95Bps: os.length ? quantile(os, 0.95) : null,
    overshootRate: os.length ? os.filter((x) => x > 0).length / os.length : null,
    capBindings,
    capBindingRate,
    peakDailyUtil,
    peakMarketUtil,
    reverts: r.reverts,
    fills: r.fills,
    calibration: resolved.map((m) => [Math.min(9, Math.floor(m.finalPriceBps / 1_000)), outcome(m)]),
  };
}

export interface Stat {
  n: number;
  mean: number;
  p5: number;
  p95: number;
  /** Bootstrap 95% CI of the mean. */
  ci95: [number, number];
}

export function stat(xs: number[], rng: Rng, resamples = 1_000): Stat {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: NaN, p5: NaN, p95: NaN, ci95: [NaN, NaN] };
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[rng.int(v.length)]!;
    means.push(s / v.length);
  }
  return { n: v.length, mean: mean(v), p5: quantile(v, 0.05), p95: quantile(v, 0.95), ci95: [quantile(means, 0.025), quantile(means, 0.975)] };
}

export interface Aggregate {
  pnl: Record<string, Stat>;
  lpPnl: Record<string, Stat>;
  /** Mean PnL per clone, summed over an agent family (e.g. all "od-*" treasuries). */
  feesSwept: Stat;
  voidDust: Stat;
  voidLpPnl: Stat;
  brier: Stat;
  brierLatent: Stat;
  meanAbsMispricingBps: Stat;
  overshootMeanBps: Stat;
  overshootRate: Stat;
  capBindingRate: Record<string, Stat>;
  peakDailyUtil: Record<string, Stat>;
  calibration: { bin: string; n: number; meanYes: number }[];
  reverts: Record<string, number>;
}

function keyed(runs: RunMetrics[], pick: (r: RunMetrics) => Record<string, number>, rng: Rng): Record<string, Stat> {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(pick(r))))].sort();
  return Object.fromEntries(keys.map((k) => [k, stat(runs.map((r) => pick(r)[k] ?? 0), rng.fork(k))]));
}

export function aggregate(runs: RunMetrics[], seed: bigint): Aggregate {
  const rng = new Rng(seed).fork("bootstrap");
  const s = (label: string, f: (r: RunMetrics) => number | null) =>
    stat(runs.map(f).filter((x): x is number => x !== null), rng.fork(label));
  const bins = Array.from({ length: 10 }, () => ({ n: 0, yes: 0 }));
  for (const r of runs) for (const [bin, o] of r.calibration) {
    bins[bin]!.n++;
    bins[bin]!.yes += o;
  }
  const reverts: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.reverts)) reverts[k] = (reverts[k] ?? 0) + v;
  return {
    pnl: keyed(runs, (r) => r.pnl, rng.fork("pnl")),
    lpPnl: keyed(runs, (r) => r.lpPnl, rng.fork("lp")),
    feesSwept: s("fees", (r) => r.feesSwept),
    voidDust: s("dust", (r) => r.voidDust),
    voidLpPnl: s("voidlp", (r) => r.voidLpPnl),
    brier: s("brier", (r) => r.brier),
    brierLatent: s("brierLatent", (r) => r.brierLatent),
    meanAbsMispricingBps: s("mis", (r) => r.meanAbsMispricingBps),
    overshootMeanBps: s("os", (r) => r.overshootMeanBps),
    overshootRate: s("osr", (r) => r.overshootRate),
    capBindingRate: keyed(runs, (r) => r.capBindingRate, rng.fork("caps")),
    peakDailyUtil: keyed(runs, (r) => r.peakDailyUtil, rng.fork("daily")),
    calibration: bins.map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, meanYes: b.n ? b.yes / b.n : NaN })),
    reverts: Object.fromEntries(Object.entries(reverts).sort()),
  };
}

// ─── experiments ────────────────────────────────────────────────────────────

export interface ExperimentConfig extends SimConfig {
  /** Runs the experiment once per value, substituting `"$<param>"` strings. */
  sweep?: { param: string; values: unknown[] };
}

export interface ExperimentResult {
  name: string;
  seed: string;
  runs: number;
  config: ExperimentConfig;
  points: { value: unknown; aggregate: Aggregate; runs: RunMetrics[] }[];
}

/** Replaces every `"$param"` string in `cfg` with `value`. */
export function substitute<T>(cfg: T, param: string, value: unknown): T {
  const token = `$${param}`;
  const walk = (v: unknown): unknown =>
    v === token ? value : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(cfg) as T;
}

/** Seed of run `i`: a splitmix64 step off the experiment seed. */
export function runSeed(seed: bigint, i: number): bigint {
  return splitmix64(seed + BigInt(i))[1];
}

export function runExperiment(config: ExperimentConfig, seed: bigint, runs: number): ExperimentResult {
  const { sweep, ...base } = config;
  const values = sweep ? sweep.values : [null];
  const points = values.map((value, vi) => {
    const cfg = sweep ? substitute(base as SimConfig, sweep.param, value) : (base as SimConfig);
    const metrics = Array.from({ length: runs }, (_, i) => runMetrics(runSimulation(cfg, runSeed(seed + BigInt(vi) * 1_000_003n, i))));
    return { value, aggregate: aggregate(metrics, seed + BigInt(vi)), runs: metrics };
  });
  return { name: config.name, seed: seed.toString(), runs, config, points };
}

/** Stable JSON: bigints as strings, NaN as null. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "number" && !Number.isFinite(v) ? null : v), 2);
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const ci = (s: Stat, d = 2) => `${f(s.mean, d)} [${f(s.ci95[0], d)}, ${f(s.ci95[1], d)}]`;

export function toMarkdown(res: ExperimentResult): string {
  const sweep = res.config.sweep;
  const lines: string[] = [
    `# Simulation: ${res.name}`,
    "",
    `Seed ${res.seed}, ${res.runs} runs per point${sweep ? `, sweeping \`${sweep.param}\` over ${JSON.stringify(sweep.values)}` : ""}.`,
    "Values are means with bootstrap 95% CIs of the mean in brackets; PnL in USDC.",
    "",
  ];
  for (const p of res.points) {
    const a = p.aggregate;
    if (sweep) lines.push(`## ${sweep.param} = ${JSON.stringify(p.value)}`, "");
    lines.push("| account | mean PnL [95% CI] | p5 | p95 |", "|---|---|---|---|");
    for (const [k, s] of Object.entries(a.pnl)) lines.push(`| ${k} | ${ci(s)} | ${f(s.p5)} | ${f(s.p95)} |`);
    lines.push("", "| metric | value |", "|---|---|");
    for (const [k, s] of Object.entries(a.lpPnl)) lines.push(`| LP PnL (${k}) | ${ci(s)} |`);
    lines.push(
      `| fees swept | ${ci(a.feesSwept)} |`,
      `| void LP PnL | ${ci(a.voidLpPnl)} |`,
      `| void dust | ${ci(a.voidDust, 7)} |`,
      `| Brier (final price) | ${ci(a.brier, 4)} |`,
      `| Brier (latent p at close) | ${ci(a.brierLatent, 4)} |`,
      `| mean abs mispricing (bps) | ${ci(a.meanAbsMispricingBps, 1)} |`,
      `| OracleDesk overshoot (bps) | ${ci(a.overshootMeanBps, 1)} |`,
      `| OracleDesk overshoot rate | ${ci(a.overshootRate, 3)} |`,
    );
    for (const [k, s] of Object.entries(a.capBindingRate)) lines.push(`| cap binding rate (${k}) | ${ci(s, 3)} |`);
    for (const [k, s] of Object.entries(a.peakDailyUtil)) lines.push(`| peak daily-cap use (${k}) | ${ci(s, 3)} |`);
    const reverts = Object.entries(a.reverts);
    if (reverts.length) lines.push("", `Reverts: ${reverts.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    lines.push("", "Calibration (final price bin → share resolved YES):", "");
    lines.push(a.calibration.filter((b) => b.n).map((b) => `${b.bin}: ${f(b.meanYes, 2)} (n=${b.n})`).join("; "), "");
  }
  return lines.join("\n");
}
