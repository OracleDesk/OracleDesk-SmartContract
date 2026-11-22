# Outcome Token Implementation (Issue #146)

This document outlines the implementation of SEP-41 outcome token wrappers for OracleDesk market positions.

## Overview

An outcome token is a SEP-41 compliant token that represents a holder's claim on one outcome (YES or NO) of an OracleDesk market. When a holder wraps N shares of an outcome, they:

1. Transfer N shares from their position in market-core to a wrapper token contract's position
2. Receive N outcome tokens (1:1 exchange rate)

After market resolution:
- Wrapped YES shares: 1:1 payout (full value if YES wins, 0 if NO wins, 0.5 if void)
- Wrapped NO shares: inverse of above

The wrapper token is deterministically deployed via a factory contract, using `sha256(market_id || outcome_byte)` as a salt, so any client can derive the token address without reading a registry.

## Code Changes Required

### 1. Create New Contracts

**Directory structure:**
```
contracts/outcome-token/
  ├── Cargo.toml
  └── src/
      ├── lib.rs           # SEP-41 token implementation
      ├── sep41.rs         # SEP-41 interface
      ├── balance.rs       # Balance tracking
      ├── allowance.rs     # Allowance with expiration
      └── settlement.rs    # Post-resolution redemption

contracts/outcome-token-factory/
  ├── Cargo.toml
  └── src/
      ├── lib.rs           # Factory (deployer + wrapper logic)
      ├── deploy.rs        # Deterministic deployment
      ├── wrap.rs          # Wrapping entrypoints
      └── redeem.rs        # Redemption logic
```

### 2. market-core: Add transfer_position Entrypoint

This new primitive is required by the wrapper to move shares between holders and the token contract.

```rust
// In contracts/market-core/src/lib.rs

pub fn transfer_position(
    env: Env,
    from: Address,
    to: Address,
    market_id: u64,
    outcome: Outcome,
    amount: i128,
) -> Result<(), Error> {
    from.require_auth();

    // Validate
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if from == to {
        return Err(Error::InvalidAmount);
    }

    // Load market
    let market = Self::load_market(&env, market_id)?;
    if market.status != MarketStatus::Open && market.status != MarketStatus::Finalized {
        return Err(Error::InvalidMarketStatus);
    }

    // Load from's position
    let from_pos = Self::load_position(&env, market_id, &from);
    let shares = match outcome {
        Outcome::Yes => from_pos.yes,
        Outcome::No => from_pos.no,
    };

    if shares < amount {
        return Err(Error::InsufficientShares);
    }

    // Update from's position (checked_sub)
    let from_pos_new = match outcome {
        Outcome::Yes => Position {
            yes: from_pos.yes.checked_sub(amount).ok_or(Error::Underflow)?,
            no: from_pos.no,
        },
        Outcome::No => Position {
            yes: from_pos.yes,
            no: from_pos.no.checked_sub(amount).ok_or(Error::Underflow)?,
        },
    };
    Self::save_position(&env, market_id, &from, &from_pos_new);

    // Load and update to's position (checked_add)
    let to_pos = Self::load_position(&env, market_id, &to);
    let to_pos_new = match outcome {
        Outcome::Yes => Position {
            yes: to_pos.yes.checked_add(amount).ok_or(Error::Overflow)?,
            no: to_pos.no,
        },
        Outcome::No => Position {
            yes: to_pos.yes,
            no: to_pos.no.checked_add(amount).ok_or(Error::Overflow)?,
        },
    };
    Self::save_position(&env, market_id, &to, &to_pos_new);

    // Bump TTL for both
    Self::bump_position(&env, market_id, &from);
    Self::bump_position(&env, market_id, &to);

    env.events().publish(
        ("PositionTransferred",),
        (market_id, from, to, outcome, amount),
    );

    Ok(())
}
```

**Location:** Add to `MarketCore` impl in `contracts/market-core/src/lib.rs`.

