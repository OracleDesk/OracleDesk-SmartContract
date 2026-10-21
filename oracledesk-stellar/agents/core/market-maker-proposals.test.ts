import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDynamicSeedStroops,
  isDuplicateQuestion,
  validateResolutionClarity,
} from "./market-maker-proposals.js";

test("isDuplicateQuestion detects semantically equivalent open markets and ignores resolved ones", () => {
  const existing = [
    {
      marketId: 1,
      question: "Will Bitcoin exceed 100000 USD before December 2026?",
      closeTimeSec: 1_800_000_000,
      resolved: false,
    },
    {
      marketId: 2,
      question: "Will Ethereum gas drop below 5 gwei in May?",
      closeTimeSec: 1_750_000_000,
      resolved: true,
    },
  ];

  const dup = isDuplicateQuestion(
    "Will Bitcoin reach 100000 USD by December 2026?",
    existing,
    0.6,
  );
  assert.equal(dup.duplicate, true);
  assert.equal(dup.matchedMarketId, 1);

  // Resolved market #2 should not block a new proposal
  const resolvedMatch = isDuplicateQuestion(
    "Will Ethereum gas drop below 5 gwei in May?",
    existing,
    0.6,
  );
  assert.equal(resolvedMatch.duplicate, false);
});

test("validateResolutionClarity rejects subjective or near-expiry questions", () => {
  const now = 1_750_000_000;
  const good = validateResolutionClarity(
    {
      source: "stellar-ledger",
      question: "Will Stellar mainnet process over 5000000 Soroban invocations on 2026-11-01?",
      closeTimeSec: now + 86_400,
      estimatedYesBps: 5500,
      confidenceBps: 2500,
    },
    now,
  );
  assert.equal(good.valid, true);

  const subjective = validateResolutionClarity(
    {
      source: "news",
      question: "Will the next Stellar upgrade be considered successful by users?",
      closeTimeSec: now + 86_400,
      estimatedYesBps: 5000,
      confidenceBps: 2500,
    },
    now,
  );
  assert.equal(subjective.valid, false);
  assert.match(subjective.reason ?? "", /subjective/i);
});

test("computeDynamicSeedStroops scales liquidity by confidence and clamps to treasury allowance", () => {
  const cfg = {
    minSeedStroops: 500_000_000n,
    maxSeedStroops: 2_500_000_000n,
    treasuryRemainingDailyStroops: 1_800_000_000n,
    minConfidenceBps: 2000,
  };

  assert.equal(computeDynamicSeedStroops(1500, cfg), 0n);
  assert.equal(computeDynamicSeedStroops(2000, cfg), 500_000_000n);
  // High confidence would target 2.5B but clamps to 1.8B remaining daily allowance
  assert.equal(computeDynamicSeedStroops(10_000, cfg), 1_800_000_000n);
});
