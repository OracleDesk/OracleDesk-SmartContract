# ADR 0010: In-place contract upgrades and versioned schema migration

## Status

Accepted. Implements issue #18 on `market-core` and `resolver`, completed on
this branch for `treasury` and `reasoning-registry` — all four contracts now
carry the mechanism (the original "Deferrals" note claimed otherwise; it was
rewritten where it belongs, see below and the PR #237 body).

**Numbering deviation:** #18 asked for this document as
`docs/adr/0003-upgrades.md`. That number (and filename) is already taken by
[ADR 0003: `AttestedOutcome` and the attestation storage
migration](0003-attested-outcome-migration.md), which this ADR *depends on* —
resolver's migration steps are that document's eager half. The next free number
is 0010, so this is ADR 0010. No other ADR in `docs/adr/` references 0010 yet.

## Context

Soroban supports in-place contract upgrade via
`env.deployer().update_current_contract_wasm(hash)`. OracleDesk had no way to
use it: repo-wide, at the base of this work (`655974c4`), `upgrade`,
`DataKey::SchemaVersion`, `update_current_contract_wasm` and `fn migrate` all
had exactly zero occurrences. Every fix therefore meant redeploying to a fresh
contract id and losing storage, which for `market-core` means losing live
markets, positions, and collateral accounting.

Three properties of `update_current_contract_wasm` shape the whole design:

1. **The new version's `__constructor` does not run.** The wasm swap replaces
   the code; initialization is not re-executed. Anything a new build must
   create — a version stamp, migrated entries, new default keys — has to happen
   in a migration entrypoint, never in a constructor.
2. **Storage, keys, TTLs, the admin role and the ledger footprint survive the
   swap untouched.** So the schema version read *before* the swap is exactly
   the version the *new* code must migrate from. `Upgraded` records it at that
   moment.
3. **An instance whose stored shape has moved on while its code has not (or the
   reverse) traps mid-transaction**, and a `get::<_, T>()` on a value that no
   longer decodes aborts the *caller's* transaction — including an unrelated
   user's `redeem`.

Layered on top of that is this repository's own coupling: per ADR 0002,
`resolver`, `treasury` and `reasoning-registry` do not depend on the
`market-core` crate; they vendor
a compiled `market_core.wasm` and generate their client from it with
`contractimport!`. `resolver`'s and `treasury`'s `build.rs` pin that blob by
sha256 (ADR 0002, #58 — `reasoning-registry` vendors the same way but has no
pin yet), so
it is refreshed only by `make build` / `scripts/sync-vendored-wasm.sh`, which
needs a Stellar CLI version this dev box does not have. **Changing a struct that
another contract decodes is therefore a build break for that other contract, not
just a storage migration.** That constraint is the reason for the compatibility
rule below.

## Decision

### 1. Upgrade policy and authority

Each contract gains an admin-gated `upgrade(env, new_wasm_hash) -> Result<(),
Error>` that calls `require_admin` (the same two-step, timelock-capable admin as
every other privileged entrypoint — ADR 0007, ADR 0008), swaps the wasm, and
publishes `Upgraded { old_version, new_wasm_hash }`. `new_wasm_hash` is the
sha256 of an *already-installed* wasm on this network, not a file path;
`scripts/upgrade.sh` performs the `stellar contract install` first.

**Say the quiet part plainly.** This gives the admin role the ability to replace
the contract's code with *arbitrary* code. Code that can do anything the
contract can do to storage and to tokens held by the contract — including
dripping every market's collateral to the admin. An in-place upgrade is not
"patching the contract"; it is handing the new code the contract's entire asset
base and its hash-committed history (ADR 0001), with no way to roll back, since
the old code may already have rewritten storage the new code cannot decode.

Accepted risk position, stated for the record:

- The mitigation is procedural, not technical, and it is ADR 0008: on any
  network where real value exists, the admin is the governance timelock, so an
  upgrade is subject to the timelock delay and is visible before it can execute.
  `scripts/upgrade.sh` calls the privileged functions through the timelock
  whenever `TIMELOCK` is set in the deployment record.
- Verification burden sits on the *operator*: the wasm hash being installed must
  come from a reproducible build of a reviewed commit. `scripts/check-wasm-determinism.sh`
  (ADR 0002) is what makes that claim checkable at all.
- On testnet, where `docs/STATUS.md` already declares the protocol unaudited,
  `upgrade` is called directly by the deployer identity.

**SECURITY.md reference: yes, and this PR adds it.** `SECURITY.md` already
documents the `treasury` admin and the guardian trust model, so an entrypoint
that lets the admin replace all contract logic belongs in the same place, and
its scope section should list "the upgrade path (`upgrade` / `migrate`)" so a
researcher knows an authorization bug there is in scope. The addition is a
pointer plus the plain sentence above, not a rewrite of the policy; the
reasoning stays in this ADR.

### 2. Vendored-interface compatibility rule

`market-core`'s external surface may change under an upgrade only in ways that
do not invalidate a vendored `market_core.wasm`:

- **May not** change the signature or the return shape of any entrypoint another
  contract decodes: `get_market`, `resolve`, `void_market`, `create_market`,
  `buy`, `sell`, `redeem`, `claim_pool_remainder`, `sweep_fees` — nor any struct
  those signatures expose, above all `Market` and its `MarketStatus`.
- **May** add entrypoints, add `DataKey` variants, and append `Error`
  discriminants.
- **Must not** renumber or insert into an existing `DataKey`/`Error` sequence:
  `#[contracttype]` enums encode positionally, so an insertion silently rewrites
  every key after it, and `#[contracterror]` discriminants are the on-wire
  error code that callers map. Both tails are append-only, permanently.

A schema bump that genuinely needs a new `Market` shape therefore gets a **new
key and a new type** (`DataKey::MarketV2(id)` / `MarketV2 { v1, schema }`) and
leaves `DataKey::Market(id)` readable — a compatibility view. `Market` itself
never changes shape in place, in this or any future version.

### 3. Upgrade order

Because the compatibility view keeps the old key readable, the safe order is:

1. **`market-core` first.** It writes only new keys and keeps every old one
   decodable, so a not-yet-upgraded `resolver`/`treasury` (whose vendored blob
   describes the *old* interface) keeps working across the swap.
2. **Then `resolver`, `treasury` and `reasoning-registry`.** They may now adopt
   the new interface, after `make build` refreshes their vendored blobs
   together with their sha256 pins.

The reverse order breaks: an upgraded `resolver` compiled against a v2
`market-core` interface would be calling a contract that still has v2 entrypoints
that do not exist, and its `build.rs` pin would not match the deployed wasm.

`scripts/upgrade.sh` takes exactly one contract per invocation and drives all
four (`market_core`, `resolver`, `treasury`, `reasoning_registry` — aliases
`market-core`/`core` and `registry`/`reasoning-registry` normalise to the
deployment-record key); `router` and `timelock` still refuse, because their
crates carry no `upgrade`/`migrate`/`schema_version` entrypoints at all on this
base. So the order is enforced by the operator driving it contract-by-contract;
the script does not attempt to sequence a multi-contract fleet on its own. It
does add an ADR 0010 §3 *reminder*: when a non-market-core contract is
upgraded while the record shows no prior market-core upgrade, the script logs a
loud warning rather than silently allowing out-of-order releases.

### 4. Version stamping and reading it

`SCHEMA_VERSION` is a compile-time constant of the *code*, not of the storage.
`DataKey::SchemaVersion` (instance storage) records the version the data is
currently at, stamped by `__constructor` for new deployments and by the last
`migrate` batch for upgraded ones.

Pre-existing deployments have no such key — `__constructor` already ran, and
upgrade does not re-run it. `load_schema_version` therefore reads an absent key
as `PRE_VERSIONING_SCHEMA_VERSION` (= 1) instead of returning
`Error::NotInitialized`: an unversioned instance is v1 data, and treating it as
"unknown" would make `schema_version()` unusable as the script's precondition
check, which is precisely the call that has to work on the instance about to be
upgraded.

`schema_version(env) -> u32` is a public read for that purpose (market-core
`contracts/market-core/src/lib.rs:640`, resolver `contracts/resolver/src/lib.rs:845`,
treasury `contracts/treasury/src/lib.rs:2671`, reasoning-registry
`contracts/reasoning-registry/src/lib.rs:1900`).

### 5. Bounded, resumable, idempotent `migrate`

`migrate(env, batch) -> Result<MigrationProgress, Error>`, admin-gated because
it walks every entry:

- **Bounded**: `batch == 0 || batch > MAX_MIGRATION_BATCH` (= 50) is
  `Err(Error::MigrationBatchTooLarge)` — an error, not a trap. A too-large batch
  would exceed the instruction/ledger limits mid-loop, which is unrecoverable
  from the caller's side and leaves the transaction rolled back with no signal.
  market-core `:273`, resolver `:380`, treasury `migrate` at `:2733`,
  reasoning-registry `migrate` at `:1963`.
- **Resumable**: `DataKey::MigrationCursor { from_version, next_id, done }` is
  the resume point. A cursor whose `from_version` no longer matches the stored
  version is discarded and the sweep restarts from 0 — correct because every
  step is idempotent, and cost is reads, not double-writes.
- **Idempotent**: the *target* entry doubles as the "already done" marker
  (`storage.has(&DataKey::MarketV2(id))`, `!storage.has(&DataKey::ProposalV2(id))`,
  and in the completion `storage.has(&DataKey::ExposureV2(id))` /
  `storage.has(&DataKey::TraceV2(id))`),
  and a legacy key is removed only in the same call that folds its value into
  the new one. That is ADR 0003's existing "nothing is ever counted twice"
  invariant, reused rather than restated.
- **Termination signal**: `migrate` returns a `MigrationProgress` struct and
  publishes `Migrated { from_version, to_version, processed, done }` on every
  batch, so an indexer can follow a long migration instead of only seeing its
  end. Returning the struct rather than only emitting an event is what lets
  `scripts/upgrade.sh` loop on `done` **without parsing ScVal debug output** —
  the CLI's event rendering is not a stable machine interface. A partial sweep
  leaves `SchemaVersion` alone; the version flip *is* `done`.
- **No-op when current**: if the stored version is already `>= SCHEMA_VERSION`,
  `migrate` returns `done: true` immediately and never rewinds. This is what
  makes the script's `upgrade && migrate` sequence safe to run unconditionally.

### 6. Gating: lazy per-entry, not `Error::MigrationInProgress`

Every path that touches a market's state calls `ensure_entry_migrated(env,
market_id)` before it reads that market:

| contract | call sites |
| --- | --- |
| market-core | `do_buy` `:1037`, `do_sell` `:1172`, `resolve` `:1243`, `void_market` `:1264`, `redeem` `:1285` |
| resolver | `submit_signatures` `:1692`, `finalize_signers` `:1761`, `record_attestation` `:2736` (covers `attest` / `attest_with_evidence`) |
| treasury | `reserve_capacity` `:3623` (reached by every authorised buy), `close_market_exposure` `:4155` (sells/redemptions, and `realize` through it), `settle_market` `:2203` |
| reasoning-registry | `consume_trace` `:788` (the gate every consumer passes before acting), `flag_trace` `:831` (the admin integrity path) |

It reads `SchemaVersion` once, returns immediately when the instance is current
(always, in the shipped v1 build — the cost is one instance read that these
callers mostly pay anyway), and otherwise migrates exactly the entry the caller
is about to use and continues.

**The issue's alternative — returning `Error::MigrationInProgress` until the
admin has finished the sweep — was considered and rejected.** It makes user
funds and in-flight settlements hostage to an admin transaction: a stalled,
unaffordable, or simply-never-run batch would freeze `redeem` and `finalize_signers`
for everyone, and a half-finished sweep becomes a liveness incident rather than
a backlog. It also needs extra state (a flag distinguishing "migrating" from
"current") and has to be checked on every gated call, which is the same read the
lazy path performs. The eager admin sweep is retained as the *preferred* path —
it amortises the work off user transactions and bounds how long any entry stays
in the lazy state — but correctness never depends on it running.

### 7. Old-shape detection, and why there is no per-market version key

Detection reads the source entry as an opaque `soroban_sdk::Val` and attempts
the decode (`<Market as TryFromVal<Env, Val>>::try_from_val`) rather than
`get::<_, Market>()`. Consequences that a typed get does not give:

- an entry of a shape this build cannot decode **falls through** instead of
  trapping the whole transaction (a batch that aborts at market 4,000 of 40,000
  is worse than no batch), and
- "cannot parse" stays distinguishable from "not migrated yet": an undecodable
  entry is **left alone for a human**. Rewriting bytes we cannot parse is how a
  migration turns one corrupt entry into a lost one.

The rejected alternative was a `DataKey::MarketVersion(u64)` per market. Storage
cost decides it: each such key is an extra *persistent* ledger entry per market,
so the fleet's footprint roughly doubles for a fact that is derivable — the
presence of the v2 entry *already* records the per-entry version, which is the
idempotence marker from §5. A per-market key would additionally need its own TTL
management (it is written before the entry it describes, so it must be extended
in a path whose entry may not exist yet) and it can drift out of agreement with
the data it labels if a step writes one and traps before the other. The global
bound that *is* needed (`SchemaVersion`) lives once, in instance storage. The
residual cost of the choice is that "un-migrated" and "never existed" are
indistinguishable without reading the entry; `migrate` resolves that by walking
the id range `[0, NextId)` rather than probing per market, so the read is paid
once per entry either way.

### 8. Instance TTL in every path that writes instance keys

Instance storage entries share one durability footprint: a write only protects
its own TTL window, so the instance must be extended where it is written or the
new keys become the first keys this contract ever let expire unnoticed.

- market-core's `instance_get` already extends on every read, so the write paths
  add one `extend_ttl(BUMP_THRESHOLD, BUMP_TO)`: `migrate` after its
  `SchemaVersion`/`MigrationCursor` write (`:739-745`), and `ensure_entry_migrated`
  after a lazy persistent write (`:1667`).
- resolver's `instance_get` does **not** bump (a gap this work found, not
  introduced): every resolver path that writes an instance key now calls
  `bump_instance_ttl` (`:1976`) — including `__constructor` (`:758`), which is
  why the constructor comment says so out loud, and the lazy path at `:2028`.
- treasury and reasoning-registry have the same gap in a sharper form: no
  instance read in either contract ever bumped (treasury's `require_admin`
  reads the admin key and extends nothing), and an expired `SchemaVersion`
  silently decodes back to v1, which would make a pending migration look
  already-done. Both therefore write instance keys only through paths that
  call `bump_instance_ttl` (treasury `:2815`, registry `:2045`) — the
  constructor stamp, `schema_version`, every `migrate` batch, and the lazy
  step after it migrates an entry.

`BUMP_THRESHOLD`/`BUMP_TO` are the existing 30-day/60-day constants per contract
(market-core `:24-25`, resolver `:50-51`); nothing here changes the TTL policy.

### 9. Test surface without a second deployed blob

To make migration steps *reachable* from tests without shipping a second wasm,
each crate opts into a `test-v2` feature (`[features] test-v2 = []` in all four
Cargo.tomls). With it, the same crate compiles "as the next version":
`SCHEMA_VERSION = 2`, the v2 key/type exists (`DataKey::MarketV2`, `MarketV2`;
resolver's `ProposalV2`/`CountV2` paths), and `migrate_from` gains its 1→2 step.
Without it — the shipped build — `SCHEMA_VERSION = 1`, the v2 type is not
compiled, `migrate_from`'s body is `let _ = (...)` and `migrate` returns early,
so the default build's storage layout stays **byte-for-byte** what the vendored
`market_core.wasm` describes (§2) and gains no cross-contract dependency:
resolver's `migration_bound` (`:1998`) reads market-core's `market_count` only
under `test-v2`, with an `Ok(0)` stub in the default build (`:2010`) that keeps
the sweep code identical in both. treasury copies that split exactly
(`:2837` / `:2853`), because its sweep bounds itself by the same
cross-contract `market_count`. reasoning-registry is the divergence worth
naming: it *owns* its sweep range — trace ids come from its own instance
`DataKey::NextId` — so its `migration_bound` (`:2068`) is a plain local read
in both builds and needs no stub at all. The bound should be whatever the
contract can enumerate without borrowing another contract's word.

`migration_bound`'s stub is a load-bearing pattern worth repeating to future
contributors: returning `Ok(0)` there is safe *only* because `migrate` exits
before it when the version is current. A real v2 build must implement the real
bound — a read failure is an error, never a zero, because a zero bound makes
`migrate` report `done` and flip the version while nothing was migrated.

### 10. Caveat: resolver's dedupe flags are not swept

`DataKey::Attestation(market_id, outcome, signer)` is keyed by an address the
contract cannot enumerate, so an eager sweep cannot reach it. It stays on ADR
0003's lazy `has_attested` read, which is not gated on the schema version. A
`done` sweep therefore means "**everything enumerable is converted**", not "no
legacy key exists anywhere". Any future audit of migration completeness must
check the lazy path, not only the cursor.

The completion extended the same caveat to the other two contracts rather than
pretending coverage it does not have:

- **treasury** sweeps `[0, market-core.market_count)` of the *original core's*
  per-market exposure keys (`Market(id)`/`Net(id)`). Exposure under the
  namespaced `MarketV2(Address-ish, u64)`/`NetV2` keys belongs to cores switched
  to after those keys existed and has no legacy shape to move; agent-, ticket-
  and share-keyed state lives in address spaces the contract cannot enumerate
  and is covered by the lazy path on the three trade entrypoints only.
- **reasoning-registry** sweeps `[0, NextId)` of its own trace ids — one
  enumerable range it owns end to end. Address-keyed state (`Agent`,
  `AgentHead`, `AgentTrace*`, `Consumer`, the signing-key indexes) and the
  market/action index keys (`MarketTrace*`, `MarketActionTrace*`) are not
  enumerable from inside the contract; under the append-only projection they
  have no v1→v2 shape change today, and any future step that gives them one
  must use the lazy-convert / indexer-key-list approach this section already
  records for resolver's dedupe flags — a bounded id sweep demonstrably does
  **not** cover them.

## Consequences

- Upgrades become possible without a new contract id, which also means the
  protocol's immutability story is now explicitly "admin + timelock + a
  reproducible build", not "the code cannot change". SECURITY.md says so.
- `DataKey` and `Error` tails grow monotonically and may never be reordered.
  market-core appends `SchemaVersion`, `MigrationCursor`, `MarketV2(u64)`
  (`:209`, `:212`, `:219`) after `Band(u64)`, and `MigrationBatchTooLarge = 30`
  (`:273`); resolver appends `SchemaVersion`, `MigrationCursor` (`:434`, `:437`)
  and `MigrationBatchTooLarge = 50` (`:380`). treasury appends `SchemaVersion`,
  `MigrationCursor`, `ExposureV2(u64)` (`:540`, `:543`, `:554`) after
  `YieldPrincipal`, and `MigrationBatchTooLarge = 60` (`:637`) after
  `InvalidResolution = 48` — leaving `49..=59` for the concurrent #20 lane and
  touching its existing `CategoryCapExceeded = 2029` not at all.
  reasoning-registry appends `SchemaVersion`, `MigrationCursor`, `TraceV2(u64)`
  (`:244`, `:247`, `:253`) after `MarketActionTraceAt`, and
  `MigrationBatchTooLarge = 3010` (`:313`) — starting past `3009` because the
  registry's own `Error` series is 3001-based and `13..=3000` is left
  unassigned for the undeclared variants this tip references (PR body, registry
  report).
  **The gap is deliberate:** PR #184 owns `DataKey::MarketHot`/`MarketCold` and
  `Error::MetaUriTooLong = 27`, and other open lanes want 28/29 in market-core
  and 44–49 in resolver. Numbers 27..=29 (market-core) and 44..=49 (resolver)
  are left unassigned here so those lanes can append without renumbering
  anything. Because both tails are appended at the same place, this PR **does
  conflict mechanically with #184** — one hunk in `DataKey`, one in `Error`; the
  resolution is "keep both, ours first, theirs appended", which is mechanical
  and preserves every existing discriminant. This branch is not based on #184.
- Tests are split by build: `contracts/market-core/src/tests_upgrade.rs`,
  `contracts/resolver/src/tests_upgrade.rs`, `contracts/treasury/src/tests_upgrade.rs`
  and `contracts/reasoning-registry/src/tests_upgrade.rs` are `#[cfg(any(test,
  feature = "test-v2"))]` modules; cross-version cases are additionally
  `#[cfg(all(test, feature = "test-v2"))]`, so the default `cargo test`
  selection is not widened by a feature that changes storage layout.
