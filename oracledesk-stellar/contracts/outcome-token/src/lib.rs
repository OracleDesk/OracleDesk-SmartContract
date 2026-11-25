#![no_std]
// SEP-41 event topics are emitted through the deprecated tuple helper so the
// on-chain shape matches the standard; migrating to #[contractevent] would
// rename the topics.
#![allow(deprecated)]

//! SEP-41 outcome token (#146): one token per `(market, outcome)`, backed
//! one-for-one by this contract's own position in market-core.
//!
//! Only the factory that deployed the token may mint, unwrap or redeem.
//! Holders may transfer, approve, and burn. Burning is an unwrap: the shares
//! go back to the burner's market-core position, so the backing never falls
//! below the supply. See `docs/architecture.md` ("Outcome tokens").
//!
//! Accounting invariant: before redemption, `total_supply` equals the
//! market-core position this contract holds for its outcome.

use oracledesk_types::Outcome;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, Env,
    MuxedAddress, String, Symbol,
};

/// Decimals of the collateral token (Stellar assets use 7).
const DECIMALS: u32 = 7;
/// Balances are extended on touch so long holds do not archive.
const BALANCE_THRESHOLD: u32 = 7 * 17_280;
const BALANCE_EXTEND: u32 = 30 * 17_280;

/// The part of market-core this token calls.
///
/// A client trait rather than a `contractimport!`: the vendored market-core
/// wasm predates `transfer_position`, and importing it would also collide with
/// market-core's `__constructor` in this crate's wasm (ADR 0002).
#[contractclient(name = "MarketCoreApi")]
pub trait MarketCore {
    fn get_position(env: Env, market_id: u64, holder: Address) -> PositionView;
    fn redeem(env: Env, holder: Address, market_id: u64) -> i128;
    fn transfer_position(
        env: Env,
        from: Address,
        to: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    );
}

/// Mirror of market-core's `Position` (same field names, so the XDR matches).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionView {
    pub yes: i128,
    pub no: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub live_until_ledger: u32,
}

/// What the token received when it redeemed its market-core position, and the
/// supply at that moment. Each holder's payout is fixed against that supply,
/// so later burns or transfers cannot make the pro-rata shares drift.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedemptionState {
    pub payout_total: i128,
    pub supply_at_redeem: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Factory,
    MarketCore,
    Collateral,
    MarketId,
    OutcomeSide,
    Name,
    TokenSymbol,
    Supply,
    Redemption,
    Balance(Address),
    Allowance(Address, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    InvalidExpiration = 4,
    /// The token has redeemed its market-core position; minting, unwrapping
    /// and burning are closed for good.
    Redeemed = 5,
    Overflow = 6,
}

#[contract]
pub struct OutcomeToken;

#[contractimpl]
impl OutcomeToken {
    /// `factory` is the only caller allowed to mint, unwrap and redeem.
    /// `collateral` must be market-core's collateral token; the factory
    /// passes it in, since the market-core wasm this crate can import does not
    /// expose the configuration.
    pub fn __constructor(
        env: Env,
        factory: Address,
        market_core: Address,
        collateral: Address,
        market_id: u64,
        outcome: Outcome,
    ) {
        let (suffix, symbol_suffix): (&[u8], &[u8]) = match outcome {
            Outcome::Yes => (&b" YES"[..], &b"Y"[..]),
            Outcome::No => (&b" NO"[..], &b"N"[..]),
        };
        let name = label(&env, b"OracleDesk M", market_id, suffix);
        let symbol = label(&env, b"OD", market_id, symbol_suffix);
        let instance = env.storage().instance();
        instance.set(&DataKey::Factory, &factory);
        instance.set(&DataKey::MarketCore, &market_core);
        instance.set(&DataKey::Collateral, &collateral);
        instance.set(&DataKey::MarketId, &market_id);
        instance.set(&DataKey::OutcomeSide, &outcome);
        instance.set(&DataKey::Name, &name);
        instance.set(&DataKey::TokenSymbol, &symbol);
        instance.set(&DataKey::Supply, &0_i128);
    }

