import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAuditGate, parseAuditReport } from "./npm-audit-gate.mjs";

function sampleReport({ id = "GHSA-1111-2222-3333", pkg = "express", severity = "high", dev = false }) {
  return {
    vulnerabilities: {
      [pkg]: {
        severity,
        dev,
        via: [
          {
            name: pkg,
            severity,
            title: `Test advisory ${id}`,
            url: `https://github.com/advisories/${id}`,
          },
        ],
      },
    },
  };
}

test("fails_on_unlisted_high", () => {
  const findings = parseAuditReport(sampleReport({ severity: "high" }), "x402");
  const result = evaluateAuditGate(findings, [], "2026-11-19");
  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, "GHSA-1111-2222-3333");
});

test("passes_on_allowlisted_unexpired", () => {
  const findings = [
    ...parseAuditReport(sampleReport({ severity: "high" }), "agents"),
    ...parseAuditReport(sampleReport({ severity: "high" }), "packages/bindings/market-core"),
  ];
  const allowlist = [
    {
      id: "GHSA-1111-2222-3333",
      package: "express",
      reason: "Awaiting upstream fix",
      expires: "2026-12-31",
    },
  ];
  const result = evaluateAuditGate(findings, allowlist, "2026-11-19");
  assert.equal(result.ok, true);
  assert.equal(result.blocked.length, 0);
  // Deduplicated across multiple packages into a single allowlisted entry.
  assert.equal(result.allowlisted.length, 1);
  assert.deepEqual(result.allowlisted[0].finding.sources.sort(), [
    "agents",
    "packages/bindings/market-core",
  ]);
});

test("fails_on_expired_allowlist_entry", () => {
  const findings = parseAuditReport(sampleReport({ severity: "high" }), "x402");
  const allowlist = [
    {
      id: "GHSA-1111-2222-3333",
      package: "express",
      reason: "Expired exception",
      expires: "2026-01-01",
    },
  ];
  const result = evaluateAuditGate(findings, allowlist, "2026-11-19");
  assert.equal(result.ok, false);
  assert.equal(result.expiredEntries.length, 1);
  assert.equal(result.blocked.length, 1);
});

test("ignores_dev_only_findings", () => {
  const findings = parseAuditReport(
    sampleReport({ id: "GHSA-9999-8888-7777", pkg: "tsx", severity: "critical", dev: true }),
    "agents"
  );
  const result = evaluateAuditGate(findings, [], "2026-11-19");
  assert.equal(result.ok, true);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.ignoredDevOnly.length, 1);
});
