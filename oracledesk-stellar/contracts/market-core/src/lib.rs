#![no_std]

mod math;
#[cfg(kani)]
mod math_proofs;
pub mod ttl;

use math::{MathError, Settlement, BPS, MAX_SETS};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String, Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Fee ceiling: 10%.
const MAX_FEE_BPS: u32 = 1_000;
/// Minimum seed liquidity: 100 USDC (7 decimals). Stops spam markets.
const MIN_SEED: i128 = 100 * 10_000_000;

/// Redemption-window bounds, in seconds. A holder cannot be forced to redeem
/// within weeks of resolution (180-day floor), and a market cannot sit
/// waitable-forever (5-year ceiling). The 365-day default is snapshotted
/// into each market at creation, so an admin change never moves an
/// existing deadline.
const DEFAULT_REDEEM_HORIZON_SECS: u64 = 365 * ttl::DAY_SECS;
const MIN_REDEEM_HORIZON_SECS: u64 = 180 * ttl::DAY_SECS;
const MAX_REDEEM_HORIZON_SECS: u64 = 1_825 * ttl::DAY_SECS;

/// Observations kept per market for the TWAP ring buffer (issue #11). One
/// observation is written per distinct trade timestamp; a consumer asking
/// for a time older than the oldest surviving observation gets
/// `ObservationTooOld` instead of a wrong answer.
const ORACLE_RING: u32 = 16;

/// Markets one `redeem_many` / `claim_pool_remainders` call may settle.
///
/// Measured with `measure_redeem_many_resources` (see the tests; run it
/// explicitly with `--ignored --nocapture` to regenerate) and checked
/// against the network per-transaction limits below, keeping every figure
/// under 75% of its limit for headroom. Each market adds 3 read entries
/// (Market, Position, Settle) and 2 write entries (Position removed, Settle
/// updated); the aggregated transfer and the instance entries are shared
/// across the batch.
///
/// LIMITS (mainnet snapshot 2026-07-10, enforced by the test env — see
/// `InvocationResourceLimits::mainnet()` in the SDK):
///   instructions 400,000,000 | memory 41,943,040 B | disk read entries 200
///   | write entries 200 | ledger entries 400 (footprint total) | read bytes
///   200,000 | write bytes 132,096 | contract events 16,384 B
/// MEASURED, batch of N (direct market-core call, one holder, every
/// position redeemable; live entries, so `footprint` = reads + writes):
///    N |    insns |    mem B | reads | writes | footprint | write B | events B
///    1 |  409,515 |   55,861 |    10 |      5 |        15 |     840 |      404
///    5 |1,258,619 |  163,347 |    22 |     13 |        35 |   2,120 |    1,076
///   10 |2,586,602 |  355,282 |    37 |     23 |        60 |   3,720 |    1,916
///   20 |6,133,201 |  931,077 |    67 |     43 |       110 |   6,920 |    3,596
///   30 |10,687,968|1,762,772 |    97 |     63 |       160 |  10,120 |    5,276
///   40 |16,308,578|2,850,367 |   127 |     83 |       210 |  13,320 |    6,956
///   45 |19,448,071|3,490,127 |   142 |     93 |       235 |  14,920 |    7,796
///   46 |20,093,044|3,625,756 |   145 |     95 |       240 |  15,240 |    7,964
/// Rows are the direct market-core call; the treasury wrappers add a
/// constant two read entries (their own config and instance entries) and no
/// extra writes — measured at this cap by
/// `measure_treasury_redeem_many_resources` in `contracts/treasury`:
/// N=46 treasury path = 147 reads, 95 writes, 242 footprint, 33.1M insns,
/// 15,240 write B, 7,964 event B.
/// At N=46 the live-state binding axis (footprint, 5N+10) sits at 240/400 =
/// 60% of the ledger-entry limit; the other entry axes are write entries
/// 95/200 = 47.5% and events 7,964/16,384 = 49%, while instructions (5-8%),
/// memory (9-13%) and write bytes (12%) stay far below.
/// Worst case, if the touched entries had to be restored from disk (archived
/// state), the 3N+7 reads would hit the 200-entry disk-read limit at
/// 147/200 = 73.5% on the treasury path (145/200 = 72.5% direct) — under
/// the 75% headroom line with room left for the transaction overhead this
/// harness cannot see (auth entries, source account). N=47 would measure
/// exactly 150/200 = 75.0% with zero margin, so 46 is the largest
/// defensible cap.
const MAX_BATCH: u32 = 46;
/// A proposed admin handover must be accepted (or cancelled) within this many
/// seconds, so a proposal forgotten by the outgoing admin cannot be used to
/// seize control months later. 7 days.
const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;

// ---------------------------------------------------------------------------
// Types shared with the frontend/backend
// ---------------------------------------------------------------------------
// The canonical definitions live in `oracledesk-types` and are re-exported
// here so every consumer (contracts, generated bindings, off-chain tooling)
// sees one Rust type. `#[contracttype]` still exports them into this
// contract's spec, so generated TypeScript bindings are unchanged.
pub use oracledesk_types::{Category, MarketStatus, Outcome};

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

/// Per-market settlement bookkeeping (issue #14). Lives in its own entry so
/// the `Market` XDR stays unchanged.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleState {
    /// Outcome shares held outside the pool (user positions), still
    /// redeemable. `redeem` decrements the redeeming holder's shares on both
    /// sides, so a losing-side redemption (payout 0) still clears here.
    pub outstanding_yes: i128,
    pub outstanding_no: i128,
    /// Timestamp of `resolve` / `void_market`; 0 while the market is Open.
    pub finalized_at: u64,
    /// Redemption window, snapshotted at creation from the admin default.
    /// `redeem_deadline = finalized_at + horizon_secs`.
    pub horizon_secs: u64,
    /// Collateral already paid to holders and the LP (`redeem` +
    /// `claim_pool_remainder` payouts); tracks what has left the market.
    pub paid_out: i128,
    /// `finalize_market` has swept the market's remaining balance; no
    /// redemption or claim can ever pay out again.
    pub closed: bool,
}

/// Per-market TWAP accumulator (issue #11). Lives in its own entry so the
/// `Market` XDR stays unchanged.
///
/// Semantics: at the start of every trade the price that held since the last
/// trade is folded into `price_cumulative` over the elapsed interval; the
/// post-trade price then becomes `last_price_bps` until the next trade. That
/// is the Uniswap-v2 model, and it is what makes manipulation expensive —
/// moving the average requires holding the price away from fair value across
/// one or more ledger boundaries, not just within a single transaction.
///
/// Overflow analysis: `last_price_bps <= 10_000` and each interval adds
/// `price * dt` seconds. A 100-year market lifetime accumulates at most
/// `10_000 * 3.2e9 ~ 3.2e13`; even a pathological `dt = u64::MAX` gives
/// `1.8e19 * 1e4 = 1.8e23`. `i128::MAX` is ~1.7e38, so there is no feasible
/// lifetime that overflows — and every step is `checked_*` anyway, so a
/// violation rejects the transaction instead of corrupting the accumulator.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleState {
    /// Running sum of `last_price_bps * seconds_elapsed` since creation.
    pub price_cumulative: i128,
    /// Timestamp the accumulator was last advanced to (the timestamp of the
    /// most recent trade). The last traded price holds from here onward.
    pub last_ts: u64,
    /// YES price in bps as of the most recent trade.
    pub last_price_bps: u32,
    /// Ring slot of the newest observation, in `0..ORACLE_RING`.
    pub obs_index: u32,
    /// Observations written so far, capped at `ORACLE_RING`.
    pub obs_count: u32,
}

/// One point in the TWAP ring buffer. At most one per distinct timestamp.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Observation {
    pub ts: u64,
    /// `OracleState::price_cumulative` as of `ts`.
    pub cumulative: i128,
}

/// Why a market in a batch call did not settle. `Duplicate` is reserved:
/// ids are validated strictly ascending first, so a duplicate is rejected
/// as `InvalidAmount` before the batch runs and never reaches a skip.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkipReason {
    NotFound,
    NotFinal,
    NothingToRedeem,
    AlreadyClaimed,
    NotCreator,
    Duplicate,
}

/// Per-market result of a batch settlement.
///
/// This union stands in for the `Option<SkipReason>` sketched in the issue:
/// a `#[contracttype]` struct field of type `Option<CustomType>` does not
/// compile under the `testutils` feature (on for every `cargo test` build).
/// The derive emits an xdr conversion gated on `CustomType: Into<ScVal>`,
/// but `#[contracttype]` enums only derive `TryFrom`, and the missing impls
/// cannot be supplied from this crate: `From<Enum> for ScVal` collides with
/// the derive's own `TryFrom` through core's blanket impl (E0119), and
/// `TryFrom<&Option<Enum>> for ScVal` violates the orphan rule (E0117).
/// The union carries the same information and surfaces as a discriminated
/// union in the generated TS bindings.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BatchStatus {
    /// The market settled and paid `BatchItem::payout`.
    Settled,
    /// The market was skipped; `BatchItem::payout` is 0.
    Skipped(SkipReason),
}

/// One market's outcome inside a `BatchResult`, in request order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchItem {
    pub market_id: u64,
    pub payout: i128,
    pub status: BatchStatus,
}

/// Result of `redeem_many` / `claim_pool_remainders`: `total` is the single
/// aggregated transfer, `items` has one entry per requested market in the
/// same order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchResult {
    pub total: i128,
    pub items: Vec<BatchItem>,
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

/// A proposed admin handover (#62). Absent when no transfer is pending.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub address: Address,
    pub expires_at: u64,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    // instance storage (one entry, shared TTL): global config
    Admin,
    PendingAdmin,
    Collateral,
    Treasury,
    Resolver,
    PendingResolver,
    PendingTreasury,
    DefaultFeeBps,
    ProtocolFeeShareBps,
    DefaultBreaker,
    Paused,
    NextId,
    DefaultRedeemHorizon,
    // persistent storage (one entry each, own TTL)
    Market(u64),
    Position(u64, Address),
    Settle(u64),
    Oracle(u64),
    Obs(u64, u32),
    FeeTerms(u64),
    LpFees(u64),
    Breaker(u64),
    // temporary storage (expires on its own, one entry per market)
    Band(u64),
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
    NoPendingWiring = 23,
    InvalidWiring = 24,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 25,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 26,
    /// `observe` / `twap` asked for a time older than every surviving
    /// observation of the market (the ring keeps the most recent 16).
    ObservationTooOld = 27,
    /// `finalize_market` called before the redemption deadline.
    RedemptionWindowOpen = 28,
    /// Market already closed by `finalize_market`; redemption is over.
    RedemptionClosed = 29,
    /// Legacy market created before `SettleState` existed: outstanding shares
    /// cannot be reconstructed on-chain, so it has no deadline and cannot be
    /// finalized (still fully redeemable).
    NotSupported = 30,
    /// A batch call carried no ids or more than `MAX_BATCH` of them.
    BatchTooLarge = 31,
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

#[contractevent]
pub struct MarketFinalized {
    #[topic]
    pub market_id: u64,
    /// Everything swept to the treasury: expired user claims, an unclaimed
    /// LP remainder, rounding dust and accrued fees.
    pub swept: i128,
    /// The part of `swept` that was reserved for shares never redeemed.
    pub unclaimed_user: i128,
    /// Rounding left over after per-holder void floors were accounted for.
    pub dust: i128,
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
pub struct ResolverProposed {
    pub resolver: Address,
}
#[contractevent]
pub struct ResolverChanged {
    pub old: Address,
    pub new: Address,
}
#[contractevent]
pub struct TreasuryProposed {
    pub treasury: Address,
}

#[contractevent]
pub struct AdminTransferProposed {
    pub new_admin: Address,
}
#[contractevent]
pub struct AdminTransferred {
    pub old: Address,
    pub new: Address,
}
#[contractevent]
pub struct AdminTransferCancelled {}

#[soroban_sdk::contractclient(name = "WiringPeerClient")]
pub trait WiringPeer {
    fn market_core(env: Env) -> Address;
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
        s.set(&DataKey::DefaultRedeemHorizon, &DEFAULT_REDEEM_HORIZON_SECS);
    }

