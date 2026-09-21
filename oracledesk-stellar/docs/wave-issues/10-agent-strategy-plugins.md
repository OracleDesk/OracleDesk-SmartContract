# Agents: strategy plug-in interface plus two example strategies

## Context

`agents/core/strategy.ts` currently has exactly one hardcoded decision
function per role (`decideMarketProposal`, `decideTrade`), and
`agents/bin/market-maker.ts`/`trader.ts` use a single fixture signal source
(see the honest note in that file about there being no real signal
ingestion wired up yet). There's no way to plug in a different strategy
without editing the CLI files directly.

## What to change

Define a `Strategy` interface (or two — one per role) that
`market-maker.ts`/`trader.ts` load by name/config rather than importing a
single hardcoded function, and ship two real example implementations:

- A market-maker strategy driven by an actual `ReferencePriceSource` (the
  interface already exists in `strategy.ts`) — e.g. a public news/events
  API or a comparable market's public price feed, read-only.
- A trader strategy with a real edge-detection rule beyond the current
  simple `fairValue - marketPrice` comparison — e.g. one that also factors
  in time-to-close or recent volume.

## Files to touch

- `agents/core/strategy.ts` (the plug-in interface)
- `agents/core/strategies/` (new directory for example implementations)
- `agents/bin/market-maker.ts`, `agents/bin/trader.ts` (load a strategy by
  config instead of the current fixture)

## Acceptance criteria

- Swapping strategies is a config/env change, not a code edit to the CLI
  files.
- Both example strategies have their own unit tests (following the pattern
  in `agents/core/strategy.test.ts`).
- `agents/bin/market-maker.ts --dry-run` output visibly differs between the
  two example strategies given the same fixture market state.

## How to test

```bash
cd agents && npm test
```

## Complexity

`complexity/medium`
