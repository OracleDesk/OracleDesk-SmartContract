# Agent runtime (agentd)

`agents/runtime/` turns the one-shot maker and trader CLIs into one
long-running, supervised process.

```bash
cd oracledesk-stellar/agents
npm run agentd                         # both tasks, continuously
npm run agentd -- --once               # each task exactly once, then exit
npm run agentd -- --tasks trader       # a subset
npm run agentd -- --tasks availability # opt-in trace availability service (#325)
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
| **Kill switch** | One persistent marker stops every task immediately, cancels unsent envelopes, blocks new submissions before and after taking the mutex, and makes a tripped daemon refuse to start. Contract-error, risk, operator and drawdown triggers all use the same path. The local stop never waits for RPC; the on-chain `agent_halt` retries independently with capped backoff. |

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

## Kill switch

```bash
npm run agentd -- kill --reason operator --detail "incident 123"
npm run agentd -- rearm --operator alice
```

`kill` writes an fsynced marker file (`AGENT_KILL_FILE`, default
`.agent-state/KILLED`) and signals the PID recorded in `.agent-state/agent.lock`
with `SIGUSR2`. The daemon also polls the marker every second. Valid reasons are
`operator`, `risk`, `errors` and `drawdown`. A killed daemon exits **3** and
will not start tasks again until an operator explicitly runs `rearm`.

The default task set includes a 30-second `guard` task that calls
`drawdown_status()` and trips on `tripped`. The trader calls
`evaluateAgentRisk` before each buy and trips on model violations. Repeated
contract errors trip with `errors`. Unsigned envelopes are never sent; the
transaction journal records a `cancelled` stage for envelopes stopped before
broadcast, while already submitted envelopes are polled to a terminal state.

Once the local halt completes, a live daemon schedules `agent_halt` outside the
task loops. It retries with exponential backoff capped at 60 seconds and keeps
its pending state in `AGENT_STATE_PATH`, so it resumes after a restart. It
finishes when `get_agent` shows no `ROLE_CREATE | ROLE_TRADE`. Dry-run writes
the marker and stops locally but never calls the chain. After the keeper has
settled remaining positions, an admin restores rights with `set_agent` followed
by `execute_agent` after `config_delay`.

## Exit codes

| code | meaning |
|---|---|
| 0 | clean stop, or `--once` succeeded |
| 1 | task failure (`--once`), circuit open, lease lost, or shutdown with submissions in flight |
| 2 | bad configuration (`AGENT_MODE`, arguments, env values) |
| 3 | killed; re-arm explicitly before restarting |
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
| `WATCHER_ENABLED` | `0` | enables the `watcher` task (see [Proposal watcher](#proposal-watcher)) |
| `WATCHER_SECRET_KEY` | | the watcher's own key. Never falls back to `AGENT_SECRET_KEY`, and a treasury agent's key is refused |
| `WATCHER_INTERVAL_MS` | 15000 | watcher schedule |
| `WATCHER_MIN_CONFIDENCE_BPS` | 9500 | dispute only at or above this confidence |
| `WATCHER_MIN_LEAD_SECS` | 60 | refuse to sign with less ledger time than this left in the window |
| `WATCHER_MAX_BOND_STROOPS` | 500000000 | largest bond escrowed in one dispute |
| `WATCHER_BUDGET_STROOPS` | 1000000000 | largest total bond at risk at once |
| `WATCHER_MAX_DISPUTES_PER_DAY` | 5 | disputes opened per UTC day |
| `WATCHER_VERDICTS_FILE` | `./watcher-verdicts.json` | operator verdicts for the manual source |
| `WATCHER_IPFS_GATEWAY` | | gateway used to fetch metadata and evidence traces (`local://` URIs need none) |
| `TRACE_STORE` | `local` dry-run / `ipfs` live | store selected by `createTraceStore`; live refuses `local` without the override below |
| `ALLOW_LOCAL_TRACE_STORE` | `0` | set to `1` to deliberately publish `local://` CIDs in live mode |
| `IPFS_KUBO_API_URL` / `IPFS_KUBO_AUTH` | | raw-leaf `/api/v0/add` provider used for uploads and re-pins |
| `IPFS_PINNING_ENDPOINT` / `IPFS_PINNING_TOKEN` / `IPFS_PINNING_ORIGINS` | | optional Pinning Service API provider; needs a serving origin |
| `IPFS_MIN_PINS` / `IPFS_PIN_RETRIES` / `IPFS_PIN_TIMEOUT_MS` | 1 / 3 / 60000 | pin quorum and retry policy |
| `IPFS_GATEWAY_URL` / `TRACE_ARCHIVE_DIR` | `https://ipfs.io/ipfs` / `./.trace-archive` | verification gateway and local archive of verified bytes |
| `AVAIL_GATEWAYS` | `IPFS_GATEWAY_URL` | comma-separated gateways the availability task probes |
| `AVAIL_REPORTER_SECRET` | | dedicated `S...` key for `report_unavailable`; required in live mode, never a trading key |
| `AVAIL_BATCH` / `AVAIL_CONCURRENCY` | 25 / 4 | traces probed per tick and parallel probes |
| `AVAIL_FLAG_AFTER_SECS` / `AVAIL_FLAG_AFTER_PROBES` | 21600 / 3 | time and distinct-tick thresholds before flagging |
| `AVAIL_MIN_TOGGLE_SECS` | 86400 | minimum interval between reporter toggles (mirrors the registry) |
| `AVAIL_INTERVAL_MS` / `AVAIL_JITTER_MS` / `AVAIL_TIMEOUT_MS` / `AVAIL_MAX_BYTES` | 900000 / 5000 / 30000 / 1048576 | task schedule and probe limits |
| `RESTORE_MAX_FEE_STROOPS` | `100000000` | maximum restore rent charged to one action |
| `RESTORE_DAILY_BUDGET_STROOPS` | `300000000` | maximum restore rent per task per UTC day (persisted) |
| `RESTORE_MAX_RETRIES` | `2` | re-simulations after an entry archives between simulation and apply |

