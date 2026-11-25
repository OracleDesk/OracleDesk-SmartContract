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
  4: {message:"OperationNotFound"},
  5: {message:"OperationNotReady"},
  6: {message:"OperationExpired"},
  7: {message:"OperationNotPending"},
  8: {message:"EmergencyNotAllowed"},
  9: {message:"DelayOutOfRange"},
  10: {message:"FloorRaiseRequiresTimelock"},
  11: {message:"NoPendingAdmin"},
  12: {message:"AdminTransferExpired"},
  /**
   * A scheduled self-call to a function the timelock cannot apply itself.
   */
  13: {message:"SelfCallUnsupported"}
}


export interface Roles {
  canceller: string;
  emergency: Option<string>;
  executor: Option<string>;
  proposer: string;
}

export type DataKey = {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "PendingAdminAt", values: void} | {tag: "Roles", values: void} | {tag: "DefaultDelay", values: void} | {tag: "Delay", values: readonly [string, string]} | {tag: "NextId", values: void} | {tag: "Op", values: readonly [u64]};




/**
 * A scheduled call. It exists in storage only while pending; `execute` and
 * `cancel` both remove it.
 */
export interface Operation {
  args: Array<any>;
  eta: u64;
  expires: u64;
  fn_name: string;
  proposer: string;
  target: string;
}









