#![no_std]

#[cfg(test)]
extern crate std;

mod math;
mod math_categorical;

use math::{MathError, Settlement, BPS, MAX_SETS};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String, Vec,
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

/// Outcome-count cap for categorical markets (mirrors the math module).
const MAX_N: usize = math_categorical::MAX_MARKET_OUTCOMES as usize;

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
    /// Scalar (range) market, final: LONG shares pay `payout_long_bps /
    /// 10_000` and SHORT shares the complement. Appended last so stored
    /// `Resolved`/`Void` values keep their encoding; readers compiled
    /// against older bindings fail to decode this one (see the release note).
    ResolvedScalar(u32),
}

/// Display metadata of a scalar market: the `[lower, upper]` range of the
/// committed resolution spec, in the feed's raw units. Stored under
/// `DataKey::Scalar(u64)` at creation; the resolver's revealed spec is the
/// authoritative copy, this entry only tells UIs what to display.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScalarMeta {
    pub lower: i128,
    pub upper: i128,
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
    /// Snapshot of the flat fee at creation so later config changes never
    /// move it. Charged as-is by categorical markets and by binary markets
    /// without a `FeeSchedule` side entry (legacy / flat-fee markets).
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

/// Which pool a market id refers to. Absent for markets created before
/// categorical markets existed, hence `market_kind` reports `Binary` for
/// a stored `Market(u64)` and a `Kind` entry is only written for
/// categorical ids (which store a `CatMarket` instead of a `Market`).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketKind {
    Binary,
    /// Outcome count, 2..=MAX_MARKET_OUTCOMES.
    Categorical(u32),
}

/// Lifecycle of a categorical market: same three states as `MarketStatus`
/// with the winning index instead of a two-way outcome.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatStatus {
    Open,
    /// Final. Winning shares redeem 1:1.
    Resolved(u32),
    /// Invalid market. Every share redeems at 1/n.
    Void,
}

/// Categorical market state. Stored under `DataKey::CatMarket(u64)`, sharing
/// the id space with binary markets (`DataKey::NextId`), so `get_market` on
/// a categorical id is `MarketNotFound` and callers must read `market_kind`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatMarket {
    pub creator: Address,
    /// Same commitment scheme as the binary `Market` (see there).
    pub question_hash: BytesN<32>,
    pub resolution_hash: BytesN<32>,
    pub meta_uri: String,
    pub category: Category,
    pub close_time: u64,
    pub fee_bps: u32,
    pub status: CatStatus,
    /// One reserve per outcome; `len()` is the outcome count n.
    pub reserves: Vec<i128>,
    /// Complete sets in existence == collateral locked for this market. Each
    /// outcome's shares (reserve + all holder balances) sum to this.
    pub sets_minted: i128,
    pub fees_accrued: i128,
    /// Creator has withdrawn the pool remainder after finality.
    pub lp_claimed: bool,
}

/// Per-holder categorical position: one balance per outcome, same order as
/// `CatMarket::reserves`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatPosition {
    pub balances: Vec<i128>,
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

/// Dynamic fee schedule, snapshotted per binary market at creation as a
/// side entry (`DataKey::FeeSchedule`) so `Market`'s XDR shape never
/// changes. The effective rate of a trade is
/// `math::effective_fee_bps(schedule, now, close_time, r_yes, r_no)`:
/// a base rate that ramps up towards `max_bps` as `close_time` approaches
/// and grows with the pool's distance from 50/50, protecting the single LP
/// from informed flow near expiry and from one-sided pools.
///
/// Markets created before this existed (and categorical markets, which
/// still charge their flat `Market::fee_bps`) have no `FeeSchedule` entry
/// and keep a flat fee. The schedule is immutable after creation; only
/// `set_default_fee_schedule` (the default for *new* markets) can change.
/// Field order is part of the XDR — keep `base_bps`, `max_bps`,
/// `ramp_secs`, `skew_mult_bps` stable.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FeeSchedule {
    /// Fee far from close with the pool at 50/50.
    pub base_bps: u32,
    /// Hard ceiling for this market, `<= MAX_FEE_BPS`.
    pub max_bps: u32,
    /// The time ramp starts this many seconds before `close_time`
    /// (0 = no ramp, `<= math::MAX_RAMP_SECS`).
    pub ramp_secs: u64,
    /// Extra bps per 1_000 bps of distance from a 5_000 price
    /// (`<= math::MAX_SKEW_MULT_BPS`).
    pub skew_mult_bps: u32,
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
    // appended (new variants only ever go at the end — the XDR tag is the
    // variant position)
    /// Only written for categorical markets; absent means binary.
    Kind(u64),
    CatMarket(u64),
    CatPosition(u64, Address),
    /// Display metadata of a scalar market, written by
    /// `create_scalar_market`; absent for binary and categorical markets.
    Scalar(u64),
    /// Dynamic fee schedule snapshotted at creation; absent for legacy and
    /// categorical markets, which charge the flat `Market::fee_bps`.
    FeeSchedule(u64),
    /// Instance storage, but appended here anyway: the XDR tag is the
    /// variant position, so even instance keys must only ever be appended.
    DefaultFeeSchedule,
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
    // 23..=27 reserved for an in-flight contributor PR (deadline/limit v2
    // work on `develop`); new codes here start at 28.
    /// `outcome_index` is not a valid outcome of this categorical market.
    InvalidOutcomeIndex = 28,
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

/// Same trade as `Trade` plus the realised fee rate. New event rather than
/// a new field so the existing `Trade` XDR stays stable for indexers (the
/// `FeesSweptTo` convention); both are emitted on every binary trade.
/// `fee_bps` is the effective dynamic rate applied, already snapshotted
/// into `fee` — indexers can recover it from `fee / collateral` but not
/// exactly, because `fee` carries the ceiling rounding.
#[contractevent]
pub struct TradeV2 {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub trader: Address,
    pub outcome: Outcome,
    pub is_buy: bool,
    pub collateral: i128,
    pub shares: i128,
    pub fee: i128,
    pub fee_bps: u32,
    pub reserve_yes: i128,
    pub reserve_no: i128,
}

#[contractevent]
pub struct CatMarketCreated {
    #[topic]
    pub market_id: u64,
    pub creator: Address,
    pub category: Category,
    pub close_time: u64,
    pub seed_amount: i128,
    /// Requested opening probabilities, one per outcome, summing to BPS.
    pub probs_bps: Vec<u32>,
}

#[contractevent]
pub struct CatTrade {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub trader: Address,
    pub outcome_index: u32,
    pub is_buy: bool,
    pub collateral: i128,
    pub shares: i128,
    pub fee: i128,
    /// Post-trade reserves, same order as `CatMarket::reserves`.
    pub reserves: Vec<i128>,
}

#[contractevent]
pub struct MarketResolved {
    #[topic]
    pub market_id: u64,
    /// None means the market was voided.
    pub outcome: Option<Outcome>,
}

#[contractevent]
pub struct CatMarketResolved {
    #[topic]
    pub market_id: u64,
    /// None means the market was voided.
    pub outcome_index: Option<u32>,
}

