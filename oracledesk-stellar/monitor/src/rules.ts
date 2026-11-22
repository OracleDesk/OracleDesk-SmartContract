import { evaluateSolvency } from './solvency.ts';
import type { AlertFinding, MonitorSnapshot, RuleConfig, RuleType } from './types.ts';

export type RuleEvaluator = (snapshot: MonitorSnapshot, rule: RuleConfig) => AlertFinding[];

const evalMarketCoreConfigChanged: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const { marketCoreConfig: cfg, expected } = snapshot;

  if (cfg.resolver !== expected.contracts.resolver) {
    findings.push({
      dedupKey: `${rule.id}:resolver`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core resolver address changed',
      message: `Expected resolver ${expected.contracts.resolver}, observed ${cfg.resolver}`,
      details: { expected: expected.contracts.resolver, actual: cfg.resolver },
    });
  }

  if (cfg.treasury !== expected.contracts.treasury) {
    findings.push({
      dedupKey: `${rule.id}:treasury`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core treasury address changed',
      message: `Expected treasury ${expected.contracts.treasury}, observed ${cfg.treasury}`,
      details: { expected: expected.contracts.treasury, actual: cfg.treasury },
    });
  }

  if (cfg.collateral !== expected.contracts.usdc) {
    findings.push({
      dedupKey: `${rule.id}:collateral`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core collateral address changed',
      message: `Expected collateral ${expected.contracts.usdc}, observed ${cfg.collateral}`,
      details: { expected: expected.contracts.usdc, actual: cfg.collateral },
    });
  }

  if (cfg.paused) {
    findings.push({
      dedupKey: `${rule.id}:paused`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core paused',
      message: 'market-core config.paused is true.',
      details: { paused: true },
    });
  }

  if (
    expected.defaultFeeBps !== undefined &&
    cfg.defaultFeeBps !== expected.defaultFeeBps
  ) {
    findings.push({
      dedupKey: `${rule.id}:default_fee_bps`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core default_fee_bps changed',
      message: `Expected default_fee_bps=${expected.defaultFeeBps}, observed ${cfg.defaultFeeBps}`,
      details: { expected: expected.defaultFeeBps, actual: cfg.defaultFeeBps },
    });
  }

  return findings;
};

const evalMarketVoided: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const marketById = new Map(snapshot.markets.map((m) => [m.marketId, m]));

  for (const event of snapshot.events) {
    if (event.kind !== 'market_resolved' || event.outcome !== null) continue;
    const market = marketById.get(event.marketId);
    const beforeClose = market ? event.timestamp < market.closeTime : false;
    findings.push({
      dedupKey: `${rule.id}:${event.marketId}`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: beforeClose
        ? `Market #${event.marketId} voided BEFORE close_time`
        : `Market #${event.marketId} voided`,
      message: beforeClose
        ? `Market #${event.marketId} was voided at ${event.timestamp} prior to close_time ${market!.closeTime}.`
        : `Market #${event.marketId} resolved as void (outcome=None) at ledger ${event.ledger}.`,
      details: {
        marketId: event.marketId,
        beforeClose,
        ledger: event.ledger,
      },
    });
  }

  return findings;
};

const evalTreasuryUnexpectedTransfer: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const treasury = snapshot.expected.contracts.treasury;
  const marketCore = snapshot.expected.contracts.market_core;
  const criticalThreshold = BigInt(rule.criticalThresholdStroops ?? '1000000000');

  for (const event of snapshot.events) {
    if (event.kind !== 'sac_transfer') continue;
    // Incoming deposits (to === treasury) or legitimate trades (from === treasury && to === marketCore)
    // must NOT fire.
    if (event.from !== treasury) continue;
    if (event.to === marketCore) continue;

    const severity = event.amount >= criticalThreshold ? 'critical' : rule.severity;
    findings.push({
      dedupKey: `${rule.id}:${event.to}:${event.ledger}`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity,
      title: 'Unexpected outgoing treasury collateral transfer',
      message: `Treasury transferred ${event.amount.toString()} stroops to ${event.to} (expected only market-core ${marketCore}).`,
      details: {
        from: event.from,
        to: event.to,
        amount: event.amount.toString(),
        ledger: event.ledger,
      },
    });
  }

  return findings;
};

