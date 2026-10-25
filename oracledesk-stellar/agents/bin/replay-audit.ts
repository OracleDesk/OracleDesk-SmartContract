#!/usr/bin/env -S npx tsx
/**
 * CLI for replaying and auditing published agent traces (#114).
 *
 * Usage:
 *   npx tsx bin/replay-audit.ts <trace-file.json> [expected-hash-hex]
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { auditTraceReplay, type ReplayableTrace } from "../core/replay.js";
import { canonicalize } from "../core/trace.js";

export function runReplayCli(tracePath: string, expectedHash?: string): number {
  const raw = JSON.parse(readFileSync(tracePath, "utf8")) as ReplayableTrace;
  const report = auditTraceReplay(raw, { expectedTraceHash: expectedHash });
  console.log(canonicalize(report));
  return report.status === "verified" || report.status === "not_replayable" ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const tracePath = process.argv[2];
  if (!tracePath) {
    console.error("usage: replay-audit.ts <trace.json> [expected-hash]");
    process.exit(2);
  }
  process.exit(runReplayCli(tracePath, process.argv[3]));
}
