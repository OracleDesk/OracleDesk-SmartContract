# Changelog

## 0.1.1

- Added views `spec_kind(market_id) -> SpecKind` and `trade_status(market_id)
  -> TradeStatus` (#273), which tell "revealed" from "not revealed" (the
  resolution state cannot) and give the treasury everything its pre-buy check
  needs in one call.
- Regenerated from source: the committed bindings predated the scaled-price,
  TWAP and `preview_price` entrypoints, which now appear. The `Error` enum gains
  the `MarketCore*` / `RegistryCallFailed` codes (1042-1054).

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.