**Tests:**
```rust
#[test]
fn transfer_position_moves_shares() {
    // spec: MC-TRANSFER-POSITION-POST-1,2
}

#[test]
fn transfer_position_requires_from_auth() {
    // spec: MC-TRANSFER-POSITION-AUTH-1
    // Use targeted mock_auths (not mock_all_auths)
}

#[test]
fn transfer_position_preserves_solvency() {
    // spec: MC-TRANSFER-POSITION-INV (SYS-INV-2)
}
```

### 3. OutcomeToken Contract Implementation

```rust
// contracts/outcome-token/src/lib.rs

#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token::Interface, Address,
    BytesN, Env, String, Symbol, TryInto, Vec, U256,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenMetadata {
    pub factory: Address,
    pub market_core: Address,
    pub market_id: u64,
    pub outcome: Outcome,  // from oracledesk-types
    pub decimals: u32,     // 7 (matches collateral)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum DataKey {
    Metadata,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),  // (spender, owner) -> (amount, expiration_ledger)
    RedemptionState,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedemptionState {
    pub payout_per_token: i128,
    pub supply_at_redeem: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contract]
pub struct OutcomeToken;

#[contractimpl]
impl OutcomeToken {
    /// Constructor called by factory
    pub fn __constructor(
        env: Env,
        factory: Address,
        market_core: Address,
        market_id: u64,
        outcome: Outcome,
    ) {
        let decimals = 7u32; // Match collateral

        env.storage().instance().set(
            &DataKey::Metadata,
            &TokenMetadata {
                factory,
                market_core,
                market_id,
                outcome,
                decimals,
            },
        );

        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &0i128);
    }

    // SEP-41 interface implementation

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), Symbol> {
        from.require_auth();
        Self::transfer_internal(&env, &from, &to, amount)?;
        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Symbol> {
        spender.require_auth();
        Self::check_allowance(&env, &spender, &from, amount)?;
        Self::spend_allowance(&env, &spender, &from, amount)?;
        Self::transfer_internal(&env, &from, &to, amount)?;
        Ok(())
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), Symbol> {
        from.require_auth();

        let key = DataKey::Allowance(spender, from.clone());
        env.storage()
            .persistent()
            .set(&key, &Allowance {
                amount,
                expiration_ledger,
            });

        // Extend TTL to live until expiration_ledger
        env.storage()
            .persistent()
            .bump(&key, expiration_ledger, expiration_ledger + 100);

        env.events().publish(
            (Symbol::new(&env, "approve"),),
            (from, spender, amount),
        );

        Ok(())
    }

    pub fn allowance(
        env: Env,
        from: Address,
        spender: Address,
    ) -> Result<i128, Symbol> {
        let key = DataKey::Allowance(spender, from);
        let allowance: Option<Allowance> = env.storage()
            .persistent()
            .get(&key)
            .ok();

        if let Some(a) = allowance {
            if env.ledger().sequence() <= a.expiration_ledger as u64 {
                return Ok(a.amount);
            }
        }

        Ok(0)
    }

    pub fn balance(env: Env, addr: Address) -> Result<i128, Symbol> {
        let key = DataKey::Balance(addr);
        Ok(env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(0i128))
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), Symbol> {
        from.require_auth();
        Self::burn_internal(&env, &from, amount)?;
        Ok(())
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) -> Result<(), Symbol> {
        spender.require_auth();
        Self::check_allowance(&env, &spender, &from, amount)?;
        Self::spend_allowance(&env, &spender, &from, amount)?;
        Self::burn_internal(&env, &from, amount)?;
        Ok(())
    }

    pub fn decimals(_env: Env) -> Result<u32, Symbol> {
        Ok(7)
    }

    pub fn name(env: Env) -> Result<String, Symbol> {
        let meta = env.storage()
            .instance()
            .get::<_, TokenMetadata>(&DataKey::Metadata)
            .ok();
        
        if let Some(m) = meta {
            let outcome_str = match m.outcome {
                Outcome::Yes => "YES",
                Outcome::No => "NO",
            };
            Ok(String::from_str(&env, &format!("OracleDesk M{} {}", m.market_id, outcome_str)))
        } else {
            Ok(String::from_str(&env, "OutcomeToken"))
        }
    }

    pub fn symbol(env: Env) -> Result<String, Symbol> {
        let meta = env.storage()
            .instance()
            .get::<_, TokenMetadata>(&DataKey::Metadata)
            .ok();
        
        if let Some(m) = meta {
            let outcome_char = match m.outcome {
                Outcome::Yes => 'Y',
                Outcome::No => 'N',
            };
            Ok(String::from_str(&env, &format!("OD{}{}",m.market_id, outcome_char)))
        } else {
            Ok(String::from_str(&env, "ODT"))
        }
    }

    pub fn total_supply(env: Env) -> Result<i128, Symbol> {
        Ok(env.storage()
            .instance()
            .get::<_, i128>(&DataKey::TotalSupply)
            .unwrap_or(0))
    }

    // Factory-only: mint and burn for wrapping/unwrapping
    
    fn mint_for_wrap(env: &Env, to: &Address, amount: i128) -> Result<(), Symbol> {
        // Only callable by factory (would require factory auth in production)
        let total = env.storage()
            .instance()
            .get::<_, i128>(&DataKey::TotalSupply)
            .unwrap_or(0);

        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total + amount));

        let balance_key = DataKey::Balance(to.clone());
        let balance = env.storage()
            .persistent()
            .get::<_, i128>(&balance_key)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&balance_key, &(balance + amount));

        env.events().publish(
            (Symbol::new(&env, "transfer"),),
            (Address::contract(&env, &BytesN::<32>::from_array(&[0u8; 32])), to, amount),
        );

        Ok(())
    }

    fn burn_for_unwrap(env: &Env, from: &Address, amount: i128) -> Result<(), Symbol> {
        // Only callable by factory
        Self::burn_internal(env, from, amount)
    }

    // Redemption (post-resolution)

    pub fn redeem_wrapped(env: Env, holder: Address) -> Result<i128, Symbol> {
        holder.require_auth();

        let meta = env.storage()
            .instance()
            .get::<_, TokenMetadata>(&DataKey::Metadata)
            .ok()
            .ok_or(Symbol::short("missing_meta"))?;

        // On first call, settle with market-core
        let mut redemption: RedemptionState = env.storage()
            .instance()
            .get(&DataKey::RedemptionState)
            .unwrap_or_else(|_| {
                // First time: call market-core.redeem(this_contract, market_id)
                // Receive payout and record it
                // This is a simplified placeholder
                RedemptionState {
                    payout_per_token: 0,
                    supply_at_redeem: Self::total_supply(&env).unwrap_or(0),
                }
            });

        // Pay holder pro-rata
        let holder_balance = Self::balance(&env, holder.clone()).unwrap_or(0);
        let payout = (holder_balance as u128 * redemption.payout_per_token as u128)
            / (redemption.supply_at_redeem.max(1) as u128);

        // Burn holder's tokens and pay collateral
        Self::burn_internal(&env, &holder, holder_balance)?;
        
        // Transfer collateral to holder (TODO: implement via contract call)
        
        Ok(payout as i128)
    }

    // Internal helpers

    fn transfer_internal(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), Symbol> {
        if amount < 0 {
            return Err(Symbol::short("neg_amount"));
        }

        let from_balance_key = DataKey::Balance(from.clone());
        let from_balance = env.storage()
            .persistent()
            .get::<_, i128>(&from_balance_key)
            .unwrap_or(0);

        if from_balance < amount {
            return Err(Symbol::short("insufficient_balance"));
        }

        env.storage()
            .persistent()
            .set(&from_balance_key, &(from_balance - amount));

        let to_balance_key = DataKey::Balance(to.clone());
        let to_balance = env.storage()
            .persistent()
            .get::<_, i128>(&to_balance_key)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&to_balance_key, &(to_balance + amount));

        env.events().publish(
            (Symbol::new(&env, "transfer"),),
            (from, to, amount),
        );

        Ok(())
    }

    fn burn_internal(env: &Env, from: &Address, amount: i128) -> Result<(), Symbol> {
        if amount < 0 {
            return Err(Symbol::short("neg_amount"));
        }

        let from_balance_key = DataKey::Balance(from.clone());
        let from_balance = env.storage()
            .persistent()
            .get::<_, i128>(&from_balance_key)
            .unwrap_or(0);

        if from_balance < amount {
            return Err(Symbol::short("insufficient_balance"));
        }

        env.storage()
            .persistent()
            .set(&from_balance_key, &(from_balance - amount));

        let total = env.storage()
            .instance()
            .get::<_, i128>(&DataKey::TotalSupply)
            .unwrap_or(0);

        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total - amount));

        env.events().publish(
            (Symbol::new(&env, "burn"),),
            (from, amount),
        );

        Ok(())
    }

    fn check_allowance(env: &Env, spender: &Address, from: &Address, amount: i128) -> Result<(), Symbol> {
        let allowed = Self::allowance(env, from.clone(), spender.clone()).unwrap_or(0);
        if allowed < amount {
            return Err(Symbol::short("insufficient_allowance"));
        }
        Ok(())
    }

    fn spend_allowance(env: &Env, spender: &Address, from: &Address, amount: i128) -> Result<(), Symbol> {
        let key = DataKey::Allowance(spender.clone(), from.clone());
        let allowance: Option<Allowance> = env.storage()
            .persistent()
            .get(&key)
            .ok();

        if let Some(mut a) = allowance {
            a.amount -= amount;
            env.storage().persistent().set(&key, &a);
        }
        Ok(())
    }
}
```

