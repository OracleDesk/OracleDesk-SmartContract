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
  23: {message:"NoPendingWiring"},
  24: {message:"InvalidWiring"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  25: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  26: {message:"PendingAdminExpired"},
  /**
   * `observe` / `twap` asked for a time older than every surviving
   * observation of the market (the ring keeps the most recent 16).
   */
  27: {message:"ObservationTooOld"},
  /**
   * `finalize_market` called before the redemption deadline.
   */
  28: {message:"RedemptionWindowOpen"},
  /**
   * Market already closed by `finalize_market`; redemption is over.
   */
  29: {message:"RedemptionClosed"},
  /**
   * Legacy market created before `SettleState` existed: outstanding shares
   * cannot be reconstructed on-chain, so it has no deadline and cannot be
   * finalized (still fully redeemable).
   */
  30: {message:"NotSupported"},
  /**
   * A batch call carried no ids or more than `MAX_BATCH` of them.
   */
  31: {message:"BatchTooLarge"},
  /**
<<<<<<< HEAD
   * The market was closed out and its remaining value swept.
   */
  32: {message:"MarketClosedOut"}
=======
   * Inbound collateral transfer delivered fewer (or different) units than
   * expected, e.g. a fee-on-transfer or under-delivering token (#137).
   */
  32: {message:"CollateralShortfall"}
>>>>>>> upstream/develop
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

export type DataKey = {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "Collateral", values: void} | {tag: "Treasury", values: void} | {tag: "Resolver", values: void} | {tag: "PendingResolver", values: void} | {tag: "PendingTreasury", values: void} | {tag: "DefaultFeeBps", values: void} | {tag: "ProtocolFeeShareBps", values: void} | {tag: "DefaultBreaker", values: void} | {tag: "Paused", values: void} | {tag: "NextId", values: void} | {tag: "DefaultRedeemHorizon", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Position", values: readonly [u64, string]} | {tag: "Settle", values: readonly [u64]} | {tag: "Oracle", values: readonly [u64]} | {tag: "Obs", values: readonly [u64, u32]} | {tag: "FeeTerms", values: readonly [u64]} | {tag: "LpFees", values: readonly [u64]} | {tag: "Breaker", values: readonly [u64]} | {tag: "Band", values: readonly [u64]};


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
 * One market's outcome inside a `BatchResult`, in request order.
 */
export interface BatchItem {
  market_id: u64;
  payout: i128;
  status: BatchStatus;
}

export type Lifecycle = {tag: "Open", values: void} | {tag: "Final", values: void} | {tag: "Closed", values: void};




export interface MarketView {
  lifecycle: Lifecycle;
  market: Market;
  redeem_deadline: Option<u64>;
}


/**
 * Why a market in a batch call did not settle. `Duplicate` is reserved:
 * ids are validated strictly ascending first, so a duplicate is rejected
 * as `InvalidAmount` before the batch runs and never reaches a skip.
 */
export type SkipReason = {tag: "NotFound", values: void} | {tag: "NotFinal", values: void} | {tag: "NothingToRedeem", values: void} | {tag: "AlreadyClaimed", values: void} | {tag: "NotCreator", values: void} | {tag: "Duplicate", values: void} | {tag: "Closed", values: void};


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

















<<<<<<< HEAD

=======
>>>>>>> upstream/develop

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};


export interface PriceData {
  price: i128;
  timestamp: u64;
}

/**
 * Who rules on a dispute.
 */
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
  /**
 * Raw Ed25519 public key. For a `G...` account address this is
 * `StrKey.decodeEd25519PublicKey(address)`; `C...` addresses have none.
 */
pubkey: Buffer;
  weight: u32;
}


/**
 * Binds a market to a reusable committee registry subject to rotation bounds.
 */
export interface CommitteeRef {
  committee_id: u64;
  dispute_window: u64;
  max_rotation_delta: u32;
  min_epoch: u32;
}


/**
 * Dual-path resolution mode: price feed first, falling back to signers.
 */
export interface HybridConfig {
  fallback: SignerConfig;
  fallback_after: u64;
  price: PriceConfig;
}

export type MarketStatus = {tag: "Open", values: void} | {tag: "Resolved", values: readonly [Outcome]} | {tag: "Void", values: void};


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}

export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

/**
 * The full resolution rule a market's `resolution_hash` commits to. Hashing
 * this (rather than the bare `PriceConfig`/`SignerConfig`) keeps the two
 * modes in disjoint hash spaces even if their field encodings could
 * otherwise collide. See `docs/adr/0001-resolution-commitment.md`.
 */
export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]};


/**
 * Versioned commitment envelope. Unlike a bare [`ResolutionSpec`] it binds the
 * network and the market-core instance, and carries a creator-chosen `salt`
 * that makes a pre-reveal brute-force of the (low-entropy) rule infeasible.
 */
export interface ResolutionSpecV2 {
  market_core: string;
  /**
 * `sha256(network passphrase)`, i.e. `env.ledger().network_id()`.
 */
network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}


export interface WeightedKeyConfig {
  dispute_window: u64;
  signers: Array<WeightedKey>;
  /**
 * Total weight that must sign one outcome. Choose it above half the total
 * weight so two outcomes can never both reach it.
 */
weight_threshold: u32;
}


/**
 * Attested resolution whose proposal can be challenged with a bond during
 * the dispute window. Hashed as `ResolutionSpec::SignersDisputable`, a
 * separate variant, so existing `Signers` commitments are unaffected.
 */
