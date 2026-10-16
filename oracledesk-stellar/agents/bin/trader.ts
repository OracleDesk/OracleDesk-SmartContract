#!/usr/bin/env -S npx tsx
/**
 * Trader agent: reads a market's current implied price, compares it to a
 * fair-value estimate, and trades the mispricing if the edge clears the
 * configured threshold. Every trade is preceded by a recorded trace.
 *
 * Bounds are never zero: the trade size comes from the strategy, then a
 * fresh `quote_buy` immediately before submission turns into
 * `min_shares_out` (quote minus SLIPPAGE_BPS) and a `limit_price_bps`
 * backstop, plus a `deadline` — so a stale or sandwiched transaction
 * reverts on-chain instead of executing at an arbitrary price.
 *
 * Defaults to dry-run. Set AGENT_MODE=live and AGENT_SECRET_KEY to submit
 * real testnet transactions — see .env.example.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { buildTrace, LocalTraceStore } from "../core/trace.js";
import { BPS, priceYesBps } from "../core/fpmm.js";
import { decideTrade, type MarketState } from "../core/strategy.js";
import { loadDeployments, StellarAdapter } from "../stellar/adapter.js";

/**
 * Reads the market to trade and the fair value to compare it against.
 *
 * In live mode the market is a real chain read (`get_market` plus
 * `current_fee_bps`) for `MARKET_ID`. The effective fee — not the flat
 * `Market.fee_bps` snapshot, which ignores dynamic fee schedules — is fed
 * into the strategy's market state so every off-chain quote and impact
 * estimate uses the number the contract will actually charge.
 *
 * The fair-value estimate stays a placeholder: wiring a real
 * ReferencePriceSource (and the question lookup it needs) is an open issue —
 * see docs/wave-issues.
 */
async function fetchMarketAndFairValue(
  adapter: StellarAdapter,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<{ market: MarketState; fairValueBps: number }> {
  if (adapter.mode === "live") {
    const marketId = BigInt(env.MARKET_ID ?? "0");
    const m = await adapter.getMarket({ market_id: marketId });
    const feeBps = await adapter.currentFeeBps({ market_id: marketId });
    return {
      market: {
        marketId: Number(marketId),
        question: "live market",
        yesBps: Number(priceYesBps(m.reserve_yes, m.reserve_no)),
        closeTime: Number(m.close_time),
        reserveYesStroops: m.reserve_yes,
        reserveNoStroops: m.reserve_no,
        feeBps,
      },
      fairValueBps: 6000,
    };
  }
  return {
    market: { marketId: 0, question: "demo", yesBps: 4000, closeTime: now() + 3600 },
    fairValueBps: 6000,
  };
}

/**
 * Exported (and injectable) so tests can drive the whole trade flow with a
 * fake adapter and clock. `now` returns unix seconds.
 */
export async function main(
  adapter: StellarAdapter,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<void> {
  const traceStore = new LocalTraceStore(env.TRACE_STORE_DIR ?? "./.traces");

  console.log(`[trader] mode=${adapter.mode}`);
  const { market, fairValueBps } = await fetchMarketAndFairValue(adapter, env, now);
  const decision = decideTrade(market, fairValueBps, {
    minEdgeBps: Number(env.MIN_EDGE_BPS ?? 500),
    tradeSizeStroops: BigInt(env.TRADE_SIZE_STROOPS ?? "100000000"),
  });
  console.log(`[trader] ${decision.action}: ${decision.reasoning}`);
  if (decision.action === "skip") return;

  const built = buildTrace({
    agent: "trader",
    marketId: market.marketId,
    action: "buy",
    reasoning: decision.reasoning,
    inputs: { market, fairValueBps, decision },
  });
  const { cid } = await traceStore.put(built.hash, built.json);
  console.log(`[trader] trace ${built.hash} -> ${cid}`);

  const outcome = { tag: decision.outcome!, values: undefined } as {
    tag: "Yes" | "No";
    values: void;
  };
  const collateralInStroops = decision.collateralInStroops!;

  // Fresh quote -> non-zero bounds. The quote is a read-only simulation,
  // so this runs in dry-run mode too and the same code path is exercised
  // before any real submission.
  const quotedShares = await adapter.quoteBuy({
    market_id: BigInt(market.marketId),
    outcome,
    collateral_in: collateralInStroops,
  });
  const slippageBps = BigInt(env.SLIPPAGE_BPS ?? 50);
  const minSharesOut = (quotedShares * (BPS - slippageBps)) / BPS;
  // Never pay more than fair for the outcome being bought: for a YES buy
  // that is `fairValueBps`; for a NO buy it is the complement, since the
  // contract compares the limit against the average price of the outcome
  // being bought (the NO price).
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
      agent: loadDeployments().agent,
      market_id: BigInt(market.marketId),
      action: "buy",
      trace_hash: Buffer.from(built.hash, "hex"),
      ipfs_cid: cid,
    });
    console.log("[trader] publish_trace:", traceResult);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = (process.env.AGENT_MODE as "dry-run" | "live") ?? "dry-run";
  const deployments = loadDeployments();
  const adapter = new StellarAdapter({
    mode,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    agentSecret: process.env.AGENT_SECRET_KEY,
    deployments,
  });
  main(adapter).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