**Location:** New file `contracts/outcome-token/src/lib.rs`.

### 4. OutcomeTokenFactory Contract Implementation

The factory contract deploys outcome tokens deterministically and manages wrapping/unwrapping.

```rust
// contracts/outcome-token-factory/src/lib.rs

#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, Symbol, Vec};

#[contract]
pub struct OutcomeTokenFactory;

#[contractimpl]
impl OutcomeTokenFactory {
    /// Deterministically derive token address (pure function)
    pub fn token_address(
        env: Env,
        market_id: u64,
        outcome: Outcome,
    ) -> Address {
        let salt = {
            let mut data = Bytes::new(&env);
            data.append(&market_id.to_be_bytes().to_vec());
            match outcome {
                Outcome::Yes => data.append(&[0u8]),
                Outcome::No => data.append(&[1u8]),
            };
            // sha256(market_id || outcome_byte)
            env.crypto().sha256(&data)
        };

        env.deployer()
            .with_current_contract(salt)
            .deployed_address()
    }

    /// Deploy token contract if not already deployed (idempotent)
    pub fn deploy_token(
        env: Env,
        market_id: u64,
        outcome: Outcome,
    ) -> Result<Address, Symbol> {
        // Verify market exists
        let market_core_addr = env.storage()
            .instance()
            .get(&Symbol::short("MarketCore"))
            .ok();

        // Derive address
        let token_addr = Self::token_address(&env, market_id, outcome);

        // Check if already deployed (idempotent)
        if env.deployer().is_contract(&token_addr) {
            return Ok(token_addr);
        }

        // Deploy new token contract
        // (Requires embedded WASM; placeholder)
        
        Ok(token_addr)
    }

    /// Wrap position: move shares from holder to token contract, mint tokens
    pub fn wrap(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Symbol> {
        holder.require_auth();

        // Deploy token if needed
        let token_addr = Self::deploy_token(&env, market_id, outcome)?;

        // Transfer position: holder -> token contract
        // market_core.transfer_position(holder, token_addr, market_id, outcome, amount)
        // TODO: Implement nested call with auth chaining

        // Mint tokens
        // token.mint(holder, amount)
        // TODO: Implement

        Ok(())
    }

    /// Unwrap: burn tokens, move shares back to holder
    pub fn unwrap(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Symbol> {
        holder.require_auth();

        let token_addr = Self::token_address(&env, market_id, outcome);

        // Burn tokens
        // token.burn_for_unwrap(holder, amount)
        // TODO: Implement

        // Transfer position: token -> holder
        // market_core.transfer_position(token_addr, holder, market_id, outcome, amount)
        // TODO: Implement

        Ok(())
    }

    /// Redeem wrapped tokens after market resolution
    pub fn redeem_wrapped(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
    ) -> Result<i128, Symbol> {
        holder.require_auth();

        let token_addr = Self::token_address(&env, market_id, outcome);

        // token.redeem_wrapped(holder)
        // TODO: Implement
        
        Ok(0) // Placeholder
    }
}
```

