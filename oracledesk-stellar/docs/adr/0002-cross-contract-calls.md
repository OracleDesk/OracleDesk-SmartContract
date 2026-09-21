# ADR 0002: Cross-contract calls via `contractimport!`, not a Cargo dependency

## Status

Accepted.

## Context

`resolver` and `treasury` both need to call `market-core` (get a market's
state, call `buy`/`sell`/`create_market`/`resolve`/`void_market`, etc.). The
obvious approach is a normal Cargo path dependency:

```toml
market-core = { path = "../market-core" }
```

This works for `cargo test` (native, rlib linking) but **fails the wasm
build**:

```
warning: Linking globals named '__constructor': symbol multiply defined!
error: failed to load bitcode of module "market_core.market_core...rcgu.o"
```

The root cause, from soroban-sdk's own docs on `#[contract]`: "a crate only
ever exports a single contract... when built as a wasm file... the
combination of all contract functions and all contracts within a crate will
be seen as a single contract." `#[contractimpl]` exports every entrypoint as
a `#[no_mangle]` wasm symbol, which the linker never dead-code-eliminates.
Depending on the `market-core` crate pulls its *entire* compiled `#[contract]
impl` (not just the types/client we wanted) into `resolver`'s and
`treasury`'s own cdylib build, so `MarketCore`'s `__constructor` collides with
`Resolver`'s/`Treasury`'s own `__constructor`.

## Decision

`resolver` and `treasury` do not depend on the `market-core` crate at all.
Instead, each vendors a copy of the *compiled* `contracts/market-core/target/.../market_core.wasm`
into its own directory (`contracts/resolver/market_core.wasm`,
`contracts/treasury/market_core.wasm`) and generates bindings from it:

```rust
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{Client as MarketCoreClient, Outcome /* , Category */};
```

This is the same mechanism the resolver already used for the (external,
not-in-this-workspace) Reflector oracle via `#[contractclient]` — here
`contractimport!` derives the equivalent client from a compiled wasm's
interface spec instead of a hand-written trait, since we have the real wasm
to read from.

Two things had to be enabled to make this work cleanly:

- **`experimental_spec_shaking_v2`** (a soroban-sdk feature flag): without
  it, types referenced only via an imported client (`Outcome`, `Category`)
  are *used* by `resolver`/`treasury` but not *declared* in their own
  contract spec, which `stellar contract build` flags with warnings like
  `type 'Outcome' ... is not defined in the spec` — and would produce broken
  TypeScript bindings for those functions. The flag makes the macro re-export
  the imported type definitions into the depending contract's own spec.
- **`#[allow(clippy::too_many_arguments)]` on the `mod market_core { ... }`
  block**: the generated `contractimport!` code (client constructors, arg
  structs) isn't ours to edit, but its constructor happens to cross clippy's
  default 7-argument threshold.

The generated `Outcome` (and other imported enums) do **not** derive `Copy`
(only `Clone`, unlike the hand-written original in `market-core`), since
`contractimport!` only has the XDR spec to work from, not the original
`#[derive(...)]` list. Call sites that assumed `Copy` needed `.clone()` added.

## Consequences

- **Trade-off accepted**: `market_core.wasm` is a checked-in binary build
  artifact in two places. Changing `market-core`'s source requires rebuilding
  it and re-copying the `.wasm` into `contracts/resolver/` and
  `contracts/treasury/` *before* rebuilding those crates — `contractimport!`
  reads the file at `resolver`'s/`treasury`'s own compile time, so a stale
  copy silently keeps the old interface. `make build` runs the steps in the
  right order (market-core first, copy, then the rest); a contributor running
  `cargo build` a la carte on just `resolver` after touching `market-core`
  needs to rebuild market-core and re-copy the wasm by hand first — noted in
  `CONTRIBUTING.md`.
- `resolver`'s and `treasury`'s own copies of `Outcome`/`Category` are
  nominally distinct Rust types from `market-core`'s originals (structurally
  identical, same XDR shape, different type identity). This is invisible at
  the ABI level — cross-contract calls serialize through `Val`/XDR, not Rust
  type identity — but it means, e.g., `resolver::Outcome` and
  `treasury::Outcome` are two more distinct (structurally-identical) Rust
  enums. Not worth a shared "types-only" crate for three enums; revisit if
  the shared surface grows.
- Every contract test now registers `market-core` from its compiled wasm
  (`env.register(market_core::WASM, (admin, ...))`) instead of the native
  struct — this is closer to how the real deployed system behaves (resolver
  and treasury genuinely only ever interact with market-core's wasm, never
  its Rust source) and was the officially documented pattern for this in
  soroban-sdk's own `contractimport!` example.
