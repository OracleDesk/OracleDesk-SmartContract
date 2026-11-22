import { createHash, createHmac } from "node:crypto";
import {
  Address,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { SignerPolicy, AuditEvent, AuditLog } from "./types.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HASH = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Argument predicate types (issue #310)
// ---------------------------------------------------------------------------

export type ScValType =
  | "i64" | "u64" | "i128" | "u128"
  | "bool" | "symbol" | "string" | "bytes"
  | "address" | "vec" | "map" | "void";

export interface ArgPredicateRange {
  kind: "range";
  /** Inclusive lower bound (bigint for i/u128, number otherwise). */
  min?: bigint | number;
  /** Inclusive upper bound. */
  max?: bigint | number;
}

export interface ArgPredicateOneOf {
  kind: "one_of";
  values: Array<string | number | bigint | boolean>;
}

export interface ArgPredicateRegex {
  kind: "regex";
  pattern: string;
}

export interface ArgPredicateNotNull {
  kind: "not_null";
}

export type ArgPredicate =
  | ArgPredicateRange
  | ArgPredicateOneOf
  | ArgPredicateRegex
  | ArgPredicateNotNull;

export interface ArgSpec {
  /** 0-based position in the invocation args list. */
  index: number;
  predicate: ArgPredicate;
}

// ---------------------------------------------------------------------------
// Extended invocation policy with optional semantic predicates + limits
// ---------------------------------------------------------------------------

export interface InvocationPolicyV2 {
  contractId: string;
  functionName: string;
  /**
   * Exact SHA-256 args-hash match. Mutually exclusive with argPredicates.
   * Leave undefined to allow any args (use argPredicates for finer control).
   */
  argsHash?: string;
  /**
   * Per-argument semantic checks applied after hash matching is skipped.
   * All listed predicates must pass.
   */
  argPredicates?: ArgSpec[];
  /** Allow Soroban auth entries containing sub-invocations of this same call. */
  allowAuthEntries?: boolean;
  /** Allow this invocation to appear as the inner tx of a fee-bump. */
  allowFeeBump?: boolean;
  /** Hard expiry: policy entry is invalid after this ISO-8601 date-time. */
  expiresAt?: string;
  /** Maximum number of approvals before this entry is exhausted. */
  maxUses?: number;
}

// ---------------------------------------------------------------------------
// Stateful usage counter (issue #310 — bounded, in-process)
// ---------------------------------------------------------------------------

export class InvocationLimiter {
  private readonly counters = new Map<string, number>();

  /** Returns the remaining budget (Infinity when no limit set). */
  check(entry: InvocationPolicyV2): number {
    if (entry.maxUses === undefined) return Infinity;
    const key = `${entry.contractId}:${entry.functionName}`;
    return entry.maxUses - (this.counters.get(key) ?? 0);
  }

  consume(entry: InvocationPolicyV2): void {
    if (entry.maxUses === undefined) return;
    const key = `${entry.contractId}:${entry.functionName}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  reset(contractId: string, functionName: string): void {
    this.counters.delete(`${contractId}:${functionName}`);
  }
}

// ---------------------------------------------------------------------------
// Hash-chained audit log (issue #310)
// ---------------------------------------------------------------------------

export class HashChainedAuditLog implements AuditLog {
  private readonly _entries: AuditEvent[] = [];
  private chainHead = "0".repeat(64);

  append(event: AuditEvent): void {
    const payload = JSON.stringify({ ...event, prev: this.chainHead });
    this.chainHead = createHash("sha256").update(payload).digest("hex");
    this._entries.push({ ...event, _chain: this.chainHead } as AuditEvent & { _chain: string });
  }

  entries(): readonly AuditEvent[] {
    return this._entries;
  }

  /**
   * Returns the current chain head. A verifier can replay `entries()` with
   * the same hash function to confirm integrity.
   */
  head(): string {
    return this.chainHead;
  }

  /**
   * HMAC-signs the current chain head with a secret, returning a compact
   * proof string that can be persisted alongside the log snapshot.
   */
  sign(secret: string): string {
    return createHmac("sha256", secret).update(this.chainHead).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Arg extraction helpers
// ---------------------------------------------------------------------------

function scValToComparable(val: xdr.ScVal): bigint | number | string | boolean | null {
  switch (val.switch().name) {
    case "scvI64":  return BigInt(val.i64().toString());
    case "scvU64":  return BigInt(val.u64().toString());
    case "scvI128": {
      const p = val.i128();
      return (BigInt(p.hi().toString()) << 64n) | BigInt(p.lo().toString());
    }
    case "scvU128": {
      const p = val.u128();
      return (BigInt(p.hi().toString()) << 64n) | BigInt(p.lo().toString());
    }
    case "scvBool":   return val.b();
    case "scvSymbol": return val.sym().toString();
    case "scvString": return val.str().toString();
    case "scvBytes":  return val.bytes().toString("hex");
    case "scvAddress": return Address.fromScVal(val).toString();
    case "scvVoid":   return null;
    default:          return null;
  }
}

function evaluatePredicate(val: xdr.ScVal, pred: ArgPredicate): boolean {
  const v = scValToComparable(val);
  switch (pred.kind) {
    case "not_null":
      return v !== null;
    case "one_of":
      return pred.values.some((x) => x === v);
    case "regex":
      return typeof v === "string" && new RegExp(pred.pattern).test(v);
    case "range": {
      if (v === null) return false;
      const n = typeof v === "bigint" ? v : BigInt(String(v));
      const lo = pred.min !== undefined ? BigInt(String(pred.min)) : null;
      const hi = pred.max !== undefined ? BigInt(String(pred.max)) : null;
      return (lo === null || n >= lo) && (hi === null || n <= hi);
    }
  }
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

export function hashInvocationArgs(args: readonly xdr.ScVal[]): string {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(args.length);
  const serialized = args.map((arg) => arg.toXDR());
  return createHash("sha256").update(length).update(Buffer.concat(serialized)).digest("hex");
}

export interface ValidatedInvocation {
  transaction: Transaction;
  transactionHash: string;
  contractId: string;
  functionName: string;
  argsHash: string;
  /** Present when the envelope was a fee-bump. */
  feeBumpSource?: string;
}

function parseEnvelope(transactionXdr: string, networkPassphrase: string, policy: SignerPolicy) {
  if (networkPassphrase !== policy.networkPassphrase) {
    throw new Error("network passphrase does not match signer policy");
  }
  try {
    return TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch {
    throw new Error("transaction XDR is invalid or unsupported");
  }
}

// ---------------------------------------------------------------------------
// Auth-entry sub-invocation validation (issue #310)
// ---------------------------------------------------------------------------

function validateAuthEntries(
  tx: Transaction,
  policy: SignerPolicy,
  matchedEntry: InvocationPolicyV2,
): void {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") return;
  const auths: xdr.SorobanAuthorizationEntry[] = op.auth ?? [];
  if (auths.length === 0) return;

  if (!matchedEntry.allowAuthEntries) {
    throw new Error("Soroban authorization entries are present but not permitted by this policy entry");
  }

  for (const auth of auths) {
    const root = auth.rootInvocation();
    const subInvocations = root.subInvocations();
    // Validate that every sub-invocation is for the same contract+function
    // (simple guard — a full recursive walk would be needed for deeply nested trees)
    for (const sub of subInvocations) {
      const subFn = sub.function();
      if (subFn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
        throw new Error("auth entry sub-invocation contains a non-contract function call");
      }
      const cf = subFn.contractFn();
      const subContractId = Address.fromScVal(xdr.ScVal.scvAddress(cf.contractAddress())).toString();
      const subFunctionName = cf.functionName().toString();
      const isAllowed = (policy.allowedInvocations as InvocationPolicyV2[]).some(
        (e) => e.contractId === subContractId && e.functionName === subFunctionName,
      );
      if (!isAllowed) {
        throw new Error(
          `auth sub-invocation ${subContractId}:${subFunctionName} is not in allowed invocations`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inner transaction validator (shared by classic + fee-bump paths)
// ---------------------------------------------------------------------------

function validateInvocationInner(
  tx: Transaction,
  policy: SignerPolicy,
  limiter?: InvocationLimiter,
): ValidatedInvocation {
  if (!policy.allowedSourceAddresses.includes(tx.source)) {
    throw new Error("transaction source is not allowed by signer policy");
  }
  if (tx.operations.length !== 1) {
    throw new Error("only single-operation transactions are supported");
  }

  const operation = tx.operations[0];
  if (operation.type !== "invokeHostFunction") {
    throw new Error("only Soroban contract invocation transactions are supported");
  }
  if (operation.source && operation.source !== tx.source) {
    throw new Error("operation-level source overrides are unsupported");
  }

  const hostFunction = operation.func;
  if (hostFunction.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw new Error("contract creation, WASM upload, and other host functions are unsupported");
  }

  const invoke = hostFunction.invokeContract();
  const contractId = Address.fromScVal(xdr.ScVal.scvAddress(invoke.contractAddress())).toString();
  const rawFunctionName = invoke.functionName();
  const functionName = Buffer.isBuffer(rawFunctionName)
    ? rawFunctionName.toString("utf8")
    : rawFunctionName;
  if (
    typeof functionName !== "string" ||
    !IDENTIFIER.test(functionName) ||
    (Buffer.isBuffer(rawFunctionName) && !Buffer.from(functionName, "utf8").equals(rawFunctionName))
  ) {
    throw new Error("contract function name has an unsupported shape");
  }

  const args = invoke.args();
  const argsHash = hashInvocationArgs(args);
  const now = new Date();

  const matchedEntry = (policy.allowedInvocations as InvocationPolicyV2[]).find((entry) => {
    if (entry.contractId !== contractId || entry.functionName !== functionName) return false;

    // Expiry check
    if (entry.expiresAt && new Date(entry.expiresAt) < now) return false;

    // Args hash exact match
    if (entry.argsHash !== undefined) {
      return HASH.test(entry.argsHash) && entry.argsHash === argsHash;
    }

    // Semantic predicate checks
    if (entry.argPredicates && entry.argPredicates.length > 0) {
      return entry.argPredicates.every((spec) => {
        const val = args[spec.index];
        if (!val) return false;
        return evaluatePredicate(val, spec.predicate);
      });
    }

    // No args restriction: allow any args
    return true;
  });

  if (!matchedEntry) {
    throw new Error("contract invocation is not explicitly allowed by signer policy");
  }

  // Stateful limit check
  if (limiter) {
    const remaining = limiter.check(matchedEntry);
    if (remaining <= 0) {
      throw new Error(
        `invocation budget exhausted for ${contractId}:${functionName}`,
      );
    }
  }

  // Auth entries
  validateAuthEntries(tx, policy, matchedEntry);

  // Consume the budget slot after all checks pass
  if (limiter) {
    limiter.consume(matchedEntry);
  }

  return {
    transaction: tx,
    transactionHash: tx.hash().toString("hex"),
    contractId,
    functionName,
    argsHash,
  };
}

// ---------------------------------------------------------------------------
// Public API (issue #310)
// ---------------------------------------------------------------------------

export function validateTransaction(
  transactionXdr: string,
  networkPassphrase: string,
  policy: SignerPolicy,
  limiter?: InvocationLimiter,
): ValidatedInvocation {
  const parsed = parseEnvelope(transactionXdr, networkPassphrase, policy);
  if (!(parsed instanceof Transaction)) {
    throw new Error("fee-bump and non-classic transaction envelopes are unsupported");
  }
  return validateInvocationInner(parsed, policy, limiter);
}

export function validateFeeBumpTransaction(
  transactionXdr: string,
  networkPassphrase: string,
  policy: SignerPolicy,
  expectedFeePayer: string,
  limiter?: InvocationLimiter,
): ValidatedInvocation {
  const parsed = parseEnvelope(transactionXdr, networkPassphrase, policy);
  if (!(parsed instanceof FeeBumpTransaction)) {
    throw new Error("expected a fee-bump transaction envelope");
  }
  if (parsed.feeSource !== expectedFeePayer) {
    throw new Error("fee bump fee source is not the configured fee payer");
  }

  const inner = parsed.innerTransaction;

  // Check that the matched policy entry permits fee-bump wrapping
  const innerOp = inner.operations[0];
  if (innerOp?.type === "invokeHostFunction") {
    const invoke = innerOp.func.invokeContract();
    const contractId = Address.fromScVal(xdr.ScVal.scvAddress(invoke.contractAddress())).toString();
    const rawFn = invoke.functionName();
    const functionName = Buffer.isBuffer(rawFn) ? rawFn.toString("utf8") : rawFn;
    const entry = (policy.allowedInvocations as InvocationPolicyV2[]).find(
      (e) => e.contractId === contractId && e.functionName === functionName,
    );
    if (entry && !entry.allowFeeBump) {
      throw new Error("fee-bump wrapping is not permitted for this invocation policy entry");
    }
  }

  const result = validateInvocationInner(inner, policy, limiter);
  return { ...result, feeBumpSource: parsed.feeSource };
}

export function assertSigningRequest(
  request: { networkPassphrase?: string; address?: string; submit?: boolean; submitUrl?: string },
  signerAddress: string,
  policy: SignerPolicy,
): void {
  if (request.networkPassphrase && request.networkPassphrase !== policy.networkPassphrase) {
    throw new Error("requested network passphrase does not match signer policy");
  }
  if (request.address && request.address !== signerAddress) {
    throw new Error("requested signer address does not match signer identity");
  }
  if (request.submit === true || request.submitUrl !== undefined) {
    throw new Error("signer callbacks must not submit transactions");
  }
}
