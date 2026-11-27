# OracleDesk Protocol Specification — treasury Contract

This document specifies the treasury contract, which manages agent risk limits and delegated market creation.

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `DAY_SECONDS` | 86400 | Rolling window for daily usage cap. |
| `DAY_IN_LEDGERS` | 17280 | Approximately 24 hours / 5-second slot. |
| `BUMP_EXPOSURE_ENTRY` | 2592000 | TTL bump for exposure ledger (30 days). |

## Instance Storage

| Key | Type | Notes |
|-----|------|-------|
| `I[Admin]` | `Address` | Admin address. |
| `I[Collateral]` | `Address` | The SEP-41 token (usually USDC). |
| `I[MarketCore]` | `Address` | The market-core contract. |
| `I[Resolver]` | `Address` | The resolver contract. |
| `I[TreasuryBalance]` | `i128` | Current balance in collateral. |

---

## Persistent Storage (Risk Config per Agent)

| Key | Type | Notes |
|-----|------|-------|
| `P[RiskConfig(agent)]` | `RiskConfig` | Agent's caps and state. |
| `P[Exposure(agent, market_id)]` | `i128` | Cumulative exposure for this agent in this market. |
| `P[DailyUsageTimestamp(agent)]` | `u64` | Ledger timestamp of last daily reset. |
| `P[DailyUsageAmount(agent)]` | `i128` | Current daily usage sum. |

**RiskConfig struct:**

```rust
pub struct RiskConfig {
    pub max_daily: i128,      // Max capital deployed in 24-hour window
    pub max_market: i128,     // Max exposure per market
    pub max_trade: i128,      // Largest single buy/trade cap
}
```

---

## Entrypoints

### `deposit`

Deposits collateral into the treasury.

**TR-DEPOSIT-AUTH-1** `auth(depositor)`.

**TR-DEPOSIT-PRE-1** `amount > 0` else `InvalidAmount(1)`.

**TR-DEPOSIT-POST-1** `collateral.transfer(depositor, treasury, amount)` executed.
**TR-DEPOSIT-POST-2** `I[TreasuryBalance]` += `amount`.

**TR-DEPOSIT-EVT-1** `Deposited { depositor, amount }`.

---

### `withdraw`

Withdraws collateral from the treasury.

**TR-WITHDRAW-AUTH-1** `auth(admin)`.

**TR-WITHDRAW-PRE-1** `I[TreasuryBalance] >= amount` else `InsufficientBalance(2)`.

**TR-WITHDRAW-POST-1** `collateral.transfer(treasury, recipient, amount)` executed.
**TR-WITHDRAW-POST-2** `I[TreasuryBalance]` -= `amount`.

**TR-WITHDRAW-EVT-1** `Withdrawn { recipient, amount }`.

---

### `agent_create_market`

Agent creates a market (without bounty).

**TR-AGENT_CREATE_MARKET-AUTH-1** `auth(agent)`.

**TR-AGENT_CREATE_MARKET-PRE-1** `P[RiskConfig(agent)]` exists else `AgentNotRegistered(3)`.
**TR-AGENT_CREATE_MARKET-PRE-2** `seed_amount <= P[RiskConfig(agent)].max_trade` else `CapExceeded(4)`.
**TR-AGENT_CREATE_MARKET-PRE-3** `P[Exposure(agent, next_market_id)] + seed_amount <= P[RiskConfig(agent)].max_market` else `MarketCapExceeded(5)`.
**TR-AGENT_CREATE_MARKET-PRE-4** Daily usage cap not exceeded (checked).
**TR-AGENT_CREATE_MARKET-PRE-5** Treasury has sufficient balance: `I[TreasuryBalance] >= seed_amount`.

**TR-AGENT_CREATE_MARKET-POST-1** Pre-authorizes `transfer(treasury, market_core, seed_amount)` via `authorize_as_current_contract`.
**TR-AGENT_CREATE_MARKET-POST-2** Calls `market_core.create_market(...)`.
**TR-AGENT_CREATE_MARKET-POST-3** `P[Exposure(agent, market_id)]` = `seed_amount`.
**TR-AGENT_CREATE_MARKET-POST-4** `P[DailyUsageAmount(agent)]` += `seed_amount` (rolling cap).
**TR-AGENT_CREATE_MARKET-POST-5** `I[TreasuryBalance]` -= `seed_amount`.

**TR-AGENT_CREATE_MARKET-EVT-1** `MarketCreatedByAgent { agent, market_id, seed_amount }`.

---

### `agent_create_market_with_bounty` (New, Issue #149)

Agent creates a market with a resolution bounty.

**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-AUTH-1** `auth(agent)`.

**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-PRE-1** `P[RiskConfig(agent)]` exists.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-PRE-2** `seed_amount + bounty_amount <= P[RiskConfig(agent)].max_trade` else `CapExceeded(4)`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-PRE-3** Exposure cap: `P[Exposure(agent, market_id)] + seed_amount + bounty_amount <= P[RiskConfig(agent)].max_market`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-PRE-4** Daily usage cap: `P[DailyUsageAmount(agent)] + seed_amount + bounty_amount <= P[RiskConfig(agent)].max_daily`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-PRE-5** Treasury balance sufficient.

**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-1** Pre-authorizes two transfers in one `authorize_as_current_contract` vector:
  - `transfer(treasury, market_core, seed_amount)`.
  - `transfer(treasury, resolver, bounty_amount)`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-2** Calls `market_core.create_market(...)` with seed_amount.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-3** Calls `resolver.fund_bounty(treasury, market_id, bounty_amount)`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-4** `P[Exposure(agent, market_id)]` = `seed_amount + bounty_amount`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-5** `P[DailyUsageAmount(agent)]` += `seed_amount + bounty_amount`.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-POST-6** `I[TreasuryBalance]` -= `seed_amount + bounty_amount`.

