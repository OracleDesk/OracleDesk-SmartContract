import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMetrics, OTHER_NETWORK, startMetricsServer } from "./metrics.js";
import { MemoryPaymentLedger } from "./payment-ledger.js";

function labelValues(text: string, metric: string, label: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`^${metric}\\{([^}]*)\\}`, "gm");
  for (const m of text.matchAll(re)) {
    const l = new RegExp(`${label}="([^"]*)"`).exec(m[1]!);
    if (l) out.add(l[1]!);
  }
  return out;
}

test("stage counters increment once per observation", async () => {
  const m = createMetrics({ networks: ["stellar:testnet"] });
  m.observeStage("prepare", "ok", "stellar:testnet", 0.01);
  m.observeStage("verify", "ok", "stellar:testnet", 0.02);
  m.observeStage("settle", "ok", "stellar:testnet", 0.03);
  m.observeStage("deliver", "ok", "stellar:testnet");
  const values = (await m.stage.get()).values;
  for (const stage of ["prepare", "verify", "settle", "deliver"])
    assert.equal(
      values.find((v) => v.labels.stage === stage)?.value,
      1,
      stage,
    );
});

test("label values stay within closed sets after 1,000 random requests", async () => {
  const m = createMetrics({ networks: ["stellar:testnet", "stellar:pubnet"] });
  for (let i = 0; i < 1000; i++) {
    const network = i % 3 === 0 ? `attacker:${Math.random()}` : "stellar:testnet";
    m.observeStage("prepare", i % 2 ? "ok" : "error", network, Math.random());
    m.observeUpstream("registry", "ok", Math.random());
    m.observeError("trace_not_found");
    m.observeTransition(["verifying"], "settling");
  }
  const text = await m.registry.metrics();
  assert.deepEqual(
    labelValues(text, "x402_stage_total", "network"),
    new Set(["stellar:testnet", OTHER_NETWORK]),
  );
  assert.ok(labelValues(text, "x402_stage_total", "outcome").size <= 4);
  assert.ok(!/attacker/.test(text));
  // No id-like label values anywhere.
  assert.ok(!/="[0-9a-f]{32,}"/.test(text));
});

test("ledger state gauge is sampled from countByState on scrape", async () => {
  const ledger = new MemoryPaymentLedger();
  let calls = 0;
  const m = createMetrics({
    countByState: () => {
      calls++;
      return ledger.countByState();
    },
  });
  assert.equal(calls, 0);
  const text = await m.registry.metrics();
  assert.equal(calls, 1);
  assert.match(text, /x402_ledger_entries\{state="settled"\} 0/);
});

test("/metrics is served only on the metrics listener", async () => {
  const m = createMetrics();
  const server = startMetricsServer(0, m, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /x402_errors_total/);
    const other = await fetch(`http://127.0.0.1:${port}/traces/1`);
    assert.equal(other.status, 404);
  } finally {
    server.close();
  }
});
