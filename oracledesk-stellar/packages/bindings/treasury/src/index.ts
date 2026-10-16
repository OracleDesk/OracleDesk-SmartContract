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
  2: {message:"Unauthorized"},
  3: {message:"InvalidConfig"},
  4: {message:"InvalidAmount"},
  5: {message:"TradeCapExceeded"},
  6: {message:"MarketCapExceeded"},
  7: {message:"DailyCapExceeded"},
  8: {message:"MarketNotOpen"},
  9: {message:"InsufficientBalance"},
  10: {message:"Paused"},
  11: {message:"NoSuccessor"}
}


export interface DailyUsage {
  amount: i128;
  day_start: u64;
}


export interface RiskConfig {
  agent: string;
  collateral: string;
  market_core: string;
  max_daily: i128;
  max_market: i128;
  max_trade: i128;
}






export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};

export interface Client {
  /**
   * Construct and simulate a redeem transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Redeems the treasury's position in a resolved/voided market.
   */
  redeem: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  deposit: ({from, amount}: {from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  withdraw: ({to, amount}: {to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_buy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buys `outcome` shares in an existing market using treasury capital.
   */
  agent_buy: ({market_id, outcome, collateral_in, min_shares_out}: {market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_sell transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sells `outcome` shares back into the pool for exactly
   * `collateral_out`. This returns capital to the treasury (market-core
   * pays out of its own balance), so it is not capped and does not need
   * the nested-transfer pre-authorization that buying does.
   */
  agent_sell: ({market_id, outcome, collateral_out, max_shares_in}: {market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<RiskConfig>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a close_trade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Marks a market's exposure as exited. Pure bookkeeping (see
   * `MarketExposure`) for the future exposure dashboard; it does not move
   * funds or free the cumulative per-market cap.
   */
  close_trade: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a daily_usage transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  daily_usage: (options?: MethodOptions) => Promise<AssembledTransaction<Result<DailyUsage>>>

  /**
   * Construct and simulate a agent_buy_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent_buy` with a per-share limit price (`limit_price_bps`, 0 = none)
   * and a deadline (unix seconds, network time). market-core's `buy_v2`
   * enforces both; an expired or out-of-limit trade reverts the whole
   * invocation, so the treasury's caps are never consumed by a reverted
   * trade.
   */
  agent_buy_v2: ({market_id, outcome, collateral_in, min_shares_out, limit_price_bps, deadline}: {market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_buy_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical counterpart of `agent_buy`: buys `outcome_index` shares of
   * a categorical market using treasury capital. Shares the per-trade and
   * per-market caps with the binary path, and needs the same nested
   * transfer pre-authorization (see `do_agent_buy`).
   */
  agent_buy_cat: ({market_id, outcome_index, collateral_in, min_shares_out}: {market_id: u64, outcome_index: u32, collateral_in: i128, min_shares_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_sell_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `agent_sell` with a per-share limit price (`limit_price_bps`, 0 = no
   * limit) and a deadline (unix seconds, network time), both enforced by
   * market-core's `sell_v2`.
   */
  agent_sell_v2: ({market_id, outcome, collateral_out, max_shares_in, limit_price_bps, deadline}: {market_id: u64, outcome: Outcome, collateral_out: i128, max_shares_in: i128, limit_price_bps: u32, deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_successor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the successor treasury that `migrate_market` hands positions and
   * the LP role to. Admin-only; overwrites any previous successor (the
   * `SuccessorSet` events are the audit trail).
   */
  set_successor: ({successor}: {successor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a available_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  available_capital: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_claim_lp_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the market's LP fee share for a market the treasury created.
   * The LP portion accrues separately on market-core (see its `claim_lp_fees`);
   * this is that claim, agent-gated like the other trading entrypoints.
   */
  agent_claim_lp_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates and seeds a market using treasury capital. The treasury
   * becomes the market's creator/LP.
   */
  agent_create_market: ({question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a collect_market_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pulls accrued **protocol** fees from a configured market-core contract.
   * 
   * Only the protocol's share of each market's fees: the LP portion accrues
   * separately on market-core and belongs to the market's creator — for
   * agent-created markets that is the treasury itself, via
   * `agent_claim_lp_fees`.
   */
  collect_market_fees: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_pool_remainder transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims the LP pool remainder for a market the treasury created.
   */
  claim_pool_remainder: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, agent, collateral, market_core, max_trade, max_market, max_daily}: {admin: string, agent: string, collateral: string, market_core: string, max_trade: i128, max_market: i128, max_daily: i128},
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
    return ContractClient.deploy({admin, agent, collateral, market_core, max_trade, max_market, max_daily}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABAAAAAAAAAAQVHJhZGVDYXBFeGNlZWRlZAAAAAUAAAAAAAAAEU1hcmtldENhcEV4Y2VlZGVkAAAAAAAABgAAAAAAAAAQRGFpbHlDYXBFeGNlZWRlZAAAAAcAAAAAAAAADU1hcmtldE5vdE9wZW4AAAAAAAAIAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAkAAAAAAAAABlBhdXNlZAAAAAAACgAAAAAAAAALTm9TdWNjZXNzb3IAAAAACw==",
        "AAAAAQAAAAAAAAAAAAAACkRhaWx5VXNhZ2UAAAAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAJZGF5X3N0YXJ0AAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAAClJpc2tDb25maWcAAAAAAAYAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAKbWF4X21hcmtldAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACw==",
        "AAAABQAAAAAAAAAAAAAADFN1Y2Nlc3NvclNldAAAAAEAAAANc3VjY2Vzc29yX3NldAAAAAAAAAIAAAAAAAAAA29sZAAAAAPoAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADk1hcmtldE1pZ3JhdGVkAAAAAAABAAAAD21hcmtldF9taWdyYXRlZAAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJc3VjY2Vzc29yAAAAAAAAEwAAAAEAAAAAAAAAA3llcwAAAAALAAAAAAAAAAAAAAACbm8AAAAAAAsAAAAAAAAAAAAAAAJscAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAMbWFya2V0X3RvdGFsAAAACwAAAAAAAAAAAAAAC2RhaWx5X3RvdGFsAAAAAAsAAAAAAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAAAAADxSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldC4AAAAGcmVkZWVtAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAHZGVwb3NpdAAAAAACAAAAAAAAAARmcm9tAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAENCdXlzIGBvdXRjb21lYCBzaGFyZXMgaW4gYW4gZXhpc3RpbmcgbWFya2V0IHVzaW5nIHRyZWFzdXJ5IGNhcGl0YWwuAAAAAAlhZ2VudF9idXkAAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAPVTZWxscyBgb3V0Y29tZWAgc2hhcmVzIGJhY2sgaW50byB0aGUgcG9vbCBmb3IgZXhhY3RseQpgY29sbGF0ZXJhbF9vdXRgLiBUaGlzIHJldHVybnMgY2FwaXRhbCB0byB0aGUgdHJlYXN1cnkgKG1hcmtldC1jb3JlCnBheXMgb3V0IG9mIGl0cyBvd24gYmFsYW5jZSksIHNvIGl0IGlzIG5vdCBjYXBwZWQgYW5kIGRvZXMgbm90IG5lZWQKdGhlIG5lc3RlZC10cmFuc2ZlciBwcmUtYXV0aG9yaXphdGlvbiB0aGF0IGJ1eWluZyBkb2VzLgAAAAAAAAphZ2VudF9zZWxsAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAApSaXNrQ29uZmlnAAAAAAAD",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAK1NYXJrcyBhIG1hcmtldCdzIGV4cG9zdXJlIGFzIGV4aXRlZC4gUHVyZSBib29ra2VlcGluZyAoc2VlCmBNYXJrZXRFeHBvc3VyZWApIGZvciB0aGUgZnV0dXJlIGV4cG9zdXJlIGRhc2hib2FyZDsgaXQgZG9lcyBub3QgbW92ZQpmdW5kcyBvciBmcmVlIHRoZSBjdW11bGF0aXZlIHBlci1tYXJrZXQgY2FwLgAAAAAAAAtjbG9zZV90cmFkZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAALZGFpbHlfdXNhZ2UAAAAAAAAAAAEAAAPpAAAH0AAAAApEYWlseVVzYWdlAAAAAAAD",
        "AAAAAAAAARdgYWdlbnRfYnV5YCB3aXRoIGEgcGVyLXNoYXJlIGxpbWl0IHByaWNlIChgbGltaXRfcHJpY2VfYnBzYCwgMCA9IG5vbmUpCmFuZCBhIGRlYWRsaW5lICh1bml4IHNlY29uZHMsIG5ldHdvcmsgdGltZSkuIG1hcmtldC1jb3JlJ3MgYGJ1eV92MmAKZW5mb3JjZXMgYm90aDsgYW4gZXhwaXJlZCBvciBvdXQtb2YtbGltaXQgdHJhZGUgcmV2ZXJ0cyB0aGUgd2hvbGUKaW52b2NhdGlvbiwgc28gdGhlIHRyZWFzdXJ5J3MgY2FwcyBhcmUgbmV2ZXIgY29uc3VtZWQgYnkgYSByZXZlcnRlZAp0cmFkZS4AAAAADGFnZW50X2J1eV92MgAAAAYAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAAAAAA9saW1pdF9wcmljZV9icHMAAAAABAAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAcAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAA==",
        "AAAAAAAAAP1DYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgYWdlbnRfYnV5YDogYnV5cyBgb3V0Y29tZV9pbmRleGAgc2hhcmVzIG9mCmEgY2F0ZWdvcmljYWwgbWFya2V0IHVzaW5nIHRyZWFzdXJ5IGNhcGl0YWwuIFNoYXJlcyB0aGUgcGVyLXRyYWRlIGFuZApwZXItbWFya2V0IGNhcHMgd2l0aCB0aGUgYmluYXJ5IHBhdGgsIGFuZCBuZWVkcyB0aGUgc2FtZSBuZXN0ZWQKdHJhbnNmZXIgcHJlLWF1dGhvcml6YXRpb24gKHNlZSBgZG9fYWdlbnRfYnV5YCkuAAAAAAAADWFnZW50X2J1eV9jYXQAAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAAAAAANY29sbGF0ZXJhbF9pbgAAAAAAAAsAAAAAAAAADm1pbl9zaGFyZXNfb3V0AAAAAAALAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAKJgYWdlbnRfc2VsbGAgd2l0aCBhIHBlci1zaGFyZSBsaW1pdCBwcmljZSAoYGxpbWl0X3ByaWNlX2Jwc2AsIDAgPSBubwpsaW1pdCkgYW5kIGEgZGVhZGxpbmUgKHVuaXggc2Vjb25kcywgbmV0d29yayB0aW1lKSwgYm90aCBlbmZvcmNlZCBieQptYXJrZXQtY29yZSdzIGBzZWxsX3YyYC4AAAAAAA1hZ2VudF9zZWxsX3YyAAAAAAAABgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA5jb2xsYXRlcmFsX291dAAAAAAACwAAAAAAAAANbWF4X3NoYXJlc19pbgAAAAAAAAsAAAAAAAAAD2xpbWl0X3ByaWNlX2JwcwAAAAAEAAAAAAAAAAhkZWFkbGluZQAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAALRTZXRzIHRoZSBzdWNjZXNzb3IgdHJlYXN1cnkgdGhhdCBgbWlncmF0ZV9tYXJrZXRgIGhhbmRzIHBvc2l0aW9ucyBhbmQKdGhlIExQIHJvbGUgdG8uIEFkbWluLW9ubHk7IG92ZXJ3cml0ZXMgYW55IHByZXZpb3VzIHN1Y2Nlc3NvciAodGhlCmBTdWNjZXNzb3JTZXRgIGV2ZW50cyBhcmUgdGhlIGF1ZGl0IHRyYWlsKS4AAAANc2V0X3N1Y2Nlc3NvcgAAAAAAAAEAAAAAAAAACXN1Y2Nlc3NvcgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAqxNb3ZlcyB0aGUgdHJlYXN1cnkncyBwb3NpdGlvbiBpbiBgbWFya2V0X2lkYCDigJQgYW5kIHRoZSBMUCByb2xlLCB3aGVuCnRoZSB0cmVhc3VyeSBpcyB0aGUgbWFya2V0J3MgY3JlYXRvciBhbmQgaGFzIG5vdCBjbGFpbWVkIHRoZSByZW1haW5kZXIKeWV0IOKAlCB0byB0aGUgc3VjY2Vzc29yIHNldCB2aWEgYHNldF9zdWNjZXNzb3JgLCB0aGVuIGNsb3NlcyB0aGUgbG9jYWwKZXhwb3N1cmUuIEFkbWluLW9ubHk6IHJlbG9jYXRpbmcgY2FwaXRhbCBpcyBub3QgYW4gYWdlbnQgdHJhZGluZwphY3Rpb24sIGFuZCB0aGUgYWdlbnQga2V5IG11c3Qgbm90IGJlIGFibGUgdG8gZHJhaW4gcG9zaXRpb25zLgoKbWFya2V0LWNvcmUncyBgdHJhbnNmZXJfcG9zaXRpb25gIC8gYHRyYW5zZmVyX2xwYCByZXF1aXJlIHRoZSB0cmVhc3VyeQppdHNlbGYgdG8gYXV0aG9yaXplLiBCZWNhdXNlIHRoZSB0cmVhc3VyeSBpcyB0aGVpciAqZGlyZWN0KiBjYWxsZXIKaGVyZSwgdGhlIGltcGxpY2l0IGludm9rZXIgYXV0aG9yaXphdGlvbiBjb3ZlcnMgYm90aCDigJQgbm8KYGF1dGhvcml6ZV9hc19jdXJyZW50X2NvbnRyYWN0YCBlbnRyeSBpcyBuZWVkZWQgKHVubGlrZSB0aGUgbmVzdGVkCnRva2VuIHRyYW5zZmVyIGluIGBhZ2VudF9idXlgLCBzZWUgYGRvY3MvYWRyLzAwMDItdHJlYXN1cnktbmVzdGVkLWF1dGgubWRgKS4AAAAObWlncmF0ZV9tYXJrZXQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAARYXZhaWxhYmxlX2NhcGl0YWwAAAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAANNDbGFpbXMgdGhlIG1hcmtldCdzIExQIGZlZSBzaGFyZSBmb3IgYSBtYXJrZXQgdGhlIHRyZWFzdXJ5IGNyZWF0ZWQuClRoZSBMUCBwb3J0aW9uIGFjY3J1ZXMgc2VwYXJhdGVseSBvbiBtYXJrZXQtY29yZSAoc2VlIGl0cyBgY2xhaW1fbHBfZmVlc2ApOwp0aGlzIGlzIHRoYXQgY2xhaW0sIGFnZW50LWdhdGVkIGxpa2UgdGhlIG90aGVyIHRyYWRpbmcgZW50cnlwb2ludHMuAAAAABNhZ2VudF9jbGFpbV9scF9mZWVzAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAGBDcmVhdGVzIGFuZCBzZWVkcyBhIG1hcmtldCB1c2luZyB0cmVhc3VyeSBjYXBpdGFsLiBUaGUgdHJlYXN1cnkKYmVjb21lcyB0aGUgbWFya2V0J3MgY3JlYXRvci9MUC4AAAATYWdlbnRfY3JlYXRlX21hcmtldAAAAAAHAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAASRQdWxscyBhY2NydWVkICoqcHJvdG9jb2wqKiBmZWVzIGZyb20gYSBjb25maWd1cmVkIG1hcmtldC1jb3JlIGNvbnRyYWN0LgoKT25seSB0aGUgcHJvdG9jb2wncyBzaGFyZSBvZiBlYWNoIG1hcmtldCdzIGZlZXM6IHRoZSBMUCBwb3J0aW9uIGFjY3J1ZXMKc2VwYXJhdGVseSBvbiBtYXJrZXQtY29yZSBhbmQgYmVsb25ncyB0byB0aGUgbWFya2V0J3MgY3JlYXRvciDigJQgZm9yCmFnZW50LWNyZWF0ZWQgbWFya2V0cyB0aGF0IGlzIHRoZSB0cmVhc3VyeSBpdHNlbGYsIHZpYQpgYWdlbnRfY2xhaW1fbHBfZmVlc2AuAAAAE2NvbGxlY3RfbWFya2V0X2ZlZXMAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAD9DbGFpbXMgdGhlIExQIHBvb2wgcmVtYWluZGVyIGZvciBhIG1hcmtldCB0aGUgdHJlYXN1cnkgY3JlYXRlZC4AAAAAFGNsYWltX3Bvb2xfcmVtYWluZGVyAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAACwAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    redeem: this.txFromJSON<Result<i128>>,
        deposit: this.txFromJSON<Result<void>>,
        withdraw: this.txFromJSON<Result<void>>,
        agent_buy: this.txFromJSON<Result<i128>>,
        agent_sell: this.txFromJSON<Result<i128>>,
        get_config: this.txFromJSON<Result<RiskConfig>>,
        set_paused: this.txFromJSON<Result<void>>,
        close_trade: this.txFromJSON<Result<i128>>,
        daily_usage: this.txFromJSON<Result<DailyUsage>>,
        agent_buy_v2: this.txFromJSON<Result<i128>>,
        agent_buy_cat: this.txFromJSON<Result<i128>>,
        agent_sell_v2: this.txFromJSON<Result<i128>>,
        set_successor: this.txFromJSON<Result<void>>,
        migrate_market: this.txFromJSON<Result<void>>,
        available_capital: this.txFromJSON<Result<i128>>,
        agent_claim_lp_fees: this.txFromJSON<Result<i128>>,
        agent_create_market: this.txFromJSON<Result<u64>>,
        collect_market_fees: this.txFromJSON<Result<i128>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>
  }
}