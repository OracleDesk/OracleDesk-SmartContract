# Contract-level fuzz/invariant tests for market-core

## Context

`contracts/market-core/src/math.rs` has a hand-rolled property test
(`k_never_decreases_and_round_trip_never_profits`, a small LCG over 2000
iterations) but nothing exercises the *contract* layer (`lib.rs`) itself
with randomized sequences of `buy`/`sell`/`create_market` calls checking the
solvency invariant described in `docs/architecture.md` (contract token
balance == `sets_minted + fees_accrued` per market). A real fuzzer (e.g.
`proptest` or `cargo-fuzz`) would catch interaction bugs the hand-written
unit tests don't (e.g. a sequence of buys/sells that drifts the invariant
by a rounding edge case).

## What to change

Add `proptest` as a dev-dependency to `contracts/market-core` and write a
property test that: creates a market, applies a random sequence of
`buy`/`sell` calls with random amounts/outcomes, and after each call asserts
the solvency invariant holds by reading the token balance and market state
directly.

## Files to touch

- `contracts/market-core/Cargo.toml` (dev-dependency)
- `contracts/market-core/src/lib.rs` (new `#[cfg(test)]` module or extend
  the existing one)

## Acceptance criteria

- A property test runs at least 200 random operation sequences per
  `cargo test` invocation and fails loudly (with the seed) if the invariant
  breaks.
- `cargo test -p market-core` still completes in well under a minute.

## How to test

```bash
cargo test -p market-core
```

## Complexity

`complexity/medium`
