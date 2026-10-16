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




export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Paused"},
  3: {message:"InvalidFee"},
  4: {message:"InvalidAmount"},
  5: {message:"InvalidProbability"},
  6: {message:"InvalidCloseTime"},
  7: {message:"MarketNotFound"},
  8: {message:"MarketNotOpen"},
  9: {message:"MarketClosed"},
  10: {message:"NotClosedYet"},
  11: {message:"NotFinal"},
  12: {message:"SlippageExceeded"},
  13: {message:"InsufficientShares"},
  14: {message:"InsufficientLiquidity"},
  15: {message:"MarketTooLarge"},
  16: {message:"NothingToRedeem"},
  17: {message:"AlreadyClaimed"},
  18: {message:"Overflow"},
  /**
   * `buy_v2` / `sell_v2` called with `env.ledger().timestamp() > deadline`.
   */
  19: {message:"DeadlineExpired"},
  /**
   * `buy_v2` / `sell_v2` average execution price worse than the limit.
   */
  20: {message:"LimitPriceExceeded"},
  /**
   * A single trade would move the price more than `max_impact_bps`.
   * (Both this and the band reject the whole invocation, so their events,
   * if any, roll back with it — see the note on `BreakerConfig`.)
   */
  21: {message:"PriceImpactTooHigh"},
  /**
   * Cumulative same-ledger movement would exceed `band_bps`.
   */
  22: {message:"PriceBandExceeded"},
  /**
   * `outcome_index` is not a valid outcome of this categorical market.
   */
  28: {message:"InvalidOutcomeIndex"}
}



export interface Config {
  admin: string;
  collateral: string;
  default_fee_bps: u32;
  paused: boolean;
  protocol_fee_share_bps: u32;
  resolver: string;
  treasury: string;
}


export interface Market {
  category: Category;
  /**
 * Unix seconds (ledger timestamp). Trading stops at this time.
 */
close_time: u64;
  creator: string;
  /**
 * Snapshot of the flat fee at creation so later config changes never
 * move it. Charged as-is by categorical markets and by binary markets
 * without a `FeeSchedule` side entry (legacy / flat-fee markets).
 */
fee_bps: u32;
  /**
 * Trading fees waiting for `sweep_fees`.
 */
fees_accrued: i128;
  /**
 * Creator has withdrawn the pool remainder after finality.
 */
lp_claimed: boolean;
  /**
 * IPFS CID / URI of the question metadata.
 */
meta_uri: string;
  /**
 * sha256 of the canonical question JSON stored off-chain (IPFS), so a
 * client can prove the text it shows is the text that was committed.
 */
question_hash: Buffer;
  reserve_no: i128;
  reserve_yes: i128;
  /**
 * Commitment to how this market will be resolved, fixed at creation so
 * the creator cannot pick favorable resolution rules after seeing
 * trading activity. The resolver contract verifies a revealed spec
 * against this hash before configuring itself for the market. See
 * `docs/adr/0001-resolution-commitment.md`.
 */
resolution_hash: Buffer;
  /**
 * Complete sets in existence == collateral locked for this market.
 */
sets_minted: i128;
  status: MarketStatus;
}

export type DataKey = {tag: "Admin", values: void} | {tag: "Collateral", values: void} | {tag: "Treasury", values: void} | {tag: "Resolver", values: void} | {tag: "DefaultFeeBps", values: void} | {tag: "ProtocolFeeShareBps", values: void} | {tag: "DefaultBreaker", values: void} | {tag: "Paused", values: void} | {tag: "NextId", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Position", values: readonly [u64, string]} | {tag: "FeeTerms", values: readonly [u64]} | {tag: "LpFees", values: readonly [u64]} | {tag: "Breaker", values: readonly [u64]} | {tag: "Band", values: readonly [u64]} | {tag: "Kind", values: readonly [u64]} | {tag: "CatMarket", values: readonly [u64]} | {tag: "CatPosition", values: readonly [u64, string]} | {tag: "Scalar", values: readonly [u64]} | {tag: "FeeSchedule", values: readonly [u64]} | {tag: "DefaultFeeSchedule", values: void};

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};


export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};


/**
 * Fee destination and split, snapshotted per market at creation as a side
 * entry (`DataKey::FeeTerms`) so `Market`'s XDR shape never changes.
 * 
 * Markets created before this entry existed have no `FeeTerms` and keep the
 * legacy behaviour: `sweep_fees` pays whatever `DataKey::Treasury` holds at
 * sweep time, with the protocol keeping 100% of the fee. That fallback is
 * documented in `sweep_fees` and makes the upgrade migration-free.
 */
export interface FeeTerms {
  /**
 * Protocol's share of each trade fee in bps; the rest is the LP's.
 * 0..=BPS. At BPS (the default) the split is exactly today's behaviour.
 */
protocol_share_bps: u32;
  /**
 * Where the protocol's fee share is swept. Frozen at creation: later
 * `set_treasury` calls never redirect fees already earned.
 */
recipient: string;
}


export interface Position {
  no: i128;
  yes: i128;
}




/**
 * Temporary (one ledger) band reference for a market.
 */
export interface BandState {
  ledger_seq: u32;
  ref_price_bps: u32;
}


/**
 * Categorical market state. Stored under `DataKey::CatMarket(u64)`, sharing
 * the id space with binary markets (`DataKey::NextId`), so `get_market` on
 * a categorical id is `MarketNotFound` and callers must read `market_kind`.
 */
export interface CatMarket {
  category: Category;
  close_time: u64;
  creator: string;
  fee_bps: u32;
  fees_accrued: i128;
  /**
 * Creator has withdrawn the pool remainder after finality.
 */
lp_claimed: boolean;
  meta_uri: string;
  /**
 * Same commitment scheme as the binary `Market` (see there).
 */
question_hash: Buffer;
  /**
 * One reserve per outcome; `len()` is the outcome count n.
 */
reserves: Array<i128>;
  resolution_hash: Buffer;
  /**
 * Complete sets in existence == collateral locked for this market. Each
 * outcome's shares (reserve + all holder balances) sum to this.
 */
sets_minted: i128;
  status: CatStatus;
}

/**
 * Lifecycle of a categorical market: same three states as `MarketStatus`
 * with the winning index instead of a two-way outcome.
 */
export type CatStatus = {tag: "Open", values: void} | {tag: "Resolved", values: readonly [u32]} | {tag: "Void", values: void};


/**
 * Which pool a market id refers to. Absent for markets created before
 * categorical markets existed, hence `market_kind` reports `Binary` for
 * a stored `Market(u64)` and a `Kind` entry is only written for
 * categorical ids (which store a `CatMarket` instead of a `Market`).
 */
export type MarketKind = {tag: "Binary", values: void} | {tag: "Categorical", values: readonly [u32]};


/**
 * Display metadata of a scalar market: the `[lower, upper]` range of the
 * committed resolution spec, in the feed's raw units. Stored under
 * `DataKey::Scalar(u64)` at creation; the resolver's revealed spec is the
 * authoritative copy, this entry only tells UIs what to display.
 */
export interface ScalarMeta {
  lower: i128;
  upper: i128;
}


/**
 * Per-holder categorical position: one balance per outcome, same order as
 * `CatMarket::reserves`.
 */
export interface CatPosition {
  balances: Array<i128>;
}


/**
 * Dynamic fee schedule, snapshotted per binary market at creation as a
 * side entry (`DataKey::FeeSchedule`) so `Market`'s XDR shape never
 * changes. The effective rate of a trade is
 * `math::effective_fee_bps(schedule, now, close_time, r_yes, r_no)`:
 * a base rate that ramps up towards `max_bps` as `close_time` approaches
 * and grows with the pool's distance from 50/50, protecting the single LP
 * from informed flow near expiry and from one-sided pools.
 * 
 * Markets created before this existed (and categorical markets, which
 * still charge their flat `Market::fee_bps`) have no `FeeSchedule` entry
 * and keep a flat fee. The schedule is immutable after creation; only
 * `set_default_fee_schedule` (the default for *new* markets) can change.
 * Field order is part of the XDR — keep `base_bps`, `max_bps`,
 * `ramp_secs`, `skew_mult_bps` stable.
 */
export interface FeeSchedule {
  /**
 * Fee far from close with the pool at 50/50.
 */
base_bps: u32;
  /**
 * Hard ceiling for this market, `<= MAX_FEE_BPS`.
 */
max_bps: u32;
  /**
 * The time ramp starts this many seconds before `close_time`
 * (0 = no ramp, `<= math::MAX_RAMP_SECS`).
 */
ramp_secs: u64;
  /**
 * Extra bps per 1_000 bps of distance from a 5_000 price
 * (`<= math::MAX_SKEW_MULT_BPS`).
 */
skew_mult_bps: u32;
}


export type MarketStatus = {tag: "Open", values: void} | {tag: "Resolved", values: readonly [Outcome]} | {tag: "Void", values: void} | {tag: "ResolvedScalar", values: readonly [u32]};


/**
 * Per-market circuit breakers, snapshotted at creation from
 * `DataKey::DefaultBreaker`. 0 disables each check. A market without a
 * `Breaker` entry (created before breakers existed) is never checked.
 */
export interface BreakerConfig {
  /**
 * Maximum |post-price - ledger-open price| cumulative movement in bps.
 */
band_bps: u32;
  /**
 * Maximum |post-price - pre-price| a single trade may move in bps.
 */
max_impact_bps: u32;
}












