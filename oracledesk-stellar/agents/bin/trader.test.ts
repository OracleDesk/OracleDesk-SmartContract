import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTunables } from "../core/config.js";
import type { StellarAdapter } from "../stellar/adapter.js";
import { main } from "./trader.js";

/** Placeholder market/fair-value pair the trader reads (yesBps 4000 vs
 * fair 6000 => a "buy Yes" decision at the default 500bps edge). */
const FAIR_VALUE_BPS = 6000;
const QUOTE_SHARES = 123_456n;

const approved = async (marketId: bigint) => ({
  outcome: "allow" as const,
  reasons: [],
  commitments: "verified" as const,
  metadata: "verified" as const,
  resolutionPath: "verified" as const,
  oracleTrust: "not_applicable" as const,
  signerTrust: "not_applicable" as const,
  marketId: marketId.toString(),
  stateFingerprint: "fixture-market-state",
  checkedAt: Date.now(),
});

function fakeAdapter(quoteShares: bigint, calls: Record<string, unknown>[]): StellarAdapter {
  return {
    mode: "dry-run" as const,
    agent: "GTRADER",
    quoteBuy: async () => quoteShares,
    agentBuyV2: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { dryRun: true as const, contractId: "CTREASURY", method: "agent_buy_v2", args };
    },
  } as unknown as StellarAdapter;
}

test("trader computes non-zero min_shares_out and limit_price_bps from a fresh quote", async () => {
  const calls: Record<string, unknown>[] = [];
  const env = { TRACE_STORE_DIR: await mkdtemp(join(tmpdir(), "trader-test-")) };
  await main(fakeAdapter(QUOTE_SHARES, calls), parseTunables(env), () => 1_000_000, approved);

  assert.equal(calls.length, 1);
  const args = calls[0];
  // Default SLIPPAGE_BPS = 50: quote * (10000 - 50) / 10000, floored.
  const minSharesOut = (QUOTE_SHARES * 9_950n) / 10_000n;
  assert.equal(args.min_shares_out, minSharesOut);
  assert.ok((args.min_shares_out as bigint) > 0n);
  // Never pay more than fair for the outcome being bought: this is a YES
  // buy, so the limit is the fair YES value itself.
  assert.equal(args.limit_price_bps, FAIR_VALUE_BPS);
  // Default DEADLINE_SECS = 60, measured from the injected clock.
  assert.equal(args.deadline, 1_000_060n);
});

test("trader honours SLIPPAGE_BPS and DEADLINE_SECS overrides", async () => {
  const calls: Record<string, unknown>[] = [];
  const env = {
    TRACE_STORE_DIR: await mkdtemp(join(tmpdir(), "trader-test-")),
    SLIPPAGE_BPS: "100",
    DEADLINE_SECS: "30",
  };
  await main(fakeAdapter(QUOTE_SHARES, calls), parseTunables(env), () => 2_000_000, approved);

  const args = calls[0];
  assert.equal(args.min_shares_out, (QUOTE_SHARES * 9_900n) / 10_000n);
  assert.equal(args.deadline, 2_000_030n);
});
