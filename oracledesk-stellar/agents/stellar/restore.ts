/**
 * Archival planning for agent submissions (#323).
 *
 * Protocol 23 folds restorations into simulation for most entries: the
 * returned `transactionData` carries a restore list and the invoke pays the
 * rent as part of its resource fee. Older RPCs return a `restorePreamble`
 * instead, which needs a separate, journaled `RestoreFootprint` transaction.
 * This module is deliberately independent of StellarAdapter so both the live
 * path and tests can reason about plans without signing anything.
 */
import { rpc, xdr } from "@stellar/stellar-sdk";
import type { RestoreConfig } from "../core/config.js";
import type { StateStore } from "../runtime/state.js";

export type RestorePlan =
  | { kind: "none" }
  | { kind: "inline"; entries: xdr.LedgerKey[]; rentEstimate: bigint }
  | { kind: "preamble"; footprint: xdr.SorobanTransactionData; minResourceFee: bigint };

/** The subset of a simulation response the planner needs. */
export interface SimulationLike {
  transactionData?: string;
  minResourceFee?: string | number | bigint;
  restorePreamble?: { transactionData: string; minResourceFee: string | number | bigint };
  /** Fake-RPC transport for the Protocol 23 restore list (base64 LedgerKeys). */
  restoreList?: string[];
  latestLedger?: number;
  error?: string;
}

export interface RestoreBudgetState {
  day: number;
  task: string;
  spent: string;
}

