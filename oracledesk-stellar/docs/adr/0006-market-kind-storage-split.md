# ADR 0006: Market kinds as side storage, append-only XDR variants

## Status

Accepted.

## Context

Categorical (n-outcome, #6) and scalar (range, #7) markets arrived after
`market-core` had shipped binary markets and after the resolution commitment
of [ADR 0001](0001-resolution-commitment.md) had pinned the hash of every
committed `ResolutionSpec`. Adding them raised a storage question: where do
the new market shapes live?

Three forces collide:

- **`Market`'s XDR is consensus-critical material.** It is hashed into
  nothing directly, but it is embedded in events (`MarketCreated` and
  friends), read by deployed bindings, and mirrored off-chain. Appending a
  field (say `kind`) changes the encoding of every existing value — structs
  encode as maps sorted by field name, so even an appended field reorders
  nothing but changes the map length and content. Deployed readers would
  fail to decode, and the change would be indistinguishable from a rename
  for any consumer that pins bytes.
- **The `market_id` space is shared.** Markets are created against one
  monotonic id counter; a categorical market does not get, and should not
  spend, a second id.
- **New enum variants are unavoidable somewhere.** A resolution rule and a
  status must express "categorical" and "scalar", and an audit of ADR 0001's
  hash spaces shows both enums are in scope (see below).

## Decision

Never change the binary `Market` struct. Each new market kind is a
**separate persistent entry keyed by the same `market_id`**:

- `DataKey::Kind(market_id) -> MarketKind` — `Binary`, `Categorical(u32)`,
  or the scalar kind; the registry of what a given id is. `market_kind`
  exposes it (returning `Binary` for ids created before the key existed —
  the old shape is the default, so no migration transaction).
- `CatMarket` / `CatPosition` — categorical state and holdings
  (`reserves: Vec<i128>`, one vec entry per outcome).
- `ScalarMeta` — scalar display metadata (`lower`, `upper`); the scalar
  market's pool *is* the binary `Market` (LONG = YES, SHORT = NO), so
  trading, fees, redemption safety and the solvency invariant are reused
  unchanged rather than reimplemented.
- `FeeSchedule` (#9) — a per-market dynamic fee side entry; absent means the
  binary default (flat `fee_bps`), so again no migration.

Entrypoints dispatch on `market_kind`: `get_market` returns
`MarketNotFound` for a categorical id (its shape is `get_cat_market`),
`buy_cat` / `sell_cat` / `resolve_cat` / `redeem_cat` refuse binary ids and
vice versa.

Enum changes are **append-only**:

- `MarketStatus` gains `ResolvedScalar(u32)` as the *last* variant (tag 3).
  Scalar resolution does not reuse `Resolved(Outcome)` because a scalar
  payout is not a binary outcome, and reusing it would silently make old
  readers interpret a 0–10000 payout as Yes/No.
- `ResolutionSpec` gains `CategoricalSigners(CatSignerConfig)` (tag 4) and
  `Scalar(ScalarPriceConfig)` (tag 5), appended after the four variants
  ADR 0001 and ADR 0004 already fixed. The spec hash spaces stay disjoint:
  a scalar spec hashes as the `Scalar` envelope, never as a bare
  `PriceConfig`.
- `MarketKind` itself is a fresh type; only its `Binary` tag is load-bearing
  (it is the fallback for absent keys), and it is encoded with `Binary`
  first from the start.

The categorical pool reuses the binary FPMM's exact math shape — the
`calc_buy` round-trip from the multi-asset constant-product formulation —
with per-outcome reserves renormalized by `Π(r_others)`, so the same
floor/ceil directions (traders never gain a stroop from rounding, `k` never
decreases) carry over; the invariants are property-tested in all three
mirrors rather than re-proven on paper here.

## Consequences

- **Deployed binary readers keep working.** Old bindings and indexers see
  byte-identical `Market`, `MarketStatus` (for tags 0–2), and `ResolutionSpec`
  (tags 0–3) encodings. The cost: a reader that does not know about appended
  variants will fail to decode *new* values (a scalar-resolved market's
  status has tag 3) — that is the intended, visible failure mode, and it is a
  release note, not a compatibility shim. `docs/STATUS.md` and the PR carry
  it.
- **Readers must dispatch.** Anything fetching a market from an id alone
  reads `market_kind` first. This is a modest off-chain burden and it is
  uniform across the three kinds.
- **Golden vectors pin the encodings.** `ResolutionSpec` XDR hashes are
  pinned in contract golden modules and `scripts/spec-hash` (3-way verified
  against Python and `stellar xdr decode`), so an accidental reorder of the
  variant list — which would change every committed hash — fails a test
  instead of a market.
- **`n` is bounded at 8** (`MAX_MARKET_OUTCOMES`). The measured worst case
  stays under 60% of Soroban limits (see `docs/architecture.md`), and quoting
  an n=8 buy touches 5 storage entries — the cap is a transaction-footprint
  cap, not just a gas estimate.
- The categorical market keeps a **flat** `fee_bps` (snapshotted like the
  binary one). The dynamic `FeeSchedule` currently applies only to binary
  and scalar markets; extending it is additive via the same side entry.

## Alternatives considered

- **Extend `Market` with a `kind` field / optional vecs.** Breaks the XDR of
  every existing market and every event that carries one; rejected outright
  under the "consensus-critical" constraint.
- **A separate `market-core-cat` contract.** Splits the id space (categorical
  ids would collide with binary ones or require a global counter anyone can
  increment — a griefing vector), duplicates fee/treasury/resolver wiring,
  and forces the resolver to know two addresses for "the market with id N".
- **A wrapper enum `MarketValue { Binary(Market), Categorical(...) }` under
  the existing key.** Same XDR breakage as extending `Market`: the stored
  value's encoding changes for every existing market.
- **Reusing `MarketStatus::Resolved(Outcome)` for scalar payouts.** Loses the
  payout value entirely (a binary outcome cannot carry 0–10000 bps) or
  overloads the variant's meaning for old readers; rejected.
