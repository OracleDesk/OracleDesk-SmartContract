#!/usr/bin/env -S npx tsx
/**
 * Cross-market consistency arbitrage CLI (#108).
 *
 * Scans configured or auto-discovered market relations for Dutch books and
 * monotonic threshold violations, sizes multi-leg FPMM trades accounting for
 * curvature and fees, and executes them with pre-quote checks and unwind
 * recovery.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { LocalTraceStore } from "../core/trace.js";
import {
  discoverMonotonicChains,
  loadRelations,
  validateRelations,
  type ArbMarketSnapshot,
  type MarketRelation,
} from "../core/arb/relations.js";
import { scanAllArbitrage } from "../core/arb/detect.js";
import { executeArbitrage } from "../core/arb/execute.js";
import { loadAgentConfig } from "../core/config.js";
import { buildAdapter } from "../runtime/wiring.js";
import type { StellarAdapter } from "../stellar/adapter.js";

export async function runArbScan(
  adapter: StellarAdapter,
  markets: ArbMarketSnapshot[],
  relations: MarketRelation[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const traceStore = new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces");
  const marketsById = new Map(markets.map((m) => [m.marketId, m]));
  const autoChains = discoverMonotonicChains(markets);
  const validated = validateRelations([...relations, ...autoChains], marketsById);
  const opportunities = scanAllArbitrage(validated, marketsById, {
    minProfitStroops: BigInt(env.ARB_MIN_PROFIT_STROOPS ?? "1000"),
  });

  const results = [];
  for (const opp of opportunities) {
    console.log(`[arb] opportunity (${opp.kind}): ${opp.reasoning}`);
    const exec = await executeArbitrage(opp, marketsById, adapter, traceStore);
    results.push({ opp, exec });
  }
  return results;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadAgentConfig({ role: "trader", env: process.env, argv: process.argv.slice(2) })
    .then((cfg) => {
      const adapter = buildAdapter(cfg);
      const relations = process.env.ARB_RELATIONS_PATH
        ? loadRelations(process.env.ARB_RELATIONS_PATH)
        : [];
      return runArbScan(adapter, [], relations);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
