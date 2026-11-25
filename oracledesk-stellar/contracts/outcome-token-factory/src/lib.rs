#![no_std]

//! Outcome-token factory (#146). Deploys one SEP-41 `outcome-token` per
//! `(market, outcome)` at a deterministic address, and moves market positions
//! into and out of those tokens.
//!
//! Auth: `wrap` needs the holder's auth twice. The holder signs the `wrap`
//! invocation, and the nested market-core `transfer_position` (holder to
//! token) is a sub-invocation the holder also authorizes. The token's own
//! calls to market-core run with the token as direct caller, so no extra auth
//! is needed there. See `docs/architecture.md` ("Outcome tokens").

use oracledesk_types::Outcome;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Bytes, BytesN, Env,
};

/// Domain separator for token salts, so a later token version cannot collide
/// with this one.
const SALT_DOMAIN: &[u8] = b"oracledesk.outcome-token.v1";

/// Instance and token-record TTLs, in ledgers.
const INSTANCE_THRESHOLD: u32 = 30 * 17_280;
const INSTANCE_EXTEND: u32 = 120 * 17_280;

/// The market-core entrypoint the factory calls. A client trait: see the
/// outcome-token crate for why this is not a `contractimport!`.
#[contractclient(name = "MarketCoreApi")]
pub trait MarketCore {
    fn transfer_position(
        env: Env,
        from: Address,
        to: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    );
}

/// The outcome-token entrypoints the factory calls (the factory is their
/// direct caller, so their `factory.require_auth()` passes without an entry).
#[contractclient(name = "OutcomeTokenApi")]
pub trait OutcomeTokenIface {
    fn mint(env: Env, to: Address, amount: i128);
    fn unwrap(env: Env, holder: Address, amount: i128);
    fn redeem_wrapped(env: Env, holder: Address) -> i128;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    /// No token has been deployed for this `(market, outcome)` yet, so there
    /// is nothing to unwrap or redeem.
    TokenNotDeployed = 2,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    MarketCore,
    Collateral,
    TokenWasmHash,
    /// Deployed token for `(market_id, outcome)`. Written only by `deploy_token`.
    Token(u64, Outcome),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutcomeTokenDeployed {
    #[topic]
    pub market_id: u64,
    pub outcome: Outcome,
    pub token: Address,
}

#[contract]
pub struct OutcomeTokenFactory;

#[contractimpl]
impl OutcomeTokenFactory {
    /// `collateral` must be market-core's collateral token, which the factory
    /// passes to every token it deploys. `token_wasm_hash` is the uploaded
    /// outcome-token wasm. Both are fixed at construction: nothing can later
    /// swap the code behind tokens that holders already rely on.
    pub fn __constructor(
        env: Env,
        market_core: Address,
        collateral: Address,
        token_wasm_hash: BytesN<32>,
    ) {
        let instance = env.storage().instance();
        instance.set(&DataKey::MarketCore, &market_core);
        instance.set(&DataKey::Collateral, &collateral);
        instance.set(&DataKey::TokenWasmHash, &token_wasm_hash);
    }

    /// The address `deploy_token` gives `(market_id, outcome)`. Pure: it can be
    /// computed before deployment.
    pub fn token_address(env: Env, market_id: u64, outcome: Outcome) -> Address {
        env.deployer()
            .with_current_contract(salt(&env, market_id, outcome))
            .deployed_address()
    }

    /// Deploys the token for `(market_id, outcome)` if it does not exist, and
    /// returns its address. Anyone may call this. A second call returns the
    /// existing token.
    pub fn deploy_token(env: Env, market_id: u64, outcome: Outcome) -> Address {
        bump_instance(&env);
        let key = DataKey::Token(market_id, outcome);
        let existing: Option<Address> = env.storage().persistent().get(&key);
        if let Some(token) = existing {
            return token;
        }
        let instance = env.storage().instance();
        let wasm_hash: BytesN<32> = instance.get(&DataKey::TokenWasmHash).unwrap();
        let market_core: Address = instance.get(&DataKey::MarketCore).unwrap();
        let collateral: Address = instance.get(&DataKey::Collateral).unwrap();
        let factory = env.current_contract_address();
        let token = env
            .deployer()
            .with_current_contract(salt(&env, market_id, outcome))
            .deploy_v2(
                wasm_hash,
                (factory, market_core, collateral, market_id, outcome),
            );
        env.storage().persistent().set(&key, &token);
        env.storage()
            .persistent()
            .extend_ttl(&key, INSTANCE_THRESHOLD, INSTANCE_EXTEND);
        OutcomeTokenDeployed {
            market_id,
            outcome,
            token: token.clone(),
        }
        .publish(&env);
        token
    }

