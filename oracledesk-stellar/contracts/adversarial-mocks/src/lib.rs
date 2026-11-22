//! Test-only adversarial mock library of hostile SEP-41 tokens and SEP-40
//! oracles (Issue #137).
//!
//! Built strictly as an `rlib` (never compiled to a deployable WASM artifact,
//! no `__constructor` exported). Every hostile contract models realistic
//! misbehavior that the Soroban host permits:
//!
//! Hostile SEP-41 tokens:
//! - [`PanicToken`] — traps inside `transfer` when armed.
//! - [`ShortToken`] — fee-on-transfer / under-delivering token (`to` receives
//!   less than `amount`).
//! - [`LyingBalanceToken`] — reports inflated balances from `balance()`.
//! - [`BudgetBurnerToken`] — burns CPU instructions in a bounded loop inside
//!   `transfer`.
//! - [`FlipFlopToken`] — succeeds during setup, then traps once flipped.
//! - [`ReentrantToken`] — invokes a configured callback on `market-core`
//!   during `transfer`.
//!
//! Hostile SEP-40 oracles:
//! - [`ExtremeOracle`] — returns `i128::MAX`, `i128::MIN`, `0`, or `-1`.
//! - [`FutureOracle`] — returns a record timestamped after `close_time`.
//! - [`NoneOracle`] — always returns `None`.
//! - [`PanicOracle`] — traps inside `price` (and optionally `resolution`).
//! - [`BudgetBurnerOracle`] — burns CPU budget in a bounded loop inside `price`.
//! - [`WrongShapeOracle`] — returns `u32` instead of `Option<PriceData>`.

#![no_std]

#[cfg(any(test, feature = "testutils"))]
extern crate alloc;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol, Val, Vec};

// ---------------------------------------------------------------------------
// Re-declared SEP-40 types matching oracledesk_types::{OracleAsset, PriceData}
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
enum TokKey {
    Bal(Address),
    Allow(Address, Address),
    Flag,
    Param,
    Count,
    Limit,
    CbTarget,
    CbFn,
    CbArgs,
    CbActive,
}

#[contracttype]
#[derive(Clone)]
enum OrcKey {
    Price,
    Offset,
    Res,
    Dec,
    Flag,
    Iters,
}

// ---------------------------------------------------------------------------
// Internal balance helpers for mock SEP-41 tokens
// ---------------------------------------------------------------------------

fn get_bal(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&TokKey::Bal(id.clone()))
        .unwrap_or(0)
}

fn set_bal(env: &Env, id: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&TokKey::Bal(id.clone()), &amount);
}

fn move_bal(env: &Env, from: &Address, to: &Address, debit: i128, credit: i128) {
    assert!(debit >= 0 && credit >= 0, "negative transfer");
    let from_bal = get_bal(env, from);
    assert!(from_bal >= debit, "insufficient balance");
    set_bal(env, from, from_bal - debit);
    let to_bal = get_bal(env, to);
    set_bal(env, to, to_bal + credit);
}

// ---------------------------------------------------------------------------
// 1. PanicToken
// ---------------------------------------------------------------------------

#[contract]
pub struct PanicToken;

#[contractimpl]
impl PanicToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    pub fn set_panic(env: Env, armed: bool) {
        env.storage().instance().set(&TokKey::Flag, &armed);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let armed: bool = env.storage().instance().get(&TokKey::Flag).unwrap_or(true);
        if armed {
            panic!("adversarial PanicToken transfer panic");
        }
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let armed: bool = env.storage().instance().get(&TokKey::Flag).unwrap_or(true);
        if armed {
            panic!("adversarial PanicToken transfer_from panic");
        }
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "PanicToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "PANIC")
    }
}

// ---------------------------------------------------------------------------
// 2. ShortToken (fee-on-transfer / under-delivering)
// ---------------------------------------------------------------------------

#[contract]
pub struct ShortToken;

