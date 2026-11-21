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

import { Account, Address, Contract, Keypair, Operation, rpc, scValToNative, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { KeypairSigner, type MethodOptions } from "@stellar/stellar-sdk/contract";
import type { Client as MarketCoreBindingClient } from "@oracledesk/bindings-market-core";
import type { Client as ReasoningRegistryBindingClient } from "@oracledesk/bindings-reasoning-registry";
import type { Client as ResolverBindingClient } from "@oracledesk/bindings-resolver";
import type { Client as TreasuryBindingClient } from "@oracledesk/bindings-treasury";
import { toContractArg, type PriceConfigArg, type SignerConfigArg, type SpecJson } from "../core/spec.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toTraceAction, type TraceActionType } from "../core/trace.js";
import { assertNever, type AgentMode } from "../runtime/config.js";
import { createJournalRecord, type TransactionJournal } from "./journal.js";
import {
  applyResourceMargin,
  feePolicyFor,
  inclusionBid,
  resourceFeeOf,
  type ActionClass,
  type FeePolicy,
  type FeeRule,
  type FeeStatsResponse,
} from "./fees.js";
import { feeChargedOf, submitSorobanTransaction, type ReplacementPolicy } from "./submit.js";
import { isArchivalError } from "./errors.js";
import {
  RestoreBudget,
  restoreKeysOf,
  restorePlanFromSimulation,
  restoreRentOf,
  type RestorePlan,
} from "./restore.js";
import type { RestoreConfig } from "../core/config.js";
import type { StateStore } from "../runtime/state.js";
import type { StellarSigner } from "./signers/types.js";

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

export interface FeeReport {
  task: string;
  decisionId: string;
  actionClass: ActionClass;
  feeCharged: string;
  bumps: number;
}

/** Operator-visible restore budget/plan report (#323). */
export interface RestoreReport {
  task: string;
  method: string;
  decisionId: string;
  plan: RestorePlan["kind"];
  keys: string[];
  rentEstimate: string;
  remainingDailyBudget: string;
  allowed: boolean;
}

interface CommonAdapterOptions {
  networkPassphrase: string;
  rpcUrl: string;
  agentAddress?: string;
  deployments: Deployments;
  /** Checked before dry-run descriptions and immediately before live broadcasts. */
  beforeSend?: () => void | Promise<void>;
  feePolicy?: FeePolicy;
  journal?: TransactionJournal;
  task?: string;
  onFeeCharged?: (report: FeeReport) => void;
  nowUnix?: () => number;
  /** Persists the per-task restore spend (#323). */
  state?: StateStore;
  /** Overrides for the archival restore caps. */
  restore?: Partial<RestoreConfig>;
  /** Emitted for every detected restore, including dry-run plans. */
  onRestore?: (report: RestoreReport) => void;
}

interface AssembledCall<T = unknown> {
  built?: Transaction;
  signed?: Transaction;
  simulation?: {
    error?: string;
    transactionData?: string;
    minResourceFee?: string | number | bigint;
    restorePreamble?: { transactionData: string; minResourceFee: string | number | bigint };
    latestLedger?: number;
  };
  result?: T | unknown;
  signAndSend(): Promise<{ result: T | unknown; sendTransactionResponse?: { hash?: string } }>;
}

type DynamicContractMethod = (
  args: Record<string, unknown>,
  options?: MethodOptions,
) => Promise<AssembledCall>;

type TypedMarketCoreClient = MarketCoreBindingClient;
type TypedResolverClient = ResolverBindingClient;
type TypedTreasuryClient = TreasuryBindingClient & {
  agent_buy_traced: DynamicContractMethod;
  agent_sell_traced: DynamicContractMethod;
};
type TypedReasoningRegistryClient = ReasoningRegistryBindingClient & {
  publish_decision_trace: DynamicContractMethod;
};

/**
 * "dry-run": builds and logs what would be submitted, never signs or sends,
 * and must not be handed a secret at all. "live": submits real transactions
 * signed with `agentSecret` (`S...`), which it requires.
 */
export type StellarAdapterOptions = CommonAdapterOptions &
  (
    | { mode: "dry-run"; agentSecret?: undefined; signer?: undefined }
    | { mode: "live"; agentSecret?: string; signer?: StellarSigner }
  );

export interface DryRunResult {
  dryRun: true;
  contractId: string;
  method: string;
  args: unknown;
  /** Restore plan detected while preparing the call, when available. */
  restore?: RestorePlan;
}

/** Real result shape depends on the call; see each wrapper method below. */
export type LiveResult<T> = { dryRun: false; value: T; fee?: FeeReport; /** Hash of the submitted transaction, when known. */ txHash?: string };

export type AdapterResult<T> = DryRunResult | LiveResult<T>;

export type Side = "Yes" | "No";

export type TradeStatusRead = {
  spec: "None" | "Price" | "ScaledPrice" | "Twap" | "Signers" | "Disputable" | "WeightedKeys" | "Committee" | "Hybrid";
  state: string;
  closeTime: bigint;
  deadline: bigint;
  openProposal: boolean;
};

export type ResolvabilityPolicyRead = {
  requireRevealed: boolean;
  blockWhenDisputed: boolean;
  blockWithOpenProposal: boolean;
  minSecsToClose: bigint;
  allowedSpecs: number;
};

/** The treasury's effective operating mode (`Treasury::mode`, issue #272). */
export type TreasuryMode = "Normal" | "AgentsHalted" | "Paused" | "Emergency" | "Unwinding";

/** The committed `DisputableSignerConfig` as the watcher reads it. */
export interface DisputableConfigRead {
  signers: string[];
  threshold: number;
  /** Seconds after `proposed_at` during which `dispute` is accepted. */
  disputeWindow: bigint;
  /** Collateral escrowed per dispute, stroops. */
  disputeBond: bigint;
  escalation: "Guardian" | "Committee";
  /** Seconds after a dispute opens before `expire_dispute` may void it. */
  escalationTimeout: bigint;
}

/** A resolver `Dispute` entry. `payee` is undefined while the dispute is open. */
export interface DisputeRead {
  disputer: string;
  bond: bigint;
  /** Collateral token snapshotted when the dispute opened. */
  token: string;
  openedAt: bigint;
  payee?: string;
}

/** Snapshot of a market's read-only state, from `readMarket`. */
export interface MarketRead {
  marketId: number;
  /** IPFS CID / URI of the question metadata (the question text itself is
   * stored off-chain; see docs/frontend-integration.md). */
  metaUri: string;
  closeTime: number;
  reserveYes: bigint;
  reserveNo: bigint;
  /** YES spot price in bps (0..=10_000), from `get_price`. */
  yesBps: number;
  /** YES time-weighted average over the requested `useTwapSecs` window,
   * from `twap`. Present only when `useTwapSecs` was passed. */
  twapBps?: number;
}

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
  private readonly signer?: StellarSigner;
  private readonly publicKey?: string;
  private readonly agentKeypair?: Keypair;
  private readonly feePayerKeypair?: Keypair;
  private readonly feeSpent = new Map<string, bigint>();
  private feeStatsCache?: { ledger: number; stats: FeeStatsResponse };
  private readonly restoreBudget: RestoreBudget;
  /** Last non-restore resource fee per contract method, for inline rent estimates. */
  private readonly restoreBaselines = new Map<string, bigint>();

  constructor(private readonly opts: StellarAdapterOptions) {
    this.restoreBudget = new RestoreBudget(
      {
        maxFeeStroops: 100_000_000n,
        dailyBudgetStroops: 300_000_000n,
        maxRetries: 2,
        ...opts.restore,
      },
      opts.state,
      () => this.nowUnix(),
    );
    switch (opts.mode) {
      case "dry-run":
        if (opts.agentSecret !== undefined || opts.signer !== undefined) {
          throw new Error("dry-run mode must not be given a signer or agentSecret");
        }
        break;
      case "live": {
        if (opts.signer && opts.agentSecret) {
          throw new Error("live mode accepts either signer or agentSecret, not both");
        }
        if (opts.signer) {
          this.signer = opts.signer;
          this.publicKey = opts.signer.address;
        } else if (opts.agentSecret) {
          const keypair = Keypair.fromSecret(opts.agentSecret);
          this.agentKeypair = keypair;
          this.signer = new KeypairSigner(keypair, opts.networkPassphrase);
          this.publicKey = keypair.publicKey();
        } else {
          throw new Error("live mode requires signer or agentSecret");
        }
        const expectedAddress = opts.agentAddress ?? opts.deployments.agent;
        if (this.publicKey !== expectedAddress) {
          throw new Error("signer address does not match the configured agent address");
        }
        if (opts.feePolicy) {
          if (!opts.journal) throw new Error("feePolicy requires a transaction journal in live mode");
          for (const rule of Object.values(opts.feePolicy.policies)) {
            if (rule.bumpMultiplier < 10) throw new Error("fee bump multiplier must be at least 10");
          }
          if (opts.feePolicy.feePayerSecret) {
            this.feePayerKeypair = Keypair.fromSecret(opts.feePolicy.feePayerSecret);
          }
        }
        break;
      }
      default:
        // Only the mode is printed: opts may carry a secret.
        assertNever(opts, "mode", (opts as { mode?: unknown }).mode);
    }
  }

  get mode(): AgentMode {
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

  private get taskName(): string {
    return this.opts.task ?? "agent";
  }

  private nowUnix(): number {
    return this.opts.nowUnix?.() ?? Math.floor(Date.now() / 1000);
  }

  private async feeStats(): Promise<FeeStatsResponse> {
    const server = this.rpcServer() as unknown as { getFeeStats?: () => Promise<FeeStatsResponse> };
    if (typeof server.getFeeStats !== "function") throw new TypeError("RPC does not support getFeeStats");
    const stats = await server.getFeeStats();
    if (this.feeStatsCache && this.feeStatsCache.ledger === stats.latestLedger) return this.feeStatsCache.stats;
    this.feeStatsCache = { ledger: stats.latestLedger, stats };
    return stats;
  }

  private async feeOptionsFor(methodName: string, deadlineUnix?: bigint): Promise<MethodOptions | undefined> {
    if (this.opts.mode !== "live" || !this.opts.feePolicy) return undefined;
    const rule = this.opts.feePolicy.policies[feePolicyFor(methodName)];
    const bid = inclusionBid(await this.feeStats(), rule);
    const options: MethodOptions = { fee: bid.toString() };
    if (deadlineUnix !== undefined) {
      options.timeoutInSeconds = Math.max(1, Number(deadlineUnix - BigInt(this.nowUnix())));
    }
    return options;
  }

  private checkFeeCap(actionClass: ActionClass, fee: bigint, rule: FeeRule): void {
    if (!this.opts.feePolicy) return;
    if (fee > rule.maxTotalFee) throw new NotSubmittedError("fee cap");
    const day = Math.floor(this.nowUnix() / 86_400);
    const used = this.feeSpent.get(`${day}:${actionClass}`) ?? 0n;
    if (used + rule.maxTotalFee > this.opts.feePolicy.maxDailyFees[actionClass]) {
      throw new NotSubmittedError("fee cap");
    }
  }

  private reserveDailyFee(actionClass: ActionClass, rule: FeeRule): void {
    const day = Math.floor(this.nowUnix() / 86_400);
    const key = `${day}:${actionClass}`;
    this.feeSpent.set(key, (this.feeSpent.get(key) ?? 0n) + rule.maxTotalFee);
  }

  private replacementFor(
    inner: Transaction,
    rule: FeeRule,
    stats: FeeStatsResponse,
    deadlineUnix: number | undefined,
    counter: { count: number },
  ): ReplacementPolicy | undefined {
    const feePayer = this.feePayerKeypair;
    if (!feePayer) return undefined;
    const resourceFee = resourceFeeOf(inner);
    const feeRate = BigInt(inner.operations.length + 1);
    return {
      afterPolls: 2,
      deadlineUnix,
      maxBumps: rule.maxBumps,
      bump: (_tx, attempt) => {
        const bid = inclusionBid(stats, rule) * BigInt(rule.bumpMultiplier) ** BigInt(attempt);
        if (bid > rule.maxInclusion) return undefined;
        if (bid * feeRate + resourceFee > rule.maxTotalFee) return undefined;
        try {
          const bump = TransactionBuilder.buildFeeBumpTransaction(
            feePayer.publicKey(),
            bid.toString(),
            inner,
            this.opts.networkPassphrase,
          );
          bump.sign(feePayer);
          counter.count += 1;
          return bump;
        } catch {
          return undefined;
        }
      },
    };
  }

  private decisionId(methodName: string): string {
    return `${this.taskName}-${methodName}-${this.nowUnix()}-${Math.random().toString(16).slice(2)}`;
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
      // A local network (http://localhost:8000/soroban/rpc) has no TLS.
      allowHttp: this.opts.rpcUrl.startsWith("http://"),
      publicKey: this.publicKey,
      signTransaction: this.signer,
    });
  }

  /**
   * Runs `method(client)` (a call to one of the generated Client's methods,
   * returning its `AssembledTransaction`) either as a dry-run description
   * or a real signed submission, depending on `this.mode`.
   *
   * Live submissions are split into prepare (simulate + restore plan), sign
   * and journaled submit. An entry that archives between simulation and apply
   * is retried by re-simulating, never by rebroadcasting the stale envelope.
   */
  private async run<C, T>(
    pkg: keyof Deployments["contracts"],
    moduleName: string,
    methodName: string,
    args: unknown,
    call: (client: C, options?: MethodOptions) => Promise<AssembledCall<T>>,
    opts: { deadlineUnix?: bigint; restorePlan?: RestorePlan } = {},
  ): Promise<AdapterResult<T>> {
    const contractId = this.opts.deployments.contracts[pkg];
    switch (this.opts.mode) {
      case "dry-run":
        await this.opts.beforeSend?.();
        if (opts.restorePlan) this.reportRestore(methodName, "", opts.restorePlan, true);
        return { dryRun: true, contractId, method: methodName, args, ...(opts.restorePlan && { restore: opts.restorePlan }) };
      case "live":
        break;
      default:
        assertNever(this.opts, "mode", (this.opts as { mode?: unknown }).mode);
    }

    const maxRetries = this.restoreBudget.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attemptRun(pkg, moduleName, methodName, args, call, opts, attempt);
      } catch (error) {
        if (!isArchivalError(error) || attempt >= maxRetries) throw error;
      }
    }
  }

  private baselineKey(pkg: string, methodName: string): string {
    return `${pkg}:${methodName}`;
  }

  private resourceFeeOfCall(assembled: AssembledCall<unknown>): bigint {
    const built = assembled.built ?? assembled.signed;
    return built ? resourceFeeOf(built) : 0n;
  }

  private reportRestore(method: string, decisionId: string, plan: RestorePlan, allowed: boolean): void {
    const report: RestoreReport = {
      task: this.taskName,
      method,
      decisionId,
      plan: plan.kind,
      keys: restoreKeysOf(plan),
      rentEstimate: restoreRentOf(plan).toString(),
      remainingDailyBudget: this.restoreBudget.remaining(this.taskName).toString(),
      allowed,
    };
    this.opts.onRestore?.(report);
    if (plan.kind !== "none" && !allowed) {
      console.warn(`[restore] ${method}: ${report.keys.join(", ")} rent ${report.rentEstimate} stroops refused (budget)`);
    } else if (plan.kind !== "none") {
      console.warn(`[restore] ${method}: ${plan.kind} ${report.keys.join(", ")} rent ${report.rentEstimate} stroops`);
    }
  }

  /** One simulate → (restore) → sign → submit attempt. */
  private async attemptRun<C, T>(
    pkg: keyof Deployments["contracts"],
    moduleName: string,
    methodName: string,
    args: unknown,
    call: (client: C, options?: MethodOptions) => Promise<AssembledCall<T>>,
    opts: { deadlineUnix?: bigint; restorePlan?: RestorePlan },
    attempt: number,
  ): Promise<AdapterResult<T>> {
    let assembled: AssembledCall<T>;
    try {
      const options = await this.feeOptionsFor(methodName, opts.deadlineUnix);
      const client = await this.client<C>(pkg, moduleName);
      assembled = await call(client, options);
    } catch (err) {
      throw new NotSubmittedError(`${methodName}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (assembled.simulation?.error) {
      throw new NotSubmittedError(`${methodName} simulation failed: ${assembled.simulation.error}`);
    }

    const key = this.baselineKey(pkg, methodName);
    const baseline = this.restoreBaselines.get(key);
    let plan = restorePlanFromSimulation(assembled.simulation ?? {}, baseline);
    if (plan.kind === "none") this.restoreBaselines.set(key, this.resourceFeeOfCall(assembled));

    const decisionId = attempt === 0 ? this.decisionId(methodName) : `${this.decisionId(methodName)}:retry-${attempt}`;
    const refusal = this.restoreBudget.check(plan, this.taskName);
    this.reportRestore(methodName, decisionId, plan, refusal === undefined);
    if (refusal !== undefined) throw new NotSubmittedError(`${methodName}: ${refusal} [${restoreKeysOf(plan).join(", ")}]`);
    this.restoreBudget.charge(plan, this.taskName);

    if (plan.kind === "preamble") {
      await this.submitRestoreFootprint(plan, decisionId, opts.deadlineUnix);
      // Never reuse a stale simulation: the restore changes the ledger state.
      const client = await this.client<C>(pkg, moduleName);
      const options = await this.feeOptionsFor(methodName, opts.deadlineUnix);
      try {
        assembled = await call(client, options);
      } catch (err) {
        throw new NotSubmittedError(`${methodName}: re-simulation after restore failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      if (assembled.simulation?.error) {
        throw new NotSubmittedError(`${methodName} simulation after restore failed: ${assembled.simulation.error}`);
      }
      const after = restorePlanFromSimulation(assembled.simulation ?? {}, baseline);
      if (after.kind === "preamble") throw new NotSubmittedError(`${methodName}: restore preamble did not clear`);
      if (after.kind === "inline") {
        const afterRefusal = this.restoreBudget.check(after, this.taskName);
        this.reportRestore(methodName, decisionId, after, afterRefusal === undefined);
        if (afterRefusal !== undefined) throw new NotSubmittedError(`${methodName}: ${afterRefusal}`);
        this.restoreBudget.charge(after, this.taskName);
      }
      plan = after;
    }

    const actionClass = feePolicyFor(methodName);
    const rule = this.opts.feePolicy?.policies[actionClass];
    const built = assembled.built ?? assembled.signed;
    if (rule && built && this.agentKeypair && this.opts.journal) {
      this.checkFeeCap(actionClass, BigInt(built.fee), rule);
      const prepared = applyResourceMargin(built, rule.resourceMarginBps);
      if (prepared.signatures.length === 0) prepared.sign(this.agentKeypair);
      this.checkFeeCap(actionClass, BigInt(prepared.fee), rule);
      this.reserveDailyFee(actionClass, rule);

      const stats = await this.feeStats();
      const counter = { count: 0 };
      const result = await submitSorobanTransaction({
        id: decisionId,
        transaction: prepared,
        server: this.rpcServer(),
        journal: this.opts.journal,
        maxAttempts: 4 + rule.maxBumps,
        maxPollsPerAttempt: Math.max(5, 2 * rule.maxBumps + 3),
        retryDelayMs: 250,
        beforeSend: this.opts.beforeSend,
        replacement: this.replacementFor(
          prepared,
          rule,
          stats,
          opts.deadlineUnix === undefined ? undefined : Number(opts.deadlineUnix),
          counter,
        ),
        nowUnix: this.opts.nowUnix,
        kind: "action",
        ...(attempt > 0 && { dependsOn: `${decisionId.replace(/:retry-\d+$/, "")}` }),
      });
      const fee: FeeReport = {
        task: this.taskName,
        decisionId,
        actionClass,
        feeCharged: feeChargedOf(result) ?? BigInt(prepared.fee).toString(),
        bumps: counter.count,
      };
      this.opts.onFeeCharged?.(fee);
      return { dryRun: false, value: unwrapContractResult(methodName, assembled.result as T), fee, ...((result as { txHash?: string }).txHash ? { txHash: (result as { txHash?: string }).txHash } : {}) };
    }

    try {
      await this.opts.beforeSend?.();
    } catch (error) {
      await this.journalCancelled(methodName, assembled, error);
      throw error;
    }
    const sent = await assembled.signAndSend();
    const txHash = sent.sendTransactionResponse?.hash;
    return { dryRun: false, value: unwrapContractResult(methodName, sent.result as T), ...(txHash ? { txHash } : {}) };
  }

  /**
   * Submits an `Operation.restoreFootprint` built from the RPC's preamble.
   * Uses the same source account as the dependent action so a channel account
   * (#258) cannot break the restore → action ordering.
   */
  private async submitRestoreFootprint(
    plan: Extract<RestorePlan, { kind: "preamble" }>,
    actionId: string,
    deadlineUnix?: bigint,
  ): Promise<void> {
    const journal = this.opts.journal;
    if (!journal) throw new NotSubmittedError("a restore preamble requires a transaction journal in live mode");
    const source = await this.rpcServer().getAccount(this.agent);
    const rule = this.opts.feePolicy?.policies.maintenance;
    const stats = await this.feeStats().catch(() => undefined);
    const observed = stats ? BigInt(stats.sorobanInclusionFee.p90) : 100n;
    const cap = rule?.maxInclusion ?? 10_000n;
    const bid = observed < 100n ? 100n : observed > cap ? cap : observed;
    const timeout = deadlineUnix === undefined ? 60 : Math.max(1, Number(deadlineUnix - BigInt(this.nowUnix())));
    let tx = new TransactionBuilder(source, { fee: (bid + plan.minResourceFee).toString(), networkPassphrase: this.opts.networkPassphrase })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(plan.footprint)
      .setTimeout(timeout)
      .build();
    if (this.agentKeypair) tx.sign(this.agentKeypair);
    else {
      const signer = this.signer as unknown as ((transaction: Transaction) => Promise<Transaction>) | undefined;
      if (!signer) throw new NotSubmittedError("a restore preamble needs a local key or a transaction signer");
      tx = await signer(tx);
    }
    await submitSorobanTransaction({
      id: `${actionId}:restore`,
      transaction: tx,
      server: this.rpcServer(),
      journal,
      maxAttempts: 3,
      maxPollsPerAttempt: 5,
      beforeSend: this.opts.beforeSend,
      nowUnix: this.opts.nowUnix,
      kind: "restore",
    });
  }

  /** Simulates a call (never signs) and returns its restore plan (#323). */
  async planRestore<C>(
    pkg: keyof Deployments["contracts"],
    moduleName: string,
    call: (client: C) => Promise<AssembledCall<unknown>>,
  ): Promise<RestorePlan> {
    const client = await this.client<C>(pkg, moduleName);
    const assembled = await call(client);
    if (assembled.simulation?.error) throw new NotSubmittedError(`restore plan simulation failed: ${assembled.simulation.error}`);
    return restorePlanFromSimulation(assembled.simulation ?? {}, this.restoreBaselines.get(this.baselineKey(pkg, "plan")));
  }

  private async journalCancelled(methodName: string, assembled: unknown, error: unknown): Promise<void> {
    const journal = this.opts.journal;
    if (!journal) return;
    const built = (assembled as { built?: { toXDR(): string; hash(): { toString(radix?: number): string } } }).built;
    const hash = built?.hash().toString("hex") ?? "";
    await journal.append(createJournalRecord({
      id: `${methodName}:${hash || "before-broadcast"}`,
      stage: "cancelled",
      hash,
      envelopeXdr: built?.toXDR() ?? "",
      detail: error instanceof Error ? error.message : String(error),
    }));
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
    return this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_create_market",
      call,
      (client, options) => client.agent_create_market(call as Parameters<TypedTreasuryClient["agent_create_market"]>[0], options),
    );
  }

  async agentBuy(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_in: bigint;
    min_shares_out: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = { agent: this.agent, ...args };
    return this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_buy",
      call,
      (client, options) => client.agent_buy(call, options),
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
    return this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_buy_v2",
      call,
      (client, options) => client.agent_buy_v2(call, options),
      { deadlineUnix: args.deadline },
    );
  }

  async agentSell(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
    max_shares_in: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = { agent: this.agent, ...args };
    return this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_sell",
      call,
      (client, options) => client.agent_sell(call, options),
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
    return this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_sell_v2",
      call,
      (client, options) => client.agent_sell_v2(call, options),
      { deadlineUnix: args.deadline },
    );
  }

  async agentHalt(reason: number): Promise<AdapterResult<void>> {
    const call = { agent: this.agent, reason };
    return this.run<TypedTreasuryClient, void>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_halt",
      call,
      (client) => client.agent_halt(call),
    );
  }

  async getAgent(agent = this.agent): Promise<{ active: boolean; roles: number } | undefined> {
    const client = await this.client<TypedTreasuryClient>("treasury", "@oracledesk/bindings-treasury");
    const policy = (await client.get_agent({ agent })).result as { active: boolean; roles: bigint | number } | undefined;
    if (!policy) return undefined;
    return { active: Boolean(policy.active), roles: Number(policy.roles) };
  }

  async drawdownStatus(): Promise<{ tripped: boolean; windowPnl: bigint; maxDrawdown: bigint }> {
    const client = await this.client<TypedTreasuryClient>("treasury", "@oracledesk/bindings-treasury");
    const status = unwrapContractResult("drawdown_status", (await client.drawdown_status()).result) as unknown as {
      tripped: boolean;
      window_pnl: bigint;
      max_drawdown: bigint;
    };
    return {
      tripped: Boolean(status.tripped),
      windowPnl: BigInt(status.window_pnl),
      maxDrawdown: BigInt(status.max_drawdown),
    };
  }

  /**
   * Unwind-mode sell (#150). The caller must be the configured agent or the
   * treasury's unwinder, and the treasury must be in `Unwinding` mode.
   */
  async unwindSell(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
    max_shares_in: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = { caller: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "unwind_sell", call, (client) =>
      client.unwind_sell(call),
    );
  }

  /** Effective exit floor for `marketId`, in bps. */
  async exitFloor(marketId: bigint): Promise<bigint> {
    const client = await this.client<any>("treasury", "@oracledesk/bindings-treasury");
    const { result } = await client.exit_floor({ market_id: marketId });
    return BigInt(result);
  }

  /**
   * Simulates market-core's `quote_sell` (read-only) and returns the shares
   * a sale of exactly `collateral_out` would consume.
   */
  async quoteSell(args: {
    market_id: bigint;
    outcome: { tag: "Yes" | "No"; values: void };
    collateral_out: bigint;
  }): Promise<bigint> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.quote_sell(args);
    return BigInt(unwrapContractResult("quote_sell", result) as bigint);
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
    const client = await this.client<TypedMarketCoreClient>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.quote_buy(args);
    // quote_buy returns Result<i128, Error>: unwrap it, and surface an Err.
    return BigInt(unwrapContractResult("quote_buy", result) as unknown as bigint);
  }

  /**
   * Reveals a signer-mode spec (resolver `register_signer_spec`).
   * Permissionless: the commitment, not the caller, authorizes it.
   */
  async registerSignerSpec(args: { market_id: bigint; spec: SignerConfigArg }): Promise<AdapterResult<void>> {
    return this.run<TypedResolverClient, void>(
      "resolver",
      "@oracledesk/bindings-resolver",
      "register_signer_spec",
      args,
      (client, options) => client.register_signer_spec(args as Parameters<TypedResolverClient["register_signer_spec"]>[0], options),
    );
  }

  /** Reveals a price-mode spec (resolver `register_price_spec`). */
  async registerPriceSpec(args: { market_id: bigint; spec: PriceConfigArg }): Promise<AdapterResult<void>> {
    return this.run<TypedResolverClient, void>(
      "resolver",
      "@oracledesk/bindings-resolver",
      "register_price_spec",
      args,
      (client, options) => client.register_price_spec(args as Parameters<TypedResolverClient["register_price_spec"]>[0], options),
    );
  }

  /** Reveals `spec` through whichever wrapper its mode needs, in canonical order. */
  async revealSpec(marketId: bigint, spec: SpecJson): Promise<AdapterResult<void>> {
    return spec.mode === "signers"
      ? this.registerSignerSpec({ market_id: marketId, spec: toContractArg(spec) as SignerConfigArg })
      : this.registerPriceSpec({ market_id: marketId, spec: toContractArg(spec) as PriceConfigArg });
  }

  /**
   * The treasury's effective operating mode (read-only simulation; also runs in
   * dry-run). Unit enum variants decode to `[name]`. Agents read it once per
   * tick and skip open-position work unless it is `Normal`, instead of
   * discovering a halt from a failed simulation.
   */
  async treasuryMode(): Promise<TreasuryMode> {
    const r = (await this.simulateRead(this.opts.deployments.contracts.treasury, "mode", [])) as [TreasuryMode] | TreasuryMode;
    return Array.isArray(r) ? r[0] : r;
  }

  /** The resolver's `trade_status` for `marketId` (#273): what the treasury's pre-buy check reads. */
  async tradeStatus(marketId: bigint): Promise<TradeStatusRead> {
    const client = await this.client<any>("resolver", "@oracledesk/bindings-resolver");
    const r = unwrapContractResult("trade_status", (await client.trade_status({ market_id: marketId })).result) as {
      spec: { tag: TradeStatusRead["spec"] };
      state: { tag: string };
      close_time: bigint;
      deadline: bigint;
      open_proposal: boolean;
    };
    return { spec: r.spec.tag, state: r.state.tag, closeTime: BigInt(r.close_time), deadline: BigInt(r.deadline), openProposal: r.open_proposal };
  }

  /** The treasury's `ResolvabilityPolicy` (all-permissive until the admin tightens it). */
  async resolvabilityPolicy(): Promise<ResolvabilityPolicyRead> {
    const p = (await this.simulateRead(this.opts.deployments.contracts.treasury, "get_resolvability_policy", [])) as {
      require_revealed: boolean;
      block_when_disputed: boolean;
      block_with_open_proposal: boolean;
      min_secs_to_close: bigint;
      allowed_specs: number;
    };
    return {
      requireRevealed: p.require_revealed,
      blockWhenDisputed: p.block_when_disputed,
      blockWithOpenProposal: p.block_with_open_proposal,
      minSecsToClose: BigInt(p.min_secs_to_close),
      allowedSpecs: Number(p.allowed_specs),
    };
  }

  /**
   * Atomic create-and-reveal through `agent_create_market_reveal_v2`: the treasury
   * reveals to the resolver market-core is configured with, so there is no
   * resolver argument to misuse (the older `agent_create_market_and_reveal`
   * requires it to equal that resolver).
   */
  async agentCreateAndReveal(args: {
    question_hash: Buffer;
    meta_uri: string;
    category: { tag: string; values: void };
    close_time: bigint;
    seed_amount: bigint;
    initial_yes_bps: number;
    spec_v2: unknown;
  }): Promise<AdapterResult<bigint>> {
    const call = { agent: this.agent, ...args };
    return this.run("treasury", "@oracledesk/bindings-treasury", "agent_create_market_reveal_v2", call, (client) =>
      client.agent_create_market_reveal_v2(call),
    );
  }

  /** market-core `market_count` (read-only simulation; also runs in dry-run). */
  async marketCount(): Promise<bigint> {
    const client = await this.client<TypedMarketCoreClient>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.market_count();
    return BigInt(result);
  }

  /** market-core `get_market` (read-only), or `undefined` if it does not exist. */
  async getMarket(marketId: bigint): Promise<
    | {
        creator: string;
        questionHash: string;
        resolutionHash: string;
        closeTime: bigint;
        status: "Open" | "Resolved" | "Void";
        reserveYes: bigint;
        reserveNo: bigint;
        feeBps: bigint;
      }
    | undefined
  > {
    const client = await this.client<TypedMarketCoreClient>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.get_market({ market_id: marketId });
    if (result?.isErr?.()) return undefined;
    const m = typeof result?.unwrap === "function" ? result.unwrap() : (result as unknown as {
      creator: string;
      question_hash: Buffer;
      resolution_hash: Buffer;
      close_time: bigint;
      status: { tag: "Open" | "Resolved" | "Void" };
      reserve_yes: bigint;
      reserve_no: bigint;
      fee_bps: bigint | number;
    });
    return {
      creator: m.creator,
      questionHash: Buffer.from(m.question_hash).toString("hex"),
      resolutionHash: Buffer.from(m.resolution_hash).toString("hex"),
      closeTime: BigInt(m.close_time),
      status: m.status.tag,
      reserveYes: BigInt(m.reserve_yes),
      reserveNo: BigInt(m.reserve_no),
      feeBps: BigInt(m.fee_bps),
    };
  }

  /**
   * The treasury caps that bound this agent: the stricter of the global
   * config and the agent's own policy, plus what it has spent today.
   */
  async riskCaps(): Promise<{
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
    dailyUsed: bigint;
    dailyHeadroom?: bigint;
  }> {
    const client = await this.client<TypedTreasuryClient>("treasury", "@oracledesk/bindings-treasury");
    const config = unwrapContractResult("get_config", (await client.get_config()).result) as unknown as {
      max_trade: bigint;
      max_market: bigint;
      max_daily: bigint;
    };
    const policy = (await client.get_agent({ agent: this.agent })).result as { max_trade: bigint; max_daily: bigint } | undefined;
    const [usageResult, globalHeadroomResult] = await Promise.all([
      client.agent_daily_usage({ agent: this.agent }),
      client.daily_headroom(),
    ]);
    const usage = unwrapContractResult("agent_daily_usage", usageResult.result) as unknown as { amount: bigint };
    const min = (a: bigint, b?: bigint) => (b !== undefined && BigInt(b) < BigInt(a) ? BigInt(b) : BigInt(a));
    const maxDaily = min(config.max_daily, policy?.max_daily);
    const agentHeadroom = max0(maxDaily - BigInt(usage.amount));
    return {
      maxTrade: min(config.max_trade, policy?.max_trade),
      maxMarket: BigInt(config.max_market),
      maxDaily,
      dailyUsed: BigInt(usage.amount),
      dailyHeadroom: min(BigInt(unwrapContractResult("daily_headroom", globalHeadroomResult.result) as unknown as bigint), agentHeadroom),
    };
  }

  /** Reads ledger keys together with the ledger they were read at, so TTLs can
   * be interpreted (#323). An entry with `liveUntilLedgerSeq < latestLedger`
   * is archived, not live, even though RPC still returns its bytes. */
  private async readLedger(keys: xdr.LedgerKey[]): Promise<{
    entries: Awaited<ReturnType<rpc.Server["getLedgerEntries"]>>["entries"];
    latestLedger: number;
  }> {
    const response = await this.rpcServer().getLedgerEntries(...keys);
    const latest = (response as { latestLedger?: number }).latestLedger
      ?? (await this.rpcServer().getLatestLedger()).sequence;
    return { entries: response.entries, latestLedger: latest };
  }

  private archived(entry: { liveUntilLedgerSeq?: number } | undefined, latestLedger: number): boolean {
    return entry?.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < latestLedger;
  }

  /**
   * Cumulative treasury spend for this market; sells and close_trade do not
   * erase it. archived=true means the persistent entry needs a restore; no
   * stale value is ever returned as live.
   */
  async marketExposureState(marketId: bigint): Promise<{ archived: boolean; amount?: bigint }> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.opts.deployments.contracts.treasury).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Market"), xdr.ScVal.scvU64(xdr.Uint64.fromString(String(marketId)))]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries, latestLedger } = await this.readLedger([key]);
    const entry = entries[0];
    if (!entry || this.archived(entry, latestLedger)) return { archived: entry !== undefined };
    const data = entry.val.contractData()?.val();
    const amount = data?.map()?.find((item) => item.key().sym?.().toString() === "amount")?.val()?.i128()?.toString();
    if (amount === undefined) throw new Error(`treasury market exposure ${marketId} has an invalid ledger entry`);
    return { archived: false, amount: BigInt(amount) };
  }

  /** Cumulative treasury spend for this market; throws when the entry is archived. */
  async marketExposure(marketId: bigint): Promise<bigint> {
    const state = await this.marketExposureState(marketId);
    if (state.archived) throw new NotSubmittedError(`treasury market exposure ${marketId} is archived; restore it before trading`);
    return state.amount ?? 0n;
  }

  /** What the treasury has committed to `marketId` (its cost basis). */
  async marketSpent(marketId: bigint): Promise<bigint> {
    const client = await this.client<TypedTreasuryClient>("treasury", "@oracledesk/bindings-treasury");
    const v = unwrapContractResult("market_valuation", (await client.market_valuation({ market_id: marketId })).result) as unknown as {
      cost_basis: bigint;
    };
    return BigInt(v.cost_basis);
  }

  /** An RPC client for this adapter's network (event polling, ledger reads). */
  rpcServer(): rpc.Server {
    return new rpc.Server(this.opts.rpcUrl, { allowHttp: this.opts.rpcUrl.startsWith("http://") });
  }

  /** The deployment's contract ids. A copy: callers cannot rebind the adapter. */
  contractIds(): Deployments["contracts"] {
    return { ...this.opts.deployments.contracts };
  }

  /** The treasury's YES/NO shares in `marketId` (zero when it holds none). */
  async treasuryPosition(marketId: bigint): Promise<{ yes: bigint; no: bigint }> {
    const client = await this.client<TypedMarketCoreClient>("market_core", "@oracledesk/bindings-market-core");
    const { result } = await client.get_position({ market_id: marketId, holder: this.opts.deployments.contracts.treasury });
    return { yes: BigInt(result.yes), no: BigInt(result.no) };
  }

  /** The resolver's state tag for `marketId`, e.g. "SignersPending". */
  async resolutionState(marketId: bigint): Promise<string> {
    const client = await this.client<TypedResolverClient>("resolver", "@oracledesk/bindings-resolver");
    const { result } = await client.state({ market_id: marketId });
    return (result as { tag: string }).tag;
  }

  /**
   * Whether a legacy spec is registered for `marketId`. A signer reveal
   * moves `state()` to SignersPending, but a price reveal leaves it
   * Unconfigured, so the resolver's `Price(market_id)` entry is read too.
   */
  async isSpecRevealed(marketId: bigint): Promise<boolean> {
    const client = await this.client<TypedResolverClient>("resolver", "@oracledesk/bindings-resolver");
    const { result } = await client.state({ market_id: marketId });
    if (result?.tag && result.tag !== "Unconfigured") return true;
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.opts.deployments.contracts.resolver).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Price"), xdr.ScVal.scvU64(new xdr.Uint64(marketId))]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries, latestLedger } = await this.readLedger([key]);
    return entries.some((entry) => !this.archived(entry, latestLedger));
  }

  // ─── Disputes (resolver) ────────────────────────────────────────────────
  // Used by the proposal watcher. The disputer is always this adapter's own
  // address, so the watcher runs on a dedicated adapter and key.

  /**
   * Challenges the market's pending signer proposal with a bond
   * (resolver `dispute`). `alternative` is the outcome the caller claims is
   * correct; `null` claims the market is invalid.
   */
  async dispute(args: { market_id: bigint; alternative: Side | null }): Promise<AdapterResult<void>> {
    const call = {
      market_id: args.market_id,
      disputer: this.agent,
      alternative: args.alternative === null ? undefined : { tag: args.alternative, values: undefined as void },
    };
    return this.run("resolver", "@oracledesk/bindings-resolver", "dispute", call, (client) => client.dispute(call));
  }

  /** Permissionless: voids a dispute that outlived `escalation_timeout` and refunds the bond. */
  async expireDispute(marketId: bigint): Promise<AdapterResult<void>> {
    const call = { market_id: marketId };
    return this.run("resolver", "@oracledesk/bindings-resolver", "expire_dispute", call, (client) => client.expire_dispute(call));
  }

  /** Permissionless: pays a settled dispute's bond to its payee. */
  async claimDisputeBond(marketId: bigint): Promise<AdapterResult<void>> {
    const call = { market_id: marketId };
    return this.run("resolver", "@oracledesk/bindings-resolver", "claim_dispute_bond", call, (client) => client.claim_dispute_bond(call));
  }

  /**
   * A resolver persistent entry, decoded without the binding spec: the
   * generated bindings only carry the types that appear in a function
   * signature, and `Dispute` / `SignerProposalV2` do not. Structs decode to
   * objects, unit enum variants to `[name]`, `None` to null.
   */
  private async resolverEntry<T>(variant: string, marketId: bigint): Promise<T | undefined> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.opts.deployments.contracts.resolver).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), xdr.ScVal.scvU64(xdr.Uint64.fromString(String(marketId)))]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries, latestLedger } = await this.readLedger([key]);
    const entry = entries[0];
    if (!entry || this.archived(entry, latestLedger)) return undefined;
    return scValToNative(entry.val.contractData().val()) as T;
  }

  /**
   * The committed `DisputableSignerConfig` (resolver `DataKey::Disputable`),
   * or `undefined` for a market that is not a disputable signer market.
   */
  async disputableConfig(marketId: bigint): Promise<DisputableConfigRead | undefined> {
    const c = await this.resolverEntry<{
      signers: string[];
      threshold: number;
      dispute_window: bigint;
      dispute_bond: bigint;
      escalation: ["Guardian"] | ["Committee", ...unknown[]];
      escalation_timeout: bigint;
    }>("Disputable", marketId);
    if (!c) return undefined;
    return {
      signers: c.signers,
      threshold: c.threshold,
      disputeWindow: BigInt(c.dispute_window),
      disputeBond: BigInt(c.dispute_bond),
      escalation: c.escalation[0],
      escalationTimeout: BigInt(c.escalation_timeout),
    };
  }

  /** The open or settled dispute (resolver `DataKey::Dispute`), if any. */
  async currentDispute(marketId: bigint): Promise<DisputeRead | undefined> {
    const d = await this.resolverEntry<{ disputer: string; bond: bigint; token: string; opened_at: bigint; payee?: string | null }>("Dispute", marketId);
    if (!d) return undefined;
    return { disputer: d.disputer, bond: BigInt(d.bond), token: d.token, openedAt: BigInt(d.opened_at), payee: d.payee ?? undefined };
  }

  /** The pending signer proposal (resolver `DataKey::ProposalV2`), if any. */
  async currentProposal(marketId: bigint): Promise<{ outcome: "Yes" | "No" | "Invalid"; proposedAt: bigint } | undefined> {
    const p = await this.resolverEntry<{ outcome: ["Yes" | "No" | "Invalid"]; proposed_at: bigint }>("ProposalV2", marketId);
    return p ? { outcome: p.outcome[0], proposedAt: BigInt(p.proposed_at) } : undefined;
  }

  /** Close time of the latest ledger, unix seconds: the clock `dispute` is judged against. */
  async ledgerTime(): Promise<bigint> {
    return BigInt((await this.rpcServer().getLatestLedger()).closeTime);
  }

  /** `addr`'s balance of the market-core collateral token, in stroops. */
  async collateralBalance(addr: string): Promise<bigint> {
    const client = await this.client<any>("market_core", "@oracledesk/bindings-market-core");
    const config = unwrapContractResult("get_config", (await client.get_config()).result) as { collateral: string };
    return this.readToken(config.collateral, addr);
  }

  /** SEP-41 `balance(addr)` of `token`, simulated (never signed or submitted). */
  async readToken(token: string, addr: string): Promise<bigint> {
    return BigInt((await this.simulateRead(token, "balance", [new Address(addr).toScVal()])) as bigint);
  }

  /**
   * Simulates `contractId.method(args)` and returns the decoded result.
   * Read-only: used for contracts without generated bindings (Reflector, SAC).
   */
  async simulateRead(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
    const source = new Account(this.agent, "0");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: this.opts.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.rpcServer().simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${method} simulation failed on ${contractId}`);
    return scValToNative(sim.result.retval);
  }

  /** Reflector (SEP-40) `resolution()`: seconds between records. */
  async reflectorResolution(reflector: string): Promise<number> {
    return Number(await this.simulateRead(reflector, "resolution", []));
  }

  /** Reflector `price(asset, timestamp)`: the record at exactly `timestamp`, if any. */
  async reflectorPrice(
    reflector: string,
    asset: { tag: "Stellar" | "Other"; value: string },
    timestamp: bigint,
  ): Promise<{ price: bigint; timestamp: bigint } | undefined> {
    const assetVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(asset.tag),
      asset.tag === "Stellar" ? new Address(asset.value).toScVal() : xdr.ScVal.scvSymbol(asset.value),
    ]);
    const r = (await this.simulateRead(reflector, "price", [assetVal, xdr.ScVal.scvU64(xdr.Uint64.fromString(timestamp.toString()))])) as
      | { price: bigint; timestamp: bigint }
      | null
      | undefined;
    return r ? { price: BigInt(r.price), timestamp: BigInt(r.timestamp) } : undefined;
  }

  /** The attestation-linked evidence citations recorded for `marketId` (resolver `evidence_at`). */
  async attestationEvidence(marketId: bigint): Promise<{ signer: string; outcome: "Yes" | "No" | "Invalid"; traceId: bigint; traceHash: string }[]> {
    const client = await this.client<any>("resolver", "@oracledesk/bindings-resolver");
    const count = Number((await client.evidence_count({ market_id: marketId })).result);
    const out = [];
    for (let index = 0; index < count; index++) {
      const e = unwrapContractResult("evidence_at", (await client.evidence_at({ market_id: marketId, index })).result) as {
        signer: string;
        outcome: { tag: "Yes" | "No" | "Invalid" };
        trace_id: bigint;
        trace_hash: Uint8Array;
      };
      out.push({ signer: e.signer, outcome: e.outcome.tag, traceId: BigInt(e.trace_id), traceHash: Buffer.from(e.trace_hash).toString("hex") });
    }
    return out;
  }

  /** The IPFS CID a registry trace was published with. */
  async traceCid(traceId: bigint): Promise<string> {
    const client = await this.client<any>("reasoning_registry", "@oracledesk/bindings-reasoning-registry");
    const t = unwrapContractResult("get_trace", (await client.get_trace({ trace_id: traceId })).result) as { ipfs_cid: string };
    return t.ipfs_cid;
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
    return this.run<TypedReasoningRegistryClient, bigint>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace",
      call,
      (client, options) => client.publish_trace(call as Parameters<TypedReasoningRegistryClient["publish_trace"]>[0], options),
    );
  }

  async publishTraceBatch(args: {
    agent: string;
    root: Buffer;
    leaf_count: number;
    manifest_cid: string;
  }): Promise<AdapterResult<bigint>> {
    return this.run<TypedReasoningRegistryClient, bigint>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace_batch",
      args,
      (client, options) => client.publish_trace_batch(args, options),
    );
  }

  async addSigningKey(args: {
    agent: string;
    public_key: Buffer;
    proof_sig: Buffer;
  }): Promise<AdapterResult<void>> {
    return this.run<TypedReasoningRegistryClient, void>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "add_signing_key",
      args,
      (client, options) => client.add_signing_key(args, options),
    );
  }

  async retireSigningKey(args: {
    agent: string;
    public_key: Buffer;
  }): Promise<AdapterResult<void>> {
    return this.run<TypedReasoningRegistryClient, void>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "retire_signing_key",
      args,
      (client, options) => client.retire_signing_key(args, options),
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
    return this.run<TypedReasoningRegistryClient, bigint>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_trace_signed",
      call,
      (client, options) => client.publish_trace_signed(call as Parameters<TypedReasoningRegistryClient["publish_trace_signed"]>[0], options),
    );
  }

  /**
   * Reads a market's price state. Unlike the write wrappers above, a read
   * always queries the network — through the bindings' simulation, which
   * never signs or submits — so it works identically in dry-run and live
   * mode and there is no offline stand-in to return.
   *
   * `useTwapSecs` additionally reads `twap(market_id, useTwapSecs)`: the
   * time-weighted average over that trailing window, which a single
   * transaction cannot move (see market-core's accumulator, issue #11).
   * Prefer it over spot for any automated trading loop.
   */
  async readMarket(
    marketId: bigint,
    opts: { useTwapSecs?: number } = {},
  ): Promise<MarketRead> {
    const client = await this.client<TypedMarketCoreClient>("market_core", "@oracledesk/bindings-market-core");
    const marketTx = await client.get_market({ market_id: marketId });
    const market = marketTx.result.unwrap() as {
      meta_uri: string;
      close_time: bigint;
      reserve_yes: bigint;
      reserve_no: bigint;
    };
    const priceTx = await client.get_price({
      market_id: marketId,
      outcome: { tag: "Yes", values: undefined },
    });
    const read: MarketRead = {
      marketId: Number(marketId),
      metaUri: market.meta_uri,
      closeTime: Number(market.close_time), // unix seconds, safe as number
      reserveYes: market.reserve_yes,
      reserveNo: market.reserve_no,
      yesBps: priceTx.result.unwrap() as number,
    };
    if (opts.useTwapSecs !== undefined) {
      const twapTx = await client.twap({
        market_id: marketId,
        window_secs: BigInt(opts.useTwapSecs),
      });
      read.twapBps = twapTx.result.unwrap() as number;
    }
    return read;
  }

  async publishDecisionTrace(args: {
    agent: string;
    marketId: bigint;
    action: string;
    traceHash: string;
    ipfsCid: string;
    decisionHash: string;
  }): Promise<{ traceId: bigint }> {
    const call = {
      agent: args.agent,
      market_id: args.marketId,
      action: toTraceAction(args.action),
      trace_hash: hexToBuffer(args.traceHash),
      ipfs_cid: args.ipfsCid,
      decision_hash: hexToBuffer(args.decisionHash),
    };
    const result = await this.run<TypedReasoningRegistryClient, bigint>(
      "reasoning_registry",
      "@oracledesk/bindings-reasoning-registry",
      "publish_decision_trace",
      call,
      (client, options) => client.publish_decision_trace(call, options),
    );
    if (result.dryRun) throw new NotSubmittedError("publishDecisionTrace requires live mode");
    return { traceId: BigInt(result.value) };
  }

  async agentBuyTraced(args: {
    agent: string;
    marketId: bigint;
    outcome: number;
    collateralIn: bigint;
    minSharesOut: bigint;
    limitPriceBps: number;
    deadline: bigint;
    traceId: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = {
      agent: args.agent,
      market_id: args.marketId,
      outcome: outcomeFromNumber(args.outcome),
      collateral_in: args.collateralIn,
      min_shares_out: args.minSharesOut,
      limit_price_bps: args.limitPriceBps,
      deadline: args.deadline,
      trace_id: args.traceId,
    };
    const result = await this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_buy_traced",
      call,
      (client, options) => client.agent_buy_traced(call, options),
      { deadlineUnix: args.deadline },
    );
    return result;
  }

  async agentSellTraced(args: {
    agent: string;
    marketId: bigint;
    outcome: number;
    collateralOut: bigint;
    maxSharesIn: bigint;
    limitPriceBps: number;
    deadline: bigint;
    traceId: bigint;
  }): Promise<AdapterResult<bigint>> {
    const call = {
      agent: args.agent,
      market_id: args.marketId,
      outcome: outcomeFromNumber(args.outcome),
      collateral_out: args.collateralOut,
      max_shares_in: args.maxSharesIn,
      limit_price_bps: args.limitPriceBps,
      deadline: args.deadline,
      trace_id: args.traceId,
    };
    const result = await this.run<TypedTreasuryClient, bigint>(
      "treasury",
      "@oracledesk/bindings-treasury",
      "agent_sell_traced",
      call,
      (client, options) => client.agent_sell_traced(call, options),
      { deadlineUnix: args.deadline },
    );
    return result;
  }

  async tradeAndPublishTrace(
    args: Record<string, unknown> & { method?: string; deadline?: bigint | number | string },
  ): Promise<unknown> {
    const method = typeof args?.method === "string" ? args.method : "trade_and_publish_trace";
    const result = await this.run<Record<string, DynamicContractMethod>, unknown>(
      "treasury",
      "@oracledesk/bindings-treasury",
      method,
      args,
      (client, options) => {
        const fn = client[method];
        if (typeof fn !== "function") {
          throw new TypeError(`treasury client has no method ${method}`);
        }
        return fn(args, options);
      },
      args?.deadline === undefined ? {} : { deadlineUnix: BigInt(args.deadline) },
    );
    return liveValue(result, method);
  }
}

function max0(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function liveValue<T>(result: AdapterResult<T>, method: string): T {
  if (result.dryRun) throw new NotSubmittedError(`${method} requires live mode`);
  return result.value;
}

function hexToBuffer(value: string): Buffer {
  if (!/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw new TypeError("expected a 32-byte hex string");
  return Buffer.from(value.replace(/^0x/, ""), "hex");
}

function outcomeFromNumber(value: number): { tag: "Yes" | "No"; values: void } {
  if (value === 0) return { tag: "Yes", values: undefined };
  if (value === 1) return { tag: "No", values: undefined };
  throw new TypeError("outcome must be 0 (Yes) or 1 (No)");
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
