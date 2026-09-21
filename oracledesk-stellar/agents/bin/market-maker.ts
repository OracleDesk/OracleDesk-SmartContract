#!/usr/bin/env -S npx tsx
/**
 * Market Maker agent: polls signal sources, decides whether a signal is
 * confident enough to seed a market, builds and records a reasoning trace,
 * and (in "live" mode) creates the market through the treasury.
 *
 * Defaults to dry-run. Set AGENT_MODE=live and AGENT_SECRET_KEY to submit
 * real testnet transactions — see .env.example.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { buildTrace, LocalTraceStore } from "../core/trace.js";
import { decideMarketProposal, type MarketSignal, type SignalSource } from "../core/strategy.js";
import { loadDeployments, StellarAdapter } from "../stellar/adapter.js";

/** Placeholder signal source until a real one (news, an oracle feed, a
 * comparable market) is wired in — see docs/wave-issues for that as an
 * open issue. Deterministic so dry-runs are reproducible. */
const demoSignalSource: SignalSource = {
  name: "demo-fixture",
  async poll(): Promise<MarketSignal[]> {
    return [
      {
        summary: "Fixture signal for dry-run demonstration",
        proposedQuestion: "Will the OracleDesk Stellar port pass its testnet demo?",
        fairValueBps: 7500,
        source: "demo-fixture",
        observedAt: Math.floor(Date.now() / 1000),
      },
    ];
  },
};

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

  console.log(`[market-maker] mode=${mode}`);
  const signals = await demoSignalSource.poll();
  for (const signal of signals) {
    const decision = decideMarketProposal(signal, {
      confidenceThresholdBps: Number(process.env.CONFIDENCE_THRESHOLD_BPS ?? 1000),
      defaultSeedStroops: BigInt(process.env.DEFAULT_SEED_STROOPS ?? "1500000000"),
    });
    console.log(`[market-maker] ${decision.action}: ${decision.reasoning}`);
    if (decision.action === "skip") continue;

    const built = buildTrace({
      agent: "market-maker",
      marketId: null,
      action: "propose_market",
      reasoning: decision.reasoning,
      inputs: { signal, decision },
    });
    const { cid } = await traceStore.put(built.hash, built.json);
    console.log(`[market-maker] trace ${built.hash} -> ${cid}`);

    const questionHash = createHash("sha256").update(decision.question!).digest();
    // Resolution spec left to reveal later, once the maker decides how this
    // market will actually be resolved — see scripts/seed-market.sh and
    // docs/adr/0001-resolution-commitment.md for the real flow. This CLI
    // stops short of that: it demonstrates the decision + trace-recording
    // half of the loop.
    const placeholderResolutionHash = createHash("sha256").update("unrevealed").digest();

    const result = await adapter.agentCreateMarket({
      question_hash: questionHash,
      resolution_hash: placeholderResolutionHash,
      meta_uri: `local://${built.hash}`,
      category: { tag: "Macro", values: undefined },
      close_time: BigInt(Math.floor(Date.now() / 1000) + 3600),
      seed_amount: decision.seedAmountStroops!,
      initial_yes_bps: decision.initialYesBps!,
    });
    console.log("[market-maker] agent_create_market:", result);

    if (!result.dryRun) {
      const traceResult = await adapter.publishTrace({
        agent: deployments.agent,
        market_id: result.value,
        action: "create_market",
        trace_hash: Buffer.from(built.hash, "hex"),
        ipfs_cid: cid,
      });
      console.log("[market-maker] publish_trace:", traceResult);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