#[contractevent]
pub struct MarketResolvedScalar {
    #[topic]
    pub market_id: u64,
    /// LONG payout per complete set, 0..=BPS; the SHORT leg pays the
    /// complement. `MarketResolved` is never emitted for scalar markets.
    pub payout_long_bps: u32,
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
        env.storage()
            .instance()
            .set(&DataKey::DefaultFeeBps, &fee_bps);
        Ok(())
    }

    /// Sets the dynamic fee schedule snapshotted into binary markets created
    /// after the call. Bounded by `MAX_FEE_BPS` and the ramp/skew caps;
    /// existing markets keep their schedule. A creator can pick a stricter
    /// schedule through `create_market_with_fees`, never a looser one (its
    /// `max_bps` is capped by this default's `max_bps`).
    pub fn set_default_fee_schedule(env: Env, schedule: FeeSchedule) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::validate_schedule(&schedule, MAX_FEE_BPS)?;
        env.storage()
            .instance()
            .set(&DataKey::DefaultFeeSchedule, &schedule);
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
    /// When a default dynamic fee schedule is set it is snapshotted for
    /// this market (see `set_default_fee_schedule`); otherwise the market
    /// charges the flat `DefaultFeeBps`.
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
        Self::do_create_market(
            env,
            creator,
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
            None,
        )
    }

    /// `create_market` with an explicit per-market `FeeSchedule`. Validated
    /// against `MAX_FEE_BPS` and the current default schedule's `max_bps`
    /// (creators can undercut protocol policy, never exceed it), then
    /// snapshotted for this market's lifetime.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market_with_fees(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        schedule: FeeSchedule,
    ) -> Result<u64, Error> {
        Self::do_create_market(
            env,
            creator,
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
            Some(schedule),
        )
    }

    /// Shared implementation of `create_market` / `create_market_with_fees`.
    /// `schedule = None` snapshots `DataKey::DefaultFeeSchedule` when set.
    #[allow(clippy::too_many_arguments)]
    fn do_create_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        schedule: Option<FeeSchedule>,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
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
        // validated before the id is allocated so a rejected schedule
        // never burns a market id
        if let Some(sch) = &schedule {
            let cap = env
                .storage()
                .instance()
                .get::<_, FeeSchedule>(&DataKey::DefaultFeeSchedule)
                .map_or(MAX_FEE_BPS, |d| d.max_bps);
            Self::validate_schedule(sch, cap)?;
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
        let default_schedule: Option<FeeSchedule> = s.get(&DataKey::DefaultFeeSchedule);

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
        if let Some(sch) = schedule.or(default_schedule) {
            Self::save_fee_schedule(&env, id, &sch);
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

    /// Creates a scalar (range) market: the binary pool with LONG = YES and
    /// SHORT = NO, whose final status carries a fractional payout
    /// (`MarketStatus::ResolvedScalar`) instead of a side. Everything else
    /// matches `create_market`; `[lower, upper]` is display metadata stored
    /// under `DataKey::Scalar` (the authoritative range is inside the
    /// `ResolutionSpec` committed through `resolution_hash`).
    #[allow(clippy::too_many_arguments)]
    pub fn create_scalar_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        lower: i128,
        upper: i128,
    ) -> Result<u64, Error> {
        if lower >= upper {
            return Err(Error::InvalidAmount);
        }
        let id = Self::create_market(
            env.clone(),
            creator,
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
        )?;
        let key = DataKey::Scalar(id);
        env.storage()
            .persistent()
            .set(&key, &ScalarMeta { lower, upper });
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(id)
    }

    /// Creates a categorical market with 2..=8 outcomes and seeds the pool.
    /// `creator` becomes the sole LP and receives the leftover shares of the
    /// likelier outcomes. `probs_bps` must have one entry per outcome with
    /// every probability in `math::MIN_PROB_BPS..=math::MAX_PROB_BPS` and the
    /// entries summing to exactly BPS.
    ///
    /// Collateral, id space, pause switch, fee snapshot and `resolution_hash`
    /// commitment are shared with `create_market`; the pool is the same FPMM
    /// with the reserve-product invariant generalised to n outcomes (see
    /// `math_categorical`). Per-market circuit breakers are price-based and
    /// binary-only, so categorical markets are not snapshotted with them —
    /// nor with a `FeeSchedule`: they always charge their flat `fee_bps`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_categorical_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        probs_bps: Vec<u32>,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        creator.require_auth();

        if close_time <= env.ledger().timestamp() {
            return Err(Error::InvalidCloseTime);
        }
        if !(MIN_SEED..=MAX_SETS).contains(&seed_amount) {
            return Err(Error::InvalidAmount);
        }
        let n = probs_bps.len();
        if !(2..=math_categorical::MAX_MARKET_OUTCOMES).contains(&n) {
            return Err(Error::InvalidAmount);
        }
        let mut prob_sum: u32 = 0;
        for p in probs_bps.iter() {
            if !(math::MIN_PROB_BPS..=math::MAX_PROB_BPS).contains(&p) {
                return Err(Error::InvalidProbability);
            }
            prob_sum = prob_sum.checked_add(p).ok_or(Error::Overflow)?;
        }
        if prob_sum != BPS as u32 {
            return Err(Error::InvalidProbability);
        }
        let mut probs = [0u32; MAX_N];
        for (i, p) in probs_bps.iter().enumerate() {
            probs[i] = p;
        }
        let seed = math_categorical::seed_reserves(seed_amount, &probs[..n as usize])?;

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

        let market = CatMarket {
            creator: creator.clone(),
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            fee_bps,
            status: CatStatus::Open,
            reserves: Vec::from_slice(&env, &seed.reserves[..n as usize]),
            sets_minted: seed_amount,
            fees_accrued: 0,
            lp_claimed: false,
        };
        Self::save_kind(&env, id, &MarketKind::Categorical(n));
        Self::save_cat_market(&env, id, &market);
        Self::save_fee_terms(
            &env,
            id,
            &FeeTerms {
                recipient: treasury,
                protocol_share_bps,
            },
        );
        let creator_shares: Vec<i128> = Vec::from_slice(&env, &seed.creator_shares[..n as usize]);
        if creator_shares.iter().any(|b| b > 0) {
            Self::save_cat_position(
                &env,
                id,
                &creator,
                &CatPosition {
                    balances: creator_shares,
                },
            );
        }

        Self::token(&env)?.transfer(&creator, env.current_contract_address(), &seed_amount);

        CatMarketCreated {
            market_id: id,
            creator,
            category,
            close_time,
            seed_amount,
            probs_bps,
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
        Self::assert_not_paused(&env)?;
        if let Some(limit) = limit_price_bps {
            if limit as i128 > BPS {
                return Err(Error::InvalidAmount);
            }
        }
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let fee_bps = Self::fee_at(&env, market_id, &m, env.ledger().timestamp())?;
        let q = math::calc_buy(r_bought, r_other, collateral_in, fee_bps)?;
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
            trader: trader.clone(),
            outcome,
            is_buy: true,
            collateral: collateral_in,
            shares: q.shares_out,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        TradeV2 {
            market_id,
            trader,
            outcome,
            is_buy: true,
            collateral: collateral_in,
            shares: q.shares_out,
            fee: q.fee,
            fee_bps,
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
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        let fee_bps = Self::fee_at(&env, market_id, &m, env.ledger().timestamp())?;
        let q = math::calc_sell(r_sold, r_other, collateral_out, fee_bps)?;
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
            trader: trader.clone(),
            outcome,
            is_buy: false,
            collateral: collateral_out,
            shares: q.shares_in,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        TradeV2 {
            market_id,
            trader,
            outcome,
            is_buy: false,
            collateral: collateral_out,
            shares: q.shares_in,
            fee: q.fee,
            fee_bps,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        Ok(q.shares_in)
    }

    /// Categorical-market counterpart of `buy`: spend `collateral_in` on
    /// `outcome_index` shares. Returns shares received; reverts if fewer than
    /// `min_shares_out` would be received. No v2 (deadline/limit) variant
    /// yet — see the categorical notes in `docs/architecture.md`.
    pub fn buy_cat(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome_index: u32,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_cat_market(&env, market_id)?;
        Self::assert_tradable_cat(&env, &m)?;
        let (reserves, n) = Self::cat_array(&m.reserves)?;
        if outcome_index >= n {
            return Err(Error::InvalidOutcomeIndex);
        }
        let q = math_categorical::calc_buy(
            &reserves[..n as usize],
            outcome_index,
            collateral_in,
            m.fee_bps,
        )?;
        if q.shares_out < min_shares_out {
            return Err(Error::SlippageExceeded);
        }
        let new_sets = m.sets_minted.checked_add(q.net).ok_or(Error::Overflow)?;
        if new_sets > MAX_SETS {
            return Err(Error::MarketTooLarge);
        }

        // effects
        m.reserves = Vec::from_slice(&env, &q.new_reserves[..n as usize]);
        m.sets_minted = new_sets;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        let mut pos = Self::load_cat_position(&env, market_id, &trader, n);
        let held = pos.balances.get(outcome_index).unwrap_or(0);
        pos.balances.set(
            outcome_index,
            held.checked_add(q.shares_out).ok_or(Error::Overflow)?,
        );
        Self::save_cat_position(&env, market_id, &trader, &pos);
        Self::save_cat_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&trader, env.current_contract_address(), &collateral_in);

        CatTrade {
            market_id,
            trader,
            outcome_index,
            is_buy: true,
            collateral: collateral_in,
            shares: q.shares_out,
            fee: q.fee,
            reserves: m.reserves,
        }
        .publish(&env);
        Ok(q.shares_out)
    }

    /// Categorical-market counterpart of `sell`: receive exactly
    /// `collateral_out` by selling `outcome_index` shares. Returns shares
    /// sold; reverts if more than `max_shares_in` would be needed.
    pub fn sell_cat(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome_index: u32,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_cat_market(&env, market_id)?;
        Self::assert_tradable_cat(&env, &m)?;
        let (reserves, n) = Self::cat_array(&m.reserves)?;
        if outcome_index >= n {
            return Err(Error::InvalidOutcomeIndex);
        }
        let q = math_categorical::calc_sell(
            &reserves[..n as usize],
            outcome_index,
            collateral_out,
            m.fee_bps,
        )?;
        if q.shares_in > max_shares_in {
            return Err(Error::SlippageExceeded);
        }

        let mut pos = Self::load_cat_position(&env, market_id, &trader, n);
        let held = pos.balances.get(outcome_index).unwrap_or(0);
        if held < q.shares_in {
            return Err(Error::InsufficientShares);
        }

        // effects
        pos.balances.set(outcome_index, held - q.shares_in);
        Self::save_cat_position(&env, market_id, &trader, &pos);
        m.reserves = Vec::from_slice(&env, &q.new_reserves[..n as usize]);
        m.sets_minted -= q.gross;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        Self::save_cat_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&env.current_contract_address(), &trader, &collateral_out);

        CatTrade {
            market_id,
            trader,
            outcome_index,
            is_buy: false,
            collateral: collateral_out,
            shares: q.shares_in,
            fee: q.fee,
            reserves: m.reserves,
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
        MarketResolved {
            market_id,
            outcome: Some(outcome),
        }
        .publish(&env);
        Ok(())
    }

    /// Categorical-market counterpart of `resolve`. Same resolver-only gate
    /// and close-time rule.
    pub fn resolve_cat(env: Env, market_id: u64, outcome_index: u32) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_cat_market(&env, market_id)?;
        if m.status != CatStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() < m.close_time {
            return Err(Error::NotClosedYet);
        }
        if outcome_index >= m.reserves.len() {
            return Err(Error::InvalidOutcomeIndex);
        }
        m.status = CatStatus::Resolved(outcome_index);
        Self::save_cat_market(&env, market_id, &m);
        CatMarketResolved {
            market_id,
            outcome_index: Some(outcome_index),
        }
        .publish(&env);
        Ok(())
    }

    /// Scalar-market counterpart of `resolve`. `payout_long_bps` is the
    /// final LONG payout in basis points of 1.0 (0..=10_000); the SHORT side
    /// pays the complement. Same resolver-only gate and close-time rule.
    pub fn resolve_scalar(env: Env, market_id: u64, payout_long_bps: u32) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() < m.close_time {
            return Err(Error::NotClosedYet);
        }
        if payout_long_bps as i128 > math::BPS {
            return Err(Error::InvalidProbability);
        }
        m.status = MarketStatus::ResolvedScalar(payout_long_bps);
        Self::save_market(&env, market_id, &m);
        MarketResolvedScalar {
            market_id,
            payout_long_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Invalid or unresolvable market. Allowed any time before finality.
    /// Dispatches on the market kind: binary markets emit `MarketResolved`
    /// with `None`, categorical markets `CatMarketResolved`.
    pub fn void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        match Self::market_kind_of(&env, market_id)? {
            MarketKind::Categorical(_) => {
                let mut m = Self::load_cat_market(&env, market_id)?;
                if m.status != CatStatus::Open {
                    return Err(Error::MarketNotOpen);
                }
                m.status = CatStatus::Void;
                Self::save_cat_market(&env, market_id, &m);
                CatMarketResolved {
                    market_id,
                    outcome_index: None,
                }
                .publish(&env);
            }
            MarketKind::Binary => {
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
            }
        }
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

    /// Categorical-market counterpart of `redeem`. Winning balances pay 1:1,
    /// a void pays `floor(Σ balances / n)` — both floored, so the total paid
    /// across all holders never exceeds `sets_minted`.
    pub fn redeem_cat(env: Env, holder: Address, market_id: u64) -> Result<i128, Error> {
        holder.require_auth();
        let m = Self::load_cat_market(&env, market_id)?;
        let settled = Self::cat_settlement(&m)?;
        let (_, n) = Self::cat_array(&m.reserves)?;
        let pos = Self::load_cat_position(&env, market_id, &holder, n);
        if pos.balances.iter().all(|b| b == 0) {
            return Err(Error::NothingToRedeem);
        }
        let (balances, _) = Self::cat_array(&pos.balances)?;
        let payout = math_categorical::settle_value(settled, &balances[..n as usize])?;

        Self::save_cat_position(
            &env,
            market_id,
            &holder,
            &CatPosition {
                balances: Self::zero_reserves(&env, n),
            },
        );
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

    /// Categorical-market counterpart of `claim_pool_remainder`: the creator
    /// (the LP) withdraws the settled pool value plus any unclaimed LP fees.
    pub fn claim_pool_remainder_cat(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_cat_market(&env, market_id)?;
        m.creator.require_auth();
        let settled = Self::cat_settlement(&m)?;
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        let (reserves, n) = Self::cat_array(&m.reserves)?;
        let pool_value = math_categorical::settle_value(settled, &reserves[..n as usize])?;
        let payout = pool_value
            .checked_add(Self::load_lp_fees(&env, market_id))
            .ok_or(Error::Overflow)?;
        Self::save_lp_fees(&env, market_id, 0);
        m.reserves = Self::zero_reserves(&env, n);
        m.lp_claimed = true;
        let creator = m.creator.clone();
        Self::save_cat_market(&env, market_id, &m);
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
    /// nothing is pending, mirroring `sweep_fees`). Works for both market
    /// kinds (the fee side-entries are keyed by the shared market id).
    pub fn claim_lp_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let creator = match Self::market_kind_of(&env, market_id)? {
            MarketKind::Binary => Self::load_market(&env, market_id)?.creator,
            MarketKind::Categorical(_) => Self::load_cat_market(&env, market_id)?.creator,
        };
        creator.require_auth();
        let amount = Self::load_lp_fees(&env, market_id);
        if amount <= 0 {
            return Ok(0);
        }
        Self::save_lp_fees(&env, market_id, 0);
        Self::token(&env)?.transfer(&env.current_contract_address(), &creator, &amount);
        LpFeesClaimed {
            market_id,
            creator,
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
    /// Works for both market kinds.
    pub fn sweep_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let amount = match Self::market_kind_of(&env, market_id)? {
            MarketKind::Binary => {
                let mut m = Self::load_market(&env, market_id)?;
                let amount = m.fees_accrued;
                if amount <= 0 {
                    return Ok(0);
                }
                m.fees_accrued = 0;
                Self::save_market(&env, market_id, &m);
                amount
            }
            MarketKind::Categorical(_) => {
                let mut m = Self::load_cat_market(&env, market_id)?;
                let amount = m.fees_accrued;
                if amount <= 0 {
                    return Ok(0);
                }
                m.fees_accrued = 0;
                Self::save_cat_market(&env, market_id, &m);
                amount
            }
        };
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
            paused: Self::instance_get(&env, &DataKey::Paused)?,
        })
    }

    pub fn market_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        Self::load_market(&env, market_id)
    }

    /// Display metadata (the staked range) of a scalar market. Absent for
    /// binary and categorical markets.
    pub fn get_scalar_meta(env: Env, market_id: u64) -> Result<ScalarMeta, Error> {
        let key = DataKey::Scalar(market_id);
        let meta: ScalarMeta = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(meta)
    }

    pub fn get_position(env: Env, market_id: u64, holder: Address) -> Position {
        Self::load_position(&env, market_id, &holder)
    }

    /// Whether a market id is a binary (`Market`) or categorical
    /// (`CatMarket`) market. `MarketNotFound` for unknown ids.
    pub fn market_kind(env: Env, market_id: u64) -> Result<MarketKind, Error> {
        Self::market_kind_of(&env, market_id)
    }

    pub fn get_cat_market(env: Env, market_id: u64) -> Result<CatMarket, Error> {
        Self::load_cat_market(&env, market_id)
    }

    /// A holder's categorical position, zero-filled to the market's outcome
    /// count when they never traded. Errors if the market does not exist.
    pub fn get_cat_position(
        env: Env,
        market_id: u64,
        holder: Address,
    ) -> Result<CatPosition, Error> {
        let m = Self::load_cat_market(&env, market_id)?;
        let n = m.reserves.len();
        Ok(Self::load_cat_position(&env, market_id, &holder, n))
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

    /// Shares a `buy` of `collateral_in` would return right now, at the
    /// effective (possibly dynamic) fee for this ledger's timestamp.
    pub fn quote_buy(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let fee_bps = Self::fee_at(&env, market_id, &m, env.ledger().timestamp())?;
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_buy(r_bought, r_other, collateral_in, fee_bps)?.shares_out)
    }

    /// Shares a `buy` of `collateral_in` would return at ledger timestamp
    /// `at_timestamp`. Under a ramping schedule the fee rises with time, so
    /// clients expecting inclusion latency can quote the worst case here
    /// (see `docs/frontend-integration.md`). No other state is simulated:
    /// the reserves are the current ones.
    pub fn quote_buy_at(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        at_timestamp: u64,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let fee_bps = Self::fee_at(&env, market_id, &m, at_timestamp)?;
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_buy(r_bought, r_other, collateral_in, fee_bps)?.shares_out)
    }

    /// Shares a `sell` for exactly `collateral_out` would consume right now,
    /// at the effective (possibly dynamic) fee for this ledger's timestamp.
    pub fn quote_sell(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let fee_bps = Self::fee_at(&env, market_id, &m, env.ledger().timestamp())?;
        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_sell(r_sold, r_other, collateral_out, fee_bps)?.shares_in)
    }

    /// Shares a `buy_cat` of `collateral_in` would return right now.
    pub fn quote_buy_cat(
        env: Env,
        market_id: u64,
        outcome_index: u32,
        collateral_in: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_cat_market(&env, market_id)?;
        let (reserves, n) = Self::cat_array(&m.reserves)?;
        if outcome_index >= n {
            return Err(Error::InvalidOutcomeIndex);
        }
        Ok(math_categorical::calc_buy(
            &reserves[..n as usize],
            outcome_index,
            collateral_in,
            m.fee_bps,
        )?
        .shares_out)
    }

    /// Spot prices of all outcomes in bps, same order as the reserves. Each
    /// price is floored, so they sum to at most BPS and at least BPS - n;
    /// clients should treat the slack as display rounding, never as a
    /// mispricing (prices do not enter trade math).
    pub fn get_prices_cat(env: Env, market_id: u64) -> Result<Vec<u32>, Error> {
        let m = Self::load_cat_market(&env, market_id)?;
        let (reserves, n) = Self::cat_array(&m.reserves)?;
        let prices = math_categorical::prices_bps(&reserves[..n as usize])?;
        Ok(Vec::from_slice(&env, &prices[..n as usize]))
    }

    /// The market's snapshotted breakers (`None` for legacy markets created
    /// before breakers existed — those are never checked).
    pub fn breaker_config(env: Env, market_id: u64) -> Result<Option<BreakerConfig>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_breaker(&env, market_id))
    }

    /// The market's snapshotted dynamic fee schedule (`None` for legacy and
    /// categorical markets, which charge the flat `Market::fee_bps`).
    pub fn fee_schedule(env: Env, market_id: u64) -> Result<Option<FeeSchedule>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_fee_schedule(&env, market_id))
    }

    /// The fee bps this ledger's next trade on `market_id` pays: the
    /// dynamic effective fee for binary markets with a schedule, the flat
    /// snapshot for legacy and categorical markets. Under a ramping
    /// schedule the value changes with the ledger timestamp; use
    /// `quote_buy_at` to price expected inclusion latency.
    pub fn current_fee_bps(env: Env, market_id: u64) -> Result<u32, Error> {
        match Self::market_kind_of(&env, market_id)? {
            MarketKind::Binary => {
                let m = Self::load_market(&env, market_id)?;
                Self::fee_at(&env, market_id, &m, env.ledger().timestamp())
            }
            MarketKind::Categorical(_) => Ok(Self::load_cat_market(&env, market_id)?.fee_bps),
        }
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
        let fee_bps = Self::fee_at(&env, market_id, &m, env.ledger().timestamp())?;
        let q = math::calc_buy(r_bought, r_other, collateral_in, fee_bps)?;
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
            MarketStatus::ResolvedScalar(payout_long_bps) => {
                Ok(Settlement::Scalar(payout_long_bps))
            }
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

    /// Which pool an id refers to: the `Kind` side entry when present
    /// (categorical), otherwise a stored binary `Market`, otherwise unknown.
    fn market_kind_of(env: &Env, id: u64) -> Result<MarketKind, Error> {
        let key = DataKey::Kind(id);
        if let Some(kind) = env.storage().persistent().get::<_, MarketKind>(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
            return Ok(kind);
        }
        Self::load_market(env, id).map(|_| MarketKind::Binary)
    }

    fn save_kind(env: &Env, id: u64, kind: &MarketKind) {
        let key = DataKey::Kind(id);
        env.storage().persistent().set(&key, kind);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_cat_market(env: &Env, id: u64) -> Result<CatMarket, Error> {
        let key = DataKey::CatMarket(id);
        let m: CatMarket = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(m)
    }

    fn save_cat_market(env: &Env, id: u64, m: &CatMarket) {
        let key = DataKey::CatMarket(id);
        env.storage().persistent().set(&key, m);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// Reads a categorical reserve/balance vector into a fixed array and
    /// returns `(array, n)`. The length check is unreachable for stored
    /// values (creation validated them) but keeps malformed storage from
    /// panicking.
    fn cat_array(v: &Vec<i128>) -> Result<([i128; MAX_N], u32), Error> {
        let n = v.len();
        if !(2..=math_categorical::MAX_MARKET_OUTCOMES).contains(&n) {
            return Err(Error::InvalidAmount);
        }
        let mut arr = [0i128; MAX_N];
        for (i, r) in v.iter().enumerate() {
            arr[i] = r;
        }
        Ok((arr, n))
    }

    fn zero_reserves(env: &Env, n: u32) -> Vec<i128> {
        Vec::from_slice(env, &[0i128; MAX_N][..n as usize])
    }

    fn load_cat_position(env: &Env, id: u64, holder: &Address, n: u32) -> CatPosition {
        let key = DataKey::CatPosition(id, holder.clone());
        match env.storage().persistent().get::<_, CatPosition>(&key) {
            Some(p) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
                p
            }
            None => CatPosition {
                balances: Self::zero_reserves(env, n),
            },
        }
    }

    /// Empty positions are removed so storage does not grow with dust.
    fn save_cat_position(env: &Env, id: u64, holder: &Address, p: &CatPosition) {
        let key = DataKey::CatPosition(id, holder.clone());
        if p.balances.iter().all(|b| b == 0) {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, p);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    fn assert_tradable_cat(env: &Env, m: &CatMarket) -> Result<(), Error> {
        if m.status != CatStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() >= m.close_time {
            return Err(Error::MarketClosed);
        }
        Ok(())
    }

    /// `Some(winning index)` when final, `None` for a void (which settles
    /// proportionally), `NotFinal` while open.
    fn cat_settlement(m: &CatMarket) -> Result<Option<u32>, Error> {
        match m.status {
            CatStatus::Open => Err(Error::NotFinal),
            CatStatus::Resolved(w) => Ok(Some(w)),
            CatStatus::Void => Ok(None),
        }
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

    /// Shared bounds for any `FeeSchedule`: `base <= max <= cap`, the hard
    /// `MAX_FEE_BPS` ceiling, and the ramp/skew caps. `cap` is `MAX_FEE_BPS`
    /// for the default setter and the current default's `max_bps` for
    /// creator-supplied schedules, so a creator can only tighten policy.
    fn validate_schedule(s: &FeeSchedule, cap_bps: u32) -> Result<(), Error> {
        if s.base_bps > s.max_bps || s.max_bps > MAX_FEE_BPS || s.max_bps > cap_bps {
            return Err(Error::InvalidFee);
        }
        if s.ramp_secs > math::MAX_RAMP_SECS || s.skew_mult_bps > math::MAX_SKEW_MULT_BPS {
            return Err(Error::InvalidFee);
        }
        Ok(())
    }

    fn load_fee_schedule(env: &Env, id: u64) -> Option<FeeSchedule> {
        let key = DataKey::FeeSchedule(id);
        let s: Option<FeeSchedule> = env.storage().persistent().get(&key);
        if s.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        s
    }

    fn save_fee_schedule(env: &Env, id: u64, s: &FeeSchedule) {
        let key = DataKey::FeeSchedule(id);
        env.storage().persistent().set(&key, s);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn fee_schedule_m(s: &FeeSchedule) -> math::FeeScheduleM {
        math::FeeScheduleM {
            base_bps: s.base_bps,
            max_bps: s.max_bps,
            ramp_secs: s.ramp_secs,
            skew_mult_bps: s.skew_mult_bps,
        }
    }

    /// The fee rate for this market's next binary trade at time `now`: the
    /// snapshotted `FeeSchedule` evaluated against the pre-trade reserves,
    /// or the flat `fee_bps` for markets without one. The result is always
    /// `< BPS`, which `calc_sell` requires.
    fn fee_at(env: &Env, id: u64, m: &Market, now: u64) -> Result<u32, Error> {
        let fee = match Self::load_fee_schedule(env, id) {
            Some(s) => math::effective_fee_bps(
                &Self::fee_schedule_m(&s),
                now,
                m.close_time,
                m.reserve_yes,
                m.reserve_no,
            )?,
            None => m.fee_bps,
        };
        if fee as i128 >= BPS {
            return Err(Error::InvalidFee);
        }
        Ok(fee)
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

    // ----- #6: categorical (N-outcome) markets -----------------------------

    /// One 100 USDC categorical market opening at `probs` (bps per outcome).
    fn new_cat_market(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        probs: &[u32],
    ) -> u64 {
        let mut p = Vec::new(env);
        for x in probs {
            p.push_back(*x);
        }
        client.create_categorical_market(
            creator,
            &BytesN::from_array(env, &[43u8; 32]),
            &BytesN::from_array(env, &[143u8; 32]),
            &String::from_str(env, "ipfs://test-cat-market"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &p,
        )
    }

    /// Contract balance always covers every outstanding claim: per outcome,
    /// `reserve_i + Σ holder balances_i == sets_minted`, so the collateral
    /// held equals `sets_minted + fees_accrued + lp_fees` while nothing has
    /// been claimed yet.
    fn assert_cat_solvent(
        env: &Env,
        client: &MarketCoreClient,
        collateral: &Address,
        market_id: u64,
    ) {
        let m = client.get_cat_market(&market_id);
        let balance =
            soroban_sdk::token::TokenClient::new(env, collateral).balance(&client.address);
        assert_eq!(
            balance,
            m.sets_minted + m.fees_accrued + lp_fees_stored(env, client, market_id),
            "cat market solvency broken"
        );
    }

    #[test]
    fn create_categorical_market_and_trade() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[5000, 3000, 2000]);

        // shared id space, categorical kind, binary views reject the id
        assert_eq!(client.market_count(), 1);
        assert_eq!(client.market_kind(&market_id), MarketKind::Categorical(3));
        assert_eq!(
            client.try_get_market(&market_id),
            Err(Ok(Error::MarketNotFound))
        );
        assert!(client.try_get_cat_market(&market_id).is_ok());

        // seeded reserves and opening prices mirror the requested probabilities
        let m = client.get_cat_market(&market_id);
        assert_eq!(
            m.reserves,
            Vec::from_slice(&env, &[400_000_000_i128, 666_666_666, 1_000_000_000])
        );
        assert_eq!(m.sets_minted, 1_000_000_000);
        // display prices land within a bps or two of the request (reciprocal
        // rounding), and the floor slack stays within n units of BPS
        let prices = client.get_prices_cat(&market_id);
        let want = [5000i128, 3000, 2000];
        let mut sum: i128 = 0;
        for (i, p) in prices.iter().enumerate() {
            assert!((p as i128 - want[i]).abs() <= 2, "i={i} price={p}");
            sum += p as i128;
        }
        assert!(sum <= BPS && sum + 3 >= BPS);

        // creator keeps shares of the two likelier outcomes only
        let creator_pos = client.get_cat_position(&market_id, &creator);
        assert_eq!(
            creator_pos.balances,
            Vec::from_slice(&env, &[600_000_000_i128, 333_333_334, 0])
        );
        // a never-traded address reads a zero-filled position of length n
        let empty = client.get_cat_position(&market_id, &Address::generate(&env));
        assert_eq!(empty.balances, Vec::from_slice(&env, &[0_i128, 0, 0]));
        assert_cat_solvent(&env, &client, &collateral, market_id);

        // quote matches execution
        let quote = client.quote_buy_cat(&market_id, &0u32, &(10 * 10_000_000_i128));
        let shares = client.buy_cat(&trader, &market_id, &0u32, &(10 * 10_000_000_i128), &0_i128);
        assert_eq!(shares, quote);

        // buy: fee = ceil(100e6 * 1%) = 1e6, net = 99e6; other reserves grow
        // by net, the bought reserve absorbs net minus shares
        let m = client.get_cat_market(&market_id);
        let net = 99_000_000_i128;
        assert_eq!(m.reserves.get(1), Some(666_666_666 + net));
        assert_eq!(m.reserves.get(2), Some(1_000_000_000 + net));
        assert_eq!(m.reserves.get(0), Some(400_000_000 + net - shares));
        assert_eq!(m.sets_minted, 1_000_000_000 + net);
        assert_eq!(m.fees_accrued, 1_000_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);
        let pos = client.get_cat_position(&market_id, &trader);
        assert_eq!(pos.balances, Vec::from_slice(&env, &[shares, 0, 0]));
        assert_cat_solvent(&env, &client, &collateral, market_id);

        // sell 5 USDC back: gross = ceil(50e6 / 0.99) = 50_505_051
        let sold = client.sell_cat(
            &trader,
            &market_id,
            &0u32,
            &(5 * 10_000_000_i128),
            &i128::MAX,
        );
        assert!(sold > 0 && sold < shares);
        let m = client.get_cat_market(&market_id);
        assert_eq!(m.sets_minted, 1_099_000_000 - 50_505_051);
        assert_eq!(m.fees_accrued, 1_000_000 + 505_051);
        let pos = client.get_cat_position(&market_id, &trader);
        assert_eq!(pos.balances.get(0), Some(shares - sold));
        assert_cat_solvent(&env, &client, &collateral, market_id);
    }

    #[test]
    fn cat_redeem_after_resolution() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[5000, 3000, 2000]);
        let shares = client.buy_cat(&trader, &market_id, &2u32, &(10 * 10_000_000_i128), &0_i128);

        // settlement is resolver-only after close
        assert_eq!(
            client.try_resolve_cat(&market_id, &2u32),
            Err(Ok(Error::NotClosedYet))
        );
        assert_eq!(
            client.try_redeem_cat(&trader, &market_id),
            Err(Ok(Error::NotFinal))
        );
        assert_eq!(
            client.try_claim_pool_remainder_cat(&market_id),
            Err(Ok(Error::NotFinal))
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve_cat(&market_id, &2u32);
        assert_eq!(
            client.get_cat_market(&market_id).status,
            CatStatus::Resolved(2)
        );

        // winner pays 1:1, loser pays 0, then the pool leftover goes to the LP
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        assert_eq!(client.redeem_cat(&trader, &market_id), shares);
        assert_eq!(token.balance(&trader), before + shares);
        // creator holds [600e6, 333_333_334, 0]: nothing on the winning index
        assert_eq!(client.redeem_cat(&creator, &market_id), 0);
        assert_eq!(
            client.try_redeem_cat(&trader, &market_id),
            Err(Ok(Error::NothingToRedeem))
        );

        let pool = client.get_cat_market(&market_id).reserves.get(2).unwrap();
        assert_eq!(client.claim_pool_remainder_cat(&market_id), pool);
        assert_eq!(
            client.try_claim_pool_remainder_cat(&market_id),
            Err(Ok(Error::AlreadyClaimed))
        );
        // only the unclaimed protocol fees remain locked in the contract
        let m = client.get_cat_market(&market_id);
        assert_eq!(token.balance(&client.address), m.fees_accrued);
        let treasury_balance_before = token.balance(&treasury_of(&client));
        assert_eq!(client.sweep_fees(&market_id), m.fees_accrued);
        assert_eq!(token.balance(&client.address), 0);
        assert_eq!(
            token.balance(&treasury_of(&client)),
            treasury_balance_before + m.fees_accrued
        );
    }

    fn treasury_of(client: &MarketCoreClient) -> Address {
        client.get_config().treasury
    }

    #[test]
    fn cat_void_pays_proportional() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[2500, 2500, 2500, 2500]);
        let m = client.get_cat_market(&market_id);
        assert_eq!(m.reserves, Vec::from_slice(&env, &[1_000_000_000_i128; 4]));
        // flat probabilities leave the creator no leftover shares at all
        let creator_pos = client.get_cat_position(&market_id, &creator);
        assert_eq!(creator_pos.balances, Vec::from_slice(&env, &[0_i128; 4]));

        let shares = client.buy_cat(&trader, &market_id, &1u32, &(10 * 10_000_000_i128), &0_i128);
        client.void_market(&market_id);
        assert_eq!(client.get_cat_market(&market_id).status, CatStatus::Void);

        // void pays floor(balances / n) per holder
        assert_eq!(client.redeem_cat(&trader, &market_id), shares / 4);
        assert_eq!(
            client.try_redeem_cat(&creator, &market_id),
            Err(Ok(Error::NothingToRedeem))
        );
        let reserves = client.get_cat_market(&market_id).reserves;
        let pool = (reserves.get(0).unwrap()
            + reserves.get(1).unwrap()
            + reserves.get(2).unwrap()
            + reserves.get(3).unwrap())
            / 4;
        assert_eq!(client.claim_pool_remainder_cat(&market_id), pool);
        client.sweep_fees(&market_id);
        // floors can strand at most one base unit per void settlement
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        assert!(token.balance(&client.address) <= 1);
    }

    #[test]
    fn wrong_caller_cannot_resolve_cat() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[5000, 5000]);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "resolve_cat",
                    args: (market_id, 0u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_resolve_cat(&market_id, &0u32)
            .is_err());
    }

    #[test]
    fn cat_trade_and_settlement_validations() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[5000, 3000, 2000]);

        // outcome index must be < n on every entrypoint that takes one
        assert_eq!(
            client.try_buy_cat(&trader, &market_id, &3u32, &(10_000_000_i128), &0_i128),
            Err(Ok(Error::InvalidOutcomeIndex))
        );
        assert_eq!(
            client.try_quote_buy_cat(&market_id, &3u32, &(10_000_000_i128)),
            Err(Ok(Error::InvalidOutcomeIndex))
        );
        assert_eq!(
            client.try_sell_cat(&trader, &market_id, &9u32, &(1_000_000_i128), &i128::MAX),
            Err(Ok(Error::InvalidOutcomeIndex))
        );

        // slippage and share checks
        assert_eq!(
            client.try_buy_cat(&trader, &market_id, &0u32, &(10_000_000_i128), &i128::MAX),
            Err(Ok(Error::SlippageExceeded))
        );
        assert_eq!(
            client.try_sell_cat(&trader, &market_id, &0u32, &(10_000_000_i128), &i128::MAX),
            Err(Ok(Error::InsufficientShares))
        );
        assert_eq!(
            client.try_buy_cat(&trader, &market_id, &0u32, &0_i128, &0_i128),
            Err(Ok(Error::InvalidAmount))
        );

        // after close: trading stops, resolution validates the index first
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        assert_eq!(
            client.try_buy_cat(&trader, &market_id, &0u32, &(10_000_000_i128), &0_i128),
            Err(Ok(Error::MarketClosed))
        );
        assert_eq!(
            client.try_resolve_cat(&market_id, &3u32),
            Err(Ok(Error::InvalidOutcomeIndex))
        );
        client.resolve_cat(&market_id, &0u32);
        // status is checked before the index, so a second resolve reports
        // MarketNotOpen even with an out-of-range index
        assert_eq!(
            client.try_resolve_cat(&market_id, &9u32),
            Err(Ok(Error::MarketNotOpen))
        );
        assert_eq!(
            client.try_buy_cat(&trader, &market_id, &0u32, &(10_000_000_i128), &0_i128),
            Err(Ok(Error::MarketNotOpen))
        );
        assert_eq!(
            client.try_void_market(&market_id),
            Err(Ok(Error::MarketNotOpen))
        );
    }

    #[test]
    fn cat_create_validations() {
        let (env, client, creator, _, _, _) = setup_market();

        // sum must be exactly BPS
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &1_000_000_000_i128,
                &Vec::from_slice(&env, &[6000u32, 3000]),
            ),
            Err(Ok(Error::InvalidProbability))
        );
        // every probability within MIN..=MAX
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &1_000_000_000_i128,
                &Vec::from_slice(&env, &[9950u32, 50]),
            ),
            Err(Ok(Error::InvalidProbability))
        );
        // outcome count must be 2..=8
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &1_000_000_000_i128,
                &Vec::from_slice(&env, &[10_000u32]),
            ),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &1_000_000_000_i128,
                &Vec::from_slice(&env, &[1000u32; 9]),
            ),
            Err(Ok(Error::InvalidAmount))
        );
        // seed below the shared MIN_SEED
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &1_000_000_i128,
                &Vec::from_slice(&env, &[5000u32, 5000]),
            ),
            Err(Ok(Error::InvalidAmount))
        );
        // past close time
        assert_eq!(
            client.try_create_categorical_market(
                &creator,
                &BytesN::from_array(&env, &[43u8; 32]),
                &BytesN::from_array(&env, &[143u8; 32]),
                &String::from_str(&env, "ipfs://x"),
                &Category::Crypto,
                &env.ledger().timestamp(),
                &1_000_000_000_i128,
                &Vec::from_slice(&env, &[5000u32, 5000]),
            ),
            Err(Ok(Error::InvalidCloseTime))
        );

        // boundary probabilities are accepted
        let market_id = new_cat_market(&env, &client, &creator, &[100, 9900]);
        let m = client.get_cat_market(&market_id);
        assert_eq!(
            m.reserves,
            Vec::from_slice(&env, &[1_000_000_000_i128, 10_101_010])
        );
        let prices = client.get_prices_cat(&market_id);
        let sum: u32 = prices.iter().sum();
        assert!((sum as i128) + 2 >= BPS && (sum as i128) <= BPS);
    }

    #[test]
    fn cat_fee_split_and_sweep_dispatch() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_cat_market(&env, &client, &creator, &[5000, 5000]);
        client.buy_cat(&trader, &market_id, &0u32, &(10 * 10_000_000_i128), &0_i128);

        // fee = 1e6, protocol = ceil(1e6 * 50%) = 5e5, LP = 5e5
        let m = client.get_cat_market(&market_id);
        assert_eq!(m.fees_accrued, 500_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 500_000);

        // claim_lp_fees works on categorical ids; second call is a no-op
        assert_eq!(client.claim_lp_fees(&market_id), 500_000);
        assert_eq!(client.claim_lp_fees(&market_id), 0);

        // sweep_fees sends the protocol part to the treasury
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let treasury = treasury_of(&client);
        let before = token.balance(&treasury);
        assert_eq!(client.sweep_fees(&market_id), 500_000);
        assert_eq!(token.balance(&treasury), before + 500_000);
    }

    #[test]
    fn cat_eight_outcomes_smoke() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[1250; 8]);
        assert_eq!(client.market_kind(&market_id), MarketKind::Categorical(8));
        let prices = client.get_prices_cat(&market_id);
        assert_eq!(prices, Vec::from_slice(&env, &[1250u32; 8]));

        // one small buy per outcome exercises every branch of the product
        let sizes = [1i128, 2, 3, 4, 5, 6, 7, 8];
        for (i, lots) in sizes.iter().enumerate() {
            let shares = client.buy_cat(
                &trader,
                &market_id,
                &(i as u32),
                &(lots * 10_000_000_i128),
                &0_i128,
            );
            assert!(shares > 0);
        }
        assert_cat_solvent(&env, &client, &collateral, market_id);

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve_cat(&market_id, &7u32);
        let pos = client.get_cat_position(&market_id, &trader);
        assert_eq!(
            client.redeem_cat(&trader, &market_id),
            pos.balances.get(7).unwrap()
        );
        client.claim_pool_remainder_cat(&market_id);
        client.sweep_fees(&market_id);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        assert_eq!(token.balance(&client.address), 0);
    }

    /// The resource ask from the categorical issue: the widest single trade
    /// (an 8-outcome buy — the longest mul_div loop and `Vec<i128>` writes)
    /// metered against the mainnet per-transaction limits. Native-contract
    /// numbers; the wasm build only adds VM overhead on top.
    #[test]
    fn cat_eight_outcomes_resource_budget() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_cat_market(&env, &client, &creator, &[1250; 8]);
        env.cost_estimate().budget().reset_unlimited();
        client.buy_cat(&trader, &market_id, &0u32, &(10 * 10_000_000_i128), &0_i128);
        let used = env.cost_estimate().resources();
        std::println!(
            "buy_cat n=8: {} instructions, {} memory bytes, {} write bytes, {} write entries",
            used.instructions,
            used.mem_bytes,
            used.write_bytes,
            used.write_entries
        );
        // Mainnet per-transaction limits (soroban-sdk 27
        // `InvocationResourceLimits::mainnet`): 400M instructions, 40 MiB
        // memory, 132_096 write bytes; stay under 60% of each.
        assert!(used.instructions <= 240_000_000);
        assert!(used.mem_bytes <= 25_165_824);
        assert!(used.write_bytes <= 79_257);
    }

    // ----- #7: scalar (range) markets --------------------------------------

    /// One 100 USDC scalar market staked on the display range
    /// `[100_000_000, 250_000_000]` (the `scalar_meta` golden vector values),
    /// opening at 50%.
    fn new_scalar_market(env: &Env, client: &MarketCoreClient, creator: &Address) -> u64 {
        client.create_scalar_market(
            creator,
            &BytesN::from_array(env, &[44u8; 32]),
            &BytesN::from_array(env, &[144u8; 32]),
            &String::from_str(env, "ipfs://test-scalar-market"),
            &Category::Macro,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
            &100_000_000_i128,
            &250_000_000_i128,
        )
    }

    #[test]
    fn create_scalar_market_validates_range_and_stores_meta() {
        let (env, client, creator, _, _, _) = setup_market();
        for (lower, upper) in [(100_i128, 100_i128), (200_i128, 100_i128)] {
            assert_eq!(
                client.try_create_scalar_market(
                    &creator,
                    &BytesN::from_array(&env, &[44u8; 32]),
                    &BytesN::from_array(&env, &[144u8; 32]),
                    &String::from_str(&env, "ipfs://scalar"),
                    &Category::Macro,
                    &(env.ledger().timestamp() + 60_000),
                    &(100 * 10_000_000_i128),
                    &5000u32,
                    &lower,
                    &upper,
                ),
                Err(Ok(Error::InvalidAmount))
            );
        }

        let market_id = new_scalar_market(&env, &client, &creator);
        assert_eq!(
            client.get_scalar_meta(&market_id),
            ScalarMeta {
                lower: 100_000_000,
                upper: 250_000_000,
            }
        );
        // a scalar market reuses the binary pool and position storage; only
        // the final status and the display metadata tell it apart
        assert_eq!(client.market_kind(&market_id), MarketKind::Binary);
        assert!(client.try_get_cat_market(&market_id).is_err());
        // binary ids carry no scalar metadata
        let binary = new_market(&env, &client, &creator, 5000);
        assert_eq!(
            client.try_get_scalar_meta(&binary),
            Err(Ok(Error::MarketNotFound))
        );
    }

    #[test]
    fn wrong_caller_cannot_resolve_scalar() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_scalar_market(&env, &client, &creator);

        // not closed yet, even for the configured resolver
        assert_eq!(
            client.try_resolve_scalar(&market_id, &6_000u32),
            Err(Ok(Error::NotClosedYet))
        );

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        let not_resolver = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_resolver,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "resolve_scalar",
                    args: (market_id, 6_000u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_resolve_scalar(&market_id, &6_000u32)
            .is_err());
        env.mock_all_auths();

        client.resolve_scalar(&market_id, &6_250u32);
        assert_eq!(
            client.get_market(&market_id).status,
            MarketStatus::ResolvedScalar(6_250)
        );
        // a final market cannot be re-resolved
        assert_eq!(
            client.try_resolve_scalar(&market_id, &5_000u32),
            Err(Ok(Error::MarketNotOpen))
        );
    }

    #[test]
    fn scalar_redeem_long_and_short() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_scalar_market(&env, &client, &creator);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::No,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve_scalar(&market_id, &6_250u32);

        let pos = client.get_position(&market_id, &trader);
        assert!(pos.yes > 0 && pos.no > 0);
        // every share stays covered by the pool: reserve + positions == sets
        let m = client.get_market(&market_id);
        let lp = client.get_position(&market_id, &creator);
        assert_eq!(m.reserve_yes + pos.yes + lp.yes, m.sets_minted);
        assert_eq!(m.reserve_no + pos.no + lp.no, m.sets_minted);

        // both legs floor, exactly as `scalar_payout` computes them
        let want = pos.yes * 6_250 / BPS + pos.no * 3_750 / BPS;
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        assert_eq!(client.redeem(&trader, &market_id), want);
        assert_eq!(token.balance(&trader), before + want);
        assert_eq!(
            client.get_position(&market_id, &trader),
            Position { yes: 0, no: 0 }
        );
        assert_eq!(
            client.try_redeem(&trader, &market_id),
            Err(Ok(Error::NothingToRedeem))
        );
    }

    #[test]
    fn scalar_claim_pool_remainder() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_scalar_market(&env, &client, &creator);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve_scalar(&market_id, &6_250u32);

        // the LP claims both reserves at the final payout; with the default
        // all-protocol split there are no LP fees on top
        let m = client.get_market(&market_id);
        let want = m.reserve_yes * 6_250 / BPS + m.reserve_no * 3_750 / BPS;
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let creator_before = token.balance(&creator);
        assert_eq!(client.claim_pool_remainder(&market_id), want);
        assert_eq!(token.balance(&creator), creator_before + want);
        assert!(client.get_market(&market_id).lp_claimed);
        assert_eq!(
            client.try_claim_pool_remainder(&market_id),
            Err(Ok(Error::AlreadyClaimed))
        );

        // drain the market: only rounding dust may stay in the contract (the
        // trader's and the pool's payouts each floor two legs, so the two
        // losses sum to under two units). The creator holds no shares — at a
        // 50/50 seed the reserves absorb the whole seed — so nothing else is
        // outstanding.
        client.redeem(&trader, &market_id);
        client.sweep_fees(&market_id);
        assert!(token.balance(&client.address) <= 1);
    }

    #[test]
    fn resolve_scalar_rejects_bps_above_max() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_scalar_market(&env, &client, &creator);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);

        assert_eq!(
            client.try_resolve_scalar(&market_id, &10_001u32),
            Err(Ok(Error::InvalidProbability))
        );
        assert_eq!(client.get_market(&market_id).status, MarketStatus::Open);

        // the 0 and BPS boundaries are valid payouts
        client.resolve_scalar(&market_id, &10_000u32);
        assert_eq!(
            client.get_market(&market_id).status,
            MarketStatus::ResolvedScalar(10_000)
        );
    }

    #[test]
    fn scalar_extremes_match_binary_resolution() {
        let (env, client, creator, trader, _, _) = setup_market();
        // four identical 5000 markets with identical long+short trades
        let mut ids = [0u64; 4];
        for id in ids.iter_mut() {
            *id = new_scalar_market(&env, &client, &creator);
            client.buy(&trader, id, &Outcome::Yes, &(10 * 10_000_000_i128), &0_i128);
            client.buy(&trader, id, &Outcome::No, &(5 * 10_000_000_i128), &0_i128);
        }
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve_scalar(&ids[0], &0u32);
        client.resolve(&ids[1], &Outcome::No);
        client.resolve_scalar(&ids[2], &10_000u32);
        client.resolve(&ids[3], &Outcome::Yes);

        let pos = |id: u64| client.get_position(&id, &trader);
        assert_eq!(pos(ids[0]), pos(ids[1]));
        assert_eq!(pos(ids[2]), pos(ids[3]));

        let short_wins = pos(ids[0]).no;
        let long_wins = pos(ids[2]).yes;
        let scalar_zero = client.redeem(&trader, &ids[0]);
        let binary_no = client.redeem(&trader, &ids[1]);
        let scalar_max = client.redeem(&trader, &ids[2]);
        let binary_yes = client.redeem(&trader, &ids[3]);
        assert_eq!(scalar_zero, binary_no);
        assert_eq!(scalar_max, binary_yes);
        assert_eq!(scalar_zero, short_wins);
        assert_eq!(scalar_max, long_wins);
    }

    // ----- #9: dynamic fee model (time-to-close + skew) ---------------------

    fn fee_sched(base_bps: u32, max_bps: u32, ramp_secs: u64, skew_mult_bps: u32) -> FeeSchedule {
        FeeSchedule {
            base_bps,
            max_bps,
            ramp_secs,
            skew_mult_bps,
        }
    }

    #[test]
    fn buy_uses_dynamic_fee_near_close() {
        let (env, client, creator, trader, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(100, 1_000, 10_000, 0));
        let id = new_market(&env, &client, &creator, 5000); // closes at t = 60_000
        assert_eq!(
            client.fee_schedule(&id),
            Some(fee_sched(100, 1_000, 10_000, 0)),
            "creation snapshots the default schedule"
        );

        // outside the ramp window (opens at close - 10_000): flat base fee
        assert_eq!(client.current_fee_bps(&id), 100);
        let buy = 10 * 10_000_000_i128;
        let shares_a = client.buy(&trader, &id, &Outcome::Yes, &buy, &0_i128);
        // read events before any other invocation — only the trade's linger
        let events_a = env.events().all().filter_by_contract(&client.address);
        let m_a = client.get_market(&id);
        assert_eq!(m_a.fees_accrued, 1_000_000); // ceil(1e8 * 100 / 1e4)
        let trade_a = Trade {
            market_id: id,
            trader: trader.clone(),
            outcome: Outcome::Yes,
            is_buy: true,
            collateral: buy,
            shares: shares_a,
            fee: 1_000_000,
            reserve_yes: m_a.reserve_yes,
            reserve_no: m_a.reserve_no,
        };
        let trade_a_v2 = TradeV2 {
            market_id: id,
            trader: trader.clone(),
            outcome: Outcome::Yes,
            is_buy: true,
            collateral: buy,
            shares: shares_a,
            fee: 1_000_000,
            fee_bps: 100,
            reserve_yes: m_a.reserve_yes,
            reserve_no: m_a.reserve_no,
        };
        assert_eq!(
            events_a,
            [
                soroban_sdk::Event::to_xdr(&trade_a, &env, &client.address),
                soroban_sdk::Event::to_xdr(&trade_a_v2, &env, &client.address),
            ],
            "Trade and TradeV2 both describe the base-rate trade"
        );

        // 60s before close, inside the ramp: t = (10_000 - 60) / 10_000 of
        // the 900 bps band -> 894, so the fee is 994 bps
        env.ledger().set_timestamp(59_940);
        assert_eq!(client.current_fee_bps(&id), 994);
        let shares_b = client.buy(&trader, &id, &Outcome::Yes, &buy, &0_i128);
        let events_b = env.events().all().filter_by_contract(&client.address);
        let m_b = client.get_market(&id);
        assert_eq!(m_b.fees_accrued, 1_000_000 + 9_940_000);
        let trade_b = Trade {
            market_id: id,
            trader: trader.clone(),
            outcome: Outcome::Yes,
            is_buy: true,
            collateral: buy,
            shares: shares_b,
            fee: 9_940_000,
            reserve_yes: m_b.reserve_yes,
            reserve_no: m_b.reserve_no,
        };
        let trade_b_v2 = TradeV2 {
            market_id: id,
            trader: trader.clone(),
            outcome: Outcome::Yes,
            is_buy: true,
            collateral: buy,
            shares: shares_b,
            fee: 9_940_000,
            fee_bps: 994,
            reserve_yes: m_b.reserve_yes,
            reserve_no: m_b.reserve_no,
        };
        assert_eq!(
            events_b,
            [
                soroban_sdk::Event::to_xdr(&trade_b, &env, &client.address),
                soroban_sdk::Event::to_xdr(&trade_b_v2, &env, &client.address),
            ],
            "near close the same trade pays 10x the base fee"
        );
    }

    #[test]
    fn quote_buy_equals_buy_same_ledger() {
        let (env, client, creator, trader, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(80, 600, 3_600, 250));
        let id = new_market(&env, &client, &creator, 5000); // closes at t = 60_000

        // mid-ramp: t = 1_800/3_600 of the 520 bps band = 260 -> fee 340
        env.ledger().set_timestamp(58_200);
        assert_eq!(client.current_fee_bps(&id), 340);
        let buy = 7 * 10_000_000_i128;
        let quoted = client.quote_buy(&id, &Outcome::Yes, &buy);
        let shares = client.buy(&trader, &id, &Outcome::Yes, &buy, &0_i128);
        assert_eq!(quoted, shares, "quote and same-ledger buy must agree");

        let sell_out = 10_000_000_i128;
        let quoted_sell = client.quote_sell(&id, &Outcome::Yes, &sell_out);
        let shares_in = client.sell(&trader, &id, &Outcome::Yes, &sell_out, &i128::MAX);
        assert_eq!(quoted_sell, shares_in, "sell quote must agree too");
    }

    #[test]
    fn legacy_market_keeps_flat_fee() {
        let (env, client, creator, trader, _, _) = setup_market();
        let id = new_market(&env, &client, &creator, 5000);
        assert_eq!(client.fee_schedule(&id), None, "no default -> no snapshot");

        // a schedule set after creation never retro-fits existing markets
        client.set_default_fee_schedule(&fee_sched(900, 1_000, 0, 1_000));
        assert_eq!(client.fee_schedule(&id), None);
        assert_eq!(client.current_fee_bps(&id), 100);

        let shares = client.buy(
            &trader,
            &id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert!(shares > 0);
        assert_eq!(client.get_market(&id).fees_accrued, 1_000_000);
    }

    #[test]
    fn categorical_market_keeps_flat_fee() {
        let (env, client, creator, trader, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(900, 1_000, 0, 1_000));
        let id = new_cat_market(&env, &client, &creator, &[5000, 5000]);
        assert_eq!(
            client.current_fee_bps(&id),
            100,
            "categorical markets always charge their flat fee"
        );
        client.buy_cat(&trader, &id, &0u32, &(10 * 10_000_000_i128), &0_i128);
        assert_eq!(client.get_cat_market(&id).fees_accrued, 1_000_000);
    }

    #[test]
    fn set_default_fee_schedule_rejects_out_of_bounds() {
        let (_env, client, _, _, _, _) = setup_market();
        let cases = [
            fee_sched(500, 499, 0, 0),                         // base > max
            fee_sched(0, 1_001, 0, 0),                         // max > MAX_FEE_BPS
            fee_sched(0, 500, math::MAX_RAMP_SECS + 1, 0),     // ramp > 30 days
            fee_sched(0, 500, 0, math::MAX_SKEW_MULT_BPS + 1), // skew > cap
        ];
        for c in cases {
            assert_eq!(
                client.try_set_default_fee_schedule(&c),
                Err(Ok(Error::InvalidFee)),
                "schedule {c:?} must be rejected"
            );
        }
        // the boundary values themselves are accepted
        client.set_default_fee_schedule(&fee_sched(
            0,
            1_000,
            math::MAX_RAMP_SECS,
            math::MAX_SKEW_MULT_BPS,
        ));
    }

    #[test]
    fn wrong_caller_cannot_set_default_fee_schedule() {
        let (env, client, _, trader, _, _) = setup_market();
        let schedule = fee_sched(10, 100, 0, 0);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_fee_schedule",
                    args: (schedule,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_fee_schedule(&schedule)
            .is_err());
    }

    #[test]
    fn create_market_with_fees_snapshots_and_caps() {
        let (env, client, creator, _, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(50, 500, 1_000, 100));
        let close = env.ledger().timestamp() + 60_000;
        let args = |env: &Env, schedule: FeeSchedule| {
            (
                BytesN::from_array(env, &[22u8; 32]),
                BytesN::from_array(env, &[122u8; 32]),
                String::from_str(env, "ipfs://explicit-fees"),
                Category::Crypto,
                close,
                100 * 10_000_000_i128,
                5000u32,
                schedule,
            )
        };

        let explicit = fee_sched(20, 400, 0, 0);
        let (q, r, u, c, s, seed, yes, sch) = args(&env, explicit);
        let id = client.create_market_with_fees(&creator, &q, &r, &u, &c, &s, &seed, &yes, &sch);
        assert_eq!(client.fee_schedule(&id), Some(explicit));
        assert_eq!(client.current_fee_bps(&id), 20);

        // above the protocol policy cap (default max 500) / hard cap / invert
        for bad in [
            fee_sched(0, 501, 0, 0),
            fee_sched(0, 1_001, 0, 0),
            fee_sched(100, 50, 0, 0),
        ] {
            let (q, r, u, c, s, seed, yes, sch) = args(&env, bad);
            assert_eq!(
                client.try_create_market_with_fees(&creator, &q, &r, &u, &c, &s, &seed, &yes, &sch),
                Err(Ok(Error::InvalidFee)),
                "schedule {bad:?} must be rejected"
            );
        }
        // rejected attempts must not burn ids
        assert_eq!(client.market_count(), 1);
    }

    #[test]
    fn quote_buy_at_simulates_future_fee() {
        let (env, client, creator, trader, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(100, 1_000, 10_000, 0));
        let id = new_market(&env, &client, &creator, 5000); // closes at t = 60_000
        let buy = 5 * 10_000_000_i128;

        let now_quote = client.quote_buy(&id, &Outcome::Yes, &buy);
        let late_quote = client.quote_buy_at(&id, &Outcome::Yes, &buy, &59_999);
        assert!(late_quote < now_quote, "a later timestamp pays more fee");
        // quotes past close clamp to the ramp end instead of failing
        let after_close = client.quote_buy_at(&id, &Outcome::Yes, &buy, &60_001);
        assert!(after_close < late_quote);

        env.ledger().set_timestamp(59_999);
        let actual = client.buy(&trader, &id, &Outcome::Yes, &buy, &0_i128);
        assert_eq!(actual, late_quote, "quote_buy_at matches the later buy");
    }

    #[test]
    fn split_trades_pay_at_least_single_trade_fee_minus_rounding() {
        let (env, client, creator, trader, _, _) = setup_market();
        client.set_default_fee_schedule(&fee_sched(100, 1_000, 0, 1_000));
        let id_single = new_market(&env, &client, &creator, 5000);
        let id_split = new_market(&env, &client, &creator, 5000);
        let unit = 10_000_000_i128;

        client.buy(&trader, &id_single, &Outcome::Yes, &(10 * unit), &0_i128);
        for _ in 0..10 {
            client.buy(&trader, &id_split, &Outcome::Yes, &unit, &0_i128);
        }

        let single_fee = client.get_market(&id_single).fees_accrued;
        let split_fee = client.get_market(&id_split).fees_accrued;
        // both pools open at exactly 50/50 and pay the base rate first, so
        // the single 10-unit buy costs exactly 1_000_000 (100 bps of 1e8)
        assert_eq!(single_fee, 1_000_000);
        // every split piece pays >= the base rate, and each unit is an exact
        // 1_000x scaling, so splitting can never undercut the lump sum
        assert!(
            split_fee >= single_fee,
            "split {split_fee} < single {single_fee}"
        );
    }
}

