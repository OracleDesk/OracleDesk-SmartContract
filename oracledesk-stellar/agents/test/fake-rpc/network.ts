/**
 * One-call setup of a fake Stellar network for chaos tests (#106): the fake
 * RPC with the contract artifacts, a funded agent account, a seeded market,
 * and a factory for the real, live-mode StellarAdapter pointed at it.
 *
 * `blockRealNetwork()` replaces global fetch (the SDK's HTTP transport) with
 * one that refuses anything but the loopback fake, so a test can never reach
 * a real network by accident.
 *
 * While a fake network runs, `Date.now()` follows its ledger clock. The SDK
 * stamps transaction time bounds and `buildTrace` stamps traces from
 * `Date.now()`, so without this a run's hashes, and whether two ticks share a
 * second, would depend on the wall clock.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { toTraceAction } from "../../core/trace.js";
import { StellarAdapter, type Deployments, type FeeReport } from "../../stellar/adapter.js";
import type { RestoreConfig } from "../../core/config.js";
import type { StateStore } from "../../runtime/state.js";
import type { FeePolicy } from "../../stellar/fees.js";
import type { TransactionJournal } from "../../stellar/journal.js";
import { contractIdFor, CONTRACT_NAMES, loadArtifact, type ContractArtifact, type ContractName, type ProbeCall } from "./artifacts.js";
import { FaultPlan } from "./faults.js";
import { initialState, seedMarket, type ModelMarket } from "./model.js";
import { FakeSorobanRpc } from "./server.js";

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** The agent's key, fixed so every run signs identical transactions. */
export const AGENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x0a));
export const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x0f));
const DEPLOYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x0b));

const yes = { tag: "Yes", values: undefined };

/** The calls the adapter makes, in the shapes it sends them. */
function probes(agent: string): Record<ContractName, ProbeCall[]> {
  return {
    market_core: [
      { fn: "quote_buy", args: { market_id: 0n, outcome: yes, collateral_in: 1n } },
      { fn: "market_count", args: {} },
    ],
    treasury: [
      {
        fn: "agent_buy_v2",
        args: { agent, market_id: 0n, outcome: yes, collateral_in: 1n, min_shares_out: 0n, limit_price_bps: 5000, deadline: 1n },
      },
      {
        fn: "agent_create_market",
        args: {
          agent,
          question_hash: Buffer.alloc(32),
          resolution_hash: Buffer.alloc(32),
          meta_uri: "local://x",
          category: { tag: "Macro", values: undefined },
          close_time: 1n,
          seed_amount: 1n,
          initial_yes_bps: 5000,
        },
      },
    ],
    reasoning_registry: [
      {
        fn: "publish_trace",
        args: { agent, market_id: 0n, action: toTraceAction("buy"), trace_hash: Buffer.alloc(32), ipfs_cid: "bafy" },
      },
    ],
  };
}

let cached: Promise<Record<ContractName, ContractArtifact>> | undefined;
/** Artifacts are read once per process; they never change during a run. */
export function artifacts(): Promise<Record<ContractName, ContractArtifact>> {
  cached ??= (async () => {
    const p = probes(AGENT.publicKey());
    const out = {} as Record<ContractName, ContractArtifact>;
    for (const n of CONTRACT_NAMES) out[n] = await loadArtifact(n, p[n]);
    return out;
  })();
  return cached;
}

export interface FakeNetwork {
  rpc: FakeSorobanRpc;
  url: string;
  deployments: Deployments;
  artifacts: Record<ContractName, ContractArtifact>;
  /** The market seeded at startup (id 0, priced at 40% YES). */
  market: ModelMarket;
  adapter(): StellarAdapter;
  stop(): Promise<void>;
}

export interface FakeNetworkOptions {
  plan?: FaultPlan;
  maxTrade?: bigint;
  startSequence?: bigint;
  surge?: { minInclusion: string | number | bigint; ledgers: number };
  feePolicy?: FeePolicy;
  journal?: TransactionJournal;
  task?: string;
  onFeeCharged?: (report: FeeReport) => void;
  state?: StateStore;
  restore?: Partial<RestoreConfig>;
}

export async function startFakeNetwork(opts: FakeNetworkOptions = {}): Promise<FakeNetwork> {
  const arts = await artifacts();
  const feePolicy = opts.feePolicy
    ? { ...opts.feePolicy, feePayerSecret: opts.feePolicy.feePayerSecret ?? FEE_PAYER.secret() }
    : undefined;
  const feePayerKey = feePolicy?.feePayerSecret
    ? Keypair.fromSecret(feePolicy.feePayerSecret).publicKey()
    : FEE_PAYER.publicKey();
  const ids = Object.fromEntries(CONTRACT_NAMES.map((n) => [n, contractIdFor(n)])) as Record<ContractName, string>;
  const deployments: Deployments = {
    deployer: DEPLOYER.publicKey(),
    agent: AGENT.publicKey(),
    contracts: {
      usdc: StrKey.encodeContract(Buffer.alloc(32, 0x0c)),
      market_core: ids.market_core,
      resolver: StrKey.encodeContract(Buffer.alloc(32, 0x0d)),
      treasury: ids.treasury,
      reasoning_registry: ids.reasoning_registry,
    },
  };
  const state = initialState({ agents: [AGENT.publicKey()], maxTrade: opts.maxTrade });
  const rpc = new FakeSorobanRpc({
    networkPassphrase: NETWORK_PASSPHRASE,
    contracts: Object.fromEntries(CONTRACT_NAMES.map((n) => [ids[n], arts[n]])),
    accounts: {
      [AGENT.publicKey()]: opts.startSequence ?? 4_294_967_296n,
      [feePayerKey]: 4_294_967_296n,
    },
    state,
    treasuryAddress: ids.treasury,
    plan: opts.plan,
    surge: opts.surge,
  });
  const market = seedMarket(state, {
    seed: 10_000_000_000n,
    yesBps: 4000n,
    closeTime: BigInt(rpc.clock.closeTime + 86_400),
    creator: StrKey.encodeContract(Buffer.alloc(32, 0x0e)),
  });
  const url = await rpc.start();
  const realNow = Date.now;
  Date.now = () => rpc.clock.closeTime * 1000;
  return {
    rpc,
    url,
    deployments,
    artifacts: arts,
    market,
    adapter: () =>
      new StellarAdapter({
        mode: "live",
        agentSecret: AGENT.secret(),
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: url,
        deployments,
        feePolicy,
        journal: opts.journal,
        task: opts.task,
        onFeeCharged: opts.onFeeCharged,
        state: opts.state,
        restore: opts.restore,
      }),
    stop: async () => {
      Date.now = realNow;
      await rpc.stop();
    },
  };
}

/** Makes any non-loopback HTTP request from this process fail. Returns an undo. */
export function blockRealNetwork(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error(`chaos tests must not reach the real network (blocked ${url.href})`);
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
