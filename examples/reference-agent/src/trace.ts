/**
 * Reasoning traces: canonical JSON encoding and hashing.
 *
 * A trace is the agent's reasoning for a market action.
 * Traces must be published before the action is executed,
 * proving that the decision was made beforehand (not based on the outcome).
 */

import { createHash } from 'crypto';

/**
 * A single reasoning trace step.
 */
export interface TraceStep {
  timestamp: string;        // ISO 8601 timestamp
  action: 'create' | 'buy' | 'sell' | 'merge' | 'split';
  market_id?: number;
  outcome?: 'Yes' | 'No';
  amount?: string;          // Collateral or shares (as string for BigInt)
  reasoning: string;        // Human-readable explanation
  expected_value?: string;  // Why this action is EV+
}

/**
 * Canonicalize a trace object to JSON (for hashing).
 *
 * Canonical form:
 * - Keys sorted alphabetically
 * - No extra whitespace
 * - BigInts as strings (JSON doesn't support them natively)
 */
export function canonicalizeTrace(trace: TraceStep): string {
  const canonical = {
    action: trace.action,
    amount: trace.amount,
    expected_value: trace.expected_value,
    market_id: trace.market_id,
    outcome: trace.outcome,
    reasoning: trace.reasoning,
    timestamp: trace.timestamp,
  };

  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

/**
 * Compute the hash of a canonical trace.
 */
export function traceHash(trace: TraceStep): Buffer {
  const canonical = canonicalizeTrace(trace);
  return createHash('sha256').update(canonical).digest();
}

/**
 * Build a trace for a create_market action.
 */
export function buildCreateTrace(
  question: string,
  marketId: number,
  seedAmount: bigint,
  reasoning: string,
): TraceStep {
  return {
    timestamp: new Date().toISOString(),
    action: 'create',
    market_id: marketId,
    amount: seedAmount.toString(),
    reasoning: `${question}\n\nReasoning: ${reasoning}`,
  };
}

/**
 * Build a trace for a buy action.
 */
export function buildBuyTrace(
  marketId: number,
  outcome: 'Yes' | 'No',
  collateralIn: bigint,
  expectedShares: bigint,
  reasoning: string,
  expectedValue?: string,
): TraceStep {
  return {
    timestamp: new Date().toISOString(),
    action: 'buy',
    market_id: marketId,
    outcome,
    amount: collateralIn.toString(),
    reasoning,
    expected_value: expectedValue || `EV positive; expect ~${expectedShares.toString()} shares`,
  };
}

/**
 * Build a trace for a sell action.
 */
export function buildSellTrace(
  marketId: number,
  outcome: 'Yes' | 'No',
  sharesToSell: bigint,
  reasoning: string,
  expectedCollateral?: bigint,
): TraceStep {
  return {
    timestamp: new Date().toISOString(),
    action: 'sell',
    market_id: marketId,
    outcome,
    amount: sharesToSell.toString(),
    reasoning,
    expected_value: expectedCollateral ? `Expect ~${expectedCollateral.toString()} collateral` : undefined,
  };
}

/**
 * Golden test vectors for canonicalization.
 * These must match the outputs from agents/core/trace.ts.
 */
export const GOLDEN_VECTORS = [
  {
    input: {
      timestamp: '2024-01-01T12:00:00Z',
      action: 'buy' as const,
      market_id: 1,
      outcome: 'Yes' as const,
      amount: '1000000000',
      reasoning: 'Model says 70% prob',
      expected_value: 'EV+',
    },
    // Canonical form (keys sorted, no whitespace)
    expectedCanonical: '{"action":"buy","amount":"1000000000","expected_value":"EV+","market_id":1,"outcome":"Yes","reasoning":"Model says 70% prob","timestamp":"2024-01-01T12:00:00Z"}',
    // Hash must match agents/core/trace.ts output
    expectedHash: 'TODO_VERIFY_AGAINST_AGENTS_CORE',
  },
];

/**
 * Verify golden vectors match agent core implementation.
 * Run in tests and CI to catch encoding mismatches.
 */
export function verifyGoldenVectors(): boolean {
  console.log('Verifying trace canonicalization golden vectors...');

  for (const vector of GOLDEN_VECTORS) {
    const canonical = canonicalizeTrace(vector.input);
    if (canonical !== vector.expectedCanonical) {
      console.error(`Canonicalization mismatch!`);
      console.error(`  Expected: ${vector.expectedCanonical}`);
      console.error(`  Got:      ${canonical}`);
      return false;
    }
    console.log('✓ Canonical form matches');
  }

  return true;
}
