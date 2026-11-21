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
  7: {message:"EmptyCid"},
  /**
   * `expected_seq` / `prev_trace_hash` don't extend the agent's chain head (#52).
   */
  8: {message:"ChainHeadMismatch"},
  /**
   * Agent already has a chain, so unchained `publish_trace` is refused (#52).
   */
  9: {message:"ChainedAgentMustChain"},
  /**
   * Trace already backed an action (#50).
   */
  10: {message:"TraceAlreadyConsumed"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  11: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  12: {message:"PendingAdminExpired"},
  /** Caller is not an admin-registered availability reporter (#325). */
  135: {message:"NotAvailabilityReporter"},
  /** The trace has no active reporter-owned `unavail` flag (#325). */
  136: {message:"NotAvailabilityFlag"},
  /** The same trace was toggled again before AVAIL_MIN_TOGGLE_SECS elapsed (#325). */
  137: {message:"AvailabilityToggleTooSoon"}
}

export interface SigningKeyRecord {
  added_at: u64;
  public_key: Buffer;
  retired_at: Option<u64>;
}

export interface TraceBatch {
  agent: string;
  leaf_count: u32;
  manifest_cid: string;
  published_at: u64;
  root: Buffer;
}

export type TraceAction =
  | { tag: "CreateMarket", values: void }
  | { tag: "ProposeMarket", values: void }
  | { tag: "Buy", values: void }
  | { tag: "Sell", values: void }
  | { tag: "Skip", values: void }
  | { tag: "Redeem", values: void }
  | { tag: "ClaimRemainder", values: void }
  | { tag: "Resolve", values: void }
  | { tag: "Other", values: readonly [string] };

export type AgentStatus =
  | { tag: "Active", values: void }
  | { tag: "Retired", values: readonly [u64] }
  | { tag: "Revoked", values: readonly [u64, string] };

export interface AgentRecord {
  registered_at: u64;
  status: AgentStatus;
}

export interface TraceFlag {
  active: boolean;
  flagged_at: u64;
  reason: string;
}

export type TraceVerdict =
  | { tag: "Valid", values: void }
  | { tag: "HashMismatch", values: void }
  | { tag: "Flagged", values: readonly [string] }
  | { tag: "AgentRevokedAfter", values: readonly [u64] };

export interface Trace {
  action: TraceAction;
  agent: string;
  ipfs_cid: string;
  market_id: u64;
  published_at: u64;
  trace_hash: Buffer;
}

export type DataKey = {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "NextId", values: void} | {tag: "Agent", values: readonly [string]} | {tag: "Trace", values: readonly [u64]} | {tag: "MarketTraceCount", values: readonly [u64]} | {tag: "MarketTrace", values: readonly [u64, u64]} | {tag: "TraceLedger", values: readonly [u64]} | {tag: "Consumer", values: readonly [string]} | {tag: "Consumed", values: readonly [u64]} | {tag: "AgentHead", values: readonly [string]} | {tag: "AgentTrace", values: readonly [string, u64]} | {tag: "TraceLink", values: readonly [u64]} | {tag: "AvailabilityReporter", values: readonly [string]} | {tag: "AvailabilityToggle", values: readonly [u64]} | {tag: "AvailabilityFlag", values: readonly [u64]};


/**
 * Head of an agent's append-only trace log (#52). Genesis is `seq = 0`
 * with an all-zero hash.
 */
export interface ChainHead {
  head_hash: Buffer;
  head_trace_id: Option<u64>;
  seq: u64;
}


export interface ChainLink {
  prev_trace_hash: Buffer;
  seq: u64;
}


/**
 * A proposed admin handover (#62). Absent when no transfer is pending.
 */
export interface PendingAdmin {
  address: string;
  expires_at: u64;
}










