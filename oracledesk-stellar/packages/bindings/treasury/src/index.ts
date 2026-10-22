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
  44: {message:"CategoryCapExceeded"},
  /**
   * Close-date bucket exposure would exceed its cap (#49).
   */
  45: {message:"BucketCapExceeded"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  46: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  47: {message:"PendingAdminExpired"},
  /**
   * `agent_create_market_and_reveal` was given a malformed resolution
   * envelope or a rule outside the two primary modes (#64).
   */
  48: {message:"InvalidResolution"}
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


/**
 * An entry of the open-market index `nav()` walks.
 */
export interface OpenMarket {
  core: string;
  market_id: u64;
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


/**
 * Collateral still owed to `owner` for shares already burned.
 */
export interface WithdrawTicket {
  created_at: u64;
  owner: string;
  remaining: i128;
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



export interface PendingPricePolicy {
  executable_at: u64;
  policy: PricePolicy;
  proposed_at: u64;
}








export type Escalation = {tag: "Guardian", values: void} | {tag: "Committee", values: readonly [Array<string>, u32]};

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

export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]};


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
   */
  market_pnl: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<MarketPnl>>

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
   * Construct and simulate a pending_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAgent>>>

  /**
   * Construct and simulate a set_successor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the successor treasury that `migrate_market` hands positions and
   * the LP role to. Admin-only; overwrites any previous successor (the
   * `SuccessorSet` events are the audit trail).
   */
  set_successor: ({successor}: {successor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless settlement of a resolved or voided market's position and LP remainder.
   * Operates even when the treasury is paused. Idempotent on retry.
   */
  settle_market: ({caller, market_id}: {caller: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettlementReport>>>

  /**
   * Construct and simulate a claim_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays the ticket at the head of the queue as far as idle collateral
   * allows. Permissionless: the money always goes to the ticket's owner.
   * Only the head ticket can be paid (`NothingToPay` for later ones).
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
   * Construct and simulate a migrate_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves the treasury's position in `market_id` — and the LP role, when
   * the treasury is the market's creator and has not claimed the remainder
   * yet — to the successor set via `set_successor`, then closes the local
   * exposure. Admin-only: relocating capital is not an agent trading
   * action, and the agent key must not be able to drain positions.
   * 
   * market-core's `transfer_position` / `transfer_lp` require the treasury
   * itself to authorize. Because the treasury is their *direct* caller
   * here, the implicit invoker authorization covers both — no
   * `authorize_as_current_contract` entry is needed (unlike the nested
   * token transfer in `agent_buy`, see `docs/adr/0002-treasury-nested-auth.md`).
   */
  migrate_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a queue_reserved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collateral owed to queued withdrawals; agents cannot spend it.
   */
  queue_reserved: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a drawdown_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  drawdown_status: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DrawdownStatus>>>

  /**
   * Construct and simulate a set_yield_venue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_yield_venue: ({pool, max_allocation}: {pool: string, max_allocation: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw_ticket transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  withdraw_ticket: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<WithdrawTicket>>>

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
   * collateral allows now and queues the rest as a ticket (FIFO, paid by
   * `claim_withdraw` as capital returns). Returns `(paid_now, ticket_id)`,
   * `ticket_id` 0 when nothing was queued.
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
   * Construct and simulate a set_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the price limits on agent trades (admin). Like the caps,
   * tightening (lower `max_buy`/`max_impact`/`max_slippage`, higher
   * `min_sell`) applies at once and anything else waits `config_delay`.
   */
  set_price_policy: ({policy}: {policy: PricePolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent`'s own sliding-window usage, counted against its `max_daily`.
   */
  agent_daily_usage: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<DailyUsage>>>

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
   * Construct and simulate a open_market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  open_market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a recall_from_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  recall_from_yield: ({amount}: {amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a cancel_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_creation_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_creation_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<CreationPolicy>>>

  /**
   * Construct and simulate a set_creation_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_creation_policy: ({new_policy}: {new_policy: CreationPolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a execute_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending price policy once its delay has passed.
   * Permissionless.
   */
  execute_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingPricePolicy>>>

  /**
   * Construct and simulate a legacy_claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `claim_pool_remainder` against a legacy market-core.
   */
  legacy_claim_pool_remainder: ({agent, core, market_id}: {agent: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAMAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABAAAAAAAAAAQVHJhZGVDYXBFeGNlZWRlZAAAAAUAAAAAAAAAEU1hcmtldENhcEV4Y2VlZGVkAAAAAAAABgAAAAAAAAAQRGFpbHlDYXBFeGNlZWRlZAAAAAcAAAAAAAAADU1hcmtldE5vdE9wZW4AAAAAAAAIAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAkAAAAAAAAABlBhdXNlZAAAAAAACgAAAAAAAAALTm9TdWNjZXNzb3IAAAAACwAAAAAAAAATTmV0RXhwb3N1cmVFeGNlZWRlZAAAAAAMAAAAAAAAABVBZ2VudERhaWx5Q2FwRXhjZWVkZWQAAAAAAAANAAAAAAAAAA9Qcm9wb3NhbFBlbmRpbmcAAAAADgAAAAAAAAAOVGltZWxvY2tBY3RpdmUAAAAAAA8AAAAAAAAAD05vUGVuZGluZ0NvbmZpZwAAAAAQAAAAAAAAABFMZWdhY3lDb3JlVW5rbm93bgAAAAAAABEAAAAAAAAAElRvb01hbnlPcGVuTWFya2V0cwAAAAAAEgAAAAAAAAAPQ2FwaXRhbFJlc2VydmVkAAAAABMAAAAAAAAAD0RlcG9zaXRUb29TbWFsbAAAAAAUAAAAAAAAABJJbnN1ZmZpY2llbnRTaGFyZXMAAAAAABUAAAAAAAAADlRpY2tldE5vdEZvdW5kAAAAAAAWAAAAAAAAAAxOb3RoaW5nVG9QYXkAAAAXAAAAAAAAAA5QcmljZU91dE9mQmFuZAAAAAAAGAAAAAAAAAATUHJpY2VJbXBhY3RFeGNlZWRlZAAAAAAZAAAAAAAAABJJbnZhbGlkUHJpY2VQb2xpY3kAAAAAABoAAAAAAAAAEFNsaXBwYWdlRXhjZWVkZWQAAAAbAAAAAAAAAAlOb3RQYXVzZWQAAAAAAAAcAAAAAAAAAA5NYXJrZXROb3RGaW5hbAAAAAAALAAAAAAAAAAPTWFya2V0Q29yZUVycm9yAAAAAC0AAAAAAAAAD0RyYXdkb3duVHJpcHBlZAAAAAAuAAAAAAAAABVJbnZhbGlkRHJhd2Rvd25Db25maWcAAAAAAAAvAAAAAAAAAA9Ob3RBY2tub3dsZWRnZWQAAAAAMAAAAAAAAAAPU2VlZENhcEV4Y2VlZGVkAAAAADEAAAAAAAAAFENyZWF0aW9uUmF0ZUV4Y2VlZGVkAAAAMgAAAAAAAAAQQ2xvc2VUaW1lVG9vU29vbgAAADMAAAAAAAAAD0Nsb3NlVGltZVRvb0ZhcgAAAAA0AAAAAAAAABJDYXRlZ29yeU5vdEFsbG93ZWQAAAAAADUAAAAAAAAAD1BvbGljeUxvb3NlbmluZwAAAAA2AAAAAAAAAA1ZaWVsZERpc2FibGVkAAAAAAAANwAAAAAAAAAQWWllbGRDYXBFeGNlZWRlZAAAADgAAAAAAAAAE1lpZWxkV2l0aGRyYXdGYWlsZWQAAAAAOQAAAAAAAAARVmVudWVIYXNQcmluY2lwYWwAAAAAAAA6AAAAOUNhdGVnb3J5IGV4cG9zdXJlIHdvdWxkIGV4Y2VlZCBpdHMgY29ycmVsYXRpb24gY2FwICgjNDkpLgAAAAAAABNDYXRlZ29yeUNhcEV4Y2VlZGVkAAAAAB0AAAA2Q2xvc2UtZGF0ZSBidWNrZXQgZXhwb3N1cmUgd291bGQgZXhjZWVkIGl0cyBjYXAgKCM0OSkuAAAAAAARQnVja2V0Q2FwRXhjZWVkZWQAAAAAAAAeAAAARGBhY2NlcHRfYWRtaW5gL2BjYW5jZWxfYWRtaW5fdHJhbnNmZXJgIGNhbGxlZCB3aXRoIG5vdGhpbmcgcHJvcG9zZWQuAAAADk5vUGVuZGluZ0FkbWluAAAAAAAfAAAAQ0EgcHJvcG9zZWQgYWRtaW4gaGFuZG92ZXIgd2FzIG5vdCBhY2NlcHRlZCB3aXRoaW4gaXRzIGBleHBpcmVzX2F0YC4AAAAAE1BlbmRpbmdBZG1pbkV4cGlyZWQAAAAAIAAAAHlgYWdlbnRfY3JlYXRlX21hcmtldF9hbmRfcmV2ZWFsYCB3YXMgZ2l2ZW4gYSBtYWxmb3JtZWQgcmVzb2x1dGlvbgplbnZlbG9wZSBvciBhIHJ1bGUgb3V0c2lkZSB0aGUgdHdvIHByaW1hcnkgbW9kZXMgKCM2NCkuAAAAAAAAEUludmFsaWRSZXNvbHV0aW9uAAAAAAAAIQ==",
        "AAAAAAAAAVtOZXQgYXNzZXQgdmFsdWU6IGlkbGUgY29sbGF0ZXJhbCBwbHVzLCBmb3IgZXZlcnkgbWFya2V0IGluIHRoZSBvcGVuLQptYXJrZXQgaW5kZXgsIHdoYXQgdGhlIGhvbGRpbmdzIGFyZSB3b3J0aCB3aGF0ZXZlciB0aGUgb3V0Y29tZQooY29tcGxldGUgc2V0cyBhbmQgdGhlIExQJ3MgYG1pbmAgcmVzZXJ2ZSB3aGlsZSBvcGVuLCB0aGUgZXhhY3QKc2V0dGxlbWVudCB2YWx1ZSBvbmNlIGZpbmFsKSwgbWludXMgd2hhdCBxdWV1ZWQgd2l0aGRyYXdhbHMgYXJlIG93ZWQuCkRpcmVjdGlvbmFsIGV4cG9zdXJlIGlzIHZhbHVlZCBhdCB6ZXJvLCBzbyBubyB0cmFkZSBhZ2FpbnN0IGEgcG9vbApjYW4gcmFpc2UgTkFWLgAAAAADbmF2AAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAQAAAAAAAAAAAAAACFJlYWxpemVkAAAAAwAAAAAAAAALbHBfcHJvY2VlZHMAAAAACwAAAAAAAAARcG9zaXRpb25fcHJvY2VlZHMAAAAAAAALAAAAAAAAAAdzZXR0bGVkAAAAAAE=",
        "AAAAAAAAAExSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldAooYFJPTEVfU0VUVExFYCkuAAAABnJlZGVlbQAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAQAAAAAAAAAAAAAACU1hcmtldFBubAAAAAAAAAMAAAAAAAAABGNvc3QAAAALAAAAAAAAAAhwcm9jZWVkcwAAAAsAAAAAAAAACHJlYWxpemVkAAAAAQ==",
        "AAAAAQAAAG9gbWFya2V0X3ZhbHVhdGlvbmAgcmVzdWx0LiBPbmx5IGBjb3N0X2Jhc2lzYCBpcyBlbmZvcmNlZCAoYnkKYG1heF9uZXRfZXhwb3N1cmVgKTsgdGhlIG90aGVycyBhcmUgaW5mb3JtYXRpb25hbC4AAAAAAAAAAAlWYWx1YXRpb24AAAAAAAAEAAAAI2BtYXgoMCwgY29zdF9iYXNpcyAtIGZsb29yX3ZhbHVlKWAuAAAAAAdhdF9yaXNrAAAAAAsAAAAAAAAACmNvc3RfYmFzaXMAAAAAAAsAAADVV2hhdCB0aGUgdHJlYXN1cnkgZ2V0cyBiYWNrIHdoYXRldmVyIHRoZSBvdXRjb21lLCBmcm9tIHN0YXRlIGEgcHJpY2UKbW92ZSBjYW5ub3QgcmFpc2U6IGNvbXBsZXRlIHNldHMgYG1pbih5ZXMsIG5vKWAgcGx1cywgYXMgdGhlIHVuY2xhaW1lZApMUCwgYG1pbihyZXNlcnZlX3llcywgcmVzZXJ2ZV9ubylgLiBBZnRlciBmaW5hbGl0eSwgdGhlIHNldHRsZW1lbnQKdmFsdWUuAAAAAAAAC2Zsb29yX3ZhbHVlAAAAAAsAAABiSG9sZGluZ3MgYXQgdGhlIHBvb2wncyBzcG90IHByaWNlLiBNYW5pcHVsYWJsZSBieSBhbnkgdHJhZGVyLCBzbyBpdCBpcwpuZXZlciB1c2VkIGZvciBlbmZvcmNlbWVudC4AAAAAAApzcG90X3ZhbHVlAAAAAAAL",
        "AAAAAAAAAH5EZXBvc2l0cyBgYW1vdW50YCBvZiBjb2xsYXRlcmFsIGFuZCBtaW50cyBzaGFyZXMgdG8gYGZyb21gIGF0IHRoZSBOQVYKYXMgaXQgd2FzIGJlZm9yZSB0aGUgZGVwb3NpdC4gUmV0dXJucyB0aGUgc2hhcmVzIG1pbnRlZC4AAAAAAAdkZXBvc2l0AAAAAAIAAAAAAAAABGZyb20AAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVhbGl6ZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAACURlcG9zaXRlZAAAAAAAAAEAAAAJZGVwb3NpdGVkAAAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAABdOQVYgYmVmb3JlIHRoZSBkZXBvc2l0LgAAAAADbmF2AAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAMRTdW1tYXJ5IG9mIHRoZSBzbGlkaW5nIGRhaWx5IHdpbmRvdywgcmV0dXJuZWQgYnkgYGRhaWx5X3VzYWdlYC4KYGRheV9zdGFydGAgaXMgdGhlIHN0YXJ0IG9mIHRoZSBvbGRlc3QgaG91ciBzdGlsbCBjb3VudGVkIGFuZCBgYW1vdW50YAp0aGUgdXNhZ2Ugc3VtbWVkIG92ZXIgdGhlIHdob2xlIHdpbmRvdyAoc2VlIFtgVXNhZ2VXaW5kb3dgXSkuAAAAAAAAAApEYWlseVVzYWdlAAAAAAACAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACWRheV9zdGFydAAAAAAAAAY=",
        "AAAAAQAAADBBbiBlbnRyeSBvZiB0aGUgb3Blbi1tYXJrZXQgaW5kZXggYG5hdigpYCB3YWxrcy4AAAAAAAAACk9wZW5NYXJrZXQAAAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAG",
        "AAAAAQAAAJhMZWdhY3kgc2luZ2xlLWFnZW50IGNvbmZpZ3VyYXRpb24uIFN0aWxsIHRoZSBzaGFwZSByZXR1cm5lZCBieSB0aGUKZGVwcmVjYXRlZCBgZ2V0X2NvbmZpZ2AgdmlldzsgbGl2ZSBzdGF0ZSBpcyBbYEdsb2JhbENvbmZpZ2BdIHBsdXMgdGhlCmFnZW50IHJlZ2lzdHJ5LgAAAAAAAAAKUmlza0NvbmZpZwAAAAAABgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAAAAAAAAAAAIYWdlbnRfYXQAAAABAAAAAAAAAAFpAAAAAAAABAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAIcmVhbGl6ZWQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAIUmVhbGl6ZWQ=",
        "AAAAAAAAAAAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAQAAAGtPbmUgcmVnaXN0ZXJlZCBhZ2VudC4gYG1heF90cmFkZWAgLyBgbWF4X2RhaWx5YCBzaXQgdW5kZXIgdGhlIGdsb2JhbApjYXBzOyBib3RoIGFyZSBjaGVja2VkIG9uIGV2ZXJ5IHNwZW5kLgAAAAAAAAAAC0FnZW50UG9saWN5AAAAAAQAAAAAAAAABmFjdGl2ZQAAAAAAAQAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACwAAAAAAAAAFcm9sZXMAAAAAAAAE",
        "AAAAAQAAALtDb2xsYXRlcmFsIHRoZSB0cmVhc3VyeSBoYXMgc2VudCBpbnRvIChgY29sbGF0ZXJhbF9pbmApIGFuZCByZWNlaXZlZCBiYWNrCmZyb20gKGBjb2xsYXRlcmFsX291dGApIG9uZSBtYXJrZXQuIEFjY291bnRpbmcgc3RhcnRzIHdoZW4gdGhpcyBjb2RlIHdhcwpkZXBsb3llZDogYSBtaXNzaW5nIGVudHJ5IHJlYWRzIGFzIHplcm8uAAAAAAAAAAALTmV0UG9zaXRpb24AAAAAAgAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAAL",
        "AAAAAQAAAEZQcmljZSBsaW1pdHMgb24gZXZlcnkgYWdlbnQgdHJhZGUsIGluIGJwcyBvZiB0aGUgb3V0Y29tZSdzIHNwb3QgcHJpY2UuAAAAAAAAAAAAC1ByaWNlUG9saWN5AAAAAAQAAAAnTmV2ZXIgYnV5IGFuIG91dGNvbWUgcHJpY2VkIGFib3ZlIHRoaXMuAAAAABFtYXhfYnV5X3ByaWNlX2JwcwAAAAAAAAQAAAA4TGFyZ2VzdCBgfHBfYWZ0ZXIgLSBwX2JlZm9yZXxgIGEgc2luZ2xlIHRyYWRlIG1heSBjYXVzZS4AAAAObWF4X2ltcGFjdF9icHMAAAAAAAQAAABrVG9sZXJhbmNlIGFwcGxpZWQgdG8gdGhlIHNhbWUtdHJhbnNhY3Rpb24gcXVvdGUgdG8gZGVyaXZlIHRoZQplZmZlY3RpdmUgYG1pbl9zaGFyZXNfb3V0YCAvIGBtYXhfc2hhcmVzX2luYC4AAAAAEG1heF9zbGlwcGFnZV9icHMAAAAEAAAAKE5ldmVyIHNlbGwgYW4gb3V0Y29tZSBwcmljZWQgYmVsb3cgdGhpcy4AAAASbWluX3NlbGxfcHJpY2VfYnBzAAAAAAAE",
        "AAAAAQAAAQRIb3VybHkgcmluZyBidWZmZXIgYmVoaW5kIGBtYXhfZGFpbHlgLiBLZXB0IGluIGluc3RhbmNlIHN0b3JhZ2U6IH40MDAKYnl0ZXMgdGhhdCBldmVyeSBjYWxsIGxvYWRzIGFueXdheSwgc28gaXQgY29zdHMgbm8gZXh0cmEgbGVkZ2VyLWVudHJ5CnJlYWQgKGEgcGVyc2lzdGVudCBlbnRyeSB3b3VsZCBhZGQgb25lIHBlciB0cmFkZSkuIFBlci1hZ2VudCB3aW5kb3dzCmhhdmUgdGhlIHNhbWUgc2hhcGUgYnV0IGxpdmUgaW4gcGVyc2lzdGVudCBzdG9yYWdlLgAAAAAAAAALVXNhZ2VXaW5kb3cAAAAAAwAAAGRBbHdheXMgYEJVQ0tFVFNgIGxvbmcuIGBhbW91bnRzW2ldYCBpcyB0aGUgdXNhZ2Ugb2YgaG91cgpgaGVhZF9ob3VyIC0gKChoZWFkX2lkeCAtIGkpIG1vZCBCVUNLRVRTKWAuAAAAB2Ftb3VudHMAAAAD6gAAAAsAAAA/SG91ciBpbmRleCAoYHRpbWVzdGFtcCAvIEJVQ0tFVF9TRUNPTkRTYCkgb2YgdGhlIG5ld2VzdCBidWNrZXQuAAAAAAloZWFkX2hvdXIAAAAAAAAGAAAAAAAAAAhoZWFkX2lkeAAAAAQ=",
        "AAAABQAAAAAAAAAAAAAAC1BubFJlYWxpemVkAAAAAAEAAAAMcG5sX3JlYWxpemVkAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGNvc3QAAAALAAAAAAAAAAAAAAAIcHJvY2VlZHMAAAALAAAAAAAAAAAAAAADcG5sAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAEBUcmVhc3VyeS13aWRlIGNhcHMsIGVuZm9yY2VkIG9uIHRvcCBvZiBldmVyeSBhZ2VudCdzIG93biBwb2xpY3kuAAAAAAAAAAxHbG9iYWxDb25maWcAAAAGAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAWkNhcCBvbiBjYXBpdGFsIGRlcGxveWVkIGluIG9wZW4gcG9zaXRpb25zIGFjcm9zcyBhbGwgbWFya2V0cyBhdCBvbmNlCihzZWUgYG5ldF9leHBvc3VyZWApLgAAAAAAEG1heF9uZXRfZXhwb3N1cmUAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADFBlbmRpbmdBZ2VudAAAAAMAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALQWdlbnRQb2xpY3kAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAG",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmVtb3ZlZAAAAAEAAAANYWdlbnRfcmVtb3ZlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAADFN1Y2Nlc3NvclNldAAAAAEAAAANc3VjY2Vzc29yX3NldAAAAAAAAAIAAAAAAAAAA29sZAAAAAPoAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFdpdGhkcmF3UGFpZAAAAAEAAAANd2l0aGRyYXdfcGFpZAAAAAAAAAIAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADVBlbmRpbmdDb25maWcAAAAAAAADAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAALcHJvcG9zZWRfYXQAAAAABg==",
        "AAAABQAAAAAAAAAAAAAADURyYXdkb3duUGF1c2UAAAAAAAABAAAADmRyYXdkb3duX3BhdXNlAAAAAAADAAAAAAAAAA1yZWFsaXplZF9sb3NzAAAAAAAACwAAAAAAAAAAAAAAEHdpbmRvd19zdGFydF9kYXkAAAAGAAAAAAAAAAAAAAATdHJpZ2dlcmVkX2J5X21hcmtldAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldFNldHRsZWQAAAAAAAABAAAADm1hcmtldF9zZXR0bGVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAIcmVkZWVtZWQAAAALAAAAAAAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAAAAAACnNldHRsZWRfYnkAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkUmVjYWxsZWQAAAAAAAABAAAADnlpZWxkX3JlY2FsbGVkAAAAAAAEAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAZyZWFzb24AAAAAABEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkVmVudWVTZXQAAAAAAAABAAAAD3lpZWxkX3ZlbnVlX3NldAAAAAACAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAADm1heF9hbGxvY2F0aW9uAAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAADkNyZWF0aW9uUG9saWN5AAAAAAAGAAAAAAAAABJhbGxvd2VkX2NhdGVnb3JpZXMAAAAAAAQAAAAAAAAAFGNyZWF0aW9uX3dpbmRvd19zZWNzAAAABgAAAAAAAAARbWF4X2Nsb3NlX2hvcml6b24AAAAAAAAGAAAAAAAAABZtYXhfbWFya2V0c19wZXJfd2luZG93AAAAAAAEAAAAAAAAAAhtYXhfc2VlZAAAAAsAAAAAAAAAEW1pbl9jbG9zZV9ob3Jpem9uAAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADkRyYXdkb3duU3RhdHVzAAAAAAADAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAd0cmlwcGVkAAAAAAEAAAAAAAAACndpbmRvd19wbmwAAAAAAAs=",
        "AAAAAQAAADtDb2xsYXRlcmFsIHN0aWxsIG93ZWQgdG8gYG93bmVyYCBmb3Igc2hhcmVzIGFscmVhZHkgYnVybmVkLgAAAAAAAAAADldpdGhkcmF3VGlja2V0AAAAAAADAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACXJlbWFpbmluZwAAAAAAAAs=",
        "AAAABQAAAAAAAAAAAAAADkFnZW50UG9saWN5U2V0AAAAAAABAAAAEGFnZW50X3BvbGljeV9zZXQAAAAEAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0RlbGF5U2V0AAAAAAABAAAAEGNvbmZpZ19kZWxheV9zZXQAAAACAAAAAAAAAANvbGQAAAAABgAAAAAAAAAAAAAAA25ldwAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0V4ZWN1dGVkAAAAAAABAAAAD2NvbmZpZ19leGVjdXRlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAOmB0cnVlYCBmb3IgYSB0aWdodGVuLW9ubHkgY2hhbmdlIGFwcGxpZWQgYXQgcHJvcG9zYWwgdGltZS4AAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ1Byb3Bvc2VkAAAAAAABAAAAD2NvbmZpZ19wcm9wb3NlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldE1pZ3JhdGVkAAAAAAABAAAAD21hcmtldF9taWdyYXRlZAAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJc3VjY2Vzc29yAAAAAAAAEwAAAAEAAAAAAAAAA3llcwAAAAALAAAAAAAAAAAAAAACbm8AAAAAAAsAAAAAAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlBubFdpbmRvd1Jlc2V0AAAAAAABAAAAEHBubF93aW5kb3dfcmVzZXQAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlByaWNlUG9saWN5U2V0AAAAAAABAAAAEHByaWNlX3BvbGljeV9zZXQAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADllpZWxkQWxsb2NhdGVkAAAAAAABAAAAD3lpZWxkX2FsbG9jYXRlZAAAAAADAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD0NvbmZpZ0NhbmNlbGxlZAAAAAABAAAAEGNvbmZpZ19jYW5jZWxsZWQAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAABFUaGUgYWN0aW5nIGFnZW50LgAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAxtYXJrZXRfdG90YWwAAAALAAAAAAAAAAAAAAALZGFpbHlfdG90YWwAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAAEENhcGl0YWxCcmVha2Rvd24AAAADAAAAAAAAAAZsaXF1aWQAAAAAAAsAAAAAAAAAD3lpZWxkX3ByaW5jaXBhbAAAAAALAAAAAAAAAAt5aWVsZF92YWx1ZQAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEFNldHRsZW1lbnRSZXBvcnQAAAADAAAAAAAAAA9hbHJlYWR5X3NldHRsZWQAAAAAAQAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAIcmVkZWVtZWQAAAAL",
        "AAAABQAAAAAAAAAAAAAAEVdpdGhkcmF3UmVxdWVzdGVkAAAAAAAAAQAAABJ3aXRoZHJhd19yZXF1ZXN0ZWQAAAAAAAUAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFzc2V0cwAAAAAACwAAAAAAAAAAAAAACHBhaWRfbm93AAAACwAAAAAAAAAjMCB3aGVuIGV2ZXJ5dGhpbmcgd2FzIHBhaWQgYXQgb25jZS4AAAAACXRpY2tldF9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAElBlbmRpbmdQcmljZVBvbGljeQAAAAAAAwAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAABnBvbGljeQAAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAY=",
        "AAAABQAAAAAAAAAAAAAAEkVtZXJnZW5jeVdpdGhkcmF3bgAAAAAAAQAAABNlbWVyZ2VuY3lfd2l0aGRyYXduAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAD5OZXQgZXhwb3N1cmUgYWZ0ZXIgYW55IHRyZWFzdXJ5IG1vbmV5IG1vdmVtZW50IGluIGBtYXJrZXRfaWRgLgAAAAAAAAAAABJOZXRFeHBvc3VyZVVwZGF0ZWQAAAAAAAEAAAAUbmV0X2V4cG9zdXJlX3VwZGF0ZWQAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAKbmV0X21hcmtldAAAAAAACwAAAAAAAAAAAAAACW5ldF90b3RhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAE0FnZW50UG9saWN5UHJvcG9zZWQAAAAAAQAAABVhZ2VudF9wb2xpY3lfcHJvcG9zZWQAAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1ByaWNlUG9saWN5UHJvcG9zZWQAAAAAAQAAABVwcmljZV9wb2xpY3lfcHJvcG9zZWQAAAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFEFnZW50UG9saWN5Q2FuY2VsbGVkAAAAAQAAABZhZ2VudF9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFByaWNlUG9saWN5Q2FuY2VsbGVkAAAAAQAAABZwcmljZV9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALUHJpY2VQb2xpY3kAAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFUNyZWF0aW9uUG9saWN5VXBkYXRlZAAAAAAAAAEAAAAXY3JlYXRpb25fcG9saWN5X3VwZGF0ZWQAAAAAAgAAAAAAAAADb2xkAAAAB9AAAAAOQ3JlYXRpb25Qb2xpY3kAAAAAAAAAAAAAAAAAA25ldwAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAAAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAAAAAVtOZXQgYXNzZXQgdmFsdWU6IGlkbGUgY29sbGF0ZXJhbCBwbHVzLCBmb3IgZXZlcnkgbWFya2V0IGluIHRoZSBvcGVuLQptYXJrZXQgaW5kZXgsIHdoYXQgdGhlIGhvbGRpbmdzIGFyZSB3b3J0aCB3aGF0ZXZlciB0aGUgb3V0Y29tZQooY29tcGxldGUgc2V0cyBhbmQgdGhlIExQJ3MgYG1pbmAgcmVzZXJ2ZSB3aGlsZSBvcGVuLCB0aGUgZXhhY3QKc2V0dGxlbWVudCB2YWx1ZSBvbmNlIGZpbmFsKSwgbWludXMgd2hhdCBxdWV1ZWQgd2l0aGRyYXdhbHMgYXJlIG93ZWQuCkRpcmVjdGlvbmFsIGV4cG9zdXJlIGlzIHZhbHVlZCBhdCB6ZXJvLCBzbyBubyB0cmFkZSBhZ2FpbnN0IGEgcG9vbApjYW4gcmFpc2UgTkFWLgAAAAADbmF2AAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAExSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldAooYFJPTEVfU0VUVExFYCkuAAAABnJlZGVlbQAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAH5EZXBvc2l0cyBgYW1vdW50YCBvZiBjb2xsYXRlcmFsIGFuZCBtaW50cyBzaGFyZXMgdG8gYGZyb21gIGF0IHRoZSBOQVYKYXMgaXQgd2FzIGJlZm9yZSB0aGUgZGVwb3NpdC4gUmV0dXJucyB0aGUgc2hhcmVzIG1pbnRlZC4AAAAAAAdkZXBvc2l0AAAAAAIAAAAAAAAABGZyb20AAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVhbGl6ZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAIYWdlbnRfYXQAAAABAAAAAAAAAAFpAAAAAAAABAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAIcmVhbGl6ZWQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAIUmVhbGl6ZWQ=",
        "AAAAAAAAAAAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHVCdXlzIGBvdXRjb21lYCBzaGFyZXMgaW4gYW4gZXhpc3RpbmcgbWFya2V0IHVzaW5nIHRyZWFzdXJ5IGNhcGl0YWwKKGBST0xFX1RSQURFYCkuIFByaWNlLWNoZWNrZWQsIHNlZSBgZG9fYWdlbnRfYnV5YC4AAAAAAAAJYWdlbnRfYnV5AAAAAAAABQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+gAAAfQAAAAC0FnZW50UG9saWN5AA==",
        "AAAAAAAAAIZBZGRzIG9yIHVwZGF0ZXMgYGFnZW50YC4gVmFsaWRhdGlvbjogYHJvbGVzYCBub24tZW1wdHkgYW5kIGtub3duLApgMCA8IG1heF90cmFkZSA8PSBtYXhfZGFpbHlgLCBib3RoIHdpdGhpbiB0aGUgZ2xvYmFsIGNhcHMsIGBhY3RpdmVgLgAAAAAACXNldF9hZ2VudAAAAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAGcG9saWN5AAAAAAfQAAAAC0FnZW50UG9saWN5AAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAJc2hhcmVzX29mAAAAAAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAABQAAAAAAAAAAAAAAC1BubFJlYWxpemVkAAAAAAEAAAAMcG5sX3JlYWxpemVkAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGNvc3QAAAALAAAAAAAAAAAAAAAIcHJvY2VlZHMAAAALAAAAAAAAAAAAAAADcG5sAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAEBUcmVhc3VyeS13aWRlIGNhcHMsIGVuZm9yY2VkIG9uIHRvcCBvZiBldmVyeSBhZ2VudCdzIG93biBwb2xpY3kuAAAAAAAAAAxHbG9iYWxDb25maWcAAAAGAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAWkNhcCBvbiBjYXBpdGFsIGRlcGxveWVkIGluIG9wZW4gcG9zaXRpb25zIGFjcm9zcyBhbGwgbWFya2V0cyBhdCBvbmNlCihzZWUgYG5ldF9leHBvc3VyZWApLgAAAAAAEG1heF9uZXRfZXhwb3N1cmUAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADFBlbmRpbmdBZ2VudAAAAAMAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALQWdlbnRQb2xpY3kAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAG",
        "AAAAAAAAAXpTZWxscyBgb3V0Y29tZWAgc2hhcmVzIGJhY2sgaW50byB0aGUgcG9vbCBmb3IgZXhhY3RseQpgY29sbGF0ZXJhbF9vdXRgIChgUk9MRV9UUkFERWApLiBUaGlzIHJldHVybnMgY2FwaXRhbCB0byB0aGUgdHJlYXN1cnkKKG1hcmtldC1jb3JlIHBheXMgb3V0IG9mIGl0cyBvd24gYmFsYW5jZSksIHNvIGl0IGlzIG5vdCBjYXBwZWQgYW5kCmRvZXMgbm90IG5lZWQgdGhlIG5lc3RlZC10cmFuc2ZlciBwcmUtYXV0aG9yaXphdGlvbiB0aGF0IGJ1eWluZyBkb2VzLgpJdCBmcmVlcyBuZXQgaGVhZHJvb20gKGBjb2xsYXRlcmFsX291dGAgaXMgcmVjb3JkZWQpIGJ1dCBuZXZlcgpsaWZldGltZSBoZWFkcm9vbS4gUHJpY2UtY2hlY2tlZCwgc2VlIGBkb19hZ2VudF9zZWxsYC4AAAAAAAphZ2VudF9zZWxsAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAOY29sbGF0ZXJhbF9vdXQAAAAAAAsAAAAAAAAADW1heF9zaGFyZXNfaW4AAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAALREZXByZWNhdGVkIGNvbXBhdGliaWxpdHkgdmlldyBpbiB0aGUgcHJlLXJlZ2lzdHJ5IGBSaXNrQ29uZmlnYCBzaGFwZToKYGFnZW50YCBpcyB0aGUgZmlyc3QgcmVnaXN0ZXJlZCBhZ2VudCAod2hhdGV2ZXIgaXRzIGN1cnJlbnQgcG9saWN5KS4KVXNlIGBnZXRfZ2xvYmFsYCBhbmQgYGdldF9hZ2VudGAgaW5zdGVhZC4AAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAApSaXNrQ29uZmlnAAAAAAAD",
        "AAAAAAAAAAAAAAAKZ2V0X2dsb2JhbAAAAAAAAAAAAAEAAAPpAAAH0AAAAAxHbG9iYWxDb25maWcAAAAD",
        "AAAAAAAAAAAAAAAKbWFya2V0X3BubAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAfQAAAACU1hcmtldFBubAAAAA==",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAKd2luZG93X3BubAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmVtb3ZlZAAAAAEAAAANYWdlbnRfcmVtb3ZlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAADFN1Y2Nlc3NvclNldAAAAAEAAAANc3VjY2Vzc29yX3NldAAAAAAAAAIAAAAAAAAAA29sZAAAAAPoAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFdpdGhkcmF3UGFpZAAAAAEAAAANd2l0aGRyYXdfcGFpZAAAAAAAAAIAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADVBlbmRpbmdDb25maWcAAAAAAAADAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAALcHJvcG9zZWRfYXQAAAAABg==",
        "AAAAAAAAAC9BZ2VudHMgZXZlciByZWdpc3RlcmVkIChyZW1vdmVkIG9uZXMgaW5jbHVkZWQpLgAAAAALYWdlbnRfY291bnQAAAAAAAAAAAEAAAAE",
        "AAAAAAAAANRNYXJrcyBhIG1hcmtldCdzIGV4cG9zdXJlIGFzIGV4aXRlZCAoYFJPTEVfU0VUVExFYCkuIFB1cmUgYm9va2tlZXBpbmcKKHNlZSBgTWFya2V0RXhwb3N1cmVgKSBmb3IgdGhlIGZ1dHVyZSBleHBvc3VyZSBkYXNoYm9hcmQ7IGl0IGRvZXMgbm90Cm1vdmUgZnVuZHMgb3IgZnJlZSBlaXRoZXIgdGhlIGN1bXVsYXRpdmUgcGVyLW1hcmtldCBjYXAgb3IgbmV0CmhlYWRyb29tLgAAAAtjbG9zZV90cmFkZQAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAQBVc2FnZSBvdmVyIHRoZSBzbGlkaW5nIHdpbmRvdyBhcyBvZiBub3c6IGBhbW91bnRgIHN1bXMgZXZlcnkgYnVja2V0CnN0aWxsIGNvdW50ZWQgYWdhaW5zdCBgbWF4X2RhaWx5YCwgYGRheV9zdGFydGAgaXMgdGhlIHN0YXJ0IG9mIHRoZQpvbGRlc3Qgb2YgdGhlbS4gU2lkZS1lZmZlY3QgZnJlZSAoaXQgYWR2YW5jZXMgYSBjb3B5KSwgc28gcmVwZWF0ZWQKcmVhZHMgd2l0aG91dCB0cmFkZXMgaW4gYmV0d2VlbiByZXR1cm4gdGhlIHNhbWUgdmFsdWUuAAAAC2RhaWx5X3VzYWdlAAAAAAAAAAABAAAD6QAAB9AAAAAKRGFpbHlVc2FnZQAAAAAAAw==",
        "AAAAAAAAABNgbWF4X25ldF9leHBvc3VyZWAuAAAAAAtnZXRfbmV0X2NhcAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAABQAAAAAAAAAAAAAADURyYXdkb3duUGF1c2UAAAAAAAABAAAADmRyYXdkb3duX3BhdXNlAAAAAAADAAAAAAAAAA1yZWFsaXplZF9sb3NzAAAAAAAACwAAAAAAAAAAAAAAEHdpbmRvd19zdGFydF9kYXkAAAAGAAAAAAAAAAAAAAATdHJpZ2dlcmVkX2J5X21hcmtldAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldFNldHRsZWQAAAAAAAABAAAADm1hcmtldF9zZXR0bGVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAIcmVkZWVtZWQAAAALAAAAAAAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAAAAAACnNldHRsZWRfYnkAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkUmVjYWxsZWQAAAAAAAABAAAADnlpZWxkX3JlY2FsbGVkAAAAAAAEAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAZyZWFzb24AAAAAABEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkVmVudWVTZXQAAAAAAAABAAAAD3lpZWxkX3ZlbnVlX3NldAAAAAACAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAADm1heF9hbGxvY2F0aW9uAAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAADkNyZWF0aW9uUG9saWN5AAAAAAAGAAAAAAAAABJhbGxvd2VkX2NhdGVnb3JpZXMAAAAAAAQAAAAAAAAAFGNyZWF0aW9uX3dpbmRvd19zZWNzAAAABgAAAAAAAAARbWF4X2Nsb3NlX2hvcml6b24AAAAAAAAGAAAAAAAAABZtYXhfbWFya2V0c19wZXJfd2luZG93AAAAAAAEAAAAAAAAAAhtYXhfc2VlZAAAAAsAAAAAAAAAEW1pbl9jbG9zZV9ob3Jpem9uAAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADkRyYXdkb3duU3RhdHVzAAAAAAADAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAd0cmlwcGVkAAAAAAEAAAAAAAAACndpbmRvd19wbmwAAAAAAAs=",
        "AAAAAQAAADtDb2xsYXRlcmFsIHN0aWxsIG93ZWQgdG8gYG93bmVyYCBmb3Igc2hhcmVzIGFscmVhZHkgYnVybmVkLgAAAAAAAAAADldpdGhkcmF3VGlja2V0AAAAAAADAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACXJlbWFpbmluZwAAAAAAAAs=",
        "AAAAAAAAARdgYWdlbnRfYnV5YCB3aXRoIGEgcGVyLXNoYXJlIGxpbWl0IHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCwgMCA9IG5vbmUpCmFuZCBhIGRlYWRsaW5lICh1bml4IHNlY29uZHMsIG5ldHdvcmsgdGltZSkuIG1hcmtldC1jb3JlJ3MgYGJ1eV92MmAKZW5mb3JjZXMgYm90aDsgYW4gZXhwaXJlZCBvciBvdXQtb2YtbGltaXQgdHJhZGUgcmV2ZXJ0cyB0aGUgd2hvbGUKaW52b2NhdGlvbiwgc28gdGhlIHRyZWFzdXJ5J3MgY2FwcyBhcmUgbmV2ZXIgY29uc3VtZWQgYnkgYSByZXZlcnRlZAp0cmFkZS4AAAAADGFnZW50X2J1eV92MgAAAAcAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAAAAAAAD2xpbWl0X3ByaWNlX2JwcwAAAAAEAAAAAAAAAAhkZWFkbGluZQAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAMY2FuY2VsX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMY29uZmlnX2RlbGF5AAAAAAAAAAEAAAAG",
        "AAAAAAAAAJBDYXBpdGFsIGN1cnJlbnRseSBkZXBsb3llZCBhY3Jvc3MgYWxsIG1hcmtldHM6CmBzdW0obWF4KDAsIGNvbGxhdGVyYWxfaW4gLSBjb2xsYXRlcmFsX291dCkpYCwgdGhlIGZpZ3VyZQpgbWF4X25ldF9leHBvc3VyZWAgaXMgZW5mb3JjZWQgYWdhaW5zdC4AAAAMbmV0X2V4cG9zdXJlAAAAAAAAAAEAAAAL",
        "AAAAAAAAADdOZXQgcG9zaXRpb24gaW4gYG1hcmtldF9pZGAgb2YgdGhlIGN1cnJlbnQgbWFya2V0LWNvcmUuAAAAAAxuZXRfcG9zaXRpb24AAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAC05ldFBvc2l0aW9uAAAAAAM=",
        "AAAAAAAAAERUaGUgdGlja2V0IGBjbGFpbV93aXRoZHJhd2AgcGF5cyBuZXh0LCBhbmQgdGhlIGlkIHRoZSBuZXh0IG9uZSBnZXRzLgAAAAxxdWV1ZV9ib3VuZHMAAAAAAAAAAQAAA+0AAAACAAAABgAAAAY=",
        "AAAAAAAAAJpEZWFjdGl2YXRlcyBgYWdlbnRgIGF0IG9uY2UsIGtlZXBpbmcgaXRzIHVzYWdlIGhpc3RvcnkuIEF0IGxlYXN0IG9uZQphY3RpdmUgYWdlbnQgd2l0aCBgUk9MRV9TRVRUTEVgIG11c3QgcmVtYWluLCBzbyBvcGVuIHBvc2l0aW9ucyBjYW4KYWx3YXlzIGJlIHNldHRsZWQuAAAAAAAMcmVtb3ZlX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMdG90YWxfc2hhcmVzAAAAAAAAAAEAAAAL",
        "AAAABQAAAAAAAAAAAAAADkFnZW50UG9saWN5U2V0AAAAAAABAAAAEGFnZW50X3BvbGljeV9zZXQAAAAEAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0RlbGF5U2V0AAAAAAABAAAAEGNvbmZpZ19kZWxheV9zZXQAAAACAAAAAAAAAANvbGQAAAAABgAAAAAAAAAAAAAAA25ldwAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0V4ZWN1dGVkAAAAAAABAAAAD2NvbmZpZ19leGVjdXRlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAOmB0cnVlYCBmb3IgYSB0aWdodGVuLW9ubHkgY2hhbmdlIGFwcGxpZWQgYXQgcHJvcG9zYWwgdGltZS4AAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ1Byb3Bvc2VkAAAAAAABAAAAD2NvbmZpZ19wcm9wb3NlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldE1pZ3JhdGVkAAAAAAABAAAAD21hcmtldF9taWdyYXRlZAAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJc3VjY2Vzc29yAAAAAAAAEwAAAAEAAAAAAAAAA3llcwAAAAALAAAAAAAAAAAAAAACbm8AAAAAAAsAAAAAAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlBubFdpbmRvd1Jlc2V0AAAAAAABAAAAEHBubF93aW5kb3dfcmVzZXQAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlByaWNlUG9saWN5U2V0AAAAAAABAAAAEHByaWNlX3BvbGljeV9zZXQAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADllpZWxkQWxsb2NhdGVkAAAAAAABAAAAD3lpZWxkX2FsbG9jYXRlZAAAAAADAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAY1SZWdpc3RlcnMgYGFnZW50YCBhcyB0aGUgZmlyc3QgYWdlbnQgd2l0aCBldmVyeSByb2xlIGFuZCB0aGUgZ2xvYmFsCmNhcHMgYXMgaXRzIG93bi4gYG1heF9uZXRfZXhwb3N1cmVgIGNhcHMgY2FwaXRhbCBkZXBsb3llZCBpbiBvcGVuCnBvc2l0aW9ucyBhY3Jvc3MgYWxsIG1hcmtldHMgYXQgb25jZSAoc2VlIGBuZXRfZXhwb3N1cmVgKTsgaXQgbXVzdCBiZQphdCBsZWFzdCBgbWF4X3RyYWRlYC4gYGNvbmZpZ19kZWxheWAgKHNlY29uZHMsIGF0IGxlYXN0CmBNSU5fQ09ORklHX0RFTEFZYCkgaXMgdGhlIHRpbWVsb2NrIG9uIGV2ZXJ5IGxvb3NlbmluZyBjaGFuZ2UuCgpBbnkgY29sbGF0ZXJhbCB0aGUgdHJlYXN1cnkgYWxyZWFkeSBob2xkcyBpcyBtaW50ZWQgYXMgc2hhcmVzIHRvCmBhZG1pbmAuAAAAAAAADV9fY29uc3RydWN0b3IAAAAAAAAMAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACwAAAAAAAAAKbWF4X21hcmtldAAAAAAACwAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAQbWF4X25ldF9leHBvc3VyZQAAAAsAAAAAAAAADGNvbmZpZ19kZWxheQAAAAYAAAAAAAAADG1heF9kcmF3ZG93bgAAAAsAAAAAAAAAC3dpbmRvd19kYXlzAAAAAAQAAAAAAAAAD2NyZWF0aW9uX3BvbGljeQAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAA",
        "AAAAAAAAAKJgYWdlbnRfc2VsbGAgd2l0aCBhIHBlci1zaGFyZSBsaW1pdCBwcmljZSAoYGxpbWl0X3ByaWNlX2Jwc2AsIDAgPSBubwpsaW1pdCkgYW5kIGEgZGVhZGxpbmUgKHVuaXggc2Vjb25kcywgbmV0d29yayB0aW1lKSwgYm90aCBlbmZvcmNlZCBieQptYXJrZXQtY29yZSdzIGBzZWxsX3YyYC4AAAAAAA1hZ2VudF9zZWxsX3YyAAAAAAAABwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAANY2FuY2VsX2NvbmZpZwAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANZGlzYWJsZV95aWVsZAAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAGhBcHBsaWVzIGBhZ2VudGAncyBwZW5kaW5nIHBvbGljeSBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLgpQZXJtaXNzaW9ubGVzczogdGhlIGRlbGF5IGlzIHRoZSBwcm90ZWN0aW9uLgAAAA1leGVjdXRlX2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIJgcmVkZWVtYCBhZ2FpbnN0IGEgbWFya2V0LWNvcmUgdGhpcyB0cmVhc3VyeSB3YXMgc3dpdGNoZWQgYXdheSBmcm9tCihzZWUgYGV4ZWN1dGVfY29uZmlnYCksIHNvIHBvc2l0aW9ucyB0aGVyZSBhcmUgbmV2ZXIgc3RyYW5kZWQuAAAAAAANbGVnYWN5X3JlZGVlbQAAAAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAANcGVuZGluZ19hZ2VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPoAAAH0AAAAAxQZW5kaW5nQWdlbnQ=",
        "AAAAAAAAALRTZXRzIHRoZSBzdWNjZXNzb3IgdHJlYXN1cnkgdGhhdCBgbWlncmF0ZV9tYXJrZXRgIGhhbmRzIHBvc2l0aW9ucyBhbmQKdGhlIExQIHJvbGUgdG8uIEFkbWluLW9ubHk7IG92ZXJ3cml0ZXMgYW55IHByZXZpb3VzIHN1Y2Nlc3NvciAodGhlCmBTdWNjZXNzb3JTZXRgIGV2ZW50cyBhcmUgdGhlIGF1ZGl0IHRyYWlsKS4AAAANc2V0X3N1Y2Nlc3NvcgAAAAAAAAEAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAJVQZXJtaXNzaW9ubGVzcyBzZXR0bGVtZW50IG9mIGEgcmVzb2x2ZWQgb3Igdm9pZGVkIG1hcmtldCdzIHBvc2l0aW9uIGFuZCBMUCByZW1haW5kZXIuCk9wZXJhdGVzIGV2ZW4gd2hlbiB0aGUgdHJlYXN1cnkgaXMgcGF1c2VkLiBJZGVtcG90ZW50IG9uIHJldHJ5LgAAAAAAAA1zZXR0bGVfbWFya2V0AAAAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAEFNldHRsZW1lbnRSZXBvcnQAAAAD",
        "AAAABQAAAAAAAAAAAAAAD0NvbmZpZ0NhbmNlbGxlZAAAAAABAAAAEGNvbmZpZ19jYW5jZWxsZWQAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAABFUaGUgYWN0aW5nIGFnZW50LgAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAxtYXJrZXRfdG90YWwAAAALAAAAAAAAAAAAAAALZGFpbHlfdG90YWwAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAAEENhcGl0YWxCcmVha2Rvd24AAAADAAAAAAAAAAZsaXF1aWQAAAAAAAsAAAAAAAAAD3lpZWxkX3ByaW5jaXBhbAAAAAALAAAAAAAAAAt5aWVsZF92YWx1ZQAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEFNldHRsZW1lbnRSZXBvcnQAAAADAAAAAAAAAA9hbHJlYWR5X3NldHRsZWQAAAAAAQAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAIcmVkZWVtZWQAAAAL",
        "AAAAAAAAAMlQYXlzIHRoZSB0aWNrZXQgYXQgdGhlIGhlYWQgb2YgdGhlIHF1ZXVlIGFzIGZhciBhcyBpZGxlIGNvbGxhdGVyYWwKYWxsb3dzLiBQZXJtaXNzaW9ubGVzczogdGhlIG1vbmV5IGFsd2F5cyBnb2VzIHRvIHRoZSB0aWNrZXQncyBvd25lci4KT25seSB0aGUgaGVhZCB0aWNrZXQgY2FuIGJlIHBhaWQgKGBOb3RoaW5nVG9QYXlgIGZvciBsYXRlciBvbmVzKS4AAAAAAAAOY2xhaW1fd2l0aGRyYXcAAAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAOY3JlYXRpb25fdXNhZ2UAAAAAAAAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAHNIb3cgbXVjaCBtb3JlIHRoZSBhZ2VudHMgdG9nZXRoZXIgbWF5IGRlcGxveSByaWdodCBub3cgYmVmb3JlCmBtYXhfZGFpbHlgIChgbWF4X2RhaWx5IC0gd2luZG93IHN1bWAsIGZsb29yZWQgYXQgMCkuAAAAAA5kYWlseV9oZWFkcm9vbQAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAcpBcHBsaWVzIHRoZSBwZW5kaW5nIGNvbmZpZyBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLiBQZXJtaXNzaW9ubGVzcywKc28gZXhlY3V0aW9uIG5ldmVyIGRlcGVuZHMgb24gdGhlIGFkbWluIGJlaW5nIGF2YWlsYWJsZS4KCkEgYG1hcmtldF9jb3JlYCBjaGFuZ2UgcmVjb3JkcyB0aGUgb2xkIGNvcmUgYXMgbGVnYWN5OiBpdHMgcG9zaXRpb25zCnN0YXkgd2hlcmUgdGhleSBhcmUgKHJlY292ZXIgdGhlbSB3aXRoIGBsZWdhY3lfcmVkZWVtYCAvCmBsZWdhY3lfY2xhaW1fcG9vbF9yZW1haW5kZXJgKSwgYW5kIGV4cG9zdXJlIGZvciB0aGUgbmV3IGNvcmUgaXMga2VwdAp1bmRlciBrZXlzIG5hbWVzcGFjZWQgYnkgY29yZSBzbyBtYXJrZXQgaWRzIGNhbm5vdCBjb2xsaWRlLiBUaGUgbmV3CmNvcmUgbXVzdCBiZSBwb2ludGVkIGF0IHRoaXMgdHJlYXN1cnkgd2l0aCBpdHMgb3duIGBzZXRfdHJlYXN1cnlgLgAAAAAADmV4ZWN1dGVfY29uZmlnAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADhMaXF1aWQgY29sbGF0ZXJhbCBiYWxhbmNlIGhlbGQgZGlyZWN0bHkgaW4gdGhlIHRyZWFzdXJ5LgAAAA5saXF1aWRfY2FwaXRhbAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAqxNb3ZlcyB0aGUgdHJlYXN1cnkncyBwb3NpdGlvbiBpbiBgbWFya2V0X2lkYCDigJQgYW5kIHRoZSBMUCByb2xlLCB3aGVuCnRoZSB0cmVhc3VyeSBpcyB0aGUgbWFya2V0J3MgY3JlYXRvciBhbmQgaGFzIG5vdCBjbGFpbWVkIHRoZSByZW1haW5kZXIKeWV0IOKAlCB0byB0aGUgc3VjY2Vzc29yIHNldCB2aWEgYHNldF9zdWNjZXNzb3JgLCB0aGVuIGNsb3NlcyB0aGUgbG9jYWwKZXhwb3N1cmUuIEFkbWluLW9ubHk6IHJlbG9jYXRpbmcgY2FwaXRhbCBpcyBub3QgYW4gYWdlbnQgdHJhZGluZwphY3Rpb24sIGFuZCB0aGUgYWdlbnQga2V5IG11c3Qgbm90IGJlIGFibGUgdG8gZHJhaW4gcG9zaXRpb25zLgoKbWFya2V0LWNvcmUncyBgdHJhbnNmZXJfcG9zaXRpb25gIC8gYHRyYW5zZmVyX2xwYCByZXF1aXJlIHRoZSB0cmVhc3VyeQppdHNlbGYgdG8gYXV0aG9yaXplLiBCZWNhdXNlIHRoZSB0cmVhc3VyeSBpcyB0aGVpciAqZGlyZWN0KiBjYWxsZXIKaGVyZSwgdGhlIGltcGxpY2l0IGludm9rZXIgYXV0aG9yaXphdGlvbiBjb3ZlcnMgYm90aCDigJQgbm8KYGF1dGhvcml6ZV9hc19jdXJyZW50X2NvbnRyYWN0YCBlbnRyeSBpcyBuZWVkZWQgKHVubGlrZSB0aGUgbmVzdGVkCnRva2VuIHRyYW5zZmVyIGluIGBhZ2VudF9idXlgLCBzZWUgYGRvY3MvYWRyLzAwMDItdHJlYXN1cnktbmVzdGVkLWF1dGgubWRgKS4AAAAObWlncmF0ZV9tYXJrZXQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOb3Blbl9tYXJrZXRfYXQAAAAAAAEAAAAAAAAAAWkAAAAAAAAEAAAAAQAAA+gAAAfQAAAACk9wZW5NYXJrZXQAAA==",
        "AAAAAAAAAAAAAAAOcGVuZGluZ19jb25maWcAAAAAAAAAAAABAAAD6AAAB9AAAAANUGVuZGluZ0NvbmZpZwAAAA==",
        "AAAAAAAAAKdQcm9wb3NlcyBgY29uZmlnYCBhcyB0aGUgZ2xvYmFsIGNvbmZpZyAoYWRtaW4pLiBUaWdodGVuLW9ubHkKcHJvcG9zYWxzIGFwcGx5IGF0IG9uY2UgYW5kIGxlYXZlIGFueSBwZW5kaW5nIHByb3Bvc2FsIGFuZCBpdHMgdGltZXIKYXMgdGhleSBhcmU7IGFueXRoaW5nIGVsc2UgaXMgcXVldWVkLgAAAAAOcHJvcG9zZV9jb25maWcAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAxHbG9iYWxDb25maWcAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAD5Db2xsYXRlcmFsIG93ZWQgdG8gcXVldWVkIHdpdGhkcmF3YWxzOyBhZ2VudHMgY2Fubm90IHNwZW5kIGl0LgAAAAAADnF1ZXVlX3Jlc2VydmVkAAAAAAAAAAAAAQAAAAs=",
        "AAAAAAAAAAAAAAAPZHJhd2Rvd25fc3RhdHVzAAAAAAAAAAABAAAD6QAAB9AAAAAORHJhd2Rvd25TdGF0dXMAAAAAAAM=",
        "AAAAAAAAAAAAAAAPc2V0X3lpZWxkX3ZlbnVlAAAAAAIAAAAAAAAABHBvb2wAAAATAAAAAAAAAA5tYXhfYWxsb2NhdGlvbgAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPd2l0aGRyYXdfdGlja2V0AAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAAOV2l0aGRyYXdUaWNrZXQAAA==",
        "AAAAAAAAAAAAAAAQZ2V0X3ByaWNlX3BvbGljeQAAAAAAAAABAAAH0AAAAAtQcmljZVBvbGljeQA=",
        "AAAAAAAAALZDb25zZXJ2YXRpdmUgdmFsdWF0aW9uIG9mIHRoZSB0cmVhc3VyeSdzIGhvbGRpbmdzIGluIGBtYXJrZXRfaWRgCihzZWUgW2BWYWx1YXRpb25gXSkuIFR3byBjcm9zcy1jb250cmFjdCByZWFkcyAoYGdldF9tYXJrZXRgLApgZ2V0X3Bvc2l0aW9uYCk7IGEgdmlldyBvbmx5LCBuZXZlciBvbiB0aGUgdHJhZGluZyBwYXRoLgAAAAAAEG1hcmtldF92YWx1YXRpb24AAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAACVZhbHVhdGlvbgAAAAAAAAM=",
        "AAAAAAAAAPRCdXJucyBgc2hhcmVzYCBvZiBgb3duZXJgIGF0IHRoZSBjdXJyZW50IE5BViwgcGF5cyB3aGF0IGZyZWUgaWRsZQpjb2xsYXRlcmFsIGFsbG93cyBub3cgYW5kIHF1ZXVlcyB0aGUgcmVzdCBhcyBhIHRpY2tldCAoRklGTywgcGFpZCBieQpgY2xhaW1fd2l0aGRyYXdgIGFzIGNhcGl0YWwgcmV0dXJucykuIFJldHVybnMgYChwYWlkX25vdywgdGlja2V0X2lkKWAsCmB0aWNrZXRfaWRgIDAgd2hlbiBub3RoaW5nIHdhcyBxdWV1ZWQuAAAAEHJlcXVlc3Rfd2l0aGRyYXcAAAACAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAABnNoYXJlcwAAAAAACwAAAAEAAAPpAAAD7QAAAAIAAAALAAAABgAAAAM=",
        "AAAAAAAAAAAAAAAQcmVzZXRfcG5sX3dpbmRvdwAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAKlMZW5ndGhlbnMgdGhlIHRpbWVsb2NrLiBTaG9ydGVuaW5nIGlzIHJlZnVzZWQgb3V0cmlnaHQ6IGl0IHdvdWxkCml0c2VsZiBoYXZlIHRvIHdhaXQgb3V0IHRoZSBvbGQgZGVsYXkgdG8gYmUgc2FmZSwgYW5kIGEgbGVuZ3RoZW5pbmcKY2FuIGFsd2F5cyBiZSB1bmRvbmUgYnkgcmVkZXBsb3lpbmcuAAAAAAAAEHNldF9jb25maWdfZGVsYXkAAAABAAAAAAAAAAluZXdfZGVsYXkAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAMFTZXRzIHRoZSBwcmljZSBsaW1pdHMgb24gYWdlbnQgdHJhZGVzIChhZG1pbikuIExpa2UgdGhlIGNhcHMsCnRpZ2h0ZW5pbmcgKGxvd2VyIGBtYXhfYnV5YC9gbWF4X2ltcGFjdGAvYG1heF9zbGlwcGFnZWAsIGhpZ2hlcgpgbWluX3NlbGxgKSBhcHBsaWVzIGF0IG9uY2UgYW5kIGFueXRoaW5nIGVsc2Ugd2FpdHMgYGNvbmZpZ19kZWxheWAuAAAAAAAAEHNldF9wcmljZV9wb2xpY3kAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALUHJpY2VQb2xpY3kAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAERgYWdlbnRgJ3Mgb3duIHNsaWRpbmctd2luZG93IHVzYWdlLCBjb3VudGVkIGFnYWluc3QgaXRzIGBtYXhfZGFpbHlgLgAAABFhZ2VudF9kYWlseV91c2FnZQAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAH0AAAAApEYWlseVVzYWdlAAAAAAAD",
        "AAAAAAAAAAAAAAARYWxsb2NhdGVfdG9feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAE5Ub3RhbCBjYXBpdGFsIGRlcGxveWFibGU6IGxpcXVpZCBjb2xsYXRlcmFsIGJhbGFuY2UgcGx1cyBzdXBwbGllZCB5aWVsZCB2YWx1ZS4AAAAAABFhdmFpbGFibGVfY2FwaXRhbAAAAAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAE5CcmVha2Rvd24gb2YgdHJlYXN1cnkgY2FwaXRhbCBhY3Jvc3MgbGlxdWlkLCB5aWVsZCBwcmluY2lwYWwsIGFuZCB5aWVsZCB2YWx1ZS4AAAAAABFjYXBpdGFsX2JyZWFrZG93bgAAAAAAAAAAAAABAAAD6QAAB9AAAAAQQ2FwaXRhbEJyZWFrZG93bgAAAAM=",
        "AAAAAAAAAAAAAAARb3Blbl9tYXJrZXRfY291bnQAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAARcmVjYWxsX2Zyb21feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAE0FnZW50UG9saWN5UHJvcG9zZWQAAAAAAQAAABVhZ2VudF9wb2xpY3lfcHJvcG9zZWQAAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1ByaWNlUG9saWN5UHJvcG9zZWQAAAAAAQAAABVwcmljZV9wb2xpY3lfcHJvcG9zZWQAAAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAAAAAAAEZUaGUgaG91cmx5IGJ1Y2tldHMgYmVoaW5kIGBkYWlseV91c2FnZWAsIGFkdmFuY2VkIHRvIG5vdyAobm90IHN0b3JlZCkuAAAAAAASZGFpbHlfdXNhZ2VfZGV0YWlsAAAAAAAAAAAAAQAAA+kAAAfQAAAAC1VzYWdlV2luZG93AAAAAAM=",
        "AAAAAAAAAPdXaGlsZSBwYXVzZWQgb25seTogYnVybnMgYHNoYXJlc2AgZm9yIHRoZWlyIHByby1yYXRhIHBhcnQgb2YgdGhlIGZyZWUKaWRsZSBjb2xsYXRlcmFsLCB3aXRob3V0IHJlYWRpbmcgbWFya2V0LWNvcmUgKGZvciB3aGVuIGl0IGlzIHRoZQp0aGluZyB0aGF0IGJyb2tlKS4gVGhlIG93bmVyIGZvcmZlaXRzIHRoZWlyIHBhcnQgb2Ygb3BlbiBwb3NpdGlvbnMsCndoaWNoIHN0YXlzIHdpdGggdGhlIHJlbWFpbmluZyBzaGFyZWhvbGRlcnMuAAAAABJlbWVyZ2VuY3lfd2l0aGRyYXcAAAAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAJ9DbGFpbXMgdGhlIG1hcmtldCdzIExQIGZlZSBzaGFyZSBmb3IgYSBtYXJrZXQgdGhlIHRyZWFzdXJ5IGNyZWF0ZWQKKGBST0xFX1NFVFRMRWApLiBUaGUgTFAgcG9ydGlvbiBhY2NydWVzIHNlcGFyYXRlbHkgb24gbWFya2V0LWNvcmUKKHNlZSBpdHMgYGNsYWltX2xwX2ZlZXNgKS4AAAAAE2FnZW50X2NsYWltX2xwX2ZlZXMAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAQxDcmVhdGVzIGFuZCBzZWVkcyBhIG1hcmtldCB1c2luZyB0cmVhc3VyeSBjYXBpdGFsIChgUk9MRV9DUkVBVEVgKS4KVGhlIHRyZWFzdXJ5IGJlY29tZXMgdGhlIG1hcmtldCdzIGNyZWF0b3IvTFAuIGBpbml0aWFsX3llc19icHNgIG11c3QKbGllIHdpdGhpbiB0aGUgcHJpY2UgcG9saWN5J3MgYFttaW5fc2VsbCwgbWF4X2J1eV1gIGJhbmQsIHNvIHRoZQp0cmVhc3VyeSBuZXZlciBzZWVkcyBhIG1hcmtldCB3aG9zZSBjcmVhdG9yIHNpZGUgaXMgbmVhciB3b3J0aGxlc3MuAAAAE2FnZW50X2NyZWF0ZV9tYXJrZXQAAAAACAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX3ByaWNlX3BvbGljeQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAWRQdWxscyBhY2NydWVkICoqcHJvdG9jb2wqKiBmZWVzIGZyb20gYSBjb25maWd1cmVkIG1hcmtldC1jb3JlIGNvbnRyYWN0LgoKT25seSB0aGUgcHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIG1hcmtldCdzIGZlZXM6IHRoZSBMUCBwb3J0aW9uIGFjY3J1ZXMKc2VwYXJhdGVseSBvbiBtYXJrZXQtY29yZSBhbmQgYmVsb25ncyB0byB0aGUgbWFya2V0J3MgY3JlYXRvciDigJQgZm9yCmFnZW50LWNyZWF0ZWQgbWFya2V0cyB0aGF0IGlzIHRoZSB0cmVhc3VyeSBpdHNlbGYsIHZpYQpgYWdlbnRfY2xhaW1fbHBfZmVlc2AuIEZlZXMgcmFpc2UgTkFWIGZvciBldmVyeSBzaGFyZWhvbGRlciBhdCB0aGUKbW9tZW50IHRoZXkgYXJyaXZlLgAAABNjb2xsZWN0X21hcmtldF9mZWVzAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAATZ2V0X2NyZWF0aW9uX3BvbGljeQAAAAAAAAAAAQAAA+kAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2NyZWF0aW9uX3BvbGljeQAAAAABAAAAAAAAAApuZXdfcG9saWN5AAAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2RyYXdkb3duX2NvbmZpZwAAAAACAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAt3aW5kb3dfZGF5cwAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFUNyZWF0aW9uUG9saWN5VXBkYXRlZAAAAAAAAAEAAAAXY3JlYXRpb25fcG9saWN5X3VwZGF0ZWQAAAAAAgAAAAAAAAADb2xkAAAAB9AAAAAOQ3JlYXRpb25Qb2xpY3kAAAAAAAAAAAAAAAAAA25ldwAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAUYWNrbm93bGVkZ2VfZHJhd2Rvd24AAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAE9DbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVyIGZvciBhIG1hcmtldCB0aGUgdHJlYXN1cnkgY3JlYXRlZAooYFJPTEVfU0VUVExFYCkuAAAAABRjbGFpbV9wb29sX3JlbWFpbmRlcgAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAEtBcHBsaWVzIHRoZSBwZW5kaW5nIHByaWNlIHBvbGljeSBvbmNlIGl0cyBkZWxheSBoYXMgcGFzc2VkLgpQZXJtaXNzaW9ubGVzcy4AAAAAFGV4ZWN1dGVfcHJpY2VfcG9saWN5AAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAUcGVuZGluZ19wcmljZV9wb2xpY3kAAAAAAAAAAQAAA+gAAAfQAAAAElBlbmRpbmdQcmljZVBvbGljeQAA",
        "AAAAAAAAADRgY2xhaW1fcG9vbF9yZW1haW5kZXJgIGFnYWluc3QgYSBsZWdhY3kgbWFya2V0LWNvcmUuAAAAG2xlZ2FjeV9jbGFpbV9wb29sX3JlbWFpbmRlcgAAAAADAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAoFMaWtlIFtgVHJlYXN1cnk6OmFnZW50X2NyZWF0ZV9tYXJrZXRgXSwgYnV0IHJldmVhbHMgdGhlIHJlc29sdXRpb24gcnVsZQppbiB0aGUgc2FtZSB0cmFuc2FjdGlvbiAoIzY0KS4gVGhlIG1hcmtldCBpcyBjcmVhdGVkIHdpdGggdGhlIGNvbW1pdG1lbnQKZGVyaXZlZCBmcm9tIGBzcGVjX3YyYCBpdHNlbGYsIHNvIHRoZSBmb2xsb3ctdXAgcmV2ZWFsIG5lY2Vzc2FyaWx5Cm1hdGNoZXMgYW5kIHRoZSBtYXJrZXQgY2FuIG5ldmVyIGJlIGxlZnQgdW5yZXNvbHZhYmxlLiBgcmVzb2x2ZXJgIGlzIHRoZQpkZXBsb3llZCByZXNvbHZlciBjb250cmFjdDsgaXQgbXVzdCBiZSBjb25maWd1cmVkIGZvciB0aGlzIHRyZWFzdXJ5J3MKbWFya2V0LWNvcmUuCgpUaGUgcm91dGVyIGNhbm5vdCBzZXJ2ZSB0aGlzIHBhdGg6IHNlZWRpbmcgcHVsbHMgY29sbGF0ZXJhbCBmcm9tIHRoZQp0cmVhc3VyeSBjb250cmFjdCAobm90IHRoZSBlbmQgdXNlcikgdmlhIGEgY29udHJhY3Qgc2VsZi1hdXRob3JpemF0aW9uLAp3aGljaCBvbmx5IHRoaXMgY29udHJhY3QgY2FuIHBlcmZvcm0g4oCUIGEgc3RhdGVsZXNzIHJvdXRlciBiZXR3ZWVuIHRoZQphZ2VudCBhbmQgbWFya2V0LWNvcmUgd291bGQgbm90IGJlIGF1dGhvcml6ZWQgb24gdGhlIHRva2VuLgAAAAAAAB5hZ2VudF9jcmVhdGVfbWFya2V0X2FuZF9yZXZlYWwAAAAAAAkAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAACG1ldGFfdXJpAAAAEAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAtzZWVkX2Ftb3VudAAAAAALAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAHc3BlY192MgAAAAfQAAAAEFJlc29sdXRpb25TcGVjVjIAAAABAAAD6QAAAAYAAAAD",
        "AAAAAgAAAAAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAEAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAAAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADENvbW1pdHRlZVJlZgAAAAQAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAABJtYXhfcm90YXRpb25fZGVsdGEAAAAAAAQAAAAAAAAACW1pbl9lcG9jaAAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAgAAAAAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAGAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAAAAAAAZIeWJyaWQAAAAAAAEAAAfQAAAADEh5YnJpZENvbmZpZw==",
        "AAAAAQAAAAAAAAAAAAAAEFJlc29sdXRpb25TcGVjVjIAAAAFAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAAAQAAAAAAAAAAAAAAFkRpc3B1dGFibGVTaWduZXJDb25maWcAAAAAAAYAAAAAAAAADGRpc3B1dGVfYm9uZAAAAAsAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAplc2NhbGF0aW9uAAAAAAfQAAAACkVzY2FsYXRpb24AAAAAAAAAAAASZXNjYWxhdGlvbl90aW1lb3V0AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE" ]),
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
        get_agent: this.txFromJSON<Option<AgentPolicy>>,
        set_agent: this.txFromJSON<Result<void>>,
        shares_of: this.txFromJSON<i128>,
        agent_sell: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<RiskConfig>>,
        get_global: this.txFromJSON<Result<GlobalConfig>>,
        market_pnl: this.txFromJSON<MarketPnl>,
        set_paused: this.txFromJSON<Result<void>>,
        window_pnl: this.txFromJSON<Result<i128>>,
        agent_count: this.txFromJSON<u32>,
        close_trade: this.txFromJSON<Result<i128>>,
        daily_usage: this.txFromJSON<Result<DailyUsage>>,
        get_net_cap: this.txFromJSON<Result<i128>>,
        agent_buy_v2: this.txFromJSON<Result<i128>>,
        cancel_agent: this.txFromJSON<Result<void>>,
        config_delay: this.txFromJSON<u64>,
        net_exposure: this.txFromJSON<i128>,
        net_position: this.txFromJSON<Result<NetPosition>>,
        queue_bounds: this.txFromJSON<readonly [u64, u64]>,
        remove_agent: this.txFromJSON<Result<void>>,
        total_shares: this.txFromJSON<i128>,
        agent_sell_v2: this.txFromJSON<Result<i128>>,
        cancel_config: this.txFromJSON<Result<void>>,
        disable_yield: this.txFromJSON<Result<void>>,
        execute_agent: this.txFromJSON<Result<void>>,
        legacy_redeem: this.txFromJSON<Result<i128>>,
        pending_agent: this.txFromJSON<Option<PendingAgent>>,
        set_successor: this.txFromJSON<Result<void>>,
        settle_market: this.txFromJSON<Result<SettlementReport>>,
        claim_withdraw: this.txFromJSON<Result<i128>>,
        creation_usage: this.txFromJSON<Result<u32>>,
        daily_headroom: this.txFromJSON<Result<i128>>,
        execute_config: this.txFromJSON<Result<void>>,
        liquid_capital: this.txFromJSON<Result<i128>>,
        migrate_market: this.txFromJSON<Result<void>>,
        open_market_at: this.txFromJSON<Option<OpenMarket>>,
        pending_config: this.txFromJSON<Option<PendingConfig>>,
        propose_config: this.txFromJSON<Result<void>>,
        queue_reserved: this.txFromJSON<i128>,
        drawdown_status: this.txFromJSON<Result<DrawdownStatus>>,
        set_yield_venue: this.txFromJSON<Result<void>>,
        withdraw_ticket: this.txFromJSON<Option<WithdrawTicket>>,
        get_price_policy: this.txFromJSON<PricePolicy>,
        market_valuation: this.txFromJSON<Result<Valuation>>,
        request_withdraw: this.txFromJSON<Result<readonly [i128, u64]>>,
        reset_pnl_window: this.txFromJSON<Result<void>>,
        set_config_delay: this.txFromJSON<Result<void>>,
        set_price_policy: this.txFromJSON<Result<void>>,
        agent_daily_usage: this.txFromJSON<Result<DailyUsage>>,
        allocate_to_yield: this.txFromJSON<Result<void>>,
        available_capital: this.txFromJSON<Result<i128>>,
        capital_breakdown: this.txFromJSON<Result<CapitalBreakdown>>,
        open_market_count: this.txFromJSON<u32>,
        recall_from_yield: this.txFromJSON<Result<void>>,
        daily_usage_detail: this.txFromJSON<Result<UsageWindow>>,
        emergency_withdraw: this.txFromJSON<Result<i128>>,
        agent_claim_lp_fees: this.txFromJSON<Result<i128>>,
        agent_create_market: this.txFromJSON<Result<u64>>,
        cancel_price_policy: this.txFromJSON<Result<void>>,
        collect_market_fees: this.txFromJSON<Result<i128>>,
        get_creation_policy: this.txFromJSON<Result<CreationPolicy>>,
        set_creation_policy: this.txFromJSON<Result<void>>,
        set_drawdown_config: this.txFromJSON<Result<void>>,
        acknowledge_drawdown: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        execute_price_policy: this.txFromJSON<Result<void>>,
        pending_price_policy: this.txFromJSON<Option<PendingPricePolicy>>,
        legacy_claim_pool_remainder: this.txFromJSON<Result<i128>>,
        agent_create_market_and_reveal: this.txFromJSON<Result<u64>>
  }
}