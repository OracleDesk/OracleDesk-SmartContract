#!/usr/bin/env -S npx tsx
/**
 * Trader agent: reads a market's current implied price, compares it to a
 * fair-value estimate, and trades the mispricing if the edge clears the
 * configured threshold. Every trade is preceded by a recorded trace.
 *
 * Defaults to dry-run. Set AGENT_MODE=live and AGENT_SECRET_KEY to submit
 * real testnet transactions — see .env.example.
 */
import "dotenv/config";
import { buildTrace, LocalTraceStore } from "../core/trace.js";
import { decideTrade, type MarketState } from "../core/strategy.js";
import { loadDeployments, StellarAdapter } from "../stellar/adapter.js";

const PRICE_SOURCE = (process.env.PRICE_SOURCE ?? "spot") as "spot" | "twap";
const TWAP_WINDOW_SECS = Number(process.env.TWAP_WINDOW_SECS ?? 900);

/** Reads the market on-chain (`readMarket`); the fair-value estimate is
 * still a placeholder — wiring a read-only ReferencePriceSource (e.g. a
 * Polymarket mid-price) is tracked in docs/wave-issues. */
async function fetchMarketAndFairValue(
  adapter: StellarAdapter,
): Promise<{ market: MarketState; fairValueBps: number }> {
  if (PRICE_SOURCE !== "spot" && PRICE_SOURCE !== "twap") {
    throw new Error(`PRICE_SOURCE must be "spot" or "twap", got "${PRICE_SOURCE}"`);
  }
  const read = await adapter.readMarket(BigInt(process.env.MARKET_ID ?? "0"), {
    useTwapSecs: PRICE_SOURCE === "twap" ? TWAP_WINDOW_SECS : undefined,
  });
  return {
    market: {
      marketId: read.marketId,
      question: read.metaUri,
      yesBps: read.yesBps,
      twapBps: read.twapBps,
      closeTime: read.closeTime,
    },
    fairValueBps: 6000,
  };
}

async function main() {
  const mode = (process.env.AGENT_MODE as "dry-run" | "live") ?? "dry-run";
  const deployments = loadDeployments();
  const adapter = new StellarAdapter({
    mode,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    agentSecret: process.env.AGENT_SECRET_KEY,
    deployments,
  });
  const traceStore = new LocalTraceStore(process.env.TRACE_STORE_DIR ?? "./.traces");

  console.log(`[trader] mode=${mode} priceSource=${PRICE_SOURCE}`);
  const { market, fairValueBps } = await fetchMarketAndFairValue(adapter);
  const decision = decideTrade(market, fairValueBps, {
    minEdgeBps: Number(process.env.MIN_EDGE_BPS ?? 500),
    tradeSizeStroops: BigInt(process.env.TRADE_SIZE_STROOPS ?? "100000000"),
    priceSource: PRICE_SOURCE,
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

  const result = await adapter.agentBuy({
    market_id: BigInt(market.marketId),
    outcome: { tag: decision.outcome!, values: undefined },
    collateral_in: decision.collateralInStroops!,
    min_shares_out: 0n,
  });
  console.log("[trader] agent_buy:", result);

  if (!result.dryRun) {
    const traceResult = await adapter.publishTrace({
      agent: deployments.agent,
      market_id: BigInt(market.marketId),
      action: "buy",
      trace_hash: Buffer.from(built.hash, "hex"),
      ipfs_cid: cid,
    });
    console.log("[trader] publish_trace:", traceResult);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