## Proposal watcher

An optimistic oracle is only as safe as its challengers. For a
`SignersDisputable` market, a signer quorum *proposes* an outcome and anyone
may `dispute` it inside `dispute_window` by escrowing `dispute_bond`; if nobody
does, `finalize_signers` settles the market on the proposal. The `watcher` task
(`runtime/tasks/watcher.ts`) is the challenger:

```
npm run agentd -- --tasks watcher        # WATCHER_ENABLED=1, WATCHER_SECRET_KEY=S...
```

**What it does.**

1. A dedicated `EventSubscriber`/`Dispatcher` (own checkpoint directory, so it
   never shares a cursor with `trader --follow`) follows `ResolutionProposed`,
   `Disputed`, `DisputeSettled` and `ResolutionFinalized`.
2. For each proposal it reads the market's *committed* `DisputableSignerConfig`
   (window, bond, escalation timeout) from the resolver. Non-disputable markets
   are ignored.
3. It evaluates the proposal against the `OutcomeSource`s once as soon as it is
   seen and again at `deadline - 2 * WATCHER_MIN_LEAD_SECS`, and retries a tick
   after a source failure. Sources are combined only when they agree; any
   disagreement is an alert, never a dispute.
4. `core/dispute-policy.ts` decides (below). If it says dispute, the task
   re-reads `state()`, the proposal and the latest ledger close time, builds a
   reasoning trace (`action: "other:dispute"`, with the proposal, verdict,
   sources, exposure and bond), stores and publishes it, and only then submits
   `dispute` through `ctx.submit` under the market's lock.
5. It follows the dispute: `expire_dispute` once `opened_at +
   escalation_timeout` has passed, and `claim_dispute_bond` when the payee is
   the watcher.

**Sources** (`core/outcomes/`):

