# ADR 0008: Governance timelock owns the admin role

## Status

Accepted.

## Context

ADR 0007 gives each contract a rotatable admin, but a single admin key is
still an instant, unilateral actor: it can set fees, move the resolver and
treasury wiring, pause markets, register agents and sweep the protocol's
share. Worse, the same key that decides *what* happens also decides *who*
holds the keys — nothing slows down a bad or compromised admin, and users get
no warning before a configuration change lands.

Putting a delay between proposal and execution is the standard mitigation: a
change becomes visible on-chain before it can take effect, so users can exit
and the canceller can stop a malicious operation.

## Decision

Add a `timelock` contract (`contracts/timelock`) and point the core contracts'
admin at it.

### Roles

The timelock separates powers, so no single key can both act and stop an
action:

- **admin** — the ultimate authority; may `set_roles`, `set_delay` and
  `set_default_delay` (decrease). Delays for existing operations cannot be
  shortened, and the global delay **cannot be increased** by the admin alone —
  that must be a scheduled self-call, so an operator cannot silently extend
  in-flight operations.
- **proposer** — calls `schedule`.
- **canceller** — calls `cancel`. Meant to be a watchdog, not the proposer.
- **executor** (optional) — calls `execute`; when unset, anyone may execute.
- **emergency** (optional) — may call `emergency` to bypass the delay for a
  small allow-list.

Roles are addresses, so each can independently be a multisig account
(ADR 0007).

### Scheduling and execution

`schedule(target, fn_name, args)` records
`Operation { proposer, target, fn_name, args, eta = now + delay,
expires = eta + EXECUTION_GRACE }` and emits `OperationScheduled`. The delay
is the larger of the global floor and any `(target, fn_name)` override.

`execute(id)` runs a due operation and emits `OperationExecuted`. The record
is removed **before** the call: a revert rolls storage back (the operation
stays pending), while success cannot be replayed. After `expires`
(`EXECUTION_GRACE` = 7 days past `eta`) the operation is dropped as
`OperationExpired`.

`cancel(id)` removes an operation, canceller only, and emits
`OperationCancelled`. `emergency(target, fn_name, args)` skips the delay for
`set_paused(true)` and `cancel_proposal` only — the calls that *reduce* risk —
and emits `EmergencyExecuted`.

Bounds: `MIN_DELAY = 1 day`, `MAX_DELAY = 30 days`,
`EXECUTION_GRACE = 7 days`.

### Wiring it in

`scripts/deploy-testnet.sh --timelock` (or `USE_TIMELOCK=1`) deploys the
timelock first and passes its address as `--admin` to `market-core`,
`resolver`, `treasury` and `reasoning-registry` in their constructors, so they
are timelock-governed from birth. Because turning on the delay makes the
script's own admin setup calls (wiring handshake, agent registration, agent
policies) timelocked, the flag is off by default; the script prints the
`schedule`/`execute` pair an operator must run, and the full procedure is in
this ADR. `scripts/wire-timelock.sh` moves an *existing* deployment to the
timelock through the two-step admin transfer instead.

Operators run admin actions through `scripts/governance/timelock-cli.ts` (see
`docs/governance-cli.md`): `propose` encodes the call from the target contract's
spec, simulates it as the timelock, checks the on-chain spec and auth tree, then
`schedule`s it as the proposer; `status` tracks `eta`/`expires`; `execute` runs
it after the delay (executor or anyone). The CLI writes reviewable proposal
records under `governance/proposals/<network>/` and refuses non-unit returns,
unsupported self-calls and spec drift. Multisig signer weights enforce the
thresholds on each role's `require_auth`.

## Consequences

- No single key can reconfigure a live market instantly; every change is
  announced `MIN_DELAY` or more before it lands.
- A watchdog (canceller) can veto a scheduled operation; the risk-reducing
  calls remain fast through `emergency`.
- The admin role is now the timelock, so the deployer EOA cannot act after
  handover. Operators must go through schedule/execute for every admin call,
  which is slower but auditable.
- The timelock itself has a two-step, expiring admin transfer like the other
  contracts, so controlling it can also be moved to a multisig.

## Formal model

The timelock is model-checked in
[`docs/formal/governance.tla`](../formal/README.md#governance-model): `eta`,
expiry, cancel-wins and the emergency allow-list hold. The model also documents
the residual trust in the timelock **admin** (finding G4): `set_roles`,
`set_delay` and lowering `set_default_delay` are instant, so one compromised
admin key can make itself proposer and canceller, move the watchdog out of the
way, and execute a configuration change after only the minimum delay
(`governance_single_key.cfg`, `model_trace_timelock_admin_set_roles_instant`).
With the timelock as its own admin and `execute` handling the `set_roles` /
`accept_admin` self-calls, no single key has instant power
(`governance_selfadmin.cfg`); today `execute` supports only `set_default_delay`,
so that handover cannot happen yet
(`model_trace_timelock_cannot_accept_its_own_admin`).
