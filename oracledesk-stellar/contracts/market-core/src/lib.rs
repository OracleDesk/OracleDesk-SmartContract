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

/// The contract-wide emergency state, replacing the old `paused` boolean
/// (#20). Each entrypoint is mapped to the modes it may run in by
/// `assert_mode_allows`; the table lives in `docs/architecture.md` and is
/// locked in by the `mode_matrix_is_enforced` test.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatingMode {
    /// Everything is allowed.
    Normal,
    /// No new risk: creation and buys stop, but holders can still exit via
    /// `sell`, and resolution/settlement keeps working.
    ReduceOnly,
    /// Trading is over: only resolution, voiding and payout of what already
    /// exists is allowed. Protocol fee revenue is *not* withdrawn (`sweep_fees`
    /// is blocked), so the shared collateral balance is never reduced.
    SettleOnly,
    /// Nothing state-changing runs, except the admin moving to another mode.
    Halted,
}

/// The state-changing entrypoints, as seen by the mode matrix. Internal only:
/// deliberately not a `#[contracttype]`, so it never reaches the spec or the
/// generated bindings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Action {
    Create,
    Buy,
    Sell,
    Resolve,
    Void,
    Redeem,
    ClaimRemainder,
    /// The creator-side counterpart of `ClaimRemainder`: it pays out LP fees,
    /// i.e. user funds, so it follows the same row.
    ClaimLpFees,
    SweepFees,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub creator: Address,
    /// sha256 of the canonical question JSON stored off-chain (IPFS), so a
    /// client can prove the text it shows is the text that was committed.
    pub question_hash: BytesN<32>,
    /// Commitment to how this market will be resolved, fixed at creation so
    /// the creator cannot pick favorable resolution rules after seeing
    /// trading activity. The resolver contract verifies a revealed spec
    /// against this hash before configuring itself for the market. See
    /// `docs/adr/0001-resolution-commitment.md`.
    pub resolution_hash: BytesN<32>,
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

/// Fee destination and split, snapshotted per market at creation as a side
/// entry (`DataKey::FeeTerms`) so `Market`'s XDR shape never changes.
///
/// Markets created before this entry existed have no `FeeTerms` and keep the
/// legacy behaviour: `sweep_fees` pays whatever `DataKey::Treasury` holds at
/// sweep time, with the protocol keeping 100% of the fee. That fallback is
/// documented in `sweep_fees` and makes the upgrade migration-free.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeTerms {
    /// Where the protocol's fee share is swept. Frozen at creation: later
    /// `set_treasury` calls never redirect fees already earned.
    pub recipient: Address,
    /// Protocol's share of each trade fee in bps; the rest is the LP's.
    /// 0..=BPS. At BPS (the default) the split is exactly today's behaviour.
    pub protocol_share_bps: u32,
}

/// Per-market circuit breakers, snapshotted at creation from
/// `DataKey::DefaultBreaker`. 0 disables each check. A market without a
/// `Breaker` entry (created before breakers existed) is never checked.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BreakerConfig {
    /// Maximum |post-price - pre-price| a single trade may move in bps.
    pub max_impact_bps: u32,
    /// Maximum |post-price - ledger-open price| cumulative movement in bps.
    pub band_bps: u32,
}

/// Temporary (one ledger) band reference for a market.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BandState {
    pub ledger_seq: u32,
    pub ref_price_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub collateral: Address,
    pub treasury: Address,
    pub resolver: Address,
    pub default_fee_bps: u32,
    pub protocol_fee_share_bps: u32,
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
    ProtocolFeeShareBps,
    DefaultBreaker,
    Paused,
    NextId,
    // persistent storage (one entry each, own TTL)
    Market(u64),
    Position(u64, Address),
    FeeTerms(u64),
    LpFees(u64),
    Breaker(u64),
    // temporary storage (expires on its own, one entry per market)
    Band(u64),
    // Appended last (#20): instance keys are XDR-encoded enum discriminants,
    // so existing variants must never be reordered or inserted before them.
    // The graduated emergency state; when absent (an instance deployed
    // before #20) it is derived from `Paused`.
    Mode,
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
    /// `buy_v2` / `sell_v2` called with `env.ledger().timestamp() > deadline`.
    DeadlineExpired = 19,
    /// `buy_v2` / `sell_v2` average execution price worse than the limit.
    LimitPriceExceeded = 20,
    /// A single trade would move the price more than `max_impact_bps`.
    /// (Both this and the band reject the whole invocation, so their events,
    /// if any, roll back with it — see the note on `BreakerConfig`.)
    PriceImpactTooHigh = 21,
    /// Cumulative same-ledger movement would exceed `band_bps`.
    PriceBandExceeded = 22,
    /// The contract's `OperatingMode` forbids this entrypoint (#20). Note
    /// that `create_market` / `buy` / `sell` while `Halted` still report
    /// `Paused` (2), so clients matching on that legacy code keep working.
    ModeRestricted = 23,
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

/// Same sweep as `FeesSwept` plus the actual recipient. New event rather
/// than new fields so the existing `FeesSwept` XDR stays stable for
/// indexers; both are emitted on every sweep.
#[contractevent]
pub struct FeesSweptTo {
    #[topic]
    pub market_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
pub struct LpFeesClaimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub creator: Address,
    pub amount: i128,
}

#[contractevent]
pub struct PoolRemainderClaimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub creator: Address,
    /// Pool remainder plus any LP fees drained in the same call.
    pub payout: i128,
}

#[contractevent]
pub struct TreasuryChanged {
    pub old: Address,
    pub new: Address,
}

#[contractevent]
pub struct ProtocolFeeShareChanged {
    pub old: u32,
    pub new: u32,
}

/// Emergency-mode transition (#20). Emitted by `set_mode`, and therefore also
/// by the `set_paused` shim, which delegates to it.
#[contractevent]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModeChanged {
    pub old: OperatingMode,
    pub new: OperatingMode,
}

/// Positions moved between holders. Indexers that track balances from
/// `Trade`/`Redeemed` must also apply this event (see docs/architecture.md).
#[contractevent]
pub struct PositionTransferred {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub from: Address,
    pub to: Address,
    pub outcome: Outcome,
    pub amount: i128,
}

#[contractevent]
pub struct LpTransferred {
    #[topic]
    pub market_id: u64,
    pub from: Address,
    pub to: Address,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MarketCore;

#[contractimpl]
impl MarketCore {
    /// Runs atomically at deploy time, so nobody can front-run initialization.
    /// `protocol_fee_share_bps` is the default protocol/LP split for new
    /// markets; 10_000 keeps the whole fee with the protocol (pre-upgrade
    /// behaviour). Pass 0 to give all fees to the market creators.
    pub fn __constructor(
        env: Env,
        admin: Address,
        collateral: Address,
        treasury: Address,
        resolver: Address,
        default_fee_bps: u32,
        protocol_fee_share_bps: u32,
    ) {
        if default_fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        if protocol_fee_share_bps as i128 > BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Collateral, &collateral);
        s.set(&DataKey::Treasury, &treasury);
        s.set(&DataKey::Resolver, &resolver);
        s.set(&DataKey::DefaultFeeBps, &default_fee_bps);
        s.set(&DataKey::ProtocolFeeShareBps, &protocol_fee_share_bps);
        s.set(&DataKey::Paused, &false);
        s.set(&DataKey::Mode, &OperatingMode::Normal);
        s.set(&DataKey::NextId, &0u64);
    }

    // ----- admin ----------------------------------------------------------

