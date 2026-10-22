# Agent runtime (agentd)

`agents/runtime/` turns the one-shot maker and trader CLIs into one
long-running, supervised process.

```bash
cd oracledesk-stellar/agents
npm run agentd                         # both tasks, continuously
npm run agentd -- --once               # each task exactly once, then exit
npm run agentd -- --tasks trader       # a subset
npm run agentd -- --config agentd.json # env-style overrides from a JSON object
npm run market-maker                   # unchanged: the maker task, once
npm run trader                         # unchanged: the trader task, once
```

## What it guarantees

| concern | mechanism |
|---|---|
| **Overlapping runs**, e.g. cron firing again before the previous run finished | Each task loops as *run, then sleep* (`intervalMs` ± `jitterMs`), so a slow tick delays the next one instead of stacking. |
| **Two copies on one key**, which race on the sequence number and double-spend the daily budget | A single-instance lease: `.agent-state/agent.lock` holds `{pid, host, startedAt, heartbeatAt}`. It is created exclusively and heartbeated every `LEASE_HEARTBEAT_MS`. A second instance exits with **75** (EX_TEMPFAIL). The lock is taken over only when it is **stale**: its heartbeat is older than `LEASE_TTL_MS` and its owner is gone (a dead PID on this host, a PID started before the last boot, or any host for a stale heartbeat from another machine). A holder that loses the lease stops with exit 1. |
| **Maker and trader sharing a source account** | Every adapter submission goes through `ctx.submit`, one FIFO mutex for the whole process, so at most one transaction is ever in flight. |
| **The trader buying into a market the maker hasn't revealed** | The maker marks the question *creating* before submitting the create, then the market *created* once the id is known, then *revealed* after its spec reveal. The trader skips our own markets (creator = our treasury) until they are *revealed*. It also takes a per-market advisory lock while it decides and trades. Other creators' markets follow the chain-state rules only. |
| **Killed mid-submission** | `SIGTERM`/`SIGINT` stop scheduling and wake sleeping loops. Abort reaches only pre-submit steps: a submission already handed to the adapter is never interrupted. The runtime waits up to `SHUTDOWN_GRACE_MS`, flushes state and releases the lease. If a submission is *still* in flight at the deadline, it logs `SHUTDOWN_WITH_INFLIGHT` with the pending intents, **keeps** the lease (so no replacement can double-submit before the TTL proves this process gone) and exits 1. A second `SIGINT` forces exit 130. |
| **Trade with no published trace** | Before every submission the state records an *intent*, and *done* after. Each trace is queued as *pending* before `publish_trace` and marked *published* after, and every tick retries pending traces first. Processed signals are deduplicated by `sha256(source, observedAt, question)`. |
| **Crash loops** | A failing task backs off exponentially (`BACKOFF_BASE_MS` × 2ⁿ, capped at `BACKOFF_MAX_MS`), and the backoff resets on success. The process circuit opens, logging `CIRCUIT_OPEN` and exiting 1 so the supervisor reacts, after `MAX_CONSECUTIVE_FAILURES` in a row from one task, or `MAX_FAILURES_IN_WINDOW` failures across tasks within `FAILURE_WINDOW_MS`. |
| **Misconfiguration** | `AGENT_MODE` must be exactly `dry-run` or `live` (unset means dry-run). Anything else exits **2**, where it used to fall through to the live path. Mixing modes in one process is rejected. |

State lives in `AGENT_STATE_PATH` (default `./.agent-state/state.json`,
gitignored). It is versioned and keyed by treasury contract id, so a testnet
redeploy starts clean. Writes are atomic (temp file, fsync, rename), debounced,
and forced after every submission. Dry-run uses in-memory state: a rehearsal
never marks real work as done.

A create or trade that fails after its intent was recorded is left as
*intent*: it may or may not have landed, so it is never blindly retried. The
transaction journal (a separate issue) or an operator reconciles it. Until the
commit/reveal flow is wired into the maker (`MakerDeps.reveal`), its markets
stay *created*, and the trader correctly leaves them alone.

