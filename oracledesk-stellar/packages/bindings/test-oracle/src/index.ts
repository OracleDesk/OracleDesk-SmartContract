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




/**
 * SEP-40 Asset identifier. Variant names and order match `resolver::OracleAsset`.
 */
export type Asset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"UnknownAsset"},
  4: {message:"MisalignedTimestamp"},
  5: {message:"FutureTimestamp"},
  6: {message:"TooManyRecords"},
  7: {message:"InvalidConfig"},
  8: {message:"TooManyAssets"}
}

export type DataKey = {tag: "Admin", values: void} | {tag: "Base", values: void} | {tag: "Decimals", values: void} | {tag: "Resolution", values: void} | {tag: "Period", values: void} | {tag: "Assets", values: void} | {tag: "Price", values: readonly [Asset, u64]} | {tag: "LastSlot", values: readonly [Asset]} | {tag: "OldestSlot", values: readonly [Asset]};


/**
 * SEP-40 price record returned by `price`, `prices`, and `lastprice`.
 */
export interface PriceData {
  price: i128;
  timestamp: u64;
}

export interface Client {
  /**
   * Construct and simulate a base transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Base asset that prices are quoted in (for example `Asset::Other("USD")`).
   */
  base: (options?: MethodOptions) => Promise<AssembledTransaction<Asset>>

