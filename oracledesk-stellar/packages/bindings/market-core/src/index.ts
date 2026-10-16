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
   * `observe` / `twap` asked for a time older than every surviving
   * observation of the market (the ring keeps the most recent 16).
   */
  23: {message:"ObservationTooOld"},
  /**
   * `finalize_market` called before the redemption deadline.
   */
  24: {message:"RedemptionWindowOpen"},
  /**
   * Market already closed by `finalize_market`; redemption is over.
   */
  25: {message:"RedemptionClosed"},
  /**
   * Legacy market created before `SettleState` existed: outstanding shares
   * cannot be reconstructed on-chain, so it has no deadline and cannot be
   * finalized (still fully redeemable).
   */
  26: {message:"NotSupported"},
  /**
   * A batch call carried no ids or more than `MAX_BATCH` of them.
   */
  27: {message:"BatchTooLarge"}
}



export interface Config {
  admin: string;
  collateral: string;
  default_fee_bps: u32;
  paused: boolean;
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
 * Snapshot of the fee at creation so later config changes never move it.
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

export type DataKey = {tag: "Admin", values: void} | {tag: "Collateral", values: void} | {tag: "Treasury", values: void} | {tag: "Resolver", values: void} | {tag: "DefaultFeeBps", values: void} | {tag: "Paused", values: void} | {tag: "NextId", values: void} | {tag: "DefaultRedeemHorizon", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Position", values: readonly [u64, string]} | {tag: "Settle", values: readonly [u64]} | {tag: "Oracle", values: readonly [u64]} | {tag: "Obs", values: readonly [u64, u32]};

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};


export interface Position {
  no: i128;
  yes: i128;
}



/**
 * One market's outcome inside a `BatchResult`, in request order.
 */
export interface BatchItem {
  market_id: u64;
  payout: i128;
  status: BatchStatus;
}


/**
 * Why a market in a batch call did not settle. `Duplicate` is reserved:
 * ids are validated strictly ascending first, so a duplicate is rejected
 * as `InvalidAmount` before the batch runs and never reaches a skip.
 */
export type SkipReason = {tag: "NotFound", values: void} | {tag: "NotFinal", values: void} | {tag: "NothingToRedeem", values: void} | {tag: "AlreadyClaimed", values: void} | {tag: "NotCreator", values: void} | {tag: "Duplicate", values: void};


/**
 * Result of `redeem_many` / `claim_pool_remainders`: `total` is the single
 * aggregated transfer, `items` has one entry per requested market in the
 * same order.
 */
export interface BatchResult {
  items: Array<BatchItem>;
  total: i128;
}

/**
 * Per-market result of a batch settlement.
 * 
 * This union stands in for the `Option<SkipReason>` sketched in the issue:
 * a `#[contracttype]` struct field of type `Option<CustomType>` does not
 * compile under the `testutils` feature (on for every `cargo test` build).
 * The derive emits an xdr conversion gated on `CustomType: Into<ScVal>`,
 * but `#[contracttype]` enums only derive `TryFrom`, and the missing impls
 * cannot be supplied from this crate: `From<Enum> for ScVal` collides with
 * the derive's own `TryFrom` through core's blanket impl (E0119), and
 * `TryFrom<&Option<Enum>> for ScVal` violates the orphan rule (E0117).
 * The union carries the same information and surfaces as a discriminated
 * union in the generated TS bindings.
 */
export type BatchStatus = {tag: "Settled", values: void} | {tag: "Skipped", values: readonly [SkipReason]};


/**
 * One point in the TWAP ring buffer. At most one per distinct timestamp.
 */
export interface Observation {
  /**
 * `OracleState::price_cumulative` as of `ts`.
 */
cumulative: i128;
  ts: u64;
}


/**
 * Per-market TWAP accumulator (issue #11). Lives in its own entry so the
 * `Market` XDR stays unchanged.
 * 
 * Semantics: at the start of every trade the price that held since the last
 * trade is folded into `price_cumulative` over the elapsed interval; the
 * post-trade price then becomes `last_price_bps` until the next trade. That
 * is the Uniswap-v2 model, and it is what makes manipulation expensive —
 * moving the average requires holding the price away from fair value across
 * one or more ledger boundaries, not just within a single transaction.
 * 
 * Overflow analysis: `last_price_bps <= 10_000` and each interval adds
 * `price * dt` seconds. A 100-year market lifetime accumulates at most
 * `10_000 * 3.2e9 ~ 3.2e13`; even a pathological `dt = u64::MAX` gives
 * `1.8e19 * 1e4 = 1.8e23`. `i128::MAX` is ~1.7e38, so there is no feasible
 * lifetime that overflows — and every step is `checked_*` anyway, so a
 * violation rejects the transaction instead of corrupting the accumulator.
 */
export interface OracleState {
  /**
 * YES price in bps as of the most recent trade.
 */
last_price_bps: u32;
  /**
 * Timestamp the accumulator was last advanced to (the timestamp of the
 * most recent trade). The last traded price holds from here onward.
 */
last_ts: u64;
  /**
 * Observations written so far, capped at `ORACLE_RING`.
 */
obs_count: u32;
  /**
 * Ring slot of the newest observation, in `0..ORACLE_RING`.
 */
obs_index: u32;
  /**
 * Running sum of `last_price_bps * seconds_elapsed` since creation.
 */
price_cumulative: i128;
}


/**
 * Per-market settlement bookkeeping (issue #14). Lives in its own entry so
 * the `Market` XDR stays unchanged.
 */
export interface SettleState {
  /**
 * `finalize_market` has swept the market's remaining balance; no
 * redemption or claim can ever pay out again.
 */
closed: boolean;
  /**
 * Timestamp of `resolve` / `void_market`; 0 while the market is Open.
 */
finalized_at: u64;
  /**
 * Redemption window, snapshotted at creation from the admin default.
 * `redeem_deadline = finalized_at + horizon_secs`.
 */
horizon_secs: u64;
  outstanding_no: i128;
  /**
 * Outcome shares held outside the pool (user positions), still
 * redeemable. `redeem` decrements the redeeming holder's shares on both
 * sides, so a losing-side redemption (payout 0) still clears here.
 */
outstanding_yes: i128;
  /**
 * Collateral already paid to holders and the LP (`redeem` +
 * `claim_pool_remainder` payouts); tracks what has left the market.
 */
paid_out: i128;
}

export type MarketStatus = {tag: "Open", values: void} | {tag: "Resolved", values: readonly [Outcome]} | {tag: "Void", values: void};





export interface Client {
  /**
   * Construct and simulate a buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spend `collateral_in` to buy `outcome` shares. Returns shares received.
   * Reverts if fewer than `min_shares_out` would be received.
   */
  buy: ({trader, market_id, outcome, collateral_in, min_shares_out}: {trader: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a sell transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Receive exactly `collateral_out` by selling `outcome` shares. Returns
   * shares sold. Reverts if more than `max_shares_in` would be needed.
   * Clients turn "sell N shares" into `collateral_out` off-chain
   * (see `math::calc_sell` docs) and add a slippage margin to `max_shares_in`.
   */
  sell: ({trader, market_id, outcome, collateral_out, max_shares_in}: {trader: string, market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a twap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Time-weighted average YES price in bps over the trailing
   * `window_secs`, floored. Rejects a zero window (`InvalidAmount`).
   * A window reaching before the oldest observation fails with
   * `ObservationTooOld`; a window extending past `close_time` keeps
   * averaging the final price, because the accumulator only moves when
   * trades are possible.
   */
  twap: ({market_id, window_secs}: {market_id: u64, window_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays out `holder`'s position for a final market and clears it.
   * Losing positions clear with a payout of 0.
   */
  redeem: ({holder, market_id}: {holder: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a observe transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cumulative YES-price-seconds as of `now - seconds_ago`.
   * 
   * The accumulator is piecewise linear in time (the price only moves when
   * a trade lands), so between observations the value is interpolated
   * along the chord, and times after the last trade extrapolate at the
   * last traded price. Fails with `ObservationTooOld` when `seconds_ago`
   * reaches before the oldest surviving observation (the ring keeps the
   * most recent 16), and with `NotSupported` for markets created before
   * the accumulator existed. A missing (archived) ring slot is skipped,
   * never a panic.
   */
  observe: ({market_id, seconds_ago}: {market_id: u64, seconds_ago: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a resolve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve: ({market_id, outcome}: {market_id: u64, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spot price of `outcome` in bps (0..=10_000). YES + NO ~ 10_000.
   */
  get_price: ({market_id, outcome}: {market_id: u64, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a max_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Largest accepted `market_ids` length for `redeem_many` /
   * `claim_pool_remainders`. Frontends should chunk work into strictly
   * ascending batches of at most this size (see
   * `docs/frontend-integration.md`).
   */
  max_batch: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a quote_buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Shares a `buy` of `collateral_in` would return right now.
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
   * Shares a `sell` for exactly `collateral_out` would consume right now.
   */
  quote_sell: ({market_id, outcome, collateral_out}: {market_id: u64, outcome: Outcome, collateral_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sweep_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anyone can move accrued fees to the treasury.
   */
  sweep_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems `holder`'s positions across up to `MAX_BATCH` final markets
   * with one collateral transfer. `market_ids` must be strictly ascending
   * (`InvalidAmount` otherwise; empty or over-cap is `BatchTooLarge`) so
   * the footprint is deterministic and duplicates are impossible.
   * 
   * Markets that cannot pay do not abort the batch; they come back in
   * `items` with a `SkipReason`. In particular an archived `Market` entry
   * is NOT `NotFound` — the transaction fails at footprint time and the
   * market must be restored first (simulation shows this before
   * submission). `holder.require_auth()` covers the whole batch: the
   * signed payload is the `market_ids` vector itself.
   */
  redeem_many: ({holder, market_ids}: {holder: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Invalid or unresolvable market. Allowed any time before finality.
   */
  void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_position: ({market_id, holder}: {market_id: u64, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Position>>

  /**
   * Construct and simulate a market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a set_resolver transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_resolver: ({resolver}: {resolver: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_treasury: ({treasury}: {treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Outstanding-share accounting for a market (issue #14).
   * `NotSupported` for markets created before this bookkeeping existed.
   */
  settle_state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettleState>>>

  /**
   * Construct and simulate a create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and seeds the pool. `creator` becomes the sole LP.
   * `initial_yes_bps` in [100, 9900] sets the opening YES probability;
   * the creator receives the leftover shares of the likelier outcome.
   */
  create_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a finalize_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless close-out of a final market after its redemption
   * deadline. Sweeps the market's entire remaining balance — value
   * reserved for shares never redeemed, an unclaimed LP remainder,
   * per-holder rounding dust and accrued fees — to the treasury, and
   * marks the market closed so nothing can ever pay out again.
   * 
   * The deadline is `redeem_deadline(market_id)` = `finalized_at +
   * horizon_secs`, the horizon being snapshotted at creation from the
   * admin default. Anyone who redeems before the deadline is paid the
   * exact `settle_value` they would have received without this call;
   * only shares still unredeemed at the deadline are forfeit, and their
   * value goes to the treasury rather than the LP so the LP cannot
   * profit from suppressing redemptions.
   * 
   * Returns the amount swept. The swept total is exactly the market's
   * contract balance: sets plus fees minus everything already paid out.
   */
  finalize_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Timestamp after which unredeemed shares are forfeit (see
   * `finalize_market`). `None` while the market is still Open — its
   * deadline is not known yet — and for legacy markets, which have no
   * deadline and cannot be finalized.
   */
  redeem_deadline: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a price_cumulative transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cumulative `price_bps * seconds` for YES since creation, extrapolated
   * to now: `observe(market_id, 0)`. Ready-made for consumers that store
   * their own checkpoints and compute TWAPs off-chain.
   */
  price_cumulative: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_default_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call; existing markets keep their fee.
   */
  set_default_fee_bps: ({fee_bps}: {fee_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creator (the LP) withdraws whatever the pool still holds once final.
   */
  claim_pool_remainder: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_pool_remainders transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the LP pool remainder for up to `MAX_BATCH` markets the
   * `creator` owns, with one collateral transfer. Same ordering and skip
   * semantics as `redeem_many`. A market closed by `finalize_market`
   * reports `AlreadyClaimed` — the sweep already took the remainder.
   */
  claim_pool_remainders: ({creator, market_ids}: {creator: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
   * Construct and simulate a set_default_redeem_horizon transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call; existing markets keep the
   * horizon snapshotted at their creation. Must be within
   * [180 days, 1825 days].
   */
  set_default_redeem_horizon: ({secs}: {secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, collateral, treasury, resolver, default_fee_bps}: {admin: string, collateral: string, treasury: string, resolver: string, default_fee_bps: u32},
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
    return ContractClient.deploy({admin, collateral, treasury, resolver, default_fee_bps}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABIAAAB9YG9ic2VydmVgIC8gYHR3YXBgIGFza2VkIGZvciBhIHRpbWUgb2xkZXIgdGhhbiBldmVyeSBzdXJ2aXZpbmcKb2JzZXJ2YXRpb24gb2YgdGhlIG1hcmtldCAodGhlIHJpbmcga2VlcHMgdGhlIG1vc3QgcmVjZW50IDE2KS4AAAAAAAART2JzZXJ2YXRpb25Ub29PbGQAAAAAAAAXAAAAOGBmaW5hbGl6ZV9tYXJrZXRgIGNhbGxlZCBiZWZvcmUgdGhlIHJlZGVtcHRpb24gZGVhZGxpbmUuAAAAFFJlZGVtcHRpb25XaW5kb3dPcGVuAAAAGAAAAD9NYXJrZXQgYWxyZWFkeSBjbG9zZWQgYnkgYGZpbmFsaXplX21hcmtldGA7IHJlZGVtcHRpb24gaXMgb3Zlci4AAAAAEFJlZGVtcHRpb25DbG9zZWQAAAAZAAAAsExlZ2FjeSBtYXJrZXQgY3JlYXRlZCBiZWZvcmUgYFNldHRsZVN0YXRlYCBleGlzdGVkOiBvdXRzdGFuZGluZyBzaGFyZXMKY2Fubm90IGJlIHJlY29uc3RydWN0ZWQgb24tY2hhaW4sIHNvIGl0IGhhcyBubyBkZWFkbGluZSBhbmQgY2Fubm90IGJlCmZpbmFsaXplZCAoc3RpbGwgZnVsbHkgcmVkZWVtYWJsZSkuAAAADE5vdFN1cHBvcnRlZAAAABoAAAA9QSBiYXRjaCBjYWxsIGNhcnJpZWQgbm8gaWRzIG9yIG1vcmUgdGhhbiBgTUFYX0JBVENIYCBvZiB0aGVtLgAAAAAAAA1CYXRjaFRvb0xhcmdlAAAAAAAAGw==",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAABGU25hcHNob3Qgb2YgdGhlIGZlZSBhdCBjcmVhdGlvbiBzbyBsYXRlciBjb25maWcgY2hhbmdlcyBuZXZlciBtb3ZlIGl0LgAAAAAAB2ZlZV9icHMAAAAABAAAACZUcmFkaW5nIGZlZXMgd2FpdGluZyBmb3IgYHN3ZWVwX2ZlZXNgLgAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAA4Q3JlYXRvciBoYXMgd2l0aGRyYXduIHRoZSBwb29sIHJlbWFpbmRlciBhZnRlciBmaW5hbGl0eS4AAAAKbHBfY2xhaW1lZAAAAAAAAQAAAChJUEZTIENJRCAvIFVSSSBvZiB0aGUgcXVlc3Rpb24gbWV0YWRhdGEuAAAACG1ldGFfdXJpAAAAEAAAAIZzaGEyNTYgb2YgdGhlIGNhbm9uaWNhbCBxdWVzdGlvbiBKU09OIHN0b3JlZCBvZmYtY2hhaW4gKElQRlMpLCBzbyBhCmNsaWVudCBjYW4gcHJvdmUgdGhlIHRleHQgaXQgc2hvd3MgaXMgdGhlIHRleHQgdGhhdCB3YXMgY29tbWl0dGVkLgAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAALcmVzZXJ2ZV95ZXMAAAAACwAAAS9Db21taXRtZW50IHRvIGhvdyB0aGlzIG1hcmtldCB3aWxsIGJlIHJlc29sdmVkLCBmaXhlZCBhdCBjcmVhdGlvbiBzbwp0aGUgY3JlYXRvciBjYW5ub3QgcGljayBmYXZvcmFibGUgcmVzb2x1dGlvbiBydWxlcyBhZnRlciBzZWVpbmcKdHJhZGluZyBhY3Rpdml0eS4gVGhlIHJlc29sdmVyIGNvbnRyYWN0IHZlcmlmaWVzIGEgcmV2ZWFsZWQgc3BlYwphZ2FpbnN0IHRoaXMgaGFzaCBiZWZvcmUgY29uZmlndXJpbmcgaXRzZWxmIGZvciB0aGUgbWFya2V0LiBTZWUKYGRvY3MvYWRyLzAwMDEtcmVzb2x1dGlvbi1jb21taXRtZW50Lm1kYC4AAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAEBDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuAAAAC3NldHNfbWludGVkAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxNYXJrZXRTdGF0dXM=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAADQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAADURlZmF1bHRGZWVCcHMAAAAAAAAAAAAAAAAAAAZQYXVzZWQAAAAAAAAAAAAAAAAABk5leHRJZAAAAAAAAAAAAAAAAAAURGVmYXVsdFJlZGVlbUhvcml6b24AAAABAAAAAAAAAAZNYXJrZXQAAAAAAAEAAAAGAAAAAQAAAAAAAAAIUG9zaXRpb24AAAACAAAABgAAABMAAAABAAAAAAAAAAZTZXR0bGUAAAAAAAEAAAAGAAAAAQAAAAAAAAAGT3JhY2xlAAAAAAABAAAABgAAAAEAAAAAAAAAA09icwAAAAACAAAABgAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAAAAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAAAAAACbm8AAAAAAAsAAAAAAAAAA3llcwAAAAAL",
        "AAAABQAAAAAAAAAAAAAACFJlZGVlbWVkAAAAAQAAAAhyZWRlZW1lZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAD5PbmUgbWFya2V0J3Mgb3V0Y29tZSBpbnNpZGUgYSBgQmF0Y2hSZXN1bHRgLCBpbiByZXF1ZXN0IG9yZGVyLgAAAAAAAAAAAAlCYXRjaEl0ZW0AAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAtCYXRjaFN0YXR1cwA=",
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAAAgAAAM9XaHkgYSBtYXJrZXQgaW4gYSBiYXRjaCBjYWxsIGRpZCBub3Qgc2V0dGxlLiBgRHVwbGljYXRlYCBpcyByZXNlcnZlZDoKaWRzIGFyZSB2YWxpZGF0ZWQgc3RyaWN0bHkgYXNjZW5kaW5nIGZpcnN0LCBzbyBhIGR1cGxpY2F0ZSBpcyByZWplY3RlZAphcyBgSW52YWxpZEFtb3VudGAgYmVmb3JlIHRoZSBiYXRjaCBydW5zIGFuZCBuZXZlciByZWFjaGVzIGEgc2tpcC4AAAAAAAAAAApTa2lwUmVhc29uAAAAAAAGAAAAAAAAAAAAAAAITm90Rm91bmQAAAAAAAAAAAAAAAhOb3RGaW5hbAAAAAAAAAAAAAAAD05vdGhpbmdUb1JlZGVlbQAAAAAAAAAAAAAAAA5BbHJlYWR5Q2xhaW1lZAAAAAAAAAAAAAAAAAAKTm90Q3JlYXRvcgAAAAAAAAAAAAAAAAAJRHVwbGljYXRlAAAA",
        "AAAAAQAAAJtSZXN1bHQgb2YgYHJlZGVlbV9tYW55YCAvIGBjbGFpbV9wb29sX3JlbWFpbmRlcnNgOiBgdG90YWxgIGlzIHRoZSBzaW5nbGUKYWdncmVnYXRlZCB0cmFuc2ZlciwgYGl0ZW1zYCBoYXMgb25lIGVudHJ5IHBlciByZXF1ZXN0ZWQgbWFya2V0IGluIHRoZQpzYW1lIG9yZGVyLgAAAAAAAAAAC0JhdGNoUmVzdWx0AAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAJQmF0Y2hJdGVtAAAAAAAAAAAAAAV0b3RhbAAAAAAAAAs=",
        "AAAAAgAAAs9QZXItbWFya2V0IHJlc3VsdCBvZiBhIGJhdGNoIHNldHRsZW1lbnQuCgpUaGlzIHVuaW9uIHN0YW5kcyBpbiBmb3IgdGhlIGBPcHRpb248U2tpcFJlYXNvbj5gIHNrZXRjaGVkIGluIHRoZSBpc3N1ZToKYSBgI1tjb250cmFjdHR5cGVdYCBzdHJ1Y3QgZmllbGQgb2YgdHlwZSBgT3B0aW9uPEN1c3RvbVR5cGU+YCBkb2VzIG5vdApjb21waWxlIHVuZGVyIHRoZSBgdGVzdHV0aWxzYCBmZWF0dXJlIChvbiBmb3IgZXZlcnkgYGNhcmdvIHRlc3RgIGJ1aWxkKS4KVGhlIGRlcml2ZSBlbWl0cyBhbiB4ZHIgY29udmVyc2lvbiBnYXRlZCBvbiBgQ3VzdG9tVHlwZTogSW50bzxTY1ZhbD5gLApidXQgYCNbY29udHJhY3R0eXBlXWAgZW51bXMgb25seSBkZXJpdmUgYFRyeUZyb21gLCBhbmQgdGhlIG1pc3NpbmcgaW1wbHMKY2Fubm90IGJlIHN1cHBsaWVkIGZyb20gdGhpcyBjcmF0ZTogYEZyb208RW51bT4gZm9yIFNjVmFsYCBjb2xsaWRlcyB3aXRoCnRoZSBkZXJpdmUncyBvd24gYFRyeUZyb21gIHRocm91Z2ggY29yZSdzIGJsYW5rZXQgaW1wbCAoRTAxMTkpLCBhbmQKYFRyeUZyb208Jk9wdGlvbjxFbnVtPj4gZm9yIFNjVmFsYCB2aW9sYXRlcyB0aGUgb3JwaGFuIHJ1bGUgKEUwMTE3KS4KVGhlIHVuaW9uIGNhcnJpZXMgdGhlIHNhbWUgaW5mb3JtYXRpb24gYW5kIHN1cmZhY2VzIGFzIGEgZGlzY3JpbWluYXRlZAp1bmlvbiBpbiB0aGUgZ2VuZXJhdGVkIFRTIGJpbmRpbmdzLgAAAAAAAAAAC0JhdGNoU3RhdHVzAAAAAAIAAAAAAAAAMFRoZSBtYXJrZXQgc2V0dGxlZCBhbmQgcGFpZCBgQmF0Y2hJdGVtOjpwYXlvdXRgLgAAAAdTZXR0bGVkAAAAAAEAAAAxVGhlIG1hcmtldCB3YXMgc2tpcHBlZDsgYEJhdGNoSXRlbTo6cGF5b3V0YCBpcyAwLgAAAAAAAAdTa2lwcGVkAAAAAAEAAAfQAAAAClNraXBSZWFzb24AAA==",
        "AAAAAQAAAEZPbmUgcG9pbnQgaW4gdGhlIFRXQVAgcmluZyBidWZmZXIuIEF0IG1vc3Qgb25lIHBlciBkaXN0aW5jdCB0aW1lc3RhbXAuAAAAAAAAAAAAC09ic2VydmF0aW9uAAAAAAIAAAArYE9yYWNsZVN0YXRlOjpwcmljZV9jdW11bGF0aXZlYCBhcyBvZiBgdHNgLgAAAAAKY3VtdWxhdGl2ZQAAAAAACwAAAAAAAAACdHMAAAAAAAY=",
        "AAAAAQAAA8FQZXItbWFya2V0IFRXQVAgYWNjdW11bGF0b3IgKGlzc3VlICMxMSkuIExpdmVzIGluIGl0cyBvd24gZW50cnkgc28gdGhlCmBNYXJrZXRgIFhEUiBzdGF5cyB1bmNoYW5nZWQuCgpTZW1hbnRpY3M6IGF0IHRoZSBzdGFydCBvZiBldmVyeSB0cmFkZSB0aGUgcHJpY2UgdGhhdCBoZWxkIHNpbmNlIHRoZSBsYXN0CnRyYWRlIGlzIGZvbGRlZCBpbnRvIGBwcmljZV9jdW11bGF0aXZlYCBvdmVyIHRoZSBlbGFwc2VkIGludGVydmFsOyB0aGUKcG9zdC10cmFkZSBwcmljZSB0aGVuIGJlY29tZXMgYGxhc3RfcHJpY2VfYnBzYCB1bnRpbCB0aGUgbmV4dCB0cmFkZS4gVGhhdAppcyB0aGUgVW5pc3dhcC12MiBtb2RlbCwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgbWFuaXB1bGF0aW9uIGV4cGVuc2l2ZSDigJQKbW92aW5nIHRoZSBhdmVyYWdlIHJlcXVpcmVzIGhvbGRpbmcgdGhlIHByaWNlIGF3YXkgZnJvbSBmYWlyIHZhbHVlIGFjcm9zcwpvbmUgb3IgbW9yZSBsZWRnZXIgYm91bmRhcmllcywgbm90IGp1c3Qgd2l0aGluIGEgc2luZ2xlIHRyYW5zYWN0aW9uLgoKT3ZlcmZsb3cgYW5hbHlzaXM6IGBsYXN0X3ByaWNlX2JwcyA8PSAxMF8wMDBgIGFuZCBlYWNoIGludGVydmFsIGFkZHMKYHByaWNlICogZHRgIHNlY29uZHMuIEEgMTAwLXllYXIgbWFya2V0IGxpZmV0aW1lIGFjY3VtdWxhdGVzIGF0IG1vc3QKYDEwXzAwMCAqIDMuMmU5IH4gMy4yZTEzYDsgZXZlbiBhIHBhdGhvbG9naWNhbCBgZHQgPSB1NjQ6Ok1BWGAgZ2l2ZXMKYDEuOGUxOSAqIDFlNCA9IDEuOGUyM2AuIGBpMTI4OjpNQVhgIGlzIH4xLjdlMzgsIHNvIHRoZXJlIGlzIG5vIGZlYXNpYmxlCmxpZmV0aW1lIHRoYXQgb3ZlcmZsb3dzIOKAlCBhbmQgZXZlcnkgc3RlcCBpcyBgY2hlY2tlZF8qYCBhbnl3YXksIHNvIGEKdmlvbGF0aW9uIHJlamVjdHMgdGhlIHRyYW5zYWN0aW9uIGluc3RlYWQgb2YgY29ycnVwdGluZyB0aGUgYWNjdW11bGF0b3IuAAAAAAAAAAAAAAtPcmFjbGVTdGF0ZQAAAAAFAAAALVlFUyBwcmljZSBpbiBicHMgYXMgb2YgdGhlIG1vc3QgcmVjZW50IHRyYWRlLgAAAAAAAA5sYXN0X3ByaWNlX2JwcwAAAAAABAAAAIZUaW1lc3RhbXAgdGhlIGFjY3VtdWxhdG9yIHdhcyBsYXN0IGFkdmFuY2VkIHRvICh0aGUgdGltZXN0YW1wIG9mIHRoZQptb3N0IHJlY2VudCB0cmFkZSkuIFRoZSBsYXN0IHRyYWRlZCBwcmljZSBob2xkcyBmcm9tIGhlcmUgb253YXJkLgAAAAAAB2xhc3RfdHMAAAAABgAAADVPYnNlcnZhdGlvbnMgd3JpdHRlbiBzbyBmYXIsIGNhcHBlZCBhdCBgT1JBQ0xFX1JJTkdgLgAAAAAAAAlvYnNfY291bnQAAAAAAAAEAAAAOVJpbmcgc2xvdCBvZiB0aGUgbmV3ZXN0IG9ic2VydmF0aW9uLCBpbiBgMC4uT1JBQ0xFX1JJTkdgLgAAAAAAAAlvYnNfaW5kZXgAAAAAAAAEAAAAQVJ1bm5pbmcgc3VtIG9mIGBsYXN0X3ByaWNlX2JwcyAqIHNlY29uZHNfZWxhcHNlZGAgc2luY2UgY3JlYXRpb24uAAAAAAAAEHByaWNlX2N1bXVsYXRpdmUAAAAL",
        "AAAAAQAAAGpQZXItbWFya2V0IHNldHRsZW1lbnQgYm9va2tlZXBpbmcgKGlzc3VlICMxNCkuIExpdmVzIGluIGl0cyBvd24gZW50cnkgc28KdGhlIGBNYXJrZXRgIFhEUiBzdGF5cyB1bmNoYW5nZWQuAAAAAAAAAAAAC1NldHRsZVN0YXRlAAAAAAYAAABqYGZpbmFsaXplX21hcmtldGAgaGFzIHN3ZXB0IHRoZSBtYXJrZXQncyByZW1haW5pbmcgYmFsYW5jZTsgbm8KcmVkZW1wdGlvbiBvciBjbGFpbSBjYW4gZXZlciBwYXkgb3V0IGFnYWluLgAAAAAABmNsb3NlZAAAAAAAAQAAAENUaW1lc3RhbXAgb2YgYHJlc29sdmVgIC8gYHZvaWRfbWFya2V0YDsgMCB3aGlsZSB0aGUgbWFya2V0IGlzIE9wZW4uAAAAAAxmaW5hbGl6ZWRfYXQAAAAGAAAAc1JlZGVtcHRpb24gd2luZG93LCBzbmFwc2hvdHRlZCBhdCBjcmVhdGlvbiBmcm9tIHRoZSBhZG1pbiBkZWZhdWx0LgpgcmVkZWVtX2RlYWRsaW5lID0gZmluYWxpemVkX2F0ICsgaG9yaXpvbl9zZWNzYC4AAAAADGhvcml6b25fc2VjcwAAAAYAAAAAAAAADm91dHN0YW5kaW5nX25vAAAAAAALAAAAw091dGNvbWUgc2hhcmVzIGhlbGQgb3V0c2lkZSB0aGUgcG9vbCAodXNlciBwb3NpdGlvbnMpLCBzdGlsbApyZWRlZW1hYmxlLiBgcmVkZWVtYCBkZWNyZW1lbnRzIHRoZSByZWRlZW1pbmcgaG9sZGVyJ3Mgc2hhcmVzIG9uIGJvdGgKc2lkZXMsIHNvIGEgbG9zaW5nLXNpZGUgcmVkZW1wdGlvbiAocGF5b3V0IDApIHN0aWxsIGNsZWFycyBoZXJlLgAAAAAPb3V0c3RhbmRpbmdfeWVzAAAAAAsAAAB7Q29sbGF0ZXJhbCBhbHJlYWR5IHBhaWQgdG8gaG9sZGVycyBhbmQgdGhlIExQIChgcmVkZWVtYCArCmBjbGFpbV9wb29sX3JlbWFpbmRlcmAgcGF5b3V0cyk7IHRyYWNrcyB3aGF0IGhhcyBsZWZ0IHRoZSBtYXJrZXQuAAAAAAhwYWlkX291dAAAAAs=",
        "AAAAAgAAAAAAAAAAAAAADE1hcmtldFN0YXR1cwAAAAMAAAAAAAAAQlRyYWRpbmcgYWxsb3dlZCB1bnRpbCBgY2xvc2VfdGltZWAsIHRoZW4gd2FpdGluZyBmb3IgdGhlIHJlc29sdmVyLgAAAAAABE9wZW4AAAABAAAAIUZpbmFsLiBXaW5uaW5nIHNoYXJlcyByZWRlZW0gMToxLgAAAAAAAAhSZXNvbHZlZAAAAAEAAAfQAAAAB091dGNvbWUAAAAAAAAAACtJbnZhbGlkIG1hcmtldC4gRXZlcnkgc2hhcmUgcmVkZWVtcyBhdCAwLjUuAAAAAARWb2lk",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldFJlc29sdmVkAAAAAAABAAAAD21hcmtldF9yZXNvbHZlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAACFOb25lIG1lYW5zIHRoZSBtYXJrZXQgd2FzIHZvaWRlZC4AAAAAAAAHb3V0Y29tZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD01hcmtldEZpbmFsaXplZAAAAAABAAAAEG1hcmtldF9maW5hbGl6ZWQAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAHFFdmVyeXRoaW5nIHN3ZXB0IHRvIHRoZSB0cmVhc3VyeTogZXhwaXJlZCB1c2VyIGNsYWltcywgYW4gdW5jbGFpbWVkCkxQIHJlbWFpbmRlciwgcm91bmRpbmcgZHVzdCBhbmQgYWNjcnVlZCBmZWVzLgAAAAAAAAVzd2VwdAAAAAAAAAsAAAAAAAAAQFRoZSBwYXJ0IG9mIGBzd2VwdGAgdGhhdCB3YXMgcmVzZXJ2ZWQgZm9yIHNoYXJlcyBuZXZlciByZWRlZW1lZC4AAAAOdW5jbGFpbWVkX3VzZXIAAAAAAAsAAAAAAAAAQ1JvdW5kaW5nIGxlZnQgb3ZlciBhZnRlciBwZXItaG9sZGVyIHZvaWQgZmxvb3JzIHdlcmUgYWNjb3VudGVkIGZvci4AAAAABGR1c3QAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFFBvb2xSZW1haW5kZXJDbGFpbWVkAAAAAQAAABZwb29sX3JlbWFpbmRlcl9jbGFpbWVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAAAAAAAIFTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4AAAAAAAADYnV5AAAAAAUAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAARBSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAUxUaW1lLXdlaWdodGVkIGF2ZXJhZ2UgWUVTIHByaWNlIGluIGJwcyBvdmVyIHRoZSB0cmFpbGluZwpgd2luZG93X3NlY3NgLCBmbG9vcmVkLiBSZWplY3RzIGEgemVybyB3aW5kb3cgKGBJbnZhbGlkQW1vdW50YCkuCkEgd2luZG93IHJlYWNoaW5nIGJlZm9yZSB0aGUgb2xkZXN0IG9ic2VydmF0aW9uIGZhaWxzIHdpdGgKYE9ic2VydmF0aW9uVG9vT2xkYDsgYSB3aW5kb3cgZXh0ZW5kaW5nIHBhc3QgYGNsb3NlX3RpbWVgIGtlZXBzCmF2ZXJhZ2luZyB0aGUgZmluYWwgcHJpY2UsIGJlY2F1c2UgdGhlIGFjY3VtdWxhdG9yIG9ubHkgbW92ZXMgd2hlbgp0cmFkZXMgYXJlIHBvc3NpYmxlLgAAAAR0d2FwAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALd2luZG93X3NlY3MAAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAiRDdW11bGF0aXZlIFlFUy1wcmljZS1zZWNvbmRzIGFzIG9mIGBub3cgLSBzZWNvbmRzX2Fnb2AuCgpUaGUgYWNjdW11bGF0b3IgaXMgcGllY2V3aXNlIGxpbmVhciBpbiB0aW1lICh0aGUgcHJpY2Ugb25seSBtb3ZlcyB3aGVuCmEgdHJhZGUgbGFuZHMpLCBzbyBiZXR3ZWVuIG9ic2VydmF0aW9ucyB0aGUgdmFsdWUgaXMgaW50ZXJwb2xhdGVkCmFsb25nIHRoZSBjaG9yZCwgYW5kIHRpbWVzIGFmdGVyIHRoZSBsYXN0IHRyYWRlIGV4dHJhcG9sYXRlIGF0IHRoZQpsYXN0IHRyYWRlZCBwcmljZS4gRmFpbHMgd2l0aCBgT2JzZXJ2YXRpb25Ub29PbGRgIHdoZW4gYHNlY29uZHNfYWdvYApyZWFjaGVzIGJlZm9yZSB0aGUgb2xkZXN0IHN1cnZpdmluZyBvYnNlcnZhdGlvbiAodGhlIHJpbmcga2VlcHMgdGhlCm1vc3QgcmVjZW50IDE2KSwgYW5kIHdpdGggYE5vdFN1cHBvcnRlZGAgZm9yIG1hcmtldHMgY3JlYXRlZCBiZWZvcmUKdGhlIGFjY3VtdWxhdG9yIGV4aXN0ZWQuIEEgbWlzc2luZyAoYXJjaGl2ZWQpIHJpbmcgc2xvdCBpcyBza2lwcGVkLApuZXZlciBhIHBhbmljLgAAAAdvYnNlcnZlAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAC3NlY29uZHNfYWdvAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAD9TcG90IHByaWNlIG9mIGBvdXRjb21lYCBpbiBicHMgKDAuLj0xMF8wMDApLiBZRVMgKyBOTyB+IDEwXzAwMC4AAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAMhMYXJnZXN0IGFjY2VwdGVkIGBtYXJrZXRfaWRzYCBsZW5ndGggZm9yIGByZWRlZW1fbWFueWAgLwpgY2xhaW1fcG9vbF9yZW1haW5kZXJzYC4gRnJvbnRlbmRzIHNob3VsZCBjaHVuayB3b3JrIGludG8gc3RyaWN0bHkKYXNjZW5kaW5nIGJhdGNoZXMgb2YgYXQgbW9zdCB0aGlzIHNpemUgKHNlZQpgZG9jcy9mcm9udGVuZC1pbnRlZ3JhdGlvbi5tZGApLgAAAAltYXhfYmF0Y2gAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADlTaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIHJpZ2h0IG5vdy4AAAAAAAAJcXVvdGVfYnV5AAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=",
        "AAAAAAAAAEVTaGFyZXMgYSBgc2VsbGAgZm9yIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCB3b3VsZCBjb25zdW1lIHJpZ2h0IG5vdy4AAAAAAAAKcXVvdGVfc2VsbAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAC1BbnlvbmUgY2FuIG1vdmUgYWNjcnVlZCBmZWVzIHRvIHRoZSB0cmVhc3VyeS4AAAAAAAAKc3dlZXBfZmVlcwAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAopSZWRlZW1zIGBob2xkZXJgJ3MgcG9zaXRpb25zIGFjcm9zcyB1cCB0byBgTUFYX0JBVENIYCBmaW5hbCBtYXJrZXRzCndpdGggb25lIGNvbGxhdGVyYWwgdHJhbnNmZXIuIGBtYXJrZXRfaWRzYCBtdXN0IGJlIHN0cmljdGx5IGFzY2VuZGluZwooYEludmFsaWRBbW91bnRgIG90aGVyd2lzZTsgZW1wdHkgb3Igb3Zlci1jYXAgaXMgYEJhdGNoVG9vTGFyZ2VgKSBzbwp0aGUgZm9vdHByaW50IGlzIGRldGVybWluaXN0aWMgYW5kIGR1cGxpY2F0ZXMgYXJlIGltcG9zc2libGUuCgpNYXJrZXRzIHRoYXQgY2Fubm90IHBheSBkbyBub3QgYWJvcnQgdGhlIGJhdGNoOyB0aGV5IGNvbWUgYmFjayBpbgpgaXRlbXNgIHdpdGggYSBgU2tpcFJlYXNvbmAuIEluIHBhcnRpY3VsYXIgYW4gYXJjaGl2ZWQgYE1hcmtldGAgZW50cnkKaXMgTk9UIGBOb3RGb3VuZGAg4oCUIHRoZSB0cmFuc2FjdGlvbiBmYWlscyBhdCBmb290cHJpbnQgdGltZSBhbmQgdGhlCm1hcmtldCBtdXN0IGJlIHJlc3RvcmVkIGZpcnN0IChzaW11bGF0aW9uIHNob3dzIHRoaXMgYmVmb3JlCnN1Ym1pc3Npb24pLiBgaG9sZGVyLnJlcXVpcmVfYXV0aCgpYCBjb3ZlcnMgdGhlIHdob2xlIGJhdGNoOiB0aGUKc2lnbmVkIHBheWxvYWQgaXMgdGhlIGBtYXJrZXRfaWRzYCB2ZWN0b3IgaXRzZWxmLgAAAAAAC3JlZGVlbV9tYW55AAAAAAIAAAAAAAAABmhvbGRlcgAAAAAAEwAAAAAAAAAKbWFya2V0X2lkcwAAAAAD6gAAAAYAAAABAAAD6QAAB9AAAAALQmF0Y2hSZXN1bHQAAAAAAw==",
        "AAAAAAAAAEFJbnZhbGlkIG9yIHVucmVzb2x2YWJsZSBtYXJrZXQuIEFsbG93ZWQgYW55IHRpbWUgYmVmb3JlIGZpbmFsaXR5LgAAAAAAAAt2b2lkX21hcmtldAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMZ2V0X3Bvc2l0aW9uAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAB9AAAAAIUG9zaXRpb24=",
        "AAAAAAAAAAAAAAAMbWFya2V0X2NvdW50AAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMc2V0X3Jlc29sdmVyAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHpPdXRzdGFuZGluZy1zaGFyZSBhY2NvdW50aW5nIGZvciBhIG1hcmtldCAoaXNzdWUgIzE0KS4KYE5vdFN1cHBvcnRlZGAgZm9yIG1hcmtldHMgY3JlYXRlZCBiZWZvcmUgdGhpcyBib29ra2VlcGluZyBleGlzdGVkLgAAAAAADHNldHRsZV9zdGF0ZQAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAALU2V0dGxlU3RhdGUAAAAAAw==",
        "AAAAAAAAAEdSdW5zIGF0b21pY2FsbHkgYXQgZGVwbG95IHRpbWUsIHNvIG5vYm9keSBjYW4gZnJvbnQtcnVuIGluaXRpYWxpemF0aW9uLgAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAUAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAD2RlZmF1bHRfZmVlX2JwcwAAAAAEAAAAAA==",
        "AAAAAAAAAMhDcmVhdGVzIGEgbWFya2V0IGFuZCBzZWVkcyB0aGUgcG9vbC4gYGNyZWF0b3JgIGJlY29tZXMgdGhlIHNvbGUgTFAuCmBpbml0aWFsX3llc19icHNgIGluIFsxMDAsIDk5MDBdIHNldHMgdGhlIG9wZW5pbmcgWUVTIHByb2JhYmlsaXR5Owp0aGUgY3JlYXRvciByZWNlaXZlcyB0aGUgbGVmdG92ZXIgc2hhcmVzIG9mIHRoZSBsaWtlbGllciBvdXRjb21lLgAAAA1jcmVhdGVfbWFya2V0AAAAAAAACAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAA3FQZXJtaXNzaW9ubGVzcyBjbG9zZS1vdXQgb2YgYSBmaW5hbCBtYXJrZXQgYWZ0ZXIgaXRzIHJlZGVtcHRpb24KZGVhZGxpbmUuIFN3ZWVwcyB0aGUgbWFya2V0J3MgZW50aXJlIHJlbWFpbmluZyBiYWxhbmNlIOKAlCB2YWx1ZQpyZXNlcnZlZCBmb3Igc2hhcmVzIG5ldmVyIHJlZGVlbWVkLCBhbiB1bmNsYWltZWQgTFAgcmVtYWluZGVyLApwZXItaG9sZGVyIHJvdW5kaW5nIGR1c3QgYW5kIGFjY3J1ZWQgZmVlcyDigJQgdG8gdGhlIHRyZWFzdXJ5LCBhbmQKbWFya3MgdGhlIG1hcmtldCBjbG9zZWQgc28gbm90aGluZyBjYW4gZXZlciBwYXkgb3V0IGFnYWluLgoKVGhlIGRlYWRsaW5lIGlzIGByZWRlZW1fZGVhZGxpbmUobWFya2V0X2lkKWAgPSBgZmluYWxpemVkX2F0ICsKaG9yaXpvbl9zZWNzYCwgdGhlIGhvcml6b24gYmVpbmcgc25hcHNob3R0ZWQgYXQgY3JlYXRpb24gZnJvbSB0aGUKYWRtaW4gZGVmYXVsdC4gQW55b25lIHdobyByZWRlZW1zIGJlZm9yZSB0aGUgZGVhZGxpbmUgaXMgcGFpZCB0aGUKZXhhY3QgYHNldHRsZV92YWx1ZWAgdGhleSB3b3VsZCBoYXZlIHJlY2VpdmVkIHdpdGhvdXQgdGhpcyBjYWxsOwpvbmx5IHNoYXJlcyBzdGlsbCB1bnJlZGVlbWVkIGF0IHRoZSBkZWFkbGluZSBhcmUgZm9yZmVpdCwgYW5kIHRoZWlyCnZhbHVlIGdvZXMgdG8gdGhlIHRyZWFzdXJ5IHJhdGhlciB0aGFuIHRoZSBMUCBzbyB0aGUgTFAgY2Fubm90CnByb2ZpdCBmcm9tIHN1cHByZXNzaW5nIHJlZGVtcHRpb25zLgoKUmV0dXJucyB0aGUgYW1vdW50IHN3ZXB0LiBUaGUgc3dlcHQgdG90YWwgaXMgZXhhY3RseSB0aGUgbWFya2V0J3MKY29udHJhY3QgYmFsYW5jZTogc2V0cyBwbHVzIGZlZXMgbWludXMgZXZlcnl0aGluZyBhbHJlYWR5IHBhaWQgb3V0LgAAAAAAAA9maW5hbGl6ZV9tYXJrZXQAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAOBUaW1lc3RhbXAgYWZ0ZXIgd2hpY2ggdW5yZWRlZW1lZCBzaGFyZXMgYXJlIGZvcmZlaXQgKHNlZQpgZmluYWxpemVfbWFya2V0YCkuIGBOb25lYCB3aGlsZSB0aGUgbWFya2V0IGlzIHN0aWxsIE9wZW4g4oCUIGl0cwpkZWFkbGluZSBpcyBub3Qga25vd24geWV0IOKAlCBhbmQgZm9yIGxlZ2FjeSBtYXJrZXRzLCB3aGljaCBoYXZlIG5vCmRlYWRsaW5lIGFuZCBjYW5ub3QgYmUgZmluYWxpemVkLgAAAA9yZWRlZW1fZGVhZGxpbmUAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPoAAAABg==",
        "AAAAAAAAAL1DdW11bGF0aXZlIGBwcmljZV9icHMgKiBzZWNvbmRzYCBmb3IgWUVTIHNpbmNlIGNyZWF0aW9uLCBleHRyYXBvbGF0ZWQKdG8gbm93OiBgb2JzZXJ2ZShtYXJrZXRfaWQsIDApYC4gUmVhZHktbWFkZSBmb3IgY29uc3VtZXJzIHRoYXQgc3RvcmUKdGhlaXIgb3duIGNoZWNrcG9pbnRzIGFuZCBjb21wdXRlIFRXQVBzIG9mZi1jaGFpbi4AAAAAAAAQcHJpY2VfY3VtdWxhdGl2ZQAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAERDcmVhdG9yICh0aGUgTFApIHdpdGhkcmF3cyB3aGF0ZXZlciB0aGUgcG9vbCBzdGlsbCBob2xkcyBvbmNlIGZpbmFsLgAAABRjbGFpbV9wb29sX3JlbWFpbmRlcgAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAQdDbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVyIGZvciB1cCB0byBgTUFYX0JBVENIYCBtYXJrZXRzIHRoZQpgY3JlYXRvcmAgb3ducywgd2l0aCBvbmUgY29sbGF0ZXJhbCB0cmFuc2Zlci4gU2FtZSBvcmRlcmluZyBhbmQgc2tpcApzZW1hbnRpY3MgYXMgYHJlZGVlbV9tYW55YC4gQSBtYXJrZXQgY2xvc2VkIGJ5IGBmaW5hbGl6ZV9tYXJrZXRgCnJlcG9ydHMgYEFscmVhZHlDbGFpbWVkYCDigJQgdGhlIHN3ZWVwIGFscmVhZHkgdG9vayB0aGUgcmVtYWluZGVyLgAAAAAVY2xhaW1fcG9vbF9yZW1haW5kZXJzAAAAAAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAptYXJrZXRfaWRzAAAAAAPqAAAABgAAAAEAAAPpAAAH0AAAAAtCYXRjaFJlc3VsdAAAAAAD",
        "AAAAAAAAAI5BZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZQpob3Jpem9uIHNuYXBzaG90dGVkIGF0IHRoZWlyIGNyZWF0aW9uLiBNdXN0IGJlIHdpdGhpbgpbMTgwIGRheXMsIDE4MjUgZGF5c10uAAAAAAAac2V0X2RlZmF1bHRfcmVkZWVtX2hvcml6b24AAAAAAAEAAAAAAAAABHNlY3MAAAAGAAAAAQAAA+kAAAACAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<i128>>,
        sell: this.txFromJSON<Result<i128>>,
        twap: this.txFromJSON<Result<u32>>,
        redeem: this.txFromJSON<Result<i128>>,
        observe: this.txFromJSON<Result<i128>>,
        resolve: this.txFromJSON<Result<void>>,
        get_price: this.txFromJSON<Result<u32>>,
        max_batch: this.txFromJSON<u32>,
        quote_buy: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<Config>>,
        get_market: this.txFromJSON<Result<Market>>,
        quote_sell: this.txFromJSON<Result<i128>>,
        set_paused: this.txFromJSON<Result<void>>,
        sweep_fees: this.txFromJSON<Result<i128>>,
        redeem_many: this.txFromJSON<Result<BatchResult>>,
        void_market: this.txFromJSON<Result<void>>,
        get_position: this.txFromJSON<Position>,
        market_count: this.txFromJSON<u64>,
        set_resolver: this.txFromJSON<Result<void>>,
        set_treasury: this.txFromJSON<Result<void>>,
        settle_state: this.txFromJSON<Result<SettleState>>,
        create_market: this.txFromJSON<Result<u64>>,
        finalize_market: this.txFromJSON<Result<i128>>,
        redeem_deadline: this.txFromJSON<Option<u64>>,
        price_cumulative: this.txFromJSON<Result<i128>>,
        set_default_fee_bps: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        claim_pool_remainders: this.txFromJSON<Result<BatchResult>>,
        set_default_redeem_horizon: this.txFromJSON<Result<void>>
  }
}