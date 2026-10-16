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
  min_shares_out: 0n,         // see slippage note below
});
const { result } = await tx.signAndSend({ signTransaction });
```

## Slippage on `buy`

`quote_buy(market_id, outcome, collateral_in)` returns the exact shares a
buy would receive *right now*. Call it immediately before building the
`buy` transaction, then pass a `min_shares_out` a few bps below that quote
(prices move between simulation and submission).

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
