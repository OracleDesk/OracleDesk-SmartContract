#![no_std]

pub mod ttl;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal, String, Symbol, Vec,
};

// See the comment on the equivalent `mod market_core` in
// contracts/resolver/src/lib.rs: a Cargo path dependency on market-core
// breaks the wasm build (duplicate `__constructor` export), so its client is
// generated from the compiled wasm instead. `docs/adr/0002-cross-contract-calls.md`.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{BatchResult, Category, Client as MarketCoreClient, Outcome};

const DAY_SECONDS: u64 = 86_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskConfig {
    pub agent: Address,
    pub collateral: Address,
    pub market_core: Address,
    pub max_trade: i128,
    pub max_market: i128,
    pub max_daily: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketExposure {
    pub amount: i128,
    pub open: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DailyUsage {
    pub day_start: u64,
    pub amount: i128,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Config,
    Market(u64),
    Daily,
    Paused,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    InvalidAmount = 4,
    TradeCapExceeded = 5,
    MarketCapExceeded = 6,
    DailyCapExceeded = 7,
    MarketNotOpen = 8,
    InsufficientBalance = 9,
    Paused = 10,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeAuthorized {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub agent: Address,
    pub amount: i128,
    pub market_total: i128,
    pub daily_total: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionClosed {
    #[topic]
    pub market_id: u64,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesCollected {
    #[topic]
    pub market_id: u64,
    pub amount: i128,
}

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        agent: Address,
        collateral: Address,
        market_core: Address,
        max_trade: i128,
        max_market: i128,
        max_daily: i128,
    ) {
        if max_trade <= 0 || max_market < max_trade || max_daily < max_market {
            panic!("invalid risk configuration");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(
            &DataKey::Config,
            &RiskConfig {
                agent,
                collateral,
                market_core,
                max_trade,
                max_market,
                max_daily,
            },
        );
        env.storage().instance().set(
            &DataKey::Daily,
            &DailyUsage {
                day_start: env.ledger().timestamp(),
                amount: 0,
            },
        );
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn get_config(env: Env) -> Result<RiskConfig, Error> {
        ttl::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    pub fn available_capital(env: Env) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        Ok(token::TokenClient::new(&env, &config.collateral)
            .balance(&env.current_contract_address()))
    }

    pub fn daily_usage(env: Env) -> Result<DailyUsage, Error> {
        Self::rolled_daily_usage(&env)
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        let config = Self::get_config(env.clone())?;
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::TokenClient::new(&env, &config.collateral).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        Ok(())
    }

    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let config = Self::get_config(env.clone())?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token = token::TokenClient::new(&env, &config.collateral);
        if token.balance(&env.current_contract_address()) < amount {
            return Err(Error::InsufficientBalance);
        }
        token.transfer(&env.current_contract_address(), &to, &amount);
        Ok(())
    }

    // ----- agent-driven trading --------------------------------------------
    // The agent never touches market-core directly with treasury funds: it
    // asks the treasury to do so, the treasury checks its own on-chain caps,
    // then calls market-core itself as the trader/creator. This is the only
    // path that moves treasury capital, so the caps below are real limits on
    // what the automated agent can deploy, not just off-chain bookkeeping.

    /// Creates and seeds a market using treasury capital. The treasury
    /// becomes the market's creator/LP.
    #[allow(clippy::too_many_arguments)]
    pub fn agent_create_market(
        env: Env,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        if seed_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if seed_amount > config.max_trade {
            return Err(Error::TradeCapExceeded);
        }

        let treasury_addr = env.current_contract_address();
        Self::authorize_token_pull(&env, &config, &treasury_addr, seed_amount);
        let market_id = MarketCoreClient::new(&env, &config.market_core).create_market(
            &treasury_addr,
            &question_hash,
            &resolution_hash,
            &meta_uri,
            &category,
            &close_time,
            &seed_amount,
            &initial_yes_bps,
        );
        Self::reserve_capacity(&env, &config, market_id, seed_amount, close_time)?;
        Ok(market_id)
    }

    /// Buys `outcome` shares in an existing market using treasury capital.
    pub fn agent_buy(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        if collateral_in <= 0 {
            return Err(Error::InvalidAmount);
        }
        if collateral_in > config.max_trade {
            return Err(Error::TradeCapExceeded);
        }

        let treasury_addr = env.current_contract_address();
        // market-core's `buy` pulls `collateral_in` from `trader` (here, the
        // treasury itself) via `token.transfer(trader -> market-core)`. That
        // transfer is a call the *token* contract receives from market-core,
        // not from the treasury directly, so the treasury's implicit
        // self-authorization (as the direct caller of market-core) does not
        // cover it. Without this pre-authorization the nested transfer's
        // `from.require_auth()` has no matching entry and the whole call
        // reverts with an authorization error — see
        // `pitfall_agent_buy_fails_without_nested_transfer_preauth` below and
        // `docs/adr/0002-treasury-nested-auth.md`.
        Self::authorize_token_pull(&env, &config, &treasury_addr, collateral_in);
        let shares = MarketCoreClient::new(&env, &config.market_core).buy(
            &treasury_addr,
            &market_id,
            &outcome,
            &collateral_in,
            &min_shares_out,
        );
        // One extra `get_market` read per buy, to key the exposure entry's TTL
        // to the market's close time rather than a fixed window (the market
        // knows its own `close_time`; the treasury otherwise would not).
        let close_time = MarketCoreClient::new(&env, &config.market_core)
            .get_market(&market_id)
            .close_time;
        Self::reserve_capacity(&env, &config, market_id, collateral_in, close_time)?;
        Ok(shares)
    }

    /// Sells `outcome` shares back into the pool for exactly
    /// `collateral_out`. This returns capital to the treasury (market-core
    /// pays out of its own balance), so it is not capped and does not need
    /// the nested-transfer pre-authorization that buying does.
    pub fn agent_sell(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let treasury_addr = env.current_contract_address();
        Ok(MarketCoreClient::new(&env, &config.market_core).sell(
            &treasury_addr,
            &market_id,
            &outcome,
            &collateral_out,
            &max_shares_in,
        ))
    }

    /// Marks a market's exposure as exited. Pure bookkeeping (see
    /// `MarketExposure`) for the future exposure dashboard; it does not move
    /// funds or free the cumulative per-market cap.
    pub fn close_trade(env: Env, market_id: u64) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let mut exposure = Self::market_exposure(&env, market_id);
        if !exposure.open {
            return Err(Error::MarketNotOpen);
        }
        exposure.open = false;
        let amount = exposure.amount;
        let close_time = MarketCoreClient::new(&env, &config.market_core)
            .get_market(&market_id)
            .close_time;
        Self::save_market(&env, market_id, &exposure, close_time);
        PositionClosed { market_id, amount }.publish(&env);
        Ok(amount)
    }

    /// Redeems the treasury's position in a resolved/voided market.
    ///
    /// Deadline (market-core issue #14): every market has a redemption
    /// window snapshotted at creation, and once `redeem_deadline(market_id)`
    /// passes anyone can `finalize_market`, which forfeits anything still
    /// unredeemed to the fee recipient. Nothing here tracks deadlines or
    /// auto-redeems, so the agent is responsible for calling this before the
    /// window expires. (This wrapper must exist: a contract address can only
    /// authorize itself from inside its own call stack, so nobody outside
    /// the treasury can redeem the treasury's position.)
    pub fn redeem(env: Env, market_id: u64) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let treasury_addr = env.current_contract_address();
        Ok(MarketCoreClient::new(&env, &config.market_core).redeem(&treasury_addr, &market_id))
    }

    /// Claims the LP pool remainder for a market the treasury created.
    pub fn claim_pool_remainder(env: Env, market_id: u64) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        Ok(MarketCoreClient::new(&env, &config.market_core).claim_pool_remainder(&market_id))
    }

    /// Redeems the treasury's positions in up to `MAX_BATCH` markets in one
    /// call (market-core issue #15). `market_ids` must be strictly ascending;
    /// markets that cannot be paid out right now are reported as skipped
    /// rather than aborting the whole batch, so one bad id does not strand
    /// the rest. The single aggregated token transfer at the end is why this
    /// exists: batching amortizes fixed per-call costs (footprint entries,
    /// event size), keeping the treasury inside the per-transaction resource
    /// limits even when it holds positions in many markets.
    pub fn redeem_many(env: Env, market_ids: Vec<u64>) -> Result<BatchResult, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let treasury_addr = env.current_contract_address();
        Ok(MarketCoreClient::new(&env, &config.market_core)
            .redeem_many(&treasury_addr, &market_ids))
    }

    /// Claims the LP pool remainders of up to `MAX_BATCH` treasury-created
    /// markets in one call. Skips (never aborts on) markets the treasury did
    /// not create, markets that have not settled, and markets already
    /// claimed — see `redeem_many` for the batching rationale.
    pub fn claim_pool_remainders(env: Env, market_ids: Vec<u64>) -> Result<BatchResult, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let treasury_addr = env.current_contract_address();
        Ok(MarketCoreClient::new(&env, &config.market_core)
            .claim_pool_remainders(&treasury_addr, &market_ids))
    }

    /// Pulls accrued fees from a configured market-core contract.
    pub fn collect_market_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::require_admin(&env)?;
        let config = Self::get_config(env.clone())?;
        let amount = MarketCoreClient::new(&env, &config.market_core).sweep_fees(&market_id);
        FeesCollected { market_id, amount }.publish(&env);
        Ok(amount)
    }
}

