# ADR 0010: Sidecar storage keys and name dispatch for the creation bond and integrator fees

## Status

Accepted. Implements issues #23 (refundable creation bond, forfeited on
guardian fault) and #24 (integrator fees on buy and sell with per-market caps).

## Context

Both features want to add per-market state to `market-core`, and both hit the
same two structural walls:

1. **`Market`'s XDR shape is frozen.** `resolver`, `treasury` and `router` each
   `contractimport!` a vendored `market_core.wasm` and decode `Market` from the
   spec baked into that blob (ADR-0002, ADR-0009). Adding a field to `Market`
   changes the decoding on three consumers at once, and we cannot regenerate
   the blobs here: the box has stellar-cli 22.0.0 against the repo's expected
   27.1.0, and `rust-toolchain.toml` pins rustc 1.90.0 deliberately (issue #58)
   so that two clean builds produce identical bytes. A blob we produced would
   contradict its own `.sha256` pin and make `build.rs` panic.

2. **A new entrypoint is invisible to the generated clients.** `void_market_with_reason`,
   `get_creation_bond`, `buy_via` and friends do not exist in the vendored blob,
   so `MarketCoreClient::try_void_market_with_reason(..)` is not a method and
   does not compile. The old escape — depend on the crate natively — is exactly
   what ADR-0002 rejects.

`market-core` already has an established answer to (1): `DataKey::FeeTerms(u64)`
(ADR-0002's sibling in `lib.rs`), a per-market sidecar entry snapshotted at
creation, "so `Market`'s XDR shape never changes", with markets created before
it existed simply having no entry and keeping the legacy default. And `treasury`
already has an answer to (2): `core_trade` invokes market-core by name through
`env.try_invoke_contract` and decodes a plain integer, because "the generated
panicking methods are never used".

## Decision

**Put all new per-market state in appended sidecar keys, and reach every new
cross-contract entrypoint by name.**

### The keys

All five are appended after the existing `DataKey` tail (`Band(u64)`). No
pre-existing discriminant moves. Absent always means the legacy default, which
makes the upgrade migration-free:

| Key | Store | Holds | Absent means |
| --- | --- | --- | --- |
| `CreationBond` | instance | `i128`, admin-set default | no bond charged |
| `MaxIntegratorFeeBps` | instance | `u32` cap default | 0 |
| `Bond(u64)` | persistent | `MarketBond { amount, state, void_reason, forfeit_to }` | market predates #23, `claim_bond` → `NoBond` |
| `MarketMaxIntegratorFee(u64)` | persistent | `u32`, cap snapshot taken at creation | 0 |
| `IntegratorFees(Address)` | persistent | `i128` unclaimed balance | 0 |

`Market`, `Position`, `FeeTerms` and every exported signature keep their exact
field order and count. New *capability* arrives as a new entrypoint
(`void_market_with_reason`, `buy_via`, `sell_via`, `claim_bond`,
`claim_integrator_fees`, `quote_*_via`, the `get_*` views), never as a new
positional parameter on an existing public method. `void_market` keeps working
and is defined as the `NoFault` path, so every pre-#23 caller is unaffected.

### Snapshots, not live config

`CreationBond` and `MaxIntegratorFeeBps` are *defaults*, copied into the
per-market entry at creation. An admin changing either later never moves what
an existing market honours — the same rule `FeeTerms` and `Breaker` already
follow, and the reason `get_market_max_integrator_fee_bps` and `get_bond` exist
as separate views from the globals.

`MarketBond.forfeit_to` extends this to a *destination*: the fee recipient is
recorded at void time, not read at claim time, so a `propose_treasury` /
`accept_treasury` between the guardian void and `claim_bond` cannot redirect the
forfeit. `sweep_fees` reads the current treasury and is left alone; the bond
path is the one where deferring the read would be an authorisation hole.

### Why a forfeited bond is not a treasury receivable

`treasury` funds `seed + bond` (ADR-0005's vault). The bond is refundable
collateral, not a position, so it is deliberately kept out of `DataKey::Net(id)`
and `DataKey::Pnl(id)`: counting it there would read a later refund as a profit
on the position. `nav()` is balance-derived (`idle()` plus position floors), so
the bond is reflected exactly once as it leaves and once as it returns, with no
receivable tracked in between. It *is* counted in the market and daily outflow
caps, because that collateral really did leave the vault.

### Name dispatch, and the one encoding claim it rests on

`resolver` reaches `void_market_with_reason` and `treasury` reaches
`get_creation_bond` through `env.try_invoke_contract` with a `Symbol`. Neither
needs a regenerated blob to compile or to run.

For `VoidReason` this depends on a single, checkable property of the SDK: a
`#[contracttype]` enum whose variants are all unit and carry **no explicit
discriminants** is encoded as `ScVal::Symbol("VariantName")`
(`derive_enum.rs` in `soroban-sdk-macros-27.0.6`); only all-explicit-integer
enums go through `derive_enum_int` to `ScVal::U32`, and a mix of the two is a
compile error. So the variant *name* is the wire format, and a caller passing
`Symbol::new(env, "GuardianFault")` is byte-compatible with a callee expecting
the enum, whether or not the spec has been regenerated.

Because the whole at-fault route of #23 rests on that property rather than on a
comment asserting it, `market-core`'s test suite asserts the encoding directly:
`void_reason_encodes_as_plain_symbol_name`.

### Absent means default, across the boundary too

`core_creation_bond` treats *every* dispatch failure as `0`, not as
`MarketCoreCallFailed`. A market-core deployed before #23 has no such function,
and treasury must keep creating markets against it. This stays fail-closed in
the dangerous direction: if the read ever under-reports a bond market-core does
require, treasury under-authorises the pull, market-core's nested `transfer`
fails its auth check, and the whole creation reverts — no market is ever created
with an unfunded bond.

### Effects before interactions

`claim_bond` writes the `Held → Refunded/Forfeited` flip before transferring,
and `claim_integrator_fees` removes the balance entry before transferring. A
second call finds nothing: `AlreadyClaimed`, or a no-op return of `0`. Neither
can be paid twice, and neither is protected only by `min_shares_out`-style
caller-side checks.

## Consequences

**Positive**

- Migration-free. Markets, integrators and treasury configs predating either
  feature need no backfill and no data migration; they simply have no entry.
- `resolver`, `treasury` and `router` compile and run against the *current*
  vendored blob. Nothing in this change is blocked on `make build`.
- The bond/fee state is independently readable (`get_bond`,
  `get_integrator_fees`), so indexers and the exposure dashboard do not have to
  re-derive it from events.
- Storage cost is proportional to use: no `Bond` entry is written when the
  default is 0, and no cap entry when the default cap is 0.

**Negative / accepted**

- One more read per relevant call path: a `*_via` trade reads the market, its
  cap snapshot and the fee terms. Chosen over widening `Market`, which would
  have broken three crates.
- Cap *validation* is duplicated by design between `validate_integrator_fee`
  and the `set_*` bounds check. The trade path cannot trust config that may have
  moved since the market was created, and the setter cannot be made to know
  every future market's fee. Both are tested.
- `IntegratorFees(Address)` is one balance per integrator across all markets,
  not per market. Deliberate — an integrator serves many markets and should claim
  in one call — but it means the entry's TTL must be bumped on every accrual, as
  `LpFees` does per market.
- The enum tails collide by design with sibling PRs: #239 appends
  `ModeRestricted = 27`, #240 `DirectoryEntryArchived = 27`, and #242
  `AlreadyHalted = 27` + `HaltTooOld = 28` at market-core (verified by reading
  each PR's patch, not inferred). The resolver side has its own collision: this
  work appends `MarketCoreCallFailed = 44` to an enum that ends at 43 on
  `develop`, and #241 (`QuorumNotReached = 44`) and #242 (`EventTimeMismatch =
  44`) reach for the same number. This is the agreed cost of solving each issue
  standalone against `develop`; the last PR to merge re-appends. It is not
  resolved by rebasing one PR onto another. Tests should assert the *named*
  variant, not the numeric literal — `Err(Ok(Error::NoBond))` and
  `Err(Ok(Error::MarketCoreCallFailed))` survive a renumber untouched, whereas
  the two `should_panic(expected = "Error(Contract, #27)")` cases have to be
  chased.

**Required follow-up, not doable here**

- `make build` to refresh `contracts/{resolver,treasury,router}/market_core.wasm`
  and their `.sha256` pins, so the generated clients gain the new entrypoints and
  the name dispatches can become typed calls. Until then the resolver's
  at-fault route fails closed against the stale blob — asserted by
  `guardian_void_v2_at_fault_fails_closed_on_stale_wasm` rather than hidden.
- `make bindings` + regeneration for `buy_via`, `sell_via`, `claim_bond`,
  `set_creation_bond`, `set_max_integrator_fee_bps`, the `quote_*_via` views and
  the `BondPosted`/`BondSettled`/`IntegratorFeeAccrued`/`IntegratorFeesClaimed`/
  `CreationBondChanged`/`GuardianVoided` events. Needs stellar-cli ≥ 27.1.0.
- The TypeScript mirror (`agents/core/fpmm.ts`) for the integrator-fee split, and
  wiring `calc_buy_with`/`calc_sell_with` into `scripts/fpmm-diff/` (the Rust
  oracle, `diff.py`'s dispatch table, and `vectors.jsonl` regenerated by the
  differential run rather than transcribed). `model/fpmm_model.py`'s mirror is
  done — its checks execute here (`python3 model/fpmm_model.py`), which is exactly
  what `fpmm.ts` cannot be, since Node on this host cannot strip its types.

`docs/architecture.md` (the global solvency form) and
`docs/frontend-integration.md` (the bond, the total pulled at creation, and how
to pass an integrator) are updated by this work rather than left as follow-ups,
per #23's step 9 and #24's front-end criterion.
