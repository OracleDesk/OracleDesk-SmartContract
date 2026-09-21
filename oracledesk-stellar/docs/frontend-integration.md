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
