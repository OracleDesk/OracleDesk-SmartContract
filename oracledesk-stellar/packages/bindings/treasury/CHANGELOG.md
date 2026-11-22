# Changelog

## 0.2.0

Operating-mode state machine (#272) and on-chain resolvability policy (#273).

- Breaking: error Error: definition changed
- **Breaking (error enum).** The generated `Error` now carries the
  market-core mirrors `MarketCore*` (2031-2042) that a merge had dropped, plus
  new codes: `EmergencyMode` 64, `NotRecovered` 65, `ResolverMismatch` 66,
  `SpecNotRevealed` 67, `SpecKindNotAllowed` 68, `MarketDisputed` 69,
  `ProposalOpen` 70, `PastResolutionDeadline` 71, `TooCloseToClose` 72,
  `ResolverCallFailed` 73. `NotAcknowledged` (48) stays allocated, unused.
- **Behaviour.** A drawdown halt stops agent openings only and no longer opens
  `emergency_withdraw`, which now requires `Mode::Emergency`. `close_trade` is
  refused while admin-paused. `agent_buy`/`agent_buy_v2` enforce the
  resolvability policy (default: fully permissive, so unchanged until tightened).
- **New functions.** `pause`, `unpause`, `resume_agents`, `declare_emergency`,
  `end_emergency`, views `mode`, `mode_state`, `allowed`;
  `agent_create_and_reveal_v2` (no resolver argument);
  `get/set/execute/cancel/pending_resolvability_policy`.
- **Deprecated.** `acknowledge_drawdown` is a no-op (use `resume_agents`);
  `agent_create_market_and_reveal` now rejects a resolver other than
  market-core's configured one (`ResolverMismatch`).
- **New types/events.** `Mode`, `ModeState`, `Op`, `ResolvabilityPolicy`,
  `PendingResolvability`; events `ModeChanged`, `ResolvabilityPolicyProposed`,
  `ResolvabilityPolicySet`, `ResolvabilityPolicyCancelled`.

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.

Includes the merged permissionless-settlement, PnL/drawdown, creation-policy and
yield-venue APIs that were missing from the previous generated bindings. Keeps
published error codes 1–33 stable and assigns previously conflicting additions
to unused codes 44–58.