    /// Legacy one-switch pause (#20 shim): `true` is `Halted`, `false` is
    /// `Normal`. Delegates to `set_mode`, so it emits `ModeChanged` too.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::set_mode(
            env,
            if paused {
                OperatingMode::Halted
            } else {
                OperatingMode::Normal
            },
        )
    }

    /// Moves the contract to `mode`, gating every state-changing entrypoint by
    /// the matrix in `docs/architecture.md`. Admin-only; emits `ModeChanged`.
    ///
    /// `Halted` blocks payouts, so it is reversible: the admin can always move
    /// to `SettleOnly` (or `Normal`) and let holders redeem — see the
    /// `halted_then_settle_only_allows_redeem` test.
    pub fn set_mode(env: Env, mode: OperatingMode) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let old: OperatingMode = Self::mode(&env)?;
        let s = env.storage().instance();
        s.extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        s.set(&DataKey::Mode, &mode);
        // Kept in sync so anything still reading the legacy boolean (an older
        // version of this contract after a downgrade, or a direct storage
        // reader) sees the same thing as `get_config().paused`.
        s.set(&DataKey::Paused, &(mode != OperatingMode::Normal));
        ModeChanged { old, new: mode }.publish(&env);
        Ok(())
    }

    /// The current emergency mode. Purely additive view (#20); treasury reads
    /// this to fail fast with its own error instead of bubbling a nested
    /// market-core code.
    pub fn get_mode(env: Env) -> Result<OperatingMode, Error> {
        Self::mode(&env)
    }

    /// Affects markets created after the call; existing markets keep their fee.
    pub fn set_default_fee_bps(env: Env, fee_bps: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        env.storage()
            .instance()
            .set(&DataKey::DefaultFeeBps, &fee_bps);
        Ok(())
    }

    pub fn set_resolver(env: Env, resolver: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Resolver, &resolver);
        Ok(())
    }

    /// Affects markets created after the call and the legacy fallback in
    /// `sweep_fees`. Markets with a snapshotted `FeeTerms` keep paying their
    /// original recipient.
    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let old: Address = Self::instance_get(&env, &DataKey::Treasury)?;
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        TreasuryChanged { old, new: treasury }.publish(&env);
        Ok(())
    }

    /// Affects markets created after the call; existing markets keep the
    /// split they snapshotted at creation.
    pub fn set_protocol_fee_share_bps(env: Env, share_bps: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if share_bps as i128 > BPS {
            return Err(Error::InvalidFee);
        }
        let old: u32 = Self::instance_get(&env, &DataKey::ProtocolFeeShareBps)?;
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeShareBps, &share_bps);
        ProtocolFeeShareChanged {
            old,
            new: share_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Sets the breaker defaults copied into markets created after the call.
    /// `band_bps < max_impact_bps` (both non-zero) is rejected: a single
    /// trade that is allowed by the impact cap could then never fit inside
    /// the band, locking trading.
    pub fn set_default_breaker(env: Env, breaker: BreakerConfig) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if breaker.max_impact_bps as i128 > BPS || breaker.band_bps as i128 > BPS {
            return Err(Error::InvalidAmount);
        }
        if breaker.max_impact_bps > 0
            && breaker.band_bps > 0
            && breaker.band_bps < breaker.max_impact_bps
        {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::DefaultBreaker, &breaker);
        Ok(())
    }

    // ----- market lifecycle -----------------------------------------------

    /// Creates a market and seeds the pool. `creator` becomes the sole LP.
    /// `initial_yes_bps` in [100, 9900] sets the opening YES probability;
    /// the creator receives the leftover shares of the likelier outcome.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
    ) -> Result<u64, Error> {
        Self::assert_mode_allows(&env, Action::Create)?;
        creator.require_auth();

        if close_time <= env.ledger().timestamp() {
            return Err(Error::InvalidCloseTime);
        }
        if !(MIN_SEED..=MAX_SETS).contains(&seed_amount) {
            return Err(Error::InvalidAmount);
        }
        if !(math::MIN_PROB_BPS..=math::MAX_PROB_BPS).contains(&initial_yes_bps) {
            return Err(Error::InvalidProbability);
        }
        let seed = math::seed_reserves(seed_amount, initial_yes_bps)?;

        let s = env.storage().instance();
        let id: u64 = s.get(&DataKey::NextId).ok_or(Error::NotInitialized)?;
        s.set(&DataKey::NextId, &(id + 1));
        let fee_bps: u32 = s
            .get(&DataKey::DefaultFeeBps)
            .ok_or(Error::NotInitialized)?;
        let protocol_share_bps: u32 = s
            .get(&DataKey::ProtocolFeeShareBps)
            .ok_or(Error::NotInitialized)?;
        let treasury: Address = s.get(&DataKey::Treasury).ok_or(Error::NotInitialized)?;
        let breaker: Option<BreakerConfig> = s.get(&DataKey::DefaultBreaker);

        let market = Market {
            creator: creator.clone(),
            question_hash,
            resolution_hash,
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
        Self::save_fee_terms(
            &env,
            id,
            &FeeTerms {
                recipient: treasury,
                protocol_share_bps,
            },
        );
        if let Some(b) = breaker {
            Self::save_breaker(&env, id, &b);
        }
        if seed.creator_yes > 0 || seed.creator_no > 0 {
            Self::save_position(
                &env,
                id,
                &creator,
                &Position {
                    yes: seed.creator_yes,
                    no: seed.creator_no,
                },
            );
        }

        Self::token(&env)?.transfer(&creator, env.current_contract_address(), &seed_amount);

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
    ///
    /// Legacy entrypoint: no deadline and no limit price, so a signed bound
    /// can execute at any later time. Prefer `buy_v2`.
    pub fn buy(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::do_buy(
            env,
            trader,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            None,
        )
    }

    /// `buy` plus a deadline (`env.ledger().timestamp()` seconds — network
    /// time, not the client clock) and an average-price limit
    /// (`limit_price_bps` per share, 1.0 = BPS; 0 = no limit).
    ///
    /// The average price includes the fee (`fee` is part of `collateral_in`)
    /// and, for a NO buy, is compared against the NO price. Because the
    /// deadline check runs before `require_auth`, an expired transaction
    /// fails cheaply. A limit above BPS can never pass for a buy and is
    /// rejected as invalid.
    #[allow(clippy::too_many_arguments)]
    pub fn buy_v2(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }
        Self::do_buy(
            env,
            trader,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            if limit_price_bps == 0 {
                None
            } else {
                Some(limit_price_bps)
            },
        )
    }

    /// Shared implementation of `buy` / `buy_v2` (single copy of the
    /// breaker, effect and interaction logic).
    #[allow(clippy::too_many_arguments)]
    fn do_buy(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: Option<u32>,
    ) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::Buy)?;
        if let Some(limit) = limit_price_bps {
            if limit as i128 > BPS {
                return Err(Error::InvalidAmount);
            }
        }
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?;
        if q.shares_out < min_shares_out {
            return Err(Error::SlippageExceeded);
        }
        if let Some(limit) = limit_price_bps {
            if !math::buy_within_limit(collateral_in, q.shares_out, limit)? {
                return Err(Error::LimitPriceExceeded);
            }
        }
        Self::check_breakers(
            &env,
            market_id,
            &m,
            outcome,
            q.new_reserve_bought,
            q.new_reserve_other,
        )?;
        let new_sets = m.sets_minted.checked_add(q.net).ok_or(Error::Overflow)?;
        if new_sets > MAX_SETS {
            return Err(Error::MarketTooLarge);
        }

        // effects
        Self::set_reserves(&mut m, outcome, q.new_reserve_bought, q.new_reserve_other);
        m.sets_minted = new_sets;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        let mut pos = Self::load_position(&env, market_id, &trader);
        match outcome {
            Outcome::Yes => pos.yes += q.shares_out,
            Outcome::No => pos.no += q.shares_out,
        }
        Self::save_position(&env, market_id, &trader, &pos);
        Self::save_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&trader, env.current_contract_address(), &collateral_in);

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
    ///
    /// Legacy entrypoint: no deadline and no limit price. Prefer `sell_v2`.
    pub fn sell(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::do_sell(
            env,
            trader,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            None,
        )
    }

    /// `sell` plus a deadline (ledger timestamp, seconds) and a minimum
    /// average execution price (`limit_price_bps` per share, 1.0 = BPS).
    ///
    /// A zero limit is trivially satisfied for sells — unlike buys, where 0
    /// means "no limit" — and a limit above BPS can never pass, so neither
    /// needs a special case. The average includes the fee, which the trader
    /// pays out of the gross.
    #[allow(clippy::too_many_arguments)]
    pub fn sell_v2(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }
        Self::do_sell(
            env,
            trader,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            if limit_price_bps == 0 {
                None
            } else {
                Some(limit_price_bps)
            },
        )
    }

    /// Shared implementation of `sell` / `sell_v2`.
    #[allow(clippy::too_many_arguments)]
    fn do_sell(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: Option<u32>,
    ) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::Sell)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_sell(r_sold, r_other, collateral_out, m.fee_bps)?;
        if q.shares_in > max_shares_in {
            return Err(Error::SlippageExceeded);
        }
        if let Some(limit) = limit_price_bps {
            if !math::sell_within_limit(collateral_out, q.shares_in, limit)? {
                return Err(Error::LimitPriceExceeded);
            }
        }
        Self::check_breakers(
            &env,
            market_id,
            &m,
            outcome,
            q.new_reserve_sold,
            q.new_reserve_other,
        )?;

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
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
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
        Self::assert_mode_allows(&env, Action::Resolve)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() < m.close_time {
            return Err(Error::NotClosedYet);
        }
        m.status = MarketStatus::Resolved(outcome);
        Self::save_market(&env, market_id, &m);
        MarketResolved {
            market_id,
            outcome: Some(outcome),
        }
        .publish(&env);
        Ok(())
    }

    /// Invalid or unresolvable market. Allowed any time before finality.
    pub fn void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        Self::assert_mode_allows(&env, Action::Void)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        m.status = MarketStatus::Void;
        Self::save_market(&env, market_id, &m);
        MarketResolved {
            market_id,
            outcome: None,
        }
        .publish(&env);
        Ok(())
    }

    // ----- settlement -----------------------------------------------------

    /// Pays out `holder`'s position for a final market and clears it.
    /// Losing positions clear with a payout of 0.
    pub fn redeem(env: Env, holder: Address, market_id: u64) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::Redeem)?;
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
        Redeemed {
            market_id,
            holder,
            payout,
        }
        .publish(&env);
        Ok(payout)
    }

    /// Creator (the LP) withdraws whatever the pool still holds once final,
    /// plus any unclaimed LP fees. Returns the total paid out.
    pub fn claim_pool_remainder(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::ClaimRemainder)?;
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let kind = Self::settlement(&m)?;
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        let pool_value = math::settle_value(kind, m.reserve_yes, m.reserve_no);
        let payout = pool_value
            .checked_add(Self::load_lp_fees(&env, market_id))
            .ok_or(Error::Overflow)?;
        Self::save_lp_fees(&env, market_id, 0);
        m.reserve_yes = 0;
        m.reserve_no = 0;
        m.lp_claimed = true;
        let creator = m.creator.clone();
        Self::save_market(&env, market_id, &m);
        if payout > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &creator, &payout);
        }
        PoolRemainderClaimed {
            market_id,
            creator,
            payout,
        }
        .publish(&env);
        Ok(payout)
    }

    /// The creator (the LP) claims their share of accrued trade fees at any
    /// time, including before finality. Returns the amount claimed (0 when
    /// nothing is pending, mirroring `sweep_fees`).
    pub fn claim_lp_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::ClaimLpFees)?;
        let m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let amount = Self::load_lp_fees(&env, market_id);
        if amount <= 0 {
            return Ok(0);
        }
        Self::save_lp_fees(&env, market_id, 0);
        Self::token(&env)?.transfer(&env.current_contract_address(), &m.creator, &amount);
        LpFeesClaimed {
            market_id,
            creator: m.creator.clone(),
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Anyone can move accrued protocol fees to the market's fee recipient.
    ///
    /// Sends to the recipient snapshotted in `FeeTerms` at creation. Markets
    /// created before `FeeTerms` existed have none and keep the legacy
    /// behaviour: the `DataKey::Treasury` of the moment of the sweep.
    pub fn sweep_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::assert_mode_allows(&env, Action::SweepFees)?;
        let mut m = Self::load_market(&env, market_id)?;
        let amount = m.fees_accrued;
        if amount <= 0 {
            return Ok(0);
        }
        m.fees_accrued = 0;
        Self::save_market(&env, market_id, &m);
        let recipient = match Self::load_fee_terms(&env, market_id) {
            Some(t) => t.recipient,
            None => Self::instance_get(&env, &DataKey::Treasury)?,
        };
        Self::token(&env)?.transfer(&env.current_contract_address(), &recipient, &amount);
        FeesSwept { market_id, amount }.publish(&env);
        FeesSweptTo {
            market_id,
            recipient,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // ----- transferability --------------------------------------------------
    // Positions and the single LP role are plain storage entries, so moving
    // them is bookkeeping only: no collateral moves, `k` is untouched, and
    // the invariant `reserve_yes + Σ pos.yes == sets_minted` holds by
    // construction. Transfers are allowed while the market is Open, Paused,
    // or final — a transfer spends no collateral, so the pause does not
    // apply. After `redeem` the position is empty and transfers fail
    // naturally with `InsufficientShares`.

    /// Moves `amount` shares of `outcome` from `from` to `to`.
    pub fn transfer_position(
        env: Env,
        from: Address,
        to: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 || from == to {
            return Err(Error::InvalidAmount);
        }
        if to == env.current_contract_address() {
            // Shares held by the contract itself could never be redeemed
            // (`redeem` requires the holder's auth), so this would burn them.
            return Err(Error::InvalidAmount);
        }
        Self::load_market(&env, market_id)?;
        let mut a = Self::load_position(&env, market_id, &from);
        let mut b = Self::load_position(&env, market_id, &to);
        match outcome {
            Outcome::Yes => {
                if a.yes < amount {
                    return Err(Error::InsufficientShares);
                }
                a.yes -= amount;
                b.yes = b.yes.checked_add(amount).ok_or(Error::Overflow)?;
            }
            Outcome::No => {
                if a.no < amount {
                    return Err(Error::InsufficientShares);
                }
                a.no -= amount;
                b.no = b.no.checked_add(amount).ok_or(Error::Overflow)?;
            }
        }
        Self::save_position(&env, market_id, &from, &a);
        Self::save_position(&env, market_id, &to, &b);
        PositionTransferred {
            market_id,
            from,
            to,
            outcome,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Transfers the single LP role (the right to `claim_pool_remainder` and
    /// `claim_lp_fees`) to `new_creator`. Only until the remainder has been
    /// claimed; after that the role has no remaining value.
    pub fn transfer_lp(env: Env, market_id: u64, new_creator: Address) -> Result<(), Error> {
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        if new_creator == m.creator || new_creator == env.current_contract_address() {
            return Err(Error::InvalidAmount);
        }
        let from = m.creator.clone();
        m.creator = new_creator.clone();
        Self::save_market(&env, market_id, &m);
        LpTransferred {
            market_id,
            from,
            to: new_creator,
        }
        .publish(&env);
        Ok(())
    }

    // ----- views ----------------------------------------------------------

    pub fn get_config(env: Env) -> Result<Config, Error> {
        Ok(Config {
            admin: Self::instance_get(&env, &DataKey::Admin)?,
            collateral: Self::instance_get(&env, &DataKey::Collateral)?,
            treasury: Self::instance_get(&env, &DataKey::Treasury)?,
            resolver: Self::instance_get(&env, &DataKey::Resolver)?,
            default_fee_bps: Self::instance_get(&env, &DataKey::DefaultFeeBps)?,
            protocol_fee_share_bps: Self::instance_get(&env, &DataKey::ProtocolFeeShareBps)?,
            // Compatibility shim (#20): the `Config` shape is unchanged, so
            // bindings and the vendored decoders keep working. Any non-Normal
            // mode reads as "paused". Use `get_mode` for the real state.
            paused: Self::mode(&env)? != OperatingMode::Normal,
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

    /// The market's snapshotted breakers (`None` for legacy markets created
    /// before breakers existed — those are never checked).
    pub fn breaker_config(env: Env, market_id: u64) -> Result<Option<BreakerConfig>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_breaker(&env, market_id))
    }

    /// The current ledger's band reference, if a band check has run this
    /// ledger. `None` means the next trade sets the reference (to its own
    /// pre-trade price, which equals the ledger-open price).
    pub fn breaker_state(env: Env, market_id: u64) -> Result<Option<BandState>, Error> {
        Self::load_market(&env, market_id)?;
        let state = env
            .storage()
            .temporary()
            .get::<_, BandState>(&DataKey::Band(market_id));
        Ok(match state {
            Some(s) if s.ledger_seq == env.ledger().sequence() => Some(s),
            _ => None,
        })
    }

    /// True when a `buy` of `collateral_in` would be rejected by the
    /// market's breakers right now. Read-only: never writes band state, so
    /// on a fresh ledger the reference is taken as the current price — the
    /// same value a subsequent real trade would use.
    pub fn would_trip(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
    ) -> Result<bool, Error> {
        let m = Self::load_market(&env, market_id)?;
        let cfg = match Self::load_breaker(&env, market_id) {
            Some(c) => c,
            None => return Ok(false),
        };
        if cfg.max_impact_bps == 0 && cfg.band_bps == 0 {
            return Ok(false);
        }
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?;
        let pre = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let post = math::price_after(
            matches!(outcome, Outcome::Yes),
            q.new_reserve_bought,
            q.new_reserve_other,
        )?;
        if cfg.max_impact_bps > 0 && (post - pre).abs() > cfg.max_impact_bps as i128 {
            return Ok(true);
        }
        if cfg.band_bps > 0 {
            let reference = env
                .storage()
                .temporary()
                .get::<_, BandState>(&DataKey::Band(market_id))
                .filter(|s| s.ledger_seq == env.ledger().sequence())
                .map(|s| s.ref_price_bps)
                .unwrap_or(pre as u32);
            if (post - reference as i128).abs() > cfg.band_bps as i128 {
                return Ok(true);
            }
        }
        Ok(false)
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
        env.storage()
            .instance()
            .get(key)
            .ok_or(Error::NotInitialized)
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

    /// The active emergency mode (#20). An instance deployed before `Mode`
    /// existed has no such key, so it is derived from the legacy boolean;
    /// every write path (`__constructor`, `set_mode`) keeps both in sync.
    fn mode(env: &Env) -> Result<OperatingMode, Error> {
        let s = env.storage().instance();
        s.extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        if let Some(mode) = s.get::<_, OperatingMode>(&DataKey::Mode) {
            return Ok(mode);
        }
        let paused: bool = s.get(&DataKey::Paused).ok_or(Error::NotInitialized)?;
        Ok(if paused {
            OperatingMode::Halted
        } else {
            OperatingMode::Normal
        })
    }

    /// The single gate every state-changing entrypoint goes through (#20).
    ///
    /// ```text
    /// | Action                          | Normal | ReduceOnly | SettleOnly | Halted |
    /// |---------------------------------|--------|------------|------------|--------|
    /// | create_market, buy / buy_v2     |   yes  |     no     |     no     |   no   |
    /// | sell / sell_v2                  |   yes  |    yes     |     no     |   no   |
    /// | resolve, void_market            |   yes  |    yes     |     yes    |   no   |
    /// | redeem, claim_pool_remainder,   |   yes  |    yes     |     yes    |   no   |
    /// |   claim_lp_fees                 |        |            |            |        |
    /// | sweep_fees                      |   yes  |     no     |     no     |   no   |
    /// ```
    ///
    /// Rationale: `ReduceOnly` stops *new* risk while a pricing bug is fixed,
    /// so holders can still exit; `SettleOnly` stops every trade so a
    /// suspected accounting bug cannot be traded against, but keeps
    /// resolution and payouts alive; `sweep_fees` is the first thing to stop
    /// because it moves protocol revenue (not user funds) out of the single
    /// shared balance, and `void_market` is blocked in `Halted` so the
    /// operator always performs one explicit step before a terminal change.
    /// `transfer_position` / `transfer_lp` are deliberately *not* gated: they
    /// move no collateral, so they stay available in every mode exactly as
    /// they stayed available while `paused`.
    ///
    /// Compatibility: `create_market`, `buy`/`buy_v2` and `sell`/`sell_v2`
    /// still report `Error::Paused` (2) when the contract is `Halted`, so
    /// clients that match on that legacy code keep working. Every other
    /// rejection reports `Error::ModeRestricted` (23).
    fn assert_mode_allows(env: &Env, action: Action) -> Result<(), Error> {
        let mode = Self::mode(env)?;
        let allowed = match (mode, action) {
            (OperatingMode::Normal, _) => true,
            (OperatingMode::ReduceOnly, Action::Create | Action::Buy | Action::SweepFees) => false,
            (OperatingMode::ReduceOnly, _) => true,
            (
                OperatingMode::SettleOnly,
                Action::Create | Action::Buy | Action::Sell | Action::SweepFees,
            ) => false,
            (OperatingMode::SettleOnly, _) => true,
            (OperatingMode::Halted, _) => false,
        };
        if allowed {
            return Ok(());
        }
        if mode == OperatingMode::Halted
            && matches!(action, Action::Create | Action::Buy | Action::Sell)
        {
            return Err(Error::Paused);
        }
        Err(Error::ModeRestricted)
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
        let m: Market = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(m)
    }

    fn save_market(env: &Env, id: u64, m: &Market) {
        let key = DataKey::Market(id);
        env.storage().persistent().set(&key, m);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_position(env: &Env, id: u64, holder: &Address) -> Position {
        let key = DataKey::Position(id, holder.clone());
        match env.storage().persistent().get::<_, Position>(&key) {
            Some(p) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    fn load_fee_terms(env: &Env, id: u64) -> Option<FeeTerms> {
        let key = DataKey::FeeTerms(id);
        let terms = env.storage().persistent().get(&key);
        if terms.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        terms
    }

    fn save_fee_terms(env: &Env, id: u64, terms: &FeeTerms) {
        let key = DataKey::FeeTerms(id);
        env.storage().persistent().set(&key, terms);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_lp_fees(env: &Env, id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LpFees(id))
            .unwrap_or(0)
    }

    /// Removing the entry at zero keeps storage from growing with dust.
    fn save_lp_fees(env: &Env, id: u64, amount: i128) {
        let key = DataKey::LpFees(id);
        if amount <= 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &amount);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    /// Splits a trade `fee` per the market's snapshotted `FeeTerms` (legacy
    /// markets: everything to the protocol), records the LP portion under
    /// `LpFees(id)` and returns the protocol portion for `fees_accrued`.
    /// Must be called once per trade, never recomputed later.
    fn accrue_fees(env: &Env, id: u64, fee: i128) -> Result<i128, Error> {
        let (protocol, lp) = match Self::load_fee_terms(env, id) {
            Some(t) => math::split_fee(fee, t.protocol_share_bps)?,
            None => (fee, 0),
        };
        if lp > 0 {
            let current = Self::load_lp_fees(env, id);
            Self::save_lp_fees(env, id, current.checked_add(lp).ok_or(Error::Overflow)?);
        }
        Ok(protocol)
    }

    fn load_breaker(env: &Env, id: u64) -> Option<BreakerConfig> {
        let key = DataKey::Breaker(id);
        let cfg: Option<BreakerConfig> = env.storage().persistent().get(&key);
        if cfg.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        cfg
    }

    fn save_breaker(env: &Env, id: u64, cfg: &BreakerConfig) {
        let key = DataKey::Breaker(id);
        env.storage().persistent().set(&key, cfg);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// Runs the market's snapshotted breakers against a quote's
    /// outcome-relative post-trade reserves. Absent entry (legacy market) or
    /// an all-zero config means no checks.
    ///
    /// Both failures abort the whole invocation, so any event describing the
    /// trip would be rolled back with it — this contract therefore emits
    /// **no** breaker event. The error code (`PriceImpactTooHigh` /
    /// `PriceBandExceeded`) in the transaction result, and the
    /// `would_trip` / `breaker_state` views, are the observability path.
    fn check_breakers(
        env: &Env,
        id: u64,
        m: &Market,
        outcome: Outcome,
        new_outcome_reserve: i128,
        new_other_reserve: i128,
    ) -> Result<(), Error> {
        let cfg = match Self::load_breaker(env, id) {
            Some(c) => c,
            None => return Ok(()),
        };
        if cfg.max_impact_bps == 0 && cfg.band_bps == 0 {
            return Ok(());
        }
        let pre = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let post = math::price_after(
            matches!(outcome, Outcome::Yes),
            new_outcome_reserve,
            new_other_reserve,
        )?;
        // `>`, not `>=`: a trade that moves exactly max_impact_bps passes.
        if cfg.max_impact_bps > 0 && (post - pre).abs() > cfg.max_impact_bps as i128 {
            return Err(Error::PriceImpactTooHigh);
        }
        if cfg.band_bps > 0 {
            let reference = Self::band_ref(env, id, pre);
            if (post - reference as i128).abs() > cfg.band_bps as i128 {
                return Err(Error::PriceBandExceeded);
            }
        }
        Ok(())
    }

    /// The band reference for the current ledger: the price at the ledger's
    /// first trade (== the ledger-open price, because no trade earlier this
    /// ledger succeeded), written to short-TTL temporary storage. A missing
    /// or stale entry means "new ledger", which is safe: the reference
    /// becomes the current price.
    fn band_ref(env: &Env, id: u64, pre_price: i128) -> u32 {
        let key = DataKey::Band(id);
        let seq = env.ledger().sequence();
        if let Some(state) = env.storage().temporary().get::<_, BandState>(&key) {
            if state.ledger_seq == seq {
                return state.ref_price_bps;
            }
        }
        let reference = pre_price as u32;
        env.storage().temporary().set(
            &key,
            &BandState {
                ledger_seq: seq,
                ref_price_bps: reference,
            },
        );
        env.storage().temporary().extend_ttl(&key, 1, 16);
        reference
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        IntoVal,
    };

    fn setup_market() -> (
        Env,
        MarketCoreClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        setup_market_full(10_000u32, None)
    }

    fn setup_market_full(
        protocol_share_bps: u32,
        breaker: Option<BreakerConfig>,
    ) -> (
        Env,
        MarketCoreClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
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
                &protocol_share_bps,
            ),
        );
        let client = MarketCoreClient::new(&env, &contract_id);
        if let Some(b) = breaker {
            client.set_default_breaker(&b);
        }

        (env, client, creator, trader, resolver, collateral.address())
    }

    /// One 100 USDC market seeded at the given opening probability.
    fn new_market(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        initial_yes_bps: u32,
    ) -> u64 {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[42u8; 32]),
            &BytesN::from_array(env, &[142u8; 32]),
            &String::from_str(env, "ipfs://test-market"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &initial_yes_bps,
        )
    }

    fn lp_fees_stored(env: &Env, client: &MarketCoreClient, market_id: u64) -> i128 {
        let contract = client.address.clone();
        env.as_contract(&contract, || {
            env.storage()
                .persistent()
                .get::<DataKey, i128>(&DataKey::LpFees(market_id))
                .unwrap_or(0)
        })
    }

    fn remove_side_entry(env: &Env, client: &MarketCoreClient, key: DataKey) {
        let contract = client.address.clone();
        env.as_contract(&contract, || {
            env.storage().persistent().remove(&key);
        });
    }

    #[test]
    fn create_market_sets_initial_price() {
        let (env, client, creator, _, _, _) = setup_market();
        let question_hash = BytesN::from_array(&env, &[1u8; 32]);
        let resolution_hash = BytesN::from_array(&env, &[101u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-1");

        let market_id = client.create_market(
            &creator,
            &question_hash,
            &resolution_hash,
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
        let resolution_hash = BytesN::from_array(&env, &[102u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-2");
        let market_id = client.create_market(
            &creator,
            &question_hash,
            &resolution_hash,
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
            &BytesN::from_array(&env, &[103u8; 32]),
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
            &BytesN::from_array(&env, &[104u8; 32]),
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
            &BytesN::from_array(&env, &[105u8; 32]),
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
            &(10_000_000_i128),
            &client.quote_sell(&market_id, &Outcome::Yes, &(10_000_000_i128)),
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
            &BytesN::from_array(&env, &[106u8; 32]),
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

        let required = client.quote_sell(&market_id, &Outcome::Yes, &(10_000_000_i128));
        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10_000_000_i128),
            &(required - 1),
        );
    }

    #[test]
    fn void_market_allows_creator_to_claim_pool_remainder() {
        let (env, client, creator, _, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[7u8; 32]),
            &BytesN::from_array(&env, &[107u8; 32]),
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
            &BytesN::from_array(&env, &[108u8; 32]),
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
            &BytesN::from_array(&env, &[109u8; 32]),
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

    #[test]
    fn create_market_commits_to_resolution_hash() {
        let (env, client, creator, _, _, _) = setup_market();
        let resolution_hash = BytesN::from_array(&env, &[200u8; 32]);
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[10u8; 32]),
            &resolution_hash,
            &String::from_str(&env, "ipfs://commitment"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        assert_eq!(
            client.get_market(&market_id).resolution_hash,
            resolution_hash
        );
    }

    #[test]
    fn wrong_caller_cannot_use_admin_functions() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_paused",
                    args: (true,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_paused(&true)
            .is_err());
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_fee_bps",
                    args: (200u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_fee_bps(&200u32)
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_resolve_market() {
        let (env, client, creator, _, _, _) = setup_market();
        let not_resolver = Address::generate(&env);
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[11u8; 32]),
            &BytesN::from_array(&env, &[111u8; 32]),
            &String::from_str(&env, "ipfs://wrong-resolver"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_resolver,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "resolve",
                    args: (market_id, Outcome::Yes).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_resolve(&market_id, &Outcome::Yes)
            .is_err());
    }

    // ----- #8: fee recipient snapshot + protocol/LP fee split ---------------

    #[test]
    fn fee_recipient_snapshotted_at_creation() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let original_treasury = client.get_config().treasury;

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);

        // Changing the contract-wide treasury must not redirect fees the
        // market already committed to the treasury of creation time.
        let replacement = Address::generate(&env);
        client.set_treasury(&replacement);

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&original_treasury);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&original_treasury), before + accrued);
        assert_eq!(token.balance(&replacement), 0);
    }

    #[test]
    fn lp_fees_accrue_and_claimable_before_finality() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // 1% of 10 USDC, split 50/50.
        assert_eq!(client.get_market(&market_id).fees_accrued, 500_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 500_000);

        // LP fees are claimable before finality — unlike the pool remainder.
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        assert_eq!(client.claim_lp_fees(&market_id), 500_000);
        assert_eq!(token.balance(&creator), before + 500_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);
        assert_eq!(client.claim_lp_fees(&market_id), 0);
    }

    #[test]
    fn claim_pool_remainder_includes_lp_fees() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let lp_fees = lp_fees_stored(&env, &client, market_id);
        assert!(lp_fees > 0);

        client.void_market(&market_id);
        let m = client.get_market(&market_id);
        let expected_pool = (m.reserve_yes + m.reserve_no) / 2; // void pays half

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        let payout = client.claim_pool_remainder(&market_id);
        assert_eq!(payout, expected_pool + lp_fees);
        assert_eq!(token.balance(&creator), before + payout);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);
    }

    #[test]
    fn protocol_plus_lp_equals_total_fee() {
        let (env, client, creator, trader, _, _) = setup_market_full(3333, None);
        let market_id = new_market(&env, &client, &creator, 5000);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // Fee is exactly 1_000_000; split 3333/6667 rounds the protocol's
        // ceil so the two parts always sum to the fee.
        let accrued = client.get_market(&market_id).fees_accrued;
        let lp = lp_fees_stored(&env, &client, market_id);
        assert_eq!(accrued, 333_300);
        assert_eq!(lp, 666_700);
        assert_eq!(accrued + lp, 1_000_000);
    }

    #[test]
    fn legacy_market_without_fee_terms_uses_current_treasury() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        // Simulate a market created before FeeTerms existed.
        remove_side_entry(&env, &client, DataKey::FeeTerms(market_id));

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);
        // No terms: the whole fee stays on the protocol side.
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);

        let replacement = Address::generate(&env);
        client.set_treasury(&replacement);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&replacement);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&replacement), before + accrued);
    }

    #[test]
    fn wrong_caller_cannot_set_protocol_fee_share() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_protocol_fee_share_bps",
                    args: (2500u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_protocol_fee_share_bps(&2500u32)
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_claim_lp_fees() {
        let (env, client, creator, trader, _, _) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert!(lp_fees_stored(&env, &client, market_id) > 0);

        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "claim_lp_fees",
                    args: (market_id,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_lp_fees(&market_id)
            .is_err());
    }

    #[test]
    fn set_treasury_and_split_change_emit_events() {
        let (env, client, _, _, _, _) = setup_market();
        // `env.events().all()` reports the last invocation's events only, so
        // each setter must publish exactly one event in its own invocation.
        client.set_treasury(&Address::generate(&env));
        assert_eq!(env.events().all().events().len(), 1);
        client.set_protocol_fee_share_bps(&2500u32);
        assert_eq!(env.events().all().events().len(), 1);
        assert_eq!(client.get_config().protocol_fee_share_bps, 2500);
        assert_eq!(
            client.try_set_protocol_fee_share_bps(&10_001u32),
            Err(Ok(Error::InvalidFee))
        );
    }

    // ----- #10: price-impact and per-ledger price-band breakers -------------

    /// Measures how many bps a 10 USDC YES buy moves the YES price on a
    /// fresh 100 USDC market — exactly the impact a breaker must allow.
    fn measure_impact_10_usdc(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        trader: &Address,
    ) -> u32 {
        let market_id = new_market(env, client, creator, 5000);
        let before = client.get_price(&market_id, &Outcome::Yes);
        client.buy(
            trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.get_price(&market_id, &Outcome::Yes) - before
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #21)")]
    fn impact_cap_rejects_large_buy() {
        let (env, client, creator, trader, _, _) = setup_market();
        let impact = measure_impact_10_usdc(&env, &client, &creator, &trader);
        assert!(impact > 0);
        client.set_default_breaker(&BreakerConfig {
            max_impact_bps: impact - 1,
            band_bps: 0,
        });
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn impact_cap_allows_exact_bound() {
        let (env, client, creator, trader, _, _) = setup_market();
        let impact = measure_impact_10_usdc(&env, &client, &creator, &trader);
        client.set_default_breaker(&BreakerConfig {
            max_impact_bps: impact,
            band_bps: 0,
        });
        let market_id = new_market(&env, &client, &creator, 5000);
        // A trade that moves exactly max_impact_bps passes.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(client.get_price(&market_id, &Outcome::Yes), 5000 + impact);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_cumulative_moves_within_ledger() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // First trade: ~470 bps from the ledger-open reference, inside band.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        // Second trade moves ~420 bps on its own — each trade individually
        // fits the band, but the cumulative move from the ledger's first
        // price (~890 bps) does not.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn band_resets_next_ledger() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        assert_eq!(client.breaker_state(&market_id), None);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let first_ledger_price = client.get_price(&market_id, &Outcome::Yes);
        assert_eq!(
            client.breaker_state(&market_id),
            Some(BandState {
                ledger_seq: env.ledger().sequence(),
                ref_price_bps: 5000,
            })
        );

        // On the next ledger the band re-anchors to the current price, so the
        // same second buy that trips within one ledger now passes.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 1);
        assert_eq!(client.breaker_state(&market_id), None);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(
            client.breaker_state(&market_id),
            Some(BandState {
                ledger_seq: env.ledger().sequence(),
                ref_price_bps: first_ledger_price,
            })
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_downward_sell() {
        let (env, client, creator, _, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        // Seeded at 68%: the creator holds the leftover YES shares and can
        // sell enough to move the price down far more than the band.
        let market_id = new_market(&env, &client, &creator, 6800);
        client.sell(
            &creator,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &i128::MAX,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_no_side_buy() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // Buying NO moves YES's price down, so the band must trip on the
        // absolute move regardless of which outcome is bought.
        client.buy(
            &trader,
            &market_id,
            &Outcome::No,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn breaker_disabled_when_zero() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // The snapshot exists but an all-zero config disables all checks.
        assert_eq!(
            client.breaker_config(&market_id),
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 0,
            })
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn legacy_market_without_breaker_unaffected() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // Simulate a market created before breakers existed: no snapshot, so
        // even trades that would trip the default are allowed.
        remove_side_entry(&env, &client, DataKey::Breaker(market_id));
        assert_eq!(client.breaker_config(&market_id), None);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn set_default_breaker_rejects_invalid_configs() {
        let (_env, client, _, _, _, _) = setup_market();
        // A band narrower than the impact cap could lock trading.
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 200,
                band_bps: 100,
            }),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 10_001,
                band_bps: 0,
            }),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 100,
                band_bps: 100,
            }),
            Ok(Ok(()))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
            Ok(Ok(()))
        );
    }

    #[test]
    fn wrong_caller_cannot_set_default_breaker() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_breaker",
                    args: (BreakerConfig {
                        max_impact_bps: 100,
                        band_bps: 0,
                    },)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            })
            .is_err());
    }

    #[test]
    fn would_trip_previews_impact_cap() {
        let (env, client, creator, _, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        assert!(client.would_trip(&market_id, &Outcome::Yes, &(20 * 10_000_000_i128)));
        assert!(!client.would_trip(&market_id, &Outcome::Yes, &(1_000_000_i128)));
        // Read-only: previewing writes no band state.
        assert_eq!(client.breaker_state(&market_id), None);
    }

    // ----- #12: deadlines and limit prices ----------------------------------

    #[test]
    #[should_panic(expected = "Error(Contract, #19)")]
    fn buy_v2_rejects_after_deadline() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        env.ledger().set_timestamp(1_000);
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &0u32,
            &999u64,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #20)")]
    fn buy_v2_rejects_worse_than_limit() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let deadline = env.ledger().timestamp();
        // Average fill price incl. fee is ~5289 bps; limit 5000 must reject.
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &5000u32,
            &deadline,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #20)")]
    fn sell_v2_rejects_below_limit() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let deadline = env.ledger().timestamp();
        let max_shares = client.quote_sell(&market_id, &Outcome::Yes, &(5 * 10_000_000_i128));
        // Average execution price is ~5302 bps; limit 6000 must reject.
        client.sell_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &max_shares,
            &6000u32,
            &deadline,
        );
    }

    #[test]
    fn buy_v2_matches_buy_when_unbounded() {
        let (env, client, creator, trader, _, _) = setup_market();
        let v2_market = new_market(&env, &client, &creator, 5000);
        let legacy_market = new_market(&env, &client, &creator, 5000);
        // deadline == now passes (only a strictly later timestamp expires),
        // and limit 0 disables the price bound.
        let deadline = env.ledger().timestamp();

        let shares_v2 = client.buy_v2(
            &trader,
            &v2_market,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &0u32,
            &deadline,
        );
        let shares_legacy = client.buy(
            &trader,
            &legacy_market,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(shares_v2, shares_legacy);
        assert_eq!(
            client.get_price(&v2_market, &Outcome::Yes),
            client.get_price(&legacy_market, &Outcome::Yes)
        );

        let out = 5 * 10_000_000_i128;
        let max_v2 = client.quote_sell(&v2_market, &Outcome::Yes, &out);
        let max_legacy = client.quote_sell(&legacy_market, &Outcome::Yes, &out);
        let sold_v2 = client.sell_v2(
            &trader,
            &v2_market,
            &Outcome::Yes,
            &out,
            &max_v2,
            &0u32,
            &deadline,
        );
        let sold_legacy = client.sell(&trader, &legacy_market, &Outcome::Yes, &out, &max_legacy);
        assert_eq!(sold_v2, sold_legacy);
        assert_eq!(
            client.get_price(&v2_market, &Outcome::Yes),
            client.get_price(&legacy_market, &Outcome::Yes)
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn buy_v2_rejects_limit_above_bps() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let deadline = env.ledger().timestamp();
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &20_000u32,
            &deadline,
        );
    }

    // ----- #13: transferable positions and LP role --------------------------

    #[test]
    fn transfer_position_moves_shares_and_preserves_invariant() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let receiver = Address::generate(&env);
        let moved = 100_000_000_i128;
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &moved);

        let a = client.get_position(&market_id, &trader);
        let b = client.get_position(&market_id, &receiver);
        assert_eq!(b.yes, moved);
        let m = client.get_market(&market_id);
        // reserve_yes + Σ positions == sets_minted, always.
        assert_eq!(m.reserve_yes + a.yes + b.yes, m.sets_minted);

        // Transfers spend no collateral, so the pause does not block them.
        client.set_paused(&true);
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &1_i128);
        assert_eq!(client.get_position(&market_id, &receiver).yes, moved + 1);
    }

    #[test]
    fn transfer_position_removes_empty_entry() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let held = client.get_position(&market_id, &trader).yes;

        let receiver = Address::generate(&env);
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &held);
        assert_eq!(
            client.get_position(&market_id, &trader),
            Position { yes: 0, no: 0 }
        );

        let contract = client.address.clone();
        let raw = env.as_contract(&contract, || {
            env.storage()
                .persistent()
                .get::<DataKey, Position>(&DataKey::Position(market_id, trader.clone()))
        });
        assert_eq!(raw, None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn transfer_position_rejects_insufficient_shares() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let held = client.get_position(&market_id, &trader).yes;
        client.transfer_position(
            &trader,
            &Address::generate(&env),
            &market_id,
            &Outcome::Yes,
            &(held + 1),
        );
    }

    #[test]
    fn transfer_position_rejects_invalid_destinations() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let receiver = Address::generate(&env);
        assert_eq!(
            client.try_transfer_position(&trader, &trader, &market_id, &Outcome::Yes, &1_i128),
            Err(Ok(Error::InvalidAmount))
        );
        // The contract address would burn the shares: redeem needs the
        // holder's auth, so shares held by the contract are unreachable.
        assert_eq!(
            client.try_transfer_position(
                &trader,
                &client.address,
                &market_id,
                &Outcome::Yes,
                &1_i128
            ),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &0_i128),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn wrong_caller_cannot_transfer_position() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "transfer_position",
                    args: (
                        trader.clone(),
                        attacker.clone(),
                        market_id,
                        Outcome::Yes,
                        1_i128
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_transfer_position(&trader, &attacker, &market_id, &Outcome::Yes, &1_i128)
            .is_err());
    }

    #[test]
    fn transfer_lp_then_new_creator_claims() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.void_market(&market_id);

        let successor = Address::generate(&env);
        client.transfer_lp(&market_id, &successor);
        assert_eq!(client.get_market(&market_id).creator, successor);

        let m = client.get_market(&market_id);
        let expected_pool = (m.reserve_yes + m.reserve_no) / 2;
        let lp_fees = lp_fees_stored(&env, &client, market_id);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&successor);
        let payout = client.claim_pool_remainder(&market_id);
        assert_eq!(payout, expected_pool + lp_fees);
        assert_eq!(token.balance(&successor), before + payout);
    }

    #[test]
    fn wrong_caller_cannot_transfer_lp() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "transfer_lp",
                    args: (market_id, attacker.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_transfer_lp(&market_id, &attacker)
            .is_err());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn transfer_lp_rejected_after_claim() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.void_market(&market_id);
        client.claim_pool_remainder(&market_id);
        client.transfer_lp(&market_id, &Address::generate(&env));
    }

    // ----- #20: graduated emergency modes ---------------------------------

    const ALL_MODES: [OperatingMode; 4] = [
        OperatingMode::Normal,
        OperatingMode::ReduceOnly,
        OperatingMode::SettleOnly,
        OperatingMode::Halted,
    ];
    const ALL_ACTIONS: [Action; 9] = [
        Action::Create,
        Action::Buy,
        Action::Sell,
        Action::Resolve,
        Action::Void,
        Action::Redeem,
        Action::ClaimRemainder,
        Action::ClaimLpFees,
        Action::SweepFees,
    ];

    /// The matrix of `docs/architecture.md`, written independently of
    /// `assert_mode_allows` so the table test is a real check and not a mirror
    /// of the implementation.
    fn mode_allows(mode: OperatingMode, action: Action) -> bool {
        match action {
            Action::Create | Action::Buy | Action::SweepFees => mode == OperatingMode::Normal,
            Action::Sell => matches!(mode, OperatingMode::Normal | OperatingMode::ReduceOnly),
            Action::Resolve
            | Action::Void
            | Action::Redeem
            | Action::ClaimRemainder
            | Action::ClaimLpFees => mode != OperatingMode::Halted,
        }
    }

    /// The error a rejected cell must report: the three trading entrypoints
    /// keep the legacy `Paused` (2) code while `Halted`, everything new uses
    /// `ModeRestricted` (23).
    fn expected_rejection(mode: OperatingMode, action: Action) -> Error {
        if mode == OperatingMode::Halted
            && matches!(action, Action::Create | Action::Buy | Action::Sell)
        {
            Error::Paused
        } else {
            Error::ModeRestricted
        }
    }

    /// A fresh fixture with the market in the lifecycle state `action` needs,
    /// so the only thing that can reject the attempt is the mode. Prepared in
    /// `Normal` (preparation is never what the test is about); the caller
    /// switches the mode afterwards. `setup_market_full(5_000, ..)` splits fees
    /// 50/50 so both `sweep_fees` and `claim_lp_fees` have real balances.
    fn prepare_for_action(
        action: Action,
    ) -> (Env, MarketCoreClient<'static>, Address, Address, u64) {
        let (env, client, creator, trader, _, _) = setup_market_full(5_000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        let close = client.get_market(&market_id).close_time;
        match action {
            Action::Create | Action::Buy | Action::Void => {}
            Action::Sell | Action::SweepFees | Action::ClaimLpFees => {
                client.buy(
                    &trader,
                    &market_id,
                    &Outcome::Yes,
                    &(10 * 10_000_000_i128),
                    &0_i128,
                );
            }
            Action::Resolve => {
                env.ledger().set_timestamp(close + 1);
            }
            Action::Redeem => {
                client.buy(
                    &trader,
                    &market_id,
                    &Outcome::Yes,
                    &(10 * 10_000_000_i128),
                    &0_i128,
                );
                env.ledger().set_timestamp(close + 1);
                client.resolve(&market_id, &Outcome::Yes);
            }
            Action::ClaimRemainder => {
                env.ledger().set_timestamp(close + 1);
                client.resolve(&market_id, &Outcome::Yes);
            }
        }
        (env, client, creator, trader, market_id)
    }

    /// Invokes `action` on the contract and reports the outcome as the
    /// contract sees it: `Ok(())` when the entrypoint ran, `Err(Error)` when
    /// it rejected the call. Uses `Env::try_invoke_contract` rather than the
    /// generated `try_` client methods so the contract error is decoded
    /// uniformly for entrypoints with different return types.
    fn attempt(
        env: &Env,
        contract: &Address,
        creator: &Address,
        trader: &Address,
        market_id: u64,
        action: Action,
    ) -> Result<(), Error> {
        let usdc = |n: i128| n * 10_000_000_i128;
        let close_time = env.ledger().timestamp() + 60_000;
        let args: soroban_sdk::Vec<soroban_sdk::Val> = match action {
            Action::Create => (
                creator,
                BytesN::from_array(env, &[7u8; 32]),
                BytesN::from_array(env, &[70u8; 32]),
                String::from_str(env, "ipfs://matrix-cell"),
                Category::Crypto,
                close_time,
                usdc(100),
                5000u32,
            )
                .into_val(env),
            Action::Buy => (trader, market_id, Outcome::Yes, usdc(10), 0_i128).into_val(env),
            Action::Sell => (trader, market_id, Outcome::Yes, usdc(1), i128::MAX).into_val(env),
            Action::Resolve => (market_id, Outcome::Yes).into_val(env),
            Action::Void => (market_id,).into_val(env),
            Action::Redeem => (trader, market_id).into_val(env),
            Action::ClaimRemainder => (market_id,).into_val(env),
            Action::ClaimLpFees => (market_id,).into_val(env),
            Action::SweepFees => (market_id,).into_val(env),
        };
        let name = soroban_sdk::Symbol::new(
            env,
            match action {
                Action::Create => "create_market",
                Action::Buy => "buy",
                Action::Sell => "sell",
                Action::Resolve => "resolve",
                Action::Void => "void_market",
                Action::Redeem => "redeem",
                Action::ClaimRemainder => "claim_pool_remainder",
                Action::ClaimLpFees => "claim_lp_fees",
                Action::SweepFees => "sweep_fees",
            },
        );
        let call: Result<
            Result<(), soroban_sdk::ConversionError>,
            Result<Error, soroban_sdk::InvokeError>,
        > = env.try_invoke_contract::<(), Error>(contract, &name, args);
        match call {
            Ok(_) => Ok(()),
            Err(Ok(e)) => Err(e),
            Err(Err(e)) => panic!("host-level error instead of a contract error: {e:?}"),
        }
    }

    /// Every mode × action cell of the documented matrix, both directions.
    #[test]
    fn mode_matrix_is_enforced() {
        let mut cells = 0u32;
        for mode in ALL_MODES {
            for action in ALL_ACTIONS {
                cells += 1;
                let (env, client, creator, trader, market_id) = prepare_for_action(action);
                client.set_mode(&mode);
                assert_eq!(client.get_mode(), mode);

                let result = attempt(&env, &client.address, &creator, &trader, market_id, action);
                if mode_allows(mode, action) {
                    assert!(
                        result.is_ok(),
                        "{mode:?} must allow {action:?}, got {result:?}"
                    );
                } else {
                    assert_eq!(
                        result,
                        Err(expected_rejection(mode, action)),
                        "{mode:?} must reject {action:?} with the documented code"
                    );
                }
            }
        }
        assert_eq!(cells, 4 * 9, "the matrix test must stay exhaustive");
    }

    #[test]
    fn set_paused_shim_maps_to_halted_and_normal() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);

        client.set_paused(&true);
        assert_eq!(client.get_mode(), OperatingMode::Halted);
        assert_eq!(
            client.try_buy(&trader, &market_id, &Outcome::Yes, &1_000_000_i128, &0_i128),
            Err(Ok(Error::Paused))
        );
        assert_eq!(
            client.try_create_market(
                &creator,
                &BytesN::from_array(&env, &[20u8; 32]),
                &BytesN::from_array(&env, &[120u8; 32]),
                &String::from_str(&env, "ipfs://halted"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &(100 * 10_000_000_i128),
                &5000u32
            ),
            Err(Ok(Error::Paused))
        );

        client.set_paused(&false);
        assert_eq!(client.get_mode(), OperatingMode::Normal);
        assert!(client
            .try_buy(
                &trader,
                &market_id,
                &Outcome::Yes,
                &(10 * 10_000_000_i128),
                &0_i128
            )
            .is_ok());
    }

    #[test]
    fn get_config_paused_reflects_mode() {
        let (env, client, creator, _, _, _) = setup_market();
        new_market(&env, &client, &creator, 5000);
        assert!(!client.get_config().paused);

        for mode in [
            OperatingMode::ReduceOnly,
            OperatingMode::SettleOnly,
            OperatingMode::Halted,
        ] {
            client.set_mode(&mode);
            assert!(client.get_config().paused, "{mode:?} must read as paused");
        }
        client.set_mode(&OperatingMode::Normal);
        assert!(!client.get_config().paused);
    }

    #[test]
    fn mode_changed_event_emitted() {
        use soroban_sdk::{testutils::Events, Event};
        let (env, client, _, _, _, _) = setup_market();
        // `set_mode` publishes exactly one event per invocation (#20 added the
        // event; the old `set_paused` published nothing).
        client.set_mode(&OperatingMode::ReduceOnly);
        let expected = ModeChanged {
            old: OperatingMode::Normal,
            new: OperatingMode::ReduceOnly,
        }
        .to_xdr(&env, &client.address);
        assert_eq!(env.events().all().events(), &[expected][..]);

        // The `set_paused` shim emits it too.
        client.set_paused(&true);
        let expected = ModeChanged {
            old: OperatingMode::ReduceOnly,
            new: OperatingMode::Halted,
        }
        .to_xdr(&env, &client.address);
        assert_eq!(env.events().all().events(), &[expected][..]);
    }

    #[test]
    fn wrong_caller_cannot_set_mode() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        for mode in ALL_MODES {
            assert!(client
                .mock_auths(&[MockAuth {
                    address: &trader,
                    invoke: &MockAuthInvoke {
                        contract: &client.address,
                        fn_name: "set_mode",
                        args: (mode,).into_val(&env),
                        sub_invokes: &[],
                    },
                }])
                .try_set_mode(&mode)
                .is_err());
        }
        assert_eq!(client.get_mode(), OperatingMode::Normal);
    }

    /// No mode sequence may strand a holder: `Halted` is reversible and
    /// `SettleOnly` always pays out.
    #[test]
    fn halted_then_settle_only_allows_redeem() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let close = client.get_market(&market_id).close_time;
        env.ledger().set_timestamp(close + 1);
        client.resolve(&market_id, &Outcome::Yes);

        client.set_mode(&OperatingMode::Halted);
        assert_eq!(
            client.try_redeem(&trader, &market_id),
            Err(Ok(Error::ModeRestricted))
        );

        client.set_mode(&OperatingMode::SettleOnly);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        let payout = client.redeem(&trader, &market_id);
        assert!(payout > 0);
        assert_eq!(token.balance(&trader), before + payout);
        // and the LP can still take the remainder in the same mode
        assert!(client.try_claim_pool_remainder(&market_id).is_ok());
    }

    /// An instance deployed before `DataKey::Mode` existed only has the legacy
    /// boolean; the mode is derived from it, so nothing has to be migrated.
    #[test]
    fn mode_derived_from_legacy_paused_boolean() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let contract = client.address.clone();
        env.as_contract(&contract, || {
            env.storage().instance().remove(&DataKey::Mode);
            env.storage().instance().set(&DataKey::Paused, &true);
        });

        assert_eq!(client.get_mode(), OperatingMode::Halted);
        assert_eq!(
            client.try_buy(&trader, &market_id, &Outcome::Yes, &1_000_000_i128, &0_i128),
            Err(Ok(Error::Paused))
        );

        env.as_contract(&contract, || {
            env.storage().instance().set(&DataKey::Paused, &false);
        });
        assert_eq!(client.get_mode(), OperatingMode::Normal);
    }

    /// ReduceOnly keeps collecting fees that cannot be swept yet: the accrual
    /// stays intact and one later sweep in Normal moves the whole amount.
    #[test]
    fn reduce_only_accrues_fees_that_sweep_later_in_normal() {
        let (env, client, creator, trader, _, _) = setup_market_full(10_000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let first = client.get_market(&market_id).fees_accrued;
        assert!(first > 0);

        client.set_mode(&OperatingMode::ReduceOnly);
        assert_eq!(
            client.try_sweep_fees(&market_id),
            Err(Ok(Error::ModeRestricted))
        );
        assert_eq!(client.get_market(&market_id).fees_accrued, first);

        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &i128::MAX,
        );
        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > first);

        client.set_mode(&OperatingMode::Normal);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(client.get_market(&market_id).fees_accrued, 0);
    }

    /// `transfer_position` / `transfer_lp` move no collateral, so they stay
    /// available in every mode, `Halted` included (same as the old pause).
    #[test]
    fn transfers_stay_open_in_every_mode() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let receiver = Address::generate(&env);
        for mode in ALL_MODES {
            client.set_mode(&mode);
            assert!(
                client
                    .try_transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &1_i128)
                    .is_ok(),
                "{mode:?} must still allow position transfers"
            );
            assert!(
                client
                    .try_transfer_lp(&market_id, &Address::generate(&env))
                    .is_ok(),
                "{mode:?} must still allow the LP role to move"
            );
        }
    }
}