const toBigInt = (value: string | number | bigint | undefined): bigint => {
  if (value === undefined) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

interface RestorationDataView {
  ledgerKeys?(): xdr.LedgerKey[];
  ledgerKeys?: xdr.LedgerKey[];
}

interface SorobanDataView {
  resourceFee?(): xdr.Int64;
}

/**
 * Reads the Protocol 23 restore list out of `transactionData`'s extension.
 * The SDK version in use may expose the union arm through a generated
 * accessor or as an `arm()` result; accept both rather than guessing at one.
 */
function inlineRestoreKeys(data: xdr.SorobanTransactionData): xdr.LedgerKey[] {
  const ext = (data as unknown as { ext(): unknown }).ext?.() as
    | {
        switch?(): unknown;
        arm?(): unknown;
        restorationData?(): RestorationDataView | undefined;
        sorobanTransactionDataExtV1?(): { restorationData?: RestorationDataView } | undefined;
      }
    | undefined;
  if (!ext) return [];
  let v1: { restorationData?: RestorationDataView } | undefined;
  if (typeof ext.sorobanTransactionDataExtV1 === "function") v1 = ext.sorobanTransactionDataExtV1();
  if (!v1 && typeof ext.arm === "function") v1 = ext.arm() as typeof v1;
  const restoration = (typeof ext.restorationData === "function" ? ext.restorationData() : undefined) ?? v1?.restorationData;
  if (!restoration) return [];
  const keys = typeof restoration.ledgerKeys === "function" ? restoration.ledgerKeys() : restoration.ledgerKeys;
  return Array.isArray(keys) ? keys : [];
}

export function ledgerKeyLabel(key: xdr.LedgerKey): string {
  try {
    if (key.switch().value === xdr.LedgerEntryType.contractData().value) {
      const cd = key.contractData();
      return `contractData:${cd.contract().toString()}:${cd.key().toString()}`;
    }
    const kind = key.switch() as unknown as { name?: string };
    return kind.name ?? String(key.switch());
  } catch {
    return String(key);
  }
}

/**
 * Detects a restore requirement from a simulation. `baselineResourceFee` is
 * the last successful simulation of the same method without a restore; when
 * absent, the whole resource fee is conservatively attributed to the restore.
 */
export function restorePlanFromSimulation(sim: SimulationLike, baselineResourceFee?: bigint): RestorePlan {
  if (sim.error) return { kind: "none" };
  const api = rpc.Api as unknown as { isSimulationRestore?: (value: unknown) => boolean };
  const flagged = api.isSimulationRestore?.(sim) === true;
  if (sim.restorePreamble || flagged) {
    const preamble = sim.restorePreamble;
    if (!preamble) return { kind: "none" };
    const footprint = xdr.SorobanTransactionData.fromXDR(preamble.transactionData, "base64");
    return { kind: "preamble", footprint, minResourceFee: toBigInt(preamble.minResourceFee) };
  }
  if (Array.isArray(sim.restoreList) && sim.restoreList.length > 0) {
    const entries: xdr.LedgerKey[] = [];
    for (const raw of sim.restoreList) {
      try {
        entries.push(xdr.LedgerKey.fromXDR(raw, "base64"));
      } catch {
        // An undecodable key is not a reason to refuse the action.
      }
    }
    if (entries.length > 0) {
      const fee = toBigInt(sim.minResourceFee);
      const rentEstimate = baselineResourceFee === undefined ? fee : fee > baselineResourceFee ? fee - baselineResourceFee : 0n;
      return { kind: "inline", entries, rentEstimate };
    }
  }
  if (!sim.transactionData) return { kind: "none" };
  let data: xdr.SorobanTransactionData;
  try {
    data = xdr.SorobanTransactionData.fromXDR(sim.transactionData, "base64");
  } catch {
    return { kind: "none" };
  }
  const entries = inlineRestoreKeys(data);
  if (entries.length === 0) return { kind: "none" };
  const fee = toBigInt(sim.minResourceFee ?? (data as unknown as SorobanDataView).resourceFee?.()?.toString());
  const rentEstimate = baselineResourceFee === undefined ? fee : fee > baselineResourceFee ? fee - baselineResourceFee : 0n;
  return { kind: "inline", entries, rentEstimate };
}

export function restoreRentOf(plan: RestorePlan): bigint {
  if (plan.kind === "inline") return plan.rentEstimate;
  if (plan.kind === "preamble") return plan.minResourceFee;
  return 0n;
}

export function restoreKeysOf(plan: RestorePlan): string[] {
  return plan.kind === "inline" ? plan.entries.map(ledgerKeyLabel) : plan.kind === "preamble" ? ["restorePreamble"] : [];
}

/**
 * Enforces the per-action cap and the persisted per-task daily cap. Spend is
 * recorded under `restore.spend` so a crash does not reset the budget.
 */
export class RestoreBudget {
  constructor(
    private readonly cfg: RestoreConfig,
    private readonly state?: StateStore,
    private readonly nowUnix: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get maxRetries(): number {
    return this.cfg.maxRetries;
  }

  private day(): number {
    return Math.floor(this.nowUnix() / 86_400);
  }

  private key(task: string): string {
    return `${this.day()}:${task}`;
  }

  spent(task: string): bigint {
    const raw = this.state?.get<string | bigint>("restore.spend", this.key(task));
    return toBigInt(raw === undefined ? undefined : String(raw));
  }

  remaining(task: string): bigint {
    const left = this.cfg.dailyBudgetStroops - this.spent(task);
    return left > 0n ? left : 0n;
  }

  /** Returns a human-readable refusal reason, or undefined when affordable. */
  check(plan: RestorePlan, task: string): string | undefined {
    if (plan.kind === "none") return undefined;
    const rent = restoreRentOf(plan);
    if (rent > this.cfg.maxFeeStroops) return `restore budget exceeded: ${rent} > per-action cap ${this.cfg.maxFeeStroops}`;
    if (rent > this.remaining(task)) {
      return `restore budget exceeded: ${rent} > remaining daily budget ${this.remaining(task)}`;
    }
    return undefined;
  }

  charge(plan: RestorePlan, task: string): void {
    if (plan.kind === "none" || !this.state) return;
    this.state.set("restore.spend", this.key(task), (this.spent(task) + restoreRentOf(plan)).toString());
  }
}
