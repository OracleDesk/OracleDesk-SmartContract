import type { MonitorEvent } from './types.ts';

export interface RawRpcEvent {
  id: string;
  pagingToken?: string;
  ledger: number;
  ledgerClosedAt?: string;
  contractId: string;
  topic: unknown[];
  value: unknown;
  txHash?: string;
}

function parseTimestampSeconds(iso?: string): number {
  if (!iso) return Math.floor(Date.now() / 1000);
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function asBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(Math.trunc(val));
  if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) return BigInt(val.trim());
  if (val && typeof val === 'object' && 'amount' in val) {
    return asBigInt((val as { amount: unknown }).amount);
  }
  return 0n;
}

/**
 * Decode a raw Soroban RPC event (contract event or SEP-41 SAC transfer).
 * Defends against both classic SEP-41 `["transfer", from, to, sep0011_asset]`
 * and protocol-23 muxed `to` value maps (`{ to_muxed_id, amount }`).
 */
export function decodeRpcEvent(raw: RawRpcEvent): MonitorEvent | null {
  const topics = Array.isArray(raw.topic) ? raw.topic.map((t) => String(t)) : [];
  const eventName = topics[0]?.toLowerCase() ?? '';

  // 1. SEP-41 SAC transfer: topics = ["transfer", from, to, asset?]
  if (eventName === 'transfer' && topics.length >= 3) {
    return {
      kind: 'sac_transfer',
      ledger: raw.ledger,
      from: topics[1],
      to: topics[2],
      amount: asBigInt(raw.value),
      txHash: raw.txHash,
    };
  }

  // 2. MarketResolved{#market_id, outcome: Option<Outcome>}
  if (eventName === 'market_resolved' || eventName === 'marketresolved') {
    const marketId = Number(topics[1] ?? (raw.value as { market_id?: number })?.market_id ?? 0);
    const valObj = raw.value as { outcome?: string | null } | string | null;
    const rawOutcome =
      typeof valObj === 'object' && valObj !== null && 'outcome' in valObj
        ? valObj.outcome
        : valObj;
    const outcome =
      rawOutcome === 'Yes' || rawOutcome === 'No' ? rawOutcome : null;

    return {
      kind: 'market_resolved',
      ledger: raw.ledger,
      timestamp: parseTimestampSeconds(raw.ledgerClosedAt),
      marketId,
      outcome,
    };
  }

  // 3. Redeemed{#market_id, #holder, payout}
  if (eventName === 'redeemed') {
    const marketId = Number(topics[1] ?? 0);
    const holder = String(topics[2] ?? '');
    const payout =
      raw.value && typeof raw.value === 'object' && 'payout' in raw.value
        ? asBigInt((raw.value as { payout: unknown }).payout)
        : asBigInt(raw.value);

    return {
      kind: 'redeemed',
      ledger: raw.ledger,
      marketId,
      holder,
      payout,
    };
  }

  // 4. TradeAuthorized{#market_id, #agent, amount, market_total, daily_total}
  if (eventName === 'trade_authorized' || eventName === 'tradeauthorized') {
    const marketId = Number(topics[1] ?? 0);
    const agent = String(topics[2] ?? '');
    const v = (raw.value ?? {}) as Record<string, unknown>;
    return {
      kind: 'trade_authorized',
      ledger: raw.ledger,
      marketId,
      agent,
      amount: asBigInt(v.amount),
      marketTotal: asBigInt(v.market_total ?? v.marketTotal),
      dailyTotal: asBigInt(v.daily_total ?? v.dailyTotal),
    };
  }

  // 5. AgentRegistered{#agent}
  if (eventName === 'agent_registered' || eventName === 'agentregistered') {
    const agent = String(topics[1] ?? (raw.value as { agent?: string })?.agent ?? '');
    return {
      kind: 'agent_registered',
      ledger: raw.ledger,
      agent,
    };
  }

  return null;
}

export interface TailerFetchResult {
  events: MonitorEvent[];
  nextCursor: string | null;
  latestLedger: number | null;
}

/**
 * Poll Soroban RPC `getEvents` for all five monitored contract IDs (including
 * the collateral SAC) from either the persisted `cursor` or `startLedger`.
 */
export async function pollContractEvents(
  rpcUrl: string,
  contractIds: readonly string[],
  cursorOrLedger: { cursor?: string | null; startLedger?: number },
  fetchImpl: typeof fetch = fetch
): Promise<TailerFetchResult> {
  const pagination = cursorOrLedger.cursor
    ? { cursor: cursorOrLedger.cursor, limit: 200 }
    : { limit: 200 };

  const params: Record<string, unknown> = {
    filters: [{ type: 'contract', contractIds: Array.from(contractIds) }],
    pagination,
  };
  if (!cursorOrLedger.cursor && cursorOrLedger.startLedger) {
    params.startLedger = cursorOrLedger.startLedger;
  }

  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getEvents',
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC getEvents failed with HTTP ${res.status}`);
  }

  const body = (await res.json()) as {
    result?: { events?: RawRpcEvent[]; latestLedger?: number };
  };
  const rawEvents = body.result?.events ?? [];
  const decoded: MonitorEvent[] = [];
  let nextCursor: string | null = cursorOrLedger.cursor ?? null;

  for (const raw of rawEvents) {
    const evt = decodeRpcEvent(raw);
    if (evt) decoded.push(evt);
    if (raw.pagingToken || raw.id) {
      nextCursor = raw.pagingToken ?? raw.id;
    }
  }

  return {
    events: decoded,
    nextCursor,
    latestLedger: body.result?.latestLedger ?? null,
  };
}
