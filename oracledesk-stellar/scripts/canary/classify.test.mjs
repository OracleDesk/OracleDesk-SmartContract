import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_CONTRACTS,
  assertBalanceDeltaWithinBound,
  classifyCanaryRun,
} from './classify.mjs';

function allPresent() {
  return Object.fromEntries(REQUIRED_CONTRACTS.map((k) => [k, true]));
}

function allMissing() {
  return Object.fromEntries(REQUIRED_CONTRACTS.map((k) => [k, false]));
}

describe('testnet canary classifier (#130)', () => {
  test('all_present_is_healthy', () => {
    const verdict = classifyCanaryRun({
      latestLedger: 1_200_000,
      previousLatestLedger: 1_199_500,
      contractsPresent: allPresent(),
      deployerPresent: true,
      wiringErrors: [],
      cycleError: null,
    });
    assert.equal(verdict.status, 'healthy');
    assert.equal(verdict.shouldRunCycle, true);
    assert.equal(verdict.shouldFileIssue, false);
  });

  test('all_missing_is_reset', () => {
    const verdict = classifyCanaryRun({
      latestLedger: 1_200_000,
      previousLatestLedger: 1_199_500,
      contractsPresent: allMissing(),
      deployerPresent: false,
    });
    assert.equal(verdict.status, 'reset');
    assert.equal(verdict.shouldRunCycle, false);
    assert.equal(verdict.shouldFileIssue, true);
    assert.equal(verdict.issueTitle, 'Testnet canary: reset');
  });

  test('partial_missing_is_drift', () => {
    const partial = allPresent();
    partial.resolver = false;
    const verdict = classifyCanaryRun({
      latestLedger: 1_200_000,
      previousLatestLedger: 1_199_500,
      contractsPresent: partial,
      deployerPresent: true,
    });
    assert.equal(verdict.status, 'drift');
    assert.equal(verdict.shouldRunCycle, false);
    assert.equal(verdict.shouldFileIssue, true);
    assert.equal(verdict.issueTitle, 'Testnet canary: drift');
  });

  test('ledger_regression_is_reset', () => {
    const verdict = classifyCanaryRun({
      latestLedger: 10_000,
      previousLatestLedger: 1_199_500,
      contractsPresent: allPresent(),
      deployerPresent: true,
    });
    assert.equal(verdict.status, 'reset');
    assert.equal(verdict.shouldRunCycle, false);
    assert.equal(verdict.shouldFileIssue, true);
  });

  test('single_rpc_timeout_is_not_filed', () => {
    const first = classifyCanaryRun({
      rpcError: 'HTTP 504 timeout',
      consecutiveRpcFailures: 0,
    });
    assert.equal(first.status, 'degraded');
    assert.equal(first.shouldFileIssue, false);
    assert.equal(first.consecutiveRpcFailures, 1);

    const second = classifyCanaryRun({
      rpcError: 'HTTP 504 timeout',
      consecutiveRpcFailures: first.consecutiveRpcFailures,
    });
    assert.equal(second.status, 'degraded');
    assert.equal(second.shouldFileIssue, true);
    assert.equal(second.consecutiveRpcFailures, 2);
  });

  test('cycle failure classifies as functional and balance delta bound catches regressions', () => {
    const verdict = classifyCanaryRun({
      latestLedger: 1_200_000,
      previousLatestLedger: 1_199_500,
      contractsPresent: allPresent(),
      deployerPresent: true,
      wiringErrors: [],
      cycleError: 'verify_trace returned false',
    });
    assert.equal(verdict.status, 'functional');
    assert.equal(verdict.shouldFileIssue, true);

    const ok = assertBalanceDeltaWithinBound(3_000_000_000n, 2_999_900_000n, 500_000n);
    assert.equal(ok.ok, true);
    assert.equal(ok.lossStroops, '100000');

    assert.throws(
      () => assertBalanceDeltaWithinBound(3_000_000_000n, 2_900_000_000n, 500_000n),
      /exceeded max allowed/i
    );
  });
});
