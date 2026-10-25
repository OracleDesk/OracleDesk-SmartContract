import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { decideTrade, type MarketState } from "./strategy.js";
import { hashTrace } from "./trace.js";
import { auditTraceReplay, type ReplayableTrace } from "./replay.js";

const SAMPLE_MARKET: MarketState = {
  marketId: 7,
  question: "Will Soroban daily transactions exceed 1M?",
  yesBps: 4000,
  closeTime: 1_800_000_000,
};

test("auditTraceReplay deterministically reproduces decideTrade@1 and signs the report", () => {
  const params = { minEdgeBps: 500, tradeSizeStroops: "100000000" };
  const decision = decideTrade(SAMPLE_MARKET, 6500, {
    minEdgeBps: 500,
    tradeSizeStroops: 100_000_000n,
  });

  const trace: ReplayableTrace = {
    agent: "trader",
    marketId: 7,
    action: "buy",
    reasoning: decision.reasoning,
    inputs: {
      market: SAMPLE_MARKET,
      fairValueBps: 6500,
      decision,
      strategy: {
        id: "decideTrade",
        version: "1",
        gitCommit: "abcdef1",
        params,
      },
    },
    timestamp: 1_750_000_000,
  };

  const kp = Keypair.random();
  const report = auditTraceReplay(trace, {
    expectedTraceHash: hashTrace(trace),
    onChainEffect: {
      action: "buy",
      marketId: 7,
      outcome: "Yes",
      collateralStroops: 100_000_000n,
    },
    signerKeypair: kp,
  });

  assert.equal(report.status, "verified");
  assert.equal(report.strategyKey, "decideTrade@1");
  assert.ok(report.signatureHex);
  assert.equal(
    kp.verify(Buffer.from(report.reportHash, "hex"), Buffer.from(report.signatureHex!, "hex")),
    true,
  );
});

test("auditTraceReplay reports legacy traces without strategy metadata as not_replayable", () => {
  const legacyTrace: ReplayableTrace = {
    agent: "trader",
    marketId: 1,
    action: "buy",
    reasoning: "legacy trace without strategy block",
    inputs: { market: SAMPLE_MARKET, fairValueBps: 6000 },
    timestamp: 1_700_000_000,
  };

  const report = auditTraceReplay(legacyTrace);
  assert.equal(report.status, "not_replayable");
});

test("auditTraceReplay detects tampered decisions, hash mismatches, and on-chain effect drift", () => {
  const decision = decideTrade(SAMPLE_MARKET, 6500, {
    minEdgeBps: 500,
    tradeSizeStroops: 100_000_000n,
  });

  const tamperedTrace: ReplayableTrace = {
    agent: "trader",
    marketId: 7,
    action: "buy",
    reasoning: decision.reasoning,
    inputs: {
      market: SAMPLE_MARKET,
      fairValueBps: 6500,
      decision: { ...decision, outcome: "No" }, // tampered outcome!
      strategy: {
        id: "decideTrade",
        version: "1",
        params: { minEdgeBps: 500, tradeSizeStroops: "100000000" },
      },
    },
    timestamp: 1_750_000_000,
  };

  const rMismatch = auditTraceReplay(tamperedTrace);
  assert.equal(rMismatch.status, "decision_mismatch");

  const rHashFail = auditTraceReplay(tamperedTrace, {
    expectedTraceHash: "0".repeat(64),
  });
  assert.equal(rHashFail.status, "hash_mismatch");

  const validTrace: ReplayableTrace = {
    ...tamperedTrace,
    inputs: { ...tamperedTrace.inputs, decision },
  };
  const rChainFail = auditTraceReplay(validTrace, {
    onChainEffect: {
      action: "buy",
      marketId: 7,
      outcome: "No", // on-chain trade went opposite to trace!
      collateralStroops: 100_000_000n,
    },
  });
  assert.equal(rChainFail.status, "onchain_mismatch");
});
