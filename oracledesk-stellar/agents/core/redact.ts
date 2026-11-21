const SENSITIVE_KEY =
  /(?:secret|private.?key|seed|password|passphrase|token|authorization|credential|api.?key|access.?key|pg.?url|database.?url|connection.?string)/i;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET = /([?&](?:token|secret|key|api[_-]?key|password|signature)=)[^&#\s]+/gi;

export const REDACTED = "[REDACTED]";

export function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET, REDACTED)
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(QUERY_SECRET, `$1${REDACTED}`);
}

export function redact<T>(value: T): T {
  const visited = new WeakMap<object, unknown>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === "string") return redactString(current);
    if (current === null || typeof current !== "object") return current;
    if (Buffer.isBuffer(current)) return REDACTED;
    const cached = visited.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      visited.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    visited.set(current, copy);
    for (const [childKey, child] of Object.entries(current)) {
      copy[childKey] = visit(child, childKey);
    }
    return copy;
  };
  return visit(value) as T;
}
