#!/usr/bin/env -S npx tsx
/**
 * One-shot unwind planner (#150). Intended for treasury `Unwinding` mode:
 * reads every open market, plans inventory sales above each market's exit
 * floor, and submits bounded `unwind_sell` calls. Dry-run by default; set
 * AGENT_MODE=live to actually sell.
 *
 * Optional bounds:
 *   UNWIND_MAX_SHARES  largest slice per call (default: whole position)
 *   UNWIND_MAX_SLICES  slices per outcome per market (default: unlimited)
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadAgentConfig } from "../core/config.js";
import { planUnwind } from "../core/unwind.js";
import { buildTrace, LocalTraceStore } from "../core/trace.js";
import { ConfigError } from "../runtime/config.js";
import { buildAdapter } from "../runtime/wiring.js";
import type { StellarAdapter } from "../stellar/adapter.js";

function positiveBigInt(raw: string | undefined, name: string): bigint | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new ConfigError(`${name} must be a positive integer`);
  return BigInt(raw);
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  const value = positiveBigInt(raw, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ConfigError(`${name} is too large`);
  return n;
}

export async function runUnwind(
  adapter: StellarAdapter,
  env: NodeJS.ProcessEnv = process.env,
  nowSecs: () => number = () => Math.floor(Date.now() / 1000),
): Promise<number> {
  const mode = await adapter.treasuryMode();
  if (mode !== "Unwinding") throw new Error(`treasury mode is ${mode}, expected Unwinding`);

  const maxSharesPerTrade = positiveBigInt(env.UNWIND_MAX_SHARES, "UNWIND_MAX_SHARES");
  const maxSlices = positiveInt(env.UNWIND_MAX_SLICES, "UNWIND_MAX_SLICES");
  const traces = new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces");
  const count = Number(await adapter.marketCount());
  let submitted = 0;

  for (let i = 0; i < count; i += 1) {
    const marketId = BigInt(i);
    const market = await adapter.getMarket(marketId);
    if (!market || market.status !== "Open" || Number(market.closeTime) <= nowSecs()) continue;
    const position = await adapter.treasuryPosition(marketId);
    if (position.yes <= 0n && position.no <= 0n) continue;
    const read = await adapter.readMarket(marketId);
    const floor = await adapter.exitFloor(marketId);
    const [plan] = planUnwind(
      [{ marketId, pool: { reserveYes: read.reserveYes, reserveNo: read.reserveNo, feeBps: market.feeBps } }],
      new Map([[marketId, position]]),
      { exitFloorBps: floor, maxSharesPerTrade, maxSlices },
    );
    if (!plan) continue;
    for (const reason of plan.reasons) console.log(`[unwind] market=${i} stop: ${reason}`);
    for (const leg of plan.legs) {
      const maxSharesIn = (leg.sharesIn * 10_100n) / 10_000n;
      const result = await adapter.unwindSell({
        market_id: marketId,
        outcome: { tag: leg.outcome, values: undefined },
        collateral_out: leg.collateralOut,
        max_shares_in: maxSharesIn,
      });
      console.log(`[unwind] market=${i} ${leg.outcome} shares=${leg.sharesIn} out=${leg.collateralOut} priceBps=${leg.priceBps}`, result);
      if (result.dryRun || adapter.mode !== "live") continue;
      submitted += 1;
      const trace = buildTrace({
        agent: "trader",
        marketId: i,
        action: "sell",
        reasoning: `unwind ${leg.outcome} inventory at ${leg.priceBps} bps, floor ${floor} bps`,
        inputs: {
          marketId: String(marketId),
          outcome: leg.outcome,
          sharesIn: leg.sharesIn,
          collateralOut: leg.collateralOut,
          priceBps: leg.priceBps,
          exitFloorBps: floor,
          reserveYes: read.reserveYes,
          reserveNo: read.reserveNo,
        },
      });
      const { cid } = await traces.put(trace.hash, trace.json);
      await adapter.publishTrace({
        agent: adapter.agent,
        market_id: marketId,
        action: "sell",
        trace_hash: Buffer.from(trace.hash, "hex"),
        ipfs_cid: cid,
      });
    }
    if (plan.remaining.yes > 0n || plan.remaining.no > 0n) {
      console.log(`[unwind] market=${i} remaining yes=${plan.remaining.yes} no=${plan.remaining.no}`);
    }
  }
  return submitted;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadAgentConfig({ role: "trader" })
    .then(async (cfg) => {
      if (cfg.printConfig) {
        console.log(JSON.stringify({ mode: cfg.mode, network: cfg.network }, null, 2));
        return;
      }
      const count = await runUnwind(buildAdapter(cfg), cfg.env);
      console.log(`[unwind] submitted ${count} sale(s)`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(err instanceof ConfigError ? 2 : 1);
    });
}
