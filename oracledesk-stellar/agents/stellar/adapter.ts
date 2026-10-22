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

import { Address, Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar/stellar-sdk/contract";
import { toContractArg, type PriceConfigArg, type SignerConfigArg, type SpecJson } from "../core/spec.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toTraceAction, type TraceActionType } from "../core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is agents/stellar/ — the repo root is two levels up.
const REPO_ROOT = join(HERE, "..", "..");

export interface Deployments {
  deployer: string;
  /** The treasury's constructor agent (all roles). Kept for deployments
   * that predate separate maker/trader identities. */
  agent: string;
  /** Per-role agents registered with the treasury's agent registry by
   * scripts/deploy-testnet.sh (`set_agent`, live after `config_delay`). */
  agents?: { maker: string; trader: string };
  contracts: {
    usdc: string;
    market_core: string;
    resolver: string;
    treasury: string;
    reasoning_registry: string;
  };
}

export function loadDeployments(
  path = process.env.DEPLOYMENTS_PATH ?? join(REPO_ROOT, "deployments", "testnet.json"),
): Deployments {
  return JSON.parse(readFileSync(path, "utf8")) as Deployments;
}

export type AgentRole = "maker" | "trader";

/**
 * Which key and address an agent CLI acts as. Each role prefers its own
 * secret (`MAKER_SECRET_KEY` / `TRADER_SECRET_KEY`) and registered address
 * (`deployments.agents`), falling back to the shared `AGENT_SECRET_KEY` and
 * the constructor agent `deployments.agent`.
 */
export function agentCredentials(
  role: AgentRole,
  env: NodeJS.ProcessEnv,
  deployments: Deployments,
): { agentSecret?: string; agentAddress: string } {
  const roleSecret = role === "maker" ? env.MAKER_SECRET_KEY : env.TRADER_SECRET_KEY;
  return {
    agentSecret: roleSecret || env.AGENT_SECRET_KEY,
    agentAddress: deployments.agents?.[role] ?? deployments.agent,
  };
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
  /** The acting agent's address for dry-run descriptions (live mode always
   * uses the secret key's public key). Defaults to `deployments.agent`. */
  agentAddress?: string;
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
 * The call failed before a transaction was submitted (building or
 * simulating it — e.g. a treasury cap rejection), so it certainly has no
 * on-chain effect. Anything else thrown by a live call may or may not have
 * landed.
 */
export class NotSubmittedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NotSubmittedError";
  }
}

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

  /** The address every treasury agent entrypoint is called as (its first
   * `agent` argument), and the agent traces are published for. */
  get agent(): string {
    return this.publicKey ?? this.opts.agentAddress ?? this.opts.deployments.agent;
  }

  /** The deployment this adapter is bound to. */
  get deployments(): Deployments {
    return this.opts.deployments;
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
    let assembled: Awaited<ReturnType<typeof call>>;
    try {
      const client = await this.client<any>(pkg, moduleName);
      assembled = await call(client);
    } catch (err) {
      throw new NotSubmittedError(`${methodName}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const simulation = (assembled as { simulation?: { error?: string } }).simulation;
    if (simulation?.error) {
      throw new NotSubmittedError(`${methodName} simulation failed: ${simulation.error}`);
    }
    const { result } = await assembled.signAndSend();
    return { dryRun: false, value: unwrapContractResult(methodName, result) };
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
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_create_market", call, (client) =>
      client.agent_create_market(call),
    );
  }

  async agentBuy(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_in: bigint;
    min_shares_out: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_buy", call, (client) =>
      client.agent_buy(call),
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
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_buy_v2", call, (client) =>
      client.agent_buy_v2(call),
    );
  }

  async agentSell(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
    max_shares_in: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_sell", call, (client) =>
      client.agent_sell(call),
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
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_sell_v2", call, (client) =>
      client.agent_sell_v2(call),
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
   * Reveals a signer-mode spec (resolver `register_signer_spec`).
   * Permissionless: the commitment, not the caller, authorizes it.
   */
  async registerSignerSpec(args: { market_id: bigint; spec: SignerConfigArg }): Promise<AdapterResult<void>> {
    return this.run("resolver", "@oracledesk/bindings-resolver", "register_signer_spec", args, (client) =>
      client.register_signer_spec(args),
    );
  }

  /** Reveals a price-mode spec (resolver `register_price_spec`). */
  async registerPriceSpec(args: { market_id: bigint; spec: PriceConfigArg }): Promise<AdapterResult<void>> {
    return this.run("resolver", "@oracledesk/bindings-resolver", "register_price_spec", args, (client) =>
      client.register_price_spec(args),
    );
  }

  /** Reveals `spec` through whichever wrapper its mode needs, in canonical order. */
  async revealSpec(marketId: bigint, spec: SpecJson): Promise<AdapterResult<void>> {
    return spec.mode === "signers"
      ? this.registerSignerSpec({ market_id: marketId, spec: toContractArg(spec) as SignerConfigArg })
      : this.registerPriceSpec({ market_id: marketId, spec: toContractArg(spec) as PriceConfigArg });
  }

  /** market-core `market_count` (read-only simulation; also runs in dry-run). */
  async marketCount(): Promise<bigint> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.market_count();
    return BigInt(result);
  }

  /** market-core `get_market` (read-only), or `undefined` if it does not exist. */
  async getMarket(
    marketId: bigint,
  ): Promise<{ creator: string; questionHash: string; resolutionHash: string; closeTime: bigint } | undefined> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.get_market({ market_id: marketId });
    if (result?.isErr?.()) return undefined;
    const m = typeof result?.unwrap === "function" ? result.unwrap() : result;
    return {
      creator: m.creator,
      questionHash: Buffer.from(m.question_hash).toString("hex"),
      resolutionHash: Buffer.from(m.resolution_hash).toString("hex"),
      closeTime: BigInt(m.close_time),
    };
  }

  /**
   * Whether a legacy spec is registered for `marketId`. A signer reveal
   * moves `state()` to SignersPending, but a price reveal leaves it
   * Unconfigured, so the resolver's `Price(market_id)` entry is read too.
   */
  async isSpecRevealed(marketId: bigint): Promise<boolean> {
    const client = await this.client<any>("resolver", "@oracledesk/bindings-resolver");
    const { result } = await client.state({ market_id: marketId });
    if (result?.tag && result.tag !== "Unconfigured") return true;
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.opts.deployments.contracts.resolver).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Price"), xdr.ScVal.scvU64(new xdr.Uint64(marketId))]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries } = await new rpc.Server(this.opts.rpcUrl).getLedgerEntries(key);
    return entries.length > 0;
  }

  async publishTrace(args: {
    agent: string;
    market_id: bigint;
    action: TraceActionType | string;
    trace_hash: Buffer;
    ipfs_cid: string;
  }): Promise<AdapterResult<bigint>> {
    const action = typeof args.action === "string" ? toTraceAction(args.action) : args.action;
    const call = { ...args, action };
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace",
      call,
      (client) => client.publish_trace(call),
    );
  }

  async publishTraceBatch(args: {
    agent: string;
    root: Buffer;
    leaf_count: number;
    manifest_cid: string;
  }): Promise<AdapterResult<bigint>> {
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace_batch",
      args,
      (client) => client.publish_trace_batch(args),
    );
  }

  async addSigningKey(args: {
    agent: string;
    public_key: Buffer;
    proof_sig: Buffer;
  }): Promise<AdapterResult<void>> {
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "add_signing_key",
      args,
      (client) => client.add_signing_key(args),
    );
  }

  async retireSigningKey(args: {
    agent: string;
    public_key: Buffer;
  }): Promise<AdapterResult<void>> {
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "retire_signing_key",
      args,
      (client) => client.retire_signing_key(args),
    );
  }

  async publishTraceSigned(args: {
    agent: string;
    market_id: bigint;
    action: TraceActionType | string;
    trace_hash: Buffer;
    ipfs_cid: string;
    signing_key: Buffer;
    signature: Buffer;
  }): Promise<AdapterResult<bigint>> {
    const action = typeof args.action === "string" ? toTraceAction(args.action) : args.action;
    const call = { ...args, action };
    return this.run(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace_signed",
      call,
      (client) => client.publish_trace_signed(call),
    );
  }
}

/**
 * Generated clients return `Result<T>` for fallible contract methods: an
 * `Err` becomes a thrown error carrying the contract error name (e.g.
 * `MarketAlreadyConfigured`), an `Ok` its value; anything else passes through.
 */
function unwrapContractResult<T>(methodName: string, result: T): T {
  const r = result as { isErr?: () => boolean; unwrapErr?: () => { message?: string }; unwrap?: () => unknown };
  if (typeof r?.isErr !== "function") return result;
  if (r.isErr()) {
    const e = r.unwrapErr?.();
    throw new Error(`${methodName} failed: ${e?.message ?? JSON.stringify(e)}`);
  }
  return r.unwrap!() as T;
}