**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-EVT-1** `MarketCreatedByAgentWithBounty { agent, market_id, seed_amount, bounty_amount }`.

**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-ERR-1** `CapExceeded(4)` if total exceeds max_trade.
**TR-AGENT_CREATE_MARKET_WITH_BOUNTY-ERR-2** `MarketCapExceeded(5)` if market exposure exceeds max_market.

---

### `agent_buy`

Agent buys shares in a market.

**TR-AGENT_BUY-AUTH-1** `auth(agent)`.

**TR-AGENT_BUY-PRE-1** `P[RiskConfig(agent)]` exists.
**TR-AGENT_BUY-PRE-2** `collateral_in <= P[RiskConfig(agent)].max_trade` else `CapExceeded(4)`.
**TR-AGENT_BUY-PRE-3** New exposure: `P[Exposure(agent, market_id)] + collateral_in <= P[RiskConfig(agent)].max_market`.
**TR-AGENT_BUY-PRE-4** Daily usage cap not exceeded.
**TR-AGENT_BUY-PRE-5** Treasury balance sufficient.

**TR-AGENT_BUY-POST-1** Pre-authorizes `transfer(treasury, market_core, collateral_in)`.
**TR-AGENT_BUY-POST-2** Calls `market_core.buy(agent, market_id, outcome, collateral_in, min_shares_out)`.
**TR-AGENT_BUY-POST-3** `P[Exposure(agent, market_id)]` += `collateral_in`.
**TR-AGENT_BUY-POST-4** `P[DailyUsageAmount(agent)]` += `collateral_in`.
**TR-AGENT_BUY-POST-5** `I[TreasuryBalance]` -= `collateral_in`.

**TR-AGENT_BUY-EVT-1** `AgentBought { agent, market_id, outcome, collateral_in }`.

---

### `close_trade`

Closes an agent's position in a market (bookkeeping; exposure not freed).

**TR-CLOSE_TRADE-AUTH-1** `auth(admin)` or design choice TBD.

**TR-CLOSE_TRADE-PRE-1** `P[Exposure(agent, market_id)]` > `0` else `NoExposure(6)`.

**TR-CLOSE_TRADE-POST-1** `P[Exposure(agent, market_id)]` remains unchanged (design choice: not freed).

**TR-CLOSE_TRADE-EVT-1** `TradeClosed { agent, market_id }`.

**NOTES** Exposure is never freed; it counts against caps until `close_trade` is called (design choice for conservative risk model).

---

### `redeem`

Agent redeems a finalized market position.

**TR-REDEEM-AUTH-1** `auth(agent)` or admin.

**TR-REDEEM-PRE-1** Market status == `Finalized`.

**TR-REDEEM-POST-1** Calls `market_core.redeem(agent, market_id)`.

**TR-REDEEM-EVT-1** `Redeemed { agent, market_id, payout }`.

---

### `claim_pool_remainder`

Agent claims LP fees and pool remainder for a finalized market.

**TR-CLAIM_POOL_REMAINDER-AUTH-1** `auth(agent)` or admin.

**TR-CLAIM_POOL_REMAINDER-PRE-1** Market status == `Finalized`.

**TR-CLAIM_POOL_REMAINDER-POST-1** Calls `market_core.claim_pool_remainder(agent, market_id)`.

**TR-CLAIM_POOL_REMAINDER-EVT-1** `PoolRemainderClaimed { agent, market_id, amount }`.

---

### `collect_market_fees`

Sweeps protocol fees from a market to the treasury.

**TR-COLLECT_MARKET_FEES-AUTH-1** `auth(admin)` or permissionless (design choice).

**TR-COLLECT_MARKET_FEES-PRE-1** Market exists and has accrued fees.

**TR-COLLECT_MARKET_FEES-POST-1** Calls `market_core.sweep_fees(market_id)`.
**TR-COLLECT_MARKET_FEES-POST-2** Treasury receives fees; balance updated.

**TR-COLLECT_MARKET_FEES-EVT-1** `FeesCollected { market_id, amount }`.

---

### `daily_usage`

View: returns the current daily usage for an agent.

**TR-DAILY_USAGE-PRE-1** No preconditions.

**TR-DAILY_USAGE-POST-1** Returns `{used: amount, max: P[RiskConfig(agent)].max_daily, remaining}` or zero if no config.

**NOTES** Rolls over after `DAY_SECONDS` from the last reset timestamp.

---

## Error Codes (Treasury)

| Code | Name | Trigger |
|------|------|---------|
| 1 | `InvalidAmount` | Deposit/withdraw amount <= 0. |
| 2 | `InsufficientBalance` | Treasury balance < amount. |
| 3 | `AgentNotRegistered` | Agent not in risk config. |
| 4 | `CapExceeded` | Trade size > max_trade. |
| 5 | `MarketCapExceeded` | Exposure for market > max_market. |
| 6 | `DailyCapExceeded` | Daily usage would exceed max_daily. |
| 7 | `NoExposure` | No exposure to close. |

---

## Invariants

- `SYS-INV-7`: Treasury exposure monotone per market (only increases or resets).
- Exposure counts seed + bounty (new).
- Daily usage rolling window enforced at `agent_create_market` and `agent_buy`.

## See Also

- `contracts/treasury/src/lib.rs` — implementation.
- `docs/spec/system.md` — Sequence 1 (agent market creation with bounty).
