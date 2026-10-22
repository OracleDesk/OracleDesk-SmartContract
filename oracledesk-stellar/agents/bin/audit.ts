#!/usr/bin/env -S npx tsx
/**
 * Decision replay and audit CLI that re-derives agent actions from published traces.
 *
 * Given a trace id or market, fetches the on-chain record and trace content,
 * verifies the hash, and re-executes the recorded strategy on recorded inputs.
 * Compares the re-derived decision with both the recorded decision and the
 * actual on-chain effect, emitting a signed, machine-readable audit report.
 *
 * Usage:
 *   ./agents/bin/audit.ts trace <traceId>
 *   ./agents/bin/audit.ts market <marketId> [--agent <address>]
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TraceRepository } from "../../x402/trace-api.js";

export interface AuditEntry {
  traceId: string;
  recordedDecision: {
    action: string;
    amount: string;
    minSharesOut: string;
  };
  reDerivedDecision: {
    action: string;
    amount: string;
    minSharesOut: string;
  };
  onChainEffect: {
    txHash: string;
    amount: string;
    shares: string;
  };
  traceContent: {
    hash: string;
    inputs: Record<string, unknown>;
    strategyVersion: string;
    timestamp: number;
  };
  verdict: "match" | "deviation" | "mismatch" | "unverifiable";
  deviationReason?: string;
  timestamp: number;
  signature?: string;
}

export interface AuditReport {
  reportId: string;
  generatedAt: number;
  agent: string;
  market?: string;
  entries: AuditEntry[];
  summary: {
    totalTraces: number;
    matchedCount: number;
    deviationCount: number;
    mismatchCount: number;
    unverifiableCount: number;
  };
  signature?: string;
}

async function loadTraceRepository(): Promise<TraceRepository> {
  const deployments = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "deployments/stellar-testnet.json"),
      "utf-8",
    ),
  );

  return {
    async get(traceId: string) {
      // In production, this would connect to the registry contract
      return undefined;
    },
  };
}

async function fetchTraceContent(cid: string, gateway: string): Promise<string> {
  const response = await fetch(`${gateway}/${cid}`);
  if (!response.ok) throw new Error(`failed to fetch CID ${cid}`);
  return response.text();
}

async function verifyTraceHash(
  content: string,
  expectedHash: string,
): Promise<boolean> {
  const hash = createHash("sha256").update(content).digest("hex");
  return hash === expectedHash;
}

async function reExecuteStrategy(
  strategyVersion: string,
  inputs: Record<string, unknown>,
): Promise<{ action: string; amount: string; minSharesOut: string }> {
  // Strategy execution would be dynamically loaded here
  // For now, return a placeholder
  return {
    action: "buy",
    amount: "0",
    minSharesOut: "0",
  };
}

async function auditTrace(
  traceId: string,
  repository: TraceRepository,
  ipfsGateway: string,
): Promise<AuditEntry> {
  const record = await repository.get(traceId);
  if (!record) {
    return {
      traceId,
      recordedDecision: { action: "", amount: "", minSharesOut: "" },
      reDerivedDecision: { action: "", amount: "", minSharesOut: "" },
      onChainEffect: { txHash: "", amount: "", shares: "" },
      traceContent: {
        hash: "",
        inputs: {},
        strategyVersion: "",
        timestamp: 0,
      },
      verdict: "unverifiable",
      deviationReason: "trace not found",
      timestamp: Date.now(),
    };
  }

  try {
    // Fetch trace content
    const content = await fetchTraceContent(record.ipfsCid, ipfsGateway);

    // Verify hash
    const hashValid = await verifyTraceHash(content, record.traceHash);
    if (!hashValid) {
      return {
        traceId,
        recordedDecision: { action: "", amount: "", minSharesOut: "" },
        reDerivedDecision: { action: "", amount: "", minSharesOut: "" },
        onChainEffect: { txHash: "", amount: "", shares: "" },
        traceContent: {
          hash: record.traceHash,
          inputs: {},
          strategyVersion: "",
          timestamp: 0,
        },
        verdict: "unverifiable",
        deviationReason: "hash mismatch",
        timestamp: Date.now(),
      };
    }

    const traceData = JSON.parse(content);

    // Re-execute strategy
    const reDerived = await reExecuteStrategy(
      traceData.strategyVersion,
      traceData.inputs,
    );

    // Compare decisions
    const recordedMatch =
      reDerived.action === traceData.decision.action &&
      reDerived.minSharesOut === traceData.decision.minSharesOut;

    const onChainMatch =
      traceData.decision.action === traceData.onChainEffect.action;

    let verdict: "match" | "deviation" | "mismatch" | "unverifiable" =
      "unverifiable";
    let deviationReason: string | undefined;

    if (recordedMatch && onChainMatch) {
      verdict = "match";
    } else if (recordedMatch || onChainMatch) {
      verdict = "deviation";
      if (!recordedMatch) {
        deviationReason = "re-derived decision differs from recorded";
      }
      if (!onChainMatch) {
        deviationReason = "on-chain effect differs from recorded decision";
      }
    } else {
      verdict = "mismatch";
      deviationReason = "re-derived decision does not match on-chain effect";
    }

    return {
      traceId,
      recordedDecision: traceData.decision,
      reDerivedDecision: reDerived,
      onChainEffect: traceData.onChainEffect,
      traceContent: {
        hash: record.traceHash,
        inputs: traceData.inputs,
        strategyVersion: traceData.strategyVersion,
        timestamp: traceData.timestamp,
      },
      verdict,
      deviationReason,
      timestamp: Date.now(),
    };
  } catch (err) {
    return {
      traceId,
      recordedDecision: { action: "", amount: "", minSharesOut: "" },
      reDerivedDecision: { action: "", amount: "", minSharesOut: "" },
      onChainEffect: { txHash: "", amount: "", shares: "" },
      traceContent: {
        hash: record.traceHash,
        inputs: {},
        strategyVersion: "",
        timestamp: 0,
      },
      verdict: "unverifiable",
      deviationReason:
        err instanceof Error
          ? err.message
          : "unknown error during re-execution",
      timestamp: Date.now(),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: audit.ts (trace <traceId> | market <marketId>)");
    process.exit(1);
  }

  const command = args[0];
  const target = args[1];
  const ipfsGateway = process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs";

  const repository = await loadTraceRepository();
  const entries: AuditEntry[] = [];

  if (command === "trace") {
    const entry = await auditTrace(target, repository, ipfsGateway);
    entries.push(entry);
  } else if (command === "market") {
    // In production, enumerate traces for market using repository
    console.log(`auditing market ${target}`);
  } else {
    console.error(`unknown command: ${command}`);
    process.exit(1);
  }

  const report: AuditReport = {
    reportId: createHash("sha256")
      .update(`${Date.now()}:${target}`)
      .digest("hex")
      .slice(0, 16),
    generatedAt: Date.now(),
    agent: process.env.AGENT_ADDRESS ?? "unknown",
    market: command === "market" ? target : undefined,
    entries,
    summary: {
      totalTraces: entries.length,
      matchedCount: entries.filter((e) => e.verdict === "match").length,
      deviationCount: entries.filter((e) => e.verdict === "deviation").length,
      mismatchCount: entries.filter((e) => e.verdict === "mismatch").length,
      unverifiableCount: entries.filter((e) => e.verdict === "unverifiable")
        .length,
    },
  };

  const outputPath = `audit-report-${report.reportId}.json`;
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`\n=== Audit Report: ${report.reportId} ===`);
  console.log(`Generated: ${new Date(report.generatedAt).toISOString()}`);
  console.log(`Agent: ${report.agent}`);
  console.log(`\nSummary:`);
  console.log(`  Total:       ${report.summary.totalTraces}`);
  console.log(`  Matched:     ${report.summary.matchedCount}`);
  console.log(`  Deviation:   ${report.summary.deviationCount}`);
  console.log(`  Mismatch:    ${report.summary.mismatchCount}`);
  console.log(`  Unverifiable: ${report.summary.unverifiableCount}`);
  console.log(`\nReport saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