impl Treasury {
    fn require_admin(env: &Env) -> Result<(), Error> {
        ttl::bump_instance(env);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        ttl::bump_instance(env);
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn rolled_daily_usage(env: &Env) -> Result<DailyUsage, Error> {
        ttl::bump_instance(env);
        let usage: DailyUsage = env
            .storage()
            .instance()
            .get(&DataKey::Daily)
            .ok_or(Error::NotInitialized)?;
        if env.ledger().timestamp() >= usage.day_start + DAY_SECONDS {
            return Ok(DailyUsage {
                day_start: env.ledger().timestamp(),
                amount: 0,
            });
        }
        Ok(usage)
    }

    /// Checks the per-market and daily caps for `amount` and, if both pass,
    /// records it. Called *after* the market-core call it authorizes:
    /// Soroban invocations are atomic, so if this returns `Err` the whole
    /// transaction (including the trade already made) reverts.
    fn reserve_capacity(
        env: &Env,
        config: &RiskConfig,
        market_id: u64,
        amount: i128,
        close_time: u64,
    ) -> Result<(), Error> {
        let mut usage = Self::rolled_daily_usage(env)?;
        let mut exposure = Self::market_exposure(env, market_id);
        let new_market = exposure
            .amount
            .checked_add(amount)
            .ok_or(Error::MarketCapExceeded)?;
        if new_market > config.max_market {
            return Err(Error::MarketCapExceeded);
        }
        let new_daily = usage
            .amount
            .checked_add(amount)
            .ok_or(Error::DailyCapExceeded)?;
        if new_daily > config.max_daily {
            return Err(Error::DailyCapExceeded);
        }
        exposure.amount = new_market;
        exposure.open = true;
        usage.amount = new_daily;
        Self::save_market(env, market_id, &exposure, close_time);
        env.storage().instance().set(&DataKey::Daily, &usage);
        TradeAuthorized {
            market_id,
            agent: config.agent.clone(),
            amount,
            market_total: new_market,
            daily_total: new_daily,
        }
        .publish(env);
        Ok(())
    }

    /// Pre-authorizes the SEP-41 `transfer(from, to, amount)` that
    /// market-core will make from the treasury's own balance when the
    /// treasury calls one of its trading entrypoints. See the comment on
    /// `agent_buy` for why this is required.
    fn authorize_token_pull(env: &Env, config: &RiskConfig, from: &Address, amount: i128) {
        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.collateral.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: vec![
                        env,
                        from.into_val(env),
                        config.market_core.into_val(env),
                        amount.into_val(env),
                    ],
                },
                sub_invocations: vec![env],
            }),
        ]);
    }

    fn market_exposure(env: &Env, market_id: u64) -> MarketExposure {
        env.storage()
            .persistent()
            .get(&DataKey::Market(market_id))
            .unwrap_or(MarketExposure {
                amount: 0,
                open: false,
            })
    }

    fn save_market(env: &Env, market_id: u64, exposure: &MarketExposure, close_time: u64) {
        let key = DataKey::Market(market_id);
        env.storage().persistent().set(&key, exposure);
        ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::{Instance as _, Persistent as _},
            Address as _, Ledger, MockAuth, MockAuthInvoke,
        },
        token::{Client as TokenClient, StellarAssetClient},
        BytesN, String,
    };

    // Comfortably past every timestamp advance the tests make, so a market
    // never closes out from under a trade mid-test.
    const MARKET_CLOSE: u64 = 1_000 + 30 * DAY_SECONDS;

    struct Fixture {
        env: Env,
        treasury: TreasuryClient<'static>,
        treasury_id: Address,
        token: Address,
        market_core: MarketCoreClient<'static>,
        market_id: u64,
    }

    fn fixture() -> Fixture {
        fixture_with_caps(
            20 * 10_000_000_i128,
            50 * 10_000_000_i128,
            60 * 10_000_000_i128,
        )
    }

    fn fixture_with_caps(max_trade: i128, max_market: i128, max_daily: i128) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let creator = Address::generate(&env);
        let treasury_id = Address::generate(&env);
        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));
        // Treasury needs real capital: agent_buy/agent_create_market move
        // actual SEP-41 balance, they are not just an advisory cap check.
        token.mint(&treasury_id, &(1_000 * 10_000_000_i128));

        let market_core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.address(),
                treasury_id.clone(),
                Address::generate(&env),
                100u32,
            ),
        );
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[11u8; 32]),
            &BytesN::from_array(&env, &[111u8; 32]),
            &String::from_str(&env, "ipfs://treasury-market"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        let treasury = env.register_at(
            &treasury_id,
            Treasury,
            TreasuryArgs::__constructor(
                &admin,
                &agent,
                &collateral.address(),
                &market_core_id,
                &max_trade,
                &max_market,
                &max_daily,
            ),
        );
        Fixture {
            env: env.clone(),
            treasury: TreasuryClient::new(&env, &treasury),
            treasury_id,
            token: collateral.address(),
            market_core,
            market_id,
        }
    }

    #[test]
    fn enforces_caps_and_closes_exposure() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        assert!(f
            .treasury
            .try_agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0)
            .is_ok());
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0),
            Err(Ok(Error::MarketCapExceeded))
        );
        assert_eq!(
            f.treasury.try_close_trade(&f.market_id),
            Ok(Ok(40 * 10_000_000_i128))
        );
        assert!(f.treasury.daily_usage().amount == 40 * 10_000_000_i128);
    }

    #[test]
    fn rejects_trade_above_single_trade_cap() {
        let f = fixture();
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.market_id, &Outcome::Yes, &(21 * 10_000_000_i128), &0),
            Err(Ok(Error::TradeCapExceeded))
        );
    }

    #[test]
    fn rejects_trade_above_daily_cap() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        f.treasury.close_trade(&f.market_id);
        let second_market = f.market_core.create_market(
            &f.market_core.get_market(&f.market_id).creator,
            &BytesN::from_array(&f.env, &[12u8; 32]),
            &BytesN::from_array(&f.env, &[112u8; 32]),
            &String::from_str(&f.env, "ipfs://treasury-market-2"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury
            .agent_buy(&second_market, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        f.treasury.close_trade(&second_market);
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        f.treasury.close_trade(&f.market_id);
        // 60 already used today (the daily cap); one more real trade of any
        // size must be rejected for exceeding it.
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.market_id, &Outcome::Yes, &(10 * 10_000_000_i128), &0),
            Err(Ok(Error::DailyCapExceeded))
        );
    }

    #[test]
    fn daily_cap_resets_after_one_day() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        f.treasury.close_trade(&f.market_id);
        f.env.ledger().set_timestamp(1_000 + DAY_SECONDS);
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        assert_eq!(f.treasury.daily_usage().amount, 20 * 10_000_000_i128);
    }

    #[test]
    fn collects_market_fees_into_treasury() {
        let f = fixture();
        let trader = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token).mint(&trader, &(100 * 10_000_000_i128));
        let market = f.market_core.get_market(&f.market_id);
        let trader_token = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
        let before = trader_token.balance(&trader);
        f.market_core.buy(
            &trader,
            &f.market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0,
        );
        let fee = market.fee_bps as i128;
        assert!(fee > 0);
        let treasury_before =
            soroban_sdk::token::TokenClient::new(&f.env, &f.token).balance(&f.treasury_id);
        let collected = f.treasury.collect_market_fees(&f.market_id);
        assert!(collected > 0);
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &f.token).balance(&f.treasury_id),
            treasury_before + collected
        );
        assert!(trader_token.balance(&trader) < before);
    }

    #[test]
    fn agent_create_market_seeds_from_treasury_capital() {
        // market-core enforces a 100 USDC MIN_SEED, so this needs a treasury
        // whose max_trade allows seeding (the shared `fixture()` deliberately
        // uses a tighter 20 USDC cap for the trade-limit tests).
        let f = fixture_with_caps(
            150 * 10_000_000_i128,
            300 * 10_000_000_i128,
            300 * 10_000_000_i128,
        );
        let token = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
        let before = token.balance(&f.treasury_id);
        let seed = 100 * 10_000_000_i128;

        let market_id = f.treasury.agent_create_market(
            &BytesN::from_array(&f.env, &[13u8; 32]),
            &BytesN::from_array(&f.env, &[113u8; 32]),
            &String::from_str(&f.env, "ipfs://agent-created"),
            &Category::Macro,
            &MARKET_CLOSE,
            &seed,
            &5000u32,
        );

        let market = f.market_core.get_market(&market_id);
        assert_eq!(market.creator, f.treasury_id);
        assert_eq!(token.balance(&f.treasury_id), before - seed);
        assert_eq!(f.treasury.daily_usage().amount, seed);
    }

    #[test]
    fn agent_create_market_rejects_seed_above_trade_cap() {
        let f = fixture_with_caps(
            150 * 10_000_000_i128,
            300 * 10_000_000_i128,
            300 * 10_000_000_i128,
        );
        assert_eq!(
            f.treasury.try_agent_create_market(
                &BytesN::from_array(&f.env, &[14u8; 32]),
                &BytesN::from_array(&f.env, &[114u8; 32]),
                &String::from_str(&f.env, "ipfs://agent-created-2"),
                &Category::Macro,
                &MARKET_CLOSE,
                &(151 * 10_000_000_i128),
                &5000u32,
            ),
            Err(Ok(Error::TradeCapExceeded))
        );
    }

    #[test]
    fn agent_sell_returns_capital_without_touching_caps() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        let quote = f
            .market_core
            .quote_sell(&f.market_id, &Outcome::Yes, &(5 * 10_000_000_i128));
        let shares_in =
            f.treasury
                .agent_sell(&f.market_id, &Outcome::Yes, &(5 * 10_000_000_i128), &quote);
        assert!(shares_in > 0);
        // Selling must not consume any more of the daily/market caps.
        assert_eq!(f.treasury.daily_usage().amount, 20 * 10_000_000_i128);
    }

    #[test]
    fn paused_treasury_rejects_agent_trading() {
        let f = fixture();
        f.treasury.set_paused(&true);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.market_id, &Outcome::Yes, &(10_000_000_i128), &0),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn wrong_caller_cannot_pause_or_withdraw() {
        let f = fixture();
        let not_admin = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "set_paused",
                    args: (true,).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_set_paused(&true)
            .is_err());
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "withdraw",
                    args: (not_admin.clone(), 1_i128).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_withdraw(&not_admin, &1_i128)
            .is_err());
    }

    /// The pitfall the design doc calls out explicitly: when the treasury
    /// calls `market_core.buy`, market-core in turn calls
    /// `token.transfer(treasury -> market_core)`. That nested transfer needs
    /// the treasury to pre-authorize it via `authorize_as_current_contract`
    /// (see `Treasury::authorize_token_pull`), or the whole call fails
    /// authorization.
    ///
    /// This test deliberately uses `mock_auths` for only the agent's
    /// top-level call — not `mock_all_auths`, which would rubber-stamp the
    /// nested transfer too and hide a regression. Verified by hand: commenting
    /// out the `authorize_token_pull` call in `agent_buy` makes this test
    /// fail with an authorization error; restoring it makes it pass again.
    #[test]
    fn pitfall_agent_buy_requires_treasury_self_authorization_for_nested_transfer() {
        let f = fixture();
        let agent = f.treasury.get_config().agent;
        let market_id = f.market_id;
        let outcome = Outcome::Yes;
        let amount = 20 * 10_000_000_i128;
        let min_out = 0_i128;

        f.env.set_auths(&[]);
        let shares = f
            .treasury
            .mock_auths(&[MockAuth {
                address: &agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "agent_buy",
                    args: (market_id, outcome.clone(), amount, min_out).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy(&market_id, &outcome, &amount, &min_out);
        assert!(shares > 0);
    }

    fn advance_ledgers(env: &Env, secs: u64) {
        assert_eq!(secs % ttl::LEDGER_SECS, 0);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + (secs / ttl::LEDGER_SECS) as u32);
        env.ledger().set_timestamp(env.ledger().timestamp() + secs);
    }

    fn instance_ttl(env: &Env, contract: &Address) -> u32 {
        env.as_contract(contract, || env.storage().instance().get_ttl())
    }

    fn persistent_ttl(env: &Env, contract: &Address, key: &DataKey) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    #[test]
    fn instance_ttl_extended_on_agent_buy() {
        let f = fixture();
        f.env.ledger().set_max_entry_ttl(3_110_400);
        f.env.ledger().set_min_persistent_entry_ttl(4_096);

        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        assert_eq!(instance_ttl(&f.env, &f.treasury_id), ttl::INSTANCE_TARGET);
        // The exposure entry's TTL is keyed to the market's close time:
        // 30 days until close + the 90-day settlement horizon.
        assert_eq!(
            persistent_ttl(&f.env, &f.treasury_id, &DataKey::Market(f.market_id)),
            120 * ttl::DAY_IN_LEDGERS
        );

        // 25 days idle drains the instance TTL below the 7-day threshold...
        advance_ledgers(&f.env, 25 * ttl::DAY_SECS);
        assert!(instance_ttl(&f.env, &f.treasury_id) < ttl::INSTANCE_THRESHOLD);

        // ...and the next trade re-extends it.
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        assert_eq!(instance_ttl(&f.env, &f.treasury_id), ttl::INSTANCE_TARGET);
    }

    // ----- batch redemption through the treasury (issue #15) --------------

    struct BatchFixture {
        env: Env,
        treasury: TreasuryClient<'static>,
        treasury_id: Address,
        market_core: MarketCoreClient<'static>,
        token: Address,
        ids: Vec<u64>,
    }

    /// `n` markets created *by the treasury*, each holding a 1 USDC YES
    /// position bought through `agent_buy`, all closed and resolved YES at
    /// the same timestamp. Sized so the treasury can pay for everything.
    fn batch_fixture(n: u64) -> BatchFixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let treasury_id = Address::generate(&env);
        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(&env, &collateral.address());
        // n x 100 USDC seeds + n x 1 USDC buys + slack.
        sac.mint(&treasury_id, &((n as i128 + 10) * 102 * 10_000_000));

        let market_core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.address(),
                treasury_id.clone(),
                Address::generate(&env),
                100u32,
            ),
        );
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        // Caps must satisfy max_trade <= max_market <= max_daily; buys are
        // 1 USDC each, so the daily cap just needs to cover n of them.
        let daily = (n.max(5) as i128 + 1) * 10_000_000;
        let treasury = env.register_at(
            &treasury_id,
            Treasury,
            TreasuryArgs::__constructor(
                &admin,
                &agent,
                &collateral.address(),
                &market_core_id,
                &(5 * 10_000_000),
                &(5 * 10_000_000),
                &daily,
            ),
        );
        let treasury_client = TreasuryClient::new(&env, &treasury);

        let mut ids = Vec::new(&env);
        for i in 0..n {
            let id = market_core.create_market(
                &treasury_id,
                &BytesN::from_array(&env, &[(i % 250 + 1) as u8; 32]),
                &BytesN::from_array(&env, &[211u8; 32]),
                &String::from_str(&env, "ipfs://treasury-batch"),
                &Category::Crypto,
                &2_000u64,
                &(100 * 10_000_000_i128),
                &5000u32,
            );
            ids.push_back(id);
        }
        for id in ids.iter() {
            treasury_client.agent_buy(&id, &Outcome::Yes, &10_000_000_i128, &0);
        }
        env.ledger().set_timestamp(2_001);
        for id in ids.iter() {
            market_core.resolve(&id, &Outcome::Yes);
        }

        BatchFixture {
            env,
            treasury: treasury_client,
            treasury_id,
            market_core,
            token: collateral.address(),
            ids,
        }
    }

    /// The acceptance test for issue #15's treasury half: a full-size batch
    /// (sized from the contract's own `max_batch` view, so it cannot drift
    /// from `MAX_BATCH`) redeems every position in one call, pays exactly
    /// the reported total in one balance delta, and skips nothing.
    #[test]
    fn agent_redeems_many_through_treasury_at_cap() {
        let probe = batch_fixture(0);
        let cap = probe.market_core.max_batch();
        drop(probe);
        let f = batch_fixture(cap as u64);

        let before = TokenClient::new(&f.env, &f.token).balance(&f.treasury_id);
        let result = f.treasury.redeem_many(&f.ids);
        let after = TokenClient::new(&f.env, &f.token).balance(&f.treasury_id);

        assert_eq!(result.items.len(), cap);
        let mut sum: i128 = 0;
        for (i, item) in result.items.iter().enumerate() {
            assert_eq!(item.market_id, f.ids.get(i as u32).unwrap());
            assert_eq!(item.status, market_core::BatchStatus::Settled);
            assert!(item.payout > 0);
            sum += item.payout;
        }
        assert_eq!(result.total, sum);
        assert_eq!(after - before, result.total);
    }

    /// The batch forwarders are agent-gated exactly like their single-market
    /// counterparts — and the gate holds at a full `max_batch` payload, so a
    /// hostile caller cannot even get a validation error before the auth
    /// check refuses them.
    #[test]
    fn wrong_caller_cannot_redeem_many() {
        let probe = batch_fixture(0);
        let cap = probe.market_core.max_batch();
        let f = probe;
        let mut ids = Vec::new(&f.env);
        for i in 0..cap {
            ids.push_back(i as u64);
        }

        let not_agent = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &not_agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "redeem_many",
                    args: (ids.clone(),).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_redeem_many(&ids)
            .is_err());
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &not_agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "claim_pool_remainders",
                    args: (ids.clone(),).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_pool_remainders(&ids)
            .is_err());
    }

    /// Measurement harness behind the treasury half of market-core's
    /// `MAX_BATCH` doc table (issue #15): run explicitly with
    /// `cargo test -p treasury measure_treasury_redeem_many_resources -- --ignored --nocapture`.
    #[test]
    #[ignore = "measurement harness; run explicitly with --ignored --nocapture"]
    fn measure_treasury_redeem_many_resources() {
        let probe = batch_fixture(0);
        let cap = probe.market_core.max_batch() as u64;
        drop(probe);
        for n in [1u64, 10, cap] {
            let f = batch_fixture(n);
            let res = f.treasury.redeem_many(&f.ids);
            let r = f.env.cost_estimate().resources();
            std::println!(
                "treasury redeem_many n={} total={} items={} | insns={} mem={} disk_read_entries={} mem_read_entries={} write_entries={} footprint={} disk_read_bytes={} write_bytes={} events_bytes={}",
                n,
                res.total,
                res.items.len(),
                r.instructions,
                r.mem_bytes,
                r.disk_read_entries,
                r.memory_read_entries,
                r.write_entries,
                r.disk_read_entries + r.memory_read_entries + r.write_entries,
                r.disk_read_bytes,
                r.write_bytes,
                r.contract_events_size_bytes
            );
        }
    }
}
