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
  10: {message:"Paused"}
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
   * Construct and simulate a available_capital transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  available_capital: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a agent_create_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates and seeds a market using treasury capital. The treasury
   * becomes the market's creator/LP.
   */
  agent_create_market: ({question_hash, resolution_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps}: {question_hash: Buffer, resolution_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a collect_market_fees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pulls accrued fees from a configured market-core contract.
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
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABAAAAAAAAAAQVHJhZGVDYXBFeGNlZWRlZAAAAAUAAAAAAAAAEU1hcmtldENhcEV4Y2VlZGVkAAAAAAAABgAAAAAAAAAQRGFpbHlDYXBFeGNlZWRlZAAAAAcAAAAAAAAADU1hcmtldE5vdE9wZW4AAAAAAAAIAAAAAAAAABNJbnN1ZmZpY2llbnRCYWxhbmNlAAAAAAkAAAAAAAAABlBhdXNlZAAAAAAACg==",
        "AAAAAAAAADxSZWRlZW1zIHRoZSB0cmVhc3VyeSdzIHBvc2l0aW9uIGluIGEgcmVzb2x2ZWQvdm9pZGVkIG1hcmtldC4AAAAGcmVkZWVtAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAHZGVwb3NpdAAAAAACAAAAAAAAAARmcm9tAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAQAAAAAAAAAAAAAACkRhaWx5VXNhZ2UAAAAAAAIAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAJZGF5X3N0YXJ0AAAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAAClJpc2tDb25maWcAAAAAAAYAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKY29sbGF0ZXJhbAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAAAAAAJbWF4X2RhaWx5AAAAAAAACwAAAAAAAAAKbWF4X21hcmtldAAAAAAACwAAAAAAAAAJbWF4X3RyYWRlAAAAAAAACw==",
        "AAAAAAAAAAAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAENCdXlzIGBvdXRjb21lYCBzaGFyZXMgaW4gYW4gZXhpc3RpbmcgbWFya2V0IHVzaW5nIHRyZWFzdXJ5IGNhcGl0YWwuAAAAAAlhZ2VudF9idXkAAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADWNvbGxhdGVyYWxfaW4AAAAAAAALAAAAAAAAAA5taW5fc2hhcmVzX291dAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAPVTZWxscyBgb3V0Y29tZWAgc2hhcmVzIGJhY2sgaW50byB0aGUgcG9vbCBmb3IgZXhhY3RseQpgY29sbGF0ZXJhbF9vdXRgLiBUaGlzIHJldHVybnMgY2FwaXRhbCB0byB0aGUgdHJlYXN1cnkgKG1hcmtldC1jb3JlCnBheXMgb3V0IG9mIGl0cyBvd24gYmFsYW5jZSksIHNvIGl0IGlzIG5vdCBjYXBwZWQgYW5kIGRvZXMgbm90IG5lZWQKdGhlIG5lc3RlZC10cmFuc2ZlciBwcmUtYXV0aG9yaXphdGlvbiB0aGF0IGJ1eWluZyBkb2VzLgAAAAAAAAphZ2VudF9zZWxsAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAADmNvbGxhdGVyYWxfb3V0AAAAAAALAAAAAAAAAA1tYXhfc2hhcmVzX2luAAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAApSaXNrQ29uZmlnAAAAAAAD",
        "AAAAAAAAAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAK1NYXJrcyBhIG1hcmtldCdzIGV4cG9zdXJlIGFzIGV4aXRlZC4gUHVyZSBib29ra2VlcGluZyAoc2VlCmBNYXJrZXRFeHBvc3VyZWApIGZvciB0aGUgZnV0dXJlIGV4cG9zdXJlIGRhc2hib2FyZDsgaXQgZG9lcyBub3QgbW92ZQpmdW5kcyBvciBmcmVlIHRoZSBjdW11bGF0aXZlIHBlci1tYXJrZXQgY2FwLgAAAAAAAAtjbG9zZV90cmFkZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAALZGFpbHlfdXNhZ2UAAAAAAAAAAAEAAAPpAAAH0AAAAApEYWlseVVzYWdlAAAAAAAD",
        "AAAABQAAAAAAAAAAAAAADUZlZXNDb2xsZWN0ZWQAAAAAAAABAAAADmZlZXNfY29sbGVjdGVkAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADlBvc2l0aW9uQ2xvc2VkAAAAAAABAAAAD3Bvc2l0aW9uX2Nsb3NlZAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAcAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAApjb2xsYXRlcmFsAAAAAAATAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAAltYXhfdHJhZGUAAAAAAAALAAAAAAAAAAptYXhfbWFya2V0AAAAAAALAAAAAAAAAAltYXhfZGFpbHkAAAAAAAALAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAD1RyYWRlQXV0aG9yaXplZAAAAAABAAAAEHRyYWRlX2F1dGhvcml6ZWQAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAMbWFya2V0X3RvdGFsAAAACwAAAAAAAAAAAAAAC2RhaWx5X3RvdGFsAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAARYXZhaWxhYmxlX2NhcGl0YWwAAAAAAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAGBDcmVhdGVzIGFuZCBzZWVkcyBhIG1hcmtldCB1c2luZyB0cmVhc3VyeSBjYXBpdGFsLiBUaGUgdHJlYXN1cnkKYmVjb21lcyB0aGUgbWFya2V0J3MgY3JlYXRvci9MUC4AAAATYWdlbnRfY3JlYXRlX21hcmtldAAAAAAHAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAAD3Jlc29sdXRpb25faGFzaAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAADpQdWxscyBhY2NydWVkIGZlZXMgZnJvbSBhIGNvbmZpZ3VyZWQgbWFya2V0LWNvcmUgY29udHJhY3QuAAAAAAATY29sbGVjdF9tYXJrZXRfZmVlcwAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
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
        available_capital: this.txFromJSON<Result<i128>>,
        agent_create_market: this.txFromJSON<Result<u64>>,
        collect_market_fees: this.txFromJSON<Result<i128>>,
        claim_pool_remainder: this.txFromJSON<Result<i128>>
  }
}