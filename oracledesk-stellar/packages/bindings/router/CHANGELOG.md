# Changelog

## 0.2.0

- **Breaking:** `buy_and_publish_trace` no longer takes `action: string`; it is now a deprecated wrapper returning `TradeTraceResult` and using `TraceAction::Buy` with unbounded price and the current ledger timestamp as deadline.
- **Breaking:** the trace `action` is a typed `TraceAction` union (`Buy`, `Sell`, `Other`, …) rather than `string`.
- Added `trade_and_publish_trace` with `Side`, `TradeBounds`, typed `TraceArgs` (optional chained and signed publishing) and `TradeTraceResult`.
- Added `agent_trade_and_publish_trace` for trades routed through a verified treasury.
- Added errors `ActionMismatch` (6), `InvalidTradeResult` (7) and `TreasuryMismatch` (8), and the `TradeTraced` event.

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.
