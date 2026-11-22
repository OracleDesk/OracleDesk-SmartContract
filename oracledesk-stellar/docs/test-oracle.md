# Deployable SEP-40 Test Oracle (`contracts/test-oracle`)

`contracts/test-oracle` is a workspace contract implementing the [SEP-40 Oracle Consumer Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md) for **testnet** and **local quickstart** deployments. It lets OracleDesk exercise the full `PriceThreshold` resolution loop (`spec-hash price` -> `agent_create_market_and_reveal` -> `test-oracle.set_price` -> `resolver.resolve_price`) end to end without depending on an external Reflector testnet feed.

> **Testnet and local only.** Never deploy `test-oracle` or commit a production market to it on mainnet.

## Interface & Semantics

### Read interface (SEP-40)

| Method | Signature | Semantics |
|---|---|---|
| `base` | `base() -> Asset` | Base currency prices are quoted in (default `Asset::Other("USD")`). |
| `assets` | `assets() -> Vec<Asset>` | Registered assets added via `add_asset` (bounded to 32). |
| `decimals` | `decimals() -> u32` | Fixed-point decimal places (default `14`, matching Reflector public feeds). |
| `resolution` | `resolution() -> u32` | Slot cadence in seconds (default `300` = 5 minutes). |
| `period` | `period() -> Option<u64>` | Retention horizon in seconds (default `86400` = 24 hours). |
| `price` | `price(asset, timestamp) -> Option<PriceData>` | Floors `timestamp` to `slot = timestamp - (timestamp % resolution)` and returns the stored record for `(asset, slot)`, or `None` if absent/pruned. |
| `prices` | `prices(asset, records) -> Option<Vec<PriceData>>` | Up to `records` (capped at 64) newest observations, newest first. |
| `lastprice` | `lastprice(asset) -> Option<PriceData>` | Most recent observation stored for `asset`. |

### Admin write API

| Method | Signature | Semantics |
|---|---|---|
| `add_asset` | `add_asset(asset)` | Admin-only, idempotent registration of an asset. |
| `set_price` | `set_price(asset, price, timestamp)` | Admin-only. Rejects unknown assets (`UnknownAsset`), timestamps not divisible by `resolution` (`MisalignedTimestamp`), and future timestamps `> ledger.timestamp()` (`FutureTimestamp`). |
| `set_prices` | `set_prices(Vec<(asset, price)>, timestamp)` | Admin-only batch write for one aligned slot (capped at 64 entries). |
| `set_period` | `set_period(period)` | Admin-only update of retention horizon (`period > 0`). |

## Slot Alignment & Staleness

Because `price(asset, ts)` floors `ts` to `slot = ts - (ts % resolution)`, an off-boundary market `close_time` receives a record timestamped up to `resolution - 1` seconds before `close_time`. The resolver enforces `close_time - data.timestamp <= max_staleness`, so any price-mode market targeting a feed with resolution `R` must choose `max_staleness >= R` (for example `max_staleness >= 300` for a 5-minute feed). If `max_staleness < R` and `close_time` is off-boundary, `resolve_price` returns `Error::StalePrice`.

## History Retention & Pruning

On each write for an asset, records at or older than `newest_slot - period` are pruned from persistent storage. If a market stays unresolved longer than `period` after its `close_time` without a `snapshot_price` pin, its closing slot ages out and `price(...)` returns `None` (`PriceUnavailable` / `StalePrice` in the resolver), matching production Reflector retention behavior.

## Deliberate Differences from Production Reflector

1. **Single admin key:** Prices are posted directly by the configured admin rather than aggregated across a multi-node Reflector quorum.
2. **Non-positive prices allowed on write:** `set_price` deliberately accepts `price <= 0` so resolver tests can verify `Error::InvalidPrice` against a real deployed SEP-40 contract.
3. **Testnet/local defaults:** `scripts/deploy-testnet.sh` deploys `test-oracle` with `base = Other("USD")`, `decimals = 14`, `resolution = 300`, `period = 86400`, and registers `Other("XLM")` (never on mainnet).

## XDR Compatibility

`test_oracle::Asset` (`Stellar(Address) | Other(Symbol)`) and `test_oracle::PriceData` (`{ price: i128, timestamp: u64 }`) mirror `oracledesk_types::{OracleAsset, PriceData}`. Because Soroban `#[contracttype]` encodes variant symbols and struct field names rather than Rust type names, their XDR encodings are byte-identical (verified by `oracle_asset_xdr_matches_test_oracle_asset` in `contracts/resolver`).

## Running the Price-Mode Demo

```bash
cd oracledesk-stellar
./scripts/deploy-testnet.sh         # deploys contracts + test-oracle (contracts.test_oracle)
MODE=price ./scripts/demo.sh        # seeds price market, waits for close, posts aligned price, resolves, verifies trace
```
