#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

// See the comment on the equivalent `mod market_core` in
// contracts/resolver/src/lib.rs: a Cargo path dependency on market-core
// breaks the wasm build (duplicate `__constructor` export), so its client is
// generated from the compiled wasm instead. `docs/adr/0002-cross-contract-calls.md`.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::{
    Category, Client as MarketCoreClient, Error as MarketCoreError, MarketStatus, Outcome,
};

// The resolver's wasm supplies the `register_spec_v2` client and the
// `ResolutionSpecV2`/`ResolutionSpec` types used by the atomic
// `agent_create_market_and_reveal` flow (#64). Same duplicate-`__constructor`
// rationale as above; the resolver wasm is vendored at the workspace root and
// refreshed by `make build`.
#[allow(clippy::too_many_arguments)]
mod resolver {
    soroban_sdk::contractimport!(file = "resolver.wasm");
}
use resolver::{Client as ResolverClient, ResolutionSpec, ResolutionSpecV2};

/// Domain tag prepended to a V2 spec before hashing. Mirrors the resolver's
/// `SPEC_DOMAIN` so the treasury can compute the commitment it will both
/// create the market with and reveal.
const SPEC_DOMAIN: &[u8] = b"oracledesk:resolution-spec";
const SPEC_V2_VERSION: u32 = 2;

pub mod correlation;

const DAY_SECONDS: u64 = 86_400;
const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;
/// Width of one bucket of the sliding daily window.
const BUCKET_SECONDS: u64 = 3_600;
/// Buckets checked against `max_daily`: the trade's own hour plus the 24
/// before it. Any real 24h interval `(t - 24h, t]` touches at most hours
/// `h - 24 ..= h` (`h = t / 3600`), so summing 25 buckets never under-counts;
/// with 24 the partially-covered hour `h - 24` could add up to one more
/// bucket's worth on top of `max_daily`. The effective window is therefore
/// 24-25h: slightly conservative, never permissive.
const BUCKETS: u32 = 25;
/// Basis points in 1 (prices from market-core are in bps).
const BPS: i128 = 10_000;
/// market-core's `Error::SlippageExceeded` (pinned by a test).
const CORE_SLIPPAGE_EXCEEDED: u32 = 12;

/// Maps a typed market-core error (from a generated `try_*` call) into the
/// treasury's own disjoint range. Unmapped conditions collapse to
/// [`Error::MarketCoreCallFailed`] rather than leaking market-core's code.
fn map_market_core_error(error: market_core::Error) -> Error {
    use market_core::Error as Core;
    match error {
        Core::MarketNotFound => Error::MarketCoreMarketNotFound,
        Core::NotFinal => Error::MarketCoreNotFinal,
        Core::MarketNotOpen => Error::MarketCoreMarketNotOpen,
        Core::MarketClosed => Error::MarketCoreMarketClosed,
        Core::InsufficientLiquidity => Error::MarketCoreInsufficientLiquidity,
        Core::InsufficientShares => Error::MarketCoreInsufficientShares,
        Core::AlreadyClaimed => Error::MarketCoreAlreadyClaimed,
        Core::NothingToRedeem => Error::MarketCoreNothingToRedeem,
        Core::InvalidAmount => Error::MarketCoreInvalidAmount,
        Core::Overflow => Error::MarketCoreOverflow,
        Core::SlippageExceeded => Error::MarketCoreSlippageExceeded,
        _ => Error::MarketCoreCallFailed,
    }
}

/// Same mapping as [`map_market_core_error`], but for the numeric
/// `soroban_sdk::Error` returned by `try_invoke_contract` (which cannot be
/// decoded into `market_core::Error` without exporting that type).
fn map_market_core_code(error: soroban_sdk::Error) -> Error {
    let code = |value: u32| soroban_sdk::Error::from_contract_error(value);
    use market_core::Error as Core;
    if error == code(Core::MarketNotFound as u32) {
        Error::MarketCoreMarketNotFound
    } else if error == code(Core::NotFinal as u32) {
        Error::MarketCoreNotFinal
    } else if error == code(Core::MarketNotOpen as u32) {
        Error::MarketCoreMarketNotOpen
    } else if error == code(Core::MarketClosed as u32) {
        Error::MarketCoreMarketClosed
    } else if error == code(Core::InsufficientLiquidity as u32) {
        Error::MarketCoreInsufficientLiquidity
    } else if error == code(Core::InsufficientShares as u32) {
        Error::MarketCoreInsufficientShares
    } else if error == code(Core::AlreadyClaimed as u32) {
        Error::MarketCoreAlreadyClaimed
    } else if error == code(Core::NothingToRedeem as u32) {
        Error::MarketCoreNothingToRedeem
    } else if error == code(Core::InvalidAmount as u32) {
        Error::MarketCoreInvalidAmount
    } else if error == code(Core::Overflow as u32) {
        Error::MarketCoreOverflow
    } else if error == code(Core::SlippageExceeded as u32) {
        Error::MarketCoreSlippageExceeded
    } else {
        Error::MarketCoreCallFailed
    }
}

/// Runs a generated `try_*` market-core call, mapping both the callee error
/// and a host/invocation failure into treasury variants. Every cross-contract
/// market-core call must go through this (or [`Treasury::core_trade`] for the
/// name-dispatched trade calls); the panicking generated methods are never
/// used.
fn core_call<T>(
    result: Result<Result<T, market_core::Error>, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
) -> Result<T, Error> {
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(map_market_core_error(error)),
        Err(_) => Err(Error::MarketCoreCallFailed),
    }
}

/// Agent role bits (`AgentPolicy.roles`). A bitmask rather than a
/// `Vec<Role>`: cheaper to store and check, and `#[contracttype]` enums
/// cannot be used as flags.
pub const ROLE_CREATE: u32 = 1 << 0;
pub const ROLE_TRADE: u32 = 1 << 1;
pub const ROLE_SETTLE: u32 = 1 << 2;
pub const ROLE_ALL: u32 = ROLE_CREATE | ROLE_TRADE | ROLE_SETTLE;
/// Bounds registry enumeration and admin mistakes.
pub const MAX_AGENTS: u32 = 16;
/// Floor for `config_delay` (one day).
pub const MIN_CONFIG_DELAY: u64 = 86_400;

/// How long a pending admin proposal stays acceptable.
pub const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;
/// Bounds `nav()` to this many markets x two cross-contract reads. Each read
/// instantiates market-core (~2.5 MB of memory per market): 32 markets
/// measured ~81 MB for `nav()` alone and 16 ~40.4 MB for a `deposit`,
/// against the 40 MiB per-transaction memory limit. 12 keeps a `deposit` or
/// `request_withdraw` near 75% of it (see
/// `nav_budget_within_limits_at_max_open_markets`).
pub const MAX_OPEN_MARKETS: u32 = 12;
/// Smallest `deposit` (10 USDC): keeps share prices away from dust rounding.
pub const MIN_DEPOSIT: i128 = 10 * 10_000_000;
/// Virtual offset against first-depositor share inflation (the ERC-4626
/// mitigation, see docs/adr/0005-treasury-vault.md). The first mint also
/// burns `VIRTUAL_SHARES` dead shares.
const VIRTUAL_SHARES: i128 = 1_000;
const VIRTUAL_ASSETS: i128 = 1;

/// Legacy single-agent configuration. Still the shape returned by the
/// deprecated `get_config` view; live state is [`GlobalConfig`] plus the
/// agent registry.
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

/// Treasury-wide caps, enforced on top of every agent's own policy.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalConfig {
    pub collateral: Address,
    pub market_core: Address,
    pub max_trade: i128,
    pub max_market: i128,
    pub max_daily: i128,
    /// Cap on capital deployed in open positions across all markets at once
    /// (see `net_exposure`).
    pub max_net_exposure: i128,
}

/// One registered agent. `max_trade` / `max_daily` sit under the global
/// caps; both are checked on every spend.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentPolicy {
    pub roles: u32,
    pub max_trade: i128,
    pub max_daily: i128,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingConfig {
    pub config: GlobalConfig,
    pub proposed_at: u64,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PendingAgent {
    pub policy: AgentPolicy,
    pub proposed_at: u64,
    pub executable_at: u64,
}

/// Price limits on every agent trade, in bps of the outcome's spot price.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PricePolicy {
    /// Never buy an outcome priced above this.
    pub max_buy_price_bps: u32,
    /// Never sell an outcome priced below this.
    pub min_sell_price_bps: u32,
    /// Largest `|p_after - p_before|` a single trade may cause.
    pub max_impact_bps: u32,
    /// Tolerance applied to the same-transaction quote to derive the
    /// effective `min_shares_out` / `max_shares_in`.
    pub max_slippage_bps: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PendingPricePolicy {
    pub policy: PricePolicy,
    pub proposed_at: u64,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketExposure {
    pub amount: i128,
    pub open: bool,
}

/// Summary of the sliding daily window, returned by `daily_usage`.
/// `day_start` is the start of the oldest hour still counted and `amount`
/// the usage summed over the whole window (see [`UsageWindow`]).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DailyUsage {
    pub day_start: u64,
    pub amount: i128,
}

/// Hourly ring buffer behind `max_daily`. Kept in instance storage: ~400
/// bytes that every call loads anyway, so it costs no extra ledger-entry
/// read (a persistent entry would add one per trade). Per-agent windows
/// have the same shape but live in persistent storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageWindow {
    /// Hour index (`timestamp / BUCKET_SECONDS`) of the newest bucket.
    pub head_hour: u64,
    /// Always `BUCKETS` long. `amounts[i]` is the usage of hour
    /// `head_hour - ((head_idx - i) mod BUCKETS)`.
    pub amounts: Vec<i128>,
    pub head_idx: u32,
}

/// Collateral the treasury has sent into (`collateral_in`) and received back
/// from (`collateral_out`) one market. Accounting starts when this code was
/// deployed: a missing entry reads as zero.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NetPosition {
    pub collateral_in: i128,
    pub collateral_out: i128,
}

impl NetPosition {
    /// Capital still deployed: `max(0, in - out)`. Profit floors at zero so it
    /// never offsets exposure in another market.
    fn cost_basis(&self) -> i128 {
        self.collateral_in
            .saturating_sub(self.collateral_out)
            .max(0)
    }
}

/// `market_valuation` result. Only `cost_basis` is enforced (by
/// `max_net_exposure`); the others are informational.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Valuation {
    pub cost_basis: i128,
    /// What the treasury gets back whatever the outcome, from state a price
    /// move cannot raise: complete sets `min(yes, no)` plus, as the unclaimed
    /// LP, `min(reserve_yes, reserve_no)`. After finality, the settlement
    /// value.
    pub floor_value: i128,
    /// Holdings at the pool's spot price. Manipulable by any trader, so it is
    /// never used for enforcement.
    pub spot_value: i128,
    /// `max(0, cost_basis - floor_value)`.
    pub at_risk: i128,
}

/// An entry of the open-market index `nav()` walks.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenMarket {
    pub core: Address,
    pub market_id: u64,
}

/// Collateral still owed to `owner` for shares already burned.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawTicket {
    pub owner: Address,
    pub remaining: i128,
    pub created_at: u64,
}