    // ----- admin ----------------------------------------------------------

    /// Starts a two-step handover of the admin role. The new admin must call
    /// `accept_admin` itself, so a typo cannot hand control to an address
    /// nobody holds.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(
            &DataKey::PendingAdmin,
            &PendingAdmin {
                address: new_admin.clone(),
                expires_at: env.ledger().timestamp() + ADMIN_PROPOSAL_TTL_SECS,
            },
        );
        AdminTransferProposed { new_admin }.publish(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = Self::load_pending(&env).ok_or(Error::NoPendingAdmin)?;
        if env.ledger().timestamp() > pending.expires_at {
            return Err(Error::PendingAdminExpired);
        }
        pending.address.require_auth();
        let old: Address = Self::instance_get(&env, &DataKey::Admin)?;
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &pending.address);
        s.remove(&DataKey::PendingAdmin);
        AdminTransferred {
            old,
            new: pending.address,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::load_pending(&env).is_none() {
            return Err(Error::NoPendingAdmin);
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        AdminTransferCancelled {}.publish(&env);
        Ok(())
    }

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

    pub fn propose_resolver(env: Env, resolver: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingResolver, &resolver);
        ResolverProposed { resolver }.publish(&env);
        Ok(())
    }

    pub fn accept_resolver(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingResolver)
            .ok_or(Error::NoPendingWiring)?;
        pending.require_auth();
        if WiringPeerClient::new(&env, &pending).market_core() != env.current_contract_address() {
            return Err(Error::InvalidWiring);
        }
        let old: Address = Self::instance_get(&env, &DataKey::Resolver)?;
        env.storage().instance().set(&DataKey::Resolver, &pending);
        env.storage().instance().remove(&DataKey::PendingResolver);
        ResolverChanged { old, new: pending }.publish(&env);
        Ok(())
    }

    /// Affects markets created after the call and the legacy fallback in
    /// `sweep_fees`. Markets with a snapshotted `FeeTerms` keep paying their
    /// original recipient.
    pub fn propose_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingTreasury, &treasury);
        TreasuryProposed { treasury }.publish(&env);
        Ok(())
    }

    pub fn accept_treasury(env: Env) -> Result<(), Error> {
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingTreasury)
            .ok_or(Error::NoPendingWiring)?;
        treasury.require_auth();
        if WiringPeerClient::new(&env, &treasury).market_core() != env.current_contract_address() {
            return Err(Error::InvalidWiring);
        }
        let old: Address = Self::instance_get(&env, &DataKey::Treasury)?;
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().remove(&DataKey::PendingTreasury);
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

    /// Affects markets created after the call; existing markets keep the
    /// horizon snapshotted at their creation. Must be within
    /// [180 days, 1825 days].
    pub fn set_default_redeem_horizon(env: Env, secs: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if !(MIN_REDEEM_HORIZON_SECS..=MAX_REDEEM_HORIZON_SECS).contains(&secs) {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::DefaultRedeemHorizon, &secs);
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
        let seed = math::seed_reserves(seed_amount, initial_yes_bps)?;

        let s = env.storage().instance();
        let id: u64 = s.get(&DataKey::NextId).ok_or(Error::NotInitialized)?;
        s.set(&DataKey::NextId, &(id + 1));
        let fee_bps: u32 = s
            .get(&DataKey::DefaultFeeBps)
            .ok_or(Error::NotInitialized)?;
        let horizon_secs: u64 = s
            .get(&DataKey::DefaultRedeemHorizon)
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
                market.close_time,
            );
        }
        // The creator's seed shares count as *user* outstanding, not pool.
        let settle = SettleState {
            outstanding_yes: seed.creator_yes,
            outstanding_no: seed.creator_no,
            finalized_at: 0,
            horizon_secs,
            paid_out: 0,
            closed: false,
        };
        Self::debug_assert_share_invariant(&market, &settle);
        Self::save_settle(&env, id, &settle);

        // TWAP accumulator: cumulative 0 at creation; the seeded price holds
        // from here until the first trade (slot 0 is the creation point).
        let now = env.ledger().timestamp();
        let oracle = OracleState {
            price_cumulative: 0,
            last_ts: now,
            last_price_bps: math::price_yes_bps(market.reserve_yes, market.reserve_no)? as u32,
            obs_index: 0,
            obs_count: 1,
        };
        Self::save_oracle(&env, id, &oracle, market.close_time);
        Self::save_obs(
            &env,
            id,
            0,
            &Observation {
                ts: now,
                cumulative: 0,
            },
            market.close_time,
        );

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
        Self::assert_not_paused(&env)?;
        if let Some(limit) = limit_price_bps {
            if limit as i128 > BPS {
                return Err(Error::InvalidAmount);
            }
        }
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;
        // TWAP: fold the pre-trade price over the elapsed interval before
        // reserves move; `last_price_bps` is refreshed from the post-trade
        // reserves below and the state is persisted once (issue #11).
        let mut oracle = Self::load_oracle_opt(&env, market_id, m.close_time);
        if let Some(st) = oracle.as_mut() {
            Self::accumulate(&env, market_id, &m, st)?;
        }

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
        let mut pos = Self::load_position(&env, market_id, &trader, m.close_time);
        match outcome {
            Outcome::Yes => pos.yes += q.shares_out,
            Outcome::No => pos.no += q.shares_out,
        }
        Self::save_position(&env, market_id, &trader, &pos, m.close_time);
        Self::save_market(&env, market_id, &m);
        if let Some(mut st) = oracle {
            st.last_price_bps = math::price_yes_bps(m.reserve_yes, m.reserve_no)? as u32;
            Self::save_oracle(&env, market_id, &st, m.close_time);
        }
        // Legacy markets (no `Settle` entry) predate this bookkeeping.
        if let Some(mut settle) = Self::load_settle_opt(&env, market_id) {
            match outcome {
                Outcome::Yes => {
                    settle.outstanding_yes = settle
                        .outstanding_yes
                        .checked_add(q.shares_out)
                        .ok_or(Error::Overflow)?
                }
                Outcome::No => {
                    settle.outstanding_no = settle
                        .outstanding_no
                        .checked_add(q.shares_out)
                        .ok_or(Error::Overflow)?
                }
            }
            Self::debug_assert_share_invariant(&m, &settle);
            Self::save_settle(&env, market_id, &settle);
        }

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
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;
        // TWAP: same rule as `buy` — fold the pre-trade price in first, then
        // refresh `last_price_bps` from the post-trade reserves below.
        let mut oracle = Self::load_oracle_opt(&env, market_id, m.close_time);
        if let Some(st) = oracle.as_mut() {
            Self::accumulate(&env, market_id, &m, st)?;
        }

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

        let mut pos = Self::load_position(&env, market_id, &trader, m.close_time);
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
        Self::save_position(&env, market_id, &trader, &pos, m.close_time);
        Self::set_reserves(&mut m, outcome, q.new_reserve_sold, q.new_reserve_other);
        m.sets_minted = m.sets_minted.checked_sub(q.gross).ok_or(Error::Overflow)?;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        Self::save_market(&env, market_id, &m);
        if let Some(mut st) = oracle {
            st.last_price_bps = math::price_yes_bps(m.reserve_yes, m.reserve_no)? as u32;
            Self::save_oracle(&env, market_id, &st, m.close_time);
        }
        if let Some(mut settle) = Self::load_settle_opt(&env, market_id) {
            match outcome {
                Outcome::Yes => {
                    settle.outstanding_yes = settle
                        .outstanding_yes
                        .checked_sub(q.shares_in)
                        .ok_or(Error::Overflow)?
                }
                Outcome::No => {
                    settle.outstanding_no = settle
                        .outstanding_no
                        .checked_sub(q.shares_in)
                        .ok_or(Error::Overflow)?
                }
            }
            Self::debug_assert_share_invariant(&m, &settle);
            Self::save_settle(&env, market_id, &settle);
        }

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
        Self::mark_finalized(&env, market_id);
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
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        m.status = MarketStatus::Void;
        Self::save_market(&env, market_id, &m);
        Self::mark_finalized(&env, market_id);
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
        holder.require_auth();
        let m = Self::load_market(&env, market_id)?;
        let kind = Self::settlement(&m)?;
        if let Some(settle) = Self::load_settle_opt(&env, market_id) {
            if settle.closed {
                return Err(Error::RedemptionClosed);
            }
        }
        let pos = Self::load_position(&env, market_id, &holder, m.close_time);
        if pos.yes == 0 && pos.no == 0 {
            return Err(Error::NothingToRedeem);
        }
        let payout = math::settle_value(kind, pos.yes, pos.no);

        Self::save_position(
            &env,
            market_id,
            &holder,
            &Position { yes: 0, no: 0 },
            m.close_time,
        );
        // Both sides decrement even when only one pays: the shares are no
        // longer outstanding, so a losing-side redemption still clears here.
        if let Some(mut settle) = Self::load_settle_opt(&env, market_id) {
            settle.outstanding_yes = settle
                .outstanding_yes
                .checked_sub(pos.yes)
                .ok_or(Error::Overflow)?;
            settle.outstanding_no = settle
                .outstanding_no
                .checked_sub(pos.no)
                .ok_or(Error::Overflow)?;
            settle.paid_out = settle.paid_out.checked_add(payout).ok_or(Error::Overflow)?;
            Self::save_settle(&env, market_id, &settle);
        }
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
        if let Some(settle) = Self::load_settle_opt(&env, market_id) {
            if settle.closed {
                return Err(Error::RedemptionClosed);
            }
        }
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
        if let Some(mut settle) = Self::load_settle_opt(&env, market_id) {
            settle.paid_out = settle.paid_out.checked_add(payout).ok_or(Error::Overflow)?;
            Self::save_settle(&env, market_id, &settle);
        }
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

    /// Redeems `holder`'s positions across up to `MAX_BATCH` final markets
    /// with one collateral transfer. `market_ids` must be strictly ascending
    /// (`InvalidAmount` otherwise; empty or over-cap is `BatchTooLarge`) so
    /// the footprint is deterministic and duplicates are impossible.
    ///
    /// Markets that cannot pay do not abort the batch; they come back in
    /// `items` with a `SkipReason`. In particular an archived `Market` entry
    /// is NOT `NotFound` — the transaction fails at footprint time and the
    /// market must be restored first (simulation shows this before
    /// submission). `holder.require_auth()` covers the whole batch: the
    /// signed payload is the `market_ids` vector itself.
    pub fn redeem_many(
        env: Env,
        holder: Address,
        market_ids: Vec<u64>,
    ) -> Result<BatchResult, Error> {
        holder.require_auth();
        Self::validate_batch(&market_ids)?;
        let mut total: i128 = 0;
        let mut items: Vec<BatchItem> = Vec::new(&env);
        for id in market_ids.iter() {
            let key = DataKey::Market(id);
            // Raw read: a market that ends up skipped must not pay a TTL
            // bump, and a missing entry must skip rather than revert.
            let m = match env.storage().persistent().get::<_, Market>(&key) {
                Some(m) => m,
                None => {
                    items.push_back(Self::batch_skip(id, SkipReason::NotFound));
                    continue;
                }
            };
            let kind = match Self::settlement(&m) {
                Ok(kind) => kind,
                Err(_) => {
                    items.push_back(Self::batch_skip(id, SkipReason::NotFinal));
                    continue;
                }
            };
            if Self::settle_closed(&env, id) {
                // `finalize_market` swept this market: redemption is over.
                items.push_back(Self::batch_skip(id, SkipReason::NothingToRedeem));
                continue;
            }
            let pos = Self::load_position(&env, id, &holder, m.close_time);
            if pos.yes == 0 && pos.no == 0 {
                items.push_back(Self::batch_skip(id, SkipReason::NothingToRedeem));
                continue;
            }
            ttl::bump_persistent(&env, &key, ttl::market_target(&env, m.close_time));
            let payout = math::settle_value(kind, pos.yes, pos.no);
            Self::save_position(&env, id, &holder, &Position { yes: 0, no: 0 }, m.close_time);
            // Both sides decrement even when only one pays (same as the
            // single-market path).
            if let Some(mut settle) = Self::load_settle_opt(&env, id) {
                settle.outstanding_yes = settle
                    .outstanding_yes
                    .checked_sub(pos.yes)
                    .ok_or(Error::Overflow)?;
                settle.outstanding_no = settle
                    .outstanding_no
                    .checked_sub(pos.no)
                    .ok_or(Error::Overflow)?;
                settle.paid_out = settle.paid_out.checked_add(payout).ok_or(Error::Overflow)?;
                Self::save_settle(&env, id, &settle);
            }
            total = total.checked_add(payout).ok_or(Error::Overflow)?;
            Redeemed {
                market_id: id,
                holder: holder.clone(),
                payout,
            }
            .publish(&env);
            items.push_back(BatchItem {
                market_id: id,
                payout,
                status: BatchStatus::Settled,
            });
        }
        if total > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &holder, &total);
        }
        Ok(BatchResult { total, items })
    }

    /// Claims the LP pool remainder for up to `MAX_BATCH` markets the
    /// `creator` owns, with one collateral transfer. Same ordering and skip
    /// semantics as `redeem_many`. A market closed by `finalize_market`
    /// reports `AlreadyClaimed` — the sweep already took the remainder.
    pub fn claim_pool_remainders(
        env: Env,
        creator: Address,
        market_ids: Vec<u64>,
    ) -> Result<BatchResult, Error> {
        creator.require_auth();
        Self::validate_batch(&market_ids)?;
        let mut total: i128 = 0;
        let mut items: Vec<BatchItem> = Vec::new(&env);
        for id in market_ids.iter() {
            let mut m = match env
                .storage()
                .persistent()
                .get::<_, Market>(&DataKey::Market(id))
            {
                Some(m) => m,
                None => {
                    items.push_back(Self::batch_skip(id, SkipReason::NotFound));
                    continue;
                }
            };
            if m.creator != creator {
                items.push_back(Self::batch_skip(id, SkipReason::NotCreator));
                continue;
            }
            let kind = match Self::settlement(&m) {
                Ok(kind) => kind,
                Err(_) => {
                    items.push_back(Self::batch_skip(id, SkipReason::NotFinal));
                    continue;
                }
            };
            if m.lp_claimed || Self::settle_closed(&env, id) {
                items.push_back(Self::batch_skip(id, SkipReason::AlreadyClaimed));
                continue;
            }
            let pool_value = math::settle_value(kind, m.reserve_yes, m.reserve_no);
            let payout = pool_value
                .checked_add(Self::load_lp_fees(&env, id))
                .ok_or(Error::Overflow)?;
            Self::save_lp_fees(&env, id, 0);
            m.reserve_yes = 0;
            m.reserve_no = 0;
            m.lp_claimed = true;
            Self::save_market(&env, id, &m);
            if let Some(mut settle) = Self::load_settle_opt(&env, id) {
                settle.paid_out = settle.paid_out.checked_add(payout).ok_or(Error::Overflow)?;
                Self::save_settle(&env, id, &settle);
            }
            total = total.checked_add(payout).ok_or(Error::Overflow)?;
            PoolRemainderClaimed {
                market_id: id,
                creator: creator.clone(),
                payout,
            }
            .publish(&env);
            items.push_back(BatchItem {
                market_id: id,
                payout,
                status: BatchStatus::Settled,
            });
        }
        if total > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &creator, &total);
        }
        Ok(BatchResult { total, items })
    }

    /// Permissionless close-out of a final market after its redemption
    /// deadline. Sweeps the market's entire remaining balance — value
    /// reserved for shares never redeemed, an unclaimed LP remainder,
    /// per-holder rounding dust and accrued fees — to the treasury, and
    /// marks the market closed so nothing can ever pay out again.
    ///
    /// The deadline is `redeem_deadline(market_id)` = `finalized_at +
    /// horizon_secs`, the horizon being snapshotted at creation from the
    /// admin default. Anyone who redeems before the deadline is paid the
    /// exact `settle_value` they would have received without this call;
    /// only shares still unredeemed at the deadline are forfeit, and their
    /// value goes to the treasury rather than the LP so the LP cannot
    /// profit from suppressing redemptions.
    ///
    /// Returns the amount swept. The swept total is exactly the market's
    /// contract balance: sets plus fees minus everything already paid out.
    pub fn finalize_market(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        let kind = Self::settlement(&m)?;
        let mut settle = Self::load_settle(&env, market_id)?;
        if settle.closed {
            return Err(Error::RedemptionClosed);
        }
        if env.ledger().timestamp() < settle.finalized_at.saturating_add(settle.horizon_secs) {
            return Err(Error::RedemptionWindowOpen);
        }
        // Upper bound on what the outstanding shares can still claim. For
        // Yes/No this is exact; for Void, `floor((oy + on) / 2)` is at least
        // the sum of per-holder floors (`settle_value` floors each pair), so
        // reserving the aggregate floor never under-reserves.
        let unclaimed_user =
            math::settle_upper(kind, settle.outstanding_yes, settle.outstanding_no);
        let lp_claim = if m.lp_claimed {
            0
        } else {
            math::settle_value(kind, m.reserve_yes, m.reserve_no)
        };
        // Sets are collateralized 1:1 and `paid_out` tracks what already
        // left the market, so remaining claims minus those two figures is
        // non-negative: it is exactly the per-holder void rounding dust
        // (zero for Yes/No markets). checked_sub makes that an assertion.
        let dust = m
            .sets_minted
            .checked_sub(settle.paid_out)
            .and_then(|v| v.checked_sub(unclaimed_user))
            .and_then(|v| v.checked_sub(lp_claim))
            .ok_or(Error::Overflow)?;
        let lp_fees = Self::load_lp_fees(&env, market_id);
        let swept = dust
            .checked_add(unclaimed_user)
            .and_then(|v| v.checked_add(lp_claim))
            .and_then(|v| v.checked_add(m.fees_accrued))
            .and_then(|v| v.checked_add(lp_fees))
            .ok_or(Error::Overflow)?;

        m.reserve_yes = 0;
        m.reserve_no = 0;
        m.lp_claimed = true;
        m.fees_accrued = 0;
        settle.outstanding_yes = 0;
        settle.outstanding_no = 0;
        settle.closed = true;
        Self::save_market(&env, market_id, &m);
        Self::save_settle(&env, market_id, &settle);
        Self::save_lp_fees(&env, market_id, 0);
        let treasury: Address = Self::instance_get(&env, &DataKey::Treasury)?;
        Self::token(&env)?.transfer(&env.current_contract_address(), &treasury, &swept);
        MarketFinalized {
            market_id,
            swept,
            unclaimed_user,
            dust,
        }
        .publish(&env);
        Ok(swept)
    }

    /// The creator (the LP) claims their share of accrued trade fees at any
    /// time, including before finality. Returns the amount claimed (0 when
    /// nothing is pending, mirroring `sweep_fees`).
    pub fn claim_lp_fees(env: Env, market_id: u64) -> Result<i128, Error> {
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
        let m = Self::load_market(&env, market_id)?;
        let mut a = Self::load_position(&env, market_id, &from, m.close_time);
        let mut b = Self::load_position(&env, market_id, &to, m.close_time);
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
        Self::save_position(&env, market_id, &from, &a, m.close_time);
        Self::save_position(&env, market_id, &to, &b, m.close_time);
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

    pub fn admin(env: Env) -> Result<Address, Error> {
        Self::instance_get(&env, &DataKey::Admin)
    }

    /// The pending admin proposal, including its expiry, if one exists.
    pub fn pending_admin(env: Env) -> Option<PendingAdmin> {
        Self::load_pending(&env)
    }

    pub fn market_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        Self::load_market(&env, market_id)
    }

    pub fn get_position(env: Env, market_id: u64, holder: Address) -> Position {
        // The TTL of the position entry tracks the market's close time. With
        // no market to anchor to (a stale id), fall back to the settlement
        // horizon from now so the entry at least keeps that much cover.
        let close_time = match Self::load_market(&env, market_id) {
            Ok(m) => m.close_time,
            Err(_) => env.ledger().timestamp(),
        };
        Self::load_position(&env, market_id, &holder, close_time)
    }

    /// Outstanding-share accounting for a market (issue #14).
    /// `NotSupported` for markets created before this bookkeeping existed.
    pub fn settle_state(env: Env, market_id: u64) -> Result<SettleState, Error> {
        Self::load_market(&env, market_id)?;
        Self::load_settle(&env, market_id)
    }

    /// Timestamp after which unredeemed shares are forfeit (see
    /// `finalize_market`). `None` while the market is still Open — its
    /// deadline is not known yet — and for legacy markets, which have no
    /// deadline and cannot be finalized.
    pub fn redeem_deadline(env: Env, market_id: u64) -> Option<u64> {
        match Self::load_settle_opt(&env, market_id) {
            Some(s) if s.finalized_at > 0 => Some(s.finalized_at.saturating_add(s.horizon_secs)),
            _ => None,
        }
    }

    /// Largest accepted `market_ids` length for `redeem_many` /
    /// `claim_pool_remainders`. Frontends should chunk work into strictly
    /// ascending batches of at most this size (see
    /// `docs/frontend-integration.md`).
    pub fn max_batch(_env: Env) -> u32 {
        MAX_BATCH
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

    /// Cumulative `price_bps * seconds` for YES since creation, extrapolated
    /// to now: `observe(market_id, 0)`. Ready-made for consumers that store
    /// their own checkpoints and compute TWAPs off-chain.
    pub fn price_cumulative(env: Env, market_id: u64) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let st = Self::load_oracle(&env, market_id, m.close_time)?;
        Self::observe_at(&env, market_id, &st, env.ledger().timestamp())
    }

    /// Cumulative YES-price-seconds as of `now - seconds_ago`.
    ///
    /// The accumulator is piecewise linear in time (the price only moves when
    /// a trade lands), so between observations the value is interpolated
    /// along the chord, and times after the last trade extrapolate at the
    /// last traded price. Fails with `ObservationTooOld` when `seconds_ago`
    /// reaches before the oldest surviving observation (the ring keeps the
    /// most recent 16), and with `NotSupported` for markets created before
    /// the accumulator existed. A missing (archived) ring slot is skipped,
    /// never a panic.
    pub fn observe(env: Env, market_id: u64, seconds_ago: u64) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let st = Self::load_oracle(&env, market_id, m.close_time)?;
        let now = env.ledger().timestamp();
        Self::observe_at(&env, market_id, &st, now.saturating_sub(seconds_ago))
    }

    /// Time-weighted average YES price in bps over the trailing
    /// `window_secs`, floored. Rejects a zero window (`InvalidAmount`).
    /// A window reaching before the oldest observation fails with
    /// `ObservationTooOld`; a window extending past `close_time` keeps
    /// averaging the final price, because the accumulator only moves when
    /// trades are possible.
    pub fn twap(env: Env, market_id: u64, window_secs: u64) -> Result<u32, Error> {
        if window_secs == 0 {
            return Err(Error::InvalidAmount);
        }
        let m = Self::load_market(&env, market_id)?;
        let st = Self::load_oracle(&env, market_id, m.close_time)?;
        let now = env.ledger().timestamp();
        let cum_now = Self::observe_at(&env, market_id, &st, now)?;
        let cum_then = Self::observe_at(&env, market_id, &st, now.saturating_sub(window_secs))?;
        let delta = cum_now.checked_sub(cum_then).ok_or(Error::Overflow)?;
        Ok((delta / window_secs as i128) as u32)
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
        ttl::bump_instance(env);
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

    fn load_pending(env: &Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
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
        let m: Market = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotFound)?;
        ttl::bump_persistent(env, &key, ttl::market_target(env, m.close_time));
        Ok(m)
    }

    fn save_market(env: &Env, id: u64, m: &Market) {
        let key = DataKey::Market(id);
        env.storage().persistent().set(&key, m);
        ttl::bump_persistent(env, &key, ttl::market_target(env, m.close_time));
    }

    fn load_position(env: &Env, id: u64, holder: &Address, close_time: u64) -> Position {
        let key = DataKey::Position(id, holder.clone());
        match env.storage().persistent().get::<_, Position>(&key) {
            Some(p) => {
                ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
                p
            }
            None => Position { yes: 0, no: 0 },
        }
    }

    /// Empty positions are removed so storage does not grow with dust entries.
    fn save_position(env: &Env, id: u64, holder: &Address, p: &Position, close_time: u64) {
        let key = DataKey::Position(id, holder.clone());
        if p.yes == 0 && p.no == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, p);
            ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
        }
    }

    /// Records the finality timestamp on `resolve` / `void_market` (both
    /// already require status == Open, so it is never overwritten). No-op
    /// for legacy markets without a `Settle` entry.
    fn mark_finalized(env: &Env, id: u64) {
        if let Some(mut settle) = Self::load_settle_opt(env, id) {
            settle.finalized_at = env.ledger().timestamp();
            Self::save_settle(env, id, &settle);
        }
    }

    /// `None` for legacy markets created before `SettleState` existed; their
    /// outstanding shares cannot be reconstructed on-chain, so they have no
    /// deadline and `finalize_market` refuses them (`NotSupported`) while
    /// `redeem` / `claim_pool_remainder` keep working as before.
    fn load_settle_opt(env: &Env, id: u64) -> Option<SettleState> {
        let key = DataKey::Settle(id);
        let settle = env.storage().persistent().get::<_, SettleState>(&key)?;
        // The deadline can be up to 5 years out, past `max_ttl()`; the entry
        // is kept as long as the network allows and then needs a restore or
        // the keeper (docs/wave-issues/14) until the market is finalized.
        ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
        Some(settle)
    }

    fn load_settle(env: &Env, id: u64) -> Result<SettleState, Error> {
        Self::load_settle_opt(env, id).ok_or(Error::NotSupported)
    }

    fn save_settle(env: &Env, id: u64, settle: &SettleState) {
        let key = DataKey::Settle(id);
        env.storage().persistent().set(&key, settle);
        ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
    }

    /// `true` once `finalize_market` closed the market. Raw read on purpose:
    /// batch loops must not pay a TTL bump for a market they only skip.
    fn settle_closed(env: &Env, id: u64) -> bool {
        env.storage()
            .persistent()
            .get::<_, SettleState>(&DataKey::Settle(id))
            .is_some_and(|s| s.closed)
    }

    fn batch_skip(id: u64, why: SkipReason) -> BatchItem {
        BatchItem {
            market_id: id,
            payout: 0,
            status: BatchStatus::Skipped(why),
        }
    }

    /// Batch input validation: at least one id, at most `MAX_BATCH`, and
    /// strictly ascending so the footprint is deterministic and duplicates
    /// cannot appear.
    fn validate_batch(market_ids: &Vec<u64>) -> Result<(), Error> {
        let n = market_ids.len();
        if n == 0 || n > MAX_BATCH {
            return Err(Error::BatchTooLarge);
        }
        for i in 1..n {
            if market_ids.get(i).unwrap() <= market_ids.get(i - 1).unwrap() {
                return Err(Error::InvalidAmount);
            }
        }
        Ok(())
    }

    /// `None` for markets created before the accumulator existed; unlike a
    /// missing `Settle` entry this cannot be reconstructed on-chain, so the
    /// oracle views refuse them (`NotSupported`) while trading keeps working
    /// (with no TWAP support) for backwards compatibility.
    fn load_oracle_opt(env: &Env, id: u64, close_time: u64) -> Option<OracleState> {
        let key = DataKey::Oracle(id);
        let st = env.storage().persistent().get::<_, OracleState>(&key)?;
        ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
        Some(st)
    }

    fn load_oracle(env: &Env, id: u64, close_time: u64) -> Result<OracleState, Error> {
        Self::load_oracle_opt(env, id, close_time).ok_or(Error::NotSupported)
    }

    fn save_oracle(env: &Env, id: u64, st: &OracleState, close_time: u64) {
        let key = DataKey::Oracle(id);
        env.storage().persistent().set(&key, st);
        ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
    }

    fn save_obs(env: &Env, id: u64, slot: u32, obs: &Observation, close_time: u64) {
        let key = DataKey::Obs(id, slot);
        env.storage().persistent().set(&key, obs);
        ttl::bump_persistent(env, &key, ttl::market_target(env, close_time));
    }

    /// Advances the accumulator to `now` using the pre-trade price and
    /// writes one ring observation when `now` is a new timestamp.
    ///
    /// Same-timestamp trades do not accumulate and do not write an
    /// observation; only `last_price_bps` is refreshed by the caller after
    /// the trade lands. That is what makes the accumulator
    /// manipulation-resistant: an attacker trading back and forth inside one
    /// ledger can move spot, but the price that counts toward future time is
    /// whatever the last trade of the ledger left behind — which arbitrageurs
    /// can punish as soon as the next ledger opens.
    fn accumulate(env: &Env, id: u64, m: &Market, st: &mut OracleState) -> Result<(), Error> {
        let now = env.ledger().timestamp();
        if now <= st.last_ts {
            return Ok(());
        }
        let dt = (now - st.last_ts) as i128;
        st.price_cumulative = st
            .price_cumulative
            .checked_add(
                (st.last_price_bps as i128)
                    .checked_mul(dt)
                    .ok_or(Error::Overflow)?,
            )
            .ok_or(Error::Overflow)?;
        st.last_ts = now;
        st.obs_index = (st.obs_index + 1) % ORACLE_RING;
        st.obs_count = core::cmp::min(st.obs_count + 1, ORACLE_RING);
        Self::save_obs(
            env,
            id,
            st.obs_index,
            &Observation {
                ts: now,
                cumulative: st.price_cumulative,
            },
            m.close_time,
        );
        Ok(())
    }

    /// `price_cumulative` as of time `t`. Per-slot reads only, so a missing
    /// (never-written or archived) slot is skipped, never a panic.
    fn observe_at(env: &Env, id: u64, st: &OracleState, t: u64) -> Result<i128, Error> {
        if t >= st.last_ts {
            // Counterfactual extension: the last traded price holds.
            let ext = (st.last_price_bps as i128)
                .checked_mul((t - st.last_ts) as i128)
                .ok_or(Error::Overflow)?;
            return st.price_cumulative.checked_add(ext).ok_or(Error::Overflow);
        }
        // `obs_count >= 1` for every live market: slot 0 is the creation
        // point. `oldest` is the ring position of the oldest written slot.
        let oldest = (st.obs_index + ORACLE_RING + 1 - st.obs_count) % ORACLE_RING;
        let mut a: Option<Observation> = None; // newest point with ts <= t
        let mut b: Option<Observation> = None; // oldest point with ts >= t
        for k in 0..st.obs_count {
            let slot = (oldest + k) % ORACLE_RING;
            let Some(obs) = env
                .storage()
                .persistent()
                .get::<_, Observation>(&DataKey::Obs(id, slot))
            else {
                continue;
            };
            if obs.ts <= t && a.is_none_or(|p| obs.ts > p.ts) {
                a = Some(obs);
            }
            if obs.ts >= t && b.is_none_or(|p| obs.ts < p.ts) {
                b = Some(obs);
            }
        }
        // If the newest ring slot was archived, the live edge still brackets
        // `t` from above; it is always at least as new as every observation.
        if b.is_none_or(|p| st.last_ts < p.ts) {
            b = Some(Observation {
                ts: st.last_ts,
                cumulative: st.price_cumulative,
            });
        }
        let Some(a) = a else {
            return Err(Error::ObservationTooOld);
        };
        let Some(b) = b else {
            return Err(Error::ObservationTooOld);
        };
        if a.ts == t {
            return Ok(a.cumulative);
        }
        if b.ts == t {
            return Ok(b.cumulative);
        }
        // Chord interpolation: exact between adjacent observations (the
        // accumulator is linear on each interval, slope = the price that
        // held), an approximation across a lost slot.
        let interp = b
            .cumulative
            .checked_sub(a.cumulative)
            .and_then(|d| d.checked_mul((t - a.ts) as i128))
            .ok_or(Error::Overflow)?
            / (b.ts - a.ts) as i128;
        a.cumulative.checked_add(interp).ok_or(Error::Overflow)
    }

    /// Debug-build check of the share-count invariant
    /// `reserve_<side> + outstanding_<side> == sets_minted`.
    ///
    /// Only valid while no collateral has left the market (`paid_out == 0`
    /// and the LP unclaimed), which is exactly every Open market plus a
    /// final one nobody redeemed from yet: redeeming a losing-side position
    /// (payout 0) burns outstanding shares without a matching payout, so
    /// after the first payout collateral conservation is tracked by
    /// `paid_out` instead and enforced by `finalize_market`'s checked
    /// residual. Exercised on create / buy / sell and in the tests.
    fn debug_assert_share_invariant(m: &Market, settle: &SettleState) {
        if settle.paid_out == 0 && !m.lp_claimed {
            debug_assert_eq!(m.reserve_yes + settle.outstanding_yes, m.sets_minted);
            debug_assert_eq!(m.reserve_no + settle.outstanding_no, m.sets_minted);
        }
    }

    fn load_fee_terms(env: &Env, id: u64) -> Option<FeeTerms> {
        let key = DataKey::FeeTerms(id);
        let terms = env.storage().persistent().get(&key);
        if terms.is_some() {
            ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
        }
        terms
    }

    fn save_fee_terms(env: &Env, id: u64, terms: &FeeTerms) {
        let key = DataKey::FeeTerms(id);
        env.storage().persistent().set(&key, terms);
        ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
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
            ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
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
            ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
        }
        cfg
    }

    fn save_breaker(env: &Env, id: u64, cfg: &BreakerConfig) {
        let key = DataKey::Breaker(id);
        env.storage().persistent().set(&key, cfg);
        ttl::bump_persistent(env, &key, ttl::long_lived_target(env));
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
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::Persistent as _, Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke,
        },
        token::{Client as TokenClient, StellarAssetClient},
        Event as _, IntoVal,
    };

    /// Minimal contract used to exercise the resolver/treasury wiring
    /// handshake: it reports a `market_core` address exactly like the real
    /// resolver and treasury do.
    #[contract]
    pub struct MockWiringPeer;

    #[contractimpl]
    impl MockWiringPeer {
        pub fn __constructor(env: Env, core: Address) {
            env.storage()
                .instance()
                .set(&soroban_sdk::symbol_short!("core"), &core);
        }

        pub fn market_core(env: Env) -> Address {
            env.storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("core"))
                .unwrap()
        }
    }

    fn register_wiring_peer(env: &Env, client: &MarketCoreClient) -> Address {
        env.register(MockWiringPeer, (client.address.clone(),))
    }

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
        let replacement = register_wiring_peer(&env, &client);
        client.propose_treasury(&replacement);
        client.accept_treasury();

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

        let replacement = register_wiring_peer(&env, &client);
        client.propose_treasury(&replacement);
        client.accept_treasury();
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
    fn wiring_and_split_change_emit_events() {
        let (env, client, _, _, _, _) = setup_market();
        // `env.events().all()` reports the last invocation's events only, so
        // each setter must publish exactly one event in its own invocation.
        client.propose_treasury(&register_wiring_peer(&env, &client));
        assert_eq!(env.events().all().events().len(), 1);
        client.set_protocol_fee_share_bps(&2500u32);
        assert_eq!(env.events().all().events().len(), 1);
        assert_eq!(client.get_config().protocol_fee_share_bps, 2500);
        assert_eq!(
            client.try_set_protocol_fee_share_bps(&10_001u32),
            Err(Ok(Error::InvalidFee))
        );
    }

    // ----- #61: resolver/treasury wiring handshake --------------------------

    #[test]
    fn resolver_wiring_handshake_updates_config() {
        let (env, client, _, _, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        client.propose_resolver(&peer);
        client.accept_resolver();
        assert_eq!(client.get_config().resolver, peer);
    }

    #[test]
    fn treasury_wiring_handshake_updates_config() {
        let (env, client, _, _, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        client.propose_treasury(&peer);
        client.accept_treasury();
        assert_eq!(client.get_config().treasury, peer);
    }

    #[test]
    fn accept_resolver_requires_a_pending_proposal() {
        let (_env, client, _, _, _, _) = setup_market();
        assert_eq!(
            client.try_accept_resolver(),
            Err(Ok(Error::NoPendingWiring))
        );
    }

    #[test]
    fn accept_resolver_rejects_peer_for_another_core() {
        let (env, client, _, _, _, _) = setup_market();
        // A contract that serves a *different* market-core must not be able
        // to wire itself in.
        let other_core = Address::generate(&env);
        let peer = env.register(MockWiringPeer, (other_core,));
        client.propose_resolver(&peer);
        assert_eq!(client.try_accept_resolver(), Err(Ok(Error::InvalidWiring)));
    }

    #[test]
    fn accept_treasury_rejects_peer_for_another_core() {
        let (env, client, _, _, _, _) = setup_market();
        let other_core = Address::generate(&env);
        let peer = env.register(MockWiringPeer, (other_core,));
        client.propose_treasury(&peer);
        assert_eq!(client.try_accept_treasury(), Err(Ok(Error::InvalidWiring)));
    }

    #[test]
    fn propose_resolver_requires_admin() {
        let (env, client, _, trader, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_resolver",
                    args: (peer.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_resolver(&peer)
            .is_err());
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

    // ----- TTL policy ------------------------------------------------------

    /// Advances both clocks together, as they move on a real network
    /// (one ledger per `ttl::LEDGER_SECS`).
    fn advance_ledgers(env: &Env, secs: u64) {
        assert_eq!(secs % ttl::LEDGER_SECS, 0);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + (secs / ttl::LEDGER_SECS) as u32);
        env.ledger().set_timestamp(env.ledger().timestamp() + secs);
    }

    fn persistent_ttl(env: &Env, contract: &Address, key: &DataKey) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    fn create_market_closing_in(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        secs_from_now: u64,
    ) -> u64 {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[21u8; 32]),
            &BytesN::from_array(env, &[121u8; 32]),
            &String::from_str(env, "ipfs://ttl-policy"),
            &Category::Other,
            &(env.ledger().timestamp() + secs_from_now),
            &(100 * 10_000_000_i128),
            &5000u32,
        )
    }

    #[test]
    fn market_entry_survives_until_close_plus_horizon() {
        let (env, client, creator, _, _, _) = setup_market();
        // Current network limits: persistent entries may live at most 180
        // days; the minimum is deliberately left low so the measured TTL is
        // the contract's own bump, not the network floor.
        env.ledger().set_max_entry_ttl(3_110_400);
        env.ledger().set_min_persistent_entry_ttl(4_096);

        let market_id = create_market_closing_in(&env, &client, &creator, 90 * ttl::DAY_SECS);
        let key = DataKey::Market(market_id);
        // 90 days to close + the 90-day settlement horizon, at the 180-day cap.
        assert!(persistent_ttl(&env, &client.address, &key) >= 3_110_399);

        // The old fixed 60-day bump let the entry die at day 60, twenty days
        // before this market could even close. Lay idle past that, then past
        // close, and resolution must still work.
        advance_ledgers(&env, 80 * ttl::DAY_SECS);
        assert!(persistent_ttl(&env, &client.address, &key) > 0);
        advance_ledgers(&env, 11 * ttl::DAY_SECS);

        client.resolve(&market_id, &Outcome::Yes);
        assert_eq!(
            client.get_market(&market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn position_ttl_tracks_close_time() {
        let (env, client, creator, trader, _, _) = setup_market();
        env.ledger().set_max_entry_ttl(3_110_400);
        env.ledger().set_min_persistent_entry_ttl(4_096);

        let short = create_market_closing_in(&env, &client, &creator, 10 * ttl::DAY_SECS);
        let long = create_market_closing_in(&env, &client, &creator, 100 * ttl::DAY_SECS);
        client.buy(
            &trader,
            &short,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.buy(
            &trader,
            &long,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let short_ttl = persistent_ttl(
            &env,
            &client.address,
            &DataKey::Position(short, trader.clone()),
        );
        let long_ttl = persistent_ttl(
            &env,
            &client.address,
            &DataKey::Position(long, trader.clone()),
        );

        // 10 days to close + 90-day horizon = 100 days.
        assert_eq!(short_ttl, 100 * ttl::DAY_IN_LEDGERS);
        // 100 days to close exceeds the 180-day cap only together with the
        // horizon, so the long market is clamped at the maximum.
        assert!(long_ttl >= 3_110_399);
        assert!(long_ttl > short_ttl);
    }

    // ----- Outstanding shares + redemption deadline (#14) ------------------

    fn create_market_with(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        yes_bps: u32,
        close_in_secs: u64,
    ) -> u64 {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[41u8; 32]),
            &BytesN::from_array(env, &[141u8; 32]),
            &String::from_str(env, "ipfs://settle"),
            &Category::Macro,
            &(env.ledger().timestamp() + close_in_secs),
            &(100 * 10_000_000_i128),
            &yes_bps,
        )
    }

    /// `reserve_<side> + outstanding_<side> == sets_minted`, checked through
    /// the public views. Only meaningful while no payout has left the market
    /// (before any redeem/claim); afterwards collateral conservation is
    /// tracked by `paid_out` and enforced by `finalize_market`'s checked
    /// residual — see the settle tests below.
    fn assert_share_invariant(client: &MarketCoreClient, market_id: u64) {
        let m = client.get_market(&market_id);
        let s = client.settle_state(&market_id);
        assert_eq!(s.paid_out, 0, "payouts must be zero for this assertion");
        assert_eq!(m.reserve_yes + s.outstanding_yes, m.sets_minted);
        assert_eq!(m.reserve_no + s.outstanding_no, m.sets_minted);
    }

    #[test]
    fn invariant_reserve_plus_outstanding_equals_sets() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);
        assert_share_invariant(&client, market_id);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_share_invariant(&client, market_id);
        client.buy(
            &trader,
            &market_id,
            &Outcome::No,
            &(7 * 10_000_000_i128),
            &0_i128,
        );
        assert_share_invariant(&client, market_id);

        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(3 * 10_000_000_i128),
            &i128::MAX,
        );
        assert_share_invariant(&client, market_id);
        client.sell(
            &trader,
            &market_id,
            &Outcome::No,
            &(2 * 10_000_000_i128),
            &i128::MAX,
        );
        assert_share_invariant(&client, market_id);

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        assert_share_invariant(&client, market_id);
    }

    #[test]
    fn outstanding_tracks_buy_sell_redeem() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);

        let s0 = client.settle_state(&market_id);
        let m0 = client.get_market(&market_id);
        assert_eq!(s0.finalized_at, 0);
        assert_eq!(s0.horizon_secs, DEFAULT_REDEEM_HORIZON_SECS);
        assert_eq!(s0.paid_out, 0);
        assert!(!s0.closed);
        assert_eq!(client.redeem_deadline(&market_id), None);
        // The creator's seed shares count as user outstanding, not pool.
        assert_eq!(s0.outstanding_yes, m0.sets_minted - m0.reserve_yes);
        assert_eq!(s0.outstanding_no, 0);

        let bought = client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let s1 = client.settle_state(&market_id);
        assert_eq!(s1.outstanding_yes, s0.outstanding_yes + bought);

        let sold = client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &i128::MAX,
        );
        let s2 = client.settle_state(&market_id);
        assert_eq!(s2.outstanding_yes, s1.outstanding_yes - sold);

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let resolved_at = env.ledger().timestamp();
        assert_eq!(
            client.redeem_deadline(&market_id),
            Some(resolved_at + DEFAULT_REDEEM_HORIZON_SECS)
        );

        let trader_pos = client.get_position(&market_id, &trader);
        let creator_pos = client.get_position(&market_id, &creator);
        let trader_payout = client.redeem(&trader, &market_id);
        assert_eq!(trader_payout, trader_pos.yes);
        let s3 = client.settle_state(&market_id);
        assert_eq!(s3.outstanding_yes, s2.outstanding_yes - trader_pos.yes);
        assert_eq!(s3.paid_out, trader_payout);
        assert_eq!(s3.finalized_at, resolved_at);

        let creator_payout = client.redeem(&creator, &market_id);
        assert_eq!(creator_payout, creator_pos.yes);
        let s4 = client.settle_state(&market_id);
        assert_eq!(s4.outstanding_yes, 0);
        assert_eq!(s4.paid_out, trader_payout + creator_payout);

        // The LP remainder still sits in the pool until claimed.
        let before_claim = client.get_market(&market_id);
        let lp_payout = client.claim_pool_remainder(&market_id);
        assert_eq!(lp_payout, before_claim.reserve_yes);
        let s5 = client.settle_state(&market_id);
        assert_eq!(s5.paid_out, s4.paid_out + lp_payout);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #24)")]
    fn finalize_before_deadline_rejected() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5000, 60_000);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let deadline = client.redeem_deadline(&market_id).unwrap();
        env.ledger().set_timestamp(deadline - 1);
        client.finalize_market(&market_id);
    }

    #[test]
    fn finalize_after_deadline_sweeps_exact_residual() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let trader2 = Address::generate(&env);
        StellarAssetClient::new(&env, &collateral).mint(&trader2, &10_000_000_000_i128);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);

        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.buy(
            &trader2,
            &market_id,
            &Outcome::No,
            &(7 * 10_000_000_i128),
            &0_i128,
        );

        // A void with a mix of odd positions: per-holder floors are what
        // leaves rounding dust behind.
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.void_market(&market_id);

        // One holder redeems before the deadline; the other never does.
        let trader_payout = client.redeem(&trader, &market_id);
        let deadline = client.redeem_deadline(&market_id).unwrap();
        env.ledger().set_timestamp(deadline + 1);

        let m_before = client.get_market(&market_id);
        let s_before = client.settle_state(&market_id);
        let expected_unclaimed = (s_before.outstanding_yes + s_before.outstanding_no) / 2;
        let expected_lp = (m_before.reserve_yes + m_before.reserve_no) / 2;
        let expected_dust =
            m_before.sets_minted - s_before.paid_out - expected_unclaimed - expected_lp;
        assert!(expected_dust >= 0);
        let expected_swept =
            expected_dust + expected_unclaimed + expected_lp + m_before.fees_accrued;

        let balance_before = token.balance(&client.address);
        let treasury_before = token.balance(&client.get_config().treasury);
        let swept = client.finalize_market(&market_id);

        // The sweep drains the market's entire balance — nothing stranded.
        assert_eq!(swept, expected_swept);
        assert_eq!(balance_before, swept);
        assert_eq!(token.balance(&client.address), 0);
        assert_eq!(
            token.balance(&client.get_config().treasury),
            treasury_before + swept
        );

        let m_after = client.get_market(&market_id);
        assert!(m_after.lp_claimed);
        assert_eq!(m_after.reserve_yes, 0);
        assert_eq!(m_after.reserve_no, 0);
        assert_eq!(m_after.fees_accrued, 0);
        let s_after = client.settle_state(&market_id);
        assert!(s_after.closed);
        assert_eq!(s_after.outstanding_yes, 0);
        assert_eq!(s_after.outstanding_no, 0);
        // `paid_out` keeps only the holder payouts that ever happened.
        assert_eq!(s_after.paid_out, trader_payout);

        // The never-redeemed holder is forfeit, not unpaid-but-pending.
        assert!(client.try_redeem(&trader2, &market_id).is_err());
    }

    #[test]
    fn redeem_before_deadline_never_underpaid() {
        let (env, client, creator, trader, _, _) = setup_market();
        // Two identical markets: one is finalized after the deadline, the
        // other is finalized too — the redemptions in between must be paid
        // exactly the same in both worlds.
        let a = create_market_with(&env, &client, &creator, 6800, 60_000);
        let b = create_market_with(&env, &client, &creator, 6800, 60_000);
        for id in [a, b] {
            client.buy(
                &trader,
                &id,
                &Outcome::Yes,
                &(10 * 10_000_000_i128),
                &0_i128,
            );
        }
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&a, &Outcome::Yes);
        client.resolve(&b, &Outcome::Yes);

        let deadline_a = client.redeem_deadline(&a).unwrap();
        let payout_a = client.redeem(&trader, &a);
        let payout_b = client.redeem(&trader, &b);
        assert_eq!(payout_a, payout_b);
        assert!(payout_a > 0);

        // Now let both deadlines pass and finalize both.
        env.ledger().set_timestamp(deadline_a + 1);
        let swept_b = client.finalize_market(&b);
        let swept_a = client.finalize_market(&a);
        assert_eq!(swept_a, swept_b);
        // The redeemer's payout was never touched by the finalize.
        assert_eq!(client.settle_state(&a).paid_out, payout_a);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #25)")]
    fn redeem_after_close_rejected() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let deadline = client.redeem_deadline(&market_id).unwrap();
        env.ledger().set_timestamp(deadline + 1);
        client.finalize_market(&market_id);
        client.redeem(&trader, &market_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #25)")]
    fn claim_after_close_rejected() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5000, 60_000);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let deadline = client.redeem_deadline(&market_id).unwrap();
        env.ledger().set_timestamp(deadline + 1);
        client.finalize_market(&market_id);
        client.claim_pool_remainder(&market_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #25)")]
    fn finalize_twice_rejected() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5000, 60_000);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let deadline = client.redeem_deadline(&market_id).unwrap();
        env.ledger().set_timestamp(deadline + 1);
        client.finalize_market(&market_id);
        client.finalize_market(&market_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #26)")]
    fn legacy_market_cannot_finalize() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5000, 60_000);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        // Simulate a market created before `Settle` entries existed.
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .remove(&DataKey::Settle(market_id));
        });
        client.finalize_market(&market_id);
    }

    #[test]
    fn legacy_market_still_redeems_without_deadline() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .remove(&DataKey::Settle(market_id));
        });

        // No deadline, no finalize — but the old redemption paths keep working.
        assert_eq!(client.redeem_deadline(&market_id), None);
        assert!(client.try_settle_state(&market_id).is_err());
        let payout = client.redeem(&trader, &market_id);
        assert!(payout > 0);
        assert!(client.claim_pool_remainder(&market_id) > 0);
    }

    #[test]
    fn redeem_horizon_default_snapshot_and_bounds() {
        let (env, client, creator, _, _, _) = setup_market();
        let long_horizon = 200 * ttl::DAY_SECS;
        client.set_default_redeem_horizon(&long_horizon);
        assert!(client
            .try_set_default_redeem_horizon(&(100 * ttl::DAY_SECS))
            .is_err());
        assert!(client
            .try_set_default_redeem_horizon(&(2_000 * ttl::DAY_SECS))
            .is_err());

        let market_id = create_market_with(&env, &client, &creator, 5000, 60_000);
        assert_eq!(client.settle_state(&market_id).horizon_secs, long_horizon);
        assert_eq!(client.redeem_deadline(&market_id), None);

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&market_id, &Outcome::Yes);
        let resolved_at = env.ledger().timestamp();
        assert_eq!(
            client.redeem_deadline(&market_id),
            Some(resolved_at + long_horizon)
        );
    }

    #[test]
    fn wrong_caller_cannot_set_default_redeem_horizon() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_redeem_horizon",
                    args: (365 * ttl::DAY_SECS,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_redeem_horizon(&(365 * ttl::DAY_SECS))
            .is_err());
    }

    // ----- TWAP accumulator (#11) ------------------------------------------

    fn oracle_state(env: &Env, client: &MarketCoreClient, market_id: u64) -> OracleState {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .get::<_, OracleState>(&DataKey::Oracle(market_id))
                .unwrap()
        })
    }

    fn obs_at(
        env: &Env,
        client: &MarketCoreClient,
        market_id: u64,
        slot: u32,
    ) -> Option<Observation> {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .get::<_, Observation>(&DataKey::Obs(market_id, slot))
        })
    }

    #[test]
    fn twap_equals_spot_without_trades() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);
        let spot = client.get_price(&market_id, &Outcome::Yes);

        env.ledger().set_timestamp(3_600);
        // No trade yet: every second so far held the seeded price.
        assert_eq!(client.twap(&market_id, &3_600), spot);
        assert_eq!(client.twap(&market_id, &60), spot);
        assert_eq!(client.price_cumulative(&market_id), (spot as i128) * 3_600);
        assert_eq!(client.observe(&market_id, &1_800), (spot as i128) * 1_800);
    }

    #[test]
    fn twap_weights_by_time() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);

        env.ledger().set_timestamp(1_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let p_a = client.get_price(&market_id, &Outcome::Yes) as i128;

        env.ledger().set_timestamp(1_100);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &0_i128,
        );
        let p_b = client.get_price(&market_id, &Outcome::Yes) as i128;

        env.ledger().set_timestamp(1_400);
        // [1000, 1100) held p_a, [1100, 1400) held p_b (extrapolated past
        // the last trade). The first 1000 s of seeded price are outside the
        // window and must not contribute.
        let expected = (p_a * 100 + p_b * 300) / 400;
        assert_eq!(client.twap(&market_id, &400) as i128, expected);
        assert_eq!(client.twap(&market_id, &300), p_b as u32);
    }

    #[test]
    fn same_timestamp_trades_do_not_accumulate() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);

        env.ledger().set_timestamp(1_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let p1 = client.get_price(&market_id, &Outcome::Yes);
        let cum1 = client.price_cumulative(&market_id);
        let twap1 = client.twap(&market_id, &500);
        let st1 = oracle_state(&env, &client, market_id);
        assert_eq!(st1.obs_count, 2, "creation slot + first trade");
        assert_eq!(st1.obs_index, 1);

        // A second trade in the same ledger moves spot but must not write an
        // observation or advance the cumulative.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let p2 = client.get_price(&market_id, &Outcome::Yes);
        assert!(p2 > p1);

        let st2 = oracle_state(&env, &client, market_id);
        assert_eq!(st2.obs_count, 2);
        assert_eq!(st2.obs_index, 1);
        assert_eq!(st2.price_cumulative, st1.price_cumulative);
        assert_eq!(client.price_cumulative(&market_id), cum1);
        assert_eq!(client.twap(&market_id, &500), twap1);
    }

    #[test]
    fn manipulation_within_one_ledger_does_not_move_twap() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5_000, 600_000);

        env.ledger().set_timestamp(5_000);
        let spot_before = client.get_price(&market_id, &Outcome::Yes);
        let twap_before = client.twap(&market_id, &1_000);

        // Big buy, then a partial sell-back — all inside one ledger.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(50 * 10_000_000_i128),
            &0_i128,
        );
        let spot_after_buy = client.get_price(&market_id, &Outcome::Yes);
        assert!(
            spot_after_buy > spot_before + 200,
            "the buy must move spot materially ({spot_before} -> {spot_after_buy})"
        );
        assert_eq!(client.twap(&market_id, &1_000), twap_before);

        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(40 * 10_000_000_i128),
            &i128::MAX,
        );
        assert_eq!(client.twap(&market_id, &1_000), twap_before);
    }

    #[test]
    fn observe_interpolates_between_observations() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);
        let p0 = client.get_price(&market_id, &Outcome::Yes) as i128;

        env.ledger().set_timestamp(1_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let p_a = client.get_price(&market_id, &Outcome::Yes) as i128;

        env.ledger().set_timestamp(1_100);
        // t = 950 sits between the creation point (0) and the t=1000
        // observation; the chord has slope p0 (the price that held).
        assert_eq!(client.observe(&market_id, &150), p0 * 950);
        // Exact at a stored observation.
        assert_eq!(client.observe(&market_id, &100), p0 * 1_000);
        // The live edge: cumulative at t=1000 plus p_a over the 100 s since.
        assert_eq!(client.price_cumulative(&market_id), p0 * 1_000 + p_a * 100);
    }

    #[test]
    fn observe_rejects_too_old() {
        let (env, client, creator, trader, _, _) = setup_market();
        env.ledger().set_timestamp(1_000);
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);
        env.ledger().set_timestamp(2_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // 1001 s ago is one second before the creation observation.
        assert_eq!(
            client.try_observe(&market_id, &1_001),
            Err(Ok(Error::ObservationTooOld))
        );
        // A window reaching back that far fails the same way.
        assert_eq!(
            client.try_twap(&market_id, &1_001),
            Err(Ok(Error::ObservationTooOld))
        );
        // Landing exactly on the creation observation is fine.
        assert_eq!(client.observe(&market_id, &1_000), 0);
    }

    #[test]
    fn ring_buffer_wraps_after_16_distinct_timestamps() {
        let (env, client, creator, trader, _, _) = setup_market();
        env.ledger().set_timestamp(1_000);
        let market_id = create_market_with(&env, &client, &creator, 5_000, 600_000);

        for k in 1..=17u64 {
            env.ledger().set_timestamp(1_000 + 100 * k);
            client.buy(
                &trader,
                &market_id,
                &Outcome::Yes,
                &10_000_000_i128,
                &0_i128,
            );
        }

        // 1 creation + 17 trade observations into 16 slots: the oldest
        // surviving slot holds t=1200, the newest holds t=2700.
        let st = oracle_state(&env, &client, market_id);
        assert_eq!(st.obs_count, 16);
        assert_eq!(st.obs_index, 1);
        assert_eq!(obs_at(&env, &client, market_id, 2).unwrap().ts, 1_200);
        assert_eq!(obs_at(&env, &client, market_id, 0).unwrap().ts, 2_600);
        assert_eq!(obs_at(&env, &client, market_id, 1).unwrap().ts, 2_700);

        // The oldest surviving observation still answers; one second
        // earlier is gone from the ring.
        assert!(client.observe(&market_id, &1_500) > 0);
        assert_eq!(
            client.try_observe(&market_id, &1_501),
            Err(Ok(Error::ObservationTooOld))
        );
    }

    #[test]
    fn quote_views_do_not_write_oracle_state() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 600_000);
        env.ledger().set_timestamp(1_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        env.ledger().set_timestamp(1_100);

        let st_before = oracle_state(&env, &client, market_id);
        let slots_before: [Option<Observation>; ORACLE_RING as usize] =
            core::array::from_fn(|k| obs_at(&env, &client, market_id, k as u32));

        let _ = client.quote_buy(&market_id, &Outcome::Yes, &(10 * 10_000_000_i128));
        let _ = client.quote_sell(&market_id, &Outcome::No, &(5 * 10_000_000_i128));
        let _ = client.get_price(&market_id, &Outcome::No);
        let _ = client.get_market(&market_id);
        let _ = client.observe(&market_id, &50);
        let _ = client.twap(&market_id, &100);
        let _ = client.price_cumulative(&market_id);

        assert_eq!(oracle_state(&env, &client, market_id), st_before);
        let slots_after: [Option<Observation>; ORACLE_RING as usize] =
            core::array::from_fn(|k| obs_at(&env, &client, market_id, k as u32));
        assert_eq!(slots_before, slots_after);
    }

    #[test]
    fn accumulator_is_overflow_safe_over_ten_years() {
        let (env, client, creator, trader, _, _) = setup_market();
        let ten_years: u64 = 10 * 365 * ttl::DAY_SECS;
        env.ledger().set_timestamp(1_000);
        let market_id = create_market_with(
            &env,
            &client,
            &creator,
            5_000,
            ten_years + 30 * ttl::DAY_SECS,
        );

        // Monthly trades for 10 years, alternating sides so the price stays
        // in a sane band. Each step feeds a ~30-day dt through the checked
        // accumulator arithmetic; the final cumulative is ~p_avg * 3.2e8.
        let step = ten_years / 120;
        for m in 1..=119u64 {
            env.ledger().set_timestamp(1_000 + m * step);
            let outcome = if m % 2 == 0 {
                Outcome::Yes
            } else {
                Outcome::No
            };
            client.buy(&trader, &market_id, &outcome, &10_000_000_i128, &0_i128);
        }
        env.ledger().set_timestamp(1_000 + 120 * step);
        let p_held_for_last_day = client.get_price(&market_id, &Outcome::Yes);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &10_000_000_i128,
            &0_i128,
        );

        let cum = client.price_cumulative(&market_id);
        let elapsed = (env.ledger().timestamp() - 1_000) as i128;
        assert!(cum > 0);
        // Every second contributes at most 10_000 bps.
        assert!(cum <= elapsed * 10_000);
        // The trailing day was held at the pre-final-trade price the whole
        // time (the final trade lands exactly at `now`).
        assert_eq!(client.twap(&market_id, &ttl::DAY_SECS), p_held_for_last_day);
        assert_eq!(oracle_state(&env, &client, market_id).obs_count, 16);
    }

    #[test]
    fn legacy_market_oracle_views_not_supported() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 6800, 60_000);
        // Simulate a market created before the accumulator existed.
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .remove(&DataKey::Oracle(market_id));
            env.storage()
                .persistent()
                .remove(&DataKey::Obs(market_id, 0));
        });
        assert_eq!(
            client.try_observe(&market_id, &1),
            Err(Ok(Error::NotSupported))
        );
        assert_eq!(
            client.try_twap(&market_id, &10),
            Err(Ok(Error::NotSupported))
        );
        assert_eq!(
            client.try_price_cumulative(&market_id),
            Err(Ok(Error::NotSupported))
        );
    }

    /// Cost harness for the numbers reported in the PR for issue #11. Run
    /// explicitly with: `cargo test -p market-core measure_buy_resources --
    /// --ignored --nocapture`. The same test body run against the parent
    /// commit's build gives the before/after delta for `buy`.
    #[test]
    #[ignore = "measurement harness; run explicitly with --ignored --nocapture"]
    fn measure_buy_resources() {
        extern crate std;
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = create_market_with(&env, &client, &creator, 5_000, 10_000_000);
        env.ledger().set_timestamp(1_000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        std::println!(
            "buy (new timestamp, with accumulator): {:?}",
            env.cost_estimate().resources()
        );
    }

    // ----- issue #15: batch redemption across many markets -----------------

    fn open_market_with_position(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        trader: &Address,
        outcome: Outcome,
        collateral_in: i128,
    ) -> u64 {
        let market_id = create_market_with(env, client, creator, 5_000, 60_000);
        client.buy(trader, &market_id, &outcome, &collateral_in, &0_i128);
        market_id
    }

    /// Advance past every close used by the batch tests, then resolve `ids`.
    fn advance_and_resolve(env: &Env, client: &MarketCoreClient, ids: &[u64], outcome: Outcome) {
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        for id in ids {
            client.resolve(id, &outcome);
        }
    }

    fn ids_vec(env: &Env, ids: &[u64]) -> Vec<u64> {
        let mut v = Vec::new(env);
        for id in ids {
            v.push_back(*id);
        }
        v
    }

    /// XDR events published by the market-core contract itself, oldest first.
    fn core_events(
        env: &Env,
        client: &MarketCoreClient,
    ) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
        let filtered = env.events().all().filter_by_contract(&client.address);
        let mut out = std::vec::Vec::new();
        for event in filtered.events() {
            out.push(event.clone());
        }
        out
    }

    #[test]
    fn redeem_many_pays_single_aggregated_transfer() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let m0 = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        let m1 = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            7 * 10_000_000,
        );
        let m2 = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            5 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[m0, m1, m2], Outcome::Yes);

        let token = TokenClient::new(&env, &collateral);
        let core_before = token.balance(&client.address);
        let trader_before = token.balance(&trader);

        let res = client.redeem_many(&trader, &ids_vec(&env, &[m0, m1, m2]));

        // `Events::all()` reports only the last contract invocation's events,
        // so capture them before any balance/state reads (which are
        // themselves invocations).
        let emitted = core_events(&env, &client);
        assert_eq!(emitted.len(), 3);

        assert_eq!(res.items.len(), 3);
        let mut sum = 0i128;
        for (i, item) in res.items.iter().enumerate() {
            assert_eq!(item.market_id, [m0, m1, m2][i]);
            assert_eq!(item.status, BatchStatus::Settled);
            assert!(item.payout > 0);
            sum += item.payout;
        }
        assert_eq!(sum, res.total);
        // One aggregated transfer: the contract pays exactly `total`, the
        // holder receives exactly `total`, and nothing else moved.
        assert_eq!(token.balance(&client.address), core_before - res.total);
        assert_eq!(token.balance(&trader), trader_before + res.total);
        // Positions are cleared and `SettleState::paid_out` tracks each payout.
        for (i, m) in [m0, m1, m2].iter().enumerate() {
            let pos = client.get_position(m, &trader);
            assert_eq!(pos.yes, 0);
            assert_eq!(pos.no, 0);
            let settle = client.settle_state(m);
            assert_eq!(settle.paid_out, res.items.get(i as u32).unwrap().payout);
        }
        // One Redeemed event per market, in request order.
        for (i, m) in [m0, m1, m2].iter().enumerate() {
            let expected = Redeemed {
                market_id: *m,
                holder: trader.clone(),
                payout: res.items.get(i as u32).unwrap().payout,
            }
            .to_xdr(&env, &client.address);
            assert_eq!(emitted[i], expected);
        }
    }

    #[test]
    fn redeem_many_skips_open_and_empty_markets() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let m_open = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        // No position for `trader` — the batch must skip, not revert.
        let m_flat = create_market_with(&env, &client, &creator, 5_000, 60_000);
        let m_paid = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            5 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[m_flat, m_paid], Outcome::Yes);

        let token = TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        let res = client.redeem_many(&trader, &ids_vec(&env, &[m_open, m_flat, m_paid]));

        assert_eq!(
            res.items.get(0).unwrap().status,
            BatchStatus::Skipped(SkipReason::NotFinal)
        );
        assert_eq!(res.items.get(0).unwrap().payout, 0);
        assert_eq!(
            res.items.get(1).unwrap().status,
            BatchStatus::Skipped(SkipReason::NothingToRedeem)
        );
        assert_eq!(res.items.get(2).unwrap().status, BatchStatus::Settled);
        assert_eq!(res.total, res.items.get(2).unwrap().payout);
        assert_eq!(token.balance(&trader), before + res.total);
        // The open market's position is untouched.
        assert!(client.get_position(&m_open, &trader).yes > 0);
    }

    #[test]
    fn redeem_many_rejects_unsorted_or_duplicate_ids() {
        let (env, client, creator, trader, _, _) = setup_market();
        let m0 = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        let m1 = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[m0, m1], Outcome::Yes);

        assert_eq!(
            client.try_redeem_many(&trader, &ids_vec(&env, &[m1, m0])),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_redeem_many(&trader, &ids_vec(&env, &[m0, m0])),
            Err(Ok(Error::InvalidAmount))
        );
        // Validation runs before any state change: positions are intact.
        assert!(client.get_position(&m0, &trader).yes > 0);
        assert!(client.get_position(&m1, &trader).yes > 0);
    }

    #[test]
    fn redeem_many_rejects_over_cap() {
        let (env, client, _, trader, _, _) = setup_market();
        let mut over = Vec::new(&env);
        for i in 0..=(MAX_BATCH as u64) {
            over.push_back(i);
        }
        assert_eq!(
            client.try_redeem_many(&trader, &over),
            Err(Ok(Error::BatchTooLarge))
        );
        assert_eq!(
            client.try_redeem_many(&trader, &Vec::new(&env)),
            Err(Ok(Error::BatchTooLarge))
        );
        // The LP batch validates identically.
        assert_eq!(
            client.try_claim_pool_remainders(&trader, &over),
            Err(Ok(Error::BatchTooLarge))
        );
        assert_eq!(
            client.try_claim_pool_remainders(&trader, &Vec::new(&env)),
            Err(Ok(Error::BatchTooLarge))
        );
    }

    #[test]
    fn redeem_many_mixed_yes_no_void() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let m_yes = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        let m_no = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::No,
            7 * 10_000_000,
        );
        let m_void = create_market_with(&env, &client, &creator, 5_000, 60_000);
        client.buy(
            &trader,
            &m_void,
            &Outcome::Yes,
            &(4 * 10_000_000_i128),
            &0_i128,
        );
        client.buy(
            &trader,
            &m_void,
            &Outcome::No,
            &(3 * 10_000_000_i128),
            &0_i128,
        );

        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        client.resolve(&m_yes, &Outcome::Yes);
        client.resolve(&m_no, &Outcome::No);
        client.void_market(&m_void);

        let pos_yes = client.get_position(&m_yes, &trader);
        let pos_no = client.get_position(&m_no, &trader);
        let pos_void = client.get_position(&m_void, &trader);
        assert!(pos_yes.yes > 0 && pos_no.no > 0 && pos_void.no > 0);

        let token = TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        let res = client.redeem_many(&trader, &ids_vec(&env, &[m_yes, m_no, m_void]));

        assert_eq!(res.items.get(0).unwrap().payout, pos_yes.yes);
        assert_eq!(res.items.get(1).unwrap().payout, pos_no.no);
        assert_eq!(
            res.items.get(2).unwrap().payout,
            (pos_void.yes + pos_void.no) / 2
        );
        assert_eq!(
            res.total,
            pos_yes.yes + pos_no.no + (pos_void.yes + pos_void.no) / 2
        );
        assert_eq!(token.balance(&trader), before + res.total);
    }

    #[test]
    fn claim_pool_remainders_skips_not_creator() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let m_mine = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        let stranger = Address::generate(&env);
        StellarAssetClient::new(&env, &collateral).mint(&stranger, &(1_000 * 10_000_000_i128));
        let m_other = open_market_with_position(
            &env,
            &client,
            &stranger,
            &trader,
            Outcome::Yes,
            5 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[m_mine, m_other], Outcome::Yes);

        let expected_payout = client.get_market(&m_mine).reserve_yes;
        let token = TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        let res = client.claim_pool_remainders(&creator, &ids_vec(&env, &[m_mine, m_other]));

        assert_eq!(res.items.get(0).unwrap().status, BatchStatus::Settled);
        assert_eq!(res.items.get(0).unwrap().payout, expected_payout);
        assert_eq!(
            res.items.get(1).unwrap().status,
            BatchStatus::Skipped(SkipReason::NotCreator)
        );
        assert_eq!(res.items.get(1).unwrap().payout, 0);
        assert_eq!(res.total, expected_payout);
        assert_eq!(token.balance(&creator), before + res.total);
        assert!(client.get_market(&m_mine).lp_claimed);
        assert!(!client.get_market(&m_other).lp_claimed);

        // Re-running the same batch is safe: the claimed market reports
        // AlreadyClaimed, the stranger's still NotCreator, and no further
        // transfer happens.
        let again = client.claim_pool_remainders(&creator, &ids_vec(&env, &[m_mine, m_other]));
        assert_eq!(
            again.items.get(0).unwrap().status,
            BatchStatus::Skipped(SkipReason::AlreadyClaimed)
        );
        assert_eq!(
            again.items.get(1).unwrap().status,
            BatchStatus::Skipped(SkipReason::NotCreator)
        );
        assert_eq!(again.total, 0);
        assert_eq!(token.balance(&creator), before + expected_payout);
    }

    #[test]
    fn claim_pool_remainder_emits_event() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[market_id], Outcome::Yes);

        let payout = client.claim_pool_remainder(&market_id);

        // Exactly one market-core event: the claim itself (the token transfer
        // event belongs to the collateral contract and is filtered out).
        let emitted = core_events(&env, &client);
        assert_eq!(emitted.len(), 1);
        let expected = PoolRemainderClaimed {
            market_id,
            creator: creator.clone(),
            payout,
        }
        .to_xdr(&env, &client.address);
        assert_eq!(emitted[0], expected);
    }

    #[test]
    fn wrong_caller_cannot_redeem_many_for_other_holder() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = open_market_with_position(
            &env,
            &client,
            &creator,
            &trader,
            Outcome::Yes,
            10 * 10_000_000,
        );
        advance_and_resolve(&env, &client, &[market_id], Outcome::Yes);

        let not_holder = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_holder,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "redeem_many",
                    args: (trader.clone(), ids_vec(&env, &[market_id])).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_redeem_many(&trader, &ids_vec(&env, &[market_id]))
            .is_err());
        // The position was not touched by the failed call.
        assert!(client.get_position(&market_id, &trader).yes > 0);

        // The signed payload is exactly `(holder, market_ids)`: a mock signed
        // by the holder over that invocation succeeds and pays.
        let res = client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "redeem_many",
                    args: (trader.clone(), ids_vec(&env, &[market_id])).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .redeem_many(&trader, &ids_vec(&env, &[market_id]));
        assert!(res.total > 0);
    }

    /// Measurement harness behind the `MAX_BATCH` doc table (issue #15):
    /// run explicitly with
    /// `cargo test -p market-core measure_redeem_many_resources -- --ignored --nocapture`.
    #[test]
    #[ignore = "measurement harness; run explicitly with --ignored --nocapture"]
    fn measure_redeem_many_resources() {
        for n in [1u64, 5, 10, 20, 30, 40, 45, 46] {
            let (env, client, creator, trader, _, collateral) = setup_market();
            // Each market needs a 100 USDC seed from the creator, and each
            // position 10 USDC from the trader; top both up so the harness
            // measures redemption, not the faucet.
            let sac = StellarAssetClient::new(&env, &collateral);
            sac.mint(&creator, &((n as i128 + 10) * 100 * 10_000_000));
            sac.mint(&trader, &((n as i128 + 10) * 10 * 10_000_000));
            let mut ids = Vec::new(&env);
            for _ in 0..n {
                ids.push_back(open_market_with_position(
                    &env,
                    &client,
                    &creator,
                    &trader,
                    Outcome::Yes,
                    10 * 10_000_000,
                ));
            }
            env.ledger()
                .set_timestamp(env.ledger().timestamp() + 60_001);
            for id in ids.iter() {
                client.resolve(&id, &Outcome::Yes);
            }
            let res = client.redeem_many(&trader, &ids);
            let r = env.cost_estimate().resources();
            std::println!(
                "redeem_many n={} total={} items={} | insns={} mem={} disk_read_entries={} mem_read_entries={} write_entries={} footprint={} disk_read_bytes={} write_bytes={} events_bytes={}",
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

    // ----- #62: two-step admin transfer -------------------------------------

    #[test]
    fn two_step_admin_transfer() {
        let (env, client, _, _, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        assert_eq!(client.pending_admin(), None);

        client.propose_admin(&new_admin);
        assert_eq!(
            client.pending_admin().map(|p| p.address),
            Some(new_admin.clone())
        );

        client.accept_admin();
        assert_eq!(client.admin(), new_admin);
        assert_eq!(client.get_config().admin, new_admin);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn admin_transfer_can_be_cancelled() {
        let (env, client, _, _, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.cancel_admin_transfer();
        assert_eq!(client.pending_admin(), None);
        assert_eq!(client.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    }

    #[test]
    fn expired_admin_transfer_cannot_be_accepted() {
        let (env, client, _, _, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + ADMIN_PROPOSAL_TTL_SECS + 1);
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(Error::PendingAdminExpired))
        );
        // The expired record stays visible so operators can inspect/clear it.
        assert!(client
            .pending_admin()
            .map(|p| p.expires_at < env.ledger().timestamp())
            .unwrap_or(false));
    }

    #[test]
    fn wrong_caller_cannot_accept_admin() {
        let (env, client, _, trader, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin()
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_propose_or_cancel_admin() {
        let (env, client, _, trader, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&new_admin)
            .is_err());
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer()
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_propose_treasury_or_cancel_wiring() {
        let (env, client, _, trader, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_treasury",
                    args: (peer.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_treasury(&peer)
            .is_err());
    }
}

// ---------------------------------------------------------------------------
// Test-only custom account: a weighted ed25519 multisig. It exists to prove
// that `require_admin` really works when the admin is a contract account (the
// `__check_auth` path), not just an `Address::generate` account that
// `mock_all_auths` approves unconditionally.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod multisig_account {
    extern crate std;

    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        crypto::Hash,
        testutils::Address as _,
        xdr::{
            Hash as XdrHash, HashIdPreimage, HashIdPreimageSorobanAuthorization,
            InvokeContractArgs, Limits, ScAddress, ScVal, SorobanAddressCredentials,
            SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
            SorobanCredentials, StringM, VecM, WriteXdr,
        },
        Bytes, IntoVal, TryFromVal, Vec,
    };

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum AccountError {
        BelowThreshold = 1,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct WeightedSig {
        pub key: BytesN<32>,
        pub signature: BytesN<64>,
    }

    #[contracttype]
    enum AccountKey {
        Signers,
        Threshold,
    }

    #[contract]
    pub struct MultisigAccount;

    #[contractimpl]
    impl MultisigAccount {
        pub fn __constructor(env: Env, signers: Vec<(BytesN<32>, u32)>, threshold: u32) {
            env.storage().instance().set(&AccountKey::Signers, &signers);
            env.storage()
                .instance()
                .set(&AccountKey::Threshold, &threshold);
        }
    }

    #[contractimpl]
    impl CustomAccountInterface for MultisigAccount {
        type Signature = Vec<WeightedSig>;
        type Error = AccountError;

        fn __check_auth(
            env: Env,
            signature_payload: Hash<32>,
            signatures: Vec<WeightedSig>,
            _auth_contexts: Vec<Context>,
        ) -> Result<(), AccountError> {
            let signers: Vec<(BytesN<32>, u32)> =
                env.storage().instance().get(&AccountKey::Signers).unwrap();
            let threshold: u32 = env
                .storage()
                .instance()
                .get(&AccountKey::Threshold)
                .unwrap();
            let message = Bytes::from_array(&env, &signature_payload.to_array());
            let mut weight = 0u32;
            // Each configured signer contributes at most once, so replaying
            // the same signature cannot reach the threshold on its own.
            for (key, key_weight) in signers.iter() {
                for sig in signatures.iter() {
                    if sig.key == key {
                        env.crypto().ed25519_verify(&key, &message, &sig.signature);
                        weight += key_weight;
                        break;
                    }
                }
            }
            if weight < threshold {
                return Err(AccountError::BelowThreshold);
            }
            Ok(())
        }
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn account_with(
        env: &Env,
        weights: &[(u8, u32)],
        threshold: u32,
    ) -> (Address, std::vec::Vec<SigningKey>) {
        let mut keys = std::vec::Vec::new();
        let mut signers = Vec::new(env);
        for (seed, weight) in weights {
            let sk = signing_key(*seed);
            signers.push_back((
                BytesN::from_array(env, &sk.verifying_key().to_bytes()),
                *weight,
            ));
            keys.push(sk);
        }
        let account = env.register(MultisigAccount, (signers, threshold));
        (account, keys)
    }

    /// Builds the address-credential auth entry a wallet would produce for
    /// `market_core.set_paused(true)`, signing the host's payload with the
    /// supplied keys.
    fn auth_entry(
        env: &Env,
        account: &Address,
        core: &Address,
        nonce: i64,
        keys: &[SigningKey],
    ) -> SorobanAuthorizationEntry {
        let expiration = 1_000u32;
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(core.clone()),
                function_name: StringM::try_from("set_paused").unwrap().into(),
                args: std::vec![ScVal::Bool(true)].try_into().unwrap(),
            }),
            sub_invocations: VecM::default(),
        };
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: XdrHash(env.ledger().network_id().to_array()),
            invocation: invocation.clone(),
            nonce,
            signature_expiration_ledger: expiration,
        });
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(
                env,
                &preimage.to_xdr(Limits::none()).unwrap(),
            ))
            .to_array();

        let mut signatures = Vec::new(env);
        for sk in keys {
            signatures.push_back(WeightedSig {
                key: BytesN::from_array(env, &sk.verifying_key().to_bytes()),
                signature: BytesN::from_array(env, &sk.sign(&payload).to_bytes()),
            });
        }
        let signature_val: soroban_sdk::Val = signatures.into_val(env);
        let signature = ScVal::try_from_val(env, &signature_val).unwrap();

        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account.clone()),
                nonce,
                signature_expiration_ledger: expiration,
                signature,
            }),
            root_invocation: invocation,
        }
    }

    fn core_with_admin(
        env: &Env,
        admin: &Address,
    ) -> (MarketCoreClient<'static>, Address, Address) {
        let collateral = env.register_stellar_asset_contract_v2(Address::generate(env));
        let treasury = Address::generate(env);
        let resolver = Address::generate(env);
        let core = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
                &10_000u32,
            ),
        );
        let client = MarketCoreClient::new(env, &core);
        (client, core, collateral.address())
    }

    #[test]
    fn require_admin_accepts_weighted_multisig() {
        let env = Env::default();
        // Weight 1 + weight 2, threshold 2: the weight-2 key alone suffices.
        let (account, keys) = account_with(&env, &[(1, 1), (2, 2)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        // Only the weight-1 key: below threshold, rejected through the real
        // __check_auth path (no mock_all_auths, no mocked auth entries).
        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            1,
            &[keys.first().unwrap().clone()],
        )]);
        assert!(client.try_set_paused(&true).is_err());

        // The weight-2 key alone reaches threshold.
        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            2,
            &[keys.get(1).unwrap().clone()],
        )]);
        client.set_paused(&true);
        assert!(client.get_config().paused);
    }

    #[test]
    fn require_admin_accepts_both_multisig_keys() {
        let env = Env::default();
        let (account, keys) = account_with(&env, &[(3, 1), (4, 1)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            7,
            &[keys.first().unwrap().clone(), keys.get(1).unwrap().clone()],
        )]);
        client.set_paused(&true);
        assert!(client.get_config().paused);
    }

    #[test]
    fn require_admin_rejects_bad_multisig_signature() {
        let env = Env::default();
        let (account, keys) = account_with(&env, &[(5, 2)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        let mut entry = auth_entry(&env, &account, &core, 9, &[keys.first().unwrap().clone()]);
        // Corrupt the signature bytes: the ed25519 check inside __check_auth
        // must reject it.
        let bad_sig = WeightedSig {
            key: BytesN::from_array(&env, &keys.first().unwrap().verifying_key().to_bytes()),
            signature: BytesN::from_array(&env, &[0u8; 64]),
        };
        let bad = Vec::from_array(&env, [bad_sig]);
        if let SorobanCredentials::Address(creds) = &mut entry.credentials {
            let bad_val: soroban_sdk::Val = bad.into_val(&env);
            creds.signature = ScVal::try_from_val(&env, &bad_val).unwrap();
        }
        env.set_auths(&[entry]);
        assert!(client.try_set_paused(&true).is_err());
    }
}
