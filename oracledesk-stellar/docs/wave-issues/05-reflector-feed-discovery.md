# Reflector feed discovery and staleness config per asset

## Context

`resolver`'s `PriceConfig` (`contracts/resolver/src/lib.rs`) takes a raw
`reflector: Address` and a single `max_staleness` per market — whoever
configures a price-mode market has to already know the correct Reflector
contract address and a sane staleness bound for that specific asset. This
was intentionally left to the market creator/config caller since verifying
the actual testnet/mainnet Reflector contract addresses per asset was out
of scope for the initial port (see `docs/STATUS.md`'s TODO(maintainer)
list) — no address is hardcoded anywhere in this repo.

## What to change

1. Look up (from Reflector's own docs — do not guess) the actual testnet
   and mainnet Reflector contract addresses per supported asset class
   (crypto majors, forex, etc.), and the update frequency each feed
   publishes at.
2. Add a small config table (could be off-chain, in `agents/stellar/` or a
   docs table, or on-chain as an admin-settable registry contract if
   warranted) mapping asset -> {reflector address, recommended
   max_staleness}, so a market creator doesn't have to hand-derive a
   staleness bound from the feed's actual publish cadence.
3. Document the chosen values and their source.

## Files to touch

- New doc (e.g. `docs/reflector-feeds.md`) or a small config module,
  depending on the approach chosen
- `agents/core/strategy.ts` / `agents/stellar/adapter.ts` if the agent
  should pick a feed automatically for a given proposed question

## Acceptance criteria

- Every Reflector address used anywhere in the repo is cited against an
  official source (Reflector's own docs or a verified on-chain lookup), not
  invented.
- A market creator has a documented, sane default `max_staleness` per asset
  rather than picking one arbitrarily.

## How to test

Manual: configure a price-mode market against the documented testnet feed
and confirm `resolve_price` succeeds with real feed data
(`stellar contract invoke ... resolve_price`).

## Complexity

`complexity/medium`
