#![no_std]

mod math;
#[cfg(kani)]
mod math_proofs;

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

/// A proposed admin handover must be accepted (or cancelled) within this many
/// seconds, so a proposal forgotten by the outgoing admin cannot be used to
/// seize control months later. 7 days.
const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;

/// How far a `halt_trading` effective time may be backdated (issue #22).
///
/// Seven days, deliberately the *same* window the resolver already grants its
/// signers (`resolver::SIGNER_GRACE_SECS`: attestations are accepted until
/// `close_time + 7 days`). A halt may therefore reach back no further than the
/// period in which post-close trading is already tolerated today, which keeps
/// the earliest possible `effective_at` inside the window whose trades the
/// agreed late-trade policy discloses. Anything longer would rewrite history
/// beyond the evidence a signer set can credibly attest to.
const MAX_BACKDATE_SECS: u64 = 7 * 86_400;

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

/// How a **voided** market pays its holders back (issue #21), chosen and
/// frozen by the creator at market creation.
///
/// `HalfPerShare` is today's rule (`math::settle_value`) and remains the
/// default for every market that has no `DataKey::VoidPolicy` entry, so
/// markets created before this change read exactly as before.
/// `CostBasis` refunds each holder the collateral it actually put in, capped
/// pro-rata when the positive bases exceed the refund pot.
///
/// Stored as a sidecar entry rather than as a `Market` field: `Market`'s XDR
/// is decoded by resolver, treasury and router through `contractimport!`
/// copies of this contract's wasm that the repo pins by sha256, so adding a
/// field would force a blob rebuild that cannot be performed here. See
/// `docs/architecture.md`, "Void refund policies".
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoidPolicy {
    HalfPerShare,
    CostBasis,
}

/// The two numbers a `CostBasis` void pays out of, frozen by `void_market`
/// (issue #21). Holders and the LP are settled against this snapshot and
/// never against live storage, which is what makes the payouts independent of
/// the order in which `redeem` is called.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VoidSnapshot {
    /// Complete sets in existence at void time — the collateral the pot can
    /// ever pay. `pot == m.sets_minted`.
    pub pot: i128,
    /// Sum of the *positive* holder bases at void time.
    pub basis_total: i128,
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
    // persistent storage (one entry each, own TTL)
    Market(u64),
    Position(u64, Address),
    FeeTerms(u64),
    LpFees(u64),
    Breaker(u64),
    // temporary storage (expires on its own, one entry per market)
    Band(u64),
    // ----- #21 cost-basis void refunds --------------------------------------
    // Append-only: `DataKey`'s discriminants are positional in XDR, so every
    // entry above keeps its index. All four are absent for markets created
    // before this change, and "absent" is defined as the legacy behaviour.
    /// The market's [`VoidPolicy`]. Absent = [`VoidPolicy::HalfPerShare`].
    VoidPolicy(u64),
    /// Net collateral a holder paid in minus took out, for `CostBasis`
    /// markets only. Signed: a holder who sold at a profit has a negative
    /// basis and is refunded nothing. Removed with its position.
    CostBasis(u64, Address),
    /// Sum of the *positive* `CostBasis` entries of a market, maintained in
    /// O(1) on every basis write so the void pro-rata needs no holder
    /// enumeration.
    BasisTotal(u64),
    /// [`VoidSnapshot`] written by `void_market` for `CostBasis` markets.
    VoidSnapshot(u64),
    // ----- #22 event-driven early close --------------------------------------
    /// `halt_trading` recorded: trading ends at this timestamp instead of at
    /// `Market::close_time`. Absent = no halt, so `effective_close == close_time`
    /// and every pre-upgrade market behaves exactly as before. One entry per
    /// market, written at most once (there is no unfinalised state to clear:
    /// disputes are settled on the resolver side *before* `halt_trading` runs).
    EarlyClose(u64),
    /// Timestamp of the last accepted `buy`/`sell`, written on every trade and
    /// read back by `TradingHalted` so the disclosed late-trade window
    /// `[effective_at, halted_at)` can be anchored to a real on-chain trade
    /// (issue #22). One entry per market; it never grows.
    LastTrade(u64),
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
    /// `halt_trading` called for a market that is already halted (issue #22).
    /// A halt is a single, permanent fact: there is no re-halt and no lift.
    AlreadyHalted = 27,
    /// `halt_trading` backdated further than `MAX_BACKDATE_SECS` (issue #22).
    HaltTooOld = 28,
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

/// Emitted by `create_market_with_policy` (issue #21), *after* the unchanged
/// `MarketCreated` event: an indexer that knows nothing about void policies
/// still sees the market being created, and one that does can attribute the
/// policy without re-reading storage. Markets created through `create_market`
/// never emit this — their policy is the default `HalfPerShare`.
#[contractevent]
pub struct VoidPolicyChosen {
    #[topic]
    pub market_id: u64,
    pub policy: VoidPolicy,
}

/// Emitted by `void_market` for a `CostBasis` market (issue #21): the refund
/// pot and the positive basis total are frozen here, so every later `redeem`
/// and `claim_pool_remainder` pays from these numbers only.
#[contractevent]
pub struct CostBasisVoidSnapshotted {
    #[topic]
    pub market_id: u64,
    pub pot: i128,
    pub basis_total: i128,
}

/// Emitted by `halt_trading` (issue #22). `effective_at` is when trading *ended*
/// and `halted_at` when the chain learned about it, so the pair is exactly the
/// window the agreed late-trade policy has to cover: trades in
/// `[effective_at, halted_at)` happened at a price the event says is stale and
/// are **not** reverted (see `docs/architecture.md`, "Early close and the
/// late-trade window", and ADR 0001). `last_trade_at` anchors the window to the
/// market's real final trade, which is the number an off-chain auditor needs to
/// quantify the damage; `close_time` is carried so a consumer does not have to
/// re-read a market whose state has since moved on.
#[contractevent]
pub struct TradingHalted {
    #[topic]
    pub market_id: u64,
    pub effective_at: u64,
    pub halted_at: u64,
    pub close_time: u64,
    pub last_trade_at: u64,
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

    // ----- market lifecycle -----------------------------------------------

