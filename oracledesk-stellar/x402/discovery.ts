import { createHmac, timingSafeEqual } from "node:crypto";

export interface TraceIndexRow {
  traceId: bigint;
  marketId: bigint;
  agent: string;
  action: string;
  traceHash: string;
  publishedAt: number;
  syncedAt: number;
}

export type VerificationStatus = "verified" | "mismatch" | "unreachable" | "pending" | "archived";

export interface VerificationRow {
  traceId: bigint;
  status: VerificationStatus;
  checkedHash?: string;
  checkedAt?: number;
  attempts: number;
  error?: string;
}

export interface DiscoveryStore {
  upsertTraces(rows: TraceIndexRow[]): Promise<void>;
  highWater(): Promise<bigint>;
  byMarket(marketId: bigint, cursor: bigint | null, limit: number, order: "asc" | "desc"): Promise<TraceIndexRow[]>;
  byAgent(agent: string, cursor: bigint | null, limit: number): Promise<TraceIndexRow[]>;
  getVerification(id: bigint): Promise<VerificationRow | undefined>;
  putVerification(v: VerificationRow): Promise<void>;
}

export class MemoryDiscoveryStore implements DiscoveryStore {
  private traces = new Map<bigint, TraceIndexRow>();
  private verifications = new Map<bigint, VerificationRow>();
  private highWaterMark = 0n;

  async upsertTraces(rows: TraceIndexRow[]): Promise<void> {
    for (const row of rows) {
      this.traces.set(row.traceId, row);
      if (row.traceId > this.highWaterMark) {
        this.highWaterMark = row.traceId;
      }
    }
  }

  async highWater(): Promise<bigint> {
    return this.highWaterMark;
  }

  async byMarket(marketId: bigint, cursor: bigint | null, limit: number, order: "asc" | "desc"): Promise<TraceIndexRow[]> {
    let rows = Array.from(this.traces.values()).filter((r) => r.marketId === marketId);
    if (cursor !== null) {
      rows = rows.filter((r) => order === "asc" ? r.traceId > cursor : r.traceId < cursor);
    }
    rows.sort((a, b) => order === "asc" ? Number(a.traceId - b.traceId) : Number(b.traceId - a.traceId));
    return rows.slice(0, limit);
  }

  async byAgent(agent: string, cursor: bigint | null, limit: number): Promise<TraceIndexRow[]> {
    let rows = Array.from(this.traces.values()).filter((r) => r.agent === agent);
    if (cursor !== null) rows = rows.filter((r) => r.traceId > cursor);
    rows.sort((a, b) => Number(b.traceId - a.traceId));
    return rows.slice(0, limit);
  }

  async getVerification(id: bigint): Promise<VerificationRow | undefined> {
    return this.verifications.get(id);
  }

  async putVerification(v: VerificationRow): Promise<void> {
    this.verifications.set(v.traceId, v);
  }
}

export interface CursorData {
  v?: 1;
  kid?: string;
  q?: string;
  next?: string;
  anchorTotal?: string;
  exp?: number;
  index?: bigint;
  marketId?: string;
  order: "asc" | "desc";
}

export interface CursorKeys {
  current: { kid: string; secret: string };
  verify?: Record<string, string>;
}

export interface CursorV1 {
  v: 1;
  kid: string;
  q: string;
  order: "asc" | "desc";
  next: string;
  anchorTotal: string;
  exp: number;
}

function keySet(keys: CursorKeys | string): CursorKeys {
  if (typeof keys === "string")
    return { current: { kid: "legacy", secret: keys } };
  return keys;
}

export function parseCursorKeys(value = process.env.X402_CURSOR_KEYS): CursorKeys | undefined {
  if (!value) return undefined;
  const parsed = value.split(",").map((part) => {
    const [kid, encoded] = part.split(":", 2);
    if (!kid || !encoded) throw new Error("X402_CURSOR_KEYS entries must be kid:base64");
    return { kid, secret: Buffer.from(encoded, "base64").toString("utf8") };
  });
  if (!parsed.length) return undefined;
  return {
    current: parsed[0],
    verify: Object.fromEntries(parsed.map((key) => [key.kid, key.secret])),
  };
}

export function encodeCursor(
  data: Omit<CursorV1, "v" | "kid"> | CursorData,
  keys: CursorKeys | string,
): string {
  const k = keySet(keys).current;
  const value = "next" in data
    ? { v: 1, kid: k.kid, ...data }
    : { v: 1, kid: k.kid, q: "", next: String(data.index ?? 0n), anchorTotal: "0", exp: Math.floor(Date.now() / 1000) + 86400, order: data.order };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = createHmac("sha256", k.secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function decodeCursor(
  cursor: string,
  keys: CursorKeys | string,
  query = "",
  now = Math.floor(Date.now() / 1000),
): CursorV1 | null {
  try {
    const separator = cursor.lastIndexOf(".");
    if (separator <= 0) return null;
    const payload = cursor.slice(0, separator);
    const supplied = Buffer.from(cursor.slice(separator + 1), "base64url");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as CursorV1;
    if (parsed.v !== 1 || typeof parsed.kid !== "string") return null;
    const all = keySet(keys);
    const secret = all.verify?.[parsed.kid] ?? (all.current.kid === parsed.kid ? all.current.secret : undefined);
    if (!secret) return null;
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    if (parsed.exp <= now || (query && parsed.q !== query)) return null;
    if (!/^\d+$/.test(parsed.next) || !/^\d+$/.test(parsed.anchorTotal)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function shouldReverify(verification: VerificationRow | undefined, maxAgeSecs: number): boolean {
  if (!verification || verification.status === "pending") return true;
  if (!verification.checkedAt) return true;
  const age = (Date.now() - verification.checkedAt) / 1000;
  return age > maxAgeSecs;
}

export function updateVerificationFromFetch(
  current: VerificationRow | undefined,
  traceId: bigint,
  fetchedHash: string | null,
  onChainHash: string,
  error?: string,
): VerificationRow {
  const attempts = (current?.attempts ?? 0) + 1;

  if (error) {
    if (error === "ARCHIVED") {
      return { traceId, status: "archived", attempts, error: "Trace was archived from Soroban state" };
    }
    return { traceId, status: "unreachable", attempts, error, checkedAt: Date.now(), checkedHash: current?.checkedHash };
  }

  if (!fetchedHash) {
    return { traceId, status: "pending", attempts };
  }

  const normalized = (h: string) => h.toLowerCase().replace(/^0x/, "");
  if (normalized(fetchedHash) === normalized(onChainHash)) {
    return { traceId, status: "verified", checkedHash: fetchedHash, checkedAt: Date.now(), attempts };
  }

  return {
    traceId,
    status: "mismatch",
    checkedHash: fetchedHash,
    checkedAt: Date.now(),
    attempts,
    error: `Hash mismatch: fetched ${fetchedHash}, expected ${onChainHash}`,
  };
}
