/**
 * Wraps the generated contract bindings (packages/bindings/*) with signing,
 * submission, and a dry-run mode. Every agent action goes through this
 * module rather than touching a Client directly, so dry-run/live is a
 * single switch and every mutating call ends up beside its trace-building.
 *
 * Requires the bindings to have been generated (`make bindings` /
 * `scripts/gen-bindings.sh`) and installed (`npm install` in each
 * packages/bindings/<name> — see README.md's quickstart).
 */

import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is agents/stellar/ — the repo root is two levels up.
const REPO_ROOT = join(HERE, "..", "..");

export interface Deployments {
  deployer: string;
  agent: string;
  contracts: {
    usdc: string;
    market_core: string;
    resolver: string;
    treasury: string;
    reasoning_registry: string;
  };
}

/** Subset of market-core's `Market` the agents consume. i128 maps to bigint
 * and u64 to bigint per the generated bindings (`u32` -> number). */
export interface MarketView {
  close_time: bigint;
  fee_bps: number;
  reserve_yes: bigint;
  reserve_no: bigint;
}

export function loadDeployments(path = join(REPO_ROOT, "deployments", "testnet.json")): Deployments {
  return JSON.parse(readFileSync(path, "utf8")) as Deployments;
}

export interface StellarAdapterOptions {
  /** "dry-run" (default): builds and logs what would be submitted, never
   * signs or sends. "live": actually submits real testnet transactions. */
  mode: "dry-run" | "live";
  networkPassphrase: string;
  rpcUrl: string;
  /** The agent's secret key (`S...`). Required for `mode: "live"`; ignored
   * (and may be omitted) in dry-run. */
  agentSecret?: string;
  deployments: Deployments;
}

export interface DryRunResult {
  dryRun: true;
  contractId: string;
  method: string;
  args: unknown;
}

/** Real result shape depends on the call; see each wrapper method below. */
export type LiveResult<T> = { dryRun: false; value: T };

export type AdapterResult<T> = DryRunResult | LiveResult<T>;

/**
 * Thin, mode-aware wrapper. Each method builds the same call regardless of
 * mode; in dry-run it stops after simulate/describe and never signs, so a
 * misconfigured agent can never accidentally submit a real transaction.
 */
export class StellarAdapter {
  private readonly signer?: KeypairSigner;
  private readonly publicKey?: string;

  constructor(private readonly opts: StellarAdapterOptions) {
    if (opts.mode !== "dry-run" && opts.mode !== "live") {
      throw new Error(`unknown mode ${JSON.stringify(opts.mode)}: expected "dry-run" or "live"`);
    }
    if (opts.mode === "live") {
      if (!opts.agentSecret) throw new Error("live mode requires agentSecret");
      const keypair = Keypair.fromSecret(opts.agentSecret);
      this.signer = new KeypairSigner(keypair, opts.networkPassphrase);
      this.publicKey = keypair.publicKey();
    }
  }

  get mode(): "dry-run" | "live" {
    return this.opts.mode;
  }

  /**
   * Loads a generated Client for one of the four contracts. Imported
   * dynamically so `mode: "dry-run"` usage (e.g. unit tests) never requires
   * the bindings packages to be installed.
   */
  private async client<T>(pkg: keyof Deployments["contracts"], moduleName: string): Promise<T> {
    const contractId = this.opts.deployments.contracts[pkg];
    const mod = (await import(moduleName)) as { Client: { from: (o: unknown) => Promise<T> } };
    return mod.Client.from({
      contractId,
      networkPassphrase: this.opts.networkPassphrase,
      rpcUrl: this.opts.rpcUrl,
      publicKey: this.publicKey,
      signTransaction: this.signer,
    });
  }

