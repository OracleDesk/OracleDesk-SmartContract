/**
 * Error classifier for the x402 trace repository.
 * Distinguishes contract-level TraceNotFound from RPC/network failures.
 */

export type Classified =
  | { kind: "contract"; code: number }
  | { kind: "upstream"; cause: string }
  | { kind: "invalid-input" }
  | { kind: "unknown" };

const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/;
const UPSTREAM_MESSAGES = [
  "fetch failed", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "ECONNREFUSED", "socket hang up", "AbortError", "network error",
];

function extractMessage(e: unknown): string {
  if (e instanceof Error) return e.message + (e.cause ? ` | cause: ${extractMessage(e.cause)}` : "");
  if (typeof e === "string") return e;
  return String(e);
}

export function classifyRegistryError(e: unknown): Classified {
  const msg = extractMessage(e).toLowerCase();
  const raw = extractMessage(e);

  // Check for contract error code
  const contractMatch = CONTRACT_ERROR_RE.exec(raw) ?? CONTRACT_ERROR_RE.exec(msg);
  if (contractMatch) {
    return { kind: "contract", code: Number(contractMatch[1]) };
  }

  // Check simulation diagnostics for contract error patterns
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    const diagnostic = String(obj["diagnostic"] ?? obj["simulationError"] ?? obj["events"] ?? "");
    const diagMatch = CONTRACT_ERROR_RE.exec(diagnostic);
    if (diagMatch) return { kind: "contract", code: Number(diagMatch[1]) };
  }

  // Check for upstream transport/network errors
  if (UPSTREAM_MESSAGES.some((m) => msg.includes(m.toLowerCase()))) {
    return { kind: "upstream", cause: raw.slice(0, 200) };
  }
  // HTTP 4xx/5xx from RPC
  if (/\b(429|500|502|503|504)\b/.test(raw)) {
    return { kind: "upstream", cause: `HTTP ${raw.match(/\b(429|500|502|503|504)\b/)?.[0]}` };
  }

  return { kind: "unknown" };
}

export class RepositoryUnavailable extends Error {
  constructor(public readonly classified: Classified) {
    super(
      classified.kind === "upstream"
        ? `Registry RPC unavailable: ${classified.cause}`
        : `Registry error: ${JSON.stringify(classified)}`,
    );
    this.name = "RepositoryUnavailable";
  }
}

/**
 * Contract error code for TraceNotFound in reasoning-registry (#306).
 * The registry uses Error::TraceNotFound = 3005, not 5.
 * Old value (5) was wrong and made TraceNotFound indistinguishable from
 * other low-numbered contract errors.
 */
export const TRACE_NOT_FOUND_CODE = 3005;

// ── #328 x402 error taxonomy ──────────────────────────────────────────────

/** Pipeline stage a failure happened in; used as a closed metrics label. */
export type Stage = "prepare" | "verify" | "settle" | "deliver";

export type X402ErrorKind =
  | "invalid_envelope"
  | "payment_expired"
  | "unsupported_requirements"
  | "verify_rejected"
  | "verify_unavailable"
  | "settle_failed"
  | "settle_indeterminate"
  | "registry_unavailable"
  | "registry_restore_required"
  | "trace_not_found"
  | "gateway_unavailable"
  | "trace_hash_mismatch"
  | "trace_invalid_json"
  | "ledger_unavailable"
  | "payment_conflict"
  | "verdict_refused"
  | "internal";

/** Every kind, for bounded metric label sets and the docs table. */
export const X402_ERROR_KINDS: readonly X402ErrorKind[] = [
  "invalid_envelope",
  "payment_expired",
  "unsupported_requirements",
  "verify_rejected",
  "verify_unavailable",
  "settle_failed",
  "settle_indeterminate",
  "registry_unavailable",
  "registry_restore_required",
  "trace_not_found",
  "gateway_unavailable",
  "trace_hash_mismatch",
  "trace_invalid_json",
  "ledger_unavailable",
  "payment_conflict",
  "verdict_refused",
  "internal",
];

