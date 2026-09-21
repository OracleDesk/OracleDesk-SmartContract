# TypeScript SDK helpers: quotes, sell-by-shares, slippage

## Context

`agents/core/fpmm.ts` has the off-chain math (including
`collateralOutForShares`, the sell-N-shares inverse — see
`docs/frontend-integration.md`), but it lives inside `agents/` rather than
somewhere a frontend can depend on directly. `packages/bindings/*` only has
the raw generated contract clients, with no ergonomic wrapper for the
common "get a live quote with slippage" or "sell exactly N shares" flows a
UI actually needs.

## What to change

Extract `agents/core/fpmm.ts` (and its test) into a small shared package —
e.g. `packages/sdk/` — with no dependency on `agents/`'s Node-specific
pieces, and add ergonomic wrappers on top of the generated `market-core`
bindings client:

- `getQuote(client, marketId, outcome, collateralIn)`: calls
  `quote_buy`/`get_market`, returns shares + implied price impact.
- `sellByShares(client, marketId, outcome, shares, slippageBps)`: computes
  `collateral_out` via `collateralOutForShares`, applies a slippage margin
  to `max_shares_in`, and calls `sell`.
- Both `agents/` and the (separate, out-of-scope-here) frontend repo should
  be able to depend on this package.

## Files to touch

- New `packages/sdk/` (move `fpmm.ts`/`fpmm.test.ts` here, add the wrappers)
- `agents/core/` re-exports from `packages/sdk` instead of duplicating
- `docs/frontend-integration.md` (point at the new package)

## Acceptance criteria

- `packages/sdk` has no dependency on Node-only APIs incompatible with a
  browser bundle (check `fpmm.ts` — it currently has none; keep it that
  way).
- `sellByShares` round-trips against a live testnet market's real
  `quote_sell` within the documented one-unit rounding tolerance (see the
  property test already in `fpmm.test.ts`).

## How to test

```bash
cd packages/sdk && npm test
```

## Complexity

`complexity/medium`
