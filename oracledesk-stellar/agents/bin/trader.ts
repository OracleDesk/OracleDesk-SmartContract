#!/usr/bin/env -S npx tsx
/**
 * Trader agent, one shot: reads chain state, compares implied price to a
 * fair-value estimate, and trades the mispricing if the edge clears the
 * configured threshold. Every trade is preceded by a recorded trace.
 *
 * Bounds are never zero: the trade size comes from the strategy, then a
 * fresh `quote_buy` immediately before submission turns into
 * `min_shares_out` (quote minus SLIPPAGE_BPS) and a `limit_price_bps`
 * backstop, plus a `deadline` — so a stale or sandwiched transaction
 * reverts on-chain instead of executing at an arbitrary price.
 *
 * A thin wrapper over the runtime's trader task (runtime/tasks/trader.ts),
 * run exactly once under the single-instance lease; `npm run agentd` runs
 * the same task continuously. Defaults to dry-run. Set AGENT_MODE=live and
 * TRADER_SECRET_KEY (or the shared AGENT_SECRET_KEY) to submit real testnet
 * transactions — see .env.example.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { EXIT_CONFIG, EXIT_TEMPFAIL, parseAgentMode } from "../runtime/config.js";
import { LeaseHeldError } from "../runtime/lease.js";
import { Runtime } from "../runtime/runtime.js";
import { traderTask } from "../runtime/tasks/trader.js";
import { buildAdapter, createLease, createStateStore, loadDeployments, runtimeOptions, traderDeps } from "../runtime/wiring.js";
import type { StellarAdapter } from "../stellar/adapter.js";

/**
 * Exported (and injectable) so tests can drive the whole trade flow with a
 * fake adapter and clock. `now` returns unix seconds. An adapter bound to a
 * deployment reads markets from chain state; one without (a test fake)
 * trades the demo fixture market.
import { buildTrace, type TraceStore } from "../core/trace.js";
import { createTraceStore } from "../core/trace-store-factory.js";
import { BPS } from "../core/fpmm.js";
import { decideTrade, type MarketState } from "../core/strategy.js";
import { agentCredentials, loadDeployments, StellarAdapter } from "../stellar/adapter.js";
import { ChainStateReader } from "../core/state/reader.js";
import { SnapshotCache } from "../core/state/cache.js";
import { tradableMarkets, availableCapital } from "../core/state/select.js";
import { toMarketState } from "../core/state/types.js";
import { Server } from "@stellar/stellar-sdk/rpc";

/**
 * Exported (and injectable) so tests can drive the whole trade flow with a
 * fake adapter and clock. `now` returns unix seconds. The trace store
 * defaults to `createTraceStore(env, adapter.mode)` (TRACE_STORE=local|ipfs).
 */
export async function main(
  adapter: StellarAdapter,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Math.floor(Date.now() / 1000),
  traceStore: TraceStore = createTraceStore(env, adapter.mode).store,
): Promise<void> {
  const deployments = (adapter as Partial<StellarAdapter>).deployments;
  const runtime = new Runtime({
    tasks: [traderTask(traderDeps(env, adapter, deployments, now), { intervalMs: 0 })],
    state: await createStateStore(adapter.mode, env, deployments?.contracts.treasury ?? "unbound"),
    lease: createLease(env),
    ...runtimeOptions(env),
  });
  await runtime.runOnce();
  const deployments = adapter.deployments ?? {};

  const rpcUrl = env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new Server(rpcUrl);
  const stateReader = new ChainStateReader({
    marketContractId: deployments.market_contract ?? "",
    portfolioContractId: deployments.portfolio_contract ?? "",
    server,
  });
  const cache = new SnapshotCache();

  console.log(`[trader] mode=${adapter.mode}`);

  const snapshot = await cache.get(() => stateReader.readSnapshot([]));

  if (!snapshot.consistent) {
    console.warn(`[trader] ledger drift ${snapshot.ledgers.max - snapshot.ledgers.min} — snapshot may be inconsistent`);
  }

  const markets = tradableMarkets(snapshot);
  if (markets.length === 0) {
    console.log("[trader] no tradable markets on-chain");
    return;
  }

  const capital = availableCapital(snapshot);
  const tradeSizeStroops = BigInt(env.TRADE_SIZE_STROOPS ?? "100000000");
  if (capital < tradeSizeStroops) {
    console.log(`[trader] insufficient capital: ${capital} < ${tradeSizeStroops}`);
    return;
  }

  for (const chainMarket of markets) {
    const market: MarketState = toMarketState(chainMarket);
    // Fair value: use env override or default to complement of current price
    // (the agent holds no external oracle right now — strategy.ts decides edge)
    const fairValueBps = Number(env.FAIR_VALUE_BPS ?? String(market.yesBps));

    const decision = decideTrade(market, fairValueBps, {
      minEdgeBps: Number(env.MIN_EDGE_BPS ?? 500),
      tradeSizeStroops,
    });
    console.log(`[trader] market=${market.marketId} ${decision.action}: ${decision.reasoning}`);
    if (decision.action === "skip") continue;

    const built = buildTrace({
      agent: "trader",
      marketId: market.marketId,
      action: "buy",
      reasoning: decision.reasoning,
      inputs: { market, fairValueBps, decision },
    });
    // The trace must be pinned and verified before the trade: never trade
    // without a publishable trace.
    let cid: string;
    try {
      ({ cid } = await traceStore.put(built.hash, built.json));
    } catch (err) {
      console.error(`[trader] market=${market.marketId} skipped: trace ${built.hash} could not be stored:`, err);
      continue;
    }
    console.log(`[trader] trace ${built.hash} -> ${cid}`);

    const outcome = decision.outcome as "Yes" | "No";
    const collateralInStroops = decision.tradeSizeStroops!;

    const quotedShares = await adapter.quoteBuy({
      market_id: BigInt(market.marketId),
      outcome,
      collateral_in: collateralInStroops,
    });
    const slippageBps = BigInt(env.SLIPPAGE_BPS ?? 50);
    const minSharesOut = (quotedShares * (BPS - slippageBps)) / BPS;
    const limitPriceBps = decision.outcome === "Yes" ? fairValueBps : Number(BPS) - fairValueBps;
    const deadline = BigInt(now() + Number(env.DEADLINE_SECS ?? 60));
    console.log(
      `[trader] quote ${quotedShares} shares -> min_shares_out=${minSharesOut} limit_price_bps=${limitPriceBps} deadline=${deadline}`,
    );

    const result = await adapter.agentBuyV2({
      market_id: BigInt(market.marketId),
      outcome,
      collateral_in: collateralInStroops,
      min_shares_out: minSharesOut,
      limit_price_bps: limitPriceBps,
      deadline,
    });
    console.log("[trader] agent_buy_v2:", result);

    if (!result.dryRun) {
      const traceResult = await adapter.publishTrace({
        agent: adapter.agent,
        market_id: BigInt(market.marketId),
        action: "buy",
        trace_hash: Buffer.from(built.hash, "hex"),
        ipfs_cid: cid,
      });
      console.log("[trader] publish_trace:", traceResult);
    }
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let mode;
  try {
    mode = parseAgentMode(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(EXIT_CONFIG);
  }
  const deployments = loadDeployments();
  main(buildAdapter("trader", mode, process.env, deployments)).catch((err) => {
    console.error(err);
    process.exit(err instanceof LeaseHeldError ? EXIT_TEMPFAIL : 1);
  });
}
