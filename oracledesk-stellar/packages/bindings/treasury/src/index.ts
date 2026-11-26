import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};


export interface BatchItem {
  market_id: u64;
  payout: i128;
  status: BatchStatus;
}

export type Escalation = {tag: "Guardian", values: void} | {tag: "Committee", values: readonly [Array<string>, u32]};

export type SkipReason = {tag: "NotFound", values: void} | {tag: "NotFinal", values: void} | {tag: "NothingToRedeem", values: void} | {tag: "AlreadyClaimed", values: void} | {tag: "NotCreator", values: void} | {tag: "Duplicate", values: void} | {tag: "Closed", values: void};


export interface BatchResult {
  items: Array<BatchItem>;
  total: i128;
}

export type BatchStatus = {tag: "Settled", values: void} | {tag: "Skipped", values: readonly [SkipReason]};

export type OracleAsset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


export interface PriceConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_staleness: u64;
  reflector: string;
  threshold: i128;
}


export interface WeightedKey {
  pubkey: Buffer;
  weight: u32;
}


export interface CommitteeRef {
  committee_id: u64;
  dispute_window: u64;
  max_rotation_delta: u32;
  min_epoch: u32;
}


export interface HybridConfig {
  fallback: SignerConfig;
  fallback_after: u64;
  price: PriceConfig;
}


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}

export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};


export interface ResolutionSpecV2 {
  market_core: string;
  network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}


export interface WeightedKeyConfig {
  dispute_window: u64;
  signers: Array<WeightedKey>;
  weight_threshold: u32;
}


export interface DisputableSignerConfig {
  dispute_bond: i128;
  dispute_window: u64;
  escalation: Escalation;
  escalation_timeout: u64;
  signers: Array<string>;
  threshold: u32;
}

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"InvalidConfig"},
  4: {message:"InvalidAmount"},
  5: {message:"TradeCapExceeded"},
  6: {message:"MarketCapExceeded"},
  7: {message:"DailyCapExceeded"},
  8: {message:"MarketNotOpen"},
  9: {message:"InsufficientBalance"},
  10: {message:"Paused"},
  11: {message:"NoSuccessor"},
  12: {message:"NetExposureExceeded"},
  13: {message:"AgentDailyCapExceeded"},
  14: {message:"ProposalPending"},
  15: {message:"TimelockActive"},
  16: {message:"NoPendingConfig"},
  17: {message:"LegacyCoreUnknown"},
  18: {message:"TooManyOpenMarkets"},
  19: {message:"CapitalReserved"},
  20: {message:"DepositTooSmall"},
  21: {message:"InsufficientShares"},
  22: {message:"TicketNotFound"},
  23: {message:"NothingToPay"},
  24: {message:"PriceOutOfBand"},
  25: {message:"PriceImpactExceeded"},
  26: {message:"InvalidPricePolicy"},
  27: {message:"SlippageExceeded"},
  28: {message:"NotPaused"},
  29: {message:"MarketCoreMarketNotFound"},
  30: {message:"MarketCoreNotFinal"},
  31: {message:"MarketCoreMarketNotOpen"},
  32: {message:"MarketCoreMarketClosed"},
  33: {message:"MarketCoreInsufficientLiquidity"},
  34: {message:"MarketCoreInsufficientShares"},
  35: {message:"MarketCoreAlreadyClaimed"},
  36: {message:"MarketCoreNothingToRedeem"},
  37: {message:"MarketCoreInvalidAmount"},
  38: {message:"MarketCoreOverflow"},
  39: {message:"MarketCoreSlippageExceeded"},
  40: {message:"MarketCoreCallFailed"},
  44: {message:"MarketNotFinal"},
  45: {message:"MarketCoreError"},
  46: {message:"DrawdownTripped"},
  47: {message:"InvalidDrawdownConfig"},
  48: {message:"NotAcknowledged"},
  49: {message:"SeedCapExceeded"},
  50: {message:"CreationRateExceeded"},
  51: {message:"CloseTimeTooSoon"},
  52: {message:"CloseTimeTooFar"},
  53: {message:"CategoryNotAllowed"},
  54: {message:"PolicyLoosening"},
  55: {message:"YieldDisabled"},
  56: {message:"YieldCapExceeded"},
  57: {message:"YieldWithdrawFailed"},
  58: {message:"VenueHasPrincipal"},
  /**
   * Category exposure would exceed its correlation cap (#49).
   */
  59: {message:"CategoryCapExceeded"},
  /**
   * Close-date bucket exposure would exceed its cap (#49).
   */
  60: {message:"BucketCapExceeded"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  61: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  62: {message:"PendingAdminExpired"},
  /**
   * `agent_create_market_and_reveal` was given a malformed resolution
   * envelope or a rule outside the two primary modes (#64).
   */
  63: {message:"InvalidResolution"},
  64: {message:"TraceRequired"},
  65: {message:"TraceDecisionMismatch"},
  66: {message:"TraceMismatch"},
  67: {message:"TraceAgentMismatch"},
  68: {message:"TraceFlagged"},
  69: {message:"TraceStale"},
  70: {message:"TraceConsumed"},
  71: {message:"TraceRegistryCallFailed"},
  72: {message:"TracePolicyPending"},
  73: {message:"TracePolicyNotPending"},
  74: {message:"TraceTimelockActive"},
  75: {message:"StaleMarks"},
  76: {message:"MarkBatchTooLarge"},
  83: {message:"MigrationInProgress"},
  84: {message:"MigrationNotReady"},
  85: {message:"IncompatibleSuccessor"},
  86: {message:"AlreadyMigrated"},
  /**
   * The ticket predates #277 (no `TicketMeta`) and cannot be cancelled;
   * it still drains and can be transferred.
   */
  77: {message:"TicketNotCancellable"},
  /**
   * `cancel_withdraw` before `created_at + MIN_CANCEL_DELAY`.
   */
  78: {message:"CancelTooEarly"},
  /**
   * The core was retired; it can never be current or legacy again.
   */
  79: {message:"CoreRetired"},
  /**
   * `retire_core` before `init_core_accounting` has run.
   */
  80: {message:"AccountingNotInitialized"},
  /**
   * `retire_core` while the core still has index entries or open exposure.
   */
  81: {message:"CoreNotDrained"},
  /**
   * The current market-core cannot be retired.
   */
  82: {message:"CoreIsCurrent"},
  /**
   * `KnownCores` is full; retire a drained legacy core first.
   */
  87: {message:"TooManyCores"},
  /**
   * `sweep_retired` on a core that is not retired.
   */
  88: {message:"CoreNotRetired"}
}


export interface Realized {
  lp_proceeds: i128;
  position_proceeds: i128;
  settled: boolean;
}


export interface MarketPnl {
  cost: i128;
  proceeds: i128;
  realized: boolean;
}


export interface NavDetail {
  holdings: i128;
  oldest_refresh: u32;
  stale_lp_markets: u32;
}


/**
 * `market_valuation` result. Only `cost_basis` is enforced (by
 * `max_net_exposure`); the others are informational.
 */
export interface Valuation {
  /**
 * `max(0, cost_basis - floor_value)`.
 */
at_risk: i128;
  cost_basis: i128;
  /**
 * What the treasury gets back whatever the outcome, from state a price
 * move cannot raise: complete sets `min(yes, no)` plus, as the unclaimed
 * LP, `min(reserve_yes, reserve_no)`. After finality, the settlement
 * value.
 */
floor_value: i128;
  /**
 * Holdings at the pool's spot price. Manipulable by any trader, so it is
 * never used for enforcement.
 */
spot_value: i128;
}



/**
 * Summary of the sliding daily window, returned by `daily_usage`.
 * `day_start` is the start of the oldest hour still counted and `amount`
 * the usage summed over the whole window (see [`UsageWindow`]).
 */
export interface DailyUsage {
  amount: i128;
  day_start: u64;
}


export interface MarkRecord {
  contribution: i128;
  core: string;
  lp: boolean;
  lp_floor: i128;
  market_id: u64;
  pos_no: i128;
  pos_yes: i128;
  refreshed_ledger: u32;
  status_final: boolean;
}


/**
 * An entry of the open-market index `nav()` walks.
 */
export interface OpenMarket {
  core: string;
  market_id: u64;
}


/**
 * One row of `queue_page`.
 */
export interface QueueEntry {
  ticket: WithdrawTicket;
  ticket_id: u64;
}


/**
 * Legacy single-agent configuration. Still the shape returned by the
 * deprecated `get_config` view; live state is [`GlobalConfig`] plus the
 * agent registry.
 */
export interface RiskConfig {
  agent: string;
  collateral: string;
  market_core: string;
  max_daily: i128;
  max_market: i128;
  max_trade: i128;
}


/**
 * One registered agent. `max_trade` / `max_daily` sit under the global
 * caps; both are checked on every spend.
 */
export interface AgentPolicy {
  active: boolean;
  max_daily: i128;
  max_trade: i128;
  roles: u32;
}


/**
 * Collateral the treasury has sent into (`collateral_in`) and received back
 * from (`collateral_out`) one market. Accounting starts when this code was
 * deployed: a missing entry reads as zero.
 */
export interface NetPosition {
  collateral_in: i128;
  collateral_out: i128;
}


/**
 * Price limits on every agent trade, in bps of the outcome's spot price.
 */
export interface PricePolicy {
  /**
 * Never buy an outcome priced above this.
 */
max_buy_price_bps: u32;
  /**
 * Largest `|p_after - p_before|` a single trade may cause.
 */
max_impact_bps: u32;
  /**
 * Tolerance applied to the same-transaction quote to derive the
 * effective `min_shares_out` / `max_shares_in`.
 */
max_slippage_bps: u32;
  /**
 * Never sell an outcome priced below this.
 */
min_sell_price_bps: u32;
}

export type TracePolicy = {tag: "Off", values: void} | {tag: "Optional", values: void} | {tag: "Required", values: void};


/**
 * Hourly ring buffer behind `max_daily`. Kept in instance storage: ~400
 * bytes that every call loads anyway, so it costs no extra ledger-entry
 * read (a persistent entry would add one per trade). Per-agent windows
 * have the same shape but live in persistent storage.
 */
export interface UsageWindow {
  /**
 * Always `BUCKETS` long. `amounts[i]` is the usage of hour
 * `head_hour - ((head_idx - i) mod BUCKETS)`.
 */
amounts: Array<i128>;
  /**
 * Hour index (`timestamp / BUCKET_SECONDS`) of the newest bucket.
 */
head_hour: u64;
  head_idx: u32;
}





/**
 * Treasury-wide caps, enforced on top of every agent's own policy.
 */
export interface GlobalConfig {
  collateral: string;
  market_core: string;
  max_daily: i128;
  max_market: i128;
  /**
 * Cap on capital deployed in open positions across all markets at once
 * (see `net_exposure`).
 */
max_net_exposure: i128;
  max_trade: i128;
}


export interface PendingAgent {
  executable_at: u64;
  policy: AgentPolicy;
  proposed_at: u64;
}





export interface PendingConfig {
  config: GlobalConfig;
  executable_at: u64;
  proposed_at: u64;
}


/**
 * Where a ticket stands in the withdrawal queue (`queue_position`).
 */
export interface QueuePosition {
  /**
 * Inside the pro-rata head window (`QUEUE_WINDOW` ids from the head).
 */
in_window: boolean;
  /**
 * Live tickets ahead of this one (holes are not counted).
 */
index: u32;
  /**
 * Sum of `remaining` over those tickets.
 */
owed_ahead: i128;
  /**
 * The walk stopped after `MAX_POSITION_SCAN` ids, so `index` and
 * `owed_ahead` are lower bounds.
 */
truncated: boolean;
}







/**
 * Per-core bookkeeping (issue #320), stored under `DataKey::CoreState`.
 * Maintained on every index, exposure and net write once
 * `init_core_accounting` has run (or from deployment for new treasuries).
 */
export interface CoreAccounting {
  /**
 * This core's share of `NetTotal`.
 */
net: i128;
  /**
 * Markets of this core whose `MarketExposure.open` is true.
 */
open_exposures: u32;
  /**
 * `OpenMarketAt` entries that belong to this core.
 */
open_index: u32;
  /**
 * Set once by `retire_core`; never cleared.
 */
retired: boolean;
}


export interface CreationPolicy {
  allowed_categories: u32;
  creation_window_secs: u64;
  max_close_horizon: u64;
  max_markets_per_window: u32;
  max_seed: i128;
  min_close_horizon: u64;
}


export interface DrawdownStatus {
  max_drawdown: i128;
  tripped: boolean;
  window_pnl: i128;
}

export type MigrationPhase = {tag: "None", values: void} | {tag: "Announced", values: void} | {tag: "Migrating", values: void} | {tag: "Migrated", values: void};


export interface MigrationState {
  announced_at: u64;
  markets_left: u32;
  migrate_after: u64;
  phase: MigrationPhase;
  successor: string;
  successor_shares: i128;
}


export interface PendingMarkAge {
  executable_at: u64;
  ledgers: u32;
}


/**
 * Collateral still owed to `owner` for shares already burned.
 * 
 * Layout frozen: tickets queued before the drain/cancel upgrade (#277) must
 * still decode. Everything new lives in [`TicketMeta`].
 */
export interface WithdrawTicket {
  created_at: u64;
  owner: string;
  remaining: i128;
}










export interface MigrationPacket {
  core: string;
  exposure_amount: i128;
  floor_value: i128;
  lp: boolean;
  market_id: u64;
  net: NetPosition;
  no: i128;
  pnl: MarketPnl;
  version: u32;
  yes: i128;
}




export interface CapitalBreakdown {
  liquid: i128;
  yield_principal: i128;
  yield_value: i128;
}


export interface SettlementReport {
  already_settled: boolean;
  lp_claimed: i128;
  redeemed: i128;
}


export interface TracePolicyConfig {
  max_trace_age_ledgers: u32;
  policy: TracePolicy;
}









export interface PendingPricePolicy {
  executable_at: u64;
  policy: PricePolicy;
  proposed_at: u64;
}













export interface HybridConfigV2 {
  fallback: FallbackAuthority;
  fallback_after: u64;
  price: PriceConfig;
}

export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]} | {tag: "HybridV2", values: readonly [HybridConfigV2]};

export type FallbackAuthority = {tag: "Signers", values: readonly [SignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]};

