import type { AlertNotification, Severity } from './types.ts';

export interface AlertSink {
  readonly name: string;
  send(notification: AlertNotification): Promise<void>;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchFn?: typeof fetch;
}

async function postJsonWithRetry(
  url: string,
  payload: unknown,
  options: RetryOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const fetchImpl = options.fetchFn ?? fetch;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class WebhookSink implements AlertSink {
  readonly name = 'webhook';
  private readonly url: string;
  private readonly retry: RetryOptions;

  constructor(url: string, retry: RetryOptions = {}) {
    this.url = url;
    this.retry = retry;
  }

  async send(notification: AlertNotification): Promise<void> {
    await postJsonWithRetry(this.url, notification, this.retry);
  }
}

export class SlackSink implements AlertSink {
  readonly name = 'slack';
  private readonly webhookUrl: string;
  private readonly retry: RetryOptions;

  constructor(webhookUrl: string, retry: RetryOptions = {}) {
    this.webhookUrl = webhookUrl;
    this.retry = retry;
  }

  async send(notification: AlertNotification): Promise<void> {
    const emoji =
      notification.action === 'resolve'
        ? ':white_check_mark:'
        : notification.severity === 'critical'
          ? ':rotating_light:'
          : ':warning:';
    const text = `${emoji} *[${notification.severity.toUpperCase()}]* ${notification.title}\n${notification.message}\n_key: \`${notification.dedupKey}\`_`;
    await postJsonWithRetry(this.webhookUrl, { text }, this.retry);
  }
}

function toPagerDutySeverity(severity: Severity): 'critical' | 'error' | 'warning' | 'info' {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

export class PagerDutySink implements AlertSink {
  readonly name = 'pagerduty';
  private readonly routingKey: string;
  private readonly endpoint: string;
  private readonly retry: RetryOptions;

  constructor(
    routingKey: string,
    retry: RetryOptions = {},
    endpoint = 'https://events.pagerduty.com/v2/enqueue'
  ) {
    this.routingKey = routingKey;
    this.retry = retry;
    this.endpoint = endpoint;
  }

  async send(notification: AlertNotification): Promise<void> {
    const payload =
      notification.action === 'resolve'
        ? {
            routing_key: this.routingKey,
            event_action: 'resolve',
            dedup_key: notification.dedupKey,
          }
        : {
            routing_key: this.routingKey,
            event_action: 'trigger',
            dedup_key: notification.dedupKey,
            payload: {
              summary: `[OracleDesk] ${notification.title}: ${notification.message}`,
              source: 'oracledesk-monitor',
              severity: toPagerDutySeverity(notification.severity),
              timestamp: notification.timestamp,
              custom_details: notification.details ?? {},
            },
          };

    await postJsonWithRetry(this.endpoint, payload, this.retry);
  }
}
