# Event indexer (Soroban events into Postgres) with schema and replay

## Context

Soroban RPC only retains a short window of historical events (see the
"Known limitations" section of `docs/architecture.md` and
`docs/STATUS.md`). Every contract in this repo emits events for its state
transitions (`MarketCreated`, `Trade`, `MarketResolved`, `TradePublished`,
`TradeAuthorized`, etc. — see the `#[contractevent]` structs in
`contracts/*/src/lib.rs`), but there is no service that persists them
anywhere durable. Any frontend or analytics feature that needs history
older than RPC's retention window currently has no data source.

## What to change

Build a standalone indexer service (a new top-level directory, e.g.
`indexer/`) that:

1. Polls (or subscribes to) Soroban RPC's `getEvents` for the four
   deployed contract IDs (read from `deployments/testnet.json`).
2. Writes each event into a Postgres schema (one table per event type, or
   a normalized `events` table — document the choice).
3. Supports replay from a given ledger sequence, so a fresh deploy of the
   indexer can backfill from contract deployment rather than only from
   "now."

## Files to touch

- New `indexer/` directory (schema, poller, replay command)
- `docs/architecture.md` (describe the indexer once it exists)
- `Makefile` (an `indexer` target)

## Acceptance criteria

- Running the indexer against the deployed testnet contracts populates
  Postgres with every event from at least the last `make demo` run.
- Re-running from a given ledger sequence produces the same rows (replay is
  idempotent — upsert or dedupe by event id).
- A documented schema (a `.sql` migration or equivalent).

## How to test

```bash
# after standing up Postgres and running the indexer against testnet:
psql -c "select count(*) from events where event_type = 'trade';"
```

## Complexity

`complexity/large`