const evalTreasuryConfigOrPauseChanged: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const { treasuryConfig: cfg, expected } = snapshot;

  if (cfg.paused) {
    findings.push({
      dedupKey: `${rule.id}:paused`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'Treasury paused',
      message: 'Treasury contract is paused.',
      details: { paused: true },
    });
  }

  if (cfg.marketCore !== expected.contracts.market_core) {
    findings.push({
      dedupKey: `${rule.id}:market_core`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'Treasury market_core address mismatch',
      message: `Expected ${expected.contracts.market_core}, observed ${cfg.marketCore}`,
    });
  }

  if (cfg.collateral !== expected.contracts.usdc) {
    findings.push({
      dedupKey: `${rule.id}:collateral`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'Treasury collateral address mismatch',
      message: `Expected ${expected.contracts.usdc}, observed ${cfg.collateral}`,
    });
  }

  if (expected.treasuryRiskConfig) {
    const exp = expected.treasuryRiskConfig;
    if (
      cfg.maxTrade !== exp.maxTrade ||
      cfg.maxMarket !== exp.maxMarket ||
      cfg.maxDaily !== exp.maxDaily
    ) {
      findings.push({
        dedupKey: `${rule.id}:risk_config`,
        ruleId: rule.id,
        ruleType: rule.type,
        severity: rule.severity,
        title: 'Treasury RiskConfig changed unexpectedly',
        message: 'Treasury max_trade / max_market / max_daily differs from expected deployment record.',
      });
    }
  }

  return findings;
};

const evalMarketStuckUnresolved: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const grace = rule.graceAfterCloseSeconds ?? 7200;
  const escalateAfter = rule.escalateAfterSeconds ?? 21600;

  for (const market of snapshot.markets) {
    if (market.status !== 'Open') continue;

    // Respect the signer spec's dispute_window so markets legitimately inside
    // their dispute window do not false-positive.
    const disputeWindow = market.disputeWindowSeconds ?? 0;
    const deadline = market.closeTime + disputeWindow;
    const overdueSeconds = snapshot.nowUnixSeconds - deadline;
    if (overdueSeconds <= grace) continue;

    const severity =
      overdueSeconds >= escalateAfter && rule.escalateSeverity
        ? rule.escalateSeverity
        : rule.severity;

    findings.push({
      dedupKey: `${rule.id}:${market.marketId}`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity,
      title: `Market #${market.marketId} stuck unresolved`,
      message: `Market #${market.marketId} is still Open ${overdueSeconds}s past close_time + dispute_window (resolverState=${market.resolverState ?? 'unknown'}).`,
      details: {
        marketId: market.marketId,
        overdueSeconds,
        resolverState: market.resolverState ?? null,
      },
    });
  }

  return findings;
};

const evalTreasuryUtilizationThreshold: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const warnPct = BigInt(rule.dailyUsageWarnPct ?? 80);
  const maxDaily = snapshot.treasuryConfig.maxDaily;
  const maxTrade = snapshot.treasuryConfig.maxTrade;

  if (maxDaily > 0n && snapshot.treasuryDailyUsage * 100n >= maxDaily * warnPct) {
    const pct = Number((snapshot.treasuryDailyUsage * 100n) / maxDaily);
    findings.push({
      dedupKey: `${rule.id}:daily_usage`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: `Treasury daily usage at ${pct}% of max_daily`,
      message: `Treasury daily usage ${snapshot.treasuryDailyUsage.toString()} / ${maxDaily.toString()} stroops exceeds ${warnPct.toString()}%.`,
      details: { pct, dailyUsage: snapshot.treasuryDailyUsage.toString() },
    });
  }

  for (const event of snapshot.events) {
    if (event.kind !== 'trade_authorized') continue;
    if (maxTrade > 0n && event.amount >= maxTrade) {
      findings.push({
        dedupKey: `${rule.id}:max_trade:${event.marketId}:${event.ledger}`,
        ruleId: rule.id,
        ruleType: rule.type,
        severity: 'info',
        title: `Single TradeAuthorized hit max_trade on market #${event.marketId}`,
        message: `Agent ${event.agent} authorized ${event.amount.toString()} stroops (max_trade=${maxTrade.toString()}).`,
        details: { marketId: event.marketId, amount: event.amount.toString() },
      });
    }
  }

  return findings;
};

