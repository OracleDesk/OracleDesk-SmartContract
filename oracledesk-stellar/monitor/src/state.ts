import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertNotification } from './types.ts';

export interface PersistedMarketCacheEntry {
  marketId: number;
  status: 'Open' | 'Resolved' | 'Void';
  outcome: 'Yes' | 'No' | null;
  redeemedPayoutTotal: string;
  reservesAtResolution?: { yes: string; no: string };
  claimedPoolPayout?: string;
  lpClaimed: boolean;
}

export interface PersistedMonitorState {
  cursor: string | null;
  lastLedger: number | null;
  markets: Record<string, PersistedMarketCacheEntry>;
}

const DEFAULT_STATE: PersistedMonitorState = {
  cursor: null,
  lastLedger: null,
  markets: {},
};

export function loadMonitorState(filePath: string): PersistedMonitorState {
  if (!existsSync(filePath)) {
    return { ...DEFAULT_STATE, markets: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedMonitorState>;
    return {
      cursor: typeof raw.cursor === 'string' ? raw.cursor : null,
      lastLedger: typeof raw.lastLedger === 'number' ? raw.lastLedger : null,
      markets: raw.markets && typeof raw.markets === 'object' ? raw.markets : {},
    };
  } catch {
    return { ...DEFAULT_STATE, markets: {} };
  }
}

export function saveMonitorState(filePath: string, state: PersistedMonitorState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Detect an RPC event-retention gap when the persisted `lastLedger` is older
 * than the RPC server's `oldestLedger`, returning a `monitor_gap` alert notification.
 */
export function detectCursorRetentionGap(
  persistedLastLedger: number | null,
  rpcOldestLedger: number,
  nowIso = new Date().toISOString()
): { gapDetected: boolean; resumeLedger: number; alert: AlertNotification | null } {
  if (persistedLastLedger === null || persistedLastLedger >= rpcOldestLedger) {
    return {
      gapDetected: false,
      resumeLedger: persistedLastLedger ?? rpcOldestLedger,
      alert: null,
    };
  }

  const missedLedgers = rpcOldestLedger - persistedLastLedger;
  return {
    gapDetected: true,
    resumeLedger: rpcOldestLedger,
    alert: {
      action: 'trigger',
      dedupKey: `monitor_gap:${persistedLastLedger}:${rpcOldestLedger}`,
      ruleId: 'monitor-retention-gap',
      severity: 'warning',
      title: 'Monitor cursor older than Soroban RPC event retention window',
      message: `Persisted lastLedger ${persistedLastLedger} is older than RPC oldestLedger ${rpcOldestLedger} (${missedLedgers} ledgers missed); resuming from ${rpcOldestLedger}.`,
      timestamp: nowIso,
      details: {
        persistedLastLedger,
        rpcOldestLedger,
        missedLedgers,
      },
    },
  };
}
