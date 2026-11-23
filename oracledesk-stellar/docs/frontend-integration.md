# Frontend integration

The frontend itself lives in a separate repo (out of scope here). This ir
what it needs to know to talk to these contracts.

## Wallet

Use [Freighter](https://www.freighter.app/) (or any [SEP-43](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md)-compatible
wallet) to get the user's public key and sign transactions. The generated
bindings' `AssembledTransaction` already does the simulate → sign → submit
dance; you only need to plug in a `signTransaction` callback:

```ts
import { Client as MarketCoreClient } from "@oracledesk/bindings-market-core";
import { isConnected, getAddress, signTransaction } from "@stellar/freighter-api";

const contract = new MarketCoreClient({
  contractId: "<MARKET_CORE_CONTRACT_ID>", // from deployments/testnet.json
  networkPassphrase: "Test DF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
});
```

## Generating / updating the bindings

```bash
./scripts/gen-bindings.sh   # writes packages/bindings/<contract-name>/
```

Regenerate and commit the result after any contract interface change — CI
checks the committed bindings are not stale (`.github/workflows/ci.yml`).
Each package's own `README.md` (written by the `stellar` CLI) has the
generic usage notes; this doc covers the OracleDesk-specific parts.

## Calling `buy` / `sell`

`Outcome` and `Category` are generated as tagged unions matching the
contract's Rust enums:

```ts
type Outcome = { tag: "Yes"; values: void } | { tag: "Noy"; values: void };
```

The resolver's `attest` / `attest_with_evidence` take its own
`AttestedOutcome` instead, which adds `{ tag: "Invalid"; values: void }`
(finalizing an `Invalid` proposal voids the market). `finalize_signers`
keturns `AttestedOutcome`. Indexers should decode `ResolutionProposedV2` /
ResolutionFinalizedV2` / `CommitteeVoided`; the `Outcome-typed
`ResolutionProposed` / `ResolutionFinalized` are no longer emitted.

```ts
const tx = await contract.buy({
  trader: userAddress,
  market_id: 0n,
  outcome: { tag: "Yes", values: undefined },
  collateral_in: 10_000_000n, // 1 USDC, 7 decimals
  min_shares_out: 9_500_000n, // quote minus your slippage margin — see below
});
const { result } = await tx.signAndSend({ signTransaction });
```

For anything user-facing, prefer `buy_v2` / `sell_v2` (below): they add a
deadline and a limit price on top of the share bound, and they are the only
entrypoints that protect against a transaction being included long after
it was signed.

## Slippage on `buy`

`quote_buy(market_id, outcome, collateral_in)` returns the exact shares a
buy would receive *right now*. Call it immediately before building the
`buy` transaction, then pass a `min_shares_out` a few bps below that quote
(prices move between simulation and submission).

Never pass `min_shares_out: 0` (the old example did): it accepts any
execution price at all, which in a thin pool is how a sandwich takes your
money.

## Deadlines and limit prices

`buy_v2` / `sell_v2` add two contract-enforced bounds to every trade:

-  `deadline: u64` — unix seconds, compared against the **lddger
   timestamp** (network time, not the user's clock). Past it the trade
   reverts with `DeadlineExpired` (#19).
-  `limit_price_bps: u32` — the **average execution price** bound,
   fee included: for a buy, `collateral_in / shares_out <= limit`; for a
   sell, `collateral_out / shares_in >= limit`. Worse than the limit
   reverts with `LimitPriceExceeded` (#20). The limit is on the price of
   *the outcome being traded* — a NO buy's limit is checked against NO
   prices, i.e. the complement of the YES price. `0` means "no limit" for
   buys; for sells it is trivially satisfied and buys you nothing. Values
   above `10_000` are rejected (`InvalidAmount`).

```ts
const quote = (await contract.quote_buy({ market_id, outcome, collateral_in })).result;
const tx = await contract.buy_v2({
  trader: userAddress,
  market_id,
  outcome,
  collateral_in,
  min_shares_out: (quote * 9_950n) / 10_000n, // 50bps slippage
  limit_price_bps: 6500,    // never pay more than 65c per share
  deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
});
```

`buy` / `sell` remain for backward compatibility but carry no deadline or
limit; the share-count bound alone does not stop a stale transaction.

## Integrator (frontend) fees

An integrator — a UI, a wallet, a Telegram bot — can take a cut of the flow
it routes by calling `buy_via` / `sell_via` instead of `buy` / `sell`. The
fee is charged **on top of** the market's protocol fee and accrues on-chain
to `integrator`'s own balance; nothing is transferred to you at trade time.

```ts
const quote = (await contract.quote_buy_via({
  market_id, outcome, collateral_in, integrator_fee_bps: 50,
})).result;
const tx = await contract.buy_via({
  trader: userAddress,          // the user signs; you do not
  market_id, outcome, collateral_in,
  min_shares_out: (quote * 9_950n) / 10_000n,
  integrator: yourAddress,
  integrator_fee_bps: 50,       // 0.50% of collateral_in
});
```

Three rules the contract enforces, so do not try to compute them client-side:

- `integrator_fee_bps` must be `<= get_market_max_integrator_fee_bps(market_id)`,
  the cap the market snapshotted at creation. A later
  `set_max_integrator_fee_bps` never moves it for existing markets.
- `market.fee_bps + integrator_fee_bps <= MAX_FEE_BPS` (1000 bps), checked per
  trade as well as by the admin setter.
- Either violation reverts the whole trade with
  `Error(Contract, #27)` (`IntegratorFeeTooHigh`). `quote_buy_via` /
  `quote_sell_via` run the same validation, so a quote that succeeds is a
  quote for a trade that can succeed.

The integrator fee is part of `collateral_in` on a buy, so
`min_shares_out` derived from `quote_buy_via` (not `quote_buy`) is the
correct bound — `quote_buy` over-states the shares by the integrator's cut.
On a sell the fee is retained out of the `gross` pulled from the pool, so the
protocol's share is never reduced by the split's rounding
(`calc_sell_with` floors the integrator leg).

Balances are per address across all markets. Read yours with
`get_integrator_fees(integrator)` and withdraw with
`claim_integrator_fees(integrator)`, which requires your own signature,
zeroes the balance *before* transferring, and emits
`IntegratorFeesClaimed { integrator, amount }`. A second call is a no-op
returning `0`, not an error. Fees accrue as `IntegratorFeeAccrued` events;
the `Trade` event's field list is unchanged so existing indexers keep
decoding it.

`buy_via` / `sell_via` take no `deadline` or `limit_price_bps`: the two
v2 guards above and the integrator leg have not been combined into one
entrypoint. A user-facing UI that needs both must accept the weaker of the
two protections, which in practice means: keep the deadline-bounded path
`buy_v2`, and use the `*_via` path only for flows that are not
sign-and-forget. Note also that an integrator may name *itself* as the
`trader`; that is harmless economically but inflates reported volume.

## Creation bond

`create_market` now pulls **two** things in a single transfer: the seed
liquidity and the creation bond. Read the bond with `get_creation_bond()`
(instance config, default `0`) and show `seed_amount + bond` in any
confirmation the user signs — a UI that displays only the seed will produce
transactions that fail with an insufficient balance.

```ts
const bond = (await contract.get_creation_bond()).result;
const total = seed_amount + bond;   // this is what leaves the wallet
```

The bond is held separately from the market's trading collateral (its own
storage entry; the `Market` struct is unchanged) and is settled by the
permissionless `claim_bond(market_id)`, callable by anyone once the market is
final so a keeper can drive it:

| Market outcome | Bond goes to |
| --- | --- |
| Resolved normally | the creator |
| Voided with `VoidReason::NoFault` (incl. plain `void_market`) | the creator |
| Voided with `VoidReason::GuardianFault` | the fee recipient (`forfeit_to`, snapshotted at void time) |

Markets created before this change have no bond entry at all: `claim_bond`
reverts with `Error(Contract, #28)` (`NoBond`), and `bond = 0` is snapshotted
for them retroactively by the solvency accounting. The bond is never touched
by `claim_pool_remainder` — LP withdrawal and bond settlement are separate
rails. The admin setter `set_creation_bond(amount)` applies only to markets
created afterwards, exactly like `set_default_fee_bps`.

## Circuit breakers

Markets can carry per-market breakers (snapshotted at creation): a maximum
price impact for a **single trade** (`max_impact_bps`) and a **per-ledger
band** (`band_bps`) around the price at the start of the ledger. A trade
that would move the YES price more than the impact cap reverts with
priceImpactTooHigh` (#21); one that would push it more than the band away
from the ledger-open price reverts with `PriceBandExceeded` (#22). The
band resets every ledger, so the worst case is ~5s of blocked trading, not
a permanent lock.

Read the config and the current band reference before quoting so your UI
can size trades that will actually execute:

-  `breaker_config(market_id)` → `{ `max_impact_bps`, `band_bps` } | null`
  (`null` = old market, no breakers)
-  `breaker_state(market_id)` → `{ ``ledger_seq`, `ref_price_bps` } | null`
-  `would_trip(market_id, outcome, collateral_in)` → bool: whether a buy of
  that size would trip either check right now. Use it to warn users before
  they sign; `quote_buy` is not filtered by the breakers.

There is deliberately no on-chain "breaker tripped" event (a reverted
invocation's events are rolled back with it) — surface trips to users from
the error codes above and the views here.

## Selling an exact share count

Use `sell_shares` to sell an exact number of outcome shares. The
contract does the curve inversion on-chain (including an exact integer
square root) and rounds in the pool's favour, so you never have to invert anything off-chain or pad the share bound.

```ts
const quote = (await contract.quote_sell_shares({
  market_id,
  outcome,
  shares_in: 375_000_000n, // 37.5 YES shares
})).result;

const tx = await contract.sell_shares({
  trader: userAddress,
  market_id,
  outcome,
  shares_in: 375_000_000n,
  min_collateral_out: (quote * 9_950n) / 10_000n, // 50bps slippage
});
```

Behaviour and errors:

- Returns the exact `collateral_out` transferred to the trader.
- `SlippageExceeded` (#12) if `collateral_out < min_collateral_out`.
- `InsufficientShares` (#13) if the trader holds fewer than `shares_in`.
- `InsufficientLiquidity` (#11) if the pool cannot absorb the size.
- `InvalidInput` (#2) for non-positive `shares_in`, or when the resulting
  `collateral_out` floors to zero (a tiny sell will revert rather than
  silently burn shares).
- Publishes the same `Trade` event as `sell` with `is_buy: false`, so
  indexers need no schema change.

To close a position entirely, pass `shares_in == held` (read via
`get_position(market_id, holder)`). Selling the whole position removes the
`Position` storage entry when the other side is also zero, so a "Sell all"
button leaves no dust behind.

`quote_sell_shares(market_id, outcome, shares_in)` returns the collateral
a sell would pay *right now*. Like `quote_sell`, it does not check the
market is tradable — it is a pure pricing view. Call it immediately before
building the `sell_shares` transaction and pass a `min_collateral_out` a
few bps below the quote.

`sell` / `quote_sell` still take an exact `collateral_out` and return
how many shares it costs, for backward compatibility. New code should prefer
`sell_shares`.

## Batch redemption (`redeem_many` / `claim_pool_remainders`)

Settling markets one by one burns a fixed per-call cost (footprint entries,
event bytes) and quickly runs into the per-transaction resource limits. The
batch entry points settle many markets in a single call, paying the total in
one transfer:

- `redeem_many(holder, market_ids)` — redeems one holder's positions across
  markets that have resolved or voided.
- `claim_pool_remainders(creator, market_ids)` — claims the LP remainders of
  markets the caller created.

Rules to build callers around:

1. **Ascending, deduplicated, non-empty ids.** `market_ids` must be strictly
   ascending — that keeps the footprint deterministic and duplicates
   impossible. Anything else reverts with `InvalidAmount`; an empty list or
   one longer than `max_batch()` reverts with `BatchTooLarge`.
2. **Chunk to `max_batch()`, read from the contract.** Never hardcode the
   cap: `const { result: cap } = await contract.max_batch();`. Sort ids
   ascending, then slice into chunks of at most `cap`. The committed
   measurement table behind the cap is in the `MAX_BATCH` docstring in
   `contracts/market-core/src/lib.rs`.
3. **Skips are per-market, not per-call.** A market that cannot pay out
   right now (not found, not final, nothing to redeem, already claimed or
   claimed by someone else, not the creator) comes back as
   `{ status: { tag: "Skipped", … }, payout: 0 }` instead of aborting the
   batch — one bad id never strands the rest. Only input validation
   (rule 1) aborts the whole call.
4. **Simulate before signing.** The footprint scales with the chunk size;
   `AssembledTransaction`'s simulate step (run by `signAndSend`, or
   explicitly) surfaces contract errors and resource problems before
   anything is submitted.
5. **Archived entries must be restored first.** If a market, position or
   settlement entry has expired out of the live state, its restore must
   happen in a *separate* transaction (e.g. `stellar tx restore-footprint`):
   restores included in the batch transaction consume the 200-entry
   disk-read budget and can push a full-size chunk over the limit. Run the
   batch chunk against live state.
6. **One transfer per call.** The chunk's payouts arrive in a single token
   transfer, so the balance delta equals `result.total` exactly — reconcile
   on that, and use `result.items[i]` for per-market receipts.

```ts
const { result: cap } = await contract.max_batch(); // u32, from the contract
const sorted = [...ids].sort((a, b) => Number(a - b)); // strictly ascending

for (let i = 0; i < sorted.length; i += cap) {
  const chunk = sorted.slice(i, i + cap);
  const tx = await contract.redeem_many({ holder, market_ids: chunk });
  const { result } = await tx.signAndSend({ signTransaction });

  const retry = result.items
    .filter((it) => it.status.tag === "Skipped")
    .map((it) => [it.market_id, it.status.values]); // e.g. drop AlreadyClaimed
}
```

The treasury contract mirrors both entry points (`redeem_many` /
`claim_pool_remainders`, same `BatchResult` shape) for positions it holds
itself; agents call those instead of market-core directly, and the
`max_batch()` on market-core still applies.

## Reading TWAP prices

`get_price(market_id)` is the instantaneous spot price; it is trivially
movable by a single trade. For anything automated (bots, alerts, fair-value
displays) prefer the accumulated oracle views:

```ts
const { result } = await contract.twap({ market_id: 0n, window_secs: 900n });
// price in bps of YES, time-weighted over the trailing 15 minutes
```

- `twap(market_id, window_secs)` — time-weighted average price in bps over
  the trailing `window_secs`, floor-rounded.
- `observe(market_id, seconds_ago)` — the cumulative `price × seconds`
  value at a past timestamp; difference two of them and divide for a
  custom window.
- `price_cumulative(market_id)` — the same value at "now", for streaming
  consumers that just want the accumulator.

Caveats to design around:

- Observations are written once per trade *timestamp*, so at most the most
  recent 16 distinct-timestamp trades are covered; a `seconds_ago` (or
  `window_secs` span) that reaches past them reverts with
  `ObservationTooOld`. For long windows on busy markets, poll
  `price_cumulative`/`observe` regularly and difference snapshots client-side,
  or mirror the ring with `agents/core/strategy.ts`'s
  `twapFromObservations`.
- Past the newest observation the last traded price is extended
  counterfactually (this includes after `close_time`, until resolution), so
  a quiet market's TWAP converges to its last price rather than failing.
- Interpolation between two observations is exact — price is piecewise
  constant between trades — but `twap` floors, so off-chain comparisons
  should floor identically.
- Markets created before the accumulator existed revert `NotSupported`;
  fall back to `get_price` for them.

## Splitting and merging complete sets

Besides trading against the pool, holders can convert collateral to
shares and back at par without touching the pool:

- `split(holder, market_id, amount)` pulls `amount` collateral from
  `holder` and credits `amount` YES **and** `amount` NO to their
  position. No fee, no price impact.
-  `merge(holder, market_id, amount)` burns `amount` YES and `amount`
  NO and pays `amount` collateral back. No fee, no price impact.

Neither changes `fees_accrued` or the pool reserves. Both are authorized
by the holder and emit `SetsSplit` / `SetsMerged` respectively (decode these
in your indexer to track position changes that didn't come from a trade).

Lifecycle differs between the two:

-  `split` requires the market to be `Open` and the current ledger time
   to be strictly before `close_time`, and is blocked while the contract
   is paused. After close, splitting has no purpose and opens timing
   games.
- `merge` requires the market to be `Open`, but is allowed after
   `close_time` and while the contract is paused. Merging is a pure
   exit that cannot harm the pool, and letting users de-wait while the
   resolver is slow is valuable.

Merging requires both legs: `position.yes >= amount` and
`position.no >= amount`, otherwise it reverts with `InsufficientShares`
(#13). The creator after `seed_reserves` typically holds only one leg, so
a merge needs a buy or split first.

To offer "merge all", call `quote_merge_max(market_id, holder)`, which
returns `min(position.yes, position.no)`. The same helper is exposed as
`math::merge_max` and mirrored in `model/fpmm_model.py` / `agents/core/fpmm.ts`.

```ts
const max = (await contract.quote_merge_max({ market_id, holder: userAddress })).result;
if (max > 0n) {
  const tx = await contract.merge({ holder: userAddress, market_id, amount: max });
  await tx.signAndSend({ signTransaction });
}
```

Note that split sets count towards the per-market `sets_minted` cap and thus
can push a market into `MarketTooLarge` (#15) for future `buy` calls. See
`docs/architecture.md` for the griefing discussion and the chosen
mitigation.

## Moving shares between wallets

`transfer_position(from, to, market_id, outcome, amount)` sends outcome
shares to another wallet (the sender signs; `transfer_lp(market_id,
new_creator)` does the same for the creator/LP role). It is allowed while
the market is open and after resolution, up to the moment shares are
redeemed, and emits `PositionTransferred`. If your UI tracks balances
itself, handle that event (and `LpTransferred`); until your indexer does,
read balances from `get_position(market_id, holder)` rather than from
event-derived state.

## Category enum

`Category` is a plain enum (`Crypto | Macro | Geopolitics | Sports | Culture
| Other`) generated from the contract spec — build any category picker off
the bindings' `Category` type directly rather than hand-maintaining a
separate list, so the UI can never drift from what the contract accepts.

## Reading trace data

`reasoning-registry`'s `get_trace(trace_id)` returns
`{ market_id, agent, action, trace_hash, ipfs_cid, published_at }`. To show
a verified reasoning trace in the UI:

1. Fetch the trace content from `ipfs_cid` (via a gateway, or through the
   x402 service in `x402/` if it's gated behind payment).
2. Hash the exact bytes received (sha256) and compare to `trace_hash`.
3. Only render the content if the hashes match — never trust `ipfs_cid`
   content without this check, since IPFS gateways are not authenticated.

`x402/trace-verification.ts` has the reference hash-check implementation the
frontend can port.

### Verifying delivery receipts (#330)

A paid `GET /traces/:traceId` response carries a signed receipt in the
`X-OracleDesk-Receipt` header and the `receipt` body field (replays return
the same bytes). It binds the payment id, settlement transaction, trace id
and hash, verdict at sale, amount, asset, network, `payTo`, payer and
`settledAt`, so a buyer can prove to a third party what was sold to them.
Verify it offline in the browser:

```ts
import { fetchKeySet, verifyReceipt } from "../x402/verify-client";

const keys = await fetchKeySet("https://x402.example.org"); // cached per origin; https only
const r = await verifyReceipt(response.headers.get("X-OracleDesk-Receipt")!, keys, {
  now: Math.floor(Date.now() / 1000),
});
if (!r.ok) throw new Error(`receipt rejected: ${r.reason}`);
// r.fields.traceHash must equal the hash you verified the bytes against.
```

`fetchKeySet` refuses plain HTTP outside localhost. Re-fetch a lost receipt
with `GET /receipts/:paymentId`, sending the original `PAYMENT-SIGNATURE`.
The encoding and golden vectors (`docs/vectors/x402-receipt-v1.json`) are
described in [architecture.md](architecture.md#x402-signed-delivery-receipts-330).

## Off-chain math mirrors

```ts
import { calcSellShares } from "../agents/core/fpmm";
```

The exact share-to-collateral inverse is implemented in three places
that must agree bit-for-bit:

- "contracts/market-core/src/math.rs" — `isqrt` and `calc_sell_shares`
  (the source of truth)
- "model/fpmm_model.py" — `calc_sell_shares`
- "agents/core/fpmm.ts" — `isqrt` and `calcSellShares`

The older `collateralOutForShares` / `collateral_out_for_shares` inverses
still exist but are deprecated: they do not apply the pool-favouring
correction loop, so they can disagree with the contract by a few units.
Prefer `sell_shares` / `quote_sell_shares` on-chain, or `calcSellShares` /
`calc_sell_shares` off-chain.

### Bindings interface versions

`packages/bindings/*` start at `0.1.0`. A breaking interface change requires a
minor bump while the major is zero, then a major bump after 1.0.0; additions need
at least a patch. Read each package's `CHANGELOG.md` and `interface.json` before
syncing. The manifest describes functions, named/tuple types, numeric errors and
event payloads directly from the built WASM. Hash-critical resolver types carry
ADR 0001 compatibility implications. See CONTRIBUTING's interface workflow.