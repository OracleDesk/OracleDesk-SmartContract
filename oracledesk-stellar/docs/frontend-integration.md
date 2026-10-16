# Frontend integration

The frontend itself lives in a separate repo (out of scope here). This is
what it needs to know to talk to these contracts.

## Wallet

Use [Freighter](https://www.freighter.app/) (or any [SEP-43](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md)-compatible
wallet) to get the user's public key and sign transactions. The generated
bindings' `AssembledTransaction` already does the simulate → sign → submit
dance; you only need to plug in a `signTransaction` callback:

```ts
import { Client as MarketCoreClient } from "@oracledesk/market-core-bindings";
import { isConnected, getAddress, signTransaction } from "@stellar/freighter-api";

const contract = new MarketCoreClient({
  contractId: "<MARKET_CORE_CONTRACT_ID>", // from deployments/testnet.json
  networkPassphrase: "Test SDF Network ; September 2015",
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
type Outcome = { tag: "Yes"; values: void } | { tag: "No"; values: void };
```

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
entrypoints that protect against a transaction being included long after it
was signed.

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

- `deadline: u64` — unix seconds, compared against the **ledger
  timestamp** (network time, not the user's clock). Past it the trade
  reverts with `DeadlineExpired` (#19).
- `limit_price_bps: u32` — the **average execution price** bound,
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
  limit_price_bps: 6500,    // never pay more than 65¢ per share
  deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
});
```

`buy` / `sell` remain for backward compatibility but carry no deadline or
limit; the share-count bound alone does not stop a stale transaction.

## Dynamic fees: quote at the fee you will pay

A market may charge a **dynamic fee** (#9): `base_bps` ramping toward
`max_bps` over the last `ramp_secs` before `close_time`, plus a skew
surcharge the further the pre-trade price sits from 50/50. The fee is fixed
inside the trade, so plain `quote_buy` (fee as of *now*) can understate what
a slightly later submission pays — near the close, or with a skewed pool,
the drift can exceed a few bps of slippage. Quote with the timestamp you
expect the transaction to land at instead:

```ts
const now = BigInt(Math.floor(Date.now() / 1000));
const at = now + 30n; // expected simulation + signing + inclusion latency
const quote = (await contract.quote_buy_at({
  market_id, outcome, collateral_in, at_timestamp: at,
})).result;
```

- `quote_buy_at(market_id, outcome, collateral_in, at_timestamp)` — the
  shares a buy would get with the schedule's fee at `at_timestamp`;
  it still uses the reserves read at call time, so keep your usual slippage
  margin on `min_shares_out`.
- `current_fee_bps(market_id)` — the effective fee right now, for display.
- `fee_schedule(market_id)` — the snapshotted schedule, or `null` for
  legacy flat-fee markets.

`TradeV2` carries the fee actually paid (`fee_bps`) per trade — index that
for "realised fee" displays rather than recomputing it. There is no
`quote_sell_at`, so a sell should either quote as late as possible or pad
`max_shares_in` to absorb the drift.

## Market kinds

`get_market(market_id)` reads binary and scalar markets only. Check
`market_kind(market_id)` when the id's kind is not already known: a
categorical id answers `MarketNotFound` there — read
`get_cat_market(market_id)` for reserves/status, `get_prices_cat(market_id)`
for implied probabilities (they sum to ~10000 bps), trade with
`buy_cat` / `sell_cat` (the same share-count bound, no `_v2` variant yet),
and settle with `redeem_cat` / `claim_pool_remainder_cat`. Scalar markets
are binary markets plus `get_scalar_meta(market_id)` (`{ lower, upper }`,
display only); their resolution arrives in `get_market`'s status as
`ResolvedScalar(payout_long_bps)`.

## Circuit breakers

Markets can carry per-market breakers (snapshotted at creation): a maximum
price impact for a **single trade** (`max_impact_bps`) and a **per-ledger
band** (`band_bps`) around the price at the start of the ledger. A trade
that would move the YES price more than the impact cap reverts with
`PriceImpactTooHigh` (#21); one that would push it more than the band away
from the ledger-open price reverts with `PriceBandExceeded` (#22). The
band resets every ledger, so the worst case is ~5s of blocked trading, not
a permanent lock.

Read the config and the current band reference before quoting so your UI
can size trades that will actually execute:

- `breaker_config(market_id)` → `{ max_impact_bps, band_bps } | null`
  (`null` = old market, no breakers)
- `breaker_state(market_id)` → `{ ledger_seq, ref_price_bps } | null`
- `would_trip(market_id, outcome, collateral_in)` → bool: whether a buy of
  that size would trip either check right now. Use it to warn users before
  they sign; `quote_buy` is not filtered by the breakers.

There is deliberately no on-chain "breaker tripped" event (a reverted
invocation's events are rolled back with it) — surface trips to users from
the error codes above and the views here.

## Selling an exact share count

`sell` takes an exact `collateral_out`, not a share count — market-core has
no on-chain sqrt (see the docstring on `sell` in
`contracts/market-core/src/lib.rs`). To sell a specific number of shares:

1. Compute the matching `collateral_out` off-chain with the same quadratic
   inversion the contract's math uses. `model/fpmm_model.py`'s
   `collateral_out_for_shares(r_sold, r_other, shares_in, fee_bps)` is the
   reference implementation; `agents/core`'s TypeScript port (BigInt-based,
   for the browser/Node) is `grossForShares` / `collateralOutForShares` in
   `agents/core/src/fpmm.ts`.
2. Read the market's current `reserve_yes`/`reserve_no` and `fee_bps` via
   `get_market(market_id)` to feed that function.
3. Call `sell` with the computed `collateral_out` and a `max_shares_in` set
   a little above your target share count (the off-chain estimate can be off
   by roughly one unit of rounding — see the property test in
   `model/fpmm_model.py` — and the pool may have moved between your read and
   your transaction).

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
frontend's check should match.
