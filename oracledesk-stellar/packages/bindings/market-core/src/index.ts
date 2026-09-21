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
  18: {message:"Overflow"}
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

export type DataKey = {tag: "Admin", values: void} | {tag: "Collateral", values: void} | {tag: "Treasury", values: void} | {tag: "Resolver", values: void} | {tag: "DefaultFeeBps", values: void} | {tag: "Paused", values: void} | {tag: "NextId", values: void} | {tag: "Market", values: readonly [u64]} | {tag: "Position", values: readonly [u64, string]};

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};


export interface Position {
  no: i128;
  yes: i128;
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
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sweep_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anyone can move accrued fees to the treasury.
   */
  sweep_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * Construct and simulate a create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and seeds the pool. `creator` becomes the sole LP.
   * `initial_yes_bps` in [100, 9900] sets the opening YES probability;
   * the creator receives the leftover shares of the likelier outcome.
   */
  create_market: ({creator, question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {creator: string, question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAAKSW52YWxpZEZlZQAAAAAAAwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAQAAAAAAAAAEkludmFsaWRQcm9iYWJpbGl0eQAAAAAABQAAAAAAAAAQSW52YWxpZENsb3NlVGltZQAAAAYAAAAAAAAADk1hcmtldE5vdEZvdW5kAAAAAAAHAAAAAAAAAA1NYXJrZXROb3RPcGVuAAAAAAAACAAAAAAAAAAMTWFya2V0Q2xvc2VkAAAACQAAAAAAAAAMTm90Q2xvc2VkWWV0AAAACgAAAAAAAAAITm90RmluYWwAAAALAAAAAAAAABBTbGlwcGFnZUV4Y2VlZGVkAAAADAAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAANAAAAAAAAABVJbnN1ZmZpY2llbnRMaXF1aWRpdHkAAAAAAAAOAAAAAAAAAA5NYXJrZXRUb29MYXJnZQAAAAAADwAAAAAAAAAPTm90aGluZ1RvUmVkZWVtAAAAABAAAAAAAAAADkFscmVhZHlDbGFpbWVkAAAAAAARAAAAAAAAAAhPdmVyZmxvdwAAABI=",
        "AAAABQAAAAAAAAAAAAAABVRyYWRlAAAAAAAAAQAAAAV0cmFkZQAAAAAAAAkAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAZpc19idXkAAAAAAAEAAAAAAAAAAAAAAApjb2xsYXRlcmFsAAAAAAALAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAAtyZXNlcnZlX3llcwAAAAALAAAAAAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAA9kZWZhdWx0X2ZlZV9icHMAAAAABAAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAACHRyZWFzdXJ5AAAAEw==",
        "AAAAAQAAAAAAAAAAAAAABk1hcmtldAAAAAAADQAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAPFVuaXggc2Vjb25kcyAobGVkZ2VyIHRpbWVzdGFtcCkuIFRyYWRpbmcgc3RvcHMgYXQgdGhpcyB0aW1lLgAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAABGU25hcHNob3Qgb2YgdGhlIGZlZSBhdCBjcmVhdGlvbiBzbyBsYXRlciBjb25maWcgY2hhbmdlcyBuZXZlciBtb3ZlIGl0LgAAAAAAB2ZlZV9icHMAAAAABAAAACZUcmFkaW5nIGZlZXMgd2FpdGluZyBmb3IgYHN3ZWVwX2ZlZXNgLgAAAAAADGZlZXNfYWNjcnVlZAAAAAsAAAA4Q3JlYXRvciBoYXMgd2l0aGRyYXduIHRoZSBwb29sIHJlbWFpbmRlciBhZnRlciBmaW5hbGl0eS4AAAAKbHBfY2xhaW1lZAAAAAAAAQAAAChJUEZTIENJRCAvIFVSSSBvZiB0aGUgcXVlc3Rpb24gbWV0YWRhdGEuAAAACG1ldGFfdXJpAAAAEAAAAIZzaGEyNTYgb2YgdGhlIGNhbm9uaWNhbCBxdWVzdGlvbiBKU09OIHN0b3JlZCBvZmYtY2hhaW4gKElQRlMpLCBzbyBhCmNsaWVudCBjYW4gcHJvdmUgdGhlIHRleHQgaXQgc2hvd3MgaXMgdGhlIHRleHQgdGhhdCB3YXMgY29tbWl0dGVkLgAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAKcmVzZXJ2ZV9ubwAAAAAACwAAAAAAAAALcmVzZXJ2ZV95ZXMAAAAACwAAAS9Db21taXRtZW50IHRvIGhvdyB0aGlzIG1hcmtldCB3aWxsIGJlIHJlc29sdmVkLCBmaXhlZCBhdCBjcmVhdGlvbiBzbwp0aGUgY3JlYXRvciBjYW5ub3QgcGljayBmYXZvcmFibGUgcmVzb2x1dGlvbiBydWxlcyBhZnRlciBzZWVpbmcKdHJhZGluZyBhY3Rpdml0eS4gVGhlIHJlc29sdmVyIGNvbnRyYWN0IHZlcmlmaWVzIGEgcmV2ZWFsZWQgc3BlYwphZ2FpbnN0IHRoaXMgaGFzaCBiZWZvcmUgY29uZmlndXJpbmcgaXRzZWxmIGZvciB0aGUgbWFya2V0LiBTZWUKYGRvY3MvYWRyLzAwMDEtcmVzb2x1dGlvbi1jb21taXRtZW50Lm1kYC4AAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAEBDb21wbGV0ZSBzZXRzIGluIGV4aXN0ZW5jZSA9PSBjb2xsYXRlcmFsIGxvY2tlZCBmb3IgdGhpcyBtYXJrZXQuAAAAC3NldHNfbWludGVkAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxNYXJrZXRTdGF0dXM=",
        "AAAAAAAAAIFTcGVuZCBgY29sbGF0ZXJhbF9pbmAgdG8gYnV5IGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMgc2hhcmVzIHJlY2VpdmVkLgpSZXZlcnRzIGlmIGZld2VyIHRoYW4gYG1pbl9zaGFyZXNfb3V0YCB3b3VsZCBiZSByZWNlaXZlZC4AAAAAAAADYnV5AAAAAAUAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAKQ29sbGF0ZXJhbAAAAAAAAAAAAAAAAAAIVHJlYXN1cnkAAAAAAAAAAAAAAAhSZXNvbHZlcgAAAAAAAAAAAAAADURlZmF1bHRGZWVCcHMAAAAAAAAAAAAAAAAAAAZQYXVzZWQAAAAAAAAAAAAAAAAABk5leHRJZAAAAAAAAQAAAAAAAAAGTWFya2V0AAAAAAABAAAABgAAAAEAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAYAAAAT",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAAAAARBSZWNlaXZlIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCBieSBzZWxsaW5nIGBvdXRjb21lYCBzaGFyZXMuIFJldHVybnMKc2hhcmVzIHNvbGQuIFJldmVydHMgaWYgbW9yZSB0aGFuIGBtYXhfc2hhcmVzX2luYCB3b3VsZCBiZSBuZWVkZWQuCkNsaWVudHMgdHVybiAic2VsbCBOIHNoYXJlcyIgaW50byBgY29sbGF0ZXJhbF9vdXRgIG9mZi1jaGFpbgooc2VlIGBtYXRoOjpjYWxjX3NlbGxgIGRvY3MpIGFuZCBhZGQgYSBzbGlwcGFnZSBtYXJnaW4gdG8gYG1heF9zaGFyZXNfaW5gLgAAAARzZWxsAAAABQAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAQAAAAAAAAAAAAAACFBvc2l0aW9uAAAAAgAAAAAAAAACbm8AAAAAAAsAAAAAAAAAA3llcwAAAAAL",
        "AAAABQAAAAAAAAAAAAAACFJlZGVlbWVkAAAAAQAAAAhyZWRlZW1lZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAAAAAAAAZwYXlvdXQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAGlQYXlzIG91dCBgaG9sZGVyYCdzIHBvc2l0aW9uIGZvciBhIGZpbmFsIG1hcmtldCBhbmQgY2xlYXJzIGl0LgpMb3NpbmcgcG9zaXRpb25zIGNsZWFyIHdpdGggYSBwYXlvdXQgb2YgMC4AAAAAAAAGcmVkZWVtAAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAABQAAAAAAAAAAAAAACUZlZXNTd2VwdAAAAAAAAAEAAAAKZmVlc19zd2VwdAAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAAAAAAAAAAAAAHcmVzb2x2ZQAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAgAAAAAAAAAAAAAADE1hcmtldFN0YXR1cwAAAAMAAAAAAAAAQlRyYWRpbmcgYWxsb3dlZCB1bnRpbCBgY2xvc2VfdGltZWAsIHRoZW4gd2FpdGluZyBmb3IgdGhlIHJlc29sdmVyLgAAAAAABE9wZW4AAAABAAAAIUZpbmFsLiBXaW5uaW5nIHNoYXJlcyByZWRlZW0gMToxLgAAAAAAAAhSZXNvbHZlZAAAAAEAAAfQAAAAB091dGNvbWUAAAAAAAAAACtJbnZhbGlkIG1hcmtldC4gRXZlcnkgc2hhcmUgcmVkZWVtcyBhdCAwLjUuAAAAAARWb2lk",
        "AAAAAAAAAD9TcG90IHByaWNlIG9mIGBvdXRjb21lYCBpbiBicHMgKDAuLj0xMF8wMDApLiBZRVMgKyBOTyB+IDEwXzAwMC4AAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAADlTaGFyZXMgYSBgYnV5YCBvZiBgY29sbGF0ZXJhbF9pbmAgd291bGQgcmV0dXJuIHJpZ2h0IG5vdy4AAAAAAAAJcXVvdGVfYnV5AAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X21hcmtldAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAZNYXJrZXQAAAAAAAM=",
        "AAAAAAAAAEVTaGFyZXMgYSBgc2VsbGAgZm9yIGV4YWN0bHkgYGNvbGxhdGVyYWxfb3V0YCB3b3VsZCBjb25zdW1lIHJpZ2h0IG5vdy4AAAAAAAAKcXVvdGVfc2VsbAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAC1BbnlvbmUgY2FuIG1vdmUgYWNjcnVlZCBmZWVzIHRvIHRoZSB0cmVhc3VyeS4AAAAAAAAKc3dlZXBfZmVlcwAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldENyZWF0ZWQAAAAAAAABAAAADm1hcmtldF9jcmVhdGVkAAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAC",
        "AAAAAAAAAEFJbnZhbGlkIG9yIHVucmVzb2x2YWJsZSBtYXJrZXQuIEFsbG93ZWQgYW55IHRpbWUgYmVmb3JlIGZpbmFsaXR5LgAAAAAAAAt2b2lkX21hcmtldAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldFJlc29sdmVkAAAAAAABAAAAD21hcmtldF9yZXNvbHZlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAACFOb25lIG1lYW5zIHRoZSBtYXJrZXQgd2FzIHZvaWRlZC4AAAAAAAAHb3V0Y29tZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAAAAAAAAAAAAAMZ2V0X3Bvc2l0aW9uAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAB9AAAAAIUG9zaXRpb24=",
        "AAAAAAAAAAAAAAAMbWFya2V0X2NvdW50AAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMc2V0X3Jlc29sdmVyAAAAAQAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEdSdW5zIGF0b21pY2FsbHkgYXQgZGVwbG95IHRpbWUsIHNvIG5vYm9keSBjYW4gZnJvbnQtcnVuIGluaXRpYWxpemF0aW9uLgAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAUAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAD2RlZmF1bHRfZmVlX2JwcwAAAAAEAAAAAA==",
        "AAAAAAAAAMhDcmVhdGVzIGEgbWFya2V0IGFuZCBzZWVkcyB0aGUgcG9vbC4gYGNyZWF0b3JgIGJlY29tZXMgdGhlIHNvbGUgTFAuCmBpbml0aWFsX3llc19icHNgIGluIFsxMDAsIDk5MDBdIHNldHMgdGhlIG9wZW5pbmcgWUVTIHByb2JhYmlsaXR5Owp0aGUgY3JlYXRvciByZWNlaXZlcyB0aGUgbGVmdG92ZXIgc2hhcmVzIG9mIHRoZSBsaWtlbGllciBvdXRjb21lLgAAAA1jcmVhdGVfbWFya2V0AAAAAAAACAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAEhBZmZlY3RzIG1hcmtldHMgY3JlYXRlZCBhZnRlciB0aGUgY2FsbDsgZXhpc3RpbmcgbWFya2V0cyBrZWVwIHRoZWlyIGZlZS4AAAATc2V0X2RlZmF1bHRfZmVlX2JwcwAAAAABAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAERDcmVhdG9yICh0aGUgTFApIHdpdGhkcmF3cyB3aGF0ZXZlciB0aGUgcG9vbCBzdGlsbCBob2xkcyBvbmNlIGZpbmFsLgAAABRjbGFpbV9wb29sX3JlbWFpbmRlcgAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD" ]),
      options
    )
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<i128>>,
        sell: this.txFromJSON<Result<i128>>,
        redeem: this.txFromJSON<Result<i128>>,
        resolve: this.txFromJSON<Result<void>>,
        get_price: this.txFromJSON<Result<u32>>,
        quote_buy: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<Config>>,
        get_market: this.txFromJSON<Result<Market>>,
        quote_sell: this.txFromJSON<Result<i128>>,
        set_paused: this.txFromJSON<Result<void>>,
        sweep_fees: this.txFromJSON<Result<i128>>,
        void_market: this.txFromJSON<Result<void>>,
        get_position: this.txFromJSON<Position>,
        market_count: this.txFromJSON<u64>,
        set_resolver: this.txFromJSON<Result<void>>,
        set_treasury: this.txFromJSON<Result<void>>,
        create_market: this.txFromJSON<Result<u64>>,
        set_default_fee_bps: this.txFromJSON<Result<void>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>
  }
}