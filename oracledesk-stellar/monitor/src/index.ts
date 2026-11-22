import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleEngine } from './engine.ts';
import { createMonitorHttpServer, type MonitorMetricsState } from './server.ts';
import { PagerDutySink, SlackSink, WebhookSink, type AlertSink } from './sinks.ts';
import { loadMonitorState, saveMonitorState } from './state.ts';
import { pollContractEvents } from './tailer.ts';
import type { ExpectedDeploymentState, RuleConfig, RuleType, Severity } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `monitor/rules.yaml` into typed `RuleConfig[]` without evaluating
 * arbitrary code.
 */
export function parseRulesYaml(yamlContent: string): RuleConfig[] {
  const rules: RuleConfig[] = [];
  let current: Partial<RuleConfig> | null = null;

  for (const rawLine of yamlContent.split(/\r?\n/)) {
    const stripped = rawLine.replace(/#.*$/, '').trim();
    if (!stripped || stripped === 'rules:' || stripped.startsWith('version:')) continue;

    if (stripped.startsWith('- id:')) {
      if (current && current.id && current.type && current.severity) {
        rules.push(current as RuleConfig);
      }
      current = { id: stripped.slice('- id:'.length).trim() };
      continue;
    }

    if (!current) continue;
    const colonIdx = stripped.indexOf(':');
    if (colonIdx === -1) continue;
    const key = stripped.slice(0, colonIdx).trim();
    const rawVal = stripped.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');

    switch (key) {
      case 'type':
        current.type = rawVal as RuleType;
        break;
      case 'severity':
        current.severity = rawVal as Severity;
        break;
      case 'escalateSeverity':
        current.escalateSeverity = rawVal as Severity;
        break;
      case 'cooldownSeconds':
      case 'graceAfterCloseSeconds':
      case 'escalateAfterSeconds':
      case 'dailyUsageWarnPct':
      case 'archivalMarginLedgers':
        current[key] = Number.parseInt(rawVal, 10);
        break;
      case 'criticalThresholdStroops':
      case 'toleranceStroops':
      case 'description':
        current[key] = rawVal;
        break;
    }
  }

  if (current && current.id && current.type && current.severity) {
    rules.push(current as RuleConfig);
  }

  return rules;
}

export function loadConfiguredSinks(env: NodeJS.ProcessEnv = process.env): AlertSink[] {
  const sinks: AlertSink[] = [];
  if (env.MONITOR_WEBHOOK_URL) {
    sinks.push(new WebhookSink(env.MONITOR_WEBHOOK_URL));
  }
  if (env.MONITOR_SLACK_WEBHOOK_URL) {
    sinks.push(new SlackSink(env.MONITOR_SLACK_WEBHOOK_URL));
  }
  if (env.MONITOR_PAGERDUTY_ROUTING_KEY) {
    sinks.push(new PagerDutySink(env.MONITOR_PAGERDUTY_ROUTING_KEY));
  }
  return sinks;
}

async function main() {
  const rulesPath = process.env.MONITOR_RULES_PATH ?? resolve(__dirname, '../rules.yaml');
  const deploymentsPath =
    process.env.DEPLOYMENTS_FILE ?? resolve(__dirname, '../../deployments/testnet.json');
  const statePath = process.env.MONITOR_STATE_PATH ?? resolve(__dirname, '../.monitor-state.json');
  const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const port = Number.parseInt(process.env.MONITOR_PORT ?? '9101', 10);
  const pollIntervalMs = Number.parseInt(process.env.MONITOR_POLL_INTERVAL_MS ?? '15000', 10);

  const rules = parseRulesYaml(readFileSync(rulesPath, 'utf8'));
  const expected = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as ExpectedDeploymentState;
  const engine = new RuleEngine(rules);
  const sinks = loadConfiguredSinks();
  const state = loadMonitorState(statePath);

  const metrics: MonitorMetricsState = {
    lagLedgers: 0,
    eventsProcessedTotal: 0,
    alertsFiring: 0,
    solvencySurplusStroops: 0n,
    lastPollUnixSeconds: Math.floor(Date.now() / 1000),
    healthy: true,
  };

  const contractIds = [
    expected.contracts.usdc,
    expected.contracts.market_core,
    expected.contracts.resolver,
    expected.contracts.treasury,
    expected.contracts.reasoning_registry,
  ];

  const tick = async () => {
    try {
      const tail = await pollContractEvents(rpcUrl, contractIds, {
        cursor: state.cursor,
        startLedger: state.lastLedger ?? undefined,
      });
      metrics.eventsProcessedTotal += tail.events.length;
      if (tail.nextCursor) state.cursor = tail.nextCursor;
      if (tail.latestLedger !== null) {
        metrics.lagLedgers =
          state.lastLedger !== null ? Math.max(0, tail.latestLedger - state.lastLedger) : 0;
        state.lastLedger = tail.latestLedger;
      }
      metrics.lastPollUnixSeconds = Math.floor(Date.now() / 1000);
      metrics.alertsFiring = engine.firingCount;
      metrics.healthy = true;
      saveMonitorState(statePath, state);
    } catch {
      metrics.healthy = false;
    }
  };

  const server = createMonitorHttpServer(() => metrics);
  await new Promise<void>((res) => server.listen(port, res));
  console.log(`OracleDesk monitor listening on http://localhost:${port} (/healthz, /metrics)`);

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  const shutdown = () => {
    clearInterval(timer);
    saveMonitorState(statePath, state);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