/** Stable HTTP status per kind. 402/404/502 match what clients relied on. */
export const X402_ERROR_STATUS: Record<X402ErrorKind, number> = {
  invalid_envelope: 402,
  payment_expired: 402,
  unsupported_requirements: 402,
  verify_rejected: 402,
  verify_unavailable: 503,
  settle_failed: 402,
  settle_indeterminate: 502,
  registry_unavailable: 503,
  registry_restore_required: 503,
  trace_not_found: 404,
  gateway_unavailable: 502,
  trace_hash_mismatch: 502,
  trace_invalid_json: 502,
  ledger_unavailable: 503,
  payment_conflict: 409,
  verdict_refused: 410,
  internal: 502,
};

/** Client-safe messages. Never derived from the cause, which may hold secrets. */
const MESSAGES: Record<X402ErrorKind, string> = {
  invalid_envelope: "Invalid payment envelope",
  payment_expired: "Payment expired",
  unsupported_requirements: "Unsupported payment requirements",
  verify_rejected: "Payment verification rejected",
  verify_unavailable: "Payment facilitator unavailable",
  settle_failed: "Settlement failed",
  settle_indeterminate: "Settlement outcome indeterminate",
  registry_unavailable: "Trace registry unavailable",
  registry_restore_required:
    "Trace registry entry is archived and must be restored",
  trace_not_found: "Trace not found",
  gateway_unavailable: "Trace content gateway unavailable",
  trace_hash_mismatch: "Trace failed on-chain hash verification",
  trace_invalid_json: "Trace content is not valid JSON",
  ledger_unavailable: "Payment ledger unavailable",
  payment_conflict: "Payment conflicts with an existing purchase",
  verdict_refused: "Trace verdict refused",
  internal: "Trace or payment processing failed",
};

export class X402Error extends Error {
  readonly status: number;
  constructor(
    readonly kind: X402ErrorKind,
    status?: number,
    readonly cause?: unknown,
    message?: string,
  ) {
    super(message ?? MESSAGES[kind]);
    this.name = "X402Error";
    this.status = status ?? X402_ERROR_STATUS[kind];
  }

  /** `{ error: kind, message }`: the only error shape clients see. */
  toJSON(): { error: X402ErrorKind; message: string } {
    return { error: this.kind, message: this.message };
  }
}

/** True when an RPC simulation reports that an entry must be restored first. */
export function isRestoreRequired(e: unknown): boolean {
  if (typeof e === "object" && e !== null && "restorePreamble" in e)
    return true;
  const msg = extractMessage(e).toLowerCase();
  return (
    msg.includes("restorepreamble") ||
    msg.includes("restore preamble") ||
    msg.includes("entryarchived") ||
    msg.includes("entry archived") ||
    msg.includes("archived entry") ||
    msg.includes("requires restore")
  );
}

/** Registry failures that mean "unavailable", not "absent" (#328, #329). */
export class RegistryRestoreRequired extends Error {
  constructor(readonly traceId: string) {
    super("Registry entry archived; restore required");
    this.name = "RegistryRestoreRequired";
  }
}

/**
 * Classifies anything thrown on the payment path into a typed error. The
 * `stage` picks the fallback for errors with no specific classification.
 */
export function toX402Error(e: unknown, stage: Stage): X402Error {
  if (e instanceof X402Error) return e;
  if (e instanceof RegistryRestoreRequired)
    return new X402Error("registry_restore_required", undefined, e);
  if (e instanceof RepositoryUnavailable)
    return new X402Error("registry_unavailable", undefined, e);
  const name = (e as { name?: unknown } | undefined)?.name;
  if (name === "FacilitatorTimeoutError")
    return new X402Error(
      stage === "settle" ? "settle_indeterminate" : "verify_unavailable",
      undefined,
      e,
    );
  if (name === "SqliteError")
    return new X402Error("ledger_unavailable", undefined, e);
  if (stage === "verify")
    return classifyRegistryError(e).kind === "upstream"
      ? new X402Error("verify_unavailable", undefined, e)
      : new X402Error("internal", undefined, e);
  if (stage === "settle")
    return new X402Error("settle_indeterminate", undefined, e);
  return new X402Error("internal", undefined, e);
}