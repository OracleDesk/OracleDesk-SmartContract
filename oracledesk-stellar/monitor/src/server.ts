import { createServer, type Server } from 'node:http';

export interface MonitorMetricsState {
  lagLedgers: number;
  eventsProcessedTotal: number;
  alertsFiring: number;
  solvencySurplusStroops: bigint;
  lastPollUnixSeconds: number;
  healthy: boolean;
}

export function renderPrometheusMetrics(m: MonitorMetricsState): string {
  return [
    '# HELP oracledesk_monitor_lag_ledgers Lag in ledgers between RPC head and monitor cursor.',
    '# TYPE oracledesk_monitor_lag_ledgers gauge',
    `oracledesk_monitor_lag_ledgers ${m.lagLedgers}`,
    '# HELP oracledesk_monitor_events_processed_total Total contract and SAC events processed.',
    '# TYPE oracledesk_monitor_events_processed_total counter',
    `oracledesk_monitor_events_processed_total ${m.eventsProcessedTotal}`,
    '# HELP oracledesk_monitor_alerts_firing Current count of active firing alerts.',
    '# TYPE oracledesk_monitor_alerts_firing gauge',
    `oracledesk_monitor_alerts_firing ${m.alertsFiring}`,
    '# HELP oracledesk_monitor_solvency_surplus_stroops market-core collateral balance minus obligations in stroops.',
    '# TYPE oracledesk_monitor_solvency_surplus_stroops gauge',
    `oracledesk_monitor_solvency_surplus_stroops ${m.solvencySurplusStroops.toString()}`,
    '',
  ].join('\n');
}

export function createMonitorHttpServer(getMetrics: () => MonitorMetricsState): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      const m = getMetrics();
      const status = m.healthy ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: m.healthy ? 'ok' : 'degraded',
          lagLedgers: m.lagLedgers,
          alertsFiring: m.alertsFiring,
          lastPollUnixSeconds: m.lastPollUnixSeconds,
        })
      );
      return;
    }

    if (url === '/metrics') {
      const m = getMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderPrometheusMetrics(m));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
}
