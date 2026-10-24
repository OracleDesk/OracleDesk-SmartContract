// Regenerated bindings for market-core. Adds `sell_shares` / `quote_sell_shares`.
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
   * A transfer moved a different amount than requested (fee-on-transfer,
   * rebasing, or a buggy collateral token).
   */
  23: {message:"CollateralMismatch"},
  /**
   * The contract's collateral balance is below its outstanding obligations.
   */
  24: {message:"Insolvent"}
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

export type DataKey = {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "Collateral", values: void} | {tag: "Treasury", values: void} | {tag: "Resolver", values: void} | {tag: "PendingResolver", values: void} | {tag: "PendingTreasury", values: void} | {tag: "DefaultFeeBps", values: void} | {tag: "ProtocolFeeShareBps", values: void} | {tag: "DefaultBreaker", values: void} | {tag: "Paused", values: void} | {tag: "NextId", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Position", values: readonly [u64, string]} | {tag: "FeeTerms", values: readonly [u64]} | {tag: "LpFees", values: readonly [u64]} | {tag: "Breaker", values: readonly [u64]} | {tag: "Band", values: readonly [u64]};

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



export type MarketStatus = {tag: "Open", values: void} | {tag: "Resolved", values: readonly [Outcome]} | {tag: "Void", values: void};


/**
 * A proposed admin handover (#62). Absent when no transfer is pending.
 */
export interface PendingAdmin {
  address: string;
  expires_at: u64;
}


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
   * Construct and simulate a sell_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sell exactly `shares_in` of `outcome` and receive the collateral the
   * constant-product curve allows, rounded in the pool's favour. Returns
   * the collateral paid out. Reverts if fewer than `min_collateral_out`
   * would be received.
   * 
   * Unlike `sell`, this needs no off-chain inversion: clients can express
   * "sell 37.5 YES shares" or "close my whole position" exactly. The
   * arithmetic lives in `math::calc_sell_shares`.
   */
  sell_shares: ({trader, market_id, outcome, shares_in, min_collateral_out}: {trader: string, market_id: u64, outcome: Outcome, shares_in: i128, min_collateral_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

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
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Spot price of `outcome` in bps (0..=10_000). YES + NO ~ 10_000.
   */
  get_price: ({market_id, outcome}: {market_id: u64, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

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
   * Construct and simulate a quote_sell_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collateral a `sell_shares` of `shares_in` would pay out right now.
   * 
   * Like `quote_sell`, this does not check tradability: it is a pure
   * view of the curve and will quote even after the market closes.
   */
  quote_sell_shares: ({market_id, outcome, shares_in}: {market_id: u64, outcome: Outcome, shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * Construct and simulate a transfer_lp transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers the single LP role (the right to `claim_pool_remainder` and
   * `claim_lp_fees`) to `new_creator`. Only until the remainder has been
   * claimed; after that the role has no remaining value.
   */
  transfer_lp: ({market_id, new_creator}: {market_id: u64, new_creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Invalid or unresolvable market. Allowed any time before finality.
   */
  void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_position: ({market_id, holder}: {market_id: u64, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Position>>

  /**
   * Construct and simulate a market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

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
   * nothing is pending, mirroring `sweep_fees`).
   */
  claim_lp_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and seeds the pool. `creator` becomes the sole LP.
   * `initial_yes_bps` in [100, 9900] sets the opening YES probability;
   * the creator receives the leftover shares of the likelier outcome.
   */
  create_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The pending admin proposal, including its expiry, if one exists.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAdmin>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Starts a two-step handover of the admin role. The new admin must call
   * `accept_admin` itself, so a typo cannot hand control to an address
   * nobody holds.
   */
  propose_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a breaker_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The market's snapshotted breakers (`None` for legacy markets created
   * before breakers existed — those are never checked).
   */
  breaker_config: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<BreakerConfig>>>>

  /**
   * Construct and simulate a accept_resolver transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_resolver: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_treasury: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_resolver transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_resolver: ({resolver}: {resolver: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call and the legacy fallback in
   * `sweep_fees`. Markets with a snapshotted `FeeTerms` keep paying their
   * original recipient.
   */
  propose_treasury: ({treasury}: {treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_admin_transfer: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABIAAABHYGJ1eV92MmAgLyBgc2VsbF92MmAgY2FsbGVkIHdpdGggYGVudi5sZWRnZXIoKS50aW1lc3RhbXAoKSA+IGRlYWRsaW5lYC4AAAAAD0RlYWRsaW5lRXhwaXJlZAAAAAATAAAAQmBidXlfdjJgIC8gYHNlbGxfdjJgIGF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIHdvcnNlIHRoYW4gdGhlIGxpbWl0LgAAAAAAEkxpbWl0UHJpY2VFeGNlZWRlZAAAAAAAFAAAAMVBIHNpbmdsZSB0cmFkZSB3b3VsZCBtb3ZlIHRoZSBwcmljZSBtb3JlIHRoYW4gYG1heF9pbXBhY3RfYnBzYC4KKEJvdGggdGhpcyBhbmQgdGhlIGJhbmQgcmVqZWN0IHRoZSB3aG9sZSBpbnZvY2F0aW9uLCBzbyB0aGVpciBldmVudHMsCmlmIGFueSwgcm9sbCBiYWNrIHdpdGggaXQg4oCUIHNlZSB0aGUgbm90ZSBvbiBgQnJlYWtlckNvbmZpZ2AuKQAAAAAAABJQcmljZUltcGFjdFRvb0hpZ2gAAAAAABUAAAA4Q3VtdWxhdGl2ZSBzYW1lLWxlZGdlciBtb3ZlbWVudCB3b3VsZCBleGNlZWQgYGJhbmRfYnBzYC4AAAARUHJpY2VCYW5kRXhjZWVkZWQAAAAAAAAWAAAAAAAAAA9Ob1BlbmRpbmdXaXJpbmcAAAAAFwAAAAAAAAANSW52YWxpZFdpcmluZwAAAAAAABgAAABEYGFjY2VwdF9hZG1pbmAvYGNhbmNlbF9hZG1pbl90cmFuc2ZlcmAgY2FsbGVkIHdpdGggbm90aGluZyBwcm9wb3NlZC4AAAAOTm9QZW5kaW5nQWRtaW4AAAAAABkAAABDQSBwcm9wb3NlZCBhZG1pbiBoYW5kb3ZlciB3YXMgbm90IGFjY2VwdGVkIHdpdGhpbiBpdHMgYGV4cGlyZXNfYXRgLgAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAAa",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAABGU25hcHNob3Qgb2YgdGhlIGZlZSBhdCBjcmVhdGlvbiBzbyBsYXRlciBjb25maWcgY2hhbmdlcyBuZXZlciBtb3ZlIGl0LgAAAAAAB2ZlZV9icHMAAAAABAAAACZUcmFkaW5nIGZlZXMgd2FpdGluZyBmb3IgYHN3ZWVwX2ZlZXNgLgAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAA4Q3JlYXRvciBoYXMgd2l0aGRyYXduIHRoZSBwb29sIHJlbWFpbmRlciBhZnRlciBmaW5hbGl0eS4AAAAKbHBfY2xhaW1lZAAAAAAAAQAAAChJUEZTIENJRCAvIFVSSSBvZiB0aGUgcXVlc3Rpb24gbWV0YWRhdGEuAAAACG1ldGFfdXJpAAAAEAAAAIZzaGEyNTYgb2YgdGhlIGNhbm9uaWNhbCBxdWVzdGlvbiBKU09OIHN0b3JlZCBvZmYtY2hhaW4gKElQRlMpLCBzbyBhCmNsaWVudCBjYW4gcHJvdmUgdGhlIHRleHQgaXQgc2hvd3MgaXMgdGhlIHRleHQgdGhhdCB3YXMgY29tbWl0dGVkLgAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAALcmVzZXJ2ZV95ZXMAAAAACwAAAS9Db21taXRtZW50IHRvIGhvdyB0aGlzIG1hcmtldCB3aWxsIGJlIHJlc29sdmVkLCBmaXhlZCBhdCBjcmVhdGlvbiBzbwp0aGUgY3JlYXRvciBjYW5ub3QgcGljayBmYXZvcmFibGUgcmVzb2x1dGlvbiBydWxlcyBhZnRlciBzZWVpbmcKdHJhZGluZyBhY3Rpdml0eS4gVGhlIHJlc29sdmVyIGNvbnRyYWN0IHZlcmlmaWVzIGEgcmV2ZWFsZWQgc3BlYwphZ2FpbnN0IHRoaXMgaGFzaCBiZWZvcmUgY29uZmlndXJpbmcgaXRzZWxmIGZvciB0aGUgbWFya2V0LiBTZWUKYGRvY3MvYWRyLzAwMDEtcmVzb2x1dGlvbi1jb21taXRtZW50Lm1kYC4AAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAEBDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuAAAAC3NldHNfbWludGVkAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxNYXJrZXRTdGF0dXM=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAEgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAAD1BlbmRpbmdSZXNvbHZlcgAAAAAAAAAAAAAAAA9QZW5kaW5nVHJlYXN1cnkAAAAAAAAAAAAAAAANRGVmYXVsdEZlZUJwcwAAAAAAAAAAAAAAAAAAE1Byb3RvY29sRmVlU2hhcmVCcHMAAAAAAAAAAAAAAAAORGVmYXVsdEJyZWFrZXIAAAAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAAAAAAAAAAAGTmV4dElkAAAAAAABAAAAAAAAAAZNYXJrZXQAAAAAAAEAAAAGAAAAAQAAAAAAAAAIUG9zaXRpb24AAAACAAAABgAAABMAAAABAAAAAAAAAAhGZWVUZXJtcwAAAAEAAAAGAAAAAQAAAAAAAAAGTHBGZWVzAAAAAAABAAAABgAAAAEAAAAAAAAAB0JyZWFrZXIAAAAAAQAAAAYAAAABAAAAAAAAAARCYW5kAAAAAQAAAAY=",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAahGZWUgZGVzdGluYXRpb24gYW5kIHNwbGl0LCBzbmFwc2hvdHRlZCBwZXIgbWFya2V0IGF0IGNyZWF0aW9uIGFzIGEgc2lkZQplbnRyeSAoYERhdGFLZXk6OkZlZVRlcm1zYCkgc28gYE1hcmtldGAncyBYRFIgc2hhcGUgbmV2ZXIgY2hhbmdlcy4KCk1hcmtldHMgY3JlYXRlZCBiZWZvcmUgdGhpcyBlbnRyeSBleGlzdGVkIGhhdmUgbm8gYEZlZVRlcm1zYCBhbmQga2VlcCB0aGUKbGVnYWN5IGJlaGF2aW91cjogYHN3ZWVwX2ZlZXNgIHBheXMgd2hhdGV2ZXIgYERhdGFLZXk6OlRyZWFzdXJ5YCBob2xkcyBhdApzd2VlcCB0aW1lLCB3aXRoIHRoZSBwcm90b2NvbCBrZWVwaW5nIDEwMCUgb2YgdGhlIGZlZS4gVGhhdCBmYWxsYmFjayBpcwpkb2N1bWVudGVkIGluIGBzd2VlcF9mZWVzYCBhbmQgbWFrZXMgdGhlIHVwZ3JhZGUgbWlncmF0aW9uLWZyZWUuAAAAAAAAAAhGZWVUZXJtcwAAAAIAAACGUHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIHRyYWRlIGZlZSBpbiBicHM7IHRoZSByZXN0IGlzIHRoZSBMUCdzLgowLi49QlBTLiBBdCBCUFMgKHRoZSBkZWZhdWx0KSB0aGUgc3BsaXQgaXMgZXhhY3RseSB0b2RheSdzIGJlaGF2aW91ci4AAAAAABJwcm90b2NvbF9zaGFyZV9icHMAAAAAAAQAAAB7V2hlcmUgdGhlIHByb3RvY29sJ3MgZmVlIHNoYXJlIGlzIHN3ZXB0LiBGcm96ZW4gYXQgY3JlYXRpb246IGxhdGVyCmBzZXRfdHJlYXN1cnlgIGNhbGxzIG5ldmVyIHJlZGlyZWN0IGZlZXMgYWxyZWFkeSBlYXJuZWQuAAAAAAlyZWNpcGllbnQAAAAAAAAT",
        "AAAAAQAAAAAAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAAAAAACbm8AAAAAAAsAAAAAAAAAA3llcwAAAAAL",
        "AAAABQAAAAAAAAAAAAAACFJlZGVlbWVkAAAAAQAAAAhyZWRlZW1lZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAADNUZW1wb3JhcnkgKG9uZSBsZWRnZXIpIGJhbmQgcmVmZXJlbmNlIGZvciBhIG1hcmtldC4AAAAAAAAAAAlCYW5kU3RhdGUAAAAAAAACAAAAAAAAAApsZWRnZXJfc2VxAAAAAAAEAAAAAAAAAA1yZWZfcHJpY2VfYnBzAAAAAAAABA==",
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAALFTYW1lIHN3ZWVwIGFzIGBGZWVzU3dlcHRgIHBsdXMgdGhlIGFjdHVhbCByZWNpcGllbnQuIE5ldyBldmVudCByYXRoZXIKdGhhbiBuZXcgZmllbGRzIHNvIHRoZSBleGlzdGluZyBgRmVlc1N3ZXB0YCBYRFIgc3RheXMgc3RhYmxlIGZvcgppbmRleGVyczsgYm90aCBhcmUgZW1pdHRlZCBvbiBldmVyeSBzd2VlcC4AAAAAAAAAAAAAC0ZlZXNTd2VwdFRvAAAAAAEAAAANZmVlc19zd2VwdF90bwAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAADE1hcmtldFN0YXR1cwAAAAMAAAAAAAAAQlRyYWRpbmcgYWxsb3dlZCB1bnRpbCBgY2xvc2VfdGltZWAsIHRoZW4gd2FpdGluZyBmb3IgdGhlIHJlc29sdmVyLgAAAAAABE9wZW4AAAABAAAAIUZpbmFsLiBXaW5uaW5nIHNoYXJlcyByZWRlZW0gMToxLgAAAAAAAAhSZXNvbHZlZAAAAAEAAAfQAAAAB091dGNvbWUAAAAAAAAAACtJbnZhbGlkIG1hcmtldC4gRXZlcnkgc2hhcmUgcmVkZWVtcyBhdCAwLjUuAAAAAARWb2lk",
        "AAAAAQAAAERBIHByb3Bvc2VkIGFkbWluIGhhbmRvdmVyICgjNjIpLiBBYnNlbnQgd2hlbiBubyB0cmFuc2ZlciBpcyBwZW5kaW5nLgAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAgAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAG",
        "AAAAAQAAAMJQZXItbWFya2V0IGNpcmN1aXQgYnJlYWtlcnMsIHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uIGZyb20KYERhdGFLZXk6OkRlZmF1bHRCcmVha2VyYC4gMCBkaXNhYmxlcyBlYWNoIGNoZWNrLiBBIG1hcmtldCB3aXRob3V0IGEKYEJyZWFrZXJgIGVudHJ5IChjcmVhdGVkIGJlZm9yZSBicmVha2VycyBleGlzdGVkKSBpcyBuZXZlciBjaGVja2VkLgAAAAAAAAAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAgAAAERNYXhpbXVtIHxwb3N0LXByaWNlIC0gbGVkZ2VyLW9wZW4gcHJpY2V8IGN1bXVsYXRpdmUgbW92ZW1lbnQgaW4gYnBzLgAAAAhiYW5kX2JwcwAAAAQAAABATWF4aW11bSB8cG9zdC1wcmljZSAtIHByZS1wcmljZXwgYSBzaW5nbGUgdHJhZGUgbWF5IG1vdmUgaW4gYnBzLgAAAA5tYXhfaW1wYWN0X2JwcwAAAAAABA==",
        "AAAABQAAAAAAAAAAAAAADUxwRmVlc0NsYWltZWQAAAAAAAABAAAAD2xwX2ZlZXNfY2xhaW1lZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUxwVHJhbnNmZXJyZWQAAAAAAAABAAAADmxwX3RyYW5zZmVycmVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldFJlc29sdmVkAAAAAAABAAAAD21hcmtldF9yZXNvbHZlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAACFOb25lIG1lYW5zIHRoZSBtYXJrZXQgd2FzIHZvaWRlZC4AAAAAAAAHb3V0Y29tZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD1Jlc29sdmVyQ2hhbmdlZAAAAAABAAAAEHJlc29sdmVyX2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyZWFzdXJ5Q2hhbmdlZAAAAAABAAAAEHRyZWFzdXJ5X2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEFJlc29sdmVyUHJvcG9zZWQAAAABAAAAEXJlc29sdmVyX3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEFRyZWFzdXJ5UHJvcG9zZWQAAAABAAAAEXRyZWFzdXJ5X3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAI=",
        "AAAABQAAAIxQb3NpdGlvbnMgbW92ZWQgYmV0d2VlbiBob2xkZXJzLiBJbmRleGVycyB0aGF0IHRyYWNrIGJhbGFuY2VzIGZyb20KYFRyYWRlYC9gUmVkZWVtZWRgIG11c3QgYWxzbyBhcHBseSB0aGlzIGV2ZW50IChzZWUgZG9jcy9hcmNoaXRlY3R1cmUubWQpLgAAAAAAAAATUG9zaXRpb25UcmFuc2ZlcnJlZAAAAAABAAAAFHBvc2l0aW9uX3RyYW5zZmVycmVkAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFBvb2xSZW1haW5kZXJDbGFpbWVkAAAAAQAAABZwb29sX3JlbWFpbmRlcl9jbGFpbWVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAADlQb29sIHJlbWFpbmRlciBwbHVzIGFueSBMUCBmZWVzIGRyYWluZWQgaW4gdGhlIHNhbWUgY2FsbC4AAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAF1Byb3RvY29sRmVlU2hhcmVDaGFuZ2VkAAAAAAEAAAAacHJvdG9jb2xfZmVlX3NoYXJlX2NoYW5nZWQAAAAAAAIAAAAAAAAAA29sZAAAAAAEAAAAAAAAAAAAAAADbmV3AAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAAPdTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4KCkxlZ2FjeSBlbnRyeXBvaW50OiBubyBkZWFkbGluZSBhbmQgbm8gbGltaXQgcHJpY2UsIHNvIGEgc2lnbmVkIGJvdW5kCmNhbiBleGVjdXRlIGF0IGFueSBsYXRlciB0aW1lLiBQcmVmZXIgYGJ1eV92MmAuAAAAAANidXkAAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAVZSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgoKTGVnYWN5IGVudHJ5cG9pbnQ6IG5vIGRlYWRsaW5lIGFuZCBubyBsaW1pdCBwcmljZS4gUHJlZmVyIGBzZWxsX3YyYC4AAAAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAdRgYnV5YCBwbHVzIGEgZGVhZGxpbmUgKGBlbnYubGVkZ2VyKCkudGltZXN0YW1wKClgIHNlY29uZHMg4oCUIG5ldHdvcmsKdGltZSwgbm90IHRoZSBjbGllbnQgY2xvY2spIGFuZCBhbiBhdmVyYWdlLXByaWNlIGxpbWl0CihgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUzsgMCA9IG5vIGxpbWl0KS4KClRoZSBhdmVyYWdlIHByaWNlIGluY2x1ZGVzIHRoZSBmZWUgKGBmZWVgIGlzIHBhcnQgb2YgYGNvbGxhdGVyYWxfaW5gKQphbmQsIGZvciBhIE5PIGJ1eSwgaXMgY29tcGFyZWQgYWdhaW5zdCB0aGUgTk8gcHJpY2UuIEJlY2F1c2UgdGhlCmRlYWRsaW5lIGNoZWNrIHJ1bnMgYmVmb3JlIGByZXF1aXJlX2F1dGhgLCBhbiBleHBpcmVkIHRyYW5zYWN0aW9uCmZhaWxzIGNoZWFwbHkuIEEgbGltaXQgYWJvdmUgQlBTIGNhbiBuZXZlciBwYXNzIGZvciBhIGJ1eSBhbmQgaXMKcmVqZWN0ZWQgYXMgaW52YWxpZC4AAAAGYnV5X3YyAAAAAAAHAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAWxgc2VsbGAgcGx1cyBhIGRlYWRsaW5lIChsZWRnZXIgdGltZXN0YW1wLCBzZWNvbmRzKSBhbmQgYSBtaW5pbXVtCmF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUykuCgpBIHplcm8gbGltaXQgaXMgdHJpdmlhbGx5IHNhdGlzZmllZCBmb3Igc2VsbHMg4oCUIHVubGlrZSBidXlzLCB3aGVyZSAwCm1lYW5zICJubyBsaW1pdCIg4oCUIGFuZCBhIGxpbWl0IGFib3ZlIEJQUyBjYW4gbmV2ZXIgcGFzcywgc28gbmVpdGhlcgpuZWVkcyBhIHNwZWNpYWwgY2FzZS4gVGhlIGF2ZXJhZ2UgaW5jbHVkZXMgdGhlIGZlZSwgd2hpY2ggdGhlIHRyYWRlcgpwYXlzIG91dCBvZiB0aGUgZ3Jvc3MuAAAAB3NlbGxfdjIAAAAABwAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAD9TcG90IHByaWNlIG9mIGBvdXRjb21lYCBpbiBicHMgKDAuLj0xMF8wMDApLiBZRVMgKyBOTyB+IDEwXzAwMC4AAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAADlTaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIHJpZ2h0IG5vdy4AAAAAAAAJcXVvdGVfYnV5AAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=",
        "AAAAAAAAAEVTaGFyZXMgYSBgc2VsbGAgZm9yIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCB3b3VsZCBjb25zdW1lIHJpZ2h0IG5vdy4AAAAAAAAKcXVvdGVfc2VsbAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQpBbnlvbmUgY2FuIG1vdmUgYWNjcnVlZCBwcm90b2NvbCBmZWVzIHRvIHRoZSBtYXJrZXQncyBmZWUgcmVjaXBpZW50LgoKU2VuZHMgdG8gdGhlIHJlY2lwaWVudCBzbmFwc2hvdHRlZCBpbiBgRmVlVGVybXNgIGF0IGNyZWF0aW9uLiBNYXJrZXRzCmNyZWF0ZWQgYmVmb3JlIGBGZWVUZXJtc2AgZXhpc3RlZCBoYXZlIG5vbmUgYW5kIGtlZXAgdGhlIGxlZ2FjeQpiZWhhdmlvdXI6IHRoZSBgRGF0YUtleTo6VHJlYXN1cnlgIG9mIHRoZSBtb21lbnQgb2YgdGhlIHN3ZWVwLgAAAAAACnN3ZWVwX2ZlZXMAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAPVUcnVlIHdoZW4gYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgYmUgcmVqZWN0ZWQgYnkgdGhlCm1hcmtldCdzIGJyZWFrZXJzIHJpZ2h0IG5vdy4gUmVhZC1vbmx5OiBuZXZlciB3cml0ZXMgYmFuZCBzdGF0ZSwgc28Kb24gYSBmcmVzaCBsZWRnZXIgdGhlIHJlZmVyZW5jZSBpcyB0YWtlbiBhcyB0aGUgY3VycmVudCBwcmljZSDigJQgdGhlCnNhbWUgdmFsdWUgYSBzdWJzZXF1ZW50IHJlYWwgdHJhZGUgd291bGQgdXNlLgAAAAAAAAp3b3VsZF90cmlwAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAAL9UcmFuc2ZlcnMgdGhlIHNpbmdsZSBMUCByb2xlICh0aGUgcmlnaHQgdG8gYGNsYWltX3Bvb2xfcmVtYWluZGVyYCBhbmQKYGNsYWltX2xwX2ZlZXNgKSB0byBgbmV3X2NyZWF0b3JgLiBPbmx5IHVudGlsIHRoZSByZW1haW5kZXIgaGFzIGJlZW4KY2xhaW1lZDsgYWZ0ZXIgdGhhdCB0aGUgcm9sZSBoYXMgbm8gcmVtYWluaW5nIHZhbHVlLgAAAAALdHJhbnNmZXJfbHAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEFJbnZhbGlkIG9yIHVucmVzb2x2YWJsZSBtYXJrZXQuIEFsbG93ZWQgYW55IHRpbWUgYmVmb3JlIGZpbmFsaXR5LgAAAAAAAAt2b2lkX21hcmtldAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMZ2V0X3Bvc2l0aW9uAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAB9AAAAAIUG9zaXRpb24=",
        "AAAAAAAAAAAAAAAMbWFya2V0X2NvdW50AAAAAAAAAAEAAAAG",
        "AAAAAAAAAQhSdW5zIGF0b21pY2FsbHkgYXQgZGVwbG95IHRpbWUsIHNvIG5vYm9keSBjYW4gZnJvbnQtcnVuIGluaXRpYWxpemF0aW9uLgpgcHJvdG9jb2xfZmVlX3NoYXJlX2Jwc2AgaXMgdGhlIGRlZmF1bHQgcHJvdG9jb2wvTFAgc3BsaXQgZm9yIG5ldwptYXJrZXRzOyAxMF8wMDAga2VlcHMgdGhlIHdob2xlIGZlZSB3aXRoIHRoZSBwcm90b2NvbCAocHJlLXVwZ3JhZGUKYmVoYXZpb3VyKS4gUGFzcyAwIHRvIGdpdmUgYWxsIGZlZXMgdG8gdGhlIG1hcmtldCBjcmVhdG9ycy4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAD2RlZmF1bHRfZmVlX2JwcwAAAAAEAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAA==",
        "AAAAAAAAALpUaGUgY3VycmVudCBsZWRnZXIncyBiYW5kIHJlZmVyZW5jZSwgaWYgYSBiYW5kIGNoZWNrIGhhcyBydW4gdGhpcwpsZWRnZXIuIGBOb25lYCBtZWFucyB0aGUgbmV4dCB0cmFkZSBzZXRzIHRoZSByZWZlcmVuY2UgKHRvIGl0cyBvd24KcHJlLXRyYWRlIHByaWNlLCB3aGljaCBlcXVhbHMgdGhlIGxlZGdlci1vcGVuIHByaWNlKS4AAAAAAA1icmVha2VyX3N0YXRlAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAD6AAAB9AAAAAJQmFuZFN0YXRlAAAAAAAAAw==",
        "AAAAAAAAALVUaGUgY3JlYXRvciAodGhlIExQKSBjbGFpbXMgdGhlaXIgc2hhcmUgb2YgYWNjcnVlZCB0cmFkZSBmZWVzIGF0IGFueQp0aW1lLCBpbmNsdWRpbmcgYmVmb3JlIGZpbmFsaXR5LiBSZXR1cm5zIHRoZSBhbW91bnQgY2xhaW1lZCAoMCB3aGVuCm5vdGhpbmcgaXMgcGVuZGluZywgbWlycm9yaW5nIGBzd2VlcF9mZWVzYCkuAAAAAAAADWNsYWltX2xwX2ZlZXMAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAMhDcmVhdGVzIGEgbWFya2V0IGFuZCBzZWVkcyB0aGUgcG9vbC4gYGNyZWF0b3JgIGJlY29tZXMgdGhlIHNvbGUgTFAuCmBpbml0aWFsX3llc19icHNgIGluIFsxMDAsIDk5MDBdIHNldHMgdGhlIG9wZW5pbmcgWUVTIHByb2JhYmlsaXR5Owp0aGUgY3JlYXRvciByZWNlaXZlcyB0aGUgbGVmdG92ZXIgc2hhcmVzIG9mIHRoZSBsaWtlbGllciBvdXRjb21lLgAAAA1jcmVhdGVfbWFya2V0AAAAAAAACAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAEBUaGUgcGVuZGluZyBhZG1pbiBwcm9wb3NhbCwgaW5jbHVkaW5nIGl0cyBleHBpcnksIGlmIG9uZSBleGlzdHMuAAAADXBlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAfQAAAADFBlbmRpbmdBZG1pbg==",
        "AAAAAAAAAJZTdGFydHMgYSB0d28tc3RlcCBoYW5kb3ZlciBvZiB0aGUgYWRtaW4gcm9sZS4gVGhlIG5ldyBhZG1pbiBtdXN0IGNhbGwKYGFjY2VwdF9hZG1pbmAgaXRzZWxmLCBzbyBhIHR5cG8gY2Fubm90IGhhbmQgY29udHJvbCB0byBhbiBhZGRyZXNzCm5vYm9keSBob2xkcy4AAAAAAA1wcm9wb3NlX2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHpUaGUgbWFya2V0J3Mgc25hcHNob3R0ZWQgYnJlYWtlcnMgKGBOb25lYCBmb3IgbGVnYWN5IG1hcmtldHMgY3JlYXRlZApiZWZvcmUgYnJlYWtlcnMgZXhpc3RlZCDigJQgdGhvc2UgYXJlIG5ldmVyIGNoZWNrZWQpLgAAAAAADmJyZWFrZXJfY29uZmlnAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAPoAAAH0AAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAPYWNjZXB0X3Jlc29sdmVyAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAPYWNjZXB0X3RyZWFzdXJ5AAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQcHJvcG9zZV9yZXNvbHZlcgAAAAEAAAAAAAAACHJlc29sdmVyAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAJtBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbCBhbmQgdGhlIGxlZ2FjeSBmYWxsYmFjayBpbgpgc3dlZXBfZmVlc2AuIE1hcmtldHMgd2l0aCBhIHNuYXBzaG90dGVkIGBGZWVUZXJtc2Aga2VlcCBwYXlpbmcgdGhlaXIKb3JpZ2luYWwgcmVjaXBpZW50LgAAAAAQcHJvcG9zZV90cmVhc3VyeQAAAAEAAAAAAAAACHRyZWFzdXJ5AAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADdNb3ZlcyBgYW1vdW50YCBzaGFyZXMgb2YgYG91dGNvbWVgIGZyb20gYGZyb21gIHRvIGB0b2AuAAAAABF0cmFuc2Zlcl9wb3NpdGlvbgAAAAAAAAUAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAOZTZXRzIHRoZSBicmVha2VyIGRlZmF1bHRzIGNvcGllZCBpbnRvIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbC4KYGJhbmRfYnBzIDwgbWF4X2ltcGFjdF9icHNgIChib3RoIG5vbi16ZXJvKSBpcyByZWplY3RlZDogYSBzaW5nbGUKdHJhZGUgdGhhdCBpcyBhbGxvd2VkIGJ5IHRoZSBpbXBhY3QgY2FwIGNvdWxkIHRoZW4gbmV2ZXIgZml0IGluc2lkZQp0aGUgYmFuZCwgbG9ja2luZyB0cmFkaW5nLgAAAAAAE3NldF9kZWZhdWx0X2JyZWFrZXIAAAAAAQAAAAAAAAAHYnJlYWtlcgAAAAfQAAAADUJyZWFrZXJDb25maWcAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHxDcmVhdG9yICh0aGUgTFApIHdpdGhkcmF3cyB3aGF0ZXZlciB0aGUgcG9vbCBzdGlsbCBob2xkcyBvbmNlIGZpbmFsLApwbHVzIGFueSB1bmNsYWltZWQgTFAgZmVlcy4gUmV0dXJucyB0aGUgdG90YWwgcGFpZCBvdXQuAAAAFGNsYWltX3Bvb2xfcmVtYWluZGVyAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAGVBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZQpzcGxpdCB0aGV5IHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uLgAAAAAAABpzZXRfcHJvdG9jb2xfZmVlX3NoYXJlX2JwcwAAAAAAAQAAAAAAAAAJc2hhcmVfYnBzAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<i128>>,
        sell: this.txFromJSON<Result<i128>>,
        sell_shares: this.txFromJSON<Result<i128>>,
        admin: this.txFromJSON<Result<string>>,
        buy_v2: this.txFromJSON<Result<i128>>,
        redeem: this.txFromJSON<Result<i128>>,
        resolve: this.txFromJSON<Result<void>>,
        sell_v2: this.txFromJSON<Result<i128>>,
        get_price: this.txFromJSON<Result<u32>>,
        quote_buy: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<Config>>,
        get_market: this.txFromJSON<Result<Market>>,
        quote_sell: this.txFromJSON<Result<i128>>,
        quote_sell_shares: this.txFromJSON<Result<i128>>,
        set_paused: this.txFromJSON<Result<void>>,
        sweep_fees: this.txFromJSON<Result<i128>>,
        would_trip: this.txFromJSON<Result<boolean>>,
        transfer_lp: this.txFromJSON<Result<void>>,
        void_market: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        get_position: this.txFromJSON<Position>,
        market_count: this.txFromJSON<u64>,
        breaker_state: this.txFromJSON<Result<Option<BandState>>>,
        claim_lp_fees: this.txFromJSON<Result<i128>>,
        create_market: this.txFromJSON<Result<u64>>,
        pending_admin: this.txFromJSON<Option<PendingAdmin>>,
        propose_admin: this.txFromJSON<Result<void>>,
        breaker_config: this.txFromJSON<Result<Option<BreakerConfig>>>,
        accept_resolver: this.txFromJSON<Result<void>>,
        accept_treasury: this.txFromJSON<Result<void>>,
        propose_resolver: this.txFromJSON<Result<void>>,
        propose_treasury: this.txFromJSON<Result<void>>,
        transfer_position: this.txFromJSON<Result<void>>,
        set_default_breaker: this.txFromJSON<Result<void>>,
        set_default_fee_bps: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        set_protocol_fee_share_bps: this.txFromJSON<Result<void>>
  }
}