**Location:** New file `contracts/outcome-token-factory/src/lib.rs`.

### 5. Update Cargo.toml

Add both crates to `contracts/Cargo.toml` workspace:

```toml
[workspace]
members = [
    "market-core",
    "resolver",
    "treasury",
    "reasoning-registry",
    "outcome-token",           # NEW
    "outcome-token-factory",   # NEW
    # ... existing ...
]
```

### 6. Update Bindings Generation

Add to `scripts/gen-bindings.sh`:

```bash
# Generate bindings for new contracts
soroban contract bindings typescript \
  --wasm oracledesk-stellar/contracts/outcome-token/target/wasm32-unknown-unknown/release/outcome_token.wasm \
  --package-name "@oracledesk/bindings-outcome-token" \
  --out-dir packages/bindings/outcome-token

soroban contract bindings typescript \
  --wasm oracledesk-stellar/contracts/outcome-token-factory/target/wasm32-unknown-unknown/release/outcome_token_factory.wasm \
  --package-name "@oracledesk/bindings-outcome-token-factory" \
  --out-dir packages/bindings/outcome-token-factory
```

## Testing Strategy

### Market-core Tests

```rust
#[test]
fn transfer_position_moves_shares() {
    // spec: MC-TRANSFER-POSITION-POST-1,2
}

#[test]
fn transfer_position_requires_from_auth() {
    // spec: MC-TRANSFER-POSITION-AUTH-1
    // Use targeted mock_auths (not mock_all_auths)
}

#[test]
fn transfer_position_preserves_solvency() {
    // spec: MC-TRANSFER-POSITION-INV (SYS-INV-2)
}
```

