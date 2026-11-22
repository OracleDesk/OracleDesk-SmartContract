/**
 * Deterministic, scriptable faults for the fake Soroban RPC (#106).
 *
 * A plan is a list of rules. Each RPC request is matched against them in
 * order; a rule fires on the nth matching request (1-based, default every
 * one) and for `times` requests (default 1). `FaultPlan.chaos(seed)` instead
 * draws faults from a seeded RNG, so the same seed and the same request
 * sequence always produce the same faults. `history` records what fired.
 */
import { Rng } from "../../sim/rng.js";

export type RpcMethod =
  | "getHealth"
  | "getNetwork"
  | "getLatestLedger"
  | "getLedgerEntries"
  | "getFeeStats"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getEvents";

export type TxErrorCode = "txBAD_SEQ" | "txTOO_LATE" | "txINSUFFICIENT_FEE";

export type Fault =
  /** Delays the response; the request still succeeds. */
  | { kind: "latency"; ms: number }
  /** Holds the request for `ms`, then drops the connection without a response. */
  | { kind: "timeout"; ms: number }
  | { kind: "http"; status: number }
  | { kind: "rpc-error"; code: number; message: string }
  /** sendTransaction: the node refuses the transaction for now. Nothing is applied. */
  | { kind: "try-again-later" }
  /** sendTransaction: answers DUPLICATE as if this exact envelope was already seen. Nothing is applied. */
  | { kind: "duplicate" }
  /** sendTransaction: rejected before inclusion with this result code. Nothing is applied. */
  | { kind: "tx-error"; code: TxErrorCode }
  /** sendTransaction: accepted and applied, but getTransaction answers NOT_FOUND `polls` more times. */
  | { kind: "not-found"; polls: number }
  /** simulateTransaction: the contract returns this `Error` variant. */
  | { kind: "contract-error"; error: string }
  /** sendTransaction: simulation succeeded, but application fails with this `Error` variant (fee charged). */
  | { kind: "apply-failure"; error: string }
  /** sendTransaction: accepted and applied, then the connection is reset before the response. */
  | { kind: "reset-after-accept" }
  | { kind: "surge"; minInclusion: string | number | bigint; ledgers: number };

export interface FaultRule {
  method: RpcMethod;
  /** Contract function the request invokes (simulate/send only). */
  fn?: string;
  /** Fire on the nth matching request, 1-based. Omit to start at the first. */
  nth?: number;
  /** How many matching requests in a row it fires for (default 1; Infinity for all). */
  times?: number;
  fault: Fault;
}

export interface FiredFault {
  seq: number;
  method: RpcMethod;
  fn?: string;
  fault: Fault;
}

/** Faults a chaos plan may draw, per method. Visibility faults are kept short
 * so the SDK's real 1s/1.5s polling backoff stays bounded. */
const CHAOS_FAULTS: Partial<Record<RpcMethod, Fault[]>> = {
  getLedgerEntries: [{ kind: "latency", ms: 5 }, { kind: "http", status: 503 }],
  simulateTransaction: [
    { kind: "latency", ms: 5 },
    { kind: "http", status: 502 },
    { kind: "rpc-error", code: -32603, message: "internal error" },
  ],
  sendTransaction: [
    { kind: "try-again-later" },
    { kind: "tx-error", code: "txBAD_SEQ" },
    { kind: "tx-error", code: "txINSUFFICIENT_FEE" },
    { kind: "not-found", polls: 1 },
    { kind: "reset-after-accept" },
  ],
  getTransaction: [{ kind: "latency", ms: 5 }],
};

export class FaultPlan {
  readonly history: FiredFault[] = [];
  private readonly seen = new Map<FaultRule, number>();
  private seq = 0;

  private constructor(
    private readonly rules: FaultRule[],
    private readonly chaos?: { rng: Rng; rate: number; methods: RpcMethod[] },
  ) {}

  static none(): FaultPlan {
    return new FaultPlan([]);
  }

  static script(rules: FaultRule[]): FaultPlan {
    return new FaultPlan(rules);
  }

  /** Seeded random faults: each eligible request faults with probability `rate`. */
  static chaos(seed: bigint, opts: { rate?: number; methods?: RpcMethod[] } = {}): FaultPlan {
    const methods = opts.methods ?? (Object.keys(CHAOS_FAULTS) as RpcMethod[]);
    return new FaultPlan([], { rng: new Rng(seed).fork("fake-rpc-chaos"), rate: opts.rate ?? 0.2, methods });
  }

  /** The faults to apply to this request, in rule order. */
  next(method: RpcMethod, fn?: string): Fault[] {
    const seq = ++this.seq;
    const fired: Fault[] = [];
    for (const rule of this.rules) {
      if (rule.method !== method || (rule.fn !== undefined && rule.fn !== fn)) continue;
      const n = (this.seen.get(rule) ?? 0) + 1;
      this.seen.set(rule, n);
      const start = rule.nth ?? 1;
      if (n >= start && n < start + (rule.times ?? 1)) fired.push(rule.fault);
    }
    if (this.chaos && this.chaos.methods.includes(method)) {
      const choices = CHAOS_FAULTS[method] ?? [];
      // Always draw both numbers so the stream does not depend on outcomes.
      const roll = this.chaos.rng.nextU32() / 2 ** 32;
      const pick = this.chaos.rng.nextU32() % Math.max(choices.length, 1);
      if (choices.length > 0 && roll < this.chaos.rate) fired.push(choices[pick]);
    }
    for (const fault of fired) this.history.push({ seq, method, fn, fault });
    return fired;
  }
}