/// Pins the exact XDR bytes behind stored binary-market state and the tag
/// order of every append-only enum. A change to field names, field order,
/// variant names, or the position of an appended variant changes the encoding
/// and strands every live market, so a failure here must never be "fixed" by
/// editing the vectors: add a new struct or an end-appended enum variant
/// instead (see the append-only note on `DataKey`). The six `u64`-payload
/// key vectors (`key_market`, `key_band`, `key_kind`, `key_cat_market`,
/// `key_scalar`, `key_fee_schedule`) are pairwise distinct, which is what
/// proves no variant moved when the categorical, scalar and fee-schedule
/// keys were appended.
#[cfg(test)]
mod golden {
    use super::*;
    use soroban_sdk::xdr::ToXdr;
    use std::{format, string::String as StdString};

    const G1: &str = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
    const G2: &str = "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW";

    fn hex_of(env: &Env, xdr: &soroban_sdk::Bytes) -> StdString {
        let hash: BytesN<32> = env.crypto().sha256(xdr).into();
        hash.to_array().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn fixed_market(env: &Env) -> Market {
        Market {
            creator: Address::from_str(env, G1),
            question_hash: BytesN::from_array(env, &[1u8; 32]),
            resolution_hash: BytesN::from_array(env, &[2u8; 32]),
            meta_uri: String::from_str(env, "ipfs://golden"),
            category: Category::Crypto,
            close_time: 1_700_000_000,
            fee_bps: 100,
            status: MarketStatus::Resolved(Outcome::Yes),
            reserve_yes: 1_234_567,
            reserve_no: 7_654_321,
            sets_minted: 8_888_888,
            fees_accrued: 1_000,
            lp_claimed: false,
        }
    }

    fn fixed_cat_market(env: &Env) -> CatMarket {
        CatMarket {
            creator: Address::from_str(env, G2),
            question_hash: BytesN::from_array(env, &[1u8; 32]),
            resolution_hash: BytesN::from_array(env, &[2u8; 32]),
            meta_uri: String::from_str(env, "ipfs://golden"),
            category: Category::Sports,
            close_time: 1_700_000_000,
            fee_bps: 100,
            status: CatStatus::Resolved(2),
            reserves: Vec::from_slice(env, &[11i128, 22, 33]),
            sets_minted: 44,
            fees_accrued: 5,
            lp_claimed: true,
        }
    }

    #[test]
    fn storage_encoding_matches_golden_vectors() {
        let env = Env::default();
        let vectors: &[(&str, soroban_sdk::Bytes, &str)] = &[
            (
                "market",
                fixed_market(&env).to_xdr(&env),
                "36188085f458f8786a726cbb5e0e08ef6904e4374fbbbf3e7de03907820b0339",
            ),
            (
                "cat_market",
                fixed_cat_market(&env).to_xdr(&env),
                "27a6f739035f3c381e5059fcd136bbae2900664b9c5ba0f20ea1bf93aa3bccf9",
            ),
            (
                "position",
                Position { yes: 5, no: 6 }.to_xdr(&env),
                "40a402f6a3cc8da11230556272326a297af445d24981444ee3155354096735c0",
            ),
            (
                "cat_position",
                CatPosition {
                    balances: Vec::from_slice(&env, &[7i128, 8, 9]),
                }
                .to_xdr(&env),
                "7a72eca94d0dd95da8d6af1c9403d91751010a1a80d555ed82893816aa8f26eb",
            ),
            (
                "fee_terms",
                FeeTerms {
                    recipient: Address::from_str(&env, G1),
                    protocol_share_bps: 5_000,
                }
                .to_xdr(&env),
                "dd4e5aff38dae3986b90290f57c5e6604b603b4be9466aa078d7a4ab1e6fc6d2",
            ),
            (
                "status_open",
                MarketStatus::Open.to_xdr(&env),
                "f5bb24256f8d569f3e445b6fdb70770cb4e3c5a7b153bcb99bdeec43d7d15a32",
            ),
            (
                "status_resolved_yes",
                MarketStatus::Resolved(Outcome::Yes).to_xdr(&env),
                "2b321394eba29f0c5f18fd2a221d68da481a61805ccd42b5ab26689fb66e7a05",
            ),
            (
                "status_resolved_no",
                MarketStatus::Resolved(Outcome::No).to_xdr(&env),
                "bc79cb5737cf6e7a62d6cea95f96197f02826e3abfe1de0b36d8c26240d09d5e",
            ),
            (
                "status_void",
                MarketStatus::Void.to_xdr(&env),
                "84fb1b711f446432537ce5420b5b68f7e7fcc259b43b4fd1cd33ba2cfa3bc847",
            ),
            (
                "status_resolved_scalar",
                MarketStatus::ResolvedScalar(6_250).to_xdr(&env),
                "4f228882af5807e96236df11e60796ad737ead4e5a8e18a3d72a29a1a1500321",
            ),
            (
                "cat_open",
                CatStatus::Open.to_xdr(&env),
                "f5bb24256f8d569f3e445b6fdb70770cb4e3c5a7b153bcb99bdeec43d7d15a32",
            ),
            (
                "cat_resolved",
                CatStatus::Resolved(2).to_xdr(&env),
                "1affbe5b375f59f3eb26c012a92d4694d50ca88b55d070c193a60b891ba6f003",
            ),
            (
                "cat_void",
                CatStatus::Void.to_xdr(&env),
                "84fb1b711f446432537ce5420b5b68f7e7fcc259b43b4fd1cd33ba2cfa3bc847",
            ),
            (
                "kind_binary",
                MarketKind::Binary.to_xdr(&env),
                "2c4dbaa6a4d48e791b13a8ace9144759ebc4eccaed186c20ab8eb644d152c147",
            ),
            (
                "kind_categorical",
                MarketKind::Categorical(8).to_xdr(&env),
                "f36c32da22305b016f5397af49f91f8afe624c3c604b9007194c2d150c97c8e1",
            ),
            (
                "key_admin",
                DataKey::Admin.to_xdr(&env),
                "c551fd4e3b592f8f79eb0e6d45db3ef38efaff551e0f97ad2f8179a51ce1706e",
            ),
            (
                "key_collateral",
                DataKey::Collateral.to_xdr(&env),
                "be058f1cb09249de00e6f9c9317c9eb05695901ac133b690a633c3ccc8d0e746",
            ),
            (
                "key_treasury",
                DataKey::Treasury.to_xdr(&env),
                "2c3c4d715ae64eb2118c999c11d775074ef37164e99c5886f14066734b268079",
            ),
            (
                "key_resolver",
                DataKey::Resolver.to_xdr(&env),
                "220e075fa80aa713117ff5c970b113b23fe3101492c7f615a9199f0d009662c1",
            ),
            (
                "key_default_fee_bps",
                DataKey::DefaultFeeBps.to_xdr(&env),
                "5757b4fac1b45e48d21f51c49f2001d79cfa537e4e66c1c20ba177226abf96ac",
            ),
            (
                "key_protocol_fee_share_bps",
                DataKey::ProtocolFeeShareBps.to_xdr(&env),
                "99f2c34332a3a712c42188a99cdcc27e2b4df902520bd82958436f5ad2eb00b1",
            ),
            (
                "key_default_breaker",
                DataKey::DefaultBreaker.to_xdr(&env),
                "27a5c8f3ec0b32815e01af29c993d0e81434a9c956b1862ce60a37775577a442",
            ),
            (
                "key_paused",
                DataKey::Paused.to_xdr(&env),
                "a2c6f2f4702c89a770af96e0f55eea0899b67fa595bf8791c1c804a30ff930ac",
            ),
            (
                "key_next_id",
                DataKey::NextId.to_xdr(&env),
                "79dcd4a0e0d838ee8fd46ded92313aaf4bed264c9aa239efd693bae70330aa6f",
            ),
            (
                "key_market",
                DataKey::Market(7).to_xdr(&env),
                "9468d585aeb83df47ea506d9f44a1b86af6b3c46f85b5e876d9aaf5ac683ba3d",
            ),
            (
                "key_position",
                DataKey::Position(7, Address::from_str(&env, G1)).to_xdr(&env),
                "389be98ced1e5bda6c6fccc2fab7e688a757770474dd47023728dbe9abccaf99",
            ),
            (
                "key_fee_terms",
                DataKey::FeeTerms(7).to_xdr(&env),
                "49d98204299a993c50e4e168d913a24bba1082e97df589c97523ad3438d52564",
            ),
            (
                "key_lp_fees",
                DataKey::LpFees(7).to_xdr(&env),
                "382ddac8a43bcca866ff597742e3837f7361df84a7f37f11666d0713cb404761",
            ),
            (
                "key_breaker",
                DataKey::Breaker(7).to_xdr(&env),
                "cf71f552b57ae9706bed63643a832bb463163267063da6472d351f5f759fcc11",
            ),
            (
                "key_band",
                DataKey::Band(7).to_xdr(&env),
                "0cfc353eaf950432b76cc69f5c4b3c81125a9c027a736c8194839c3cfb37e04e",
            ),
            (
                "key_kind",
                DataKey::Kind(7).to_xdr(&env),
                "e024376fceb4ca0a8d2f4e24564361d9ede75ad0de688939ea36b23b4868ad35",
            ),
            (
                "key_cat_market",
                DataKey::CatMarket(7).to_xdr(&env),
                "ecc36fe74d9bb69ab421b662dc27d95863838a5c75718b11e696a1213d888a79",
            ),
            (
                "key_cat_position",
                DataKey::CatPosition(7, Address::from_str(&env, G1)).to_xdr(&env),
                "abe25f5135bf271f295ab53dea568e9ed8733b7b2e95d92daead139b3fdb6f83",
            ),
            (
                "key_scalar",
                DataKey::Scalar(7).to_xdr(&env),
                "c37848092184e76aa7e4f3ef72f6255068d91b57286a1f63bef9be9007620234",
            ),
            (
                "scalar_meta",
                ScalarMeta {
                    lower: 100_000_000,
                    upper: 250_000_000,
                }
                .to_xdr(&env),
                "0c8fa296ba44740c03754de99e5ce49eca58515891147d50ab2cbac7a6da98d0",
            ),
            (
                "key_fee_schedule",
                DataKey::FeeSchedule(7).to_xdr(&env),
                "28ad21a72d90132aa173d68e3b5fb58b2c75df13ae78e40ad87f0001b16288ad",
            ),
            (
                "key_default_fee_schedule",
                DataKey::DefaultFeeSchedule.to_xdr(&env),
                "50c22f14b3c7648ecff9a9a8a5d98a91c2dc2b833fb685790288c59689c2d220",
            ),
            (
                "fee_schedule",
                FeeSchedule {
                    base_bps: 100,
                    max_bps: 1_000,
                    ramp_secs: 86_400,
                    skew_mult_bps: 500,
                }
                .to_xdr(&env),
                "11b04b09c719862e0a9f2b8f9689c38c302f4ac02d7f9d92ab84e14f99c1a608",
            ),
        ];
        for (label, xdr, expected) in vectors {
            assert_eq!(&hex_of(&env, xdr), expected, "{label} encoding moved");
        }
        // identical tag+payload pairs legitimately hash the same; the six
        // u64-payload keys above must all differ, proving no tag shifted
        let u64_keys = [
            hex_of(&env, &DataKey::Market(7).to_xdr(&env)),
            hex_of(&env, &DataKey::Band(7).to_xdr(&env)),
            hex_of(&env, &DataKey::Kind(7).to_xdr(&env)),
            hex_of(&env, &DataKey::CatMarket(7).to_xdr(&env)),
            hex_of(&env, &DataKey::Scalar(7).to_xdr(&env)),
            hex_of(&env, &DataKey::FeeSchedule(7).to_xdr(&env)),
        ];
        for i in 0..u64_keys.len() {
            for j in (i + 1)..u64_keys.len() {
                assert_ne!(u64_keys[i], u64_keys[j], "DataKey tags collided");
            }
        }
    }
}