| source | covers | confidence |
|---|---|---|
| `PriceRuleSource` | markets whose metadata declares a `price_question` (`reflector`, `asset`, `threshold`, `direction`, `closeTime`, `maxStaleness`) | reads the same Reflector record as the resolver's `read_feed_on_grid` (close time rounded down to the oracle's resolution, walking back inside `max_staleness`, at most 12 records). Within one feed tick of the threshold the confidence is 0; it rises to 9900 bps at a 1 % margin. A missing close-time record (retention) is confidence 0 |
| `EvidenceTraceSource` | markets with attestation-linked evidence traces | verifies each trace against its on-chain hash; majority conclusion of the verified traces, confidence from the share that agree (capped at 9500; needs at least two) |
| `ManualSource` | anything else | `watcher-verdicts.json`, re-read on every call: `{ "<market id>": { "outcome": "No", "confidenceBps": 10000, "note": "..." } }` |

**Decision rule.** A correct dispute only *refunds* the bond (the resolver
pays no reward); a wrong one forfeits it to market-core's treasury. The watcher
therefore profits only by protecting positions the treasury already holds, and
disputes only when all of these hold:

```
verdict.outcome != proposal.outcome
verdict.confidenceBps >= WATCHER_MIN_CONFIDENCE_BPS
protected * p > bond * (1 - p)             p = confidenceBps / 10_000
bond <= budget available                   (per-dispute cap, total budget, wallet balance, daily count)
secondsLeft(ledger time) >= WATCHER_MIN_LEAD_SECS
```

`protected` is how much more the treasury is paid if the verdict settles than
if the proposal does (YES/NO shares held, or its cost basis for `Invalid`). It
is evaluated in integer stroops with a strict inequality, so ties and rounding
go toward not disputing.

**Timing.** The window is ledger time, but RPC event delivery lags. The task
never trusts an event's age: every tick re-reads `state()`, the proposal and
`getLatestLedger().closeTime`, so a cancelled proposal, a re-proposal or
another party's dispute is noticed even if no event arrives. Simulation runs at
the next ledger's timestamp, so `WATCHER_MIN_LEAD_SECS` (default 60) leaves
well over two ledgers plus inclusion time. `candidates` (markets the treasury
holds) lets a tick rediscover a pending proposal whose event was lost.

**Bonds.** `core/bond-budget.ts` keeps one record per disputed market in the
state store (`committed = at risk + refunded + forfeited`), so a restart never
forgets a locked bond. A submission that may have landed keeps its bond
committed and is reconciled against `Dispute(id)` on the next tick; one that
certainly did not is released. Another party disputing first (`DisputeActive`)
counts as success: nothing is spent and their dispute is followed.

**Prerequisites.** The watcher key needs collateral for bonds and must be
registered with the reasoning registry (`register_agent`), because the trace is
published before the dispute. It never acts as an escalation member and does
not change bond economics.

## Trace availability (#325)

An audit trail is only useful while its bytes can be fetched. The `availability`
task is **off by default** and is enabled only with
`--tasks availability` (it can be combined with the other tasks):

```bash
npm run agentd -- --tasks availability          # dry-run: logs intended flags
AGENT_MODE=live AVAIL_REPORTER_SECRET=S... \
  npm run agentd -- --tasks maker,trader,availability
```

Every entrypoint now builds its trace store through
`core/trace-store-factory.ts`, so live mode publishes IPFS CIDs by default;
`ALLOW_LOCAL_TRACE_STORE=1` is the only way to publish a `local://` CID.
`IpfsTraceStore.put` archives the exact verified bytes under
`TRACE_ARCHIVE_DIR` after enough providers pin them and the gateway serves
bytes hashing to the recorded trace hash.

Each tick the task:

1. reads a persisted `availability/checkpoint` cursor and probes the next
   `AVAIL_BATCH` registry trace ids (bounded parallelism `AVAIL_CONCURRENCY`);
   the cursor is saved **only after** all results are recorded, so a crash
   re-probes rather than skips;
2. verifies every fetch: raw CIDv1/sha2-256 against the CID multihash, and
   legacy dag-pb against the on-chain `trace_hash` without decrypting the
   envelope. A gateway serving wrong bytes is reported as `mismatch`
   immediately, with the gateway named in the log;
