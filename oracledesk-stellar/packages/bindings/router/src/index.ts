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
  /**
   * A `price`/`signers` config failed the resolver's own validation rules.
   */
  2: {message:"InvalidConfig"},
  /**
   * The envelope named a different network or market-core.
   */
  3: {message:"DomainMismatch"},
  /**
   * Empty or over-long trace content.
   */
  4: {message:"InvalidTrace"},
  /**
   * The router was asked to reveal a rule variant it does not support.
   */
  5: {message:"UnsupportedRule"},
  /**
   * `TraceArgs.action` does not match the trade side.
   */
  6: {message:"ActionMismatch"},
  /**
   * The downstream trade returned no positive shares.
   */
  7: {message:"InvalidTradeResult"},
  /**
   * The supplied treasury is not wired to this router's market-core.
   */
  8: {message:"TreasuryMismatch"}
}


/**
 * The address book the router calls into. Without it, every entrypoint would
 * have to take the downstream contract addresses from the caller, letting
 * anyone point the router at a hostile "resolver". With it, the router is
 * stateless apart from this one instance value.
 */
export interface RouterConfig {
  market_core: string;
  reasoning_registry: Option<string>;
  resolver: string;
}

export type Side = {tag: "Buy", values: void} | {tag: "Sell", values: void};

export type TraceAction = {tag: "CreateMarket", values: void} | {tag: "ProposeMarket", values: void} | {tag: "Buy", values: void} | {tag: "Sell", values: void} | {tag: "Skip", values: void} | {tag: "Redeem", values: void} | {tag: "ClaimRemainder", values: void} | {tag: "Resolve", values: void} | {tag: "Other", values: readonly [string]};

export interface ChainArgs {
  expected_seq: u64;
  prev_trace_hash: Buffer;
}

export interface SigArgs {
  signature: Buffer;
  signing_key: Buffer;
}

export interface TraceArgs {
  action: TraceAction;
  chain: Option<ChainArgs>;
  ipfs_cid: string;
  sig: Option<SigArgs>;
  trace_hash: Buffer;
}

export interface TradeBounds {
  amount: i128;
  deadline: u64;
  limit_price_bps: u32;
  limit_shares: i128;
}

export interface TradeTraceResult {
  chain_seq: Option<u64>;
  shares: i128;
  trace_id: u64;
}

export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

export type Category = {tag: "Crypto", values: void} | {tag: "Macro", values: void} | {tag: "Geopolitics", values: void} | {tag: "Sports", values: void} | {tag: "Culture", values: void} | {tag: "Other", values: void};

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
  pubkey: Buffer;
  weight: u32;
}


export interface CommitteeRef {
  committee_id: u64;
  dispute_window: u64;
  max_rotation_delta: u32;
  min_epoch: u32;
}


export interface HybridConfig {
  fallback: SignerConfig;
  fallback_after: u64;
  price: PriceConfig;
}


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}

export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]};


export interface ResolutionSpecV2 {
  market_core: string;
  network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}


export interface WeightedKeyConfig {
  dispute_window: u64;
  signers: Array<WeightedKey>;
  weight_threshold: u32;
}


export interface DisputableSignerConfig {
  dispute_bond: i128;
  dispute_window: u64;
  escalation: Escalation;
  escalation_timeout: u64;
  signers: Array<string>;
  threshold: u32;
}

