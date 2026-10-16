#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal, String, Symbol,
};

// See the comment on the equivalent `mod market_core` in
// contracts/resolver/src/lib.rs: a Cargo path dependency on market-core
// breaks the wasm build (duplicate `__constructor` export), so its client is
// generated from the compiled wasm instead. `docs/adr/0002-cross-contract-calls.md`.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{Category, Client as MarketCoreClient, Outcome};

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
    Paused,
    Successor,
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
    NoSuccessor = 11,
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

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SuccessorSet {
    pub old: Option<Address>,
    pub new: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketMigrated {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub successor: Address,
    pub yes: i128,
    pub no: i128,
    pub lp: bool,
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
        Self::reserve_capacity(&env, &config, market_id, seed_amount)?;
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
        Self::do_agent_buy(env, market_id, outcome, collateral_in, min_shares_out, None)
    }

    /// `agent_buy` with a per-share limit price (`limit_price_bps`, 0 = none)
    /// and a deadline (unix seconds, network time). market-core's `buy_v2`
    /// enforces both; an expired or out-of-limit trade reverts the whole
    /// invocation, so the treasury's caps are never consumed by a reverted
    /// trade.
    pub fn agent_buy_v2(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        Self::do_agent_buy(
            env,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            Some((limit_price_bps, deadline)),
        )
    }

    fn do_agent_buy(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        bound: Option<(u32, u64)>,
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
        let client = MarketCoreClient::new(&env, &config.market_core);
        let shares = match bound {
            Some((limit_price_bps, deadline)) => client.buy_v2(
                &treasury_addr,
                &market_id,
                &outcome,
                &collateral_in,
                &min_shares_out,
                &limit_price_bps,
                &deadline,
            ),
            None => client.buy(
                &treasury_addr,
                &market_id,
                &outcome,
                &collateral_in,
                &min_shares_out,
            ),
        };
        Self::reserve_capacity(&env, &config, market_id, collateral_in)?;
        Ok(shares)
    }

    /// Categorical counterpart of `agent_buy`: buys `outcome_index` shares of
    /// a categorical market using treasury capital. Shares the per-trade and
    /// per-market caps with the binary path, and needs the same nested
    /// transfer pre-authorization (see `do_agent_buy`).
    pub fn agent_buy_cat(
        env: Env,
        market_id: u64,
        outcome_index: u32,
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
        Self::authorize_token_pull(&env, &config, &treasury_addr, collateral_in);
        let shares = MarketCoreClient::new(&env, &config.market_core).buy_cat(
            &treasury_addr,
            &market_id,
            &outcome_index,
            &collateral_in,
            &min_shares_out,
        );
        Self::reserve_capacity(&env, &config, market_id, collateral_in)?;
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
        Self::do_agent_sell(env, market_id, outcome, collateral_out, max_shares_in, None)
    }

    /// `agent_sell` with a per-share limit price (`limit_price_bps`, 0 = no
    /// limit) and a deadline (unix seconds, network time), both enforced by
    /// market-core's `sell_v2`.
    pub fn agent_sell_v2(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        Self::do_agent_sell(
            env,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            Some((limit_price_bps, deadline)),
        )
    }

    fn do_agent_sell(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        bound: Option<(u32, u64)>,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(&env, &config.market_core);
        Ok(match bound {
            Some((limit_price_bps, deadline)) => client.sell_v2(
                &treasury_addr,
                &market_id,
                &outcome,
                &collateral_out,
                &max_shares_in,
                &limit_price_bps,
                &deadline,
            ),
            None => client.sell(
                &treasury_addr,
                &market_id,
                &outcome,
                &collateral_out,
                &max_shares_in,
            ),
        })
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
        Self::save_market(&env, market_id, &exposure);
        PositionClosed { market_id, amount }.publish(&env);
        Ok(amount)
    }

    /// Redeems the treasury's position in a resolved/voided market.
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

    /// Claims the market's LP fee share for a market the treasury created.
    /// The LP portion accrues separately on market-core (see its `claim_lp_fees`);
    /// this is that claim, agent-gated like the other trading entrypoints.
    pub fn agent_claim_lp_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let config = Self::get_config(env.clone())?;
        config.agent.require_auth();
        Ok(MarketCoreClient::new(&env, &config.market_core).claim_lp_fees(&market_id))
    }

    /// Pulls accrued **protocol** fees from a configured market-core contract.
    ///
    /// Only the protocol's share of each market's fees: the LP portion accrues
    /// separately on market-core and belongs to the market's creator — for
    /// agent-created markets that is the treasury itself, via
    /// `agent_claim_lp_fees`.
    pub fn collect_market_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::require_admin(&env)?;
        let config = Self::get_config(env.clone())?;
        let amount = MarketCoreClient::new(&env, &config.market_core).sweep_fees(&market_id);
        FeesCollected { market_id, amount }.publish(&env);
        Ok(amount)
    }

    // ----- migration ---------------------------------------------------------

    /// Sets the successor treasury that `migrate_market` hands positions and
    /// the LP role to. Admin-only; overwrites any previous successor (the
    /// `SuccessorSet` events are the audit trail).
    pub fn set_successor(env: Env, successor: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let old: Option<Address> = env.storage().instance().get(&DataKey::Successor);
        env.storage()
            .instance()
            .set(&DataKey::Successor, &successor);
        SuccessorSet {
            old,
            new: successor,
        }
        .publish(&env);
        Ok(())
    }

    /// Moves the treasury's position in `market_id` — and the LP role, when
    /// the treasury is the market's creator and has not claimed the remainder
    /// yet — to the successor set via `set_successor`, then closes the local
    /// exposure. Admin-only: relocating capital is not an agent trading
    /// action, and the agent key must not be able to drain positions.
    ///
    /// market-core's `transfer_position` / `transfer_lp` require the treasury
    /// itself to authorize. Because the treasury is their *direct* caller
    /// here, the implicit invoker authorization covers both — no
    /// `authorize_as_current_contract` entry is needed (unlike the nested
    /// token transfer in `agent_buy`, see `docs/adr/0002-treasury-nested-auth.md`).
    pub fn migrate_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let successor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Successor)
            .ok_or(Error::NoSuccessor)?;
        let config = Self::get_config(env.clone())?;
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(&env, &config.market_core);

        let position = client.get_position(&market_id, &treasury_addr);
        if position.yes > 0 {
            client.transfer_position(
                &treasury_addr,
                &successor,
                &market_id,
                &Outcome::Yes,
                &position.yes,
            );
        }
        if position.no > 0 {
            client.transfer_position(
                &treasury_addr,
                &successor,
                &market_id,
                &Outcome::No,
                &position.no,
            );
        }
        let market = client.get_market(&market_id);
        let lp = market.creator == treasury_addr && !market.lp_claimed;
        if lp {
            client.transfer_lp(&market_id, &successor);
        }
        let mut exposure = Self::market_exposure(&env, market_id);
        exposure.open = false;
        Self::save_market(&env, market_id, &exposure);
        MarketMigrated {
            market_id,
            successor,
            yes: position.yes,
            no: position.no,
            lp,
        }
        .publish(&env);
        Ok(())
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

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
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
        Self::save_market(env, market_id, &exposure);
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

    fn save_market(env: &Env, market_id: u64, exposure: &MarketExposure) {
        let key = DataKey::Market(market_id);
        env.storage().persistent().set(&key, exposure);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        BytesN, String, Vec,
    };

    // Comfortably past every timestamp advance the tests make, so a market
    // never closes out from under a trade mid-test.
    const MARKET_CLOSE: u64 = 1_000 + 30 * DAY_SECONDS;

    struct Fixture {
        env: Env,
        admin: Address,
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
                // Protocol keeps the whole fee; treasury tests only exercise
                // protocol-side sweeps.
                10_000u32,
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
            admin,
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

    #[test]
    fn agent_claims_lp_fees_for_own_market() {
        let f = fixture_with_caps(
            150 * 10_000_000_i128,
            300 * 10_000_000_i128,
            300 * 10_000_000_i128,
        );
        // New markets snapshot the split at creation; give the creator half.
        f.market_core.set_protocol_fee_share_bps(&5000u32);
        let market_id = f.treasury.agent_create_market(
            &BytesN::from_array(&f.env, &[15u8; 32]),
            &BytesN::from_array(&f.env, &[115u8; 32]),
            &String::from_str(&f.env, "ipfs://lp-fees"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        let trader = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token).mint(&trader, &(100 * 10_000_000_i128));
        f.market_core.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // Fee is 1_000_000, split 50/50 between protocol and the LP.
        let token = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
        let before = token.balance(&f.treasury_id);
        assert_eq!(f.treasury.agent_claim_lp_fees(&market_id), 500_000);
        assert_eq!(token.balance(&f.treasury_id), before + 500_000);
        assert_eq!(f.treasury.agent_claim_lp_fees(&market_id), 0);
    }

    #[test]
    fn agent_buy_breaker_revert_leaves_caps_unchanged() {
        let f = fixture();
        f.market_core
            .set_default_breaker(&market_core::BreakerConfig {
                max_impact_bps: 10,
                band_bps: 0,
            });
        let creator = f.market_core.get_market(&f.market_id).creator;
        let market_id = f.market_core.create_market(
            &creator,
            &BytesN::from_array(&f.env, &[16u8; 32]),
            &BytesN::from_array(&f.env, &[116u8; 32]),
            &String::from_str(&f.env, "ipfs://breaker-market"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        // 0.1 USDC moves the price ~4 bps: inside the 10 bps impact cap.
        f.treasury
            .agent_buy(&market_id, &Outcome::Yes, &(1_000_000_i128), &0);
        assert_eq!(f.treasury.daily_usage().amount, 1_000_000);

        // 20 USDC moves it ~893 bps: market-core trips the breaker, which
        // reverts the whole treasury call — the caps must not absorb it.
        assert!(f
            .treasury
            .try_agent_buy(&market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0)
            .is_err());
        assert_eq!(f.treasury.daily_usage().amount, 1_000_000);
        let exposure = f.env.as_contract(&f.treasury_id, || {
            f.env
                .storage()
                .persistent()
                .get::<DataKey, MarketExposure>(&DataKey::Market(market_id))
                .unwrap()
        });
        assert!(exposure.open);
        assert_eq!(exposure.amount, 1_000_000);
    }

    #[test]
    fn agent_buy_v2_forwards_bounds() {
        let f = fixture();
        let now = f.env.ledger().timestamp();
        // Expired deadline.
        assert!(f
            .treasury
            .try_agent_buy_v2(
                &f.market_id,
                &Outcome::Yes,
                &(10_000_000_i128),
                &0,
                &0u32,
                &(now - 1),
            )
            .is_err());
        // Average fill for 20 USDC is ~5505 bps; limit 5000 must reject.
        assert!(f
            .treasury
            .try_agent_buy_v2(
                &f.market_id,
                &Outcome::Yes,
                &(20 * 10_000_000_i128),
                &0,
                &5000u32,
                &(now + 60),
            )
            .is_err());
        assert_eq!(f.treasury.daily_usage().amount, 0);

        // Generous bounds: succeeds and consumes the caps like agent_buy.
        let shares = f.treasury.agent_buy_v2(
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
            &6000u32,
            &(now + 60),
        );
        assert!(shares > 0);
        assert_eq!(f.treasury.daily_usage().amount, 20 * 10_000_000_i128);

        // The sell side forwards its bounds too.
        let quote = f
            .market_core
            .quote_sell(&f.market_id, &Outcome::Yes, &(5 * 10_000_000_i128));
        let sold = f.treasury.agent_sell_v2(
            &f.market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &quote,
            &0u32,
            &(now + 60),
        );
        assert!(sold > 0);
        assert!(f
            .treasury
            .try_agent_sell_v2(
                &f.market_id,
                &Outcome::Yes,
                &(5 * 10_000_000_i128),
                &quote,
                &0u32,
                &(now - 1),
            )
            .is_err());
    }

    #[test]
    fn agent_buy_v2_deadline_revert_leaves_caps_unchanged() {
        let f = fixture();
        let past = f.env.ledger().timestamp() - 1;
        assert!(f
            .treasury
            .try_agent_buy_v2(
                &f.market_id,
                &Outcome::Yes,
                &(10 * 10_000_000_i128),
                &0,
                &0u32,
                &past,
            )
            .is_err());
        assert_eq!(f.treasury.daily_usage().amount, 0);
        let exposure = f.env.as_contract(&f.treasury_id, || {
            f.env
                .storage()
                .persistent()
                .get::<DataKey, MarketExposure>(&DataKey::Market(f.market_id))
        });
        assert_eq!(exposure, None);
    }

    /// The v2 twin of the pitfall test above: the `buy_v2` path must also
    /// pre-authorize the nested token transfer (`mock_auths` for only the
    /// agent, so a regression in `authorize_token_pull` fails here).
    #[test]
    fn pitfall_agent_buy_v2_forwards_nested_transfer_auth() {
        let f = fixture();
        let agent = f.treasury.get_config().agent;
        let market_id = f.market_id;
        let outcome = Outcome::Yes;
        let amount = 20 * 10_000_000_i128;
        let min_out = 0_i128;
        let limit = 0u32;
        let deadline = f.env.ledger().timestamp() + 60;

        f.env.set_auths(&[]);
        let shares = f
            .treasury
            .mock_auths(&[MockAuth {
                address: &agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "agent_buy_v2",
                    args: (market_id, outcome.clone(), amount, min_out, limit, deadline)
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy_v2(&market_id, &outcome, &amount, &min_out, &limit, &deadline);
        assert!(shares > 0);
    }

    /// Creates a 3-outcome categorical market seeded by the fixture creator.
    fn create_cat_market(f: &Fixture, nonce: u8) -> u64 {
        let creator = f.market_core.get_market(&f.market_id).creator;
        f.market_core.create_categorical_market(
            &creator,
            &BytesN::from_array(&f.env, &[nonce; 32]),
            &BytesN::from_array(&f.env, &[nonce + 100; 32]),
            &String::from_str(&f.env, "ipfs://treasury-cat-market"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &Vec::from_array(&f.env, [5_000u32, 3_000, 2_000]),
        )
    }

    #[test]
    fn agent_buy_cat_respects_trade_and_market_caps() {
        let f = fixture();
        let cat_market = create_cat_market(&f, 18);

        // Same single-trade cap as the binary path.
        assert_eq!(
            f.treasury
                .try_agent_buy_cat(&cat_market, &0u32, &(21 * 10_000_000_i128), &0),
            Err(Ok(Error::TradeCapExceeded))
        );
        // Two capped buys fill the per-market cap; a third — even on another
        // outcome — is rejected.
        f.treasury
            .agent_buy_cat(&cat_market, &0u32, &(20 * 10_000_000_i128), &0);
        f.treasury
            .agent_buy_cat(&cat_market, &2u32, &(20 * 10_000_000_i128), &0);
        assert_eq!(
            f.treasury
                .try_agent_buy_cat(&cat_market, &1u32, &(20 * 10_000_000_i128), &0),
            Err(Ok(Error::MarketCapExceeded))
        );
        assert_eq!(
            f.treasury.try_close_trade(&cat_market),
            Ok(Ok(40 * 10_000_000_i128))
        );
    }

    /// The categorical twin of the `agent_buy` pitfall test: `buy_cat`'s
    /// nested token transfer must be pre-authorized too (`mock_auths` for
    /// only the agent, so a regression in `authorize_token_pull` fails here).
    #[test]
    fn pitfall_agent_buy_cat_forwards_nested_transfer_auth() {
        let f = fixture();
        let cat_market = create_cat_market(&f, 19);
        let agent = f.treasury.get_config().agent;
        let outcome_index = 1u32;
        let amount = 20 * 10_000_000_i128;
        let min_out = 0_i128;

        f.env.set_auths(&[]);
        let shares = f
            .treasury
            .mock_auths(&[MockAuth {
                address: &agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "agent_buy_cat",
                    args: (cat_market, outcome_index, amount, min_out).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy_cat(&cat_market, &outcome_index, &amount, &min_out);
        assert!(shares > 0);
    }

    #[test]
    fn migrate_market_moves_position_and_lp_to_successor() {
        let f = fixture_with_caps(
            150 * 10_000_000_i128,
            300 * 10_000_000_i128,
            300 * 10_000_000_i128,
        );
        let market_id = f.treasury.agent_create_market(
            &BytesN::from_array(&f.env, &[17u8; 32]),
            &BytesN::from_array(&f.env, &[117u8; 32]),
            &String::from_str(&f.env, "ipfs://migration"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury
            .agent_buy(&market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        let held = f.market_core.get_position(&market_id, &f.treasury_id).yes;
        assert!(held > 0);
        assert_eq!(f.market_core.get_market(&market_id).creator, f.treasury_id);

        let successor = Address::generate(&f.env);
        f.treasury.set_successor(&successor);
        f.treasury.migrate_market(&market_id);

        assert_eq!(
            f.market_core.get_position(&market_id, &f.treasury_id).yes,
            0
        );
        assert_eq!(f.market_core.get_position(&market_id, &successor).yes, held);
        assert_eq!(f.market_core.get_market(&market_id).creator, successor);
        let exposure = f.env.as_contract(&f.treasury_id, || {
            f.env
                .storage()
                .persistent()
                .get::<DataKey, MarketExposure>(&DataKey::Market(market_id))
                .unwrap()
        });
        assert!(!exposure.open);
        // Migration does not free the cumulative cap (like close_trade).
        assert_eq!(exposure.amount, 120 * 10_000_000_i128);
    }

    #[test]
    fn migrate_requires_successor() {
        let f = fixture();
        assert_eq!(
            f.treasury.try_migrate_market(&f.market_id),
            Err(Ok(Error::NoSuccessor))
        );
    }

    #[test]
    fn agent_cannot_migrate() {
        let f = fixture();
        let agent = f.treasury.get_config().agent;
        f.env.set_auths(&[]);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "migrate_market",
                    args: (f.market_id,).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_migrate_market(&f.market_id)
            .is_err());
    }

    /// The treasury's calls to market-core's `transfer_position` /
    /// `transfer_lp` are *direct* calls, so market-core's `require_auth`
    /// on the treasury is satisfied implicitly by the invoker rule — no
    /// `authorize_as_current_contract` entry is needed (unlike the nested
    /// token transfer in `agent_buy`). Mocking only the admin's auth must be
    /// enough for the whole migration.
    #[test]
    fn pitfall_migrate_market_needs_only_admin_auth() {
        let f = fixture_with_caps(
            150 * 10_000_000_i128,
            300 * 10_000_000_i128,
            300 * 10_000_000_i128,
        );
        let market_id = f.treasury.agent_create_market(
            &BytesN::from_array(&f.env, &[18u8; 32]),
            &BytesN::from_array(&f.env, &[118u8; 32]),
            &String::from_str(&f.env, "ipfs://migration-auth"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury
            .agent_buy(&market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        let successor = Address::generate(&f.env);
        f.treasury.set_successor(&successor);
        let held = f.market_core.get_position(&market_id, &f.treasury_id).yes;

        f.env.set_auths(&[]);
        f.treasury
            .mock_auths(&[MockAuth {
                address: &f.admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "migrate_market",
                    args: (market_id,).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .migrate_market(&market_id);

        assert_eq!(f.market_core.get_position(&market_id, &successor).yes, held);
        assert_eq!(f.market_core.get_market(&market_id).creator, successor);
    }

    #[test]
    fn migrate_then_successor_redeems_after_resolution() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.market_id, &Outcome::Yes, &(20 * 10_000_000_i128), &0);
        let successor = Address::generate(&f.env);
        f.treasury.set_successor(&successor);

        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        f.treasury.migrate_market(&f.market_id);

        // The successor (not the treasury) now redeems the migrated shares.
        let payout = f.market_core.redeem(&successor, &f.market_id);
        assert!(payout > 0);
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&f.env, &f.token).balance(&successor),
            payout
        );
        assert_eq!(
            f.market_core.get_position(&f.market_id, &f.treasury_id).yes,
            0
        );
    }
}