    pub fn decimals(_env: Env) -> u32 {
        DECIMALS
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::TokenSymbol).unwrap()
    }

    pub fn total_supply(env: Env) -> i128 {
        supply(&env)
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        balance_of(&env, &id)
    }

    /// Zero once the allowance's `live_until_ledger` has passed.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let now = env.ledger().sequence();
        match allowance_of(&env, &from, &spender) {
            Some(a) if a.live_until_ledger >= now => a.amount,
            _ => 0,
        }
    }

    /// Sets `spender`'s allowance over `from`'s tokens. A non-zero amount must
    /// still be live at `live_until_ledger`; setting zero is always allowed.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().sequence();
        if amount > 0 && live_until_ledger < now {
            return Err(Error::InvalidExpiration);
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(
            &key,
            &AllowanceValue {
                amount,
                live_until_ledger,
            },
        );
        if amount > 0 {
            let ttl = core::cmp::min(live_until_ledger - now, env.storage().max_ttl());
            env.storage().persistent().extend_ttl(&key, ttl, ttl);
        }
        env.events().publish(
            (Symbol::new(&env, "approve"), from, spender),
            (amount, live_until_ledger),
        );
        Ok(())
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) -> Result<(), Error> {
        from.require_auth();
        move_balance(&env, &from, &to.address(), amount)
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        move_balance(&env, &from, &to, amount)
    }

    /// Burns the holder's tokens and returns the shares to the holder.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        unwrap_to(&env, &from, amount)
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) -> Result<(), Error> {
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        unwrap_to(&env, &from, amount)
    }

    /// Factory only: credits `to` for shares the factory has just moved into
    /// this contract's market-core position.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        require_factory(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        ensure_not_redeemed(&env)?;
        let new_supply = supply(&env).checked_add(amount).ok_or(Error::Overflow)?;
        let new_balance = balance_of(&env, &to)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        set_supply(&env, new_supply);
        set_balance(&env, &to, new_balance);
        env.events()
            .publish((Symbol::new(&env, "mint"), to), amount);
        Ok(())
    }

    /// Factory only: burns `holder`'s tokens and returns the shares to the
    /// holder's market-core position. The factory has already required the
    /// holder's auth.
    pub fn unwrap(env: Env, holder: Address, amount: i128) -> Result<(), Error> {
        require_factory(&env);
        unwrap_to(&env, &holder, amount)
    }

    /// Factory only: pays `holder` a pro-rata share of the market's payout.
    /// The first call redeems the token's whole market-core position, which
    /// fails until the market is final. Returns the amount paid.
    pub fn redeem_wrapped(env: Env, holder: Address) -> Result<i128, Error> {
        require_factory(&env);
        let balance = balance_of(&env, &holder);
        if balance == 0 {
            return Ok(0);
        }
        let state = match redemption(&env) {
            Some(state) => state,
            None => settle(&env),
        };
        if state.supply_at_redeem == 0 {
            return Ok(0);
        }
        let payout = balance
            .checked_mul(state.payout_total)
            .ok_or(Error::Overflow)?
            / state.supply_at_redeem;
        set_balance(&env, &holder, 0);
        let new_supply = supply(&env).checked_sub(balance).ok_or(Error::Overflow)?;
        set_supply(&env, new_supply);
        if payout > 0 {
            token::TokenClient::new(&env, &collateral(&env)).transfer(
                &env.current_contract_address(),
                &holder,
                &payout,
            );
        }
        env.events()
            .publish((Symbol::new(&env, "redeem"), holder), payout);
        Ok(payout)
    }
}

// ─── internals ───────────────────────────────────────────────────────────────

