/**
 * Calibrates the volatility fair-value estimator against price history (#331).
 *
 *   npx tsx bin/calibrate-volatility.ts --csv history.csv --out ../docs/calibration/ \
 *     [--asset XLM-USD] [--resolution 300] [--estimator ewma|garch] [--history 96]
 *
 * Input: `ts,price` CSV (unix seconds, decimal price), the operator's export
 * of feed or exchange history (Reflector keeps only a short on-chain window).
 * Output: `<asset>.json` (the report) and `<asset>.md`, plus the report's
 * sha256 to put in VOL_CALIBRATION_REPORT_HASH. Live use additionally needs
 * the estimator's Brier score to beat the baseline (core/calibration.ts).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildReport,
  DEFAULT_CALIBRATION,
  parsePriceCsv,
  reportHash,
  reportMarkdown,
  runCalibration,
} from "../core/calibration.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const csvPath = arg("csv");
const outDir = arg("out") ?? ".";
if (!csvPath) {
  console.error("usage: calibrate-volatility --csv <ts,price file> [--out dir] [--asset name] [--resolution secs] [--estimator ewma|garch]");
  process.exit(2);
}
const text = readFileSync(csvPath, "utf8");
const { points, decimals } = parsePriceCsv(text);
if (points.length < 200) {
  console.error(`need at least 200 points, got ${points.length}`);
  process.exit(2);
}
const sorted = [...points].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
const steps = sorted.slice(1).map((p, i) => Number(p.timestamp - sorted[i]!.timestamp)).sort((a, b) => a - b);
const resolution = BigInt(arg("resolution") ?? steps[Math.floor(steps.length / 2)]!);
const estimator = (arg("estimator") ?? "ewma") as "ewma" | "garch";
const opts = {
  ...DEFAULT_CALIBRATION,
  historySlots: Number(arg("history") ?? DEFAULT_CALIBRATION.historySlots),
  estimator,
  resolution,
  decimals,
};
const asset = arg("asset") ?? basename(csvPath).replace(/\.csv$/i, "");
const run = runCalibration(points, opts);
const report = buildReport(run, {
  file: basename(csvPath),
  sha256: createHash("sha256").update(text).digest("hex"),
  points: points.length,
  asset,
  params: { ...opts, resolution: resolution.toString() },
});
mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(report, null, 2) + "\n";
writeFileSync(join(outDir, `${asset}.json`), json);
writeFileSync(join(outDir, `${asset}.md`), reportMarkdown(report));
console.log(`markets=${report.markets} brier=${report.brier.toFixed(4)} baseline=${report.baselineBrier.toFixed(4)}`);
console.log(`report: ${join(outDir, `${asset}.json`)}`);
console.log(`VOL_CALIBRATION_REPORT_HASH=${reportHash(json)}`);
if (!(report.brier < report.baselineBrier)) {
  console.error("estimator does not beat the baseline: live use stays gated");
  process.exitCode = 1;
}
