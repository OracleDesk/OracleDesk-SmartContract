# add_liquidity / multi-LP shares with fee sharing

## Context

`market-core` currently supports exactly one LP per market: whoever calls
`create_market` seeds the pool and is the sole recipient of
`claim_pool_remainder` (see `contracts/market-core/src/lib.rs`,
`Market.creator`). There is no way for a second party to add liquidity to
an existing market, and no mechanism to split `fees_accrued` between
multiple LPs proportional to their contribution.

## What to change

Add an `add_liquidity(market_id, provider, amount)` entrypoint that mints
proportional LP shares (a new `LpShare(market_id, Address) -> i128` storage
entry, tracked as complete-set-equivalents contributed), and change
`claim_pool_remainder` and fee distribution to pay out
proportional-to-LP-share rather than paying the whole remainder/fee pool to
`creator` alone. `creator` becomes just "the first LP" rather than a
privileged role beyond that.

## Files to touch

- `contracts/market-core/src/lib.rs` (`Market`, new storage key, new
  entrypoint, `claim_pool_remainder`, `sweep_fees`/fee accounting)
- `contracts/market-core/src/math.rs` if the seeding math needs a variant
  for adding to an already-trading pool (adding liquidity mid-market moves
  the price unless done carefully — Uniswap-v2-style "add at current ratio"
  is the usual approach)
- New tests for: two LPs, proportional fee split, proportional remainder
  split after resolution/void

## Acceptance criteria

- Two LPs can each add liquidity to the same market at different times.
- `claim_pool_remainder` pays each LP their proportional share, and the
  total paid across all LPs never exceeds what the pool actually holds.
- Existing single-LP tests still pass unchanged (single-LP is a special
  case of N=1, not a separate code path).

## How to test

```bash
cargo test -p market-core
```

## Complexity

`complexity/large`