/// Builds `"<prefix><market_id><suffix>"` without `alloc`. The longest result
/// (a 20-digit id with a 12-byte prefix and a 4-byte suffix) fits the buffer.
fn label(env: &Env, prefix: &[u8], market_id: u64, suffix: &[u8]) -> String {
    let mut digits = [0u8; 20];
    let mut len = 0usize;
    let mut rest = market_id;
    loop {
        digits[len] = b'0' + (rest % 10) as u8;
        len += 1;
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    let mut buf = [0u8; 64];
    let mut n = 0usize;
    for &b in prefix {
        buf[n] = b;
        n += 1;
    }
    for i in (0..len).rev() {
        buf[n] = digits[i];
        n += 1;
    }
    for &b in suffix {
        buf[n] = b;
        n += 1;
    }
    String::from_bytes(env, &buf[..n])
}

fn require_factory(env: &Env) {
    let factory: Address = env.storage().instance().get(&DataKey::Factory).unwrap();
    factory.require_auth();
}

fn market_core(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::MarketCore).unwrap()
}

fn collateral(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Collateral).unwrap()
}

fn market_id(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::MarketId).unwrap()
}

fn outcome(env: &Env) -> Outcome {
    env.storage().instance().get(&DataKey::OutcomeSide).unwrap()
}

fn supply(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Supply).unwrap_or(0)
}

fn set_supply(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::Supply, &amount);
}

fn redemption(env: &Env) -> Option<RedemptionState> {
    env.storage().instance().get(&DataKey::Redemption)
}

fn ensure_not_redeemed(env: &Env) -> Result<(), Error> {
    if redemption(env).is_some() {
        return Err(Error::Redeemed);
    }
    Ok(())
}

fn balance_of(env: &Env, id: &Address) -> i128 {
    let key = DataKey::Balance(id.clone());
    match env.storage().persistent().get::<_, i128>(&key) {
        Some(balance) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_EXTEND);
            balance
        }
        None => 0,
    }
}

fn set_balance(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_EXTEND);
}

fn allowance_of(env: &Env, from: &Address, spender: &Address) -> Option<AllowanceValue> {
    env.storage()
        .persistent()
        .get(&DataKey::Allowance(from.clone(), spender.clone()))
}

/// Deducts `amount` from `spender`'s live allowance over `from`.
fn spend_allowance(
    env: &Env,
    from: &Address,
    spender: &Address,
    amount: i128,
) -> Result<(), Error> {
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    if amount == 0 {
        return Ok(());
    }
    let now = env.ledger().sequence();
    let current = match allowance_of(env, from, spender) {
        Some(a) if a.live_until_ledger >= now => a,
        _ => return Err(Error::InsufficientAllowance),
    };
    if current.amount < amount {
        return Err(Error::InsufficientAllowance);
    }
    env.storage().persistent().set(
        &DataKey::Allowance(from.clone(), spender.clone()),
        &AllowanceValue {
            amount: current.amount - amount,
            live_until_ledger: current.live_until_ledger,
        },
    );
    Ok(())
}

fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), Error> {
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    if amount == 0 {
        return Ok(());
    }
    let from_balance = balance_of(env, from);
    if from_balance < amount {
        return Err(Error::InsufficientBalance);
    }
    if from != to {
        let to_balance = balance_of(env, to)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        set_balance(env, from, from_balance - amount);
        set_balance(env, to, to_balance);
    }
    env.events().publish(
        (Symbol::new(env, "transfer"), from.clone(), to.clone()),
        amount,
    );
    Ok(())
}

/// Burns `holder`'s tokens and moves the matching shares back to the holder's
/// market-core position. The token is the direct caller of market-core, so
/// `from` (this contract) is authorized without an explicit auth entry.
fn unwrap_to(env: &Env, holder: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    ensure_not_redeemed(env)?;
    let balance = balance_of(env, holder);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }
    let new_supply = supply(env).checked_sub(amount).ok_or(Error::Overflow)?;
    set_balance(env, holder, balance - amount);
    set_supply(env, new_supply);
    env.events()
        .publish((Symbol::new(env, "burn"), holder.clone()), amount);
    MarketCoreApi::new(env, &market_core(env)).transfer_position(
        &env.current_contract_address(),
        holder,
        &market_id(env),
        &outcome(env),
        &amount,
    );
    Ok(())
}

