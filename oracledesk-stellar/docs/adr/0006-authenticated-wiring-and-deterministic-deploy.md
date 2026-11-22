# ADR 0006: Authenticated resolver/treasury wiring and deterministic deploys

## Status

Accepted.

## Context

`market-core` gives two addresses special power: the **resolver**, which alone
may call `resolve` and `void_market` (and so decides every payout), and the
**treasury**, which receives all swept fees through the permissionless
`sweep_fees`. Historically both were set by the admin with no checks:
`set_resolver` / `set_treasury` only called `require_admin`, stored the raw
address, and emitted no event. Nothing verified that the new address was a
contract, that it was a resolver, or that it was configured for *this*
market-core.

The deploy script made this worse. It deployed `market-core` with the
deployer's own EOA as both `--treasury` and `--resolver` (the real contracts
did not exist yet), then deployed resolver/treasury/registry, and only at the
end replaced the placeholders. Between those steps the deployer EOA could
resolve or void any market. Because the script is idempotent and partial
states are expected, a failure partway could leave that window open
indefinitely.

## Decision

### Two-step, contract-authenticated wiring

`market-core` no longer exposes `set_resolver` / `set_treasury`. The
replacement is a handshake where the downstream contract has to prove the
relation:

1. `propose_resolver(resolver)` / `propose_treasury(treasury)` — admin only,
   stores `DataKey::PendingResolver` / `DataKey::PendingTreasury`, emits
   `ResolverProposed` / `TreasuryProposed`.
2. The proposed contract calls `market-core.accept_resolver()` /
   `accept_treasury()` (through its own `accept_market_core_role`
   entrypoint). `accept_*` calls `pending.require_auth()` and rejects the
   change with `InvalidWiring` unless the caller's `market_core()` view equals
   `env.current_contract_address()`. On success it emits
   `ResolverChanged { old, new }` / `TreasuryChanged { old, new }`.

A plain EOA cannot accept (it has no `market_core()` view), and a resolver or
treasury configured for a different market-core is rejected. Every change is
observable through the proposal and change events.

### Deterministic addresses

The contract id of a `stellar contract deploy --salt` is a pure function of
(network, source account, salt) — it does **not** depend on the constructor
arguments. `scripts/deploy-testnet.sh` therefore:

1. predicts the resolver and treasury ids from their salts,
2. deploys resolver and treasury (they only need market-core's *predicted* id),
3. deploys market-core with the real resolver/treasury addresses in the
   constructor, so no placeholder is ever stored,
4. runs the propose/accept handshake to authenticate the wiring and emit the
   change events.

The resolver and treasury constructor arguments reference the predicted
market-core id, which is likewise stable. Salts are recorded under `.salts` in
`deployments/testnet.json`.

## Migration

A deployment created before this ADR stored the deployer EOA and used the
removed setters. `scripts/migrate-market-core-wiring.sh` reads the live
`get_config()` and, if the wiring is not already authenticated, runs the
propose/accept handshake for the recorded resolver and treasury. Running it
against an already-authenticated deployment is a no-op.

## Consequences

- Resolution authority can no longer change hands silently: it is proposed,
  authenticated by the receiving contract, and announced.
- The deploy-time window in which the deployer EOA could resolve is gone;
  market-core is born pointing at the real contracts.
- A stale `deployments/testnet.json` from before this change no longer
  suffices; the migration script (or a redeploy) is required.

## Formal model

The wiring handshake is model-checked in
[`docs/formal/governance.tla`](../formal/README.md#governance-model). The model
found that the handshake as written **cannot complete for a contract peer**
(finding G1): `Resolver::accept_market_core_role` calls `accept_resolver`, which
calls back into the resolver for `market_core()`, and Soroban rejects that
re-entry with `Error(Context, InvalidAction)` (replayed against real wasm by
`model_trace_wiring_callback_reenters`). The treasury has no
`accept_market_core_role` at all. The model validates the repair: market-core
drops the callback and relies on `pending.require_auth()`, while the peer
asserts its own `market_core()` before calling (`WIRING_MODE = "PeerAsserts"`).
It also found that `PendingResolver` / `PendingTreasury` never expire (G3).
These are findings, not fixes: no contract behaviour changed.