### Outcome Token Tests

```rust
#[test]
fn token_address_is_deterministic() {
    // spec: outcome-token-factory-token-address
    // Deploy same token twice, verify addresses match
}

#[test]
fn wrap_then_unwrap_round_trips() {
    // spec: outcome-token-factory-wrap-unwrap
    // 1. Create market, buy shares
    // 2. Wrap N shares -> N tokens
    // 3. Transfer tokens to another holder
    // 4. Unwrap back to shares
    // 5. Assert holdings match (minus fees)
}

#[test]
fn redeem_wrapped_yes_pays_one_to_one() {
    // spec: outcome-token-redeem-wrapped-yes
    // Market resolves YES
    // 1 token = 1 collateral
}

#[test]
fn redeem_wrapped_void_pays_half_floor() {
    // spec: outcome-token-redeem-wrapped-void
    // Market voided
    // 1 token (sum of yes+no) = 0.5 collateral (floor)
}
```

## Next Steps

1. Create `outcome-token` and `outcome-token-factory` crates
2. Implement `transfer_position` in market-core
3. Implement SEP-41 token interface (transfer, approve, balance, etc.)
4. Implement factory deployment logic
5. Implement wrap/unwrap with auth chaining
6. Implement redemption with settlement logic
7. Write comprehensive tests
8. Update scripts/gen-bindings.sh
9. Regenerate bindings via `make bindings`

## References

- [Issue #146 Full Spec](../docs/spec/system.md#sequence-4) - Outcome token wrapping flows
- [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) - Stellar token standard
- [Soroban Deployer](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/deployer) - Contract deployment from contracts

---

**Author:** OracleDesk Contributors  
**Status:** Specification complete; implementation in progress
