#![no_std]

use market_core::MarketCoreClient;
use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env};

const DAY_SECONDS: u64 = 86_400;
const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

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
        env.storage().instance().set(&DataKey::Config, &RiskConfig {
            agent,
            collateral,
            market_core,
            max_trade,
            max_market,
            max_daily,
        });
        env.storage().instance().set(&DataKey::Daily, &DailyUsage {
            day_start: env.ledger().timestamp(),
            amount: 0,
        });
    }

    pub fn get_config(env: Env) -> Result<RiskConfig, Error> {
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

    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        let config = Self::get_config(env.clone())?;
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::TokenClient::new(&env, &config.collateral).transfer(
            &from,
            &env.current_contract_address(),
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

    /// Authorizes one agent allocation and records it as open market exposure.
    /// The downstream execution service must use this successful call as the
    /// on-chain risk decision before placing the external or market-core trade.
    pub fn authorize_trade(env: Env, market_id: u64, amount: i128) -> Result<(), Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount > config.max_trade {
            return Err(Error::TradeCapExceeded);
        }
        let mut usage: DailyUsage = env
            .storage()
            .instance()
            .get(&DataKey::Daily)
            .ok_or(Error::NotInitialized)?;
        if env.ledger().timestamp() >= usage.day_start + DAY_SECONDS {
            usage = DailyUsage {
                day_start: env.ledger().timestamp(),
                amount: 0,
            };
        }
        let mut exposure = Self::market_exposure(&env, market_id);
        let new_market = exposure
            .amount
            .checked_add(amount)
            .ok_or(Error::MarketCapExceeded)?;
        if new_market > config.max_market {
            return Err(Error::MarketCapExceeded);
        }
        let new_daily = usage.amount.checked_add(amount).ok_or(Error::DailyCapExceeded)?;
        if new_daily > config.max_daily {
            return Err(Error::DailyCapExceeded);
        }
        exposure = MarketExposure {
            amount: new_market,
            open: true,
        };
        usage.amount = new_daily;
        Self::save_market(&env, market_id, &exposure);
        env.storage().instance().set(&DataKey::Daily, &usage);
        TradeAuthorized {
            market_id,
            agent: config.agent,
            amount,
            market_total: new_market,
            daily_total: new_daily,
        }
        .publish(&env);
        Ok(())
    }

    pub fn close_trade(env: Env, market_id: u64) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let mut exposure = Self::market_exposure(&env, market_id);
        if !exposure.open {
            return Err(Error::MarketNotOpen);
        }
        exposure.open = false;
        let amount = exposure.amount;
        Self::save_market(&env, market_id, &exposure);
        PositionClosed { market_id, amount }.publish(&env);
        Ok(amount)
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
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
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

    fn save_market(env: &Env, market_id: u64, exposure: &MarketExposure) {
        let key = DataKey::Market(market_id);
        env.storage().persistent().set(&key, exposure);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use market_core::{Category, MarketCore, MarketCoreArgs, Outcome};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        BytesN, String,
    };

    struct Fixture {
        env: Env,
        treasury: TreasuryClient<'static>,
        treasury_id: Address,
        token: Address,
        market_core: market_core::MarketCoreClient<'static>,
        market_id: u64,
    }

    fn fixture() -> Fixture {
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

        let market_core_id = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury_id,
                &Address::generate(&env),
                &100u32,
            ),
        );
        let market_core = market_core::MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[11u8; 32]),
            &String::from_str(&env, "ipfs://treasury-market"),
            &Category::Crypto,
            &60_000,
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
                &(20 * 10_000_000_i128),
                &(50 * 10_000_000_i128),
                &(60 * 10_000_000_i128),
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
        f.treasury.authorize_trade(&f.market_id, &(20 * 10_000_000_i128));
        assert_eq!(
            f.treasury.try_authorize_trade(&f.market_id, &(20 * 10_000_000_i128)),
            Ok(Ok(()))
        );
        assert_eq!(
            f.treasury.try_authorize_trade(&f.market_id, &(20 * 10_000_000_i128)),
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
            f.treasury.try_authorize_trade(&f.market_id, &(21 * 10_000_000_i128)),
            Err(Ok(Error::TradeCapExceeded))
        );
    }

    #[test]
    fn rejects_trade_above_daily_cap() {
        let f = fixture();
        f.treasury.authorize_trade(&f.market_id, &(20 * 10_000_000_i128));
        f.treasury.close_trade(&f.market_id);
        let second_market = f.market_core.create_market(
            &f.market_core.get_market(&f.market_id).creator,
            &BytesN::from_array(&f.env, &[12u8; 32]),
            &String::from_str(&f.env, "ipfs://treasury-market-2"),
            &Category::Crypto,
            &60_000,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury.authorize_trade(&second_market, &(20 * 10_000_000_i128));
        f.treasury.close_trade(&second_market);
        f.treasury.authorize_trade(&f.market_id, &(20 * 10_000_000_i128));
        f.treasury.close_trade(&f.market_id);
        assert_eq!(
            f.treasury.try_authorize_trade(&f.market_id, &1),
            Err(Ok(Error::DailyCapExceeded))
        );
    }

    #[test]
    fn daily_cap_resets_after_one_day() {
        let f = fixture();
        f.treasury.authorize_trade(&f.market_id, &(20 * 10_000_000_i128));
        f.treasury.close_trade(&f.market_id);
        f.env.ledger().set_timestamp(1_000 + DAY_SECONDS);
        f.treasury.authorize_trade(&f.market_id, &(20 * 10_000_000_i128));
        assert_eq!(f.treasury.daily_usage().amount, 20 * 10_000_000_i128);
    }

    #[test]
    fn collects_market_fees_into_treasury() {
        let f = fixture();
        let trader = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token)
            .mint(&trader, &(100 * 10_000_000_i128));
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
        let treasury_before = soroban_sdk::token::TokenClient::new(&f.env, &f.token)
            .balance(&f.treasury_id);
        let collected = f.treasury.collect_market_fees(&f.market_id);
        assert!(collected > 0);
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &f.token)
                .balance(&f.treasury_id),
            treasury_before + collected
        );
        assert!(trader_token.balance(&trader) < before);
    }
}
