# CLI to create, trade and redeem markets

## Context

Today, interacting with a market outside of the agent CLIs
(`agents/bin/market-maker.ts`, `agents/bin/trader.ts`, both of which are
tied to the agent strategy loop) means hand-crafting `stellar contract
invoke` calls, as `scripts/seed-market.sh` and `scripts/demo.sh` do. There's
no general-purpose, human-friendly CLI for someone who just wants to create
a market, buy/sell in it, or redeem a position without going through the
treasury/agent flow (e.g. a human LP seeding their own market directly
against `market-core`, not through the treasury).

## What to change

Build a small CLI (e.g. `agents/bin/market-cli.ts`, or a new top-level
`cli/` if it should live independently of `agents/`) with subcommands:

```
market-cli create --question "..." --close-time ... --seed ... --yes-bps ...
market-cli buy --market-id 0 --outcome Yes --amount ...
market-cli sell --market-id 0 --outcome Yes --shares ...   # uses the sell-by-shares helper
market-cli redeem --market-id 0
market-cli quote --market-id 0 --outcome Yes --amount ...
```

Each subcommand should compute a `resolution_hash` (via the `spec-hash`
tool or an equivalent library call — see `scripts/spec-hash/`) when
creating a market, since `create_market` requires one.

## Files to touch

- New CLI entrypoint (location TBD by the implementer — document the
  choice)
- Reuses `packages/bindings/market-core` and, if issue #7 (TS SDK helpers)
  is done first, `packages/sdk`'s `sellByShares`

## Acceptance criteria

- All five subcommands work against a testnet deployment from
  `deployments/testnet.json`.
- `sell --shares N` produces a transaction that actually sells close to `N`
  shares (within the documented rounding tolerance), not just "some"
  shares for an arbitrary `collateral_out`.

## How to test

```bash
market-cli create --question "Test?" --close-time <ts> --seed 1500000000 --yes-bps 5000
market-cli quote --market-id <id> --outcome Yes --amount 10000000
```

## Complexity

`complexity/medium`
