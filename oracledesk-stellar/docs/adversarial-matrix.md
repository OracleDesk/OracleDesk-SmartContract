# Adversarial Dependency Behaviour Matrix

This matrix documents how OracleDesk's core contracts (`market-core`, `resolver`, and `treasury`) behave when called with hostile SEP-41 collateral tokens or hostile SEP-40 oracles from `contracts/adversarial-mocks/` (Issue #137).

Every **fails-safely** and **fixed** row is backed by a test asserting storage and balance atomicity (`snapshot_before == snapshot_after`) on revert.

## Classification Legend

- **fixed**: Previously risked corrupting accounting or settling on invalid data; hardened on-chain (`CollateralShortfall` balance-delta check on inbound transfers; `InvalidPrice` rejection for `price <= 0`).
- **fails-safely**: Whole Soroban transaction reverts atomically; storage and token balances remain byte-for-byte unchanged.
- **tolerated**: Contract accounting does not rely on the hostile behavior (for example `LyingBalanceToken`, because `market-core` tracks `sets_minted` and `fees_accrued` internally instead of trusting `balance()`), or the behavior is inherent to trusting the committed dependency (for example an extreme positive price from a creator-committed oracle).
- **accepted-risk**: External collateral liveness risk that cannot be fixed on-chain once funds are custodied (for example a token issuer freezing transfers after users buy).

## `market-core` vs Hostile SEP-41 Tokens

| Entrypoint | Hostile Mock | Expected Class | Test Name | Notes |
|---|---|---|---|---|
| `create_market` | `PanicToken` | fails-safely | `adversarial_create_market_with_panic_token_leaves_no_market` | Market count and storage roll back atomically. |
| `create_market` | `ShortToken` | fixed | `adversarial_create_market_with_short_token_reverts_with_collateral_shortfall` | Balance-delta check rejects under-delivery with `Error::CollateralShortfall` (32). |
| `create_market` | `LyingBalanceToken` | tolerated | `adversarial_create_market_with_lying_balance_succeeds_exact` | Delta `(after - before)` cancels constant additive offset; internal accounting never trusts raw `balance()`. |
| `create_market` | `BudgetBurnerToken` | fails-safely | `adversarial_create_market_with_budget_burner_reverts_cleanly` | Exceeding CPU budget aborts transaction atomically. |
| `create_market` | `FlipFlopToken` | fails-safely | `adversarial_create_market_with_flipflop_token_reverts_when_frozen` | Frozen transfer aborts cleanly before persisting market. |
| `create_market` | `ReentrantToken` | fails-safely | `adversarial_reentrant_token_cannot_reenter_buy` | Targeted-auth callback into `market-core` fails Soroban reentrancy / auth check. |
| `buy` / `buy_v2` | `ShortToken` | fixed | `adversarial_buy_with_short_token_reverts_with_collateral_shortfall` | Balance-delta check rejects fee-on-transfer / short transfer with `Error::CollateralShortfall` (32). |
| `buy` / `buy_v2` | `PanicToken` | fails-safely | `adversarial_buy_with_panic_token_preserves_state` | Reserves, positions, and balances unchanged on panic. |
| `buy` / `buy_v2` | `LyingBalanceToken` | tolerated | `adversarial_sweep_fees_ignores_lying_balance` | Market accounting tracks exact `sets_minted` / `fees_accrued`. |
| `buy` / `buy_v2` | `BudgetBurnerToken` | fails-safely | `adversarial_buy_with_budget_burner_reverts_cleanly` | Exceeding budget reverts entire buy atomically. |
| `buy` / `buy_v2` | `FlipFlopToken` | fails-safely | `adversarial_buy_with_flipflop_token_reverts_when_frozen` | Frozen transfer leaves reserves and positions unchanged. |
| `buy` / `buy_v2` | `ReentrantToken` | fails-safely | `adversarial_reentrant_token_cannot_reenter_buy` | Soroban host forbids reentrant contract call (and targeted auth rejects spoofed trader). |
| `sell` / `sell_v2` | `FlipFlopToken` | fails-safely | `adversarial_sell_with_flipflop_token_preserves_position_on_revert` | Outbound transfer panic rolls back position and reserve updates. |
| `sell` / `sell_v2` | `PanicToken` | fails-safely | `adversarial_sell_with_flipflop_token_preserves_position_on_revert` | Equivalent outbound panic revert. |
| `redeem` | `BudgetBurnerToken` | fails-safely | `adversarial_redeem_with_budget_burner_reverts_cleanly` | Position remains intact on budget exhaustion. |
| `redeem` | `FlipFlopToken` | accepted-risk / fails-safely | `adversarial_redeem_with_frozen_flipflop_preserves_position` | Reverts cleanly without burning position; permanent freeze by collateral issuer is an accepted collateral-selection risk. |
| `claim_pool_remainder` | `FlipFlopToken` | fails-safely | `adversarial_claim_pool_remainder_with_flipflop_preserves_lp_state` | `lp_claimed` and reserves roll back when outbound transfer fails. |
| `sweep_fees` | `LyingBalanceToken` | tolerated | `adversarial_sweep_fees_ignores_lying_balance` | Sweeps exact `fees_accrued` regardless of inflated `balance()`. |
| `sweep_fees` | `FlipFlopToken` | fails-safely | `adversarial_sweep_fees_with_flipflop_preserves_fees` | `fees_accrued` rolls back on transfer revert. |

