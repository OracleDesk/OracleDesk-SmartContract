import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTracer, HashChainedAuditLog, MetricsRegistry } from "./observability.js";

test("AgentTracer records spans with duration, attributes, and error status", async () => {
  const tracer = new AgentTracer();
  const out = await tracer.withSpan("trader.cycle", { marketId: 5 }, async (span) => {
    span.setAttribute("action", "buy");
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(tracer.spans().length, 1);
  assert.equal(tracer.spans()[0].status, "ok");
  assert.equal(tracer.spans()[0].attributes.action, "buy");

  await assert.rejects(
    () =>
      tracer.withSpan("trader.submit", { marketId: 5 }, async () => {
        throw new Error("rpc timeout");
      }),
    /rpc timeout/,
  );
  assert.equal(tracer.spans()[1].status, "error");
  assert.equal(tracer.spans()[1].errorMessage, "rpc timeout");
});

test("MetricsRegistry exports counters, gauges, and histograms in Prometheus format", () => {
  const reg = new MetricsRegistry();
  reg.incCounter("oracledesk_agent_decisions_total", { action: "buy", role: "trader" }, 2);
  reg.incCounter("oracledesk_agent_decisions_total", { action: "skip", role: "trader" }, 5);
  reg.setGauge("oracledesk_treasury_daily_usage_stroops", 250_000_000);
  reg.observeHistogram("oracledesk_edge_bps", 800);
  reg.observeHistogram("oracledesk_edge_bps", 1200);

  const text = reg.toPrometheusText();
  assert.match(text, /oracledesk_agent_decisions_total\{action="buy",role="trader"\} 2/);
  assert.match(text, /oracledesk_treasury_daily_usage_stroops 250000000/);
  assert.match(text, /oracledesk_edge_bps_count 2/);
  assert.match(text, /oracledesk_edge_bps_sum 2000/);
});

test("HashChainedAuditLog links entries via prevHash and detects any tampered line", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-log-"));
  const logPath = join(dir, "audit.jsonl");
  const log = new HashChainedAuditLog(logPath);

  const e0 = log.append({
    timestamp: 1_700_000_000,
    agent: "trader",
    marketId: 1,
    decisionAction: "buy",
    traceHash: "a".repeat(64),
    traceCid: "ipfs://bafy1",
    txHash: "b".repeat(64),
    onChainResult: { sharesOut: "120000000" },
  });
  const e1 = log.append({
    timestamp: 1_700_000_060,
    agent: "trader",
    marketId: 2,
    decisionAction: "buy",
    traceHash: "c".repeat(64),
    traceCid: "ipfs://bafy2",
    untracedTradeAlert: true,
  });

  assert.equal(e0.seq, 0);
  assert.equal(e1.seq, 1);
  assert.equal(e1.prevHash, e0.entryHash);
  assert.deepEqual(HashChainedAuditLog.verifyFile(logPath), { valid: true, count: 2 });

  // Tamper with line 0 and verify chain fails
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  lines[0] = lines[0].replace('"marketId":1', '"marketId":99');
  writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  assert.deepEqual(HashChainedAuditLog.verifyFile(logPath), {
    valid: false,
    count: 2,
    brokenAtSeq: 0,
  });
});
