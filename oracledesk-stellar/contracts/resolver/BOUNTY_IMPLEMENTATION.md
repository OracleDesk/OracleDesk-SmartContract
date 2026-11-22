# Bounty Implementation for Resolver (Issue #149)

This document outlines the modifications needed to add resolution bounty support to the resolver contract.

## Overview

The resolver now escrows optional per-market bounties in the collateral token. When a market is finalized via `resolve_price_for` or `finalize_signers_for`, the caller (the resolver) is paid the bounty. If the market is voided via `guardian_void_market`, the bounty is refunded to the funder.

## Code Changes Required

### 1. Add BountyEscrow Type (resolver/src/lib.rs)

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BountyEscrow {
    pub amount: i128,
    pub funder: Address,
    pub paid: bool,
}
```

**Location:** Insert near other `#[contracttype]` definitions in `lib.rs`, around line 150-200.

### 2. Add Instance Storage for Bounty Token (resolver/src/lib.rs)

Add a getter to `Resolver` impl:

```rust
impl Resolver {
    // ... existing impl ...

    fn bounty_token(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::BountyToken)
            .unwrap_or_else(|_| {
                // Default: collateral from market-core if not set
                Self::get_market_core(env).map(|_| {
                    // TODO: Fetch collateral from market-core's config
                    env.current_contract_address()
                })
                .unwrap_or(env.current_contract_address())
            })
    }

    fn set_bounty_token(env: &Env, token: Address) -> Result<(), Error> {
        env.storage()
            .instance()
            .set(&DataKey::BountyToken, &token);
        Ok(())
    }
}
```

**Location:** Add to `Resolver` impl block, around line 900-950.

### 3. Add DataKey Variants (resolver/src/lib.rs)

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum DataKey {
    // ... existing variants ...
    BountyToken,                     // Instance: token address for bounties
    Bounty(u64),                     // Persistent: BountyEscrow for market_id
}
```

**Location:** Find the existing `DataKey` enum and add these variants.

### 4. Add fund_bounty Entrypoint

```rust
pub fn fund_bounty(
    env: Env,
    funder: Address,
    market_id: u64,
    amount: i128,
) -> Result<(), Error> {
    funder.require_auth();

    // Validate market exists
    let market_core = Self::get_market_core(&env)?;
    let _market = market_core.get_market(&market_id)
        .ok_or(Error::MarketNotFound)?;

    // PRE: now < close_time
    let now = env.ledger().timestamp();
    if now >= _market.close_time {
        return Err(Error::BountyFundingClosed);
    }

    // PRE: amount > 0
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    // Load or create bounty entry
    let mut bounty: BountyEscrow = env.storage()
        .persistent()
        .get(&DataKey::Bounty(market_id))
        .unwrap_or(BountyEscrow {
            amount: 0,
            funder: funder.clone(),
            paid: false,
        });

    // PRE: Same funder or no prior bounty (single funder constraint)
    if bounty.amount > 0 && bounty.funder != funder {
        return Err(Error::BountyFunderMismatch);
    }

    bounty.amount = bounty.amount.checked_add(amount)
        .ok_or(Error::Overflow)?;
    bounty.funder = funder.clone();

    // Transfer collateral from funder to resolver
    let token = Self::bounty_token(&env);
    token::Client::new(&env, &token)
        .transfer(&funder, &env.current_contract_address(), &amount);

    // Save escrow
    env.storage()
        .persistent()
        .set(&DataKey::Bounty(market_id), &bounty);

    // Bump TTL
    env.storage()
        .persistent()
        .bump(&DataKey::Bounty(market_id), BUMP_THRESHOLD, BUMP_TO);

    env.events().publish(("BountyFunded",), (market_id, funder, amount, bounty.amount));

    Ok(())
}
```

**Location:** Add to `Resolver` impl, around line 1700-1800 (after `guardian_void_market`).

### 5. Add pay_bounty Internal Function

```rust
impl Resolver {
    // ... existing impl ...

