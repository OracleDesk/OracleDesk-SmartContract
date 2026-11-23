/**
 * Tests for verdict-policy.ts (#306).
 * Verifies defaults, JSON validation, and policy decisions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadVerdictPolicy, decide, DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";
import type { TraceVerdict } from "./trace-verification.js";

test("loadVerdictPolicy: returns default when env var is unset", () => {
  const policy = loadVerdictPolicy({});
  assert.deepEqual(policy, DEFAULT_VERDICT_POLICY);
});

test("loadVerdictPolicy: throws on non-JSON", () => {
  assert.throws(
    () => loadVerdictPolicy({ X402_VERDICT_POLICY: "not-json{" }),
    /not valid JSON/,
  );
});

test("loadVerdictPolicy: throws on invalid onUnavailable", () => {
  assert.throws(
    () =>
      loadVerdictPolicy({
        X402_VERDICT_POLICY: JSON.stringify({ onUnavailable: "accept" }),
      }),
    /onUnavailable/,
  );
});

test("loadVerdictPolicy: throws when priceMultiplierBps is set (not supported yet)", () => {
  assert.throws(
    () =>
      loadVerdictPolicy({
        X402_VERDICT_POLICY: JSON.stringify({
          byTag: { HashMismatch: { kind: "sell", priceMultiplierBps: 200 } },
        }),
      }),
    /priceMultiplierBps/,
  );
});

test("loadVerdictPolicy: accepts valid sell override", () => {
  const policy = loadVerdictPolicy({
    X402_VERDICT_POLICY: JSON.stringify({
      onUnavailable: "sell_unverified",
      byTag: { AgentRevokedAfter: { kind: "sell", warn: true } },
    }),
  });
  assert.equal(policy.onUnavailable, "sell_unverified");
  assert.deepEqual(policy.byTag["AgentRevokedAfter"], { kind: "sell", warn: true });
  // Other tags still default to refuse
  assert.equal(policy.byTag["HashMismatch"]?.kind, "refuse");
});

// ── decide() ────────────────────────────────────────────────────────────────

test("decide: Valid returns sell without warning", () => {
  const action = decide({ tag: "Valid" }, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "sell", warn: false });
});

test("decide: HashMismatch returns refuse 409", () => {
  const action = decide({ tag: "HashMismatch" }, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "refuse", status: 409 });
});

test("decide: Flagged returns refuse 451", () => {
  const verdict: TraceVerdict = { tag: "Flagged", values: ["fabricated"] };
  const action = decide(verdict, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "refuse", status: 451 });
});

test("decide: AgentRevokedAfter returns refuse 451", () => {
  const verdict: TraceVerdict = { tag: "AgentRevokedAfter", values: [1234n] };
  const action = decide(verdict, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "refuse", status: 451 });
});

test("decide: unavailable returns refuse 503 by default", () => {
  const action = decide("unavailable", DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "refuse", status: 503 });
});

test("decide: unavailable returns sell_unverified when policy is sell_unverified", () => {
  const policy = loadVerdictPolicy({
    X402_VERDICT_POLICY: JSON.stringify({ onUnavailable: "sell_unverified" }),
  });
  const action = decide("unavailable", policy);
  assert.deepEqual(action, { kind: "sell", warn: true });
});

test("decide: unknown future tag defaults to refuse 451", () => {
  // Simulate a future variant the client doesn't know about
  const unknownVerdict = { tag: "FutureVariant" } as unknown as TraceVerdict;
  const action = decide(unknownVerdict, DEFAULT_VERDICT_POLICY);
  assert.deepEqual(action, { kind: "refuse", status: 451 });
});
