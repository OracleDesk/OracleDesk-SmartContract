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