    fn pay_bounty(env: &Env, market_id: u64, caller: &Address) -> Result<(), Error> {
        // Load bounty
        let bounty: BountyEscrow = env.storage()
            .persistent()
            .get(&DataKey::Bounty(market_id))
            .ok_or(Error::NoBounty)?;

        // PRE: not already paid
        if bounty.paid {
            return Ok(()); // Idempotent: already paid
        }

        // Update state: set paid=true BEFORE transfer (effects before interactions)
        let mut updated_bounty = bounty.clone();
        updated_bounty.paid = true;
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(market_id), &updated_bounty);

        // Transfer bounty to caller
        let token = Self::bounty_token(env);
        token::Client::new(env, &token)
            .transfer(&env.current_contract_address(), caller, &bounty.amount);

        env.events().publish(("BountyPaid",), (market_id, caller, bounty.amount));

        Ok(())
    }

    fn refund_bounty(env: &Env, market_id: u64) -> Result<(), Error> {
        // Load bounty
        let bounty: BountyEscrow = env.storage()
            .persistent()
            .get(&DataKey::Bounty(market_id))
            .ok_or(Error::NoBounty)?;

        // PRE: not already paid/refunded
        if bounty.paid {
            return Ok(()); // Already handled
        }

        // Update state
        let mut updated_bounty = bounty.clone();
        updated_bounty.paid = true;
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(market_id), &updated_bounty);

        // Refund to funder
        let token = Self::bounty_token(env);
        token::Client::new(env, &token)
            .transfer(&env.current_contract_address(), &bounty.funder, &bounty.amount);

        env.events().publish(("BountyRefunded",), (market_id, bounty.funder, bounty.amount));

        Ok(())
    }
}
```

**Location:** Add to `Resolver` impl.

### 6. Add Wrapper Entrypoints: resolve_price_for and finalize_signers_for

```rust
pub fn resolve_price_for(env: Env, caller: Address, market_id: u64) -> Result<Outcome, Error> {
    caller.require_auth();

    // Call the existing resolve_price logic
    let outcome = Resolver::resolve_price(&env, market_id)?;

    // Pay bounty (idempotent)
    Self::pay_bounty(&env, market_id, &caller)?;

    Ok(outcome)
}

pub fn finalize_signers_for(env: Env, caller: Address, market_id: u64) -> Result<AttestedOutcome, Error> {
    caller.require_auth();

    // Call the existing finalize_signers logic
    let result = Resolver::finalize_signers(&env, market_id)?;

    // Pay bounty (idempotent)
    Self::pay_bounty(&env, market_id, &caller)?;

    Ok(result)
}
```

**Location:** Add to `Resolver` impl, as new wrapper entrypoints.

### 7. Modify guardian_void_market to Refund Bounties

Add a call to refund bounties in the existing `guardian_void_market`:

```rust
pub fn guardian_void_market(env: Env, market_id: u64, reason: GuardianReason) -> Result<(), Error> {
    // ... existing validation and guardian_void logic ...

    // After calling market_core.void_market(...):
    
    // Refund bounty if present
    Self::refund_bounty(&env, market_id).ok(); // Ignore if no bounty exists

    // ... rest of function ...
}
```

**Location:** Modify existing function around line 1379, add bounty refund call before or after `void_market`.

### 8. Add Error Code

Add to the `Error` enum:

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    // ... existing errors ...
    BountyFundingClosed = 16,
    BountyFunderMismatch = 17,
    InvalidAmount = 18,
    NoBounty = 19,
    Overflow = 20,
}
```

**Location:** Add to the `Error` enum around line 452.

## Treasury Changes (contracts/treasury/src/lib.rs)

Add a new entrypoint:

```rust
pub fn agent_create_market_with_bounty(
    env: Env,
    agent: Address,
    seed_amount: i128,
    bounty_amount: i128,
    question_hash: BytesN<32>,
    resolution_hash: BytesN<32>,
    close_time: u64,
) -> Result<u64, Error> {
    agent.require_auth();

    // Check caps: seed + bounty <= max_trade
    let config = Self::risk_config(&env, &agent)?;
    if seed_amount + bounty_amount > config.max_trade {
        return Err(Error::CapExceeded);
    }

    // Pre-authorize both transfers
    env.authorize_as_current_contract(vec![
        // Transfer seed to market-core
        InvokerContractAuthEntry::Contract(ContractAuth {
            contract_id: Self::market_core(&env),
            function_name: Symbol::new(&env, "transfer"),
            args: vec![
                self_ref.clone().into_val(&env),
                market_core_ref.into_val(&env),
                seed_amount.into_val(&env),
            ],
        }),
        // Transfer bounty to resolver
        InvokerContractAuthEntry::Contract(ContractAuth {
            contract_id: Self::resolver(&env),
            function_name: Symbol::new(&env, "transfer"),
            args: vec![
                self_ref.clone().into_val(&env),
                resolver_ref.into_val(&env),
                bounty_amount.into_val(&env),
            ],
        }),
    ]);

    // Create market
    let market_id = Self::market_core(&env)
        .create_market(&agent, seed_amount, question_hash, resolution_hash, close_time)?;

    // Fund bounty
    Self::resolver(&env)
        .fund_bounty(&self_address, &market_id, &bounty_amount)?;

    // Reserve capacity for both
    Self::reserve_capacity(&env, &agent, &market_id, seed_amount + bounty_amount)?;

    Ok(market_id)
}
```

**Location:** Add to `Treasury` impl as a new entrypoint.

## Testing Strategy

Add tests in `contracts/resolver/src/lib.rs` module:

```rust
#[cfg(test)]
mod test {
    // ... existing tests ...

    #[test]
    fn fund_bounty_escrows_tokens_in_resolver() {
        // spec: RS-FUND-BOUNTY-*
        // 1. fund_bounty
        // 2. Assert escrow created
        // 3. Assert tokens transferred
    }

    #[test]
    fn resolve_price_for_pays_bounty_once() {
        // spec: RS-RESOLVE-PRICE-FOR-POST-2
        // 1. Create market with bounty
        // 2. Resolve with resolve_price_for
        // 3. Assert bounty paid to caller
        // 4. Assert second call pays nothing
    }

    #[test]
    fn finalize_signers_for_pays_bounty_to_caller() {
        // spec: RS-FINALIZE-SIGNERS-FOR-POST-2
        // 1. Create market with bounty
        // 2. Register signers and get attestations
        // 3. finalize_signers_for(caller, market_id)
        // 4. Assert bounty paid to caller
    }

    #[test]
    fn guardian_void_refunds_bounty_to_funder() {
        // spec: RS-GUARDIAN-VOID-MARKET-POST-2
        // 1. Create market with bounty
        // 2. guardian_void_market(market_id)
        // 3. Assert bounty refunded to funder
    }

    #[test]
    fn treasurer_agent_create_market_with_bounty_counts_against_caps() {
        // spec: TR-AGENT-CREATE-MARKET-WITH-BOUNTY-PRE-*
        // 1. Register agent with max_trade = 100
        // 2. agent_create_market_with_bounty(seed=60, bounty=50)
        // 3. Assert CapExceeded (60+50 > 100)
        // 4. agent_create_market_with_bounty(seed=60, bounty=40)
        // 5. Assert success
    }
}
```

## Next Steps

1. Implement `BountyEscrow` type and `DataKey` variants
2. Implement `fund_bounty`, `pay_bounty`, `refund_bounty` functions
3. Create `resolve_price_for` and `finalize_signers_for` wrapper entrypoints
4. Modify `guardian_void_market` to refund bounties
5. Add treasury `agent_create_market_with_bounty` entrypoint
6. Add and run tests
7. Update `docs/architecture.md` and deploy scripts
8. Regenerate bindings via `make bindings`

## References

- [Issue #149 Full Spec](../docs/spec/resolver.md) - Bounty entrypoints
- [ADR 0002: Cross-Contract Calls](../docs/adr/0002-cross-contract-calls.md) - Vendored WASM and auth
- [Soroban Authorization](https://developers.stellar.org/docs/learn/encyclopedia/security/authorization) - `require_auth()` and `authorize_as_current_contract`

---

**Author:** OracleDesk Contributors  
**Status:** Specification complete; implementation in progress
