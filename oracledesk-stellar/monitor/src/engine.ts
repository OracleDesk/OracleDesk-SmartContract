import { evaluateAllRules } from './rules.ts';
import type { AlertFinding, AlertNotification, MonitorSnapshot, RuleConfig } from './types.ts';

export interface ActiveAlertRecord {
  dedupKey: string;
  ruleId: string;
  finding: AlertFinding;
  firstFiredAtMs: number;
  lastNotifiedAtMs: number;
}

export class RuleEngine {
  private readonly rules: readonly RuleConfig[];
  private readonly cooldownByRuleId: Map<string, number>;
  private readonly activeAlerts = new Map<string, ActiveAlertRecord>();

  constructor(rules: readonly RuleConfig[]) {
    this.rules = rules;
    this.cooldownByRuleId = new Map(
      rules.map((r) => [r.id, (r.cooldownSeconds ?? 300) * 1000])
    );
  }

  get firingCount(): number {
    return this.activeAlerts.size;
  }

  getFiringAlerts(): ActiveAlertRecord[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Evaluate a snapshot against all registered rules, producing deduplicated
   * `trigger` notifications (subject to per-rule cooldown) and `resolve`
   * notifications when an active condition clears.
   */
  evaluate(snapshot: MonitorSnapshot, nowMs = snapshot.nowUnixSeconds * 1000): AlertNotification[] {
    const findings = evaluateAllRules(snapshot, this.rules);
    const currentByKey = new Map<string, AlertFinding>();
    for (const f of findings) {
      currentByKey.set(f.dedupKey, f);
    }

    const notifications: AlertNotification[] = [];
    const isoNow = new Date(nowMs).toISOString();

    // 1. Trigger new alerts or re-notify after cooldown
    for (const [dedupKey, finding] of currentByKey.entries()) {
      const existing = this.activeAlerts.get(dedupKey);
      const cooldownMs = this.cooldownByRuleId.get(finding.ruleId) ?? 300_000;

      if (!existing) {
        this.activeAlerts.set(dedupKey, {
          dedupKey,
          ruleId: finding.ruleId,
          finding,
          firstFiredAtMs: nowMs,
          lastNotifiedAtMs: nowMs,
        });
        notifications.push({
          action: 'trigger',
          dedupKey,
          ruleId: finding.ruleId,
          severity: finding.severity,
          title: finding.title,
          message: finding.message,
          timestamp: isoNow,
          details: finding.details,
        });
      } else if (
        nowMs - existing.lastNotifiedAtMs >= cooldownMs ||
        existing.finding.severity !== finding.severity
      ) {
        existing.finding = finding;
        existing.lastNotifiedAtMs = nowMs;
        notifications.push({
          action: 'trigger',
          dedupKey,
          ruleId: finding.ruleId,
          severity: finding.severity,
          title: finding.title,
          message: finding.message,
          timestamp: isoNow,
          details: finding.details,
        });
      }
    }

    // 2. Resolve alerts whose condition cleared
    for (const [dedupKey, existing] of Array.from(this.activeAlerts.entries())) {
      if (!currentByKey.has(dedupKey)) {
        this.activeAlerts.delete(dedupKey);
        notifications.push({
          action: 'resolve',
          dedupKey,
          ruleId: existing.ruleId,
          severity: existing.finding.severity,
          title: `RESOLVED: ${existing.finding.title}`,
          message: existing.finding.message,
          timestamp: isoNow,
          details: existing.finding.details,
        });
      }
    }

    return notifications;
  }
}
