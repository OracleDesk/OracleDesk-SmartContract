/**
 * Pure classification and settlement-delta helpers for the scheduled testnet canary (#130).
 *
 * Failure classes:
 *   - `healthy`    All contracts, wiring, and cycle checks passed.
 *   - `reset`      All contracts + deployer missing OR RPC latestLedger regressed.
 *   - `drift`      Partial missing/archived contracts OR wiring/funding mismatch.
 *   - `degraded`   RPC error or timeout (requires >= 2 consecutive failures to file an issue).
 *   - `functional` Existence and wiring passed, but the end-to-end market cycle failed.
 */

export const REQUIRED_CONTRACTS = [
  'usdc',
  'market_core',
  'resolver',
  'treasury',
  'reasoning_registry',
];

/**
 * Classify a canary observation into a structured verdict with issue-filing guidance.
 */
export function classifyCanaryRun(observation) {
  const {
    rpcError = null,
    consecutiveRpcFailures = 0,
    latestLedger = null,
    previousLatestLedger = null,
    contractsPresent = {},
    deployerPresent = true,
    wiringErrors = [],
    cycleError = null,
  } = observation;

  // 1. Transient RPC failures / timeouts
  if (rpcError) {
    const failures = consecutiveRpcFailures + 1;
    return {
      status: 'degraded',
      shouldRunCycle: false,
      shouldFileIssue: failures >= 2,
      consecutiveRpcFailures: failures,
      issueTitle: 'Testnet canary: degraded',
      summary: `RPC error (${failures} consecutive failure(s)): ${rpcError}`,
    };
  }

  // 2. Ledger regression is an unambiguous network reset signal
  if (
    typeof latestLedger === 'number' &&
    typeof previousLatestLedger === 'number' &&
    latestLedger < previousLatestLedger
  ) {
    return {
      status: 'reset',
      shouldRunCycle: false,
      shouldFileIssue: true,
      consecutiveRpcFailures: 0,
      issueTitle: 'Testnet canary: reset',
      summary: `Ledger sequence regressed from ${previousLatestLedger} to ${latestLedger}, indicating a Stellar testnet reset.`,
    };
  }

  // 3. Contract existence check
  const presentCount = REQUIRED_CONTRACTS.filter((k) => Boolean(contractsPresent[k])).length;
  const missingContracts = REQUIRED_CONTRACTS.filter((k) => !contractsPresent[k]);

  if (presentCount === 0 && !deployerPresent) {
    return {
      status: 'reset',
      shouldRunCycle: false,
      shouldFileIssue: true,
      consecutiveRpcFailures: 0,
      issueTitle: 'Testnet canary: reset',
      summary: 'All recorded contracts and the deployer account are absent (testnet reset).',
    };
  }

  if (missingContracts.length > 0 || !deployerPresent) {
    return {
      status: 'drift',
      shouldRunCycle: false,
      shouldFileIssue: true,
      consecutiveRpcFailures: 0,
      issueTitle: 'Testnet canary: drift',
      summary: `Missing/archived state: contracts=[${missingContracts.join(', ')}], deployerPresent=${deployerPresent}.`,
    };
  }

  // 4. Wiring check
  if (Array.isArray(wiringErrors) && wiringErrors.length > 0) {
    return {
      status: 'drift',
      shouldRunCycle: false,
      shouldFileIssue: true,
      consecutiveRpcFailures: 0,
      issueTitle: 'Testnet canary: drift',
      summary: `Wiring mismatch(es): ${wiringErrors.join('; ')}`,
    };
  }

  // 5. Cycle check
  if (cycleError) {
    return {
      status: 'functional',
      shouldRunCycle: true,
      shouldFileIssue: true,
      consecutiveRpcFailures: 0,
      issueTitle: 'Testnet canary: functional',
      summary: `End-to-end market cycle failed: ${cycleError}`,
    };
  }

  return {
    status: 'healthy',
    shouldRunCycle: true,
    shouldFileIssue: false,
    consecutiveRpcFailures: 0,
    issueTitle: null,
    summary: 'All existence, wiring, and end-to-end cycle checks passed.',
  };
}

/**
 * Verify that the canary's collateral balance decreased by at most `maxLossStroops`
 * (protocol fees + rounding dust) over a full create -> buy -> resolve -> redeem/claim cycle.
 */
export function assertBalanceDeltaWithinBound(balanceBefore, balanceAfter, maxLossStroops) {
  const before = BigInt(balanceBefore);
  const after = BigInt(balanceAfter);
  const maxLoss = BigInt(maxLossStroops);
  const delta = before - after;
  if (delta > maxLoss) {
    throw new Error(
      `Canary collateral loss ${delta.toString()} stroops exceeded max allowed ${maxLoss.toString()} stroops`
    );
  }
  return { ok: true, lossStroops: delta.toString() };
}
