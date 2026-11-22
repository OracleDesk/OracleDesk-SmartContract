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

export type SkipReason = {tag: "NotFound", values: void} | {tag: "NotFinal", values: void} | {tag: "NothingToRedeem", values: void} | {tag: "AlreadyClaimed", values: void} | {tag: "NotCreator", values: void} | {tag: "Duplicate", values: void};


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
  59: {message:"CategoryCapExceeded"},
  60: {message:"BucketCapExceeded"},
  61: {message:"NoPendingAdmin"},
  62: {message:"PendingAdminExpired"},
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
  77: {message:"OpNotReady"},
  78: {message:"OpExpired"},
  79: {message:"NoPendingOp"},
  80: {message:"BelowExitFloor"},
  81: {message:"InvalidExitFloor"},
  82: {message:"CollateralNotAllowed"},
  /**
   * The treasury is in `Mode::Emergency`: only settlement, claiming existing
   * withdrawal tickets and `emergency_withdraw` are open (#272).
   */
  83: {message:"EmergencyMode"},
  /**
   * `resume_agents`: the realized window PnL has not recovered above
   * `-max_drawdown` (reset the window or wait for old losses to expire) (#272).
   */
  84: {message:"NotRecovered"},
  /**
   * The market's resolution spec was never revealed to its resolver, or a
   * resolver accepted `register_spec_v2` and stored nothing (#273).
   */
  86: {message:"SpecNotRevealed"},
  /**
   * The market's spec kind is not in `allowed_specs` (#273).
   */
  87: {message:"SpecKindNotAllowed"},
  /**
   * The market is `Disputed`: finalization is frozen (#273).
   */
  88: {message:"MarketDisputed"},
  /**
   * A signer proposal is pending and the policy blocks buys then (#273).
   */
  89: {message:"ProposalOpen"},
  /**
   * Past `close_time + RESOLUTION_GRACE_SECS`: the market can already be voided (#273).
   */
  90: {message:"PastResolutionDeadline"},
  /**
   * Closer to `close_time` than `min_secs_to_close` (#273).
   */
  91: {message:"TooCloseToClose"},
  /**
   * A call to the resolver failed (#273).
   */
  92: {message:"ResolverCallFailed"}
}

export type AdminOp = {tag: "SetYieldVenue", values: readonly [string, i128]} | {tag: "AllocateToYield", values: readonly [i128]} | {tag: "SetSuccessor", values: readonly [string]} | {tag: "MigrateMarkets", values: readonly [Array<u64>]} | {tag: "SetDrawdownConfig", values: readonly [i128, u32]} | {tag: "ResetPnlWindow", values: void} | {tag: "SetCreationPolicy", values: readonly [CreationPolicy]} | {tag: "SetCorrelationCaps", values: readonly [CorrelationCaps]};


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


export interface TokenCaps {
  max_daily: i128;
  max_market: i128;
  max_trade: i128;
}


export interface Valuation {
  at_risk: i128;
  cost_basis: i128;
  floor_value: i128;
  spot_value: i128;
}



export interface DailyUsage {
  amount: i128;
  day_start: u64;
}


