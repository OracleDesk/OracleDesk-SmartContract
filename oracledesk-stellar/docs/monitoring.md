# On-Chain Monitoring & Alerting Service

`oracledesk-stellar/monitor/` is a read-only TypeScript service that tails Soroban contract and collateral SAC events, polls contract state periodically, evaluates declarative rules from `monitor/rules.yaml`, and dispatches deduplicated alerts (with automatic resolve notifications) to generic webhooks, Slack, and PagerDuty Events v2.

## Why Both Event Tailing and State Polling Are Required

Several critical privileged actions emit no contract events (`market-core` `set_paused`, `set_default_fee_bps`, `set_resolver`, `set_treasury`, `claim_pool_remainder`; `treasury` `withdraw`, `deposit`, `set_paused`; `reasoning-registry` `unregister_agent`). The monitor combines:

1. **Event tailing (`getEvents`)** across all five contract IDs (including SEP-41 `transfer` events on the collateral SAC to detect silent `treasury.withdraw` calls) with a persisted cursor and retention-gap detection (`monitor_gap`).
2. **Selective state polling** of `market-core` and `treasury` configs, `reasoning-registry.is_registered(agent)`, instance TTLs (`liveUntilLedgerSeq`), and active/touched market states (plus an hourly full sweep).

## Initial Rule Set (`monitor/rules.yaml`)

| Rule ID | Type | Severity | What it Detects & Response Steps |
| --- | --- | --- | --- |
| `market-core-config-changed` | `market_core_config_changed` | `critical` | `market-core` `resolver`, `treasury`, `collateral`, `paused`, or `default_fee_bps` differs from `deployments/testnet.json`. **Acknowledgement**: update `deployments/testnet.json` first for planned migrations; otherwise pause and rotate admin. |
| `market-voided` | `market_voided` | `high` | `MarketResolved` with `outcome = None` (void), flagging voids before `close_time`. Verify guardian action logs. |
| `treasury-unexpected-transfer` | `treasury_unexpected_transfer` | `warning` / `critical` (≥ 100 USDC) | Outgoing SAC `transfer` from `treasury` to any recipient other than `market-core`. Incoming deposits and trades to `market-core` are ignored. |
| `treasury-config-or-pause-changed` | `treasury_config_or_pause_changed` | `critical` | Treasury `paused` toggled or `RiskConfig` (`max_trade`, `max_market`, `max_daily`) drifted. |
| `market-stuck-unresolved` | `market_stuck_unresolved` | `warning` → `high` | Market still `Open` past `close_time + dispute_window + graceAfterCloseSeconds` (2h warning, 6h high). Accounts for the signer spec's `dispute_window` to avoid false positives during active dispute windows. |
| `treasury-utilization-threshold` | `treasury_utilization_threshold` | `warning` / `info` | Daily usage ≥ 80% of `max_daily` or single `TradeAuthorized` at `max_trade`. |
| `market-core-solvency-deficit` | `market_core_solvency_deficit` | `critical` | `balance(market_core) < sum(obligations) - tolerance`. Models both pre-settlement (`sets_minted + fees_accrued`) and post-settlement (`sets_minted - sum(Redeemed.payout) - claimed_pool + fees_accrued`) obligations. Positive surplus from void-payout integer floor rounding is reported via `oracledesk_monitor_solvency_surplus_stroops` and never alerts. |
| `registry-agent-anomaly` | `registry_agent_anomaly` | `high` | Primary agent silently unregistered (`is_registered(agent) == false`) or `AgentRegistered` for an unknown address. |
| `ledger-entry-near-archival` | `ledger_entry_near_archival` | `warning` | Contract instance `liveUntilLedgerSeq - currentLedger <= 17280` (~24 hours). Extend TTL immediately. |

## Operations & Endpoints

- `GET /healthz`: JSON readiness status, lag in ledgers, active alert count, and last poll timestamp.
- `GET /metrics`: Prometheus text exposition (`oracledesk_monitor_lag_ledgers`, `oracledesk_monitor_events_processed_total`, `oracledesk_monitor_alerts_firing`, `oracledesk_monitor_solvency_surplus_stroops`).
