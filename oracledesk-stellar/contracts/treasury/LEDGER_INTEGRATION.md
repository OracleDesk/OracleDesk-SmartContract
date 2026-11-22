# Treasury Ledger Segregation Integration Guide

This document provides step-by-step integration instructions for the ledger segregation feature (Issue #141).

## Overview

The ledger module (`src/ledger.rs`) provides:
- `Bucket` enum: `AgentCapital`, `ProtocolRevenue`, `Unallocated`
- `Ledger` struct: internal balance tracking
- Helper functions: `load_ledger`, `save_ledger`, `credit`, `debit`, `reconcile_balance`, `check_invariant`
- Events: `UnattributedInflow`, `BalanceShortfall`, `BucketTransfer`

## Integration Checklist

### 1. Add Module Declaration to lib.rs

```rust
mod ledger;
pub use ledger::{Bucket, Ledger, credit, debit, reconcile_balance, check_invariant};
pub use ledger::{UnattributedInflow, BalanceShortfall, BucketTransfer};
```

### 2. Add New DataKey Variants (in DataKey enum)

```rust
#[contracttype]
pub enum DataKey {
    // ... existing keys ...
    
    /// Ledger with internal bucket balances (Issue #141)
    Ledger,
}
```

### 3. Add New Error Codes (after Error::InvalidResolution)

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    // ... existing errors up to InvalidResolution = 63 ...
    
    /// Insufficient balance in requested bucket (Issue #141)
    BucketInsufficient = 64,
}
```

### 4. Modify Treasury Implementation

#### 4.1 Constructor (__constructor)

After the existing config initialization:

```rust
// Initialize ledger with zero balances
let initial_ledger = Ledger {
    agent_capital: 0,
    protocol_revenue: 0,
    unallocated: 0,
    last_seen_balance: 0,
};
env.storage().instance().set(&DataKey::Ledger, &initial_ledger);
```

#### 4.2 Agent Buy (agent_buy, agent_create_market)

**At the start of the function (after authorization checks):**

```rust
// Reconcile any unexplained inflows before spending
let token = token::Client::new(&env, &config.collateral);
let real_balance = token.balance(&env.current_contract_address());
let mut ledger = ledger::load_ledger(&env);
let (_, is_paused) = ledger::reconcile_balance(&env, &mut ledger, real_balance);

if is_paused {
    panic_with_error!(&env, Error::Paused);
}

// Debit agent capital before market-core call
ledger::debit(&env, &mut ledger, Bucket::AgentCapital, spend_amount)?;

// Update last_seen_balance BEFORE market-core call (so we can recover on failure)
ledger.last_seen_balance = real_balance;
ledger::save_ledger(&env, &ledger);
```

**After successful market-core call:**

```rust
// Market-core succeeded; update real balance
let new_real_balance = token.balance(&env.current_contract_address());
ledger.last_seen_balance = new_real_balance;
ledger::save_ledger(&env, &ledger);
```

**On market-core failure (atomic rollback):**

Credit back the amount (ledger changes roll back as part of transaction)

#### 4.3 Agent Sell / Redeem / Claim Pool Remainder

**After proceeds are received from market-core:**

```rust
// Proceeds flow back as agent capital
let mut ledger = ledger::load_ledger(&env);
ledger::credit(&mut ledger, Bucket::AgentCapital, proceeds_amount);

let token = token::Client::new(&env, &config.collateral);
let new_real_balance = token.balance(&env.current_contract_address());
ledger.last_seen_balance = new_real_balance;
ledger::save_ledger(&env, &ledger);
```

#### 4.4 Deposit (new signature)

Add a new overload:

```rust
pub fn deposit(env: Env, from: Address, amount: i128, bucket: Bucket) {
    // ... existing checks ...
    
    // Transfer token in
    let token = token::Client::new(&env, &config.collateral);
    token.transfer(&from, &env.current_contract_address(), &amount);
    
    // Update ledger
    let mut ledger = ledger::load_ledger(&env);
    if bucket == Bucket::ProtocolRevenue {
        // Only admin can deposit directly to revenue bucket
        config.admin.require_auth();
    }
    
    ledger::credit(&mut ledger, bucket, amount);
    let token_balance = token.balance(&env.current_contract_address());
    ledger.last_seen_balance = token_balance;
    ledger::save_ledger(&env, &ledger);
    
    env.events().publish(
        ("deposited",),
        Deposited { from, bucket, amount }
    );
}

// Keep old signature for compatibility
pub fn deposit(env: Env, from: Address, amount: i128) {
    deposit(&env, from, amount, Bucket::Unallocated);
}
```

#### 4.5 Collect Market Fees

Replace the existing implementation with:

```rust
pub fn collect_market_fees(env: Env, market_id: u64) -> i128 {
    // ... existing admin check ...
    
    // Reconcile first
    let token = token::Client::new(&env, &config.collateral);
    let real_balance = token.balance(&env.current_contract_address());
    let mut ledger = ledger::load_ledger(&env);
    ledger::reconcile_balance(&env, &mut ledger, real_balance);
    
    // Record pre-sweep balance
    let balance_before = real_balance;
    
    // Call market-core sweep_fees
    let market_core = MarketCoreClient::new(&env, &config.market_core);
    let _event = market_core.sweep_fees(&market_id);
    
    // Calculate increase and credit to protocol revenue
    let balance_after = token.balance(&env.current_contract_address());
    let collected = balance_after.saturating_sub(balance_before);
    
    ledger::credit(&mut ledger, Bucket::ProtocolRevenue, collected);
    ledger.last_seen_balance = balance_after;
    ledger::save_ledger(&env, &ledger);
    
    env.events().publish(
        ("fees_collected",),
        FeesCollected { market_id, amount: collected }
    );
    
    collected
}
```

#### 4.6 Withdraw (new signature)

Replace existing withdraw:

```rust
pub fn withdraw(env: Env, to: Address, bucket: Bucket, amount: i128) {
    // ... admin check ...
    
    let token = token::Client::new(&env, &config.collateral);
    let mut ledger = ledger::load_ledger(&env);
    
    // Debit requested bucket
    ledger::debit(&env, &mut ledger, bucket, amount)?;
    
    // Transfer token out
    token.transfer(&env.current_contract_address(), &to, &amount);
    
    // Update last_seen_balance
    let new_real_balance = token.balance(&env.current_contract_address());
    ledger.last_seen_balance = new_real_balance;
    ledger::save_ledger(&env, &ledger);
    
    env.events().publish(
        ("withdrawn",),
        Withdrawn { to, bucket, amount }
    );
}