export interface MarkRecord {
  close_time: u64;
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


export interface OpenMarket {
  core: string;
  market_id: u64;
}


export interface RiskConfig {
  agent: string;
  collateral: string;
  market_core: string;
  max_daily: i128;
  max_market: i128;
  max_trade: i128;
}



export interface AgentPolicy {
  active: boolean;
  max_daily: i128;
  max_trade: i128;
  roles: u32;
}


export interface NetPosition {
  collateral_in: i128;
  collateral_out: i128;
}


export interface PricePolicy {
  max_buy_price_bps: u32;
  max_impact_bps: u32;
  max_slippage_bps: u32;
  min_sell_price_bps: u32;
}

export type TracePolicy = {tag: "Off", values: void} | {tag: "Optional", values: void} | {tag: "Required", values: void};


export interface UsageWindow {
  amounts: Array<i128>;
  head_hour: u64;
  head_idx: u32;
}





export interface GlobalConfig {
  collateral: string;
  market_core: string;
  max_daily: i128;
  max_market: i128;
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


export interface PendingAdminOp {
  executable_at: u64;
  expires_at: u64;
  op: AdminOp;
  proposed_at: u64;
}


export interface PendingMarkAge {
  executable_at: u64;
  ledgers: u32;
}


/**
 * Collateral still owed to `owner` for shares already burned.
 */
export interface WithdrawTicket {
  created_at: u64;
  owner: string;
  remaining: i128;
}












export interface CorrelationCaps {
  bucket_secs: u64;
  max_per_bucket: i128;
  max_per_category: Array<i128>;
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




export interface PendingCorrelation {
  caps: CorrelationCaps;
  executable_at: u64;
  proposed_at: u64;
}


export interface PendingPricePolicy {
  executable_at: u64;
  policy: PricePolicy;
  proposed_at: u64;
}




/**
 * Pre-trade resolvability policy for `agent_buy` / `agent_buy_v2` (#273): the
 * treasury will not put depositor capital into a market that cannot be
 * resolved, whatever the agent believes. Sells, redemptions and settlement are
 * never gated by it (the treasury must always be able to exit or settle).
 * 
 * Tightening is immediate (a flag set to `true`, a larger `min_secs_to_close`,
 * fewer `allowed_specs` bits); everything else waits `config_delay`, like the
 * other policies. The default is fully permissive, so an upgraded deployment
 * behaves as before until the admin tightens it.
 */
export interface ResolvabilityPolicy {
  /**
 * Bitmask over `resolver::SpecKind`: kinds that may be bought into.
 */
allowed_specs: u32;
  /**
 * No buys while the resolver reports `Disputed` (finalization frozen).
 */
block_when_disputed: boolean;
  /**
 * No buys while a signer proposal is pending. Off by default: opening a
 * proposal needs a signer, but a quorum can still use it to freeze buys.
 */
block_with_open_proposal: boolean;
  /**
 * Minimum seconds between now and `close_time` for a buy (0 = none). Does
 * not apply to seed-and-reveal creation, which happens far from close.
 */
min_secs_to_close: u64;
  /**
 * The market's resolution spec must have been revealed to its resolver.
 */
require_revealed: boolean;
}




export interface PendingResolvability {
  executable_at: u64;
  policy: ResolvabilityPolicy;
  proposed_at: u64;
}











/**
 * A class of state-changing entrypoint. Every one the treasury exposes maps to
 * exactly one `Op` (or is pure admin configuration, which is never gated; see
 * the `matrix` test in `lib.rs`).
 */
export type Op = {tag: "Deposit", values: void} | {tag: "RequestWithdraw", values: void} | {tag: "ClaimWithdraw", values: void} | {tag: "EmergencyWithdraw", values: void} | {tag: "AgentOpen", values: void} | {tag: "AgentReduce", values: void} | {tag: "AgentSettle", values: void} | {tag: "PermissionlessSettle", values: void} | {tag: "YieldAllocate", values: void} | {tag: "YieldRecall", values: void} | {tag: "Migrate", values: void};

/**
 * What the treasury is doing right now, derived from [`ModeState`] with the
 * priority `Emergency > Paused > AgentsHalted > Unwinding > Normal`.
 */
export type Mode = {tag: "Normal", values: void} | {tag: "AgentsHalted", values: void} | {tag: "Paused", values: void} | {tag: "Emergency", values: void} | {tag: "Unwinding", values: void};


/**
 * Why the treasury is not in `Normal`. Each reason is stored independently, so
 * clearing one never clears another.
 */
export interface ModeState {
  /**
 * Ledger time of the admin pause. Cleared by `unpause` / `set_paused(false)`.
 */
admin_pause_at: Option<u64>;
  /**
 * The reason the admin gave (`admin` for `set_paused(true)`; `legacy` for a
 * pause read from the pre-#272 flags). Set with `admin_pause_at`.
 */
admin_pause_reason: Option<string>;
  /**
 * Ledger time a drawdown halted the agents. Cleared by `resume_agents`.
 */
drawdown_halt: Option<u64>;
  /**
 * Ledger time the admin declared an emergency. Cleared by `end_emergency`.
 */
emergency_at: Option<u64>;
  /**
 * The reason the admin gave. Set with `emergency_at`.
 */
emergency_reason: Option<string>;
  /**
 * Ledger time the admin set `Unwinding`. Cleared by `set_mode(Normal)`.
 */
unwinding_at: Option<u64>;
}

export interface Client {
  /**
   * Construct and simulate a nav transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  nav: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a mode transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The effective operating mode.
   */
  mode: (options?: MethodOptions) => Promise<AssembledTransaction<Mode>>

  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin pause: no deposits and no agent trading (settlement, queued
   * withdrawals and recalls stay open). Idempotent.
   */
  pause: ({reason}: {reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems the treasury's position in a resolved/voided market
   * (`ROLE_SETTLE`).
   */
  redeem: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a allowed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `op` is permitted in the current mode: the gate's answer, for
   * agents and frontends to pre-check.
   */
  allowed: ({op}: {op: Op}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  deposit: ({from, amount}: {from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a realize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  realize: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Clears the admin pause only. A drawdown halt, if any, stands, so the
   * agents stay halted; clear it with `resume_agents`. Refused while an
   * emergency is declared (`end_emergency` first).
   */
  unpause: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unwound transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unwound: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a agent_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_at: ({i}: {i: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a realized transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  realized: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Realized>>

  /**
   * Construct and simulate a set_mode transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin mode transition kept from #150: `Normal` clears an admin pause and
   * an unwind (a drawdown halt stands: `resume_agents`), `Paused` is `pause`,
   * `Unwinding` replaces an admin pause with an orderly wind-down. `Emergency`
   * and `AgentsHalted` have their own entrypoints (`declare_emergency`, the
   * drawdown trip) and are refused here.
   */
  set_mode: ({mode}: {mode: Mode}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unwinder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unwinder: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a agent_buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_buy: ({agent, market_id, outcome, collateral_in, min_shares_out}: {agent: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a cancel_op transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_op: ({kind}: {kind: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AgentPolicy>>>

  /**
   * Construct and simulate a set_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   */
  agent_sell: ({agent, market_id, outcome, collateral_out, max_shares_in}: {agent: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a audit_mark transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  audit_mark: ({core, market_id}: {core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<MarkRecord>>>

  /**
   * Construct and simulate a execute_op transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_op: ({kind}: {kind: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a exit_floor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  exit_floor: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   * Construct and simulate a mode_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Each stored reason (drawdown halt, admin pause, emergency) with when it
   * began and, for the admin's, why.
   */
  mode_state: (options?: MethodOptions) => Promise<AssembledTransaction<ModeState>>

  /**
   * Construct and simulate a nav_detail transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  nav_detail: (options?: MethodOptions) => Promise<AssembledTransaction<NavDetail>>

  /**
   * Construct and simulate a pending_op transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_op: ({kind}: {kind: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAdminOp>>>

  /**
   * Construct and simulate a propose_op transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_op: ({op}: {op: AdminOp}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `set_paused(true)` is `pause(admin)`, `set_paused(false)` is `unpause()`.
   * Kept for the timelock's emergency path (ADR 0008), which calls
   * `set_paused(true)`.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a token_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  token_caps: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TokenCaps>>>

  /**
   * Construct and simulate a window_pnl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  window_pnl: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a close_trade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  close_trade: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  daily_usage: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DailyUsage>>>

  /**
   * Construct and simulate a get_net_cap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_net_cap: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  redeem_many: ({agent, market_ids}: {agent: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a agent_buy_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   */
  net_exposure: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a net_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  net_position: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<NetPosition>>>

  /**
   * Construct and simulate a queue_bounds transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  queue_bounds: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [u64, u64]>>

  /**
   * Construct and simulate a refresh_mark transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  refresh_mark: ({market_ids}: {market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  remove_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_unwinder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_unwinder: ({unwinder}: {unwinder: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   */
  agent_sell_v2: ({agent, market_id, outcome, collateral_out, max_shares_in, limit_price_bps, deadline}: {agent: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a cancel_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a deposit_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  deposit_token: ({from, token, amount}: {from: string, token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a disable_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  disable_yield: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a end_emergency transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Ends the emergency. The admin pause stands (`AdminPaused`); `unpause`
   * then resumes. In production route it through `timelock.schedule`.
   */
  end_emergency: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a legacy_redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  legacy_redeem: ({agent, core, market_id}: {agent: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a migrate_marks transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migrate_marks: ({start, limit}: {start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a pending_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAgent>>>

  /**
   * Construct and simulate a resume_agents transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Clears a drawdown halt. Allowed only once the realized window PnL is back
   * above `-max_drawdown` (waiting for old losses to leave the window, or an
   * explicit `reset_pnl_window`), so an admin cannot simply wave a real loss
   * through. Leaves any admin pause or emergency untouched. Replaces
   * `acknowledge_drawdown` + `set_paused(false)`.
   */
  resume_agents: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_successor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_successor: ({successor}: {successor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  settle_market: ({caller, market_id}: {caller: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettlementReport>>>

  /**
   * Construct and simulate a claim_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  claim_withdraw: ({ticket_id}: {ticket_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a creation_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  creation_usage: (options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a daily_headroom transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  daily_headroom: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a liquid_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   */
  propose_config: ({config}: {config: GlobalConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a queue_reserved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  queue_reserved: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_exit_floor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_exit_floor: ({market_id, price_bps}: {market_id: u64, price_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_token_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_token_caps: ({token, caps}: {token: string, caps: TokenCaps}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a bucket_exposure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  bucket_exposure: ({core, bucket}: {core: string, bucket: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a drawdown_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  drawdown_status: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DrawdownStatus>>>

  /**
   * Construct and simulate a migrate_markets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  migrate_markets: ({market_ids}: {market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_yield_venue transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_yield_venue: ({pool, max_allocation}: {pool: string, max_allocation: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a correlation_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  correlation_caps: (options?: MethodOptions) => Promise<AssembledTransaction<Result<CorrelationCaps>>>

  /**
   * Construct and simulate a get_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<PricePolicy>>

  /**
   * Construct and simulate a market_valuation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_valuation: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Valuation>>>

  /**
   * Construct and simulate a request_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   */
  set_price_policy: ({policy}: {policy: PricePolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   */
  available_capital: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a capital_breakdown transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  capital_breakdown: (options?: MethodOptions) => Promise<AssembledTransaction<Result<CapitalBreakdown>>>

  /**
   * Construct and simulate a category_exposure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  category_exposure: ({core, idx}: {core: string, idx: u32}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a declare_emergency transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Declares an emergency: opens `emergency_withdraw` (the idle-only,
   * position-forfeiting exit) and closes new withdrawal requests. Only from
   * `AdminPaused`, so one admin call cannot flip straight into the forfeiting
   * exit; with the timelock as admin the extra step is delayed too.
   */
  declare_emergency: ({reason}: {reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   */
  daily_usage_detail: (options?: MethodOptions) => Promise<AssembledTransaction<Result<UsageWindow>>>

  /**
   * Construct and simulate a emergency_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `Mode::Emergency` only (`declare_emergency`, itself only from an admin
   * pause): burns `shares` for their pro-rata part of the free idle
   * collateral, without reading market-core (for when it is the thing that
   * broke). The owner forfeits their part of open positions, which stays with
   * the remaining shareholders. A drawdown halt or an ordinary admin pause
   * never opens it: the normal queued exit pays at NAV (ADR 0005).
   */
  emergency_withdraw: ({owner, shares}: {owner: string, shares: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_claim_lp_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_claim_lp_fees: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
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
   * Deprecated no-op, kept so existing callers and bindings keep working:
   * acknowledging is no longer a separate step. Use `resume_agents`.
   */
  acknowledge_drawdown: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a available_capital_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  available_capital_of: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  claim_pool_remainder: ({agent, market_id}: {agent: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a correlation_headroom transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  correlation_headroom: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [i128, i128]>>>

  /**
   * Construct and simulate a execute_max_mark_age transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_max_mark_age: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_price_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_price_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_trace_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_trace_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   */
  claim_pool_remainders: ({agent, market_ids}: {agent: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a set_default_exit_floor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_default_exit_floor: ({price_bps}: {price_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_correlation_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_correlation_caps: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_correlation_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  execute_correlation_caps: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_resolvability_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_resolvability_policy: (options?: MethodOptions) => Promise<AssembledTransaction<ResolvabilityPolicy>>

  /**
   * Construct and simulate a pending_correlation_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_correlation_caps: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingCorrelation>>>

  /**
   * Construct and simulate a propose_correlation_caps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_correlation_caps: ({caps}: {caps: CorrelationCaps}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_resolvability_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin only. Tightening (a flag to `true`, a larger `min_secs_to_close`,
   * fewer `allowed_specs` bits) applies at once; anything that loosens a knob
   * waits `config_delay` (`execute_resolvability_policy`).
   */
  set_resolvability_policy: ({policy}: {policy: ResolvabilityPolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_resolvability_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_resolvability_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a legacy_claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  legacy_claim_pool_remainder: ({agent, core, market_id}: {agent: string, core: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a execute_resolvability_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Applies the pending resolvability policy once its delay has passed.
   * Permissionless.
   */
  execute_resolvability_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_resolvability_policy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_resolvability_policy: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingResolvability>>>

  /**
   * Construct and simulate a agent_create_market_reveal_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_create_market_reveal_v2: ({agent, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {agent: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_create_market_and_reveal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_create_market_and_reveal: ({agent, resolver, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {agent: string, resolver: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_create_market_collateral transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_create_market_collateral: ({agent, collateral, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {agent: string, collateral: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
        "AAAAAgAAAAAAAAAAAAAAClNraXBSZWFzb24AAAAAAAYAAAAAAAAAAAAAAAhOb3RGb3VuZAAAAAAAAAAAAAAACE5vdEZpbmFsAAAAAAAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAAAAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAAAAAAAAAAAAApOb3RDcmVhdG9yAAAAAAAAAAAAAAAAAAlEdXBsaWNhdGUAAAA=",
        "AAAAAQAAAAAAAAAAAAAAC0JhdGNoUmVzdWx0AAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAJQmF0Y2hJdGVtAAAAAAAAAAAAAAV0b3RhbAAAAAAAAAs=",
        "AAAAAgAAAAAAAAAAAAAAC0JhdGNoU3RhdHVzAAAAAAIAAAAAAAAAAAAAAAdTZXR0bGVkAAAAAAEAAAAAAAAAB1NraXBwZWQAAAAAAQAAB9AAAAAKU2tpcFJlYXNvbgAA",
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
        "AAAAAQAAAAAAAAAAAAAAFkRpc3B1dGFibGVTaWduZXJDb25maWcAAAAAAAYAAAAAAAAADGRpc3B1dGVfYm9uZAAAAAsAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAplc2NhbGF0aW9uAAAAAAfQAAAACkVzY2FsYXRpb24AAAAAAAAAAAASZXNjYWxhdGlvbl90aW1lb3V0AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAWAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABAAAAAAAAAAQVHJhZGVDYXBFeGNlZWRlZAAAAAUAAAAAAAAAEU1hcmtldENhcEV4Y2VlZGVkAAAAAAAABgAAAAAAAAAQRGFpbHlDYXBFeGNlZWRlZAAAAAcAAAAAAAAADU1hcmtldE5vdE9wZW4AAAAAAAAIAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAkAAAAAAAAABlBhdXNlZAAAAAAACgAAAAAAAAALTm9TdWNjZXNzb3IAAAAACwAAAAAAAAATTmV0RXhwb3N1cmVFeGNlZWRlZAAAAAAMAAAAAAAAABVBZ2VudERhaWx5Q2FwRXhjZWVkZWQAAAAAAAANAAAAAAAAAA9Qcm9wb3NhbFBlbmRpbmcAAAAADgAAAAAAAAAOVGltZWxvY2tBY3RpdmUAAAAAAA8AAAAAAAAAD05vUGVuZGluZ0NvbmZpZwAAAAAQAAAAAAAAABFMZWdhY3lDb3JlVW5rbm93bgAAAAAAABEAAAAAAAAAElRvb01hbnlPcGVuTWFya2V0cwAAAAAAEgAAAAAAAAAPQ2FwaXRhbFJlc2VydmVkAAAAABMAAAAAAAAAD0RlcG9zaXRUb29TbWFsbAAAAAAUAAAAAAAAABJJbnN1ZmZpY2llbnRTaGFyZXMAAAAAABUAAAAAAAAADlRpY2tldE5vdEZvdW5kAAAAAAAWAAAAAAAAAAxOb3RoaW5nVG9QYXkAAAAXAAAAAAAAAA5QcmljZU91dE9mQmFuZAAAAAAAGAAAAAAAAAATUHJpY2VJbXBhY3RFeGNlZWRlZAAAAAAZAAAAAAAAABJJbnZhbGlkUHJpY2VQb2xpY3kAAAAAABoAAAAAAAAAEFNsaXBwYWdlRXhjZWVkZWQAAAAbAAAAAAAAAAlOb3RQYXVzZWQAAAAAAAAcAAAAAAAAABhNYXJrZXRDb3JlTWFya2V0Tm90Rm91bmQAAAAdAAAAAAAAABJNYXJrZXRDb3JlTm90RmluYWwAAAAAAB4AAAAAAAAAF01hcmtldENvcmVNYXJrZXROb3RPcGVuAAAAAB8AAAAAAAAAFk1hcmtldENvcmVNYXJrZXRDbG9zZWQAAAAAACAAAAAAAAAAH01hcmtldENvcmVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAIQAAAAAAAAAcTWFya2V0Q29yZUluc3VmZmljaWVudFNoYXJlcwAAACIAAAAAAAAAGE1hcmtldENvcmVBbHJlYWR5Q2xhaW1lZAAAACMAAAAAAAAAGU1hcmtldENvcmVOb3RoaW5nVG9SZWRlZW0AAAAAAAAkAAAAAAAAABdNYXJrZXRDb3JlSW52YWxpZEFtb3VudAAAAAAlAAAAAAAAABJNYXJrZXRDb3JlT3ZlcmZsb3cAAAAAACYAAAAAAAAAGk1hcmtldENvcmVTbGlwcGFnZUV4Y2VlZGVkAAAAAAAnAAAAAAAAABRNYXJrZXRDb3JlQ2FsbEZhaWxlZAAAACgAAAAAAAAADk1hcmtldE5vdEZpbmFsAAAAAAAsAAAAAAAAAA9NYXJrZXRDb3JlRXJyb3IAAAAALQAAAAAAAAAPRHJhd2Rvd25UcmlwcGVkAAAAAC4AAAAAAAAAFUludmFsaWREcmF3ZG93bkNvbmZpZwAAAAAAAC8AAAAAAAAAD05vdEFja25vd2xlZGdlZAAAAAAwAAAAAAAAAA9TZWVkQ2FwRXhjZWVkZWQAAAAAMQAAAAAAAAAUQ3JlYXRpb25SYXRlRXhjZWVkZWQAAAAyAAAAAAAAABBDbG9zZVRpbWVUb29Tb29uAAAAMwAAAAAAAAAPQ2xvc2VUaW1lVG9vRmFyAAAAADQAAAAAAAAAEkNhdGVnb3J5Tm90QWxsb3dlZAAAAAAANQAAAAAAAAAPUG9saWN5TG9vc2VuaW5nAAAAADYAAAAAAAAADVlpZWxkRGlzYWJsZWQAAAAAAAA3AAAAAAAAABBZaWVsZENhcEV4Y2VlZGVkAAAAOAAAAAAAAAATWWllbGRXaXRoZHJhd0ZhaWxlZAAAAAA5AAAAAAAAABFWZW51ZUhhc1ByaW5jaXBhbAAAAAAAADoAAAAAAAAAE0NhdGVnb3J5Q2FwRXhjZWVkZWQAAAAAOwAAAAAAAAARQnVja2V0Q2FwRXhjZWVkZWQAAAAAAAA8AAAAAAAAAA5Ob1BlbmRpbmdBZG1pbgAAAAAAPQAAAAAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAA+AAAAAAAAABFJbnZhbGlkUmVzb2x1dGlvbgAAAAAAAD8AAAAAAAAADVRyYWNlUmVxdWlyZWQAAAAAAABAAAAAAAAAABVUcmFjZURlY2lzaW9uTWlzbWF0Y2gAAAAAAABBAAAAAAAAAA1UcmFjZU1pc21hdGNoAAAAAAAAQgAAAAAAAAASVHJhY2VBZ2VudE1pc21hdGNoAAAAAABDAAAAAAAAAAxUcmFjZUZsYWdnZWQAAABEAAAAAAAAAApUcmFjZVN0YWxlAAAAAABFAAAAAAAAAA1UcmFjZUNvbnN1bWVkAAAAAAAARgAAAAAAAAAXVHJhY2VSZWdpc3RyeUNhbGxGYWlsZWQAAAAARwAAAAAAAAASVHJhY2VQb2xpY3lQZW5kaW5nAAAAAABIAAAAAAAAABVUcmFjZVBvbGljeU5vdFBlbmRpbmcAAAAAAABJAAAAAAAAABNUcmFjZVRpbWVsb2NrQWN0aXZlAAAAAEoAAAAAAAAAClN0YWxlTWFya3MAAAAAAEsAAAAAAAAAEU1hcmtCYXRjaFRvb0xhcmdlAAAAAAAATAAAAAAAAAAKT3BOb3RSZWFkeQAAAAAATQAAAAAAAAAJT3BFeHBpcmVkAAAAAAAATgAAAAAAAAALTm9QZW5kaW5nT3AAAAAATwAAAAAAAAAOQmVsb3dFeGl0Rmxvb3IAAAAAAFAAAAAAAAAAEEludmFsaWRFeGl0Rmxvb3IAAABRAAAAAAAAABRDb2xsYXRlcmFsTm90QWxsb3dlZAAAAFIAAACFVGhlIHRyZWFzdXJ5IGlzIGluIGBNb2RlOjpFbWVyZ2VuY3lgOiBvbmx5IHNldHRsZW1lbnQsIGNsYWltaW5nIGV4aXN0aW5nCndpdGhkcmF3YWwgdGlja2V0cyBhbmQgYGVtZXJnZW5jeV93aXRoZHJhd2AgYXJlIG9wZW4gKCMyNzIpLgAAAAAAAA1FbWVyZ2VuY3lNb2RlAAAAAAAAUwAAAIxgcmVzdW1lX2FnZW50c2A6IHRoZSByZWFsaXplZCB3aW5kb3cgUG5MIGhhcyBub3QgcmVjb3ZlcmVkIGFib3ZlCmAtbWF4X2RyYXdkb3duYCAocmVzZXQgdGhlIHdpbmRvdyBvciB3YWl0IGZvciBvbGQgbG9zc2VzIHRvIGV4cGlyZSkgKCMyNzIpLgAAAAxOb3RSZWNvdmVyZWQAAABUAAAAhVRoZSBtYXJrZXQncyByZXNvbHV0aW9uIHNwZWMgd2FzIG5ldmVyIHJldmVhbGVkIHRvIGl0cyByZXNvbHZlciwgb3IgYQpyZXNvbHZlciBhY2NlcHRlZCBgcmVnaXN0ZXJfc3BlY192MmAgYW5kIHN0b3JlZCBub3RoaW5nICgjMjczKS4AAAAAAAAPU3BlY05vdFJldmVhbGVkAAAAAFYAAAA4VGhlIG1hcmtldCdzIHNwZWMga2luZCBpcyBub3QgaW4gYGFsbG93ZWRfc3BlY3NgICgjMjczKS4AAAASU3BlY0tpbmROb3RBbGxvd2VkAAAAAABXAAAAOFRoZSBtYXJrZXQgaXMgYERpc3B1dGVkYDogZmluYWxpemF0aW9uIGlzIGZyb3plbiAoIzI3MykuAAAADk1hcmtldERpc3B1dGVkAAAAAABYAAAAREEgc2lnbmVyIHByb3Bvc2FsIGlzIHBlbmRpbmcgYW5kIHRoZSBwb2xpY3kgYmxvY2tzIGJ1eXMgdGhlbiAoIzI3MykuAAAADFByb3Bvc2FsT3BlbgAAAFkAAABTUGFzdCBgY2xvc2VfdGltZSArIFJFU09MVVRJT05fR1JBQ0VfU0VDU2A6IHRoZSBtYXJrZXQgY2FuIGFscmVhZHkgYmUgdm9pZGVkICgjMjczKS4AAAAAFlBhc3RSZXNvbHV0aW9uRGVhZGxpbmUAAAAAAFoAAAA3Q2xvc2VyIHRvIGBjbG9zZV90aW1lYCB0aGFuIGBtaW5fc2Vjc190b19jbG9zZWAgKCMyNzMpLgAAAAAPVG9vQ2xvc2VUb0Nsb3NlAAAAAFsAAAAlQSBjYWxsIHRvIHRoZSByZXNvbHZlciBmYWlsZWQgKCMyNzMpLgAAAAAAABJSZXNvbHZlckNhbGxGYWlsZWQAAAAAAFw=",
        "AAAAAAAAAAAAAAADbmF2AAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAB1UaGUgZWZmZWN0aXZlIG9wZXJhdGluZyBtb2RlLgAAAAAAAARtb2RlAAAAAAAAAAEAAAfQAAAABE1vZGU=",
        "AAAAAgAAAAAAAAAAAAAAB0FkbWluT3AAAAAACAAAAAEAAAAAAAAADVNldFlpZWxkVmVudWUAAAAAAAACAAAAEwAAAAsAAAABAAAAAAAAAA9BbGxvY2F0ZVRvWWllbGQAAAAAAQAAAAsAAAABAAAAAAAAAAxTZXRTdWNjZXNzb3IAAAABAAAAEwAAAAEAAAAAAAAADk1pZ3JhdGVNYXJrZXRzAAAAAAABAAAD6gAAAAYAAAABAAAAAAAAABFTZXREcmF3ZG93bkNvbmZpZwAAAAAAAAIAAAALAAAABAAAAAAAAAAAAAAADlJlc2V0UG5sV2luZG93AAAAAAABAAAAAAAAABFTZXRDcmVhdGlvblBvbGljeQAAAAAAAAEAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAABAAAAAAAAABJTZXRDb3JyZWxhdGlvbkNhcHMAAAAAAAEAAAfQAAAAD0NvcnJlbGF0aW9uQ2FwcwA=",
        "AAAAAAAAAHFBZG1pbiBwYXVzZTogbm8gZGVwb3NpdHMgYW5kIG5vIGFnZW50IHRyYWRpbmcgKHNldHRsZW1lbnQsIHF1ZXVlZAp3aXRoZHJhd2FscyBhbmQgcmVjYWxscyBzdGF5IG9wZW4pLiBJZGVtcG90ZW50LgAAAAAAAAVwYXVzZQAAAAAAAAEAAAAAAAAABnJlYXNvbgAAAAAAEQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAQAAAAAAAAAAAAAACFJlYWxpemVkAAAAAwAAAAAAAAALbHBfcHJvY2VlZHMAAAAACwAAAAAAAAARcG9zaXRpb25fcHJvY2VlZHMAAAAAAAALAAAAAAAAAAdzZXR0bGVkAAAAAAE=",
        "AAAAAAAAAExSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldAooYFJPTEVfU0VUVExFYCkuAAAABnJlZGVlbQAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAQAAAAAAAAAAAAAACU1hcmtldFBubAAAAAAAAAMAAAAAAAAABGNvc3QAAAALAAAAAAAAAAhwcm9jZWVkcwAAAAsAAAAAAAAACHJlYWxpemVkAAAAAQ==",
        "AAAAAQAAAAAAAAAAAAAACU5hdkRldGFpbAAAAAAAAAMAAAAAAAAACGhvbGRpbmdzAAAACwAAAAAAAAAOb2xkZXN0X3JlZnJlc2gAAAAAAAQAAAAAAAAAEHN0YWxlX2xwX21hcmtldHMAAAAE",
        "AAAAAQAAAAAAAAAAAAAACVRva2VuQ2FwcwAAAAAAAAMAAAAAAAAACW1heF9kYWlseQAAAAAAAAsAAAAAAAAACm1heF9tYXJrZXQAAAAAAAsAAAAAAAAACW1heF90cmFkZQAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAACVZhbHVhdGlvbgAAAAAAAAQAAAAAAAAAB2F0X3Jpc2sAAAAACwAAAAAAAAAKY29zdF9iYXNpcwAAAAAACwAAAAAAAAALZmxvb3JfdmFsdWUAAAAACwAAAAAAAAAKc3BvdF92YWx1ZQAAAAAACw==",
        "AAAAAAAAAGhXaGV0aGVyIGBvcGAgaXMgcGVybWl0dGVkIGluIHRoZSBjdXJyZW50IG1vZGU6IHRoZSBnYXRlJ3MgYW5zd2VyLCBmb3IKYWdlbnRzIGFuZCBmcm9udGVuZHMgdG8gcHJlLWNoZWNrLgAAAAdhbGxvd2VkAAAAAAEAAAAAAAAAAm9wAAAAAAfQAAAAAk9wAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAHZGVwb3NpdAAAAAACAAAAAAAAAARmcm9tAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAHcmVhbGl6ZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAALdDbGVhcnMgdGhlIGFkbWluIHBhdXNlIG9ubHkuIEEgZHJhd2Rvd24gaGFsdCwgaWYgYW55LCBzdGFuZHMsIHNvIHRoZQphZ2VudHMgc3RheSBoYWx0ZWQ7IGNsZWFyIGl0IHdpdGggYHJlc3VtZV9hZ2VudHNgLiBSZWZ1c2VkIHdoaWxlIGFuCmVtZXJnZW5jeSBpcyBkZWNsYXJlZCAoYGVuZF9lbWVyZ2VuY3lgIGZpcnN0KS4AAAAAB3VucGF1c2UAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAHdW53b3VuZAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAs=",
        "AAAABQAAAAAAAAAAAAAACURlcG9zaXRlZAAAAAAAAAEAAAAJZGVwb3NpdGVkAAAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADbmF2AAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAACkRhaWx5VXNhZ2UAAAAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAJZGF5X3N0YXJ0AAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAACk1hcmtSZWNvcmQAAAAAAAoAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAADGNvbnRyaWJ1dGlvbgAAAAsAAAAAAAAABGNvcmUAAAATAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAIbHBfZmxvb3IAAAALAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZwb3Nfbm8AAAAAAAsAAAAAAAAAB3Bvc195ZXMAAAAACwAAAAAAAAAQcmVmcmVzaGVkX2xlZGdlcgAAAAQAAAAAAAAADHN0YXR1c19maW5hbAAAAAE=",
        "AAAAAQAAAAAAAAAAAAAACk9wZW5NYXJrZXQAAAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAG",
        "AAAAAQAAAAAAAAAAAAAAClJpc2tDb25maWcAAAAAAAYAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAKbWF4X21hcmtldAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACw==",
        "AAAAAAAAAAAAAAAIYWdlbnRfYXQAAAABAAAAAAAAAAFpAAAAAAAABAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAIcmVhbGl6ZWQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAIUmVhbGl6ZWQ=",
        "AAAAAAAAAUpBZG1pbiBtb2RlIHRyYW5zaXRpb24ga2VwdCBmcm9tICMxNTA6IGBOb3JtYWxgIGNsZWFycyBhbiBhZG1pbiBwYXVzZSBhbmQKYW4gdW53aW5kIChhIGRyYXdkb3duIGhhbHQgc3RhbmRzOiBgcmVzdW1lX2FnZW50c2ApLCBgUGF1c2VkYCBpcyBgcGF1c2VgLApgVW53aW5kaW5nYCByZXBsYWNlcyBhbiBhZG1pbiBwYXVzZSB3aXRoIGFuIG9yZGVybHkgd2luZC1kb3duLiBgRW1lcmdlbmN5YAphbmQgYEFnZW50c0hhbHRlZGAgaGF2ZSB0aGVpciBvd24gZW50cnlwb2ludHMgKGBkZWNsYXJlX2VtZXJnZW5jeWAsIHRoZQpkcmF3ZG93biB0cmlwKSBhbmQgYXJlIHJlZnVzZWQgaGVyZS4AAAAAAAhzZXRfbW9kZQAAAAEAAAAAAAAABG1vZGUAAAfQAAAABE1vZGUAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAIdW53aW5kZXIAAAAAAAAAAQAAA+gAAAAT",
        "AAAABQAAAAAAAAAAAAAAClVud2luZFNlbGwAAAAAAAEAAAALdW53aW5kX3NlbGwAAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAAAAAAAJc2hhcmVzX2luAAAAAAAACwAAAAAAAAAAAAAACXByaWNlX2JwcwAAAAAAAAQAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAC0FnZW50UG9saWN5AAAAAAQAAAAAAAAABmFjdGl2ZQAAAAAAAQAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACwAAAAAAAAAFcm9sZXMAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAAC05ldFBvc2l0aW9uAAAAAAIAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACw==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlUG9saWN5AAAAAAQAAAAAAAAAEW1heF9idXlfcHJpY2VfYnBzAAAAAAAABAAAAAAAAAAObWF4X2ltcGFjdF9icHMAAAAAAAQAAAAAAAAAEG1heF9zbGlwcGFnZV9icHMAAAAEAAAAAAAAABJtaW5fc2VsbF9wcmljZV9icHMAAAAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC1RyYWNlUG9saWN5AAAAAAMAAAAAAAAAAAAAAANPZmYAAAAAAAAAAAAAAAAIT3B0aW9uYWwAAAAAAAAAAAAAAAhSZXF1aXJlZA==",
        "AAAAAQAAAAAAAAAAAAAAC1VzYWdlV2luZG93AAAAAAMAAAAAAAAAB2Ftb3VudHMAAAAD6gAAAAsAAAAAAAAACWhlYWRfaG91cgAAAAAAAAYAAAAAAAAACGhlYWRfaWR4AAAABA==",
        "AAAAAAAAAAAAAAAJYWdlbnRfYnV5AAAAAAAABQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAJY2FuY2VsX29wAAAAAAAAAQAAAAAAAAAEa2luZAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAJZ2V0X2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+gAAAfQAAAAC0FnZW50UG9saWN5AA==",
        "AAAAAAAAAAAAAAAJc2V0X2FnZW50AAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALQWdlbnRQb2xpY3kAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJc2hhcmVzX29mAAAAAAAAAQAAAAAAAAAFb3duZXIAAAAAAAATAAAAAQAAAAs=",
        "AAAABQAAAAAAAAAAAAAAC0FnZW50SGFsdGVkAAAAAAEAAAAMYWdlbnRfaGFsdGVkAAAAAwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGcmVhc29uAAAAAAAEAAAAAAAAAAAAAAALcm9sZXNfYWZ0ZXIAAAAABAAAAAAAAAAC",
        "AAAABQAAAN1FdmVyeSBjaGFuZ2UgdG8gdGhlIG9wZXJhdGluZyBtb2RlJ3MgcmVhc29ucyAoIzI3MikuIGBmcm9tYC9gdG9gIGFyZSB0aGUKZWZmZWN0aXZlIG1vZGVzOyB0aGV5IGFyZSBlcXVhbCB3aGVuIGEgcmVhc29uIHdhcyBhZGRlZCBvciBjbGVhcmVkIHVuZGVyIGEKaGlnaGVyLXByaW9yaXR5IG9uZSAoZS5nLiBhIGRyYXdkb3duIHRyaXBzIHdoaWxlIHRoZSBhZG1pbiBwYXVzZSBzdGFuZHMpLgAAAAAAAAAAAAALTW9kZUNoYW5nZWQAAAAAAQAAAAxtb2RlX2NoYW5nZWQAAAAEAAAAAAAAAARmcm9tAAAH0AAAAARNb2RlAAAAAAAAAAAAAAACdG8AAAAAB9AAAAAETW9kZQAAAAAAAACKYGRyYXdkb3duYCwgYHJlc3VtZWAsIGBhZG1pbmAsIGB1bnBhdXNlYCwgYGxlZ2FjeWAsIGBlbWVyZ2VuY3lgLApgZW5kX2VtZXJnYCwgb3IgdGhlIGFkbWluJ3Mgb3duIHJlYXNvbiBmb3IgYHBhdXNlYCAvIGBkZWNsYXJlX2VtZXJnZW5jeWAuAAAAAAAGcmVhc29uAAAAAAARAAAAAAAAAAAAAAACYXQAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAC1BubFJlYWxpemVkAAAAAAEAAAAMcG5sX3JlYWxpemVkAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGNvc3QAAAALAAAAAAAAAAAAAAAIcHJvY2VlZHMAAAALAAAAAAAAAAAAAAADcG5sAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADEdsb2JhbENvbmZpZwAAAAYAAAAAAAAACmNvbGxhdGVyYWwAAAAAABMAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAAAAAAACW1heF9kYWlseQAAAAAAAAsAAAAAAAAACm1heF9tYXJrZXQAAAAAAAsAAAAAAAAAEG1heF9uZXRfZXhwb3N1cmUAAAALAAAAAAAAAAltYXhfdHJhZGUAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAADFBlbmRpbmdBZ2VudAAAAAMAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALQWdlbnRQb2xpY3kAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAG",
        "AAAAAAAAAAAAAAAKYWdlbnRfaGFsdAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAZyZWFzb24AAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAKYWdlbnRfc2VsbAAAAAAABQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKYXVkaXRfbWFyawAAAAAAAgAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAAKTWFya1JlY29yZAAA",
        "AAAAAAAAAAAAAAAKZXhlY3V0ZV9vcAAAAAAAAQAAAAAAAAAEa2luZAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAKZXhpdF9mbG9vcgAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAE",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAApSaXNrQ29uZmlnAAAAAAAD",
        "AAAAAAAAAAAAAAAKZ2V0X2dsb2JhbAAAAAAAAAAAAAEAAAPpAAAH0AAAAAxHbG9iYWxDb25maWcAAAAD",
        "AAAAAAAAAAAAAAAKbWFya2V0X3BubAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAfQAAAACU1hcmtldFBubAAAAA==",
        "AAAAAAAAAGhFYWNoIHN0b3JlZCByZWFzb24gKGRyYXdkb3duIGhhbHQsIGFkbWluIHBhdXNlLCBlbWVyZ2VuY3kpIHdpdGggd2hlbiBpdApiZWdhbiBhbmQsIGZvciB0aGUgYWRtaW4ncywgd2h5LgAAAAptb2RlX3N0YXRlAAAAAAAAAAAAAQAAB9AAAAAJTW9kZVN0YXRlAAAA",
        "AAAAAAAAAAAAAAAKbmF2X2RldGFpbAAAAAAAAAAAAAEAAAfQAAAACU5hdkRldGFpbAAAAA==",
        "AAAAAAAAAAAAAAAKcGVuZGluZ19vcAAAAAAAAQAAAAAAAAAEa2luZAAAAAQAAAABAAAD6AAAB9AAAAAOUGVuZGluZ0FkbWluT3AAAA==",
        "AAAAAAAAAAAAAAAKcHJvcG9zZV9vcAAAAAAAAQAAAAAAAAACb3AAAAAAB9AAAAAHQWRtaW5PcAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAJxgc2V0X3BhdXNlZCh0cnVlKWAgaXMgYHBhdXNlKGFkbWluKWAsIGBzZXRfcGF1c2VkKGZhbHNlKWAgaXMgYHVucGF1c2UoKWAuCktlcHQgZm9yIHRoZSB0aW1lbG9jaydzIGVtZXJnZW5jeSBwYXRoIChBRFIgMDAwOCksIHdoaWNoIGNhbGxzCmBzZXRfcGF1c2VkKHRydWUpYC4AAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAKdG9rZW5fY2FwcwAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAfQAAAACVRva2VuQ2FwcwAAAAAAAAM=",
        "AAAAAAAAAAAAAAAKd2luZG93X3BubAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmVtb3ZlZAAAAAEAAAANYWdlbnRfcmVtb3ZlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAADEV4aXRGbG9vclNldAAAAAEAAAAOZXhpdF9mbG9vcl9zZXQAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAlwcmljZV9icHMAAAAAAAAEAAAAAAAAAAAAAAAKaXNfZGVmYXVsdAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADFN1Y2Nlc3NvclNldAAAAAEAAAANc3VjY2Vzc29yX3NldAAAAAAAAAIAAAAAAAAAA29sZAAAAAPoAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFdpdGhkcmF3UGFpZAAAAAEAAAANd2l0aGRyYXdfcGFpZAAAAAAAAAIAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADVBlbmRpbmdDb25maWcAAAAAAAADAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAALcHJvcG9zZWRfYXQAAAAABg==",
        "AAAAAAAAAAAAAAALYWdlbnRfY291bnQAAAAAAAAAAAEAAAAE",
        "AAAAAAAAAAAAAAALY2xvc2VfdHJhZGUAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAALZGFpbHlfdXNhZ2UAAAAAAAAAAAEAAAPpAAAH0AAAAApEYWlseVVzYWdlAAAAAAAD",
        "AAAAAAAAAAAAAAALZ2V0X25ldF9jYXAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAALcmVkZWVtX21hbnkAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAptYXJrZXRfaWRzAAAAAAPqAAAABgAAAAEAAAPpAAAH0AAAAAtCYXRjaFJlc3VsdAAAAAAD",
        "AAAABQAAAAAAAAAAAAAADURyYXdkb3duUGF1c2UAAAAAAAABAAAADmRyYXdkb3duX3BhdXNlAAAAAAADAAAAAAAAAA1yZWFsaXplZF9sb3NzAAAAAAAACwAAAAAAAAAAAAAAEHdpbmRvd19zdGFydF9kYXkAAAAGAAAAAAAAAAAAAAATdHJpZ2dlcmVkX2J5X21hcmtldAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldFNldHRsZWQAAAAAAAABAAAADm1hcmtldF9zZXR0bGVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAIcmVkZWVtZWQAAAALAAAAAAAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAAAAAACnNldHRsZWRfYnkAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkUmVjYWxsZWQAAAAAAAABAAAADnlpZWxkX3JlY2FsbGVkAAAAAAAEAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAZyZWFzb24AAAAAABEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVlpZWxkVmVudWVTZXQAAAAAAAABAAAAD3lpZWxkX3ZlbnVlX3NldAAAAAACAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAADm1heF9hbGxvY2F0aW9uAAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAADkNyZWF0aW9uUG9saWN5AAAAAAAGAAAAAAAAABJhbGxvd2VkX2NhdGVnb3JpZXMAAAAAAAQAAAAAAAAAFGNyZWF0aW9uX3dpbmRvd19zZWNzAAAABgAAAAAAAAARbWF4X2Nsb3NlX2hvcml6b24AAAAAAAAGAAAAAAAAABZtYXhfbWFya2V0c19wZXJfd2luZG93AAAAAAAEAAAAAAAAAAhtYXhfc2VlZAAAAAsAAAAAAAAAEW1pbl9jbG9zZV9ob3Jpem9uAAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADkRyYXdkb3duU3RhdHVzAAAAAAADAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAd0cmlwcGVkAAAAAAEAAAAAAAAACndpbmRvd19wbmwAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAADlBlbmRpbmdBZG1pbk9wAAAAAAAEAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAACb3AAAAAAB9AAAAAHQWRtaW5PcAAAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAADlBlbmRpbmdNYXJrQWdlAAAAAAACAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAHbGVkZ2VycwAAAAAE",
        "AAAAAQAAADtDb2xsYXRlcmFsIHN0aWxsIG93ZWQgdG8gYG93bmVyYCBmb3Igc2hhcmVzIGFscmVhZHkgYnVybmVkLgAAAAAAAAAADldpdGhkcmF3VGlja2V0AAAAAAADAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACXJlbWFpbmluZwAAAAAAAAs=",
        "AAAAAAAAAAAAAAAMYWdlbnRfYnV5X3YyAAAABwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAMY2FuY2VsX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMY29uZmlnX2RlbGF5AAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMbmV0X2V4cG9zdXJlAAAAAAAAAAEAAAAL",
        "AAAAAAAAAAAAAAAMbmV0X3Bvc2l0aW9uAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAtOZXRQb3NpdGlvbgAAAAAD",
        "AAAAAAAAAAAAAAAMcXVldWVfYm91bmRzAAAAAAAAAAEAAAPtAAAAAgAAAAYAAAAG",
        "AAAAAAAAAAAAAAAMcmVmcmVzaF9tYXJrAAAAAQAAAAAAAAAKbWFya2V0X2lkcwAAAAAD6gAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMcmVtb3ZlX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMc2V0X3Vud2luZGVyAAAAAQAAAAAAAAAIdW53aW5kZXIAAAPoAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMdG90YWxfc2hhcmVzAAAAAAAAAAEAAAAL",
        "AAAAAAAAAAAAAAAMdHJhY2VfcG9saWN5AAAAAAAAAAEAAAfQAAAAEVRyYWNlUG9saWN5Q29uZmlnAAAA",
        "AAAABQAAAAAAAAAAAAAADkFnZW50UG9saWN5U2V0AAAAAAABAAAAEGFnZW50X3BvbGljeV9zZXQAAAAEAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0RlbGF5U2V0AAAAAAABAAAAEGNvbmZpZ19kZWxheV9zZXQAAAACAAAAAAAAAANvbGQAAAAABgAAAAAAAAAAAAAAA25ldwAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ0V4ZWN1dGVkAAAAAAABAAAAD2NvbmZpZ19leGVjdXRlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkNvbmZpZ1Byb3Bvc2VkAAAAAAABAAAAD2NvbmZpZ19wcm9wb3NlZAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAxHbG9iYWxDb25maWcAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldE1pZ3JhdGVkAAAAAAABAAAAD21hcmtldF9taWdyYXRlZAAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJc3VjY2Vzc29yAAAAAAAAEwAAAAEAAAAAAAAAA3llcwAAAAALAAAAAAAAAAAAAAACbm8AAAAAAAsAAAAAAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlBubFdpbmRvd1Jlc2V0AAAAAAABAAAAEHBubF93aW5kb3dfcmVzZXQAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlByaWNlUG9saWN5U2V0AAAAAAABAAAAEHByaWNlX3BvbGljeV9zZXQAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlRva2VuRGVwb3NpdGVkAAAAAAABAAAAD3Rva2VuX2RlcG9zaXRlZAAAAAADAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAAV0b2tlbgAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADllpZWxkQWxsb2NhdGVkAAAAAAABAAAAD3lpZWxkX2FsbG9jYXRlZAAAAAADAAAAAAAAAARwb29sAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAD0NvcnJlbGF0aW9uQ2FwcwAAAAADAAAAAAAAAAtidWNrZXRfc2VjcwAAAAAGAAAAAAAAAA5tYXhfcGVyX2J1Y2tldAAAAAAACwAAAAAAAAAQbWF4X3Blcl9jYXRlZ29yeQAAA+oAAAAL",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAwAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAAAAABBtYXhfbmV0X2V4cG9zdXJlAAAACwAAAAAAAAAMY29uZmlnX2RlbGF5AAAABgAAAAAAAAAMbWF4X2RyYXdkb3duAAAACwAAAAAAAAALd2luZG93X2RheXMAAAAABAAAAAAAAAAPY3JlYXRpb25fcG9saWN5AAAAB9AAAAAOQ3JlYXRpb25Qb2xpY3kAAAAAAAA=",
        "AAAAAAAAAAAAAAANYWdlbnRfc2VsbF92MgAAAAAAAAcAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAAAAAANbWF4X3NoYXJlc19pbgAAAAAAAAsAAAAAAAAAD2xpbWl0X3ByaWNlX2JwcwAAAAAEAAAAAAAAAAhkZWFkbGluZQAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAANY2FuY2VsX2NvbmZpZwAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANZGVwb3NpdF90b2tlbgAAAAAAAAMAAAAAAAAABGZyb20AAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAANZGlzYWJsZV95aWVsZAAAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAIdFbmRzIHRoZSBlbWVyZ2VuY3kuIFRoZSBhZG1pbiBwYXVzZSBzdGFuZHMgKGBBZG1pblBhdXNlZGApOyBgdW5wYXVzZWAKdGhlbiByZXN1bWVzLiBJbiBwcm9kdWN0aW9uIHJvdXRlIGl0IHRocm91Z2ggYHRpbWVsb2NrLnNjaGVkdWxlYC4AAAAADWVuZF9lbWVyZ2VuY3kAAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAANZXhlY3V0ZV9hZ2VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANbGVnYWN5X3JlZGVlbQAAAAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAANbWlncmF0ZV9tYXJrcwAAAAAAAAIAAAAAAAAABXN0YXJ0AAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAAAAAAANcGVuZGluZ19hZ2VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPoAAAH0AAAAAxQZW5kaW5nQWdlbnQ=",
        "AAAAAAAAAUpDbGVhcnMgYSBkcmF3ZG93biBoYWx0LiBBbGxvd2VkIG9ubHkgb25jZSB0aGUgcmVhbGl6ZWQgd2luZG93IFBuTCBpcyBiYWNrCmFib3ZlIGAtbWF4X2RyYXdkb3duYCAod2FpdGluZyBmb3Igb2xkIGxvc3NlcyB0byBsZWF2ZSB0aGUgd2luZG93LCBvciBhbgpleHBsaWNpdCBgcmVzZXRfcG5sX3dpbmRvd2ApLCBzbyBhbiBhZG1pbiBjYW5ub3Qgc2ltcGx5IHdhdmUgYSByZWFsIGxvc3MKdGhyb3VnaC4gTGVhdmVzIGFueSBhZG1pbiBwYXVzZSBvciBlbWVyZ2VuY3kgdW50b3VjaGVkLiBSZXBsYWNlcwpgYWNrbm93bGVkZ2VfZHJhd2Rvd25gICsgYHNldF9wYXVzZWQoZmFsc2UpYC4AAAAAAA1yZXN1bWVfYWdlbnRzAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANc2V0X3N1Y2Nlc3NvcgAAAAAAAAEAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANc2V0dGxlX21hcmtldAAAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAABBTZXR0bGVtZW50UmVwb3J0AAAAAw==",
        "AAAABQAAAAAAAAAAAAAAD0FkbWluT3BFeGVjdXRlZAAAAAABAAAAEWFkbWluX29wX2V4ZWN1dGVkAAAAAAAAAgAAAAAAAAAEa2luZAAAAAQAAAAAAAAAAAAAAAJvcAAAAAAH0AAAAAdBZG1pbk9wAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0FkbWluT3BQcm9wb3NlZAAAAAABAAAAEWFkbWluX29wX3Byb3Bvc2VkAAAAAAAAAwAAAAAAAAAEa2luZAAAAAQAAAAAAAAAAAAAAAJvcAAAAAAH0AAAAAdBZG1pbk9wAAAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD0NvbmZpZ0NhbmNlbGxlZAAAAAABAAAAEGNvbmZpZ19jYW5jZWxsZWQAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMR2xvYmFsQ29uZmlnAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAMbWFya2V0X3RvdGFsAAAACwAAAAAAAAAAAAAAC2RhaWx5X3RvdGFsAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAEENhcGl0YWxCcmVha2Rvd24AAAADAAAAAAAAAAZsaXF1aWQAAAAAAAsAAAAAAAAAD3lpZWxkX3ByaW5jaXBhbAAAAAALAAAAAAAAAAt5aWVsZF92YWx1ZQAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEFNldHRsZW1lbnRSZXBvcnQAAAADAAAAAAAAAA9hbHJlYWR5X3NldHRsZWQAAAAAAQAAAAAAAAAKbHBfY2xhaW1lZAAAAAAACwAAAAAAAAAIcmVkZWVtZWQAAAAL",
        "AAAAAAAAAAAAAAAOY2xhaW1fd2l0aGRyYXcAAAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAOY3JlYXRpb25fdXNhZ2UAAAAAAAAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAAAAAAAOZGFpbHlfaGVhZHJvb20AAAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAOZXhlY3V0ZV9jb25maWcAAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAObGlxdWlkX2NhcGl0YWwAAAAAAAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAOb3Blbl9tYXJrZXRfYXQAAAAAAAEAAAAAAAAAAWkAAAAAAAAEAAAAAQAAA+gAAAfQAAAACk9wZW5NYXJrZXQAAA==",
        "AAAAAAAAAAAAAAAOcGVuZGluZ19jb25maWcAAAAAAAAAAAABAAAD6AAAB9AAAAANUGVuZGluZ0NvbmZpZwAAAA==",
        "AAAAAAAAAAAAAAAOcHJvcG9zZV9jb25maWcAAAAAAAEAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAxHbG9iYWxDb25maWcAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOcXVldWVfcmVzZXJ2ZWQAAAAAAAAAAAABAAAACw==",
        "AAAAAAAAAAAAAAAOc2V0X2V4aXRfZmxvb3IAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAACXByaWNlX2JwcwAAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOc2V0X3Rva2VuX2NhcHMAAAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAEY2FwcwAAB9AAAAAJVG9rZW5DYXBzAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluT3BDYW5jZWxsZWQAAAABAAAAEmFkbWluX29wX2NhbmNlbGxlZAAAAAAAAQAAAAAAAAAEa2luZAAAAAQAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAEVRyYWNlUG9saWN5Q29uZmlnAAAAAAAAAgAAAAAAAAAVbWF4X3RyYWNlX2FnZV9sZWRnZXJzAAAAAAAABAAAAAAAAAAGcG9saWN5AAAAAAfQAAAAC1RyYWNlUG9saWN5AA==",
        "AAAAAAAAAAAAAAAPYnVja2V0X2V4cG9zdXJlAAAAAAIAAAAAAAAABGNvcmUAAAATAAAAAAAAAAZidWNrZXQAAAAAAAYAAAABAAAACw==",
        "AAAAAAAAAAAAAAAPZHJhd2Rvd25fc3RhdHVzAAAAAAAAAAABAAAD6QAAB9AAAAAORHJhd2Rvd25TdGF0dXMAAAAAAAM=",
        "AAAAAAAAAAAAAAAPbWlncmF0ZV9tYXJrZXRzAAAAAAEAAAAAAAAACm1hcmtldF9pZHMAAAAAA+oAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAPc2V0X3lpZWxkX3ZlbnVlAAAAAAIAAAAAAAAABHBvb2wAAAATAAAAAAAAAA5tYXhfYWxsb2NhdGlvbgAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPd2l0aGRyYXdfdGlja2V0AAAAAAEAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAABAAAD6AAAB9AAAAAOV2l0aGRyYXdUaWNrZXQAAA==",
        "AAAABQAAAAAAAAAAAAAAEURyYXdkb3duQ29uZmlnU2V0AAAAAAAAAQAAABNkcmF3ZG93bl9jb25maWdfc2V0AAAAAAUAAAAAAAAAEG9sZF9tYXhfZHJhd2Rvd24AAAALAAAAAAAAAAAAAAAQbmV3X21heF9kcmF3ZG93bgAAAAsAAAAAAAAAAAAAAA9vbGRfd2luZG93X2RheXMAAAAABAAAAAAAAAAAAAAAD25ld193aW5kb3dfZGF5cwAAAAAEAAAAAAAAAAAAAAAJaW1tZWRpYXRlAAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEVdpdGhkcmF3UmVxdWVzdGVkAAAAAAAAAQAAABJ3aXRoZHJhd19yZXF1ZXN0ZWQAAAAAAAUAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFzc2V0cwAAAAAACwAAAAAAAAAAAAAACHBhaWRfbm93AAAACwAAAAAAAAAAAAAACXRpY2tldF9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAElBlbmRpbmdDb3JyZWxhdGlvbgAAAAAAAwAAAAAAAAAEY2FwcwAAB9AAAAAPQ29ycmVsYXRpb25DYXBzAAAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAAElBlbmRpbmdQcmljZVBvbGljeQAAAAAAAwAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAABnBvbGljeQAAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAY=",
        "AAAAAAAAAD1CdXlzIHdpdGggYSBwcmlvciBkZWNpc2lvbi1iZWFyaW5nIHRyYWNlIGNvbnN1bWVkIGF0b21pY2FsbHkuAAAAAAAAEGFnZW50X2J1eV90cmFjZWQAAAAIAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAQY29ycmVsYXRpb25fY2FwcwAAAAAAAAABAAAD6QAAB9AAAAAPQ29ycmVsYXRpb25DYXBzAAAAAAM=",
        "AAAAAAAAAAAAAAAQZ2V0X3ByaWNlX3BvbGljeQAAAAAAAAABAAAH0AAAAAtQcmljZVBvbGljeQA=",
        "AAAAAAAAAAAAAAAQbWFya2V0X3ZhbHVhdGlvbgAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAJVmFsdWF0aW9uAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAQcmVxdWVzdF93aXRoZHJhdwAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAA+kAAAPtAAAAAgAAAAsAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAQcmVzZXRfcG5sX3dpbmRvdwAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAKlMZW5ndGhlbnMgdGhlIHRpbWVsb2NrLiBTaG9ydGVuaW5nIGlzIHJlZnVzZWQgb3V0cmlnaHQ6IGl0IHdvdWxkCml0c2VsZiBoYXZlIHRvIHdhaXQgb3V0IHRoZSBvbGQgZGVsYXkgdG8gYmUgc2FmZSwgYW5kIGEgbGVuZ3RoZW5pbmcKY2FuIGFsd2F5cyBiZSB1bmRvbmUgYnkgcmVkZXBsb3lpbmcuAAAAAAAAEHNldF9jb25maWdfZGVsYXkAAAABAAAAAAAAAAluZXdfZGVsYXkAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAQc2V0X21heF9tYXJrX2FnZQAAAAEAAAAAAAAAB2xlZGdlcnMAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAQc2V0X3ByaWNlX3BvbGljeQAAAAEAAAAAAAAABnBvbGljeQAAAAAH0AAAAAtQcmljZVBvbGljeQAAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAEkVtZXJnZW5jeVdpdGhkcmF3bgAAAAAAAQAAABNlbWVyZ2VuY3lfd2l0aGRyYXduAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEk5ldEV4cG9zdXJlVXBkYXRlZAAAAAAAAQAAABRuZXRfZXhwb3N1cmVfdXBkYXRlZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAApuZXRfbWFya2V0AAAAAAALAAAAAAAAAAAAAAAJbmV0X3RvdGFsAAAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAjlQcmUtdHJhZGUgcmVzb2x2YWJpbGl0eSBwb2xpY3kgZm9yIGBhZ2VudF9idXlgIC8gYGFnZW50X2J1eV92MmAgKCMyNzMpOiB0aGUKdHJlYXN1cnkgd2lsbCBub3QgcHV0IGRlcG9zaXRvciBjYXBpdGFsIGludG8gYSBtYXJrZXQgdGhhdCBjYW5ub3QgYmUKcmVzb2x2ZWQsIHdoYXRldmVyIHRoZSBhZ2VudCBiZWxpZXZlcy4gU2VsbHMsIHJlZGVtcHRpb25zIGFuZCBzZXR0bGVtZW50IGFyZQpuZXZlciBnYXRlZCBieSBpdCAodGhlIHRyZWFzdXJ5IG11c3QgYWx3YXlzIGJlIGFibGUgdG8gZXhpdCBvciBzZXR0bGUpLgoKVGlnaHRlbmluZyBpcyBpbW1lZGlhdGUgKGEgZmxhZyBzZXQgdG8gYHRydWVgLCBhIGxhcmdlciBgbWluX3NlY3NfdG9fY2xvc2VgLApmZXdlciBgYWxsb3dlZF9zcGVjc2AgYml0cyk7IGV2ZXJ5dGhpbmcgZWxzZSB3YWl0cyBgY29uZmlnX2RlbGF5YCwgbGlrZSB0aGUKb3RoZXIgcG9saWNpZXMuIFRoZSBkZWZhdWx0IGlzIGZ1bGx5IHBlcm1pc3NpdmUsIHNvIGFuIHVwZ3JhZGVkIGRlcGxveW1lbnQKYmVoYXZlcyBhcyBiZWZvcmUgdW50aWwgdGhlIGFkbWluIHRpZ2h0ZW5zIGl0LgAAAAAAAAAAAAATUmVzb2x2YWJpbGl0eVBvbGljeQAAAAAFAAAAQUJpdG1hc2sgb3ZlciBgcmVzb2x2ZXI6OlNwZWNLaW5kYDoga2luZHMgdGhhdCBtYXkgYmUgYm91Z2h0IGludG8uAAAAAAAADWFsbG93ZWRfc3BlY3MAAAAAAAAEAAAARE5vIGJ1eXMgd2hpbGUgdGhlIHJlc29sdmVyIHJlcG9ydHMgYERpc3B1dGVkYCAoZmluYWxpemF0aW9uIGZyb3plbikuAAAAE2Jsb2NrX3doZW5fZGlzcHV0ZWQAAAAAAQAAAIxObyBidXlzIHdoaWxlIGEgc2lnbmVyIHByb3Bvc2FsIGlzIHBlbmRpbmcuIE9mZiBieSBkZWZhdWx0OiBvcGVuaW5nIGEKcHJvcG9zYWwgbmVlZHMgYSBzaWduZXIsIGJ1dCBhIHF1b3J1bSBjYW4gc3RpbGwgdXNlIGl0IHRvIGZyZWV6ZSBidXlzLgAAABhibG9ja193aXRoX29wZW5fcHJvcG9zYWwAAAABAAAAjE1pbmltdW0gc2Vjb25kcyBiZXR3ZWVuIG5vdyBhbmQgYGNsb3NlX3RpbWVgIGZvciBhIGJ1eSAoMCA9IG5vbmUpLiBEb2VzCm5vdCBhcHBseSB0byBzZWVkLWFuZC1yZXZlYWwgY3JlYXRpb24sIHdoaWNoIGhhcHBlbnMgZmFyIGZyb20gY2xvc2UuAAAAEW1pbl9zZWNzX3RvX2Nsb3NlAAAAAAAABgAAAEVUaGUgbWFya2V0J3MgcmVzb2x1dGlvbiBzcGVjIG11c3QgaGF2ZSBiZWVuIHJldmVhbGVkIHRvIGl0cyByZXNvbHZlci4AAAAAAAAQcmVxdWlyZV9yZXZlYWxlZAAAAAE=",
        "AAAAAAAAAAAAAAARYWdlbnRfZGFpbHlfdXNhZ2UAAAAAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAD6QAAB9AAAAAKRGFpbHlVc2FnZQAAAAAAAw==",
        "AAAAAAAAAD5TZWxscyB3aXRoIGEgcHJpb3IgZGVjaXNpb24tYmVhcmluZyB0cmFjZSBjb25zdW1lZCBhdG9taWNhbGx5LgAAAAAAEWFnZW50X3NlbGxfdHJhY2VkAAAAAAAACAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAARYWxsb2NhdGVfdG9feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARYXZhaWxhYmxlX2NhcGl0YWwAAAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAARY2FwaXRhbF9icmVha2Rvd24AAAAAAAAAAAAAAQAAA+kAAAfQAAAAEENhcGl0YWxCcmVha2Rvd24AAAAD",
        "AAAAAAAAAAAAAAARY2F0ZWdvcnlfZXhwb3N1cmUAAAAAAAACAAAAAAAAAARjb3JlAAAAEwAAAAAAAAADaWR4AAAAAAQAAAABAAAACw==",
        "AAAAAAAAARNEZWNsYXJlcyBhbiBlbWVyZ2VuY3k6IG9wZW5zIGBlbWVyZ2VuY3lfd2l0aGRyYXdgICh0aGUgaWRsZS1vbmx5LApwb3NpdGlvbi1mb3JmZWl0aW5nIGV4aXQpIGFuZCBjbG9zZXMgbmV3IHdpdGhkcmF3YWwgcmVxdWVzdHMuIE9ubHkgZnJvbQpgQWRtaW5QYXVzZWRgLCBzbyBvbmUgYWRtaW4gY2FsbCBjYW5ub3QgZmxpcCBzdHJhaWdodCBpbnRvIHRoZSBmb3JmZWl0aW5nCmV4aXQ7IHdpdGggdGhlIHRpbWVsb2NrIGFzIGFkbWluIHRoZSBleHRyYSBzdGVwIGlzIGRlbGF5ZWQgdG9vLgAAAAARZGVjbGFyZV9lbWVyZ2VuY3kAAAAAAAABAAAAAAAAAAZyZWFzb24AAAAAABEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARb3Blbl9tYXJrZXRfY291bnQAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAARcmVjYWxsX2Zyb21feWllbGQAAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAE0FnZW50UG9saWN5UHJvcG9zZWQAAAAAAQAAABVhZ2VudF9wb2xpY3lfcHJvcG9zZWQAAAAAAAAFAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAAVyb2xlcwAAAAAAAAQAAAAAAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1ByaWNlUG9saWN5UHJvcG9zZWQAAAAAAQAAABVwcmljZV9wb2xpY3lfcHJvcG9zZWQAAAAAAAADAAAAAAAAAANvbGQAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAAAtQcmljZVBvbGljeQAAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAAFFBlbmRpbmdSZXNvbHZhYmlsaXR5AAAAAwAAAAAAAAANZXhlY3V0YWJsZV9hdAAAAAAAAAYAAAAAAAAABnBvbGljeQAAAAAH0AAAABNSZXNvbHZhYmlsaXR5UG9saWN5AAAAAAAAAAALcHJvcG9zZWRfYXQAAAAABg==",
        "AAAAAAAAAAAAAAASZGFpbHlfdXNhZ2VfZGV0YWlsAAAAAAAAAAAAAQAAA+kAAAfQAAAAC1VzYWdlV2luZG93AAAAAAM=",
        "AAAAAAAAAZ1gTW9kZTo6RW1lcmdlbmN5YCBvbmx5IChgZGVjbGFyZV9lbWVyZ2VuY3lgLCBpdHNlbGYgb25seSBmcm9tIGFuIGFkbWluCnBhdXNlKTogYnVybnMgYHNoYXJlc2AgZm9yIHRoZWlyIHByby1yYXRhIHBhcnQgb2YgdGhlIGZyZWUgaWRsZQpjb2xsYXRlcmFsLCB3aXRob3V0IHJlYWRpbmcgbWFya2V0LWNvcmUgKGZvciB3aGVuIGl0IGlzIHRoZSB0aGluZyB0aGF0CmJyb2tlKS4gVGhlIG93bmVyIGZvcmZlaXRzIHRoZWlyIHBhcnQgb2Ygb3BlbiBwb3NpdGlvbnMsIHdoaWNoIHN0YXlzIHdpdGgKdGhlIHJlbWFpbmluZyBzaGFyZWhvbGRlcnMuIEEgZHJhd2Rvd24gaGFsdCBvciBhbiBvcmRpbmFyeSBhZG1pbiBwYXVzZQpuZXZlciBvcGVucyBpdDogdGhlIG5vcm1hbCBxdWV1ZWQgZXhpdCBwYXlzIGF0IE5BViAoQURSIDAwMDUpLgAAAAAAABJlbWVyZ2VuY3lfd2l0aGRyYXcAAAAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFEFnZW50UG9saWN5Q2FuY2VsbGVkAAAAAQAAABZhZ2VudF9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFByaWNlUG9saWN5Q2FuY2VsbGVkAAAAAQAAABZwcmljZV9wb2xpY3lfY2FuY2VsbGVkAAAAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALUHJpY2VQb2xpY3kAAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAATYWdlbnRfY2xhaW1fbHBfZmVlcwAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAATYWdlbnRfY3JlYXRlX21hcmtldAAAAAAIAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAPcmVzb2x1dGlvbl9oYXNoAAAAA+4AAAAgAAAAAAAAAAhtZXRhX3VyaQAAABAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAALc2VlZF9hbW91bnQAAAAACwAAAAAAAAAPaW5pdGlhbF95ZXNfYnBzAAAAAAQAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAAAAAAATY2FuY2VsX21heF9tYXJrX2FnZQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX3ByaWNlX3BvbGljeQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATY2FuY2VsX3RyYWNlX3BvbGljeQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAATY29sbGVjdF9tYXJrZXRfZmVlcwAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAATZ2V0X2NyZWF0aW9uX3BvbGljeQAAAAAAAAAAAQAAA+kAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2NyZWF0aW9uX3BvbGljeQAAAAABAAAAAAAAAApuZXdfcG9saWN5AAAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAATc2V0X2RyYXdkb3duX2NvbmZpZwAAAAACAAAAAAAAAAxtYXhfZHJhd2Rvd24AAAALAAAAAAAAAAt3aW5kb3dfZGF5cwAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFUNyZWF0aW9uUG9saWN5VXBkYXRlZAAAAAAAAAEAAAAXY3JlYXRpb25fcG9saWN5X3VwZGF0ZWQAAAAAAgAAAAAAAAADb2xkAAAAB9AAAAAOQ3JlYXRpb25Qb2xpY3kAAAAAAAAAAAAAAAAAA25ldwAAAAfQAAAADkNyZWF0aW9uUG9saWN5AAAAAAAAAAAAAg==",
        "AAAAAAAAAIZEZXByZWNhdGVkIG5vLW9wLCBrZXB0IHNvIGV4aXN0aW5nIGNhbGxlcnMgYW5kIGJpbmRpbmdzIGtlZXAgd29ya2luZzoKYWNrbm93bGVkZ2luZyBpcyBubyBsb25nZXIgYSBzZXBhcmF0ZSBzdGVwLiBVc2UgYHJlc3VtZV9hZ2VudHNgLgAAAAAAFGFja25vd2xlZGdlX2RyYXdkb3duAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAUYXZhaWxhYmxlX2NhcGl0YWxfb2YAAAABAAAAAAAAAAV0b2tlbgAAAAAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAUY2xhaW1fcG9vbF9yZW1haW5kZXIAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAUY29ycmVsYXRpb25faGVhZHJvb20AAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAPtAAAAAgAAAAsAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAUZXhlY3V0ZV9tYXhfbWFya19hZ2UAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAUZXhlY3V0ZV9wcmljZV9wb2xpY3kAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAUZXhlY3V0ZV90cmFjZV9wb2xpY3kAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAUbWF4X21hcmtfYWdlX2xlZGdlcnMAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAAUcGVuZGluZ19tYXhfbWFya19hZ2UAAAAAAAAAAQAAA+gAAAfQAAAADlBlbmRpbmdNYXJrQWdlAAA=",
        "AAAAAAAAAAAAAAAUcGVuZGluZ19wcmljZV9wb2xpY3kAAAAAAAAAAQAAA+gAAAfQAAAAElBlbmRpbmdQcmljZVBvbGljeQAA",
        "AAAAAAAAAAAAAAAUcHJvcG9zZV90cmFjZV9wb2xpY3kAAAADAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAALVHJhY2VQb2xpY3kAAAAAAAAAABVtYXhfdHJhY2VfYWdlX2xlZGdlcnMAAAAAAAAEAAAAAAAAAAhyZWdpc3RyeQAAA+gAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFlJlc29sdmFiaWxpdHlQb2xpY3lTZXQAAAAAAAEAAAAYcmVzb2x2YWJpbGl0eV9wb2xpY3lfc2V0AAAAAwAAAAAAAAADb2xkAAAAB9AAAAATUmVzb2x2YWJpbGl0eVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAABNSZXNvbHZhYmlsaXR5UG9saWN5AAAAAAAAAAAAAAAACWltbWVkaWF0ZQAAAAAAAAEAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAVY2xhaW1fcG9vbF9yZW1haW5kZXJzAAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAptYXJrZXRfaWRzAAAAAAPqAAAABgAAAAEAAAPpAAAH0AAAAAtCYXRjaFJlc3VsdAAAAAAD",
        "AAAABQAAAAAAAAAAAAAAF0NvcnJlbGF0aW9uQ2Fwc0V4ZWN1dGVkAAAAAAEAAAAZY29ycmVsYXRpb25fY2Fwc19leGVjdXRlZAAAAAAAAAIAAAAAAAAABGNhcHMAAAfQAAAAD0NvcnJlbGF0aW9uQ2FwcwAAAAAAAAAAAAAAAAlpbW1lZGlhdGUAAAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAF0NvcnJlbGF0aW9uQ2Fwc1Byb3Bvc2VkAAAAAAEAAAAZY29ycmVsYXRpb25fY2Fwc19wcm9wb3NlZAAAAAAAAAIAAAAAAAAABGNhcHMAAAfQAAAAD0NvcnJlbGF0aW9uQ2FwcwAAAAAAAAAAAAAAAA1leGVjdXRhYmxlX2F0AAAAAAAABgAAAAAAAAAC",
        "AAAAAAAAAAAAAAAWc2V0X2RlZmF1bHRfZXhpdF9mbG9vcgAAAAAAAQAAAAAAAAAJcHJpY2VfYnBzAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABQAAAAAAAAAAAAAAGENvcnJlbGF0aW9uQ2Fwc0NhbmNlbGxlZAAAAAEAAAAaY29ycmVsYXRpb25fY2Fwc19jYW5jZWxsZWQAAAAAAAAAAAAC",
        "AAAAAAAAAAAAAAAXY2FuY2VsX2NvcnJlbGF0aW9uX2NhcHMAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABQAAAAAAAAAAAAAAGUNvcnJlbGF0ZWRFeHBvc3VyZVVwZGF0ZWQAAAAAAAABAAAAG2NvcnJlbGF0ZWRfZXhwb3N1cmVfdXBkYXRlZAAAAAAFAAAAAAAAAARjb3JlAAAAEwAAAAAAAAAAAAAACGNhdGVnb3J5AAAABAAAAAAAAAAAAAAABmJ1Y2tldAAAAAAABgAAAAAAAAAAAAAADmNhdGVnb3J5X3RvdGFsAAAAAAALAAAAAAAAAAAAAAAMYnVja2V0X3RvdGFsAAAACwAAAAAAAAAC",
        "AAAAAAAAAAAAAAAYZXhlY3V0ZV9jb3JyZWxhdGlvbl9jYXBzAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAYZ2V0X3Jlc29sdmFiaWxpdHlfcG9saWN5AAAAAAAAAAEAAAfQAAAAE1Jlc29sdmFiaWxpdHlQb2xpY3kA",
        "AAAAAAAAAAAAAAAYcGVuZGluZ19jb3JyZWxhdGlvbl9jYXBzAAAAAAAAAAEAAAPoAAAH0AAAABJQZW5kaW5nQ29ycmVsYXRpb24AAA==",
        "AAAAAAAAAAAAAAAYcHJvcG9zZV9jb3JyZWxhdGlvbl9jYXBzAAAAAQAAAAAAAAAEY2FwcwAAB9AAAAAPQ29ycmVsYXRpb25DYXBzAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAMhBZG1pbiBvbmx5LiBUaWdodGVuaW5nIChhIGZsYWcgdG8gYHRydWVgLCBhIGxhcmdlciBgbWluX3NlY3NfdG9fY2xvc2VgLApmZXdlciBgYWxsb3dlZF9zcGVjc2AgYml0cykgYXBwbGllcyBhdCBvbmNlOyBhbnl0aGluZyB0aGF0IGxvb3NlbnMgYSBrbm9iCndhaXRzIGBjb25maWdfZGVsYXlgIChgZXhlY3V0ZV9yZXNvbHZhYmlsaXR5X3BvbGljeWApLgAAABhzZXRfcmVzb2x2YWJpbGl0eV9wb2xpY3kAAAABAAAAAAAAAAZwb2xpY3kAAAAAB9AAAAATUmVzb2x2YWJpbGl0eVBvbGljeQAAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAG1Jlc29sdmFiaWxpdHlQb2xpY3lQcm9wb3NlZAAAAAABAAAAHXJlc29sdmFiaWxpdHlfcG9saWN5X3Byb3Bvc2VkAAAAAAAAAwAAAAAAAAADb2xkAAAAB9AAAAATUmVzb2x2YWJpbGl0eVBvbGljeQAAAAAAAAAAAAAAAANuZXcAAAAH0AAAABNSZXNvbHZhYmlsaXR5UG9saWN5AAAAAAAAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAHFJlc29sdmFiaWxpdHlQb2xpY3lDYW5jZWxsZWQAAAABAAAAHnJlc29sdmFiaWxpdHlfcG9saWN5X2NhbmNlbGxlZAAAAAAAAQAAAAAAAAAGcG9saWN5AAAAAAfQAAAAE1Jlc29sdmFiaWxpdHlQb2xpY3kAAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAbY2FuY2VsX3Jlc29sdmFiaWxpdHlfcG9saWN5AAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAbbGVnYWN5X2NsYWltX3Bvb2xfcmVtYWluZGVyAAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAEY29yZQAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAFNBcHBsaWVzIHRoZSBwZW5kaW5nIHJlc29sdmFiaWxpdHkgcG9saWN5IG9uY2UgaXRzIGRlbGF5IGhhcyBwYXNzZWQuClBlcm1pc3Npb25sZXNzLgAAAAAcZXhlY3V0ZV9yZXNvbHZhYmlsaXR5X3BvbGljeQAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAccGVuZGluZ19yZXNvbHZhYmlsaXR5X3BvbGljeQAAAAAAAAABAAAD6AAAB9AAAAAUUGVuZGluZ1Jlc29sdmFiaWxpdHk=",
        "AAAAAAAAAAAAAAAdYWdlbnRfY3JlYXRlX21hcmtldF9yZXZlYWxfdjIAAAAAAAAIAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAAAAAAAeYWdlbnRfY3JlYXRlX21hcmtldF9hbmRfcmV2ZWFsAAAAAAAJAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACHJlc29sdmVyAAAAEwAAAAAAAAANcXVlc3Rpb25faGFzaAAAAAAAA+4AAAAgAAAAAAAAAAhtZXRhX3VyaQAAABAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAALc2VlZF9hbW91bnQAAAAACwAAAAAAAAAPaW5pdGlhbF95ZXNfYnBzAAAAAAQAAAAAAAAAB3NwZWNfdjIAAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAeYWdlbnRfY3JlYXRlX21hcmtldF9jb2xsYXRlcmFsAAAAAAAJAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACmNvbGxhdGVyYWwAAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAPcmVzb2x1dGlvbl9oYXNoAAAAA+4AAAAgAAAAAAAAAAhtZXRhX3VyaQAAABAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAALc2VlZF9hbW91bnQAAAAACwAAAAAAAAAPaW5pdGlhbF95ZXNfYnBzAAAAAAQAAAABAAAD6QAAAAYAAAAD",
        "AAAAAgAAALhBIGNsYXNzIG9mIHN0YXRlLWNoYW5naW5nIGVudHJ5cG9pbnQuIEV2ZXJ5IG9uZSB0aGUgdHJlYXN1cnkgZXhwb3NlcyBtYXBzIHRvCmV4YWN0bHkgb25lIGBPcGAgKG9yIGlzIHB1cmUgYWRtaW4gY29uZmlndXJhdGlvbiwgd2hpY2ggaXMgbmV2ZXIgZ2F0ZWQ7IHNlZQp0aGUgYG1hdHJpeGAgdGVzdCBpbiBgbGliLnJzYCkuAAAAAAAAAAJPcAAAAAAACwAAAAAAAAAKYGRlcG9zaXRgLgAAAAAAB0RlcG9zaXQAAAAAAAAAABNgcmVxdWVzdF93aXRoZHJhd2AuAAAAAA9SZXF1ZXN0V2l0aGRyYXcAAAAAAAAAADVgY2xhaW1fd2l0aGRyYXdgIChwYXlzIGEgdGlja2V0IHRoYXQgYWxyZWFkeSBleGlzdHMpLgAAAAAAAA1DbGFpbVdpdGhkcmF3AAAAAAAAAAAAABVgZW1lcmdlbmN5X3dpdGhkcmF3YC4AAAAAAAARRW1lcmdlbmN5V2l0aGRyYXcAAAAAAAAAAAAAe2BhZ2VudF9jcmVhdGVfbWFya2V0YCwgYGFnZW50X2NyZWF0ZV9tYXJrZXRfYW5kX3JldmVhbGAsIGBhZ2VudF9idXlgLApgYWdlbnRfYnV5X3YyYDogYW55dGhpbmcgdGhhdCBvcGVucyBvciBhZGRzIGV4cG9zdXJlLgAAAAAJQWdlbnRPcGVuAAAAAAAAAAAAAEdgYWdlbnRfc2VsbGAsIGBhZ2VudF9zZWxsX3YyYCwgYGNsb3NlX3RyYWRlYDogYW55dGhpbmcgdGhhdCByZWR1Y2VzIGl0LgAAAAALQWdlbnRSZWR1Y2UAAAAAAAAAAHpgcmVkZWVtYCwgYGNsYWltX3Bvb2xfcmVtYWluZGVyYCwgdGhlIGJhdGNoIHZhcmlhbnRzIGFuZApgYWdlbnRfY2xhaW1fbHBfZmVlc2A6IGJyaW5naW5nIGNvbGxhdGVyYWwgaG9tZSBhZnRlciByZXNvbHV0aW9uLgAAAAAAC0FnZW50U2V0dGxlAAAAAAAAAABNYHNldHRsZV9tYXJrZXRgLCBgcmVhbGl6ZWAsIGBjb2xsZWN0X21hcmtldF9mZWVzYDogcGVybWlzc2lvbmxlc3MKc2V0dGxlbWVudC4AAAAAAAAUUGVybWlzc2lvbmxlc3NTZXR0bGUAAAAAAAAAFGBhbGxvY2F0ZV90b195aWVsZGAuAAAADVlpZWxkQWxsb2NhdGUAAAAAAAAAAAAAFGByZWNhbGxfZnJvbV95aWVsZGAuAAAAC1lpZWxkUmVjYWxsAAAAAAAAAAARYG1pZ3JhdGVfbWFya2V0YC4AAAAAAAAHTWlncmF0ZQA=",
        "AAAAAgAAAIxXaGF0IHRoZSB0cmVhc3VyeSBpcyBkb2luZyByaWdodCBub3csIGRlcml2ZWQgZnJvbSBbYE1vZGVTdGF0ZWBdIHdpdGggdGhlCnByaW9yaXR5IGBFbWVyZ2VuY3kgPiBQYXVzZWQgPiBBZ2VudHNIYWx0ZWQgPiBVbndpbmRpbmcgPiBOb3JtYWxgLgAAAAAAAAAETW9kZQAAAAUAAAAAAAAAEEV2ZXJ5dGhpbmcgcnVucy4AAAAGTm9ybWFsAAAAAAAAAAAAikEgZHJhd2Rvd24gdHJpcHBlZDogYWdlbnRzIG1heSBub3Qgb3BlbiBvciBhZGQgZXhwb3N1cmUsIGJ1dCBtYXkgcmVkdWNlCml0LiBEZXBvc2l0b3JzIGtlZXAgdGhlaXIgbm9ybWFsIGV4aXQgKHF1ZXVlZCB3aXRoZHJhd2FscyBhdCBOQVYpLgAAAAAADEFnZW50c0hhbHRlZAAAAAAAAABAVGhlIGFkbWluIHBhdXNlZCB0aGUgdHJlYXN1cnk6IG5vIGRlcG9zaXRzIGFuZCBubyBhZ2VudCB0cmFkaW5nLgAAAAZQYXVzZWQAAAAAAAAAAACMVGhlIGFkbWluIGRlY2xhcmVkIGFuIGVtZXJnZW5jeSAob25seSBmcm9tIGBQYXVzZWRgKTogdGhlCmluLWtpbmQvaWRsZSBgZW1lcmdlbmN5X3dpdGhkcmF3YCBleGl0IG9wZW5zLCBhbmQgcXVldWVpbmcgbmV3CndpdGhkcmF3YWxzIGNsb3Nlcy4AAAAJRW1lcmdlbmN5AAAAAAAAAAAAANJUaGUgYWRtaW4gY2hvc2UgYW4gb3JkZXJseSB3aW5kLWRvd24gKGBzZXRfbW9kZShVbndpbmRpbmcpYCwgIzE1MCk6CmFnZW50cyBtYXkgbm90IG9wZW4gb3IgYWRkIGV4cG9zdXJlLCBidXQgbWF5IHNlbGwgKHNlZSBgdW53aW5kX3NlbGxgIGFuZAp0aGUgcGVyLW1hcmtldCBleGl0IGZsb29ycyksIGFuZCBldmVyeXRoaW5nIGVsc2UgcnVucyBhcyBpbiBgTm9ybWFsYC4AAAAAAAlVbndpbmRpbmcAAAA=",
        "AAAAAQAAAG9XaHkgdGhlIHRyZWFzdXJ5IGlzIG5vdCBpbiBgTm9ybWFsYC4gRWFjaCByZWFzb24gaXMgc3RvcmVkIGluZGVwZW5kZW50bHksIHNvCmNsZWFyaW5nIG9uZSBuZXZlciBjbGVhcnMgYW5vdGhlci4AAAAAAAAAAAlNb2RlU3RhdGUAAAAAAAAGAAAAS0xlZGdlciB0aW1lIG9mIHRoZSBhZG1pbiBwYXVzZS4gQ2xlYXJlZCBieSBgdW5wYXVzZWAgLyBgc2V0X3BhdXNlZChmYWxzZSlgLgAAAAAOYWRtaW5fcGF1c2VfYXQAAAAAA+gAAAAGAAAAiVRoZSByZWFzb24gdGhlIGFkbWluIGdhdmUgKGBhZG1pbmAgZm9yIGBzZXRfcGF1c2VkKHRydWUpYDsgYGxlZ2FjeWAgZm9yIGEKcGF1c2UgcmVhZCBmcm9tIHRoZSBwcmUtIzI3MiBmbGFncykuIFNldCB3aXRoIGBhZG1pbl9wYXVzZV9hdGAuAAAAAAAAEmFkbWluX3BhdXNlX3JlYXNvbgAAAAAD6AAAABEAAABFTGVkZ2VyIHRpbWUgYSBkcmF3ZG93biBoYWx0ZWQgdGhlIGFnZW50cy4gQ2xlYXJlZCBieSBgcmVzdW1lX2FnZW50c2AuAAAAAAAADWRyYXdkb3duX2hhbHQAAAAAAAPoAAAABgAAAEhMZWRnZXIgdGltZSB0aGUgYWRtaW4gZGVjbGFyZWQgYW4gZW1lcmdlbmN5LiBDbGVhcmVkIGJ5IGBlbmRfZW1lcmdlbmN5YC4AAAAMZW1lcmdlbmN5X2F0AAAD6AAAAAYAAAAzVGhlIHJlYXNvbiB0aGUgYWRtaW4gZ2F2ZS4gU2V0IHdpdGggYGVtZXJnZW5jeV9hdGAuAAAAABBlbWVyZ2VuY3lfcmVhc29uAAAD6AAAABEAAABFTGVkZ2VyIHRpbWUgdGhlIGFkbWluIHNldCBgVW53aW5kaW5nYC4gQ2xlYXJlZCBieSBgc2V0X21vZGUoTm9ybWFsKWAuAAAAAAAADHVud2luZGluZ19hdAAAA+gAAAAG" ]),
      options
    )
  }
  public readonly fromJSON = {
    nav: this.txFromJSON<Result<i128>>,
        mode: this.txFromJSON<Mode>,
        pause: this.txFromJSON<Result<void>>,
        redeem: this.txFromJSON<Result<i128>>,
        allowed: this.txFromJSON<boolean>,
        deposit: this.txFromJSON<Result<i128>>,
        realize: this.txFromJSON<Result<void>>,
        unpause: this.txFromJSON<Result<void>>,
        unwound: this.txFromJSON<i128>,
        agent_at: this.txFromJSON<Option<string>>,
        realized: this.txFromJSON<Realized>,
        set_mode: this.txFromJSON<Result<void>>,
        unwinder: this.txFromJSON<Option<string>>,
        agent_buy: this.txFromJSON<Result<i128>>,
        cancel_op: this.txFromJSON<Result<void>>,
        get_agent: this.txFromJSON<Option<AgentPolicy>>,
        set_agent: this.txFromJSON<Result<void>>,
        shares_of: this.txFromJSON<i128>,
        agent_halt: this.txFromJSON<Result<void>>,
        agent_sell: this.txFromJSON<Result<i128>>,
        audit_mark: this.txFromJSON<Option<MarkRecord>>,
        execute_op: this.txFromJSON<Result<void>>,
        exit_floor: this.txFromJSON<u32>,
        get_config: this.txFromJSON<Result<RiskConfig>>,
        get_global: this.txFromJSON<Result<GlobalConfig>>,
        market_pnl: this.txFromJSON<MarketPnl>,
        mode_state: this.txFromJSON<ModeState>,
        nav_detail: this.txFromJSON<NavDetail>,
        pending_op: this.txFromJSON<Option<PendingAdminOp>>,
        propose_op: this.txFromJSON<Result<u64>>,
        set_paused: this.txFromJSON<Result<void>>,
        token_caps: this.txFromJSON<Result<TokenCaps>>,
        window_pnl: this.txFromJSON<Result<i128>>,
        agent_count: this.txFromJSON<u32>,
        close_trade: this.txFromJSON<Result<i128>>,
        daily_usage: this.txFromJSON<Result<DailyUsage>>,
        get_net_cap: this.txFromJSON<Result<i128>>,
        redeem_many: this.txFromJSON<Result<BatchResult>>,
        agent_buy_v2: this.txFromJSON<Result<i128>>,
        cancel_agent: this.txFromJSON<Result<void>>,
        config_delay: this.txFromJSON<u64>,
        net_exposure: this.txFromJSON<i128>,
        net_position: this.txFromJSON<Result<NetPosition>>,
        queue_bounds: this.txFromJSON<readonly [u64, u64]>,
        refresh_mark: this.txFromJSON<Result<void>>,
        remove_agent: this.txFromJSON<Result<void>>,
        set_unwinder: this.txFromJSON<Result<void>>,
        total_shares: this.txFromJSON<i128>,
        trace_policy: this.txFromJSON<TracePolicyConfig>,
        agent_sell_v2: this.txFromJSON<Result<i128>>,
        cancel_config: this.txFromJSON<Result<void>>,
        deposit_token: this.txFromJSON<Result<i128>>,
        disable_yield: this.txFromJSON<Result<void>>,
        end_emergency: this.txFromJSON<Result<void>>,
        execute_agent: this.txFromJSON<Result<void>>,
        legacy_redeem: this.txFromJSON<Result<i128>>,
        migrate_marks: this.txFromJSON<Result<u32>>,
        pending_agent: this.txFromJSON<Option<PendingAgent>>,
        resume_agents: this.txFromJSON<Result<void>>,
        set_successor: this.txFromJSON<Result<void>>,
        settle_market: this.txFromJSON<Result<SettlementReport>>,
        claim_withdraw: this.txFromJSON<Result<i128>>,
        creation_usage: this.txFromJSON<Result<u32>>,
        daily_headroom: this.txFromJSON<Result<i128>>,
        execute_config: this.txFromJSON<Result<void>>,
        liquid_capital: this.txFromJSON<Result<i128>>,
        open_market_at: this.txFromJSON<Option<OpenMarket>>,
        pending_config: this.txFromJSON<Option<PendingConfig>>,
        propose_config: this.txFromJSON<Result<void>>,
        queue_reserved: this.txFromJSON<i128>,
        set_exit_floor: this.txFromJSON<Result<void>>,
        set_token_caps: this.txFromJSON<Result<void>>,
        bucket_exposure: this.txFromJSON<i128>,
        drawdown_status: this.txFromJSON<Result<DrawdownStatus>>,
        migrate_markets: this.txFromJSON<Result<void>>,
        set_yield_venue: this.txFromJSON<Result<void>>,
        withdraw_ticket: this.txFromJSON<Option<WithdrawTicket>>,
        agent_buy_traced: this.txFromJSON<Result<i128>>,
        correlation_caps: this.txFromJSON<Result<CorrelationCaps>>,
        get_price_policy: this.txFromJSON<PricePolicy>,
        market_valuation: this.txFromJSON<Result<Valuation>>,
        request_withdraw: this.txFromJSON<Result<readonly [i128, u64]>>,
        reset_pnl_window: this.txFromJSON<Result<void>>,
        set_config_delay: this.txFromJSON<Result<void>>,
        set_max_mark_age: this.txFromJSON<Result<void>>,
        set_price_policy: this.txFromJSON<Result<void>>,
        agent_daily_usage: this.txFromJSON<Result<DailyUsage>>,
        agent_sell_traced: this.txFromJSON<Result<i128>>,
        allocate_to_yield: this.txFromJSON<Result<void>>,
        available_capital: this.txFromJSON<Result<i128>>,
        capital_breakdown: this.txFromJSON<Result<CapitalBreakdown>>,
        category_exposure: this.txFromJSON<i128>,
        declare_emergency: this.txFromJSON<Result<void>>,
        open_market_count: this.txFromJSON<u32>,
        recall_from_yield: this.txFromJSON<Result<void>>,
        daily_usage_detail: this.txFromJSON<Result<UsageWindow>>,
        emergency_withdraw: this.txFromJSON<Result<i128>>,
        agent_claim_lp_fees: this.txFromJSON<Result<i128>>,
        agent_create_market: this.txFromJSON<Result<u64>>,
        cancel_max_mark_age: this.txFromJSON<Result<void>>,
        cancel_price_policy: this.txFromJSON<Result<void>>,
        cancel_trace_policy: this.txFromJSON<Result<void>>,
        collect_market_fees: this.txFromJSON<Result<i128>>,
        get_creation_policy: this.txFromJSON<Result<CreationPolicy>>,
        set_creation_policy: this.txFromJSON<Result<void>>,
        set_drawdown_config: this.txFromJSON<Result<void>>,
        acknowledge_drawdown: this.txFromJSON<Result<void>>,
        available_capital_of: this.txFromJSON<Result<i128>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        correlation_headroom: this.txFromJSON<Result<readonly [i128, i128]>>,
        execute_max_mark_age: this.txFromJSON<Result<void>>,
        execute_price_policy: this.txFromJSON<Result<void>>,
        execute_trace_policy: this.txFromJSON<Result<void>>,
        max_mark_age_ledgers: this.txFromJSON<u32>,
        pending_max_mark_age: this.txFromJSON<Option<PendingMarkAge>>,
        pending_price_policy: this.txFromJSON<Option<PendingPricePolicy>>,
        propose_trace_policy: this.txFromJSON<Result<void>>,
        claim_pool_remainders: this.txFromJSON<Result<BatchResult>>,
        set_default_exit_floor: this.txFromJSON<Result<void>>,
        cancel_correlation_caps: this.txFromJSON<Result<void>>,
        execute_correlation_caps: this.txFromJSON<Result<void>>,
        get_resolvability_policy: this.txFromJSON<ResolvabilityPolicy>,
        pending_correlation_caps: this.txFromJSON<Option<PendingCorrelation>>,
        propose_correlation_caps: this.txFromJSON<Result<void>>,
        set_resolvability_policy: this.txFromJSON<Result<void>>,
        cancel_resolvability_policy: this.txFromJSON<Result<void>>,
        legacy_claim_pool_remainder: this.txFromJSON<Result<i128>>,
        execute_resolvability_policy: this.txFromJSON<Result<void>>,
        pending_resolvability_policy: this.txFromJSON<Option<PendingResolvability>>,
        agent_create_market_reveal_v2: this.txFromJSON<Result<u64>>,
        agent_create_market_and_reveal: this.txFromJSON<Result<u64>>,
        agent_create_market_collateral: this.txFromJSON<Result<u64>>
  }
}