## `resolver` vs Hostile SEP-40 Oracles

| Entrypoint | Hostile Mock | Expected Class | Test Name | Notes |
|---|---|---|---|---|
| `resolve_price` | `ExtremeOracle` (`0`, `-1`, `i128::MIN`) | fixed | `adversarial_resolve_price_rejects_zero_and_negative_price` | Returns `Error::InvalidPrice` (10); `State` stays `Unconfigured`. |
| `resolve_price` | `ExtremeOracle` (`i128::MAX`) | tolerated | `adversarial_resolve_price_extreme_positive_price_tolerated` | Extreme positive prices are trusted by creator commitment (`PriceConfig` XDR is immutable per ADR 0001). |
| `resolve_price` | `FutureOracle` | fails-safely | `adversarial_future_dated_price_is_stale` | Returns `Error::StalePrice` (9); `State` stays `Unconfigured`. |
| `resolve_price` | `NoneOracle` | fails-safely | `adversarial_none_oracle_fails_safely` | Returns `Error::StalePrice` (9) after grid lookback; `State` unchanged. |
| `resolve_price` | `PanicOracle` | fails-safely | `adversarial_resolve_price_with_panic_oracle_keeps_state_unconfigured` | Caught via `try_price` -> `Error::PriceUnavailable` (8); `State` stays `Unconfigured`. |
| `resolve_price` | `BudgetBurnerOracle` | fails-safely | `adversarial_budget_burner_oracle_reverts_cleanly` | Budget exhaustion aborts transaction; `State` stays `Unconfigured`. |
| `resolve_price` | `WrongShapeOracle` | fails-safely | `adversarial_wrong_shape_oracle_fails_safely` | Host Val conversion error mapped to `Error::PriceUnavailable` (8); `State` stays `Unconfigured`. |
| `guardian_void_market` | All 6 hostile oracles | fails-safely / escape hatch | `adversarial_guardian_void_succeeds_after_oracle_failure` | Guardian void with `GuardianReason::OracleUnavailable` succeeds after `ORACLE_GRACE_SECS` for every non-settling hostile oracle. |

## `treasury` vs Hostile SEP-41 Tokens

| Entrypoint | Hostile Mock | Expected Class | Test Name | Notes |
|---|---|---|---|---|
| `agent_create_market` | `ShortToken` | fails-safely | `adversarial_treasury_agent_create_market_short_token_keeps_caps` | `market-core` reverts with `CollateralShortfall`; treasury daily/market caps and creation counters roll back. |
| `agent_buy` | `ShortToken` / `FlipFlopToken` | fails-safely | `adversarial_treasury_agent_buy_revert_keeps_daily_usage` | Reverted `market-core` call leaves `Daily` usage and `Market(id)` exposure byte-for-byte unchanged. |
| `agent_sell` | `FlipFlopToken` | fails-safely | `adversarial_treasury_agent_sell_revert_keeps_exposure` | Reverted sell leaves treasury net exposure and positions unchanged. |
| `redeem` / `claim_pool_remainder` | `FlipFlopToken` | fails-safely | `adversarial_treasury_settlement_revert_keeps_state` | Reverted settlement preserves treasury open-market accounting. |
| `collect_market_fees` | `FlipFlopToken` | fails-safely | `adversarial_treasury_collect_fees_revert_keeps_state` | Reverted fee sweep leaves market fees untouched. |
| `deposit` / `request_withdraw` | `FlipFlopToken` / `PanicToken` | fails-safely | `adversarial_treasury_deposit_and_withdraw_revert_cleanly` | Share supply and user share balances roll back atomically on token panic. |