export interface Client {
  /**
   * Construct and simulate a buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spend `collateral_in` to buy `outcome` shares. Returns shares received.
   * Reverts if fewer than `min_shares_out` would be received.
   * 
   * Legacy entrypoint: no deadline and no limit price, so a signed bound
   * can execute at any later time. Prefer `buy_v2`.
   */
  buy: ({trader, market_id, outcome, collateral_in, min_shares_out}: {trader: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a sell transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Receive exactly `collateral_out` by selling `outcome` shares. Returns
   * shares sold. Reverts if more than `max_shares_in` would be needed.
   * Clients turn "sell N shares" into `collateral_out` off-chain
   * (see `math::calc_sell` docs) and add a slippage margin to `max_shares_in`.
   * 
   * Legacy entrypoint: no deadline and no limit price. Prefer `sell_v2`.
   */
  sell: ({trader, market_id, outcome, collateral_out, max_shares_in}: {trader: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a buy_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `buy` plus a deadline (`env.ledger().timestamp()` seconds — network
   * time, not the client clock) and an average-price limit
   * (`limit_price_bps` per share, 1.0 = BPS; 0 = no limit).
   * 
   * The average price includes the fee (`fee` is part of `collateral_in`)
   * and, for a NO buy, is compared against the NO price. Because the
   * deadline check runs before `require_auth`, an expired transaction
   * fails cheaply. A limit above BPS can never pass for a buy and is
   * rejected as invalid.
   */
  buy_v2: ({trader, market_id, outcome, collateral_in, min_shares_out, limit_price_bps, deadline}: {trader: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays out `holder`'s position for a final market and clears it.
   * Losing positions clear with a payout of 0.
   */
  redeem: ({holder, market_id}: {holder: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a buy_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical-market counterpart of `buy`: spend `collateral_in` on
   * `outcome_index` shares. Returns shares received; reverts if fewer than
   * `min_shares_out` would be received. No v2 (deadline/limit) variant
   * yet — see the categorical notes in `docs/architecture.md`.
   */
  buy_cat: ({trader, market_id, outcome_index, collateral_in, min_shares_out}: {trader: string, market_id: u64, outcome_index: u32, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a resolve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve: ({market_id, outcome}: {market_id: u64, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sell_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `sell` plus a deadline (ledger timestamp, seconds) and a minimum
   * average execution price (`limit_price_bps` per share, 1.0 = BPS).
   * 
   * A zero limit is trivially satisfied for sells — unlike buys, where 0
   * means "no limit" — and a limit above BPS can never pass, so neither
   * needs a special case. The average includes the fee, which the trader
   * pays out of the gross.
   */
  sell_v2: ({trader, market_id, outcome, collateral_out, max_shares_in, limit_price_bps, deadline}: {trader: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a sell_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical-market counterpart of `sell`: receive exactly
   * `collateral_out` by selling `outcome_index` shares. Returns shares
   * sold; reverts if more than `max_shares_in` would be needed.
   */
  sell_cat: ({trader, market_id, outcome_index, collateral_out, max_shares_in}: {trader: string, market_id: u64, outcome_index: u32, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spot price of `outcome` in bps (0..=10_000). YES + NO ~ 10_000.
   */
  get_price: ({market_id, outcome}: {market_id: u64, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a quote_buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Shares a `buy` of `collateral_in` would return right now, at the
   * effective (possibly dynamic) fee for this ledger's timestamp.
   */
  quote_buy: ({market_id, outcome, collateral_in}: {market_id: u64, outcome: Outcome, collateral_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Config>>>

  /**
   * Construct and simulate a get_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Market>>>

  /**
   * Construct and simulate a quote_sell transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Shares a `sell` for exactly `collateral_out` would consume right now,
   * at the effective (possibly dynamic) fee for this ledger's timestamp.
   */
  quote_sell: ({market_id, outcome, collateral_out}: {market_id: u64, outcome: Outcome, collateral_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical-market counterpart of `redeem`. Winning balances pay 1:1,
   * a void pays `floor(Σ balances / n)` — both floored, so the total paid
   * across all holders never exceeds `sets_minted`.
   */
  redeem_cat: ({holder, market_id}: {holder: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sweep_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anyone can move accrued protocol fees to the market's fee recipient.
   * 
   * Sends to the recipient snapshotted in `FeeTerms` at creation. Markets
   * created before `FeeTerms` existed have none and keep the legacy
   * behaviour: the `DataKey::Treasury` of the moment of the sweep.
   * Works for both market kinds.
   */
  sweep_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a would_trip transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True when a `buy` of `collateral_in` would be rejected by the
   * market's breakers right now. Read-only: never writes band state, so
   * on a fresh ledger the reference is taken as the current price — the
   * same value a subsequent real trade would use.
   */
  would_trip: ({market_id, outcome, collateral_in}: {market_id: u64, outcome: Outcome, collateral_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a market_kind transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether a market id is a binary (`Market`) or categorical
   * (`CatMarket`) market. `MarketNotFound` for unknown ids.
   */
  market_kind: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<MarketKind>>>

  /**
   * Construct and simulate a resolve_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical-market counterpart of `resolve`. Same resolver-only gate
   * and close-time rule.
   */
  resolve_cat: ({market_id, outcome_index}: {market_id: u64, outcome_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_lp transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers the single LP role (the right to `claim_pool_remainder` and
   * `claim_lp_fees`) to `new_creator`. Only until the remainder has been
   * claimed; after that the role has no remaining value.
   */
  transfer_lp: ({market_id, new_creator}: {market_id: u64, new_creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Invalid or unresolvable market. Allowed any time before finality.
   * Dispatches on the market kind: binary markets emit `MarketResolved`
   * with `None`, categorical markets `CatMarketResolved`.
   */
  void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a fee_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The market's snapshotted dynamic fee schedule (`None` for legacy and
   * categorical markets, which charge the flat `Market::fee_bps`).
   */
  fee_schedule: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<FeeSchedule>>>>

  /**
   * Construct and simulate a get_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_position: ({market_id, holder}: {market_id: u64, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Position>>

  /**
   * Construct and simulate a market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a quote_buy_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Shares a `buy` of `collateral_in` would return at ledger timestamp
   * `at_timestamp`. Under a ramping schedule the fee rises with time, so
   * clients expecting inclusion latency can quote the worst case here
   * (see `docs/frontend-integration.md`). No other state is simulated:
   * the reserves are the current ones.
   */
  quote_buy_at: ({market_id, outcome, collateral_in, at_timestamp}: {market_id: u64, outcome: Outcome, collateral_in: i128, at_timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_resolver transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_resolver: ({resolver}: {resolver: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call and the legacy fallback in
   * `sweep_fees`. Markets with a snapshotted `FeeTerms` keep paying their
   * original recipient.
   */
  set_treasury: ({treasury}: {treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a breaker_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The current ledger's band reference, if a band check has run this
   * ledger. `None` means the next trade sets the reference (to its own
   * pre-trade price, which equals the ledger-open price).
   */
  breaker_state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<BandState>>>>

  /**
   * Construct and simulate a claim_lp_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The creator (the LP) claims their share of accrued trade fees at any
   * time, including before finality. Returns the amount claimed (0 when
   * nothing is pending, mirroring `sweep_fees`). Works for both market
   * kinds (the fee side-entries are keyed by the shared market id).
   */
  claim_lp_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and seeds the pool. `creator` becomes the sole LP.
   * `initial_yes_bps` in [100, 9900] sets the opening YES probability;
   * the creator receives the leftover shares of the likelier outcome.
   * When a default dynamic fee schedule is set it is snapshotted for
   * this market (see `set_default_fee_schedule`); otherwise the market
   * charges the flat `DefaultFeeBps`.
   */
  create_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a quote_buy_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Shares a `buy_cat` of `collateral_in` would return right now.
   */
  quote_buy_cat: ({market_id, outcome_index, collateral_in}: {market_id: u64, outcome_index: u32, collateral_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a breaker_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The market's snapshotted breakers (`None` for legacy markets created
   * before breakers existed — those are never checked).
   */
  breaker_config: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<BreakerConfig>>>>

  /**
   * Construct and simulate a get_cat_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_cat_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CatMarket>>>

  /**
   * Construct and simulate a get_prices_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spot prices of all outcomes in bps, same order as the reserves. Each
   * price is floored, so they sum to at most BPS and at least BPS - n;
   * clients should treat the slack as display rounding, never as a
   * mispricing (prices do not enter trade math).
   */
  get_prices_cat: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u32>>>>

  /**
   * Construct and simulate a resolve_scalar transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Scalar-market counterpart of `resolve`. `payout_long_bps` is the
   * final LONG payout in basis points of 1.0 (0..=10_000); the SHORT side
   * pays the complement. Same resolver-only gate and close-time rule.
   */
  resolve_scalar: ({market_id, payout_long_bps}: {market_id: u64, payout_long_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a current_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The fee bps this ledger's next trade on `market_id` pays: the
   * dynamic effective fee for binary markets with a schedule, the flat
   * snapshot for legacy and categorical markets. Under a ramping
   * schedule the value changes with the ledger timestamp; use
   * `quote_buy_at` to price expected inclusion latency.
   */
  current_fee_bps: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a get_scalar_meta transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Display metadata (the staked range) of a scalar market. Absent for
   * binary and categorical markets.
   */
  get_scalar_meta: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ScalarMeta>>>

  /**
   * Construct and simulate a get_cat_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A holder's categorical position, zero-filled to the market's outcome
   * count when they never traded. Errors if the market does not exist.
   */
  get_cat_position: ({market_id, holder}: {market_id: u64, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CatPosition>>>

  /**
   * Construct and simulate a transfer_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves `amount` shares of `outcome` from `from` to `to`.
   */
  transfer_position: ({from, to, market_id, outcome, amount}: {from: string, to: string, market_id: u64, outcome: Outcome, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_default_breaker transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the breaker defaults copied into markets created after the call.
   * `band_bps < max_impact_bps` (both non-zero) is rejected: a single
   * trade that is allowed by the impact cap could then never fit inside
   * the band, locking trading.
   */
  set_default_breaker: ({breaker}: {breaker: BreakerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_default_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call; existing markets keep their fee.
   */
  set_default_fee_bps: ({fee_bps}: {fee_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creator (the LP) withdraws whatever the pool still holds once final,
   * plus any unclaimed LP fees. Returns the total paid out.
   */
  claim_pool_remainder: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a create_scalar_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a scalar (range) market: the binary pool with LONG = YES and
   * SHORT = NO, whose final status carries a fractional payout
   * (`MarketStatus::ResolvedScalar`) instead of a side. Everything else
   * matches `create_market`; `[lower, upper]` is display metadata stored
   * under `DataKey::Scalar` (the authoritative range is inside the
   * `ResolutionSpec` committed through `resolution_hash`).
   */
  create_scalar_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, lower, upper}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, lower: i128, upper: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_market_with_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `create_market` with an explicit per-market `FeeSchedule`. Validated
   * against `MAX_FEE_BPS` and the current default schedule's `max_bps`
   * (creators can undercut protocol policy, never exceed it), then
   * snapshotted for this market's lifetime.
   */
  create_market_with_fees: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, schedule}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, schedule: FeeSchedule}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a claim_pool_remainder_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical-market counterpart of `claim_pool_remainder`: the creator
   * (the LP) withdraws the settled pool value plus any unclaimed LP fees.
   */
  claim_pool_remainder_cat: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_default_fee_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the dynamic fee schedule snapshotted into binary markets created
   * after the call. Bounded by `MAX_FEE_BPS` and the ramp/skew caps;
   * existing markets keep their schedule. A creator can pick a stricter
   * schedule through `create_market_with_fees`, never a looser one (its
   * `max_bps` is capped by this default's `max_bps`).
   */
  set_default_fee_schedule: ({schedule}: {schedule: FeeSchedule}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_categorical_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a categorical market with 2..=8 outcomes and seeds the pool.
   * `creator` becomes the sole LP and receives the leftover shares of the
   * likelier outcomes. `probs_bps` must have one entry per outcome with
   * every probability in `math::MIN_PROB_BPS..=math::MAX_PROB_BPS` and the
   * entries summing to exactly BPS.
   * 
   * Collateral, id space, pause switch, fee snapshot and `resolution_hash`
   * commitment are shared with `create_market`; the pool is the same FPMM
   * with the reserve-product invariant generalised to n outcomes (see
   * `math_categorical`). Per-market circuit breakers are price-based and
   * binary-only, so categorical markets are not snapshotted with them —
   * nor with a `FeeSchedule`: they always charge their flat `fee_bps`.
   */
  create_categorical_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, probs_bps}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, probs_bps: Array<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a set_protocol_fee_share_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call; existing markets keep the
   * split they snapshotted at creation.
   */
  set_protocol_fee_share_bps: ({share_bps}: {share_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, collateral, treasury, resolver, default_fee_bps, protocol_fee_share_bps}: {admin: string, collateral: string, treasury: string, resolver: string, default_fee_bps: u32, protocol_fee_share_bps: u32},
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
    return ContractClient.deploy({admin, collateral, treasury, resolver, default_fee_bps, protocol_fee_share_bps}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABIAAABHYGJ1eV92MmAgLyBgc2VsbF92MmAgY2FsbGVkIHdpdGggYGVudi5sZWRnZXIoKS50aW1lc3RhbXAoKSA+IGRlYWRsaW5lYC4AAAAAD0RlYWRsaW5lRXhwaXJlZAAAAAATAAAAQmBidXlfdjJgIC8gYHNlbGxfdjJgIGF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIHdvcnNlIHRoYW4gdGhlIGxpbWl0LgAAAAAAEkxpbWl0UHJpY2VFeGNlZWRlZAAAAAAAFAAAAMVBIHNpbmdsZSB0cmFkZSB3b3VsZCBtb3ZlIHRoZSBwcmljZSBtb3JlIHRoYW4gYG1heF9pbXBhY3RfYnBzYC4KKEJvdGggdGhpcyBhbmQgdGhlIGJhbmQgcmVqZWN0IHRoZSB3aG9sZSBpbnZvY2F0aW9uLCBzbyB0aGVpciBldmVudHMsCmlmIGFueSwgcm9sbCBiYWNrIHdpdGggaXQg4oCUIHNlZSB0aGUgbm90ZSBvbiBgQnJlYWtlckNvbmZpZ2AuKQAAAAAAABJQcmljZUltcGFjdFRvb0hpZ2gAAAAAABUAAAA4Q3VtdWxhdGl2ZSBzYW1lLWxlZGdlciBtb3ZlbWVudCB3b3VsZCBleGNlZWQgYGJhbmRfYnBzYC4AAAARUHJpY2VCYW5kRXhjZWVkZWQAAAAAAAAWAAAAQmBvdXRjb21lX2luZGV4YCBpcyBub3QgYSB2YWxpZCBvdXRjb21lIG9mIHRoaXMgY2F0ZWdvcmljYWwgbWFya2V0LgAAAAAAE0ludmFsaWRPdXRjb21lSW5kZXgAAAAAHA==",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAADGU25hcHNob3Qgb2YgdGhlIGZsYXQgZmVlIGF0IGNyZWF0aW9uIHNvIGxhdGVyIGNvbmZpZyBjaGFuZ2VzIG5ldmVyCm1vdmUgaXQuIENoYXJnZWQgYXMtaXMgYnkgY2F0ZWdvcmljYWwgbWFya2V0cyBhbmQgYnkgYmluYXJ5IG1hcmtldHMKd2l0aG91dCBhIGBGZWVTY2hlZHVsZWAgc2lkZSBlbnRyeSAobGVnYWN5IC8gZmxhdC1mZWUgbWFya2V0cykuAAAAAAAHZmVlX2JwcwAAAAAEAAAAJlRyYWRpbmcgZmVlcyB3YWl0aW5nIGZvciBgc3dlZXBfZmVlc2AuAAAAAAAMZmVlc19hY2NydWVkAAAACwAAADhDcmVhdG9yIGhhcyB3aXRoZHJhd24gdGhlIHBvb2wgcmVtYWluZGVyIGFmdGVyIGZpbmFsaXR5LgAAAApscF9jbGFpbWVkAAAAAAABAAAAKElQRlMgQ0lEIC8gVVJJIG9mIHRoZSBxdWVzdGlvbiBtZXRhZGF0YS4AAAAIbWV0YV91cmkAAAAQAAAAhnNoYTI1NiBvZiB0aGUgY2Fub25pY2FsIHF1ZXN0aW9uIEpTT04gc3RvcmVkIG9mZi1jaGFpbiAoSVBGUyksIHNvIGEKY2xpZW50IGNhbiBwcm92ZSB0aGUgdGV4dCBpdCBzaG93cyBpcyB0aGUgdGV4dCB0aGF0IHdhcyBjb21taXR0ZWQuAAAAAAANcXVlc3Rpb25faGFzaAAAAAAAA+4AAAAgAAAAAAAAAApyZXNlcnZlX25vAAAAAAALAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAABL0NvbW1pdG1lbnQgdG8gaG93IHRoaXMgbWFya2V0IHdpbGwgYmUgcmVzb2x2ZWQsIGZpeGVkIGF0IGNyZWF0aW9uIHNvCnRoZSBjcmVhdG9yIGNhbm5vdCBwaWNrIGZhdm9yYWJsZSByZXNvbHV0aW9uIHJ1bGVzIGFmdGVyIHNlZWluZwp0cmFkaW5nIGFjdGl2aXR5LiBUaGUgcmVzb2x2ZXIgY29udHJhY3QgdmVyaWZpZXMgYSByZXZlYWxlZCBzcGVjCmFnYWluc3QgdGhpcyBoYXNoIGJlZm9yZSBjb25maWd1cmluZyBpdHNlbGYgZm9yIHRoZSBtYXJrZXQuIFNlZQpgZG9jcy9hZHIvMDAwMS1yZXNvbHV0aW9uLWNvbW1pdG1lbnQubWRgLgAAAAAPcmVzb2x1dGlvbl9oYXNoAAAAA+4AAAAgAAAAQENvbXBsZXRlIHNldHMgaW4gZXhpc3RlbmNlID09IGNvbGxhdGVyYWwgbG9ja2VkIGZvciB0aGlzIG1hcmtldC4AAAALc2V0c19taW50ZWQAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADE1hcmtldFN0YXR1cw==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAFQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAADURlZmF1bHRGZWVCcHMAAAAAAAAAAAAAAAAAABNQcm90b2NvbEZlZVNoYXJlQnBzAAAAAAAAAAAAAAAADkRlZmF1bHRCcmVha2VyAAAAAAAAAAAAAAAAAAZQYXVzZWQAAAAAAAAAAAAAAAAABk5leHRJZAAAAAAAAQAAAAAAAAAGTWFya2V0AAAAAAABAAAABgAAAAEAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAYAAAATAAAAAQAAAAAAAAAIRmVlVGVybXMAAAABAAAABgAAAAEAAAAAAAAABkxwRmVlcwAAAAAAAQAAAAYAAAABAAAAAAAAAAdCcmVha2VyAAAAAAEAAAAGAAAAAQAAAAAAAAAEQmFuZAAAAAEAAAAGAAAAAQAAADpPbmx5IHdyaXR0ZW4gZm9yIGNhdGVnb3JpY2FsIG1hcmtldHM7IGFic2VudCBtZWFucyBiaW5hcnkuAAAAAAAES2luZAAAAAEAAAAGAAAAAQAAAAAAAAAJQ2F0TWFya2V0AAAAAAAAAQAAAAYAAAABAAAAAAAAAAtDYXRQb3NpdGlvbgAAAAACAAAABgAAABMAAAABAAAAckRpc3BsYXkgbWV0YWRhdGEgb2YgYSBzY2FsYXIgbWFya2V0LCB3cml0dGVuIGJ5CmBjcmVhdGVfc2NhbGFyX21hcmtldGA7IGFic2VudCBmb3IgYmluYXJ5IGFuZCBjYXRlZ29yaWNhbCBtYXJrZXRzLgAAAAAABlNjYWxhcgAAAAAAAQAAAAYAAAABAAAAgUR5bmFtaWMgZmVlIHNjaGVkdWxlIHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uOyBhYnNlbnQgZm9yIGxlZ2FjeSBhbmQKY2F0ZWdvcmljYWwgbWFya2V0cywgd2hpY2ggY2hhcmdlIHRoZSBmbGF0IGBNYXJrZXQ6OmZlZV9icHNgLgAAAAAAAAtGZWVTY2hlZHVsZQAAAAABAAAABgAAAAAAAACCSW5zdGFuY2Ugc3RvcmFnZSwgYnV0IGFwcGVuZGVkIGhlcmUgYW55d2F5OiB0aGUgWERSIHRhZyBpcyB0aGUKdmFyaWFudCBwb3NpdGlvbiwgc28gZXZlbiBpbnN0YW5jZSBrZXlzIG11c3Qgb25seSBldmVyIGJlIGFwcGVuZGVkLgAAAAAAEkRlZmF1bHRGZWVTY2hlZHVsZQAA",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAABQAAAZJTYW1lIHRyYWRlIGFzIGBUcmFkZWAgcGx1cyB0aGUgcmVhbGlzZWQgZmVlIHJhdGUuIE5ldyBldmVudCByYXRoZXIgdGhhbgphIG5ldyBmaWVsZCBzbyB0aGUgZXhpc3RpbmcgYFRyYWRlYCBYRFIgc3RheXMgc3RhYmxlIGZvciBpbmRleGVycyAodGhlCmBGZWVzU3dlcHRUb2AgY29udmVudGlvbik7IGJvdGggYXJlIGVtaXR0ZWQgb24gZXZlcnkgYmluYXJ5IHRyYWRlLgpgZmVlX2Jwc2AgaXMgdGhlIGVmZmVjdGl2ZSBkeW5hbWljIHJhdGUgYXBwbGllZCwgYWxyZWFkeSBzbmFwc2hvdHRlZAppbnRvIGBmZWVgIOKAlCBpbmRleGVycyBjYW4gcmVjb3ZlciBpdCBmcm9tIGBmZWUgLyBjb2xsYXRlcmFsYCBidXQgbm90CmV4YWN0bHksIGJlY2F1c2UgYGZlZWAgY2FycmllcyB0aGUgY2VpbGluZyByb3VuZGluZy4AAAAAAAAAAAAHVHJhZGVWMgAAAAABAAAACHRyYWRlX3YyAAAACgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAEAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAAAAAABmlzX2J1eQAAAAAAAQAAAAAAAAAAAAAACmNvbGxhdGVyYWwAAAAAAAsAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAAAAAANmZWUAAAAACwAAAAAAAAAAAAAAB2ZlZV9icHMAAAAABAAAAAAAAAAAAAAAC3Jlc2VydmVfeWVzAAAAAAsAAAAAAAAAAAAAAApyZXNlcnZlX25vAAAAAAALAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAahGZWUgZGVzdGluYXRpb24gYW5kIHNwbGl0LCBzbmFwc2hvdHRlZCBwZXIgbWFya2V0IGF0IGNyZWF0aW9uIGFzIGEgc2lkZQplbnRyeSAoYERhdGFLZXk6OkZlZVRlcm1zYCkgc28gYE1hcmtldGAncyBYRFIgc2hhcGUgbmV2ZXIgY2hhbmdlcy4KCk1hcmtldHMgY3JlYXRlZCBiZWZvcmUgdGhpcyBlbnRyeSBleGlzdGVkIGhhdmUgbm8gYEZlZVRlcm1zYCBhbmQga2VlcCB0aGUKbGVnYWN5IGJlaGF2aW91cjogYHN3ZWVwX2ZlZXNgIHBheXMgd2hhdGV2ZXIgYERhdGFLZXk6OlRyZWFzdXJ5YCBob2xkcyBhdApzd2VlcCB0aW1lLCB3aXRoIHRoZSBwcm90b2NvbCBrZWVwaW5nIDEwMCUgb2YgdGhlIGZlZS4gVGhhdCBmYWxsYmFjayBpcwpkb2N1bWVudGVkIGluIGBzd2VlcF9mZWVzYCBhbmQgbWFrZXMgdGhlIHVwZ3JhZGUgbWlncmF0aW9uLWZyZWUuAAAAAAAAAAhGZWVUZXJtcwAAAAIAAACGUHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIHRyYWRlIGZlZSBpbiBicHM7IHRoZSByZXN0IGlzIHRoZSBMUCdzLgowLi49QlBTLiBBdCBCUFMgKHRoZSBkZWZhdWx0KSB0aGUgc3BsaXQgaXMgZXhhY3RseSB0b2RheSdzIGJlaGF2aW91ci4AAAAAABJwcm90b2NvbF9zaGFyZV9icHMAAAAAAAQAAAB7V2hlcmUgdGhlIHByb3RvY29sJ3MgZmVlIHNoYXJlIGlzIHN3ZXB0LiBGcm96ZW4gYXQgY3JlYXRpb246IGxhdGVyCmBzZXRfdHJlYXN1cnlgIGNhbGxzIG5ldmVyIHJlZGlyZWN0IGZlZXMgYWxyZWFkeSBlYXJuZWQuAAAAAAlyZWNpcGllbnQAAAAAAAAT",
        "AAAAAQAAAAAAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAAAAAACbm8AAAAAAAsAAAAAAAAAA3llcwAAAAAL",
        "AAAABQAAAAAAAAAAAAAACENhdFRyYWRlAAAAAQAAAAljYXRfdHJhZGUAAAAAAAAIAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAQAAAAAAAAANb3V0Y29tZV9pbmRleAAAAAAAAAQAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAOVBvc3QtdHJhZGUgcmVzZXJ2ZXMsIHNhbWUgb3JkZXIgYXMgYENhdE1hcmtldDo6cmVzZXJ2ZXNgLgAAAAAAAAhyZXNlcnZlcwAAA+oAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACFJlZGVlbWVkAAAAAQAAAAhyZWRlZW1lZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAADNUZW1wb3JhcnkgKG9uZSBsZWRnZXIpIGJhbmQgcmVmZXJlbmNlIGZvciBhIG1hcmtldC4AAAAAAAAAAAlCYW5kU3RhdGUAAAAAAAACAAAAAAAAAApsZWRnZXJfc2VxAAAAAAAEAAAAAAAAAA1yZWZfcHJpY2VfYnBzAAAAAAAABA==",
        "AAAAAQAAANxDYXRlZ29yaWNhbCBtYXJrZXQgc3RhdGUuIFN0b3JlZCB1bmRlciBgRGF0YUtleTo6Q2F0TWFya2V0KHU2NClgLCBzaGFyaW5nCnRoZSBpZCBzcGFjZSB3aXRoIGJpbmFyeSBtYXJrZXRzIChgRGF0YUtleTo6TmV4dElkYCksIHNvIGBnZXRfbWFya2V0YCBvbgphIGNhdGVnb3JpY2FsIGlkIGlzIGBNYXJrZXROb3RGb3VuZGAgYW5kIGNhbGxlcnMgbXVzdCByZWFkIGBtYXJrZXRfa2luZGAuAAAAAAAAAAlDYXRNYXJrZXQAAAAAAAAMAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAAxmZWVzX2FjY3J1ZWQAAAALAAAAOENyZWF0b3IgaGFzIHdpdGhkcmF3biB0aGUgcG9vbCByZW1haW5kZXIgYWZ0ZXIgZmluYWxpdHkuAAAACmxwX2NsYWltZWQAAAAAAAEAAAAAAAAACG1ldGFfdXJpAAAAEAAAADpTYW1lIGNvbW1pdG1lbnQgc2NoZW1lIGFzIHRoZSBiaW5hcnkgYE1hcmtldGAgKHNlZSB0aGVyZSkuAAAAAAANcXVlc3Rpb25faGFzaAAAAAAAA+4AAAAgAAAAOE9uZSByZXNlcnZlIHBlciBvdXRjb21lOyBgbGVuKClgIGlzIHRoZSBvdXRjb21lIGNvdW50IG4uAAAACHJlc2VydmVzAAAD6gAAAAsAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAINDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuIEVhY2gKb3V0Y29tZSdzIHNoYXJlcyAocmVzZXJ2ZSArIGFsbCBob2xkZXIgYmFsYW5jZXMpIHN1bSB0byB0aGlzLgAAAAALc2V0c19taW50ZWQAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACUNhdFN0YXR1cwAAAA==",
        "AAAAAgAAAHtMaWZlY3ljbGUgb2YgYSBjYXRlZ29yaWNhbCBtYXJrZXQ6IHNhbWUgdGhyZWUgc3RhdGVzIGFzIGBNYXJrZXRTdGF0dXNgCndpdGggdGhlIHdpbm5pbmcgaW5kZXggaW5zdGVhZCBvZiBhIHR3by13YXkgb3V0Y29tZS4AAAAAAAAAAAlDYXRTdGF0dXMAAAAAAAADAAAAAAAAAAAAAAAET3BlbgAAAAEAAAAhRmluYWwuIFdpbm5pbmcgc2hhcmVzIHJlZGVlbSAxOjEuAAAAAAAACFJlc29sdmVkAAAAAQAAAAQAAAAAAAAAK0ludmFsaWQgbWFya2V0LiBFdmVyeSBzaGFyZSByZWRlZW1zIGF0IDEvbi4AAAAABFZvaWQ=",
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAAAgAAAQpXaGljaCBwb29sIGEgbWFya2V0IGlkIHJlZmVycyB0by4gQWJzZW50IGZvciBtYXJrZXRzIGNyZWF0ZWQgYmVmb3JlCmNhdGVnb3JpY2FsIG1hcmtldHMgZXhpc3RlZCwgaGVuY2UgYG1hcmtldF9raW5kYCByZXBvcnRzIGBCaW5hcnlgIGZvcgphIHN0b3JlZCBgTWFya2V0KHU2NClgIGFuZCBhIGBLaW5kYCBlbnRyeSBpcyBvbmx5IHdyaXR0ZW4gZm9yCmNhdGVnb3JpY2FsIGlkcyAod2hpY2ggc3RvcmUgYSBgQ2F0TWFya2V0YCBpbnN0ZWFkIG9mIGEgYE1hcmtldGApLgAAAAAAAAAAAApNYXJrZXRLaW5kAAAAAAACAAAAAAAAAAAAAAAGQmluYXJ5AAAAAAABAAAAJ091dGNvbWUgY291bnQsIDIuLj1NQVhfTUFSS0VUX09VVENPTUVTLgAAAAALQ2F0ZWdvcmljYWwAAAAAAQAAAAQ=",
        "AAAAAQAAAQ5EaXNwbGF5IG1ldGFkYXRhIG9mIGEgc2NhbGFyIG1hcmtldDogdGhlIGBbbG93ZXIsIHVwcGVyXWAgcmFuZ2Ugb2YgdGhlCmNvbW1pdHRlZCByZXNvbHV0aW9uIHNwZWMsIGluIHRoZSBmZWVkJ3MgcmF3IHVuaXRzLiBTdG9yZWQgdW5kZXIKYERhdGFLZXk6OlNjYWxhcih1NjQpYCBhdCBjcmVhdGlvbjsgdGhlIHJlc29sdmVyJ3MgcmV2ZWFsZWQgc3BlYyBpcyB0aGUKYXV0aG9yaXRhdGl2ZSBjb3B5LCB0aGlzIGVudHJ5IG9ubHkgdGVsbHMgVUlzIHdoYXQgdG8gZGlzcGxheS4AAAAAAAAAAAAKU2NhbGFyTWV0YQAAAAAAAgAAAAAAAAAFbG93ZXIAAAAAAAALAAAAAAAAAAV1cHBlcgAAAAAAAAs=",
        "AAAAAQAAAF5QZXItaG9sZGVyIGNhdGVnb3JpY2FsIHBvc2l0aW9uOiBvbmUgYmFsYW5jZSBwZXIgb3V0Y29tZSwgc2FtZSBvcmRlciBhcwpgQ2F0TWFya2V0OjpyZXNlcnZlc2AuAAAAAAAAAAAAC0NhdFBvc2l0aW9uAAAAAAEAAAAAAAAACGJhbGFuY2VzAAAD6gAAAAs=",
        "AAAAAQAAAzZEeW5hbWljIGZlZSBzY2hlZHVsZSwgc25hcHNob3R0ZWQgcGVyIGJpbmFyeSBtYXJrZXQgYXQgY3JlYXRpb24gYXMgYQpzaWRlIGVudHJ5IChgRGF0YUtleTo6RmVlU2NoZWR1bGVgKSBzbyBgTWFya2V0YCdzIFhEUiBzaGFwZSBuZXZlcgpjaGFuZ2VzLiBUaGUgZWZmZWN0aXZlIHJhdGUgb2YgYSB0cmFkZSBpcwpgbWF0aDo6ZWZmZWN0aXZlX2ZlZV9icHMoc2NoZWR1bGUsIG5vdywgY2xvc2VfdGltZSwgcl95ZXMsIHJfbm8pYDoKYSBiYXNlIHJhdGUgdGhhdCByYW1wcyB1cCB0b3dhcmRzIGBtYXhfYnBzYCBhcyBgY2xvc2VfdGltZWAgYXBwcm9hY2hlcwphbmQgZ3Jvd3Mgd2l0aCB0aGUgcG9vbCdzIGRpc3RhbmNlIGZyb20gNTAvNTAsIHByb3RlY3RpbmcgdGhlIHNpbmdsZSBMUApmcm9tIGluZm9ybWVkIGZsb3cgbmVhciBleHBpcnkgYW5kIGZyb20gb25lLXNpZGVkIHBvb2xzLgoKTWFya2V0cyBjcmVhdGVkIGJlZm9yZSB0aGlzIGV4aXN0ZWQgKGFuZCBjYXRlZ29yaWNhbCBtYXJrZXRzLCB3aGljaApzdGlsbCBjaGFyZ2UgdGhlaXIgZmxhdCBgTWFya2V0OjpmZWVfYnBzYCkgaGF2ZSBubyBgRmVlU2NoZWR1bGVgIGVudHJ5CmFuZCBrZWVwIGEgZmxhdCBmZWUuIFRoZSBzY2hlZHVsZSBpcyBpbW11dGFibGUgYWZ0ZXIgY3JlYXRpb247IG9ubHkKYHNldF9kZWZhdWx0X2ZlZV9zY2hlZHVsZWAgKHRoZSBkZWZhdWx0IGZvciAqbmV3KiBtYXJrZXRzKSBjYW4gY2hhbmdlLgpGaWVsZCBvcmRlciBpcyBwYXJ0IG9mIHRoZSBYRFIg4oCUIGtlZXAgYGJhc2VfYnBzYCwgYG1heF9icHNgLApgcmFtcF9zZWNzYCwgYHNrZXdfbXVsdF9icHNgIHN0YWJsZS4AAAAAAAAAAAALRmVlU2NoZWR1bGUAAAAABAAAACpGZWUgZmFyIGZyb20gY2xvc2Ugd2l0aCB0aGUgcG9vbCBhdCA1MC81MC4AAAAAAAhiYXNlX2JwcwAAAAQAAAAvSGFyZCBjZWlsaW5nIGZvciB0aGlzIG1hcmtldCwgYDw9IE1BWF9GRUVfQlBTYC4AAAAAB21heF9icHMAAAAABAAAAGNUaGUgdGltZSByYW1wIHN0YXJ0cyB0aGlzIG1hbnkgc2Vjb25kcyBiZWZvcmUgYGNsb3NlX3RpbWVgCigwID0gbm8gcmFtcCwgYDw9IG1hdGg6Ok1BWF9SQU1QX1NFQ1NgKS4AAAAACXJhbXBfc2VjcwAAAAAAAAYAAABWRXh0cmEgYnBzIHBlciAxXzAwMCBicHMgb2YgZGlzdGFuY2UgZnJvbSBhIDVfMDAwIHByaWNlCihgPD0gbWF0aDo6TUFYX1NLRVdfTVVMVF9CUFNgKS4AAAAAAA1za2V3X211bHRfYnBzAAAAAAAABA==",
        "AAAABQAAALFTYW1lIHN3ZWVwIGFzIGBGZWVzU3dlcHRgIHBsdXMgdGhlIGFjdHVhbCByZWNpcGllbnQuIE5ldyBldmVudCByYXRoZXIKdGhhbiBuZXcgZmllbGRzIHNvIHRoZSBleGlzdGluZyBgRmVlc1N3ZXB0YCBYRFIgc3RheXMgc3RhYmxlIGZvcgppbmRleGVyczsgYm90aCBhcmUgZW1pdHRlZCBvbiBldmVyeSBzd2VlcC4AAAAAAAAAAAAAC0ZlZXNTd2VwdFRvAAAAAAEAAAANZmVlc19zd2VwdF90bwAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAADE1hcmtldFN0YXR1cwAAAAQAAAAAAAAAQlRyYWRpbmcgYWxsb3dlZCB1bnRpbCBgY2xvc2VfdGltZWAsIHRoZW4gd2FpdGluZyBmb3IgdGhlIHJlc29sdmVyLgAAAAAABE9wZW4AAAABAAAAIUZpbmFsLiBXaW5uaW5nIHNoYXJlcyByZWRlZW0gMToxLgAAAAAAAAhSZXNvbHZlZAAAAAEAAAfQAAAAB091dGNvbWUAAAAAAAAAACtJbnZhbGlkIG1hcmtldC4gRXZlcnkgc2hhcmUgcmVkZWVtcyBhdCAwLjUuAAAAAARWb2lkAAAAAQAAAQdTY2FsYXIgKHJhbmdlKSBtYXJrZXQsIGZpbmFsOiBMT05HIHNoYXJlcyBwYXkgYHBheW91dF9sb25nX2JwcyAvCjEwXzAwMGAgYW5kIFNIT1JUIHNoYXJlcyB0aGUgY29tcGxlbWVudC4gQXBwZW5kZWQgbGFzdCBzbyBzdG9yZWQKYFJlc29sdmVkYC9gVm9pZGAgdmFsdWVzIGtlZXAgdGhlaXIgZW5jb2Rpbmc7IHJlYWRlcnMgY29tcGlsZWQKYWdhaW5zdCBvbGRlciBiaW5kaW5ncyBmYWlsIHRvIGRlY29kZSB0aGlzIG9uZSAoc2VlIHRoZSByZWxlYXNlIG5vdGUpLgAAAAAOUmVzb2x2ZWRTY2FsYXIAAAAAAAEAAAAE",
        "AAAAAQAAAMJQZXItbWFya2V0IGNpcmN1aXQgYnJlYWtlcnMsIHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uIGZyb20KYERhdGFLZXk6OkRlZmF1bHRCcmVha2VyYC4gMCBkaXNhYmxlcyBlYWNoIGNoZWNrLiBBIG1hcmtldCB3aXRob3V0IGEKYEJyZWFrZXJgIGVudHJ5IChjcmVhdGVkIGJlZm9yZSBicmVha2VycyBleGlzdGVkKSBpcyBuZXZlciBjaGVja2VkLgAAAAAAAAAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAgAAAERNYXhpbXVtIHxwb3N0LXByaWNlIC0gbGVkZ2VyLW9wZW4gcHJpY2V8IGN1bXVsYXRpdmUgbW92ZW1lbnQgaW4gYnBzLgAAAAhiYW5kX2JwcwAAAAQAAABATWF4aW11bSB8cG9zdC1wcmljZSAtIHByZS1wcmljZXwgYSBzaW5nbGUgdHJhZGUgbWF5IG1vdmUgaW4gYnBzLgAAAA5tYXhfaW1wYWN0X2JwcwAAAAAABA==",
        "AAAABQAAAAAAAAAAAAAADUxwRmVlc0NsYWltZWQAAAAAAAABAAAAD2xwX2ZlZXNfY2xhaW1lZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUxwVHJhbnNmZXJyZWQAAAAAAAABAAAADmxwX3RyYW5zZmVycmVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldFJlc29sdmVkAAAAAAABAAAAD21hcmtldF9yZXNvbHZlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAACFOb25lIG1lYW5zIHRoZSBtYXJrZXQgd2FzIHZvaWRlZC4AAAAAAAAHb3V0Y29tZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD1RyZWFzdXJ5Q2hhbmdlZAAAAAABAAAAEHRyZWFzdXJ5X2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEENhdE1hcmtldENyZWF0ZWQAAAABAAAAEmNhdF9tYXJrZXRfY3JlYXRlZAAAAAAABgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAAAAAAAtzZWVkX2Ftb3VudAAAAAALAAAAAAAAAEFSZXF1ZXN0ZWQgb3BlbmluZyBwcm9iYWJpbGl0aWVzLCBvbmUgcGVyIG91dGNvbWUsIHN1bW1pbmcgdG8gQlBTLgAAAAAAAAlwcm9ic19icHMAAAAAAAPqAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEUNhdE1hcmtldFJlc29sdmVkAAAAAAAAAQAAABNjYXRfbWFya2V0X3Jlc29sdmVkAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAIU5vbmUgbWVhbnMgdGhlIG1hcmtldCB3YXMgdm9pZGVkLgAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAD6AAAAAQAAAAAAAAAAg==",
        "AAAABQAAAIxQb3NpdGlvbnMgbW92ZWQgYmV0d2VlbiBob2xkZXJzLiBJbmRleGVycyB0aGF0IHRyYWNrIGJhbGFuY2VzIGZyb20KYFRyYWRlYC9gUmVkZWVtZWRgIG11c3QgYWxzbyBhcHBseSB0aGlzIGV2ZW50IChzZWUgZG9jcy9hcmNoaXRlY3R1cmUubWQpLgAAAAAAAAATUG9zaXRpb25UcmFuc2ZlcnJlZAAAAAABAAAAFHBvc2l0aW9uX3RyYW5zZmVycmVkAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFE1hcmtldFJlc29sdmVkU2NhbGFyAAAAAQAAABZtYXJrZXRfcmVzb2x2ZWRfc2NhbGFyAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAH9MT05HIHBheW91dCBwZXIgY29tcGxldGUgc2V0LCAwLi49QlBTOyB0aGUgU0hPUlQgbGVnIHBheXMgdGhlCmNvbXBsZW1lbnQuIGBNYXJrZXRSZXNvbHZlZGAgaXMgbmV2ZXIgZW1pdHRlZCBmb3Igc2NhbGFyIG1hcmtldHMuAAAAAA9wYXlvdXRfbG9uZ19icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFFBvb2xSZW1haW5kZXJDbGFpbWVkAAAAAQAAABZwb29sX3JlbWFpbmRlcl9jbGFpbWVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAADlQb29sIHJlbWFpbmRlciBwbHVzIGFueSBMUCBmZWVzIGRyYWluZWQgaW4gdGhlIHNhbWUgY2FsbC4AAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAF1Byb3RvY29sRmVlU2hhcmVDaGFuZ2VkAAAAAAEAAAAacHJvdG9jb2xfZmVlX3NoYXJlX2NoYW5nZWQAAAAAAAIAAAAAAAAAA29sZAAAAAAEAAAAAAAAAAAAAAADbmV3AAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAAPdTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4KCkxlZ2FjeSBlbnRyeXBvaW50OiBubyBkZWFkbGluZSBhbmQgbm8gbGltaXQgcHJpY2UsIHNvIGEgc2lnbmVkIGJvdW5kCmNhbiBleGVjdXRlIGF0IGFueSBsYXRlciB0aW1lLiBQcmVmZXIgYGJ1eV92MmAuAAAAAANidXkAAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAVZSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgoKTGVnYWN5IGVudHJ5cG9pbnQ6IG5vIGRlYWRsaW5lIGFuZCBubyBsaW1pdCBwcmljZS4gUHJlZmVyIGBzZWxsX3YyYC4AAAAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAdRgYnV5YCBwbHVzIGEgZGVhZGxpbmUgKGBlbnYubGVkZ2VyKCkudGltZXN0YW1wKClgIHNlY29uZHMg4oCUIG5ldHdvcmsKdGltZSwgbm90IHRoZSBjbGllbnQgY2xvY2spIGFuZCBhbiBhdmVyYWdlLXByaWNlIGxpbWl0CihgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUzsgMCA9IG5vIGxpbWl0KS4KClRoZSBhdmVyYWdlIHByaWNlIGluY2x1ZGVzIHRoZSBmZWUgKGBmZWVgIGlzIHBhcnQgb2YgYGNvbGxhdGVyYWxfaW5gKQphbmQsIGZvciBhIE5PIGJ1eSwgaXMgY29tcGFyZWQgYWdhaW5zdCB0aGUgTk8gcHJpY2UuIEJlY2F1c2UgdGhlCmRlYWRsaW5lIGNoZWNrIHJ1bnMgYmVmb3JlIGByZXF1aXJlX2F1dGhgLCBhbiBleHBpcmVkIHRyYW5zYWN0aW9uCmZhaWxzIGNoZWFwbHkuIEEgbGltaXQgYWJvdmUgQlBTIGNhbiBuZXZlciBwYXNzIGZvciBhIGJ1eSBhbmQgaXMKcmVqZWN0ZWQgYXMgaW52YWxpZC4AAAAGYnV5X3YyAAAAAAAHAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAQhDYXRlZ29yaWNhbC1tYXJrZXQgY291bnRlcnBhcnQgb2YgYGJ1eWA6IHNwZW5kIGBjb2xsYXRlcmFsX2luYCBvbgpgb3V0Y29tZV9pbmRleGAgc2hhcmVzLiBSZXR1cm5zIHNoYXJlcyByZWNlaXZlZDsgcmV2ZXJ0cyBpZiBmZXdlciB0aGFuCmBtaW5fc2hhcmVzX291dGAgd291bGQgYmUgcmVjZWl2ZWQuIE5vIHYyIChkZWFkbGluZS9saW1pdCkgdmFyaWFudAp5ZXQg4oCUIHNlZSB0aGUgY2F0ZWdvcmljYWwgbm90ZXMgaW4gYGRvY3MvYXJjaGl0ZWN0dXJlLm1kYC4AAAAHYnV5X2NhdAAAAAAFAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAADW91dGNvbWVfaW5kZXgAAAAAAAAEAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAWxgc2VsbGAgcGx1cyBhIGRlYWRsaW5lIChsZWRnZXIgdGltZXN0YW1wLCBzZWNvbmRzKSBhbmQgYSBtaW5pbXVtCmF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUykuCgpBIHplcm8gbGltaXQgaXMgdHJpdmlhbGx5IHNhdGlzZmllZCBmb3Igc2VsbHMg4oCUIHVubGlrZSBidXlzLCB3aGVyZSAwCm1lYW5zICJubyBsaW1pdCIg4oCUIGFuZCBhIGxpbWl0IGFib3ZlIEJQUyBjYW4gbmV2ZXIgcGFzcywgc28gbmVpdGhlcgpuZWVkcyBhIHNwZWNpYWwgY2FzZS4gVGhlIGF2ZXJhZ2UgaW5jbHVkZXMgdGhlIGZlZSwgd2hpY2ggdGhlIHRyYWRlcgpwYXlzIG91dCBvZiB0aGUgZ3Jvc3MuAAAAB3NlbGxfdjIAAAAABwAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAALhDYXRlZ29yaWNhbC1tYXJrZXQgY291bnRlcnBhcnQgb2YgYHNlbGxgOiByZWNlaXZlIGV4YWN0bHkKYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lX2luZGV4YCBzaGFyZXMuIFJldHVybnMgc2hhcmVzCnNvbGQ7IHJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuAAAACHNlbGxfY2F0AAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAAAAAAOY29sbGF0ZXJhbF9vdXQAAAAAAAsAAAAAAAAADW1heF9zaGFyZXNfaW4AAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAD9TcG90IHByaWNlIG9mIGBvdXRjb21lYCBpbiBicHMgKDAuLj0xMF8wMDApLiBZRVMgKyBOTyB+IDEwXzAwMC4AAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAH5TaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIHJpZ2h0IG5vdywgYXQgdGhlCmVmZmVjdGl2ZSAocG9zc2libHkgZHluYW1pYykgZmVlIGZvciB0aGlzIGxlZGdlcidzIHRpbWVzdGFtcC4AAAAAAAlxdW90ZV9idXkAAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=",
        "AAAAAAAAAIpTaGFyZXMgYSBgc2VsbGAgZm9yIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCB3b3VsZCBjb25zdW1lIHJpZ2h0IG5vdywKYXQgdGhlIGVmZmVjdGl2ZSAocG9zc2libHkgZHluYW1pYykgZmVlIGZvciB0aGlzIGxlZGdlcidzIHRpbWVzdGFtcC4AAAAAAApxdW90ZV9zZWxsAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAL5DYXRlZ29yaWNhbC1tYXJrZXQgY291bnRlcnBhcnQgb2YgYHJlZGVlbWAuIFdpbm5pbmcgYmFsYW5jZXMgcGF5IDE6MSwKYSB2b2lkIHBheXMgYGZsb29yKM6jIGJhbGFuY2VzIC8gbilgIOKAlCBib3RoIGZsb29yZWQsIHNvIHRoZSB0b3RhbCBwYWlkCmFjcm9zcyBhbGwgaG9sZGVycyBuZXZlciBleGNlZWRzIGBzZXRzX21pbnRlZGAuAAAAAAAKcmVkZWVtX2NhdAAAAAAAAgAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAASdBbnlvbmUgY2FuIG1vdmUgYWNjcnVlZCBwcm90b2NvbCBmZWVzIHRvIHRoZSBtYXJrZXQncyBmZWUgcmVjaXBpZW50LgoKU2VuZHMgdG8gdGhlIHJlY2lwaWVudCBzbmFwc2hvdHRlZCBpbiBgRmVlVGVybXNgIGF0IGNyZWF0aW9uLiBNYXJrZXRzCmNyZWF0ZWQgYmVmb3JlIGBGZWVUZXJtc2AgZXhpc3RlZCBoYXZlIG5vbmUgYW5kIGtlZXAgdGhlIGxlZ2FjeQpiZWhhdmlvdXI6IHRoZSBgRGF0YUtleTo6VHJlYXN1cnlgIG9mIHRoZSBtb21lbnQgb2YgdGhlIHN3ZWVwLgpXb3JrcyBmb3IgYm90aCBtYXJrZXQga2luZHMuAAAAAApzd2VlcF9mZWVzAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAPVUcnVlIHdoZW4gYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgYmUgcmVqZWN0ZWQgYnkgdGhlCm1hcmtldCdzIGJyZWFrZXJzIHJpZ2h0IG5vdy4gUmVhZC1vbmx5OiBuZXZlciB3cml0ZXMgYmFuZCBzdGF0ZSwgc28Kb24gYSBmcmVzaCBsZWRnZXIgdGhlIHJlZmVyZW5jZSBpcyB0YWtlbiBhcyB0aGUgY3VycmVudCBwcmljZSDigJQgdGhlCnNhbWUgdmFsdWUgYSBzdWJzZXF1ZW50IHJlYWwgdHJhZGUgd291bGQgdXNlLgAAAAAAAAp3b3VsZF90cmlwAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAAHFXaGV0aGVyIGEgbWFya2V0IGlkIGlzIGEgYmluYXJ5IChgTWFya2V0YCkgb3IgY2F0ZWdvcmljYWwKKGBDYXRNYXJrZXRgKSBtYXJrZXQuIGBNYXJrZXROb3RGb3VuZGAgZm9yIHVua25vd24gaWRzLgAAAAAAAAttYXJrZXRfa2luZAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAACk1hcmtldEtpbmQAAAAAAAM=",
        "AAAAAAAAAFlDYXRlZ29yaWNhbC1tYXJrZXQgY291bnRlcnBhcnQgb2YgYHJlc29sdmVgLiBTYW1lIHJlc29sdmVyLW9ubHkgZ2F0ZQphbmQgY2xvc2UtdGltZSBydWxlLgAAAAAAAAtyZXNvbHZlX2NhdAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAL9UcmFuc2ZlcnMgdGhlIHNpbmdsZSBMUCByb2xlICh0aGUgcmlnaHQgdG8gYGNsYWltX3Bvb2xfcmVtYWluZGVyYCBhbmQKYGNsYWltX2xwX2ZlZXNgKSB0byBgbmV3X2NyZWF0b3JgLiBPbmx5IHVudGlsIHRoZSByZW1haW5kZXIgaGFzIGJlZW4KY2xhaW1lZDsgYWZ0ZXIgdGhhdCB0aGUgcm9sZSBoYXMgbm8gcmVtYWluaW5nIHZhbHVlLgAAAAALdHJhbnNmZXJfbHAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAALtJbnZhbGlkIG9yIHVucmVzb2x2YWJsZSBtYXJrZXQuIEFsbG93ZWQgYW55IHRpbWUgYmVmb3JlIGZpbmFsaXR5LgpEaXNwYXRjaGVzIG9uIHRoZSBtYXJrZXQga2luZDogYmluYXJ5IG1hcmtldHMgZW1pdCBgTWFya2V0UmVzb2x2ZWRgCndpdGggYE5vbmVgLCBjYXRlZ29yaWNhbCBtYXJrZXRzIGBDYXRNYXJrZXRSZXNvbHZlZGAuAAAAAAt2b2lkX21hcmtldAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAINUaGUgbWFya2V0J3Mgc25hcHNob3R0ZWQgZHluYW1pYyBmZWUgc2NoZWR1bGUgKGBOb25lYCBmb3IgbGVnYWN5IGFuZApjYXRlZ29yaWNhbCBtYXJrZXRzLCB3aGljaCBjaGFyZ2UgdGhlIGZsYXQgYE1hcmtldDo6ZmVlX2Jwc2ApLgAAAAAMZmVlX3NjaGVkdWxlAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAD6AAAB9AAAAALRmVlU2NoZWR1bGUAAAAAAw==",
        "AAAAAAAAAAAAAAAMZ2V0X3Bvc2l0aW9uAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAB9AAAAAIUG9zaXRpb24=",
        "AAAAAAAAAAAAAAAMbWFya2V0X2NvdW50AAAAAAAAAAEAAAAG",
        "AAAAAAAAAS9TaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIGF0IGxlZGdlciB0aW1lc3RhbXAKYGF0X3RpbWVzdGFtcGAuIFVuZGVyIGEgcmFtcGluZyBzY2hlZHVsZSB0aGUgZmVlIHJpc2VzIHdpdGggdGltZSwgc28KY2xpZW50cyBleHBlY3RpbmcgaW5jbHVzaW9uIGxhdGVuY3kgY2FuIHF1b3RlIHRoZSB3b3JzdCBjYXNlIGhlcmUKKHNlZSBgZG9jcy9mcm9udGVuZC1pbnRlZ3JhdGlvbi5tZGApLiBObyBvdGhlciBzdGF0ZSBpcyBzaW11bGF0ZWQ6CnRoZSByZXNlcnZlcyBhcmUgdGhlIGN1cnJlbnQgb25lcy4AAAAADHF1b3RlX2J1eV9hdAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADGF0X3RpbWVzdGFtcAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAMc2V0X3Jlc29sdmVyAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAJtBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbCBhbmQgdGhlIGxlZ2FjeSBmYWxsYmFjayBpbgpgc3dlZXBfZmVlc2AuIE1hcmtldHMgd2l0aCBhIHNuYXBzaG90dGVkIGBGZWVUZXJtc2Aga2VlcCBwYXlpbmcgdGhlaXIKb3JpZ2luYWwgcmVjaXBpZW50LgAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQhSdW5zIGF0b21pY2FsbHkgYXQgZGVwbG95IHRpbWUsIHNvIG5vYm9keSBjYW4gZnJvbnQtcnVuIGluaXRpYWxpemF0aW9uLgpgcHJvdG9jb2xfZmVlX3NoYXJlX2Jwc2AgaXMgdGhlIGRlZmF1bHQgcHJvdG9jb2wvTFAgc3BsaXQgZm9yIG5ldwptYXJrZXRzOyAxMF8wMDAga2VlcHMgdGhlIHdob2xlIGZlZSB3aXRoIHRoZSBwcm90b2NvbCAocHJlLXVwZ3JhZGUKYmVoYXZpb3VyKS4gUGFzcyAwIHRvIGdpdmUgYWxsIGZlZXMgdG8gdGhlIG1hcmtldCBjcmVhdG9ycy4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAD2RlZmF1bHRfZmVlX2JwcwAAAAAEAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAA==",
        "AAAAAAAAALpUaGUgY3VycmVudCBsZWRnZXIncyBiYW5kIHJlZmVyZW5jZSwgaWYgYSBiYW5kIGNoZWNrIGhhcyBydW4gdGhpcwpsZWRnZXIuIGBOb25lYCBtZWFucyB0aGUgbmV4dCB0cmFkZSBzZXRzIHRoZSByZWZlcmVuY2UgKHRvIGl0cyBvd24KcHJlLXRyYWRlIHByaWNlLCB3aGljaCBlcXVhbHMgdGhlIGxlZGdlci1vcGVuIHByaWNlKS4AAAAAAA1icmVha2VyX3N0YXRlAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAD6AAAB9AAAAAJQmFuZFN0YXRlAAAAAAAAAw==",
        "AAAAAAAAAQtUaGUgY3JlYXRvciAodGhlIExQKSBjbGFpbXMgdGhlaXIgc2hhcmUgb2YgYWNjcnVlZCB0cmFkZSBmZWVzIGF0IGFueQp0aW1lLCBpbmNsdWRpbmcgYmVmb3JlIGZpbmFsaXR5LiBSZXR1cm5zIHRoZSBhbW91bnQgY2xhaW1lZCAoMCB3aGVuCm5vdGhpbmcgaXMgcGVuZGluZywgbWlycm9yaW5nIGBzd2VlcF9mZWVzYCkuIFdvcmtzIGZvciBib3RoIG1hcmtldApraW5kcyAodGhlIGZlZSBzaWRlLWVudHJpZXMgYXJlIGtleWVkIGJ5IHRoZSBzaGFyZWQgbWFya2V0IGlkKS4AAAAADWNsYWltX2xwX2ZlZXMAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAW5DcmVhdGVzIGEgbWFya2V0IGFuZCBzZWVkcyB0aGUgcG9vbC4gYGNyZWF0b3JgIGJlY29tZXMgdGhlIHNvbGUgTFAuCmBpbml0aWFsX3llc19icHNgIGluIFsxMDAsIDk5MDBdIHNldHMgdGhlIG9wZW5pbmcgWUVTIHByb2JhYmlsaXR5Owp0aGUgY3JlYXRvciByZWNlaXZlcyB0aGUgbGVmdG92ZXIgc2hhcmVzIG9mIHRoZSBsaWtlbGllciBvdXRjb21lLgpXaGVuIGEgZGVmYXVsdCBkeW5hbWljIGZlZSBzY2hlZHVsZSBpcyBzZXQgaXQgaXMgc25hcHNob3R0ZWQgZm9yCnRoaXMgbWFya2V0IChzZWUgYHNldF9kZWZhdWx0X2ZlZV9zY2hlZHVsZWApOyBvdGhlcndpc2UgdGhlIG1hcmtldApjaGFyZ2VzIHRoZSBmbGF0IGBEZWZhdWx0RmVlQnBzYC4AAAAAAA1jcmVhdGVfbWFya2V0AAAAAAAACAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAD1TaGFyZXMgYSBgYnV5X2NhdGAgb2YgYGNvbGxhdGVyYWxfaW5gIHdvdWxkIHJldHVybiByaWdodCBub3cuAAAAAAAADXF1b3RlX2J1eV9jYXQAAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAHpUaGUgbWFya2V0J3Mgc25hcHNob3R0ZWQgYnJlYWtlcnMgKGBOb25lYCBmb3IgbGVnYWN5IG1hcmtldHMgY3JlYXRlZApiZWZvcmUgYnJlYWtlcnMgZXhpc3RlZCDigJQgdGhvc2UgYXJlIG5ldmVyIGNoZWNrZWQpLgAAAAAADmJyZWFrZXJfY29uZmlnAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAPoAAAH0AAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAOZ2V0X2NhdF9tYXJrZXQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAJQ2F0TWFya2V0AAAAAAAAAw==",
        "AAAAAAAAAPNTcG90IHByaWNlcyBvZiBhbGwgb3V0Y29tZXMgaW4gYnBzLCBzYW1lIG9yZGVyIGFzIHRoZSByZXNlcnZlcy4gRWFjaApwcmljZSBpcyBmbG9vcmVkLCBzbyB0aGV5IHN1bSB0byBhdCBtb3N0IEJQUyBhbmQgYXQgbGVhc3QgQlBTIC0gbjsKY2xpZW50cyBzaG91bGQgdHJlYXQgdGhlIHNsYWNrIGFzIGRpc3BsYXkgcm91bmRpbmcsIG5ldmVyIGFzIGEKbWlzcHJpY2luZyAocHJpY2VzIGRvIG5vdCBlbnRlciB0cmFkZSBtYXRoKS4AAAAADmdldF9wcmljZXNfY2F0AAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAPqAAAABAAAAAM=",
        "AAAAAAAAAMhTY2FsYXItbWFya2V0IGNvdW50ZXJwYXJ0IG9mIGByZXNvbHZlYC4gYHBheW91dF9sb25nX2Jwc2AgaXMgdGhlCmZpbmFsIExPTkcgcGF5b3V0IGluIGJhc2lzIHBvaW50cyBvZiAxLjAgKDAuLj0xMF8wMDApOyB0aGUgU0hPUlQgc2lkZQpwYXlzIHRoZSBjb21wbGVtZW50LiBTYW1lIHJlc29sdmVyLW9ubHkgZ2F0ZSBhbmQgY2xvc2UtdGltZSBydWxlLgAAAA5yZXNvbHZlX3NjYWxhcgAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAPcGF5b3V0X2xvbmdfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAStUaGUgZmVlIGJwcyB0aGlzIGxlZGdlcidzIG5leHQgdHJhZGUgb24gYG1hcmtldF9pZGAgcGF5czogdGhlCmR5bmFtaWMgZWZmZWN0aXZlIGZlZSBmb3IgYmluYXJ5IG1hcmtldHMgd2l0aCBhIHNjaGVkdWxlLCB0aGUgZmxhdApzbmFwc2hvdCBmb3IgbGVnYWN5IGFuZCBjYXRlZ29yaWNhbCBtYXJrZXRzLiBVbmRlciBhIHJhbXBpbmcKc2NoZWR1bGUgdGhlIHZhbHVlIGNoYW5nZXMgd2l0aCB0aGUgbGVkZ2VyIHRpbWVzdGFtcDsgdXNlCmBxdW90ZV9idXlfYXRgIHRvIHByaWNlIGV4cGVjdGVkIGluY2x1c2lvbiBsYXRlbmN5LgAAAAAPY3VycmVudF9mZWVfYnBzAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAGJEaXNwbGF5IG1ldGFkYXRhICh0aGUgc3Rha2VkIHJhbmdlKSBvZiBhIHNjYWxhciBtYXJrZXQuIEFic2VudCBmb3IKYmluYXJ5IGFuZCBjYXRlZ29yaWNhbCBtYXJrZXRzLgAAAAAAD2dldF9zY2FsYXJfbWV0YQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAClNjYWxhck1ldGEAAAAAAAM=",
        "AAAAAAAAAIdBIGhvbGRlcidzIGNhdGVnb3JpY2FsIHBvc2l0aW9uLCB6ZXJvLWZpbGxlZCB0byB0aGUgbWFya2V0J3Mgb3V0Y29tZQpjb3VudCB3aGVuIHRoZXkgbmV2ZXIgdHJhZGVkLiBFcnJvcnMgaWYgdGhlIG1hcmtldCBkb2VzIG5vdCBleGlzdC4AAAAAEGdldF9jYXRfcG9zaXRpb24AAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAD6QAAB9AAAAALQ2F0UG9zaXRpb24AAAAAAw==",
        "AAAAAAAAADdNb3ZlcyBgYW1vdW50YCBzaGFyZXMgb2YgYG91dGNvbWVgIGZyb20gYGZyb21gIHRvIGB0b2AuAAAAABF0cmFuc2Zlcl9wb3NpdGlvbgAAAAAAAAUAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAOZTZXRzIHRoZSBicmVha2VyIGRlZmF1bHRzIGNvcGllZCBpbnRvIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbC4KYGJhbmRfYnBzIDwgbWF4X2ltcGFjdF9icHNgIChib3RoIG5vbi16ZXJvKSBpcyByZWplY3RlZDogYSBzaW5nbGUKdHJhZGUgdGhhdCBpcyBhbGxvd2VkIGJ5IHRoZSBpbXBhY3QgY2FwIGNvdWxkIHRoZW4gbmV2ZXIgZml0IGluc2lkZQp0aGUgYmFuZCwgbG9ja2luZyB0cmFkaW5nLgAAAAAAE3NldF9kZWZhdWx0X2JyZWFrZXIAAAAAAQAAAAAAAAAHYnJlYWtlcgAAAAfQAAAADUJyZWFrZXJDb25maWcAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHxDcmVhdG9yICh0aGUgTFApIHdpdGhkcmF3cyB3aGF0ZXZlciB0aGUgcG9vbCBzdGlsbCBob2xkcyBvbmNlIGZpbmFsLApwbHVzIGFueSB1bmNsYWltZWQgTFAgZmVlcy4gUmV0dXJucyB0aGUgdG90YWwgcGFpZCBvdXQuAAAAFGNsYWltX3Bvb2xfcmVtYWluZGVyAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAX5DcmVhdGVzIGEgc2NhbGFyIChyYW5nZSkgbWFya2V0OiB0aGUgYmluYXJ5IHBvb2wgd2l0aCBMT05HID0gWUVTIGFuZApTSE9SVCA9IE5PLCB3aG9zZSBmaW5hbCBzdGF0dXMgY2FycmllcyBhIGZyYWN0aW9uYWwgcGF5b3V0CihgTWFya2V0U3RhdHVzOjpSZXNvbHZlZFNjYWxhcmApIGluc3RlYWQgb2YgYSBzaWRlLiBFdmVyeXRoaW5nIGVsc2UKbWF0Y2hlcyBgY3JlYXRlX21hcmtldGA7IGBbbG93ZXIsIHVwcGVyXWAgaXMgZGlzcGxheSBtZXRhZGF0YSBzdG9yZWQKdW5kZXIgYERhdGFLZXk6OlNjYWxhcmAgKHRoZSBhdXRob3JpdGF0aXZlIHJhbmdlIGlzIGluc2lkZSB0aGUKYFJlc29sdXRpb25TcGVjYCBjb21taXR0ZWQgdGhyb3VnaCBgcmVzb2x1dGlvbl9oYXNoYCkuAAAAAAAUY3JlYXRlX3NjYWxhcl9tYXJrZXQAAAAKAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAPcmVzb2x1dGlvbl9oYXNoAAAAA+4AAAAgAAAAAAAAAAhtZXRhX3VyaQAAABAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAALc2VlZF9hbW91bnQAAAAACwAAAAAAAAAPaW5pdGlhbF95ZXNfYnBzAAAAAAQAAAAAAAAABWxvd2VyAAAAAAAACwAAAAAAAAAFdXBwZXIAAAAAAAALAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAO5gY3JlYXRlX21hcmtldGAgd2l0aCBhbiBleHBsaWNpdCBwZXItbWFya2V0IGBGZWVTY2hlZHVsZWAuIFZhbGlkYXRlZAphZ2FpbnN0IGBNQVhfRkVFX0JQU2AgYW5kIHRoZSBjdXJyZW50IGRlZmF1bHQgc2NoZWR1bGUncyBgbWF4X2Jwc2AKKGNyZWF0b3JzIGNhbiB1bmRlcmN1dCBwcm90b2NvbCBwb2xpY3ksIG5ldmVyIGV4Y2VlZCBpdCksIHRoZW4Kc25hcHNob3R0ZWQgZm9yIHRoaXMgbWFya2V0J3MgbGlmZXRpbWUuAAAAAAAXY3JlYXRlX21hcmtldF93aXRoX2ZlZXMAAAAACQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAhzY2hlZHVsZQAAB9AAAAALRmVlU2NoZWR1bGUAAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAItDYXRlZ29yaWNhbC1tYXJrZXQgY291bnRlcnBhcnQgb2YgYGNsYWltX3Bvb2xfcmVtYWluZGVyYDogdGhlIGNyZWF0b3IKKHRoZSBMUCkgd2l0aGRyYXdzIHRoZSBzZXR0bGVkIHBvb2wgdmFsdWUgcGx1cyBhbnkgdW5jbGFpbWVkIExQIGZlZXMuAAAAABhjbGFpbV9wb29sX3JlbWFpbmRlcl9jYXQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAUBTZXRzIHRoZSBkeW5hbWljIGZlZSBzY2hlZHVsZSBzbmFwc2hvdHRlZCBpbnRvIGJpbmFyeSBtYXJrZXRzIGNyZWF0ZWQKYWZ0ZXIgdGhlIGNhbGwuIEJvdW5kZWQgYnkgYE1BWF9GRUVfQlBTYCBhbmQgdGhlIHJhbXAvc2tldyBjYXBzOwpleGlzdGluZyBtYXJrZXRzIGtlZXAgdGhlaXIgc2NoZWR1bGUuIEEgY3JlYXRvciBjYW4gcGljayBhIHN0cmljdGVyCnNjaGVkdWxlIHRocm91Z2ggYGNyZWF0ZV9tYXJrZXRfd2l0aF9mZWVzYCwgbmV2ZXIgYSBsb29zZXIgb25lIChpdHMKYG1heF9icHNgIGlzIGNhcHBlZCBieSB0aGlzIGRlZmF1bHQncyBgbWF4X2Jwc2ApLgAAABhzZXRfZGVmYXVsdF9mZWVfc2NoZWR1bGUAAAABAAAAAAAAAAhzY2hlZHVsZQAAB9AAAAALRmVlU2NoZWR1bGUAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAtNDcmVhdGVzIGEgY2F0ZWdvcmljYWwgbWFya2V0IHdpdGggMi4uPTggb3V0Y29tZXMgYW5kIHNlZWRzIHRoZSBwb29sLgpgY3JlYXRvcmAgYmVjb21lcyB0aGUgc29sZSBMUCBhbmQgcmVjZWl2ZXMgdGhlIGxlZnRvdmVyIHNoYXJlcyBvZiB0aGUKbGlrZWxpZXIgb3V0Y29tZXMuIGBwcm9ic19icHNgIG11c3QgaGF2ZSBvbmUgZW50cnkgcGVyIG91dGNvbWUgd2l0aApldmVyeSBwcm9iYWJpbGl0eSBpbiBgbWF0aDo6TUlOX1BST0JfQlBTLi49bWF0aDo6TUFYX1BST0JfQlBTYCBhbmQgdGhlCmVudHJpZXMgc3VtbWluZyB0byBleGFjdGx5IEJQUy4KCkNvbGxhdGVyYWwsIGlkIHNwYWNlLCBwYXVzZSBzd2l0Y2gsIGZlZSBzbmFwc2hvdCBhbmQgYHJlc29sdXRpb25faGFzaGAKY29tbWl0bWVudCBhcmUgc2hhcmVkIHdpdGggYGNyZWF0ZV9tYXJrZXRgOyB0aGUgcG9vbCBpcyB0aGUgc2FtZSBGUE1NCndpdGggdGhlIHJlc2VydmUtcHJvZHVjdCBpbnZhcmlhbnQgZ2VuZXJhbGlzZWQgdG8gbiBvdXRjb21lcyAoc2VlCmBtYXRoX2NhdGVnb3JpY2FsYCkuIFBlci1tYXJrZXQgY2lyY3VpdCBicmVha2VycyBhcmUgcHJpY2UtYmFzZWQgYW5kCmJpbmFyeS1vbmx5LCBzbyBjYXRlZ29yaWNhbCBtYXJrZXRzIGFyZSBub3Qgc25hcHNob3R0ZWQgd2l0aCB0aGVtIOKAlApub3Igd2l0aCBhIGBGZWVTY2hlZHVsZWA6IHRoZXkgYWx3YXlzIGNoYXJnZSB0aGVpciBmbGF0IGBmZWVfYnBzYC4AAAAAGWNyZWF0ZV9jYXRlZ29yaWNhbF9tYXJrZXQAAAAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAPcmVzb2x1dGlvbl9oYXNoAAAAA+4AAAAgAAAAAAAAAAhtZXRhX3VyaQAAABAAAAAAAAAACGNhdGVnb3J5AAAH0AAAAAhDYXRlZ29yeQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAALc2VlZF9hbW91bnQAAAAACwAAAAAAAAAJcHJvYnNfYnBzAAAAAAAD6gAAAAQAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAGVBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZQpzcGxpdCB0aGV5IHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uLgAAAAAAABpzZXRfcHJvdG9jb2xfZmVlX3NoYXJlX2JwcwAAAAAAAQAAAAAAAAAJc2hhcmVfYnBzAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<i128>>,
        sell: this.txFromJSON<Result<i128>>,
        buy_v2: this.txFromJSON<Result<i128>>,
        redeem: this.txFromJSON<Result<i128>>,
        buy_cat: this.txFromJSON<Result<i128>>,
        resolve: this.txFromJSON<Result<void>>,
        sell_v2: this.txFromJSON<Result<i128>>,
        sell_cat: this.txFromJSON<Result<i128>>,
        get_price: this.txFromJSON<Result<u32>>,
        quote_buy: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<Config>>,
        get_market: this.txFromJSON<Result<Market>>,
        quote_sell: this.txFromJSON<Result<i128>>,
        redeem_cat: this.txFromJSON<Result<i128>>,
        set_paused: this.txFromJSON<Result<void>>,
        sweep_fees: this.txFromJSON<Result<i128>>,
        would_trip: this.txFromJSON<Result<boolean>>,
        market_kind: this.txFromJSON<Result<MarketKind>>,
        resolve_cat: this.txFromJSON<Result<void>>,
        transfer_lp: this.txFromJSON<Result<void>>,
        void_market: this.txFromJSON<Result<void>>,
        fee_schedule: this.txFromJSON<Result<Option<FeeSchedule>>>,
        get_position: this.txFromJSON<Position>,
        market_count: this.txFromJSON<u64>,
        quote_buy_at: this.txFromJSON<Result<i128>>,
        set_resolver: this.txFromJSON<Result<void>>,
        set_treasury: this.txFromJSON<Result<void>>,
        breaker_state: this.txFromJSON<Result<Option<BandState>>>,
        claim_lp_fees: this.txFromJSON<Result<i128>>,
        create_market: this.txFromJSON<Result<u64>>,
        quote_buy_cat: this.txFromJSON<Result<i128>>,
        breaker_config: this.txFromJSON<Result<Option<BreakerConfig>>>,
        get_cat_market: this.txFromJSON<Result<CatMarket>>,
        get_prices_cat: this.txFromJSON<Result<Array<u32>>>,
        resolve_scalar: this.txFromJSON<Result<void>>,
        current_fee_bps: this.txFromJSON<Result<u32>>,
        get_scalar_meta: this.txFromJSON<Result<ScalarMeta>>,
        get_cat_position: this.txFromJSON<Result<CatPosition>>,
        transfer_position: this.txFromJSON<Result<void>>,
        set_default_breaker: this.txFromJSON<Result<void>>,
        set_default_fee_bps: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        create_scalar_market: this.txFromJSON<Result<u64>>,
        create_market_with_fees: this.txFromJSON<Result<u64>>,
        claim_pool_remainder_cat: this.txFromJSON<Result<i128>>,
        set_default_fee_schedule: this.txFromJSON<Result<void>>,
        create_categorical_market: this.txFromJSON<Result<u64>>,
        set_protocol_fee_share_bps: this.txFromJSON<Result<void>>
  }
}