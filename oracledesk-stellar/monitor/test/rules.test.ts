import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleEngine } from '../src/engine.ts';
import { parseRulesYaml } from '../src/index.ts';
import { reconcilePolledMarket, selectMarketsToPoll } from '../src/poller.ts';
import { evaluateAllRules } from '../src/rules.ts';
import { renderPrometheusMetrics } from '../src/server.ts';
import { PagerDutySink, SlackSink, WebhookSink } from '../src/sinks.ts';
import { evaluateSolvency } from '../src/solvency.ts';
import { detectCursorRetentionGap } from '../src/state.ts';
import { decodeRpcEvent } from '../src/tailer.ts';
import type { MonitorSnapshot, RuleConfig } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES: RuleConfig[] = parseRulesYaml(
  readFileSync(resolve(__dirname, '../rules.yaml'), 'utf8')
);

function baseSnapshot(): MonitorSnapshot {
  return {
    nowUnixSeconds: 1_760_000_000,
    currentLedger: 1_000_000,
    expected: {
      deployer: 'GDEPLOYER',
      agent: 'GAGENT_PRIMARY',
      contracts: {
        usdc: 'CUSDC',
        market_core: 'CMARKET_CORE',
        resolver: 'CRESOLVER',
        treasury: 'CTREASURY',
        reasoning_registry: 'CREGISTRY',
      },
      defaultFeeBps: 100,
      treasuryRiskConfig: {
        maxTrade: 2_000_000_000n,
        maxMarket: 5_000_000_000n,
        maxDaily: 10_000_000_000n,
      },
    },
    marketCoreConfig: {
      admin: 'GDEPLOYER',
      collateral: 'CUSDC',
      treasury: 'CTREASURY',
      resolver: 'CRESOLVER',
      defaultFeeBps: 100,
      paused: false,
    },
    treasuryConfig: {
      marketCore: 'CMARKET_CORE',
      collateral: 'CUSDC',
      maxTrade: 2_000_000_000n,
      maxMarket: 5_000_000_000n,
      maxDaily: 10_000_000_000n,
      paused: false,
    },
    treasuryDailyUsage: 1_000_000_000n,
    marketCoreCollateralBalance: 1_500_000_000n,
    agentRegistered: true,
    markets: [
      {
        marketId: 1,
        closeTime: 1_760_003_600,
        status: 'Open',
        outcome: null,
        reserveYes: 750_000_000n,
        reserveNo: 750_000_000n,
        setsMinted: 1_500_000_000n,
        feesAccrued: 0n,
        lpClaimed: false,
        redeemedPayoutTotal: 0n,
      },
    ],
    ledgerEntries: [
      {
        contractName: 'market_core',
        contractId: 'CMARKET_CORE',
        liveUntilLedgerSeq: 1_200_000,
      },
    ],
    events: [],
  };
}