/// Redeems the token's whole market-core position and records the payout.
/// Skips the call when there is nothing to redeem, which is how a token with
/// no supply stays free to redeem later.
fn settle(env: &Env) -> RedemptionState {
    let me = env.current_contract_address();
    let id = market_id(env);
    let core = MarketCoreApi::new(env, &market_core(env));
    let position = core.get_position(&id, &me);
    let payout_total = if position.yes == 0 && position.no == 0 {
        0
    } else {
        core.redeem(&me, &id)
    };
    let state = RedemptionState {
        payout_total,
        supply_at_redeem: supply(env),
    };
    env.storage().instance().set(&DataKey::Redemption, &state);
    state
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    /// Registers a token as if the factory had deployed it. Returns the
    /// token's address and the factory's address.
    fn new_token(env: &Env, outcome: Outcome) -> (Address, Address) {
        let factory = Address::generate(env);
        let core = Address::generate(env);
        let collateral = Address::generate(env);
        let id = env.register(
            OutcomeToken,
            OutcomeTokenArgs::__constructor(&factory, &core, &collateral, &42, &outcome),
        );
        (id, factory)
    }

    #[test]
    fn metadata_matches_market_and_outcome() {
        let env = Env::default();
        env.mock_all_auths();
        let (id, _factory) = new_token(&env, Outcome::Yes);
        let client = OutcomeTokenClient::new(&env, &id);
        assert_eq!(client.decimals(), 7);
        assert_eq!(client.name(), String::from_str(&env, "OracleDesk M42 YES"));
        assert_eq!(client.symbol(), String::from_str(&env, "OD42Y"));

        let (no_id, _) = new_token(&env, Outcome::No);
        let no = OutcomeTokenClient::new(&env, &no_id);
        assert_eq!(no.name(), String::from_str(&env, "OracleDesk M42 NO"));
        assert_eq!(no.symbol(), String::from_str(&env, "OD42N"));
    }

    #[test]
    fn factory_mint_credits_balance_and_supply() {
        let env = Env::default();
        env.mock_all_auths();
        let (id, _factory) = new_token(&env, Outcome::Yes);
        let client = OutcomeTokenClient::new(&env, &id);
        let holder = Address::generate(&env);
        client.mint(&holder, &100);
        assert_eq!(client.balance(&holder), 100);
        assert_eq!(client.total_supply(), 100);
    }

    #[test]
    fn transfer_moves_balance_and_keeps_supply() {
        let env = Env::default();
        env.mock_all_auths();
        let (id, _factory) = new_token(&env, Outcome::Yes);
        let client = OutcomeTokenClient::new(&env, &id);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &100);
        client.transfer(&alice, &bob, &30);
        assert_eq!(client.balance(&alice), 70);
        assert_eq!(client.balance(&bob), 30);
        assert_eq!(client.total_supply(), 100);
        assert_eq!(
            client.try_transfer(&alice, &bob, &71),
            Err(Ok(Error::InsufficientBalance))
        );
    }

    #[test]
    fn approve_and_transfer_from_respect_expiration() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(100);
        let (id, _factory) = new_token(&env, Outcome::Yes);
        let client = OutcomeTokenClient::new(&env, &id);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let sink = Address::generate(&env);
        client.mint(&owner, &100);

        client.approve(&owner, &spender, &40, &105);
        assert_eq!(client.allowance(&owner, &spender), 40);
        client.transfer_from(&spender, &owner, &sink, &25);
        assert_eq!(client.allowance(&owner, &spender), 15);

        // Past `live_until_ledger` the allowance reads as zero.
        env.ledger().set_sequence_number(106);
        assert_eq!(client.allowance(&owner, &spender), 0);
        assert_eq!(
            client.try_transfer_from(&spender, &owner, &sink, &1),
            Err(Ok(Error::InsufficientAllowance))
        );
    }

    #[test]
    fn approve_rejects_expired_non_zero_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(100);
        let (id, _factory) = new_token(&env, Outcome::No);
        let client = OutcomeTokenClient::new(&env, &id);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        assert_eq!(
            client.try_approve(&owner, &spender, &1, &99),
            Err(Ok(Error::InvalidExpiration))
        );
        // Clearing an allowance is allowed whatever the expiration.
        client.approve(&owner, &spender, &0, &99);
    }
}