Each task run logs one JSON line (`TASK_OK` / `TASK_FAILED` with the task
name and duration), plus decision and submission events.

## Exit codes

| code | meaning |
|---|---|
| 0 | clean stop, or `--once` succeeded |
| 1 | task failure (`--once`), circuit open, lease lost, or shutdown with submissions in flight |
| 2 | bad configuration (`AGENT_MODE`, arguments, env values) |
| 75 | lease held by another live instance; retry later |
| 130 | forced by a second `SIGINT` |

## systemd

```ini
# /etc/systemd/system/oracledesk-agentd.service
[Unit]
Description=OracleDesk agent daemon
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/oracledesk/oracledesk-stellar/agents
EnvironmentFile=/opt/oracledesk/oracledesk-stellar/.env
ExecStart=/usr/bin/npx tsx bin/agentd.ts
Restart=on-failure
RestartSec=30
# 75 means another instance holds the lease: retry, but don't count it as a crash.
RestartPreventExitStatus=2
SuccessExitStatus=0
KillSignal=SIGTERM
# Must exceed SHUTDOWN_GRACE_MS (default 30s), or systemd SIGKILLs mid-submission.
TimeoutStopSec=60
User=oracledesk

[Install]
WantedBy=multi-user.target
```

`RestartPreventExitStatus=2` stops systemd from restart-looping on a
configuration error. Exit 1, from the circuit breaker, is restarted after
`RestartSec`, which is the cool-down.

## Docker

```dockerfile
STOPSIGNAL SIGTERM
CMD ["npx", "tsx", "bin/agentd.ts"]
```

Run with `docker run --stop-timeout 60 ...` (or `stop_grace_period: 60s` in
Compose), which must be greater than `SHUTDOWN_GRACE_MS`. Mount
`.agent-state/` on a volume so state and the lease survive container
restarts. Use exec-form `CMD`, so the signal reaches node rather than a shell.

## Environment

| variable | default | meaning |
|---|---|---|
| `AGENT_MODE` | `dry-run` | `dry-run` or `live`; anything else exits 2 |
| `AGENT_STATE_PATH` | `./.agent-state/state.json` | state file; the lock defaults to `agent.lock` beside it |
| `AGENT_LEASE_PATH` | (beside the state) | lock file path |
| `AGENT_LEASE` | | `none` disables the lease; only use it when exclusivity is guaranteed elsewhere |
| `LEASE_TTL_MS` / `LEASE_HEARTBEAT_MS` | 60000 / 10000 | staleness threshold / heartbeat period |
| `MAKER_INTERVAL_MS` / `MAKER_JITTER_MS` | 300000 / 15000 | maker schedule |
| `TRADER_INTERVAL_MS` / `TRADER_JITTER_MS` | 60000 / 5000 | trader schedule |
| `SHUTDOWN_GRACE_MS` | 30000 | how long shutdown waits for in-flight work |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | 1000 / 300000 | per-task failure backoff |
| `MAX_CONSECUTIVE_FAILURES` | 8 | consecutive failures of one task that open the circuit |
| `MAX_FAILURES_IN_WINDOW` / `FAILURE_WINDOW_MS` | 20 / 600000 | failures across tasks that open the circuit |
| `STATE_FLUSH_DEBOUNCE_MS` | 250 | state write debounce |
| `MARKET_CLOSE_IN_SECS` | 3600 | close time of markets the maker creates |

## Extending

A task is `{name, intervalMs, jitterMs?, mode?, run(ctx)}`. Its `ctx`
provides:
- `submit` for every transaction,
- `state` for cursors (write the intent before submitting),
- `locks` for market coordination,
- `signal`, to check between steps,
- `log` and `now`.

`Lease` is an interface: a shared backend for multiple hosts can replace
`FileLease` without touching the runtime. Event-driven wake-ups can later call
into the same loops instead of waiting out `intervalMs`.