export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a roles transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  roles: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Roles>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels a pending operation. Only the canceller role may call this.
   */
  cancel: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Executes a due operation. Callable by the configured `executor`, or by
   * anyone when `executor` is `None`.
   */
  execute: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Schedules `target.fn_name(args)`. The proposer must hold the proposer
   * role; the effective delay is the larger of the global floor and any
   * `(target, fn_name)` override.
   */
  schedule: ({target, fn_name, args}: {target: string, fn_name: string, args: Array<any>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a delay_for transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The delay a call to `(target, fn_name)` would wait right now.
   */
  delay_for: ({target, fn_name}: {target: string, fn_name: string}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a emergency transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bypasses the delay for a small allow-list of safety calls. The
   * `emergency` role must be configured and hold auth.
   */
  emergency: ({target, fn_name, args}: {target: string, fn_name: string, args: Array<any>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a operation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  operation: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Operation>>>

  /**
   * Construct and simulate a set_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets or clears a `(target, fn_name)` delay override.
   */
  set_delay: ({target, fn_name, delay}: {target: string, fn_name: string, delay: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_roles transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the roles. Admin action (redirect it through `schedule` in
   * production so operators cannot silently swap each other).
   */
  set_roles: ({proposer, canceller, executor, emergency}: {proposer: string, canceller: string, executor: Option<string>, emergency: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a default_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  default_delay: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a operation_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  operation_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a set_default_delay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the global delay floor. Increasing it must go through the timelock
   * itself (schedule a self-call), so an operator cannot quietly extend
   * every in-flight delay; decreasing it is a normal admin action.
   */
  set_default_delay: ({delay}: {delay: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_admin_transfer: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, proposer, canceller, executor, emergency, default_delay}: {admin: string, proposer: string, canceller: string, executor: Option<string>, emergency: Option<string>, default_delay: u64},
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
    return ContractClient.deploy({admin, proposer, canceller, executor, emergency, default_delay}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADQAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAABFPcGVyYXRpb25Ob3RGb3VuZAAAAAAAAAQAAAAAAAAAEU9wZXJhdGlvbk5vdFJlYWR5AAAAAAAABQAAAAAAAAAQT3BlcmF0aW9uRXhwaXJlZAAAAAYAAAAAAAAAE09wZXJhdGlvbk5vdFBlbmRpbmcAAAAABwAAAAAAAAATRW1lcmdlbmN5Tm90QWxsb3dlZAAAAAAIAAAAAAAAAA9EZWxheU91dE9mUmFuZ2UAAAAACQAAAAAAAAAaRmxvb3JSYWlzZVJlcXVpcmVzVGltZWxvY2sAAAAAAAoAAAAAAAAADk5vUGVuZGluZ0FkbWluAAAAAAALAAAAAAAAABRBZG1pblRyYW5zZmVyRXhwaXJlZAAAAAwAAABFQSBzY2hlZHVsZWQgc2VsZi1jYWxsIHRvIGEgZnVuY3Rpb24gdGhlIHRpbWVsb2NrIGNhbm5vdCBhcHBseSBpdHNlbGYuAAAAAAAAE1NlbGZDYWxsVW5zdXBwb3J0ZWQAAAAADQ==",
        "AAAAAQAAAAAAAAAAAAAABVJvbGVzAAAAAAAABAAAAAAAAAAJY2FuY2VsbGVyAAAAAAAAEwAAAAAAAAAJZW1lcmdlbmN5AAAAAAAD6AAAABMAAAAAAAAACGV4ZWN1dG9yAAAD6AAAABMAAAAAAAAACHByb3Bvc2VyAAAAEw==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACAAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAOUGVuZGluZ0FkbWluQXQAAAAAAAAAAAAAAAAABVJvbGVzAAAAAAAAAAAAAAAAAAAMRGVmYXVsdERlbGF5AAAAAQAAAAAAAAAFRGVsYXkAAAAAAAACAAAAEwAAABEAAAAAAAAAAAAAAAZOZXh0SWQAAAAAAAEAAAAAAAAAAk9wAAAAAAABAAAABg==",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "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",
        "AAAAAAAAAHlTZXRzIHRoZSByb2xlcy4gQWRtaW4gYWN0aW9uIChyZWRpcmVjdCBpdCB0aHJvdWdoIGBzY2hlZHVsZWAgaW4KcHJvZHVjdGlvbiBzbyBvcGVyYXRvcnMgY2Fubm90IHNpbGVudGx5IHN3YXAgZWFjaCBvdGhlcikuAAAAAAAACXNldF9yb2xlcwAAAAAAAAQAAAAAAAAACHByb3Bvc2VyAAAAEwAAAAAAAAAJY2FuY2VsbGVyAAAAAAAAEwAAAAAAAAAIZXhlY3V0b3IAAAPoAAAAEwAAAAAAAAAJZW1lcmdlbmN5AAAAAAAD6AAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAljYW5jZWxsZXIAAAAAAAATAAAAAAAAAAhleGVjdXRvcgAAA+gAAAATAAAAAAAAAAllbWVyZ2VuY3kAAAAAAAPoAAAAEwAAAAAAAAANZGVmYXVsdF9kZWxheQAAAAAAAAYAAAAA",
        "AAAAAAAAAAAAAAANZGVmYXVsdF9kZWxheQAAAAAAAAAAAAABAAAABg==",
        "AAAAAAAAAAAAAAANcGVuZGluZ19hZG1pbgAAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAAAAAAANcHJvcG9zZV9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAD0RlZmF1bHREZWxheVNldAAAAAABAAAAEWRlZmF1bHRfZGVsYXlfc2V0AAAAAAAAAQAAAAAAAAAFZGVsYXkAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAAAAAAAAAAAAAPb3BlcmF0aW9uX2NvdW50AAAAAAAAAAABAAAABg==",
        "AAAABQAAAAAAAAAAAAAAEUVtZXJnZW5jeUV4ZWN1dGVkAAAAAAAAAQAAABJlbWVyZ2VuY3lfZXhlY3V0ZWQAAAAAAAIAAAAAAAAABnRhcmdldAAAAAAAEwAAAAAAAAAAAAAAB2ZuX25hbWUAAAAAEQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEU9wZXJhdGlvbkV4ZWN1dGVkAAAAAAAAAQAAABJvcGVyYXRpb25fZXhlY3V0ZWQAAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEk9wZXJhdGlvbkNhbmNlbGxlZAAAAAAAAQAAABNvcGVyYXRpb25fY2FuY2VsbGVkAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEk9wZXJhdGlvblNjaGVkdWxlZAAAAAAAAQAAABNvcGVyYXRpb25fc2NoZWR1bGVkAAAAAAQAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAGdGFyZ2V0AAAAAAATAAAAAAAAAAAAAAAHZm5fbmFtZQAAAAARAAAAAAAAAAAAAAADZXRhAAAAAAYAAAAAAAAAAg==",
        "AAAAAAAAAMpTZXRzIHRoZSBnbG9iYWwgZGVsYXkgZmxvb3IuIEluY3JlYXNpbmcgaXQgbXVzdCBnbyB0aHJvdWdoIHRoZSB0aW1lbG9jawppdHNlbGYgKHNjaGVkdWxlIGEgc2VsZi1jYWxsKSwgc28gYW4gb3BlcmF0b3IgY2Fubm90IHF1aWV0bHkgZXh0ZW5kCmV2ZXJ5IGluLWZsaWdodCBkZWxheTsgZGVjcmVhc2luZyBpdCBpcyBhIG5vcm1hbCBhZG1pbiBhY3Rpb24uAAAAAAARc2V0X2RlZmF1bHRfZGVsYXkAAAAAAAABAAAAAAAAAAVkZWxheQAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<Result<string>>,
        roles: this.txFromJSON<Result<Roles>>,
        cancel: this.txFromJSON<Result<void>>,
        execute: this.txFromJSON<Result<void>>,
        schedule: this.txFromJSON<Result<u64>>,
        delay_for: this.txFromJSON<u64>,
        emergency: this.txFromJSON<Result<void>>,
        operation: this.txFromJSON<Option<Operation>>,
        set_delay: this.txFromJSON<Result<void>>,
        set_roles: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        default_delay: this.txFromJSON<u64>,
        pending_admin: this.txFromJSON<Option<string>>,
        propose_admin: this.txFromJSON<Result<void>>,
        operation_count: this.txFromJSON<u64>,
        set_default_delay: this.txFromJSON<Result<void>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>
  }
}