#[contractimpl]
impl ShortToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    /// Sets the fee in bps deducted from every transfer (default 100 = 1%).
    /// Setting 0 makes transfers exact during test setup.
    pub fn set_fee_bps(env: Env, fee_bps: i128) {
        env.storage().instance().set(&TokKey::Param, &fee_bps);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fee_bps: i128 = env.storage().instance().get(&TokKey::Param).unwrap_or(100);
        let fee = if fee_bps > 0 && amount > 0 {
            (amount * fee_bps / 10_000).max(1)
        } else {
            0
        };
        let delivered = amount.saturating_sub(fee);
        move_bal(&env, &from, &to, amount, delivered);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let fee_bps: i128 = env.storage().instance().get(&TokKey::Param).unwrap_or(100);
        let fee = if fee_bps > 0 && amount > 0 {
            (amount * fee_bps / 10_000).max(1)
        } else {
            0
        };
        move_bal(&env, &from, &to, amount, amount.saturating_sub(fee));
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "ShortToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "SHORT")
    }
}

// ---------------------------------------------------------------------------
// 3. LyingBalanceToken (reports inflated balance while transfers stay exact)
// ---------------------------------------------------------------------------

#[contract]
pub struct LyingBalanceToken;

#[contractimpl]
impl LyingBalanceToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    /// Sets the additive lie returned by `balance()` (default +1_000_000_000).
    pub fn set_lie(env: Env, offset: i128) {
        env.storage().instance().set(&TokKey::Param, &offset);
    }

    pub fn real_balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        let offset: i128 = env
            .storage()
            .instance()
            .get(&TokKey::Param)
            .unwrap_or(1_000_000_000);
        get_bal(&env, &id).saturating_add(offset)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "LyingBalanceToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "LIE")
    }
}

// ---------------------------------------------------------------------------
// 4. BudgetBurnerToken (exhausts CPU/memory budget in bounded iterations)
// ---------------------------------------------------------------------------

#[contract]
pub struct BudgetBurnerToken;

#[contractimpl]
impl BudgetBurnerToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    pub fn set_burn(env: Env, enabled: bool, iterations: u32) {
        env.storage().instance().set(&TokKey::Flag, &enabled);
        env.storage().instance().set(&TokKey::Limit, &iterations);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let enabled: bool = env.storage().instance().get(&TokKey::Flag).unwrap_or(true);
        if enabled {
            let iters: u32 = env
                .storage()
                .instance()
                .get(&TokKey::Limit)
                .unwrap_or(200_000);
            let seed = soroban_sdk::Bytes::from_slice(&env, &[0xAB; 64]);
            let mut h = env.crypto().sha256(&seed);
            for _ in 0..iters {
                let bytes: soroban_sdk::Bytes = h.into();
                h = env.crypto().sha256(&bytes);
            }
            let _ = h;
        }
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::transfer(env, from, to, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "BudgetBurnerToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "BURN")
    }
}

// ---------------------------------------------------------------------------
// 5. FlipFlopToken (succeeds initially, then fails after N calls or freeze)
// ---------------------------------------------------------------------------

#[contract]
pub struct FlipFlopToken;

