#![no_std]

mod math;

use math::{MathError, Settlement, BPS, MAX_SETS};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Ledger close time is ~5s, so 17_280 ledgers ~ 1 day. Tune if that changes.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 60 * DAY_IN_LEDGERS;

/// Fee ceiling: 10%.
const MAX_FEE_BPS: u32 = 1_000;
/// Minimum seed liquidity: 100 USDC (7 decimals). Stops spam markets.
const MIN_SEED: i128 = 100 * 10_000_000;

// ---------------------------------------------------------------------------
// Types shared with the frontend/backend
// ---------------------------------------------------------------------------
// Generate TypeScript bindings straight from the compiled contract
// (`stellar contract bindings typescript`) so enums like `Category` cannot
// drift between the contract, the API and the UI.

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Yes,
    No,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Category {
    Crypto,
    Macro,
    Geopolitics,
    Sports,
    Culture,
    Other,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketStatus {
    /// Trading allowed until `close_time`, then waiting for the resolver.
    Open,
    /// Final. Winning shares redeem 1:1.
    Resolved(Outcome),
    /// Invalid market. Every share redeems at 0.5.
    Void,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub creator: Address,
    /// sha256 of the canonical question JSON stored off-chain (IPFS), so a
    /// client can prove the text it shows is the text that was committed.
    pub question_hash: BytesN<32>,
    /// IPFS CID / URI of the question metadata.
    pub meta_uri: String,
    pub category: Category,
    /// Unix seconds (ledger timestamp). Trading stops at this time.
    pub close_time: u64,
    /// Snapshot of the fee at creation so later config changes never move it.
    pub fee_bps: u32,
    pub status: MarketStatus,
    pub reserve_yes: i128,
    pub reserve_no: i128,
    /// Complete sets in existence == collateral locked for this market.
    pub sets_minted: i128,
    /// Trading fees waiting for `sweep_fees`.
    pub fees_accrued: i128,
    /// Creator has withdrawn the pool remainder after finality.
    pub lp_claimed: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Position {
    pub yes: i128,
    pub no: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub collateral: Address,
    pub treasury: Address,
    pub resolver: Address,
    pub default_fee_bps: u32,
    pub paused: bool,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    // instance storage (one entry, shared TTL): global config
    Admin,
    Collateral,
    Treasury,
    Resolver,
    DefaultFeeBps,
    Paused,
    NextId,
    // persistent storage (one entry each, own TTL)
    Market(u64),
    Position(u64, Address),
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Paused = 2,
    InvalidFee = 3,
    InvalidAmount = 4,
    InvalidProbability = 5,
    InvalidCloseTime = 6,
    MarketNotFound = 7,
    MarketNotOpen = 8,
    MarketClosed = 9,
    NotClosedYet = 10,
    NotFinal = 11,
    SlippageExceeded = 12,
    InsufficientShares = 13,
    InsufficientLiquidity = 14,
    MarketTooLarge = 15,
    NothingToRedeem = 16,
    AlreadyClaimed = 17,
    Overflow = 18,
}

impl From<MathError> for Error {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => Error::Overflow,
            MathError::InvalidInput => Error::InvalidAmount,
            MathError::InsufficientLiquidity => Error::InsufficientLiquidity,
        }
    }
}

// ---------------------------------------------------------------------------
// Events (the backend indexes these into Postgres; RPC keeps only a short
// event window, so do not rely on querying old events live)
// ---------------------------------------------------------------------------

#[contractevent]
pub struct MarketCreated {
    #[topic]
    pub market_id: u64,
    pub creator: Address,
    pub category: Category,
    pub close_time: u64,
    pub seed_amount: i128,
    pub initial_yes_bps: u32,
}

#[contractevent]
pub struct Trade {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub trader: Address,
    pub outcome: Outcome,
    pub is_buy: bool,
    pub collateral: i128,
    pub shares: i128,
    pub fee: i128,
    pub reserve_yes: i128,
    pub reserve_no: i128,
}

#[contractevent]
pub struct MarketResolved {
    #[topic]
    pub market_id: u64,
    /// None means the market was voided.
    pub outcome: Option<Outcome>,
}

#[contractevent]
pub struct Redeemed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub holder: Address,
    pub payout: i128,
}

