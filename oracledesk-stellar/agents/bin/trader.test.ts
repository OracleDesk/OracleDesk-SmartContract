import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StellarAdapter } from "../stellar/adapter.js";
import { main } from "./trader.js";

/** Placeholder market/fair-value pair the trader reads (yesBps 4000 vs
 * fair 6000 => a "buy Yes" decision at the default 500bps edge). */
const FAIR_VALUE_BPS = 6000;
const QUOTE_SHARES = 123_456n;

function fakeAdapter(quoteShares: bigint, calls: Record<string, unknown>[]): StellarAdapter {
  return {
    mode: "dry-run" as const,
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
  await main(fakeAdapter(QUOTE_SHARES, calls), env, () => 1_000_000);

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
  await main(fakeAdapter(QUOTE_SHARES, calls), env, () => 2_000_000);

  const args = calls[0];
  assert.equal(args.min_shares_out, (QUOTE_SHARES * 9_900n) / 10_000n);
  assert.equal(args.deadline, 2_000_030n);
});

test("live mode reads the market and its effective fee from the chain", async () => {
  const traceDir = await mkdtemp(join(tmpdir(), "trader-test-"));
  const env = { TRACE_STORE_DIR: traceDir, MARKET_ID: "7" };
  const reads: Array<[string, bigint]> = [];
  const adapter = {
    mode: "live" as const,
    quoteBuy: async () => QUOTE_SHARES,
    agentBuyV2: async (args: Record<string, unknown>) => ({
      dryRun: true as const,
      contractId: "CTREASURY",
      method: "agent_buy_v2",
      args,
    }),
    getMarket: async (args: { market_id: bigint }) => {
      reads.push(["get_market", args.market_id]);
      return {
        close_time: 2_000_000n,
        fee_bps: 100, // the flat snapshot; the schedule may charge more
        reserve_yes: 1_000_000_000_000_000n,
        reserve_no: 1_000_000_000_000_000n,
      };
    },
    currentFeeBps: async (args: { market_id: bigint }) => {
      reads.push(["current_fee_bps", args.market_id]);
      return 321; // the dynamic effective fee at the current ledger time
    },
  } as unknown as StellarAdapter;

  await main(adapter, env, () => 1_000_000);

  assert.deepEqual(reads, [
    ["get_market", 7n],
    ["current_fee_bps", 7n],
  ]);

  // The trace records the live market state, including the effective fee
  // (not the flat snapshot) and the reserves the quote was sized against.
  const traces = await readdir(traceDir);
  assert.equal(traces.length, 1);
  const trace = JSON.parse(await readFile(join(traceDir, traces[0]), "utf8")) as {
    inputs: { market: { feeBps: number; yesBps: number; reserveYesStroops: string } };
  };
  assert.equal(trace.inputs.market.feeBps, 321);
  assert.equal(trace.inputs.market.yesBps, 5000);
  assert.equal(trace.inputs.market.reserveYesStroops, "1000000000000000");
});
