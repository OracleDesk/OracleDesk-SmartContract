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
