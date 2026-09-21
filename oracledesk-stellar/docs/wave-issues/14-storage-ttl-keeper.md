# Storage TTL policy and an automated TTL-bump keeper

## Context

All four contracts extend storage TTLs on read/write using hardcoded
`BUMP_THRESHOLD`/`BUMP_TO` constants (e.g.
`contracts/market-core/src/lib.rs`'s `DAY_IN_LEDGERS`-derived constants).
This works as long as *something* touches an entry before its TTL expires,
but a market nobody interacts with for a long stretch (past its close time,
before someone gets around to redeeming) could have its persistent storage
entries archived, requiring a manual restore before they're usable again.
There's no automated process ensuring TTLs get bumped proactively.

## What to change

1. Document the actual TTL policy clearly in one place (currently it's
   implicit in the constants scattered across each contract) —
   `docs/storage-ttl.md`, covering: what the bump threshold/target are per
   contract, and what happens if an entry's TTL does expire (does the
   read fail gracefully, or panic?).
2. Build a small keeper script/service that periodically calls a
   TTL-extending operation (e.g. `stellar contract extend-footprint-ttl`,
   or a lightweight read that the contract already bumps TTL on) for
   entries that matter (open markets, registered agents) before they get
   close to expiry.

## Files to touch

- `docs/storage-ttl.md` (new)
- New keeper script (location TBD — could be a cron-friendly script in
  `scripts/`, or an addition to the indexer service from issue #6 if that
  exists by the time this is picked up)

## Acceptance criteria

- The TTL policy doc accurately reflects the current constants in all four
  contracts (or the constants are unified into one shared value with a
  comment, if that's cleaner — implementer's call, document the choice).
- The keeper successfully extends TTL for a test entry approaching expiry
  without requiring a full redeploy.

## How to test

Manual: seed a market, fast-forward past most of its TTL window (or use a
short TTL override on a scratch deployment), run the keeper, confirm the
entry's TTL was extended (`stellar contract invoke` still reads it without
a "not found" error).

## Complexity

`complexity/medium`
