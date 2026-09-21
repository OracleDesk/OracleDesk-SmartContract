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

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"InvalidConfig"},
  4: {message:"MarketAlreadyConfigured"},
  5: {message:"MarketNotConfigured"},
  6: {message:"WrongMode"},
  7: {message:"MarketNotClosed"},
  8: {message:"PriceUnavailable"},
  9: {message:"StalePrice"},
  10: {message:"InvalidPrice"},
  11: {message:"NotSigner"},
  12: {message:"AlreadyAttested"},
  13: {message:"ThresholdNotReached"},
  14: {message:"DisputeActive"},
  15: {message:"DisputeWindowOpen"},
  16: {message:"NoProposal"},
  17: {message:"AlreadyFinalized"},
  18: {message:"SpecHashMismatch"}
}

export type OracleAsset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


export interface PriceConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_staleness: u64;
  reflector: string;
  threshold: i128;
}


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}

export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

export type ResolutionState = {tag: "Unconfigured", values: void} | {tag: "SignersPending", values: void} | {tag: "Finalized", values: void};




export interface Client {
  /**
   * Construct and simulate a state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<ResolutionState>>

  /**
   * Construct and simulate a attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  attest: ({market_id, signer, outcome}: {market_id: u64, signer: string, outcome: Outcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a cancel_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: withdraws an unfinalized signer proposal, e.g. because
   * evidence surfaced during the dispute window that it is wrong. Voting
   * can restart once the counts are cleared by re-attesting.
   */
  cancel_proposal: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a finalize_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  finalize_signers: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a register_price_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals the resolution rule committed to at market creation. Anyone
   * may call this (there is no admin gate) because the only thing that
   * makes a spec acceptable is that it hashes to `market.resolution_hash`
   * — the commitment, not the caller, is the authority. Fails if a spec
   * was already registered for this market.
   */
  register_price_spec: ({market_id, spec}: {market_id: u64, spec: PriceConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a guardian_void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: voids an unresolvable market directly through
   * market-core. The resolver is the direct caller, so market-core's
   * `require_resolver` check passes the same way `resolve_price` does.
   */
  guardian_void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_signer_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, signer mode.
   */
  register_signer_spec: ({market_id, spec}: {market_id: u64, spec: SignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, market_core}: {admin: string, market_core: string},
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
    return ContractClient.deploy({admin, market_core}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAABdNYXJrZXRBbHJlYWR5Q29uZmlndXJlZAAAAAAEAAAAAAAAABNNYXJrZXROb3RDb25maWd1cmVkAAAAAAUAAAAAAAAACVdyb25nTW9kZQAAAAAAAAYAAAAAAAAAD01hcmtldE5vdENsb3NlZAAAAAAHAAAAAAAAABBQcmljZVVuYXZhaWxhYmxlAAAACAAAAAAAAAAKU3RhbGVQcmljZQAAAAAACQAAAAAAAAAMSW52YWxpZFByaWNlAAAACgAAAAAAAAAJTm90U2lnbmVyAAAAAAAACwAAAAAAAAAPQWxyZWFkeUF0dGVzdGVkAAAAAAwAAAAAAAAAE1RocmVzaG9sZE5vdFJlYWNoZWQAAAAADQAAAAAAAAANRGlzcHV0ZUFjdGl2ZQAAAAAAAA4AAAAAAAAAEURpc3B1dGVXaW5kb3dPcGVuAAAAAAAADwAAAAAAAAAKTm9Qcm9wb3NhbAAAAAAAEAAAAAAAAAAQQWxyZWFkeUZpbmFsaXplZAAAABEAAAAAAAAAEFNwZWNIYXNoTWlzbWF0Y2gAAAAS",
        "AAAAAAAAAAAAAAAFc3RhdGUAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAPUmVzb2x1dGlvblN0YXRlAA==",
        "AAAAAAAAAAAAAAAGYXR0ZXN0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAANcmVzb2x2ZV9wcmljZQAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAAAgAAAAAAAAAAAAAAD1Jlc29sdXRpb25TdGF0ZQAAAAADAAAAAAAAAAAAAAAMVW5jb25maWd1cmVkAAAAAAAAAAAAAAAOU2lnbmVyc1BlbmRpbmcAAAAAAAAAAAAAAAAACUZpbmFsaXplZAAAAA==",
        "AAAABQAAAAAAAAAAAAAAD1ByaWNlUmVzb2x1dGlvbgAAAAABAAAAEHByaWNlX3Jlc29sdXRpb24AAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAAAAAAPcHJpY2VfdGltZXN0YW1wAAAAAAYAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAg==",
        "AAAAAAAAAMVHdWFyZGlhbiBhY3Rpb246IHdpdGhkcmF3cyBhbiB1bmZpbmFsaXplZCBzaWduZXIgcHJvcG9zYWwsIGUuZy4gYmVjYXVzZQpldmlkZW5jZSBzdXJmYWNlZCBkdXJpbmcgdGhlIGRpc3B1dGUgd2luZG93IHRoYXQgaXQgaXMgd3JvbmcuIFZvdGluZwpjYW4gcmVzdGFydCBvbmNlIHRoZSBjb3VudHMgYXJlIGNsZWFyZWQgYnkgcmUtYXR0ZXN0aW5nLgAAAAAAAA9jYW5jZWxfcHJvcG9zYWwAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAQZmluYWxpemVfc2lnbmVycwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAABQAAAAAAAAAAAAAAElJlc29sdXRpb25Qcm9wb3NlZAAAAAAAAQAAABNyZXNvbHV0aW9uX3Byb3Bvc2VkAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1Jlc29sdXRpb25GaW5hbGl6ZWQAAAAAAQAAABRyZXNvbHV0aW9uX2ZpbmFsaXplZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAxmaW5hbGl6ZWRfYXQAAAAGAAAAAAAAAAI=",
        "AAAAAAAAATpSZXZlYWxzIHRoZSByZXNvbHV0aW9uIHJ1bGUgY29tbWl0dGVkIHRvIGF0IG1hcmtldCBjcmVhdGlvbi4gQW55b25lCm1heSBjYWxsIHRoaXMgKHRoZXJlIGlzIG5vIGFkbWluIGdhdGUpIGJlY2F1c2UgdGhlIG9ubHkgdGhpbmcgdGhhdAptYWtlcyBhIHNwZWMgYWNjZXB0YWJsZSBpcyB0aGF0IGl0IGhhc2hlcyB0byBgbWFya2V0LnJlc29sdXRpb25faGFzaGAK4oCUIHRoZSBjb21taXRtZW50LCBub3QgdGhlIGNhbGxlciwgaXMgdGhlIGF1dGhvcml0eS4gRmFpbHMgaWYgYSBzcGVjCndhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAAE3JlZ2lzdGVyX3ByaWNlX3NwZWMAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAALUHJpY2VDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAMJHdWFyZGlhbiBhY3Rpb246IHZvaWRzIGFuIHVucmVzb2x2YWJsZSBtYXJrZXQgZGlyZWN0bHkgdGhyb3VnaAptYXJrZXQtY29yZS4gVGhlIHJlc29sdmVyIGlzIHRoZSBkaXJlY3QgY2FsbGVyLCBzbyBtYXJrZXQtY29yZSdzCmByZXF1aXJlX3Jlc29sdmVyYCBjaGVjayBwYXNzZXMgdGhlIHNhbWUgd2F5IGByZXNvbHZlX3ByaWNlYCBkb2VzLgAAAAAAFGd1YXJkaWFuX3ZvaWRfbWFya2V0AAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAENTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUuAAAAABRyZWdpc3Rlcl9zaWduZXJfc3BlYwAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    state: this.txFromJSON<ResolutionState>,
        attest: this.txFromJSON<Result<void>>,
        resolve_price: this.txFromJSON<Result<Outcome>>,
        cancel_proposal: this.txFromJSON<Result<void>>,
        finalize_signers: this.txFromJSON<Result<Outcome>>,
        register_price_spec: this.txFromJSON<Result<void>>,
        guardian_void_market: this.txFromJSON<Result<void>>,
        register_signer_spec: this.txFromJSON<Result<void>>
  }
}