export interface Client {
  /**
   * Construct and simulate a nav transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Net asset value: idle collateral plus, for every market in the open-
   * market index, what the holdings are worth whatever the outcome
   * (complete sets and the LP's `min` reserve while open, the exact
   * settlement value once final), minus what queued withdrawals are owed.
   * Directional exposure is valued at zero, so no trade against a pool
   * can raise NAV.
   */
  nav: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems the treasury's position in a resolved/voided market
   * (`ROLE_SETTLE`).
   */
  redeem: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deposits `amount` of collateral and mints shares to `from` at the NAV
   * as it was before the deposit. Returns the shares minted.
   */
  deposit: ({from, amount}: {from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a realize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  realize: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_at: ({i}: {i: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a realized transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settlement state of `market_id` on the current core; see `realized_on`.
   */
  realized: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Realized>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  withdraw: ({to, amount}: {to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buys `outcome` shares in an existing market using treasury capital
   * (`ROLE_TRADE`). Price-checked, see `do_agent_buy`.
   */
  agent_buy: ({agent, market_id, outcome, collateral_in, min_shares_out}: {agent: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a assets_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  assets_of: ({owner}: {owner: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AgentPolicy>>>

  /**
   * Construct and simulate a set_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds or updates `agent`. Validation: `roles` non-empty and known,
   * `0 < max_trade <= max_daily`, both within the global caps, `active`.
   */
  set_agent: ({agent, policy}: {agent: string, policy: AgentPolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a shares_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  shares_of: ({owner}: {owner: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a agent_halt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_halt: ({agent, reason}: {agent: string, reason: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_sell transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sells `outcome` shares back into the pool for exactly
   * `collateral_out` (`ROLE_TRADE`). This returns capital to the treasury
   * (market-core pays out of its own balance), so it is not capped and
   * does not need the nested-transfer pre-authorization that buying does.
   * It frees net headroom (`collateral_out` is recorded) but never
   * lifetime headroom. Price-checked, see `do_agent_sell`.
   */
  agent_sell: ({agent, market_id, outcome, collateral_out, max_shares_in}: {agent: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a audit_mark transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  audit_mark: ({core, market_id}: {core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<MarkRecord>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deprecated compatibility view in the pre-registry `RiskConfig` shape:
   * `agent` is the first registered agent (whatever its current policy).
   * Use `get_global` and `get_agent` instead.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<RiskConfig>>>

  /**
   * Construct and simulate a get_global transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_global: (options?: MethodOptions) => Promise<AssembledTransaction<Result<GlobalConfig>>>

  /**
   * Construct and simulate a market_pnl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cost/proceeds of `market_id` on the current core; see `market_pnl_on`.
   */
  market_pnl: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<MarketPnl>>

  /**
   * Construct and simulate a nav_detail transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  nav_detail: (options?: MethodOptions) => Promise<AssembledTransaction<NavDetail>>

  /**
   * Construct and simulate a queue_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Live tickets with ids in `[start, start + limit)` (`limit` capped at
   * `MAX_QUEUE_PAGE`), in queue order. Holes are skipped, so a page can
   * hold fewer than `limit` rows; continue from `start + limit`.
   */
  queue_page: ({start, limit}: {start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<QueueEntry>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a window_pnl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  window_pnl: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Agents ever registered (removed ones included).
   */
  agent_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a close_trade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Marks a market's exposure as exited (`ROLE_SETTLE`). Pure bookkeeping
   * (see `MarketExposure`) for the future exposure dashboard; it does not
   * move funds or free either the cumulative per-market cap or net
   * headroom.
   */
  close_trade: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a core_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Per-core counters (issue #320).
   */
  core_status: ({core}: {core: string}, options?: MethodOptions) => Promise<AssembledTransaction<CoreAccounting>>

  /**
   * Construct and simulate a daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Usage over the sliding window as of now: `amount` sums every bucket
   * still counted against `max_daily`, `day_start` is the start of the
   * oldest of them. Side-effect free (it advances a copy), so repeated
   * reads without trades in between return the same value.
   */
  daily_usage: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DailyUsage>>>

  /**
   * Construct and simulate a get_net_cap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `max_net_exposure`.
   */
  get_net_cap: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a known_cores transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Live (not retired) market-cores this treasury knows.
   */
  known_cores: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a predecessor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  predecessor: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a realized_on transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * [`Treasury::realized`] for a market on `core`.
   */
  realized_on: ({core, market_id}: {core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Realized>>

  /**
   * Construct and simulate a redeem_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems the treasury's positions in up to `MAX_BATCH` markets in one
   * call (market-core issue #15), delegating to market-core's `redeem_many`.
   * `market_ids` must be strictly ascending; markets that cannot be paid out
   * right now are reported as skipped rather than aborting the batch. The
   * single aggregated token transfer at the end amortizes fixed per-call
   * costs, keeping the treasury inside the per-transaction resource limits
   * even when it holds positions in many markets. (`ROLE_SETTLE`.)
   */
  redeem_many: ({agent, market_ids}: {agent: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a retire_core transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless, irreversible retirement of a drained legacy core
   * (issue #320). Requires the per-core counters (`init_core_accounting`),
   * a legacy core that is not current and not yet retired, and no index
   * entries or open exposures left on it. Releases the core's net from
   * `NetTotal` (so it stops counting against the caps), clears
   * `LegacyCore` so the `legacy_*` entrypoints refuse it, and drops it
   * from `KnownCores`.
   * 
   * While the treasury is paused, index entries whose core can no longer
   * be read (a broken wasm that would otherwise fail `nav()` forever) are
   * dropped first, each with an `IndexEntryDropped` event.
   * Returns the net released from `NetTotal`.
   */
  retire_core: ({core}: {core: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_buy_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent_buy` with a per-share limit price (`limit_price_bps`, 0 = none)
   * and a deadline (unix seconds, network time). market-core's `buy_v2`
   * enforces both; an expired or out-of-limit trade reverts the whole
   * invocation, so the treasury's caps are never consumed by a reverted
   * trade.
   */
  agent_buy_v2: ({agent, market_id, outcome, collateral_in, min_shares_out, limit_price_bps, deadline}: {agent: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a cancel_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a config_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config_delay: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a migrate_idle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migrate_idle: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a net_exposure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Capital currently deployed across all markets:
   * `sum(max(0, collateral_in - collateral_out))`, the figure
   * `max_net_exposure` is enforced against.
   */
  net_exposure: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a net_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Net position in `market_id` of the current market-core.
   */
  net_position: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<NetPosition>>>

  /**
   * Construct and simulate a queue_bounds transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The ticket `claim_withdraw` pays next, and the id the next one gets.
   */
  queue_bounds: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [u64, u64]>>

  /**
   * Construct and simulate a refresh_mark transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  refresh_mark: ({market_ids}: {market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deactivates `agent` at once, keeping its usage history. At least one
   * active agent with `ROLE_SETTLE` must remain, so open positions can
   * always be settled.
   */
  remove_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a total_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  total_shares: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a trace_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  trace_policy: (options?: MethodOptions) => Promise<AssembledTransaction<TracePolicyConfig>>

  /**
   * Construct and simulate a agent_sell_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent_sell` with a per-share limit price (`limit_price_bps`, 0 = no
   * limit) and a deadline (unix seconds, network time), both enforced by
   * market-core's `sell_v2`.
   */
  agent_sell_v2: ({agent, market_id, outcome, collateral_out, max_shares_in, limit_price_bps, deadline}: {agent: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a cancel_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a disable_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  disable_yield: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies `agent`'s pending policy once its delay has passed.
   * Permissionless: the delay is the protection.
   */
  execute_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a legacy_redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `redeem` against a market-core this treasury was switched away from
   * (see `execute_config`), so positions there are never stranded.
   */
  legacy_redeem: ({agent, core, market_id}: {agent: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a market_pnl_on transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * [`Treasury::market_pnl`] for a market on `core`.
   */
  market_pnl_on: ({core, market_id}: {core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<MarketPnl>>

  /**
   * Construct and simulate a migrate_marks transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migrate_marks: ({start, limit}: {start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a pending_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAgent>>>

  /**
   * Construct and simulate a settle_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless settlement of a resolved or voided market's position and LP remainder.
   * Operates even when the treasury is paused. Idempotent on retry.
   */
  settle_market: ({caller, market_id}: {caller: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettlementReport>>>

  /**
   * Construct and simulate a sweep_retired transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems a stray position that reached the treasury on a retired core
   * (e.g. through market-core's `transfer_position`) straight into idle.
   * Permissionless. Skips index, net and PnL bookkeeping: the collateral
   * simply lands in idle and is counted from then on.
   */
  sweep_retired: ({core, market_id}: {core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless wrapper around the queue drain (`drain_queue`):
   * pays queued tickets from idle collateral, pro rata across the
   * `QUEUE_WINDOW` head window, reading at most `MAX_QUEUE_STEPS` ids.
   * The money always goes to each ticket's owner. `ticket_id` must name
   * a live ticket (`TicketNotFound`); returns the total paid across all
   * tickets, or `NothingToPay` when the drain made no progress.
   * 
   * A call that only moved the head past a run of holes pays nothing but
   * returns `Ok(0)`: failing would revert the head move and let a long
   * run of cancelled tickets stall `claim_withdraw` forever.
   */
  claim_withdraw: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a creation_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  creation_usage: (options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a daily_headroom transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * How much more the agents together may deploy right now before
   * `max_daily` (`max_daily - window sum`, floored at 0).
   */
  daily_headroom: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending config once its delay has passed. Permissionless,
   * so execution never depends on the admin being available.
   * 
   * A `market_core` change records the old core as legacy: its positions
   * stay where they are (recover them with `legacy_redeem` /
   * `legacy_claim_pool_remainder`), and exposure for the new core is kept
   * under keys namespaced by core so market ids cannot collide. The new
   * core must be pointed at this treasury with its own `set_treasury`.
   */
  execute_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a liquid_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Liquid collateral balance held directly in the treasury.
   */
  liquid_capital: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a open_market_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  open_market_at: ({i}: {i: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<OpenMarket>>>

  /**
   * Construct and simulate a pending_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingConfig>>>

  /**
   * Construct and simulate a propose_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Proposes `config` as the global config (admin). Tighten-only
   * proposals apply at once and leave any pending proposal and its timer
   * as they are; anything else is queued.
   */
  propose_config: ({config}: {config: GlobalConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a queue_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Position of `ticket_id` in the queue, or `None` if it is not live.
   * Walks at most `MAX_POSITION_SCAN` ids ahead of it (`truncated`
   * otherwise).
   */
  queue_position: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<QueuePosition>>>

  /**
   * Construct and simulate a queue_reserved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collateral owed to queued withdrawals; agents cannot spend it.
   */
  queue_reserved: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a begin_migration transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  begin_migration: ({successor}: {successor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels `ticket_id` and re-mints shares for what it is still owed.
   * 
   * Shares minted = `min(shares_for_deposit(remaining, nav, supply),
   * floor(shares_burned * remaining / assets_at_request))`: after a NAV
   * loss the owner cannot get back more shares than were burned for the
   * same assets; after a gain they get fewer shares at the higher NAV.
   * Either way request-then-cancel never profits at the expense of other
   * shareholders. The reservation is released *before* NAV is read,
   * because NAV subtracts `QueueReserved`.
   */
  cancel_withdraw: ({owner, ticket_id}: {owner: string, ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a drawdown_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  drawdown_status: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DrawdownStatus>>>

  /**
   * Construct and simulate a fund_data_spend transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records a data-spend of `amount` stroops for `agent`.
   * The agent must be active, its `DataBudget` must be active, and the
   * deduction must not exceed the per-agent daily cap.
   * Only the budget's registered `account` may call this.
   */
  fund_data_spend: ({agent, amount}: {agent: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a migrate_markets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migrate_markets: ({market_ids}: {market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a migration_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migration_state: (options?: MethodOptions) => Promise<AssembledTransaction<Option<MigrationState>>>

  /**
   * Construct and simulate a set_data_budget transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Proposes a new `DataBudget` for `agent`, subject to the config timelock.
   * Admin only. The budget takes effect once `execute_data_budget` is called.
   */
  set_data_budget: ({agent, max_daily, account}: {agent: string, max_daily: i128, account: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_yield_venue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_yield_venue: ({pool, max_allocation}: {pool: string, max_allocation: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  transfer_shares: ({from, to, amount}: {from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_ticket transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves `ticket_id` (and its cancellation right) from `from` to `to`.
   */
  transfer_ticket: ({from, to, ticket_id}: {from: string, to: string, ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw_ticket transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  withdraw_ticket: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<WithdrawTicket>>>

  /**
   * Construct and simulate a agent_buy_traced transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buys with a prior decision-bearing trace consumed atomically.
   */
  agent_buy_traced: ({agent, market_id, outcome, collateral_in, min_shares_out, limit_price_bps, deadline, trace_id}: {agent: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, limit_price_bps: u32, deadline: u64, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a cancel_migration transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_migration: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a estimated_unlock transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rough unlock time for `ticket_id`: now if the collateral already
   * held for the queue covers it; otherwise the close time of the open
   * market whose settlement (floor value, in close-time order) first
   * covers `owed_ahead + remaining`. `None` if the ticket is not live or
   * the open markets cannot cover it. An estimate only: it ignores new
   * deposits, trading and market resolution delays.
   */
  estimated_unlock: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a get_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<PricePolicy>>

  /**
   * Construct and simulate a market_valuation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Conservative valuation of the treasury's holdings in `market_id`
   * (see [`Valuation`]). Two cross-contract reads (`get_market`,
   * `get_position`); a view only, never on the trading path.
   */
  market_valuation: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Valuation>>>

  /**
   * Construct and simulate a request_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Burns `shares` of `owner` at the current NAV, pays what free idle
   * collateral allows now and queues the rest as a ticket. Queued tickets
   * are paid automatically by every transaction that brings collateral in
   * (`drain_queue`, #277), pro rata within the `QUEUE_WINDOW` head
   * window. Returns `(paid_now, ticket_id)`, `ticket_id` 0 when nothing
   * was queued.
   */
  request_withdraw: ({owner, shares}: {owner: string, shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [i128, u64]>>>

  /**
   * Construct and simulate a reset_pnl_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  reset_pnl_window: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_config_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lengthens the timelock. Shortening is refused outright: it would
   * itself have to wait out the old delay to be safe, and a lengthening
   * can always be undone by redeploying.
   */
  set_config_delay: ({new_delay}: {new_delay: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_max_mark_age transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_max_mark_age: ({ledgers}: {ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the price limits on agent trades (admin). Like the caps,
   * tightening (lower `max_buy`/`max_impact`/`max_slippage`, higher
   * `min_sell`) applies at once and anything else waits `config_delay`.
   */
  set_price_policy: ({policy}: {policy: PricePolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_market_on transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * [`Treasury::settle_market`] against any known core (issue #320): the
   * current one or a legacy core this treasury was switched away from.
   * Restricted to known cores because it calls into `core`. A market that
   * market-core already finalized (`RedemptionClosed`) has nothing left
   * to collect, so its exposure is closed and its index entry removed;
   * otherwise a finalized legacy market would block retirement forever.
   */
  settle_market_on: ({caller, core, market_id}: {caller: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettlementReport>>>

  /**
   * Construct and simulate a unattributed_net transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Part of `NetTotal` the backfill could not attribute to a core.
   */
  unattributed_net: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a agent_daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent`'s own sliding-window usage, counted against its `max_daily`.
   */
  agent_daily_usage: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<DailyUsage>>>

  /**
   * Construct and simulate a agent_sell_traced transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sells with a prior decision-bearing trace consumed atomically.
   */
  agent_sell_traced: ({agent, market_id, outcome, collateral_out, max_shares_in, limit_price_bps, deadline, trace_id}: {agent: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128, limit_price_bps: u32, deadline: u64, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a allocate_to_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  allocate_to_yield: ({amount}: {amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a available_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Total capital deployable: liquid collateral balance plus supplied yield value.
   */
  available_capital: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a capital_breakdown transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Breakdown of treasury capital across liquid, yield principal, and yield value.
   */
  capital_breakdown: (options?: MethodOptions) => Promise<AssembledTransaction<Result<CapitalBreakdown>>>

  /**
   * Construct and simulate a exit_to_successor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  exit_to_successor: ({owner, shares}: {owner: string, shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a migration_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migration_version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a open_market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  open_market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a recall_from_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  recall_from_yield: ({amount}: {amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a receive_migration transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  receive_migration: ({predecessor, packet}: {predecessor: string, packet: MigrationPacket}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a accept_predecessor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The successor admin records the old vault before the old vault can
   * announce. This prevents a successor from accepting arbitrary packets.
   */
  accept_predecessor: ({predecessor}: {predecessor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_data_budget transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels a pending `DataBudget` proposal. Admin only.
   */
  cancel_data_budget: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a daily_usage_detail transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The hourly buckets behind `daily_usage`, advanced to now (not stored).
   */
  daily_usage_detail: (options?: MethodOptions) => Promise<AssembledTransaction<Result<UsageWindow>>>

  /**
   * Construct and simulate a emergency_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * While paused only: burns `shares` for their pro-rata part of the free
   * idle collateral, without reading market-core (for when it is the
   * thing that broke). The owner forfeits their part of open positions,
   * which stays with the remaining shareholders.
   */
  emergency_withdraw: ({owner, shares}: {owner: string, shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a receive_collateral transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  receive_collateral: ({predecessor, amount}: {predecessor: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_claim_lp_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the market's LP fee share for a market the treasury created
   * (`ROLE_SETTLE`). The LP portion accrues separately on market-core
   * (see its `claim_lp_fees`).
   */
  agent_claim_lp_fees: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates and seeds a market using treasury capital (`ROLE_CREATE`).
   * The treasury becomes the market's creator/LP. `initial_yes_bps` must
   * lie within the price policy's `[min_sell, max_buy]` band, so the
   * treasury never seeds a market whose creator side is near worthless.
   */
  agent_create_market: ({agent, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {agent: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a cancel_max_mark_age transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_max_mark_age: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_trace_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_trace_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a collect_market_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pulls accrued **protocol** fees from a configured market-core contract.
   * 
   * Only the protocol's share of each market's fees: the LP portion accrues
   * separately on market-core and belongs to the market's creator — for
   * agent-created markets that is the treasury itself, via
   * `agent_claim_lp_fees`. Fees raise NAV for every shareholder at the
   * moment they arrive.
   */
  collect_market_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_data_budget transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Executes a proposed `DataBudget` once the timelock has elapsed.
   */
  execute_data_budget: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_creation_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_creation_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<CreationPolicy>>>

  /**
   * Construct and simulate a set_creation_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_creation_policy: ({new_policy}: {new_policy: CreationPolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_data_global_cap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the network-wide global ceiling for all data budgets. Admin only.
   * Setting `cap` to 0 removes the ceiling.
   */
  set_data_global_cap: ({cap}: {cap: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_drawdown_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_drawdown_config: ({max_drawdown, window_days}: {max_drawdown: i128, window_days: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a acknowledge_drawdown transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  acknowledge_drawdown: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the LP pool remainder for a market the treasury created
   * (`ROLE_SETTLE`).
   */
  claim_pool_remainder: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_max_mark_age transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_max_mark_age: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending price policy once its delay has passed.
   * Permissionless.
   */
  execute_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_trace_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_trace_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a init_core_accounting transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-shot, permissionless backfill of the per-core counters for a
   * treasury deployed before issue #320. Walks the open-market index (at
   * most `MAX_OPEN_MARKETS` entries) and attributes each entry, its open
   * exposure and its net cost basis to its core. Whatever part of
   * `NetTotal` is not attributable to an indexed market goes into
   * `UnattributedNet`, which stays counted in the caps (conservative).
   * Returns the unattributed net.
   */
  init_core_accounting: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a max_mark_age_ledgers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  max_mark_age_ledgers: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a pending_max_mark_age transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_max_mark_age: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingMarkAge>>>

  /**
   * Construct and simulate a pending_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingPricePolicy>>>

  /**
   * Construct and simulate a propose_trace_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_trace_policy: ({policy, max_trace_age_ledgers, registry}: {policy: TracePolicy, max_trace_age_ledgers: u32, registry: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_pool_remainders transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the LP pool remainders of up to `MAX_BATCH` treasury-created
   * markets in one call, delegating to market-core's `claim_pool_remainders`
   * (skips, never aborts on, markets the treasury did not create, markets
   * not settled, or markets already claimed — see `redeem_many` for the
   * batching rationale). (`ROLE_SETTLE`.)
   */
  claim_pool_remainders: ({agent, market_ids}: {agent: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a core_accounting_initialized transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the per-core counters are maintained.
   */
  core_accounting_initialized: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a legacy_claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `claim_pool_remainder` against a legacy market-core.
   */
  legacy_claim_pool_remainder: ({agent, core, market_id}: {agent: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_create_market_reveal_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_create_market_reveal_v2: ({agent, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {agent: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_create_market_and_reveal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Like [`Treasury::agent_create_market`], but reveals the resolution rule
   * in the same transaction (#64). The market is created with the commitment
   * derived from `spec_v2` itself, so the follow-up reveal necessarily
   * matches and the market can never be left unresolvable. `resolver` is the
   * deployed resolver contract; it must be configured for this treasury's
   * market-core.
   * 
   * The router cannot serve this path: seeding pulls collateral from the
   * treasury contract (not the end user) via a contract self-authorization,
   * which only this contract can perform — a stateless router between the
   * agent and market-core would not be authorized on the token.
   */
  agent_create_market_and_reveal: ({agent, resolver, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {agent: string, resolver: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, agent, collateral, market_core, max_trade, max_market, max_daily, max_net_exposure, config_delay, max_drawdown, window_days, creation_policy}: {admin: string, agent: string, collateral: string, market_core: string, max_trade: i128, max_market: i128, max_daily: i128, max_net_exposure: i128, config_delay: u64, max_drawdown: i128, window_days: u32, creation_policy: CreationPolicy},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, agent, collateral, market_core, max_trade, max_market, max_daily, max_net_exposure, config_delay, max_drawdown, window_days, creation_policy}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAAAAAAAAAAAACUJhdGNoSXRlbQAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABnBheW91dAAAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAC0JhdGNoU3RhdHVzAA==",
        "AAAAAgAAAAAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAEAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAClNraXBSZWFzb24AAAAAAAcAAAAAAAAAAAAAAAhOb3RGb3VuZAAAAAAAAAAAAAAACE5vdEZpbmFsAAAAAAAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAAAAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAAAAAAAAAAAAApOb3RDcmVhdG9yAAAAAAAAAAAAAAAAAAlEdXBsaWNhdGUAAAAAAAAAAAAAAAAAAAZDbG9zZWQAAA==",
        "AAAAAQAAAAAAAAAAAAAAC0JhdGNoUmVzdWx0AAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAJQmF0Y2hJdGVtAAAAAAAAAAAAAAV0b3RhbAAAAAAAAAs=",
        "AAAAAgAAAAAAAAAAAAAAC0JhdGNoU3RhdHVzAAAAAAIAAAAAAAAAAAAAAAdTZXR0bGVkAAAAAAEAAAAAAAAAB1NraXBwZWQAAAAAAQAAB9AAAAAKU2tpcFJlYXNvbgAA",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAAAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADENvbW1pdHRlZVJlZgAAAAQAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAABJtYXhfcm90YXRpb25fZGVsdGEAAAAAAAQAAAAAAAAACW1pbl9lcG9jaAAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAQAAAAAAAAAAAAAAEFJlc29sdXRpb25TcGVjVjIAAAAFAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAAAQAAAAAAAAAAAAAAFkRpc3B1dGFibGVTaWduZXJDb25maWcAAAAAAAYAAAAAAAAADGRpc3B1dGVfYm9uZAAAAAsAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAplc2NhbGF0aW9uAAAAAAfQAAAACkVzY2FsYXRpb24AAAAAAAAAAAASZXNjYWxhdGlvbl90aW1lb3V0AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAVQAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABAAAAAAAAAAQVHJhZGVDYXBFeGNlZWRlZAAAAAUAAAAAAAAAEU1hcmtldENhcEV4Y2VlZGVkAAAAAAAABgAAAAAAAAAQRGFpbHlDYXBFeGNlZWRlZAAAAAcAAAAAAAAADU1hcmtldE5vdE9wZW4AAAAAAAAIAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAkAAAAAAAAABlBhdXNlZAAAAAAACgAAAAAAAAALTm9TdWNjZXNzb3IAAAAACwAAAAAAAAATTmV0RXhwb3N1cmVFeGNlZWRlZAAAAAAMAAAAAAAAABVBZ2VudERhaWx5Q2FwRXhjZWVkZWQAAAAAAAANAAAAAAAAAA9Qcm9wb3NhbFBlbmRpbmcAAAAADgAAAAAAAAAOVGltZWxvY2tBY3RpdmUAAAAAAA8AAAAAAAAAD05vUGVuZGluZ0NvbmZpZwAAAAAQAAAAAAAAABFMZWdhY3lDb3JlVW5rbm93bgAAAAAAABEAAAAAAAAAElRvb01hbnlPcGVuTWFya2V0cwAAAAAAEgAAAAAAAAAPQ2FwaXRhbFJlc2VydmVkAAAAABMAAAAAAAAAD0RlcG9zaXRUb29TbWFsbAAAAAAUAAAAAAAAABJJbnN1ZmZpY2llbnRTaGFyZXMAAAAAABUAAAAAAAAADlRpY2tldE5vdEZvdW5kAAAAAAAWAAAAAAAAAAxOb3RoaW5nVG9QYXkAAAAXAAAAAAAAAA5QcmljZU91dE9mQmFuZAAAAAAAGAAAAAAAAAATUHJpY2VJbXBhY3RFeGNlZWRlZAAAAAAZAAAAAAAAABJJbnZhbGlkUHJpY2VQb2xpY3kAAAAAABoAAAAAAAAAEFNsaXBwYWdlRXhjZWVkZWQAAAAbAAAAAAAAAAlOb3RQYXVzZWQAAAAAAAAcAAAAAAAAABhNYXJrZXRDb3JlTWFya2V0Tm90Rm91bmQAAAAdAAAAAAAAABJNYXJrZXRDb3JlTm90RmluYWwAAAAAAB4AAAAAAAAAF01hcmtldENvcmVNYXJrZXROb3RPcGVuAAAAAB8AAAAAAAAAFk1hcmtldENvcmVNYXJrZXRDbG9zZWQAAAAAACAAAAAAAAAAH01hcmtldENvcmVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAIQAAAAAAAAAcTWFya2V0Q29yZUluc3VmZmljaWVudFNoYXJlcwAAACIAAAAAAAAAGE1hcmtldENvcmVBbHJlYWR5Q2xhaW1lZAAAACMAAAAAAAAAGU1hcmtldENvcmVOb3RoaW5nVG9SZWRlZW0AAAAAAAAkAAAAAAAAABdNYXJrZXRDb3JlSW52YWxpZEFtb3VudAAAAAAlAAAAAAAAABJNYXJrZXRDb3JlT3ZlcmZsb3cAAAAAACYAAAAAAAAAGk1hcmtldENvcmVTbGlwcGFnZUV4Y2VlZGVkAAAAAAAnAAAAAAAAABRNYXJrZXRDb3JlQ2FsbEZhaWxlZAAAACgAAAAAAAAADk1hcmtldE5vdEZpbmFsAAAAAAAsAAAAAAAAAA9NYXJrZXRDb3JlRXJyb3IAAAAALQAAAAAAAAAPRHJhd2Rvd25UcmlwcGVkAAAAAC4AAAAAAAAAFUludmFsaWREcmF3ZG93bkNvbmZpZwAAAAAAAC8AAAAAAAAAD05vdEFja25vd2xlZGdlZAAAAAAwAAAAAAAAAA9TZWVkQ2FwRXhjZWVkZWQAAAAAMQAAAAAAAAAUQ3JlYXRpb25SYXRlRXhjZWVkZWQAAAAyAAAAAAAAABBDbG9zZVRpbWVUb29Tb29uAAAAMwAAAAAAAAAPQ2xvc2VUaW1lVG9vRmFyAAAAADQAAAAAAAAAEkNhdGVnb3J5Tm90QWxsb3dlZAAAAAAANQAAAAAAAAAPUG9saWN5TG9vc2VuaW5nAAAAADYAAAAAAAAADVlpZWxkRGlzYWJsZWQAAAAAAAA3AAAAAAAAABBZaWVsZENhcEV4Y2VlZGVkAAAAOAAAAAAAAAATWWllbGRXaXRoZHJhd0ZhaWxlZAAAAAA5AAAAAAAAABFWZW51ZUhhc1ByaW5jaXBhbAAAAAAAADoAAAA5Q2F0ZWdvcnkgZXhwb3N1cmUgd291bGQgZXhjZWVkIGl0cyBjb3JyZWxhdGlvbiBjYXAgKCM0OSkuAAAAAAAAE0NhdGVnb3J5Q2FwRXhjZWVkZWQAAAAAOwAAADZDbG9zZS1kYXRlIGJ1Y2tldCBleHBvc3VyZSB3b3VsZCBleGNlZWQgaXRzIGNhcCAoIzQ5KS4AAAAAABFCdWNrZXRDYXBFeGNlZWRlZAAAAAAAADwAAABEYGFjY2VwdF9hZG1pbmAvYGNhbmNlbF9hZG1pbl90cmFuc2ZlcmAgY2FsbGVkIHdpdGggbm90aGluZyBwcm9wb3NlZC4AAAAOTm9QZW5kaW5nQWRtaW4AAAAAAD0AAABDQSBwcm9wb3NlZCBhZG1pbiBoYW5kb3ZlciB3YXMgbm90IGFjY2VwdGVkIHdpdGhpbiBpdHMgYGV4cGlyZXNfYXRgLgAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAA+AAAAeWBhZ2VudF9jcmVhdGVfbWFya2V0X2FuZF9yZXZlYWxgIHdhcyBnaXZlbiBhIG1hbGZvcm1lZCByZXNvbHV0aW9uCmVudmVsb3BlIG9yIGEgcnVsZSBvdXRzaWRlIHRoZSB0d28gcHJpbWFyeSBtb2RlcyAoIzY0KS4AAAAAAAARSW52YWxpZFJlc29sdXRpb24AAAAAAAA/AAAAAAAAAA1UcmFjZVJlcXVpcmVkAAAAAAAAQAAAAAAAAAAVVHJhY2VEZWNpc2lvbk1pc21hdGNoAAAAAAAAQQAAAAAAAAANVHJhY2VNaXNtYXRjaAAAAAAAAEIAAAAAAAAAElRyYWNlQWdlbnRNaXNtYXRjaAAAAAAAQwAAAAAAAAAMVHJhY2VGbGFnZ2VkAAAARAAAAAAAAAAKVHJhY2VTdGFsZQAAAAAARQAAAAAAAAANVHJhY2VDb25zdW1lZAAAAAAAAEYAAAAAAAAAF1RyYWNlUmVnaXN0cnlDYWxsRmFpbGVkAAAAAEcAAAAAAAAAElRyYWNlUG9saWN5UGVuZGluZwAAAAAASAAAAAAAAAAVVHJhY2VQb2xpY3lOb3RQZW5kaW5nAAAAAAAASQAAAAAAAAATVHJhY2VUaW1lbG9ja0FjdGl2ZQAAAABKAAAAAAAAAApTdGFsZU1hcmtzAAAAAABLAAAAAAAAABFNYXJrQmF0Y2hUb29MYXJnZQAAAAAAAEwAAAAAAAAAE01pZ3JhdGlvbkluUHJvZ3Jlc3MAAAAAUwAAAAAAAAARTWlncmF0aW9uTm90UmVhZHkAAAAAAABUAAAAAAAAABVJbmNvbXBhdGlibGVTdWNjZXNzb3IAAAAAAABVAAAAAAAAAA9BbHJlYWR5TWlncmF0ZWQAAAAAVgAAAGtUaGUgdGlja2V0IHByZWRhdGVzICMyNzcgKG5vIGBUaWNrZXRNZXRhYCkgYW5kIGNhbm5vdCBiZSBjYW5jZWxsZWQ7Cml0IHN0aWxsIGRyYWlucyBhbmQgY2FuIGJlIHRyYW5zZmVycmVkLgAAAAAUVGlja2V0Tm90Q2FuY2VsbGFibGUAAABNAAAAOWBjYW5jZWxfd2l0aGRyYXdgIGJlZm9yZSBgY3JlYXRlZF9hdCArIE1JTl9DQU5DRUxfREVMQVlgLgAAAAAAAA5DYW5jZWxUb29FYXJseQAAAAAATgAAAD5UaGUgY29yZSB3YXMgcmV0aXJlZDsgaXQgY2FuIG5ldmVyIGJlIGN1cnJlbnQgb3IgbGVnYWN5IGFnYWluLgAAAAAAC0NvcmVSZXRpcmVkAAAAAE8AAAA0YHJldGlyZV9jb3JlYCBiZWZvcmUgYGluaXRfY29yZV9hY2NvdW50aW5nYCBoYXMgcnVuLgAAABhBY2NvdW50aW5nTm90SW5pdGlhbGl6ZWQAAABQAAAARmByZXRpcmVfY29yZWAgd2hpbGUgdGhlIGNvcmUgc3RpbGwgaGFzIGluZGV4IGVudHJpZXMgb3Igb3BlbiBleHBvc3VyZS4AAAAAAA5Db3JlTm90RHJhaW5lZAAAAAAAUQAAACpUaGUgY3VycmVudCBtYXJrZXQtY29yZSBjYW5ub3QgYmUgcmV0aXJlZC4AAAAAAA1Db3JlSXNDdXJyZW50AAAAAAAAUgAAADlgS25vd25Db3Jlc2AgaXMgZnVsbDsgcmV0aXJlIGEgZHJhaW5lZCBsZWdhY3kgY29yZSBmaXJzdC4AAAAAAAAMVG9vTWFueUNvcmVzAAAAVwAAAC5gc3dlZXBfcmV0aXJlZGAgb24gYSBjb3JlIHRoYXQgaXMgbm90IHJldGlyZWQuAAAAAAAOQ29yZU5vdFJldGlyZWQAAAAAAFg=",
        "AAAAAAAAAVtOZXQgYXNzZXQgdmFsdWU6IGlkbGUgY29sbGF0ZXJhbCBwbHVzLCBmb3IgZXZlcnkgbWFya2V0IGluIHRoZSBvcGVuLQptYXJrZXQgaW5kZXgsIHdoYXQgdGhlIGhvbGRpbmdzIGFyZSB3b3J0aCB3aGF0ZXZlciB0aGUgb3V0Y29tZQooY29tcGxldGUgc2V0cyBhbmQgdGhlIExQJ3MgYG1pbmAgcmVzZXJ2ZSB3aGlsZSBvcGVuLCB0aGUgZXhhY3QKc2V0dGxlbWVudCB2YWx1ZSBvbmNlIGZpbmFsKSwgbWludXMgd2hhdCBxdWV1ZWQgd2l0aGRyYXdhbHMgYXJlIG93ZWQuCkRpcmVjdGlvbmFsIGV4cG9zdXJlIGlzIHZhbHVlZCBhdCB6ZXJvLCBzbyBubyB0cmFkZSBhZ2FpbnN0IGEgcG9vbApjYW4gcmFpc2UgTkFWLgAAAAADbmF2AAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAQAAAAAAAAAAAAAACFJlYWxpemVkAAAAAwAAAAAAAAALbHBfcHJvY2VlZHMAAAAACwAAAAAAAAARcG9zaXRpb25fcHJvY2VlZHMAAAAAAAALAAAAAAAAAAdzZXR0bGVkAAAAAAE=",
        "AAAAAAAAAExSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldAooYFJPTEVfU0VUVExFYCkuAAAABnJlZGVlbQAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAQAAAAAAAAAAAAAACU1hcmtldFBubAAAAAAAAAMAAAAAAAAABGNvc3QAAAALAAAAAAAAAAhwcm9jZWVkcwAAAAsAAAAAAAAACHJlYWxpemVkAAAAAQ==",
        "AAAAAQAAAAAAAAAAAAAACU5hdkRldGFpbAAAAAAAAAMAAAAAAAAACGhvbGRpbmdzAAAACwAAAAAAAAAOb2xkZXN0X3JlZnJlc2gAAAAAAAQAAAAAAAAAEHN0YWxlX2xwX21hcmtldHMAAAAE",
        "AAAAAQAAAG9gbWFya2V0X3ZhbHVhdGlvbmAgcmVzdWx0LiBPbmx5IGBjb3N0X2Jhc2lzYCBpcyBlbmZvcmNlZCAoYnkKYG1heF9uZXRfZXhwb3N1cmVgKTsgdGhlIG90aGVycyBhcmUgaW5mb3JtYXRpb25hbC4AAAAAAAAAAAlWYWx1YXRpb24AAAAAAAAEAAAAI2BtYXgoMCwgY29zdF9iYXNpcyAtIGZsb29yX3ZhbHVlKWAuAAAAAAdhdF9yaXNrAAAAAAsAAAAAAAAACmNvc3RfYmFzaXMAAAAAAAsAAADVV2hhdCB0aGUgdHJlYXN1cnkgZ2V0cyBiYWNrIHdoYXRldmVyIHRoZSBvdXRjb21lLCBmcm9tIHN0YXRlIGEgcHJpY2UKbW92ZSBjYW5ub3QgcmFpc2U6IGNvbXBsZXRlIHNldHMgYG1pbih5ZXMsIG5vKWAgcGx1cywgYXMgdGhlIHVuY2xhaW1lZApMUCwgYG1pbihyZXNlcnZlX3llcywgcmVzZXJ2ZV9ubylgLiBBZnRlciBmaW5hbGl0eSwgdGhlIHNldHRsZW1lbnQKdmFsdWUuAAAAAAAAC2Zsb29yX3ZhbHVlAAAAAAsAAABiSG9sZGluZ3MgYXQgdGhlIHBvb2wncyBzcG90IHByaWNlLiBNYW5pcHVsYWJsZSBieSBhbnkgdHJhZGVyLCBzbyBpdCBpcwpuZXZlciB1c2VkIGZvciBlbmZvcmNlbWVudC4AAAAAAApzcG90X3ZhbHVlAAAAAAAL",
        "AAAAAAAAAH5EZXBvc2l0cyBgYW1vdW50YCBvZiBjb2xsYXRlcmFsIGFuZCBtaW50cyBzaGFyZXMgdG8gYGZyb21gIGF0IHRoZSBOQVYKYXMgaXQgd2FzIGJlZm9yZSB0aGUgZGVwb3NpdC4gUmV0dXJucyB0aGUgc2hhcmVzIG1pbnRlZC4AAAAAAAdkZXBvc2l0AAAAAAIAAAAAAAAABGZyb20AAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVhbGl6ZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAACURlcG9zaXRlZAAAAAAAAAEAAAAJZGVwb3NpdGVkAAAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAABdOQVYgYmVmb3JlIHRoZSBkZXBvc2l0LgAAAAADbmF2AAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAMRTdW1tYXJ5IG9mIHRoZSBzbGlkaW5nIGRhaWx5IHdpbmRvdywgcmV0dXJuZWQgYnkgYGRhaWx5X3VzYWdlYC4KYGRheV9zdGFydGAgaXMgdGhlIHN0YXJ0IG9mIHRoZSBvbGRlc3QgaG91ciBzdGlsbCBjb3VudGVkIGFuZCBgYW1vdW50YAp0aGUgdXNhZ2Ugc3VtbWVkIG92ZXIgdGhlIHdob2xlIHdpbmRvdyAoc2VlIFtgVXNhZ2VXaW5kb3dgXSkuAAAAAAAAAApEYWlseVVzYWdlAAAAAAACAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACWRheV9zdGFydAAAAAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAACk1hcmtSZWNvcmQAAAAAAAkAAAAAAAAADGNvbnRyaWJ1dGlvbgAAAAsAAAAAAAAABGNvcmUAAAATAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAIbHBfZmxvb3IAAAALAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZwb3Nfbm8AAAAAAAsAAAAAAAAAB3Bvc195ZXMAAAAACwAAAAAAAAAQcmVmcmVzaGVkX2xlZGdlcgAAAAQAAAAAAAAADHN0YXR1c19maW5hbAAAAAE=",
        "AAAAAQAAADBBbiBlbnRyeSBvZiB0aGUgb3Blbi1tYXJrZXQgaW5kZXggYG5hdigpYCB3YWxrcy4AAAAAAAAACk9wZW5NYXJrZXQAAAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAG",
        "AAAAAQAAABhPbmUgcm93IG9mIGBxdWV1ZV9wYWdlYC4AAAAAAAAAClF1ZXVlRW50cnkAAAAAAAIAAAAAAAAABnRpY2tldAAAAAAH0AAAAA5XaXRoZHJhd1RpY2tldAAAAAAAAAAAAAl0aWNrZXRfaWQAAAAAAAAG",
        "AAAAAQAAAJhMZWdhY3kgc2luZ2xlLWFnZW50IGNvbmZpZ3VyYXRpb24uIFN0aWxsIHRoZSBzaGFwZSByZXR1cm5lZCBieSB0aGUKZGVwcmVjYXRlZCBgZ2V0X2NvbmZpZ2AgdmlldzsgbGl2ZSBzdGF0ZSBpcyBbYEdsb2JhbENvbmZpZ2BdIHBsdXMgdGhlCmFnZW50IHJlZ2lzdHJ5LgAAAAAAAAAKUmlza0NvbmZpZwAAAAAABgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAAAAAAAAAAAIYWdlbnRfYXQAAAABAAAAAAAAAAFpAAAAAAAABAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAEdTZXR0bGVtZW50IHN0YXRlIG9mIGBtYXJrZXRfaWRgIG9uIHRoZSBjdXJyZW50IGNvcmU7IHNlZSBgcmVhbGl6ZWRfb25gLgAAAAAIcmVhbGl6ZWQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAIUmVhbGl6ZWQ=",
        "AAAAAAAAAAAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAQAAAGtPbmUgcmVnaXN0ZXJlZCBhZ2VudC4gYG1heF90cmFkZWAgLyBgbWF4X2RhaWx5YCBzaXQgdW5kZXIgdGhlIGdsb2JhbApjYXBzOyBib3RoIGFyZSBjaGVja2VkIG9uIGV2ZXJ5IHNwZW5kLgAAAAAAAAAAC0FnZW50UG9saWN5AAAAAAQAAAAAAAAABmFjdGl2ZQAAAAAAAQAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACwAAAAAAAAAFcm9sZXMAAAAAAAAE",
        "AAAAAQAAALtDb2xsYXRlcmFsIHRoZSB0cmVhc3VyeSBoYXMgc2VudCBpbnRvIChgY29sbGF0ZXJhbF9pbmApIGFuZCByZWNlaXZlZCBiYWNrCmZyb20gKGBjb2xsYXRlcmFsX291dGApIG9uZSBtYXJrZXQuIEFjY291bnRpbmcgc3RhcnRzIHdoZW4gdGhpcyBjb2RlIHdhcwpkZXBsb3llZDogYSBtaXNzaW5nIGVudHJ5IHJlYWRzIGFzIHplcm8uAAAAAAAAAAALTmV0UG9zaXRpb24AAAAAAgAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAAL",
        "AAAAAQAAAEZQcmljZSBsaW1pdHMgb24gZXZlcnkgYWdlbnQgdHJhZGUsIGluIGJwcyBvZiB0aGUgb3V0Y29tZSdzIHNwb3QgcHJpY2UuAAAAAAAAAAAAC1ByaWNlUG9saWN5AAAAAAQAAAAnTmV2ZXIgYnV5IGFuIG91dGNvbWUgcHJpY2VkIGFib3ZlIHRoaXMuAAAAABFtYXhfYnV5X3ByaWNlX2JwcwAAAAAAAAQAAAA4TGFyZ2VzdCBgfHBfYWZ0ZXIgLSBwX2JlZm9yZXxgIGEgc2luZ2xlIHRyYWRlIG1heSBjYXVzZS4AAAAObWF4X2ltcGFjdF9icHMAAAAAAAQAAABrVG9sZXJhbmNlIGFwcGxpZWQgdG8gdGhlIHNhbWUtdHJhbnNhY3Rpb24gcXVvdGUgdG8gZGVyaXZlIHRoZQplZmZlY3RpdmUgYG1pbl9zaGFyZXNfb3V0YCAvIGBtYXhfc2hhcmVzX2luYC4AAAAAEG1heF9zbGlwcGFnZV9icHMAAAAEAAAAKE5ldmVyIHNlbGwgYW4gb3V0Y29tZSBwcmljZWQgYmVsb3cgdGhpcy4AAAASbWluX3NlbGxfcHJpY2VfYnBzAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAAC1RyYWNlUG9saWN5AAAAAAMAAAAAAAAAAAAAAANPZmYAAAAAAAAAAAAAAAAIT3B0aW9uYWwAAAAAAAAAAAAAAAhSZXF1aXJlZA==",
        "AAAAAQAAAQRIb3VybHkgcmluZyBidWZmZXIgYmVoaW5kIGBtYXhfZGFpbHlgLiBLZXB0IGluIGluc3RhbmNlIHN0b3JhZ2U6IH40MDAKYnl0ZXMgdGhhdCBldmVyeSBjYWxsIGxvYWRzIGFueXdheSwgc28gaXQgY29zdHMgbm8gZXh0cmEgbGVkZ2VyLWVudHJ5CnJlYWQgKGEgcGVyc2lzdGVudCBlbnRyeSB3b3VsZCBhZGQgb25lIHBlciB0cmFkZSkuIFBlci1hZ2VudCB3aW5kb3dzCmhhdmUgdGhlIHNhbWUgc2hhcGUgYnV0IGxpdmUgaW4gcGVyc2lzdGVudCBzdG9yYWdlLgAAAAAAAAALVXNhZ2VXaW5kb3cAAAAAAwAAAGRBbHdheXMgYEJVQ0tFVFNgIGxvbmcuIGBhbW91bnRzW2ldYCBpcyB0aGUgdXNhZ2Ugb2YgaG91cgpgaGVhZF9ob3VyIC0gKChoZWFkX2lkeCAtIGkpIG1vZCBCVUNLRVRTKWAuAAAAB2Ftb3VudHMAAAAD6gAAAAsAAAA/SG91ciBpbmRleCAoYHRpbWVzdGFtcCAvIEJVQ0tFVF9TRUNPTkRTYCkgb2YgdGhlIG5ld2VzdCBidWNrZXQuAAAAAAloZWFkX2hvdXIAAAAAAAAGAAAAAAAAAAhoZWFkX2lkeAAAAAQ=",
        "AAAAAAAAAHVCdXlzIGBvdXRjb21lYCBzaGFyZXMgaW4gYW4gZXhpc3RpbmcgbWFya2V0IHVzaW5nIHRyZWFzdXJ5IGNhcGl0YWwKKGBST0xFX1RSQURFYCkuIFByaWNlLWNoZWNrZWQsIHNlZSBgZG9fYWdlbnRfYnV5YC4AAAAAAAAJYWdlbnRfYnV5AAAAAAAABQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAJYXNzZXRzX29mAAAAAAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAAAAAAAJZ2V0X2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+gAAAfQAAAAC0FnZW50UG9saWN5AA==",
        "AAAAAAAAAIZBZGRzIG9yIHVwZGF0ZXMgYGFnZW50YC4gVmFsaWRhdGlvbjogYHJvbGVzYCBub24tZW1wdHkgYW5kIGtub3duLApgMCA8IG1heF90cmFkZSA8PSBtYXhfZGFpbHlgLCBib3RoIHdpdGhpbiB0aGUgZ2xvYmFsIGNhcHMsIGBhY3RpdmVgLgAAAAAACXNldF9hZ2VudAAAAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAGcG9saWN5AAAAAAfQAAAAC0FnZW50UG9saWN5AAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAJc2hhcmVzX29mAAAAAAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAABQAAAAAAAAAAAAAAC0FnZW50SGFsdGVkAAAAAAEAAAAMYWdlbnRfaGFsdGVkAAAAAwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGcmVhc29uAAAAAAAEAAAAAAAAAAAAAAALcm9sZXNfYWZ0ZXIAAAAABAAAAAAAAAAC",
        "AAAABQAAAD0jMzIwOiBhIGRyYWluZWQgbGVnYWN5IGNvcmUgd2FzIHJldGlyZWQgYW5kIGl0cyBuZXQgcmVsZWFzZWQuAAAAAAAAAAAAAAtDb3JlUmV0aXJlZAAAAAABAAAADGNvcmVfcmV0aXJlZAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAQAAAAAAAAAMbmV0X3JlbGVhc2VkAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAC1BubFJlYWxpemVkAAAAAAEAAAAMcG5sX3JlYWxpemVkAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGNvc3QAAAALAAAAAAAAAAAAAAAIcHJvY2VlZHMAAAALAAAAAAAAAAAAAAADcG5sAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAEBUcmVhc3VyeS13aWRlIGNhcHMsIGVuZm9yY2VkIG9uIHRvcCBvZiBldmVyeSBhZ2VudCdzIG93biBwb2xpY3kuAAAAAAAAAAxHbG9iYWxDb25maWcAAAAGAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAWkNhcCBvbiBjYXBpdGFsIGRlcGxveWVkIGluIG9wZW4gcG9zaXRpb25zIGFjcm9zcyBhbGwgbWFya2V0cyBhdCBvbmNlCihzZWUgYG5ldF9leHBvc3VyZWApLgAAAAAAEG1heF9uZXRfZXhwb3N1cmUAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADFBlbmRpbmdBZ2VudAAAAAMAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALQWdlbnRQb2xpY3kAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAG",
        "AAAAAAAAAAAAAAAKYWdlbnRfaGFsdAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAZyZWFzb24AAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAXpTZWxscyBgb3V0Y29tZWAgc2hhcmVzIGJhY2sgaW50byB0aGUgcG9vbCBmb3IgZXhhY3RseQpgY29sbGF0ZXJhbF9vdXRgIChgUk9MRV9UUkFERWApLiBUaGlzIHJldHVybnMgY2FwaXRhbCB0byB0aGUgdHJlYXN1cnkKKG1hcmtldC1jb3JlIHBheXMgb3V0IG9mIGl0cyBvd24gYmFsYW5jZSksIHNvIGl0IGlzIG5vdCBjYXBwZWQgYW5kCmRvZXMgbm90IG5lZWQgdGhlIG5lc3RlZC10cmFuc2ZlciBwcmUtYXV0aG9yaXphdGlvbiB0aGF0IGJ1eWluZyBkb2VzLgpJdCBmcmVlcyBuZXQgaGVhZHJvb20gKGBjb2xsYXRlcmFsX291dGAgaXMgcmVjb3JkZWQpIGJ1dCBuZXZlcgpsaWZldGltZSBoZWFkcm9vbS4gUHJpY2UtY2hlY2tlZCwgc2VlIGBkb19hZ2VudF9zZWxsYC4AAAAAAAphZ2VudF9zZWxsAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAOY29sbGF0ZXJhbF9vdXQAAAAAAAsAAAAAAAAADW1heF9zaGFyZXNfaW4AAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAKYXVkaXRfbWFyawAAAAAAAgAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAAKTWFya1JlY29yZAAA",
        "AAAAAAAAALREZXByZWNhdGVkIGNvbXBhdGliaWxpdHkgdmlldyBpbiB0aGUgcHJlLXJlZ2lzdHJ5IGBSaXNrQ29uZmlnYCBzaGFwZToKYGFnZW50YCBpcyB0aGUgZmlyc3QgcmVnaXN0ZXJlZCBhZ2VudCAod2hhdGV2ZXIgaXRzIGN1cnJlbnQgcG9saWN5KS4KVXNlIGBnZXRfZ2xvYmFsYCBhbmQgYGdldF9hZ2VudGAgaW5zdGVhZC4AAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAApSaXNrQ29uZmlnAAAAAAAD",
        "AAAAAAAAAAAAAAAKZ2V0X2dsb2JhbAAAAAAAAAAAAAEAAAPpAAAH0AAAAAxHbG9iYWxDb25maWcAAAAD",
        "AAAAAAAAAEZDb3N0L3Byb2NlZWRzIG9mIGBtYXJrZXRfaWRgIG9uIHRoZSBjdXJyZW50IGNvcmU7IHNlZSBgbWFya2V0X3BubF9vbmAuAAAAAAAKbWFya2V0X3BubAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAfQAAAACU1hcmtldFBubAAAAA==",
        "AAAAAAAAAAAAAAAKbmF2X2RldGFpbAAAAAAAAAAAAAEAAAfQAAAACU5hdkRldGFpbAAAAA==",
        "AAAAAAAAAMVMaXZlIHRpY2tldHMgd2l0aCBpZHMgaW4gYFtzdGFydCwgc3RhcnQgKyBsaW1pdClgIChgbGltaXRgIGNhcHBlZCBhdApgTUFYX1FVRVVFX1BBR0VgKSwgaW4gcXVldWUgb3JkZXIuIEhvbGVzIGFyZSBza2lwcGVkLCBzbyBhIHBhZ2UgY2FuCmhvbGQgZmV3ZXIgdGhhbiBgbGltaXRgIHJvd3M7IGNvbnRpbnVlIGZyb20gYHN0YXJ0ICsgbGltaXRgLgAAAAAAAApxdWV1ZV9wYWdlAAAAAAACAAAAAAAAAAVzdGFydAAAAAAAAAYAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAApRdWV1ZUVudHJ5AAA=",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAKd2luZG93X3BubAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmVtb3ZlZAAAAAEAAAANYWdlbnRfcmVtb3ZlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAC",
        "AAAABQAAAEAjMzIwOiBhIHN0cmF5IHBvc2l0aW9uIG9uIGEgcmV0aXJlZCBjb3JlIHdhcyByZWRlZW1lZCBpbnRvIGlkbGUuAAAAAAAAAAxSZXRpcmVkU3dlZXAAAAABAAAADXJldGlyZWRfc3dlZXAAAAAAAAADAAAAAAAAAARjb3JlAAAAEwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADFdpdGhkcmF3UGFpZAAAAAEAAAANd2l0aGRyYXdfcGFpZAAAAAAAAAIAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADVBlbmRpbmdDb25maWcAAAAAAAADAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAALcHJvcG9zZWRfYXQAAAAABg==",
        "AAAAAQAAAEFXaGVyZSBhIHRpY2tldCBzdGFuZHMgaW4gdGhlIHdpdGhkcmF3YWwgcXVldWUgKGBxdWV1ZV9wb3NpdGlvbmApLgAAAAAAAAAAAAANUXVldWVQb3NpdGlvbgAAAAAAAAQAAABDSW5zaWRlIHRoZSBwcm8tcmF0YSBoZWFkIHdpbmRvdyAoYFFVRVVFX1dJTkRPV2AgaWRzIGZyb20gdGhlIGhlYWQpLgAAAAAJaW5fd2luZG93AAAAAAAAAQAAADdMaXZlIHRpY2tldHMgYWhlYWQgb2YgdGhpcyBvbmUgKGhvbGVzIGFyZSBub3QgY291bnRlZCkuAAAAAAVpbmRleAAAAAAAAAQAAAAmU3VtIG9mIGByZW1haW5pbmdgIG92ZXIgdGhvc2UgdGlja2V0cy4AAAAAAApvd2VkX2FoZWFkAAAAAAALAAAAXVRoZSB3YWxrIHN0b3BwZWQgYWZ0ZXIgYE1BWF9QT1NJVElPTl9TQ0FOYCBpZHMsIHNvIGBpbmRleGAgYW5kCmBvd2VkX2FoZWFkYCBhcmUgbG93ZXIgYm91bmRzLgAAAAAAAAl0cnVuY2F0ZWQAAAAAAAAB",
        "AAAAAAAAAC9BZ2VudHMgZXZlciByZWdpc3RlcmVkIChyZW1vdmVkIG9uZXMgaW5jbHVkZWQpLgAAAAALYWdlbnRfY291bnQAAAAAAAAAAAEAAAAE",
        "AAAAAAAAANRNYXJrcyBhIG1hcmtldCdzIGV4cG9zdXJlIGFzIGV4aXRlZCAoYFJPTEVfU0VUVExFYCkuIFB1cmUgYm9va2tlZXBpbmcKKHNlZSBgTWFya2V0RXhwb3N1cmVgKSBmb3IgdGhlIGZ1dHVyZSBleHBvc3VyZSBkYXNoYm9hcmQ7IGl0IGRvZXMgbm90Cm1vdmUgZnVuZHMgb3IgZnJlZSBlaXRoZXIgdGhlIGN1bXVsYXRpdmUgcGVyLW1hcmtldCBjYXAgb3IgbmV0CmhlYWRyb29tLgAAAAtjbG9zZV90cmFkZQAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAB9QZXItY29yZSBjb3VudGVycyAoaXNzdWUgIzMyMCkuAAAAAAtjb3JlX3N0YXR1cwAAAAABAAAAAAAAAARjb3JlAAAAEwAAAAEAAAfQAAAADkNvcmVBY2NvdW50aW5nAAA=",
        "AAAAAAAAAQBVc2FnZSBvdmVyIHRoZSBzbGlkaW5nIHdpbmRvdyBhcyBvZiBub3c6IGBhbW91bnRgIHN1bXMgZXZlcnkgYnVja2V0CnN0aWxsIGNvdW50ZWQgYWdhaW5zdCBgbWF4X2RhaWx5YCwgYGRheV9zdGFydGAgaXMgdGhlIHN0YXJ0IG9mIHRoZQpvbGRlc3Qgb2YgdGhlbS4gU2lkZS1lZmZlY3QgZnJlZSAoaXQgYWR2YW5jZXMgYSBjb3B5KSwgc28gcmVwZWF0ZWQKcmVhZHMgd2l0aG91dCB0cmFkZXMgaW4gYmV0d2VlbiByZXR1cm4gdGhlIHNhbWUgdmFsdWUuAAAAC2RhaWx5X3VzYWdlAAAAAAAAAAABAAAD6QAAB9AAAAAKRGFpbHlVc2FnZQAAAAAAAw==",
        "AAAAAAAAABNgbWF4X25ldF9leHBvc3VyZWAuAAAAAAtnZXRfbmV0X2NhcAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAADRMaXZlIChub3QgcmV0aXJlZCkgbWFya2V0LWNvcmVzIHRoaXMgdHJlYXN1cnkga25vd3MuAAAAC2tub3duX2NvcmVzAAAAAAAAAAABAAAD6gAAABM=",
        "AAAAAAAAAAAAAAALcHJlZGVjZXNzb3IAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAC5bYFRyZWFzdXJ5OjpyZWFsaXplZGBdIGZvciBhIG1hcmtldCBvbiBgY29yZWAuAAAAAAALcmVhbGl6ZWRfb24AAAAAAgAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAH0AAAAAhSZWFsaXplZA==",
        "AAAAAAAAAedSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9ucyBpbiB1cCB0byBgTUFYX0JBVENIYCBtYXJrZXRzIGluIG9uZQpjYWxsIChtYXJrZXQtY29yZSBpc3N1ZSAjMTUpLCBkZWxlZ2F0aW5nIHRvIG1hcmtldC1jb3JlJ3MgYHJlZGVlbV9tYW55YC4KYG1hcmtldF9pZHNgIG11c3QgYmUgc3RyaWN0bHkgYXNjZW5kaW5nOyBtYXJrZXRzIHRoYXQgY2Fubm90IGJlIHBhaWQgb3V0CnJpZ2h0IG5vdyBhcmUgcmVwb3J0ZWQgYXMgc2tpcHBlZCByYXRoZXIgdGhhbiBhYm9ydGluZyB0aGUgYmF0Y2guIFRoZQpzaW5nbGUgYWdncmVnYXRlZCB0b2tlbiB0cmFuc2ZlciBhdCB0aGUgZW5kIGFtb3J0aXplcyBmaXhlZCBwZXItY2FsbApjb3N0cywga2VlcGluZyB0aGUgdHJlYXN1cnkgaW5zaWRlIHRoZSBwZXItdHJhbnNhY3Rpb24gcmVzb3VyY2UgbGltaXRzCmV2ZW4gd2hlbiBpdCBob2xkcyBwb3NpdGlvbnMgaW4gbWFueSBtYXJrZXRzLiAoYFJPTEVfU0VUVExFYC4pAAAAAAtyZWRlZW1fbWFueQAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACm1hcmtldF9pZHMAAAAAA+oAAAAGAAAAAQAAA+kAAAfQAAAAC0JhdGNoUmVzdWx0AAAAAAM=",
        "AAAAAAAAAoxQZXJtaXNzaW9ubGVzcywgaXJyZXZlcnNpYmxlIHJldGlyZW1lbnQgb2YgYSBkcmFpbmVkIGxlZ2FjeSBjb3JlCihpc3N1ZSAjMzIwKS4gUmVxdWlyZXMgdGhlIHBlci1jb3JlIGNvdW50ZXJzIChgaW5pdF9jb3JlX2FjY291bnRpbmdgKSwKYSBsZWdhY3kgY29yZSB0aGF0IGlzIG5vdCBjdXJyZW50IGFuZCBub3QgeWV0IHJldGlyZWQsIGFuZCBubyBpbmRleAplbnRyaWVzIG9yIG9wZW4gZXhwb3N1cmVzIGxlZnQgb24gaXQuIFJlbGVhc2VzIHRoZSBjb3JlJ3MgbmV0IGZyb20KYE5ldFRvdGFsYCAoc28gaXQgc3RvcHMgY291bnRpbmcgYWdhaW5zdCB0aGUgY2FwcyksIGNsZWFycwpgTGVnYWN5Q29yZWAgc28gdGhlIGBsZWdhY3lfKmAgZW50cnlwb2ludHMgcmVmdXNlIGl0LCBhbmQgZHJvcHMgaXQKZnJvbSBgS25vd25Db3Jlc2AuCgpXaGlsZSB0aGUgdHJlYXN1cnkgaXMgcGF1c2VkLCBpbmRleCBlbnRyaWVzIHdob3NlIGNvcmUgY2FuIG5vIGxvbmdlcgpiZSByZWFkIChhIGJyb2tlbiB3YXNtIHRoYXQgd291bGQgb3RoZXJ3aXNlIGZhaWwgYG5hdigpYCBmb3JldmVyKSBhcmUKZHJvcHBlZCBmaXJzdCwgZWFjaCB3aXRoIGFuIGBJbmRleEVudHJ5RHJvcHBlZGAgZXZlbnQuClJldHVybnMgdGhlIG5ldCByZWxlYXNlZCBmcm9tIGBOZXRUb3RhbGAuAAAAC3JldGlyZV9jb3JlAAAAAAEAAAAAAAAABGNvcmUAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAABQAAAAAAAAAAAAAADURyYXdkb3duUGF1c2UAAAAAAAABAAAADmRyYXdkb3duX3BhdXNlAAAAAAADAAAAAAAAAA1yZWFsaXplZF9sb3NzAAAAAAAACwAAAAAAAAAAAAAAEHdpbmRvd19zdGFydF9kYXkAAAAGAAAAAAAAAAAAAAATdHJpZ2dlcmVkX2J5X21hcmtldAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldFNldHRsZWQAAAAAAAABAAAADm1hcmtldF9zZXR0bGVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAIcmVkZWVtZWQAAAALAAAAAAAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAAAAAACnNldHRsZWRfYnkAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkUmVjYWxsZWQAAAAAAAABAAAADnlpZWxkX3JlY2FsbGVkAAAAAAAEAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAZyZWFzb24AAAAAABEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkVmVudWVTZXQAAAAAAAABAAAAD3lpZWxkX3ZlbnVlX3NldAAAAAACAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAADm1heF9hbGxvY2F0aW9uAAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAMRQZXItY29yZSBib29ra2VlcGluZyAoaXNzdWUgIzMyMCksIHN0b3JlZCB1bmRlciBgRGF0YUtleTo6Q29yZVN0YXRlYC4KTWFpbnRhaW5lZCBvbiBldmVyeSBpbmRleCwgZXhwb3N1cmUgYW5kIG5ldCB3cml0ZSBvbmNlCmBpbml0X2NvcmVfYWNjb3VudGluZ2AgaGFzIHJ1biAob3IgZnJvbSBkZXBsb3ltZW50IGZvciBuZXcgdHJlYXN1cmllcykuAAAAAAAAAA5Db3JlQWNjb3VudGluZwAAAAAABAAAACBUaGlzIGNvcmUncyBzaGFyZSBvZiBgTmV0VG90YWxgLgAAAANuZXQAAAAACwAAADlNYXJrZXRzIG9mIHRoaXMgY29yZSB3aG9zZSBgTWFya2V0RXhwb3N1cmUub3BlbmAgaXMgdHJ1ZS4AAAAAAAAOb3Blbl9leHBvc3VyZXMAAAAAAAQAAAAwYE9wZW5NYXJrZXRBdGAgZW50cmllcyB0aGF0IGJlbG9uZyB0byB0aGlzIGNvcmUuAAAACm9wZW5faW5kZXgAAAAAAAQAAAApU2V0IG9uY2UgYnkgYHJldGlyZV9jb3JlYDsgbmV2ZXIgY2xlYXJlZC4AAAAAAAAHcmV0aXJlZAAAAAAB",
        "AAAAAQAAAAAAAAAAAAAADkNyZWF0aW9uUG9saWN5AAAAAAAGAAAAAAAAABJhbGxvd2VkX2NhdGVnb3JpZXMAAAAAAAQAAAAAAAAAFGNyZWF0aW9uX3dpbmRvd19zZWNzAAAABgAAAAAAAAARbWF4X2Nsb3NlX2hvcml6b24AAAAAAAAGAAAAAAAAABZtYXhfbWFya2V0c19wZXJfd2luZG93AAAAAAAEAAAAAAAAAAhtYXhfc2VlZAAAAAsAAAAAAAAAEW1pbl9jbG9zZV9ob3Jpem9uAAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADkRyYXdkb3duU3RhdHVzAAAAAAADAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAd0cmlwcGVkAAAAAAEAAAAAAAAACndpbmRvd19wbmwAAAAAAAs=",
        "AAAAAgAAAAAAAAAAAAAADk1pZ3JhdGlvblBoYXNlAAAAAAAEAAAAAAAAAAAAAAAETm9uZQAAAAAAAAAAAAAACUFubm91bmNlZAAAAAAAAAAAAAAAAAAACU1pZ3JhdGluZwAAAAAAAAAAAAAAAAAACE1pZ3JhdGVk",
        "AAAAAQAAAAAAAAAAAAAADk1pZ3JhdGlvblN0YXRlAAAAAAAGAAAAAAAAAAxhbm5vdW5jZWRfYXQAAAAGAAAAAAAAAAxtYXJrZXRzX2xlZnQAAAAEAAAAAAAAAA1taWdyYXRlX2FmdGVyAAAAAAAABgAAAAAAAAAFcGhhc2UAAAAAAAfQAAAADk1pZ3JhdGlvblBoYXNlAAAAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAAAAAAAEHN1Y2Nlc3Nvcl9zaGFyZXMAAAAL",
        "AAAAAQAAAAAAAAAAAAAADlBlbmRpbmdNYXJrQWdlAAAAAAACAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAHbGVkZ2VycwAAAAAE",
        "AAAAAQAAALxDb2xsYXRlcmFsIHN0aWxsIG93ZWQgdG8gYG93bmVyYCBmb3Igc2hhcmVzIGFscmVhZHkgYnVybmVkLgoKTGF5b3V0IGZyb3plbjogdGlja2V0cyBxdWV1ZWQgYmVmb3JlIHRoZSBkcmFpbi9jYW5jZWwgdXBncmFkZSAoIzI3NykgbXVzdApzdGlsbCBkZWNvZGUuIEV2ZXJ5dGhpbmcgbmV3IGxpdmVzIGluIFtgVGlja2V0TWV0YWBdLgAAAAAAAAAOV2l0aGRyYXdUaWNrZXQAAAAAAAMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAJcmVtYWluaW5nAAAAAAAACw==",
        "AAAAAAAAARdgYWdlbnRfYnV5YCB3aXRoIGEgcGVyLXNoYXJlIGxpbWl0IHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCwgMCA9IG5vbmUpCmFuZCBhIGRlYWRsaW5lICh1bml4IHNlY29uZHMsIG5ldHdvcmsgdGltZSkuIG1hcmtldC1jb3JlJ3MgYGJ1eV92MmAKZW5mb3JjZXMgYm90aDsgYW4gZXhwaXJlZCBvciBvdXQtb2YtbGltaXQgdHJhZGUgcmV2ZXJ0cyB0aGUgd2hvbGUKaW52b2NhdGlvbiwgc28gdGhlIHRyZWFzdXJ5J3MgY2FwcyBhcmUgbmV2ZXIgY29uc3VtZWQgYnkgYSByZXZlcnRlZAp0cmFkZS4AAAAADGFnZW50X2J1eV92MgAAAAcAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAAAAAAAD2xpbWl0X3ByaWNlX2JwcwAAAAAEAAAAAAAAAAhkZWFkbGluZQAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAMY2FuY2VsX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMY29uZmlnX2RlbGF5AAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMbWlncmF0ZV9pZGxlAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAJBDYXBpdGFsIGN1cnJlbnRseSBkZXBsb3llZCBhY3Jvc3MgYWxsIG1hcmtldHM6CmBzdW0obWF4KDAsIGNvbGxhdGVyYWxfaW4gLSBjb2xsYXRlcmFsX291dCkpYCwgdGhlIGZpZ3VyZQpgbWF4X25ldF9leHBvc3VyZWAgaXMgZW5mb3JjZWQgYWdhaW5zdC4AAAAMbmV0X2V4cG9zdXJlAAAAAAAAAAEAAAAL",
        "AAAAAAAAADdOZXQgcG9zaXRpb24gaW4gYG1hcmtldF9pZGAgb2YgdGhlIGN1cnJlbnQgbWFya2V0LWNvcmUuAAAAAAxuZXRfcG9zaXRpb24AAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAC05ldFBvc2l0aW9uAAAAAAM=",
        "AAAAAAAAAERUaGUgdGlja2V0IGBjbGFpbV93aXRoZHJhd2AgcGF5cyBuZXh0LCBhbmQgdGhlIGlkIHRoZSBuZXh0IG9uZSBnZXRzLgAAAAxxdWV1ZV9ib3VuZHMAAAAAAAAAAQAAA+0AAAACAAAABgAAAAY=",
        "AAAAAAAAAAAAAAAMcmVmcmVzaF9tYXJrAAAAAQAAAAAAAAAKbWFya2V0X2lkcwAAAAAD6gAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAJpEZWFjdGl2YXRlcyBgYWdlbnRgIGF0IG9uY2UsIGtlZXBpbmcgaXRzIHVzYWdlIGhpc3RvcnkuIEF0IGxlYXN0IG9uZQphY3RpdmUgYWdlbnQgd2l0aCBgUk9MRV9TRVRUTEVgIG11c3QgcmVtYWluLCBzbyBvcGVuIHBvc2l0aW9ucyBjYW4KYWx3YXlzIGJlIHNldHRsZWQuAAAAAAAMcmVtb3ZlX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMdG90YWxfc2hhcmVzAAAAAAAAAAEAAAAL",
        "AAAAAAAAAAAAAAAMdHJhY2VfcG9saWN5AAAAAAAAAAEAAAfQAAAAEVRyYWNlUG9saWN5Q29uZmlnAAAA",
        "AAAABQAAAAAAAAAAAAAADkFnZW50UG9saWN5U2V0AAAAAAABAAAAEGFnZW50X3BvbGljeV9zZXQAAAAEAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0RlbGF5U2V0AAAAAAABAAAAEGNvbmZpZ19kZWxheV9zZXQAAAACAAAAAAAAAANvbGQAAAAABgAAAAAAAAAAAAAAA25ldwAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0V4ZWN1dGVkAAAAAAABAAAAD2NvbmZpZ19leGVjdXRlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAOmB0cnVlYCBmb3IgYSB0aWdodGVuLW9ubHkgY2hhbmdlIGFwcGxpZWQgYXQgcHJvcG9zYWwgdGltZS4AAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ1Byb3Bvc2VkAAAAAAABAAAAD2NvbmZpZ19wcm9wb3NlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlBubFdpbmRvd1Jlc2V0AAAAAAABAAAAEHBubF93aW5kb3dfcmVzZXQAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlByaWNlUG9saWN5U2V0AAAAAAABAAAAEHByaWNlX3BvbGljeV9zZXQAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADllpZWxkQWxsb2NhdGVkAAAAAAABAAAAD3lpZWxkX2FsbG9jYXRlZAAAAAADAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAD01pZ3JhdGlvblBhY2tldAAAAAAKAAAAAAAAAARjb3JlAAAAEwAAAAAAAAAPZXhwb3N1cmVfYW1vdW50AAAAAAsAAAAAAAAAC2Zsb29yX3ZhbHVlAAAAAAsAAAAAAAAAAmxwAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAANuZXQAAAAH0AAAAAtOZXRQb3NpdGlvbgAAAAAAAAAAAm5vAAAAAAALAAAAAAAAAANwbmwAAAAH0AAAAAlNYXJrZXRQbmwAAAAAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAAAAAADeWVzAAAAAAs=",
        "AAAAAAAAAY1SZWdpc3RlcnMgYGFnZW50YCBhcyB0aGUgZmlyc3QgYWdlbnQgd2l0aCBldmVyeSByb2xlIGFuZCB0aGUgZ2xvYmFsCmNhcHMgYXMgaXRzIG93bi4gYG1heF9uZXRfZXhwb3N1cmVgIGNhcHMgY2FwaXRhbCBkZXBsb3llZCBpbiBvcGVuCnBvc2l0aW9ucyBhY3Jvc3MgYWxsIG1hcmtldHMgYXQgb25jZSAoc2VlIGBuZXRfZXhwb3N1cmVgKTsgaXQgbXVzdCBiZQphdCBsZWFzdCBgbWF4X3RyYWRlYC4gYGNvbmZpZ19kZWxheWAgKHNlY29uZHMsIGF0IGxlYXN0CmBNSU5fQ09ORklHX0RFTEFZYCkgaXMgdGhlIHRpbWVsb2NrIG9uIGV2ZXJ5IGxvb3NlbmluZyBjaGFuZ2UuCgpBbnkgY29sbGF0ZXJhbCB0aGUgdHJlYXN1cnkgYWxyZWFkeSBob2xkcyBpcyBtaW50ZWQgYXMgc2hhcmVzIHRvCmBhZG1pbmAuAAAAAAAADV9fY29uc3RydWN0b3IAAAAAAAAMAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACwAAAAAAAAAKbWF4X21hcmtldAAAAAAACwAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAQbWF4X25ldF9leHBvc3VyZQAAAAsAAAAAAAAADGNvbmZpZ19kZWxheQAAAAYAAAAAAAAADG1heF9kcmF3ZG93bgAAAAsAAAAAAAAAC3dpbmRvd19kYXlzAAAAAAQAAAAAAAAAD2NyZWF0aW9uX3BvbGljeQAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAA",
        "AAAAAAAAAKJgYWdlbnRfc2VsbGAgd2l0aCBhIHBlci1zaGFyZSBsaW1pdCBwcmljZSAoYGxpbWl0X3ByaWNlX2Jwc2AsIDAgPSBubwpsaW1pdCkgYW5kIGEgZGVhZGxpbmUgKHVuaXggc2Vjb25kcywgbmV0d29yayB0aW1lKSwgYm90aCBlbmZvcmNlZCBieQptYXJrZXQtY29yZSdzIGBzZWxsX3YyYC4AAAAAAA1hZ2VudF9zZWxsX3YyAAAAAAAABwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAANY2FuY2VsX2NvbmZpZwAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANZGlzYWJsZV95aWVsZAAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAGhBcHBsaWVzIGBhZ2VudGAncyBwZW5kaW5nIHBvbGljeSBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLgpQZXJtaXNzaW9ubGVzczogdGhlIGRlbGF5IGlzIHRoZSBwcm90ZWN0aW9uLgAAAA1leGVjdXRlX2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIJgcmVkZWVtYCBhZ2FpbnN0IGEgbWFya2V0LWNvcmUgdGhpcyB0cmVhc3VyeSB3YXMgc3dpdGNoZWQgYXdheSBmcm9tCihzZWUgYGV4ZWN1dGVfY29uZmlnYCksIHNvIHBvc2l0aW9ucyB0aGVyZSBhcmUgbmV2ZXIgc3RyYW5kZWQuAAAAAAANbGVnYWN5X3JlZGVlbQAAAAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAADBbYFRyZWFzdXJ5OjptYXJrZXRfcG5sYF0gZm9yIGEgbWFya2V0IG9uIGBjb3JlYC4AAAANbWFya2V0X3BubF9vbgAAAAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAJTWFya2V0UG5sAAAA",
        "AAAAAAAAAAAAAAANbWlncmF0ZV9tYXJrcwAAAAAAAAIAAAAAAAAABXN0YXJ0AAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAAAAAAANcGVuZGluZ19hZ2VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPoAAAH0AAAAAxQZW5kaW5nQWdlbnQ=",
        "AAAAAAAAAJVQZXJtaXNzaW9ubGVzcyBzZXR0bGVtZW50IG9mIGEgcmVzb2x2ZWQgb3Igdm9pZGVkIG1hcmtldCdzIHBvc2l0aW9uIGFuZCBMUCByZW1haW5kZXIuCk9wZXJhdGVzIGV2ZW4gd2hlbiB0aGUgdHJlYXN1cnkgaXMgcGF1c2VkLiBJZGVtcG90ZW50IG9uIHJldHJ5LgAAAAAAAA1zZXR0bGVfbWFya2V0AAAAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAEFNldHRsZW1lbnRSZXBvcnQAAAAD",
        "AAAAAAAAAQBSZWRlZW1zIGEgc3RyYXkgcG9zaXRpb24gdGhhdCByZWFjaGVkIHRoZSB0cmVhc3VyeSBvbiBhIHJldGlyZWQgY29yZQooZS5nLiB0aHJvdWdoIG1hcmtldC1jb3JlJ3MgYHRyYW5zZmVyX3Bvc2l0aW9uYCkgc3RyYWlnaHQgaW50byBpZGxlLgpQZXJtaXNzaW9ubGVzcy4gU2tpcHMgaW5kZXgsIG5ldCBhbmQgUG5MIGJvb2trZWVwaW5nOiB0aGUgY29sbGF0ZXJhbApzaW1wbHkgbGFuZHMgaW4gaWRsZSBhbmQgaXMgY291bnRlZCBmcm9tIHRoZW4gb24uAAAADXN3ZWVwX3JldGlyZWQAAAAAAAACAAAAAAAAAARjb3JlAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAAD0NvbmZpZ0NhbmNlbGxlZAAAAAABAAAAEGNvbmZpZ19jYW5jZWxsZWQAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAABFUaGUgYWN0aW5nIGFnZW50LgAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAxtYXJrZXRfdG90YWwAAAALAAAAAAAAAAAAAAALZGFpbHlfdG90YWwAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAAEENhcGl0YWxCcmVha2Rvd24AAAADAAAAAAAAAAZsaXF1aWQAAAAAAAsAAAAAAAAAD3lpZWxkX3ByaW5jaXBhbAAAAAALAAAAAAAAAAt5aWVsZF92YWx1ZQAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEFNldHRsZW1lbnRSZXBvcnQAAAADAAAAAAAAAA9hbHJlYWR5X3NldHRsZWQAAAAAAQAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAIcmVkZWVtZWQAAAAL",
        "AAAAAAAAAkVQZXJtaXNzaW9ubGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgcXVldWUgZHJhaW4gKGBkcmFpbl9xdWV1ZWApOgpwYXlzIHF1ZXVlZCB0aWNrZXRzIGZyb20gaWRsZSBjb2xsYXRlcmFsLCBwcm8gcmF0YSBhY3Jvc3MgdGhlCmBRVUVVRV9XSU5ET1dgIGhlYWQgd2luZG93LCByZWFkaW5nIGF0IG1vc3QgYE1BWF9RVUVVRV9TVEVQU2AgaWRzLgpUaGUgbW9uZXkgYWx3YXlzIGdvZXMgdG8gZWFjaCB0aWNrZXQncyBvd25lci4gYHRpY2tldF9pZGAgbXVzdCBuYW1lCmEgbGl2ZSB0aWNrZXQgKGBUaWNrZXROb3RGb3VuZGApOyByZXR1cm5zIHRoZSB0b3RhbCBwYWlkIGFjcm9zcyBhbGwKdGlja2V0cywgb3IgYE5vdGhpbmdUb1BheWAgd2hlbiB0aGUgZHJhaW4gbWFkZSBubyBwcm9ncmVzcy4KCkEgY2FsbCB0aGF0IG9ubHkgbW92ZWQgdGhlIGhlYWQgcGFzdCBhIHJ1biBvZiBob2xlcyBwYXlzIG5vdGhpbmcgYnV0CnJldHVybnMgYE9rKDApYDogZmFpbGluZyB3b3VsZCByZXZlcnQgdGhlIGhlYWQgbW92ZSBhbmQgbGV0IGEgbG9uZwpydW4gb2YgY2FuY2VsbGVkIHRpY2tldHMgc3RhbGwgYGNsYWltX3dpdGhkcmF3YCBmb3JldmVyLgAAAAAAAA5jbGFpbV93aXRoZHJhdwAAAAAAAQAAAAAAAAAJdGlja2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAOY3JlYXRpb25fdXNhZ2UAAAAAAAAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAHNIb3cgbXVjaCBtb3JlIHRoZSBhZ2VudHMgdG9nZXRoZXIgbWF5IGRlcGxveSByaWdodCBub3cgYmVmb3JlCmBtYXhfZGFpbHlgIChgbWF4X2RhaWx5IC0gd2luZG93IHN1bWAsIGZsb29yZWQgYXQgMCkuAAAAAA5kYWlseV9oZWFkcm9vbQAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAcpBcHBsaWVzIHRoZSBwZW5kaW5nIGNvbmZpZyBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLiBQZXJtaXNzaW9ubGVzcywKc28gZXhlY3V0aW9uIG5ldmVyIGRlcGVuZHMgb24gdGhlIGFkbWluIGJlaW5nIGF2YWlsYWJsZS4KCkEgYG1hcmtldF9jb3JlYCBjaGFuZ2UgcmVjb3JkcyB0aGUgb2xkIGNvcmUgYXMgbGVnYWN5OiBpdHMgcG9zaXRpb25zCnN0YXkgd2hlcmUgdGhleSBhcmUgKHJlY292ZXIgdGhlbSB3aXRoIGBsZWdhY3lfcmVkZWVtYCAvCmBsZWdhY3lfY2xhaW1fcG9vbF9yZW1haW5kZXJgKSwgYW5kIGV4cG9zdXJlIGZvciB0aGUgbmV3IGNvcmUgaXMga2VwdAp1bmRlciBrZXlzIG5hbWVzcGFjZWQgYnkgY29yZSBzbyBtYXJrZXQgaWRzIGNhbm5vdCBjb2xsaWRlLiBUaGUgbmV3CmNvcmUgbXVzdCBiZSBwb2ludGVkIGF0IHRoaXMgdHJlYXN1cnkgd2l0aCBpdHMgb3duIGBzZXRfdHJlYXN1cnlgLgAAAAAADmV4ZWN1dGVfY29uZmlnAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADhMaXF1aWQgY29sbGF0ZXJhbCBiYWxhbmNlIGhlbGQgZGlyZWN0bHkgaW4gdGhlIHRyZWFzdXJ5LgAAAA5saXF1aWRfY2FwaXRhbAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAOb3Blbl9tYXJrZXRfYXQAAAAAAAEAAAAAAAAAAWkAAAAAAAAEAAAAAQAAA+gAAAfQAAAACk9wZW5NYXJrZXQAAA==",
        "AAAAAAAAAAAAAAAOcGVuZGluZ19jb25maWcAAAAAAAAAAAABAAAD6AAAB9AAAAANUGVuZGluZ0NvbmZpZwAAAA==",
        "AAAAAAAAAKdQcm9wb3NlcyBgY29uZmlnYCBhcyB0aGUgZ2xvYmFsIGNvbmZpZyAoYWRtaW4pLiBUaWdodGVuLW9ubHkKcHJvcG9zYWxzIGFwcGx5IGF0IG9uY2UgYW5kIGxlYXZlIGFueSBwZW5kaW5nIHByb3Bvc2FsIGFuZCBpdHMgdGltZXIKYXMgdGhleSBhcmU7IGFueXRoaW5nIGVsc2UgaXMgcXVldWVkLgAAAAAOcHJvcG9zZV9jb25maWcAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAxHbG9iYWxDb25maWcAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAI1Qb3NpdGlvbiBvZiBgdGlja2V0X2lkYCBpbiB0aGUgcXVldWUsIG9yIGBOb25lYCBpZiBpdCBpcyBub3QgbGl2ZS4KV2Fsa3MgYXQgbW9zdCBgTUFYX1BPU0lUSU9OX1NDQU5gIGlkcyBhaGVhZCBvZiBpdCAoYHRydW5jYXRlZGAKb3RoZXJ3aXNlKS4AAAAAAAAOcXVldWVfcG9zaXRpb24AAAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAANUXVldWVQb3NpdGlvbgAAAA==",
        "AAAAAAAAAD5Db2xsYXRlcmFsIG93ZWQgdG8gcXVldWVkIHdpdGhkcmF3YWxzOyBhZ2VudHMgY2Fubm90IHNwZW5kIGl0LgAAAAAADnF1ZXVlX3Jlc2VydmVkAAAAAAAAAAAAAQAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAEVRyYWNlUG9saWN5Q29uZmlnAAAAAAAAAgAAAAAAAAAVbWF4X3RyYWNlX2FnZV9sZWRnZXJzAAAAAAAABAAAAAAAAAAGcG9saWN5AAAAAAfQAAAAC1RyYWNlUG9saWN5AA==",
        "AAAAAAAAAAAAAAAPYmVnaW5fbWlncmF0aW9uAAAAAAEAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAftDYW5jZWxzIGB0aWNrZXRfaWRgIGFuZCByZS1taW50cyBzaGFyZXMgZm9yIHdoYXQgaXQgaXMgc3RpbGwgb3dlZC4KClNoYXJlcyBtaW50ZWQgPSBgbWluKHNoYXJlc19mb3JfZGVwb3NpdChyZW1haW5pbmcsIG5hdiwgc3VwcGx5KSwKZmxvb3Ioc2hhcmVzX2J1cm5lZCAqIHJlbWFpbmluZyAvIGFzc2V0c19hdF9yZXF1ZXN0KSlgOiBhZnRlciBhIE5BVgpsb3NzIHRoZSBvd25lciBjYW5ub3QgZ2V0IGJhY2sgbW9yZSBzaGFyZXMgdGhhbiB3ZXJlIGJ1cm5lZCBmb3IgdGhlCnNhbWUgYXNzZXRzOyBhZnRlciBhIGdhaW4gdGhleSBnZXQgZmV3ZXIgc2hhcmVzIGF0IHRoZSBoaWdoZXIgTkFWLgpFaXRoZXIgd2F5IHJlcXVlc3QtdGhlbi1jYW5jZWwgbmV2ZXIgcHJvZml0cyBhdCB0aGUgZXhwZW5zZSBvZiBvdGhlcgpzaGFyZWhvbGRlcnMuIFRoZSByZXNlcnZhdGlvbiBpcyByZWxlYXNlZCAqYmVmb3JlKiBOQVYgaXMgcmVhZCwKYmVjYXVzZSBOQVYgc3VidHJhY3RzIGBRdWV1ZVJlc2VydmVkYC4AAAAAD2NhbmNlbF93aXRoZHJhdwAAAAACAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAPZHJhd2Rvd25fc3RhdHVzAAAAAAAAAAABAAAD6QAAB9AAAAAORHJhd2Rvd25TdGF0dXMAAAAAAAM=",
        "AAAAAAAAAOFSZWNvcmRzIGEgZGF0YS1zcGVuZCBvZiBgYW1vdW50YCBzdHJvb3BzIGZvciBgYWdlbnRgLgpUaGUgYWdlbnQgbXVzdCBiZSBhY3RpdmUsIGl0cyBgRGF0YUJ1ZGdldGAgbXVzdCBiZSBhY3RpdmUsIGFuZCB0aGUKZGVkdWN0aW9uIG11c3Qgbm90IGV4Y2VlZCB0aGUgcGVyLWFnZW50IGRhaWx5IGNhcC4KT25seSB0aGUgYnVkZ2V0J3MgcmVnaXN0ZXJlZCBgYWNjb3VudGAgbWF5IGNhbGwgdGhpcy4AAAAAAAAPZnVuZF9kYXRhX3NwZW5kAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAPbWlncmF0ZV9tYXJrZXRzAAAAAAEAAAAAAAAACm1hcmtldF9pZHMAAAAAA+oAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAPbWlncmF0aW9uX3N0YXRlAAAAAAAAAAABAAAD6AAAB9AAAAAOTWlncmF0aW9uU3RhdGUAAA==",
        "AAAAAAAAAJJQcm9wb3NlcyBhIG5ldyBgRGF0YUJ1ZGdldGAgZm9yIGBhZ2VudGAsIHN1YmplY3QgdG8gdGhlIGNvbmZpZyB0aW1lbG9jay4KQWRtaW4gb25seS4gVGhlIGJ1ZGdldCB0YWtlcyBlZmZlY3Qgb25jZSBgZXhlY3V0ZV9kYXRhX2J1ZGdldGAgaXMgY2FsbGVkLgAAAAAAD3NldF9kYXRhX2J1ZGdldAAAAAADAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1heF9kYWlseQAAAAAAAAsAAAAAAAAAB2FjY291bnQAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPc2V0X3lpZWxkX3ZlbnVlAAAAAAIAAAAAAAAABHBvb2wAAAATAAAAAAAAAA5tYXhfYWxsb2NhdGlvbgAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPdHJhbnNmZXJfc2hhcmVzAAAAAAMAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAENNb3ZlcyBgdGlja2V0X2lkYCAoYW5kIGl0cyBjYW5jZWxsYXRpb24gcmlnaHQpIGZyb20gYGZyb21gIHRvIGB0b2AuAAAAAA90cmFuc2Zlcl90aWNrZXQAAAAAAwAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAnRvAAAAAAATAAAAAAAAAAl0aWNrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAPd2l0aGRyYXdfdGlja2V0AAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAAOV2l0aGRyYXdUaWNrZXQAAA==",
        "AAAABQAAAFcjMzIwOiBgcmV0aXJlX2NvcmVgLCB3aGlsZSBwYXVzZWQsIGRyb3BwZWQgYW4gaW5kZXggZW50cnkgd2hvc2UgY29yZQpjb3VsZCBub3QgYmUgcmVhZC4AAAAAAAAAABFJbmRleEVudHJ5RHJvcHBlZAAAAAAAAAEAAAATaW5kZXhfZW50cnlfZHJvcHBlZAAAAAACAAAAAAAAAARjb3JlAAAAEwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEU1hcmtldE1pZ3JhdGVkT3V0AAAAAAAAAQAAABNtYXJrZXRfbWlncmF0ZWRfb3V0AAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZwYWNrZXQAAAAAB9AAAAAPTWlncmF0aW9uUGFja2V0AAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEU1pZ3JhdGlvblJlY2VpdmVkAAAAAAAAAQAAABJtaWdyYXRpb25fcmVjZWl2ZWQAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAtwcmVkZWNlc3NvcgAAAAATAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAMBBIGRyYWluIGhpdCBhbiBhcml0aG1ldGljIG92ZXJmbG93IGFuZCBzdG9wcGVkOyB0aGUgZW50cnlwb2ludCB0aGF0CmJyb3VnaHQgdGhlIHByb2NlZWRzIHN0aWxsIHN1Y2NlZWRlZCAoc2V0dGxlbWVudCBuZXZlciBmYWlscyBiZWNhdXNlIG9mCnRoZSBxdWV1ZSkuIGBwYWlkYCBpcyB3aGF0IHdhcyBwYWlkIGJlZm9yZSB0aGUgc3RvcC4AAAAAAAAAEVF1ZXVlRHJhaW5Ta2lwcGVkAAAAAAAAAQAAABNxdWV1ZV9kcmFpbl9za2lwcGVkAAAAAAEAAAAAAAAABHBhaWQAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEVRpY2tldFRyYW5zZmVycmVkAAAAAAAAAQAAABJ0aWNrZXRfdHJhbnNmZXJyZWQAAAAAAAMAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAARmcm9tAAAAEwAAAAAAAAAAAAAAAnRvAAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAGlgY2FuY2VsX3dpdGhkcmF3YDogdGhlIHRpY2tldCdzIGBhc3NldHNgIHdlbnQgYmFjayBpbnRvIHRoZSB2YXVsdCBhbmQKYHNoYXJlc2Agd2VyZSByZS1taW50ZWQgdG8gYG93bmVyYC4AAAAAAAAAAAAAEVdpdGhkcmF3Q2FuY2VsbGVkAAAAAAAAAQAAABJ3aXRoZHJhd19jYW5jZWxsZWQAAAAAAAQAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAAZhc3NldHMAAAAAAAsAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEVdpdGhkcmF3UmVxdWVzdGVkAAAAAAAAAQAAABJ3aXRoZHJhd19yZXF1ZXN0ZWQAAAAAAAUAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFzc2V0cwAAAAAACwAAAAAAAAAAAAAACHBhaWRfbm93AAAACwAAAAAAAAAjMCB3aGVuIGV2ZXJ5dGhpbmcgd2FzIHBhaWQgYXQgb25jZS4AAAAACXRpY2tldF9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAElBlbmRpbmdQcmljZVBvbGljeQAAAAAAAwAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAABnBvbGljeQAAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAY=",
        "AAAAAAAAAD1CdXlzIHdpdGggYSBwcmlvciBkZWNpc2lvbi1iZWFyaW5nIHRyYWNlIGNvbnN1bWVkIGF0b21pY2FsbHkuAAAAAAAAEGFnZW50X2J1eV90cmFjZWQAAAAIAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAQY2FuY2VsX21pZ3JhdGlvbgAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAXxSb3VnaCB1bmxvY2sgdGltZSBmb3IgYHRpY2tldF9pZGA6IG5vdyBpZiB0aGUgY29sbGF0ZXJhbCBhbHJlYWR5CmhlbGQgZm9yIHRoZSBxdWV1ZSBjb3ZlcnMgaXQ7IG90aGVyd2lzZSB0aGUgY2xvc2UgdGltZSBvZiB0aGUgb3BlbgptYXJrZXQgd2hvc2Ugc2V0dGxlbWVudCAoZmxvb3IgdmFsdWUsIGluIGNsb3NlLXRpbWUgb3JkZXIpIGZpcnN0CmNvdmVycyBgb3dlZF9haGVhZCArIHJlbWFpbmluZ2AuIGBOb25lYCBpZiB0aGUgdGlja2V0IGlzIG5vdCBsaXZlIG9yCnRoZSBvcGVuIG1hcmtldHMgY2Fubm90IGNvdmVyIGl0LiBBbiBlc3RpbWF0ZSBvbmx5OiBpdCBpZ25vcmVzIG5ldwpkZXBvc2l0cywgdHJhZGluZyBhbmQgbWFya2V0IHJlc29sdXRpb24gZGVsYXlzLgAAABBlc3RpbWF0ZWRfdW5sb2NrAAAAAQAAAAAAAAAJdGlja2V0X2lkAAAAAAAABgAAAAEAAAPoAAAABg==",
        "AAAAAAAAAAAAAAAQZ2V0X3ByaWNlX3BvbGljeQAAAAAAAAABAAAH0AAAAAtQcmljZVBvbGljeQA=",
        "AAAAAAAAALZDb25zZXJ2YXRpdmUgdmFsdWF0aW9uIG9mIHRoZSB0cmVhc3VyeSdzIGhvbGRpbmdzIGluIGBtYXJrZXRfaWRgCihzZWUgW2BWYWx1YXRpb25gXSkuIFR3byBjcm9zcy1jb250cmFjdCByZWFkcyAoYGdldF9tYXJrZXRgLApgZ2V0X3Bvc2l0aW9uYCk7IGEgdmlldyBvbmx5LCBuZXZlciBvbiB0aGUgdHJhZGluZyBwYXRoLgAAAAAAEG1hcmtldF92YWx1YXRpb24AAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAACVZhbHVhdGlvbgAAAAAAAAM=",
        "AAAAAAAAAVxCdXJucyBgc2hhcmVzYCBvZiBgb3duZXJgIGF0IHRoZSBjdXJyZW50IE5BViwgcGF5cyB3aGF0IGZyZWUgaWRsZQpjb2xsYXRlcmFsIGFsbG93cyBub3cgYW5kIHF1ZXVlcyB0aGUgcmVzdCBhcyBhIHRpY2tldC4gUXVldWVkIHRpY2tldHMKYXJlIHBhaWQgYXV0b21hdGljYWxseSBieSBldmVyeSB0cmFuc2FjdGlvbiB0aGF0IGJyaW5ncyBjb2xsYXRlcmFsIGluCihgZHJhaW5fcXVldWVgLCAjMjc3KSwgcHJvIHJhdGEgd2l0aGluIHRoZSBgUVVFVUVfV0lORE9XYCBoZWFkCndpbmRvdy4gUmV0dXJucyBgKHBhaWRfbm93LCB0aWNrZXRfaWQpYCwgYHRpY2tldF9pZGAgMCB3aGVuIG5vdGhpbmcKd2FzIHF1ZXVlZC4AAAAQcmVxdWVzdF93aXRoZHJhdwAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAA+kAAAPtAAAAAgAAAAsAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAQcmVzZXRfcG5sX3dpbmRvdwAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAKlMZW5ndGhlbnMgdGhlIHRpbWVsb2NrLiBTaG9ydGVuaW5nIGlzIHJlZnVzZWQgb3V0cmlnaHQ6IGl0IHdvdWxkCml0c2VsZiBoYXZlIHRvIHdhaXQgb3V0IHRoZSBvbGQgZGVsYXkgdG8gYmUgc2FmZSwgYW5kIGEgbGVuZ3RoZW5pbmcKY2FuIGFsd2F5cyBiZSB1bmRvbmUgYnkgcmVkZXBsb3lpbmcuAAAAAAAAEHNldF9jb25maWdfZGVsYXkAAAABAAAAAAAAAAluZXdfZGVsYXkAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAQc2V0X21heF9tYXJrX2FnZQAAAAEAAAAAAAAAB2xlZGdlcnMAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAMFTZXRzIHRoZSBwcmljZSBsaW1pdHMgb24gYWdlbnQgdHJhZGVzIChhZG1pbikuIExpa2UgdGhlIGNhcHMsCnRpZ2h0ZW5pbmcgKGxvd2VyIGBtYXhfYnV5YC9gbWF4X2ltcGFjdGAvYG1heF9zbGlwcGFnZWAsIGhpZ2hlcgpgbWluX3NlbGxgKSBhcHBsaWVzIGF0IG9uY2UgYW5kIGFueXRoaW5nIGVsc2Ugd2FpdHMgYGNvbmZpZ19kZWxheWAuAAAAAAAAEHNldF9wcmljZV9wb2xpY3kAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALUHJpY2VQb2xpY3kAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAZhbYFRyZWFzdXJ5OjpzZXR0bGVfbWFya2V0YF0gYWdhaW5zdCBhbnkga25vd24gY29yZSAoaXNzdWUgIzMyMCk6IHRoZQpjdXJyZW50IG9uZSBvciBhIGxlZ2FjeSBjb3JlIHRoaXMgdHJlYXN1cnkgd2FzIHN3aXRjaGVkIGF3YXkgZnJvbS4KUmVzdHJpY3RlZCB0byBrbm93biBjb3JlcyBiZWNhdXNlIGl0IGNhbGxzIGludG8gYGNvcmVgLiBBIG1hcmtldCB0aGF0Cm1hcmtldC1jb3JlIGFscmVhZHkgZmluYWxpemVkIChgUmVkZW1wdGlvbkNsb3NlZGApIGhhcyBub3RoaW5nIGxlZnQKdG8gY29sbGVjdCwgc28gaXRzIGV4cG9zdXJlIGlzIGNsb3NlZCBhbmQgaXRzIGluZGV4IGVudHJ5IHJlbW92ZWQ7Cm90aGVyd2lzZSBhIGZpbmFsaXplZCBsZWdhY3kgbWFya2V0IHdvdWxkIGJsb2NrIHJldGlyZW1lbnQgZm9yZXZlci4AAAAQc2V0dGxlX21hcmtldF9vbgAAAAMAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAQU2V0dGxlbWVudFJlcG9ydAAAAAM=",
        "AAAAAAAAAD5QYXJ0IG9mIGBOZXRUb3RhbGAgdGhlIGJhY2tmaWxsIGNvdWxkIG5vdCBhdHRyaWJ1dGUgdG8gYSBjb3JlLgAAAAAAEHVuYXR0cmlidXRlZF9uZXQAAAAAAAAAAQAAAAs=",
        "AAAABQAAAAAAAAAAAAAAEkVtZXJnZW5jeVdpdGhkcmF3bgAAAAAAAQAAABNlbWVyZ2VuY3lfd2l0aGRyYXduAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEk1pZ3JhdGlvbkFubm91bmNlZAAAAAAAAQAAABNtaWdyYXRpb25fYW5ub3VuY2VkAAAAAAIAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAAAAAAAAAAAAA1taWdyYXRlX2FmdGVyAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEk1pZ3JhdGlvbkNhbmNlbGxlZAAAAAAAAQAAABNtaWdyYXRpb25fY2FuY2VsbGVkAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEk1pZ3JhdGlvbkNvbXBsZXRlZAAAAAAAAQAAABNtaWdyYXRpb25fY29tcGxldGVkAAAAAAMAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAD5OZXQgZXhwb3N1cmUgYWZ0ZXIgYW55IHRyZWFzdXJ5IG1vbmV5IG1vdmVtZW50IGluIGBtYXJrZXRfaWRgLgAAAAAAAAAAABJOZXRFeHBvc3VyZVVwZGF0ZWQAAAAAAAEAAAAUbmV0X2V4cG9zdXJlX3VwZGF0ZWQAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAKbmV0X21hcmtldAAAAAAACwAAAAAAAAAAAAAACW5ldF90b3RhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAERgYWdlbnRgJ3Mgb3duIHNsaWRpbmctd2luZG93IHVzYWdlLCBjb3VudGVkIGFnYWluc3QgaXRzIGBtYXhfZGFpbHlgLgAAABFhZ2VudF9kYWlseV91c2FnZQAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAH0AAAAApEYWlseVVzYWdlAAAAAAAD",
        "AAAAAAAAAD5TZWxscyB3aXRoIGEgcHJpb3IgZGVjaXNpb24tYmVhcmluZyB0cmFjZSBjb25zdW1lZCBhdG9taWNhbGx5LgAAAAAAEWFnZW50X3NlbGxfdHJhY2VkAAAAAAAACAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAARYWxsb2NhdGVfdG9feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAE5Ub3RhbCBjYXBpdGFsIGRlcGxveWFibGU6IGxpcXVpZCBjb2xsYXRlcmFsIGJhbGFuY2UgcGx1cyBzdXBwbGllZCB5aWVsZCB2YWx1ZS4AAAAAABFhdmFpbGFibGVfY2FwaXRhbAAAAAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAE5CcmVha2Rvd24gb2YgdHJlYXN1cnkgY2FwaXRhbCBhY3Jvc3MgbGlxdWlkLCB5aWVsZCBwcmluY2lwYWwsIGFuZCB5aWVsZCB2YWx1ZS4AAAAAABFjYXBpdGFsX2JyZWFrZG93bgAAAAAAAAAAAAABAAAD6QAAB9AAAAAQQ2FwaXRhbEJyZWFrZG93bgAAAAM=",
        "AAAAAAAAAAAAAAARZXhpdF90b19zdWNjZXNzb3IAAAAAAAACAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAARbWlncmF0aW9uX3ZlcnNpb24AAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAARb3Blbl9tYXJrZXRfY291bnQAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAARcmVjYWxsX2Zyb21feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARcmVjZWl2ZV9taWdyYXRpb24AAAAAAAACAAAAAAAAAAtwcmVkZWNlc3NvcgAAAAATAAAAAAAAAAZwYWNrZXQAAAAAB9AAAAAPTWlncmF0aW9uUGFja2V0AAAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAAE0FnZW50UG9saWN5UHJvcG9zZWQAAAAAAQAAABVhZ2VudF9wb2xpY3lfcHJvcG9zZWQAAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1ByaWNlUG9saWN5UHJvcG9zZWQAAAAAAQAAABVwcmljZV9wb2xpY3lfcHJvcG9zZWQAAAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAAAAAAAIhUaGUgc3VjY2Vzc29yIGFkbWluIHJlY29yZHMgdGhlIG9sZCB2YXVsdCBiZWZvcmUgdGhlIG9sZCB2YXVsdCBjYW4KYW5ub3VuY2UuIFRoaXMgcHJldmVudHMgYSBzdWNjZXNzb3IgZnJvbSBhY2NlcHRpbmcgYXJiaXRyYXJ5IHBhY2tldHMuAAAAEmFjY2VwdF9wcmVkZWNlc3NvcgAAAAAAAQAAAAAAAAALcHJlZGVjZXNzb3IAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADRDYW5jZWxzIGEgcGVuZGluZyBgRGF0YUJ1ZGdldGAgcHJvcG9zYWwuIEFkbWluIG9ubHkuAAAAEmNhbmNlbF9kYXRhX2J1ZGdldAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEZUaGUgaG91cmx5IGJ1Y2tldHMgYmVoaW5kIGBkYWlseV91c2FnZWAsIGFkdmFuY2VkIHRvIG5vdyAobm90IHN0b3JlZCkuAAAAAAASZGFpbHlfdXNhZ2VfZGV0YWlsAAAAAAAAAAAAAQAAA+kAAAfQAAAAC1VzYWdlV2luZG93AAAAAAM=",
        "AAAAAAAAAPdXaGlsZSBwYXVzZWQgb25seTogYnVybnMgYHNoYXJlc2AgZm9yIHRoZWlyIHByby1yYXRhIHBhcnQgb2YgdGhlIGZyZWUKaWRsZSBjb2xsYXRlcmFsLCB3aXRob3V0IHJlYWRpbmcgbWFya2V0LWNvcmUgKGZvciB3aGVuIGl0IGlzIHRoZQp0aGluZyB0aGF0IGJyb2tlKS4gVGhlIG93bmVyIGZvcmZlaXRzIHRoZWlyIHBhcnQgb2Ygb3BlbiBwb3NpdGlvbnMsCndoaWNoIHN0YXlzIHdpdGggdGhlIHJlbWFpbmluZyBzaGFyZWhvbGRlcnMuAAAAABJlbWVyZ2VuY3lfd2l0aGRyYXcAAAAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAScmVjZWl2ZV9jb2xsYXRlcmFsAAAAAAACAAAAAAAAAAtwcmVkZWNlc3NvcgAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAABQAAAAAAAAAAAAAAFEFnZW50UG9saWN5Q2FuY2VsbGVkAAAAAQAAABZhZ2VudF9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFByaWNlUG9saWN5Q2FuY2VsbGVkAAAAAQAAABZwcmljZV9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALUHJpY2VQb2xpY3kAAAAAAAAAAAI=",
        "AAAAAAAAAJ9DbGFpbXMgdGhlIG1hcmtldCdzIExQIGZlZSBzaGFyZSBmb3IgYSBtYXJrZXQgdGhlIHRyZWFzdXJ5IGNyZWF0ZWQKKGBST0xFX1NFVFRMRWApLiBUaGUgTFAgcG9ydGlvbiBhY2NydWVzIHNlcGFyYXRlbHkgb24gbWFya2V0LWNvcmUKKHNlZSBpdHMgYGNsYWltX2xwX2ZlZXNgKS4AAAAAE2FnZW50X2NsYWltX2xwX2ZlZXMAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAQxDcmVhdGVzIGFuZCBzZWVkcyBhIG1hcmtldCB1c2luZyB0cmVhc3VyeSBjYXBpdGFsIChgUk9MRV9DUkVBVEVgKS4KVGhlIHRyZWFzdXJ5IGJlY29tZXMgdGhlIG1hcmtldCdzIGNyZWF0b3IvTFAuIGBpbml0aWFsX3llc19icHNgIG11c3QKbGllIHdpdGhpbiB0aGUgcHJpY2UgcG9saWN5J3MgYFttaW5fc2VsbCwgbWF4X2J1eV1gIGJhbmQsIHNvIHRoZQp0cmVhc3VyeSBuZXZlciBzZWVkcyBhIG1hcmtldCB3aG9zZSBjcmVhdG9yIHNpZGUgaXMgbmVhciB3b3J0aGxlc3MuAAAAE2FnZW50X2NyZWF0ZV9tYXJrZXQAAAAACAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX21heF9tYXJrX2FnZQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX3ByaWNlX3BvbGljeQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX3RyYWNlX3BvbGljeQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAWRQdWxscyBhY2NydWVkICoqcHJvdG9jb2wqKiBmZWVzIGZyb20gYSBjb25maWd1cmVkIG1hcmtldC1jb3JlIGNvbnRyYWN0LgoKT25seSB0aGUgcHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIG1hcmtldCdzIGZlZXM6IHRoZSBMUCBwb3J0aW9uIGFjY3J1ZXMKc2VwYXJhdGVseSBvbiBtYXJrZXQtY29yZSBhbmQgYmVsb25ncyB0byB0aGUgbWFya2V0J3MgY3JlYXRvciDigJQgZm9yCmFnZW50LWNyZWF0ZWQgbWFya2V0cyB0aGF0IGlzIHRoZSB0cmVhc3VyeSBpdHNlbGYsIHZpYQpgYWdlbnRfY2xhaW1fbHBfZmVlc2AuIEZlZXMgcmFpc2UgTkFWIGZvciBldmVyeSBzaGFyZWhvbGRlciBhdCB0aGUKbW9tZW50IHRoZXkgYXJyaXZlLgAAABNjb2xsZWN0X21hcmtldF9mZWVzAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAD9FeGVjdXRlcyBhIHByb3Bvc2VkIGBEYXRhQnVkZ2V0YCBvbmNlIHRoZSB0aW1lbG9jayBoYXMgZWxhcHNlZC4AAAAAE2V4ZWN1dGVfZGF0YV9idWRnZXQAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATZ2V0X2NyZWF0aW9uX3BvbGljeQAAAAAAAAAAAQAAA+kAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2NyZWF0aW9uX3BvbGljeQAAAAABAAAAAAAAAApuZXdfcG9saWN5AAAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAG5TZXRzIHRoZSBuZXR3b3JrLXdpZGUgZ2xvYmFsIGNlaWxpbmcgZm9yIGFsbCBkYXRhIGJ1ZGdldHMuIEFkbWluIG9ubHkuClNldHRpbmcgYGNhcGAgdG8gMCByZW1vdmVzIHRoZSBjZWlsaW5nLgAAAAAAE3NldF9kYXRhX2dsb2JhbF9jYXAAAAAAAQAAAAAAAAADY2FwAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2RyYXdkb3duX2NvbmZpZwAAAAACAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAt3aW5kb3dfZGF5cwAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFUNyZWF0aW9uUG9saWN5VXBkYXRlZAAAAAAAAAEAAAAXY3JlYXRpb25fcG9saWN5X3VwZGF0ZWQAAAAAAgAAAAAAAAADb2xkAAAAB9AAAAAOQ3JlYXRpb25Qb2xpY3kAAAAAAAAAAAAAAAAAA25ldwAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAUYWNrbm93bGVkZ2VfZHJhd2Rvd24AAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAE9DbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVyIGZvciBhIG1hcmtldCB0aGUgdHJlYXN1cnkgY3JlYXRlZAooYFJPTEVfU0VUVExFYCkuAAAAABRjbGFpbV9wb29sX3JlbWFpbmRlcgAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAUZXhlY3V0ZV9tYXhfbWFya19hZ2UAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEtBcHBsaWVzIHRoZSBwZW5kaW5nIHByaWNlIHBvbGljeSBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLgpQZXJtaXNzaW9ubGVzcy4AAAAAFGV4ZWN1dGVfcHJpY2VfcG9saWN5AAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAUZXhlY3V0ZV90cmFjZV9wb2xpY3kAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAadPbmUtc2hvdCwgcGVybWlzc2lvbmxlc3MgYmFja2ZpbGwgb2YgdGhlIHBlci1jb3JlIGNvdW50ZXJzIGZvciBhCnRyZWFzdXJ5IGRlcGxveWVkIGJlZm9yZSBpc3N1ZSAjMzIwLiBXYWxrcyB0aGUgb3Blbi1tYXJrZXQgaW5kZXggKGF0Cm1vc3QgYE1BWF9PUEVOX01BUktFVFNgIGVudHJpZXMpIGFuZCBhdHRyaWJ1dGVzIGVhY2ggZW50cnksIGl0cyBvcGVuCmV4cG9zdXJlIGFuZCBpdHMgbmV0IGNvc3QgYmFzaXMgdG8gaXRzIGNvcmUuIFdoYXRldmVyIHBhcnQgb2YKYE5ldFRvdGFsYCBpcyBub3QgYXR0cmlidXRhYmxlIHRvIGFuIGluZGV4ZWQgbWFya2V0IGdvZXMgaW50bwpgVW5hdHRyaWJ1dGVkTmV0YCwgd2hpY2ggc3RheXMgY291bnRlZCBpbiB0aGUgY2FwcyAoY29uc2VydmF0aXZlKS4KUmV0dXJucyB0aGUgdW5hdHRyaWJ1dGVkIG5ldC4AAAAAFGluaXRfY29yZV9hY2NvdW50aW5nAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAUbWF4X21hcmtfYWdlX2xlZGdlcnMAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAAUcGVuZGluZ19tYXhfbWFya19hZ2UAAAAAAAAAAQAAA+gAAAfQAAAADlBlbmRpbmdNYXJrQWdlAAA=",
        "AAAAAAAAAAAAAAAUcGVuZGluZ19wcmljZV9wb2xpY3kAAAAAAAAAAQAAA+gAAAfQAAAAElBlbmRpbmdQcmljZVBvbGljeQAA",
        "AAAAAAAAAAAAAAAUcHJvcG9zZV90cmFjZV9wb2xpY3kAAAADAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALVHJhY2VQb2xpY3kAAAAAAAAAABVtYXhfdHJhY2VfYWdlX2xlZGdlcnMAAAAAAAAEAAAAAAAAAAhyZWdpc3RyeQAAA+gAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAT5DbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVycyBvZiB1cCB0byBgTUFYX0JBVENIYCB0cmVhc3VyeS1jcmVhdGVkCm1hcmtldHMgaW4gb25lIGNhbGwsIGRlbGVnYXRpbmcgdG8gbWFya2V0LWNvcmUncyBgY2xhaW1fcG9vbF9yZW1haW5kZXJzYAooc2tpcHMsIG5ldmVyIGFib3J0cyBvbiwgbWFya2V0cyB0aGUgdHJlYXN1cnkgZGlkIG5vdCBjcmVhdGUsIG1hcmtldHMKbm90IHNldHRsZWQsIG9yIG1hcmtldHMgYWxyZWFkeSBjbGFpbWVkIOKAlCBzZWUgYHJlZGVlbV9tYW55YCBmb3IgdGhlCmJhdGNoaW5nIHJhdGlvbmFsZSkuIChgUk9MRV9TRVRUTEVgLikAAAAAABVjbGFpbV9wb29sX3JlbWFpbmRlcnMAAAAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACm1hcmtldF9pZHMAAAAAA+oAAAAGAAAAAQAAA+kAAAfQAAAAC0JhdGNoUmVzdWx0AAAAAAM=",
        "AAAABQAAAD4jMzIwOiBgaW5pdF9jb3JlX2FjY291bnRpbmdgIGJhY2tmaWxsZWQgdGhlIHBlci1jb3JlIGNvdW50ZXJzLgAAAAAAAAAAABlDb3JlQWNjb3VudGluZ0luaXRpYWxpemVkAAAAAAAAAQAAABtjb3JlX2FjY291bnRpbmdfaW5pdGlhbGl6ZWQAAAAAAgAAAAAAAAAFY29yZXMAAAAAAAAEAAAAAAAAAAAAAAAQdW5hdHRyaWJ1dGVkX25ldAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAC1XaGV0aGVyIHRoZSBwZXItY29yZSBjb3VudGVycyBhcmUgbWFpbnRhaW5lZC4AAAAAAAAbY29yZV9hY2NvdW50aW5nX2luaXRpYWxpemVkAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAADRgY2xhaW1fcG9vbF9yZW1haW5kZXJgIGFnYWluc3QgYSBsZWdhY3kgbWFya2V0LWNvcmUuAAAAG2xlZ2FjeV9jbGFpbV9wb29sX3JlbWFpbmRlcgAAAAADAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAdYWdlbnRfY3JlYXRlX21hcmtldF9yZXZlYWxfdjIAAAAAAAAIAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAoFMaWtlIFtgVHJlYXN1cnk6OmFnZW50X2NyZWF0ZV9tYXJrZXRgXSwgYnV0IHJldmVhbHMgdGhlIHJlc29sdXRpb24gcnVsZQppbiB0aGUgc2FtZSB0cmFuc2FjdGlvbiAoIzY0KS4gVGhlIG1hcmtldCBpcyBjcmVhdGVkIHdpdGggdGhlIGNvbW1pdG1lbnQKZGVyaXZlZCBmcm9tIGBzcGVjX3YyYCBpdHNlbGYsIHNvIHRoZSBmb2xsb3ctdXAgcmV2ZWFsIG5lY2Vzc2FyaWx5Cm1hdGNoZXMgYW5kIHRoZSBtYXJrZXQgY2FuIG5ldmVyIGJlIGxlZnQgdW5yZXNvbHZhYmxlLiBgcmVzb2x2ZXJgIGlzIHRoZQpkZXBsb3llZCByZXNvbHZlciBjb250cmFjdDsgaXQgbXVzdCBiZSBjb25maWd1cmVkIGZvciB0aGlzIHRyZWFzdXJ5J3MKbWFya2V0LWNvcmUuCgpUaGUgcm91dGVyIGNhbm5vdCBzZXJ2ZSB0aGlzIHBhdGg6IHNlZWRpbmcgcHVsbHMgY29sbGF0ZXJhbCBmcm9tIHRoZQp0cmVhc3VyeSBjb250cmFjdCAobm90IHRoZSBlbmQgdXNlcikgdmlhIGEgY29udHJhY3Qgc2VsZi1hdXRob3JpemF0aW9uLAp3aGljaCBvbmx5IHRoaXMgY29udHJhY3QgY2FuIHBlcmZvcm0g4oCUIGEgc3RhdGVsZXNzIHJvdXRlciBiZXR3ZWVuIHRoZQphZ2VudCBhbmQgbWFya2V0LWNvcmUgd291bGQgbm90IGJlIGF1dGhvcml6ZWQgb24gdGhlIHRva2VuLgAAAAAAAB5hZ2VudF9jcmVhdGVfbWFya2V0X2FuZF9yZXZlYWwAAAAAAAkAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAACG1ldGFfdXJpAAAAEAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAtzZWVkX2Ftb3VudAAAAAALAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAHc3BlY192MgAAAAfQAAAAEFJlc29sdXRpb25TcGVjVjIAAAABAAAD6QAAAAYAAAAD",
        "AAAAAQAAAAAAAAAAAAAADkh5YnJpZENvbmZpZ1YyAAAAAAADAAAAAAAAAAhmYWxsYmFjawAAB9AAAAARRmFsbGJhY2tBdXRob3JpdHkAAAAAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAgAAAAAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAHAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAAAAAAAZIeWJyaWQAAAAAAAEAAAfQAAAADEh5YnJpZENvbmZpZwAAAAEAAAAAAAAACEh5YnJpZFYyAAAAAQAAB9AAAAAOSHlicmlkQ29uZmlnVjIAAA==",
        "AAAAAgAAAAAAAAAAAAAAEUZhbGxiYWNrQXV0aG9yaXR5AAAAAAAAAwAAAAEAAAAAAAAAB1NpZ25lcnMAAAAAAQAAB9AAAAAMU2lnbmVyQ29uZmlnAAAAAQAAAAAAAAAJQ29tbWl0dGVlAAAAAAAAAQAAB9AAAAAMQ29tbWl0dGVlUmVmAAAAAQAAAAAAAAAMV2VpZ2h0ZWRLZXlzAAAAAQAAB9AAAAARV2VpZ2h0ZWRLZXlDb25maWcAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    nav: this.txFromJSON<Result<i128>>,
        redeem: this.txFromJSON<Result<i128>>,
        deposit: this.txFromJSON<Result<i128>>,
        realize: this.txFromJSON<Result<void>>,
        agent_at: this.txFromJSON<Option<string>>,
        realized: this.txFromJSON<Realized>,
        withdraw: this.txFromJSON<Result<void>>,
        agent_buy: this.txFromJSON<Result<i128>>,
        assets_of: this.txFromJSON<i128>,
        get_agent: this.txFromJSON<Option<AgentPolicy>>,
        set_agent: this.txFromJSON<Result<void>>,
        shares_of: this.txFromJSON<i128>,
        agent_halt: this.txFromJSON<Result<void>>,
        agent_sell: this.txFromJSON<Result<i128>>,
        audit_mark: this.txFromJSON<Option<MarkRecord>>,
        get_config: this.txFromJSON<Result<RiskConfig>>,
        get_global: this.txFromJSON<Result<GlobalConfig>>,
        market_pnl: this.txFromJSON<MarketPnl>,
        nav_detail: this.txFromJSON<NavDetail>,
        queue_page: this.txFromJSON<Array<QueueEntry>>,
        set_paused: this.txFromJSON<Result<void>>,
        window_pnl: this.txFromJSON<Result<i128>>,
        agent_count: this.txFromJSON<u32>,
        close_trade: this.txFromJSON<Result<i128>>,
        core_status: this.txFromJSON<CoreAccounting>,
        daily_usage: this.txFromJSON<Result<DailyUsage>>,
        get_net_cap: this.txFromJSON<Result<i128>>,
        known_cores: this.txFromJSON<Array<string>>,
        predecessor: this.txFromJSON<Option<string>>,
        realized_on: this.txFromJSON<Realized>,
        redeem_many: this.txFromJSON<Result<BatchResult>>,
        retire_core: this.txFromJSON<Result<i128>>,
        agent_buy_v2: this.txFromJSON<Result<i128>>,
        cancel_agent: this.txFromJSON<Result<void>>,
        config_delay: this.txFromJSON<u64>,
        migrate_idle: this.txFromJSON<Result<void>>,
        net_exposure: this.txFromJSON<i128>,
        net_position: this.txFromJSON<Result<NetPosition>>,
        queue_bounds: this.txFromJSON<readonly [u64, u64]>,
        refresh_mark: this.txFromJSON<Result<void>>,
        remove_agent: this.txFromJSON<Result<void>>,
        total_shares: this.txFromJSON<i128>,
        trace_policy: this.txFromJSON<TracePolicyConfig>,
        agent_sell_v2: this.txFromJSON<Result<i128>>,
        cancel_config: this.txFromJSON<Result<void>>,
        disable_yield: this.txFromJSON<Result<void>>,
        execute_agent: this.txFromJSON<Result<void>>,
        legacy_redeem: this.txFromJSON<Result<i128>>,
        market_pnl_on: this.txFromJSON<MarketPnl>,
        migrate_marks: this.txFromJSON<Result<u32>>,
        pending_agent: this.txFromJSON<Option<PendingAgent>>,
        settle_market: this.txFromJSON<Result<SettlementReport>>,
        sweep_retired: this.txFromJSON<Result<i128>>,
        claim_withdraw: this.txFromJSON<Result<i128>>,
        creation_usage: this.txFromJSON<Result<u32>>,
        daily_headroom: this.txFromJSON<Result<i128>>,
        execute_config: this.txFromJSON<Result<void>>,
        liquid_capital: this.txFromJSON<Result<i128>>,
        open_market_at: this.txFromJSON<Option<OpenMarket>>,
        pending_config: this.txFromJSON<Option<PendingConfig>>,
        propose_config: this.txFromJSON<Result<void>>,
        queue_position: this.txFromJSON<Option<QueuePosition>>,
        queue_reserved: this.txFromJSON<i128>,
        begin_migration: this.txFromJSON<Result<void>>,
        cancel_withdraw: this.txFromJSON<Result<i128>>,
        drawdown_status: this.txFromJSON<Result<DrawdownStatus>>,
        fund_data_spend: this.txFromJSON<Result<void>>,
        migrate_markets: this.txFromJSON<Result<void>>,
        migration_state: this.txFromJSON<Option<MigrationState>>,
        set_data_budget: this.txFromJSON<Result<void>>,
        set_yield_venue: this.txFromJSON<Result<void>>,
        transfer_shares: this.txFromJSON<Result<void>>,
        transfer_ticket: this.txFromJSON<Result<void>>,
        withdraw_ticket: this.txFromJSON<Option<WithdrawTicket>>,
        agent_buy_traced: this.txFromJSON<Result<i128>>,
        cancel_migration: this.txFromJSON<Result<void>>,
        estimated_unlock: this.txFromJSON<Option<u64>>,
        get_price_policy: this.txFromJSON<PricePolicy>,
        market_valuation: this.txFromJSON<Result<Valuation>>,
        request_withdraw: this.txFromJSON<Result<readonly [i128, u64]>>,
        reset_pnl_window: this.txFromJSON<Result<void>>,
        set_config_delay: this.txFromJSON<Result<void>>,
        set_max_mark_age: this.txFromJSON<Result<void>>,
        set_price_policy: this.txFromJSON<Result<void>>,
        settle_market_on: this.txFromJSON<Result<SettlementReport>>,
        unattributed_net: this.txFromJSON<i128>,
        agent_daily_usage: this.txFromJSON<Result<DailyUsage>>,
        agent_sell_traced: this.txFromJSON<Result<i128>>,
        allocate_to_yield: this.txFromJSON<Result<void>>,
        available_capital: this.txFromJSON<Result<i128>>,
        capital_breakdown: this.txFromJSON<Result<CapitalBreakdown>>,
        exit_to_successor: this.txFromJSON<Result<i128>>,
        migration_version: this.txFromJSON<u32>,
        open_market_count: this.txFromJSON<u32>,
        recall_from_yield: this.txFromJSON<Result<void>>,
        receive_migration: this.txFromJSON<Result<i128>>,
        accept_predecessor: this.txFromJSON<Result<void>>,
        cancel_data_budget: this.txFromJSON<Result<void>>,
        daily_usage_detail: this.txFromJSON<Result<UsageWindow>>,
        emergency_withdraw: this.txFromJSON<Result<i128>>,
        receive_collateral: this.txFromJSON<Result<i128>>,
        agent_claim_lp_fees: this.txFromJSON<Result<i128>>,
        agent_create_market: this.txFromJSON<Result<u64>>,
        cancel_max_mark_age: this.txFromJSON<Result<void>>,
        cancel_price_policy: this.txFromJSON<Result<void>>,
        cancel_trace_policy: this.txFromJSON<Result<void>>,
        collect_market_fees: this.txFromJSON<Result<i128>>,
        execute_data_budget: this.txFromJSON<Result<void>>,
        get_creation_policy: this.txFromJSON<Result<CreationPolicy>>,
        set_creation_policy: this.txFromJSON<Result<void>>,
        set_data_global_cap: this.txFromJSON<Result<void>>,
        set_drawdown_config: this.txFromJSON<Result<void>>,
        acknowledge_drawdown: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        execute_max_mark_age: this.txFromJSON<Result<void>>,
        execute_price_policy: this.txFromJSON<Result<void>>,
        execute_trace_policy: this.txFromJSON<Result<void>>,
        init_core_accounting: this.txFromJSON<Result<i128>>,
        max_mark_age_ledgers: this.txFromJSON<u32>,
        pending_max_mark_age: this.txFromJSON<Option<PendingMarkAge>>,
        pending_price_policy: this.txFromJSON<Option<PendingPricePolicy>>,
        propose_trace_policy: this.txFromJSON<Result<void>>,
        claim_pool_remainders: this.txFromJSON<Result<BatchResult>>,
        core_accounting_initialized: this.txFromJSON<boolean>,
        legacy_claim_pool_remainder: this.txFromJSON<Result<i128>>,
        agent_create_market_reveal_v2: this.txFromJSON<Result<u64>>,
        agent_create_market_and_reveal: this.txFromJSON<Result<u64>>
  }
}