    /// Moves `amount` of `holder`'s `outcome` shares into the token and mints
    /// `amount` tokens to `holder`. Deploys the token first if needed. The
    /// token's total supply therefore always equals the shares it holds.
    pub fn wrap(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Error> {
        holder.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token = Self::deploy_token(env.clone(), market_id, outcome);
        MarketCoreApi::new(&env, &market_core(&env))
            .transfer_position(&holder, &token, &market_id, &outcome, &amount);
        OutcomeTokenApi::new(&env, &token).mint(&holder, &amount);
        Ok(())
    }

    /// Burns `amount` of `holder`'s tokens and returns the matching shares to
    /// the holder's market-core position.
    pub fn unwrap(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Error> {
        holder.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token = existing_token(&env, market_id, outcome)?;
        OutcomeTokenApi::new(&env, &token).unwrap(&holder, &amount);
        Ok(())
    }

    /// Pays `holder` their pro-rata share of the market's payout for the
    /// wrapped `outcome` (1:1 for the winning outcome, half for a void market,
    /// zero for the losing outcome). The first redemption redeems the token's
    /// whole market-core position, so it works only after the market is final.
    pub fn redeem_wrapped(
        env: Env,
        holder: Address,
        market_id: u64,
        outcome: Outcome,
    ) -> Result<i128, Error> {
        holder.require_auth();
        let token = existing_token(&env, market_id, outcome)?;
        Ok(OutcomeTokenApi::new(&env, &token).redeem_wrapped(&holder))
    }
}

// ─── internals ───────────────────────────────────────────────────────────────

/// Deterministic salt: `sha256(domain || market_id_be || outcome_byte)`.
fn salt(env: &Env, market_id: u64, outcome: Outcome) -> BytesN<32> {
    let mut preimage = Bytes::from_slice(env, SALT_DOMAIN);
    preimage.extend_from_slice(&market_id.to_be_bytes());
    let side: u8 = match outcome {
        Outcome::Yes => 1,
        Outcome::No => 0,
    };
    preimage.extend_from_slice(&[side]);
    env.crypto().sha256(&preimage).to_bytes()
}

fn market_core(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::MarketCore).unwrap()
}

fn existing_token(env: &Env, market_id: u64, outcome: Outcome) -> Result<Address, Error> {
    bump_instance(env);
    let key = DataKey::Token(market_id, outcome);
    let token: Option<Address> = env.storage().persistent().get(&key);
    match token {
        Some(token) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, INSTANCE_THRESHOLD, INSTANCE_EXTEND);
            Ok(token)
        }
        None => Err(Error::TokenNotDeployed),
    }
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND);
}