export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_trace: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Trace>>>

  /**
   * Construct and simulate a is_consumed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_consumed: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  trace_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_trace: ({trace_id, received_hash}: {trace_id: u64, received_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a consume_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Marks a trace as having backed an action, exactly once (#50). Only an
   * allow-listed consumer contract can call it; the treasury passes its own
   * address, which satisfies `require_auth` as the direct invoker.
   */
  consume_trace: ({consumer, trace_id}: {consumer: string, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Trace>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_registered: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

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
   * Construct and simulate a publish_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  publish_trace: ({agent, market_id, action, trace_hash, ipfs_cid}: {agent: string, market_id: u64, action: string, trace_hash: Buffer, ipfs_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Trace id at position `seq` (1-based) of `agent`'s chain.
   */
  agent_trace_at: ({agent, seq}: {agent: string, seq: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a get_trace_link transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Chain link for a trace; `None` for legacy, unchained traces.
   */
  get_trace_link: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ChainLink>>>

  /**
   * Construct and simulate a register_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  register_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  retire_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  retire_self: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  reactivate_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  revoke_agent: ({agent, effective_from, reason}: {agent: string, effective_from: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  flag_trace: ({trace_id, reason}: {trace_id: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  unflag_trace: ({trace_id, reason}: {trace_id: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>
  trace_flags: ({trace_id, start, limit}: {trace_id: u64, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<TraceFlag>>>>
  get_trace_flag: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<TraceFlag>>>
  market_trace_at: ({market_id, index}: {market_id: u64, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_chain_head transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current chain head for `agent` (genesis if it has never chained).
   */
  agent_chain_head: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<ChainHead>>

  /**
   * Construct and simulate a get_trace_ledger transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Ledger sequence the trace was written in (#50). `None` for traces
   * written before this field existed.
   */
  get_trace_ledger: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u32>>>

  /**
   * Construct and simulate a unregister_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unregister_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allow-lists a contract (e.g. the treasury) to call `consume_trace` (#50).
   */
  register_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_commitment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Checks a commit-reveal commitment (#51):
   * `commitment == sha256("oracledesk.trace.commit.v1" || trace_hash || salt)`.
   */
  verify_commitment: ({trace_hash, salt, commitment}: {trace_hash: Buffer, salt: Buffer, commitment: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a market_trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of traces published for `market_id`.
   */
  market_trace_count: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a unregister_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unregister_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_admin_transfer: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a publish_chained_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Publishes a trace that extends `agent`'s hash chain (#52). Fails with
   * `ChainHeadMismatch` unless `expected_seq == head.seq + 1` and
   * `prev_trace_hash == head.head_hash`, so a skipped decision shows up as
   * a gap and a fork is impossible.
   */
  publish_chained_trace: ({agent, market_id, action, trace_hash, ipfs_cid, expected_seq, prev_trace_hash}: {agent: string, market_id: u64, action: string, trace_hash: Buffer, ipfs_cid: string, expected_seq: u64, prev_trace_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a set_availability_reporter transaction (#325).
   */
  set_availability_reporter: ({reporter, enabled}: {reporter: string, enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a availability_reporter transaction (#325).
   */
  availability_reporter: ({reporter}: {reporter: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a report_unavailable transaction (#325).
   */
  report_unavailable: ({reporter, trace_id}: {reporter: string, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a clear_unavailable transaction (#325).
   */
  clear_unavailable: ({reporter, trace_id}: {reporter: string, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAAFkFnZW50QWxyZWFkeVJlZ2lzdGVyZWQAAAAAAAMAAAAAAAAAEkFnZW50Tm90UmVnaXN0ZXJlZAAAAAAABAAAAAAAAAANVHJhY2VOb3RGb3VuZAAAAAAAAAUAAAAAAAAAC0VtcHR5QWN0aW9uAAAAAAYAAAAAAAAACEVtcHR5Q2lkAAAABwAAAE1gZXhwZWN0ZWRfc2VxYCAvIGBwcmV2X3RyYWNlX2hhc2hgIGRvbid0IGV4dGVuZCB0aGUgYWdlbnQncyBjaGFpbiBoZWFkICgjNTIpLgAAAAAAABFDaGFpbkhlYWRNaXNtYXRjaAAAAAAAAAgAAABJQWdlbnQgYWxyZWFkeSBoYXMgYSBjaGFpbiwgc28gdW5jaGFpbmVkIGBwdWJsaXNoX3RyYWNlYCBpcyByZWZ1c2VkICgjNTIpLgAAAAAAABVDaGFpbmVkQWdlbnRNdXN0Q2hhaW4AAAAAAAAJAAAAJVRyYWNlIGFscmVhZHkgYmFja2VkIGFuIGFjdGlvbiAoIzUwKS4AAAAAAAAUVHJhY2VBbHJlYWR5Q29uc3VtZWQAAAAKAAAARGBhY2NlcHRfYWRtaW5gL2BjYW5jZWxfYWRtaW5fdHJhbnNmZXJgIGNhbGxlZCB3aXRoIG5vdGhpbmcgcHJvcG9zZWQuAAAADk5vUGVuZGluZ0FkbWluAAAAAAALAAAAQ0EgcHJvcG9zZWQgYWRtaW4gaGFuZG92ZXIgd2FzIG5vdCBhY2NlcHRlZCB3aXRoaW4gaXRzIGBleHBpcmVzX2F0YC4AAAAAE1BlbmRpbmdBZG1pbkV4cGlyZWQAAAAADAAAADhDYWxsZXIgaXMgbm90IGFuIGFkbWluLXJlZ2lzdGVyZWQgYXZhaWxhYmlsaXR5IHJlcG9ydGVyLgAAABdOb3RBdmFpbGFiaWxpdHlSZXBvcnRlcgAAAACHAAAANlRoZSB0cmFjZSBoYXMgbm8gYWN0aXZlIHJlcG9ydGVyLW93bmVkIGB1bmF2YWlsYCBmbGFnLgAAAAAAE05vdEF2YWlsYWJpbGl0eUZsYWcAAAAAiAAAAEZUaGUgc2FtZSB0cmFjZSB3YXMgdG9nZ2xlZCBhZ2FpbiBiZWZvcmUgQVZBSUxfTUlOX1RPR0dMRV9TRUNTIGVsYXBzZWQuAAAAAAAZQXZhaWxhYmlsaXR5VG9nZ2xlVG9vU29vbgAAAAAAAIk=",
        "AAAAAQAAAAAAAAAAAAAABVRyYWNlAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAMcHVibGlzaGVkX2F0AAAABgAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACA=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAEAAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAAAAAAAAAAAGTmV4dElkAAAAAAABAAAAAAAAAAVBZ2VudAAAAAAAAAEAAAATAAAAAQAAAAAAAAAFVHJhY2UAAAAAAAABAAAABgAAAAEAAAC+TnVtYmVyIG9mIHRyYWNlcyBwdWJsaXNoZWQgZm9yIGEgbWFya2V0LCBzbyBhIGNsaWVudCBjYW4gcGFnZSB0aHJvdWdoCmBNYXJrZXRUcmFjZShtYXJrZXRfaWQsIDAuLmNvdW50KWAgd2l0aG91dCB0aGUgY29udHJhY3QgZXZlciBob2xkaW5nCmFuIHVuYm91bmRlZCBWZWMgb2YgdHJhY2UgaWRzIGluIG9uZSBzdG9yYWdlIGVudHJ5LgAAAAAAEE1hcmtldFRyYWNlQ291bnQAAAABAAAABgAAAAEAAAAAAAAAC01hcmtldFRyYWNlAAAAAAIAAAAGAAAABgAAAAEAAACATGVkZ2VyIHNlcXVlbmNlIGEgdHJhY2Ugd2FzIHdyaXR0ZW4gaW4gKCM1MCkuIEtlcHQgYmVzaWRlIGBUcmFjZWAKcmF0aGVyIHRoYW4gaW5zaWRlIGl0IHNvIHRoZSBgVHJhY2VgIFhEUiBzaGFwZSBkb2Vzbid0IGNoYW5nZS4AAAALVHJhY2VMZWRnZXIAAAAAAQAAAAYAAAABAAAAMENvbnRyYWN0cyBhbGxvd2VkIHRvIGNhbGwgYGNvbnN1bWVfdHJhY2VgICgjNTApLgAAAAhDb25zdW1lcgAAAAEAAAATAAAAAQAAACxTZXQgb25jZSBhIHRyYWNlIGhhcyBiYWNrZWQgYW4gYWN0aW9uICgjNTApLgAAAAhDb25zdW1lZAAAAAEAAAAGAAAAAQAAACBQZXItYWdlbnQgaGFzaC1jaGFpbiBoZWFkICgjNTIpLgAAAAlBZ2VudEhlYWQAAAAAAAABAAAAEwAAAAEAAAAiUGVyLWFnZW50IGBzZXEgLT4gdHJhY2VfaWRgICgjNTIpLgAAAAAACkFnZW50VHJhY2UAAAAAAAIAAAATAAAABgAAAAEAAAA4YHRyYWNlX2lkIC0+IENoYWluTGlua2A7IGFic2VudCBmb3IgbGVnYWN5IHRyYWNlcyAoIzUyKS4AAAAJVHJhY2VMaW5rAAAAAAAAAQAAAAYAAABBIzMyNTogYEF2YWlsYWJpbGl0eVJlcG9ydGVyKGFkZHIpYCDihpIgYHRydWVgIHdoaWxlIGFsbG93LWxpc3RlZC4AAAAAAAAUQXZhaWxhYmlsaXR5UmVwb3J0ZXIAAAABAAAAEwAAAD9MYXN0IGF2YWlsYWJpbGl0eSB0b2dnbGUsIHVzZWQgdG8gcmF0ZS1saW1pdCBmbGFwcGluZyBnYXRld2F5cy4AAAAAEkF2YWlsYWJpbGl0eVRvZ2dsZQAAAAAAAQAAAAYAAABRTWFya3MgYSBmbGFnIGFzIHJlcG9ydGVyLW93bmVkIHNvIGBjbGVhcl91bmF2YWlsYWJsZWAgY2Fubm90IHRvdWNoIGFuIGFkbWluIGZsYWcuAAAAAAAAEEF2YWlsYWJpbGl0eUZsYWcAAAABAAAABg==",
        "AAAAAQAAAFtIZWFkIG9mIGFuIGFnZW50J3MgYXBwZW5kLW9ubHkgdHJhY2UgbG9nICgjNTIpLiBHZW5lc2lzIGlzIGBzZXEgPSAwYAp3aXRoIGFuIGFsbC16ZXJvIGhhc2guAAAAAAAAAAAJQ2hhaW5IZWFkAAAAAAAAAwAAAAAAAAAJaGVhZF9oYXNoAAAAAAAD7gAAACAAAAAAAAAADWhlYWRfdHJhY2VfaWQAAAAAAAPoAAAABgAAAAAAAAADc2VxAAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAACUNoYWluTGluawAAAAAAAAIAAAAAAAAAD3ByZXZfdHJhY2VfaGFzaAAAAAPuAAAAIAAAAAAAAAADc2VxAAAAAAY=",
        "AAAAAQAAAERBIHByb3Bvc2VkIGFkbWluIGhhbmRvdmVyICgjNjIpLiBBYnNlbnQgd2hlbiBubyB0cmFuc2ZlciBpcyBwZW5kaW5nLgAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAgAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAG",
        "AAAABQAAAAAAAAAAAAAADFRyYWNlQ2hhaW5lZAAAAAEAAAANdHJhY2VfY2hhaW5lZAAAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAAA3NlcQAAAAAGAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAAAAAAAPcHJldl90cmFjZV9oYXNoAAAAA+4AAAAgAAAAAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVRyYWNlQ29uc3VtZWQAAAAAAAABAAAADnRyYWNlX2NvbnN1bWVkAAAAAAACAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlRyYWNlUHVibGlzaGVkAAAAAAABAAAAD3RyYWNlX3B1Ymxpc2hlZAAAAAAHAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAAAAAAAAxwdWJsaXNoZWRfYXQAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD0FnZW50UmVnaXN0ZXJlZAAAAAABAAAAEGFnZW50X3JlZ2lzdGVyZWQAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEkNvbnN1bWVyUmVnaXN0ZXJlZAAAAAAAAQAAABNjb25zdW1lcl9yZWdpc3RlcmVkAAAAAAEAAAAAAAAACGNvbnN1bWVyAAAAEwAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAAFENvbnN1bWVyVW5yZWdpc3RlcmVkAAAAAQAAABVjb25zdW1lcl91bnJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAAAAAAAJZ2V0X3RyYWNlAAAAAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAfQAAAABVRyYWNlAAAAAAAAAw==",
        "AAAAAAAAAAAAAAALaXNfY29uc3VtZWQAAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAALaXNfY29uc3VtZXIAAAAAAQAAAAAAAAAIY29uc3VtZXIAAAATAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAALdHJhY2VfY291bnQAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMdmVyaWZ5X3RyYWNlAAAAAgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAA1yZWNlaXZlZF9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAMxNYXJrcyBhIHRyYWNlIGFzIGhhdmluZyBiYWNrZWQgYW4gYWN0aW9uLCBleGFjdGx5IG9uY2UgKCM1MCkuIE9ubHkgYW4KYWxsb3ctbGlzdGVkIGNvbnN1bWVyIGNvbnRyYWN0IGNhbiBjYWxsIGl0OyB0aGUgdHJlYXN1cnkgcGFzc2VzIGl0cyBvd24KYWRkcmVzcywgd2hpY2ggc2F0aXNmaWVzIGByZXF1aXJlX2F1dGhgIGFzIHRoZSBkaXJlY3QgaW52b2tlci4AAAANY29uc3VtZV90cmFjZQAAAAAAAAIAAAAAAAAACGNvbnN1bWVyAAAAEwAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAfQAAAABVRyYWNlAAAAAAAAAw==",
        "AAAAAAAAAAAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAEBUaGUgcGVuZGluZyBhZG1pbiBwcm9wb3NhbCwgaW5jbHVkaW5nIGl0cyBleHBpcnksIGlmIG9uZSBleGlzdHMuAAAADXBlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAfQAAAADFBlbmRpbmdBZG1pbg==",
        "AAAAAAAAAJZTdGFydHMgYSB0d28tc3RlcCBoYW5kb3ZlciBvZiB0aGUgYWRtaW4gcm9sZS4gVGhlIG5ldyBhZG1pbiBtdXN0IGNhbGwKYGFjY2VwdF9hZG1pbmAgaXRzZWxmLCBzbyBhIHR5cG8gY2Fubm90IGhhbmQgY29udHJvbCB0byBhbiBhZGRyZXNzCm5vYm9keSBob2xkcy4AAAAAAA1wcm9wb3NlX2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANcHVibGlzaF90cmFjZQAAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAAQAAAAAAAAAAp0cmFjZV9oYXNoAAAAAAPuAAAAIAAAAAAAAAAIaXBmc19jaWQAAAAQAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAADhUcmFjZSBpZCBhdCBwb3NpdGlvbiBgc2VxYCAoMS1iYXNlZCkgb2YgYGFnZW50YCdzIGNoYWluLgAAAA5hZ2VudF90cmFjZV9hdAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAANzZXEAAAAABgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAADxDaGFpbiBsaW5rIGZvciBhIHRyYWNlOyBgTm9uZWAgZm9yIGxlZ2FjeSwgdW5jaGFpbmVkIHRyYWNlcy4AAAAOZ2V0X3RyYWNlX2xpbmsAAAAAAAEAAAAAAAAACHRyYWNlX2lkAAAABgAAAAEAAAPoAAAH0AAAAAlDaGFpbkxpbmsAAAA=",
        "AAAAAAAAAAAAAAAOcmVnaXN0ZXJfYWdlbnQAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEFUaGUgYGluZGV4YC10aCAoMC1iYXNlZCwgcHVibGlzaCBvcmRlcikgdHJhY2UgaWQgZm9yIGBtYXJrZXRfaWRgLgAAAAAAAA9tYXJrZXRfdHJhY2VfYXQAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAFaW5kZXgAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAEFDdXJyZW50IGNoYWluIGhlYWQgZm9yIGBhZ2VudGAgKGdlbmVzaXMgaWYgaXQgaGFzIG5ldmVyIGNoYWluZWQpLgAAAAAAABBhZ2VudF9jaGFpbl9oZWFkAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAB9AAAAAJQ2hhaW5IZWFkAAAA",
        "AAAAAAAAAGRMZWRnZXIgc2VxdWVuY2UgdGhlIHRyYWNlIHdhcyB3cml0dGVuIGluICgjNTApLiBgTm9uZWAgZm9yIHRyYWNlcwp3cml0dGVuIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQuAAAAEGdldF90cmFjZV9sZWRnZXIAAAABAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6AAAAAQ=",
        "AAAAAAAAAAAAAAAQdW5yZWdpc3Rlcl9hZ2VudAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAElBbGxvdy1saXN0cyBhIGNvbnRyYWN0IChlLmcuIHRoZSB0cmVhc3VyeSkgdG8gY2FsbCBgY29uc3VtZV90cmFjZWAgKCM1MCkuAAAAAAAAEXJlZ2lzdGVyX2NvbnN1bWVyAAAAAAAAAQAAAAAAAAAIY29uc3VtZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHRDaGVja3MgYSBjb21taXQtcmV2ZWFsIGNvbW1pdG1lbnQgKCM1MSk6CmBjb21taXRtZW50ID09IHNoYTI1Nigib3JhY2xlZGVzay50cmFjZS5jb21taXQudjEiIHx8IHRyYWNlX2hhc2ggfHwgc2FsdClgLgAAABF2ZXJpZnlfY29tbWl0bWVudAAAAAAAAAMAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAARzYWx0AAAD7gAAACAAAAAAAAAACmNvbW1pdG1lbnQAAAAAA+4AAAAgAAAAAQAAAAE=",
        "AAAAAAAAACtOdW1iZXIgb2YgdHJhY2VzIHB1Ymxpc2hlZCBmb3IgYG1hcmtldF9pZGAuAAAAABJtYXJrZXRfdHJhY2VfY291bnQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABg==",
        "AAAAAAAAAAAAAAATdW5yZWdpc3Rlcl9jb25zdW1lcgAAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAOpQdWJsaXNoZXMgYSB0cmFjZSB0aGF0IGV4dGVuZHMgYGFnZW50YCdzIGhhc2ggY2hhaW4gKCM1MikuIEZhaWxzIHdpdGgKYENoYWluSGVhZE1pc21hdGNoYCB1bmxlc3MgYGV4cGVjdGVkX3NlcSA9PSBoZWFkLnNlcSArIDFgIGFuZApgcHJldl90cmFjZV9oYXNoID09IGhlYWQuaGVhZF9oYXNoYCwgc28gYSBza2lwcGVkIGRlY2lzaW9uIHNob3dzIHVwIGFzCmEgZ2FwIGFuZCBhIGZvcmsgaXMgaW1wb3NzaWJsZS4AAAAAABVwdWJsaXNoX2NoYWluZWRfdHJhY2UAAAAAAAAHAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABmFjdGlvbgAAAAAAEAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAAAAAAMZXhwZWN0ZWRfc2VxAAAABgAAAAAAAAAPcHJldl90cmFjZV9oYXNoAAAAA+4AAAAgAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAD1BZG1pbiBhbGxvdy1saXN0IGZvciBkZWxlZ2F0ZWQgYXZhaWxhYmlsaXR5IHJlcG9ydGVycyAoIzMyNSkuAAAAAAAAGXNldF9hdmFpbGFiaWxpdHlfcmVwb3J0ZXIAAAAAAAACAAAAAAAAAAhyZXBvcnRlcgAAABMAAAAAAAAAB2VuYWJsZWQAAAAAAQAAAAEAAAPpAAAAAAAAAAM=",
        "AAAAAAAAADdXaGV0aGVyIGByZXBvcnRlcmAgbWF5IHJhaXNlIGF2YWlsYWJpbGl0eSBmbGFncyAoIzMyNSkuAAAAABVhdmFpbGFiaWxpdHlfcmVwb3J0ZXIAAAAAAAABAAAAAAAAAAhyZXBvcnRlcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAAEtGbGFncyBhIHRyYWNlIHdob3NlIGNvbnRlbnQgaXMgdW5hdmFpbGFibGUsIGFzIGEgZGVsZWdhdGVkIHJlcG9ydGVyICgjMzI1KS4AAAAAEnJlcG9ydF91bmF2YWlsYWJsZQAAAAAAAgAAAAAAAAAIcmVwb3J0ZXIAAAATAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAAAAAAAAD",
        "AAAAAAAAAEtDbGVhcnMgb25seSBhbiBhY3RpdmUgYHVuYXZhaWxgIGZsYWcgcmFpc2VkIGJ5IHRoZSBjYWxsaW5nIHJlcG9ydGVyICgjMzI1KS4AAAAAEWNsZWFyX3VuYXZhaWxhYmxlAAAAAAAAAgAAAAAAAAAIcmVwb3J0ZXIAAAATAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAAAAAAAAD",
        "AAAABQAAAAAAAAAAAAAAF0F2YWlsYWJpbGl0eVJlcG9ydGVyU2V0AAAAAAEAAAAZYXZhaWxhYmlsaXR5X3JlcG9ydGVyX3NldAAAAAAAAAIAAAAAAAAAAAAAAAhyZXBvcnRlcgAAABMAAAAAAAAAAwAAAAdlbmFibGVkAAAAAAEAAAAC" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<Result<string>>,
        get_trace: this.txFromJSON<Result<Trace>>,
        is_consumed: this.txFromJSON<boolean>,
        is_consumer: this.txFromJSON<boolean>,
        trace_count: this.txFromJSON<u64>,
        accept_admin: this.txFromJSON<Result<void>>,
        verify_trace: this.txFromJSON<Result<boolean>>,
        consume_trace: this.txFromJSON<Result<Trace>>,
        is_registered: this.txFromJSON<boolean>,
        pending_admin: this.txFromJSON<Option<PendingAdmin>>,
        propose_admin: this.txFromJSON<Result<void>>,
        publish_trace: this.txFromJSON<Result<u64>>,
        agent_trace_at: this.txFromJSON<Result<u64>>,
        get_trace_link: this.txFromJSON<Option<ChainLink>>,
        register_agent: this.txFromJSON<Result<void>>,
        market_trace_at: this.txFromJSON<Result<u64>>,
        agent_chain_head: this.txFromJSON<ChainHead>,
        get_trace_ledger: this.txFromJSON<Option<u32>>,
        unregister_agent: this.txFromJSON<Result<void>>,
        register_consumer: this.txFromJSON<Result<void>>,
        verify_commitment: this.txFromJSON<boolean>,
        market_trace_count: this.txFromJSON<u64>,
        unregister_consumer: this.txFromJSON<Result<void>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        publish_chained_trace: this.txFromJSON<Result<u64>>,
        set_availability_reporter: this.txFromJSON<Result<void>>,
        availability_reporter: this.txFromJSON<boolean>,
        report_unavailable: this.txFromJSON<Result<void>>,
        clear_unavailable: this.txFromJSON<Result<void>>
  }
}