  /**
   * Runs `method(client)` (a call to one of the generated Client's methods,
   * returning its `AssembledTransaction`) either as a dry-run description
   * or a real signed submission, depending on `this.mode`.
   */
  private async run<T>(
    pkg: keyof Deployments["contracts"],
    moduleName: string,
    methodName: string,
    args: unknown,
    call: (client: any) => Promise<{ signAndSend: () => Promise<{ result: T }> }>,
  ): Promise<AdapterResult<T>> {
    const contractId = this.opts.deployments.contracts[pkg];
    if (this.opts.mode === "dry-run") {
      return { dryRun: true, contractId, method: methodName, args };
    }
    const client = await this.client<any>(pkg, moduleName);
    const assembled = await call(client);
    const { result } = await assembled.signAndSend();
    return { dryRun: false, value: result };
  }

  async agentCreateMarket(args: {
    question_hash: Buffer;
    resolution_hash: Buffer;
    meta_uri: string;
    category: { tag: string; values: void };
    close_time: bigint;
    seed_amount: bigint;
    initial_yes_bps: number;
  }): Promise<AdapterResult<bigint>> {
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_create_market", args, (client) =>
      client.agent_create_market(args),
    );
  }

  async agentBuy(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_in: bigint;
    min_shares_out: bigint;
  }): Promise<AdapterResult<bigint>> {
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_buy", args, (client) =>
      client.agent_buy(args),
    );
  }

  /**
   * `agent_buy` with contract-enforced bounds: the trade reverts past
   * `deadline` (ledger timestamp, unix seconds) or when the average
   * execution price is worse than `limit_price_bps` (fee included; 0 = no
   * limit for buys). On-chain this is the treasury's `agent_buy_v2`.
   */
  async agentBuyV2(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_in: bigint;
    min_shares_out: bigint;
    limit_price_bps: number;
    deadline: bigint;
  }): Promise<AdapterResult<bigint>> {
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_buy_v2", args, (client) =>
      client.agent_buy_v2(args),
    );
  }

  async agentSell(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
    max_shares_in: bigint;
  }): Promise<AdapterResult<bigint>> {
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_sell", args, (client) =>
      client.agent_sell(args),
    );
  }

  /**
   * `agent_sell` with contract-enforced bounds. For sells a
   * `limit_price_bps` of 0 is trivially satisfied on-chain (no
   * protection) — pass the fair value you are willing to sell at.
   */
  async agentSellV2(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
    max_shares_in: bigint;
    limit_price_bps: number;
    deadline: bigint;
  }): Promise<AdapterResult<bigint>> {
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_sell_v2", args, (client) =>
      client.agent_sell_v2(args),
    );
  }

  /**
   * Simulates market-core's `quote_buy` (read-only — never signs or
   * submits) and returns the quoted shares. Unlike the mutating wrappers
   * this also runs in dry-run mode, so a dry-run trader can still derive
   * its `min_shares_out` / `limit_price_bps` bounds.
   */
  async quoteBuy(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_in: bigint;
  }): Promise<bigint> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.quote_buy(args);
    return result as bigint;
  }

  /**
   * Reads a market's full state via market-core's `get_market` view
   * (read-only — simulates, never signs or submits). Lets the trader seed
   * its market state (reserves, close time) from the chain in live mode.
   */
  async getMarket(args: { market_id: bigint }): Promise<MarketView> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.get_market(args);
    return result as MarketView;
  }

  /**
   * Reads market-core's `current_fee_bps` view: the fee a trade would pay
   * right now, including any dynamic `FeeSchedule`. That schedule is
   * deliberately invisible in `Market.fee_bps` (the flat snapshot legacy
   * markets charge), so quoting off the snapshot would understate the fee
   * near close. Read-only, simulates only.
   */
  async currentFeeBps(args: { market_id: bigint }): Promise<number> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.current_fee_bps(args);
    return result as number;
  }

  async publishTrace(args: {
    agent: string;
    market_id: bigint;
    action: string;
    trace_hash: Buffer;
    ipfs_cid: string;
  }): Promise<AdapterResult<bigint>> {
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace",
      args,
      (client) => client.publish_trace(args),
    );
  }
}