describe('OracleDesk on-chain monitor rules (#131)', () => {
  test('rules.yaml declares all 9 initial rules', () => {
    assert.equal(RULES.length, 9);
    const healthy = evaluateAllRules(baseSnapshot(), RULES);
    assert.deepEqual(healthy, []);
  });

  test('config_resolver_change_fires_critical', () => {
    const snap = baseSnapshot();
    snap.marketCoreConfig.resolver = 'CATTACKER_RESOLVER';
    const findings = evaluateAllRules(snap, RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleType, 'market_core_config_changed');
    assert.equal(findings[0].severity, 'critical');
    assert.match(findings[0].title, /resolver address changed/i);
  });

  test('void_before_close_fires_high', () => {
    const snap = baseSnapshot();
    snap.events.push({
      kind: 'market_resolved',
      ledger: 1_000_001,
      timestamp: 1_760_000_100, // before market #1 closeTime (1_760_003_600)
      marketId: 1,
      outcome: null,
    });
    const findings = evaluateAllRules(snap, RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleType, 'market_voided');
    assert.equal(findings[0].severity, 'high');
    assert.match(findings[0].title, /BEFORE close_time/);
  });

  test('treasury_transfer_to_non_market_core_fires', () => {
    const snap = baseSnapshot();
    snap.events.push({
      kind: 'sac_transfer',
      ledger: 1_000_002,
      from: 'CTREASURY',
      to: 'GEXTERNAL_RECIPIENT',
      amount: 2_500_000_000n, // >= 100 USDC critical threshold
    });
    const findings = evaluateAllRules(snap, RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleType, 'treasury_unexpected_transfer');
    assert.equal(findings[0].severity, 'critical');
  });

  test('deposit_does_not_fire', () => {
    const snap = baseSnapshot();
    // Incoming deposit to treasury + legitimate trade transfer from treasury to market-core
    snap.events.push(
      {
        kind: 'sac_transfer',
        ledger: 1_000_003,
        from: 'GDEPOSITOR',
        to: 'CTREASURY',
        amount: 5_000_000_000n,
      },
      {
        kind: 'sac_transfer',
        ledger: 1_000_004,
        from: 'CTREASURY',
        to: 'CMARKET_CORE',
        amount: 1_000_000_000n,
      }
    );
    const findings = evaluateAllRules(snap, RULES);
    assert.deepEqual(findings, []);
  });

  test('stuck_market_respects_dispute_window', () => {
    const snap = baseSnapshot();
    // Market closed 2 hours ago, but has a 3-hour (10_800s) dispute window -> NOT stuck!
    snap.markets[0].closeTime = snap.nowUnixSeconds - 7_200;
    snap.markets[0].disputeWindowSeconds = 10_800;
    assert.deepEqual(evaluateAllRules(snap, RULES), []);

    // Once nowUnixSeconds exceeds closeTime + disputeWindow + grace (7200s), it fires.
    snap.nowUnixSeconds = snap.markets[0].closeTime + 10_800 + 7_201;
    const findings = evaluateAllRules(snap, RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleType, 'market_stuck_unresolved');
    assert.equal(findings[0].severity, 'warning');
  });

  test('solvency_detects_deficit', () => {
    const snap = baseSnapshot();
    // Market #1 requires 1_500_000_000n; drop balance to 1_499_999_000n
    snap.marketCoreCollateralBalance = 1_499_999_000n;
    const findings = evaluateAllRules(snap, RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleType, 'market_core_solvency_deficit');
    assert.equal(findings[0].severity, 'critical');
  });

  test('solvency_ignores_void_dust', () => {
    const snap = baseSnapshot();
    // Void market where integer floor division on void payouts left +3 stroops of surplus dust in market-core
    snap.markets[0] = {
      marketId: 1,
      closeTime: 1_759_000_000,
      status: 'Void',
      outcome: null,
      reserveYes: 0n,
      reserveNo: 0n,
      setsMinted: 1_000_000_001n,
      feesAccrued: 0n,
      lpClaimed: true,
      redeemedPayoutTotal: 500_000_000n,
      reservesAtResolution: { yes: 500_000_000n, no: 500_000_001n },
    };
    const reconciled = reconcilePolledMarket(snap.markets[0], undefined, []);
    snap.markets[0] = reconciled;
    // Remaining obligation is 1 stroop; balance has 4 stroops (+3 surplus dust) -> no alert!
    snap.marketCoreCollateralBalance = 4n;
    const solvency = evaluateSolvency(snap.marketCoreCollateralBalance, snap.markets, 10n);
    assert.equal(solvency.deficit, false);
    assert.ok(solvency.surplusStroops > 0n);
    assert.deepEqual(evaluateAllRules(snap, RULES), []);
  });

  test('dedup_suppresses_repeat_and_resolves', () => {
    const engine = new RuleEngine(RULES);
    const snap = baseSnapshot();
    snap.marketCoreConfig.resolver = 'CMALICIOUS';

    const t0 = 1_760_000_000_000;
    const first = engine.evaluate(snap, t0);
    assert.equal(first.length, 1);
    assert.equal(first[0].action, 'trigger');
    assert.equal(engine.firingCount, 1);

    // Within 300s cooldown, repeat evaluation emits nothing
    const repeated = engine.evaluate(snap, t0 + 60_000);
    assert.equal(repeated.length, 0);

    // Once condition clears, engine emits a `resolve` notification
    snap.marketCoreConfig.resolver = 'CRESOLVER';
    const resolved = engine.evaluate(snap, t0 + 120_000);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].action, 'resolve');
    assert.equal(engine.firingCount, 0);
  });

  test('covers silent treasury pause, agent unregistration, utilization, archival, and retention gaps', () => {
    const snap = baseSnapshot();
    snap.treasuryConfig.paused = true;
    snap.agentRegistered = false;
    snap.treasuryDailyUsage = 8_500_000_000n; // 85% of 10B max_daily
    snap.ledgerEntries[0].liveUntilLedgerSeq = snap.currentLedger + 1_000; // <= 17_280 margin

    const findings = evaluateAllRules(snap, RULES);
    const types = new Set(findings.map((f) => f.ruleType));
    assert.ok(types.has('treasury_config_or_pause_changed'));
    assert.ok(types.has('registry_agent_anomaly'));
    assert.ok(types.has('treasury_utilization_threshold'));
    assert.ok(types.has('ledger_entry_near_archival'));

    const gap = detectCursorRetentionGap(100, 500);
    assert.equal(gap.gapDetected, true);
    assert.equal(gap.resumeLedger, 500);
    assert.ok(gap.alert);
  });

  test('decodes SAC transfer and contract events and delivers to webhook/Slack/PagerDuty sinks with retry', async () => {
    const sac = decodeRpcEvent({
      id: '1',
      ledger: 99,
      contractId: 'CUSDC',
      topic: ['transfer', 'CTREASURY', 'GOTHER', 'USDC:GISSUER'],
      value: { amount: '12345', to_muxed_id: null },
    });
    assert.ok(sac && sac.kind === 'sac_transfer');
    assert.equal(sac.amount, 12345n);

    let attempts = 0;
    const payloads: unknown[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, status: 502 } as Response;
      }
      payloads.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    const pd = new PagerDutySink('rk-123', { maxAttempts: 2, baseDelayMs: 1, fetchFn: fakeFetch });
    const slack = new SlackSink('https://hooks.slack.test/1', { maxAttempts: 1, fetchFn: fakeFetch });
    const wh = new WebhookSink('https://webhook.test/1', { maxAttempts: 1, fetchFn: fakeFetch });

    const sampleAlert = {
      action: 'trigger' as const,
      dedupKey: 'test:1',
      ruleId: 'r1',
      severity: 'critical' as const,
      title: 'Test alert',
      message: 'Body',
      timestamp: '2026-07-01T00:00:00Z',
    };

    await pd.send(sampleAlert);
    await slack.send(sampleAlert);
    await wh.send({ ...sampleAlert, action: 'resolve' });
    assert.equal(payloads.length, 3);

    const metricsText = renderPrometheusMetrics({
      lagLedgers: 2,
      eventsProcessedTotal: 42,
      alertsFiring: 1,
      solvencySurplusStroops: 3n,
      lastPollUnixSeconds: 1_760_000_000,
      healthy: true,
    });
    assert.match(metricsText, /oracledesk_monitor_solvency_surplus_stroops 3/);
    assert.deepEqual(selectMarketsToPoll(2, new Map(), [], false), [1, 2]);
  });
});