export interface DisputableSignerConfig {
  /**
 * Collateral escrowed by `dispute`; must be positive.
 */
dispute_bond: i128;
  dispute_window: u64;
  escalation: Escalation;
  /**
 * Seconds after a dispute opens before anyone may void it unresolved.
 */
escalation_timeout: u64;
  signers: Array<string>;
  threshold: u32;
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
   * Construct and simulate a is_closed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_closed: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

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
   * Returns zero for a closed market. Historical amounts must be recovered
   * from `Redeemed`, `PositionTransferred`, and `MarketFinalized` events.
   */
  get_position: ({market_id, holder}: {market_id: u64, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Position>>

  /**
   * Construct and simulate a market_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a settle_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Outstanding-share accounting for a market (issue #14).
   * `NotSupported` for markets created before this bookkeeping existed.
   */
  settle_state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SettleState>>>

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
   * Construct and simulate a get_market_view transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the market and its lifecycle. Integrators must use this view
   * rather than `get_market` when deciding whether positions have value.
   */
  get_market_view: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<MarketView>>>

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
   * Construct and simulate a claim_pool_remainders transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the LP pool remainder for up to `MAX_BATCH` markets the
   * `creator` owns, with one collateral transfer. Same ordering and skip
   * semantics as `redeem_many`. A market closed by `finalize_market`
   * reports `AlreadyClaimed` — the sweep already took the remainder.
   */
  claim_pool_remainders: ({creator, market_ids}: {creator: string, market_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchResult>>>

  /**
<<<<<<< HEAD
   * Construct and simulate a purge_closed_positions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes valueless position entries from a closed market. This is
   * permissionless and does not refund rent; it only reduces live state.
   */
  purge_closed_positions: ({market_id, holders}: {market_id: u64, holders: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
=======
>>>>>>> upstream/develop
   * Construct and simulate a set_default_redeem_horizon transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Affects markets created after the call; existing markets keep the
   * horizon snapshotted at their creation. Must be within
   * [180 days, 1825 days].
   */
  set_default_redeem_horizon: ({secs}: {secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
<<<<<<< HEAD
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAIAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABIAAABHYGJ1eV92MmAgLyBgc2VsbF92MmAgY2FsbGVkIHdpdGggYGVudi5sZWRnZXIoKS50aW1lc3RhbXAoKSA+IGRlYWRsaW5lYC4AAAAAD0RlYWRsaW5lRXhwaXJlZAAAAAATAAAAQmBidXlfdjJgIC8gYHNlbGxfdjJgIGF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIHdvcnNlIHRoYW4gdGhlIGxpbWl0LgAAAAAAEkxpbWl0UHJpY2VFeGNlZWRlZAAAAAAAFAAAAMVBIHNpbmdsZSB0cmFkZSB3b3VsZCBtb3ZlIHRoZSBwcmljZSBtb3JlIHRoYW4gYG1heF9pbXBhY3RfYnBzYC4KKEJvdGggdGhpcyBhbmQgdGhlIGJhbmQgcmVqZWN0IHRoZSB3aG9sZSBpbnZvY2F0aW9uLCBzbyB0aGVpciBldmVudHMsCmlmIGFueSwgcm9sbCBiYWNrIHdpdGggaXQg4oCUIHNlZSB0aGUgbm90ZSBvbiBgQnJlYWtlckNvbmZpZ2AuKQAAAAAAABJQcmljZUltcGFjdFRvb0hpZ2gAAAAAABUAAAA4Q3VtdWxhdGl2ZSBzYW1lLWxlZGdlciBtb3ZlbWVudCB3b3VsZCBleGNlZWQgYGJhbmRfYnBzYC4AAAARUHJpY2VCYW5kRXhjZWVkZWQAAAAAAAAWAAAAAAAAAA9Ob1BlbmRpbmdXaXJpbmcAAAAAFwAAAAAAAAANSW52YWxpZFdpcmluZwAAAAAAABgAAABEYGFjY2VwdF9hZG1pbmAvYGNhbmNlbF9hZG1pbl90cmFuc2ZlcmAgY2FsbGVkIHdpdGggbm90aGluZyBwcm9wb3NlZC4AAAAOTm9QZW5kaW5nQWRtaW4AAAAAABkAAABDQSBwcm9wb3NlZCBhZG1pbiBoYW5kb3ZlciB3YXMgbm90IGFjY2VwdGVkIHdpdGhpbiBpdHMgYGV4cGlyZXNfYXRgLgAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAAaAAAAfWBvYnNlcnZlYCAvIGB0d2FwYCBhc2tlZCBmb3IgYSB0aW1lIG9sZGVyIHRoYW4gZXZlcnkgc3Vydml2aW5nCm9ic2VydmF0aW9uIG9mIHRoZSBtYXJrZXQgKHRoZSByaW5nIGtlZXBzIHRoZSBtb3N0IHJlY2VudCAxNikuAAAAAAAAEU9ic2VydmF0aW9uVG9vT2xkAAAAAAAAGwAAADhgZmluYWxpemVfbWFya2V0YCBjYWxsZWQgYmVmb3JlIHRoZSByZWRlbXB0aW9uIGRlYWRsaW5lLgAAABRSZWRlbXB0aW9uV2luZG93T3BlbgAAABwAAAA/TWFya2V0IGFscmVhZHkgY2xvc2VkIGJ5IGBmaW5hbGl6ZV9tYXJrZXRgOyByZWRlbXB0aW9uIGlzIG92ZXIuAAAAABBSZWRlbXB0aW9uQ2xvc2VkAAAAHQAAALBMZWdhY3kgbWFya2V0IGNyZWF0ZWQgYmVmb3JlIGBTZXR0bGVTdGF0ZWAgZXhpc3RlZDogb3V0c3RhbmRpbmcgc2hhcmVzCmNhbm5vdCBiZSByZWNvbnN0cnVjdGVkIG9uLWNoYWluLCBzbyBpdCBoYXMgbm8gZGVhZGxpbmUgYW5kIGNhbm5vdCBiZQpmaW5hbGl6ZWQgKHN0aWxsIGZ1bGx5IHJlZGVlbWFibGUpLgAAAAxOb3RTdXBwb3J0ZWQAAAAeAAAAPUEgYmF0Y2ggY2FsbCBjYXJyaWVkIG5vIGlkcyBvciBtb3JlIHRoYW4gYE1BWF9CQVRDSGAgb2YgdGhlbS4AAAAAAAANQmF0Y2hUb29MYXJnZQAAAAAAAB8AAAA4VGhlIG1hcmtldCB3YXMgY2xvc2VkIG91dCBhbmQgaXRzIHJlbWFpbmluZyB2YWx1ZSBzd2VwdC4AAAAPTWFya2V0Q2xvc2VkT3V0AAAAACA=",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAABGU25hcHNob3Qgb2YgdGhlIGZlZSBhdCBjcmVhdGlvbiBzbyBsYXRlciBjb25maWcgY2hhbmdlcyBuZXZlciBtb3ZlIGl0LgAAAAAAB2ZlZV9icHMAAAAABAAAACZUcmFkaW5nIGZlZXMgd2FpdGluZyBmb3IgYHN3ZWVwX2ZlZXNgLgAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAA4Q3JlYXRvciBoYXMgd2l0aGRyYXduIHRoZSBwb29sIHJlbWFpbmRlciBhZnRlciBmaW5hbGl0eS4AAAAKbHBfY2xhaW1lZAAAAAAAAQAAAChJUEZTIENJRCAvIFVSSSBvZiB0aGUgcXVlc3Rpb24gbWV0YWRhdGEuAAAACG1ldGFfdXJpAAAAEAAAAIZzaGEyNTYgb2YgdGhlIGNhbm9uaWNhbCBxdWVzdGlvbiBKU09OIHN0b3JlZCBvZmYtY2hhaW4gKElQRlMpLCBzbyBhCmNsaWVudCBjYW4gcHJvdmUgdGhlIHRleHQgaXQgc2hvd3MgaXMgdGhlIHRleHQgdGhhdCB3YXMgY29tbWl0dGVkLgAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAALcmVzZXJ2ZV95ZXMAAAAACwAAAS9Db21taXRtZW50IHRvIGhvdyB0aGlzIG1hcmtldCB3aWxsIGJlIHJlc29sdmVkLCBmaXhlZCBhdCBjcmVhdGlvbiBzbwp0aGUgY3JlYXRvciBjYW5ub3QgcGljayBmYXZvcmFibGUgcmVzb2x1dGlvbiBydWxlcyBhZnRlciBzZWVpbmcKdHJhZGluZyBhY3Rpdml0eS4gVGhlIHJlc29sdmVyIGNvbnRyYWN0IHZlcmlmaWVzIGEgcmV2ZWFsZWQgc3BlYwphZ2FpbnN0IHRoaXMgaGFzaCBiZWZvcmUgY29uZmlndXJpbmcgaXRzZWxmIGZvciB0aGUgbWFya2V0LiBTZWUKYGRvY3MvYWRyLzAwMDEtcmVzb2x1dGlvbi1jb21taXRtZW50Lm1kYC4AAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAEBDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuAAAAC3NldHNfbWludGVkAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxNYXJrZXRTdGF0dXM=",
        "AAAAAAAAAPdTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4KCkxlZ2FjeSBlbnRyeXBvaW50OiBubyBkZWFkbGluZSBhbmQgbm8gbGltaXQgcHJpY2UsIHNvIGEgc2lnbmVkIGJvdW5kCmNhbiBleGVjdXRlIGF0IGFueSBsYXRlciB0aW1lLiBQcmVmZXIgYGJ1eV92MmAuAAAAAANidXkAAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAFgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAAD1BlbmRpbmdSZXNvbHZlcgAAAAAAAAAAAAAAAA9QZW5kaW5nVHJlYXN1cnkAAAAAAAAAAAAAAAANRGVmYXVsdEZlZUJwcwAAAAAAAAAAAAAAAAAAE1Byb3RvY29sRmVlU2hhcmVCcHMAAAAAAAAAAAAAAAAORGVmYXVsdEJyZWFrZXIAAAAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAAAAAAAAAAAGTmV4dElkAAAAAAAAAAAAAAAAABREZWZhdWx0UmVkZWVtSG9yaXpvbgAAAAEAAAAAAAAABk1hcmtldAAAAAAAAQAAAAYAAAABAAAAAAAAAAhQb3NpdGlvbgAAAAIAAAAGAAAAEwAAAAEAAAAAAAAABlNldHRsZQAAAAAAAQAAAAYAAAABAAAAAAAAAAZPcmFjbGUAAAAAAAEAAAAGAAAAAQAAAAAAAAADT2JzAAAAAAIAAAAGAAAABAAAAAEAAAAAAAAACEZlZVRlcm1zAAAAAQAAAAYAAAABAAAAAAAAAAZMcEZlZXMAAAAAAAEAAAAGAAAAAQAAAAAAAAAHQnJlYWtlcgAAAAABAAAABgAAAAEAAAAAAAAABEJhbmQAAAABAAAABg==",
        "AAAAAAAAAVZSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgoKTGVnYWN5IGVudHJ5cG9pbnQ6IG5vIGRlYWRsaW5lIGFuZCBubyBsaW1pdCBwcmljZS4gUHJlZmVyIGBzZWxsX3YyYC4AAAAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAUxUaW1lLXdlaWdodGVkIGF2ZXJhZ2UgWUVTIHByaWNlIGluIGJwcyBvdmVyIHRoZSB0cmFpbGluZwpgd2luZG93X3NlY3NgLCBmbG9vcmVkLiBSZWplY3RzIGEgemVybyB3aW5kb3cgKGBJbnZhbGlkQW1vdW50YCkuCkEgd2luZG93IHJlYWNoaW5nIGJlZm9yZSB0aGUgb2xkZXN0IG9ic2VydmF0aW9uIGZhaWxzIHdpdGgKYE9ic2VydmF0aW9uVG9vT2xkYDsgYSB3aW5kb3cgZXh0ZW5kaW5nIHBhc3QgYGNsb3NlX3RpbWVgIGtlZXBzCmF2ZXJhZ2luZyB0aGUgZmluYWwgcHJpY2UsIGJlY2F1c2UgdGhlIGFjY3VtdWxhdG9yIG9ubHkgbW92ZXMgd2hlbgp0cmFkZXMgYXJlIHBvc3NpYmxlLgAAAAR0d2FwAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALd2luZG93X3NlY3MAAAAABgAAAAEAAAPpAAAABAAAAAM=",
=======
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAIAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABIAAABHYGJ1eV92MmAgLyBgc2VsbF92MmAgY2FsbGVkIHdpdGggYGVudi5sZWRnZXIoKS50aW1lc3RhbXAoKSA+IGRlYWRsaW5lYC4AAAAAD0RlYWRsaW5lRXhwaXJlZAAAAAATAAAAQmBidXlfdjJgIC8gYHNlbGxfdjJgIGF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIHdvcnNlIHRoYW4gdGhlIGxpbWl0LgAAAAAAEkxpbWl0UHJpY2VFeGNlZWRlZAAAAAAAFAAAAMVBIHNpbmdsZSB0cmFkZSB3b3VsZCBtb3ZlIHRoZSBwcmljZSBtb3JlIHRoYW4gYG1heF9pbXBhY3RfYnBzYC4KKEJvdGggdGhpcyBhbmQgdGhlIGJhbmQgcmVqZWN0IHRoZSB3aG9sZSBpbnZvY2F0aW9uLCBzbyB0aGVpciBldmVudHMsCmlmIGFueSwgcm9sbCBiYWNrIHdpdGggaXQg4oCUIHNlZSB0aGUgbm90ZSBvbiBgQnJlYWtlckNvbmZpZ2AuKQAAAAAAABJQcmljZUltcGFjdFRvb0hpZ2gAAAAAABUAAAA4Q3VtdWxhdGl2ZSBzYW1lLWxlZGdlciBtb3ZlbWVudCB3b3VsZCBleGNlZWQgYGJhbmRfYnBzYC4AAAARUHJpY2VCYW5kRXhjZWVkZWQAAAAAAAAWAAAAAAAAAA9Ob1BlbmRpbmdXaXJpbmcAAAAAFwAAAAAAAAANSW52YWxpZFdpcmluZwAAAAAAABgAAABEYGFjY2VwdF9hZG1pbmAvYGNhbmNlbF9hZG1pbl90cmFuc2ZlcmAgY2FsbGVkIHdpdGggbm90aGluZyBwcm9wb3NlZC4AAAAOTm9QZW5kaW5nQWRtaW4AAAAAABkAAABDQSBwcm9wb3NlZCBhZG1pbiBoYW5kb3ZlciB3YXMgbm90IGFjY2VwdGVkIHdpdGhpbiBpdHMgYGV4cGlyZXNfYXRgLgAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAAaAAAAfWBvYnNlcnZlYCAvIGB0d2FwYCBhc2tlZCBmb3IgYSB0aW1lIG9sZGVyIHRoYW4gZXZlcnkgc3Vydml2aW5nCm9ic2VydmF0aW9uIG9mIHRoZSBtYXJrZXQgKHRoZSByaW5nIGtlZXBzIHRoZSBtb3N0IHJlY2VudCAxNikuAAAAAAAAEU9ic2VydmF0aW9uVG9vT2xkAAAAAAAAGwAAADhgZmluYWxpemVfbWFya2V0YCBjYWxsZWQgYmVmb3JlIHRoZSByZWRlbXB0aW9uIGRlYWRsaW5lLgAAABRSZWRlbXB0aW9uV2luZG93T3BlbgAAABwAAAA/TWFya2V0IGFscmVhZHkgY2xvc2VkIGJ5IGBmaW5hbGl6ZV9tYXJrZXRgOyByZWRlbXB0aW9uIGlzIG92ZXIuAAAAABBSZWRlbXB0aW9uQ2xvc2VkAAAAHQAAALBMZWdhY3kgbWFya2V0IGNyZWF0ZWQgYmVmb3JlIGBTZXR0bGVTdGF0ZWAgZXhpc3RlZDogb3V0c3RhbmRpbmcgc2hhcmVzCmNhbm5vdCBiZSByZWNvbnN0cnVjdGVkIG9uLWNoYWluLCBzbyBpdCBoYXMgbm8gZGVhZGxpbmUgYW5kIGNhbm5vdCBiZQpmaW5hbGl6ZWQgKHN0aWxsIGZ1bGx5IHJlZGVlbWFibGUpLgAAAAxOb3RTdXBwb3J0ZWQAAAAeAAAAPUEgYmF0Y2ggY2FsbCBjYXJyaWVkIG5vIGlkcyBvciBtb3JlIHRoYW4gYE1BWF9CQVRDSGAgb2YgdGhlbS4AAAAAAAANQmF0Y2hUb29MYXJnZQAAAAAAAB8AAACISW5ib3VuZCBjb2xsYXRlcmFsIHRyYW5zZmVyIGRlbGl2ZXJlZCBmZXdlciAob3IgZGlmZmVyZW50KSB1bml0cyB0aGFuCmV4cGVjdGVkLCBlLmcuIGEgZmVlLW9uLXRyYW5zZmVyIG9yIHVuZGVyLWRlbGl2ZXJpbmcgdG9rZW4gKCMxMzcpLgAAABNDb2xsYXRlcmFsU2hvcnRmYWxsAAAAACA=",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAABGU25hcHNob3Qgb2YgdGhlIGZlZSBhdCBjcmVhdGlvbiBzbyBsYXRlciBjb25maWcgY2hhbmdlcyBuZXZlciBtb3ZlIGl0LgAAAAAAB2ZlZV9icHMAAAAABAAAACZUcmFkaW5nIGZlZXMgd2FpdGluZyBmb3IgYHN3ZWVwX2ZlZXNgLgAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAA4Q3JlYXRvciBoYXMgd2l0aGRyYXduIHRoZSBwb29sIHJlbWFpbmRlciBhZnRlciBmaW5hbGl0eS4AAAAKbHBfY2xhaW1lZAAAAAAAAQAAAChJUEZTIENJRCAvIFVSSSBvZiB0aGUgcXVlc3Rpb24gbWV0YWRhdGEuAAAACG1ldGFfdXJpAAAAEAAAAIZzaGEyNTYgb2YgdGhlIGNhbm9uaWNhbCBxdWVzdGlvbiBKU09OIHN0b3JlZCBvZmYtY2hhaW4gKElQRlMpLCBzbyBhCmNsaWVudCBjYW4gcHJvdmUgdGhlIHRleHQgaXQgc2hvd3MgaXMgdGhlIHRleHQgdGhhdCB3YXMgY29tbWl0dGVkLgAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAALcmVzZXJ2ZV95ZXMAAAAACwAAAS9Db21taXRtZW50IHRvIGhvdyB0aGlzIG1hcmtldCB3aWxsIGJlIHJlc29sdmVkLCBmaXhlZCBhdCBjcmVhdGlvbiBzbwp0aGUgY3JlYXRvciBjYW5ub3QgcGljayBmYXZvcmFibGUgcmVzb2x1dGlvbiBydWxlcyBhZnRlciBzZWVpbmcKdHJhZGluZyBhY3Rpdml0eS4gVGhlIHJlc29sdmVyIGNvbnRyYWN0IHZlcmlmaWVzIGEgcmV2ZWFsZWQgc3BlYwphZ2FpbnN0IHRoaXMgaGFzaCBiZWZvcmUgY29uZmlndXJpbmcgaXRzZWxmIGZvciB0aGUgbWFya2V0LiBTZWUKYGRvY3MvYWRyLzAwMDEtcmVzb2x1dGlvbi1jb21taXRtZW50Lm1kYC4AAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAEBDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuAAAAC3NldHNfbWludGVkAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxNYXJrZXRTdGF0dXM=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAFgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAAD1BlbmRpbmdSZXNvbHZlcgAAAAAAAAAAAAAAAA9QZW5kaW5nVHJlYXN1cnkAAAAAAAAAAAAAAAANRGVmYXVsdEZlZUJwcwAAAAAAAAAAAAAAAAAAE1Byb3RvY29sRmVlU2hhcmVCcHMAAAAAAAAAAAAAAAAORGVmYXVsdEJyZWFrZXIAAAAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAAAAAAAAAAAGTmV4dElkAAAAAAAAAAAAAAAAABREZWZhdWx0UmVkZWVtSG9yaXpvbgAAAAEAAAAAAAAABk1hcmtldAAAAAAAAQAAAAYAAAABAAAAAAAAAAhQb3NpdGlvbgAAAAIAAAAGAAAAEwAAAAEAAAAAAAAABlNldHRsZQAAAAAAAQAAAAYAAAABAAAAAAAAAAZPcmFjbGUAAAAAAAEAAAAGAAAAAQAAAAAAAAADT2JzAAAAAAIAAAAGAAAABAAAAAEAAAAAAAAACEZlZVRlcm1zAAAAAQAAAAYAAAABAAAAAAAAAAZMcEZlZXMAAAAAAAEAAAAGAAAAAQAAAAAAAAAHQnJlYWtlcgAAAAABAAAABgAAAAEAAAAAAAAABEJhbmQAAAABAAAABg==",
>>>>>>> upstream/develop
        "AAAAAQAAAahGZWUgZGVzdGluYXRpb24gYW5kIHNwbGl0LCBzbmFwc2hvdHRlZCBwZXIgbWFya2V0IGF0IGNyZWF0aW9uIGFzIGEgc2lkZQplbnRyeSAoYERhdGFLZXk6OkZlZVRlcm1zYCkgc28gYE1hcmtldGAncyBYRFIgc2hhcGUgbmV2ZXIgY2hhbmdlcy4KCk1hcmtldHMgY3JlYXRlZCBiZWZvcmUgdGhpcyBlbnRyeSBleGlzdGVkIGhhdmUgbm8gYEZlZVRlcm1zYCBhbmQga2VlcCB0aGUKbGVnYWN5IGJlaGF2aW91cjogYHN3ZWVwX2ZlZXNgIHBheXMgd2hhdGV2ZXIgYERhdGFLZXk6OlRyZWFzdXJ5YCBob2xkcyBhdApzd2VlcCB0aW1lLCB3aXRoIHRoZSBwcm90b2NvbCBrZWVwaW5nIDEwMCUgb2YgdGhlIGZlZS4gVGhhdCBmYWxsYmFjayBpcwpkb2N1bWVudGVkIGluIGBzd2VlcF9mZWVzYCBhbmQgbWFrZXMgdGhlIHVwZ3JhZGUgbWlncmF0aW9uLWZyZWUuAAAAAAAAAAhGZWVUZXJtcwAAAAIAAACGUHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIHRyYWRlIGZlZSBpbiBicHM7IHRoZSByZXN0IGlzIHRoZSBMUCdzLgowLi49QlBTLiBBdCBCUFMgKHRoZSBkZWZhdWx0KSB0aGUgc3BsaXQgaXMgZXhhY3RseSB0b2RheSdzIGJlaGF2aW91ci4AAAAAABJwcm90b2NvbF9zaGFyZV9icHMAAAAAAAQAAAB7V2hlcmUgdGhlIHByb3RvY29sJ3MgZmVlIHNoYXJlIGlzIHN3ZXB0LiBGcm96ZW4gYXQgY3JlYXRpb246IGxhdGVyCmBzZXRfdHJlYXN1cnlgIGNhbGxzIG5ldmVyIHJlZGlyZWN0IGZlZXMgYWxyZWFkeSBlYXJuZWQuAAAAAAlyZWNpcGllbnQAAAAAAAAT",
        "AAAAAQAAAAAAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAAAAAACbm8AAAAAAAsAAAAAAAAAA3llcwAAAAAL",
        "AAAABQAAAAAAAAAAAAAACFJlZGVlbWVkAAAAAQAAAAhyZWRlZW1lZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAADNUZW1wb3JhcnkgKG9uZSBsZWRnZXIpIGJhbmQgcmVmZXJlbmNlIGZvciBhIG1hcmtldC4AAAAAAAAAAAlCYW5kU3RhdGUAAAAAAAACAAAAAAAAAApsZWRnZXJfc2VxAAAAAAAEAAAAAAAAAA1yZWZfcHJpY2VfYnBzAAAAAAAABA==",
        "AAAAAQAAAD5PbmUgbWFya2V0J3Mgb3V0Y29tZSBpbnNpZGUgYSBgQmF0Y2hSZXN1bHRgLCBpbiByZXF1ZXN0IG9yZGVyLgAAAAAAAAAAAAlCYXRjaEl0ZW0AAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAtCYXRjaFN0YXR1cwA=",
<<<<<<< HEAD
        "AAAAAgAAAAAAAAAAAAAACUxpZmVjeWNsZQAAAAAAAAMAAAAAAAAAAAAAAARPcGVuAAAAAAAAAAAAAAAFRmluYWwAAAAAAAAAAAAAAAAAAAZDbG9zZWQAAA==",
        "AAAAAAAAAdRgYnV5YCBwbHVzIGEgZGVhZGxpbmUgKGBlbnYubGVkZ2VyKCkudGltZXN0YW1wKClgIHNlY29uZHMg4oCUIG5ldHdvcmsKdGltZSwgbm90IHRoZSBjbGllbnQgY2xvY2spIGFuZCBhbiBhdmVyYWdlLXByaWNlIGxpbWl0CihgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUzsgMCA9IG5vIGxpbWl0KS4KClRoZSBhdmVyYWdlIHByaWNlIGluY2x1ZGVzIHRoZSBmZWUgKGBmZWVgIGlzIHBhcnQgb2YgYGNvbGxhdGVyYWxfaW5gKQphbmQsIGZvciBhIE5PIGJ1eSwgaXMgY29tcGFyZWQgYWdhaW5zdCB0aGUgTk8gcHJpY2UuIEJlY2F1c2UgdGhlCmRlYWRsaW5lIGNoZWNrIHJ1bnMgYmVmb3JlIGByZXF1aXJlX2F1dGhgLCBhbiBleHBpcmVkIHRyYW5zYWN0aW9uCmZhaWxzIGNoZWFwbHkuIEEgbGltaXQgYWJvdmUgQlBTIGNhbiBuZXZlciBwYXNzIGZvciBhIGJ1eSBhbmQgaXMKcmVqZWN0ZWQgYXMgaW52YWxpZC4AAAAGYnV5X3YyAAAAAAAHAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAACVWMSBldmVudDogbWFya2V0IHBhdXNlIHN0YXRlIGNoYW5nZWQuAAAAAAAAAAAAAAlQYXVzZWRTZXQAAAAAAAABAAAACnBhdXNlZF9zZXQAAAAAAAIAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAACk1hcmtldFZpZXcAAAAAAAMAAAAAAAAACWxpZmVjeWNsZQAAAAAAB9AAAAAJTGlmZWN5Y2xlAAAAAAAAAAAAAAZtYXJrZXQAAAAAB9AAAAAGTWFya2V0AAAAAAAAAAAAD3JlZGVlbV9kZWFkbGluZQAAAAPoAAAABg==",
        "AAAAAgAAAM9XaHkgYSBtYXJrZXQgaW4gYSBiYXRjaCBjYWxsIGRpZCBub3Qgc2V0dGxlLiBgRHVwbGljYXRlYCBpcyByZXNlcnZlZDoKaWRzIGFyZSB2YWxpZGF0ZWQgc3RyaWN0bHkgYXNjZW5kaW5nIGZpcnN0LCBzbyBhIGR1cGxpY2F0ZSBpcyByZWplY3RlZAphcyBgSW52YWxpZEFtb3VudGAgYmVmb3JlIHRoZSBiYXRjaCBydW5zIGFuZCBuZXZlciByZWFjaGVzIGEgc2tpcC4AAAAAAAAAAApTa2lwUmVhc29uAAAAAAAHAAAAAAAAAAAAAAAITm90Rm91bmQAAAAAAAAAAAAAAAhOb3RGaW5hbAAAAAAAAAAAAAAAD05vdGhpbmdUb1JlZGVlbQAAAAAAAAAAAAAAAA5BbHJlYWR5Q2xhaW1lZAAAAAAAAAAAAAAAAAAKTm90Q3JlYXRvcgAAAAAAAAAAAAAAAAAJRHVwbGljYXRlAAAAAAAAAAAAAAAAAAAGQ2xvc2VkAAA=",
        "AAAAAAAAAiRDdW11bGF0aXZlIFlFUy1wcmljZS1zZWNvbmRzIGFzIG9mIGBub3cgLSBzZWNvbmRzX2Fnb2AuCgpUaGUgYWNjdW11bGF0b3IgaXMgcGllY2V3aXNlIGxpbmVhciBpbiB0aW1lICh0aGUgcHJpY2Ugb25seSBtb3ZlcyB3aGVuCmEgdHJhZGUgbGFuZHMpLCBzbyBiZXR3ZWVuIG9ic2VydmF0aW9ucyB0aGUgdmFsdWUgaXMgaW50ZXJwb2xhdGVkCmFsb25nIHRoZSBjaG9yZCwgYW5kIHRpbWVzIGFmdGVyIHRoZSBsYXN0IHRyYWRlIGV4dHJhcG9sYXRlIGF0IHRoZQpsYXN0IHRyYWRlZCBwcmljZS4gRmFpbHMgd2l0aCBgT2JzZXJ2YXRpb25Ub29PbGRgIHdoZW4gYHNlY29uZHNfYWdvYApyZWFjaGVzIGJlZm9yZSB0aGUgb2xkZXN0IHN1cnZpdmluZyBvYnNlcnZhdGlvbiAodGhlIHJpbmcga2VlcHMgdGhlCm1vc3QgcmVjZW50IDE2KSwgYW5kIHdpdGggYE5vdFN1cHBvcnRlZGAgZm9yIG1hcmtldHMgY3JlYXRlZCBiZWZvcmUKdGhlIGFjY3VtdWxhdG9yIGV4aXN0ZWQuIEEgbWlzc2luZyAoYXJjaGl2ZWQpIHJpbmcgc2xvdCBpcyBza2lwcGVkLApuZXZlciBhIHBhbmljLgAAAAdvYnNlcnZlAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAC3NlY29uZHNfYWdvAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAWxgc2VsbGAgcGx1cyBhIGRlYWRsaW5lIChsZWRnZXIgdGltZXN0YW1wLCBzZWNvbmRzKSBhbmQgYSBtaW5pbXVtCmF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUykuCgpBIHplcm8gbGltaXQgaXMgdHJpdmlhbGx5IHNhdGlzZmllZCBmb3Igc2VsbHMg4oCUIHVubGlrZSBidXlzLCB3aGVyZSAwCm1lYW5zICJubyBsaW1pdCIg4oCUIGFuZCBhIGxpbWl0IGFib3ZlIEJQUyBjYW4gbmV2ZXIgcGFzcywgc28gbmVpdGhlcgpuZWVkcyBhIHNwZWNpYWwgY2FzZS4gVGhlIGF2ZXJhZ2UgaW5jbHVkZXMgdGhlIGZlZSwgd2hpY2ggdGhlIHRyYWRlcgpwYXlzIG91dCBvZiB0aGUgZ3Jvc3MuAAAAB3NlbGxfdjIAAAAABwAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
=======
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAACVWMSBldmVudDogbWFya2V0IHBhdXNlIHN0YXRlIGNoYW5nZWQuAAAAAAAAAAAAAAlQYXVzZWRTZXQAAAAAAAABAAAACnBhdXNlZF9zZXQAAAAAAAIAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAAAAAAC",
        "AAAAAgAAAM9XaHkgYSBtYXJrZXQgaW4gYSBiYXRjaCBjYWxsIGRpZCBub3Qgc2V0dGxlLiBgRHVwbGljYXRlYCBpcyByZXNlcnZlZDoKaWRzIGFyZSB2YWxpZGF0ZWQgc3RyaWN0bHkgYXNjZW5kaW5nIGZpcnN0LCBzbyBhIGR1cGxpY2F0ZSBpcyByZWplY3RlZAphcyBgSW52YWxpZEFtb3VudGAgYmVmb3JlIHRoZSBiYXRjaCBydW5zIGFuZCBuZXZlciByZWFjaGVzIGEgc2tpcC4AAAAAAAAAAApTa2lwUmVhc29uAAAAAAAGAAAAAAAAAAAAAAAITm90Rm91bmQAAAAAAAAAAAAAAAhOb3RGaW5hbAAAAAAAAAAAAAAAD05vdGhpbmdUb1JlZGVlbQAAAAAAAAAAAAAAAA5BbHJlYWR5Q2xhaW1lZAAAAAAAAAAAAAAAAAAKTm90Q3JlYXRvcgAAAAAAAAAAAAAAAAAJRHVwbGljYXRlAAAA",
>>>>>>> upstream/develop
        "AAAAAQAAAJtSZXN1bHQgb2YgYHJlZGVlbV9tYW55YCAvIGBjbGFpbV9wb29sX3JlbWFpbmRlcnNgOiBgdG90YWxgIGlzIHRoZSBzaW5nbGUKYWdncmVnYXRlZCB0cmFuc2ZlciwgYGl0ZW1zYCBoYXMgb25lIGVudHJ5IHBlciByZXF1ZXN0ZWQgbWFya2V0IGluIHRoZQpzYW1lIG9yZGVyLgAAAAAAAAAAC0JhdGNoUmVzdWx0AAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAJQmF0Y2hJdGVtAAAAAAAAAAAAAAV0b3RhbAAAAAAAAAs=",
        "AAAAAgAAAs9QZXItbWFya2V0IHJlc3VsdCBvZiBhIGJhdGNoIHNldHRsZW1lbnQuCgpUaGlzIHVuaW9uIHN0YW5kcyBpbiBmb3IgdGhlIGBPcHRpb248U2tpcFJlYXNvbj5gIHNrZXRjaGVkIGluIHRoZSBpc3N1ZToKYSBgI1tjb250cmFjdHR5cGVdYCBzdHJ1Y3QgZmllbGQgb2YgdHlwZSBgT3B0aW9uPEN1c3RvbVR5cGU+YCBkb2VzIG5vdApjb21waWxlIHVuZGVyIHRoZSBgdGVzdHV0aWxzYCBmZWF0dXJlIChvbiBmb3IgZXZlcnkgYGNhcmdvIHRlc3RgIGJ1aWxkKS4KVGhlIGRlcml2ZSBlbWl0cyBhbiB4ZHIgY29udmVyc2lvbiBnYXRlZCBvbiBgQ3VzdG9tVHlwZTogSW50bzxTY1ZhbD5gLApidXQgYCNbY29udHJhY3R0eXBlXWAgZW51bXMgb25seSBkZXJpdmUgYFRyeUZyb21gLCBhbmQgdGhlIG1pc3NpbmcgaW1wbHMKY2Fubm90IGJlIHN1cHBsaWVkIGZyb20gdGhpcyBjcmF0ZTogYEZyb208RW51bT4gZm9yIFNjVmFsYCBjb2xsaWRlcyB3aXRoCnRoZSBkZXJpdmUncyBvd24gYFRyeUZyb21gIHRocm91Z2ggY29yZSdzIGJsYW5rZXQgaW1wbCAoRTAxMTkpLCBhbmQKYFRyeUZyb208Jk9wdGlvbjxFbnVtPj4gZm9yIFNjVmFsYCB2aW9sYXRlcyB0aGUgb3JwaGFuIHJ1bGUgKEUwMTE3KS4KVGhlIHVuaW9uIGNhcnJpZXMgdGhlIHNhbWUgaW5mb3JtYXRpb24gYW5kIHN1cmZhY2VzIGFzIGEgZGlzY3JpbWluYXRlZAp1bmlvbiBpbiB0aGUgZ2VuZXJhdGVkIFRTIGJpbmRpbmdzLgAAAAAAAAAAC0JhdGNoU3RhdHVzAAAAAAIAAAAAAAAAMFRoZSBtYXJrZXQgc2V0dGxlZCBhbmQgcGFpZCBgQmF0Y2hJdGVtOjpwYXlvdXRgLgAAAAdTZXR0bGVkAAAAAAEAAAAxVGhlIG1hcmtldCB3YXMgc2tpcHBlZDsgYEJhdGNoSXRlbTo6cGF5b3V0YCBpcyAwLgAAAAAAAAdTa2lwcGVkAAAAAAEAAAfQAAAAClNraXBSZWFzb24AAA==",
        "AAAAAQAAAEZPbmUgcG9pbnQgaW4gdGhlIFRXQVAgcmluZyBidWZmZXIuIEF0IG1vc3Qgb25lIHBlciBkaXN0aW5jdCB0aW1lc3RhbXAuAAAAAAAAAAAAC09ic2VydmF0aW9uAAAAAAIAAAArYE9yYWNsZVN0YXRlOjpwcmljZV9jdW11bGF0aXZlYCBhcyBvZiBgdHNgLgAAAAAKY3VtdWxhdGl2ZQAAAAAACwAAAAAAAAACdHMAAAAAAAY=",
        "AAAAAQAAA8FQZXItbWFya2V0IFRXQVAgYWNjdW11bGF0b3IgKGlzc3VlICMxMSkuIExpdmVzIGluIGl0cyBvd24gZW50cnkgc28gdGhlCmBNYXJrZXRgIFhEUiBzdGF5cyB1bmNoYW5nZWQuCgpTZW1hbnRpY3M6IGF0IHRoZSBzdGFydCBvZiBldmVyeSB0cmFkZSB0aGUgcHJpY2UgdGhhdCBoZWxkIHNpbmNlIHRoZSBsYXN0CnRyYWRlIGlzIGZvbGRlZCBpbnRvIGBwcmljZV9jdW11bGF0aXZlYCBvdmVyIHRoZSBlbGFwc2VkIGludGVydmFsOyB0aGUKcG9zdC10cmFkZSBwcmljZSB0aGVuIGJlY29tZXMgYGxhc3RfcHJpY2VfYnBzYCB1bnRpbCB0aGUgbmV4dCB0cmFkZS4gVGhhdAppcyB0aGUgVW5pc3dhcC12MiBtb2RlbCwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgbWFuaXB1bGF0aW9uIGV4cGVuc2l2ZSDigJQKbW92aW5nIHRoZSBhdmVyYWdlIHJlcXVpcmVzIGhvbGRpbmcgdGhlIHByaWNlIGF3YXkgZnJvbSBmYWlyIHZhbHVlIGFjcm9zcwpvbmUgb3IgbW9yZSBsZWRnZXIgYm91bmRhcmllcywgbm90IGp1c3Qgd2l0aGluIGEgc2luZ2xlIHRyYW5zYWN0aW9uLgoKT3ZlcmZsb3cgYW5hbHlzaXM6IGBsYXN0X3ByaWNlX2JwcyA8PSAxMF8wMDBgIGFuZCBlYWNoIGludGVydmFsIGFkZHMKYHByaWNlICogZHRgIHNlY29uZHMuIEEgMTAwLXllYXIgbWFya2V0IGxpZmV0aW1lIGFjY3VtdWxhdGVzIGF0IG1vc3QKYDEwXzAwMCAqIDMuMmU5IH4gMy4yZTEzYDsgZXZlbiBhIHBhdGhvbG9naWNhbCBgZHQgPSB1NjQ6Ok1BWGAgZ2l2ZXMKYDEuOGUxOSAqIDFlNCA9IDEuOGUyM2AuIGBpMTI4OjpNQVhgIGlzIH4xLjdlMzgsIHNvIHRoZXJlIGlzIG5vIGZlYXNpYmxlCmxpZmV0aW1lIHRoYXQgb3ZlcmZsb3dzIOKAlCBhbmQgZXZlcnkgc3RlcCBpcyBgY2hlY2tlZF8qYCBhbnl3YXksIHNvIGEKdmlvbGF0aW9uIHJlamVjdHMgdGhlIHRyYW5zYWN0aW9uIGluc3RlYWQgb2YgY29ycnVwdGluZyB0aGUgYWNjdW11bGF0b3IuAAAAAAAAAAAAAAtPcmFjbGVTdGF0ZQAAAAAFAAAALVlFUyBwcmljZSBpbiBicHMgYXMgb2YgdGhlIG1vc3QgcmVjZW50IHRyYWRlLgAAAAAAAA5sYXN0X3ByaWNlX2JwcwAAAAAABAAAAIZUaW1lc3RhbXAgdGhlIGFjY3VtdWxhdG9yIHdhcyBsYXN0IGFkdmFuY2VkIHRvICh0aGUgdGltZXN0YW1wIG9mIHRoZQptb3N0IHJlY2VudCB0cmFkZSkuIFRoZSBsYXN0IHRyYWRlZCBwcmljZSBob2xkcyBmcm9tIGhlcmUgb253YXJkLgAAAAAAB2xhc3RfdHMAAAAABgAAADVPYnNlcnZhdGlvbnMgd3JpdHRlbiBzbyBmYXIsIGNhcHBlZCBhdCBgT1JBQ0xFX1JJTkdgLgAAAAAAAAlvYnNfY291bnQAAAAAAAAEAAAAOVJpbmcgc2xvdCBvZiB0aGUgbmV3ZXN0IG9ic2VydmF0aW9uLCBpbiBgMC4uT1JBQ0xFX1JJTkdgLgAAAAAAAAlvYnNfaW5kZXgAAAAAAAAEAAAAQVJ1bm5pbmcgc3VtIG9mIGBsYXN0X3ByaWNlX2JwcyAqIHNlY29uZHNfZWxhcHNlZGAgc2luY2UgY3JlYXRpb24uAAAAAAAAEHByaWNlX2N1bXVsYXRpdmUAAAAL",
        "AAAAAQAAAGpQZXItbWFya2V0IHNldHRsZW1lbnQgYm9va2tlZXBpbmcgKGlzc3VlICMxNCkuIExpdmVzIGluIGl0cyBvd24gZW50cnkgc28KdGhlIGBNYXJrZXRgIFhEUiBzdGF5cyB1bmNoYW5nZWQuAAAAAAAAAAAAC1NldHRsZVN0YXRlAAAAAAYAAABqYGZpbmFsaXplX21hcmtldGAgaGFzIHN3ZXB0IHRoZSBtYXJrZXQncyByZW1haW5pbmcgYmFsYW5jZTsgbm8KcmVkZW1wdGlvbiBvciBjbGFpbSBjYW4gZXZlciBwYXkgb3V0IGFnYWluLgAAAAAABmNsb3NlZAAAAAAAAQAAAENUaW1lc3RhbXAgb2YgYHJlc29sdmVgIC8gYHZvaWRfbWFya2V0YDsgMCB3aGlsZSB0aGUgbWFya2V0IGlzIE9wZW4uAAAAAAxmaW5hbGl6ZWRfYXQAAAAGAAAAc1JlZGVtcHRpb24gd2luZG93LCBzbmFwc2hvdHRlZCBhdCBjcmVhdGlvbiBmcm9tIHRoZSBhZG1pbiBkZWZhdWx0LgpgcmVkZWVtX2RlYWRsaW5lID0gZmluYWxpemVkX2F0ICsgaG9yaXpvbl9zZWNzYC4AAAAADGhvcml6b25fc2VjcwAAAAYAAAAAAAAADm91dHN0YW5kaW5nX25vAAAAAAALAAAAw091dGNvbWUgc2hhcmVzIGhlbGQgb3V0c2lkZSB0aGUgcG9vbCAodXNlciBwb3NpdGlvbnMpLCBzdGlsbApyZWRlZW1hYmxlLiBgcmVkZWVtYCBkZWNyZW1lbnRzIHRoZSByZWRlZW1pbmcgaG9sZGVyJ3Mgc2hhcmVzIG9uIGJvdGgKc2lkZXMsIHNvIGEgbG9zaW5nLXNpZGUgcmVkZW1wdGlvbiAocGF5b3V0IDApIHN0aWxsIGNsZWFycyBoZXJlLgAAAAAPb3V0c3RhbmRpbmdfeWVzAAAAAAsAAAB7Q29sbGF0ZXJhbCBhbHJlYWR5IHBhaWQgdG8gaG9sZGVycyBhbmQgdGhlIExQIChgcmVkZWVtYCArCmBjbGFpbV9wb29sX3JlbWFpbmRlcmAgcGF5b3V0cyk7IHRyYWNrcyB3aGF0IGhhcyBsZWZ0IHRoZSBtYXJrZXQuAAAAAAhwYWlkX291dAAAAAs=",
        "AAAABQAAALFTYW1lIHN3ZWVwIGFzIGBGZWVzU3dlcHRgIHBsdXMgdGhlIGFjdHVhbCByZWNpcGllbnQuIE5ldyBldmVudCByYXRoZXIKdGhhbiBuZXcgZmllbGRzIHNvIHRoZSBleGlzdGluZyBgRmVlc1N3ZXB0YCBYRFIgc3RheXMgc3RhYmxlIGZvcgppbmRleGVyczsgYm90aCBhcmUgZW1pdHRlZCBvbiBldmVyeSBzd2VlcC4AAAAAAAAAAAAAC0ZlZXNTd2VwdFRvAAAAAAEAAAANZmVlc19zd2VwdF90bwAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAERBIHByb3Bvc2VkIGFkbWluIGhhbmRvdmVyICgjNjIpLiBBYnNlbnQgd2hlbiBubyB0cmFuc2ZlciBpcyBwZW5kaW5nLgAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAgAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAG",
        "AAAAAQAAAMJQZXItbWFya2V0IGNpcmN1aXQgYnJlYWtlcnMsIHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uIGZyb20KYERhdGFLZXk6OkRlZmF1bHRCcmVha2VyYC4gMCBkaXNhYmxlcyBlYWNoIGNoZWNrLiBBIG1hcmtldCB3aXRob3V0IGEKYEJyZWFrZXJgIGVudHJ5IChjcmVhdGVkIGJlZm9yZSBicmVha2VycyBleGlzdGVkKSBpcyBuZXZlciBjaGVja2VkLgAAAAAAAAAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAgAAAERNYXhpbXVtIHxwb3N0LXByaWNlIC0gbGVkZ2VyLW9wZW4gcHJpY2V8IGN1bXVsYXRpdmUgbW92ZW1lbnQgaW4gYnBzLgAAAAhiYW5kX2JwcwAAAAQAAABATWF4aW11bSB8cG9zdC1wcmljZSAtIHByZS1wcmljZXwgYSBzaW5nbGUgdHJhZGUgbWF5IG1vdmUgaW4gYnBzLgAAAA5tYXhfaW1wYWN0X2JwcwAAAAAABA==",
        "AAAABQAAAC5WMSBldmVudDogZGVmYXVsdCBmZWUgZm9yIG5ldyBtYXJrZXRzIGNoYW5nZWQuAAAAAAAAAAAADURlZmF1bHRGZWVTZXQAAAAAAAABAAAAD2RlZmF1bHRfZmVlX3NldAAAAAADAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAABAAAAAAAAAAtvbGRfZmVlX2JwcwAAAAAEAAAAAAAAAAAAAAALbmV3X2ZlZV9icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADUxwRmVlc0NsYWltZWQAAAAAAAABAAAAD2xwX2ZlZXNfY2xhaW1lZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUxwVHJhbnNmZXJyZWQAAAAAAAABAAAADmxwX3RyYW5zZmVycmVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldFJlc29sdmVkAAAAAAABAAAAD21hcmtldF9yZXNvbHZlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAACFOb25lIG1lYW5zIHRoZSBtYXJrZXQgd2FzIHZvaWRlZC4AAAAAAAAHb3V0Y29tZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD01hcmtldEZpbmFsaXplZAAAAAABAAAAEG1hcmtldF9maW5hbGl6ZWQAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAHFFdmVyeXRoaW5nIHN3ZXB0IHRvIHRoZSB0cmVhc3VyeTogZXhwaXJlZCB1c2VyIGNsYWltcywgYW4gdW5jbGFpbWVkCkxQIHJlbWFpbmRlciwgcm91bmRpbmcgZHVzdCBhbmQgYWNjcnVlZCBmZWVzLgAAAAAAAAVzd2VwdAAAAAAAAAsAAAAAAAAAQFRoZSBwYXJ0IG9mIGBzd2VwdGAgdGhhdCB3YXMgcmVzZXJ2ZWQgZm9yIHNoYXJlcyBuZXZlciByZWRlZW1lZC4AAAAOdW5jbGFpbWVkX3VzZXIAAAAAAAsAAAAAAAAAQ1JvdW5kaW5nIGxlZnQgb3ZlciBhZnRlciBwZXItaG9sZGVyIHZvaWQgZmxvb3JzIHdlcmUgYWNjb3VudGVkIGZvci4AAAAABGR1c3QAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1Jlc29sdmVyQ2hhbmdlZAAAAAABAAAAEHJlc29sdmVyX2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyZWFzdXJ5Q2hhbmdlZAAAAAABAAAAEHRyZWFzdXJ5X2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEFJlc29sdmVyUHJvcG9zZWQAAAABAAAAEXJlc29sdmVyX3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEFRyZWFzdXJ5UHJvcG9zZWQAAAABAAAAEXRyZWFzdXJ5X3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAI=",
        "AAAABQAAAIxQb3NpdGlvbnMgbW92ZWQgYmV0d2VlbiBob2xkZXJzLiBJbmRleGVycyB0aGF0IHRyYWNrIGJhbGFuY2VzIGZyb20KYFRyYWRlYC9gUmVkZWVtZWRgIG11c3QgYWxzbyBhcHBseSB0aGlzIGV2ZW50IChzZWUgZG9jcy9hcmNoaXRlY3R1cmUubWQpLgAAAAAAAAATUG9zaXRpb25UcmFuc2ZlcnJlZAAAAAABAAAAFHBvc2l0aW9uX3RyYW5zZmVycmVkAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFBvb2xSZW1haW5kZXJDbGFpbWVkAAAAAQAAABZwb29sX3JlbWFpbmRlcl9jbGFpbWVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAADlQb29sIHJlbWFpbmRlciBwbHVzIGFueSBMUCBmZWVzIGRyYWluZWQgaW4gdGhlIHNhbWUgY2FsbC4AAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAABQAAAEJWMSBldmVudDogcG9vbCByZW1haW5kZXIgY2xhaW1lZCBieSBjcmVhdG9yIGFmdGVyIG1hcmtldCBmaW5hbGl0eS4AAAAAAAAAAAAWUG9vbFJlbWFpbmRlckNsYWltZWRWMQAAAAAAAQAAABlwb29sX3JlbWFpbmRlcl9jbGFpbWVkX3YxAAAAAAAABAAAAAAAAAAHdmVyc2lvbgAAAAAEAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAAAAAAABnBheW91dAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAF1Byb3RvY29sRmVlU2hhcmVDaGFuZ2VkAAAAAAEAAAAacHJvdG9jb2xfZmVlX3NoYXJlX2NoYW5nZWQAAAAAAAIAAAAAAAAAA29sZAAAAAAEAAAAAAAAAAAAAAADbmV3AAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAAPdTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4KCkxlZ2FjeSBlbnRyeXBvaW50OiBubyBkZWFkbGluZSBhbmQgbm8gbGltaXQgcHJpY2UsIHNvIGEgc2lnbmVkIGJvdW5kCmNhbiBleGVjdXRlIGF0IGFueSBsYXRlciB0aW1lLiBQcmVmZXIgYGJ1eV92MmAuAAAAAANidXkAAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAVZSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgoKTGVnYWN5IGVudHJ5cG9pbnQ6IG5vIGRlYWRsaW5lIGFuZCBubyBsaW1pdCBwcmljZS4gUHJlZmVyIGBzZWxsX3YyYC4AAAAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAUxUaW1lLXdlaWdodGVkIGF2ZXJhZ2UgWUVTIHByaWNlIGluIGJwcyBvdmVyIHRoZSB0cmFpbGluZwpgd2luZG93X3NlY3NgLCBmbG9vcmVkLiBSZWplY3RzIGEgemVybyB3aW5kb3cgKGBJbnZhbGlkQW1vdW50YCkuCkEgd2luZG93IHJlYWNoaW5nIGJlZm9yZSB0aGUgb2xkZXN0IG9ic2VydmF0aW9uIGZhaWxzIHdpdGgKYE9ic2VydmF0aW9uVG9vT2xkYDsgYSB3aW5kb3cgZXh0ZW5kaW5nIHBhc3QgYGNsb3NlX3RpbWVgIGtlZXBzCmF2ZXJhZ2luZyB0aGUgZmluYWwgcHJpY2UsIGJlY2F1c2UgdGhlIGFjY3VtdWxhdG9yIG9ubHkgbW92ZXMgd2hlbgp0cmFkZXMgYXJlIHBvc3NpYmxlLgAAAAR0d2FwAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALd2luZG93X3NlY3MAAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAdRgYnV5YCBwbHVzIGEgZGVhZGxpbmUgKGBlbnYubGVkZ2VyKCkudGltZXN0YW1wKClgIHNlY29uZHMg4oCUIG5ldHdvcmsKdGltZSwgbm90IHRoZSBjbGllbnQgY2xvY2spIGFuZCBhbiBhdmVyYWdlLXByaWNlIGxpbWl0CihgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUzsgMCA9IG5vIGxpbWl0KS4KClRoZSBhdmVyYWdlIHByaWNlIGluY2x1ZGVzIHRoZSBmZWUgKGBmZWVgIGlzIHBhcnQgb2YgYGNvbGxhdGVyYWxfaW5gKQphbmQsIGZvciBhIE5PIGJ1eSwgaXMgY29tcGFyZWQgYWdhaW5zdCB0aGUgTk8gcHJpY2UuIEJlY2F1c2UgdGhlCmRlYWRsaW5lIGNoZWNrIHJ1bnMgYmVmb3JlIGByZXF1aXJlX2F1dGhgLCBhbiBleHBpcmVkIHRyYW5zYWN0aW9uCmZhaWxzIGNoZWFwbHkuIEEgbGltaXQgYWJvdmUgQlBTIGNhbiBuZXZlciBwYXNzIGZvciBhIGJ1eSBhbmQgaXMKcmVqZWN0ZWQgYXMgaW52YWxpZC4AAAAGYnV5X3YyAAAAAAAHAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAiRDdW11bGF0aXZlIFlFUy1wcmljZS1zZWNvbmRzIGFzIG9mIGBub3cgLSBzZWNvbmRzX2Fnb2AuCgpUaGUgYWNjdW11bGF0b3IgaXMgcGllY2V3aXNlIGxpbmVhciBpbiB0aW1lICh0aGUgcHJpY2Ugb25seSBtb3ZlcyB3aGVuCmEgdHJhZGUgbGFuZHMpLCBzbyBiZXR3ZWVuIG9ic2VydmF0aW9ucyB0aGUgdmFsdWUgaXMgaW50ZXJwb2xhdGVkCmFsb25nIHRoZSBjaG9yZCwgYW5kIHRpbWVzIGFmdGVyIHRoZSBsYXN0IHRyYWRlIGV4dHJhcG9sYXRlIGF0IHRoZQpsYXN0IHRyYWRlZCBwcmljZS4gRmFpbHMgd2l0aCBgT2JzZXJ2YXRpb25Ub29PbGRgIHdoZW4gYHNlY29uZHNfYWdvYApyZWFjaGVzIGJlZm9yZSB0aGUgb2xkZXN0IHN1cnZpdmluZyBvYnNlcnZhdGlvbiAodGhlIHJpbmcga2VlcHMgdGhlCm1vc3QgcmVjZW50IDE2KSwgYW5kIHdpdGggYE5vdFN1cHBvcnRlZGAgZm9yIG1hcmtldHMgY3JlYXRlZCBiZWZvcmUKdGhlIGFjY3VtdWxhdG9yIGV4aXN0ZWQuIEEgbWlzc2luZyAoYXJjaGl2ZWQpIHJpbmcgc2xvdCBpcyBza2lwcGVkLApuZXZlciBhIHBhbmljLgAAAAdvYnNlcnZlAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAC3NlY29uZHNfYWdvAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAWxgc2VsbGAgcGx1cyBhIGRlYWRsaW5lIChsZWRnZXIgdGltZXN0YW1wLCBzZWNvbmRzKSBhbmQgYSBtaW5pbXVtCmF2ZXJhZ2UgZXhlY3V0aW9uIHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCBwZXIgc2hhcmUsIDEuMCA9IEJQUykuCgpBIHplcm8gbGltaXQgaXMgdHJpdmlhbGx5IHNhdGlzZmllZCBmb3Igc2VsbHMg4oCUIHVubGlrZSBidXlzLCB3aGVyZSAwCm1lYW5zICJubyBsaW1pdCIg4oCUIGFuZCBhIGxpbWl0IGFib3ZlIEJQUyBjYW4gbmV2ZXIgcGFzcywgc28gbmVpdGhlcgpuZWVkcyBhIHNwZWNpYWwgY2FzZS4gVGhlIGF2ZXJhZ2UgaW5jbHVkZXMgdGhlIGZlZSwgd2hpY2ggdGhlIHRyYWRlcgpwYXlzIG91dCBvZiB0aGUgZ3Jvc3MuAAAAB3NlbGxfdjIAAAAABwAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAAAAAAPbGltaXRfcHJpY2VfYnBzAAAAAAQAAAAAAAAACGRlYWRsaW5lAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAD9TcG90IHByaWNlIG9mIGBvdXRjb21lYCBpbiBicHMgKDAuLj0xMF8wMDApLiBZRVMgKyBOTyB+IDEwXzAwMC4AAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAAJaXNfY2xvc2VkAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAB",
        "AAAAAAAAAMhMYXJnZXN0IGFjY2VwdGVkIGBtYXJrZXRfaWRzYCBsZW5ndGggZm9yIGByZWRlZW1fbWFueWAgLwpgY2xhaW1fcG9vbF9yZW1haW5kZXJzYC4gRnJvbnRlbmRzIHNob3VsZCBjaHVuayB3b3JrIGludG8gc3RyaWN0bHkKYXNjZW5kaW5nIGJhdGNoZXMgb2YgYXQgbW9zdCB0aGlzIHNpemUgKHNlZQpgZG9jcy9mcm9udGVuZC1pbnRlZ3JhdGlvbi5tZGApLgAAAAltYXhfYmF0Y2gAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADlTaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIHJpZ2h0IG5vdy4AAAAAAAAJcXVvdGVfYnV5AAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=",
        "AAAAAAAAAEVTaGFyZXMgYSBgc2VsbGAgZm9yIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCB3b3VsZCBjb25zdW1lIHJpZ2h0IG5vdy4AAAAAAAAKcXVvdGVfc2VsbAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQpBbnlvbmUgY2FuIG1vdmUgYWNjcnVlZCBwcm90b2NvbCBmZWVzIHRvIHRoZSBtYXJrZXQncyBmZWUgcmVjaXBpZW50LgoKU2VuZHMgdG8gdGhlIHJlY2lwaWVudCBzbmFwc2hvdHRlZCBpbiBgRmVlVGVybXNgIGF0IGNyZWF0aW9uLiBNYXJrZXRzCmNyZWF0ZWQgYmVmb3JlIGBGZWVUZXJtc2AgZXhpc3RlZCBoYXZlIG5vbmUgYW5kIGtlZXAgdGhlIGxlZ2FjeQpiZWhhdmlvdXI6IHRoZSBgRGF0YUtleTo6VHJlYXN1cnlgIG9mIHRoZSBtb21lbnQgb2YgdGhlIHN3ZWVwLgAAAAAACnN3ZWVwX2ZlZXMAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAPVUcnVlIHdoZW4gYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgYmUgcmVqZWN0ZWQgYnkgdGhlCm1hcmtldCdzIGJyZWFrZXJzIHJpZ2h0IG5vdy4gUmVhZC1vbmx5OiBuZXZlciB3cml0ZXMgYmFuZCBzdGF0ZSwgc28Kb24gYSBmcmVzaCBsZWRnZXIgdGhlIHJlZmVyZW5jZSBpcyB0YWtlbiBhcyB0aGUgY3VycmVudCBwcmljZSDigJQgdGhlCnNhbWUgdmFsdWUgYSBzdWJzZXF1ZW50IHJlYWwgdHJhZGUgd291bGQgdXNlLgAAAAAAAAp3b3VsZF90cmlwAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAQAAA+kAAAABAAAAAw==",
<<<<<<< HEAD
        "AAAABQAAAC5WMSBldmVudDogZGVmYXVsdCBmZWUgZm9yIG5ldyBtYXJrZXRzIGNoYW5nZWQuAAAAAAAAAAAADURlZmF1bHRGZWVTZXQAAAAAAAABAAAAD2RlZmF1bHRfZmVlX3NldAAAAAADAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAABAAAAAAAAAAtvbGRfZmVlX2JwcwAAAAAEAAAAAAAAAAAAAAALbmV3X2ZlZV9icHMAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADUxwRmVlc0NsYWltZWQAAAAAAAABAAAAD2xwX2ZlZXNfY2xhaW1lZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUxwVHJhbnNmZXJyZWQAAAAAAAABAAAADmxwX3RyYW5zZmVycmVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAEZnJvbQAAABMAAAAAAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
=======
>>>>>>> upstream/develop
        "AAAAAAAAAopSZWRlZW1zIGBob2xkZXJgJ3MgcG9zaXRpb25zIGFjcm9zcyB1cCB0byBgTUFYX0JBVENIYCBmaW5hbCBtYXJrZXRzCndpdGggb25lIGNvbGxhdGVyYWwgdHJhbnNmZXIuIGBtYXJrZXRfaWRzYCBtdXN0IGJlIHN0cmljdGx5IGFzY2VuZGluZwooYEludmFsaWRBbW91bnRgIG90aGVyd2lzZTsgZW1wdHkgb3Igb3Zlci1jYXAgaXMgYEJhdGNoVG9vTGFyZ2VgKSBzbwp0aGUgZm9vdHByaW50IGlzIGRldGVybWluaXN0aWMgYW5kIGR1cGxpY2F0ZXMgYXJlIGltcG9zc2libGUuCgpNYXJrZXRzIHRoYXQgY2Fubm90IHBheSBkbyBub3QgYWJvcnQgdGhlIGJhdGNoOyB0aGV5IGNvbWUgYmFjayBpbgpgaXRlbXNgIHdpdGggYSBgU2tpcFJlYXNvbmAuIEluIHBhcnRpY3VsYXIgYW4gYXJjaGl2ZWQgYE1hcmtldGAgZW50cnkKaXMgTk9UIGBOb3RGb3VuZGAg4oCUIHRoZSB0cmFuc2FjdGlvbiBmYWlscyBhdCBmb290cHJpbnQgdGltZSBhbmQgdGhlCm1hcmtldCBtdXN0IGJlIHJlc3RvcmVkIGZpcnN0IChzaW11bGF0aW9uIHNob3dzIHRoaXMgYmVmb3JlCnN1Ym1pc3Npb24pLiBgaG9sZGVyLnJlcXVpcmVfYXV0aCgpYCBjb3ZlcnMgdGhlIHdob2xlIGJhdGNoOiB0aGUKc2lnbmVkIHBheWxvYWQgaXMgdGhlIGBtYXJrZXRfaWRzYCB2ZWN0b3IgaXRzZWxmLgAAAAAAC3JlZGVlbV9tYW55AAAAAAIAAAAAAAAABmhvbGRlcgAAAAAAEwAAAAAAAAAKbWFya2V0X2lkcwAAAAAD6gAAAAYAAAABAAAD6QAAB9AAAAALQmF0Y2hSZXN1bHQAAAAAAw==",
        "AAAAAAAAAL9UcmFuc2ZlcnMgdGhlIHNpbmdsZSBMUCByb2xlICh0aGUgcmlnaHQgdG8gYGNsYWltX3Bvb2xfcmVtYWluZGVyYCBhbmQKYGNsYWltX2xwX2ZlZXNgKSB0byBgbmV3X2NyZWF0b3JgLiBPbmx5IHVudGlsIHRoZSByZW1haW5kZXIgaGFzIGJlZW4KY2xhaW1lZDsgYWZ0ZXIgdGhhdCB0aGUgcm9sZSBoYXMgbm8gcmVtYWluaW5nIHZhbHVlLgAAAAALdHJhbnNmZXJfbHAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEFJbnZhbGlkIG9yIHVucmVzb2x2YWJsZSBtYXJrZXQuIEFsbG93ZWQgYW55IHRpbWUgYmVmb3JlIGZpbmFsaXR5LgAAAAAAAAt2b2lkX21hcmtldAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIxSZXR1cm5zIHplcm8gZm9yIGEgY2xvc2VkIG1hcmtldC4gSGlzdG9yaWNhbCBhbW91bnRzIG11c3QgYmUgcmVjb3ZlcmVkCmZyb20gYFJlZGVlbWVkYCwgYFBvc2l0aW9uVHJhbnNmZXJyZWRgLCBhbmQgYE1hcmtldEZpbmFsaXplZGAgZXZlbnRzLgAAAAxnZXRfcG9zaXRpb24AAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAH0AAAAAhQb3NpdGlvbg==",
        "AAAAAAAAAAAAAAAMbWFya2V0X2NvdW50AAAAAAAAAAEAAAAG",
        "AAAAAAAAAHpPdXRzdGFuZGluZy1zaGFyZSBhY2NvdW50aW5nIGZvciBhIG1hcmtldCAoaXNzdWUgIzE0KS4KYE5vdFN1cHBvcnRlZGAgZm9yIG1hcmtldHMgY3JlYXRlZCBiZWZvcmUgdGhpcyBib29ra2VlcGluZyBleGlzdGVkLgAAAAAADHNldHRsZV9zdGF0ZQAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAALU2V0dGxlU3RhdGUAAAAAAw==",
<<<<<<< HEAD
        "AAAABQAAAAAAAAAAAAAAD01hcmtldEZpbmFsaXplZAAAAAABAAAAEG1hcmtldF9maW5hbGl6ZWQAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAHFFdmVyeXRoaW5nIHN3ZXB0IHRvIHRoZSB0cmVhc3VyeTogZXhwaXJlZCB1c2VyIGNsYWltcywgYW4gdW5jbGFpbWVkCkxQIHJlbWFpbmRlciwgcm91bmRpbmcgZHVzdCBhbmQgYWNjcnVlZCBmZWVzLgAAAAAAAAVzd2VwdAAAAAAAAAsAAAAAAAAAQFRoZSBwYXJ0IG9mIGBzd2VwdGAgdGhhdCB3YXMgcmVzZXJ2ZWQgZm9yIHNoYXJlcyBuZXZlciByZWRlZW1lZC4AAAAOdW5jbGFpbWVkX3VzZXIAAAAAAAsAAAAAAAAAQ1JvdW5kaW5nIGxlZnQgb3ZlciBhZnRlciBwZXItaG9sZGVyIHZvaWQgZmxvb3JzIHdlcmUgYWNjb3VudGVkIGZvci4AAAAABGR1c3QAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1Bvc2l0aW9uc1B1cmdlZAAAAAABAAAAEHBvc2l0aW9uc19wdXJnZWQAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFY291bnQAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1Jlc29sdmVyQ2hhbmdlZAAAAAABAAAAEHJlc29sdmVyX2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyZWFzdXJ5Q2hhbmdlZAAAAAABAAAAEHRyZWFzdXJ5X2NoYW5nZWQAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
=======
>>>>>>> upstream/develop
        "AAAAAAAAAQhSdW5zIGF0b21pY2FsbHkgYXQgZGVwbG95IHRpbWUsIHNvIG5vYm9keSBjYW4gZnJvbnQtcnVuIGluaXRpYWxpemF0aW9uLgpgcHJvdG9jb2xfZmVlX3NoYXJlX2Jwc2AgaXMgdGhlIGRlZmF1bHQgcHJvdG9jb2wvTFAgc3BsaXQgZm9yIG5ldwptYXJrZXRzOyAxMF8wMDAga2VlcHMgdGhlIHdob2xlIGZlZSB3aXRoIHRoZSBwcm90b2NvbCAocHJlLXVwZ3JhZGUKYmVoYXZpb3VyKS4gUGFzcyAwIHRvIGdpdmUgYWxsIGZlZXMgdG8gdGhlIG1hcmtldCBjcmVhdG9ycy4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAD2RlZmF1bHRfZmVlX2JwcwAAAAAEAAAAAAAAABZwcm90b2NvbF9mZWVfc2hhcmVfYnBzAAAAAAAEAAAAAA==",
        "AAAAAAAAALpUaGUgY3VycmVudCBsZWRnZXIncyBiYW5kIHJlZmVyZW5jZSwgaWYgYSBiYW5kIGNoZWNrIGhhcyBydW4gdGhpcwpsZWRnZXIuIGBOb25lYCBtZWFucyB0aGUgbmV4dCB0cmFkZSBzZXRzIHRoZSByZWZlcmVuY2UgKHRvIGl0cyBvd24KcHJlLXRyYWRlIHByaWNlLCB3aGljaCBlcXVhbHMgdGhlIGxlZGdlci1vcGVuIHByaWNlKS4AAAAAAA1icmVha2VyX3N0YXRlAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAD6AAAB9AAAAAJQmFuZFN0YXRlAAAAAAAAAw==",
        "AAAAAAAAALVUaGUgY3JlYXRvciAodGhlIExQKSBjbGFpbXMgdGhlaXIgc2hhcmUgb2YgYWNjcnVlZCB0cmFkZSBmZWVzIGF0IGFueQp0aW1lLCBpbmNsdWRpbmcgYmVmb3JlIGZpbmFsaXR5LiBSZXR1cm5zIHRoZSBhbW91bnQgY2xhaW1lZCAoMCB3aGVuCm5vdGhpbmcgaXMgcGVuZGluZywgbWlycm9yaW5nIGBzd2VlcF9mZWVzYCkuAAAAAAAADWNsYWltX2xwX2ZlZXMAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAMhDcmVhdGVzIGEgbWFya2V0IGFuZCBzZWVkcyB0aGUgcG9vbC4gYGNyZWF0b3JgIGJlY29tZXMgdGhlIHNvbGUgTFAuCmBpbml0aWFsX3llc19icHNgIGluIFsxMDAsIDk5MDBdIHNldHMgdGhlIG9wZW5pbmcgWUVTIHByb2JhYmlsaXR5Owp0aGUgY3JlYXRvciByZWNlaXZlcyB0aGUgbGVmdG92ZXIgc2hhcmVzIG9mIHRoZSBsaWtlbGllciBvdXRjb21lLgAAAA1jcmVhdGVfbWFya2V0AAAAAAAACAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAEBUaGUgcGVuZGluZyBhZG1pbiBwcm9wb3NhbCwgaW5jbHVkaW5nIGl0cyBleHBpcnksIGlmIG9uZSBleGlzdHMuAAAADXBlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAfQAAAADFBlbmRpbmdBZG1pbg==",
        "AAAAAAAAAJZTdGFydHMgYSB0d28tc3RlcCBoYW5kb3ZlciBvZiB0aGUgYWRtaW4gcm9sZS4gVGhlIG5ldyBhZG1pbiBtdXN0IGNhbGwKYGFjY2VwdF9hZG1pbmAgaXRzZWxmLCBzbyBhIHR5cG8gY2Fubm90IGhhbmQgY29udHJvbCB0byBhbiBhZGRyZXNzCm5vYm9keSBob2xkcy4AAAAAAA1wcm9wb3NlX2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
<<<<<<< HEAD
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEFJlc29sdmVyUHJvcG9zZWQAAAABAAAAEXJlc29sdmVyX3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEFRyZWFzdXJ5UHJvcG9zZWQAAAABAAAAEXRyZWFzdXJ5X3Byb3Bvc2VkAAAAAAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAI=",
=======
>>>>>>> upstream/develop
        "AAAAAAAAAHpUaGUgbWFya2V0J3Mgc25hcHNob3R0ZWQgYnJlYWtlcnMgKGBOb25lYCBmb3IgbGVnYWN5IG1hcmtldHMgY3JlYXRlZApiZWZvcmUgYnJlYWtlcnMgZXhpc3RlZCDigJQgdGhvc2UgYXJlIG5ldmVyIGNoZWNrZWQpLgAAAAAADmJyZWFrZXJfY29uZmlnAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAPoAAAH0AAAAA1CcmVha2VyQ29uZmlnAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAPYWNjZXB0X3Jlc29sdmVyAAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAPYWNjZXB0X3RyZWFzdXJ5AAAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAA3FQZXJtaXNzaW9ubGVzcyBjbG9zZS1vdXQgb2YgYSBmaW5hbCBtYXJrZXQgYWZ0ZXIgaXRzIHJlZGVtcHRpb24KZGVhZGxpbmUuIFN3ZWVwcyB0aGUgbWFya2V0J3MgZW50aXJlIHJlbWFpbmluZyBiYWxhbmNlIOKAlCB2YWx1ZQpyZXNlcnZlZCBmb3Igc2hhcmVzIG5ldmVyIHJlZGVlbWVkLCBhbiB1bmNsYWltZWQgTFAgcmVtYWluZGVyLApwZXItaG9sZGVyIHJvdW5kaW5nIGR1c3QgYW5kIGFjY3J1ZWQgZmVlcyDigJQgdG8gdGhlIHRyZWFzdXJ5LCBhbmQKbWFya3MgdGhlIG1hcmtldCBjbG9zZWQgc28gbm90aGluZyBjYW4gZXZlciBwYXkgb3V0IGFnYWluLgoKVGhlIGRlYWRsaW5lIGlzIGByZWRlZW1fZGVhZGxpbmUobWFya2V0X2lkKWAgPSBgZmluYWxpemVkX2F0ICsKaG9yaXpvbl9zZWNzYCwgdGhlIGhvcml6b24gYmVpbmcgc25hcHNob3R0ZWQgYXQgY3JlYXRpb24gZnJvbSB0aGUKYWRtaW4gZGVmYXVsdC4gQW55b25lIHdobyByZWRlZW1zIGJlZm9yZSB0aGUgZGVhZGxpbmUgaXMgcGFpZCB0aGUKZXhhY3QgYHNldHRsZV92YWx1ZWAgdGhleSB3b3VsZCBoYXZlIHJlY2VpdmVkIHdpdGhvdXQgdGhpcyBjYWxsOwpvbmx5IHNoYXJlcyBzdGlsbCB1bnJlZGVlbWVkIGF0IHRoZSBkZWFkbGluZSBhcmUgZm9yZmVpdCwgYW5kIHRoZWlyCnZhbHVlIGdvZXMgdG8gdGhlIHRyZWFzdXJ5IHJhdGhlciB0aGFuIHRoZSBMUCBzbyB0aGUgTFAgY2Fubm90CnByb2ZpdCBmcm9tIHN1cHByZXNzaW5nIHJlZGVtcHRpb25zLgoKUmV0dXJucyB0aGUgYW1vdW50IHN3ZXB0LiBUaGUgc3dlcHQgdG90YWwgaXMgZXhhY3RseSB0aGUgbWFya2V0J3MKY29udHJhY3QgYmFsYW5jZTogc2V0cyBwbHVzIGZlZXMgbWludXMgZXZlcnl0aGluZyBhbHJlYWR5IHBhaWQgb3V0LgAAAAAAAA9maW5hbGl6ZV9tYXJrZXQAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAIlSZXR1cm5zIHRoZSBtYXJrZXQgYW5kIGl0cyBsaWZlY3ljbGUuIEludGVncmF0b3JzIG11c3QgdXNlIHRoaXMgdmlldwpyYXRoZXIgdGhhbiBgZ2V0X21hcmtldGAgd2hlbiBkZWNpZGluZyB3aGV0aGVyIHBvc2l0aW9ucyBoYXZlIHZhbHVlLgAAAAAAAA9nZXRfbWFya2V0X3ZpZXcAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApNYXJrZXRWaWV3AAAAAAAD",
        "AAAAAAAAAOBUaW1lc3RhbXAgYWZ0ZXIgd2hpY2ggdW5yZWRlZW1lZCBzaGFyZXMgYXJlIGZvcmZlaXQgKHNlZQpgZmluYWxpemVfbWFya2V0YCkuIGBOb25lYCB3aGlsZSB0aGUgbWFya2V0IGlzIHN0aWxsIE9wZW4g4oCUIGl0cwpkZWFkbGluZSBpcyBub3Qga25vd24geWV0IOKAlCBhbmQgZm9yIGxlZ2FjeSBtYXJrZXRzLCB3aGljaCBoYXZlIG5vCmRlYWRsaW5lIGFuZCBjYW5ub3QgYmUgZmluYWxpemVkLgAAAA9yZWRlZW1fZGVhZGxpbmUAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPoAAAABg==",
        "AAAAAAAAAL1DdW11bGF0aXZlIGBwcmljZV9icHMgKiBzZWNvbmRzYCBmb3IgWUVTIHNpbmNlIGNyZWF0aW9uLCBleHRyYXBvbGF0ZWQKdG8gbm93OiBgb2JzZXJ2ZShtYXJrZXRfaWQsIDApYC4gUmVhZHktbWFkZSBmb3IgY29uc3VtZXJzIHRoYXQgc3RvcmUKdGhlaXIgb3duIGNoZWNrcG9pbnRzIGFuZCBjb21wdXRlIFRXQVBzIG9mZi1jaGFpbi4AAAAAAAAQcHJpY2VfY3VtdWxhdGl2ZQAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAQcHJvcG9zZV9yZXNvbHZlcgAAAAEAAAAAAAAACHJlc29sdmVyAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAJtBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbCBhbmQgdGhlIGxlZ2FjeSBmYWxsYmFjayBpbgpgc3dlZXBfZmVlc2AuIE1hcmtldHMgd2l0aCBhIHNuYXBzaG90dGVkIGBGZWVUZXJtc2Aga2VlcCBwYXlpbmcgdGhlaXIKb3JpZ2luYWwgcmVjaXBpZW50LgAAAAAQcHJvcG9zZV90cmVhc3VyeQAAAAEAAAAAAAAACHRyZWFzdXJ5AAAAEwAAAAEAAAPpAAAAAgAAAAM=",
<<<<<<< HEAD
        "AAAABQAAAIxQb3NpdGlvbnMgbW92ZWQgYmV0d2VlbiBob2xkZXJzLiBJbmRleGVycyB0aGF0IHRyYWNrIGJhbGFuY2VzIGZyb20KYFRyYWRlYC9gUmVkZWVtZWRgIG11c3QgYWxzbyBhcHBseSB0aGlzIGV2ZW50IChzZWUgZG9jcy9hcmNoaXRlY3R1cmUubWQpLgAAAAAAAAATUG9zaXRpb25UcmFuc2ZlcnJlZAAAAAABAAAAFHBvc2l0aW9uX3RyYW5zZmVycmVkAAAABQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAADdNb3ZlcyBgYW1vdW50YCBzaGFyZXMgb2YgYG91dGNvbWVgIGZyb20gYGZyb21gIHRvIGB0b2AuAAAAABF0cmFuc2Zlcl9wb3NpdGlvbgAAAAAAAAUAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAFFBvb2xSZW1haW5kZXJDbGFpbWVkAAAAAQAAABZwb29sX3JlbWFpbmRlcl9jbGFpbWVkAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAADlQb29sIHJlbWFpbmRlciBwbHVzIGFueSBMUCBmZWVzIGRyYWluZWQgaW4gdGhlIHNhbWUgY2FsbC4AAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAAAAAAAOZTZXRzIHRoZSBicmVha2VyIGRlZmF1bHRzIGNvcGllZCBpbnRvIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbC4KYGJhbmRfYnBzIDwgbWF4X2ltcGFjdF9icHNgIChib3RoIG5vbi16ZXJvKSBpcyByZWplY3RlZDogYSBzaW5nbGUKdHJhZGUgdGhhdCBpcyBhbGxvd2VkIGJ5IHRoZSBpbXBhY3QgY2FwIGNvdWxkIHRoZW4gbmV2ZXIgZml0IGluc2lkZQp0aGUgYmFuZCwgbG9ja2luZyB0cmFkaW5nLgAAAAAAE3NldF9kZWZhdWx0X2JyZWFrZXIAAAAAAQAAAAAAAAAHYnJlYWtlcgAAAAfQAAAADUJyZWFrZXJDb25maWcAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAABQAAAEJWMSBldmVudDogcG9vbCByZW1haW5kZXIgY2xhaW1lZCBieSBjcmVhdG9yIGFmdGVyIG1hcmtldCBmaW5hbGl0eS4AAAAAAAAAAAAWUG9vbFJlbWFpbmRlckNsYWltZWRWMQAAAAAAAQAAABlwb29sX3JlbWFpbmRlcl9jbGFpbWVkX3YxAAAAAAAABAAAAAAAAAAHdmVyc2lvbgAAAAAEAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAAAAAAABnBheW91dAAAAAAACwAAAAAAAAAC",
=======
        "AAAAAAAAADdNb3ZlcyBgYW1vdW50YCBzaGFyZXMgb2YgYG91dGNvbWVgIGZyb20gYGZyb21gIHRvIGB0b2AuAAAAABF0cmFuc2Zlcl9wb3NpdGlvbgAAAAAAAAUAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAOZTZXRzIHRoZSBicmVha2VyIGRlZmF1bHRzIGNvcGllZCBpbnRvIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbC4KYGJhbmRfYnBzIDwgbWF4X2ltcGFjdF9icHNgIChib3RoIG5vbi16ZXJvKSBpcyByZWplY3RlZDogYSBzaW5nbGUKdHJhZGUgdGhhdCBpcyBhbGxvd2VkIGJ5IHRoZSBpbXBhY3QgY2FwIGNvdWxkIHRoZW4gbmV2ZXIgZml0IGluc2lkZQp0aGUgYmFuZCwgbG9ja2luZyB0cmFkaW5nLgAAAAAAE3NldF9kZWZhdWx0X2JyZWFrZXIAAAAAAQAAAAAAAAAHYnJlYWtlcgAAAAfQAAAADUJyZWFrZXJDb25maWcAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
>>>>>>> upstream/develop
        "AAAAAAAAAHxDcmVhdG9yICh0aGUgTFApIHdpdGhkcmF3cyB3aGF0ZXZlciB0aGUgcG9vbCBzdGlsbCBob2xkcyBvbmNlIGZpbmFsLApwbHVzIGFueSB1bmNsYWltZWQgTFAgZmVlcy4gUmV0dXJucyB0aGUgdG90YWwgcGFpZCBvdXQuAAAAFGNsYWltX3Bvb2xfcmVtYWluZGVyAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAQdDbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVyIGZvciB1cCB0byBgTUFYX0JBVENIYCBtYXJrZXRzIHRoZQpgY3JlYXRvcmAgb3ducywgd2l0aCBvbmUgY29sbGF0ZXJhbCB0cmFuc2Zlci4gU2FtZSBvcmRlcmluZyBhbmQgc2tpcApzZW1hbnRpY3MgYXMgYHJlZGVlbV9tYW55YC4gQSBtYXJrZXQgY2xvc2VkIGJ5IGBmaW5hbGl6ZV9tYXJrZXRgCnJlcG9ydHMgYEFscmVhZHlDbGFpbWVkYCDigJQgdGhlIHN3ZWVwIGFscmVhZHkgdG9vayB0aGUgcmVtYWluZGVyLgAAAAAVY2xhaW1fcG9vbF9yZW1haW5kZXJzAAAAAAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAptYXJrZXRfaWRzAAAAAAPqAAAABgAAAAEAAAPpAAAH0AAAAAtCYXRjaFJlc3VsdAAAAAAD",
<<<<<<< HEAD
        "AAAAAAAAAIVSZW1vdmVzIHZhbHVlbGVzcyBwb3NpdGlvbiBlbnRyaWVzIGZyb20gYSBjbG9zZWQgbWFya2V0LiBUaGlzIGlzCnBlcm1pc3Npb25sZXNzIGFuZCBkb2VzIG5vdCByZWZ1bmQgcmVudDsgaXQgb25seSByZWR1Y2VzIGxpdmUgc3RhdGUuAAAAAAAAFnB1cmdlX2Nsb3NlZF9wb3NpdGlvbnMAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB2hvbGRlcnMAAAAD6gAAABMAAAABAAAD6QAAAAQAAAAD",
=======
>>>>>>> upstream/develop
        "AAAAAAAAAI5BZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZQpob3Jpem9uIHNuYXBzaG90dGVkIGF0IHRoZWlyIGNyZWF0aW9uLiBNdXN0IGJlIHdpdGhpbgpbMTgwIGRheXMsIDE4MjUgZGF5c10uAAAAAAAac2V0X2RlZmF1bHRfcmVkZWVtX2hvcml6b24AAAAAAAEAAAAAAAAABHNlY3MAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAGVBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZQpzcGxpdCB0aGV5IHNuYXBzaG90dGVkIGF0IGNyZWF0aW9uLgAAAAAAABpzZXRfcHJvdG9jb2xfZmVlX3NoYXJlX2JwcwAAAAAAAQAAAAAAAAAJc2hhcmVfYnBzAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==",
        "AAAAAgAAABdXaG8gcnVsZXMgb24gYSBkaXNwdXRlLgAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAALVRoZSByZXNvbHZlciBhZG1pbiwgdGhyb3VnaCBgc2V0dGxlX2Rpc3B1dGVgLgAAAAAAAAhHdWFyZGlhbgAAAAEAAABfYGtgIG9mIHRoZXNlIG1lbWJlcnMsIHRocm91Z2ggYGVzY2FsYXRpb25fYXR0ZXN0YC4gTXVzdCBiZSBkaXNqb2ludApmcm9tIHRoZSBwcm9wb3Npbmcgc2lnbmVycy4AAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAACCUmF3IEVkMjU1MTkgcHVibGljIGtleS4gRm9yIGEgYEcuLi5gIGFjY291bnQgYWRkcmVzcyB0aGlzIGlzCmBTdHJLZXkuZGVjb2RlRWQyNTUxOVB1YmxpY0tleShhZGRyZXNzKWA7IGBDLi4uYCBhZGRyZXNzZXMgaGF2ZSBub25lLgAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAEtCaW5kcyBhIG1hcmtldCB0byBhIHJldXNhYmxlIGNvbW1pdHRlZSByZWdpc3RyeSBzdWJqZWN0IHRvIHJvdGF0aW9uIGJvdW5kcy4AAAAAAAAAAAxDb21taXR0ZWVSZWYAAAAEAAAAAAAAAAxjb21taXR0ZWVfaWQAAAAGAAAAAAAAAA5kaXNwdXRlX3dpbmRvdwAAAAAABgAAAAAAAAASbWF4X3JvdGF0aW9uX2RlbHRhAAAAAAAEAAAAAAAAAAltaW5fZXBvY2gAAAAAAAAE",
        "AAAAAQAAAEVEdWFsLXBhdGggcmVzb2x1dGlvbiBtb2RlOiBwcmljZSBmZWVkIGZpcnN0LCBmYWxsaW5nIGJhY2sgdG8gc2lnbmVycy4AAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAgAAAAAAAAAAAAAADE1hcmtldFN0YXR1cwAAAAMAAAAAAAAAQlRyYWRpbmcgYWxsb3dlZCB1bnRpbCBgY2xvc2VfdGltZWAsIHRoZW4gd2FpdGluZyBmb3IgdGhlIHJlc29sdmVyLgAAAAAABE9wZW4AAAABAAAAIUZpbmFsLiBXaW5uaW5nIHNoYXJlcyByZWRlZW0gMToxLgAAAAAAAAhSZXNvbHZlZAAAAAEAAAfQAAAAB091dGNvbWUAAAAAAAAAACtJbnZhbGlkIG1hcmtldC4gRXZlcnkgc2hhcmUgcmVkZWVtcyBhdCAwLjUuAAAAAARWb2lk",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAgAAARNUaGUgZnVsbCByZXNvbHV0aW9uIHJ1bGUgYSBtYXJrZXQncyBgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvLiBIYXNoaW5nCnRoaXMgKHJhdGhlciB0aGFuIHRoZSBiYXJlIGBQcmljZUNvbmZpZ2AvYFNpZ25lckNvbmZpZ2ApIGtlZXBzIHRoZSB0d28KbW9kZXMgaW4gZGlzam9pbnQgaGFzaCBzcGFjZXMgZXZlbiBpZiB0aGVpciBmaWVsZCBlbmNvZGluZ3MgY291bGQKb3RoZXJ3aXNlIGNvbGxpZGUuIFNlZSBgZG9jcy9hZHIvMDAwMS1yZXNvbHV0aW9uLWNvbW1pdG1lbnQubWRgLgAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAGAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAAAAAAAZIeWJyaWQAAAAAAAEAAAfQAAAADEh5YnJpZENvbmZpZw==",
        "AAAAAQAAAOBWZXJzaW9uZWQgY29tbWl0bWVudCBlbnZlbG9wZS4gVW5saWtlIGEgYmFyZSBbYFJlc29sdXRpb25TcGVjYF0gaXQgYmluZHMgdGhlCm5ldHdvcmsgYW5kIHRoZSBtYXJrZXQtY29yZSBpbnN0YW5jZSwgYW5kIGNhcnJpZXMgYSBjcmVhdG9yLWNob3NlbiBgc2FsdGAKdGhhdCBtYWtlcyBhIHByZS1yZXZlYWwgYnJ1dGUtZm9yY2Ugb2YgdGhlIChsb3ctZW50cm9weSkgcnVsZSBpbmZlYXNpYmxlLgAAAAAAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAUAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAA/YHNoYTI1NihuZXR3b3JrIHBhc3NwaHJhc2UpYCwgaS5lLiBgZW52LmxlZGdlcigpLm5ldHdvcmtfaWQoKWAuAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAd1RvdGFsIHdlaWdodCB0aGF0IG11c3Qgc2lnbiBvbmUgb3V0Y29tZS4gQ2hvb3NlIGl0IGFib3ZlIGhhbGYgdGhlIHRvdGFsCndlaWdodCBzbyB0d28gb3V0Y29tZXMgY2FuIG5ldmVyIGJvdGggcmVhY2ggaXQuAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAAAQAAANBBdHRlc3RlZCByZXNvbHV0aW9uIHdob3NlIHByb3Bvc2FsIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIGR1cmluZwp0aGUgZGlzcHV0ZSB3aW5kb3cuIEhhc2hlZCBhcyBgUmVzb2x1dGlvblNwZWM6OlNpZ25lcnNEaXNwdXRhYmxlYCwgYQpzZXBhcmF0ZSB2YXJpYW50LCBzbyBleGlzdGluZyBgU2lnbmVyc2AgY29tbWl0bWVudHMgYXJlIHVuYWZmZWN0ZWQuAAAAAAAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAAGAAAAM0NvbGxhdGVyYWwgZXNjcm93ZWQgYnkgYGRpc3B1dGVgOyBtdXN0IGJlIHBvc2l0aXZlLgAAAAAMZGlzcHV0ZV9ib25kAAAACwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAACmVzY2FsYXRpb24AAAAAB9AAAAAKRXNjYWxhdGlvbgAAAAAAQ1NlY29uZHMgYWZ0ZXIgYSBkaXNwdXRlIG9wZW5zIGJlZm9yZSBhbnlvbmUgbWF5IHZvaWQgaXQgdW5yZXNvbHZlZC4AAAAAEmVzY2FsYXRpb25fdGltZW91dAAAAAAABgAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<i128>>,
        sell: this.txFromJSON<Result<i128>>,
        twap: this.txFromJSON<Result<u32>>,
        admin: this.txFromJSON<Result<string>>,
        buy_v2: this.txFromJSON<Result<i128>>,
        redeem: this.txFromJSON<Result<i128>>,
        observe: this.txFromJSON<Result<i128>>,
        resolve: this.txFromJSON<Result<void>>,
        sell_v2: this.txFromJSON<Result<i128>>,
        get_price: this.txFromJSON<Result<u32>>,
        is_closed: this.txFromJSON<boolean>,
        max_batch: this.txFromJSON<u32>,
        quote_buy: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<Config>>,
        get_market: this.txFromJSON<Result<Market>>,
        quote_sell: this.txFromJSON<Result<i128>>,
        set_paused: this.txFromJSON<Result<void>>,
        sweep_fees: this.txFromJSON<Result<i128>>,
        would_trip: this.txFromJSON<Result<boolean>>,
        redeem_many: this.txFromJSON<Result<BatchResult>>,
        transfer_lp: this.txFromJSON<Result<void>>,
        void_market: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        get_position: this.txFromJSON<Position>,
        market_count: this.txFromJSON<u64>,
        settle_state: this.txFromJSON<Result<SettleState>>,
        breaker_state: this.txFromJSON<Result<Option<BandState>>>,
        claim_lp_fees: this.txFromJSON<Result<i128>>,
        create_market: this.txFromJSON<Result<u64>>,
        pending_admin: this.txFromJSON<Option<PendingAdmin>>,
        propose_admin: this.txFromJSON<Result<void>>,
        breaker_config: this.txFromJSON<Result<Option<BreakerConfig>>>,
        accept_resolver: this.txFromJSON<Result<void>>,
        accept_treasury: this.txFromJSON<Result<void>>,
        finalize_market: this.txFromJSON<Result<i128>>,
        get_market_view: this.txFromJSON<Result<MarketView>>,
        redeem_deadline: this.txFromJSON<Option<u64>>,
        price_cumulative: this.txFromJSON<Result<i128>>,
        propose_resolver: this.txFromJSON<Result<void>>,
        propose_treasury: this.txFromJSON<Result<void>>,
        transfer_position: this.txFromJSON<Result<void>>,
        set_default_breaker: this.txFromJSON<Result<void>>,
        set_default_fee_bps: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        claim_pool_remainders: this.txFromJSON<Result<BatchResult>>,
<<<<<<< HEAD
        purge_closed_positions: this.txFromJSON<Result<u32>>,
=======
>>>>>>> upstream/develop
        set_default_redeem_horizon: this.txFromJSON<Result<void>>,
        set_protocol_fee_share_bps: this.txFromJSON<Result<void>>
  }
}