#[contractimpl]
impl FlipFlopToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    pub fn set_frozen(env: Env, frozen: bool) {
        env.storage().instance().set(&TokKey::Flag, &frozen);
    }

    /// Fails starting on transfer number `after_calls + 1` (0 = fail immediately).
    pub fn fail_after(env: Env, after_calls: u32) {
        env.storage().instance().set(&TokKey::Limit, &after_calls);
        env.storage().instance().set(&TokKey::Count, &0u32);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let frozen: bool = env.storage().instance().get(&TokKey::Flag).unwrap_or(false);
        if frozen {
            panic!("adversarial FlipFlopToken frozen");
        }
        if let Some(limit) = env.storage().instance().get::<_, u32>(&TokKey::Limit) {
            let count: u32 = env.storage().instance().get(&TokKey::Count).unwrap_or(0);
            if count >= limit {
                panic!("adversarial FlipFlopToken flipped");
            }
            env.storage().instance().set(&TokKey::Count, &(count + 1));
        }
        move_bal(&env, &from, &to, amount, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::transfer(env, from, to, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "FlipFlopToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "FLIP")
    }
}

// ---------------------------------------------------------------------------
// 6. ReentrantToken (calls back into a configured contract during transfer)
// ---------------------------------------------------------------------------

#[contract]
pub struct ReentrantToken;

#[contractimpl]
impl ReentrantToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        set_bal(&env, &to, get_bal(&env, &to) + amount);
    }

    pub fn arm_callback(env: Env, target: Address, fn_name: Symbol, args: Vec<Val>) {
        env.storage().instance().set(&TokKey::CbTarget, &target);
        env.storage().instance().set(&TokKey::CbFn, &fn_name);
        env.storage().instance().set(&TokKey::CbArgs, &args);
        env.storage().instance().set(&TokKey::CbActive, &true);
    }

    pub fn disarm(env: Env) {
        env.storage().instance().set(&TokKey::CbActive, &false);
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokKey::Allow(from, spender))
            .unwrap_or(0)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _live_until: u32) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&TokKey::Allow(from, spender), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        get_bal(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        move_bal(&env, &from, &to, amount, amount);
        let active: bool = env
            .storage()
            .instance()
            .get(&TokKey::CbActive)
            .unwrap_or(false);
        if active {
            // Prevent infinite recursion while attempting the reentrant call.
            env.storage().instance().set(&TokKey::CbActive, &false);
            let target: Address = env.storage().instance().get(&TokKey::CbTarget).unwrap();
            let fn_name: Symbol = env.storage().instance().get(&TokKey::CbFn).unwrap();
            let args: Vec<Val> = env.storage().instance().get(&TokKey::CbArgs).unwrap();
            let _: Val = env.invoke_contract(&target, &fn_name, args);
        }
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::transfer(env, from, to, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        set_bal(&env, &from, get_bal(&env, &from) - amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "ReentrantToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "REENT")
    }
}

// ---------------------------------------------------------------------------
// Hostile SEP-40 Oracles
// ---------------------------------------------------------------------------

// 1. ExtremeOracle (i128::MAX, i128::MIN, 0, -1)
#[contract]
pub struct ExtremeOracle;

#[contractimpl]
impl ExtremeOracle {
    pub fn set_price(env: Env, price: i128) {
        env.storage().instance().set(&OrcKey::Price, &price);
    }

    pub fn set_config(env: Env, decimals: u32, resolution: u32) {
        env.storage().instance().set(&OrcKey::Dec, &decimals);
        env.storage().instance().set(&OrcKey::Res, &resolution);
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&OrcKey::Dec).unwrap_or(14)
    }

    pub fn resolution(env: Env) -> u32 {
        env.storage().instance().get(&OrcKey::Res).unwrap_or(300)
    }

    pub fn price(env: Env, _asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
        let p: i128 = env.storage().instance().get(&OrcKey::Price).unwrap_or(0);
        Some(PriceData {
            price: p,
            timestamp,
        })
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let ts = env.ledger().timestamp();
        Self::price(env, asset, ts)
    }
}

// 2. FutureOracle (returns timestamp > close_time)
#[contract]
pub struct FutureOracle;

#[contractimpl]
impl FutureOracle {
    pub fn set_future_offset(env: Env, offset: u64, price: i128) {
        env.storage().instance().set(&OrcKey::Offset, &offset);
        env.storage().instance().set(&OrcKey::Price, &price);
    }

    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(_env: Env) -> u32 {
        300
    }

    pub fn price(env: Env, _asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
        let offset: u64 = env.storage().instance().get(&OrcKey::Offset).unwrap_or(600);
        let p: i128 = env
            .storage()
            .instance()
            .get(&OrcKey::Price)
            .unwrap_or(5_000);
        Some(PriceData {
            price: p,
            timestamp: timestamp.saturating_add(offset),
        })
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let ts = env.ledger().timestamp();
        Self::price(env, asset, ts)
    }
}

// 3. NoneOracle (always returns None)
#[contract]
pub struct NoneOracle;

