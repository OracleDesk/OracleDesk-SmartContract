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


export interface HybridConfigV2 {
  fallback: FallbackAuthority;
  fallback_after: u64;
  price: PriceConfig;
}

export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]} | {tag: "HybridV2", values: readonly [HybridConfigV2]} | {tag: "CategoricalSigners", values: readonly [CatSignerConfig]} | {tag: "Scalar", values: readonly [ScalarPriceConfig]};


export interface CatSignerConfig {
  dispute_window: u64;
  outcome_count: u32;
  signers: Array<string>;
  threshold: u32;
}


export interface ResolutionSpecV2 {
  market_core: string;
  network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}

export type FallbackAuthority = {tag: "Signers", values: readonly [SignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]};


export interface ScalarPriceConfig {
  asset: OracleAsset;
  lower: i128;
  max_staleness: u64;
  reflector: string;
  upper: i128;
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

export type Side = {tag: "Buy", values: void} | {tag: "Sell", values: void};

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
  8: {message:"TreasuryMismatch"},
  /**
   * The resolver and market-core point at different contracts.
   */
  9: {message:"WiringMismatch"},
  /**
   * The resolver did not store the rule kind that was revealed.
   */
  10: {message:"RuleMismatch"}
}


export interface TraceArgs {
  action: TraceAction;
  chain_expected_seq: u64;
  chain_prev_trace_hash: Buffer;
  /**
 * Chained publish requested. When `false`, `chain_expected_seq` and
 * `chain_prev_trace_hash` are ignored.
 */
chained: boolean;
  ipfs_cid: string;
  signature: Buffer;
  /**
 * Signed publish requested. When `false`, `signing_key` and `signature`
 * are ignored.
 */
signed: boolean;
  signing_key: Buffer;
  trace_hash: Buffer;
}

/**
 * Mirrors reasoning-registry's `TraceAction`. The enum is defined locally so
 * the router can pass a typed action without depending on the stale vendored
 * registry interface; its XDR shape is identical to the registry's.
 */
export type TraceAction = {tag: "CreateMarket", values: void} | {tag: "ProposeMarket", values: void} | {tag: "Buy", values: void} | {tag: "Sell", values: void} | {tag: "Skip", values: void} | {tag: "Redeem", values: void} | {tag: "ClaimRemainder", values: void} | {tag: "Resolve", values: void} | {tag: "Other", values: readonly [string]};


