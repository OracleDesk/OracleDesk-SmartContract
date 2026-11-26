# Changelog

## 0.3.0

- Regenerated from source; the committed bindings had drifted from the
  contract (functions, types and errors already changed on `develop` now
  appear), which is part of why this is a breaking release.
- #320: per-core accounting and legacy core retirement. New entrypoints
  `settle_market_on`, `init_core_accounting`, `retire_core`, `sweep_retired`;
  views `core_status`, `known_cores`, `unattributed_net`,
  `core_accounting_initialized`, `realized_on`, `market_pnl_on`; type
  `CoreAccounting`; errors `CoreRetired` (79), `AccountingNotInitialized`
  (80), `CoreNotDrained` (81), `CoreIsCurrent` (82), `TooManyCores` (87),
  `CoreNotRetired` (88); events `CoreRetired`, `RetiredSweep`,
  `IndexEntryDropped`, `CoreAccountingInitialized`.

Breaking interface changes (from `interface-manifest check`):

- fn agent_create_market_collateral: removed
- fn allowed: removed
- fn available_capital_of: removed
- fn bucket_exposure: removed
- fn cancel_correlation_caps: removed
- fn cancel_op: removed
- fn cancel_resolvability_policy: removed
- fn category_exposure: removed
- fn correlation_caps: removed
- fn correlation_headroom: removed
- fn declare_emergency: removed
- fn deposit_token: removed
- fn end_emergency: removed
- fn execute_correlation_caps: removed
- fn execute_op: removed
- fn execute_resolvability_policy: removed
- fn exit_floor: removed
- fn get_resolvability_policy: removed
- fn mode: removed
- fn mode_state: removed
- fn pause: removed
- fn pending_correlation_caps: removed
- fn pending_op: removed
- fn pending_resolvability_policy: removed
- fn propose_correlation_caps: removed
- fn propose_op: removed
- fn resume_agents: removed
- fn set_default_exit_floor: removed
- fn set_exit_floor: removed
- fn set_mode: removed
- fn set_resolvability_policy: removed
- fn set_successor: removed
- fn set_token_caps: removed
- fn set_unwinder: removed
- fn token_caps: removed
- fn unpause: removed
- fn unwinder: removed
- fn unwound: removed
- type AdminOp: removed
- type CorrelationCaps: removed
- type MarkRecord: definition changed
- type Mode: removed
- type ModeState: removed
- type Op: removed
- type PendingAdminOp: removed
- type PendingCorrelation: removed
- type PendingResolvability: removed
- type ResolvabilityPolicy: removed
- type TokenCaps: removed
- error Error: definition changed
- event AdminOpCancelled: removed
- event AdminOpExecuted: removed
- event AdminOpProposed: removed
- event CorrelatedExposureUpdated: removed
- event CorrelationCapsCancelled: removed
- event CorrelationCapsExecuted: removed
- event CorrelationCapsProposed: removed
- event DrawdownConfigSet: removed
- event ExitFloorSet: removed
- event MarketMigrated: removed
- event ModeChanged: removed
- event ResolvabilityPolicyCancelled: removed
- event ResolvabilityPolicyProposed: removed
- event ResolvabilityPolicySet: removed
- event SuccessorSet: removed
- event TokenDeposited: removed
- event UnwindSell: removed

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
