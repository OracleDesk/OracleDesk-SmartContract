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
  3: {message:"AgentAlreadyRegistered"},
  4: {message:"AgentNotRegistered"},
  5: {message:"TraceNotFound"},
  6: {message:"EmptyAction"},
  7: {message:"EmptyCid"}
}


export interface Trace {
  action: string;
  agent: string;
  ipfs_cid: string;
  market_id: u64;
  published_at: u64;
  trace_hash: Buffer;
}

export type DataKey = {tag: "Admin", values: void} | {tag: "NextId", values: void} | {tag: "Agent", values: readonly [string]} | {tag: "Trace", values: readonly [u64]} | {tag: "MarketTraceCount", values: readonly [u64]} | {tag: "MarketTrace", values: readonly [u64, u64]};



export interface Client {
  /**
   * Construct and simulate a get_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_trace: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Trace>>>

  /**
   * Construct and simulate a trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  trace_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a verify_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_trace: ({trace_id, received_hash}: {trace_id: u64, received_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_registered: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  publish_trace: ({agent, market_id, action, trace_hash, ipfs_cid}: {agent: string, market_id: u64, action: string, trace_hash: Buffer, ipfs_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a register_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  register_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a market_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The `index`-th (0-based, publish order) trace id for `market_id`.
   */
  market_trace_at: ({market_id, index}: {market_id: u64, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a unregister_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unregister_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a market_trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of traces published for `market_id`.
   */
  market_trace_count: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin}: {admin: string},
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
    return ContractClient.deploy({admin}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAAFkFnZW50QWxyZWFkeVJlZ2lzdGVyZWQAAAAAAAMAAAAAAAAAEkFnZW50Tm90UmVnaXN0ZXJlZAAAAAAABAAAAAAAAAANVHJhY2VOb3RGb3VuZAAAAAAAAAUAAAAAAAAAC0VtcHR5QWN0aW9uAAAAAAYAAAAAAAAACEVtcHR5Q2lkAAAABw==",
        "AAAAAQAAAAAAAAAAAAAABVRyYWNlAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAMcHVibGlzaGVkX2F0AAAABgAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACA=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAGTmV4dElkAAAAAAABAAAAAAAAAAVBZ2VudAAAAAAAAAEAAAATAAAAAQAAAAAAAAAFVHJhY2UAAAAAAAABAAAABgAAAAEAAAC+TnVtYmVyIG9mIHRyYWNlcyBwdWJsaXNoZWQgZm9yIGEgbWFya2V0LCBzbyBhIGNsaWVudCBjYW4gcGFnZSB0aHJvdWdoCmBNYXJrZXRUcmFjZShtYXJrZXRfaWQsIDAuLmNvdW50KWAgd2l0aG91dCB0aGUgY29udHJhY3QgZXZlciBob2xkaW5nCmFuIHVuYm91bmRlZCBWZWMgb2YgdHJhY2UgaWRzIGluIG9uZSBzdG9yYWdlIGVudHJ5LgAAAAAAEE1hcmtldFRyYWNlQ291bnQAAAABAAAABgAAAAEAAAAAAAAAC01hcmtldFRyYWNlAAAAAAIAAAAGAAAABg==",
        "AAAABQAAAAAAAAAAAAAADlRyYWNlUHVibGlzaGVkAAAAAAABAAAAD3RyYWNlX3B1Ymxpc2hlZAAAAAAHAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAAAAAAAAxwdWJsaXNoZWRfYXQAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD0FnZW50UmVnaXN0ZXJlZAAAAAABAAAAEGFnZW50X3JlZ2lzdGVyZWQAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAAAAAAAAAAAAAJZ2V0X3RyYWNlAAAAAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAfQAAAABVRyYWNlAAAAAAAAAw==",
        "AAAAAAAAAAAAAAALdHJhY2VfY291bnQAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMdmVyaWZ5X3RyYWNlAAAAAgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAA1yZWNlaXZlZF9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAAAAAAANcHVibGlzaF90cmFjZQAAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAp0cmFjZV9oYXNoAAAAAAPuAAAAIAAAAAAAAAAIaXBmc19jaWQAAAAQAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAOcmVnaXN0ZXJfYWdlbnQAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEFUaGUgYGluZGV4YC10aCAoMC1iYXNlZCwgcHVibGlzaCBvcmRlcikgdHJhY2UgaWQgZm9yIGBtYXJrZXRfaWRgLgAAAAAAAA9tYXJrZXRfdHJhY2VfYXQAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAFaW5kZXgAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAQdW5yZWdpc3Rlcl9hZ2VudAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAACtOdW1iZXIgb2YgdHJhY2VzIHB1Ymxpc2hlZCBmb3IgYG1hcmtldF9pZGAuAAAAABJtYXJrZXRfdHJhY2VfY291bnQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABg==" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_trace: this.txFromJSON<Result<Trace>>,
        trace_count: this.txFromJSON<u64>,
        verify_trace: this.txFromJSON<Result<boolean>>,
        is_registered: this.txFromJSON<boolean>,
        publish_trace: this.txFromJSON<Result<u64>>,
        register_agent: this.txFromJSON<Result<void>>,
        market_trace_at: this.txFromJSON<Result<u64>>,
        unregister_agent: this.txFromJSON<Result<void>>,
        market_trace_count: this.txFromJSON<u64>
  }
}