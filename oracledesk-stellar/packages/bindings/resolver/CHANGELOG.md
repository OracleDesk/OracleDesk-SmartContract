# Changelog

## 0.2.0

- Regenerated from source; the committed bindings had drifted from the
  contract (functions, types and errors already changed on `develop` now
  appear), which is part of why this is a breaking release.
- #326: `submit_signatures_v2(market_id, outcome: AttestedOutcome, round, sigs)`
  over the `oracledesk-attest-v2` message, so weighted-key committees can
  attest `Invalid`. New views `signature_weight`, `attest_v1_disabled`; new
  admin `disable_attest_v1`; new event `SignaturesSubmitted`.
  **Deprecation:** v1 `submit_signatures` stays accepted for Yes/No during the
  transition. Operators should switch every signer to v2 and then call
  `disable_attest_v1` (one-way); from then on v1 returns `WrongMode`.
- #321: `snapshot_price` supports `PriceScaled` markets (pins `decimals()`);
  new `snapshot_twap_samples`, views `twap_samples`, `twap_grid`,
  `scaled_snapshot`; types `TwapSlot`, `ScaledSnapshot`; events
  `TwapSamplesSnapshotted`, `PriceResolutionSource`.
- #322: read-only `resolution_role(market_id, who, keys) -> ResolutionRole`.
- Renamed `consent_market_resolver_migration` to `consent_resolver_migration`
  (the old name exceeded Soroban's 32-character limit, so the contract did not
  build).

Breaking interface changes (from `interface-manifest check`):

- type FallbackAuthority: added
- type HybridConfigV2: added
- type ResolutionSpec: definition changed
- error Error: definition changed

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
