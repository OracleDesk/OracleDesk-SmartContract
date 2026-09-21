# Treasury: per-market exposure dashboard endpoint

## Context

`treasury` already tracks per-market exposure (`MarketExposure { amount,
open }`, see `contracts/treasury/src/lib.rs`) and daily usage
(`DailyUsage`), but there's no way to list *all* markets the treasury has
exposure to in one call — a caller has to already know a `market_id` to
query `market_exposure`-shaped state, and there's no public view function
for it at all today (it's a private helper). There's no dashboard or API
surface showing the treasury's overall risk picture.

## What to change

1. Add a public view function to `treasury` exposing exposure for a given
   market (currently internal-only), and a bounded-iteration way to list
   markets with open exposure (a counter-indexed list, following the same
   pattern as `reasoning-registry`'s `market_trace_count`/`market_trace_at`
   — no unbounded `Vec`).
2. Build a small read-only HTTP endpoint (could live in `x402/` as an
   unpaid route, or a new small service) that calls this and renders a
   simple JSON/HTML summary: total exposure, per-market breakdown, daily
   usage vs. cap, available capital.

## Files to touch

- `contracts/treasury/src/lib.rs` (new view function(s), new indexed
  storage for "markets with exposure")
- New endpoint, wherever it's decided to live

## Acceptance criteria

- The on-chain side is a getter, not a state-changing call — no new auth
  requirements, no fund movement.
- The dashboard endpoint correctly reflects state after a `make demo` run
  (exposure appears for the demo market, daily usage matches what was
  traded).

## How to test

```bash
cargo test -p treasury
```

## Complexity

`complexity/medium`