  /**
   * Construct and simulate a price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the price record for `asset` at `timestamp`, rounded down to
   * the resolution slot `timestamp - (timestamp % resolution)`.
   */
  price: ({asset, timestamp}: {asset: Asset, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceData>>>

  /**
   * Construct and simulate a assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supported assets registered via `add_asset`.
   */
  assets: (options?: MethodOptions) => Promise<AssembledTransaction<Array<Asset>>>

  /**
   * Construct and simulate a period transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Retention period in seconds. Records older than `latest_slot - period`
   * are pruned on subsequent writes.
   */
  period: (options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a prices transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns up to `records` most recent price records for `asset`, ordered
   * newest-first. Returns `None` if `asset` has no stored prices or
   * `records == 0`. Capped at [`MAX_PRICES_RECORDS`].
   */
  prices: ({asset, records}: {asset: Asset, records: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Array<PriceData>>>>

  /**
   * Construct and simulate a decimals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fixed-point decimal places for returned prices.
   */
  decimals: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a add_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Registers an asset so prices may be posted for it. Idempotent.
   */
  add_asset: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a lastprice transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the newest recorded price for `asset`, if any.
   */
  lastprice: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceData>>>

  /**
   * Construct and simulate a set_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Posts a single price observation for a registered `asset` at `timestamp`.
   * 
   * `timestamp` must be aligned to `resolution()` and must not exceed the
   * current ledger timestamp (`FutureTimestamp`). Note that `price <= 0` is
   * deliberately permitted so resolver validation of invalid prices can be
   * tested against a deployed oracle.
   */
  set_price: ({asset, price, timestamp}: {asset: Asset, price: i128, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolution transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Feed cadence in seconds. Timestamps align to multiples of `resolution`.
   */
  resolution: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a set_period transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Updates the retention horizon in seconds.
   */
  set_period: ({period}: {period: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_prices transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Posts a batch of `(asset, price)` observations for the same `timestamp`.
   */
  set_prices: ({entries, timestamp}: {entries: Array<readonly [Asset, i128]>, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, base, decimals, resolution, period}: {admin: string, base: Asset, decimals: u32, resolution: u32, period: u64},
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
    return ContractClient.deploy({admin, base, decimals, resolution, period}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAgAAAE9TRVAtNDAgQXNzZXQgaWRlbnRpZmllci4gVmFyaWFudCBuYW1lcyBhbmQgb3JkZXIgbWF0Y2ggYHJlc29sdmVyOjpPcmFjbGVBc3NldGAuAAAAAAAAAAAFQXNzZXQAAAAAAAACAAAAAQAAAAAAAAAHU3RlbGxhcgAAAAABAAAAEwAAAAEAAAAAAAAABU90aGVyAAAAAAAAAQAAABE=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADFVua25vd25Bc3NldAAAAAMAAAAAAAAAE01pc2FsaWduZWRUaW1lc3RhbXAAAAAABAAAAAAAAAAPRnV0dXJlVGltZXN0YW1wAAAAAAUAAAAAAAAADlRvb01hbnlSZWNvcmRzAAAAAAAGAAAAAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAABwAAAAAAAAANVG9vTWFueUFzc2V0cwAAAAAAAAg=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACQAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAEQmFzZQAAAAAAAAAAAAAACERlY2ltYWxzAAAAAAAAAAAAAAAKUmVzb2x1dGlvbgAAAAAAAAAAAAAAAAAGUGVyaW9kAAAAAAAAAAAAAAAAAAZBc3NldHMAAAAAAAEAAAAAAAAABVByaWNlAAAAAAAAAgAAB9AAAAAFQXNzZXQAAAAAAAAGAAAAAQAAAAAAAAAITGFzdFNsb3QAAAABAAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAACk9sZGVzdFNsb3QAAAAAAAEAAAfQAAAABUFzc2V0AAAA",
        "AAAAAQAAAENTRVAtNDAgcHJpY2UgcmVjb3JkIHJldHVybmVkIGJ5IGBwcmljZWAsIGBwcmljZXNgLCBhbmQgYGxhc3RwcmljZWAuAAAAAAAAAAAJUHJpY2VEYXRhAAAAAAAAAgAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAG",
        "AAAAAAAAAElCYXNlIGFzc2V0IHRoYXQgcHJpY2VzIGFyZSBxdW90ZWQgaW4gKGZvciBleGFtcGxlIGBBc3NldDo6T3RoZXIoIlVTRCIpYCkuAAAAAAAABGJhc2UAAAAAAAAAAQAAB9AAAAAFQXNzZXQAAAA=",
        "AAAAAAAAAIBSZXR1cm5zIHRoZSBwcmljZSByZWNvcmQgZm9yIGBhc3NldGAgYXQgYHRpbWVzdGFtcGAsIHJvdW5kZWQgZG93biB0bwp0aGUgcmVzb2x1dGlvbiBzbG90IGB0aW1lc3RhbXAgLSAodGltZXN0YW1wICUgcmVzb2x1dGlvbilgLgAAAAVwcmljZQAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAEAAAPoAAAH0AAAAAlQcmljZURhdGEAAAA=",
        "AAAAAAAAACxTdXBwb3J0ZWQgYXNzZXRzIHJlZ2lzdGVyZWQgdmlhIGBhZGRfYXNzZXRgLgAAAAZhc3NldHMAAAAAAAAAAAABAAAD6gAAB9AAAAAFQXNzZXQAAAA=",
        "AAAAAAAAAGdSZXRlbnRpb24gcGVyaW9kIGluIHNlY29uZHMuIFJlY29yZHMgb2xkZXIgdGhhbiBgbGF0ZXN0X3Nsb3QgLSBwZXJpb2RgCmFyZSBwcnVuZWQgb24gc3Vic2VxdWVudCB3cml0ZXMuAAAAAAZwZXJpb2QAAAAAAAAAAAABAAAD6AAAAAY=",
        "AAAAAAAAALhSZXR1cm5zIHVwIHRvIGByZWNvcmRzYCBtb3N0IHJlY2VudCBwcmljZSByZWNvcmRzIGZvciBgYXNzZXRgLCBvcmRlcmVkCm5ld2VzdC1maXJzdC4gUmV0dXJucyBgTm9uZWAgaWYgYGFzc2V0YCBoYXMgbm8gc3RvcmVkIHByaWNlcyBvcgpgcmVjb3JkcyA9PSAwYC4gQ2FwcGVkIGF0IFtgTUFYX1BSSUNFU19SRUNPUkRTYF0uAAAABnByaWNlcwAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAdyZWNvcmRzAAAAAAQAAAABAAAD6AAAA+oAAAfQAAAACVByaWNlRGF0YQAAAA==",
        "AAAAAAAAAC9GaXhlZC1wb2ludCBkZWNpbWFsIHBsYWNlcyBmb3IgcmV0dXJuZWQgcHJpY2VzLgAAAAAIZGVjaW1hbHMAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAD5SZWdpc3RlcnMgYW4gYXNzZXQgc28gcHJpY2VzIG1heSBiZSBwb3N0ZWQgZm9yIGl0LiBJZGVtcG90ZW50LgAAAAAACWFkZF9hc3NldAAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADZSZXR1cm5zIHRoZSBuZXdlc3QgcmVjb3JkZWQgcHJpY2UgZm9yIGBhc3NldGAsIGlmIGFueS4AAAAAAAlsYXN0cHJpY2UAAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAAUFQb3N0cyBhIHNpbmdsZSBwcmljZSBvYnNlcnZhdGlvbiBmb3IgYSByZWdpc3RlcmVkIGBhc3NldGAgYXQgYHRpbWVzdGFtcGAuCgpgdGltZXN0YW1wYCBtdXN0IGJlIGFsaWduZWQgdG8gYHJlc29sdXRpb24oKWAgYW5kIG11c3Qgbm90IGV4Y2VlZCB0aGUKY3VycmVudCBsZWRnZXIgdGltZXN0YW1wIChgRnV0dXJlVGltZXN0YW1wYCkuIE5vdGUgdGhhdCBgcHJpY2UgPD0gMGAgaXMKZGVsaWJlcmF0ZWx5IHBlcm1pdHRlZCBzbyByZXNvbHZlciB2YWxpZGF0aW9uIG9mIGludmFsaWQgcHJpY2VzIGNhbiBiZQp0ZXN0ZWQgYWdhaW5zdCBhIGRlcGxveWVkIG9yYWNsZS4AAAAAAAAJc2V0X3ByaWNlAAAAAAAAAwAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEdGZWVkIGNhZGVuY2UgaW4gc2Vjb25kcy4gVGltZXN0YW1wcyBhbGlnbiB0byBtdWx0aXBsZXMgb2YgYHJlc29sdXRpb25gLgAAAAAKcmVzb2x1dGlvbgAAAAAAAAAAAAEAAAAE",
        "AAAAAAAAAClVcGRhdGVzIHRoZSByZXRlbnRpb24gaG9yaXpvbiBpbiBzZWNvbmRzLgAAAAAAAApzZXRfcGVyaW9kAAAAAAABAAAAAAAAAAZwZXJpb2QAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAEhQb3N0cyBhIGJhdGNoIG9mIGAoYXNzZXQsIHByaWNlKWAgb2JzZXJ2YXRpb25zIGZvciB0aGUgc2FtZSBgdGltZXN0YW1wYC4AAAAKc2V0X3ByaWNlcwAAAAAAAgAAAAAAAAAHZW50cmllcwAAAAPqAAAD7QAAAAIAAAfQAAAABUFzc2V0AAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAALZJbml0aWFsaXplcyB0aGUgU0VQLTQwIHRlc3Qgb3JhY2xlLgoKYHJlc29sdXRpb25gIGlzIHRoZSBzbG90IGNhZGVuY2UgaW4gc2Vjb25kcyAoZS5nLiBgMzAwYCBmb3IgNSBtaW51dGVzKS4KYHBlcmlvZGAgaXMgdGhlIHJldGVudGlvbiBob3Jpem9uIGluIHNlY29uZHMgKGUuZy4gYDg2NDAwYCBmb3IgMjQgaG91cnMpLgAAAAAADV9fY29uc3RydWN0b3IAAAAAAAAFAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABGJhc2UAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAhkZWNpbWFscwAAAAQAAAAAAAAACnJlc29sdXRpb24AAAAAAAQAAAAAAAAABnBlcmlvZAAAAAAABgAAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    base: this.txFromJSON<Asset>,
        price: this.txFromJSON<Option<PriceData>>,
        assets: this.txFromJSON<Array<Asset>>,
        period: this.txFromJSON<Option<u64>>,
        prices: this.txFromJSON<Option<Array<PriceData>>>,
        decimals: this.txFromJSON<u32>,
        add_asset: this.txFromJSON<Result<void>>,
        lastprice: this.txFromJSON<Option<PriceData>>,
        set_price: this.txFromJSON<Result<void>>,
        resolution: this.txFromJSON<u32>,
        set_period: this.txFromJSON<Result<void>>,
        set_prices: this.txFromJSON<Result<void>>
  }
}