// Add for backward compatibility if needed
pub fn withdraw_v1(env: Env, to: Address, amount: i128) {
    // Withdraw from first available bucket (old behavior simulation)
    // For now, error out with deprecation message
    panic!("withdraw/2 is deprecated; use withdraw/3 with explicit bucket");
}
```

#### 4.7 Add New Functions: Rebalance and Views

```rust
pub fn rebalance(env: Env, from: Bucket, to: Bucket, amount: i128) {
    // ... admin check ...
    
    let mut ledger = ledger::load_ledger(&env);
    ledger::debit(&env, &mut ledger, from, amount)?;
    ledger::credit(&mut ledger, to, amount);
    
    ledger::save_ledger(&env, &ledger);
    
    env.events().publish(
        ("bucket_transfer",),
        BucketTransfer { from, to, amount }
    );
}

pub fn get_ledger(env: Env) -> Ledger {
    ledger::load_ledger(&env)
}

pub fn bucket_balance(env: Env, bucket: Bucket) -> i128 {
    let ledger = ledger::load_ledger(&env);
    ledger.balance(bucket)
}

pub fn available_capital(env: Env) -> i128 {
    // BREAKING CHANGE: Returns only agent_capital, not full balance
    let ledger = ledger::load_ledger(&env);
    ledger.agent_capital
}

pub fn check_ledger(env: Env) -> bool {
    let token = token::Client::new(&env, &config.collateral);
    let real_balance = token.balance(&env.current_contract_address());
    let ledger = ledger::load_ledger(&env);
    ledger::check_invariant(&ledger, real_balance)
}
```

#### 4.8 Add Reconcile Function

```rust
pub fn reconcile(env: Env) -> i128 {
    let token = token::Client::new(&env, &config.collateral);
    let real_balance = token.balance(&env.current_contract_address());
    let mut ledger = ledger::load_ledger(&env);
    
    let (delta, _paused) = ledger::reconcile_balance(&env, &mut ledger, real_balance);
    
    if _paused {
        // Set paused flag in existing pause key
        env.storage().instance().set(&DataKey::Paused, &true);
    }
    
    ledger::save_ledger(&env, &ledger);
    delta
}
```

### 5. Add Events to Contract Events Section

```rust
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    pub from: Address,
    pub bucket: Bucket,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    pub to: Address,
    pub bucket: Bucket,
    pub amount: i128,
}

// (UnattributedInflow, BalanceShortfall, BucketTransfer already defined in ledger module)
```

### 6. Update Tests

Add to `contracts/integration-tests`:

```rust
#[test]
fn test_agent_buy_debits_agent_capital_only() {
    // ... setup ...
    // Verify: agent_capital decreases, protocol_revenue unchanged, unallocated unchanged
}

#[test]
fn test_agent_buy_fails_when_agent_capital_insufficient() {
    // ... setup with insufficient agent_capital ...
    // Expect: Error::BucketInsufficient
}

#[test]
fn test_third_party_sweep_fees_is_reconciled() {
    // ... deposit to unallocated, call market-core.sweep_fees directly (not via collect_market_fees) ...
    // ... call treasury.reconcile() ...
    // Verify: UnattributedInflow event emitted, amount moved to unallocated
}

#[test]
fn test_ledger_sum_never_exceeds_balance() {
    // Randomized: execute sequence of deposits, trades, reconciles
    // After each step: assert check_invariant() == true
}
```

### 7. Update Generated Bindings

After implementing:

```bash
make bindings
```

This regenerates `packages/bindings/treasury/` with new error codes and event types.

### 8. Update Documentation

Update `docs/architecture.md` treasury section with:
- New bucket architecture
- Reconciliation model
- Semantic change to `available_capital()`
- Rebalance policy (especially `ProtocolRevenue → AgentCapital` timelock requirement)

### 9. Test Checklist

- [ ] `cargo test -p treasury` passes
- [ ] `cargo test --workspace` passes
- [ ] All bucket transitions are tested
- [ ] Reconciliation edge cases covered (shortfall, unattributed inflow)
- [ ] Invariant is checked after every operation
- [ ] `make lint` passes
- [ ] Generated bindings are committed

## Breaking Changes

1. **`available_capital()` semantics change**: Returns `agent_capital` only, not full balance
   - Old behavior: sum of all three buckets
   - New behavior: agent-spendable capital only
   - Mitigation: Document clearly, update off-chain callers

2. **`withdraw()` signature change**: Now requires explicit `bucket` parameter
   - Old: `withdraw(to, amount)`
   - New: `withdraw(to, bucket, amount)`
   - Mitigation: Regenerate bindings, update all callers

## References

- `contracts/treasury/src/ledger.rs` — Helper module
- `docs/treasury-ledger.md` — Design document
- `contracts/treasury/LEDGER_INTEGRATION.md` — This file