#[contractimpl]
impl NoneOracle {
    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(_env: Env) -> u32 {
        300
    }

    pub fn price(_env: Env, _asset: OracleAsset, _timestamp: u64) -> Option<PriceData> {
        None
    }

    pub fn lastprice(_env: Env, _asset: OracleAsset) -> Option<PriceData> {
        None
    }
}

// 4. PanicOracle (panics on price, and optionally resolution)
#[contract]
pub struct PanicOracle;

#[contractimpl]
impl PanicOracle {
    pub fn set_panic_resolution(env: Env, on: bool) {
        env.storage().instance().set(&OrcKey::Flag, &on);
    }

    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(env: Env) -> u32 {
        let on: bool = env.storage().instance().get(&OrcKey::Flag).unwrap_or(false);
        if on {
            panic!("adversarial PanicOracle resolution panic");
        }
        300
    }

    pub fn price(_env: Env, _asset: OracleAsset, _timestamp: u64) -> Option<PriceData> {
        panic!("adversarial PanicOracle price panic");
    }

    pub fn lastprice(_env: Env, _asset: OracleAsset) -> Option<PriceData> {
        panic!("adversarial PanicOracle lastprice panic");
    }
}

// 5. BudgetBurnerOracle (exhausts CPU budget in bounded loop)
#[contract]
pub struct BudgetBurnerOracle;

#[contractimpl]
impl BudgetBurnerOracle {
    pub fn set_iterations(env: Env, iters: u32) {
        env.storage().instance().set(&OrcKey::Iters, &iters);
    }

    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(_env: Env) -> u32 {
        300
    }

    pub fn price(env: Env, _asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
        let iters: u32 = env
            .storage()
            .instance()
            .get(&OrcKey::Iters)
            .unwrap_or(200_000);
        let seed = soroban_sdk::Bytes::from_slice(&env, &[0xCD; 64]);
        let mut h = env.crypto().sha256(&seed);
        for _ in 0..iters {
            let bytes: soroban_sdk::Bytes = h.into();
            h = env.crypto().sha256(&bytes);
        }
        let _ = h;
        Some(PriceData {
            price: 5_000,
            timestamp,
        })
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        let ts = env.ledger().timestamp();
        Self::price(env, asset, ts)
    }
}

// 6. WrongShapeOracle (returns u32 instead of Option<PriceData>)
#[contract]
pub struct WrongShapeOracle;

#[contractimpl]
impl WrongShapeOracle {
    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(_env: Env) -> u32 {
        300
    }

    pub fn price(_env: Env, _asset: OracleAsset, _timestamp: u64) -> u32 {
        42
    }

    pub fn lastprice(_env: Env, _asset: OracleAsset) -> u32 {
        42
    }
}