    /// Creates a market and seeds the pool. `creator` becomes the sole LP.
    /// `initial_yes_bps` in [100, 9900] sets the opening YES probability;
    /// the creator receives the leftover shares of the likelier outcome.
    ///
    /// The void refund policy is the default [`VoidPolicy::HalfPerShare`];
    /// see [`MarketCore::create_market_with_policy`] to choose another one.
    /// This entrypoint's behaviour and signature are unchanged, and it writes
    /// no policy entry at all, so markets created through it are stored
    /// bit-for-bit as before this change.
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
        Self::create_market_with_policy(
            env,
            creator,
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
            VoidPolicy::HalfPerShare,
        )
    }

    /// `create_market` plus the [`VoidPolicy`] the creator commits to for the
    /// life of the market (issue #21).
    ///
    /// A **new entrypoint** rather than a trailing parameter on `create_market`
    /// (which the issue also allows): `create_market`'s signature is part of
    /// the interface that resolver, treasury and router decode from their
    /// vendored copies of this contract's wasm, and those blobs are pinned by
    /// sha256 and cannot be rebuilt here. Adding a parameter would change the
    /// exported spec and every client's call site; adding an entrypoint changes
    /// neither. Consequence: `treasury::agent_create_market` keeps creating
    /// `HalfPerShare` markets until somebody with stellar-cli 27.1.0 refreshes
    /// the vendored blob — an adoption limit, not a bug.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market_with_policy(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        void_policy: VoidPolicy,
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
        // #21: only a CostBasis market gets the sidecar entries. For
        // HalfPerShare this block is skipped entirely, so no `VoidPolicy`,
        // `CostBasis` or `BasisTotal` key is ever written.
        if void_policy == VoidPolicy::CostBasis {
            Self::save_void_policy(&env, id, &void_policy);
            // The creator paid `seed_amount` into the pool and received no
            // collateral back, so its basis is the whole seed — the same
            // "net collateral paid" rule used for `buy`. With it
            // `Σ basis_h == sets_minted` right after creation, i.e. the LP's
            // implicit residual basis (`sets_minted − Σ basis_h`) is 0.
            Self::add_basis(&env, id, &creator, seed_amount, false)?;
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
        if void_policy == VoidPolicy::CostBasis {
            VoidPolicyChosen {
                market_id: id,
                policy: void_policy,
            }
            .publish(&env);
        }
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
        Self::assert_tradable(&env, market_id, &m)?;

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
        // #21: `q.net` is the collateral that minted complete sets, i.e. what
        // left the trader's pocket into `sets_minted` (the fee went to the
        // protocol and is never refunded, so it is excluded by design).
        Self::add_basis(&env, market_id, &trader, q.net, false)?;
        // #22: one extra persistent write per accepted trade, always to the same
        // key, so the cost is a fixed 8-byte entry per market and never growth.
        Self::save_last_trade(&env, market_id);
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
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, market_id, &m)?;

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
        let emptied = pos.yes == 0 && pos.no == 0;
        Self::save_position(&env, market_id, &trader, &pos);
        // #21: reduce the basis by `q.gross` — the collateral that left
        // `sets_minted` — and *not* proportionally to the shares sold, which
        // is what keeps `Σ basis_h + basis_LP == sets_minted` exact. A holder
        // who sells more than they paid in ends with a negative basis (they
        // already took their refund out of the pool); the entry goes with the
        // position once it empties, and its unrecovered positive part, if any,
        // becomes the LP's residual.
        Self::add_basis(&env, market_id, &trader, -q.gross, emptied)?;
        // #22: see the note in `do_buy`.
        Self::save_last_trade(&env, market_id);
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

    /// Brings the end of trading forward to `effective_at` (issue #22).
    ///
    /// A "Will X happen by D?" question can be settled by the world long before
    /// `D`; until now the pool stayed open and anyone faster than the repricing
    /// crowd bought the already-known outcome at a stale price, with the loss
    /// landing on the LP. `halt_trading` closes that window: from the moment it
    /// is called, `assert_tradable`, `resolve` and the resolver's attestation
    /// gate all read `effective_close = min(close_time, effective_at)`.
    ///
    /// Rules, in order:
    /// - resolver-only, exactly like `resolve` / `void_market`;
    /// - the market must still be `Open` (a resolved or void market has nothing
    ///   to halt, and `finalize_early_close` reaching a market that was voided
    ///   mid-dispute fails here rather than half-applying a halt);
    /// - one halt per market — a halt is permanent, there is no lift entrypoint,
    ///   which is what makes "the halt is final" trivially true on-chain;
    /// - `effective_at <= close_time` (a halt may only move the close earlier)
    ///   and `effective_at <= now` (a halt records a fact, it cannot schedule
    ///   one), plus `effective_at >= now - MAX_BACKDATE_SECS`.
    ///
    /// Because the halt only *records* a past instant, trades that landed
    /// between `effective_at` and this transaction still happened. The chosen
    /// policy is **accept and disclose**: they are not reverted, and the event
    /// publishes the window so the backend can flag them. Rationale and the
    /// rejected alternative are in `docs/adr/0001-resolution-commitment.md`.
    pub fn halt_trading(env: Env, market_id: u64, effective_at: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if Self::load_early_close(&env, market_id).is_some() {
            return Err(Error::AlreadyHalted);
        }
        if effective_at > m.close_time {
            return Err(Error::InvalidCloseTime);
        }
        let now = env.ledger().timestamp();
        if effective_at > now {
            return Err(Error::InvalidCloseTime);
        }
        if effective_at < now.saturating_sub(MAX_BACKDATE_SECS) {
            return Err(Error::HaltTooOld);
        }
        Self::save_early_close(&env, market_id, effective_at);
        TradingHalted {
            market_id,
            effective_at,
            halted_at: now,
            close_time: m.close_time,
            last_trade_at: Self::load_last_trade(&env, market_id),
        }
        .publish(&env);
        Ok(())
    }

    pub fn resolve(env: Env, market_id: u64, outcome: Outcome) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        // Issue #22: an early halt is final the instant it is written (it can
        // only come from the resolver, and there is no way to lift it), so the
        // effective close is the only gate. With no halt recorded this is the
        // original `m.close_time` comparison, byte for byte.
        if env.ledger().timestamp() < Self::effective_close(&env, market_id, &m) {
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
    ///
    /// For a `CostBasis` market (issue #21) this is also the moment the refund
    /// pot is frozen: `void_market` snapshots `sets_minted` and the positive
    /// basis total, and every later `redeem` / `claim_pool_remainder` pays from
    /// that snapshot only. A `HalfPerShare` market writes nothing here.
    pub fn void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        m.status = MarketStatus::Void;
        Self::save_market(&env, market_id, &m);
        if Self::load_void_policy(&env, market_id) == VoidPolicy::CostBasis {
            let snapshot = VoidSnapshot {
                pot: m.sets_minted,
                basis_total: Self::load_basis_total(&env, market_id),
            };
            Self::save_void_snapshot(&env, market_id, &snapshot);
            CostBasisVoidSnapshotted {
                market_id,
                pot: snapshot.pot,
                basis_total: snapshot.basis_total,
            }
            .publish(&env);
        }
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
    ///
    /// Under the `CostBasis` void policy (issue #21) the payout is the holder's
    /// share of the frozen refund pot instead of `settle_value`; a resolved
    /// market ignores the policy entirely, and so does a `HalfPerShare` one.
    pub fn redeem(env: Env, holder: Address, market_id: u64) -> Result<i128, Error> {
        holder.require_auth();
        let m = Self::load_market(&env, market_id)?;
        let kind = Self::settlement(&m)?;
        let pos = Self::load_position(&env, market_id, &holder);
        if pos.yes == 0 && pos.no == 0 {
            return Err(Error::NothingToRedeem);
        }
        let payout = match (kind, Self::load_void_policy(&env, market_id)) {
            (Settlement::Void, VoidPolicy::CostBasis) => {
                match Self::load_void_snapshot_opt(&env, market_id) {
                    Some(snapshot) => math::cost_basis_refund(
                        Self::load_basis(&env, market_id, &holder),
                        snapshot.pot,
                        snapshot.basis_total,
                    )?,
                    // `void_market` always writes the snapshot for a CostBasis
                    // market, so falling back to the legacy rule here is only
                    // reachable if the entry was archived. Paying `settle_value`
                    // is the safe direction: paying 0 would strand the refund.
                    None => math::settle_value(kind, pos.yes, pos.no),
                }
            }
            _ => math::settle_value(kind, pos.yes, pos.no),
        };

        Self::save_position(&env, market_id, &holder, &Position { yes: 0, no: 0 });
        Self::clear_basis(&env, market_id, &holder)?;
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
    ///
    /// Under the `CostBasis` void policy (issue #21) the LP takes the snapshot
    /// residual `pot − min(basis_total, pot)` and never a live read of what
    /// holders have already redeemed: the amount is fixed at void time, so
    /// claiming before anybody else redeems cannot take their refunds, and
    /// claiming last cannot take more either. Together with the floored holder
    /// refunds this bounds the total void payout by `pot == sets_minted`.
    pub fn claim_pool_remainder(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let kind = Self::settlement(&m)?;
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        let pool_value = match (kind, Self::load_void_policy(&env, market_id)) {
            (Settlement::Void, VoidPolicy::CostBasis) => {
                match Self::load_void_snapshot_opt(&env, market_id) {
                    Some(snapshot) => {
                        math::cost_basis_lp_residual(snapshot.pot, snapshot.basis_total)?
                    }
                    None => math::settle_value(kind, m.reserve_yes, m.reserve_no),
                }
            }
            _ => math::settle_value(kind, m.reserve_yes, m.reserve_no),
        };
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
        Self::load_market(&env, market_id)?;
        let mut a = Self::load_position(&env, market_id, &from);
        let mut b = Self::load_position(&env, market_id, &to);
        // #21: cost basis is a property of the collateral, so it follows the
        // shares it paid for. A `CostBasis` transfer moves the same fraction of
        // the sender's *positive* basis as the fraction of their shares moving;
        // a negative basis (the sender already took out more than they paid in)
        // stays with its owner, because it is a claim already spent and not an
        // asset to hand over. No-op for every other market.
        let held_before = a.yes.checked_add(a.no).ok_or(Error::Overflow)?;
        let basis_slice = if held_before > 0 {
            Self::transferable_basis(&env, market_id, &from, amount, held_before)?
        } else {
            0
        };
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
        let from_emptied = a.yes == 0 && a.no == 0;
        Self::save_position(&env, market_id, &from, &a);
        Self::save_position(&env, market_id, &to, &b);
        if basis_slice != 0 || from_emptied {
            Self::add_basis(&env, market_id, &from, -basis_slice, from_emptied)?;
            Self::add_basis(&env, market_id, &to, basis_slice, false)?;
        }
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
    ///
    /// No `CostBasis` bookkeeping is needed here (issue #21): the LP's own basis
    /// is the *implicit* residual `sets_minted − Σ basis_h` and is never stored,
    /// so it follows `m.creator` automatically and the new LP is the one who
    /// claims `cost_basis_lp_residual`.
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
        Self::load_position(&env, market_id, &holder)
    }

    /// The market's [`VoidPolicy`] (issue #21). A market with no sidecar entry
    /// — every market created before this change, and every one created through
    /// `create_market` — reports `HalfPerShare`.
    pub fn get_void_policy(env: Env, market_id: u64) -> Result<VoidPolicy, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_void_policy(&env, market_id))
    }

    /// Signed net collateral `holder` has put into a `CostBasis` market and
    /// not taken back (issue #21). Always 0 for a `HalfPerShare` market, which
    /// never writes the entry.
    pub fn get_cost_basis(env: Env, market_id: u64, holder: Address) -> Result<i128, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_basis(&env, market_id, &holder))
    }

    /// Sum of the positive holder bases of a `CostBasis` market (issue #21),
    /// the denominator of the void pro-rata.
    pub fn get_basis_total(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_basis_total(&env, market_id))
    }

    /// The refund pot frozen by `void_market` for a `CostBasis` market
    /// (issue #21). `Ok(None)` while the market is open, resolved, or voided
    /// under `HalfPerShare`.
    pub fn get_void_snapshot(env: Env, market_id: u64) -> Result<Option<VoidSnapshot>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_void_snapshot_opt(&env, market_id))
    }

    /// The instant recorded by `halt_trading` (issue #22), `None` while the
    /// market has never been halted. Read-only and permissionless, so the
    /// resolver can gate attestation on it without a second source of truth.
    pub fn get_early_close(env: Env, market_id: u64) -> Result<Option<u64>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_early_close(&env, market_id))
    }

    /// `min(close_time, early_close)` — when trading really ends (issue #22).
    /// Equals `get_market(..).close_time` for every market that was never
    /// halted, which is the whole compatibility argument for the sidecar.
    pub fn get_effective_close(env: Env, market_id: u64) -> Result<u64, Error> {
        let m = Self::load_market(&env, market_id)?;
        Ok(Self::effective_close(&env, market_id, &m))
    }

    /// Timestamp of the last accepted `buy`/`sell`, 0 if the market never
    /// traded (issue #22: the anchor for the disclosed late-trade window).
    pub fn get_last_trade_at(env: Env, market_id: u64) -> Result<u64, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_last_trade(&env, market_id))
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

    /// Trading gates: open, and strictly before the **effective** close.
    ///
    /// Issue #22 adds the early-close term. A market with no `EarlyClose` entry
    /// — every market created before this change, and every one never halted —
    /// compares against `m.close_time` exactly as before, at the cost of one
    /// storage read that misses.
    fn assert_tradable(env: &Env, market_id: u64, m: &Market) -> Result<(), Error> {
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() >= Self::effective_close(env, market_id, m) {
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

    // ----- #21 cost-basis void refunds --------------------------------------
    //
    // Every one of these is a no-op (or a single storage read that misses) for
    // a market without a `CostBasis` policy entry, which is what keeps
    // `HalfPerShare` markets — including all pre-upgrade ones — bit-for-bit
    // unchanged in storage.
    //
    // The invariant they maintain is `Σ basis_h + basis_LP == sets_minted`,
    // where `basis_LP` is not stored but *is* `sets_minted − Σ basis_h`: every
    // path that moves collateral across the pool boundary changes `sets_minted`
    // by exactly the amount it changes one holder's basis (`+q.net` on a buy,
    // `-q.gross` on a sell, `+seed_amount` at creation), so the identity holds
    // at every step by construction. Deleting a basis with its emptied position
    // hands its unrecovered positive part to the LP, which the identity absorbs.

    fn load_void_policy(env: &Env, id: u64) -> VoidPolicy {
        env.storage()
            .persistent()
            .get(&DataKey::VoidPolicy(id))
            .unwrap_or(VoidPolicy::HalfPerShare)
    }

    fn save_void_policy(env: &Env, id: u64, policy: &VoidPolicy) {
        let key = DataKey::VoidPolicy(id);
        env.storage().persistent().set(&key, policy);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// The holder's signed basis, 0 when absent. Never extends or creates an
    /// entry: `add_basis` is the only writer.
    fn load_basis(env: &Env, id: u64, holder: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::CostBasis(id, holder.clone()))
            .unwrap_or(0)
    }

    fn load_basis_total(env: &Env, id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::BasisTotal(id))
            .unwrap_or(0)
    }

    fn save_basis_total(env: &Env, id: u64, total: i128) {
        let key = DataKey::BasisTotal(id);
        if total <= 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &total);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    fn load_void_snapshot_opt(env: &Env, id: u64) -> Option<VoidSnapshot> {
        let key = DataKey::VoidSnapshot(id);
        let snapshot = env.storage().persistent().get(&key);
        if snapshot.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        snapshot
    }

    fn save_void_snapshot(env: &Env, id: u64, snapshot: &VoidSnapshot) {
        let key = DataKey::VoidSnapshot(id);
        env.storage().persistent().set(&key, snapshot);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// Applies `delta` to a `CostBasis` holder's basis and keeps
    /// `DataKey::BasisTotal` exact. `position_empty` mirrors `save_position`:
    /// an emptied position takes its entry with it, so what it was owed falls
    /// back to the LP. Does nothing at all for `HalfPerShare` markets.
    fn add_basis(
        env: &Env,
        id: u64,
        holder: &Address,
        delta: i128,
        position_empty: bool,
    ) -> Result<(), Error> {
        if Self::load_void_policy(env, id) != VoidPolicy::CostBasis {
            return Ok(());
        }
        let before = Self::load_basis(env, id, holder);
        let after = before.checked_add(delta).ok_or(Error::Overflow)?;
        let key = DataKey::CostBasis(id, holder.clone());
        if position_empty || after == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &after);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        let counted = if position_empty { 0 } else { after.max(0) };
        let total = Self::load_basis_total(env, id)
            .checked_sub(before.max(0))
            .and_then(|t| t.checked_add(counted))
            .ok_or(Error::Overflow)?;
        Self::save_basis_total(env, id, total);
        Ok(())
    }

    /// Drops a redeemed holder's basis entry (issue #21). Called on every
    /// `redeem`, including of a resolved market, so a `CostBasis` market cannot
    /// accumulate entries for positions that no longer exist.
    fn clear_basis(env: &Env, id: u64, holder: &Address) -> Result<(), Error> {
        if Self::load_void_policy(env, id) != VoidPolicy::CostBasis {
            return Ok(());
        }
        let before = Self::load_basis(env, id, holder);
        if before == 0 {
            return Ok(());
        }
        env.storage()
            .persistent()
            .remove(&DataKey::CostBasis(id, holder.clone()));
        let total = Self::load_basis_total(env, id)
            .checked_sub(before.max(0))
            .ok_or(Error::Overflow)?;
        Self::save_basis_total(env, id, total);
        Ok(())
    }

    /// The slice of `from`'s basis that moves with `amount` of its
    /// `held_before` shares: `floor(basis * amount / held_before)`, or 0 when
    /// the basis is not positive (see `transfer_position`).
    fn transferable_basis(
        env: &Env,
        id: u64,
        from: &Address,
        amount: i128,
        held_before: i128,
    ) -> Result<i128, Error> {
        if Self::load_void_policy(env, id) != VoidPolicy::CostBasis {
            return Ok(0);
        }
        let basis = Self::load_basis(env, id, from);
        if basis <= 0 {
            return Ok(0);
        }
        Ok(math::mul_div_floor(basis, amount, held_before)?)
    }

    // ----- #22 event-driven early close -------------------------------------
    //
    // A halt is sidecar state, not a `Market` field: `Market`'s XDR is decoded by
    // resolver, treasury and router out of vendored copies of this contract's
    // wasm that the repo pins by sha256, so adding a field would need a blob
    // rebuild that cannot be performed here (the same reason as #21). The one
    // behavioural consequence is that `close_time` stays the *nominal* close and
    // every consumer that cares about the real one has to go through
    // `effective_close` / the new views.

    /// The recorded halt instant, `None` when the market was never halted.
    fn load_early_close(env: &Env, id: u64) -> Option<u64> {
        let key = DataKey::EarlyClose(id);
        let at: Option<u64> = env.storage().persistent().get(&key);
        if at.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        at
    }

    fn save_early_close(env: &Env, id: u64, effective_at: u64) {
        let key = DataKey::EarlyClose(id);
        env.storage().persistent().set(&key, &effective_at);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// When trading really ends: an early halt can only move the close
    /// *earlier*, so the effective close is the minimum. Clamped defensively —
    /// `halt_trading` already refuses `effective_at > close_time`, and a halt
    /// must never extend a market's life.
    fn effective_close(env: &Env, id: u64, m: &Market) -> u64 {
        match Self::load_early_close(env, id) {
            Some(at) if at < m.close_time => at,
            _ => m.close_time,
        }
    }

    /// Timestamp of the last accepted trade, 0 when the market has never
    /// traded. Read by `halt_trading` to anchor the disclosed late-trade window
    /// and exposed as `get_last_trade_at` for the backend.
    fn load_last_trade(env: &Env, id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::LastTrade(id))
            .unwrap_or(0)
    }

    fn save_last_trade(env: &Env, id: u64) {
        let key = DataKey::LastTrade(id);
        env.storage()
            .persistent()
            .set(&key, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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

    // ----- #21: optional cost-basis refunds for voided markets --------------

    /// Seed used by every market in this module (100 USDC, 7 decimals).
    const TEST_SEED: i128 = 100 * 10_000_000;

    /// A market created through `create_market_with_policy` (issue #21).
    fn new_market_policy(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        initial_yes_bps: u32,
        policy: VoidPolicy,
        salt: u8,
    ) -> u64 {
        client.create_market_with_policy(
            creator,
            &BytesN::from_array(env, &[salt; 32]),
            &BytesN::from_array(env, &[salt.wrapping_add(100); 32]),
            &String::from_str(env, "ipfs://cost-basis"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &TEST_SEED,
            &initial_yes_bps,
            &policy,
        )
    }

    /// Direct storage probe, so a test can assert an entry was never written.
    fn has_entry(env: &Env, client: &MarketCoreClient, key: DataKey) -> bool {
        let contract = client.address.clone();
        env.as_contract(&contract, || env.storage().persistent().has(&key))
    }

    /// The trade inputs a test needs to mirror the contract's own quotes.
    fn quote(client: &MarketCoreClient, market_id: u64, outcome: &Outcome) -> (i128, i128, u32) {
        let m = client.get_market(&market_id);
        let reserves = match outcome {
            Outcome::Yes => (m.reserve_yes, m.reserve_no),
            Outcome::No => (m.reserve_no, m.reserve_yes),
        };
        (reserves.0, reserves.1, m.fee_bps)
    }

    /// The market's whole position book (used by the redemption loops below).
    fn position_total(client: &MarketCoreClient, market_id: u64, holder: &Address) -> i128 {
        let p = client.get_position(&market_id, holder);
        p.yes + p.no
    }

    #[test]
    fn half_per_share_void_unchanged() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 9000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(30 * 10_000_000_i128),
            &0_i128,
        );

        // `create_market` writes no policy sidecar at all, so a pre-upgrade
        // market stays byte-identical in storage.
        assert!(!has_entry(&env, &client, DataKey::VoidPolicy(market_id)));
        assert!(!has_entry(
            &env,
            &client,
            DataKey::CostBasis(market_id, trader.clone())
        ));
        assert!(!has_entry(&env, &client, DataKey::BasisTotal(market_id)));
        assert_eq!(client.get_void_policy(&market_id), VoidPolicy::HalfPerShare);
        assert_eq!(client.get_cost_basis(&market_id, &trader), 0);

        client.void_market(&market_id);
        assert!(!has_entry(&env, &client, DataKey::VoidSnapshot(market_id)));
        assert!(client.get_void_snapshot(&market_id).is_none());

        // The legacy rule, unchanged: half a unit per share, floor.
        let pos = client.get_position(&market_id, &trader);
        let expected = (pos.yes + pos.no) / 2;
        assert_eq!(client.redeem(&trader, &market_id), expected);
        let m = client.get_market(&market_id);
        assert_eq!(
            client.claim_pool_remainder(&market_id),
            (m.reserve_yes + m.reserve_no) / 2
        );
        // The 44% haircut that motivates #21 is still there for a 0.9 entry.
        assert!(expected < 30 * 10_000_000_i128);
    }

    #[test]
    fn cost_basis_void_refunds_buyer_at_high_price() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        // Opens at 90% YES: the case where half-per-share pays 0.5 for a 0.9
        // entry. `create_market_with_policy` costs the same market 5% more.
        let market_id = new_market_policy(&env, &client, &creator, 9000, VoidPolicy::CostBasis, 22);
        assert_eq!(client.get_void_policy(&market_id), VoidPolicy::CostBasis);

        let paid = 30 * 10_000_000_i128;
        let (r_bought, r_other, fee_bps) = quote(&client, market_id, &Outcome::Yes);
        let q = math::calc_buy(r_bought, r_other, paid, fee_bps).unwrap();
        client.buy(&trader, &market_id, &Outcome::Yes, &paid, &0_i128);

        // Basis is the *net* collateral: the fee is the protocol's and is never
        // refunded, so the pot stays exactly `sets_minted`.
        assert_eq!(client.get_cost_basis(&market_id, &trader), q.net);
        assert_eq!(client.get_cost_basis(&market_id, &creator), TEST_SEED);
        assert_eq!(client.get_basis_total(&market_id), TEST_SEED + q.net);
        assert_eq!(client.get_market(&market_id).sets_minted, TEST_SEED + q.net);

        client.void_market(&market_id);
        let snapshot = client.get_void_snapshot(&market_id).unwrap();
        assert_eq!(snapshot.pot, TEST_SEED + q.net);
        assert_eq!(snapshot.basis_total, snapshot.pot);

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&trader);
        assert_eq!(client.redeem(&trader, &market_id), q.net);
        assert_eq!(token.balance(&trader), before + q.net);
        // The refunded entry is gone with the position.
        assert!(!has_entry(
            &env,
            &client,
            DataKey::CostBasis(market_id, trader.clone())
        ));
        assert_eq!(client.get_basis_total(&market_id), TEST_SEED);
    }

    #[test]
    fn partial_sell_reduces_basis_by_gross() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market_policy(&env, &client, &creator, 5000, VoidPolicy::CostBasis, 23);
        let buy_in = 20 * 10_000_000_i128;
        let (rb, ro, fee_bps) = quote(&client, market_id, &Outcome::Yes);
        let qb = math::calc_buy(rb, ro, buy_in, fee_bps).unwrap();
        client.buy(&trader, &market_id, &Outcome::Yes, &buy_in, &0_i128);

        let sell_out = 5 * 10_000_000_i128;
        let (rs, ro2, _) = quote(&client, market_id, &Outcome::Yes);
        let qs = math::calc_sell(rs, ro2, sell_out, fee_bps).unwrap();
        client.sell(&trader, &market_id, &Outcome::Yes, &sell_out, &qs.shares_in);

        // Minus the *gross* the pool burned, not a share-proportional slice:
        // that is what keeps Σ basis + LP == sets_minted exact.
        assert_eq!(
            client.get_cost_basis(&market_id, &trader),
            qb.net - qs.gross
        );
        assert_eq!(qs.gross, sell_out + qs.fee);
        assert_eq!(
            client.get_market(&market_id).sets_minted,
            TEST_SEED + qb.net - qs.gross
        );
        assert_eq!(
            client.get_basis_total(&market_id),
            TEST_SEED + qb.net - qs.gross
        );
        assert!(position_total(&client, market_id, &trader) > 0);
    }

    #[test]
    fn negative_basis_holder_gets_zero() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let other = Address::generate(&env);
        // YES opens at 10%, so the trader's entry is cheap; `other` then buys
        // heavily and the trader exits *half* their position at a profit, which
        // is what pushes a basis negative while shares remain.
        let market_id = new_market_policy(&env, &client, &creator, 1000, VoidPolicy::CostBasis, 24);
        StellarAssetClient::new(&env, &collateral).mint(&other, &(1_000 * 10_000_000_i128));

        let buy_in = 20 * 10_000_000_i128;
        client.buy(&trader, &market_id, &Outcome::Yes, &buy_in, &0_i128);
        let net = client.get_cost_basis(&market_id, &trader);
        client.buy(
            &other,
            &market_id,
            &Outcome::Yes,
            &(300 * 10_000_000_i128),
            &0_i128,
        );

        let held = client.get_position(&market_id, &trader).yes;
        let half = held / 2;
        let (rs, ro, fee_bps) = quote(&client, market_id, &Outcome::Yes);
        let sell_out = math::collateral_out_for_shares(rs, ro, half, fee_bps).unwrap();
        let qs = math::calc_sell(rs, ro, sell_out, fee_bps).unwrap();
        client.sell(&trader, &market_id, &Outcome::Yes, &sell_out, &qs.shares_in);

        assert!(qs.gross > net, "the sell must exceed what was paid in");
        let basis = client.get_cost_basis(&market_id, &trader);
        assert!(basis < 0);
        assert!(client.get_position(&market_id, &trader).yes > 0);

        client.void_market(&market_id);
        // Still holds shares, still gets nothing: they already took more out of
        // the pool than they put in.
        assert_eq!(client.redeem(&trader, &market_id), 0);
        let snapshot = client.get_void_snapshot(&market_id).unwrap();
        assert!(snapshot.basis_total <= snapshot.pot);
    }

    #[test]
    fn redeem_order_independent_under_cost_basis() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let other = Address::generate(&env);
        StellarAssetClient::new(&env, &collateral).mint(&other, &(1_000 * 10_000_000_i128));
        // Indexed by holder, so the two runs can be compared slot by slot no
        // matter which order the redemptions were issued in.
        let people = [trader.clone(), other.clone(), creator.clone()];

        let mut run = |reverse: bool, salt: u8, out: &mut [i128; 3]| {
            let market_id =
                new_market_policy(&env, &client, &creator, 5000, VoidPolicy::CostBasis, salt);
            client.buy(
                &trader,
                &market_id,
                &Outcome::Yes,
                &(20 * 10_000_000_i128),
                &0_i128,
            );
            client.buy(
                &other,
                &market_id,
                &Outcome::No,
                &(10 * 10_000_000_i128),
                &0_i128,
            );
            client.void_market(&market_id);
            let snapshot = client.get_void_snapshot(&market_id).unwrap();
            assert_eq!(snapshot.pot, client.get_market(&market_id).sets_minted);
            let order = if reverse { [2, 1, 0] } else { [0, 1, 2] };
            for index in order {
                out[index] += client.redeem(&people[index], &market_id);
            }
            // The creator is also the LP; their residual claim is order-free
            // too, because the snapshot formula never reads live balances.
            out[2] += client.claim_pool_remainder(&market_id);
        };

        let mut forwards = [0_i128; 3];
        let mut backwards = [0_i128; 3];
        run(false, 25, &mut forwards);
        run(true, 26, &mut backwards);
        assert_eq!(forwards, backwards);
        assert!(forwards[0] > 0 && forwards[1] > 0);
    }

    #[test]
    fn lp_receives_residual_after_cost_basis_void() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market_policy(&env, &client, &creator, 6800, VoidPolicy::CostBasis, 27);
        let buy_in = 20 * 10_000_000_i128;
        let (rb, ro, fee_bps) = quote(&client, market_id, &Outcome::Yes);
        let qb = math::calc_buy(rb, ro, buy_in, fee_bps).unwrap();
        client.buy(&trader, &market_id, &Outcome::Yes, &buy_in, &0_i128);

        // The trader exits completely at a loss: their unrecovered basis has to
        // go to the LP, because the position (and its entry) is deleted.
        let held = client.get_position(&market_id, &trader).yes;
        let (rs, ro2, _) = quote(&client, market_id, &Outcome::Yes);
        let sell_out = math::collateral_out_for_shares(rs, ro2, held, fee_bps).unwrap();
        let qs = math::calc_sell(rs, ro2, sell_out, fee_bps).unwrap();
        client.sell(&trader, &market_id, &Outcome::Yes, &sell_out, &qs.shares_in);
        let unrecovered = qb.net - qs.gross;
        assert!(unrecovered > 0);
        assert_eq!(position_total(&client, market_id, &trader), 0);
        assert!(!has_entry(
            &env,
            &client,
            DataKey::CostBasis(market_id, trader.clone())
        ));

        client.void_market(&market_id);
        let snapshot = client.get_void_snapshot(&market_id).unwrap();
        assert_eq!(snapshot.basis_total, TEST_SEED);
        assert_eq!(snapshot.pot, TEST_SEED + unrecovered);

        // The LP claims FIRST: the snapshot formula does not read live
        // balances, so it cannot take the creator's own holder refund either.
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        assert_eq!(client.claim_pool_remainder(&market_id), unrecovered);
        assert_eq!(token.balance(&creator), before + unrecovered);
        assert_eq!(client.redeem(&creator, &market_id), TEST_SEED);
    }

    #[test]
    fn cost_basis_void_solvent_under_random_sequences() {
        // Same tiny LCG as `math::tests::k_never_decreases_and_round_trip_never_profits`
        // so the sequence is reproducible. 5 holders, 500 random buys and sells,
        // then a void. The solvency proof is partly structural: a payout the
        // contract cannot fund would trap the host and fail this test, so
        // reaching the assertions at all already shows every transfer settled.
        let (env, client, creator, trader, _, collateral) = setup_market();
        let holders = [
            trader.clone(),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let bank = StellarAssetClient::new(&env, &collateral);
        for holder in holders.iter().skip(1) {
            bank.mint(holder, &(10_000 * 10_000_000_i128));
        }
        let market_id = new_market_policy(&env, &client, &creator, 6800, VoidPolicy::CostBasis, 28);

        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        let mut basis = [0_i128; 5];
        for _ in 0..500 {
            let i = (next() % 5) as usize;
            let outcome = if next() % 2 == 0 {
                Outcome::Yes
            } else {
                Outcome::No
            };
            let (r_bought, r_other, fee_bps) = quote(&client, market_id, &outcome);
            if next() % 3 == 0 {
                let held = match outcome {
                    Outcome::Yes => client.get_position(&market_id, &holders[i]).yes,
                    Outcome::No => client.get_position(&market_id, &holders[i]).no,
                };
                if held <= 1 {
                    continue;
                }
                let shares = 1 + (next() % held);
                let Ok(sell_out) =
                    math::collateral_out_for_shares(r_bought, r_other, shares, fee_bps)
                else {
                    continue;
                };
                let qs = math::calc_sell(r_bought, r_other, sell_out, fee_bps).unwrap();
                match client.try_sell(&holders[i], &market_id, &outcome, &sell_out, &qs.shares_in) {
                    Ok(Ok(_)) => {
                        basis[i] -= qs.gross;
                        if position_total(&client, market_id, &holders[i]) == 0 {
                            // mirrors `add_basis`: an emptied position takes its
                            // entry (and its positive part of the total) with it
                            basis[i] = 0;
                        }
                    }
                    _ => {}
                }
            } else {
                let amount = 1 + next() % (10 * 10_000_000);
                let qb = math::calc_buy(r_bought, r_other, amount, fee_bps).unwrap();
                match client.try_buy(&holders[i], &market_id, &outcome, &amount, &qb.shares_out) {
                    Ok(Ok(_)) => basis[i] += qb.net,
                    _ => {}
                }
            }
            // The on-chain sidecar must agree with the model at every step.
            assert_eq!(client.get_cost_basis(&market_id, &holders[i]), basis[i]);
        }

        let mut positive_total = TEST_SEED; // the creator's basis is the seed
        for holder_basis in basis.iter() {
            if *holder_basis > 0 {
                positive_total += *holder_basis;
            }
        }
        assert_eq!(client.get_basis_total(&market_id), positive_total);

        let pot = client.get_market(&market_id).sets_minted;
        client.void_market(&market_id);
        let snapshot = client.get_void_snapshot(&market_id).unwrap();
        assert_eq!(snapshot.pot, pot);
        assert_eq!(snapshot.basis_total, positive_total);

        let mut payouts = [0_i128; 5];
        let mut paid = 0_i128;
        for i in 0..5 {
            if position_total(&client, market_id, &holders[i]) == 0 {
                continue;
            }
            payouts[i] = client.redeem(&holders[i], &market_id);
            assert!(payouts[i] >= 0 && payouts[i] <= basis[i].max(0));
            paid += payouts[i];
        }
        let creator_payout = client.redeem(&creator, &market_id);
        paid += creator_payout;
        paid += client.claim_pool_remainder(&market_id);

        // The invariant #21 exists to guarantee: holder refunds plus the LP
        // residual never exceed the collateral the market actually holds.
        assert!(paid <= pot, "void paid {paid} out of a pot of {pot}");
        assert!(creator_payout <= TEST_SEED);
    }

    // ----- #22: event-driven early close ------------------------------------

    /// 10 USDC, the size every #22 test trades.
    const BUY_10: i128 = 10 * 10_000_000;

    /// A market whose nominal close is `close_in` seconds away. `new_market`
    /// fixes it at 60_000s, which is shorter than `MAX_BACKDATE_SECS`; the
    /// backdating tests need a market that is still open days later.
    fn new_market_long_close(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        close_in: u64,
        salt: u8,
    ) -> u64 {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[salt; 32]),
            &BytesN::from_array(env, &[salt.wrapping_add(100); 32]),
            &String::from_str(env, "ipfs://early-close"),
            &Category::Crypto,
            &(env.ledger().timestamp() + close_in),
            &TEST_SEED,
            &5000u32,
        )
    }

    #[test]
    fn halt_trading_blocks_buys_after_effective_time() {
        let (env, client, creator, trader, _, _) = setup_market();
        let start = env.ledger().timestamp();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);

        // The event happens 500s in; the resolver finalises its early-close
        // flow 500s after that, so the halt is recorded at now = start + 1_000
        // with effective_at = start + 500.
        env.ledger().set_timestamp(start + 1_000);
        client.halt_trading(&market_id, &(start + 500));

        assert_eq!(client.get_early_close(&market_id), Some(start + 500));
        assert_eq!(client.get_effective_close(&market_id), start + 500);
        // `close_time` is untouched: `Market`'s XDR is frozen, so the halt only
        // lives in the sidecar and the nominal close stays reportable.
        assert_eq!(client.get_market(&market_id).close_time, start + 60_000);
        // A halt closes trading, it does not resolve anything.
        assert_eq!(client.get_market(&market_id).status, MarketStatus::Open);

        // Every later trade is refused even though `close_time` is 59_000s away.
        assert_eq!(
            client.try_buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128),
            Err(Ok(Error::MarketClosed))
        );
        assert_eq!(
            client.try_sell(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128),
            Err(Ok(Error::MarketClosed))
        );
        // `buy_v2` / `sell_v2` share `do_buy` / `do_sell`, so they inherit it.
        assert_eq!(
            client.try_buy_v2(
                &trader,
                &market_id,
                &Outcome::Yes,
                &BUY_10,
                &0_i128,
                &0u32,
                &(start + 5_000u64)
            ),
            Err(Ok(Error::MarketClosed))
        );
    }

    #[test]
    fn halt_trading_rejects_future_or_after_close() {
        let (env, client, creator, trader, _, _) = setup_market();
        let start = env.ledger().timestamp();
        // 40 days out, so a 7-day backdate is still comfortably before the close.
        let close_in = 40 * 86_400;
        let market_id = new_market_long_close(&env, &client, &creator, close_in, 31);
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);
        env.ledger().set_timestamp(start + 1_000);
        let now = start + 1_000;

        // Never future-dated: a halt records a fact, it cannot schedule one.
        assert_eq!(
            client.try_halt_trading(&market_id, &(now + 1)),
            Err(Ok(Error::InvalidCloseTime))
        );
        // Cannot move the close later than itself: recorded after the nominal
        // close has passed, `effective_at` still has to be at or before it.
        let close_time = start + close_in;
        env.ledger().set_timestamp(close_time + 10);
        assert_eq!(
            client.try_halt_trading(&market_id, &(close_time + 5)),
            Err(Ok(Error::InvalidCloseTime))
        );
        // Backdating is bounded by MAX_BACKDATE_SECS.
        env.ledger().set_timestamp(start + 10 * 86_400);
        assert_eq!(
            client.try_halt_trading(&market_id, &(start + 1)),
            Err(Ok(Error::HaltTooOld))
        );
        // Exactly at the boundary is fine, and `effective_at == now` is too.
        let at = env.ledger().timestamp() - MAX_BACKDATE_SECS;
        client.halt_trading(&market_id, &at);
        assert_eq!(client.get_effective_close(&market_id), at);
        assert_eq!(
            client.try_halt_trading(&market_id, &at),
            Err(Ok(Error::AlreadyHalted))
        );
        // A halt is permanent: the effective close stays at the first one and
        // `close_time` still dominates the nominal view.
        assert_eq!(client.get_early_close(&market_id), Some(at));
        assert_eq!(client.get_market(&market_id).close_time, close_time);
    }

    #[test]
    fn resolve_allowed_after_early_close() {
        let (env, client, creator, trader, _, _) = setup_market();
        let start = env.ledger().timestamp();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);
        env.ledger().set_timestamp(start + 1_000);

        // Before the halt the original rule still bites.
        assert_eq!(
            client.try_resolve(&market_id, &Outcome::Yes),
            Err(Ok(Error::NotClosedYet))
        );

        client.halt_trading(&market_id, &(start + 500));
        // The halt is final the moment it is written (resolver-only, no lift),
        // so resolution unlocks immediately.
        client.resolve(&market_id, &Outcome::Yes);
        assert_eq!(
            client.get_market(&market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
        // A resolved market has nothing left to halt. `finalize_early_close`
        // racing a guardian void lands here too, which is why the resolver can
        // treat a failed halt as harmless.
        assert_eq!(
            client.try_halt_trading(&market_id, &(start + 500)),
            Err(Ok(Error::MarketNotOpen))
        );
    }

    #[test]
    fn void_market_still_works_after_a_halt() {
        let (env, client, creator, trader, _, _) = setup_market();
        let start = env.ledger().timestamp();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);
        env.ledger().set_timestamp(start + 1_000);
        client.halt_trading(&market_id, &(start + 500));

        // Halting is not resolving: the market stays Open, so the resolver can
        // still call it invalid afterwards.
        client.void_market(&market_id);
        assert_eq!(client.get_market(&market_id).status, MarketStatus::Void);
        let pos = client.get_position(&market_id, &trader);
        assert_eq!(client.redeem(&trader, &market_id), (pos.yes + pos.no) / 2);
    }

    #[test]
    fn wrong_caller_cannot_halt_trading() {
        let (env, client, creator, trader, resolver, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let at = env.ledger().timestamp();
        let attacker = Address::generate(&env);

        // `halt_trading` authorises the *resolver address*, exactly like
        // `resolve`, so no other key can produce the auth it needs — not the
        // admin, not the creator, not a trader.
        env.set_auths(&[]);
        for signer in [
            attacker.clone(),
            trader.clone(),
            creator.clone(),
            resolver.clone(),
        ]
        .iter()
        .enumerate()
        {
            let (index, address) = signer;
            let result = client
                .mock_auths(&[MockAuth {
                    address,
                    invoke: &MockAuthInvoke {
                        contract: &client.address,
                        fn_name: "halt_trading",
                        args: (market_id, at).into_val(&env),
                        sub_invokes: &[],
                    },
                }])
                .try_halt_trading(&market_id, &at);
            if index == 3 {
                // The resolver key is the one path that must succeed.
                assert_eq!(result, Ok(Ok(())));
            } else {
                assert!(result.is_err(), "non-resolver {index} could halt trading");
                assert_eq!(client.get_early_close(&market_id), None);
            }
        }
    }

    #[test]
    fn last_trade_at_updated() {
        let (env, client, creator, trader, _, _) = setup_market();
        let start = env.ledger().timestamp();
        let market_id = new_market(&env, &client, &creator, 5000);
        // Seeding the pool is not a trade.
        assert_eq!(client.get_last_trade_at(&market_id), 0);

        env.ledger().set_timestamp(start + 10);
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);
        assert_eq!(client.get_last_trade_at(&market_id), start + 10);

        env.ledger().set_timestamp(start + 20);
        let held = client.get_position(&market_id, &trader).yes;
        let (r_sold, r_other, fee_bps) = quote(&client, market_id, &Outcome::Yes);
        let out = math::collateral_out_for_shares(r_sold, r_other, held / 2, fee_bps).unwrap();
        let qs = math::calc_sell(r_sold, r_other, out, fee_bps).unwrap();
        client.sell(&trader, &market_id, &Outcome::Yes, &out, &qs.shares_in);
        assert_eq!(client.get_last_trade_at(&market_id), start + 20);

        // A rejected trade must not move it: the market is closed by then, and
        // the write happens after every check that can fail.
        env.ledger().set_timestamp(start + 30);
        client.halt_trading(&market_id, &(start + 25));
        // `env.events().all()` only reports the *last* invocation, so this is
        // the halt's own event count: `TradingHalted` publishes the whole
        // disclosure window — effective_at, halted_at, close_time, last_trade_at
        // — in that single event, so an indexer never has to re-read the market.
        assert_eq!(env.events().all().events().len(), 1);
        assert_eq!(client.get_last_trade_at(&market_id), start + 20);
        assert_eq!(
            client.try_buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128),
            Err(Ok(Error::MarketClosed))
        );
        assert_eq!(client.get_last_trade_at(&market_id), start + 20);
    }

    #[test]
    fn unhalted_markets_never_touch_the_early_close_keys() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        assert!(!has_entry(&env, &client, DataKey::EarlyClose(market_id)));
        assert_eq!(client.get_early_close(&market_id), None);
        // The compatibility claim in one line: an un-halted market's effective
        // close *is* its close_time, so `assert_tradable` and `resolve` compare
        // against the same number they did before this change.
        assert_eq!(
            client.get_effective_close(&market_id),
            client.get_market(&market_id).close_time
        );
        client.buy(&trader, &market_id, &Outcome::Yes, &BUY_10, &0_i128);
        assert!(has_entry(&env, &client, DataKey::LastTrade(market_id)));
        assert!(!has_entry(&env, &client, DataKey::EarlyClose(market_id)));
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