#[cfg(test)]
mod test {
    use super::*;
    use market_core_native::{Category, MarketCoreClient, MarketStatus};
    use outcome_token::OutcomeToken;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, BytesN, Env, String,
    };

    const CLOSE: u64 = 2_000;
    const SEED: i128 = 100 * 10_000_000;

    struct Setup {
        env: Env,
        admin: Address,
        creator: Address,
        resolver: Address,
        collateral: Address,
        core_id: Address,
        factory_id: Address,
        market_id: u64,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_sequence_number(100);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let collateral = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &collateral).mint(&creator, &(1_000 * 10_000_000_i128));

        let core_id = env.register(
            market_core_native::MarketCore,
            market_core_native::MarketCoreArgs::__constructor(
                &admin,
                &collateral,
                &treasury,
                &resolver,
                &100u32,
                &10_000u32,
            ),
        );
        let core = MarketCoreClient::new(&env, &core_id);
        let market_id = core.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &BytesN::from_array(&env, &[7u8; 32]),
            &String::from_str(&env, "ipfs://outcome-token-test"),
            &Category::Crypto,
            &CLOSE,
            &SEED,
            &5000u32,
        );
        // At a 50/50 split the whole seed lands in the pool, so the creator
        // holds no shares to wrap; buy a little of each side for them.
        core.buy(
            &creator,
            &market_id,
            &market_core_native::Outcome::Yes,
            &(10 * 10_000_000),
            &0,
        );
        core.buy(
            &creator,
            &market_id,
            &market_core_native::Outcome::No,
            &(10 * 10_000_000),
            &0,
        );

        let factory_id = env.register(
            OutcomeTokenFactory,
            OutcomeTokenFactoryArgs::__constructor(
                &core_id,
                &collateral,
                &BytesN::from_array(&env, &[9u8; 32]),
            ),
        );

        Setup {
            env,
            admin,
            creator,
            resolver,
            collateral,
            core_id,
            factory_id,
            market_id,
        }
    }

    /// Stands in for `deploy_token`: the wasm cannot be built here, so this
    /// registers the token natively at the address the factory derives and
    /// records it the way `deploy_token` would.
    fn seed_token(s: &Setup, outcome: Outcome) -> Address {
        let factory = OutcomeTokenFactoryClient::new(&s.env, &s.factory_id);
        let token = factory.token_address(&s.market_id, &outcome);
        s.env.register_at(
            &token,
            OutcomeToken,
            outcome_token::OutcomeTokenArgs::__constructor(
                &s.factory_id,
                &s.core_id,
                &s.collateral,
                &s.market_id,
                &outcome,
            ),
        );
        s.env.as_contract(&s.factory_id, || {
            s.env
                .storage()
                .persistent()
                .set(&DataKey::Token(s.market_id, outcome), &token);
        });
        token
    }

    fn mc(s: &Setup) -> MarketCoreClient<'_> {
        MarketCoreClient::new(&s.env, &s.core_id)
    }

    fn factory(s: &Setup) -> OutcomeTokenFactoryClient<'_> {
        OutcomeTokenFactoryClient::new(&s.env, &s.factory_id)
    }

    fn token_client<'a>(s: &'a Setup, token: &Address) -> outcome_token::OutcomeTokenClient<'a> {
        outcome_token::OutcomeTokenClient::new(&s.env, token)
    }

    #[test]
    fn token_address_is_deterministic_and_per_side() {
        let s = setup();
        let f = factory(&s);
        let yes = f.token_address(&s.market_id, &Outcome::Yes);
        assert_eq!(yes, f.token_address(&s.market_id, &Outcome::Yes));
        assert_ne!(yes, f.token_address(&s.market_id, &Outcome::No));
        assert_ne!(yes, f.token_address(&(s.market_id + 1), &Outcome::Yes));
        // The address is known before deployment, and seeding at it matches.
        assert_eq!(seed_token(&s, Outcome::Yes), yes);
    }

    #[test]
    fn wrap_then_unwrap_round_trips_exactly() {
        let s = setup();
        let yes_token = seed_token(&s, Outcome::Yes);
        let position = mc(&s).get_position(&s.market_id, &s.creator);
        let amount = position.yes / 2;
        assert!(amount > 0);

        factory(&s).wrap(&s.creator, &s.market_id, &Outcome::Yes, &amount);
        assert_eq!(token_client(&s, &yes_token).balance(&s.creator), amount);
        assert_eq!(mc(&s).get_position(&s.market_id, &yes_token).yes, amount);
        // Total supply equals the shares the token holds.
        assert_eq!(token_client(&s, &yes_token).total_supply(), amount);
        assert_eq!(
            mc(&s).get_position(&s.market_id, &s.creator).yes,
            position.yes - amount
        );

        factory(&s).unwrap(&s.creator, &s.market_id, &Outcome::Yes, &amount);
        assert_eq!(token_client(&s, &yes_token).balance(&s.creator), 0);
        assert_eq!(token_client(&s, &yes_token).total_supply(), 0);
        assert_eq!(mc(&s).get_position(&s.market_id, &yes_token).yes, 0);
        assert_eq!(
            mc(&s).get_position(&s.market_id, &s.creator).yes,
            position.yes
        );
    }

    #[test]
    fn wrap_rejects_non_positive_amounts_and_unwrap_needs_a_deployed_token() {
        let s = setup();
        assert_eq!(
            factory(&s).try_wrap(&s.creator, &s.market_id, &Outcome::Yes, &0),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            factory(&s).try_unwrap(&s.creator, &s.market_id, &Outcome::No, &1),
            Err(Ok(Error::TokenNotDeployed))
        );
    }

    #[test]
    fn redeem_wrapped_yes_pays_one_to_one_and_no_pays_zero() {
        let s = setup();
        let yes_token = seed_token(&s, Outcome::Yes);
        let no_token = seed_token(&s, Outcome::No);
        let position = mc(&s).get_position(&s.market_id, &s.creator);
        let yes_amount = position.yes / 2;
        let no_amount = position.no / 2;
        factory(&s).wrap(&s.creator, &s.market_id, &Outcome::Yes, &yes_amount);
        factory(&s).wrap(&s.creator, &s.market_id, &Outcome::No, &no_amount);

        s.env.ledger().set_timestamp(CLOSE);
        mc(&s).resolve(&s.market_id, &market_core_native::Outcome::Yes);
        assert_eq!(
            mc(&s).get_market(&s.market_id).status,
            MarketStatus::Resolved(market_core_native::Outcome::Yes)
        );

        let collateral = soroban_sdk::token::TokenClient::new(&s.env, &s.collateral);
        let before = collateral.balance(&s.creator);
        assert_eq!(
            factory(&s).redeem_wrapped(&s.creator, &s.market_id, &Outcome::Yes),
            yes_amount
        );
        assert_eq!(collateral.balance(&s.creator), before + yes_amount);
        assert_eq!(
            factory(&s).redeem_wrapped(&s.creator, &s.market_id, &Outcome::No),
            0
        );
        assert_eq!(token_client(&s, &yes_token).balance(&s.creator), 0);
        assert_eq!(token_client(&s, &no_token).balance(&s.creator), 0);
    }

    #[test]
    fn redeem_wrapped_void_pays_half_floor() {
        let s = setup();
        let yes_token = seed_token(&s, Outcome::Yes);
        let position = mc(&s).get_position(&s.market_id, &s.creator);
        let amount = position.yes / 2;
        factory(&s).wrap(&s.creator, &s.market_id, &Outcome::Yes, &amount);

        s.env.ledger().set_timestamp(CLOSE);
        mc(&s).void_market(&s.market_id);
        let collateral = soroban_sdk::token::TokenClient::new(&s.env, &s.collateral);
        let before = collateral.balance(&s.creator);
        let paid = factory(&s).redeem_wrapped(&s.creator, &s.market_id, &Outcome::Yes);
        // The token's position is the whole wrapped supply, so the void
        // payout is half of it, rounded down.
        assert_eq!(paid, amount / 2);
        assert_eq!(collateral.balance(&s.creator), before + paid);
        assert_eq!(token_client(&s, &yes_token).balance(&s.creator), 0);
    }

    #[test]
    fn redeem_wrapped_before_finality_fails_and_keeps_tokens() {
        let s = setup();
        let yes_token = seed_token(&s, Outcome::Yes);
        let position = mc(&s).get_position(&s.market_id, &s.creator);
        let amount = position.yes / 2;
        factory(&s).wrap(&s.creator, &s.market_id, &Outcome::Yes, &amount);

        assert!(factory(&s)
            .try_redeem_wrapped(&s.creator, &s.market_id, &Outcome::Yes)
            .is_err());
        assert_eq!(token_client(&s, &yes_token).balance(&s.creator), amount);
        assert_eq!(token_client(&s, &yes_token).total_supply(), amount);
        let _ = (&s.admin, &s.resolver);
    }
}