// ---------------------------------------------------------------------------
// Shared test harness (behind `testutils` feature)
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "testutils"))]
pub mod harness {
    use super::*;
    use alloc::vec::Vec as StdVec;
    use soroban_sdk::token::TokenClient;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum TokenKind {
        Panic,
        Short,
        LyingBalance,
        BudgetBurner,
        FlipFlop,
        Reentrant,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum OracleKind {
        Extreme,
        Future,
        None,
        Panic,
        BudgetBurner,
        WrongShape,
    }

    /// Registers one of the six hostile SEP-41 tokens in `env`.
    pub fn deploy_token(env: &Env, kind: TokenKind) -> Address {
        match kind {
            TokenKind::Panic => env.register(PanicToken, ()),
            TokenKind::Short => env.register(ShortToken, ()),
            TokenKind::LyingBalance => env.register(LyingBalanceToken, ()),
            TokenKind::BudgetBurner => env.register(BudgetBurnerToken, ()),
            TokenKind::FlipFlop => env.register(FlipFlopToken, ()),
            TokenKind::Reentrant => env.register(ReentrantToken, ()),
        }
    }

    /// Registers one of the six hostile SEP-40 oracles in `env`.
    pub fn deploy_oracle(env: &Env, kind: OracleKind) -> Address {
        match kind {
            OracleKind::Extreme => env.register(ExtremeOracle, ()),
            OracleKind::Future => env.register(FutureOracle, ()),
            OracleKind::None => env.register(NoneOracle, ()),
            OracleKind::Panic => env.register(PanicOracle, ()),
            OracleKind::BudgetBurner => env.register(BudgetBurnerOracle, ()),
            OracleKind::WrongShape => env.register(WrongShapeOracle, ()),
        }
    }

    /// Mints test funds on any of the six hostile tokens.
    pub fn mint_hostile(env: &Env, kind: TokenKind, token: &Address, to: &Address, amount: i128) {
        match kind {
            TokenKind::Panic => PanicTokenClient::new(env, token).mint(to, &amount),
            TokenKind::Short => ShortTokenClient::new(env, token).mint(to, &amount),
            TokenKind::LyingBalance => LyingBalanceTokenClient::new(env, token).mint(to, &amount),
            TokenKind::BudgetBurner => BudgetBurnerTokenClient::new(env, token).mint(to, &amount),
            TokenKind::FlipFlop => FlipFlopTokenClient::new(env, token).mint(to, &amount),
            TokenKind::Reentrant => ReentrantTokenClient::new(env, token).mint(to, &amount),
        }
    }

    /// Snapshot of token balances and arbitrary caller-supplied state tuples so
    /// every expected-failure test can assert `snapshot_before == snapshot_after`.
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Snapshot<S: Clone + Eq> {
        pub balances: StdVec<i128>,
        pub state: S,
    }

    pub fn snapshot<S: Clone + Eq>(
        env: &Env,
        token: &Address,
        holders: &[&Address],
        state: S,
    ) -> Snapshot<S> {
        let client = TokenClient::new(env, token);
        let balances = holders.iter().map(|h| client.balance(h)).collect();
        Snapshot { balances, state }
    }
}

#[cfg(test)]
mod test {
    use super::harness::*;
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn hostile_tokens_smoke() {
        let env = Env::default();
        env.mock_all_auths();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        let short = deploy_token(&env, TokenKind::Short);
        mint_hostile(&env, TokenKind::Short, &short, &alice, 1_000);
        ShortTokenClient::new(&env, &short).transfer(&alice, &bob, &1_000);
        assert!(ShortTokenClient::new(&env, &short).balance(&bob) < 1_000);

        let lying = deploy_token(&env, TokenKind::LyingBalance);
        mint_hostile(&env, TokenKind::LyingBalance, &lying, &alice, 100);
        assert!(LyingBalanceTokenClient::new(&env, &lying).balance(&alice) > 100);

        let flip = deploy_token(&env, TokenKind::FlipFlop);
        mint_hostile(&env, TokenKind::FlipFlop, &flip, &alice, 1_000);
        let flip_client = FlipFlopTokenClient::new(&env, &flip);
        flip_client.fail_after(&1);
        flip_client.transfer(&alice, &bob, &100);
        assert!(flip_client.try_transfer(&alice, &bob, &100).is_err());
    }

    #[test]
    fn hostile_oracles_smoke() {
        let env = Env::default();
        let asset = OracleAsset::Other(Symbol::new(&env, "XLM"));

        let ext = deploy_oracle(&env, OracleKind::Extreme);
        ExtremeOracleClient::new(&env, &ext).set_price(&-1);
        assert_eq!(
            ExtremeOracleClient::new(&env, &ext)
                .price(&asset, &1_000)
                .unwrap()
                .price,
            -1
        );

        let fut = deploy_oracle(&env, OracleKind::Future);
        assert!(
            FutureOracleClient::new(&env, &fut)
                .price(&asset, &1_000)
                .unwrap()
                .timestamp
                > 1_000
        );

        let none = deploy_oracle(&env, OracleKind::None);
        assert_eq!(
            NoneOracleClient::new(&env, &none).price(&asset, &1_000),
            None
        );

        let wrong = deploy_oracle(&env, OracleKind::WrongShape);
        assert_eq!(
            WrongShapeOracleClient::new(&env, &wrong).price(&asset, &1_000),
            42
        );
    }
}
