# Gas/resource-usage benchmarks per contract function

## Context

Soroban meters CPU instructions, memory, and ledger I/O per invocation
("resource fees"), and `stellar contract invoke` reports these per call,
but nothing in this repo tracks them systematically. There's no baseline
to notice a regression against (e.g. a future change to `market-core::buy`
that accidentally makes it O(n) in something that should be O(1)).

## What to change

Add a benchmarking script (`scripts/benchmark.sh` or similar) that invokes
each contract's public functions against a representative testnet state
(seeded via `scripts/seed-market.sh`) with `--cost` (see `stellar contract
invoke --help`) and records CPU instructions / memory / ledger reads-writes
per call into a checked-in baseline file (e.g.
`docs/benchmarks/testnet-baseline.json`). Add a CI job (or a `make
benchmark-check` target) that re-runs it and flags a regression beyond some
threshold (e.g. 10%).

## Files to touch

- `scripts/benchmark.sh` (new)
- `docs/benchmarks/testnet-baseline.json` (new, generated)
- `Makefile` (`benchmark` target)
- Optionally `.github/workflows/ci.yml` if this should run on every PR
  (note: needs a funded testnet identity in CI secrets if so — decide
  whether that's worth the complexity vs. running it manually/on a
  schedule)

## Acceptance criteria

- Every public function across all four contracts has a recorded baseline.
- The comparison script clearly reports which function(s) regressed and by
  how much.

## How to test

```bash
./scripts/benchmark.sh
```

## Complexity

`complexity/medium`