export interface TradeBounds {
  /**
 * `collateral_in` for a buy, `collateral_out` for a sell.
 */
amount: i128;
  deadline: u64;
  limit_price_bps: u32;
  /**
 * `min_shares_out` for a buy, `max_shares_in` for a sell.
 */
limit_shares: i128;
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


export interface TradeTraceResult {
  chain_seq: Option<u64>;
  shares: i128;
  trace_id: u64;
}



export interface Client {
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
   * Construct and simulate a create_and_reveal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and reveals any V2 rule in one transaction. The
   * resolver and treasury come from market-core's live configuration, so a
   * resolver swap cannot strand the new market in an untrusted resolver.
   */
  create_and_reveal: ({creator, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {creator: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a buy_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deprecated one-release compatibility wrapper for the direct buy path.
   * New callers should use `trade_and_publish_trace` with explicit bounds,
   * a typed action and optional chain/signature arguments.
   */
  buy_and_publish_trace: ({trader, market_id, outcome, collateral_in, min_shares_out, trace_hash, ipfs_cid}: {trader: string, market_id: u64, outcome: Outcome, collateral_in: i128, min_shares_out: i128, trace_hash: Buffer, ipfs_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

  /**
   * Construct and simulate a agent_create_and_reveal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market with treasury capital and reveals any V2 rule in one
   * transaction. Root authorization is anchored by the agent here; the
   * treasury still applies its role, caps and creation policy checks.
   */
  agent_create_and_reveal: ({agent, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {agent: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_and_reveal_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See [`Router::create_and_reveal_signers`] — same flow, price rule.
   */
  create_and_reveal_price: ({creator, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {creator: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a trade_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Trades `outcome` shares through market-core's `buy_v2`/`sell_v2` and
   * publishes a typed reasoning trace through the registry in the same
   * transaction. Optional chain and signature arguments select one of the
   * registry's four publish entrypoints. Emits `TradeTraced`.
   */
  trade_and_publish_trace: ({trader, market_id, outcome, side, bounds, trace}: {trader: string, market_id: u64, outcome: Outcome, side: Side, bounds: TradeBounds, trace: TraceArgs}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

  /**
   * Construct and simulate a create_and_reveal_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a market and reveals its signer-mode rule in one transaction.
   * The commitment is computed from `spec_v2` locally and passed to
   * market-core, so the reveal necessarily matches.
   */
  create_and_reveal_signers: ({creator, question_hash, meta_uri, category, close_time, seed_amount, initial_yes_bps, spec_v2}: {creator: string, question_hash: Buffer, meta_uri: string, category: Category, close_time: u64, seed_amount: i128, initial_yes_bps: u32, spec_v2: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_trade_and_publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same atomic trade+trace flow, but the trade runs through the caller's
   * treasury (`agent_buy_v2`/`agent_sell_v2`) and the agent is the trace
   * author. The treasury is caller-supplied, so it is checked against the
   * router's market-core both ways before any call is made: a hostile
   * treasury could otherwise make the router publish a trace for a trade
   * that never happened.
   */
  agent_trade_and_publish_trace: ({treasury, agent, market_id, outcome, side, bounds, trace}: {treasury: string, agent: string, market_id: u64, outcome: Outcome, side: Side, bounds: TradeBounds, trace: TraceArgs}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeTraceResult>>>

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
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAgAAAAAAAAAAAAAACENhdGVnb3J5AAAABgAAAAAAAAAAAAAABkNyeXB0bwAAAAAAAAAAAAAAAAAFTWFjcm8AAAAAAAAAAAAAAAAAAAtHZW9wb2xpdGljcwAAAAAAAAAAAAAAAAZTcG9ydHMAAAAAAAAAAAAAAAAAB0N1bHR1cmUAAAAAAAAAAAAAAAAFT3RoZXIAAAA=",
        "AAAAAgAAAAAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAEAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAAAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADENvbW1pdHRlZVJlZgAAAAQAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAABJtYXhfcm90YXRpb25fZGVsdGEAAAAAAAQAAAAAAAAACW1pbl9lcG9jaAAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "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",
        "AAAAAgAAAAAAAAAAAAAABFNpZGUAAAACAAAAAAAAAAAAAAADQnV5AAAAAAAAAAAAAAAABFNlbGw=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAABGQSBgcHJpY2VgL2BzaWduZXJzYCBjb25maWcgZmFpbGVkIHRoZSByZXNvbHZlcidzIG93biB2YWxpZGF0aW9uIHJ1bGVzLgAAAAAADUludmFsaWRDb25maWcAAAAAAAACAAAANlRoZSBlbnZlbG9wZSBuYW1lZCBhIGRpZmZlcmVudCBuZXR3b3JrIG9yIG1hcmtldC1jb3JlLgAAAAAADkRvbWFpbk1pc21hdGNoAAAAAAADAAAAIUVtcHR5IG9yIG92ZXItbG9uZyB0cmFjZSBjb250ZW50LgAAAAAAAAxJbnZhbGlkVHJhY2UAAAAEAAAAQlRoZSByb3V0ZXIgd2FzIGFza2VkIHRvIHJldmVhbCBhIHJ1bGUgdmFyaWFudCBpdCBkb2VzIG5vdCBzdXBwb3J0LgAAAAAAD1Vuc3VwcG9ydGVkUnVsZQAAAAAFAAAAMWBUcmFjZUFyZ3MuYWN0aW9uYCBkb2VzIG5vdCBtYXRjaCB0aGUgdHJhZGUgc2lkZS4AAAAAAAAOQWN0aW9uTWlzbWF0Y2gAAAAAAAYAAAAxVGhlIGRvd25zdHJlYW0gdHJhZGUgcmV0dXJuZWQgbm8gcG9zaXRpdmUgc2hhcmVzLgAAAAAAABJJbnZhbGlkVHJhZGVSZXN1bHQAAAAAAAcAAABAVGhlIHN1cHBsaWVkIHRyZWFzdXJ5IGlzIG5vdCB3aXJlZCB0byB0aGlzIHJvdXRlcidzIG1hcmtldC1jb3JlLgAAABBUcmVhc3VyeU1pc21hdGNoAAAACAAAADpUaGUgcmVzb2x2ZXIgYW5kIG1hcmtldC1jb3JlIHBvaW50IGF0IGRpZmZlcmVudCBjb250cmFjdHMuAAAAAAAOV2lyaW5nTWlzbWF0Y2gAAAAAAAkAAAA7VGhlIHJlc29sdmVyIGRpZCBub3Qgc3RvcmUgdGhlIHJ1bGUga2luZCB0aGF0IHdhcyByZXZlYWxlZC4AAAAADFJ1bGVNaXNtYXRjaAAAAAo=",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAA+kAAAfQAAAADFJvdXRlckNvbmZpZwAAAAM=",
        "AAAAAQAAAAAAAAAAAAAACVRyYWNlQXJncwAAAAAAAAkAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAtUcmFjZUFjdGlvbgAAAAAAAAAAEmNoYWluX2V4cGVjdGVkX3NlcQAAAAAABgAAAAAAAAAVY2hhaW5fcHJldl90cmFjZV9oYXNoAAAAAAAD7gAAACAAAABmQ2hhaW5lZCBwdWJsaXNoIHJlcXVlc3RlZC4gV2hlbiBgZmFsc2VgLCBgY2hhaW5fZXhwZWN0ZWRfc2VxYCBhbmQKYGNoYWluX3ByZXZfdHJhY2VfaGFzaGAgYXJlIGlnbm9yZWQuAAAAAAAHY2hhaW5lZAAAAAABAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAACXNpZ25hdHVyZQAAAAAAA+4AAABAAAAAUlNpZ25lZCBwdWJsaXNoIHJlcXVlc3RlZC4gV2hlbiBgZmFsc2VgLCBgc2lnbmluZ19rZXlgIGFuZCBgc2lnbmF0dXJlYAphcmUgaWdub3JlZC4AAAAAAAZzaWduZWQAAAAAAAEAAAAAAAAAC3NpZ25pbmdfa2V5AAAAA+4AAAAgAAAAAAAAAAp0cmFjZV9oYXNoAAAAAAPuAAAAIA==",
        "AAAAAAAAAMRSZXZlYWxzIGEgc3BlYyB0aGUgY3JlYXRvciBjb21taXR0ZWQgdG8gaW4gYSBwcmV2aW91cyB0cmFuc2FjdGlvbgooQURSIDAwMDEncyBjb21taXQtbm93L3JldmVhbC1sYXRlciBwYXRoKS4gS2VwdCBoZXJlIHNvIGEgY3JlYXRvciBjYW4KdXNlIG9uZSBjb250cmFjdCBmb3IgYm90aCB0aGUgYXRvbWljIGFuZCB0aGUgZGVmZXJyZWQgZmxvd3MuAAAAC3JldmVhbF9zcGVjAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB3NwZWNfdjIAAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAgAAANdNaXJyb3JzIHJlYXNvbmluZy1yZWdpc3RyeSdzIGBUcmFjZUFjdGlvbmAuIFRoZSBlbnVtIGlzIGRlZmluZWQgbG9jYWxseSBzbwp0aGUgcm91dGVyIGNhbiBwYXNzIGEgdHlwZWQgYWN0aW9uIHdpdGhvdXQgZGVwZW5kaW5nIG9uIHRoZSBzdGFsZSB2ZW5kb3JlZApyZWdpc3RyeSBpbnRlcmZhY2U7IGl0cyBYRFIgc2hhcGUgaXMgaWRlbnRpY2FsIHRvIHRoZSByZWdpc3RyeSdzLgAAAAAAAAAAC1RyYWNlQWN0aW9uAAAAAAkAAAAAAAAAAAAAAAxDcmVhdGVNYXJrZXQAAAAAAAAAAAAAAA1Qcm9wb3NlTWFya2V0AAAAAAAAAAAAAAAAAAADQnV5AAAAAAAAAAAAAAAABFNlbGwAAAAAAAAAAAAAAARTa2lwAAAAAAAAAAAAAAAGUmVkZWVtAAAAAAAAAAAAAAAAAA5DbGFpbVJlbWFpbmRlcgAAAAAAAAAAAAAAAAAHUmVzb2x2ZQAAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAAAAAAAAAAAAC1RyYWRlQm91bmRzAAAAAAQAAAA3YGNvbGxhdGVyYWxfaW5gIGZvciBhIGJ1eSwgYGNvbGxhdGVyYWxfb3V0YCBmb3IgYSBzZWxsLgAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAAD2xpbWl0X3ByaWNlX2JwcwAAAAAEAAAAN2BtaW5fc2hhcmVzX291dGAgZm9yIGEgYnV5LCBgbWF4X3NoYXJlc19pbmAgZm9yIGEgc2VsbC4AAAAADGxpbWl0X3NoYXJlcwAAAAs=",
        "AAAABQAAAAAAAAAAAAAAC1RyYWRlVHJhY2VkAAAAAAEAAAAMdHJhZGVfdHJhY2VkAAAABgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAAAAAAAAAAABHNpZGUAAAfQAAAABFNpZGUAAAAAAAAAAAAAAAZzaGFyZXMAAAAAAAsAAAAAAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAAAAAAAAAAAAAljaGFpbl9zZXEAAAAAAAPoAAAABgAAAAAAAAAC",
        "AAAAAQAAAQhUaGUgYWRkcmVzcyBib29rIHRoZSByb3V0ZXIgY2FsbHMgaW50by4gV2l0aG91dCBpdCwgZXZlcnkgZW50cnlwb2ludCB3b3VsZApoYXZlIHRvIHRha2UgdGhlIGRvd25zdHJlYW0gY29udHJhY3QgYWRkcmVzc2VzIGZyb20gdGhlIGNhbGxlciwgbGV0dGluZwphbnlvbmUgcG9pbnQgdGhlIHJvdXRlciBhdCBhIGhvc3RpbGUgInJlc29sdmVyIi4gV2l0aCBpdCwgdGhlIHJvdXRlciBpcwpzdGF0ZWxlc3MgYXBhcnQgZnJvbSB0aGlzIG9uZSBpbnN0YW5jZSB2YWx1ZS4AAAAAAAAADFJvdXRlckNvbmZpZwAAAAMAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAAAAAAAEnJlYXNvbmluZ19yZWdpc3RyeQAAAAAD6AAAABMAAAAAAAAACHJlc29sdmVyAAAAEw==",
        "AAAAAAAAAIJTdG9yZXMgdGhlIGFkZHJlc3MgYm9vayBvbmNlLCBhdCBkZXBsb3kgdGltZS4gVGhlcmUgaXMgbm8gcHJpdmlsZWdlZApyb2xlIGFuZCB0aGUgdmFsdWVzIG5ldmVyIGNoYW5nZSwgc28gdGhpcyBpcyBub3QgYWRtaW4tZ2F0ZWQuAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAMAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAAAAAAACHJlc29sdmVyAAAAEwAAAAAAAAAScmVhc29uaW5nX3JlZ2lzdHJ5AAAAAAPoAAAAEwAAAAA=",
        "AAAAAQAAAAAAAAAAAAAAEFRyYWRlVHJhY2VSZXN1bHQAAAADAAAAAAAAAAljaGFpbl9zZXEAAAAAAAPoAAAABgAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAh0cmFjZV9pZAAAAAY=",
        "AAAAAAAAAMxDcmVhdGVzIGEgbWFya2V0IGFuZCByZXZlYWxzIGFueSBWMiBydWxlIGluIG9uZSB0cmFuc2FjdGlvbi4gVGhlCnJlc29sdmVyIGFuZCB0cmVhc3VyeSBjb21lIGZyb20gbWFya2V0LWNvcmUncyBsaXZlIGNvbmZpZ3VyYXRpb24sIHNvIGEKcmVzb2x2ZXIgc3dhcCBjYW5ub3Qgc3RyYW5kIHRoZSBuZXcgbWFya2V0IGluIGFuIHVudHJ1c3RlZCByZXNvbHZlci4AAAARY3JlYXRlX2FuZF9yZXZlYWwAAAAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAABQAAAAAAAAAAAAAAE0FnZW50TWFya2V0UmV2ZWFsZWQAAAAAAQAAABVhZ2VudF9tYXJrZXRfcmV2ZWFsZWQAAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAAAAAAJc3BlY19oYXNoAAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAAAAAAAMNEZXByZWNhdGVkIG9uZS1yZWxlYXNlIGNvbXBhdGliaWxpdHkgd3JhcHBlciBmb3IgdGhlIGRpcmVjdCBidXkgcGF0aC4KTmV3IGNhbGxlcnMgc2hvdWxkIHVzZSBgdHJhZGVfYW5kX3B1Ymxpc2hfdHJhY2VgIHdpdGggZXhwbGljaXQgYm91bmRzLAphIHR5cGVkIGFjdGlvbiBhbmQgb3B0aW9uYWwgY2hhaW4vc2lnbmF0dXJlIGFyZ3VtZW50cy4AAAAAFWJ1eV9hbmRfcHVibGlzaF90cmFjZQAAAAAAAAcAAAAAAAAABnRyYWRlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAA1jb2xsYXRlcmFsX2luAAAAAAAACwAAAAAAAAAObWluX3NoYXJlc19vdXQAAAAAAAsAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAAhpcGZzX2NpZAAAABAAAAABAAAD6QAAB9AAAAAQVHJhZGVUcmFjZVJlc3VsdAAAAAM=",
        "AAAAAAAAAMpDcmVhdGVzIGEgbWFya2V0IHdpdGggdHJlYXN1cnkgY2FwaXRhbCBhbmQgcmV2ZWFscyBhbnkgVjIgcnVsZSBpbiBvbmUKdHJhbnNhY3Rpb24uIFJvb3QgYXV0aG9yaXphdGlvbiBpcyBhbmNob3JlZCBieSB0aGUgYWdlbnQgaGVyZTsgdGhlCnRyZWFzdXJ5IHN0aWxsIGFwcGxpZXMgaXRzIHJvbGUsIGNhcHMgYW5kIGNyZWF0aW9uIHBvbGljeSBjaGVja3MuAAAAAAAXYWdlbnRfY3JlYXRlX2FuZF9yZXZlYWwAAAAACAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAA1xdWVzdGlvbl9oYXNoAAAAAAAD7gAAACAAAAAAAAAACG1ldGFfdXJpAAAAEAAAAAAAAAAIY2F0ZWdvcnkAAAfQAAAACENhdGVnb3J5AAAAAAAAAApjbG9zZV90aW1lAAAAAAAGAAAAAAAAAAtzZWVkX2Ftb3VudAAAAAALAAAAAAAAAA9pbml0aWFsX3llc19icHMAAAAABAAAAAAAAAAHc3BlY192MgAAAAfQAAAAEFJlc29sdXRpb25TcGVjVjIAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAERTZWUgW2BSb3V0ZXI6OmNyZWF0ZV9hbmRfcmV2ZWFsX3NpZ25lcnNgXSDigJQgc2FtZSBmbG93LCBwcmljZSBydWxlLgAAABdjcmVhdGVfYW5kX3JldmVhbF9wcmljZQAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAQdUcmFkZXMgYG91dGNvbWVgIHNoYXJlcyB0aHJvdWdoIG1hcmtldC1jb3JlJ3MgYGJ1eV92MmAvYHNlbGxfdjJgIGFuZApwdWJsaXNoZXMgYSB0eXBlZCByZWFzb25pbmcgdHJhY2UgdGhyb3VnaCB0aGUgcmVnaXN0cnkgaW4gdGhlIHNhbWUKdHJhbnNhY3Rpb24uIE9wdGlvbmFsIGNoYWluIGFuZCBzaWduYXR1cmUgYXJndW1lbnRzIHNlbGVjdCBvbmUgb2YgdGhlCnJlZ2lzdHJ5J3MgZm91ciBwdWJsaXNoIGVudHJ5cG9pbnRzLiBFbWl0cyBgVHJhZGVUcmFjZWRgLgAAAAAXdHJhZGVfYW5kX3B1Ymxpc2hfdHJhY2UAAAAABgAAAAAAAAAGdHJhZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAABHNpZGUAAAfQAAAABFNpZGUAAAAAAAAABmJvdW5kcwAAAAAH0AAAAAtUcmFkZUJvdW5kcwAAAAAAAAAABXRyYWNlAAAAAAAH0AAAAAlUcmFjZUFyZ3MAAAAAAAABAAAD6QAAB9AAAAAQVHJhZGVUcmFjZVJlc3VsdAAAAAM=",
        "AAAAAAAAALVDcmVhdGVzIGEgbWFya2V0IGFuZCByZXZlYWxzIGl0cyBzaWduZXItbW9kZSBydWxlIGluIG9uZSB0cmFuc2FjdGlvbi4KVGhlIGNvbW1pdG1lbnQgaXMgY29tcHV0ZWQgZnJvbSBgc3BlY192MmAgbG9jYWxseSBhbmQgcGFzc2VkIHRvCm1hcmtldC1jb3JlLCBzbyB0aGUgcmV2ZWFsIG5lY2Vzc2FyaWx5IG1hdGNoZXMuAAAAAAAAGWNyZWF0ZV9hbmRfcmV2ZWFsX3NpZ25lcnMAAAAAAAAIAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAADXF1ZXN0aW9uX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAIbWV0YV91cmkAAAAQAAAAAAAAAAhjYXRlZ29yeQAAB9AAAAAIQ2F0ZWdvcnkAAAAAAAAACmNsb3NlX3RpbWUAAAAAAAYAAAAAAAAAC3NlZWRfYW1vdW50AAAAAAsAAAAAAAAAD2luaXRpYWxfeWVzX2JwcwAAAAAEAAAAAAAAAAdzcGVjX3YyAAAAB9AAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAEAAAPpAAAABgAAAAM=",
        "AAAABQAAAAAAAAAAAAAAGE1hcmtldENyZWF0ZWRBbmRSZXZlYWxlZAAAAAEAAAAbbWFya2V0X2NyZWF0ZWRfYW5kX3JldmVhbGVkAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAAAAAAAlzcGVjX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAC",
        "AAAAAAAAAWxTYW1lIGF0b21pYyB0cmFkZSt0cmFjZSBmbG93LCBidXQgdGhlIHRyYWRlIHJ1bnMgdGhyb3VnaCB0aGUgY2FsbGVyJ3MKdHJlYXN1cnkgKGBhZ2VudF9idXlfdjJgL2BhZ2VudF9zZWxsX3YyYCkgYW5kIHRoZSBhZ2VudCBpcyB0aGUgdHJhY2UKYXV0aG9yLiBUaGUgdHJlYXN1cnkgaXMgY2FsbGVyLXN1cHBsaWVkLCBzbyBpdCBpcyBjaGVja2VkIGFnYWluc3QgdGhlCnJvdXRlcidzIG1hcmtldC1jb3JlIGJvdGggd2F5cyBiZWZvcmUgYW55IGNhbGwgaXMgbWFkZTogYSBob3N0aWxlCnRyZWFzdXJ5IGNvdWxkIG90aGVyd2lzZSBtYWtlIHRoZSByb3V0ZXIgcHVibGlzaCBhIHRyYWNlIGZvciBhIHRyYWRlCnRoYXQgbmV2ZXIgaGFwcGVuZWQuAAAAHWFnZW50X3RyYWRlX2FuZF9wdWJsaXNoX3RyYWNlAAAAAAAABwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAEc2lkZQAAB9AAAAAEU2lkZQAAAAAAAAAGYm91bmRzAAAAAAfQAAAAC1RyYWRlQm91bmRzAAAAAAAAAAAFdHJhY2UAAAAAAAfQAAAACVRyYWNlQXJncwAAAAAAAAEAAAPpAAAH0AAAABBUcmFkZVRyYWNlUmVzdWx0AAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    config: this.txFromJSON<Result<RouterConfig>>,
        reveal_spec: this.txFromJSON<Result<void>>,
        create_and_reveal: this.txFromJSON<Result<u64>>,
        buy_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>,
        agent_create_and_reveal: this.txFromJSON<Result<u64>>,
        create_and_reveal_price: this.txFromJSON<Result<u64>>,
        trade_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>,
        create_and_reveal_signers: this.txFromJSON<Result<u64>>,
        agent_trade_and_publish_trace: this.txFromJSON<Result<TradeTraceResult>>
  }
}