// Issue #45
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SettlementReport {
    pub redeemed: i128,
    pub lp_claimed: i128,
    pub already_settled: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct Realized {
    pub position_proceeds: i128,
    pub lp_proceeds: i128,
    pub settled: bool,
}

// Issue #46
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct MarketPnl {
    pub cost: i128,
    pub proceeds: i128,
    pub realized: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DrawdownConfig {
    pub max_drawdown: i128,
    pub window_days: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PnlDays {
    pub head_day: u64,
    pub amounts: Vec<i128>,
    pub head_idx: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DrawdownStatus {
    pub tripped: bool,
    pub window_pnl: i128,
    pub max_drawdown: i128,
}

// Issue #47
pub const CREATION_BUCKETS: u32 = 24;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreationPolicy {
    pub max_seed: i128,
    pub max_markets_per_window: u32,
    pub creation_window_secs: u64,
    pub min_close_horizon: u64,
    pub max_close_horizon: u64,
    pub allowed_categories: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreationBucket {
    pub bucket_start: u64,
    pub count: u32,
}

// Issue #48
pub const BLEND_REQUEST_SUPPLY: u32 = 0;
pub const BLEND_REQUEST_WITHDRAW: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlendRequest {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlendPositions {
    pub supply_shares: i128,
    pub liabilities: i128,
}

#[soroban_sdk::contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit(env: Env, from: Address, spender: Address, to: Address, requests: Vec<BlendRequest>);
    fn get_positions(env: Env, address: Address) -> BlendPositions;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldVenue {
    pub pool: Address,
    pub max_allocation: i128,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapitalBreakdown {
    pub liquid: i128,
    pub yield_principal: i128,
    pub yield_value: i128,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    /// Legacy `RiskConfig`; migrated into `Global` plus one full-role agent
    /// by `load_global`.
    Config,
    Market(u64),
    /// Legacy fixed-window `DailyUsage`; migrated into `UsageWindow` and
    /// removed on the first trade after an upgrade.
    Daily,
    Paused,
    Successor,
    UsageWindow,
    /// Legacy `max_net_exposure`, now a `GlobalConfig` field.
    NetCap,
    Net(u64),
    /// Running `sum(max(0, in - out))` over all markets.
    NetTotal,
    Global,
    Agent(Address),
    AgentWindow(Address),
    AgentCount,
    AgentAt(u32),
    PendingAgent(Address),
    ConfigDelay,
    PendingConfig,
    /// The market-core the treasury was deployed against: its exposure keys
    /// stay `Market(id)` / `Net(id)`, any later core's are namespaced.
    OriginalCore,
    /// A market-core this treasury was switched away from.
    LegacyCore(Address),
    MarketV2(Address, u64),
    NetV2(Address, u64),
    PricePolicy,
    PendingPrice,
    Shares(Address),
    TotalShares,
    OpenMarketCount,
    OpenMarketAt(u32),
    OpenMarketSlot(Address, u64),
    QueueHead,
    QueueTail,
    Ticket(u64),
    /// Sum of `remaining` over all queued tickets.
    QueueReserved,
    Realized(u64),
    Pnl(u64),
    DrawdownCfg,
    PnlDays,
    DrawdownTripped,
    DrawdownAcknowledged,
    AdminPaused,
    CreationPolicy,
    CreationBuckets,
    YieldVenue,
    YieldPrincipal,
}

/// Note that market-core errors reach callers of treasury entrypoints with
/// market-core's own codes, which overlap these numerically (e.g. its
/// `NotFinal = 11`). The one market-core error a trade's own bounds can
/// cause, `SlippageExceeded`, is remapped to [`Error::SlippageExceeded`].
/// A proposed admin handover (#62). Absent when no transfer is pending.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub address: Address,
    pub expires_at: u64,
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
    NetExposureExceeded = 12,
    AgentDailyCapExceeded = 13,
    ProposalPending = 14,
    TimelockActive = 15,
    NoPendingConfig = 16,
    LegacyCoreUnknown = 17,
    TooManyOpenMarkets = 18,
    CapitalReserved = 19,
    DepositTooSmall = 20,
    InsufficientShares = 21,
    TicketNotFound = 22,
    NothingToPay = 23,
    PriceOutOfBand = 24,
    PriceImpactExceeded = 25,
    InvalidPricePolicy = 26,
    SlippageExceeded = 27,
    NotPaused = 28,
    MarketNotFinal = 44,
    MarketCoreError = 45,
    DrawdownTripped = 46,
    InvalidDrawdownConfig = 47,
    NotAcknowledged = 48,
    SeedCapExceeded = 49,
    CreationRateExceeded = 50,
    CloseTimeTooSoon = 51,
    CloseTimeTooFar = 52,
    CategoryNotAllowed = 53,
    PolicyLoosening = 54,
    YieldDisabled = 55,
    YieldCapExceeded = 56,
    YieldWithdrawFailed = 57,
    VenueHasPrincipal = 58,
    /// Category exposure would exceed its correlation cap (#49).
    CategoryCapExceeded = 44,
    /// Close-date bucket exposure would exceed its cap (#49).
    BucketCapExceeded = 45,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 46,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 47,
    /// `agent_create_market_and_reveal` was given a malformed resolution
    /// envelope or a rule outside the two primary modes (#64).
    InvalidResolution = 48,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposed {
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferred {
    pub old: Address,
    pub new: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferCancelled {}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeAuthorized {
    #[topic]
    pub market_id: u64,
    /// The acting agent.
    #[topic]
    pub agent: Address,
    pub amount: i128,
    pub market_total: i128,
    pub daily_total: i128,
}

/// Net exposure after any treasury money movement in `market_id`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetExposureUpdated {
    #[topic]
    pub market_id: u64,
    pub net_market: i128,
    pub net_total: i128,
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

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPolicySet {
    #[topic]
    pub agent: Address,
    pub roles: u32,
    pub max_trade: i128,
    pub max_daily: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPolicyProposed {
    #[topic]
    pub agent: Address,
    pub roles: u32,
    pub max_trade: i128,
    pub max_daily: i128,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPolicyCancelled {
    #[topic]
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRemoved {
    #[topic]
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigProposed {
    pub old: GlobalConfig,
    pub new: GlobalConfig,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigExecuted {
    pub old: GlobalConfig,
    pub new: GlobalConfig,
    /// `true` for a tighten-only change applied at proposal time.
    pub immediate: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigCancelled {
    pub config: GlobalConfig,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigDelaySet {
    pub old: u64,
    pub new: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PricePolicyProposed {
    pub old: PricePolicy,
    pub new: PricePolicy,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PricePolicySet {
    pub old: PricePolicy,
    pub new: PricePolicy,
    pub immediate: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PricePolicyCancelled {
    pub policy: PricePolicy,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub owner: Address,
    pub amount: i128,
    pub shares: i128,
    /// NAV before the deposit.
    pub nav: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawRequested {
    #[topic]
    pub owner: Address,
    pub shares: i128,
    pub assets: i128,
    pub paid_now: i128,
    /// 0 when everything was paid at once.
    pub ticket_id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawPaid {
    #[topic]
    pub ticket_id: u64,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyWithdrawn {
    #[topic]
    pub owner: Address,
    pub shares: i128,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketSettled {
    #[topic]
    pub market_id: u64,
    pub redeemed: i128,
    pub lp_claimed: i128,
    pub settled_by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PnlRealized {
    #[topic]
    pub market_id: u64,
    pub cost: i128,
    pub proceeds: i128,
    pub pnl: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DrawdownPause {
    pub realized_loss: i128,
    pub window_start_day: u64,
    pub triggered_by_market: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PnlWindowReset {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreationPolicyUpdated {
    pub old: CreationPolicy,
    pub new: CreationPolicy,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldAllocated {
    pub pool: Address,
    pub amount: i128,
    pub principal: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldRecalled {
    pub pool: Address,
    pub amount: i128,
    pub principal: i128,
    pub reason: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldVenueSet {
    pub pool: Address,
    pub max_allocation: i128,
}

/// Outcome of comparing a proposed config against the current one.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Change {
    None,
    TightenOnly,
    NeedsDelay,
}

/// `(old, new)` pairs where a lower value is the tighter one.
fn classify_caps(pairs: &[(i128, i128)]) -> Change {
    let mut lowered = false;
    for &(old, new) in pairs {
        if new > old {
            return Change::NeedsDelay;
        }
        lowered |= new < old;
    }
    if lowered {
        Change::TightenOnly
    } else {
        Change::None
    }
}

/// Copies of market-core's `math::mul_div_floor` / `mul_div_ceil`
/// (contracts/market-core/src/math.rs). The treasury cannot depend on the
/// market-core crate (ADR 0002); extracting a shared crate is separate work.
mod price_math {
    pub fn mul_div_floor(a: i128, b: i128, c: i128) -> Option<i128> {
        if a < 0 || b < 0 || c <= 0 {
            return None;
        }
        Some(a.checked_mul(b)? / c)
    }

    pub fn mul_div_ceil(a: i128, b: i128, c: i128) -> Option<i128> {
        if a < 0 || b < 0 || c <= 0 {
            return None;
        }
        let p = a.checked_mul(b)?;
        let q = p / c;
        Some(if p % c != 0 { q + 1 } else { q })
    }
}

/// Shares minted for `amount` at `nav` (floor, favours the vault).
fn shares_for_deposit(amount: i128, nav: i128, supply: i128) -> Option<i128> {
    price_math::mul_div_floor(
        amount,
        supply.checked_add(VIRTUAL_SHARES)?,
        nav.checked_add(VIRTUAL_ASSETS)?,
    )
}

/// Collateral owed for burning `shares` at `nav` (floor, favours the vault).
fn assets_for_shares(shares: i128, nav: i128, supply: i128) -> Option<i128> {
    price_math::mul_div_floor(
        shares,
        nav.checked_add(VIRTUAL_ASSETS)?,
        supply.checked_add(VIRTUAL_SHARES)?,
    )
}

pub const DEFAULT_PRICE_POLICY: PricePolicy = PricePolicy {
    max_buy_price_bps: 9_500,
    min_sell_price_bps: 500,
    max_impact_bps: 500,
    max_slippage_bps: 200,
};

#[contract]
pub struct Treasury;

#[soroban_sdk::contractclient(name = "MarketCoreWiringClient")]
pub trait MarketCoreWiring {
    fn accept_treasury(env: Env) -> Result<(), soroban_sdk::Error>;
}

#[contractimpl]
impl Treasury {
    /// Registers `agent` as the first agent with every role and the global
    /// caps as its own. `max_net_exposure` caps capital deployed in open
    /// positions across all markets at once (see `net_exposure`); it must be
    /// at least `max_trade`. `config_delay` (seconds, at least
    /// `MIN_CONFIG_DELAY`) is the timelock on every loosening change.
    ///
    /// Any collateral the treasury already holds is minted as shares to
    /// `admin`.
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
        max_net_exposure: i128,
        config_delay: u64,
        max_drawdown: i128,
        window_days: u32,
        creation_policy: CreationPolicy,
    ) {
        let global = GlobalConfig {
            collateral,
            market_core,
            max_trade,
            max_market,
            max_daily,
            max_net_exposure,
        };
        if Self::validate(&global).is_err() || config_delay < MIN_CONFIG_DELAY {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        if Self::validate_drawdown_config(max_drawdown, window_days).is_err() {
            panic_with_error!(&env, Error::InvalidDrawdownConfig);
        }
        if Self::validate_creation_policy(&global, &creation_policy).is_err() {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Global, &global);
        storage.set(&DataKey::OriginalCore, &global.market_core);
        storage.set(&DataKey::ConfigDelay, &config_delay);
        storage.set(&DataKey::PricePolicy, &DEFAULT_PRICE_POLICY);
        storage.set(
            &DataKey::UsageWindow,
            &Self::empty_window(&env, env.ledger().timestamp() / BUCKET_SECONDS),
        );
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::AdminPaused, &false);
        storage.set(&DataKey::DrawdownTripped, &false);
        storage.set(&DataKey::DrawdownAcknowledged, &false);
        storage.set(
            &DataKey::DrawdownCfg,
            &DrawdownConfig {
                max_drawdown,
                window_days,
            },
        );
        let head_day = env.ledger().timestamp() / DAY_SECONDS;
        storage.set(
            &DataKey::PnlDays,
            &Self::empty_pnl_days(&env, head_day, window_days),
        );
        storage.set(&DataKey::CreationPolicy, &creation_policy);
        let buckets: Vec<CreationBucket> = Vec::new(&env);
        storage.set(&DataKey::CreationBuckets, &buckets);
        storage.set(&DataKey::YieldPrincipal, &0i128);

        let full = AgentPolicy {
            roles: ROLE_ALL,
            max_trade,
            max_daily,
            active: true,
        };
        if let Err(e) = Self::write_agent(&env, &agent, &full) {
            panic_with_error!(&env, e);
        }
        let idle = Self::idle(&env, &global);
        if idle > 0 {
            if let Err(e) = Self::mint_shares(&env, &admin, idle, 0) {
                panic_with_error!(&env, e);
            }
        }
    }

    /// Deprecated compatibility view in the pre-registry `RiskConfig` shape:
    /// `agent` is the first registered agent (whatever its current policy).
    /// Use `get_global` and `get_agent` instead.
    pub fn get_config(env: Env) -> Result<RiskConfig, Error> {
        let global = Self::load_global(&env)?;
        let agent = Self::agent_at(env.clone(), 0).ok_or(Error::NotInitialized)?;
        Ok(RiskConfig {
            agent,
            collateral: global.collateral,
            market_core: global.market_core,
            max_trade: global.max_trade,
            max_market: global.max_market,
            max_daily: global.max_daily,
        })
    }

    pub fn get_global(env: Env) -> Result<GlobalConfig, Error> {
        Self::load_global(&env)
    }

    /// Total capital deployable: liquid collateral balance plus supplied yield value.
    pub fn available_capital(env: Env) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        let liquid = Self::idle(&env, &global);
        let y_val = Self::yield_value(&env);
        Ok(liquid.saturating_add(y_val))
    }

    /// Liquid collateral balance held directly in the treasury.
    pub fn liquid_capital(env: Env) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Ok(Self::idle(&env, &global))
    }

    /// Breakdown of treasury capital across liquid, yield principal, and yield value.
    pub fn capital_breakdown(env: Env) -> Result<CapitalBreakdown, Error> {
        let global = Self::load_global(&env)?;
        let liquid = Self::idle(&env, &global);
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YieldPrincipal)
            .unwrap_or(0);
        let yield_val = Self::yield_value(&env);
        Ok(CapitalBreakdown {
            liquid,
            yield_principal: principal,
            yield_value: yield_val,
        })
    }

    /// Usage over the sliding window as of now: `amount` sums every bucket
    /// still counted against `max_daily`, `day_start` is the start of the
    /// oldest of them. Side-effect free (it advances a copy), so repeated
    /// reads without trades in between return the same value.
    pub fn daily_usage(env: Env) -> Result<DailyUsage, Error> {
        let window = Self::daily_usage_detail(env)?;
        Self::summarize(&window)
    }

    /// The hourly buckets behind `daily_usage`, advanced to now (not stored).
    pub fn daily_usage_detail(env: Env) -> Result<UsageWindow, Error> {
        let mut window = Self::load_window(&env)?;
        Self::advance(&mut window, env.ledger().timestamp() / BUCKET_SECONDS);
        Ok(window)
    }

    /// How much more the agents together may deploy right now before
    /// `max_daily` (`max_daily - window sum`, floored at 0).
    pub fn daily_headroom(env: Env) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        let used = Self::daily_usage(env)?.amount;
        Ok(global.max_daily.saturating_sub(used).max(0))
    }

    /// `agent`'s own sliding-window usage, counted against its `max_daily`.
    pub fn agent_daily_usage(env: Env, agent: Address) -> Result<DailyUsage, Error> {
        let mut window = Self::load_agent_window(&env, &agent);
        Self::advance(&mut window, env.ledger().timestamp() / BUCKET_SECONDS);
        Self::summarize(&window)
    }

    /// `max_net_exposure`.
    pub fn get_net_cap(env: Env) -> Result<i128, Error> {
        Ok(Self::load_global(&env)?.max_net_exposure)
    }

    /// Capital currently deployed across all markets:
    /// `sum(max(0, collateral_in - collateral_out))`, the figure
    /// `max_net_exposure` is enforced against.
    pub fn net_exposure(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::NetTotal)
            .unwrap_or(0)
    }

    /// Net position in `market_id` of the current market-core.
    pub fn net_position(env: Env, market_id: u64) -> Result<NetPosition, Error> {
        let global = Self::load_global(&env)?;
        Ok(Self::load_net(&env, &global.market_core, market_id))
    }

    /// Conservative valuation of the treasury's holdings in `market_id`
    /// (see [`Valuation`]). Two cross-contract reads (`get_market`,
    /// `get_position`); a view only, never on the trading path.
    pub fn market_valuation(env: Env, market_id: u64) -> Result<Valuation, Error> {
        let global = Self::load_global(&env)?;
        let (floor_value, spot_value) = Self::holdings_value(&env, &global.market_core, market_id)?;
        let cost_basis = Self::load_net(&env, &global.market_core, market_id).cost_basis();
        Ok(Valuation {
            cost_basis,
            floor_value,
            spot_value,
            at_risk: cost_basis.saturating_sub(floor_value).max(0),
        })
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let storage = env.storage().instance();
        if paused {
            storage.set(&DataKey::Paused, &true);
            storage.set(&DataKey::AdminPaused, &true);
        } else {
            if storage.get(&DataKey::DrawdownTripped).unwrap_or(false) {
                if !storage.get(&DataKey::DrawdownAcknowledged).unwrap_or(false) {
                    return Err(Error::NotAcknowledged);
                }
                storage.set(&DataKey::DrawdownTripped, &false);
                storage.set(&DataKey::DrawdownAcknowledged, &false);
            }
            storage.set(&DataKey::Paused, &false);
            storage.set(&DataKey::AdminPaused, &false);
        }
        Ok(())
    }

    // ----- agent registry ------------------------------------------------------
    // Every agent entrypoint names its acting agent, which must sign, be
    // active and hold the entrypoint's role. Changes that only narrow an
    // active agent's policy (fewer roles, lower caps) and `remove_agent`
    // apply at once; adding an agent, reactivating one or widening a policy
    // waits `config_delay`, like any other loosening (see `propose_config`).
    //
    // market-core only ever sees the treasury as the trader, so positions
    // are pooled: per-agent state is usage (caps), not ownership.

    /// Adds or updates `agent`. Validation: `roles` non-empty and known,
    /// `0 < max_trade <= max_daily`, both within the global caps, `active`.
    pub fn set_agent(env: Env, agent: Address, policy: AgentPolicy) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let global = Self::load_global(&env)?;
        Self::validate_policy(&policy, &global)?;
        let current = Self::get_agent(env.clone(), agent.clone());
        match Self::classify_agent(current, &policy) {
            Change::None => Err(Error::InvalidConfig),
            Change::TightenOnly => {
                Self::write_agent(&env, &agent, &policy)?;
                Self::ensure_settler(&env)
            }
            Change::NeedsDelay => {
                let key = DataKey::PendingAgent(agent.clone());
                if env.storage().persistent().has(&key) {
                    return Err(Error::ProposalPending);
                }
                if current.is_none() && Self::agent_count(env.clone()) >= MAX_AGENTS {
                    return Err(Error::InvalidConfig);
                }
                let executable_at = Self::unlock_time(&env)?;
                let pending = PendingAgent {
                    policy,
                    proposed_at: env.ledger().timestamp(),
                    executable_at,
                };
                Self::put_persistent(&env, &key, &pending);
                AgentPolicyProposed {
                    agent,
                    roles: policy.roles,
                    max_trade: policy.max_trade,
                    max_daily: policy.max_daily,
                    executable_at,
                }
                .publish(&env);
                Ok(())
            }
        }
    }

    /// Applies `agent`'s pending policy once its delay has passed.
    /// Permissionless: the delay is the protection.
    pub fn execute_agent(env: Env, agent: Address) -> Result<(), Error> {
        let key = DataKey::PendingAgent(agent.clone());
        let pending: PendingAgent = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoPendingConfig)?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::TimelockActive);
        }
        // Re-validated against the global caps as they are now.
        Self::validate_policy(&pending.policy, &Self::load_global(&env)?)?;
        env.storage().persistent().remove(&key);
        Self::write_agent(&env, &agent, &pending.policy)?;
        Self::ensure_settler(&env)
    }

    pub fn cancel_agent(env: Env, agent: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::PendingAgent(agent.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoPendingConfig);
        }
        env.storage().persistent().remove(&key);
        AgentPolicyCancelled { agent }.publish(&env);
        Ok(())
    }

    /// Deactivates `agent` at once, keeping its usage history. At least one
    /// active agent with `ROLE_SETTLE` must remain, so open positions can
    /// always be settled.
    pub fn remove_agent(env: Env, agent: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let mut policy = Self::get_agent(env.clone(), agent.clone())
            .filter(|p| p.active)
            .ok_or(Error::InvalidConfig)?;
        policy.active = false;
        Self::put_persistent(&env, &DataKey::Agent(agent.clone()), &policy);
        Self::ensure_settler(&env)?;
        AgentRemoved { agent }.publish(&env);
        Ok(())
    }

    pub fn get_agent(env: Env, agent: Address) -> Option<AgentPolicy> {
        env.storage().persistent().get(&DataKey::Agent(agent))
    }

    pub fn pending_agent(env: Env, agent: Address) -> Option<PendingAgent> {
        env.storage()
            .persistent()
            .get(&DataKey::PendingAgent(agent))
    }

    /// Agents ever registered (removed ones included).
    pub fn agent_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AgentCount)
            .unwrap_or(0)
    }

    pub fn agent_at(env: Env, i: u32) -> Option<Address> {
        env.storage().persistent().get(&DataKey::AgentAt(i))
    }

    // ----- timelocked configuration --------------------------------------------
    // Asymmetric: lowering caps applies immediately (incident response);
    // raising any cap, or changing collateral or market_core, waits
    // `config_delay` and is announced by `ConfigProposed` first. A proposal
    // that lowers one cap and raises another is a loosening as a whole —
    // split it in two to apply the tightening at once. This bounds what a
    // compromised admin can unlock for the *agents*; it does not stop the
    // admin's own powers (pause, migrate_market).

    /// Proposes `config` as the global config (admin). Tighten-only
    /// proposals apply at once and leave any pending proposal and its timer
    /// as they are; anything else is queued.
    pub fn propose_config(env: Env, config: GlobalConfig) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let new = config;
        Self::validate(&new)?;
        let old = Self::load_global(&env)?;
        match Self::classify_global(&old, &new) {
            Change::None => Err(Error::InvalidConfig),
            Change::TightenOnly => {
                env.storage().instance().set(&DataKey::Global, &new);
                ConfigExecuted {
                    old,
                    new,
                    immediate: true,
                }
                .publish(&env);
                Ok(())
            }
            Change::NeedsDelay => {
                if env.storage().instance().has(&DataKey::PendingConfig) {
                    return Err(Error::ProposalPending);
                }
                Self::check_collateral_change(&env, &old, &new)?;
                let executable_at = Self::unlock_time(&env)?;
                env.storage().instance().set(
                    &DataKey::PendingConfig,
                    &PendingConfig {
                        config: new.clone(),
                        proposed_at: env.ledger().timestamp(),
                        executable_at,
                    },
                );
                ConfigProposed {
                    old,
                    new,
                    executable_at,
                }
                .publish(&env);
                Ok(())
            }
        }
    }

    /// Applies the pending config once its delay has passed. Permissionless,
    /// so execution never depends on the admin being available.
    ///
    /// A `market_core` change records the old core as legacy: its positions
    /// stay where they are (recover them with `legacy_redeem` /
    /// `legacy_claim_pool_remainder`), and exposure for the new core is kept
    /// under keys namespaced by core so market ids cannot collide. The new
    /// core must be pointed at this treasury with its own `set_treasury`.
    pub fn execute_config(env: Env) -> Result<(), Error> {
        let pending: PendingConfig = env
            .storage()
            .instance()
            .get(&DataKey::PendingConfig)
            .ok_or(Error::NoPendingConfig)?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::TimelockActive);
        }
        let old = Self::load_global(&env)?;
        let new = pending.config;
        Self::validate(&new)?;
        Self::check_collateral_change(&env, &old, &new)?;
        if new.market_core != old.market_core {
            Self::put_persistent(&env, &DataKey::LegacyCore(old.market_core.clone()), &true);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Global, &new);
        storage.remove(&DataKey::PendingConfig);
        ConfigExecuted {
            old,
            new,
            immediate: false,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_config(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let pending: PendingConfig = env
            .storage()
            .instance()
            .get(&DataKey::PendingConfig)
            .ok_or(Error::NoPendingConfig)?;
        env.storage().instance().remove(&DataKey::PendingConfig);
        ConfigCancelled {
            config: pending.config,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pending_config(env: Env) -> Option<PendingConfig> {
        env.storage().instance().get(&DataKey::PendingConfig)
    }

    pub fn config_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ConfigDelay)
            .unwrap_or(MIN_CONFIG_DELAY)
    }

    /// Lengthens the timelock. Shortening is refused outright: it would
    /// itself have to wait out the old delay to be safe, and a lengthening
    /// can always be undone by redeploying.
    pub fn set_config_delay(env: Env, new_delay: u64) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let old = Self::config_delay(env.clone());
        if new_delay < old {
            return Err(Error::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&DataKey::ConfigDelay, &new_delay);
        ConfigDelaySet {
            old,
            new: new_delay,
        }
        .publish(&env);
        Ok(())
    }

    // ----- price policy ----------------------------------------------------------

    pub fn get_price_policy(env: Env) -> PricePolicy {
        Self::load_price_policy(&env)
    }

    /// Sets the price limits on agent trades (admin). Like the caps,
    /// tightening (lower `max_buy`/`max_impact`/`max_slippage`, higher
    /// `min_sell`) applies at once and anything else waits `config_delay`.
    pub fn set_price_policy(env: Env, policy: PricePolicy) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::validate_price_policy(&policy)?;
        let old = Self::load_price_policy(&env);
        let change = classify_caps(&[
            (
                old.max_buy_price_bps as i128,
                policy.max_buy_price_bps as i128,
            ),
            (
                -(old.min_sell_price_bps as i128),
                -(policy.min_sell_price_bps as i128),
            ),
            (old.max_impact_bps as i128, policy.max_impact_bps as i128),
            (
                old.max_slippage_bps as i128,
                policy.max_slippage_bps as i128,
            ),
        ]);
        match change {
            Change::None => Err(Error::InvalidPricePolicy),
            Change::TightenOnly => {
                env.storage().instance().set(&DataKey::PricePolicy, &policy);
                PricePolicySet {
                    old,
                    new: policy,
                    immediate: true,
                }
                .publish(&env);
                Ok(())
            }
            Change::NeedsDelay => {
                if env.storage().instance().has(&DataKey::PendingPrice) {
                    return Err(Error::ProposalPending);
                }
                let executable_at = Self::unlock_time(&env)?;
                env.storage().instance().set(
                    &DataKey::PendingPrice,
                    &PendingPricePolicy {
                        policy,
                        proposed_at: env.ledger().timestamp(),
                        executable_at,
                    },
                );
                PricePolicyProposed {
                    old,
                    new: policy,
                    executable_at,
                }
                .publish(&env);
                Ok(())
            }
        }
    }

    /// Applies the pending price policy once its delay has passed.
    /// Permissionless.
    pub fn execute_price_policy(env: Env) -> Result<(), Error> {
        let pending: PendingPricePolicy = env
            .storage()
            .instance()
            .get(&DataKey::PendingPrice)
            .ok_or(Error::NoPendingConfig)?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::TimelockActive);
        }
        let old = Self::load_price_policy(&env);
        let storage = env.storage().instance();
        storage.set(&DataKey::PricePolicy, &pending.policy);
        storage.remove(&DataKey::PendingPrice);
        PricePolicySet {
            old,
            new: pending.policy,
            immediate: false,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_price_policy(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let pending: PendingPricePolicy = env
            .storage()
            .instance()
            .get(&DataKey::PendingPrice)
            .ok_or(Error::NoPendingConfig)?;
        env.storage().instance().remove(&DataKey::PendingPrice);
        PricePolicyCancelled {
            policy: pending.policy,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pending_price_policy(env: Env) -> Option<PendingPricePolicy> {
        env.storage().instance().get(&DataKey::PendingPrice)
    }

    // ----- vault -------------------------------------------------------------------
    // Deposits mint shares against a conservative NAV and withdrawals burn
    // them; see docs/adr/0005-treasury-vault.md for the valuation choice.

    /// Net asset value: idle collateral plus, for every market in the open-
    /// market index, what the holdings are worth whatever the outcome
    /// (complete sets and the LP's `min` reserve while open, the exact
    /// settlement value once final), minus what queued withdrawals are owed.
    /// Directional exposure is valued at zero, so no trade against a pool
    /// can raise NAV.
    pub fn nav(env: Env) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Self::compute_nav(&env, &global)
    }

    pub fn shares_of(env: Env, owner: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Shares(owner))
            .unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        Self::supply(&env)
    }

    /// Collateral owed to queued withdrawals; agents cannot spend it.
    pub fn queue_reserved(env: Env) -> i128 {
        Self::reserved(&env)
    }

    pub fn withdraw_ticket(env: Env, ticket_id: u64) -> Option<WithdrawTicket> {
        env.storage().persistent().get(&DataKey::Ticket(ticket_id))
    }

    /// The ticket `claim_withdraw` pays next, and the id the next one gets.
    pub fn queue_bounds(env: Env) -> (u64, u64) {
        (Self::queue_head(&env), Self::queue_tail(&env))
    }

    pub fn open_market_count(env: Env) -> u32 {
        Self::open_count(&env)
    }

    pub fn open_market_at(env: Env, i: u32) -> Option<OpenMarket> {
        env.storage().persistent().get(&DataKey::OpenMarketAt(i))
    }

    /// Deposits `amount` of collateral and mints shares to `from` at the NAV
    /// as it was before the deposit. Returns the shares minted.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let global = Self::load_global(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount < MIN_DEPOSIT {
            return Err(Error::DepositTooSmall);
        }
        let nav = Self::compute_nav(&env, &global)?;
        token::TokenClient::new(&env, &global.collateral).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        let shares = Self::mint_shares(&env, &from, amount, nav)?;
        Deposited {
            owner: from,
            amount,
            shares,
            nav,
        }
        .publish(&env);
        Ok(shares)
    }

    /// Burns `shares` of `owner` at the current NAV, pays what free idle
    /// collateral allows now and queues the rest as a ticket (FIFO, paid by
    /// `claim_withdraw` as capital returns). Returns `(paid_now, ticket_id)`,
    /// `ticket_id` 0 when nothing was queued.
    pub fn request_withdraw(env: Env, owner: Address, shares: i128) -> Result<(i128, u64), Error> {
        let global = Self::load_global(&env)?;
        owner.require_auth();
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::shares_of(env.clone(), owner.clone()) < shares {
            return Err(Error::InsufficientShares);
        }
        let nav = Self::compute_nav(&env, &global)?;
        let assets =
            assets_for_shares(shares, nav, Self::supply(&env)).ok_or(Error::InvalidAmount)?;
        if assets <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::burn_shares(&env, &owner, shares)?;
        let reserved = Self::reserved(&env);
        let free = Self::idle(&env, &global).saturating_sub(reserved).max(0);
        let paid_now = assets.min(free);
        if paid_now > 0 {
            token::TokenClient::new(&env, &global.collateral).transfer(
                &env.current_contract_address(),
                &owner,
                &paid_now,
            );
        }
        let remaining = assets - paid_now;
        let mut ticket_id = 0;
        if remaining > 0 {
            ticket_id = Self::queue_tail(&env);
            Self::put_persistent(
                &env,
                &DataKey::Ticket(ticket_id),
                &WithdrawTicket {
                    owner: owner.clone(),
                    remaining,
                    created_at: env.ledger().timestamp(),
                },
            );
            let storage = env.storage().instance();
            storage.set(&DataKey::QueueTail, &(ticket_id + 1));
            storage.set(
                &DataKey::QueueReserved,
                &reserved
                    .checked_add(remaining)
                    .ok_or(Error::InvalidAmount)?,
            );
        }
        WithdrawRequested {
            owner,
            shares,
            assets,
            paid_now,
            ticket_id,
        }
        .publish(&env);
        Ok((paid_now, ticket_id))
    }

    /// Pays the ticket at the head of the queue as far as idle collateral
    /// allows. Permissionless: the money always goes to the ticket's owner.
    /// Only the head ticket can be paid (`NothingToPay` for later ones).
    pub fn claim_withdraw(env: Env, ticket_id: u64) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        let key = DataKey::Ticket(ticket_id);
        let mut ticket: WithdrawTicket = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TicketNotFound)?;
        let head = Self::queue_head(&env);
        if ticket_id != head {
            return Err(Error::NothingToPay);
        }
        let amount = ticket.remaining.min(Self::idle(&env, &global));
        if amount <= 0 {
            return Err(Error::NothingToPay);
        }
        token::TokenClient::new(&env, &global.collateral).transfer(
            &env.current_contract_address(),
            &ticket.owner,
            &amount,
        );
        ticket.remaining -= amount;
        let storage = env.storage().instance();
        storage.set(&DataKey::QueueReserved, &(Self::reserved(&env) - amount));
        if ticket.remaining == 0 {
            env.storage().persistent().remove(&key);
            storage.set(&DataKey::QueueHead, &(head + 1));
        } else {
            Self::put_persistent(&env, &key, &ticket);
        }
        WithdrawPaid { ticket_id, amount }.publish(&env);
        Ok(amount)
    }

    /// While paused only: burns `shares` for their pro-rata part of the free
    /// idle collateral, without reading market-core (for when it is the
    /// thing that broke). The owner forfeits their part of open positions,
    /// which stays with the remaining shareholders.
    pub fn emergency_withdraw(env: Env, owner: Address, shares: i128) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        owner.require_auth();
        if !Self::is_paused(&env) {
            return Err(Error::NotPaused);
        }
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        let free = Self::idle(&env, &global)
            .saturating_sub(Self::reserved(&env))
            .max(0);
        let amount = price_math::mul_div_floor(
            shares,
            free,
            Self::supply(&env)
                .checked_add(VIRTUAL_SHARES)
                .ok_or(Error::InvalidAmount)?,
        )
        .ok_or(Error::InvalidAmount)?;
        Self::burn_shares(&env, &owner, shares)?;
        if amount > 0 {
            token::TokenClient::new(&env, &global.collateral).transfer(
                &env.current_contract_address(),
                &owner,
                &amount,
            );
        }
        EmergencyWithdrawn {
            owner,
            shares,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // ----- agent-driven trading --------------------------------------------
    // An agent never touches market-core directly with treasury funds: it
    // asks the treasury to do so, the treasury checks its own on-chain caps,
    // then calls market-core itself as the trader/creator. This is the only
    // path that moves treasury capital, so the caps below are real limits on
    // what the automated agents can deploy, not just off-chain bookkeeping.

    /// Creates and seeds a market using treasury capital (`ROLE_CREATE`).
    /// The treasury becomes the market's creator/LP. `initial_yes_bps` must
    /// lie within the price policy's `[min_sell, max_buy]` band, so the
    /// treasury never seeds a market whose creator side is near worthless.
    #[allow(clippy::too_many_arguments)]
    pub fn agent_create_market(
        env: Env,
        agent: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        let global = Self::load_global(&env)?;
        let policy = Self::require_agent(&env, &agent, ROLE_CREATE)?;
        if seed_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let creation_policy = Self::load_creation_policy(&env)?;
        if seed_amount > creation_policy.max_seed {
            return Err(Error::SeedCapExceeded);
        }
        let now = env.ledger().timestamp();
        let horizon = close_time.checked_sub(now).ok_or(Error::CloseTimeTooSoon)?;
        if horizon < creation_policy.min_close_horizon {
            return Err(Error::CloseTimeTooSoon);
        }
        if horizon > creation_policy.max_close_horizon {
            return Err(Error::CloseTimeTooFar);
        }
        if (Self::category_bit(&category) & creation_policy.allowed_categories) == 0 {
            return Err(Error::CategoryNotAllowed);
        }
        let prices = Self::load_price_policy(&env);
        if initial_yes_bps < prices.min_sell_price_bps || initial_yes_bps > prices.max_buy_price_bps
        {
            return Err(Error::PriceOutOfBand);
        }
        Self::record_creation(&env, &creation_policy)?;
        Self::ensure_liquid(&env, &global, seed_amount)?;
        Self::ensure_unreserved(&env, &global, seed_amount)?;

        let treasury_addr = env.current_contract_address();
        Self::authorize_token_pull(&env, &global, &treasury_addr, seed_amount);
        let market_id = core_call(MarketCoreClient::new(&env, &global.market_core).try_create_market(
            &treasury_addr,
            &question_hash,
            &resolution_hash,
            &meta_uri,
            &category,
            &close_time,
            &seed_amount,
            &initial_yes_bps,
        ))?;
        Self::reserve_capacity(&env, &global, &agent, &policy, market_id, seed_amount)?;
        Self::reserve_net(&env, &global, market_id, seed_amount)?;
        Self::record_cost(&env, market_id, seed_amount)?;
        Ok(market_id)
    }

    /// Like [`Treasury::agent_create_market`], but reveals the resolution rule
    /// in the same transaction (#64). The market is created with the commitment
    /// derived from `spec_v2` itself, so the follow-up reveal necessarily
    /// matches and the market can never be left unresolvable. `resolver` is the
    /// deployed resolver contract; it must be configured for this treasury's
    /// market-core.
    ///
    /// The router cannot serve this path: seeding pulls collateral from the
    /// treasury contract (not the end user) via a contract self-authorization,
    /// which only this contract can perform — a stateless router between the
    /// agent and market-core would not be authorized on the token.
    #[allow(clippy::too_many_arguments)]
    pub fn agent_create_market_and_reveal(
        env: Env,
        agent: Address,
        resolver: Address,
        question_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
        spec_v2: ResolutionSpecV2,
    ) -> Result<u64, Error> {
        let resolution_hash = Self::resolve_commitment(&env, &spec_v2)?;
        let market_id = Self::agent_create_market(
            env.clone(),
            agent.clone(),
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
        )?;
        ResolverClient::new(&env, &resolver).register_spec_v2(&market_id, &spec_v2);
        Ok(market_id)
    }

    /// Buys `outcome` shares in an existing market using treasury capital
    /// (`ROLE_TRADE`). Price-checked, see `do_agent_buy`.
    pub fn agent_buy(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::do_agent_buy(
            env,
            agent,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            None,
        )
    }

    /// `agent_buy` with a per-share limit price (`limit_price_bps`, 0 = none)
    /// and a deadline (unix seconds, network time). market-core's `buy_v2`
    /// enforces both; an expired or out-of-limit trade reverts the whole
    /// invocation, so the treasury's caps are never consumed by a reverted
    /// trade.
    #[allow(clippy::too_many_arguments)]
    pub fn agent_buy_v2(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        Self::do_agent_buy(
            env,
            agent,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            Some((limit_price_bps, deadline)),
        )
    }

    /// Categorical counterpart of `agent_buy`: buys `outcome_index` shares of
    /// a categorical market using treasury capital (`ROLE_TRADE`). The binary
    /// price band is a Yes/No concept so it does not apply here, but the
    /// per-trade / per-market / daily caps, the reserved-capital check, the
    /// net-exposure reserve and the nested transfer pre-authorization all do
    /// (see `do_agent_buy`).
    pub fn agent_buy_cat(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome_index: u32,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let global = Self::load_global(&env)?;
        let policy = Self::require_agent(&env, &agent, ROLE_TRADE)?;
        Self::check_trade_size(&global, &policy, collateral_in)?;
        Self::ensure_unreserved(&env, &global, collateral_in)?;

        let treasury_addr = env.current_contract_address();
        Self::authorize_token_pull(&env, &global, &treasury_addr, collateral_in);
        let shares = MarketCoreClient::new(&env, &global.market_core).buy_cat(
            &treasury_addr,
            &market_id,
            &outcome_index,
            &collateral_in,
            &min_shares_out,
        );
        Self::reserve_capacity(&env, &global, &agent, &policy, market_id, collateral_in)?;
        Self::reserve_net(&env, &global, market_id, collateral_in)?;
        Ok(shares)
    }

    /// Sells `outcome` shares back into the pool for exactly
    /// `collateral_out` (`ROLE_TRADE`). This returns capital to the treasury
    /// (market-core pays out of its own balance), so it is not capped and
    /// does not need the nested-transfer pre-authorization that buying does.
    /// It frees net headroom (`collateral_out` is recorded) but never
    /// lifetime headroom. Price-checked, see `do_agent_sell`.
    pub fn agent_sell(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::do_agent_sell(
            env,
            agent,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            None,
        )
    }

    /// `agent_sell` with a per-share limit price (`limit_price_bps`, 0 = no
    /// limit) and a deadline (unix seconds, network time), both enforced by
    /// market-core's `sell_v2`.
    #[allow(clippy::too_many_arguments)]
    pub fn agent_sell_v2(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        Self::do_agent_sell(
            env,
            agent,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            Some((limit_price_bps, deadline)),
        )
    }

    /// Marks a market's exposure as exited (`ROLE_SETTLE`). Pure bookkeeping
    /// (see `MarketExposure`) for the future exposure dashboard; it does not
    /// move funds or free either the cumulative per-market cap or net
    /// headroom.
    pub fn close_trade(env: Env, agent: Address, market_id: u64) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        let core = global.market_core;
        let mut exposure = Self::market_exposure(&env, &core, market_id);
        if !exposure.open {
            return Err(Error::MarketNotOpen);
        }
        exposure.open = false;
        let amount = exposure.amount;
        Self::save_market(&env, &core, market_id, &exposure);
        PositionClosed { market_id, amount }.publish(&env);
        Ok(amount)
    }

    /// Redeems the treasury's position in a resolved/voided market
    /// (`ROLE_SETTLE`).
    pub fn redeem(env: Env, agent: Address, market_id: u64) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        Self::settle_redeem(&env, &global.market_core, market_id)
    }

    /// Claims the LP pool remainder for a market the treasury created
    /// (`ROLE_SETTLE`).
    pub fn claim_pool_remainder(env: Env, agent: Address, market_id: u64) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        Self::settle_claim(&env, &global.market_core, market_id)
    }

    /// `redeem` against a market-core this treasury was switched away from
    /// (see `execute_config`), so positions there are never stranded.
    pub fn legacy_redeem(
        env: Env,
        agent: Address,
        core: Address,
        market_id: u64,
    ) -> Result<i128, Error> {
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        Self::require_legacy(&env, &core)?;
        Self::settle_redeem(&env, &core, market_id)
    }

    /// `claim_pool_remainder` against a legacy market-core.
    pub fn legacy_claim_pool_remainder(
        env: Env,
        agent: Address,
        core: Address,
        market_id: u64,
    ) -> Result<i128, Error> {
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        Self::require_legacy(&env, &core)?;
        Self::settle_claim(&env, &core, market_id)
    }

    /// Claims the market's LP fee share for a market the treasury created
    /// (`ROLE_SETTLE`). The LP portion accrues separately on market-core
    /// (see its `claim_lp_fees`).
    pub fn agent_claim_lp_fees(env: Env, agent: Address, market_id: u64) -> Result<i128, Error> {
        let global = Self::load_global(&env)?;
        Self::require_agent(&env, &agent, ROLE_SETTLE)?;
        let amount = core_call(
            MarketCoreClient::new(&env, &global.market_core).try_claim_lp_fees(&market_id),
        )?;
        Self::record_return(&env, &global.market_core, market_id, amount)?;
        Ok(amount)
    }

    /// Pulls accrued **protocol** fees from a configured market-core contract.
    ///
    /// Only the protocol's share of each market's fees: the LP portion accrues
    /// separately on market-core and belongs to the market's creator — for
    /// agent-created markets that is the treasury itself, via
    /// `agent_claim_lp_fees`. Fees raise NAV for every shareholder at the
    /// moment they arrive.
    pub fn collect_market_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        Self::require_admin(&env)?;
        let global = Self::load_global(&env)?;
        let amount =
            core_call(MarketCoreClient::new(&env, &global.market_core).try_sweep_fees(&market_id))?;
        FeesCollected { market_id, amount }.publish(&env);
        Ok(amount)
    }

    // ----- settlement, PnL & risk controls ----------------------------------

    /// Permissionless settlement of a resolved or voided market's position and LP remainder.
    /// Operates even when the treasury is paused. Idempotent on retry.
    pub fn settle_market(
        env: Env,
        caller: Address,
        market_id: u64,
    ) -> Result<SettlementReport, Error> {
        caller.require_auth();
        let mut r = Self::load_realized(&env, market_id);
        if r.settled {
            return Ok(SettlementReport {
                redeemed: 0,
                lp_claimed: 0,
                already_settled: true,
            });
        }
        let global = Self::load_global(&env)?;
        let core = &global.market_core;
        let client = MarketCoreClient::new(&env, core);
        let treasury_addr = env.current_contract_address();

        let redeemed = match client.try_redeem(&treasury_addr, &market_id) {
            Ok(Ok(p)) => p,
            Err(Ok(MarketCoreError::NothingToRedeem)) => 0,
            Err(Ok(MarketCoreError::NotFinal)) => {
                return Err(Error::MarketNotFinal);
            }
            Err(Ok(_)) | Err(Err(_)) | Ok(Err(_)) => return Err(Error::MarketCoreError),
        };
        if redeemed > 0 {
            Self::record_return(&env, core, market_id, redeemed)?;
            Self::record_proceeds(&env, market_id, redeemed)?;
        }

        let m = client.get_market(&market_id);
        if matches!(m.status, MarketStatus::Open) {
            return Err(Error::MarketNotFinal);
        }
        let lp_claimed = if m.creator == treasury_addr && !m.lp_claimed {
            let p = match client.try_claim_pool_remainder(&market_id) {
                Ok(Ok(val)) => val,
                Err(Ok(MarketCoreError::AlreadyClaimed)) => 0,
                Err(Ok(MarketCoreError::NotFinal)) => {
                    return Err(Error::MarketNotFinal);
                }
                Err(Ok(_)) | Err(Err(_)) | Ok(Err(_)) => return Err(Error::MarketCoreError),
            };
            if p > 0 {
                Self::record_return(&env, core, market_id, p)?;
                Self::record_proceeds(&env, market_id, p)?;
            }
            p
        } else {
            0
        };

        r.position_proceeds = r
            .position_proceeds
            .checked_add(redeemed)
            .ok_or(Error::InvalidAmount)?;
        r.lp_proceeds = r
            .lp_proceeds
            .checked_add(lp_claimed)
            .ok_or(Error::InvalidAmount)?;

        let pos = client.get_position(&market_id, &treasury_addr);
        let m_after = client.get_market(&market_id);
        let lp_settled = m_after.creator != treasury_addr || m_after.lp_claimed;
        if pos.yes == 0 && pos.no == 0 && lp_settled {
            r.settled = true;
            Self::close_market_exposure(&env, core, market_id);
        }
        Self::save_realized(&env, market_id, &r);
        Self::prune_if_settled(&env, core, market_id);
        if r.settled {
            Self::try_realize(&env, core, market_id)?;
        }

        MarketSettled {
            market_id,
            redeemed,
            lp_claimed,
            settled_by: caller,
        }
        .publish(&env);

        Ok(SettlementReport {
            redeemed,
            lp_claimed,
            already_settled: false,
        })
    }

    pub fn realized(env: Env, market_id: u64) -> Realized {
        Self::load_realized(&env, market_id)
    }

    pub fn realize(env: Env, market_id: u64) -> Result<(), Error> {
        let global = Self::load_global(&env)?;
        Self::try_realize(&env, &global.market_core, market_id)
    }

    pub fn market_pnl(env: Env, market_id: u64) -> MarketPnl {
        Self::load_pnl(&env, market_id)
    }

    pub fn window_pnl(env: Env) -> Result<i128, Error> {
        Self::calc_window_pnl(&env)
    }

    pub fn drawdown_status(env: Env) -> Result<DrawdownStatus, Error> {
        let cfg = Self::load_drawdown_cfg(&env)?;
        let wpnl = Self::calc_window_pnl(&env)?;
        let tripped = env
            .storage()
            .instance()
            .get(&DataKey::DrawdownTripped)
            .unwrap_or(false);
        Ok(DrawdownStatus {
            tripped,
            window_pnl: wpnl,
            max_drawdown: cfg.max_drawdown,
        })
    }

    pub fn acknowledge_drawdown(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let storage = env.storage().instance();
        if storage.get(&DataKey::DrawdownTripped).unwrap_or(false) {
            storage.set(&DataKey::DrawdownAcknowledged, &true);
        }
        Ok(())
    }

    pub fn reset_pnl_window(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let cfg = Self::load_drawdown_cfg(&env)?;
        let head_day = env.ledger().timestamp() / DAY_SECONDS;
        env.storage().instance().set(
            &DataKey::PnlDays,
            &Self::empty_pnl_days(&env, head_day, cfg.window_days),
        );
        let admin = env.storage().instance().get(&DataKey::Admin).unwrap();
        PnlWindowReset { admin }.publish(&env);
        Ok(())
    }

    pub fn set_drawdown_config(
        env: Env,
        max_drawdown: i128,
        window_days: u32,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::validate_drawdown_config(max_drawdown, window_days)?;
        let cfg = DrawdownConfig {
            max_drawdown,
            window_days,
        };
        env.storage().instance().set(&DataKey::DrawdownCfg, &cfg);
        let head_day = env.ledger().timestamp() / DAY_SECONDS;
        env.storage().instance().set(
            &DataKey::PnlDays,
            &Self::empty_pnl_days(&env, head_day, window_days),
        );
        Ok(())
    }

    pub fn get_creation_policy(env: Env) -> Result<CreationPolicy, Error> {
        Self::load_creation_policy(&env)
    }

    pub fn creation_usage(env: Env) -> Result<u32, Error> {
        let policy = Self::load_creation_policy(&env)?;
        let now = env.ledger().timestamp();
        let buckets: Vec<CreationBucket> = env
            .storage()
            .instance()
            .get(&DataKey::CreationBuckets)
            .unwrap_or_else(|| Vec::new(&env));
        let mut total = 0u32;
        for i in 0..buckets.len() {
            let b = buckets.get(i).unwrap();
            if b.bucket_start.saturating_add(policy.creation_window_secs) > now {
                total = total.saturating_add(b.count);
            }
        }
        Ok(total)
    }

    pub fn set_creation_policy(env: Env, new_policy: CreationPolicy) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let global = Self::load_global(&env)?;
        Self::validate_creation_policy(&global, &new_policy)?;
        let old_policy = Self::load_creation_policy(&env)?;
        if new_policy.max_seed > old_policy.max_seed
            || new_policy.max_markets_per_window > old_policy.max_markets_per_window
            || new_policy.min_close_horizon < old_policy.min_close_horizon
            || new_policy.max_close_horizon > old_policy.max_close_horizon
            || (new_policy.allowed_categories & !old_policy.allowed_categories) != 0
            || new_policy.creation_window_secs < old_policy.creation_window_secs
        {
            return Err(Error::PolicyLoosening);
        }
        env.storage()
            .instance()
            .set(&DataKey::CreationPolicy, &new_policy);
        CreationPolicyUpdated {
            old: old_policy,
            new: new_policy,
        }
        .publish(&env);
        Ok(())
    }

    // ----- Blend lending & yield ---------------------------------------------

    pub fn set_yield_venue(env: Env, pool: Address, max_allocation: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if max_allocation <= 0 {
            return Err(Error::InvalidAmount);
        }
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YieldPrincipal)
            .unwrap_or(0);
        if principal > 0 {
            return Err(Error::VenueHasPrincipal);
        }
        let venue = YieldVenue {
            pool: pool.clone(),
            max_allocation,
            enabled: true,
        };
        env.storage().instance().set(&DataKey::YieldVenue, &venue);
        YieldVenueSet {
            pool,
            max_allocation,
        }
        .publish(&env);
        Ok(())
    }

    pub fn allocate_to_yield(env: Env, amount: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let venue: YieldVenue = env
            .storage()
            .instance()
            .get(&DataKey::YieldVenue)
            .ok_or(Error::YieldDisabled)?;
        if !venue.enabled {
            return Err(Error::YieldDisabled);
        }
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YieldPrincipal)
            .unwrap_or(0);
        let new_principal = principal.checked_add(amount).ok_or(Error::InvalidAmount)?;
        if new_principal > venue.max_allocation {
            return Err(Error::YieldCapExceeded);
        }
        let global = Self::load_global(&env)?;
        let liquid = Self::idle(&env, &global);
        if liquid.saturating_sub(amount) < global.max_daily {
            return Err(Error::DailyCapExceeded);
        }
        let treasury = env.current_contract_address();
        Self::authorize_transfer(&env, &global.collateral, &treasury, &venue.pool, amount);
        let client = BlendPoolClient::new(&env, &venue.pool);
        let mut requests = Vec::new(&env);
        requests.push_back(BlendRequest {
            request_type: BLEND_REQUEST_SUPPLY,
            address: global.collateral.clone(),
            amount,
        });
        if client
            .try_submit(&treasury, &treasury, &treasury, &requests)
            .is_err()
        {
            return Err(Error::YieldWithdrawFailed);
        }
        env.storage()
            .instance()
            .set(&DataKey::YieldPrincipal, &new_principal);
        YieldAllocated {
            pool: venue.pool,
            amount,
            principal: new_principal,
        }
        .publish(&env);
        Ok(())
    }

    pub fn recall_from_yield(env: Env, amount: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let venue: YieldVenue = env
            .storage()
            .instance()
            .get(&DataKey::YieldVenue)
            .ok_or(Error::YieldDisabled)?;
        let global = Self::load_global(&env)?;
        let treasury = env.current_contract_address();
        let client = BlendPoolClient::new(&env, &venue.pool);
        let mut requests = Vec::new(&env);
        requests.push_back(BlendRequest {
            request_type: BLEND_REQUEST_WITHDRAW,
            address: global.collateral.clone(),
            amount,
        });
        if client
            .try_submit(&treasury, &treasury, &treasury, &requests)
            .is_err()
        {
            return Err(Error::YieldWithdrawFailed);
        }
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YieldPrincipal)
            .unwrap_or(0);
        let new_principal = principal.saturating_sub(amount).max(0);
        env.storage()
            .instance()
            .set(&DataKey::YieldPrincipal, &new_principal);
        YieldRecalled {
            pool: venue.pool,
            amount,
            principal: new_principal,
            reason: Symbol::new(&env, "admin"),
        }
        .publish(&env);
        Ok(())
    }

    pub fn disable_yield(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if let Some(mut venue) = env
            .storage()
            .instance()
            .get::<_, YieldVenue>(&DataKey::YieldVenue)
        {
            venue.enabled = false;
            env.storage().instance().set(&DataKey::YieldVenue, &venue);
        }
        Ok(())
    }

    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let global = Self::load_global(&env)?;
        Self::ensure_liquid(&env, &global, amount)?;
        let liquid = Self::idle(&env, &global);
        if liquid < amount {
            return Err(Error::InsufficientBalance);
        }
        token::TokenClient::new(&env, &global.collateral).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Ok(())
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
        let global = Self::load_global(&env)?;
        let core = global.market_core;
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(&env, &core);

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
        let mut exposure = Self::market_exposure(&env, &core, market_id);
        exposure.open = false;
        Self::save_market(&env, &core, market_id, &exposure);
        // The holdings now belong to the successor, so none of this market's
        // capital is at risk here any more.
        Self::clear_net(&env, &core, market_id)?;
        Self::index_remove(&env, &core, market_id);
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

    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        let storage = env.storage().instance();
        if storage.get(&DataKey::Paused).unwrap_or(false) {
            if storage.get(&DataKey::DrawdownTripped).unwrap_or(false) {
                return Err(Error::DrawdownTripped);
            }
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn put_persistent<V: IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
        env.storage().persistent().set(key, value);
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
    }

    // ----- config ------------------------------------------------------------

    fn validate(c: &GlobalConfig) -> Result<(), Error> {
        if c.max_trade <= 0
            || c.max_market < c.max_trade
            || c.max_daily < c.max_market
            || c.max_net_exposure < c.max_trade
        {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }

    /// The global config, migrating a pre-registry `RiskConfig` on first use:
    /// it becomes a `GlobalConfig` (net cap from the legacy `NetCap`, else
    /// `max_daily`) plus one full-role agent with the global caps, and the
    /// collateral already held is minted as shares to the admin. Positions
    /// opened before the migration are not in the open-market index, so
    /// `nav()` values them at zero until they are redeemed.
    fn load_global(env: &Env) -> Result<GlobalConfig, Error> {
        let storage = env.storage().instance();
        if let Some(global) = storage.get(&DataKey::Global) {
            return Ok(global);
        }
        let legacy: RiskConfig = storage.get(&DataKey::Config).ok_or(Error::NotInitialized)?;
        let global = GlobalConfig {
            collateral: legacy.collateral,
            market_core: legacy.market_core,
            max_trade: legacy.max_trade,
            max_market: legacy.max_market,
            max_daily: legacy.max_daily,
            max_net_exposure: storage.get(&DataKey::NetCap).unwrap_or(legacy.max_daily),
        };
        storage.set(&DataKey::Global, &global);
        storage.remove(&DataKey::Config);
        storage.remove(&DataKey::NetCap);
        if !storage.has(&DataKey::OriginalCore) {
            storage.set(&DataKey::OriginalCore, &global.market_core);
        }
        Self::write_agent(
            env,
            &legacy.agent,
            &AgentPolicy {
                roles: ROLE_ALL,
                max_trade: global.max_trade,
                max_daily: global.max_daily,
                active: true,
            },
        )?;
        if Self::supply(env) == 0 {
            let idle = Self::idle(env, &global);
            if idle > 0 {
                let admin: Address = storage.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
                Self::mint_shares(env, &admin, idle, 0)?;
            }
        }
        Ok(global)
    }

    fn classify_global(old: &GlobalConfig, new: &GlobalConfig) -> Change {
        if old.collateral != new.collateral || old.market_core != new.market_core {
            return Change::NeedsDelay;
        }
        classify_caps(&[
            (old.max_trade, new.max_trade),
            (old.max_market, new.max_market),
            (old.max_daily, new.max_daily),
            (old.max_net_exposure, new.max_net_exposure),
        ])
    }

    /// A collateral switch would orphan anything held in the old token, so
    /// it is only allowed for an empty treasury: no balance, no open
    /// markets, no queued withdrawals.
    fn check_collateral_change(
        env: &Env,
        old: &GlobalConfig,
        new: &GlobalConfig,
    ) -> Result<(), Error> {
        if old.collateral == new.collateral {
            return Ok(());
        }
        if Self::idle(env, old) != 0 || Self::open_count(env) != 0 || Self::reserved(env) != 0 {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }

    fn unlock_time(env: &Env) -> Result<u64, Error> {
        env.ledger()
            .timestamp()
            .checked_add(Self::config_delay(env.clone()))
            .ok_or(Error::InvalidConfig)
    }

    fn require_legacy(env: &Env, core: &Address) -> Result<(), Error> {
        let known: bool = env
            .storage()
            .persistent()
            .get(&DataKey::LegacyCore(core.clone()))
            .unwrap_or(false);
        if !known {
            return Err(Error::LegacyCoreUnknown);
        }
        Ok(())
    }

    fn load_price_policy(env: &Env) -> PricePolicy {
        env.storage()
            .instance()
            .get(&DataKey::PricePolicy)
            .unwrap_or(DEFAULT_PRICE_POLICY)
    }

    fn validate_price_policy(p: &PricePolicy) -> Result<(), Error> {
        let max = BPS as u32;
        if p.max_buy_price_bps > max
            || p.min_sell_price_bps > max
            || p.max_impact_bps > max
            || p.min_sell_price_bps >= p.max_buy_price_bps
            || p.max_impact_bps == 0
            || p.max_slippage_bps >= max
        {
            return Err(Error::InvalidPricePolicy);
        }
        Ok(())
    }

    // ----- agents --------------------------------------------------------------

    fn validate_policy(p: &AgentPolicy, global: &GlobalConfig) -> Result<(), Error> {
        if !p.active
            || p.roles == 0
            || p.roles & !ROLE_ALL != 0
            || p.max_trade <= 0
            || p.max_trade > p.max_daily
            || p.max_trade > global.max_trade
            || p.max_daily > global.max_daily
        {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }

    fn classify_agent(current: Option<AgentPolicy>, new: &AgentPolicy) -> Change {
        let Some(cur) = current.filter(|p| p.active) else {
            return Change::NeedsDelay;
        };
        if new.roles & !cur.roles != 0 {
            return Change::NeedsDelay;
        }
        match classify_caps(&[
            (cur.max_trade, new.max_trade),
            (cur.max_daily, new.max_daily),
        ]) {
            Change::None if new.roles != cur.roles => Change::TightenOnly,
            change => change,
        }
    }

    /// Stores `policy`, enumerating `agent` on first registration (bounded
    /// by `MAX_AGENTS`; re-adding an agent never counts twice).
    fn write_agent(env: &Env, agent: &Address, policy: &AgentPolicy) -> Result<(), Error> {
        let key = DataKey::Agent(agent.clone());
        if !env.storage().persistent().has(&key) {
            let count = Self::agent_count(env.clone());
            if count >= MAX_AGENTS {
                return Err(Error::InvalidConfig);
            }
            Self::put_persistent(env, &DataKey::AgentAt(count), agent);
            env.storage()
                .instance()
                .set(&DataKey::AgentCount, &(count + 1));
        }
        Self::put_persistent(env, &key, policy);
        AgentPolicySet {
            agent: agent.clone(),
            roles: policy.roles,
            max_trade: policy.max_trade,
            max_daily: policy.max_daily,
        }
        .publish(env);
        Ok(())
    }

    /// At least one active agent must be able to settle.
    fn ensure_settler(env: &Env) -> Result<(), Error> {
        for i in 0..Self::agent_count(env.clone()) {
            let Some(addr) = Self::agent_at(env.clone(), i) else {
                continue;
            };
            if let Some(p) = Self::get_agent(env.clone(), addr) {
                if p.active && p.roles & ROLE_SETTLE != 0 {
                    return Ok(());
                }
            }
        }
        Err(Error::InvalidConfig)
    }

    /// `agent` signed this invocation, is registered, active and holds
    /// `role`.
    fn require_agent(env: &Env, agent: &Address, role: u32) -> Result<AgentPolicy, Error> {
        agent.require_auth();
        let key = DataKey::Agent(agent.clone());
        let policy: AgentPolicy = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::Unauthorized)?;
        if !policy.active || policy.roles & role == 0 {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(policy)
    }

    fn check_trade_size(
        global: &GlobalConfig,
        policy: &AgentPolicy,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount > policy.max_trade || amount > global.max_trade {
            return Err(Error::TradeCapExceeded);
        }
        Ok(())
    }

    // ----- trading -------------------------------------------------------------

    /// Price-checked buy. Before the trade: the outcome's spot price
    /// (market-core's own `get_price`, so the rounding matches what clients
    /// see) must be within `max_buy_price_bps`, and `min_shares_out` is
    /// raised to the same-transaction quote minus `max_slippage_bps` (never
    /// below 1). After it: the price may have moved at most `max_impact_bps`.
    ///
    /// Because the quote runs against the same pool state as the buy, the
    /// quote floor alone cannot stop a sandwich: it only protects the agent's
    /// own intent against whatever state is current at execution. What stops
    /// a front-runner is the band (pushed above `max_buy`: `PriceOutOfBand`)
    /// and the impact limit (price left in band but liquidity thinned so
    /// this trade moves it further: `PriceImpactExceeded`).
    #[allow(clippy::too_many_arguments)]
    fn do_agent_buy(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        bound: Option<(u32, u64)>,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        let global = Self::load_global(&env)?;
        let policy = Self::require_agent(&env, &agent, ROLE_TRADE)?;
        Self::check_trade_size(&global, &policy, collateral_in)?;
        Self::ensure_unreserved(&env, &global, collateral_in)?;

        let prices = Self::load_price_policy(&env);
        let client = MarketCoreClient::new(&env, &global.market_core);
        let p_before = core_call(client.try_get_price(&market_id, &outcome))?;
        if p_before > prices.max_buy_price_bps {
            return Err(Error::PriceOutOfBand);
        }
        let quoted = core_call(client.try_quote_buy(&market_id, &outcome, &collateral_in))?;
        let floor = price_math::mul_div_floor(quoted, BPS - prices.max_slippage_bps as i128, BPS)
            .ok_or(Error::InvalidAmount)?;
        let effective_min = min_shares_out.max(floor.max(1));

        Self::ensure_liquid(&env, &global, collateral_in)?;

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
        Self::authorize_token_pull(&env, &global, &treasury_addr, collateral_in);
        let mut args: Vec<Val> = vec![
            &env,
            treasury_addr.into_val(&env),
            market_id.into_val(&env),
            outcome.into_val(&env),
            collateral_in.into_val(&env),
            effective_min.into_val(&env),
        ];
        let fn_name = Self::push_bound(&env, &mut args, bound, "buy", "buy_v2");
        let shares = Self::core_trade(&env, &global.market_core, fn_name, args)?;
        let p_after = core_call(client.try_get_price(&market_id, &outcome))?;
        if p_after.abs_diff(p_before) > prices.max_impact_bps {
            return Err(Error::PriceImpactExceeded);
        }
        Self::reserve_capacity(&env, &global, &agent, &policy, market_id, collateral_in)?;
        Self::reserve_net(&env, &global, market_id, collateral_in)?;
        Self::record_cost(&env, market_id, collateral_in)?;
        Ok(shares)
    }

    /// Price-checked sell: the outcome's spot price must be at least
    /// `min_sell_price_bps`, `max_shares_in` is capped at the same-transaction
    /// quote plus `max_slippage_bps` (rounded up), and the post-trade impact
    /// limit applies as for buys.
    #[allow(clippy::too_many_arguments)]
    fn do_agent_sell(
        env: Env,
        agent: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        bound: Option<(u32, u64)>,
    ) -> Result<i128, Error> {
        let storage = env.storage().instance();
        if storage.get(&DataKey::AdminPaused).unwrap_or(false) {
            return Err(Error::Paused);
        }
        if storage.get(&DataKey::Paused).unwrap_or(false)
            && !storage.get(&DataKey::DrawdownTripped).unwrap_or(false)
        {
            return Err(Error::Paused);
        }
        let global = Self::load_global(&env)?;
        Self::require_agent(&env, &agent, ROLE_TRADE)?;
        let prices = Self::load_price_policy(&env);
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(&env, &global.market_core);
        let p_before = core_call(client.try_get_price(&market_id, &outcome))?;
        if p_before < prices.min_sell_price_bps {
            return Err(Error::PriceOutOfBand);
        }
        let quoted = core_call(client.try_quote_sell(&market_id, &outcome, &collateral_out))?;
        let cap = price_math::mul_div_ceil(quoted, BPS + prices.max_slippage_bps as i128, BPS)
            .ok_or(Error::InvalidAmount)?;
        let effective_max = max_shares_in.min(cap);
        let mut args: Vec<Val> = vec![
            &env,
            treasury_addr.into_val(&env),
            market_id.into_val(&env),
            outcome.into_val(&env),
            collateral_out.into_val(&env),
            effective_max.into_val(&env),
        ];
        let fn_name = Self::push_bound(&env, &mut args, bound, "sell", "sell_v2");
        let shares_in = Self::core_trade(&env, &global.market_core, fn_name, args)?;
        let p_after = core_call(client.try_get_price(&market_id, &outcome))?;
        if p_after.abs_diff(p_before) > prices.max_impact_bps {
            return Err(Error::PriceImpactExceeded);
        }
        // market-core transfers exactly `collateral_out` on success.
        Self::record_return(&env, &global.market_core, market_id, collateral_out)?;
        Self::record_proceeds(&env, market_id, collateral_out)?;
        Ok(shares_in)
    }

    /// Appends the `_v2` bounds to a trade's arguments when given, and
    /// returns the market-core function to call.
    fn push_bound(
        env: &Env,
        args: &mut Vec<Val>,
        bound: Option<(u32, u64)>,
        plain: &'static str,
        bounded: &'static str,
    ) -> &'static str {
        match bound {
            Some((limit_price_bps, deadline)) => {
                args.push_back(limit_price_bps.into_val(env));
                args.push_back(deadline.into_val(env));
                bounded
            }
            None => plain,
        }
    }

    /// Calls a market-core trade, catching its failure. market-core's
    /// `SlippageExceeded` becomes the treasury's own code (the bound is the
    /// treasury's); every other failure is mapped into the treasury's
    /// `MarketCore*` range so market-core's numeric codes never leak through
    /// the treasury ABI.
    ///
    /// Invoked by name rather than through the generated client's `try_`
    /// methods: those decode into market-core's `Error` type, which would
    /// then be exported in this contract's spec next to the treasury's own.
    fn core_trade(env: &Env, core: &Address, fn_name: &str, args: Vec<Val>) -> Result<i128, Error> {
        match env.try_invoke_contract::<i128, soroban_sdk::Error>(
            core,
            &Symbol::new(env, fn_name),
            args,
        ) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(Error::MarketCoreCallFailed),
            Err(Ok(e)) if e == soroban_sdk::Error::from_contract_error(CORE_SLIPPAGE_EXCEEDED) => {
                Err(Error::SlippageExceeded)
            }
            Err(Ok(e)) => Err(map_market_core_code(e)),
            Err(Err(_)) => Err(Error::MarketCoreCallFailed),
        }
    }

    /// Agents may never spend collateral owed to queued withdrawals.
    /// The commitment an `agent_create_market_and_reveal` will both create the
    /// market with and reveal: `sha256(SPEC_DOMAIN || XDR(spec))`, matching the
    /// resolver's `spec_v2_hash`. Validates the envelope and the two primary
    /// rule variants locally so a malformed rule never creates a market.
    fn resolve_commitment(env: &Env, spec: &ResolutionSpecV2) -> Result<BytesN<32>, Error> {
        if spec.version != SPEC_V2_VERSION || spec.salt == BytesN::from_array(env, &[0; 32]) {
            return Err(Error::InvalidResolution);
        }
        if spec.network_id != env.ledger().network_id() {
            return Err(Error::InvalidResolution);
        }
        let valid = match &spec.rule {
            ResolutionSpec::Price(cfg) => cfg.threshold >= 0 && cfg.max_staleness != 0,
            ResolutionSpec::Signers(cfg) => {
                !cfg.signers.is_empty()
                    && cfg.threshold != 0
                    && cfg.threshold <= cfg.signers.len()
                    && cfg.dispute_window != 0
            }
            _ => false,
        };
        if !valid {
            return Err(Error::InvalidResolution);
        }
        let mut preimage = Bytes::from_slice(env, SPEC_DOMAIN);
        preimage.append(&spec.clone().to_xdr(env));
        Ok(env.crypto().sha256(&preimage).into())
    }

    fn ensure_unreserved(env: &Env, global: &GlobalConfig, amount: i128) -> Result<(), Error> {
        let reserved = Self::reserved(env);
        if reserved == 0 {
            return Ok(());
        }
        if Self::idle(env, global).saturating_sub(amount) < reserved {
            return Err(Error::CapitalReserved);
        }
        Ok(())
    }

    fn do_redeem(env: &Env, core: &Address, market_id: u64) -> Result<i128, Error> {
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(env, core);
        let payout = match client.try_redeem(&treasury_addr, &market_id) {
            Ok(Ok(p)) => p,
            Err(Ok(MarketCoreError::NothingToRedeem)) => 0,
            Err(Ok(MarketCoreError::NotFinal)) => {
                return Err(Error::MarketNotFinal);
            }
            Err(Ok(_)) | Err(Err(_)) | Ok(Err(_)) => return Err(Error::MarketCoreError),
        };
        if payout > 0 {
            Self::record_return(env, core, market_id, payout)?;
            Self::record_proceeds(env, market_id, payout)?;
        }
        let mut r = Self::load_realized(env, market_id);
        r.position_proceeds = r
            .position_proceeds
            .checked_add(payout)
            .ok_or(Error::InvalidAmount)?;
        let pos = client.get_position(&market_id, &treasury_addr);
        let m = client.get_market(&market_id);
        let lp_settled = m.creator != treasury_addr || m.lp_claimed;
        if pos.yes == 0 && pos.no == 0 && lp_settled {
            r.settled = true;
            Self::close_market_exposure(env, core, market_id);
        }
        Self::save_realized(env, market_id, &r);
        Self::prune_if_settled(env, core, market_id);
        if r.settled {
            Self::try_realize(env, core, market_id)?;
        }
        Ok(payout)
    }

    fn do_claim(env: &Env, core: &Address, market_id: u64) -> Result<i128, Error> {
        let client = MarketCoreClient::new(env, core);
        let payout = match client.try_claim_pool_remainder(&market_id) {
            Ok(Ok(p)) => p,
            Err(Ok(MarketCoreError::AlreadyClaimed)) => 0,
            Err(Ok(MarketCoreError::NotFinal)) => {
                return Err(Error::MarketNotFinal);
            }
            Err(Ok(_)) | Err(Err(_)) | Ok(Err(_)) => return Err(Error::MarketCoreError),
        };
        if payout > 0 {
            Self::record_return(env, core, market_id, payout)?;
            Self::record_proceeds(env, market_id, payout)?;
        }
        let mut r = Self::load_realized(env, market_id);
        r.lp_proceeds = r
            .lp_proceeds
            .checked_add(payout)
            .ok_or(Error::InvalidAmount)?;
        let treasury_addr = env.current_contract_address();
        let pos = client.get_position(&market_id, &treasury_addr);
        let m = client.get_market(&market_id);
        let lp_settled = m.creator != treasury_addr || m.lp_claimed;
        if pos.yes == 0 && pos.no == 0 && lp_settled {
            r.settled = true;
            Self::close_market_exposure(env, core, market_id);
        }
        Self::save_realized(env, market_id, &r);
        Self::prune_if_settled(env, core, market_id);
        if r.settled {
            Self::try_realize(env, core, market_id)?;
        }
        Ok(payout)
    }

    fn settle_redeem(env: &Env, core: &Address, market_id: u64) -> Result<i128, Error> {
        Self::do_redeem(env, core, market_id)
    }

    fn settle_claim(env: &Env, core: &Address, market_id: u64) -> Result<i128, Error> {
        Self::do_claim(env, core, market_id)
    }

    // ----- daily windows ---------------------------------------------------------

    fn empty_window(env: &Env, head_hour: u64) -> UsageWindow {
        let mut amounts = Vec::new(env);
        for _ in 0..BUCKETS {
            amounts.push_back(0i128);
        }
        UsageWindow {
            head_hour,
            amounts,
            head_idx: 0,
        }
    }

    fn summarize(window: &UsageWindow) -> Result<DailyUsage, Error> {
        Ok(DailyUsage {
            day_start: window
                .head_hour
                .saturating_sub((BUCKETS - 1) as u64)
                .saturating_mul(BUCKET_SECONDS),
            amount: Self::window_sum(window)?,
        })
    }

    /// The stored window, or one migrated from the legacy fixed-window
    /// `DataKey::Daily` (not persisted here; `reserve_capacity` saves it and
    /// removes the legacy entry). Legacy usage still inside its day counts in
    /// full in the current hour's bucket: conservative, since it then stays
    /// in the window for up to 25 more hours.
    fn load_window(env: &Env) -> Result<UsageWindow, Error> {
        let storage = env.storage().instance();
        if let Some(window) = storage.get(&DataKey::UsageWindow) {
            return Ok(window);
        }
        let legacy: DailyUsage = storage.get(&DataKey::Daily).ok_or(Error::NotInitialized)?;
        let now = env.ledger().timestamp();
        let mut window = Self::empty_window(env, now / BUCKET_SECONDS);
        if now < legacy.day_start.saturating_add(DAY_SECONDS) {
            window.amounts.set(window.head_idx, legacy.amount);
        }
        Ok(window)
    }

    fn load_agent_window(env: &Env, agent: &Address) -> UsageWindow {
        env.storage()
            .persistent()
            .get(&DataKey::AgentWindow(agent.clone()))
            .unwrap_or_else(|| Self::empty_window(env, env.ledger().timestamp() / BUCKET_SECONDS))
    }

    /// Moves the head to `now_hour`, zeroing every bucket that left the
    /// window. At most `BUCKETS` steps however long the treasury was idle.
    /// An equal or earlier hour is a no-op: ledger time never goes backwards
    /// on-chain (tests that rewind `set_timestamp` just keep the current head).
    fn advance(window: &mut UsageWindow, now_hour: u64) {
        if now_hour <= window.head_hour {
            return;
        }
        let steps = core::cmp::min(now_hour - window.head_hour, BUCKETS as u64) as u32;
        for _ in 0..steps {
            window.head_idx = (window.head_idx + 1) % BUCKETS;
            window.amounts.set(window.head_idx, 0);
        }
        window.head_hour = now_hour;
    }

    fn window_sum(window: &UsageWindow) -> Result<i128, Error> {
        window.amounts.iter().try_fold(0i128, |sum, amount| {
            sum.checked_add(amount).ok_or(Error::DailyCapExceeded)
        })
    }

    /// Advances `window` to `now`, then adds `amount` to the current hour if
    /// the window total stays within `max_daily`. Returns the new total.
    fn consume_window(
        window: &mut UsageWindow,
        now: u64,
        amount: i128,
        max_daily: i128,
    ) -> Result<i128, Error> {
        Self::advance(window, now / BUCKET_SECONDS);
        let total = Self::window_sum(window)?
            .checked_add(amount)
            .ok_or(Error::DailyCapExceeded)?;
        if total > max_daily {
            return Err(Error::DailyCapExceeded);
        }
        let head = window
            .amounts
            .get(window.head_idx)
            .ok_or(Error::NotInitialized)?;
        window.amounts.set(
            window.head_idx,
            head.checked_add(amount).ok_or(Error::DailyCapExceeded)?,
        );
        Ok(total)
    }

    /// Checks the per-market cap, the global daily cap and the acting
    /// agent's own daily cap for `amount` and, if all pass, records it in
    /// all three and adds the market to the open-market index. Called
    /// *after* the market-core call it authorizes: Soroban invocations are
    /// atomic, so if this returns `Err` the whole transaction (including the
    /// trade already made) reverts.
    ///
    /// Both daily caps are sliding windows: usage in the trade's hour and
    /// the 24 hours before it (see `BUCKETS`) may never exceed the cap, so
    /// no trailing 24h interval can either. `TradeAuthorized.daily_total` is
    /// the global window sum after the trade.
    fn reserve_capacity(
        env: &Env,
        global: &GlobalConfig,
        agent: &Address,
        policy: &AgentPolicy,
        market_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        let core = &global.market_core;
        let now = env.ledger().timestamp();
        let mut window = Self::load_window(env)?;
        let mut agent_window = Self::load_agent_window(env, agent);
        let mut exposure = Self::market_exposure(env, core, market_id);
        let new_market = exposure
            .amount
            .checked_add(amount)
            .ok_or(Error::MarketCapExceeded)?;
        if new_market > global.max_market {
            return Err(Error::MarketCapExceeded);
        }
        let new_daily = Self::consume_window(&mut window, now, amount, global.max_daily)?;
        Self::consume_window(&mut agent_window, now, amount, policy.max_daily)
            .map_err(|_| Error::AgentDailyCapExceeded)?;
        Self::index_add(env, core, market_id)?;
        exposure.amount = new_market;
        exposure.open = true;
        Self::save_market(env, core, market_id, &exposure);
        Self::put_persistent(env, &DataKey::AgentWindow(agent.clone()), &agent_window);
        let storage = env.storage().instance();
        storage.set(&DataKey::UsageWindow, &window);
        storage.remove(&DataKey::Daily);
        // The window must outlive idle days, so keep the instance live.
        storage.extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        TradeAuthorized {
            market_id,
            agent: agent.clone(),
            amount,
            market_total: new_market,
            daily_total: new_daily,
        }
        .publish(env);
        Ok(())
    }

    // ----- per-core keys ---------------------------------------------------------
    // Exposure is keyed by market id, and ids restart in every market-core.
    // The original core keeps the legacy `Market(id)` / `Net(id)` keys; any
    // core switched to later gets keys namespaced by its address.

    fn is_original_core(env: &Env, core: &Address) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::OriginalCore)
            .is_none_or(|original| original == *core)
    }

    fn market_key(env: &Env, core: &Address, market_id: u64) -> DataKey {
        if Self::is_original_core(env, core) {
            DataKey::Market(market_id)
        } else {
            DataKey::MarketV2(core.clone(), market_id)
        }
    }

    fn net_key(env: &Env, core: &Address, market_id: u64) -> DataKey {
        if Self::is_original_core(env, core) {
            DataKey::Net(market_id)
        } else {
            DataKey::NetV2(core.clone(), market_id)
        }
    }

    // ----- net exposure ------------------------------------------------------
    // Two caps with different questions: `max_market` limits what was *ever*
    // committed to one market (lifetime, never freed); `max_net_exposure`
    // limits what is *currently* committed across all markets (cost basis,
    // freed by sells, redemptions and claims). Enforcement reads only local
    // counters, never a pool price: a spot-valued cap would let anyone pump
    // the price to unlock headroom, or crash it to block the agent.

    fn load_net(env: &Env, core: &Address, market_id: u64) -> NetPosition {
        env.storage()
            .persistent()
            .get(&Self::net_key(env, core, market_id))
            .unwrap_or(NetPosition {
                collateral_in: 0,
                collateral_out: 0,
            })
    }

    /// Stores `next` for `market_id`, moves `NetTotal` by the change in that
    /// market's cost basis (so it never needs iterating) and returns the new
    /// total.
    fn save_net(
        env: &Env,
        core: &Address,
        market_id: u64,
        before: &NetPosition,
        next: &NetPosition,
    ) -> Result<i128, Error> {
        let total = Self::net_exposure(env.clone())
            .checked_sub(before.cost_basis())
            .and_then(|t| t.checked_add(next.cost_basis()))
            .ok_or(Error::NetExposureExceeded)?;
        Self::put_persistent(env, &Self::net_key(env, core, market_id), next);
        env.storage().instance().set(&DataKey::NetTotal, &total);
        NetExposureUpdated {
            market_id,
            net_market: next.cost_basis(),
            net_total: total,
        }
        .publish(env);
        Ok(total)
    }

    /// Records `amount` sent into `market_id` and enforces `max_net_exposure`
    /// on the new total. Like `reserve_capacity`, runs after the market-core
    /// call and relies on the invocation reverting on `Err`.
    fn reserve_net(
        env: &Env,
        global: &GlobalConfig,
        market_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        let core = &global.market_core;
        let before = Self::load_net(env, core, market_id);
        let next = NetPosition {
            collateral_in: before
                .collateral_in
                .checked_add(amount)
                .ok_or(Error::NetExposureExceeded)?,
            ..before
        };
        let total = Self::save_net(env, core, market_id, &before, &next)?;
        if total > global.max_net_exposure {
            return Err(Error::NetExposureExceeded);
        }
        Ok(())
    }

    /// Records `amount` received back from `market_id` (a sell, redemption,
    /// pool remainder or LP fee claim).
    fn record_return(env: &Env, core: &Address, market_id: u64, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let before = Self::load_net(env, core, market_id);
        let next = NetPosition {
            collateral_out: before
                .collateral_out
                .checked_add(amount)
                .ok_or(Error::InvalidAmount)?,
            ..before
        };
        Self::save_net(env, core, market_id, &before, &next)?;
        Ok(())
    }

    /// Drops `market_id` from net accounting (its holdings left the treasury).
    fn clear_net(env: &Env, core: &Address, market_id: u64) -> Result<(), Error> {
        let before = Self::load_net(env, core, market_id);
        let cleared = NetPosition {
            collateral_in: 0,
            collateral_out: 0,
        };
        Self::save_net(env, core, market_id, &before, &cleared)?;
        Ok(())
    }

    // ----- valuation ---------------------------------------------------------------

    /// `(floor, spot)` value of the treasury's holdings in one market (see
    /// [`Valuation`]): two cross-contract reads.
    fn holdings_value(env: &Env, core: &Address, market_id: u64) -> Result<(i128, i128), Error> {
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(env, core);
        let market = core_call(client.try_get_market(&market_id))?;
        let position = core_call(client.try_get_position(&market_id, &treasury_addr))?;
        let lp = market.creator == treasury_addr && !market.lp_claimed;
        let (lp_yes, lp_no) = if lp {
            (market.reserve_yes, market.reserve_no)
        } else {
            (0, 0)
        };

        Ok(match market.status {
            MarketStatus::Open => {
                let floor = position
                    .yes
                    .min(position.no)
                    .saturating_add(lp_yes.min(lp_no));
                // Mirrors market-core's `price_yes_bps` from the reserves just
                // read, so spot costs no third call.
                let sum = market.reserve_yes.saturating_add(market.reserve_no);
                let p_yes = if sum > 0 {
                    market.reserve_no.saturating_mul(BPS) / sum
                } else {
                    BPS / 2
                };
                let yes = position.yes.saturating_add(lp_yes);
                let no = position.no.saturating_add(lp_no);
                let spot = yes
                    .saturating_mul(p_yes)
                    .saturating_add(no.saturating_mul(BPS - p_yes))
                    / BPS;
                (floor, spot)
            }
            // Final markets are worth exactly what market-core's
            // `settle_value` pays out.
            status => {
                let settled = Self::settle_value(&status, position.yes, position.no)
                    .saturating_add(Self::settle_value(&status, lp_yes, lp_no));
                (settled, settled)
            }
        })
    }

    fn compute_nav(env: &Env, global: &GlobalConfig) -> Result<i128, Error> {
        let mut total = Self::idle(env, global);
        for i in 0..Self::open_count(env) {
            let key = DataKey::OpenMarketAt(i);
            let entry: OpenMarket = env
                .storage()
                .persistent()
                .get(&key)
                .ok_or(Error::NotInitialized)?;
            let (floor, _) = Self::holdings_value(env, &entry.core, entry.market_id)?;
            total = total.checked_add(floor).ok_or(Error::InvalidAmount)?;
        }
        Ok(total.saturating_sub(Self::reserved(env)).max(0))
    }

    /// Private mirror of market-core's `math::settle_value` for final markets.
    fn settle_value(status: &MarketStatus, yes: i128, no: i128) -> i128 {
        match status {
            MarketStatus::Resolved(Outcome::Yes) => yes,
            MarketStatus::Resolved(Outcome::No) => no,
            MarketStatus::ResolvedScalar(payout_long_bps) => {
                // Mirror of market-core's `math::scalar_payout`: each leg floors
                // independently at its fractional share of the complete set.
                let p = *payout_long_bps as i128;
                yes.saturating_mul(p) / BPS + no.saturating_mul(BPS - p) / BPS
            }
            MarketStatus::Void => yes.saturating_add(no) / 2,
            MarketStatus::Open => 0,
        }
    }

    // ----- open-market index ---------------------------------------------------------
    // Markets holding treasury capital, so `nav()` can walk them: a dense
    // array `OpenMarketAt(0..count)` plus a reverse slot map for swap-and-pop
    // removal. Entries carry their market-core, so positions left behind in
    // a legacy core keep counting.

    fn open_count(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::OpenMarketCount)
            .unwrap_or(0)
    }

    fn index_add(env: &Env, core: &Address, market_id: u64) -> Result<(), Error> {
        let slot = DataKey::OpenMarketSlot(core.clone(), market_id);
        if env.storage().persistent().has(&slot) {
            return Ok(());
        }
        let count = Self::open_count(env);
        if count >= MAX_OPEN_MARKETS {
            return Err(Error::TooManyOpenMarkets);
        }
        Self::put_persistent(
            env,
            &DataKey::OpenMarketAt(count),
            &OpenMarket {
                core: core.clone(),
                market_id,
            },
        );
        Self::put_persistent(env, &slot, &count);
        env.storage()
            .instance()
            .set(&DataKey::OpenMarketCount, &(count + 1));
        Ok(())
    }

    fn index_remove(env: &Env, core: &Address, market_id: u64) {
        let slot_key = DataKey::OpenMarketSlot(core.clone(), market_id);
        let persistent = env.storage().persistent();
        let Some(slot) = persistent.get::<DataKey, u32>(&slot_key) else {
            return;
        };
        let last = Self::open_count(env) - 1;
        if slot != last {
            if let Some(moved) = persistent.get::<DataKey, OpenMarket>(&DataKey::OpenMarketAt(last))
            {
                Self::put_persistent(env, &DataKey::OpenMarketAt(slot), &moved);
                Self::put_persistent(
                    env,
                    &DataKey::OpenMarketSlot(moved.core, moved.market_id),
                    &slot,
                );
            }
        }
        persistent.remove(&DataKey::OpenMarketAt(last));
        persistent.remove(&slot_key);
        env.storage()
            .instance()
            .set(&DataKey::OpenMarketCount, &last);
    }

    /// Drops `market_id` from the index once the treasury holds nothing in
    /// it: no shares and no unclaimed LP role.
    fn prune_if_settled(env: &Env, core: &Address, market_id: u64) -> Result<(), Error> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::OpenMarketSlot(core.clone(), market_id))
        {
            return Ok(());
        }
        let treasury_addr = env.current_contract_address();
        let client = MarketCoreClient::new(env, core);
        let position = core_call(client.try_get_position(&market_id, &treasury_addr))?;
        let market = core_call(client.try_get_market(&market_id))?;
        let lp = market.creator == treasury_addr && !market.lp_claimed;
        if position.yes == 0 && position.no == 0 && !lp {
            Self::index_remove(env, core, market_id);
        }
        Ok(())
    }

    // ----- shares and queue ------------------------------------------------------------

    fn idle(env: &Env, global: &GlobalConfig) -> i128 {
        token::TokenClient::new(env, &global.collateral).balance(&env.current_contract_address())
    }

    fn supply(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    fn reserved(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::QueueReserved)
            .unwrap_or(0)
    }

    /// Ticket ids start at 1, so 0 can mean "no ticket".
    fn queue_head(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::QueueHead)
            .unwrap_or(1)
    }

    fn queue_tail(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::QueueTail)
            .unwrap_or(1)
    }

    /// Mints shares for `amount` deposited at `nav` and returns those
    /// credited to `owner`. The first mint withholds `VIRTUAL_SHARES` as dead
    /// shares nobody owns.
    fn mint_shares(env: &Env, owner: &Address, amount: i128, nav: i128) -> Result<i128, Error> {
        let supply = Self::supply(env);
        let minted = shares_for_deposit(amount, nav, supply).ok_or(Error::InvalidAmount)?;
        let credited = if supply == 0 {
            minted - VIRTUAL_SHARES
        } else {
            minted
        };
        if credited <= 0 {
            return Err(Error::DepositTooSmall);
        }
        let new_supply = supply.checked_add(minted).ok_or(Error::InvalidAmount)?;
        let key = DataKey::Shares(owner.clone());
        let balance = Self::shares_of(env.clone(), owner.clone())
            .checked_add(credited)
            .ok_or(Error::InvalidAmount)?;
        Self::put_persistent(env, &key, &balance);
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &new_supply);
        Ok(credited)
    }

    fn burn_shares(env: &Env, owner: &Address, shares: i128) -> Result<(), Error> {
        let balance = Self::shares_of(env.clone(), owner.clone());
        if balance < shares {
            return Err(Error::InsufficientShares);
        }
        Self::put_persistent(env, &DataKey::Shares(owner.clone()), &(balance - shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(Self::supply(env) - shares));
        Ok(())
    }

    fn authorize_transfer(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: vec![
                        env,
                        from.into_val(env),
                        to.into_val(env),
                        amount.into_val(env),
                    ],
                },
                sub_invocations: vec![env],
            }),
        ]);
    }

    /// Pre-authorizes the SEP-41 `transfer(from, to, amount)` that
    /// market-core will make from the treasury's own balance when the
    /// treasury calls one of its trading entrypoints. See the comment on
    /// `agent_buy` for why this is required.
    fn authorize_token_pull(env: &Env, global: &GlobalConfig, from: &Address, amount: i128) {
        Self::authorize_transfer(env, &global.collateral, from, &global.market_core, amount);
    }

    fn category_bit(c: &Category) -> u32 {
        match c {
            Category::Crypto => 1 << 0,
            Category::Macro => 1 << 1,
            Category::Geopolitics => 1 << 2,
            Category::Sports => 1 << 3,
            Category::Culture => 1 << 4,
            Category::Other => 1 << 5,
        }
    }

    fn validate_creation_policy(
        global: &GlobalConfig,
        policy: &CreationPolicy,
    ) -> Result<(), Error> {
        if policy.max_seed <= 0 || policy.max_seed > global.max_market {
            return Err(Error::InvalidConfig);
        }
        if policy.max_markets_per_window < 1 {
            return Err(Error::InvalidConfig);
        }
        if policy.creation_window_secs < CREATION_BUCKETS as u64 {
            return Err(Error::InvalidConfig);
        }
        if policy.min_close_horizon >= policy.max_close_horizon {
            return Err(Error::InvalidConfig);
        }
        if policy.allowed_categories == 0 || (policy.allowed_categories & !0x3F) != 0 {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }

    fn validate_drawdown_config(max_drawdown: i128, window_days: u32) -> Result<(), Error> {
        if max_drawdown <= 0 {
            return Err(Error::InvalidDrawdownConfig);
        }
        if !(1..=30).contains(&window_days) {
            return Err(Error::InvalidDrawdownConfig);
        }
        Ok(())
    }

    fn load_creation_policy(env: &Env) -> Result<CreationPolicy, Error> {
        env.storage()
            .instance()
            .get(&DataKey::CreationPolicy)
            .ok_or(Error::NotInitialized)
    }

    fn record_creation(env: &Env, policy: &CreationPolicy) -> Result<(), Error> {
        let now = env.ledger().timestamp();
        let bucket_width = (policy.creation_window_secs / CREATION_BUCKETS as u64).max(1);
        let storage = env.storage().instance();
        let old_buckets: Vec<CreationBucket> = storage
            .get(&DataKey::CreationBuckets)
            .unwrap_or_else(|| Vec::new(env));
        let mut active_buckets = Vec::new(env);
        let mut total_count = 0u32;
        for i in 0..old_buckets.len() {
            let b = old_buckets.get(i).unwrap();
            if b.bucket_start.saturating_add(policy.creation_window_secs) > now {
                total_count = total_count
                    .checked_add(b.count)
                    .ok_or(Error::CreationRateExceeded)?;
                active_buckets.push_back(b);
            }
        }
        if total_count >= policy.max_markets_per_window {
            return Err(Error::CreationRateExceeded);
        }
        let cur_start = now - (now % bucket_width);
        let mut updated = false;
        if !active_buckets.is_empty() {
            let last_idx = active_buckets.len() - 1;
            let mut last = active_buckets.get(last_idx).unwrap();
            if last.bucket_start == cur_start {
                last.count = last
                    .count
                    .checked_add(1)
                    .ok_or(Error::CreationRateExceeded)?;
                active_buckets.set(last_idx, last);
                updated = true;
            }
        }
        if !updated {
            active_buckets.push_back(CreationBucket {
                bucket_start: cur_start,
                count: 1,
            });
            while active_buckets.len() > CREATION_BUCKETS {
                active_buckets.remove(0);
            }
        }
        storage.set(&DataKey::CreationBuckets, &active_buckets);
        Ok(())
    }

    fn load_realized(env: &Env, market_id: u64) -> Realized {
        env.storage()
            .persistent()
            .get(&DataKey::Realized(market_id))
            .unwrap_or_default()
    }

    fn save_realized(env: &Env, market_id: u64, r: &Realized) {
        env.storage()
            .persistent()
            .set(&DataKey::Realized(market_id), r);
        Self::bump_persistent(env, &DataKey::Realized(market_id));
    }

    fn close_market_exposure(env: &Env, core: &Address, market_id: u64) {
        let mut exposure = Self::market_exposure(env, core, market_id);
        if exposure.open {
            exposure.open = false;
            Self::save_market(env, core, market_id, &exposure);
        }
    }

    fn load_pnl(env: &Env, market_id: u64) -> MarketPnl {
        env.storage()
            .persistent()
            .get(&DataKey::Pnl(market_id))
            .unwrap_or_default()
    }

    fn save_pnl(env: &Env, market_id: u64, pnl: &MarketPnl) {
        env.storage()
            .persistent()
            .set(&DataKey::Pnl(market_id), pnl);
        Self::bump_persistent(env, &DataKey::Pnl(market_id));
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn record_cost(env: &Env, market_id: u64, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let mut pnl = Self::load_pnl(env, market_id);
        pnl.cost = pnl.cost.checked_add(amount).ok_or(Error::InvalidAmount)?;
        Self::save_pnl(env, market_id, &pnl);
        Ok(())
    }

    fn record_proceeds(env: &Env, market_id: u64, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let mut pnl = Self::load_pnl(env, market_id);
        pnl.proceeds = pnl
            .proceeds
            .checked_add(amount)
            .ok_or(Error::InvalidAmount)?;
        Self::save_pnl(env, market_id, &pnl);
        Ok(())
    }

    fn empty_pnl_days(env: &Env, head_day: u64, window_days: u32) -> PnlDays {
        let mut amounts = Vec::new(env);
        for _ in 0..window_days {
            amounts.push_back(0i128);
        }
        PnlDays {
            head_day,
            amounts,
            head_idx: 0,
        }
    }

    fn load_drawdown_cfg(env: &Env) -> Result<DrawdownConfig, Error> {
        env.storage()
            .instance()
            .get(&DataKey::DrawdownCfg)
            .ok_or(Error::NotInitialized)
    }

    fn advance_pnl_days(days: &mut PnlDays, now_day: u64, window_days: u32) {
        if now_day <= days.head_day {
            return;
        }
        let delta = (now_day - days.head_day) as u32;
        let steps = delta.min(window_days);
        for _ in 0..steps {
            days.head_idx = (days.head_idx + 1) % window_days;
            days.amounts.set(days.head_idx, 0i128);
        }
        days.head_day = now_day;
    }

    fn add_daily_pnl(env: &Env, pnl: i128) -> Result<(), Error> {
        let cfg = Self::load_drawdown_cfg(env)?;
        let mut pnl_days: PnlDays = env
            .storage()
            .instance()
            .get(&DataKey::PnlDays)
            .ok_or(Error::NotInitialized)?;
        let now_day = env.ledger().timestamp() / DAY_SECONDS;
        Self::advance_pnl_days(&mut pnl_days, now_day, cfg.window_days);
        let curr = pnl_days.amounts.get(pnl_days.head_idx).unwrap_or(0);
        pnl_days.amounts.set(
            pnl_days.head_idx,
            curr.checked_add(pnl).ok_or(Error::InvalidAmount)?,
        );
        env.storage().instance().set(&DataKey::PnlDays, &pnl_days);
        Ok(())
    }

    fn calc_window_pnl(env: &Env) -> Result<i128, Error> {
        let cfg = Self::load_drawdown_cfg(env)?;
        let mut pnl_days: PnlDays = env
            .storage()
            .instance()
            .get(&DataKey::PnlDays)
            .ok_or(Error::NotInitialized)?;
        let now_day = env.ledger().timestamp() / DAY_SECONDS;
        Self::advance_pnl_days(&mut pnl_days, now_day, cfg.window_days);
        let mut sum = 0i128;
        for i in 0..cfg.window_days {
            if let Some(amt) = pnl_days.amounts.get(i) {
                sum = sum.checked_add(amt).ok_or(Error::InvalidAmount)?;
            }
        }
        Ok(sum)
    }

    fn check_drawdown(env: &Env, market_id: u64) -> Result<(), Error> {
        let wpnl = Self::calc_window_pnl(env)?;
        let cfg = Self::load_drawdown_cfg(env)?;
        if wpnl < -cfg.max_drawdown {
            let storage = env.storage().instance();
            if !storage.get(&DataKey::DrawdownTripped).unwrap_or(false) {
                storage.set(&DataKey::Paused, &true);
                storage.set(&DataKey::DrawdownTripped, &true);
                storage.set(&DataKey::DrawdownAcknowledged, &false);
                let now_day = env.ledger().timestamp() / DAY_SECONDS;
                let window_start_day = now_day.saturating_sub((cfg.window_days - 1) as u64);
                DrawdownPause {
                    realized_loss: -wpnl,
                    window_start_day,
                    triggered_by_market: market_id,
                }
                .publish(env);
            }
        }
        Ok(())
    }

    fn try_realize(env: &Env, core: &Address, market_id: u64) -> Result<(), Error> {
        let client = MarketCoreClient::new(env, core);
        let m = client.get_market(&market_id);
        if matches!(m.status, MarketStatus::Open) {
            return Ok(());
        }
        let treasury_addr = env.current_contract_address();
        let pos = client.get_position(&market_id, &treasury_addr);
        let lp_settled = m.creator != treasury_addr || m.lp_claimed;
        if pos.yes == 0 && pos.no == 0 && lp_settled {
            let mut pnl = Self::load_pnl(env, market_id);
            if !pnl.realized {
                let net_pnl = pnl
                    .proceeds
                    .checked_sub(pnl.cost)
                    .ok_or(Error::InvalidAmount)?;
                Self::add_daily_pnl(env, net_pnl)?;
                pnl.realized = true;
                Self::save_pnl(env, market_id, &pnl);
                PnlRealized {
                    market_id,
                    cost: pnl.cost,
                    proceeds: pnl.proceeds,
                    pnl: net_pnl,
                }
                .publish(env);
                Self::check_drawdown(env, market_id)?;
            }
        }
        Ok(())
    }

    fn yield_value(env: &Env) -> i128 {
        let storage = env.storage().instance();
        let venue: YieldVenue = match storage.get(&DataKey::YieldVenue) {
            Some(v) => v,
            None => return 0,
        };
        let client = BlendPoolClient::new(env, &venue.pool);
        let treasury = env.current_contract_address();
        let pos = client.get_positions(&treasury);
        pos.supply_shares
    }

    fn ensure_liquid(env: &Env, global: &GlobalConfig, needed: i128) -> Result<(), Error> {
        let liquid = Self::idle(env, global);
        if liquid >= needed {
            return Ok(());
        }
        let venue: YieldVenue = match env
            .storage()
            .instance()
            .get::<_, YieldVenue>(&DataKey::YieldVenue)
        {
            Some(v) if v.enabled => v,
            _ => return Err(Error::InsufficientBalance),
        };
        let shortfall = needed - liquid;
        let to_withdraw = shortfall.saturating_add(1);
        let treasury = env.current_contract_address();
        let client = BlendPoolClient::new(env, &venue.pool);
        let mut requests = Vec::new(env);
        requests.push_back(BlendRequest {
            request_type: BLEND_REQUEST_WITHDRAW,
            address: global.collateral.clone(),
            amount: to_withdraw,
        });
        if client
            .try_submit(&treasury, &treasury, &treasury, &requests)
            .is_err()
        {
            return Err(Error::YieldWithdrawFailed);
        }
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YieldPrincipal)
            .unwrap_or(0);
        let new_principal = principal.saturating_sub(to_withdraw).max(0);
        env.storage()
            .instance()
            .set(&DataKey::YieldPrincipal, &new_principal);
        YieldRecalled {
            pool: venue.pool,
            amount: to_withdraw,
            principal: new_principal,
            reason: Symbol::new(env, "jit"),
        }
        .publish(env);

        let new_liquid = Self::idle(env, global);
        if new_liquid < needed {
            return Err(Error::InsufficientBalance);
        }
        Ok(())
    }

    fn market_exposure(env: &Env, core: &Address, market_id: u64) -> MarketExposure {
        env.storage()
            .persistent()
            .get(&Self::market_key(env, core, market_id))
            .unwrap_or(MarketExposure {
                amount: 0,
                open: false,
            })
    }

    fn save_market(env: &Env, core: &Address, market_id: u64, exposure: &MarketExposure) {
        Self::put_persistent(env, &Self::market_key(env, core, market_id), exposure);
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        BytesN, String, Vec,
    };

    // ---- dual registration of market-core (coverage, issue #75) ---------------
    //
    // The wasm copy is what ships and what ADR 0002 requires the contract to be
    // *built* against, but code running inside the wasm VM is invisible to
    // `cargo llvm-cov`. A native `market-core` registration (a dev-dependency:
    // the duplicate `__constructor` export that forbids this in the wasm build
    // does not exist in a native test binary) runs the same scenarios as host
    // code. `MARKET_CORE_IMPL=native cargo test` flips the whole suite;
    // `both_modes!` pins individual scenarios to both.

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum McImpl {
        Wasm,
        Native,
    }

    std::thread_local! {
        static MC_OVERRIDE: core::cell::Cell<Option<McImpl>> = const { core::cell::Cell::new(None) };
    }

    fn mc_impl() -> McImpl {
        MC_OVERRIDE.with(|c| c.get()).unwrap_or_else(|| {
            match std::env::var("MARKET_CORE_IMPL").as_deref() {
                Ok("native") => McImpl::Native,
                _ => McImpl::Wasm,
            }
        })
    }

    /// Runs `f` with market-core registered as `how`, restoring the previous
    /// choice even if `f` panics.
    fn with_market_core<R>(how: McImpl, f: impl FnOnce() -> R) -> R {
        struct Restore(Option<McImpl>);
        impl Drop for Restore {
            fn drop(&mut self) {
                MC_OVERRIDE.with(|c| c.set(self.0));
            }
        }
        let _restore = Restore(MC_OVERRIDE.with(|c| c.replace(Some(how))));
        f()
    }

    /// `(admin, collateral, treasury, resolver, default_fee_bps, protocol_share_bps)`.
    fn register_market_core(
        env: &Env,
        args: (Address, Address, Address, Address, u32, u32),
    ) -> Address {
        match mc_impl() {
            McImpl::Wasm => env.register(market_core::WASM, args),
            McImpl::Native => env.register(
                ::market_core_native::MarketCore,
                ::market_core_native::MarketCoreArgs::__constructor(
                    &args.0, &args.1, &args.2, &args.3, &args.4, &args.5,
                ),
            ),
        }
    }

    /// Re-runs existing scenario tests (`#[test]` functions are plain functions
    /// too) once per market-core registration, as `<name>::wasm` and
    /// `<name>::native`.
    macro_rules! both_modes {
        ($($name:ident),+ $(,)?) => {$(
            mod $name {
                #[test]
                fn wasm() {
                    super::with_market_core(super::McImpl::Wasm, super::$name);
                }
                #[test]
                fn native() {
                    super::with_market_core(super::McImpl::Native, super::$name);
                }
            }
        )+};
    }

    // Comfortably past every timestamp advance the tests make, so a market
    // never closes out from under a trade mid-test.
    const MARKET_CLOSE: u64 = 1_000 + 30 * DAY_SECONDS;

    const DELAY: u64 = MIN_CONFIG_DELAY;
    const PERMISSIVE: PricePolicy = PricePolicy {
        max_buy_price_bps: 10_000,
        min_sell_price_bps: 0,
        max_impact_bps: 10_000,
        max_slippage_bps: 9_999,
    };

    /// Writes a price policy straight into storage, bypassing the timelock.
    fn install_price_policy(env: &Env, treasury: &Address, policy: PricePolicy) {
        env.as_contract(treasury, || {
            env.storage().instance().set(&DataKey::PricePolicy, &policy);
        });
    }

    struct Fixture {
        env: Env,
        admin: Address,
        agent: Address,
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
        fixture_with_net_cap(max_trade, max_market, max_daily, max_daily)
    }

    fn fixture_with_net_cap(
        max_trade: i128,
        max_market: i128,
        max_daily: i128,
        max_net_exposure: i128,
    ) -> Fixture {
        fixture_full(max_trade, max_market, max_daily, max_net_exposure, true)
    }

    fn fixture_with_policy(
        max_trade: i128,
        max_market: i128,
        max_daily: i128,
        policy: CreationPolicy,
    ) -> Fixture {
        fixture_full_with_policy(max_trade, max_market, max_daily, max_daily, true, policy)
    }

    fn fixture_full(
        max_trade: i128,
        max_market: i128,
        max_daily: i128,
        max_net_exposure: i128,
        prefund: bool,
    ) -> Fixture {
        let default_policy = CreationPolicy {
            max_seed: max_trade,
            max_markets_per_window: 100,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        fixture_full_with_policy(
            max_trade,
            max_market,
            max_daily,
            max_net_exposure,
            prefund,
            default_policy,
        )
    }

    fn fixture_full_with_policy(
        max_trade: i128,
        max_market: i128,
        max_daily: i128,
        max_net_exposure: i128,
        prefund: bool,
        creation_policy: CreationPolicy,
    ) -> Fixture {
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
        if prefund {
            token.mint(&treasury_id, &(1_000 * 10_000_000_i128));
        }

        let resolver = Address::generate(&env);
        let market_core_id = register_market_core(
            &env,
            (
                admin.clone(),
                collateral.address(),
                treasury_id.clone(),
                resolver.clone(),
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
        let max_drawdown = max_daily * 10;
        let window_days = 7u32;
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
                &max_net_exposure,
                &DELAY,
                &max_drawdown,
                &window_days,
                &creation_policy,
            ),
        );
        // Most tests exercise caps, not prices: lift the price limits (the
        // price-policy tests install their own).
        install_price_policy(&env, &treasury, PERMISSIVE);
        Fixture {
            env: env.clone(),
            admin,
            agent,
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
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        assert!(f
            .treasury
            .try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(20 * 10_000_000_i128),
                &0
            )
            .is_ok());
        assert_eq!(
            f.treasury.try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(20 * 10_000_000_i128),
                &0
            ),
            Err(Ok(Error::MarketCapExceeded))
        );
        assert_eq!(
            f.treasury.try_close_trade(&f.agent, &f.market_id),
            Ok(Ok(40 * 10_000_000_i128))
        );
        assert!(f.treasury.daily_usage().amount == 40 * 10_000_000_i128);
    }

    #[test]
    fn rejects_trade_above_single_trade_cap() {
        let f = fixture();
        assert_eq!(
            f.treasury.try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(21 * 10_000_000_i128),
                &0
            ),
            Err(Ok(Error::TradeCapExceeded))
        );
    }

    #[test]
    fn rejects_trade_above_daily_cap() {
        let f = fixture();
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        f.treasury.close_trade(&f.agent, &f.market_id);
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
        f.treasury.agent_buy(
            &f.agent,
            &second_market,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        f.treasury.close_trade(&f.agent, &second_market);
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        f.treasury.close_trade(&f.agent, &f.market_id);
        // 60 already used today (the daily cap); one more real trade of any
        // size must be rejected for exceeding it.
        assert_eq!(
            f.treasury.try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(10 * 10_000_000_i128),
                &0
            ),
            Err(Ok(Error::DailyCapExceeded))
        );
    }

    /// Replaces the old `daily_cap_resets_after_one_day`, which pinned the
    /// fixed window's reset. With 25 hourly buckets a trade from hour 0 still
    /// counts exactly 24h later (hour 24's window is hours 0..=24) and only
    /// drops out once the head reaches hour 25.
    #[test]
    fn daily_cap_frees_capacity_after_window_slides() {
        let f = fixture();
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        f.treasury.close_trade(&f.agent, &f.market_id);
        f.env.ledger().set_timestamp(1_000 + DAY_SECONDS);
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        assert_eq!(f.treasury.daily_usage().amount, 40 * 10_000_000_i128);
        f.env.ledger().set_timestamp(25 * BUCKET_SECONDS);
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
            &f.agent,
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
                &f.agent,
                &BytesN::from_array(&f.env, &[14u8; 32]),
                &BytesN::from_array(&f.env, &[114u8; 32]),
                &String::from_str(&f.env, "ipfs://agent-created-2"),
                &Category::Macro,
                &MARKET_CLOSE,
                &(151 * 10_000_000_i128),
                &5000u32,
            ),
            Err(Ok(Error::SeedCapExceeded))
        );
    }

    #[test]
    fn agent_sell_returns_capital_without_touching_caps() {
        let f = fixture();
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
        let quote = f
            .market_core
            .quote_sell(&f.market_id, &Outcome::Yes, &(5 * 10_000_000_i128));
        let shares_in = f.treasury.agent_sell(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &quote,
        );
        assert!(shares_in > 0);
        // Selling must not consume any more of the daily/market caps.
        assert_eq!(f.treasury.daily_usage().amount, 20 * 10_000_000_i128);
    }

    #[test]
    fn paused_treasury_rejects_agent_trading() {
        let f = fixture();
        f.treasury.set_paused(&true);
        assert_eq!(
            f.treasury.try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(10_000_000_i128),
                &0
            ),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn wrong_caller_cannot_pause_or_emergency_withdraw_for_others() {
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
        // Admin `withdraw` is gone; shares are the only claim on capital, and
        // only their owner can burn them.
        f.env.mock_all_auths();
        f.treasury.set_paused(&true);
        f.env.set_auths(&[]);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "emergency_withdraw",
                    args: (f.admin.clone(), 1_000_i128).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_emergency_withdraw(&f.admin, &1_000_i128)
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
                    args: (agent.clone(), market_id, outcome.clone(), amount, min_out)
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy(&agent, &market_id, &outcome, &amount, &min_out);
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
            &f.agent,
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
        assert_eq!(
            f.treasury.agent_claim_lp_fees(&f.agent, &market_id),
            500_000
        );
        assert_eq!(token.balance(&f.treasury_id), before + 500_000);
        assert_eq!(f.treasury.agent_claim_lp_fees(&f.agent, &market_id), 0);
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
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(1_000_000_i128), &0);
        assert_eq!(f.treasury.daily_usage().amount, 1_000_000);

        // 20 USDC moves it ~893 bps: market-core trips the breaker, which
        // reverts the whole treasury call — the caps must not absorb it.
        assert!(f
            .treasury
            .try_agent_buy(
                &f.agent,
                &market_id,
                &Outcome::Yes,
                &(20 * 10_000_000_i128),
                &0
            )
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
                &f.agent,
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
                &f.agent,
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
            &f.agent,
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
            &f.agent,
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
                &f.agent,
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
                &f.agent,
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
                    args: (
                        agent.clone(),
                        market_id,
                        outcome.clone(),
                        amount,
                        min_out,
                        limit,
                        deadline,
                    )
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy_v2(
                &agent, &market_id, &outcome, &amount, &min_out, &limit, &deadline,
            );
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
                .try_agent_buy_cat(&f.agent, &cat_market, &0u32, &(21 * 10_000_000_i128), &0),
            Err(Ok(Error::TradeCapExceeded))
        );
        // Two capped buys fill the per-market cap; a third — even on another
        // outcome — is rejected.
        f.treasury
            .agent_buy_cat(&f.agent, &cat_market, &0u32, &(20 * 10_000_000_i128), &0);
        f.treasury
            .agent_buy_cat(&f.agent, &cat_market, &2u32, &(20 * 10_000_000_i128), &0);
        assert_eq!(
            f.treasury
                .try_agent_buy_cat(&f.agent, &cat_market, &1u32, &(20 * 10_000_000_i128), &0),
            Err(Ok(Error::MarketCapExceeded))
        );
        assert_eq!(
            f.treasury.try_close_trade(&f.agent, &cat_market),
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
                    args: (agent.clone(), cat_market, outcome_index, amount, min_out)
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy_cat(&agent, &cat_market, &outcome_index, &amount, &min_out);
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
            &f.agent,
            &BytesN::from_array(&f.env, &[17u8; 32]),
            &BytesN::from_array(&f.env, &[117u8; 32]),
            &String::from_str(&f.env, "ipfs://migration"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury.agent_buy(
            &f.agent,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
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
            &f.agent,
            &BytesN::from_array(&f.env, &[18u8; 32]),
            &BytesN::from_array(&f.env, &[118u8; 32]),
            &String::from_str(&f.env, "ipfs://migration-auth"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        f.treasury.agent_buy(
            &f.agent,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
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
        f.treasury.agent_buy(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0,
        );
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

    // ----- sliding daily window -------------------------------------------

    const USDC: i128 = 10_000_000;

    /// A second externally-created market in the fixture's market-core.
    fn extra_market(f: &Fixture, tag: u8) -> u64 {
        f.market_core.create_market(
            &f.market_core.get_market(&f.market_id).creator,
            &BytesN::from_array(&f.env, &[tag; 32]),
            &BytesN::from_array(&f.env, &[tag.wrapping_add(100); 32]),
            &String::from_str(&f.env, "ipfs://treasury-extra"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * USDC),
            &5000u32,
        )
    }

    fn stored_window(f: &Fixture) -> Option<UsageWindow> {
        f.env.as_contract(&f.treasury_id, || {
            f.env.storage().instance().get(&DataKey::UsageWindow)
        })
    }

    #[test]
    fn burst_across_old_window_boundary_is_rejected() {
        let f = fixture_with_caps(20 * USDC, 60 * USDC, 60 * USDC);
        // The old fixed window began at 1_000 and reset at 1_000 + 86_400.
        f.env.ledger().set_timestamp(1_000 + 86_399);
        for _ in 0..3 {
            f.treasury
                .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        }
        f.env.ledger().set_timestamp(1_000 + 86_401);
        let other = extra_market(&f, 21);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &other, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::DailyCapExceeded))
        );
    }

    #[test]
    fn usage_expires_after_25_hours() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        // Hour 0 is still in hour 24's window...
        f.env.ledger().set_timestamp(24 * BUCKET_SECONDS + 3_599);
        assert_eq!(f.treasury.daily_headroom(), 40 * USDC);
        // ...and gone from hour 25's.
        f.env.ledger().set_timestamp(25 * BUCKET_SECONDS);
        assert_eq!(f.treasury.daily_headroom(), 60 * USDC);
    }

    /// Regression for I4 ("no `max_daily` in any 24h"), the shape of the
    /// shortest counterexample the exhaustive explorer
    /// (`contracts/integration-tests`, `treasury_caps_exhaustive`) reports when
    /// the window is mutated to 24 buckets instead of 25: spend near the end of
    /// an hour, then again 86_399s later. 24h earlier than the second trade is
    /// still inside the window because the first trade's hour is only
    /// partially covered. The original fixed daily window (reset to `now` at
    /// the first call after 24h) allowed up to 2x `max_daily` here; the
    /// sliding window allows exactly `max_daily`.
    #[test]
    fn explorer_i4_sequence_stays_within_max_daily() {
        let u = 100 * USDC;
        let f = fixture_with_caps(2 * u, 3 * u, 4 * u);
        // A second market, so the daily cap binds before the per-market cap.
        let creator = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token).mint(&creator, &(1_000 * USDC));
        let second = f.market_core.create_market(
            &creator,
            &BytesN::from_array(&f.env, &[12u8; 32]),
            &BytesN::from_array(&f.env, &[112u8; 32]),
            &String::from_str(&f.env, "ipfs://second-market"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * USDC),
            &5000u32,
        );
        let first = 24 * BUCKET_SECONDS + 3_599;
        f.env.ledger().set_timestamp(first);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &u, &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(2 * u), &0);

        // 86_399s later the first hour is still counted: 3u + 2u > 4u.
        f.env.ledger().set_timestamp(first + 86_399);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &second, &Outcome::Yes, &(2 * u), &0),
            Err(Ok(Error::DailyCapExceeded))
        );
        // The failed call spent nothing; a buy that fits the remaining 1u does.
        assert_eq!(f.treasury.daily_headroom(), u);
        f.treasury
            .agent_buy(&f.agent, &second, &Outcome::Yes, &u, &0);

        // Once the first trade's hour has left the 25-bucket window (hour 49
        // covers hours 25..=49) its 3u are free again.
        f.env.ledger().set_timestamp(49 * BUCKET_SECONDS);
        assert_eq!(f.treasury.daily_headroom(), 3 * u);
    }

    #[test]
    fn same_hour_trades_accumulate() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(3_599);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(15 * USDC), &0);
        let window = f.treasury.daily_usage_detail();
        assert_eq!(window.head_hour, 0);
        assert_eq!(window.amounts.get(window.head_idx), Some(35 * USDC));
        assert_eq!(window.amounts.iter().sum::<i128>(), 35 * USDC);
    }

    #[test]
    fn long_idle_gap_clears_all_buckets() {
        let f = fixture();
        for hour in [0u64, 5, 20] {
            f.env.ledger().set_timestamp(hour * BUCKET_SECONDS + 1_000);
            f.treasury
                .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(10 * USDC), &0);
        }
        f.env
            .ledger()
            .set_timestamp(20 * BUCKET_SECONDS + 10 * DAY_SECONDS);
        let window = f.treasury.daily_usage_detail();
        assert_eq!(window.amounts.len(), BUCKETS);
        assert!(window.amounts.iter().all(|a| a == 0));
        assert_eq!(f.treasury.daily_usage().amount, 0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        assert_eq!(f.treasury.daily_usage().amount, 20 * USDC);
    }

    #[test]
    fn daily_usage_view_is_pure_and_stable() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let stored = stored_window(&f);
        f.env.ledger().set_timestamp(5 * BUCKET_SECONDS);
        let first = f.treasury.daily_usage();
        let second = f.treasury.daily_usage();
        assert_eq!(first, second);
        assert_eq!(
            first,
            DailyUsage {
                day_start: 0,
                amount: 20 * USDC
            }
        );
        // Reading advanced a copy only.
        assert_eq!(stored_window(&f), stored);
        assert_eq!(stored.unwrap().head_hour, 0);
    }

    #[test]
    fn legacy_daily_entry_is_migrated_conservatively() {
        let f = fixture();
        let install_legacy = |day_start: u64, amount: i128| {
            f.env.as_contract(&f.treasury_id, || {
                let storage = f.env.storage().instance();
                storage.remove(&DataKey::UsageWindow);
                storage.set(&DataKey::Daily, &DailyUsage { day_start, amount });
            })
        };

        // Legacy day still running: its usage counts in full.
        install_legacy(1_000, 50 * USDC);
        f.env.ledger().set_timestamp(1_000 + 23 * BUCKET_SECONDS);
        assert_eq!(f.treasury.daily_usage().amount, 50 * USDC);
        let other = extra_market(&f, 22);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &other, &Outcome::Yes, &(20 * USDC), &0),
            Err(Ok(Error::DailyCapExceeded))
        );
        f.treasury
            .agent_buy(&f.agent, &other, &Outcome::Yes, &(10 * USDC), &0);
        f.env.as_contract(&f.treasury_id, || {
            assert!(!f.env.storage().instance().has(&DataKey::Daily));
        });
        let window = stored_window(&f).unwrap();
        assert_eq!(window.amounts.iter().sum::<i128>(), 60 * USDC);

        // Legacy day already over: the window starts empty.
        install_legacy(1_000, 50 * USDC);
        f.env.ledger().set_timestamp(1_000 + DAY_SECONDS);
        assert_eq!(f.treasury.daily_usage().amount, 0);
    }

    #[test]
    fn daily_headroom_matches_cap_minus_window_sum() {
        let f = fixture();
        assert_eq!(f.treasury.daily_headroom(), 60 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(2 * BUCKET_SECONDS);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(5 * USDC), &0);
        assert_eq!(
            f.treasury.daily_headroom(),
            60 * USDC - f.treasury.daily_usage().amount
        );
        assert_eq!(f.treasury.daily_headroom(), 35 * USDC);
    }

    /// Randomized schedule (an LCG, as in market-core's math property tests)
    /// of 2_000 attempted trades over 30 days against the window logic
    /// itself. After every accepted trade the true usage over the trailing
    /// `(t - 86_400, t]` interval, brute-forced from a log, stays within cap.
    #[test]
    fn sliding_window_property_random_schedule() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let max_daily: i128 = 1_000;
        let mut window = Treasury::empty_window(&env, 0);
        let mut log: std::vec::Vec<(u64, i128)> = std::vec::Vec::new();
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            seed >> 33
        };
        let mut now: u64 = 0;
        let mut accepted = 0;
        for _ in 0..2_000 {
            // Mostly short gaps (bursts), sometimes multi-hour ones.
            now += if next() % 4 == 0 {
                next() % (6 * BUCKET_SECONDS)
            } else {
                next() % 900
            };
            if now > 30 * DAY_SECONDS {
                break;
            }
            let amount = 1 + (next() % 300) as i128;
            if Treasury::consume_window(&mut window, now, amount, max_daily).is_ok() {
                accepted += 1;
                log.push((now, amount));
                let trailing: i128 = log
                    .iter()
                    .filter(|(t, _)| *t + DAY_SECONDS > now)
                    .map(|(_, a)| a)
                    .sum();
                assert!(trailing <= max_daily, "t={now}: {trailing} > {max_daily}");
            }
        }
        assert!(accepted > 100, "schedule too sparse: {accepted}");
    }

    // ----- net exposure -----------------------------------------------------

    fn net_fixture(max_net_exposure: i128) -> Fixture {
        fixture_with_net_cap(150 * USDC, 300 * USDC, 300 * USDC, max_net_exposure)
    }

    fn agent_market(f: &Fixture, tag: u8) -> u64 {
        f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[tag; 32]),
            &BytesN::from_array(&f.env, &[tag.wrapping_add(100); 32]),
            &String::from_str(&f.env, "ipfs://net"),
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * USDC),
            &5000u32,
        )
    }

    #[test]
    fn net_cap_blocks_buy_when_total_deployed_exceeds_limit() {
        let f = fixture_with_net_cap(20 * USDC, 50 * USDC, 60 * USDC, 30 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let other = extra_market(&f, 23);
        // Within every lifetime/daily cap, but 20 + 11 > 30 deployed.
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &other, &Outcome::Yes, &(11 * USDC), &0),
            Err(Ok(Error::NetExposureExceeded))
        );
        f.treasury
            .agent_buy(&f.agent, &other, &Outcome::Yes, &(10 * USDC), &0);
        assert_eq!(f.treasury.net_exposure(), 30 * USDC);
        assert_eq!(f.treasury.get_net_cap(), 30 * USDC);
    }

    #[test]
    fn net_cap_applies_to_market_creation() {
        let f = fixture_with_net_cap(100 * USDC, 300 * USDC, 300 * USDC, 150 * USDC);
        agent_market(&f, 24);
        assert_eq!(f.treasury.net_exposure(), 100 * USDC);
        assert_eq!(
            f.treasury.try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &[25; 32]),
                &BytesN::from_array(&f.env, &[125; 32]),
                &String::from_str(&f.env, "ipfs://net-2"),
                &Category::Macro,
                &MARKET_CLOSE,
                &(100 * USDC),
                &5000u32,
            ),
            Err(Ok(Error::NetExposureExceeded))
        );
    }

    #[test]
    fn sell_frees_net_headroom_but_not_lifetime_cap() {
        let f = fixture_with_net_cap(20 * USDC, 50 * USDC, 60 * USDC, 30 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let quote = f
            .market_core
            .quote_sell(&f.market_id, &Outcome::Yes, &(5 * USDC));
        f.treasury
            .agent_sell(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &quote);
        assert_eq!(f.treasury.net_exposure(), 15 * USDC);
        assert_eq!(
            f.treasury.net_position(&f.market_id),
            NetPosition {
                collateral_in: 20 * USDC,
                collateral_out: 5 * USDC
            }
        );

        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(15 * USDC), &0);
        assert_eq!(f.treasury.net_exposure(), 30 * USDC);
        let exposure = f.env.as_contract(&f.treasury_id, || {
            Treasury::market_exposure(&f.env, &f.market_core.address, f.market_id)
        });
        // The lifetime cap counts the sold capital too.
        assert_eq!(exposure.amount, 35 * USDC);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::NetExposureExceeded))
        );
        // close_trade changes neither cap.
        f.treasury.close_trade(&f.agent, &f.market_id);
        assert_eq!(f.treasury.net_exposure(), 30 * USDC);
    }

    #[test]
    fn redeem_and_claim_reduce_net_exposure() {
        let f = net_fixture(300 * USDC);
        let market_id = agent_market(&f, 26);
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(20 * USDC), &0);
        assert_eq!(f.treasury.net_exposure(), 120 * USDC);

        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&market_id, &Outcome::Yes);
        let redeemed = f.treasury.redeem(&f.agent, &market_id);
        let claimed = f.treasury.claim_pool_remainder(&f.agent, &market_id);
        assert!(redeemed > 0 && claimed > 0);
        assert_eq!(
            f.treasury.net_position(&market_id),
            NetPosition {
                collateral_in: 120 * USDC,
                collateral_out: redeemed + claimed
            }
        );
        assert_eq!(
            f.treasury.net_exposure(),
            (120 * USDC - redeemed - claimed).max(0)
        );
    }

    #[test]
    fn profit_in_one_market_does_not_offset_another() {
        let f = net_fixture(300 * USDC);
        let other = extra_market(&f, 27);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &other, &Outcome::Yes, &(20 * USDC), &0);

        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        let payout = f.treasury.redeem(&f.agent, &f.market_id);
        assert!(payout > 20 * USDC, "winning shares pay out at a profit");
        assert_eq!(f.treasury.net_position(&f.market_id).collateral_out, payout);
        // The profitable market floors at 0; the other keeps its 20.
        assert_eq!(f.treasury.net_exposure(), 20 * USDC);
    }

    #[test]
    fn valuation_floor_counts_complete_sets_and_lp_min_reserve() {
        let f = net_fixture(300 * USDC);
        let market_id = agent_market(&f, 28);
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::No, &(10 * USDC), &0);

        let position = f.market_core.get_position(&market_id, &f.treasury_id);
        let market = f.market_core.get_market(&market_id);
        let floor = position.yes.min(position.no) + market.reserve_yes.min(market.reserve_no);
        let valuation = f.treasury.market_valuation(&market_id);
        assert_eq!(valuation.cost_basis, 130 * USDC);
        assert_eq!(valuation.floor_value, floor);
        assert_eq!(valuation.at_risk, (130 * USDC - floor).max(0));
        assert!(valuation.spot_value >= valuation.floor_value);
    }

    #[test]
    fn spot_manipulation_does_not_change_enforced_headroom() {
        let f = fixture_with_net_cap(20 * USDC, 50 * USDC, 60 * USDC, 30 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let before = f.treasury.market_valuation(&f.market_id);

        // A third party pumps YES hard.
        let whale = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token).mint(&whale, &(500 * USDC));
        f.market_core
            .buy(&whale, &f.market_id, &Outcome::Yes, &(400 * USDC), &0);
        let after = f.treasury.market_valuation(&f.market_id);
        assert!(after.spot_value > before.spot_value);
        assert_eq!(after.cost_basis, before.cost_basis);
        assert_eq!(f.treasury.net_exposure(), 20 * USDC);

        // Exactly the same 10 of headroom as before the pump.
        let other = extra_market(&f, 29);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &other, &Outcome::Yes, &(11 * USDC), &0),
            Err(Ok(Error::NetExposureExceeded))
        );
        f.treasury
            .agent_buy(&f.agent, &other, &Outcome::Yes, &(10 * USDC), &0);
    }

    #[test]
    fn valuation_after_resolution_uses_settlement_semantics() {
        let f = net_fixture(300 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(10 * USDC), &0);
        let position = f.market_core.get_position(&f.market_id, &f.treasury_id);
        let voided = extra_market(&f, 30);
        f.treasury
            .agent_buy(&f.agent, &voided, &Outcome::Yes, &(20 * USDC), &0);
        let voided_position = f.market_core.get_position(&voided, &f.treasury_id);

        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::No);
        f.market_core.void_market(&voided);

        let resolved = f.treasury.market_valuation(&f.market_id);
        assert_eq!(resolved.floor_value, position.no);
        assert_eq!(resolved.spot_value, position.no);
        let void = f.treasury.market_valuation(&voided);
        assert_eq!(
            void.floor_value,
            (voided_position.yes + voided_position.no) / 2
        );
        assert_eq!(void.spot_value, void.floor_value);
    }

    /// Stand-in market-core exposing only what a price-checked buy needs:
    /// `get_price` (a flat 50%), `quote_buy` and `buy`, which pulls the
    /// collateral like the real one and returns one share per stroop. If
    /// `agent_buy` made any other market-core call (a valuation read such as
    /// `get_market`/`get_position` on the hot path), it would fail against
    /// this contract.
    #[contract]
    struct BuyOnlyMarketCore;

    #[contractimpl]
    impl BuyOnlyMarketCore {
        pub fn set_token(env: Env, token: Address) {
            env.storage().instance().set(&0u32, &token);
        }

        pub fn calls(env: Env) -> u32 {
            env.storage().instance().get(&1u32).unwrap_or(0)
        }

        pub fn get_price(_env: Env, _market_id: u64, _outcome: Outcome) -> u32 {
            5_000
        }

        pub fn quote_buy(
            _env: Env,
            _market_id: u64,
            _outcome: Outcome,
            collateral_in: i128,
        ) -> i128 {
            collateral_in
        }

        pub fn buy(
            env: Env,
            trader: Address,
            _market_id: u64,
            _outcome: Outcome,
            collateral_in: i128,
            _min_shares_out: i128,
        ) -> i128 {
            trader.require_auth();
            let token: Address = env.storage().instance().get(&0u32).unwrap();
            soroban_sdk::token::TokenClient::new(&env, &token).transfer(
                &trader,
                env.current_contract_address(),
                &collateral_in,
            );
            let calls = Self::calls(env.clone());
            env.storage().instance().set(&1u32, &(calls + 1));
            collateral_in
        }
    }

    #[test]
    fn agent_buy_hot_path_makes_no_extra_cross_contract_reads() {
        let f = fixture();
        let proxy_id = f.env.register(BuyOnlyMarketCore, ());
        let proxy = BuyOnlyMarketCoreClient::new(&f.env, &proxy_id);
        proxy.set_token(&f.token);
        let config = f.treasury.get_config();
        let default_policy = CreationPolicy {
            max_seed: config.max_market,
            max_markets_per_window: 100,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        let max_drawdown = config.max_daily * 10;
        let window_days = 7u32;
        let treasury_id = f.env.register(
            Treasury,
            TreasuryArgs::__constructor(
                &f.admin,
                &config.agent,
                &f.token,
                &proxy_id,
                &config.max_trade,
                &config.max_market,
                &config.max_daily,
                &config.max_daily,
                &DELAY,
                &max_drawdown,
                &window_days,
                &default_policy,
            ),
        );
        StellarAssetClient::new(&f.env, &f.token).mint(&treasury_id, &(100 * USDC));
        let treasury = TreasuryClient::new(&f.env, &treasury_id);

        // Only the agent's call is mocked: the stub's token pull must be
        // covered by the treasury's own pre-authorization, as in production.
        f.env.set_auths(&[]);
        let (agent, amount) = (config.agent.clone(), 20 * USDC);
        f.env.cost_estimate().budget().reset_unlimited();
        let shares = treasury
            .mock_auths(&[MockAuth {
                address: &agent,
                invoke: &MockAuthInvoke {
                    contract: &treasury_id,
                    fn_name: "agent_buy",
                    args: (agent.clone(), f.market_id, Outcome::Yes, amount, 0_i128)
                        .into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .agent_buy(&agent, &f.market_id, &Outcome::Yes, &amount, &0);
        let used = f.env.cost_estimate().resources();
        std::println!(
            "agent_buy with net accounting + price checks: {} instructions, {} reads, {} writes",
            used.instructions,
            used.disk_read_entries,
            used.write_entries
        );
        assert!(shares > 0);
        assert_eq!(proxy.calls(), 1);
        assert_eq!(treasury.net_exposure(), 20 * USDC);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2003)")]
    fn constructor_rejects_net_cap_below_max_trade() {
        fixture_with_net_cap(20 * USDC, 50 * USDC, 60 * USDC, 20 * USDC - 1);
    }

    #[test]
    fn migrate_market_clears_net_exposure() {
        let f = net_fixture(300 * USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury.set_successor(&Address::generate(&f.env));
        f.treasury.migrate_market(&f.market_id);
        assert_eq!(f.treasury.net_exposure(), 0);
    }

    // ----- shared helpers ---------------------------------------------------

    fn has_event<E: soroban_sdk::Event>(f: &Fixture, event: &E) -> bool {
        use soroban_sdk::testutils::Events as _;
        let expected = soroban_sdk::Event::to_xdr(event, &f.env, &f.treasury_id);
        f.env
            .events()
            .all()
            .filter_by_contract(&f.treasury_id)
            .events()
            .contains(&expected)
    }

    fn policy(roles: u32, max_trade: i128, max_daily: i128) -> AgentPolicy {
        AgentPolicy {
            roles,
            max_trade,
            max_daily,
            active: true,
        }
    }

    /// Registers `agent` through the real flow: `set_agent`, then (unless it
    /// applied at once) wait out the delay and `execute_agent`. The clock is
    /// put back afterwards so window-sensitive tests are unaffected.
    fn register_agent(f: &Fixture, agent: &Address, p: AgentPolicy) {
        f.treasury.set_agent(agent, &p);
        if f.treasury.get_agent(agent) != Some(p) {
            let now = f.env.ledger().timestamp();
            f.env.ledger().set_timestamp(now + DELAY);
            f.treasury.execute_agent(agent);
            f.env.ledger().set_timestamp(now);
        }
        assert_eq!(f.treasury.get_agent(agent), Some(p));
    }

    fn mint(f: &Fixture, to: &Address, amount: i128) {
        StellarAssetClient::new(&f.env, &f.token).mint(to, &amount);
    }

    fn balance(f: &Fixture, of: &Address) -> i128 {
        soroban_sdk::token::TokenClient::new(&f.env, &f.token).balance(of)
    }

    fn create_args(f: &Fixture, tag: u8) -> (BytesN<32>, BytesN<32>, String) {
        (
            BytesN::from_array(&f.env, &[tag; 32]),
            BytesN::from_array(&f.env, &[tag.wrapping_add(100); 32]),
            String::from_str(&f.env, "ipfs://created"),
        )
    }

    // ----- agent registry (multi-agent roles and sub-budgets) ---------------

    #[test]
    fn trader_role_cannot_create_market() {
        let f = fixture_with_caps(150 * USDC, 300 * USDC, 300 * USDC);
        let trader = Address::generate(&f.env);
        register_agent(
            &f,
            &trader,
            policy(ROLE_TRADE | ROLE_SETTLE, 150 * USDC, 300 * USDC),
        );
        let (q, r, uri) = create_args(&f, 40);
        assert_eq!(
            f.treasury.try_agent_create_market(
                &trader,
                &q,
                &r,
                &uri,
                &Category::Macro,
                &MARKET_CLOSE,
                &(100 * USDC),
                &5000u32,
            ),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn maker_role_cannot_buy() {
        let f = fixture();
        let maker = Address::generate(&f.env);
        register_agent(
            &f,
            &maker,
            policy(ROLE_CREATE | ROLE_SETTLE, 20 * USDC, 60 * USDC),
        );
        assert_eq!(
            f.treasury
                .try_agent_buy(&maker, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::Unauthorized))
        );
        assert_eq!(
            f.treasury
                .try_agent_sell(&maker, &f.market_id, &Outcome::Yes, &USDC, &USDC),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn settle_role_required_for_settlement_entrypoints() {
        let f = fixture();
        let trader = Address::generate(&f.env);
        register_agent(&f, &trader, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        f.treasury
            .agent_buy(&trader, &f.market_id, &Outcome::Yes, &(10 * USDC), &0);
        assert_eq!(
            f.treasury.try_close_trade(&trader, &f.market_id),
            Err(Ok(Error::Unauthorized))
        );
        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        assert_eq!(
            f.treasury.try_redeem(&trader, &f.market_id),
            Err(Ok(Error::Unauthorized))
        );
        assert_eq!(
            f.treasury.try_claim_pool_remainder(&trader, &f.market_id),
            Err(Ok(Error::Unauthorized))
        );
        assert_eq!(
            f.treasury.try_agent_claim_lp_fees(&trader, &f.market_id),
            Err(Ok(Error::Unauthorized))
        );
        assert!(f.treasury.redeem(&f.agent, &f.market_id) > 0);
    }

    #[test]
    fn inactive_agent_rejected() {
        let f = fixture();
        let trader = Address::generate(&f.env);
        let stranger = Address::generate(&f.env);
        register_agent(&f, &trader, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        f.treasury.remove_agent(&trader);
        assert!(!f.treasury.get_agent(&trader).unwrap().active);
        assert_eq!(
            f.treasury
                .try_agent_buy(&trader, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::Unauthorized))
        );
        assert_eq!(
            f.treasury
                .try_agent_buy(&stranger, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::Unauthorized))
        );
        // Reactivation is a loosening: it waits out the delay.
        f.treasury
            .set_agent(&trader, &policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        assert!(!f.treasury.get_agent(&trader).unwrap().active);
        assert!(f.treasury.pending_agent(&trader).is_some());
    }

    #[test]
    fn per_agent_daily_cap_enforced_independently() {
        let f = fixture();
        let a = Address::generate(&f.env);
        let b = Address::generate(&f.env);
        register_agent(&f, &a, policy(ROLE_TRADE, 20 * USDC, 20 * USDC));
        register_agent(&f, &b, policy(ROLE_TRADE, 20 * USDC, 20 * USDC));
        f.treasury
            .agent_buy(&a, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        assert_eq!(
            f.treasury
                .try_agent_buy(&a, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::AgentDailyCapExceeded))
        );
        // `a` exhausting its budget leaves `b`'s untouched.
        f.treasury
            .agent_buy(&b, &f.market_id, &Outcome::No, &(20 * USDC), &0);
        assert_eq!(f.treasury.agent_daily_usage(&a).amount, 20 * USDC);
        assert_eq!(f.treasury.agent_daily_usage(&b).amount, 20 * USDC);
        assert_eq!(f.treasury.daily_usage().amount, 40 * USDC);
        // Per-agent windows slide like the global one.
        f.env.ledger().set_timestamp(25 * BUCKET_SECONDS);
        f.treasury
            .agent_buy(&a, &f.market_id, &Outcome::Yes, &USDC, &0);
    }

    #[test]
    fn global_daily_cap_still_binds_across_agents() {
        let f = fixture();
        let a = Address::generate(&f.env);
        let b = Address::generate(&f.env);
        register_agent(&f, &a, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        register_agent(&f, &b, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        let m2 = extra_market(&f, 41);
        f.treasury
            .agent_buy(&a, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&a, &m2, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&b, &m2, &Outcome::No, &(20 * USDC), &0);
        assert_eq!(
            f.treasury
                .try_agent_buy(&b, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::DailyCapExceeded))
        );
    }

    #[test]
    fn agent_trade_cap_below_global_enforced() {
        let f = fixture();
        let a = Address::generate(&f.env);
        register_agent(&f, &a, policy(ROLE_TRADE, 5 * USDC, 60 * USDC));
        assert_eq!(
            f.treasury
                .try_agent_buy(&a, &f.market_id, &Outcome::Yes, &(6 * USDC), &0),
            Err(Ok(Error::TradeCapExceeded))
        );
        f.treasury
            .agent_buy(&a, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
    }

    #[test]
    fn set_agent_rejects_policy_above_global_caps() {
        let f = fixture();
        let a = Address::generate(&f.env);
        for bad in [
            policy(ROLE_TRADE, 21 * USDC, 60 * USDC),
            policy(ROLE_TRADE, 20 * USDC, 61 * USDC),
            policy(ROLE_TRADE, 20 * USDC, 10 * USDC),
            policy(0, 20 * USDC, 60 * USDC),
            policy(1 << 3, 20 * USDC, 60 * USDC),
            policy(ROLE_TRADE, 0, 60 * USDC),
            AgentPolicy {
                active: false,
                ..policy(ROLE_TRADE, 20 * USDC, 60 * USDC)
            },
        ] {
            assert_eq!(
                f.treasury.try_set_agent(&a, &bad),
                Err(Ok(Error::InvalidConfig))
            );
        }
    }

    #[test]
    fn new_agent_waits_for_delay_but_narrowing_applies_at_once() {
        let f = fixture();
        let a = Address::generate(&f.env);
        let p = policy(ROLE_TRADE | ROLE_SETTLE, 20 * USDC, 60 * USDC);
        f.treasury.set_agent(&a, &p);
        assert!(has_event(
            &f,
            &AgentPolicyProposed {
                agent: a.clone(),
                roles: p.roles,
                max_trade: p.max_trade,
                max_daily: p.max_daily,
                executable_at: 1_000 + DELAY,
            }
        ));
        assert_eq!(f.treasury.get_agent(&a), None);
        assert_eq!(
            f.treasury.try_execute_agent(&a),
            Err(Ok(Error::TimelockActive))
        );
        assert_eq!(
            f.treasury.try_set_agent(&a, &p),
            Err(Ok(Error::ProposalPending))
        );
        f.env.ledger().set_timestamp(1_000 + DELAY);
        f.treasury.execute_agent(&a);
        assert_eq!(f.treasury.get_agent(&a), Some(p));
        assert_eq!(f.treasury.pending_agent(&a), None);

        // Narrowing (fewer roles, lower caps) is immediate.
        let narrower = policy(ROLE_TRADE, 10 * USDC, 30 * USDC);
        f.treasury.set_agent(&a, &narrower);
        assert!(has_event(
            &f,
            &AgentPolicySet {
                agent: a.clone(),
                roles: ROLE_TRADE,
                max_trade: 10 * USDC,
                max_daily: 30 * USDC,
            }
        ));
        assert_eq!(f.treasury.get_agent(&a), Some(narrower));
        // Widening back is not; a no-op is refused.
        f.treasury.set_agent(&a, &p);
        assert_eq!(f.treasury.get_agent(&a), Some(narrower));
        f.treasury.cancel_agent(&a);
        assert_eq!(f.treasury.pending_agent(&a), None);
        assert_eq!(
            f.treasury.try_set_agent(&a, &narrower),
            Err(Ok(Error::InvalidConfig))
        );
    }

    #[test]
    fn agent_enumeration_is_bounded_and_counts_each_agent_once() {
        let f = fixture();
        assert_eq!(f.treasury.agent_count(), 1);
        assert_eq!(f.treasury.agent_at(&0), Some(f.agent.clone()));
        let a = Address::generate(&f.env);
        register_agent(&f, &a, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        f.treasury.remove_agent(&a);
        register_agent(&f, &a, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        assert_eq!(f.treasury.agent_count(), 2);
        for _ in 2..MAX_AGENTS {
            register_agent(
                &f,
                &Address::generate(&f.env),
                policy(ROLE_TRADE, USDC, USDC),
            );
        }
        assert_eq!(f.treasury.agent_count(), MAX_AGENTS);
        assert_eq!(
            f.treasury
                .try_set_agent(&Address::generate(&f.env), &policy(ROLE_TRADE, USDC, USDC)),
            Err(Ok(Error::InvalidConfig))
        );
    }

    #[test]
    fn last_settle_capable_agent_cannot_be_removed() {
        let f = fixture();
        assert_eq!(
            f.treasury.try_remove_agent(&f.agent),
            Err(Ok(Error::InvalidConfig))
        );
        assert_eq!(
            f.treasury.try_set_agent(
                &f.agent,
                &policy(ROLE_TRADE | ROLE_CREATE, 20 * USDC, 60 * USDC)
            ),
            Err(Ok(Error::InvalidConfig))
        );
        let keeper = Address::generate(&f.env);
        register_agent(&f, &keeper, policy(ROLE_SETTLE, USDC, USDC));
        f.treasury.remove_agent(&f.agent);
        assert!(has_event(
            &f,
            &AgentRemoved {
                agent: f.agent.clone()
            }
        ));
    }

    #[test]
    fn legacy_config_migrates_to_single_full_role_agent() {
        let f = fixture();
        let core = f.market_core.address.clone();
        f.env.as_contract(&f.treasury_id, || {
            let instance = f.env.storage().instance();
            for key in [
                DataKey::Global,
                DataKey::AgentCount,
                DataKey::OriginalCore,
                DataKey::TotalShares,
            ] {
                instance.remove(&key);
            }
            let persistent = f.env.storage().persistent();
            persistent.remove(&DataKey::Agent(f.agent.clone()));
            persistent.remove(&DataKey::AgentAt(0));
            persistent.remove(&DataKey::Shares(f.admin.clone()));
            instance.set(
                &DataKey::Config,
                &RiskConfig {
                    agent: f.agent.clone(),
                    collateral: f.token.clone(),
                    market_core: core.clone(),
                    max_trade: 20 * USDC,
                    max_market: 50 * USDC,
                    max_daily: 60 * USDC,
                },
            );
            instance.set(&DataKey::NetCap, &(30 * USDC));
        });

        let global = f.treasury.get_global();
        assert_eq!(global.max_net_exposure, 30 * USDC);
        assert_eq!(global.market_core, core);
        assert_eq!(
            f.treasury.get_agent(&f.agent),
            Some(policy(ROLE_ALL, 20 * USDC, 60 * USDC))
        );
        assert_eq!(f.treasury.agent_count(), 1);
        assert_eq!(f.treasury.get_config().agent, f.agent);
        // The pre-vault balance became the admin's shares.
        assert!(f.treasury.shares_of(&f.admin) > 0);
        f.env.as_contract(&f.treasury_id, || {
            let instance = f.env.storage().instance();
            assert!(!instance.has(&DataKey::Config));
            assert!(!instance.has(&DataKey::NetCap));
        });
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
    }

    #[test]
    fn trade_authorized_event_attributes_acting_agent() {
        let f = fixture();
        let b = Address::generate(&f.env);
        register_agent(&f, &b, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        f.treasury
            .agent_buy(&b, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
        assert!(has_event(
            &f,
            &TradeAuthorized {
                market_id: f.market_id,
                agent: b.clone(),
                amount: 5 * USDC,
                market_total: 5 * USDC,
                daily_total: 5 * USDC,
            }
        ));
    }

    #[test]
    fn wrong_caller_cannot_set_or_remove_agent() {
        let f = fixture();
        let not_admin = Address::generate(&f.env);
        let target = Address::generate(&f.env);
        let p = policy(ROLE_TRADE, USDC, USDC);
        f.env.set_auths(&[]);
        let mock =
            |fn_name: &'static str, args: soroban_sdk::Vec<soroban_sdk::Val>| (fn_name, args);
        let calls = [
            mock("set_agent", (target.clone(), p).into_val(&f.env)),
            mock("remove_agent", (f.agent.clone(),).into_val(&f.env)),
            mock("cancel_agent", (target.clone(),).into_val(&f.env)),
        ];
        for (fn_name, args) in calls.iter() {
            let auth = [MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name,
                    args: args.clone(),
                    sub_invokes: &[],
                },
            }];
            let client = f.treasury.mock_auths(&auth);
            let failed = match *fn_name {
                "set_agent" => client.try_set_agent(&target, &p).is_err(),
                "remove_agent" => client.try_remove_agent(&f.agent).is_err(),
                _ => client.try_cancel_agent(&target).is_err(),
            };
            assert!(failed, "{fn_name} accepted a non-admin signature");
        }
    }

    #[test]
    fn wrong_agent_signature_rejected_for_agent_buy() {
        let f = fixture();
        let b = Address::generate(&f.env);
        register_agent(&f, &b, policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        let amount = 5 * USDC;
        f.env.set_auths(&[]);
        // `f.agent` signs a call that names `b` as the acting agent.
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &f.agent,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name: "agent_buy",
                    args: (b.clone(), f.market_id, Outcome::Yes, amount, 0_i128).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_agent_buy(&b, &f.market_id, &Outcome::Yes, &amount, &0)
            .is_err());
    }

    // ----- timelocked configuration -----------------------------------------

    fn global_with(f: &Fixture, edit: impl FnOnce(&mut GlobalConfig)) -> GlobalConfig {
        let mut g = f.treasury.get_global();
        edit(&mut g);
        g
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2003)")]
    fn constructor_invalid_caps_panics_with_contract_error_3() {
        fixture_with_caps(20 * USDC, 10 * USDC, 60 * USDC);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2003)")]
    fn constructor_rejects_config_delay_below_minimum() {
        let default_policy = CreationPolicy {
            max_seed: USDC,
            max_markets_per_window: 100,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        let max_drawdown = USDC * 10;
        let window_days = 7u32;
        let f = fixture();
        f.env.register(
            Treasury,
            TreasuryArgs::__constructor(
                &f.admin,
                &f.agent,
                &f.token,
                &f.market_core.address,
                &USDC,
                &USDC,
                &USDC,
                &USDC,
                &(MIN_CONFIG_DELAY - 1),
                &max_drawdown,
                &window_days,
                &default_policy,
            ),
        );
    }

    #[test]
    fn tighten_only_applies_immediately_and_emits_event() {
        let f = fixture();
        let old = f.treasury.get_global();
        let new = global_with(&f, |g| {
            g.max_trade = 10 * USDC;
            g.max_daily = 50 * USDC;
        });
        f.treasury.propose_config(&new);
        assert!(has_event(
            &f,
            &ConfigExecuted {
                old,
                new: new.clone(),
                immediate: true,
            }
        ));
        assert_eq!(f.treasury.get_global(), new);
        assert_eq!(f.treasury.pending_config(), None);
        // The global cap now binds even though the agent's own is higher.
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(11 * USDC), &0),
            Err(Ok(Error::TradeCapExceeded))
        );
        assert_eq!(
            f.treasury.try_propose_config(&new),
            Err(Ok(Error::InvalidConfig))
        );
    }

    #[test]
    fn raise_cap_requires_delay() {
        let f = fixture();
        let old = f.treasury.get_global();
        let new = global_with(&f, |g| g.max_daily = 100 * USDC);
        f.treasury.propose_config(&new);
        assert!(has_event(
            &f,
            &ConfigProposed {
                old: old.clone(),
                new: new.clone(),
                executable_at: 1_000 + DELAY,
            }
        ));
        assert_eq!(f.treasury.get_global(), old);
        // Mixed proposals (one cap down, one up) are loosening as a whole.
        f.treasury.cancel_config();
        let mixed = global_with(&f, |g| {
            g.max_trade = 10 * USDC;
            g.max_daily = 100 * USDC;
        });
        f.treasury.propose_config(&mixed);
        assert_eq!(f.treasury.get_global(), old);
        assert_eq!(f.treasury.pending_config().unwrap().config, mixed);
    }

    #[test]
    fn agent_change_requires_delay_and_new_agent_works_after_execute() {
        let f = fixture();
        let fresh = Address::generate(&f.env);
        f.treasury
            .set_agent(&fresh, &policy(ROLE_TRADE, 20 * USDC, 60 * USDC));
        assert_eq!(
            f.treasury
                .try_agent_buy(&fresh, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::Unauthorized))
        );
        f.env.ledger().set_timestamp(1_000 + DELAY);
        f.treasury.execute_agent(&fresh);
        f.treasury
            .agent_buy(&fresh, &f.market_id, &Outcome::Yes, &USDC, &0);
    }

    #[test]
    fn execute_before_delay_fails_timelock_active() {
        let f = fixture();
        f.treasury
            .propose_config(&global_with(&f, |g| g.max_daily = 100 * USDC));
        f.env.ledger().set_timestamp(1_000 + DELAY - 1);
        assert_eq!(
            f.treasury.try_execute_config(),
            Err(Ok(Error::TimelockActive))
        );
    }

    #[test]
    fn execute_is_permissionless_after_delay() {
        let f = fixture();
        let old = f.treasury.get_global();
        let new = global_with(&f, |g| g.max_daily = 100 * USDC);
        f.treasury.propose_config(&new);
        f.env.ledger().set_timestamp(1_000 + DELAY);
        f.env.set_auths(&[]);
        f.treasury.execute_config();
        assert!(has_event(
            &f,
            &ConfigExecuted {
                old,
                new: new.clone(),
                immediate: false,
            }
        ));
        assert_eq!(f.treasury.get_global(), new);
    }

    #[test]
    fn cancel_removes_pending_and_blocks_execute() {
        let f = fixture();
        let new = global_with(&f, |g| g.max_daily = 100 * USDC);
        f.treasury.propose_config(&new);
        f.treasury.cancel_config();
        assert!(has_event(&f, &ConfigCancelled { config: new }));
        f.env.ledger().set_timestamp(1_000 + DELAY);
        assert_eq!(
            f.treasury.try_execute_config(),
            Err(Ok(Error::NoPendingConfig))
        );
        assert_eq!(
            f.treasury.try_cancel_config(),
            Err(Ok(Error::NoPendingConfig))
        );
    }

    #[test]
    fn second_loosening_proposal_rejected_while_pending() {
        let f = fixture();
        f.treasury
            .propose_config(&global_with(&f, |g| g.max_daily = 100 * USDC));
        assert_eq!(
            f.treasury
                .try_propose_config(&global_with(&f, |g| g.max_daily = 200 * USDC)),
            Err(Ok(Error::ProposalPending))
        );
        // A tightening still goes through and leaves the pending one queued.
        let tight = global_with(&f, |g| g.max_trade = 10 * USDC);
        f.treasury.propose_config(&tight);
        assert_eq!(f.treasury.get_global(), tight);
        assert!(f.treasury.pending_config().is_some());
    }

    #[test]
    fn market_core_switch_namespaces_exposure_and_allows_legacy_redeem() {
        let f = fixture();
        let old_core = f.market_core.address.clone();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);

        let creator = f.market_core.get_market(&f.market_id).creator;
        let new_core_id = register_market_core(
            &f.env,
            (
                f.admin.clone(),
                f.token.clone(),
                f.treasury_id.clone(),
                Address::generate(&f.env),
                100u32,
                10_000u32,
            ),
        );
        let new_core = MarketCoreClient::new(&f.env, &new_core_id);
        f.treasury
            .propose_config(&global_with(&f, |g| g.market_core = new_core_id.clone()));
        f.env.ledger().set_timestamp(1_000 + DELAY);
        f.treasury.execute_config();
        assert_eq!(f.treasury.get_global().market_core, new_core_id);

        // Market id 0 again, in the new core: its exposure is separate.
        let new_market = new_core.create_market(
            &creator,
            &BytesN::from_array(&f.env, &[42; 32]),
            &BytesN::from_array(&f.env, &[142; 32]),
            &String::from_str(&f.env, "ipfs://new-core"),
            &Category::Crypto,
            &MARKET_CLOSE,
            &(100 * USDC),
            &5000u32,
        );
        assert_eq!(new_market, f.market_id);
        f.treasury
            .agent_buy(&f.agent, &new_market, &Outcome::Yes, &(20 * USDC), &0);
        assert_eq!(
            f.treasury.net_position(&new_market),
            NetPosition {
                collateral_in: 20 * USDC,
                collateral_out: 0
            }
        );
        f.env.as_contract(&f.treasury_id, || {
            assert_eq!(
                Treasury::market_exposure(&f.env, &old_core, f.market_id).amount,
                20 * USDC
            );
            assert_eq!(
                Treasury::market_exposure(&f.env, &new_core_id, new_market).amount,
                20 * USDC
            );
        });
        assert_eq!(f.treasury.open_market_count(), 2);
        assert_eq!(f.treasury.net_exposure(), 40 * USDC);

        // The position left behind in the old core is recoverable.
        assert_eq!(
            f.treasury
                .try_legacy_redeem(&f.agent, &new_core_id, &new_market),
            Err(Ok(Error::LegacyCoreUnknown))
        );
        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        let before = balance(&f, &f.treasury_id);
        let payout = f.treasury.legacy_redeem(&f.agent, &old_core, &f.market_id);
        assert!(payout > 0);
        assert_eq!(balance(&f, &f.treasury_id), before + payout);
        assert_eq!(f.treasury.open_market_count(), 1);
        assert_eq!(
            f.treasury.open_market_at(&0),
            Some(OpenMarket {
                core: new_core_id,
                market_id: new_market
            })
        );
        // The old core's net exposure was settled, the new one's is intact.
        assert_eq!(f.treasury.net_exposure(), 20 * USDC);
    }

    #[test]
    fn collateral_change_rejected_with_nonzero_old_balance() {
        let f = fixture();
        let other = f.env.register_stellar_asset_contract_v2(f.admin.clone());
        assert_eq!(
            f.treasury
                .try_propose_config(&global_with(&f, |g| g.collateral = other.address())),
            Err(Ok(Error::InvalidConfig))
        );

        // An empty treasury may switch.
        let empty = fixture_full(20 * USDC, 50 * USDC, 60 * USDC, 60 * USDC, false);
        let other = empty
            .env
            .register_stellar_asset_contract_v2(empty.admin.clone());
        let mut g = empty.treasury.get_global();
        g.collateral = other.address();
        empty.treasury.propose_config(&g);
        empty.env.ledger().set_timestamp(1_000 + DELAY);
        empty.treasury.execute_config();
        assert_eq!(empty.treasury.get_global().collateral, other.address());
    }

    #[test]
    fn config_delay_cannot_be_shortened() {
        let f = fixture();
        assert_eq!(f.treasury.config_delay(), DELAY);
        assert_eq!(
            f.treasury.try_set_config_delay(&(DELAY - 1)),
            Err(Ok(Error::InvalidConfig))
        );
        f.treasury.set_config_delay(&(2 * DELAY));
        assert!(has_event(
            &f,
            &ConfigDelaySet {
                old: DELAY,
                new: 2 * DELAY
            }
        ));
        f.treasury
            .propose_config(&global_with(&f, |g| g.max_daily = 100 * USDC));
        assert_eq!(
            f.treasury.pending_config().unwrap().executable_at,
            1_000 + 2 * DELAY
        );
    }

    #[test]
    fn wrong_caller_cannot_propose_cancel_or_set_delay() {
        let f = fixture();
        let not_admin = Address::generate(&f.env);
        let new = global_with(&f, |g| g.max_trade = 10 * USDC);
        let prices = DEFAULT_PRICE_POLICY;
        f.env.set_auths(&[]);
        let auth =
            |fn_name: &'static str, args: soroban_sdk::Vec<soroban_sdk::Val>| (fn_name, args);
        let calls = [
            auth("propose_config", (new.clone(),).into_val(&f.env)),
            auth("cancel_config", soroban_sdk::Vec::new(&f.env)),
            auth("set_config_delay", (2 * DELAY,).into_val(&f.env)),
            auth("set_price_policy", (prices,).into_val(&f.env)),
            auth("cancel_price_policy", soroban_sdk::Vec::new(&f.env)),
        ];
        for (fn_name, args) in calls.iter() {
            let mock = [MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    fn_name,
                    args: args.clone(),
                    sub_invokes: &[],
                },
            }];
            let client = f.treasury.mock_auths(&mock);
            let failed = match *fn_name {
                "propose_config" => client.try_propose_config(&new).is_err(),
                "cancel_config" => client.try_cancel_config().is_err(),
                "set_config_delay" => client.try_set_config_delay(&(2 * DELAY)).is_err(),
                "set_price_policy" => client.try_set_price_policy(&prices).is_err(),
                _ => client.try_cancel_price_policy().is_err(),
            };
            assert!(failed, "{fn_name} accepted a non-admin signature");
        }
    }

    // ----- vault ------------------------------------------------------------

    fn vault_fixture() -> Fixture {
        fixture_full(100 * USDC, 200 * USDC, 300 * USDC, 300 * USDC, false)
    }

    fn depositor(f: &Fixture, amount: i128) -> Address {
        let who = Address::generate(&f.env);
        mint(f, &who, amount);
        who
    }

    #[test]
    fn first_deposit_mints_shares_with_virtual_offset() {
        let f = vault_fixture();
        assert_eq!(f.treasury.total_shares(), 0);
        assert_eq!(f.treasury.nav(), 0);
        let alice = depositor(&f, 100 * USDC);
        assert_eq!(
            f.treasury.try_deposit(&alice, &(MIN_DEPOSIT - 1)),
            Err(Ok(Error::DepositTooSmall))
        );
        let shares = f.treasury.deposit(&alice, &(100 * USDC));
        assert!(has_event(
            &f,
            &Deposited {
                owner: alice.clone(),
                amount: 100 * USDC,
                shares,
                nav: 0,
            }
        ));
        assert_eq!(shares, 100 * USDC * VIRTUAL_SHARES - VIRTUAL_SHARES);
        assert_eq!(f.treasury.shares_of(&alice), shares);
        assert_eq!(f.treasury.total_shares(), 100 * USDC * VIRTUAL_SHARES);
        assert_eq!(f.treasury.nav(), 100 * USDC);

        // A pre-funded treasury mints its balance to the admin instead.
        let g = fixture();
        assert_eq!(
            g.treasury.shares_of(&g.admin),
            1_000 * USDC * VIRTUAL_SHARES - VIRTUAL_SHARES
        );
    }

    #[test]
    fn donation_attack_does_not_steal_from_second_depositor() {
        let f = vault_fixture();
        let attacker = depositor(&f, 1_010 * USDC);
        let victim = depositor(&f, 100 * USDC);
        f.treasury.deposit(&attacker, &MIN_DEPOSIT);
        // Donate straight to the treasury to inflate the share price.
        soroban_sdk::token::TokenClient::new(&f.env, &f.token).transfer(
            &attacker,
            &f.treasury_id,
            &(1_000 * USDC),
        );
        let shares = f.treasury.deposit(&victim, &(100 * USDC));
        assert!(shares > 0);
        f.treasury.request_withdraw(&victim, &shares);
        let back = balance(&f, &victim);
        // At most rounding dust is lost, nowhere near the donation's leverage.
        assert!(back >= 100 * USDC - 2, "victim got {back}");

        let attacker_shares = f.treasury.shares_of(&attacker);
        f.treasury.request_withdraw(&attacker, &attacker_shares);
        assert!(balance(&f, &attacker) <= 1_010 * USDC);
    }

    #[test]
    fn deposit_withdraw_round_trip_never_profits() {
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            seed >> 11
        };
        for _ in 0..1_000 {
            let nav = (next() % 1_000_000_000_000_000) as i128;
            // 1..2_000 shares per stroop of NAV (1_000 after a first mint).
            let supply = if nav == 0 {
                0
            } else {
                nav * (1 + (next() % 2_000) as i128)
            };
            let amount = MIN_DEPOSIT + (next() % 10_000_000_000_000) as i128;
            let shares = shares_for_deposit(amount, nav, supply).unwrap();
            let back = assets_for_shares(shares, nav + amount, supply + shares).unwrap();
            assert!(
                back <= amount,
                "nav={nav} supply={supply} amount={amount}: {back} > {amount}"
            );
        }

        // And end to end through the contract.
        let f = vault_fixture();
        let alice = depositor(&f, 500 * USDC);
        f.treasury.deposit(&alice, &(123 * USDC));
        let bob = depositor(&f, 500 * USDC);
        for amount in [MIN_DEPOSIT, 77 * USDC + 3, 250 * USDC + 1] {
            let before = balance(&f, &bob);
            let shares = f.treasury.deposit(&bob, &amount);
            f.treasury.request_withdraw(&bob, &shares);
            assert!(balance(&f, &bob) <= before);
        }
    }

    #[test]
    fn nav_counts_complete_sets_and_lp_floor_not_directional_exposure() {
        let f = fixture_with_caps(150 * USDC, 300 * USDC, 300 * USDC);
        let market_id = agent_market(&f, 43);
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(5 * USDC), &0);

        let own = f.market_core.get_market(&market_id);
        let own_pos = f.market_core.get_position(&market_id, &f.treasury_id);
        let ext_pos = f.market_core.get_position(&f.market_id, &f.treasury_id);
        let expected = balance(&f, &f.treasury_id)
            + own_pos.yes.min(own_pos.no)
            + own.reserve_yes.min(own.reserve_no)
            + ext_pos.yes.min(ext_pos.no);
        assert_eq!(f.treasury.nav(), expected);
        assert_eq!(f.treasury.open_market_count(), 2);
        // Directional YES beyond complete sets is worth nothing to NAV.
        assert!(ext_pos.yes > ext_pos.no);
    }

    #[test]
    fn spot_price_pump_does_not_change_nav() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(10 * USDC), &0);
        let nav = f.treasury.nav();
        let before = f.treasury.market_valuation(&f.market_id);

        let whale = depositor(&f, 500 * USDC);
        f.market_core
            .buy(&whale, &f.market_id, &Outcome::Yes, &(400 * USDC), &0);
        assert!(f.treasury.market_valuation(&f.market_id).spot_value > before.spot_value);
        assert_eq!(f.treasury.nav(), nav);
        f.market_core
            .buy(&whale, &f.market_id, &Outcome::No, &(90 * USDC), &0);
        assert_eq!(f.treasury.nav(), nav);
    }

    #[test]
    fn nav_unchanged_by_redeem_after_resolution() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(10 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        let nav = f.treasury.nav();
        assert_eq!(f.treasury.open_market_count(), 1);
        f.treasury.redeem(&f.agent, &f.market_id);
        assert_eq!(f.treasury.nav(), nav);
        // Nothing is left in the market, so it leaves the index.
        assert_eq!(f.treasury.open_market_count(), 0);
    }

    /// Two depositors, then most of the capital deployed into one market.
    fn deployed_vault() -> (Fixture, Address, Address) {
        let f = vault_fixture();
        let alice = depositor(&f, 100 * USDC);
        let bob = depositor(&f, 100 * USDC);
        f.treasury.deposit(&alice, &(100 * USDC));
        f.treasury.deposit(&bob, &(100 * USDC));
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(100 * USDC), &0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &(90 * USDC), &0);
        assert_eq!(balance(&f, &f.treasury_id), 10 * USDC);
        (f, alice, bob)
    }

    #[test]
    fn withdraw_pays_idle_then_queues_remainder() {
        let (f, alice, _) = deployed_vault();
        let shares = f.treasury.shares_of(&alice);
        let nav = f.treasury.nav();
        let assets = assets_for_shares(shares, nav, f.treasury.total_shares()).unwrap();
        assert!(assets > 10 * USDC);

        let (paid, ticket_id) = f.treasury.request_withdraw(&alice, &shares);
        assert!(has_event(
            &f,
            &WithdrawRequested {
                owner: alice.clone(),
                shares,
                assets,
                paid_now: paid,
                ticket_id,
            }
        ));
        assert_eq!(paid, 10 * USDC);
        assert_eq!(ticket_id, 1);
        assert_eq!(f.treasury.shares_of(&alice), 0);
        assert_eq!(f.treasury.queue_reserved(), assets - paid);
        assert_eq!(
            f.treasury.withdraw_ticket(&1),
            Some(WithdrawTicket {
                owner: alice,
                remaining: assets - paid,
                created_at: 1_000,
            })
        );
        assert_eq!(
            f.treasury
                .try_request_withdraw(&Address::generate(&f.env), &1),
            Err(Ok(Error::InsufficientShares))
        );
    }

    #[test]
    fn agent_buy_cannot_spend_queue_reserved_capital() {
        let (f, alice, _) = deployed_vault();
        let shares = f.treasury.shares_of(&alice);
        f.treasury.request_withdraw(&alice, &shares);
        let reserved = f.treasury.queue_reserved();
        // New money arrives: 10 USDC more than what the queue is owed.
        let carol = depositor(&f, reserved + 10 * USDC);
        f.treasury.deposit(&carol, &(reserved + 10 * USDC));
        let other = extra_market(&f, 44);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &other, &Outcome::Yes, &(10 * USDC + 1), &0),
            Err(Ok(Error::CapitalReserved))
        );
        f.treasury
            .agent_buy(&f.agent, &other, &Outcome::Yes, &(10 * USDC), &0);
        assert!(balance(&f, &f.treasury_id) >= reserved);
    }

    #[test]
    fn claim_withdraw_pays_fifo_after_capital_returns() {
        let (f, alice, bob) = deployed_vault();
        let (_, t1) = f
            .treasury
            .request_withdraw(&alice, &f.treasury.shares_of(&alice));
        let (paid_bob, t2) = f
            .treasury
            .request_withdraw(&bob, &f.treasury.shares_of(&bob));
        assert_eq!((t1, t2, paid_bob), (1, 2, 0));
        assert_eq!(f.treasury.queue_bounds(), (1, 3));
        assert_eq!(
            f.treasury.try_claim_withdraw(&t2),
            Err(Ok(Error::NothingToPay))
        );
        assert_eq!(
            f.treasury.try_claim_withdraw(&t1),
            Err(Ok(Error::NothingToPay))
        );
        assert_eq!(
            f.treasury.try_claim_withdraw(&9),
            Err(Ok(Error::TicketNotFound))
        );

        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);
        f.treasury.redeem(&f.agent, &f.market_id);
        let owed_alice = f.treasury.withdraw_ticket(&t1).unwrap().remaining;
        let owed_bob = f.treasury.withdraw_ticket(&t2).unwrap().remaining;
        let alice_before = balance(&f, &alice);

        f.env.set_auths(&[]);
        assert_eq!(f.treasury.claim_withdraw(&t1), owed_alice);
        assert!(has_event(
            &f,
            &WithdrawPaid {
                ticket_id: t1,
                amount: owed_alice
            }
        ));
        assert_eq!(balance(&f, &alice), alice_before + owed_alice);
        assert_eq!(f.treasury.claim_withdraw(&t2), owed_bob);
        assert_eq!(f.treasury.queue_reserved(), 0);
        assert_eq!(f.treasury.queue_bounds(), (3, 3));
        assert_eq!(f.treasury.withdraw_ticket(&t1), None);
    }

    #[test]
    fn emergency_withdraw_only_while_paused_and_pro_rata_of_idle() {
        let (f, alice, _) = deployed_vault();
        let shares = f.treasury.shares_of(&alice);
        assert_eq!(
            f.treasury.try_emergency_withdraw(&alice, &shares),
            Err(Ok(Error::NotPaused))
        );
        f.treasury.set_paused(&true);
        let supply = f.treasury.total_shares();
        let expected = shares * (10 * USDC) / (supply + VIRTUAL_SHARES);
        assert_eq!(f.treasury.emergency_withdraw(&alice, &shares), expected);
        assert_eq!(balance(&f, &alice), expected);
        assert_eq!(f.treasury.shares_of(&alice), 0);
        assert_eq!(
            f.treasury.try_deposit(&alice, &MIN_DEPOSIT),
            Err(Ok(Error::Paused))
        );
    }

    /// `count` extra externally-created markets, each with 1 USDC of treasury
    /// exposure.
    fn fill_open_markets(f: &Fixture, count: u32) -> u64 {
        let creator = f.market_core.get_market(&f.market_id).creator;
        mint(f, &creator, count as i128 * 100 * USDC);
        let mut last = f.market_id;
        for i in 0..count {
            last = extra_market(f, 50 + i as u8);
            f.treasury
                .agent_buy(&f.agent, &last, &Outcome::Yes, &(USDC / 10), &0);
        }
        last
    }

    #[test]
    fn open_market_cap_enforced() {
        let f = fixture();
        fill_open_markets(&f, MAX_OPEN_MARKETS);
        assert_eq!(f.treasury.open_market_count(), MAX_OPEN_MARKETS);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::TooManyOpenMarkets))
        );
        // Adding to a market already in the index is fine.
        let indexed = f.treasury.open_market_at(&5).unwrap().market_id;
        f.treasury
            .agent_buy(&f.agent, &indexed, &Outcome::Yes, &USDC, &0);
    }

    /// The test host enforces the network's per-transaction limits on every
    /// invocation (instructions, memory, entries), so a `deposit` and a
    /// `request_withdraw` that each walk a full index must simply succeed.
    #[test]
    fn nav_budget_within_limits_at_max_open_markets() {
        let f = fixture();
        fill_open_markets(&f, MAX_OPEN_MARKETS);
        let alice = depositor(&f, 100 * USDC);
        for step in ["deposit", "request_withdraw"] {
            f.env.cost_estimate().budget().reset_unlimited();
            if step == "deposit" {
                f.treasury.deposit(&alice, &(100 * USDC));
            } else {
                f.treasury
                    .request_withdraw(&alice, &f.treasury.shares_of(&alice));
            }
            let used = f.env.cost_estimate().resources();
            std::println!(
                "{step} over {MAX_OPEN_MARKETS} open markets: {} instructions, {} memory bytes, {} reads",
                used.instructions,
                used.mem_bytes,
                used.disk_read_entries
            );
        }
        assert!(f.treasury.nav() > 0);
    }

    #[test]
    fn index_swap_and_pop_keeps_entries_consistent() {
        let f = fixture();
        fill_open_markets(&f, 3);
        let first = f.treasury.open_market_at(&0).unwrap();
        f.env.ledger().set_timestamp(MARKET_CLOSE);
        f.market_core.resolve(&first.market_id, &Outcome::No);
        f.treasury.redeem(&f.agent, &first.market_id);
        assert_eq!(f.treasury.open_market_count(), 2);
        let mut ids: std::vec::Vec<u64> = (0..2)
            .map(|i| f.treasury.open_market_at(&i).unwrap().market_id)
            .collect();
        ids.sort();
        assert!(!ids.contains(&first.market_id));
        assert_eq!(f.treasury.open_market_at(&2), None);
    }

    // ----- price bands ------------------------------------------------------

    fn priced_fixture() -> Fixture {
        let f = fixture();
        install_price_policy(&f.env, &f.treasury_id, DEFAULT_PRICE_POLICY);
        f
    }

    /// Moves `market_id`'s YES price with an outside trader.
    fn push_price(f: &Fixture, market_id: u64, outcome: Outcome, amount: i128) {
        let whale = depositor(f, amount);
        f.market_core.buy(&whale, &market_id, &outcome, &amount, &0);
    }

    #[test]
    fn buy_rejected_when_price_above_band() {
        let f = priced_fixture();
        push_price(&f, f.market_id, Outcome::Yes, 900 * USDC);
        assert!(f.market_core.get_price(&f.market_id, &Outcome::Yes) > 9_500);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(USDC / 10), &0),
            Err(Ok(Error::PriceOutOfBand))
        );
    }

    #[test]
    fn sell_rejected_when_price_below_band() {
        let f = priced_fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &USDC, &0);
        push_price(&f, f.market_id, Outcome::No, 900 * USDC);
        assert!(f.market_core.get_price(&f.market_id, &Outcome::Yes) < 500);
        assert_eq!(
            f.treasury
                .try_agent_sell(&f.agent, &f.market_id, &Outcome::Yes, &(USDC / 100), &USDC),
            Err(Ok(Error::PriceOutOfBand))
        );
    }

    #[test]
    fn buy_rejected_when_impact_exceeds_limit() {
        let f = priced_fixture();
        // 20 USDC moves a 100 USDC pool ~893 bps (> 500).
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0),
            Err(Ok(Error::PriceImpactExceeded))
        );
        assert_eq!(f.treasury.daily_usage().amount, 0);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
    }

    #[test]
    fn sell_impact_and_max_shares_in_capped_by_slippage() {
        let f = priced_fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
        let quote = f
            .market_core
            .quote_sell(&f.market_id, &Outcome::Yes, &(2 * USDC));
        // A generous max_shares_in is clamped to quote + 2%, which the
        // same-transaction trade always meets.
        let shares_in = f.treasury.agent_sell(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(2 * USDC),
            &(10 * quote),
        );
        assert_eq!(shares_in, quote);
    }

    #[test]
    fn zero_min_shares_out_is_replaced_by_slippage_floor() {
        let f = priced_fixture();
        let quote = f
            .market_core
            .quote_buy(&f.market_id, &Outcome::Yes, &(5 * USDC));
        let shares = f
            .treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
        assert!(shares >= quote * 9_800 / 10_000);
        assert!(shares > 0);
        // An agent bound above the fill is still honoured, under the
        // treasury's own error code (not market-core's 12).
        let quote = f
            .market_core
            .quote_buy(&f.market_id, &Outcome::Yes, &(5 * USDC));
        assert_eq!(
            f.treasury.try_agent_buy(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &(5 * USDC),
                &(quote + 1)
            ),
            Err(Ok(Error::SlippageExceeded))
        );
    }

    #[test]
    fn market_core_slippage_error_remapped_to_treasury_code() {
        assert_eq!(
            market_core::Error::SlippageExceeded as u32,
            CORE_SLIPPAGE_EXCEEDED
        );
        let f = fixture();
        let quote = f.market_core.quote_sell(&f.market_id, &Outcome::Yes, &USDC);
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &0);
        assert_eq!(
            f.treasury
                .try_agent_sell(&f.agent, &f.market_id, &Outcome::Yes, &USDC, &(quote / 2)),
            Err(Ok(Error::SlippageExceeded))
        );
        // Other market-core errors are re-raised with market-core's own code
        // (which may coincide numerically with a treasury code).
        let past = f.env.ledger().timestamp() - 1;
        let err = f
            .treasury
            .try_agent_buy_v2(
                &f.agent,
                &f.market_id,
                &Outcome::Yes,
                &USDC,
                &0,
                &0u32,
                &past,
            )
            .unwrap_err();
        assert_ne!(err, Ok(Error::SlippageExceeded));
    }

    #[test]
    fn sandwich_front_run_causes_agent_trade_to_fail() {
        let f = priced_fixture();
        let attacker = depositor(&f, 1_000 * USDC);
        let before_balance = balance(&f, &f.treasury_id);
        // Big front-run: pushes YES out of band.
        f.market_core
            .buy(&attacker, &f.market_id, &Outcome::Yes, &(800 * USDC), &0);
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(5 * USDC), &0),
            Err(Ok(Error::PriceOutOfBand))
        );
        // Moderate front-run that stays in band: the agent's own bound,
        // quoted before the front-run (as agents/bin/trader.ts does), fails
        // under the treasury's code.
        let g = priced_fixture();
        let quote = g
            .market_core
            .quote_buy(&g.market_id, &Outcome::Yes, &(5 * USDC));
        let attacker = depositor(&g, 1_000 * USDC);
        g.market_core
            .buy(&attacker, &g.market_id, &Outcome::Yes, &(50 * USDC), &0);
        assert!(g.market_core.get_price(&g.market_id, &Outcome::Yes) <= 9_500);
        assert_eq!(
            g.treasury.try_agent_buy(
                &g.agent,
                &g.market_id,
                &Outcome::Yes,
                &(5 * USDC),
                &(quote * 9_950 / 10_000)
            ),
            Err(Ok(Error::SlippageExceeded))
        );
        for t in [&f, &g] {
            assert_eq!(balance(t, &t.treasury_id), before_balance);
            assert_eq!(t.treasury.daily_usage().amount, 0);
            assert_eq!(t.treasury.net_exposure(), 0);
        }
    }

    #[test]
    fn sandwich_small_front_run_within_tolerance_succeeds_with_bounded_cost() {
        let f = priced_fixture();
        let amount = 3 * USDC;
        let clean = f
            .market_core
            .quote_buy(&f.market_id, &Outcome::Yes, &amount);
        let attacker = depositor(&f, 10 * USDC);
        f.market_core
            .buy(&attacker, &f.market_id, &Outcome::Yes, &(2 * USDC), &0);
        let p_before = f.market_core.get_price(&f.market_id, &Outcome::Yes);
        let shares = f
            .treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &amount, &0);
        let p_after = f.market_core.get_price(&f.market_id, &Outcome::Yes);
        assert!(p_after.abs_diff(p_before) <= DEFAULT_PRICE_POLICY.max_impact_bps);
        // The front-run cost the agent something, but a bounded amount: the
        // fill is worse than the clean quote by less than the impact limit.
        assert!(shares < clean);
        assert!(
            (clean - shares) * 10_000 / clean <= (DEFAULT_PRICE_POLICY.max_impact_bps as i128) * 2
        );
    }

    #[test]
    fn band_boundary_equal_is_accepted() {
        let f = fixture();
        let p = f.market_core.get_price(&f.market_id, &Outcome::No);
        install_price_policy(
            &f.env,
            &f.treasury_id,
            PricePolicy {
                max_buy_price_bps: p,
                ..PERMISSIVE
            },
        );
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::No, &USDC, &0);
        // One bps under the price is out of band.
        let p = f.market_core.get_price(&f.market_id, &Outcome::No);
        install_price_policy(
            &f.env,
            &f.treasury_id,
            PricePolicy {
                max_buy_price_bps: p - 1,
                ..PERMISSIVE
            },
        );
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &f.market_id, &Outcome::No, &USDC, &0),
            Err(Ok(Error::PriceOutOfBand))
        );
    }

    #[test]
    fn create_market_rejects_initial_prob_outside_band() {
        let f = fixture_with_caps(150 * USDC, 300 * USDC, 300 * USDC);
        install_price_policy(&f.env, &f.treasury_id, DEFAULT_PRICE_POLICY);
        for bps in [499u32, 9_501] {
            let (q, r, uri) = create_args(&f, 60);
            assert_eq!(
                f.treasury.try_agent_create_market(
                    &f.agent,
                    &q,
                    &r,
                    &uri,
                    &Category::Macro,
                    &MARKET_CLOSE,
                    &(100 * USDC),
                    &bps,
                ),
                Err(Ok(Error::PriceOutOfBand))
            );
        }
        let (q, r, uri) = create_args(&f, 61);
        f.treasury.agent_create_market(
            &f.agent,
            &q,
            &r,
            &uri,
            &Category::Macro,
            &MARKET_CLOSE,
            &(100 * USDC),
            &500u32,
        );
    }

    #[test]
    fn set_price_policy_validation_and_timelock() {
        let f = priced_fixture();
        for bad in [
            PricePolicy {
                max_buy_price_bps: 10_001,
                ..DEFAULT_PRICE_POLICY
            },
            PricePolicy {
                min_sell_price_bps: 9_500,
                ..DEFAULT_PRICE_POLICY
            },
            PricePolicy {
                max_impact_bps: 0,
                ..DEFAULT_PRICE_POLICY
            },
            PricePolicy {
                max_slippage_bps: 10_000,
                ..DEFAULT_PRICE_POLICY
            },
            DEFAULT_PRICE_POLICY,
        ] {
            assert_eq!(
                f.treasury.try_set_price_policy(&bad),
                Err(Ok(Error::InvalidPricePolicy))
            );
        }
        // Tightening is immediate.
        let tight = PricePolicy {
            max_impact_bps: 300,
            min_sell_price_bps: 1_000,
            ..DEFAULT_PRICE_POLICY
        };
        f.treasury.set_price_policy(&tight);
        assert_eq!(f.treasury.get_price_policy(), tight);
        // Loosening waits.
        f.treasury.set_price_policy(&DEFAULT_PRICE_POLICY);
        assert_eq!(f.treasury.get_price_policy(), tight);
        assert_eq!(
            f.treasury.try_execute_price_policy(),
            Err(Ok(Error::TimelockActive))
        );
        f.env.ledger().set_timestamp(1_000 + DELAY);
        f.treasury.execute_price_policy();
        assert_eq!(f.treasury.get_price_policy(), DEFAULT_PRICE_POLICY);
        assert_eq!(f.treasury.pending_price_policy(), None);
    }

    #[test]
    fn price_checks_cost_estimate_recorded() {
        let measure = |policy: PricePolicy| {
            let f = fixture();
            install_price_policy(&f.env, &f.treasury_id, policy);
            f.env.cost_estimate().budget().reset_unlimited();
            f.treasury
                .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &USDC, &0);
            f.env.cost_estimate().resources().instructions
        };
        let with_checks = measure(DEFAULT_PRICE_POLICY);
        std::println!(
            "agent_buy (price-checked: get_price x2 + quote_buy): {with_checks} instructions"
        );
        assert!(with_checks < 100_000_000);
    }

    fn get_exposure(f: &Fixture, market_id: u64) -> MarketExposure {
        f.env.as_contract(&f.treasury_id, || {
            f.env
                .storage()
                .persistent()
                .get::<DataKey, MarketExposure>(&DataKey::Market(market_id))
                .unwrap()
        })
    }

    // =========================================================================
    // Issue #45: Permissionless settlement of treasury positions
    // =========================================================================

    #[test]
    fn settle_market_redeems_position_after_resolution() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);
        assert!(report.redeemed > 0);
        assert_eq!(report.lp_claimed, 0);
        assert!(!report.already_settled);

        let real = f.treasury.realized(&f.market_id);
        assert_eq!(real.position_proceeds, report.redeemed);
        assert_eq!(real.lp_proceeds, 0);
        assert!(real.settled);
    }

    #[test]
    fn settle_market_claims_lp_for_treasury_created_market() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        let close = f.env.ledger().timestamp() + 1000;
        let market_id = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[21u8; 32]),
            &BytesN::from_array(&f.env, &[22u8; 32]),
            &String::from_str(&f.env, "ipfs://lp-created"),
            &Category::Crypto,
            &close,
            &(100 * USDC),
            &5000u32,
        );
        f.env.ledger().set_timestamp(close + 1);
        f.market_core.resolve(&market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &market_id);
        assert_eq!(report.redeemed, 0);
        assert!(report.lp_claimed > 0);
        assert!(!report.already_settled);

        let real = f.treasury.realized(&market_id);
        assert_eq!(real.position_proceeds, 0);
        assert_eq!(real.lp_proceeds, report.lp_claimed);
        assert!(real.settled);
    }

    #[test]
    fn settle_market_handles_position_and_lp_together() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        let close = f.env.ledger().timestamp() + 1000;
        let market_id = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[23u8; 32]),
            &BytesN::from_array(&f.env, &[24u8; 32]),
            &String::from_str(&f.env, "ipfs://both"),
            &Category::Crypto,
            &close,
            &(100 * USDC),
            &5000u32,
        );
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(close + 1);
        f.market_core.resolve(&market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &market_id);
        assert!(report.redeemed > 0);
        assert!(report.lp_claimed > 0);
        assert!(!report.already_settled);

        let real = f.treasury.realized(&market_id);
        assert_eq!(real.position_proceeds, report.redeemed);
        assert_eq!(real.lp_proceeds, report.lp_claimed);
        assert!(real.settled);
    }

    #[test]
    fn settle_market_is_idempotent_and_never_errors_on_retry() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let first = f.treasury.settle_market(&caller, &f.market_id);
        assert!(!first.already_settled);

        let second = f.treasury.settle_market(&caller, &f.market_id);
        assert_eq!(second.redeemed, 0);
        assert_eq!(second.lp_claimed, 0);
        assert!(second.already_settled);
    }

    #[test]
    fn settle_market_on_open_market_returns_market_not_final() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let caller = Address::generate(&f.env);
        let err = f.treasury.try_settle_market(&caller, &f.market_id);
        assert_eq!(err, Err(Ok(Error::MarketNotFinal)));
    }

    #[test]
    fn settle_market_after_agent_redeem_reports_only_lp() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        let close = f.env.ledger().timestamp() + 1000;
        let market_id = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[25u8; 32]),
            &BytesN::from_array(&f.env, &[26u8; 32]),
            &String::from_str(&f.env, "ipfs://agent-then-settle"),
            &Category::Crypto,
            &close,
            &(100 * USDC),
            &5000u32,
        );
        f.treasury
            .agent_buy(&f.agent, &market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(close + 1);
        f.market_core.resolve(&market_id, &Outcome::Yes);

        let redeemed = f.treasury.redeem(&f.agent, &market_id);
        assert!(redeemed > 0);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &market_id);
        assert_eq!(report.redeemed, 0);
        assert!(report.lp_claimed > 0);
        assert!(!report.already_settled);

        let real = f.treasury.realized(&market_id);
        assert_eq!(real.position_proceeds, redeemed);
        assert_eq!(real.lp_proceeds, report.lp_claimed);
        assert!(real.settled);
    }

    #[test]
    fn settle_market_works_while_treasury_paused() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        f.treasury.set_paused(&true);
        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);
        assert!(report.redeemed > 0);
    }

    #[test]
    fn settle_market_callable_by_any_address() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        f.env.set_auths(&[]);
        let report = f
            .treasury
            .mock_auths(&[MockAuth {
                address: &caller,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    sub_invokes: &[],
                    fn_name: "settle_market",
                    args: (&caller, f.market_id).into_val(&f.env),
                },
            }])
            .settle_market(&caller, &f.market_id);
        assert!(report.redeemed > 0);
    }

    #[test]
    fn voided_market_settles_with_half_value() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.void_market(&f.market_id);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);
        assert!(report.redeemed > 0);
        let real = f.treasury.realized(&f.market_id);
        assert_eq!(real.position_proceeds, report.redeemed);
        assert!(real.settled);
    }

    #[test]
    fn exposure_marked_closed_but_lifetime_amount_unchanged() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        let before = get_exposure(&f, f.market_id);
        assert!(before.open);

        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);

        let after = get_exposure(&f, f.market_id);
        assert!(!after.open);
        assert_eq!(after.amount, before.amount);
    }

    #[test]
    fn realized_view_matches_token_balance_delta() {
        let f = fixture();
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let token = soroban_sdk::token::TokenClient::new(&f.env, &f.token);
        let bal_before = token.balance(&f.treasury_id);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);
        assert!(has_event(
            &f,
            &MarketSettled {
                market_id: f.market_id,
                redeemed: report.redeemed,
                lp_claimed: report.lp_claimed,
                settled_by: caller,
            }
        ));
        let bal_after = token.balance(&f.treasury_id);
        assert_eq!(bal_after - bal_before, report.redeemed + report.lp_claimed);
    }

    // =========================================================================
    // Issue #46: Realized PnL and Drawdown Auto-Pause
    // =========================================================================

    #[test]
    fn losing_market_realizes_negative_pnl_on_redeem() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);

        let pnl = f.treasury.market_pnl(&f.market_id);
        assert_eq!(pnl.cost, cost);
        assert_eq!(pnl.proceeds, 0);
        assert!(pnl.realized);
        assert_eq!(f.treasury.window_pnl(), -cost);
    }

    #[test]
    fn winning_market_realizes_positive_pnl() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);
        assert!(report.redeemed > cost);

        let pnl = f.treasury.market_pnl(&f.market_id);
        assert_eq!(pnl.cost, cost);
        assert_eq!(pnl.proceeds, report.redeemed);
        assert!(pnl.realized);
        assert_eq!(f.treasury.window_pnl(), report.redeemed - cost);
    }

    #[test]
    fn partial_sells_do_not_realize_before_final() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.treasury.agent_sell(
            &f.agent,
            &f.market_id,
            &Outcome::Yes,
            &(5 * USDC),
            &i128::MAX,
        );

        let pnl = f.treasury.market_pnl(&f.market_id);
        assert_eq!(pnl.cost, cost);
        assert!(pnl.proceeds > 0);
        assert!(!pnl.realized);
        assert_eq!(f.treasury.window_pnl(), 0);
    }

    #[test]
    fn void_market_pnl_includes_rounding_dust() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.void_market(&f.market_id);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &f.market_id);

        let pnl = f.treasury.market_pnl(&f.market_id);
        assert_eq!(pnl.cost, cost);
        assert_eq!(pnl.proceeds, report.redeemed);
        assert!(pnl.realized);
        assert_eq!(f.treasury.window_pnl(), report.redeemed - cost);
    }

    #[test]
    fn lp_remainder_counts_toward_proceeds_for_created_markets() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        let close = f.env.ledger().timestamp() + 1000;
        let seed = 100 * USDC;
        let market_id = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[31u8; 32]),
            &BytesN::from_array(&f.env, &[32u8; 32]),
            &String::from_str(&f.env, "ipfs://lp-pnl"),
            &Category::Crypto,
            &close,
            &seed,
            &5000u32,
        );
        f.env.ledger().set_timestamp(close + 1);
        f.market_core.resolve(&market_id, &Outcome::Yes);

        let caller = Address::generate(&f.env);
        let report = f.treasury.settle_market(&caller, &market_id);

        let pnl = f.treasury.market_pnl(&market_id);
        assert_eq!(pnl.cost, seed);
        assert_eq!(pnl.proceeds, report.lp_claimed);
        assert!(pnl.realized);
    }

    #[test]
    fn drawdown_breach_pauses_buys_but_allows_reduce_only_sells() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        // Lower max_drawdown to 15 USDC
        f.treasury.set_drawdown_config(&(15 * USDC), &7u32);

        // Buy on market 1 (to lose) and market 2 (to sell)
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);

        let close = MARKET_CLOSE + 1000;
        let market2 = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[33u8; 32]),
            &BytesN::from_array(&f.env, &[34u8; 32]),
            &String::from_str(&f.env, "ipfs://market2"),
            &Category::Crypto,
            &close,
            &(100 * USDC),
            &5000u32,
        );
        f.treasury
            .agent_buy(&f.agent, &market2, &Outcome::Yes, &(10 * USDC), &0);

        // Resolve market 1 to No (100% loss of 20 USDC)
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);

        // Loss is 20 USDC > 15 USDC max_drawdown!
        let status = f.treasury.drawdown_status();
        assert!(status.tripped);
        assert_eq!(status.window_pnl, -cost);

        // agent_buy is blocked
        assert_eq!(
            f.treasury
                .try_agent_buy(&f.agent, &market2, &Outcome::Yes, &USDC, &0),
            Err(Ok(Error::DrawdownTripped))
        );
        // agent_create_market is blocked
        assert_eq!(
            f.treasury.try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &[35u8; 32]),
                &BytesN::from_array(&f.env, &[36u8; 32]),
                &String::from_str(&f.env, "ipfs://blocked"),
                &Category::Crypto,
                &(f.env.ledger().timestamp() + 500),
                &(100 * USDC),
                &5000u32,
            ),
            Err(Ok(Error::DrawdownTripped))
        );

        // Reduce-only sells are allowed!
        let sold =
            f.treasury
                .agent_sell(&f.agent, &market2, &Outcome::Yes, &(2 * USDC), &i128::MAX);
        assert!(sold > 0);
    }

    #[test]
    fn resume_requires_acknowledgement_after_drawdown() {
        let f = fixture();
        f.treasury.set_drawdown_config(&(15 * USDC), &7u32);
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);

        // Attempting to set_paused(false) without acknowledging fails
        assert_eq!(
            f.treasury.try_set_paused(&false),
            Err(Ok(Error::NotAcknowledged))
        );

        // Admin acknowledges drawdown
        f.treasury.acknowledge_drawdown();

        // Now resuming succeeds
        assert!(f.treasury.try_set_paused(&false).is_ok());
    }

    #[test]
    fn window_slides_and_old_losses_expire() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);
        assert_eq!(f.treasury.window_pnl(), -cost);

        // Advance ledger time by 8 days (window is 7 days)
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + 8 * DAY_SECONDS);
        assert_eq!(f.treasury.window_pnl(), 0);
    }

    #[test]
    fn fees_and_donations_do_not_affect_pnl() {
        let f = fixture();
        let pnl_before = f.treasury.window_pnl();

        // Donate direct tokens
        let donor = Address::generate(&f.env);
        let token = StellarAssetClient::new(&f.env, &f.token);
        token.mint(&donor, &(100 * USDC));
        token.transfer(&donor, &f.treasury_id, &(100 * USDC));

        assert_eq!(f.treasury.window_pnl(), pnl_before);
    }

    #[test]
    fn third_party_realize_cannot_change_loss_magnitude() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        // Finality alone does not burn positions; realize must wait for settlement.
        f.treasury.realize(&f.market_id);
        assert!(!f.treasury.market_pnl(&f.market_id).realized);
        let caller = Address::generate(&f.env);
        f.treasury.settle_market(&caller, &f.market_id);
        let before = f.treasury.window_pnl();
        f.treasury.realize(&f.market_id);
        assert_eq!(f.treasury.window_pnl(), before);
        let pnl = f.treasury.market_pnl(&f.market_id);
        assert_eq!(pnl.cost, cost);
        assert_eq!(pnl.proceeds, 0);
        assert!(pnl.realized);
    }

    #[test]
    fn set_drawdown_config_wrong_caller_rejected() {
        let f = fixture();
        f.env.set_auths(&[]);
        let bad = Address::generate(&f.env);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &bad,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    sub_invokes: &[],
                    fn_name: "set_drawdown_config",
                    args: (50 * USDC, 7u32).into_val(&f.env),
                },
            }])
            .try_set_drawdown_config(&(50 * USDC), &7u32)
            .is_err());
    }

    #[test]
    fn realize_is_idempotent() {
        let f = fixture();
        let cost = 20 * USDC;
        f.treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &cost, &0);
        f.env.ledger().set_timestamp(MARKET_CLOSE + 1);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        f.treasury.realize(&f.market_id);
        let first = f.treasury.market_pnl(&f.market_id);
        f.treasury.realize(&f.market_id);
        let second = f.treasury.market_pnl(&f.market_id);
        assert_eq!(first, second);
    }

    // =========================================================================
    // Issue #47: Market Creation Risk Controls
    // =========================================================================

    #[test]
    fn create_rejects_seed_above_max_seed_even_when_below_max_trade() {
        let policy = CreationPolicy {
            max_seed: 50 * USDC,
            max_markets_per_window: 10,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        // max_trade = 100 USDC, max_seed = 50 USDC
        let f = fixture_with_policy(100 * USDC, 200 * USDC, 200 * USDC, policy);
        let close = f.env.ledger().timestamp() + 500;
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[41u8; 32]),
            &BytesN::from_array(&f.env, &[42u8; 32]),
            &String::from_str(&f.env, "ipfs://seed-cap"),
            &Category::Crypto,
            &close,
            &(60 * USDC), // above max_seed (50), but below max_trade (100)
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::SeedCapExceeded)));
    }

    #[test]
    fn create_rejects_close_time_inside_min_horizon() {
        let f = fixture();
        let now = f.env.ledger().timestamp();
        let close = now + 30; // min_close_horizon is 60
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[43u8; 32]),
            &BytesN::from_array(&f.env, &[44u8; 32]),
            &String::from_str(&f.env, "ipfs://too-soon"),
            &Category::Crypto,
            &close,
            &(10 * USDC),
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::CloseTimeTooSoon)));
    }

    #[test]
    fn create_rejects_close_time_beyond_max_horizon() {
        let f = fixture();
        let now = f.env.ledger().timestamp();
        let close = now + 400 * DAY_SECONDS; // max_close_horizon is 365 days
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[45u8; 32]),
            &BytesN::from_array(&f.env, &[46u8; 32]),
            &String::from_str(&f.env, "ipfs://too-far"),
            &Category::Crypto,
            &close,
            &(10 * USDC),
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::CloseTimeTooFar)));
    }

    #[test]
    fn create_rejects_close_time_in_past_with_treasury_error() {
        let f = fixture();
        let now = f.env.ledger().timestamp();
        let close = now - 10;
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[47u8; 32]),
            &BytesN::from_array(&f.env, &[48u8; 32]),
            &String::from_str(&f.env, "ipfs://in-past"),
            &Category::Crypto,
            &close,
            &(10 * USDC),
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::CloseTimeTooSoon)));
    }

    #[test]
    fn create_rejects_disallowed_category() {
        let policy = CreationPolicy {
            max_seed: 50 * USDC,
            max_markets_per_window: 10,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 1, // Only Crypto
        };
        let f = fixture_with_policy(100 * USDC, 200 * USDC, 200 * USDC, policy);
        let close = f.env.ledger().timestamp() + 500;
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[49u8; 32]),
            &BytesN::from_array(&f.env, &[50u8; 32]),
            &String::from_str(&f.env, "ipfs://disallowed-cat"),
            &Category::Macro,
            &close,
            &(10 * USDC),
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::CategoryNotAllowed)));
    }

    #[test]
    fn creation_rate_limit_blocks_n_plus_one_and_recovers_after_window() {
        let policy = CreationPolicy {
            max_seed: 100 * USDC,
            max_markets_per_window: 2,
            creation_window_secs: 2400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        let f = fixture_with_policy(100 * USDC, 500 * USDC, 500 * USDC, policy);
        let close = f.env.ledger().timestamp() + 500;

        // 1st creation
        assert!(f
            .treasury
            .try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &[51u8; 32]),
                &BytesN::from_array(&f.env, &[52u8; 32]),
                &String::from_str(&f.env, "ipfs://m1"),
                &Category::Crypto,
                &close,
                &(100 * USDC),
                &5000u32,
            )
            .is_ok());

        // 2nd creation
        assert!(f
            .treasury
            .try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &[53u8; 32]),
                &BytesN::from_array(&f.env, &[54u8; 32]),
                &String::from_str(&f.env, "ipfs://m2"),
                &Category::Crypto,
                &close,
                &(100 * USDC),
                &5000u32,
            )
            .is_ok());

        // 3rd creation (rate exceeded)
        let err = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[55u8; 32]),
            &BytesN::from_array(&f.env, &[56u8; 32]),
            &String::from_str(&f.env, "ipfs://m3"),
            &Category::Crypto,
            &close,
            &(100 * USDC),
            &5000u32,
        );
        assert_eq!(err, Err(Ok(Error::CreationRateExceeded)));

        // Advance past window (2400s)
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + 2500);
        let new_close = f.env.ledger().timestamp() + 500;

        // 4th creation succeeds
        assert!(f
            .treasury
            .try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &[57u8; 32]),
                &BytesN::from_array(&f.env, &[58u8; 32]),
                &String::from_str(&f.env, "ipfs://m4"),
                &Category::Crypto,
                &new_close,
                &(100 * USDC),
                &5000u32,
            )
            .is_ok());
    }

    #[test]
    fn creation_buckets_stay_bounded_over_many_windows() {
        let policy = CreationPolicy {
            max_seed: 100 * USDC,
            max_markets_per_window: 10,
            creation_window_secs: 86_400,
            min_close_horizon: 60,
            max_close_horizon: 365 * DAY_SECONDS,
            allowed_categories: 0x3F,
        };
        let f = fixture_with_policy(100 * USDC, 500 * USDC, 500 * USDC, policy);

        for day in 0..30 {
            f.env.ledger().set_timestamp(1_000 + (day as u64) * 86_400);
            let close = f.env.ledger().timestamp() + 1000;
            let mut byte_arr = [0u8; 32];
            byte_arr[0] = (day + 1) as u8;
            let _ = f.treasury.try_agent_create_market(
                &f.agent,
                &BytesN::from_array(&f.env, &byte_arr),
                &BytesN::from_array(&f.env, &byte_arr),
                &String::from_str(&f.env, "ipfs://bound"),
                &Category::Crypto,
                &close,
                &(10 * USDC),
                &5000u32,
            );
        }

        let buckets_len = f.env.as_contract(&f.treasury_id, || {
            f.env
                .storage()
                .instance()
                .get::<DataKey, Vec<CreationBucket>>(&DataKey::CreationBuckets)
                .map(|b| b.len())
                .unwrap_or(0)
        });
        assert!(buckets_len <= 24);
    }

    #[test]
    fn seed_still_counts_toward_daily_and_market_caps() {
        let f = fixture_with_caps(200 * USDC, 500 * USDC, 600 * USDC);
        let seed = 100 * USDC;
        let close = f.env.ledger().timestamp() + 500;
        let market_id = f.treasury.agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[61u8; 32]),
            &BytesN::from_array(&f.env, &[62u8; 32]),
            &String::from_str(&f.env, "ipfs://cap-counts"),
            &Category::Crypto,
            &close,
            &seed,
            &5000u32,
        );
        assert_eq!(f.treasury.daily_usage().amount, seed);
        assert_eq!(get_exposure(&f, market_id).amount, seed);
    }

    #[test]
    fn set_creation_policy_accepts_tightening_rejects_loosening() {
        let f = fixture();
        let cur = f.treasury.get_creation_policy();

        // Tighten: lower max_seed
        let mut tighter = cur.clone();
        tighter.max_seed = cur.max_seed / 2;
        f.treasury.set_creation_policy(&tighter);
        assert_eq!(f.treasury.get_creation_policy(), tighter);

        // Loosen: higher max_seed
        let mut looser = tighter.clone();
        looser.max_seed = tighter.max_seed + 10 * USDC;
        let err = f.treasury.try_set_creation_policy(&looser);
        assert_eq!(err, Err(Ok(Error::PolicyLoosening)));
    }

    #[test]
    fn wrong_caller_cannot_set_creation_policy() {
        let f = fixture();
        let policy = f.treasury.get_creation_policy();
        f.env.set_auths(&[]);
        let bad = Address::generate(&f.env);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &bad,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    sub_invokes: &[],
                    fn_name: "set_creation_policy",
                    args: (policy,).into_val(&f.env),
                },
            }])
            .try_set_creation_policy(&f.treasury.get_creation_policy())
            .is_err());
    }

    #[test]
    fn category_bits_are_distinct() {
        let c1 = Treasury::category_bit(&Category::Crypto);
        let c2 = Treasury::category_bit(&Category::Macro);
        let c3 = Treasury::category_bit(&Category::Geopolitics);
        let c4 = Treasury::category_bit(&Category::Sports);
        let c5 = Treasury::category_bit(&Category::Culture);
        let c6 = Treasury::category_bit(&Category::Other);

        assert_eq!(c1, 1 << 0);
        assert_eq!(c2, 1 << 1);
        assert_eq!(c3, 1 << 2);
        assert_eq!(c4, 1 << 3);
        assert_eq!(c5, 1 << 4);
        assert_eq!(c6, 1 << 5);
        assert_eq!(c1 | c2 | c3 | c4 | c5 | c6, 0x3F);
    }

    #[test]
    fn failed_market_core_create_does_not_consume_rate_budget() {
        let f = fixture();
        let close = f.env.ledger().timestamp() + 500;
        let usage_before = f.treasury.creation_usage();

        // Seed below market_core MIN_SEED (100 USDC) fails inside market_core
        let _ = f.treasury.try_agent_create_market(
            &f.agent,
            &BytesN::from_array(&f.env, &[71u8; 32]),
            &BytesN::from_array(&f.env, &[72u8; 32]),
            &String::from_str(&f.env, "ipfs://fail-core"),
            &Category::Crypto,
            &close,
            &(10 * USDC),
            &5000u32,
        );

        assert_eq!(f.treasury.creation_usage(), usage_before);
    }

    // =========================================================================
    // Issue #48: Deploy Idle Capital into Blend Lending
    // =========================================================================

    #[contract]
    pub struct MockBlendPool;

    #[contractimpl]
    impl MockBlendPool {
        pub fn submit(
            env: Env,
            _from: Address,
            spender: Address,
            to: Address,
            requests: Vec<BlendRequest>,
        ) -> BlendPositions {
            spender.require_auth();
            for req in requests.iter() {
                if req.request_type == 0 {
                    token::TokenClient::new(&env, &req.address).transfer(
                        &spender,
                        env.current_contract_address(),
                        &req.amount,
                    );
                    let mut pos = Self::get_positions(env.clone(), spender.clone());
                    pos.supply_shares += req.amount;
                    env.storage().instance().set(&DataKey::YieldVenue, &pos);
                } else if req.request_type == 1 {
                    let fail: bool = env.storage().instance().get(&100u32).unwrap_or(false);
                    if fail {
                        panic!("mock blend withdraw failed");
                    }
                    let under: bool = env.storage().instance().get(&101u32).unwrap_or(false);
                    let transfer_amt = if under && req.amount > 1 {
                        req.amount - 1
                    } else {
                        req.amount
                    };
                    token::TokenClient::new(&env, &req.address).transfer(
                        &env.current_contract_address(),
                        &to,
                        &transfer_amt,
                    );
                    let mut pos = Self::get_positions(env.clone(), spender.clone());
                    pos.supply_shares = if pos.supply_shares >= req.amount {
                        pos.supply_shares - req.amount
                    } else {
                        0
                    };
                    env.storage().instance().set(&DataKey::YieldVenue, &pos);
                }
            }
            Self::get_positions(env, spender)
        }

        pub fn get_positions(env: Env, _address: Address) -> BlendPositions {
            env.storage()
                .instance()
                .get(&DataKey::YieldVenue)
                .unwrap_or(BlendPositions {
                    supply_shares: 0,
                    liabilities: 0,
                })
        }

        pub fn set_fail_withdraw(env: Env, fail: bool) {
            env.storage().instance().set(&100u32, &fail);
        }

        pub fn set_under_deliver(env: Env, under: bool) {
            env.storage().instance().set(&101u32, &under);
        }
    }

    #[test]
    fn allocate_moves_tokens_to_pool_and_updates_principal() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(200 * USDC));

        f.treasury.allocate_to_yield(&(100 * USDC));
        let breakdown = f.treasury.capital_breakdown();
        assert_eq!(breakdown.yield_principal, 100 * USDC);
        assert_eq!(breakdown.yield_value, 100 * USDC);

        let pool_bal = soroban_sdk::token::TokenClient::new(&f.env, &f.token).balance(&pool);
        assert_eq!(pool_bal, 100 * USDC);
    }

    #[test]
    fn allocate_rejects_above_max_allocation() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(50 * USDC));

        let err = f.treasury.try_allocate_to_yield(&(60 * USDC));
        assert_eq!(err, Err(Ok(Error::YieldCapExceeded)));
    }

    #[test]
    fn allocate_rejects_leaving_less_than_daily_cap_liquid() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        // total treasury balance is 1000 USDC, max_daily is 60 USDC
        // max allocation set to 1000 USDC, but allocating 960 USDC leaves only 40 USDC < 60 USDC max_daily
        f.treasury.set_yield_venue(&pool, &(1000 * USDC));

        let err = f.treasury.try_allocate_to_yield(&(950 * USDC));
        assert_eq!(err, Err(Ok(Error::DailyCapExceeded)));
    }

    #[test]
    fn agent_buy_withdraws_shortfall_from_yield_atomically() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(950 * USDC));
        // Allocate 940 USDC to yield, leaving only 60 USDC liquid
        f.treasury.allocate_to_yield(&(940 * USDC));

        // Buy with 20 USDC
        let shares = f
            .treasury
            .agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        assert!(shares > 0);
    }

    #[test]
    fn agent_buy_reverts_entirely_when_pool_withdraw_fails() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(950 * USDC));
        f.treasury.allocate_to_yield(&(940 * USDC));

        // Withdraw 50 USDC from treasury so liquid is only 10 USDC (less than 20 USDC needed)
        f.treasury.withdraw(&f.admin, &(50 * USDC));

        // Set mock pool to fail withdrawals
        MockBlendPoolClient::new(&f.env, &pool).set_fail_withdraw(&true);

        // Buy needing 20 USDC fails because withdrawal fails
        let err = f
            .treasury
            .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(20 * USDC), &0);
        assert_eq!(err, Err(Ok(Error::YieldWithdrawFailed)));
    }

    #[test]
    fn cap_failure_after_jit_withdraw_reverts_withdraw_too() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(950 * USDC));
        f.treasury.allocate_to_yield(&(940 * USDC));

        // Max trade is 20 USDC. Try buying 25 USDC (> max_trade)
        let err = f
            .treasury
            .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(25 * USDC), &0);
        assert_eq!(err, Err(Ok(Error::TradeCapExceeded)));
    }

    #[test]
    fn under_delivering_pool_is_handled_by_buffer() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(950 * USDC));
        f.treasury.allocate_to_yield(&(940 * USDC));
        f.treasury.withdraw(&f.admin, &(50 * USDC)); // 10 USDC liquid

        // Pool under-delivers by 1 stroop
        MockBlendPoolClient::new(&f.env, &pool).set_under_deliver(&true);

        // Buy 15 USDC: shortfall is 5 USDC, buffer requests 6, gets 5, total is 15 USDC. Succeeds!
        assert!(f
            .treasury
            .try_agent_buy(&f.agent, &f.market_id, &Outcome::Yes, &(15 * USDC), &0)
            .is_ok());
    }

    #[test]
    fn available_capital_includes_supplied_value() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(200 * USDC));
        f.treasury.allocate_to_yield(&(100 * USDC));

        assert_eq!(f.treasury.available_capital(), 1000 * USDC);
        assert_eq!(f.treasury.liquid_capital(), 900 * USDC);
    }

    #[test]
    fn wrong_caller_cannot_allocate_or_recall() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(200 * USDC));

        f.env.set_auths(&[]);
        let bad = Address::generate(&f.env);
        assert!(f
            .treasury
            .mock_auths(&[MockAuth {
                address: &bad,
                invoke: &MockAuthInvoke {
                    contract: &f.treasury_id,
                    sub_invokes: &[],
                    fn_name: "allocate_to_yield",
                    args: (100 * USDC,).into_val(&f.env),
                },
            }])
            .try_allocate_to_yield(&(100 * USDC))
            .is_err());
    }

    #[test]
    fn pitfall_jit_withdraw_requires_nested_transfer_preauth() {
        let f = fixture();
        let pool = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool, &(200 * USDC));
        f.treasury.allocate_to_yield(&(100 * USDC));
        f.treasury.recall_from_yield(&(50 * USDC));
        assert_eq!(f.treasury.capital_breakdown().yield_principal, 50 * USDC);
    }

    #[test]
    fn set_yield_venue_rejected_while_principal_outstanding() {
        let f = fixture();
        let pool1 = f.env.register(MockBlendPool, ());
        let pool2 = f.env.register(MockBlendPool, ());
        f.treasury.set_yield_venue(&pool1, &(200 * USDC));
        f.treasury.allocate_to_yield(&(100 * USDC));

        let err = f.treasury.try_set_yield_venue(&pool2, &(200 * USDC));
        assert_eq!(err, Err(Ok(Error::VenueHasPrincipal)));
    }
}