export interface Client {
  /**
   * Construct and simulate an agent_trade_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same atomic trade+trace flow, but the trade runs through the caller's treasury and the agent is the trace author.
   */
  agent_trade_and_publish_trace: ({treasury, agent, market_id, outcome, side, bounds, trace}: {treasury: string, agent: string, market_id: u64, outcome: Outcome, side: Side, bounds: TradeBounds, trace: TraceArgs}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<RouterConfig>>>

  /**
   * Construct and simulate a reveal_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals a spec the creator committed to in a previous transaction
   * (ADR 0001's commit-now/reveal-later path). Kept here so a creator can
   * use one contract for both the atomic and the deferred flows.
   */
  reveal_spec: ({market_id, spec_v2}: {market_id: u64, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a buy_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deprecated one-release compatibility wrapper for the direct buy path.
   * The `action: string` argument is gone; use `trade_and_publish_trace` for typed actions.
   */
  buy_and_publish_trace: ({trader, market_id, outcome, collateral_in, min_shares_out, trace_hash, ipfs_cid}: {trader: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, trace_hash: Buffer, ipfs_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

  /**
   * Construct and simulate a create_and_reveal_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See [`Router::create_and_reveal_signers`] — same flow, price rule.
   */
  create_and_reveal_price: ({creator, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {creator: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_and_reveal_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and reveals its signer-mode rule in one transaction.
   * The commitment is computed from `spec_v2` locally and passed to
   * market-core, so the reveal necessarily matches.
   */
  create_and_reveal_signers: ({creator, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {creator: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a trade_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Trades through `buy_v2`/`sell_v2` and publishes a typed trace in one transaction.
   */
  trade_and_publish_trace: ({trader, market_id, outcome, side, bounds, trace}: {trader: string, market_id: u64, outcome: Outcome, side: Side, bounds: TradeBounds, trace: TraceArgs}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {market_core, resolver, reasoning_registry}: {market_core: string, resolver: string, reasoning_registry: Option<string>},
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
    return ContractClient.deploy({market_core, resolver, reasoning_registry}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABQAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAABGQSBgcHJpY2VgL2BzaWduZXJzYCBjb25maWcgZmFpbGVkIHRoZSByZXNvbHZlcidzIG93biB2YWxpZGF0aW9uIHJ1bGVzLgAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAANlRoZSBlbnZlbG9wZSBuYW1lZCBhIGRpZmZlcmVudCBuZXR3b3JrIG9yIG1hcmtldC1jb3JlLgAAAAAADkRvbWFpbk1pc21hdGNoAAAAAAADAAAANmBidXlfYW5kX3B1Ymxpc2hfdHJhY2VgIHdhcyBnaXZlbiBlbXB0eSB0cmFjZSBjb250ZW50LgAAAAAADEludmFsaWRUcmFjZQAAAAQAAABCVGhlIHJvdXRlciB3YXMgYXNrZWQgdG8gcmV2ZWFsIGEgcnVsZSB2YXJpYW50IGl0IGRvZXMgbm90IHN1cHBvcnQuAAAAAAAPVW5zdXBwb3J0ZWRSdWxlAAAAAAU=",
        "AAAAAQAAAQhUaGUgYWRkcmVzcyBib29rIHRoZSByb3V0ZXIgY2FsbHMgaW50by4gV2l0aG91dCBpdCwgZXZlcnkgZW50cnlwb2ludCB3b3VsZApoYXZlIHRvIHRha2UgdGhlIGRvd25zdHJlYW0gY29udHJhY3QgYWRkcmVzc2VzIGZyb20gdGhlIGNhbGxlciwgbGV0dGluZwphbnlvbmUgcG9pbnQgdGhlIHJvdXRlciBhdCBhIGhvc3RpbGUgInJlc29sdmVyIi4gV2l0aCBpdCwgdGhlIHJvdXRlciBpcwpzdGF0ZWxlc3MgYXBhcnQgZnJvbSB0aGlzIG9uZSBpbnN0YW5jZSB2YWx1ZS4AAAAAAAAADFJvdXRlckNvbmZpZwAAAAMAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAAAAAAAEnJlYXNvbmluZ19yZWdpc3RyeQAAAAAD6AAAABMAAAAAAAAACHJlc29sdmVyAAAAEw==",
        "AAAABQAAAAAAAAAAAAAAF0JvdWdodEFuZFB1Ymxpc2hlZFRyYWNlAAAAAAEAAAAaYm91Z2h0X2FuZF9wdWJsaXNoZWRfdHJhY2UAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZ0cmFkZXIAAAAAABMAAAAAAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAGE1hcmtldENyZWF0ZWRBbmRSZXZlYWxlZAAAAAEAAAAbbWFya2V0X2NyZWF0ZWRfYW5kX3JldmVhbGVkAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAAAAAAAlzcGVjX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAC",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAA+kAAAfQAAAADFJvdXRlckNvbmZpZwAAAAM=",
        "AAAAAAAAAMRSZXZlYWxzIGEgc3BlYyB0aGUgY3JlYXRvciBjb21taXR0ZWQgdG8gaW4gYSBwcmV2aW91cyB0cmFuc2FjdGlvbgooQURSIDAwMDEncyBjb21taXQtbm93L3JldmVhbC1sYXRlciBwYXRoKS4gS2VwdCBoZXJlIHNvIGEgY3JlYXRvciBjYW4KdXNlIG9uZSBjb250cmFjdCBmb3IgYm90aCB0aGUgYXRvbWljIGFuZCB0aGUgZGVmZXJyZWQgZmxvd3MuAAAAC3JldmVhbF9zcGVjAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB3NwZWNfdjIAAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIJTdG9yZXMgdGhlIGFkZHJlc3MgYm9vayBvbmNlLCBhdCBkZXBsb3kgdGltZS4gVGhlcmUgaXMgbm8gcHJpdmlsZWdlZApyb2xlIGFuZCB0aGUgdmFsdWVzIG5ldmVyIGNoYW5nZSwgc28gdGhpcyBpcyBub3QgYWRtaW4tZ2F0ZWQuAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAMAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAAAAAAACHJlc29sdmVyAAAAEwAAAAAAAAAScmVhc29uaW5nX3JlZ2lzdHJ5AAAAAAPoAAAAEwAAAAA=",
        "AAAAAAAAAM5CdXlzIGBvdXRjb21lYCBzaGFyZXMgdGhyb3VnaCBtYXJrZXQtY29yZSBhbmQgcHVibGlzaGVzIGEgcmVhc29uaW5nCnRyYWNlIHRocm91Z2ggdGhlIHJlYXNvbmluZyByZWdpc3RyeSBpbiB0aGUgc2FtZSB0cmFuc2FjdGlvbiwgc28gYQp0cmFjZSBjYW5ub3QgYmUgc2tpcHBlZCBhZnRlciBhIHRyYWRlLiBUaGUgcmVnaXN0cnkgbXVzdCBiZSBjb25maWd1cmVkLgAAAAAAFWJ1eV9hbmRfcHVibGlzaF90cmFjZQAAAAAAAAgAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAAAAAAABmFjdGlvbgAAAAAAEAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAERTZWUgW2BSb3V0ZXI6OmNyZWF0ZV9hbmRfcmV2ZWFsX3NpZ25lcnNgXSDigJQgc2FtZSBmbG93LCBwcmljZSBydWxlLgAAABdjcmVhdGVfYW5kX3JldmVhbF9wcmljZQAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAALVDcmVhdGVzIGEgbWFya2V0IGFuZCByZXZlYWxzIGl0cyBzaWduZXItbW9kZSBydWxlIGluIG9uZSB0cmFuc2FjdGlvbi4KVGhlIGNvbW1pdG1lbnQgaXMgY29tcHV0ZWQgZnJvbSBgc3BlY192MmAgbG9jYWxseSBhbmQgcGFzc2VkIHRvCm1hcmtldC1jb3JlLCBzbyB0aGUgcmV2ZWFsIG5lY2Vzc2FyaWx5IG1hdGNoZXMuAAAAAAAAGWNyZWF0ZV9hbmRfcmV2ZWFsX3NpZ25lcnMAAAAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAgAAAAAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAEAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAAAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADENvbW1pdHRlZVJlZgAAAAQAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAABJtYXhfcm90YXRpb25fZGVsdGEAAAAAAAQAAAAAAAAACW1pbl9lcG9jaAAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAgAAAAAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAGAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAAAAAAAZIeWJyaWQAAAAAAAEAAAfQAAAADEh5YnJpZENvbmZpZw==",
        "AAAAAQAAAAAAAAAAAAAAEFJlc29sdXRpb25TcGVjVjIAAAAFAAAAAAAAAAttYXJrZXRfY29yZQAAAAATAAAAAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAAAQAAAAAAAAAAAAAAFkRpc3B1dGFibGVTaWduZXJDb25maWcAAAAAAAYAAAAAAAAADGRpc3B1dGVfYm9uZAAAAAsAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAplc2NhbGF0aW9uAAAAAAfQAAAACkVzY2FsYXRpb24AAAAAAAAAAAASZXNjYWxhdGlvbl90aW1lb3V0AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE" ]),
      options
    )
  }
  public readonly fromJSON = {
    config: this.txFromJSON<Result<RouterConfig>>,
        reveal_spec: this.txFromJSON<Result<void>>,
        buy_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>,
        create_and_reveal_price: this.txFromJSON<Result<u64>>,
        create_and_reveal_signers: this.txFromJSON<Result<u64>>,
        trade_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>,
        agent_trade_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>
  }
}