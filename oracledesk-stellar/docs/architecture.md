# Architecture

See the top-level diagram in [README.md](../README.md#architecture) for the
system at a glance. This doc goes one level deeper into each contract's
responsibilities and the invariants that hold across them.

## Contracts

### market-core

The hub: every market — binary, categorical, scalar — lives here as one
entry in persistent storage, keyed by `market_id`. Pricing is a Gnosis-style
constant-product FPMM over internal share accounting — no external LP token,
no AMM pool contract per market. `contracts/market-core/src/math.rs` is the
entire pricing engine, pure integer arithmetic, no `Env` dependency, so it's
natively unit-testable and mirrored line-for-line in
[`model/fpmm_model.py`](../model/fpmm_model.py) and
`agents/core/fpmm.ts` for property testing and off-chain quoting.

**Three market kinds, one id space.** A market is binary (the original
`Market`), categorical (#6, 2–8 outcomes), or scalar (#7, a range bet on a
price feed). The XDR of the original `Market` struct is never changed: each
new kind is *side storage* keyed by the same `market_id` (`DataKey::Kind`
records which kind an id is; `market_kind` exposes it), and new enum
variants are appended after the existing tags so deployed readers keep
decoding old values. Readers dispatch on `market_kind` first: `get_market`
returns `MarketNotFound` for a categorical id, whose shape lives in
`get_cat_market`. See [ADR 0005](adr/0005-market-kind-storage-split.md) for
the full argument and the alternatives rejected.

**Solvency invariant** (holds after every state transition — see the test
suite for the ones exercised): the contract's own SEP-41 token balance for a
market equals `sets_minted + fees_accrued + lp_fees` (`fees_accrued` is the
protocol's pending share of trading fees, `lp_fees` the creator's — see the
fee split below), and `reserve_yes + Σ(user yes positions) == sets_minted`
(symmetrically for `no`). The same invariant holds for categorical markets
on `CatMarket`.

**Fee split and recipient snapshot.** `create_market` snapshots a
`FeeTerms { recipient, protocol_share_bps }` side entry per market, so
`set_treasury` / `set_protocol_fee_share_bps` only affect markets created
after them. Each trade's fee is split once at accrual time
(`math::split_fee`, protocol shares round up so `protocol + lp == fee`
exactly): the protocol portion accumulates in `Market.fees_accrued` and is
swept to the snapshotted recipient by the permissionless `sweep_fees`
(old `FeesSwept` event kept for indexers, plus `FeesSweptTo`); the creator
portion accumulates in a `LpFees(market_id)` side entry, claimable any time
(before finality too) via `claim_lp_fees`, and also drained by
`claim_pool_remainder`. Markets created before this change have no
`FeeTerms` entry and fall back to the old behavior: recipient = whatever
`DataKey::Treasury` holds at sweep time, `protocol_share_bps = 10_000` —
fully backward compatible, no migration transaction needed. The separate
LP balance (rather than adding fees to the reserves) is deliberate: it does
not move `k` or the price and maps directly onto the per-LP fee accumulator
of the future multi-LP design ([wave-issue 02](wave-issues/02-multi-lp-liquidity.md)).

**Dynamic fee schedules (#9).** A market can charge a scheduled fee instead
of a flat one. `FeeSchedule { base_bps, max_bps, ramp_secs, skew_mult_bps }`
is snapshotted at creation — from `DataKey::DefaultFeeSchedule` (set by the
admin's `set_default_fee_schedule`, which only affects markets created after
it) or from an explicit `create_market_with_fees`, whose schedule is
validated against the default's `max_bps` cap before a market id is
allocated. The effective fee is recomputed per trade by
`math::effective_fee_bps(schedule, now, close_time, r_yes, r_no)`:
`min(max_bps, base_bps + ramp + skew)`, where `ramp` rises linearly from
`base_bps` to `max_bps` over the last `ramp_secs` before `close_time` (and
stays at `max_bps` afterwards), and `skew` adds `skew_mult_bps` per 1000 bps
the pre-trade YES price sits away from 50/50. Every floor rounds in the
trader's favour; the contract layer bounds `max_bps <= MAX_FEE_BPS`,
`ramp_secs <= MAX_RAMP_SECS` (30 days) and `skew_mult_bps <= MAX_SKEW_MULT_BPS`
(1000), while the pure math only requires `base_bps <= max_bps < BPS`.
`buy` / `sell` / `quote_buy` / `quote_sell`, the `_v2` twins, and the fee
split all use the effective fee; `current_fee_bps` exposes it now, and
`quote_buy_at(market_id, outcome, collateral_in, at_timestamp)` quotes with
the fee that will apply at a *future* timestamp — the client-side latency
hedge described in [frontend-integration.md](frontend-integration.md).
`TradeV2` carries the realised `fee_bps` next to the existing `Trade` event.
Legacy markets have no schedule and keep their flat `fee_bps`; categorical
markets always charge the flat fee.

**Trade bounds and circuit breakers.** Two layers of protection beyond the
share-count slippage parameters:

- *Deadline + limit price* (#12): `buy_v2` / `sell_v2` take a
  `deadline` (ledger **timestamp**, unix seconds) checked before anything
  else, and a `limit_price_bps` bounding the **average execution price**
  (`collateral_in / shares_out` for buys, `collateral_out / shares_in` for
  sells, fee included, compared by cross-multiplication). `0` means "no
  limit" for buys; for sells it is trivially satisfied and buys no
  protection. The original `buy` / `sell` remain as thin wrappers for
  backward compatibility (same body, no bounds).
- *Per-market breakers* (#10): `BreakerConfig { max_impact_bps, band_bps }`
  is snapshotted per market from an admin default (`set_default_breaker`,
  which rejects `band_bps < max_impact_bps` because that makes one trade
  cover the whole band). `max_impact_bps` bounds a single trade's
  |post − pre| YES-price move (`>` — a trade moving exactly the cap
  passes); `band_bps` bounds |post − ledger-open price|, with the reference
  stored in short-TTL **temporary** storage keyed by ledger sequence, so it
  resets by itself every ledger. 0 disables either check; legacy markets
  have no config and are unaffected. Breaker trips revert with
  `PriceImpactTooHigh` / `PriceBandExceeded` and — because Soroban rolls
  back an invocation's events on `Err` — emit **no** event (the error codes
  and the `would_trip` / `breaker_config` / `breaker_state` views are the
  observability path; see the comment on `check_breakers`).

  *Worst-case lock cost.* The band cannot be ratcheted: the reference is
  the ledger-open price, so an attacker who pushes the price to the band
  edge only blocks further trades for the rest of that ledger (~5 s) —
  and pays the trading fee plus price impact to do it, which arbitrageurs
  can take back the next ledger. The breakers cannot lock a market across
  ledgers by construction.

**Transferability.** `transfer_position(from, to, market_id, outcome,
amount)` moves shares between any two addresses (owner auth; allowed while
`Paused` — a transfer moves no collateral — and after finality until
`redeem`), rejecting self-transfers, transfers to the contract's own
address (they could never be redeemed) and over-transfers, and emitting
`PositionTransferred` so indexers stay in sync. `transfer_lp(market_id,
new_creator)` (current-creator auth, until `lp_claimed`) moves the single
LP role — the right to `claim_pool_remainder` and `claim_lp_fees` — and
emits `LpTransferred`. Both preserve the solvency invariant by
construction; the position mapping is unchanged down to the "remove
zero entries" rule.

**Categorical markets (#6).** `create_categorical_market` opens an
n-outcome market (`2 <= n <= 8`, `MAX_MARKET_OUTCOMES`) seeded from
`probs_bps` — one probability per outcome, each within
`MIN_PROB_BPS..=MAX_PROB_BPS` and summing to exactly 10000; the creator/LP
receives the leftover shares of the likelier outcomes. The pool is the
generalized FPMM: reserves `[r_0..r_n]` with the binary invariant
`k = r_yes * r_no` replaced by `k = Π(r_i)`; a `buy_cat` of outcome `i`
moves `r_i` in and renormalizes the other reserves down so the product is
preserved (`sell_cat` is the inverse). The math uses the same iterative
floor/ceil scheme as the binary path — rounding never pays the trader and
`k` never decreases — and is property-tested in all three mirrors.
`get_prices_cat` reports implied probabilities that sum to within `n` of
10000 bps; settlement pays one unit per winning share and a void pays half
per share, exactly like the binary path. Categorical markets keep a flat
snapshotted `fee_bps` (no dynamic schedule) and no price-based breakers;
collateral, pause switch, `FeeTerms` and the `resolution_hash` commitment
are shared with `create_market`. Worst case (`n = 8`) `buy_cat` costs
444,604 instructions / 64,092 B memory / 1,640 write bytes across 5 storage
entries — under 60% of the network limits, asserted by
`cat_eight_outcomes_resource_budget`. Events: `CatTrade`,
`CatMarketResolved`.

**Scalar markets (#7).** `create_scalar_market` is a binary market
(LONG = YES, SHORT = NO) plus a `ScalarMeta { lower, upper }` display side
entry — trading, fees (dynamic schedules included), breakers and the whole
solvency story are inherited unchanged. Resolution writes
`MarketStatus::ResolvedScalar(payout_long_bps)` (an appended status variant;
0 = full SHORT, 10000 = full LONG) via `resolve_scalar`, and redemption
pays each holder `floor(yes·p / 10000) + floor(no·(10000 − p) / 10000)` —
both legs floor, so total payouts stay within `sets_minted` and a scalar
market cannot overpay. `get_scalar_meta` exposes the bounds; the meta is
display-only and never affects payouts.

**Resolution commitment**: `resolution_hash` is fixed at `create_market`
time — see [ADR 0001](adr/0001-resolution-commitment.md) for why.

Lifecycle: `create_market` / `create_market_with_fees` /
`create_categorical_market` / `create_scalar_market` → `buy`/`sell`
(`buy_v2`/`sell_v2` with bounds; `buy_cat`/`sell_cat`) while open →
`resolve` / `resolve_cat` / `resolve_scalar` or `void_market`
(resolver-only) → `redeem` / `redeem_cat` per holder,
`claim_pool_remainder` / `claim_pool_remainder_cat` for the creator/LP,
`sweep_fees` (permissionless) to the snapshotted fee recipient. Positions
and LP ownership can change hands at any point via `transfer_position` /
`transfer_lp`.

### resolver

Independent resolution modes, all ultimately calling
`market_core.resolve(market_id, outcome)`:

- **PriceThreshold**: reads a [Reflector](https://reflector.network) SEP-40
  price feed at (or after) the market's `close_time`, compares to a
  threshold, enforces a max staleness window.
- **Attested**: m-of-n signer votes; once `threshold` signers agree, a
  dispute window opens; anyone can finalize after it elapses, or a guardian
  (the resolver's `admin`) can `cancel_proposal` during the window.
- **Weighted keys**: a committee of raw Ed25519 public keys with weights.
  Members sign a domain-separated message off-chain and anyone submits the
  signatures to `submit_signatures` in one transaction; the weight threshold
  starts the same dispute window. `cancel_proposal` moves the market to a new
  round, invalidating earlier signatures. Message format: ADR 0001.
- **Categorical signers**: the n-outcome counterpart of Attested.
  `register_cat_signer_spec` reveals a `CategoricalSigners` spec (signer
  set, `threshold`, `dispute_window`, and the committed `outcome_count`);
  signers call `attest_cat(market_id, outcome_index)` — the first index to
  reach `threshold` attestations becomes the proposal and opens the dispute
  window — and anyone calls `finalize_cat` after the window to resolve the
  winning index through market-core's `resolve_cat`. The guardian's
  `cancel_proposal` clears a categorical proposal too.
- **Scalar price**: `register_scalar_spec` reveals a `Scalar` spec
  (`ScalarPriceConfig`: a Reflector feed plus `lower` / `upper`). After
  `close_time`, `resolve_scalar_price` reads the feed — a non-positive
  reading is `InvalidPrice` (a broken feed, not a value at the bottom of the
  range), with the same staleness window as `resolve_price` — clamps it into
  `[lower, upper]` and settles the fractional LONG payout
  `(clamped − lower) / (upper − lower)` in bps, flooring toward the pool.

No rule can be configured until the revealed spec's hash matches the
market's commitment, via the `register_*_spec` entrypoint matching the
committed variant — see ADR 0001. A guardian can also `guardian_void_market`
an unresolvable market directly.

#### Bonded disputes (`SignersDisputable`)

A `SignersDisputable` spec adds an optimistic challenge to Attested mode.
While a proposal's dispute window is open, anyone can `dispute` it by
escrowing `dispute_bond` of the collateral token in the resolver. That
freezes `finalize_signers`, `attest`, `cancel_proposal` and `expire_market`
(`DisputeActive`) and escalates to the authority committed in the spec: the
guardian (`settle_dispute`) or a `k`-of-`n` committee disjoint from the
signers (`escalation_attest`). Upholding the proposal resolves to it and
forfeits the bond to market-core's treasury; any other ruling resolves to the
verdict (or voids for `Invalid`) and returns the bond. If nobody rules within
`escalation_timeout` of the dispute, anyone may `expire_dispute`: the market is
voided and the bond refunded. `guardian_void_market` during a dispute also
refunds it. Bonds leave escrow only via the permissionless
`claim_dispute_bond` (pull, so a payee that cannot receive cannot block
settlement); the resolver's token balance always equals the bonds it still
holds.

```mermaid
stateDiagram-v2
    [*] --> SignersPending: register_disputable_spec
    SignersPending --> SignersPending: attest (proposal at threshold)
    SignersPending --> Finalized: finalize_signers (window elapsed)
    SignersPending --> Disputed: dispute (window open, bond escrowed)
    Disputed --> Finalized: settle_dispute / escalation_attest (k votes)
    Disputed --> Finalized: expire_dispute (timeout, void, refund)
    Disputed --> Finalized: guardian_void_market (void, refund)
    SignersPending --> Expired: expire_market (no pending proposal)
    Finalized --> [*]: claim_dispute_bond pays the payee
```

**Rewards, honestly:** a winning disputer only gets their bond back. The
resolver holds no funds besides bonds, so there is nothing to pay a reward
from until signers also post bonds (signer staking is separate work). The
incentive to dispute is therefore protecting one's own position, not profit.

Liveness: `resolution_deadline` is `close_time` + 30 days. After it anyone can
call `expire_market`, which resolves the market if it still can be (valid
price feed) and otherwise voids it through market-core, so collateral is never
locked behind a missing reveal or a silent committee. See ADR 0001.

The resolver never depends on `market-core`'s Rust crate — see
[ADR 0002](adr/0002-cross-contract-calls.md) for why, and what that trades
off.

### treasury

Holds the agents' pooled USDC and is the *only* path that spends it: an
agent calls `agent_create_market` / `agent_buy` / `agent_sell` /
`agent_buy_v2` / `agent_sell_v2` (and `agent_buy_cat`, the categorical
forwarder), the treasury checks its own per-trade/per-market/daily caps,
then calls `market-core` itself as the trader/creator. This means the caps are a real on-chain limit on what the
automated agent can deploy — an agent's own key calling `market-core`
directly would just be trading its own separate funds, not bypassing a cap
on the treasury's money. The `*_v2` twins forward the same caps plus
market-core's deadline / limit-price bounds, so a revert from either layer
leaves the caps unchanged (the whole invocation is atomic). The treasury's
creator-side claims are split the same way the fees are: `collect_market_fees`
sweeps the **protocol portion** to the treasury, while `agent_claim_lp_fees`
claims the LP portion for markets the treasury created.

**Migration to a successor treasury.** The treasury has no upgrade path or
config setters by design, so redeploying it (bug fix, cap change, agent
rotation) means deploying a new contract. `set_successor(successor)`
(admin) records where value may go and emits `SuccessorSet`; then
`migrate_market(market_id)` (admin, **not** agent) moves the treasury's
YES/NO position and, if it is still the LP, its LP ownership for one market
to the successor — market by market, so the footprint stays bounded — and
emits `MarketMigrated`. The auth model:

- The agent has no path: both migration entrypoints are `require_admin`.
- The destination is fixed to the configured `Successor` — `migrate_market`
  takes no destination argument, so even a compromised agent key cannot
  redirect value, and a compromised admin gains no new power over *user*
  funds (it could already `withdraw`; migration only moves
  treasury-owned positions, and the successor is visible on-chain via
  `SuccessorSet`).
- The treasury's calls to market-core's `transfer_position` / `transfer_lp`
  are *direct* calls, so market-core's `require_auth` on the treasury's own
  address is satisfied implicitly by the invoker rule — no
  `authorize_as_current_contract` entry is needed (unlike the nested token
  call in `authorize_token_pull`). This is proven by the
  `pitfall_migrate_market_needs_only_admin_auth` test, which permits only
  the admin's signature and no sub-invocations.

A migrated market's `MarketExposure` on the successor starts at zero and the
old treasury's entry is closed (`open = false`, amount preserved), so the
successor's caps apply to its own future activity — acceptable because the
cap is a per-deployment risk bound, not a market-level accounting value.
Successor-side acceptance (`accept_migration`) is deliberately not
implemented: it would record provenance only, and the events plus the
successor's own exposure records are enough for an off-chain dashboard
([wave-issue 08](wave-issues/08-treasury-exposure-dashboard.md)).

The nested-authorization pitfall this design implies, and how it's handled,
is documented at length in `contracts/treasury/src/lib.rs` (see
`authorize_token_pull`) and exercised by
`pitfall_agent_buy_requires_treasury_self_authorization_for_nested_transfer`
in the same file's test module — a test that's been verified to fail
without the fix and pass with it (see the commit history / docs/STATUS.md).

### reasoning-registry

An admin allow-list of agent addresses; a registered agent calls
`publish_trace(agent, market_id, action, trace_hash, cid)` to record that a
trace exists, returning a `trace_id`. `verify_trace(trace_id, candidate_hash)`
is the check a paying subscriber (via `x402/`) or a frontend runs before
trusting fetched trace content. Traces are also indexed per market
(`market_trace_count` / `market_trace_at`) via a counter rather than an
unbounded `Vec`, so the index never has an unbounded-growth storage cost.

**Known limitation**: Soroban RPC only retains a short window of historical
events. An indexer (Soroban events → Postgres, replayable) is required for
any UI that wants to list traces/trades older than that window — this is
one of the seeded `docs/wave-issues/`.

## Off-chain pieces

- **x402/**: an Express service selling reasoning traces for ~$0.01 via
  `@x402/*`'s exact-payment Stellar scheme. Fetches the trace JSON (from
  IPFS or `reasoning-registry`'s configured store), recomputes its hash, and
  serves it only if the hash matches the on-chain record — see
  `x402/registry-trace-repository.ts`.
- **agents/**: `core/` is chain-agnostic (FPMM math including the
  price-impact quoting used to size trades under a breaker cap, trace
  building, strategy decisions with an optional impact clamp); `stellar/`
  is the only part that knows about Soroban, wrapping the generated
  bindings with a dry-run/live switch. The trader always quotes
  (`quote_buy`) immediately before submitting and derives non-zero
  `min_shares_out` / `limit_price_bps` bounds plus a deadline from it. In
  live mode it reads `get_market` and `current_fee_bps` first, and sizes the
  trade under the market's price-impact breaker when one is configured.
- **packages/bindings/**: generated TypeScript clients (`scripts/gen-bindings.sh`).

## Known limitations (see docs/STATUS.md for the full, current list)

- Testnet only; unaudited.
- No indexer yet — anything needing historical events beyond RPC's
  retention window has no on-chain-native way to query them.
- Agent-vs-agent liquidity: nothing here stops multiple independent agent
  deployments (this repo's or a fork's) from trading against the same
  market-core markets; the treasury's caps bound one agent deployment's own
  risk, not systemic market behavior.
