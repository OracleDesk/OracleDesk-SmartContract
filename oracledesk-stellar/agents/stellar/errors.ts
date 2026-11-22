export type SorobanErrorKind = "contract" | "auth" | "fee" | "transient" | "unknown";

export interface SorobanErrorClassification {
  kind: SorobanErrorKind;
  terminal: boolean;
  message: string;
}

function collectText(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const entries: unknown[] = [];
  if (Array.isArray(value)) entries.push(...value);
  else {
    const object = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(object)) {
      entries.push(key, child);
    }
    // Stellar SDK XDR objects expose discriminant values through switch().
    const switchMethod = (value as { switch?: () => unknown }).switch;
    if (typeof switchMethod === "function") {
      try {
        entries.push(switchMethod.call(value));
      } catch {
        // Some XDR union values are not initialized; their fields still help.
      }
    }
  }
  return entries.flatMap((entry) => collectText(entry, seen));
}

/**
 * Classify explicit Soroban contract/auth failures as terminal. Generic RPC
 * and transport failures remain unknown, because they may have reached a node.
 */
export function classifySorobanError(value: unknown): SorobanErrorClassification {
  const message = collectText(value).join(" ").replace(/\s+/g, " ").trim() || String(value);
  const normalized = message.toLowerCase();

  if (
    /\b(tx_bad_auth|txbadauth|bad_auth|badauth)\b/.test(normalized) ||
    (/\b(auth|authorization|signature)\b/.test(normalized) &&
      /\b(error|failed|invalid|missing|bad|denied|unauthorized)\b/.test(normalized)) ||
    /\bauth[_ -](error|failed|invalid|missing|denied)\b/.test(normalized)
  ) {
    return { kind: "auth", terminal: true, message };
  }
  if (
    /\b(tx_insufficient_fee|txinsufficient_fee|txfeebumpinnerfailed|tx_fee_bump_inner_failed|resourcelimitexceeded|resource_limit_exceeded)\b/.test(
      normalized,
    ) ||
    /\bresource limit exceeded\b/.test(normalized)
  ) {
    return { kind: "fee", terminal: false, message };
  }
  if (
    /\b(contract error|contract_error|contracterror|contract trap|hosterror|scerror|contract invocation failed|invokehostfunctionfailed)\b/.test(
      normalized,
    )
  ) {
    return { kind: "contract", terminal: true, message };
  }
  if (/\b(try_again_later|timeout|timed out|temporar|rate limit|unavailable|network|connection reset)\b/.test(normalized)) {
    return { kind: "transient", terminal: false, message };
  }
  return { kind: "unknown", terminal: false, message };
}

export class SorobanSubmissionError extends Error {
  readonly classification: SorobanErrorClassification;
  readonly transactionHash?: string;

  constructor(
    message: string,
    classification: SorobanErrorClassification,
    options: { cause?: unknown; transactionHash?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SorobanSubmissionError";
    this.classification = classification;
    this.transactionHash = options.transactionHash;
  }
}

export class SorobanTerminalError extends SorobanSubmissionError {
  constructor(message: string, options: { cause?: unknown; transactionHash?: string } = {}) {
    super(message, { ...classifySorobanError(message), terminal: true }, options);
    this.name = "SorobanTerminalError";
  }
}

/** The signed envelope may still land; callers must not create a replacement. */
export class SorobanPendingError extends SorobanSubmissionError {
  constructor(message: string, transactionHash: string, options: { cause?: unknown } = {}) {
    super(message, { kind: "unknown", terminal: false, message }, {
      ...options,
      transactionHash,
    });
    this.name = "SorobanPendingError";
  }
}
