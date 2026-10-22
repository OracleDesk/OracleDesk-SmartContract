#!/usr/bin/env -S npx tsx
/**
 * Market Maker agent, one shot: polls signal sources, decides whether a
 * signal is confident enough to seed a market, builds and records a
 * reasoning trace, and (in "live" mode) creates the market through the
 * treasury. Skips markets whose question_hash already exists on-chain, and
 * signals already processed (live state in AGENT_STATE_PATH).
 *
 * A thin wrapper over the runtime's maker task (runtime/tasks/maker.ts), run
 * exactly once under the single-instance lease; `npm run agentd` runs the
 * same task continuously. Defaults to dry-run. Set AGENT_MODE=live and
 * MAKER_SECRET_KEY (or the shared AGENT_SECRET_KEY) to submit real testnet
 * transactions — see .env.example.
 */
import "dotenv/config";
import { EXIT_CONFIG, EXIT_TEMPFAIL, parseAgentMode } from "../runtime/config.js";
import { LeaseHeldError } from "../runtime/lease.js";
import { Runtime } from "../runtime/runtime.js";
import { makerTask } from "../runtime/tasks/maker.js";
import { buildAdapter, createLease, createStateStore, loadDeployments, makerDeps, runtimeOptions } from "../runtime/wiring.js";
 * Market Maker agent: polls signal sources, decides whether a signal is
 * confident enough to seed a market, builds and records a reasoning trace,
 * and (in "live" mode) creates the market through the treasury.
 * Skips markets whose question_hash already exists on-chain or in the spec
 * store.
 *
 * Every market commits to a real resolution spec (docs/adr/0001, "Agent flow
 * and recovery"): the spec is built from MM_* config, hashed with
 * scripts/spec-hash (or the TS library), durably stored in AGENT_SPEC_DIR
 * BEFORE agent_create_market is submitted, and revealed right after. A
 * recovery pass at startup and after every create reveals anything a crash
 * or RPC failure left behind.
 *
 * Defaults to dry-run. Set AGENT_MODE=live and MAKER_SECRET_KEY (or the
 * shared AGENT_SECRET_KEY) to submit real testnet transactions — see
 * .env.example. Pass --verify-spec-hash to cross-check the TS spec library
 * against the Rust CLI.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { buildTrace, canonicalize } from "../core/trace.js";
import { createTraceStore } from "../core/trace-store-factory.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrace, LocalTraceStore } from "../core/trace.js";
import { createHash } from "node:crypto";
import { buildTrace, LocalTraceStore, NO_MARKET } from "../core/trace.js";
import { decideMarketProposal, type MarketSignal, type SignalSource } from "../core/strategy.js";
import { agentCredentials, loadDeployments, StellarAdapter } from "../stellar/adapter.js";
import { ChainStateReader } from "../core/state/reader.js";
import { SnapshotCache } from "../core/state/state_cache.js";
import { existingQuestionHashes } from "../core/state/select.js";
import { buildSpec, questionHashOf } from "../core/spec.js";
import { createSpecHasher } from "../core/spec-hasher.js";
import {
  FileSpecStore,
  MemorySpecStore,
  recoverSpecs,
  type RecoveryChain,
  type SpecStore,
} from "../core/spec-store.js";
import { createMarketWithSpec } from "../core/maker-flow.js";
import { Server } from "@stellar/stellar-sdk/rpc";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

function recoveryChainFor(adapter: StellarAdapter): RecoveryChain {
  return {
    marketCount: () => adapter.marketCount(),
    getMarket: (id) => adapter.getMarket(id),
    isRevealed: (id) => adapter.isSpecRevealed(id),
    reveal: async (id, spec) => {
      await adapter.revealSpec(id, spec);
    },
  };
}

async function main() {
  const mode = parseAgentMode(process.env);
  const deployments = loadDeployments();
  const adapter = buildAdapter("maker", mode, process.env, deployments);
  console.log(`[market-maker] mode=${mode}`);
  const runtime = new Runtime({
    tasks: [makerTask(makerDeps(process.env, adapter, deployments), { intervalMs: 0 })],
    state: await createStateStore(mode, process.env, deployments.contracts.treasury),
    lease: createLease(process.env),
    ...runtimeOptions(process.env),
  });
  await runtime.runOnce();
  const adapter = new StellarAdapter({
    mode,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    ...agentCredentials("maker", process.env, deployments),
    deployments,
  });
  const { store: traceStore, kind: traceStoreKind } = createTraceStore(process.env, mode);
  const traceStore = new LocalTraceStore(process.env.TRACE_STORE_DIR ?? "./.traces");
  // Dry-run never creates a market, so it must not leave pending specs
  // behind for a later live run to chase.
  const specStore: SpecStore =
    mode === "live"
      ? new FileSpecStore(process.env.AGENT_SPEC_DIR ?? "./.specs", { backupCmd: process.env.SPEC_BACKUP_CMD })
      : new MemorySpecStore();
  const hasher = await createSpecHasher({
    manifestPath: process.env.SPEC_HASH_MANIFEST ?? join(REPO_ROOT, "scripts", "spec-hash", "Cargo.toml"),
    bin: process.env.SPEC_HASH_BIN || undefined,
    verify: process.argv.includes("--verify-spec-hash") || process.env.MM_VERIFY_SPEC_HASH === "1",
  });
  const chain = recoveryChainFor(adapter);
  const recover = async () => {
    if (mode !== "live") return;
    const report = await recoverSpecs({
      store: specStore,
      chain,
      creator: deployments.contracts.treasury,
      pendingTtlSecs: Number(process.env.MM_PENDING_TTL_SECS ?? 900),
      maxScan: Number(process.env.MM_RECOVERY_MAX_SCAN ?? 200),
      staleRevealSecs: Number(process.env.MM_STALE_REVEAL_SECS ?? 600),
    });
    console.log("[market-maker] spec recovery:", report);
  };

  await recover();

  // Load chain state to check for duplicate question hashes
  const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const server = new Server(rpcUrl);
  const stateReader = new ChainStateReader({
    marketContractId: deployments.contracts.market_core,
    portfolioContractId: deployments.contracts.treasury,
    server,
  });
  const cache = new SnapshotCache();
  const snapshot = await cache.get(() => stateReader.readSnapshot([]));
  const knownHashes = existingQuestionHashes(snapshot);
  for (const s of await specStore.list()) if (s.state !== "abandoned") knownHashes.add(s.questionHash);

  console.log(`[market-maker] mode=${mode}, known markets=${knownHashes.size}`);

  const closeInSecs = Number(process.env.MM_CLOSE_IN_SECS ?? 3600);
  const signals = await demoSignalSource.poll();
  for (const signal of signals) {
    const decision = decideMarketProposal(signal, {
      confidenceThresholdBps: Number(process.env.CONFIDENCE_THRESHOLD_BPS ?? 1000),
      defaultSeedStroops: BigInt(process.env.DEFAULT_SEED_STROOPS ?? "1500000000"),
    });
    console.log(`[market-maker] ${decision.action}: ${decision.reasoning}`);
    if (decision.action === "skip") continue;

    const questionHash = questionHashOf(decision.question!);
    const questionHashHex = questionHash.toString("hex");

    // Skip if this question already has a market on-chain
    if (knownHashes.has(questionHashHex)) {
      console.log(`[market-maker] skipping duplicate question_hash=${questionHashHex}`);
      continue;
    }

    const built = buildTrace({
      agent: "market-maker",
      marketId: null,
      action: "propose_market",
      reasoning: decision.reasoning,
      inputs: { signal, decision },
    });
    const closeTime = BigInt(Math.floor(Date.now() / 1000) + 3600);

    // The trace (and, with the IPFS store, the market metadata) must be
    // pinned and verified before the create: never act without a
    // publishable trace.
    let cid: string;
    let metaUri: string;
    try {
      ({ cid } = await traceStore.put(built.hash, built.json));
      if (traceStoreKind === "ipfs") {
        const metaJson = canonicalize({
          question: decision.question,
          category: "Macro",
          closeTime,
          source: signal.source,
          traceHash: built.hash,
          traceCid: cid,
        });
        const metaHash = createHash("sha256").update(metaJson).digest("hex");
        metaUri = `ipfs://${(await traceStore.put(metaHash, metaJson)).cid}`;
      } else {
        metaUri = `local://${built.hash}`;
      }
    } catch (err) {
      console.error(`[market-maker] skipped: trace ${built.hash} could not be stored:`, err);
      continue;
    }
    console.log(`[market-maker] trace ${built.hash} -> ${cid}, meta_uri=${metaUri}`);
    const spec = buildSpec(process.env, deployments.agent, signal.priceRule);
    const closeTime = BigInt(Math.floor(Date.now() / 1000) + closeInSecs);
    let traceHash = "";
    let traceCid = "";

    try {
      const outcome = await createMarketWithSpec({
        spec,
        questionHash,
        closeTime,
        closeMarginSecs: Number(process.env.MM_CLOSE_MARGIN_SECS ?? 60),
        store: specStore,
        hasher,
        chain,
        // Runs only after the spec is durably stored.
        create: async (resolutionHash) => {
          const built = buildTrace({
            agent: "market-maker",
            marketId: null,
            action: "propose_market",
            reasoning: decision.reasoning,
            inputs: { signal, decision, spec, commitment: resolutionHash.toString("hex") },
          });
          const { cid } = await traceStore.put(built.hash, built.json);
          traceHash = built.hash;
          traceCid = cid;
          console.log(`[market-maker] trace ${built.hash} -> ${cid}`);
          const metaUri = `local://${built.hash}`;
          if (mode === "live") {
            console.warn(`[market-maker] WARNING: live market created with non-durable meta_uri ${metaUri}`);
          }
          return adapter.agentCreateMarket({
            question_hash: questionHash,
            resolution_hash: resolutionHash,
            meta_uri: metaUri,
            category: { tag: "Macro", values: undefined },
            close_time: closeTime,
            seed_amount: decision.seedAmountStroops!,
            initial_yes_bps: decision.initialYesBps!,
          });
        },
      });
      console.log(`[market-maker] commitment=${outcome.commitment} spec=${JSON.stringify(spec)}`);
      console.log("[market-maker] agent_create_market:", outcome.create);
      knownHashes.add(questionHashHex);

      if (!outcome.create.dryRun) {
        console.log(`[market-maker] spec ${outcome.revealed ? "revealed" : "NOT yet revealed"} for market ${outcome.entry.marketId}`);
        const traceResult = await adapter.publishTrace({
          agent: adapter.agent,
          market_id: outcome.create.value,
          action: "create_market",
          trace_hash: Buffer.from(traceHash, "hex"),
          ipfs_cid: traceCid,
        });
        console.log("[market-maker] publish_trace:", traceResult);
      } else {
        console.log("[market-maker] would reveal:", await adapter.revealSpec(0n, spec));
      }
    } finally {
      await recover().catch((err) => console.error("[market-maker] spec recovery failed:", err));
    const result = await adapter.agentCreateMarket({
      question_hash: questionHash,
      resolution_hash: placeholderResolutionHash,
      meta_uri: metaUri,
      category: { tag: "Macro", values: undefined },
      close_time: closeTime,
      seed_amount: decision.seedAmountStroops!,
      initial_yes_bps: decision.initialYesBps!,
    });
    console.log("[market-maker] agent_create_market:", result);

    if (!result.dryRun) {
      // Record proposal trace prior to creation using NO_MARKET sentinel (#55)
      const proposalResult = await adapter.publishTrace({
        agent: adapter.agent,
        market_id: NO_MARKET,
        action: { tag: "ProposeMarket", values: undefined },
        trace_hash: Buffer.from(built.hash, "hex"),
        ipfs_cid: cid,
      });
      console.log("[market-maker] publish_trace (propose_market):", proposalResult);

      const traceResult = await adapter.publishTrace({
        agent: adapter.agent,
        market_id: result.value,
        action: { tag: "CreateMarket", values: undefined },
        trace_hash: Buffer.from(built.hash, "hex"),
        ipfs_cid: cid,
      });
      console.log("[market-maker] publish_trace (create_market):", traceResult);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(err instanceof LeaseHeldError ? EXIT_TEMPFAIL : err?.name === "ConfigError" ? EXIT_CONFIG : 1);
});