#[contractevent]
pub struct FeesSwept {
    #[topic]
    pub market_id: u64,
    pub amount: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MarketCore;

#[contractimpl]
impl MarketCore {
    /// Runs atomically at deploy time, so nobody can front-run initialization.
    pub fn __constructor(
        env: Env,
        admin: Address,
        collateral: Address,
        treasury: Address,
        resolver: Address,
        default_fee_bps: u32,
    ) {
        if default_fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Collateral, &collateral);
        s.set(&DataKey::Treasury, &treasury);
        s.set(&DataKey::Resolver, &resolver);
        s.set(&DataKey::DefaultFeeBps, &default_fee_bps);
        s.set(&DataKey::Paused, &false);
        s.set(&DataKey::NextId, &0u64);
    }

    // ----- admin ----------------------------------------------------------

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Affects markets created after the call; existing markets keep their fee.
    pub fn set_default_fee_bps(env: Env, fee_bps: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        env.storage().instance().set(&DataKey::DefaultFeeBps, &fee_bps);
        Ok(())
    }

    pub fn set_resolver(env: Env, resolver: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Resolver, &resolver);
        Ok(())
    }

    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        Ok(())
    }

    // ----- market lifecycle -----------------------------------------------

    /// Creates a market and seeds the pool. `creator` becomes the sole LP.
    /// `initial_yes_bps` in [100, 9900] sets the opening YES probability;
    /// the creator receives the leftover shares of the likelier outcome.
    pub fn create_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        creator.require_auth();

        if close_time <= env.ledger().timestamp() {
            return Err(Error::InvalidCloseTime);
        }
        if seed_amount < MIN_SEED || seed_amount > MAX_SETS {
            return Err(Error::InvalidAmount);
        }
        if initial_yes_bps < math::MIN_PROB_BPS || initial_yes_bps > math::MAX_PROB_BPS {
            return Err(Error::InvalidProbability);
        }
        let seed = math::seed_reserves(seed_amount, initial_yes_bps)?;

        let s = env.storage().instance();
        let id: u64 = s.get(&DataKey::NextId).ok_or(Error::NotInitialized)?;
        s.set(&DataKey::NextId, &(id + 1));
        let fee_bps: u32 = s.get(&DataKey::DefaultFeeBps).ok_or(Error::NotInitialized)?;

        let market = Market {
            creator: creator.clone(),
            question_hash,
            meta_uri,
            category,
            close_time,
            fee_bps,
            status: MarketStatus::Open,
            reserve_yes: seed.reserve_yes,
            reserve_no: seed.reserve_no,
            sets_minted: seed_amount,
            fees_accrued: 0,
            lp_claimed: false,
        };
        Self::save_market(&env, id, &market);
        if seed.creator_yes > 0 || seed.creator_no > 0 {
            Self::save_position(
                &env,
                id,
                &creator,
                &Position { yes: seed.creator_yes, no: seed.creator_no },
            );
        }

        Self::token(&env)?.transfer(&creator, &env.current_contract_address(), &seed_amount);

        MarketCreated {
            market_id: id,
            creator,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
        }
        .publish(&env);
        Ok(id)
    }

    // ----- trading --------------------------------------------------------

    /// Spend `collateral_in` to buy `outcome` shares. Returns shares received.
    /// Reverts if fewer than `min_shares_out` would be received.
    pub fn buy(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?;
        if q.shares_out < min_shares_out {
            return Err(Error::SlippageExceeded);
        }
        let new_sets = m.sets_minted.checked_add(q.net).ok_or(Error::Overflow)?;
        if new_sets > MAX_SETS {
            return Err(Error::MarketTooLarge);
        }

        // effects
        Self::set_reserves(&mut m, outcome, q.new_reserve_bought, q.new_reserve_other);
        m.sets_minted = new_sets;
        m.fees_accrued = m.fees_accrued.checked_add(q.fee).ok_or(Error::Overflow)?;
        let mut pos = Self::load_position(&env, market_id, &trader);
        match outcome {
            Outcome::Yes => pos.yes += q.shares_out,
            Outcome::No => pos.no += q.shares_out,
        }
        Self::save_position(&env, market_id, &trader, &pos);
        Self::save_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&trader, &env.current_contract_address(), &collateral_in);

        Trade {
            market_id,
            trader,
            outcome,
            is_buy: true,
            collateral: collateral_in,
            shares: q.shares_out,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        Ok(q.shares_out)
    }

    /// Receive exactly `collateral_out` by selling `outcome` shares. Returns
    /// shares sold. Reverts if more than `max_shares_in` would be needed.
    /// Clients turn "sell N shares" into `collateral_out` off-chain
    /// (see `math::calc_sell` docs) and add a slippage margin to `max_shares_in`.
    pub fn sell(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_sell(r_sold, r_other, collateral_out, m.fee_bps)?;
        if q.shares_in > max_shares_in {
            return Err(Error::SlippageExceeded);
        }

        let mut pos = Self::load_position(&env, market_id, &trader);
        let held = match outcome {
            Outcome::Yes => pos.yes,
            Outcome::No => pos.no,
        };
        if held < q.shares_in {
            return Err(Error::InsufficientShares);
        }

        // effects
        match outcome {
            Outcome::Yes => pos.yes -= q.shares_in,
            Outcome::No => pos.no -= q.shares_in,
        }
        Self::save_position(&env, market_id, &trader, &pos);
        Self::set_reserves(&mut m, outcome, q.new_reserve_sold, q.new_reserve_other);
        m.sets_minted -= q.gross;
        m.fees_accrued = m.fees_accrued.checked_add(q.fee).ok_or(Error::Overflow)?;
        Self::save_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&env.current_contract_address(), &trader, &collateral_out);

        Trade {
            market_id,
            trader,
            outcome,
            is_buy: false,
            collateral: collateral_out,
            shares: q.shares_in,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        Ok(q.shares_in)
    }

    // ----- resolution -----------------------------------------------------
    // Only the configured resolver contract may call these. When the resolver
    // contract is the direct caller, `require_auth` on its address passes.

    pub fn resolve(env: Env, market_id: u64, outcome: Outcome) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() < m.close_time {
            return Err(Error::NotClosedYet);
        }
        m.status = MarketStatus::Resolved(outcome);
        Self::save_market(&env, market_id, &m);
        MarketResolved { market_id, outcome: Some(outcome) }.publish(&env);
        Ok(())
    }

    /// Invalid or unresolvable market. Allowed any time before finality.
    pub fn void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        m.status = MarketStatus::Void;
        Self::save_market(&env, market_id, &m);
        MarketResolved { market_id, outcome: None }.publish(&env);
        Ok(())
    }

    // ----- settlement -----------------------------------------------------

    /// Pays out `holder`'s position for a final market and clears it.
    /// Losing positions clear with a payout of 0.
    pub fn redeem(env: Env, holder: Address, market_id: u64) -> Result<i128, Error> {
        holder.require_auth();
        let m = Self::load_market(&env, market_id)?;
        let kind = Self::settlement(&m)?;
        let pos = Self::load_position(&env, market_id, &holder);
        if pos.yes == 0 && pos.no == 0 {
            return Err(Error::NothingToRedeem);
        }
        let payout = math::settle_value(kind, pos.yes, pos.no);

        Self::save_position(&env, market_id, &holder, &Position { yes: 0, no: 0 });
        if payout > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &holder, &payout);
        }
        Redeemed { market_id, holder, payout }.publish(&env);
        Ok(payout)
    }

    /// Creator (the LP) withdraws whatever the pool still holds once final.
    pub fn claim_pool_remainder(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let kind = Self::settlement(&m)?;
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        let payout = math::settle_value(kind, m.reserve_yes, m.reserve_no);
        m.reserve_yes = 0;
        m.reserve_no = 0;
        m.lp_claimed = true;
        let creator = m.creator.clone();
        Self::save_market(&env, market_id, &m);
        if payout > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &creator, &payout);
        }
        Ok(payout)
    }

    /// Anyone can move accrued fees to the treasury.
    pub fn sweep_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        let amount = m.fees_accrued;
        if amount <= 0 {
            return Ok(0);
        }
        m.fees_accrued = 0;
        Self::save_market(&env, market_id, &m);
        let treasury: Address = Self::instance_get(&env, &DataKey::Treasury)?;
        Self::token(&env)?.transfer(&env.current_contract_address(), &treasury, &amount);
        FeesSwept { market_id, amount }.publish(&env);
        Ok(amount)
    }

    // ----- views ----------------------------------------------------------

    pub fn get_config(env: Env) -> Result<Config, Error> {
        Ok(Config {
            admin: Self::instance_get(&env, &DataKey::Admin)?,
            collateral: Self::instance_get(&env, &DataKey::Collateral)?,
            treasury: Self::instance_get(&env, &DataKey::Treasury)?,
            resolver: Self::instance_get(&env, &DataKey::Resolver)?,
            default_fee_bps: Self::instance_get(&env, &DataKey::DefaultFeeBps)?,
            paused: Self::instance_get(&env, &DataKey::Paused)?,
        })
    }

    pub fn market_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        Self::load_market(&env, market_id)
    }

    pub fn get_position(env: Env, market_id: u64, holder: Address) -> Position {
        Self::load_position(&env, market_id, &holder)
    }

    /// Spot price of `outcome` in bps (0..=10_000). YES + NO ~ 10_000.
    pub fn get_price(env: Env, market_id: u64, outcome: Outcome) -> Result<u32, Error> {
        let m = Self::load_market(&env, market_id)?;
        let yes = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let p = match outcome {
            Outcome::Yes => yes,
            Outcome::No => BPS - yes,
        };
        Ok(p as u32)
    }

    /// Shares a `buy` of `collateral_in` would return right now.
    pub fn quote_buy(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?.shares_out)
    }

    /// Shares a `sell` for exactly `collateral_out` would consume right now.
    pub fn quote_sell(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_sell(r_sold, r_other, collateral_out, m.fee_bps)?.shares_in)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl MarketCore {
    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Result<V, Error> {
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        env.storage().instance().get(key).ok_or(Error::NotInitialized)
    }

    fn token(env: &Env) -> Result<token::TokenClient<'_>, Error> {
        let addr: Address = Self::instance_get(env, &DataKey::Collateral)?;
        Ok(token::TokenClient::new(env, &addr))
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::instance_get(env, &DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn require_resolver(env: &Env) -> Result<(), Error> {
        let resolver: Address = Self::instance_get(env, &DataKey::Resolver)?;
        resolver.require_auth();
        Ok(())
    }

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = Self::instance_get(env, &DataKey::Paused)?;
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn assert_tradable(env: &Env, m: &Market) -> Result<(), Error> {
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() >= m.close_time {
            return Err(Error::MarketClosed);
        }
        Ok(())
    }

    fn settlement(m: &Market) -> Result<Settlement, Error> {
        match m.status {
            MarketStatus::Open => Err(Error::NotFinal),
            MarketStatus::Resolved(Outcome::Yes) => Ok(Settlement::Yes),
            MarketStatus::Resolved(Outcome::No) => Ok(Settlement::No),
            MarketStatus::Void => Ok(Settlement::Void),
        }
    }

    /// (reserve of `outcome`, reserve of the other outcome)
    fn reserves_for(m: &Market, outcome: Outcome) -> (i128, i128) {
        match outcome {
            Outcome::Yes => (m.reserve_yes, m.reserve_no),
            Outcome::No => (m.reserve_no, m.reserve_yes),
        }
    }

    fn set_reserves(m: &mut Market, outcome: Outcome, r_outcome: i128, r_other: i128) {
        match outcome {
            Outcome::Yes => {
                m.reserve_yes = r_outcome;
                m.reserve_no = r_other;
            }
            Outcome::No => {
                m.reserve_no = r_outcome;
                m.reserve_yes = r_other;
            }
        }
    }

    fn load_market(env: &Env, id: u64) -> Result<Market, Error> {
        let key = DataKey::Market(id);
        let m: Market = env.storage().persistent().get(&key).ok_or(Error::MarketNotFound)?;
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(m)
    }

    fn save_market(env: &Env, id: u64, m: &Market) {
        let key = DataKey::Market(id);
        env.storage().persistent().set(&key, m);
        env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_position(env: &Env, id: u64, holder: &Address) -> Position {
        let key = DataKey::Position(id, holder.clone());
        match env.storage().persistent().get::<_, Position>(&key) {
            Some(p) => {
                env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
                p
            }
            None => Position { yes: 0, no: 0 },
        }
    }

    /// Empty positions are removed so storage does not grow with dust entries.
    fn save_position(env: &Env, id: u64, holder: &Address, p: &Position) {
        let key = DataKey::Position(id, holder.clone());
        if p.yes == 0 && p.no == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, p);
            env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
    };

    fn setup_market() -> (Env, MarketCoreClient<'static>, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let creator = Address::generate(&env);
        let trader = Address::generate(&env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let collateral_client = StellarAssetClient::new(&env, &collateral.address());
        collateral_client.mint(&creator, &10_000_000_000_i128);
        collateral_client.mint(&trader, &10_000_000_000_i128);

        let contract_id = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
            ),
        );
        let client = MarketCoreClient::new(&env, &contract_id);

        (env, client, creator, trader, resolver, collateral.address())
    }

    #[test]
    fn create_market_sets_initial_price() {
        let (env, client, creator, _, _, _) = setup_market();
        let question_hash = BytesN::from_array(&env, &[1u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-1");

        let market_id = client.create_market(
            &creator,
            &question_hash,
            &meta_uri,
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &6800u32,
        );

        assert_eq!(market_id, 0);
        assert_eq!(client.market_count(), 1);

        let market = client.get_market(&market_id);
        assert_eq!(market.category, Category::Crypto);
        assert_eq!(market.status, MarketStatus::Open);
        assert!(client.get_price(&market_id, &Outcome::Yes) > 6000);
    }

    #[test]
    fn buy_moves_price_and_redeem_after_resolution() {
        let (env, client, creator, trader, _, _) = setup_market();
        let question_hash = BytesN::from_array(&env, &[2u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-2");
        let market_id = client.create_market(
            &creator,
            &question_hash,
            &meta_uri,
            &Category::Macro,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        let price_before = client.get_price(&market_id, &Outcome::Yes);
        let shares_out = client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert!(shares_out > 0);
        let price_after = client.get_price(&market_id, &Outcome::Yes);
        assert!(price_after > price_before);

        let close_time = client.get_market(&market_id).close_time;
        env.ledger().set_timestamp(close_time + 1);
        client.resolve(&market_id, &Outcome::Yes);

        let payout = client.redeem(&trader, &market_id);
        assert!(payout > 0);
        assert_eq!(client.get_position(&market_id, &trader).yes, 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn rejects_close_time_in_the_past() {
        let (env, client, creator, _, _, _) = setup_market();
        client.create_market(
            &creator,
            &BytesN::from_array(&env, &[3u8; 32]),
            &String::from_str(&env, "ipfs://invalid-close"),
            &Category::Other,
            &env.ledger().timestamp(),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn rejects_probability_outside_bounds() {
        let (env, client, creator, _, _, _) = setup_market();
        client.create_market(
            &creator,
            &BytesN::from_array(&env, &[4u8; 32]),
            &String::from_str(&env, "ipfs://invalid-probability"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &9901u32,
        );
    }

    #[test]
    fn sell_returns_collateral_and_reduces_position() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[5u8; 32]),
            &String::from_str(&env, "ipfs://sell"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let balance_before = token.balance(&trader);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let position_before = client.get_position(&market_id, &trader);

        let shares_sold = client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(1 * 10_000_000_i128),
            &client.quote_sell(
                &market_id,
                &Outcome::Yes,
                &(1 * 10_000_000_i128),
            ),
        );

        let position_after = client.get_position(&market_id, &trader);
        assert!(shares_sold > 0);
        assert_eq!(position_before.yes - position_after.yes, shares_sold);
        assert!(token.balance(&trader) > balance_before - 10 * 10_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn sell_rejects_excessive_share_slippage() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[6u8; 32]),
            &String::from_str(&env, "ipfs://sell-slippage"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let required = client.quote_sell(
            &market_id,
            &Outcome::Yes,
            &(1 * 10_000_000_i128),
        );
        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(1 * 10_000_000_i128),
            &(required - 1),
        );
    }

    #[test]
    fn void_market_allows_creator_to_claim_pool_remainder() {
        let (env, client, creator, _, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[7u8; 32]),
            &String::from_str(&env, "ipfs://void"),
            &Category::Geopolitics,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        client.void_market(&market_id);
        assert_eq!(client.get_market(&market_id).status, MarketStatus::Void);

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        let payout = client.claim_pool_remainder(&market_id);
        assert!(payout > 0);
        assert_eq!(token.balance(&creator), before + payout);
        assert!(client.get_market(&market_id).lp_claimed);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn creator_cannot_claim_pool_remainder_twice() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[8u8; 32]),
            &String::from_str(&env, "ipfs://claim-once"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.void_market(&market_id);
        client.claim_pool_remainder(&market_id);
        client.claim_pool_remainder(&market_id);
    }

    #[test]
    fn sweep_fees_transfers_accrued_fees_to_treasury() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[9u8; 32]),
            &String::from_str(&env, "ipfs://fees"),
            &Category::Macro,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);

        let treasury = client.get_config().treasury;
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let treasury_before = token.balance(&treasury);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&treasury), treasury_before + accrued);
        assert_eq!(client.get_market(&market_id).fees_accrued, 0);
        assert_eq!(client.sweep_fees(&market_id), 0);
    }
}
