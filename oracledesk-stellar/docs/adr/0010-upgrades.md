# ADR 0010: In-place upgrades, schema versioning, and migrations

## Status

Accepted. Implements [issue #18](https://github.com/OracleDesk/OracleDesk-SmartContract/issues/18).
Depends on [ADR 0002](0002-cross-contract-calls.md) (vendored cross-contract
interfaces) and is referenced by `SECURITY.md` (upgrade authority).
`docs/adr/0003-attested-outcome-migration.md` is an *application-level*
outcome migration (moving one market's resolution path between signer sets);
this ADR is the *storage-level* one. They do not overlap.

## Context

Until now none of the four contracts (`market-core`, `resolver`, `treasury`,
`reasoning-registry`) exposed an entrypoint calling
`env.deployer().update_current_contract_wasm(...)`. The only way to ship a
fix was `scripts/deploy-testnet.sh`-style redeployment, which abandons every
open market, user `Position`, committed `resolution_hash`, treasury balance
and trace history at the old address. For market-core — one instance holding
every market and one shared collateral balance — a redeploy is a hand-migration
of user funds.

Soroban supports in-place upgrades: same address, same storage, only the
executable changes. Three problems make that more than one function call:

1. After an upgrade the new code must know which storage layout it is
   reading. `#[contracttype]` structs decode strictly: `get::<_, Market>`
   on an entry written by older code *panics* on a shape mismatch. Several
   planned issues append fields to `Market`, so without versioned migration
   those changes are impossible on a live deployment.
2. `update_current_contract_wasm` deliberately does not run a constructor;
   the swap itself initialises nothing.
3. `resolver` and `treasury` hold compiled copies of market-core's
   interface (ADR 0002). They keep calling the *old* view of market-core
   until they are themselves upgraded with a refreshed vendored wasm.

## Decision

### The mechanism (all four contracts)

- `pub const SCHEMA_VERSION: u32` is the schema version compiled into the
  build. `DataKey::SchemaVersion` (instance, `u32`) records the version the
  instance's *storage* conforms to; it is written by `__constructor` and
  read with `unwrap_or(1)`, so deployments predating this ADR are treated
  as version 1. `schema_version()` exposes it.
- `upgrade(new_wasm_hash: BytesN<32>)` is gated by the contract's existing
  `require_admin` (the two-step `propose_admin`/`accept_admin` handover of
  #62 governs who holds that key), swaps the executable, and emits
  `Upgraded { old_version, new_wasm_hash }`. It changes no storage.
- `migrate(batch: u32) -> MigrationProgress` converts persistent entries
  toward `SCHEMA_VERSION` in caller-sized, resumable, idempotent batches
  tracked by the single `DataKey::MigrationCursor` instance key
  (`{ from_version, next_id, done }`), emitting `Migrated { from_version,
  to_version, processed, done }` once per call. It is admin-gated like
  `upgrade`: each batch writes storage, and the loop is driven by
  `scripts/upgrade.sh`, which runs as the admin. Only a *finished* pass may
  advance `SchemaVersion` — until then old and new entries genuinely
  coexist and a retry must resume from the stored cursor, not restart.
- Adding only two instance keys per contract (`SchemaVersion`,
  `MigrationCursor`) keeps the shared instance entry small; instance
  storage is one budget, and per-market state stays persistent.

### market-core specifics

- The batch loop iterates the only enumerable id space there is, market ids
  `cursor.next_id .. min(next_id + batch, NextId)` (`DataKey::NextId` bounds
  it; ids are dense).
- `Position` entries are keyed `(market_id, holder)` and cannot be
  enumerated on-chain. Two seams exist: conversion *lazily* wherever a
  position is loaded, and `migrate_positions(keys: Vec<(u64, Address)>)`,
  driven by an indexer replaying `Trade`/`Redeemed`/`PositionTransferred`
  events. A `Position` schema change picks between them exactly as the
  `Market` change below does.
- State-changing entrypoints (`do_buy`/`do_sell` behind
  `buy`/`buy_v2`/`sell`/`sell_v2`, `resolve`, `void_market`, `redeem`,
  `claim_pool_remainder`, `sweep_fees`) call `ensure_migrated(market_id)`
  before touching an entry. It converts the single entry in place.
  **Rejected: the `MigrationInProgress` error.** A gated entrypoint turns a
  stalled or abandoned batch into frozen markets: whoever runs the batches
  becomes a liveness dependency for user funds. Lazy conversion makes the
  batch loop a pure optimisation — nice for spreading cost, never
  required. The fast path with no upgrade pending is one read of an
  already-warm instance key.

### Detecting old-shape entries: the explicit version key

Each market entry carries `DataKey::MarketVersion(u64)` (persistent),
written by `create_market` and by every migration step; absence means
version 1. `legacy::MarketV1` freezes the v1 `Market` shape so a v2 has
something to decode old bytes with.

**Rejected: `try_from_val` probing.** Reading the raw `Val` and attempting
`MarketV1::try_from_val` then the current type was the alternative. It is
ambiguous in exactly the case that matters most — a *field-appending*
change, where the old decoding of a new entry can succeed by accident on
the shared prefix — and it puts a decoder-fallback maze on the hot path of
every read. The version key costs one extra persistent entry per market —
bounded, deterministic, and greppable by operators mid-migration. We chose
unambiguity.

### Vendored-interface compatibility rule

market-core speaks to the world through copies of its interface compiled
into resolver, treasury and router (ADR 0002). The rule those copies force:

- A market-core upgrade **may** add entrypoints, append `Error`/`DataKey`
  discriminants at the tail (never renumber or reorder), and append fields
  to structs *that resolver/treasury do not decode*.
- It **must not** change the signature of any function those contracts
  call — `get_market`, `resolve`, `void_market`, `create_market`, `buy`,
  `sell`, `redeem`, `claim_pool_remainder`, `sweep_fees` — nor change the
  shape of the `Market` struct resolver decodes from `get_market` *until
  resolver itself has been upgraded with a refreshed* `market_core.wasm`.
  Appending a `Market` field is therefore a *two-step* change: upgrade
  market-core (compatible view — old entries still decode for consumers'
  stale copies only while they still match the frozen shape; this is why
  migrations must be written append-then-migrate, never in place), then
  upgrade resolver and treasury.
- `scripts/upgrade.sh all` hard-codes that order: market-core, resolver,
  treasury, reasoning-registry.

### Why `upgrade` runs no migration and no constructor

`update_current_contract_wasm` takes effect on the next invocation, so the
admin who calls `upgrade` still runs *old* code; any migration it performed
inline would use the old ruleset's assumptions about the new layout.
Constructors run at deploy time precisely so nobody can initialise between
deploy and the first call — there is no deploy-time hook to reuse in a
swap, so `migrate` owns all initialisation of the new version, and `upgrade`
stays one gated storage write plus the swap. The pair's only bookkeeping is
the `Upgraded` event, which is what makes the swap auditable.

### Authority and trust trade-off (read this in `SECURITY.md` too)

The admin key of each of the four contracts can now upgrade to *arbitrary
wasm*: a compromised key replaces all logic and can drain market-core's
collateral and the treasury's vault outright — strictly more power than any
single configuration entrypoint this ADR sits beside. This is the accepted
cost of upgradability; it is stated plainly rather than glossed.
Non-goals of this change, tracked elsewhere: timelock/multisig over the
upgrade authority (#61, #62 — the two-step `accept_admin` handover at least
means upgrades cannot be redirected to a mistyped key), and reproducible
builds / on-chain wasm-hash verification (#57, #126). Until those land,
`deployments/<network>.json` records each contract's `wasm_hashes` and
`schema_versions` via `scripts/upgrade.sh` so operators can diff what is
actually deployed against what the repo built.

### Testing the seam without a second wasm

**Constraint:** this repo commits seven cross-contract `*.wasm` blobs plus
`.sha256` pins built by a toolchain we cannot reproduce on our machines
(CLI 22.x vs expected 27.1), so *no contributor PR can add a committed v2
blob or a `make` target that produces one*. The mechanism is therefore
tested source-only: market-core carries a `test-v2` Cargo feature (no
dependencies; touches `Cargo.lock` and no wasm) that flips
`SCHEMA_VERSION` to 2 with the entry shapes unchanged, so the cursor, the
bounded batches, the stamping and `ensure_migrated` run through a genuine
pending migration. A real v2 bumps the constant for the default build,
replaces the identity in `legacy::market_v1_to_current`, and promotes the
feature-gated `from_version == 1 && to_version == 2` arm of
`migrate_market_entry` to an unconditional one — that arm is written in
exactly the shape a real conversion needs, so nothing else changes. What
this
deliberately does not do is claim the "populated v1 deployment upgraded to
a *real* v2 build, state compared byte-for-byte" host test ran: it needs a
v2 blob, and the honest answer for now is the sentence in the PR body.

## Consequences

- Every future storage-shape issue must come through this mechanism:
  bump `SCHEMA_VERSION`, freeze the old shape in `legacy`, add one
  conversion arm, and keep the change append-only for vendored consumers.
- The mechanism itself is shipped dead-but-tested: today
  `from_version == SCHEMA_VERSION == 1` makes `migrate` an identity pass
  that records the cursor. That is intentional — an untested migration
  path is a broken migration path.
- Generated TypeScript bindings must be regenerated after merging (the
  four new entrypoints per contract are additive; see
  `scripts/gen-bindings.sh`), which the acceptance criteria for #18 ask
  for but which — like the wasm blobs — must happen in a build environment
  that can produce the pinned artifacts.