const evalMarketCoreSolvencyDeficit: RuleEvaluator = (snapshot, rule) => {
  const tolerance = BigInt(rule.toleranceStroops ?? '0');
  const result = evaluateSolvency(
    snapshot.marketCoreCollateralBalance,
    snapshot.markets,
    tolerance,
    Boolean(snapshot.approximateSolvencyMode)
  );

  if (!result.deficit) return [];

  return [
    {
      dedupKey: `${rule.id}:market_core`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'market-core collateral solvency deficit detected',
      message: `market-core balance ${result.collateralBalance.toString()} < obligations ${result.totalObligations.toString()} (surplus=${result.surplusStroops.toString()} stroops).`,
      details: {
        balance: result.collateralBalance.toString(),
        obligations: result.totalObligations.toString(),
        surplusStroops: result.surplusStroops.toString(),
        approximateMode: result.approximateMode,
      },
    },
  ];
};

const evalRegistryAgentAnomaly: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const allowedAgents = new Set([
    snapshot.expected.agent,
    ...(snapshot.expected.expectedAgents ?? []),
  ]);

  if (!snapshot.agentRegistered) {
    findings.push({
      dedupKey: `${rule.id}:unregistered:${snapshot.expected.agent}`,
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      title: 'Primary agent unregistered from reasoning-registry',
      message: `is_registered(${snapshot.expected.agent}) returned false.`,
      details: { agent: snapshot.expected.agent },
    });
  }

  for (const event of snapshot.events) {
    if (event.kind !== 'agent_registered') continue;
    if (!allowedAgents.has(event.agent)) {
      findings.push({
        dedupKey: `${rule.id}:unexpected_agent:${event.agent}`,
        ruleId: rule.id,
        ruleType: rule.type,
        severity: rule.severity,
        title: 'Unexpected AgentRegistered on reasoning-registry',
        message: `Address ${event.agent} was registered at ledger ${event.ledger} and is not in the expected agent list.`,
        details: { agent: event.agent, ledger: event.ledger },
      });
    }
  }

  return findings;
};

const evalLedgerEntryNearArchival: RuleEvaluator = (snapshot, rule) => {
  const findings: AlertFinding[] = [];
  const margin = rule.archivalMarginLedgers ?? 17_280;

  for (const entry of snapshot.ledgerEntries) {
    const remaining = entry.liveUntilLedgerSeq - snapshot.currentLedger;
    if (remaining <= margin) {
      findings.push({
        dedupKey: `${rule.id}:${entry.contractName}`,
        ruleId: rule.id,
        ruleType: rule.type,
        severity: rule.severity,
        title: `Contract ${entry.contractName} instance near archival`,
        message: `${entry.contractName} (${entry.contractId}) has ${remaining} ledgers until archival (margin=${margin}).`,
        details: {
          contractName: entry.contractName,
          liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
          remainingLedgers: remaining,
        },
      });
    }
  }

  return findings;
};

export const RULE_REGISTRY: Readonly<Record<RuleType, RuleEvaluator>> = {
  market_core_config_changed: evalMarketCoreConfigChanged,
  market_voided: evalMarketVoided,
  treasury_unexpected_transfer: evalTreasuryUnexpectedTransfer,
  treasury_config_or_pause_changed: evalTreasuryConfigOrPauseChanged,
  market_stuck_unresolved: evalMarketStuckUnresolved,
  treasury_utilization_threshold: evalTreasuryUtilizationThreshold,
  market_core_solvency_deficit: evalMarketCoreSolvencyDeficit,
  registry_agent_anomaly: evalRegistryAgentAnomaly,
  ledger_entry_near_archival: evalLedgerEntryNearArchival,
};

export function evaluateAllRules(
  snapshot: MonitorSnapshot,
  rules: readonly RuleConfig[]
): AlertFinding[] {
  const findings: AlertFinding[] = [];
  for (const rule of rules) {
    const evaluator = RULE_REGISTRY[rule.type];
    if (!evaluator) continue;
    findings.push(...evaluator(snapshot, rule));
  }
  return findings;
}