3. re-pins from `TRACE_ARCHIVE_DIR` through the **same** `PinProvider`s that
   published the trace, then re-probes to confirm recovery. Archived registry
   entries (`get_trace` restore requirement) and `local://` CIDs are logged and
   never flagged;
4. raises `report_unavailable` only after a trace has failed for at least
   `AVAIL_FLAG_AFTER_SECS` and across `AVAIL_FLAG_AFTER_PROBES` distinct ticks.
   A later successful probe clears the flag with `clear_unavailable`. Both
   submissions go through `ctx.submit`, and dry-run never submits.

The reporter signs with `AVAIL_REPORTER_SECRET`, a dedicated key that must be
registered on reasoning-registry by the admin
(`set_availability_reporter(reporter, true)`). It is checked at startup against
the deployment's `agent`, `agents.maker` and `agents.trader` addresses, so an
operator cannot accidentally give the availability task a trading key.
`clear_unavailable` can only deactivate an `unavail` flag raised by that same
reporter; admin flags are untouched. x402 does **not** run a monitor: the old
`x402/trace-availability-monitor.ts` scanner was dead code with no integrity
check and no bytes to re-pin, and has been removed in favour of this task.

## State archival

Soroban persistent entries can archive while a market's redemption window is
still open. Before every live submission the adapter now **prepares** the call:
it simulates, detects a restore requirement and prices it before signing.

- A Protocol 23 simulation carries an inline restore list in its transaction
  data. The rent estimate is the resource fee above the last non-restore
  simulation of the same method (or the whole fee when there is no baseline).
- If RPC returns a `restorePreamble`, the adapter journals a
  `RestoreFootprint` transaction as `${actionId}:restore` with `kind:
  "restore"`, submits it on the same source account, then **re-simulates** the
  action. The action record carries `dependsOn`; on restart,
  `TransactionJournal.resumableActions()` finds a confirmed (or hash-checkable)
  restore whose action was never confirmed and resumes it. A second restore is
  harmless on chain but is logged.
- `RESTORE_MAX_FEE_STROOPS` caps one action and `RESTORE_DAILY_BUDGET_STROOPS`
  caps one task per UTC day. Spend is persisted in the state store namespace
  `restore.spend`, so restarts cannot reset it. Over budget produces
  `NotSubmittedError("restore budget exceeded")` with the offending ledger keys
  in the log and in `onRestore` reports.
- A failure classified `archived_entry` (an entry archived between simulation
  and apply) is retried by fresh simulation up to `RESTORE_MAX_RETRIES`; the
  retry journal id carries `:retry-N`. Ambiguous submissions stay `uncertain`
  and are never retried as if they had not landed.
- Raw ledger reads check `liveUntilLedgerSeq` against the response's
  `latestLedger`. An archived entry is never returned as a live value: market
  reads surface a `market-archived` error, and `marketExposureState()` returns
  `{ archived: true }`.
- Read-only simulations report restores but never refuse a read; they surface
  archival to the caller. Temporary `Band(u64)` entries are not restorable and
  their absence is normal state. Restoring a whole contract instance is an
  operator job, not an agent budget item.

## Fees

In live mode the adapter reads `getFeeStats` before each submission and sets
the generated binding's `fee` / `timeoutInSeconds` from the configured
percentile for the action class (`trade`, `create`, `trace`, `maintenance`).
The simulated Soroban resource fee is increased by `resourceMarginBps` before
signing. Per-transaction and rolling daily caps are enforced; a JSON
`FEE_POLICY_FILE` can override any class, and `AGENT_FEE_PAYER_SECRET` names the
separate key that signs fee bumps.

Fee bumps keep the signed inner transaction and sequence number unchanged:
only the outer fee-bump envelope changes, so a bump has a new outer hash. The
transaction journal records both hashes plus the offered and charged fees;
`onFeeCharged` receives the same report for metrics. `txINSUFFICIENT_FEE`,
`txFEE_BUMP_INNER_FAILED` and `ResourceLimitExceeded` are classified as
retriable fee errors, while `txBAD_AUTH` and `txBAD_SEQ` remain terminal.

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
