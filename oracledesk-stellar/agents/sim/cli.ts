#!/usr/bin/env -S npx tsx
/**
 * npm run sim -- --config sim/configs/clones.json --seed 1 --runs 50 [--out sim/results]
 *
 * Writes <out>/<name>-<seed>.json (config, seed, per-run metrics and
 * aggregates) and <out>/<name>-<seed>.summary.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runExperiment, toJson, toMarkdown, type ExperimentConfig } from "./report.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

const configPath = resolve(arg("config"));
const seed = BigInt(arg("seed", "1"));
const runs = Number(arg("runs", "100"));
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
const out = resolve(arg("out", join(dirname(fileURLToPath(import.meta.url)), "results")));

const config = JSON.parse(readFileSync(configPath, "utf8")) as ExperimentConfig;
const started = Date.now();
const result = runExperiment(config, seed, runs);
mkdirSync(out, { recursive: true });
const base = join(out, `${config.name}-${seed}`);
writeFileSync(`${base}.json`, toJson(result) + "\n");
writeFileSync(`${base}.summary.md`, toMarkdown(result));
console.log(toMarkdown(result));
console.log(`wrote ${base}.json and ${base}.summary.md in ${((Date.now() - started) / 1000).toFixed(1)}s`);