- The v1→v2 cross-version test for `market-core` upgrades to a wasm read from
  `ORACLEDESK_MARKET_CORE_V2_WASM` (a `make build`-produced path), **not**
  committed and **not** `include_bytes!`'d — zero `.wasm` in this diff (see
  Verification).
- **Deferrals — corrected on this branch.** The original text deferred
  `treasury` and `reasoning-registry` claiming `treasury` "does not compile at
  this base (five duplicate `Error` discriminants, E0081)". That was measured
  false: `treasury`'s `Error` enum at the base has 48 variants with **zero**
  duplicate discriminants. Both contracts are now implemented here (commits
  `72bb6fd`, `4c62eeb`, `097afdf`). What is *actually* true — and was always
  the honest blocker — is shared by all four contracts and recorded in the PR
  body's Verification section: nothing in this workspace can be compiled at
  all, because the pinned toolchain (rustc 1.90.0) is below `soroban-sdk`
  27.0.6's MSRV (1.91), and the `+stable` fallback dies on 21 pre-existing
  `oracledesk-types` errors before reaching any contract. `reasoning-registry`
  additionally does not *parse* at this base for reasons unrelated to #18 (the
  PR body's registry report); its new tests are authored against the repaired
  file and disclosed as never executed.
- Verification status: **nothing in this PR has been compiled or executed.** The
  repository does not build at its base commit for reasons unrelated to this
  work (see the PR body's Verification section); the executable evidence is
  `scripts/upgrade.sh` (G1) plus git-level gates.

## Follow-ups

1. ~~`treasury` + `reasoning-registry`: same mechanism~~ — **done on this
   branch** (issue #18 completion). The remaining piece for both is the
   workspace build itself: run `cargo test -p treasury --features test-v2` and
   `cargo test -p reasoning-registry --features test-v2` the moment the
   toolchain and `oracledesk-types` walls come down, plus repair the registry's
   pre-existing parse damage first (PR body's registry report).
2. Add `--timelock-propose-then-exec` sequencing to `scripts/upgrade.sh` so a
   production upgrade is two recorded transactions rather than one `admin_call`.
3. Decide whether `get_market` should *read* `MarketV2` once the sweep is done
   (it would then need vendored-blob refreshes in resolver/treasury; today the
   compatibility view is the read path, by design).
4. Consider recording the `Upgraded` hash *in* storage (a `DataKey::WasmHistory`
   append) so the deployment record is not the only off-chain ledger of what was
   installed.
