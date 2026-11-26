# Changelog

## 0.2.0

- Regenerated from source; the committed bindings had drifted from the
  contract (functions, types and errors already changed on `develop` now
  appear), which is part of why this is a breaking release.
- #322: trace actions are validated against live market and resolver state.
  New errors `MarketClosed` (3050), `MarketNotFinal` (3051),
  `NotMarketCreator` (3052), `NotResolutionSigner` (3053), `MarketNotClosed`
  (3054), `UnknownOtherAction` (3055), `LimitExceeded` (3056). New admin
  `set_action_grace`, `set_other_action`; views `action_grace`,
  `is_trace_late`, `other_action_rule`, `other_actions`; type `OtherRule`.
  **Breaking:** `TraceVerdict` gains `Late`, and `Other(Symbol)` actions must
  now be allow-listed before they can be published.

Breaking interface changes (from `interface-manifest check`):

- fn agent_trace_at: arg "seq" renamed to "index" at position 1
- fn publish_chained_trace: arg "action" retyped
- fn publish_trace: arg "action" retyped
- type DataKey: removed
- type Trace: definition changed
- error Error: definition changed
- event TracePublished: definition changed

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.
