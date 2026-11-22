# ADR 0009: Atomic router for multi-step flows

## Status

Accepted.

## Context

Several flows are naturally multi-step and are only correct if every step
lands together:

- A market must be created **and** the resolution rule revealed. ADR 0001
  splits this into a commit (at creation) and a reveal, but a creator that
  creates a market and never reveals leaves it unresolvable, and the
  reveal's hash must match the commitment exactly.
- A trade should be accompanied by a reasoning trace. The registry exists for
  exactly this, but a client that calls `market-core.buy` and then drops the
  `publish_trace` call produces an unaccountable trade.

Doing these from a client means several transactions: a partial failure
(e.g. the reveal hash mismatch, or the process dying between the buy and the
trace) leaves an inconsistent state that nobody re-checks. Having each client
orchestrate the calls also means each one decides *which* resolver and
registry to trust.

## Decision

Add a stateless `router` contract (`contracts/router`) whose only stored value
is an address book.

### Immutable address book

`__constructor(market_core, resolver, reasoning_registry: Option)` stores a
`RouterConfig` once. There is no privileged role — the values never change —
so the router cannot be repointed at a hostile resolver mid-flight and callers
need no per-call address arguments. `config()` exposes it.

### Atomic entrypoints

- `create_and_reveal_signers(creator, ..., spec_v2)` and
  `create_and_reveal_price(...)` — create the market through market-core and
  reveal its spec through the resolver in one transaction. The commitment is
  computed from `spec_v2` **locally** (mirroring the resolver's own hashing)
  and passed to `market-core.create_market`, so the commitment and the reveal
  are consistent by construction; a mismatch is impossible rather than merely
  checked. Emits `MarketCreatedAndRevealed`.
- `reveal_spec(market_id, spec_v2)` — the deferred reveal for a market created
  by the commit-now/reveal-later path, validating the rule before
  `resolver.register_spec_v2`.
- `trade_and_publish_trace(trader, market_id, outcome, side, bounds, trace)` —
  trades through market-core's `buy_v2`/`sell_v2` (limit price, deadline and
  share bounds) and publishes a typed `TraceAction` in the same transaction.
  `TraceArgs.chain` and `TraceArgs.sig` select one of `publish_trace`,
  `publish_chained_trace`, `publish_trace_signed` or
  `publish_chained_trace_signed`. A non-positive trade result fails in every
  profile with `InvalidTradeResult` (the old `debug_assert!` disappeared in
  release builds). Emits `TradeTraced { market_id, trader, side, shares,
  trace_id, chain_seq }`. The action must be `Buy`/`Sell` to match `side`
  (`ActionMismatch`), and the CID is checked against the registry's 128-byte
  bound before any call.
- `agent_trade_and_publish_trace(treasury, agent, market_id, outcome, side,
  bounds, trace)` — the same atomic flow with the treasury's capital via
  `agent_buy_v2`/`agent_sell_v2`, publishing the trace as `agent`. Because the
  treasury address is caller-supplied, the router first checks
  `treasury.get_global().market_core == cfg.market_core` and
  `market_core.get_config().treasury == treasury`; a hostile treasury gets
  `TreasuryMismatch` before any trade or trace.
- `buy_and_publish_trace` — deprecated one-release wrapper over the direct
  buy path. It drops the old `action: String` argument (breaking change, see
  `packages/bindings/router/CHANGELOG.md`), uses `TraceAction::Buy`, an
  unbounded limit price and the current timestamp as deadline. It returns a
  `TradeTraceResult`, not a bare trace id. Remove in the next minor version.

### Authorization

Each entrypoint calls `creator.require_auth()` / `trader.require_auth()` /
`agent.require_auth()` at the **root** of the call tree. Downstream contracts
call `require_auth` for the same address deeper down; a non-root
`require_auth` fails unless the address is already anchored, so the router
anchors it first. A caller still authorizes exactly one account — the router
adds no authority of its own. The exact trees are:

```
trader → router.trade_and_publish_trace
         ├─ market_core.buy_v2 → token.transfer(trader → core)
         └─ registry.publish_*

agent → router.agent_trade_and_publish_trace
        ├─ treasury.agent_buy_v2
        └─ registry.publish_*
```

The treasury's token pull is pre-authorized inside treasury
(`authorize_token_pull` with `authorize_as_current_contract`), so no extra
signature is needed for the nested transfer. The signed publishing variants
need no extra auth either: the registry verifies the Ed25519 signature over
`trace_attestation_message`. `chain_seq` is read back with `agent_chain_head`;
a concurrent publish by the same agent reverts the whole call with
`ChainHeadMismatch`, so clients should retry with a fresh head.

`reasoning_registry` is optional: if it is `None`, all trade+trace entrypoints
return `NotInitialized`.

## Consequences

- The create+reveal and buy+trace flows are all-or-nothing; there is no window
  in which a market exists without its rule or a trade exists without its
  trace.
- Clients point at one router address and never choose a resolver or registry
  themselves, so they cannot be tricked into a different one.
- The router holds no funds, no roles and no admin, so it is not a target for
  a governance action and needs no timelock.
