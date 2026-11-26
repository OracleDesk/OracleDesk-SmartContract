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
  3001: {message:"NotInitialized"},
  3002: {message:"Unauthorized"},
  3003: {message:"AgentAlreadyRegistered"},
  3004: {message:"AgentNotRegistered"},
  3005: {message:"TraceNotFound"},
  3006: {message:"EmptyAction"},
  3007: {message:"EmptyCid"},
  /**
   * `expected_seq` / `prev_trace_hash` don't extend the agent's chain head (#52).
   */
  3008: {message:"ChainHeadMismatch"},
  /**
   * Agent already has a chain, so unchained `publish_trace` is refused (#52).
   */
  3009: {message:"ChainedAgentMustChain"},
  /**
   * Trace already backed an action (#50).
   */
  3010: {message:"TraceAlreadyConsumed"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  3011: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  3012: {message:"PendingAdminExpired"},
  3013: {message:"CannotReactivateRevoked"},
  3014: {message:"FlagHistoryFull"},
  3015: {message:"InvalidEffectiveTime"},
  3016: {message:"UnknownMarket"},
  3017: {message:"MarketRequired"},
  3018: {message:"ProposalMustUseNoMarket"},
  3019: {message:"UseCanonicalAction"},
  3020: {message:"BatchNotFound"},
  3021: {message:"InvalidBatch"},
  3022: {message:"InvalidProof"},
  3023: {message:"TooManyKeys"},
  3024: {message:"KeyAlreadyBound"},
  3025: {message:"InvalidKey"},
  3026: {message:"InvalidSignature"},
  3027: {message:"TraceNotSigned"},
  3028: {message:"AgentNotActive"},
  3029: {message:"ActionTooLong"},
  3030: {message:"CidTooLong"},
  3031: {message:"PageTooLarge"},
  3032: {message:"TraceFlagged"},
  3033: {message:"TraceTooOld"},
  3034: {message:"TraceDecisionMissing"},
  3035: {message:"TraceAgentMismatch"},
  3036: {message:"TraceMismatch"},
  3037: {message:"AlreadyRetired"},
  3038: {message:"NotRetired"},
  3039: {message:"SigningKeyNotFound"},
  3040: {message:"TooManySigningKeys"},
  3041: {message:"SigningKeyAlreadyBound"},
  /**
   * `authorize_consumer` called after agent has reached MAX_AGENT_CONSUMERS.
   */
  3042: {message:"TooManyConsumers"},
  /**
   * `consume_trace` called by a consumer the publishing agent never granted.
   */
  3043: {message:"ConsumerNotAuthorized"},
  /**
   * `consume_trace` called by a consumer other than the one the trace is bound to.
   */
  3044: {message:"TraceBoundElsewhere"},
  /**
   * `set_default_consumer` or `bind_trace_consumer` called with a consumer the
   * agent has not yet authorised.
   */
  3045: {message:"ConsumerGrantRequired"},
  /**
   * `bind_trace_consumer` called on a trace that already has a binding.
   */
  3046: {message:"TraceAlreadyBound"},
  /**
   * `grant_consumer_legacy` called after scoping has been enabled.
   */
  3047: {message:"ScopingAlreadyEnabled"},
  /**
   * #299: Key already revoked and `compromised_since` cannot move later.
   */
  3048: {message:"AlreadyRevoked"},
  /**
   * #329: an archivist call asked to extend more entries than one call allows.
   */
  3049: {message:"TooManyEntries"},
  /**
   * Buy/Sell on a market that is not open, or past `close_time + grace`.
   */
  3050: {message:"MarketClosed"},
  /**
   * Redeem/ClaimRemainder on a market that is still open.
   */
  3051: {message:"MarketNotFinal"},
  /**
   * CreateMarket by an agent that neither created the market nor acts
   * through a registered consumer that did.
   */
  3052: {message:"NotMarketCreator"},
  /**
   * Resolve by an agent with no role in the market's resolution.
   */
  3053: {message:"NotResolutionSigner"},
  /**
   * Resolve (or CreateMarket after close) at the wrong time.
   */
  3054: {message:"MarketNotClosed"},
  /**
   * `Other(Symbol)` that is not on the admin allow-list.
   */
  3055: {message:"UnknownOtherAction"},
  /**
   * The `Other` allow-list is full, or a grace above the maximum.
   */
  3056: {message:"LimitExceeded"}
}


export interface Trace {
  action: TraceAction;
  agent: string;
  ipfs_cid: string;
  market_id: u64;
  published_at: u64;
  trace_hash: Buffer;
}

/**
 * Which secondary index `extend_index` walks (#329).
 */
export type IndexKey = {tag: "Market", values: readonly [u64]} | {tag: "Agent", values: readonly [string]} | {tag: "MarketAction", values: readonly [u64, TraceAction]};


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
 * Market rule of an allow-listed `TraceAction::Other(Symbol)` (issue #322).
 */
export type OtherRule = {tag: "NoMarketOnly", values: void} | {tag: "MarketOnly", values: void} | {tag: "Any", values: void};


export interface TraceFlag {
  active: boolean;
  flagged_at: u64;
  reason: string;
}


/**
 * A page of traces returned by one simulation, plus the cursor to fetch the
 * next page (#57). `next == total` means the caller has seen everything.
 */
export interface TracePage {
  entries: Array<TracePageEntry>;
  /**
 * Index of the first entry the *next* page would return.
 */
next: u64;
  /**
 * Total entries in this index at read time.
 */
total: u64;
}


export interface TraceBatch {
  agent: string;
  leaf_count: u32;
  manifest_cid: string;
  published_at: u64;
  root: Buffer;
}


export interface AgentRecord {
  registered_at: u64;
  status: AgentStatus;
}

export type AgentStatus = {tag: "Active", values: void} | {tag: "Retired", values: readonly [u64]} | {tag: "Revoked", values: readonly [u64, string]};

export type TraceAction = {tag: "CreateMarket", values: void} | {tag: "ProposeMarket", values: void} | {tag: "Buy", values: void} | {tag: "Sell", values: void} | {tag: "Skip", values: void} | {tag: "Redeem", values: void} | {tag: "ClaimRemainder", values: void} | {tag: "Resolve", values: void} | {tag: "Other", values: readonly [string]};



/**
 * A proposed admin handover (#62). Absent when no transfer is pending.
 */
export interface PendingAdmin {
  address: string;
  expires_at: u64;
}

export type TraceVerdict = {tag: "Valid", values: void} | {tag: "HashMismatch", values: void} | {tag: "Flagged", values: readonly [string]} | {tag: "AgentRevokedAfter", values: readonly [u64]} | {tag: "KeyCompromised", values: readonly [u64]} | {tag: "Late", values: void};







/**
 * One `(trace_id, Trace)` pair in a [`TracePage`].
 */
export interface TracePageEntry {
  trace: Trace;
  trace_id: u64;
}





/**
 * #299: Verdict for a trace's signature alone (independent of hash/flag/agent).
 */
export type SignatureVerdict = {tag: "NotSigned", values: void} | {tag: "WrongAgent", values: void} | {tag: "Valid", values: void} | {tag: "KeyCompromised", values: readonly [u64]};


export interface SigningKeyRecord {
  added_at: u64;
  public_key: Buffer;
  retired_at: Option<u64>;
}










export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AgentRecord>>>

  /**
   * Construct and simulate a get_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_batch: ({batch_id}: {batch_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TraceBatch>>>

  /**
   * Construct and simulate a get_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pure read (#329): views never extend TTL, so simulations have a
   * read-only footprint. Retention comes from write-time targets and the
   * archivist entrypoints (`extend_traces`).
   */
  get_trace: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Trace>>>

  /**
   * Construct and simulate a flag_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  flag_trace: ({trace_id, reason}: {trace_id: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a key_traces transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #299: Paged list of trace ids a key has signed.
   */
  key_traces: ({public_key, start, limit}: {public_key: Buffer, start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u64>>>>

  /**
   * Construct and simulate a batch_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  batch_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a is_consumed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_consumed: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a retire_self transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  retire_self: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reads the instance's `NextId`. Pure read (#329): the instance is kept
   * alive by mutating entrypoints (and `extend_traces`), not by views.
   */
  trace_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a trace_flags transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  trace_flags: ({trace_id, start, limit}: {trace_id: u64, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<TraceFlag>>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a action_grace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current post-close grace window for Buy/Sell traces, in seconds.
   */
  action_grace: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a extend_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extends an agent's `Identity` entries (registration, chain head,
   * signing keys and up to `retention::MAX_EXTEND_KEY_HISTORY` history
   * records) to the long-lived target. A no-op for unknown agents.
   */
  extend_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a extend_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extends index entries `[from, to)` (clamped to the index length) and
   * the index's count to at least the target of each referenced trace.
   * At most `retention::MAX_EXTEND_INDEX` entries per call.
   */
  extend_index: ({key, from, to}: {key: IndexKey, from: u64, to: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a retire_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  retire_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  revoke_agent: ({agent, effective_from, reason}: {agent: string, effective_from: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unflag_trace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unflag_trace: ({trace_id, reason}: {trace_id: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a extend_traces transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extends every key of each trace (the trace plus its side keys) to its
   * retention target. At most `retention::MAX_EXTEND_TRACES` ids; unknown
   * ids are skipped. Returns the number of entries extended. Also bumps
   * the instance, so archivist traffic alone keeps the contract live.
   */
  extend_traces: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a get_key_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_key_agent: ({public_key}: {public_key: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only view: no TTL writes, so an indexer's simulation stays cheap.
   * The `Agent` entry is refreshed by `register_agent`/`publish_trace`.
   */
  is_registered: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_trace_late transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether a Buy/Sell trace was published after its market's close.
   */
  is_trace_late: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a other_actions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Every allow-listed `Other` symbol.
   */
  other_actions: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

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
  publish_trace: ({agent, market_id, action, trace_hash, ipfs_cid}: {agent: string, market_id: u64, action: TraceAction, trace_hash: Buffer, ipfs_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a trace_verdict transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  trace_verdict: ({trace_id, received_hash}: {trace_id: u64, received_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TraceVerdict>>>

  /**
   * Construct and simulate a agent_batch_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_batch_at: ({agent, index}: {agent: string, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a agent_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The `index`-th (0-based, publish order) trace id for `agent` (#57).
   */
  agent_trace_at: ({agent, index}: {agent: string, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a get_trace_flag transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_trace_flag: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<TraceFlag>>>

  /**
   * Construct and simulate a get_trace_link transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Chain link for a trace; `None` for legacy, unchained traces.
   */
  get_trace_link: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ChainLink>>>

  /**
   * Construct and simulate a register_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  register_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_signing_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  add_signing_key: ({agent, public_key, proof_sig}: {agent: string, public_key: Buffer, proof_sig: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a affected_traces transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #299: Paged list of affected trace ids starting from the first
   * trace published at or after `compromised_since`.
   */
  affected_traces: ({public_key, compromised_since, page_start, limit}: {public_key: Buffer, compromised_since: u64, page_start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u64>>>>

  /**
   * Construct and simulate a key_trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #299: Number of traces a key has signed (length of the per-key index).
   */
  key_trace_count: ({public_key}: {public_key: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a market_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The `index`-th (0-based, publish order) trace id for `market_id`.
   */
  market_trace_at: ({market_id, index}: {market_id: u64, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a traces_by_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A page of every trace `agent` published, in publish order (#57).
   */
  traces_by_agent: ({agent, start, limit}: {agent: string, start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TracePage>>>

  /**
   * Construct and simulate a agent_chain_head transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current chain head for `agent` (genesis if it has never chained).
   */
  agent_chain_head: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<ChainHead>>

  /**
   * Construct and simulate a get_signing_keys transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pure read (#329): views never extend TTL.
   */
  get_signing_keys: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Buffer>>>

  /**
   * Construct and simulate a get_trace_ledger transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Ledger sequence the trace was written in (#50). `None` for traces
   * written before this field existed.
   */
  get_trace_ledger: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u32>>>

  /**
   * Construct and simulate a reactivate_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  reactivate_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_action_grace transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the post-close grace window for Buy/Sell traces (issue #322),
   * at most [`MAX_ACTION_GRACE_SECS`]. Admin only.
   */
  set_action_grace: ({secs}: {secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_other_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds, changes (`Some`) or removes (`None`) an allow-listed
   * `Other(sym)` action (issue #322). At most [`MAX_OTHER_ACTIONS`]
   * symbols; canonical action names are refused. Admin only. Applies at
   * publish time only, so existing traces are untouched.
   */
  set_other_action: ({sym, rule}: {sym: string, rule: Option<OtherRule>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a traces_by_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A page of every trace for `market_id`, starting at `start` (#57).
   * Replaces the `market_trace_count` + `market_trace_at` + `get_trace`
   * loop (101 RPC simulations for 50 traces) with one simulation.
   */
  traces_by_market: ({market_id, start, limit}: {market_id: u64, start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TracePage>>>

  /**
   * Construct and simulate a unregister_agent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unregister_agent: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_batch_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_batch_count: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a agent_trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of traces published by `agent` (#57).
   */
  agent_trace_count: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a key_affected_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #299: Binary search for the first trace index whose `published_at >=
   * compromised_since`. Returns the index, or `total` if none qualify.
   */
  key_affected_from: ({public_key, compromised_since}: {public_key: Buffer, compromised_since: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a other_action_rule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The market rule of an allow-listed `Other(sym)` action.
   */
  other_action_rule: ({sym}: {sym: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<OtherRule>>>

  /**
   * Construct and simulate a register_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allow-lists a contract (e.g. the treasury) to call `consume_trace` (#50).
   */
  register_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a signature_verdict transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #299: Returns the signature-level verdict for a trace, independent of
   * hash/flag/agent checks. Uses a constant number of reads.
   */
  signature_verdict: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SignatureVerdict>>>

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
   * Construct and simulate a retire_signing_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  retire_signing_key: ({agent, public_key}: {agent: string, public_key: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_signing_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revokes a signing key retroactively. Verdicts for traces the key signed
   * at or after `compromised_since` flip to `KeyCompromised`. Callable by
   * the agent or the registry admin, including for retired or revoked
   * agents. Revocation is permanent; `compromised_since` can only move
   * earlier on a subsequent call.
   */
  revoke_signing_key: ({caller, agent, public_key, compromised_since, reason}: {caller: string, agent: string, public_key: Buffer, compromised_since: u64, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a compute_merkle_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  compute_merkle_root: ({leaf_count, trace_hash, index, proof}: {leaf_count: u32, trace_hash: Buffer, index: u32, proof: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a get_trace_signature transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_trace_signature: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [Buffer, Buffer]>>>

  /**
   * Construct and simulate a publish_trace_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anchors a Merkle batch of N traces off-chain, storing only the 32-byte root
   * and manifest CID on-chain (#54).
   */
  publish_trace_batch: ({agent, root, leaf_count, manifest_cid}: {agent: string, root: Buffer, leaf_count: u32, manifest_cid: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a signing_key_history transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  signing_key_history: ({agent, start, limit}: {agent: string, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<SigningKeyRecord>>>>

  /**
   * Construct and simulate a unregister_consumer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unregister_consumer: ({consumer}: {consumer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a agent_chain_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Trace id at position `seq` (1-based) of `agent`'s chain.
   */
  agent_chain_trace_at: ({agent, seq}: {agent: string, seq: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a publish_trace_signed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  publish_trace_signed: ({agent, market_id, action, trace_hash, ipfs_cid, signing_key, signature}: {agent: string, market_id: u64, action: TraceAction, trace_hash: Buffer, ipfs_cid: string, signing_key: Buffer, signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
  publish_chained_trace: ({agent, market_id, action, trace_hash, ipfs_cid, expected_seq, prev_trace_hash}: {agent: string, market_id: u64, action: TraceAction, trace_hash: Buffer, ipfs_cid: string, expected_seq: u64, prev_trace_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a market_action_trace_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The `index`-th (0-based, publish order) trace id for
   * `(market_id, action)` (#57).
   */
  market_action_trace_at: ({market_id, action, index}: {market_id: u64, action: TraceAction, index: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a verify_trace_inclusion transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_trace_inclusion: ({batch_id, trace_hash, index, proof}: {batch_id: u64, trace_hash: Buffer, index: u32, proof: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a verify_trace_signature transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_trace_signature: ({trace_id}: {trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a traces_by_market_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A page of every trace for `(market_id, action)`, in publish order
   * (#57) — e.g. every `Buy` decision on market 7.
   */
  traces_by_market_action: ({market_id, action, start, limit}: {market_id: u64, action: TraceAction, start: u64, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TracePage>>>

  /**
   * Construct and simulate a market_action_trace_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of traces for the `(market_id, action)` pair (#57).
   */
  market_action_trace_count: ({market_id, action}: {market_id: u64, action: TraceAction}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a signing_key_history_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  signing_key_history_count: ({agent}: {agent: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a publish_chained_trace_signed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  publish_chained_trace_signed: ({agent, market_id, action, trace_hash, ipfs_cid, expected_seq, prev_trace_hash, signing_key, signature}: {agent: string, market_id: u64, action: TraceAction, trace_hash: Buffer, ipfs_cid: string, expected_seq: u64, prev_trace_hash: Buffer, signing_key: Buffer, signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAOAAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAC7kAAAAAAAAADFVuYXV0aG9yaXplZAAAC7oAAAAAAAAAFkFnZW50QWxyZWFkeVJlZ2lzdGVyZWQAAAAAC7sAAAAAAAAAEkFnZW50Tm90UmVnaXN0ZXJlZAAAAAALvAAAAAAAAAANVHJhY2VOb3RGb3VuZAAAAAAAC70AAAAAAAAAC0VtcHR5QWN0aW9uAAAAC74AAAAAAAAACEVtcHR5Q2lkAAALvwAAAE1gZXhwZWN0ZWRfc2VxYCAvIGBwcmV2X3RyYWNlX2hhc2hgIGRvbid0IGV4dGVuZCB0aGUgYWdlbnQncyBjaGFpbiBoZWFkICgjNTIpLgAAAAAAABFDaGFpbkhlYWRNaXNtYXRjaAAAAAAAC8AAAABJQWdlbnQgYWxyZWFkeSBoYXMgYSBjaGFpbiwgc28gdW5jaGFpbmVkIGBwdWJsaXNoX3RyYWNlYCBpcyByZWZ1c2VkICgjNTIpLgAAAAAAABVDaGFpbmVkQWdlbnRNdXN0Q2hhaW4AAAAAAAvBAAAAJVRyYWNlIGFscmVhZHkgYmFja2VkIGFuIGFjdGlvbiAoIzUwKS4AAAAAAAAUVHJhY2VBbHJlYWR5Q29uc3VtZWQAAAvCAAAARGBhY2NlcHRfYWRtaW5gL2BjYW5jZWxfYWRtaW5fdHJhbnNmZXJgIGNhbGxlZCB3aXRoIG5vdGhpbmcgcHJvcG9zZWQuAAAADk5vUGVuZGluZ0FkbWluAAAAAAvDAAAAQ0EgcHJvcG9zZWQgYWRtaW4gaGFuZG92ZXIgd2FzIG5vdCBhY2NlcHRlZCB3aXRoaW4gaXRzIGBleHBpcmVzX2F0YC4AAAAAE1BlbmRpbmdBZG1pbkV4cGlyZWQAAAALxAAAAAAAAAAXQ2Fubm90UmVhY3RpdmF0ZVJldm9rZWQAAAALxQAAAAAAAAAPRmxhZ0hpc3RvcnlGdWxsAAAAC8YAAAAAAAAAFEludmFsaWRFZmZlY3RpdmVUaW1lAAALxwAAAAAAAAANVW5rbm93bk1hcmtldAAAAAAAC8gAAAAAAAAADk1hcmtldFJlcXVpcmVkAAAAAAvJAAAAAAAAABdQcm9wb3NhbE11c3RVc2VOb01hcmtldAAAAAvKAAAAAAAAABJVc2VDYW5vbmljYWxBY3Rpb24AAAAAC8sAAAAAAAAADUJhdGNoTm90Rm91bmQAAAAAAAvMAAAAAAAAAAxJbnZhbGlkQmF0Y2gAAAvNAAAAAAAAAAxJbnZhbGlkUHJvb2YAAAvOAAAAAAAAAAtUb29NYW55S2V5cwAAAAvPAAAAAAAAAA9LZXlBbHJlYWR5Qm91bmQAAAAL0AAAAAAAAAAKSW52YWxpZEtleQAAAAAL0QAAAAAAAAAQSW52YWxpZFNpZ25hdHVyZQAAC9IAAAAAAAAADlRyYWNlTm90U2lnbmVkAAAAAAvTAAAAAAAAAA5BZ2VudE5vdEFjdGl2ZQAAAAAL1AAAAAAAAAANQWN0aW9uVG9vTG9uZwAAAAAAC9UAAAAAAAAACkNpZFRvb0xvbmcAAAAAC9YAAAAAAAAADFBhZ2VUb29MYXJnZQAAC9cAAAAAAAAADFRyYWNlRmxhZ2dlZAAAC9gAAAAAAAAAC1RyYWNlVG9vT2xkAAAAC9kAAAAAAAAAFFRyYWNlRGVjaXNpb25NaXNzaW5nAAAL2gAAAAAAAAASVHJhY2VBZ2VudE1pc21hdGNoAAAAAAvbAAAAAAAAAA1UcmFjZU1pc21hdGNoAAAAAAAL3AAAAAAAAAAOQWxyZWFkeVJldGlyZWQAAAAAC90AAAAAAAAACk5vdFJldGlyZWQAAAAAC94AAAAAAAAAElNpZ25pbmdLZXlOb3RGb3VuZAAAAAAL3wAAAAAAAAASVG9vTWFueVNpZ25pbmdLZXlzAAAAAAvgAAAAAAAAABZTaWduaW5nS2V5QWxyZWFkeUJvdW5kAAAAAAvhAAAASGBhdXRob3JpemVfY29uc3VtZXJgIGNhbGxlZCBhZnRlciBhZ2VudCBoYXMgcmVhY2hlZCBNQVhfQUdFTlRfQ09OU1VNRVJTLgAAABBUb29NYW55Q29uc3VtZXJzAAAL4gAAAEhgY29uc3VtZV90cmFjZWAgY2FsbGVkIGJ5IGEgY29uc3VtZXIgdGhlIHB1Ymxpc2hpbmcgYWdlbnQgbmV2ZXIgZ3JhbnRlZC4AAAAVQ29uc3VtZXJOb3RBdXRob3JpemVkAAAAAAAL4wAAAE5gY29uc3VtZV90cmFjZWAgY2FsbGVkIGJ5IGEgY29uc3VtZXIgb3RoZXIgdGhhbiB0aGUgb25lIHRoZSB0cmFjZSBpcyBib3VuZCB0by4AAAAAABNUcmFjZUJvdW5kRWxzZXdoZXJlAAAAC+QAAABoYHNldF9kZWZhdWx0X2NvbnN1bWVyYCBvciBgYmluZF90cmFjZV9jb25zdW1lcmAgY2FsbGVkIHdpdGggYSBjb25zdW1lciB0aGUKYWdlbnQgaGFzIG5vdCB5ZXQgYXV0aG9yaXNlZC4AAAAVQ29uc3VtZXJHcmFudFJlcXVpcmVkAAAAAAAL5QAAAENgYmluZF90cmFjZV9jb25zdW1lcmAgY2FsbGVkIG9uIGEgdHJhY2UgdGhhdCBhbHJlYWR5IGhhcyBhIGJpbmRpbmcuAAAAABFUcmFjZUFscmVhZHlCb3VuZAAAAAAAC+YAAAA+YGdyYW50X2NvbnN1bWVyX2xlZ2FjeWAgY2FsbGVkIGFmdGVyIHNjb3BpbmcgaGFzIGJlZW4gZW5hYmxlZC4AAAAAABVTY29waW5nQWxyZWFkeUVuYWJsZWQAAAAAAAvnAAAARCMyOTk6IEtleSBhbHJlYWR5IHJldm9rZWQgYW5kIGBjb21wcm9taXNlZF9zaW5jZWAgY2Fubm90IG1vdmUgbGF0ZXIuAAAADkFscmVhZHlSZXZva2VkAAAAAAvoAAAASiMzMjk6IGFuIGFyY2hpdmlzdCBjYWxsIGFza2VkIHRvIGV4dGVuZCBtb3JlIGVudHJpZXMgdGhhbiBvbmUgY2FsbCBhbGxvd3MuAAAAAAAOVG9vTWFueUVudHJpZXMAAAAAC+kAAABEQnV5L1NlbGwgb24gYSBtYXJrZXQgdGhhdCBpcyBub3Qgb3Blbiwgb3IgcGFzdCBgY2xvc2VfdGltZSArIGdyYWNlYC4AAAAMTWFya2V0Q2xvc2VkAAAL6gAAADVSZWRlZW0vQ2xhaW1SZW1haW5kZXIgb24gYSBtYXJrZXQgdGhhdCBpcyBzdGlsbCBvcGVuLgAAAAAAAA5NYXJrZXROb3RGaW5hbAAAAAAL6wAAAGlDcmVhdGVNYXJrZXQgYnkgYW4gYWdlbnQgdGhhdCBuZWl0aGVyIGNyZWF0ZWQgdGhlIG1hcmtldCBub3IgYWN0cwp0aHJvdWdoIGEgcmVnaXN0ZXJlZCBjb25zdW1lciB0aGF0IGRpZC4AAAAAAAAQTm90TWFya2V0Q3JlYXRvcgAAC+wAAAA8UmVzb2x2ZSBieSBhbiBhZ2VudCB3aXRoIG5vIHJvbGUgaW4gdGhlIG1hcmtldCdzIHJlc29sdXRpb24uAAAAE05vdFJlc29sdXRpb25TaWduZXIAAAAL7QAAADhSZXNvbHZlIChvciBDcmVhdGVNYXJrZXQgYWZ0ZXIgY2xvc2UpIGF0IHRoZSB3cm9uZyB0aW1lLgAAAA9NYXJrZXROb3RDbG9zZWQAAAAL7gAAADRgT3RoZXIoU3ltYm9sKWAgdGhhdCBpcyBub3Qgb24gdGhlIGFkbWluIGFsbG93LWxpc3QuAAAAElVua25vd25PdGhlckFjdGlvbgAAAAAL7wAAAD1UaGUgYE90aGVyYCBhbGxvdy1saXN0IGlzIGZ1bGwsIG9yIGEgZ3JhY2UgYWJvdmUgdGhlIG1heGltdW0uAAAAAAAADUxpbWl0RXhjZWVkZWQAAAAAAAvw",
        "AAAAAQAAAAAAAAAAAAAABVRyYWNlAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAC1RyYWNlQWN0aW9uAAAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAADHB1Ymxpc2hlZF9hdAAAAAYAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAg",
        "AAAAAgAAADJXaGljaCBzZWNvbmRhcnkgaW5kZXggYGV4dGVuZF9pbmRleGAgd2Fsa3MgKCMzMjkpLgAAAAAAAAAAAAhJbmRleEtleQAAAAMAAAABAAAAPGBNYXJrZXRUcmFjZShtYXJrZXRfaWQsIGkpYCAvIGBNYXJrZXRUcmFjZUNvdW50KG1hcmtldF9pZClgLgAAAAZNYXJrZXQAAAAAAAEAAAAGAAAAAQAAADRgQWdlbnRUcmFjZUF0KGFnZW50LCBpKWAgLyBgQWdlbnRUcmFjZUNvdW50KGFnZW50KWAuAAAABUFnZW50AAAAAAAAAQAAABMAAAABAAAAOGBNYXJrZXRBY3Rpb25UcmFjZUF0KG1hcmtldF9pZCwgYWN0aW9uLCBpKWAgLyBpdHMgY291bnQuAAAADE1hcmtldEFjdGlvbgAAAAIAAAAGAAAH0AAAAAtUcmFjZUFjdGlvbgA=",
        "AAAAAQAAAFtIZWFkIG9mIGFuIGFnZW50J3MgYXBwZW5kLW9ubHkgdHJhY2UgbG9nICgjNTIpLiBHZW5lc2lzIGlzIGBzZXEgPSAwYAp3aXRoIGFuIGFsbC16ZXJvIGhhc2guAAAAAAAAAAAJQ2hhaW5IZWFkAAAAAAAAAwAAAAAAAAAJaGVhZF9oYXNoAAAAAAAD7gAAACAAAAAAAAAADWhlYWRfdHJhY2VfaWQAAAAAAAPoAAAABgAAAAAAAAADc2VxAAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAACUNoYWluTGluawAAAAAAAAIAAAAAAAAAD3ByZXZfdHJhY2VfaGFzaAAAAAPuAAAAIAAAAAAAAAADc2VxAAAAAAY=",
        "AAAAAgAAAElNYXJrZXQgcnVsZSBvZiBhbiBhbGxvdy1saXN0ZWQgYFRyYWNlQWN0aW9uOjpPdGhlcihTeW1ib2wpYCAoaXNzdWUgIzMyMikuAAAAAAAAAAAAAAlPdGhlclJ1bGUAAAAAAAADAAAAAAAAABVNdXN0IHVzZSBgTk9fTUFSS0VUYC4AAAAAAAAMTm9NYXJrZXRPbmx5AAAAAAAAACJNdXN0IHJlZmVyZW5jZSBhbiBleGlzdGluZyBtYXJrZXQuAAAAAAAKTWFya2V0T25seQAAAAAAAAAAAAdFaXRoZXIuAAAAAANBbnkA",
        "AAAAAQAAAAAAAAAAAAAACVRyYWNlRmxhZwAAAAAAAAMAAAAAAAAABmFjdGl2ZQAAAAAAAQAAAAAAAAAKZmxhZ2dlZF9hdAAAAAAABgAAAAAAAAAGcmVhc29uAAAAAAAR",
        "AAAAAQAAAJBBIHBhZ2Ugb2YgdHJhY2VzIHJldHVybmVkIGJ5IG9uZSBzaW11bGF0aW9uLCBwbHVzIHRoZSBjdXJzb3IgdG8gZmV0Y2ggdGhlCm5leHQgcGFnZSAoIzU3KS4gYG5leHQgPT0gdG90YWxgIG1lYW5zIHRoZSBjYWxsZXIgaGFzIHNlZW4gZXZlcnl0aGluZy4AAAAAAAAACVRyYWNlUGFnZQAAAAAAAAMAAAAAAAAAB2VudHJpZXMAAAAD6gAAB9AAAAAOVHJhY2VQYWdlRW50cnkAAAAAADZJbmRleCBvZiB0aGUgZmlyc3QgZW50cnkgdGhlICpuZXh0KiBwYWdlIHdvdWxkIHJldHVybi4AAAAAAARuZXh0AAAABgAAAClUb3RhbCBlbnRyaWVzIGluIHRoaXMgaW5kZXggYXQgcmVhZCB0aW1lLgAAAAAAAAV0b3RhbAAAAAAAAAY=",
        "AAAAAQAAAAAAAAAAAAAAClRyYWNlQmF0Y2gAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKbGVhZl9jb3VudAAAAAAABAAAAAAAAAAMbWFuaWZlc3RfY2lkAAAAEAAAAAAAAAAMcHVibGlzaGVkX2F0AAAABgAAAAAAAAAEcm9vdAAAA+4AAAAg",
        "AAAAAQAAAAAAAAAAAAAAC0FnZW50UmVjb3JkAAAAAAIAAAAAAAAADXJlZ2lzdGVyZWRfYXQAAAAAAAAGAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAALQWdlbnRTdGF0dXMA",
        "AAAAAgAAAAAAAAAAAAAAC0FnZW50U3RhdHVzAAAAAAMAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAEAAAAAAAAAB1JldGlyZWQAAAAAAQAAAAYAAAABAAAAAAAAAAdSZXZva2VkAAAAAAIAAAAGAAAAEQ==",
        "AAAAAgAAAAAAAAAAAAAAC1RyYWNlQWN0aW9uAAAAAAkAAAAAAAAAAAAAAAxDcmVhdGVNYXJrZXQAAAAAAAAAAAAAAA1Qcm9wb3NlTWFya2V0AAAAAAAAAAAAAAAAAAADQnV5AAAAAAAAAAAAAAAABFNlbGwAAAAAAAAAAAAAAARTa2lwAAAAAAAAAAAAAAAGUmVkZWVtAAAAAAAAAAAAAAAAAA5DbGFpbVJlbWFpbmRlcgAAAAAAAAAAAAAAAAAHUmVzb2x2ZQAAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAABQAAAAAAAAAAAAAAC1RyYWNlU2lnbmVkAAAAAAEAAAAMdHJhY2Vfc2lnbmVkAAAAAwAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAALc2lnbmluZ19rZXkAAAAD7gAAACAAAAABAAAAAg==",
        "AAAAAQAAAERBIHByb3Bvc2VkIGFkbWluIGhhbmRvdmVyICgjNjIpLiBBYnNlbnQgd2hlbiBubyB0cmFuc2ZlciBpcyBwZW5kaW5nLgAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAgAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAG",
        "AAAAAgAAAAAAAAAAAAAADFRyYWNlVmVyZGljdAAAAAYAAAAAAAAAAAAAAAVWYWxpZAAAAAAAAAAAAAAAAAAADEhhc2hNaXNtYXRjaAAAAAEAAAAAAAAAB0ZsYWdnZWQAAAAAAQAAABEAAAABAAAAAAAAABFBZ2VudFJldm9rZWRBZnRlcgAAAAAAAAEAAAAGAAAAAQAAAGsjMjk5OiBUaGUgc2lnbmluZyBrZXkgd2FzIHJldHJvYWN0aXZlbHkgcmV2b2tlZDsgdHJhY2VzIHNpZ25lZCBhdCBvcgphZnRlciBgY29tcHJvbWlzZWRfc2luY2VgIGFyZSB0YWludGVkLgAAAAAOS2V5Q29tcHJvbWlzZWQAAAAAAAEAAAAGAAAAAAAAALEjMzIyOiBhIEJ1eS9TZWxsIHRyYWNlIHB1Ymxpc2hlZCBhZnRlciB0aGUgbWFya2V0J3MgYGNsb3NlX3RpbWVgLAppbnNpZGUgdGhlIGdyYWNlIHdpbmRvdy4gT25seSByZXBvcnRlZCB3aGVuIHRoZSBoYXNoIG1hdGNoZXMgYW5kIG5vCmZsYWcsIHJldm9jYXRpb24gb3Iga2V5IGNvbXByb21pc2UgYXBwbGllcy4AAAAAAAAETGF0ZQ==",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmV0aXJlZAAAAAEAAAANYWdlbnRfcmV0aXJlZAAAAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAAAmF0AAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADEFnZW50UmV2b2tlZAAAAAEAAAANYWdlbnRfcmV2b2tlZAAAAAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAADmVmZmVjdGl2ZV9mcm9tAAAAAAAGAAAAAAAAAAAAAAAGcmVhc29uAAAAAAARAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFRyYWNlQ2hhaW5lZAAAAAEAAAANdHJhY2VfY2hhaW5lZAAAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAAA3NlcQAAAAAGAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAAAAAAAPcHJldl90cmFjZV9oYXNoAAAAA+4AAAAgAAAAAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADFRyYWNlRmxhZ2dlZAAAAAEAAAANdHJhY2VfZmxhZ2dlZAAAAAAAAAIAAAAAAAAACHRyYWNlX2lkAAAABgAAAAEAAAAAAAAABnJlYXNvbgAAAAAAEQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADVRyYWNlQ29uc3VtZWQAAAAAAAABAAAADnRyYWNlX2NvbnN1bWVkAAAAAAACAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAAAAAAAAg==",
        "AAAAAQAAADBPbmUgYCh0cmFjZV9pZCwgVHJhY2UpYCBwYWlyIGluIGEgW2BUcmFjZVBhZ2VgXS4AAAAAAAAADlRyYWNlUGFnZUVudHJ5AAAAAAACAAAAAAAAAAV0cmFjZQAAAAAAB9AAAAAFVHJhY2UAAAAAAAAAAAAACHRyYWNlX2lkAAAABg==",
        "AAAABQAAAAAAAAAAAAAADkJhdGNoUHVibGlzaGVkAAAAAAABAAAAD2JhdGNoX3B1Ymxpc2hlZAAAAAAGAAAAAAAAAAhiYXRjaF9pZAAAAAYAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAARyb290AAAD7gAAACAAAAAAAAAAAAAAAApsZWFmX2NvdW50AAAAAAAEAAAAAAAAAAAAAAAMbWFuaWZlc3RfY2lkAAAAEAAAAAAAAAAAAAAADHB1Ymxpc2hlZF9hdAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlRyYWNlUHVibGlzaGVkAAAAAAABAAAAD3RyYWNlX3B1Ymxpc2hlZAAAAAAHAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAC1RyYWNlQWN0aW9uAAAAAAAAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAAAAAAAIaXBmc19jaWQAAAAQAAAAAAAAAAAAAAAMcHVibGlzaGVkX2F0AAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADlRyYWNlVW5mbGFnZ2VkAAAAAAABAAAAD3RyYWNlX3VuZmxhZ2dlZAAAAAACAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAAAAAAZyZWFzb24AAAAAABEAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAD0FnZW50UmVnaXN0ZXJlZAAAAAABAAAAEGFnZW50X3JlZ2lzdGVyZWQAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAg==",
        "AAAAAgAAAE0jMjk5OiBWZXJkaWN0IGZvciBhIHRyYWNlJ3Mgc2lnbmF0dXJlIGFsb25lIChpbmRlcGVuZGVudCBvZiBoYXNoL2ZsYWcvYWdlbnQpLgAAAAAAAAAAAAAQU2lnbmF0dXJlVmVyZGljdAAAAAQAAAAAAAAAAAAAAAlOb3RTaWduZWQAAAAAAAAAAAAAAAAAAApXcm9uZ0FnZW50AAAAAAAAAAAAAAAAAAVWYWxpZAAAAAAAAAEAAAAAAAAADktleUNvbXByb21pc2VkAAAAAAABAAAABg==",
        "AAAAAQAAAAAAAAAAAAAAEFNpZ25pbmdLZXlSZWNvcmQAAAADAAAAAAAAAAhhZGRlZF9hdAAAAAYAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAAAAAApyZXRpcmVkX2F0AAAAAAPoAAAABg==",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEEFnZW50UmVhY3RpdmF0ZWQAAAABAAAAEWFnZW50X3JlYWN0aXZhdGVkAAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAI=",
        "AAAABQAAADojMjk5OiBFbWl0dGVkIHdoZW4gYSBzaWduaW5nIGtleSBpcyByZXRyb2FjdGl2ZWx5IHJldm9rZWQuAAAAAAAAAAAAEVNpZ25pbmdLZXlSZXZva2VkAAAAAAAAAQAAABNzaWduaW5nX2tleV9yZXZva2VkAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAQAAAAAAAAARY29tcHJvbWlzZWRfc2luY2UAAAAAAAAGAAAAAAAAAAAAAAAGcmVhc29uAAAAAAARAAAAAAAAAAAAAAAIYnlfYWRtaW4AAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEkNvbnN1bWVyUmVnaXN0ZXJlZAAAAAAAAQAAABNjb25zdW1lcl9yZWdpc3RlcmVkAAAAAAEAAAAAAAAACGNvbnN1bWVyAAAAEwAAAAEAAAAC",
        "AAAAAAAAAAAAAAAJZ2V0X2FnZW50AAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+gAAAfQAAAAC0FnZW50UmVjb3JkAA==",
        "AAAAAAAAAAAAAAAJZ2V0X2JhdGNoAAAAAAAAAQAAAAAAAAAIYmF0Y2hfaWQAAAAGAAAAAQAAA+kAAAfQAAAAClRyYWNlQmF0Y2gAAAAAAAM=",
        "AAAAAAAAAK1QdXJlIHJlYWQgKCMzMjkpOiB2aWV3cyBuZXZlciBleHRlbmQgVFRMLCBzbyBzaW11bGF0aW9ucyBoYXZlIGEKcmVhZC1vbmx5IGZvb3RwcmludC4gUmV0ZW50aW9uIGNvbWVzIGZyb20gd3JpdGUtdGltZSB0YXJnZXRzIGFuZCB0aGUKYXJjaGl2aXN0IGVudHJ5cG9pbnRzIChgZXh0ZW5kX3RyYWNlc2ApLgAAAAAAAAlnZXRfdHJhY2UAAAAAAAABAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAB9AAAAAFVHJhY2UAAAAAAAAD",
        "AAAAAAAAAAAAAAAKZmxhZ190cmFjZQAAAAAAAgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAAZyZWFzb24AAAAAABEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAC8jMjk5OiBQYWdlZCBsaXN0IG9mIHRyYWNlIGlkcyBhIGtleSBoYXMgc2lnbmVkLgAAAAAKa2V5X3RyYWNlcwAAAAAAAwAAAAAAAAAKcHVibGljX2tleQAAAAAD7gAAACAAAAAAAAAABXN0YXJ0AAAAAAAABgAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+kAAAPqAAAABgAAAAM=",
        "AAAABQAAAAAAAAAAAAAAFEFnZW50U2lnbmluZ0tleUFkZGVkAAAAAQAAABdhZ2VudF9zaWduaW5nX2tleV9hZGRlZAAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAAAAAAAApwdWJsaWNfa2V5AAAAAAPuAAAAIAAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAAFENvbnN1bWVyVW5yZWdpc3RlcmVkAAAAAQAAABVjb25zdW1lcl91bnJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAABAAAAAg==",
        "AAAAAAAAAAAAAAALYmF0Y2hfY291bnQAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAALaXNfY29uc3VtZWQAAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAALaXNfY29uc3VtZXIAAAAAAQAAAAAAAAAIY29uc3VtZXIAAAATAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAALcmV0aXJlX3NlbGYAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIhSZWFkcyB0aGUgaW5zdGFuY2UncyBgTmV4dElkYC4gUHVyZSByZWFkICgjMzI5KTogdGhlIGluc3RhbmNlIGlzIGtlcHQKYWxpdmUgYnkgbXV0YXRpbmcgZW50cnlwb2ludHMgKGFuZCBgZXh0ZW5kX3RyYWNlc2ApLCBub3QgYnkgdmlld3MuAAAAC3RyYWNlX2NvdW50AAAAAAAAAAABAAAABg==",
        "AAAAAAAAAAAAAAALdHJhY2VfZmxhZ3MAAAAAAwAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPpAAAD6gAAB9AAAAAJVHJhY2VGbGFnAAAAAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEBDdXJyZW50IHBvc3QtY2xvc2UgZ3JhY2Ugd2luZG93IGZvciBCdXkvU2VsbCB0cmFjZXMsIGluIHNlY29uZHMuAAAADGFjdGlvbl9ncmFjZQAAAAAAAAABAAAABg==",
        "AAAAAAAAAMJFeHRlbmRzIGFuIGFnZW50J3MgYElkZW50aXR5YCBlbnRyaWVzIChyZWdpc3RyYXRpb24sIGNoYWluIGhlYWQsCnNpZ25pbmcga2V5cyBhbmQgdXAgdG8gYHJldGVudGlvbjo6TUFYX0VYVEVORF9LRVlfSElTVE9SWWAgaGlzdG9yeQpyZWNvcmRzKSB0byB0aGUgbG9uZy1saXZlZCB0YXJnZXQuIEEgbm8tb3AgZm9yIHVua25vd24gYWdlbnRzLgAAAAAADGV4dGVuZF9hZ2VudAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAL9FeHRlbmRzIGluZGV4IGVudHJpZXMgYFtmcm9tLCB0bylgIChjbGFtcGVkIHRvIHRoZSBpbmRleCBsZW5ndGgpIGFuZAp0aGUgaW5kZXgncyBjb3VudCB0byBhdCBsZWFzdCB0aGUgdGFyZ2V0IG9mIGVhY2ggcmVmZXJlbmNlZCB0cmFjZS4KQXQgbW9zdCBgcmV0ZW50aW9uOjpNQVhfRVhURU5EX0lOREVYYCBlbnRyaWVzIHBlciBjYWxsLgAAAAAMZXh0ZW5kX2luZGV4AAAAAwAAAAAAAAADa2V5AAAAB9AAAAAISW5kZXhLZXkAAAAAAAAABGZyb20AAAAGAAAAAAAAAAJ0bwAAAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAAMcmV0aXJlX2FnZW50AAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMcmV2b2tlX2FnZW50AAAAAwAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAA5lZmZlY3RpdmVfZnJvbQAAAAAABgAAAAAAAAAGcmVhc29uAAAAAAARAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMdW5mbGFnX3RyYWNlAAAAAgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAAZyZWFzb24AAAAAABEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMdmVyaWZ5X3RyYWNlAAAAAgAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAAAAAA1yZWNlaXZlZF9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAAAEAAAAD",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFkFnZW50U2lnbmluZ0tleVJldGlyZWQAAAAAAAEAAAAZYWdlbnRfc2lnbmluZ19rZXlfcmV0aXJlZAAAAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAQAAAAI=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAA=",
        "AAAAAAAAAMxNYXJrcyBhIHRyYWNlIGFzIGhhdmluZyBiYWNrZWQgYW4gYWN0aW9uLCBleGFjdGx5IG9uY2UgKCM1MCkuIE9ubHkgYW4KYWxsb3ctbGlzdGVkIGNvbnN1bWVyIGNvbnRyYWN0IGNhbiBjYWxsIGl0OyB0aGUgdHJlYXN1cnkgcGFzc2VzIGl0cyBvd24KYWRkcmVzcywgd2hpY2ggc2F0aXNmaWVzIGByZXF1aXJlX2F1dGhgIGFzIHRoZSBkaXJlY3QgaW52b2tlci4AAAANY29uc3VtZV90cmFjZQAAAAAAAAIAAAAAAAAACGNvbnN1bWVyAAAAEwAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAfQAAAABVRyYWNlAAAAAAAAAw==",
        "AAAAAAAAARFFeHRlbmRzIGV2ZXJ5IGtleSBvZiBlYWNoIHRyYWNlICh0aGUgdHJhY2UgcGx1cyBpdHMgc2lkZSBrZXlzKSB0byBpdHMKcmV0ZW50aW9uIHRhcmdldC4gQXQgbW9zdCBgcmV0ZW50aW9uOjpNQVhfRVhURU5EX1RSQUNFU2AgaWRzOyB1bmtub3duCmlkcyBhcmUgc2tpcHBlZC4gUmV0dXJucyB0aGUgbnVtYmVyIG9mIGVudHJpZXMgZXh0ZW5kZWQuIEFsc28gYnVtcHMKdGhlIGluc3RhbmNlLCBzbyBhcmNoaXZpc3QgdHJhZmZpYyBhbG9uZSBrZWVwcyB0aGUgY29udHJhY3QgbGl2ZS4AAAAAAAANZXh0ZW5kX3RyYWNlcwAAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAANZ2V0X2tleV9hZ2VudAAAAAAAAAEAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAQAAA+gAAAAT",
        "AAAAAAAAAIpSZWFkLW9ubHkgdmlldzogbm8gVFRMIHdyaXRlcywgc28gYW4gaW5kZXhlcidzIHNpbXVsYXRpb24gc3RheXMgY2hlYXAuClRoZSBgQWdlbnRgIGVudHJ5IGlzIHJlZnJlc2hlZCBieSBgcmVnaXN0ZXJfYWdlbnRgL2BwdWJsaXNoX3RyYWNlYC4AAAAAAA1pc19yZWdpc3RlcmVkAAAAAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAEBXaGV0aGVyIGEgQnV5L1NlbGwgdHJhY2Ugd2FzIHB1Ymxpc2hlZCBhZnRlciBpdHMgbWFya2V0J3MgY2xvc2UuAAAADWlzX3RyYWNlX2xhdGUAAAAAAAABAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAAAQ==",
        "AAAAAAAAACJFdmVyeSBhbGxvdy1saXN0ZWQgYE90aGVyYCBzeW1ib2wuAAAAAAANb3RoZXJfYWN0aW9ucwAAAAAAAAAAAAABAAAD6gAAABE=",
        "AAAAAAAAAEBUaGUgcGVuZGluZyBhZG1pbiBwcm9wb3NhbCwgaW5jbHVkaW5nIGl0cyBleHBpcnksIGlmIG9uZSBleGlzdHMuAAAADXBlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAfQAAAADFBlbmRpbmdBZG1pbg==",
        "AAAAAAAAAJZTdGFydHMgYSB0d28tc3RlcCBoYW5kb3ZlciBvZiB0aGUgYWRtaW4gcm9sZS4gVGhlIG5ldyBhZG1pbiBtdXN0IGNhbGwKYGFjY2VwdF9hZG1pbmAgaXRzZWxmLCBzbyBhIHR5cG8gY2Fubm90IGhhbmQgY29udHJvbCB0byBhbiBhZGRyZXNzCm5vYm9keSBob2xkcy4AAAAAAA1wcm9wb3NlX2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANcHVibGlzaF90cmFjZQAAAAAAAAUAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAC1RyYWNlQWN0aW9uAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAAAAAAANdHJhY2VfdmVyZGljdAAAAAAAAAIAAAAAAAAACHRyYWNlX2lkAAAABgAAAAAAAAANcmVjZWl2ZWRfaGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAfQAAAADFRyYWNlVmVyZGljdAAAAAM=",
        "AAAAAAAAAAAAAAAOYWdlbnRfYmF0Y2hfYXQAAAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAFaW5kZXgAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAENUaGUgYGluZGV4YC10aCAoMC1iYXNlZCwgcHVibGlzaCBvcmRlcikgdHJhY2UgaWQgZm9yIGBhZ2VudGAgKCM1NykuAAAAAA5hZ2VudF90cmFjZV9hdAAAAAAAAgAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAVpbmRleAAAAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAAAAAAAOZ2V0X3RyYWNlX2ZsYWcAAAAAAAEAAAAAAAAACHRyYWNlX2lkAAAABgAAAAEAAAPoAAAH0AAAAAlUcmFjZUZsYWcAAAA=",
        "AAAAAAAAADxDaGFpbiBsaW5rIGZvciBhIHRyYWNlOyBgTm9uZWAgZm9yIGxlZ2FjeSwgdW5jaGFpbmVkIHRyYWNlcy4AAAAOZ2V0X3RyYWNlX2xpbmsAAAAAAAEAAAAAAAAACHRyYWNlX2lkAAAABgAAAAEAAAPoAAAH0AAAAAlDaGFpbkxpbmsAAAA=",
        "AAAAAAAAAAAAAAAOcmVnaXN0ZXJfYWdlbnQAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPYWRkX3NpZ25pbmdfa2V5AAAAAAMAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAKcHVibGljX2tleQAAAAAD7gAAACAAAAAAAAAACXByb29mX3NpZwAAAAAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAG8jMjk5OiBQYWdlZCBsaXN0IG9mIGFmZmVjdGVkIHRyYWNlIGlkcyBzdGFydGluZyBmcm9tIHRoZSBmaXJzdAp0cmFjZSBwdWJsaXNoZWQgYXQgb3IgYWZ0ZXIgYGNvbXByb21pc2VkX3NpbmNlYC4AAAAAD2FmZmVjdGVkX3RyYWNlcwAAAAAEAAAAAAAAAApwdWJsaWNfa2V5AAAAAAPuAAAAIAAAAAAAAAARY29tcHJvbWlzZWRfc2luY2UAAAAAAAAGAAAAAAAAAApwYWdlX3N0YXJ0AAAAAAAGAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6QAAA+oAAAAGAAAAAw==",
        "AAAAAAAAAEYjMjk5OiBOdW1iZXIgb2YgdHJhY2VzIGEga2V5IGhhcyBzaWduZWQgKGxlbmd0aCBvZiB0aGUgcGVyLWtleSBpbmRleCkuAAAAAAAPa2V5X3RyYWNlX2NvdW50AAAAAAEAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAQAAAAY=",
        "AAAAAAAAAEFUaGUgYGluZGV4YC10aCAoMC1iYXNlZCwgcHVibGlzaCBvcmRlcikgdHJhY2UgaWQgZm9yIGBtYXJrZXRfaWRgLgAAAAAAAA9tYXJrZXRfdHJhY2VfYXQAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAFaW5kZXgAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAEBBIHBhZ2Ugb2YgZXZlcnkgdHJhY2UgYGFnZW50YCBwdWJsaXNoZWQsIGluIHB1Ymxpc2ggb3JkZXIgKCM1NykuAAAAD3RyYWNlc19ieV9hZ2VudAAAAAADAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAABXN0YXJ0AAAAAAAABgAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+kAAAfQAAAACVRyYWNlUGFnZQAAAAAAAAM=",
        "AAAAAAAAAEFDdXJyZW50IGNoYWluIGhlYWQgZm9yIGBhZ2VudGAgKGdlbmVzaXMgaWYgaXQgaGFzIG5ldmVyIGNoYWluZWQpLgAAAAAAABBhZ2VudF9jaGFpbl9oZWFkAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAB9AAAAAJQ2hhaW5IZWFkAAAA",
        "AAAAAAAAAClQdXJlIHJlYWQgKCMzMjkpOiB2aWV3cyBuZXZlciBleHRlbmQgVFRMLgAAAAAAABBnZXRfc2lnbmluZ19rZXlzAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAQAAA+oAAAPuAAAAIA==",
        "AAAAAAAAAGRMZWRnZXIgc2VxdWVuY2UgdGhlIHRyYWNlIHdhcyB3cml0dGVuIGluICgjNTApLiBgTm9uZWAgZm9yIHRyYWNlcwp3cml0dGVuIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQuAAAAEGdldF90cmFjZV9sZWRnZXIAAAABAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6AAAAAQ=",
        "AAAAAAAAAAAAAAAQcmVhY3RpdmF0ZV9hZ2VudAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHFTZXRzIHRoZSBwb3N0LWNsb3NlIGdyYWNlIHdpbmRvdyBmb3IgQnV5L1NlbGwgdHJhY2VzIChpc3N1ZSAjMzIyKSwKYXQgbW9zdCBbYE1BWF9BQ1RJT05fR1JBQ0VfU0VDU2BdLiBBZG1pbiBvbmx5LgAAAAAAABBzZXRfYWN0aW9uX2dyYWNlAAAAAQAAAAAAAAAEc2VjcwAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAPNBZGRzLCBjaGFuZ2VzIChgU29tZWApIG9yIHJlbW92ZXMgKGBOb25lYCkgYW4gYWxsb3ctbGlzdGVkCmBPdGhlcihzeW0pYCBhY3Rpb24gKGlzc3VlICMzMjIpLiBBdCBtb3N0IFtgTUFYX09USEVSX0FDVElPTlNgXQpzeW1ib2xzOyBjYW5vbmljYWwgYWN0aW9uIG5hbWVzIGFyZSByZWZ1c2VkLiBBZG1pbiBvbmx5LiBBcHBsaWVzIGF0CnB1Ymxpc2ggdGltZSBvbmx5LCBzbyBleGlzdGluZyB0cmFjZXMgYXJlIHVudG91Y2hlZC4AAAAAEHNldF9vdGhlcl9hY3Rpb24AAAACAAAAAAAAAANzeW0AAAAAEQAAAAAAAAAEcnVsZQAAA+gAAAfQAAAACU90aGVyUnVsZQAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAMNBIHBhZ2Ugb2YgZXZlcnkgdHJhY2UgZm9yIGBtYXJrZXRfaWRgLCBzdGFydGluZyBhdCBgc3RhcnRgICgjNTcpLgpSZXBsYWNlcyB0aGUgYG1hcmtldF90cmFjZV9jb3VudGAgKyBgbWFya2V0X3RyYWNlX2F0YCArIGBnZXRfdHJhY2VgCmxvb3AgKDEwMSBSUEMgc2ltdWxhdGlvbnMgZm9yIDUwIHRyYWNlcykgd2l0aCBvbmUgc2ltdWxhdGlvbi4AAAAAEHRyYWNlc19ieV9tYXJrZXQAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAVzdGFydAAAAAAAAAYAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPpAAAH0AAAAAlUcmFjZVBhZ2UAAAAAAAAD",
        "AAAAAAAAAAAAAAAQdW5yZWdpc3Rlcl9hZ2VudAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAARYWdlbnRfYmF0Y2hfY291bnQAAAAAAAABAAAAAAAAAAVhZ2VudAAAAAAAABMAAAABAAAABg==",
        "AAAAAAAAACxOdW1iZXIgb2YgdHJhY2VzIHB1Ymxpc2hlZCBieSBgYWdlbnRgICgjNTcpLgAAABFhZ2VudF90cmFjZV9jb3VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAG",
        "AAAAAAAAAIcjMjk5OiBCaW5hcnkgc2VhcmNoIGZvciB0aGUgZmlyc3QgdHJhY2UgaW5kZXggd2hvc2UgYHB1Ymxpc2hlZF9hdCA+PQpjb21wcm9taXNlZF9zaW5jZWAuIFJldHVybnMgdGhlIGluZGV4LCBvciBgdG90YWxgIGlmIG5vbmUgcXVhbGlmeS4AAAAAEWtleV9hZmZlY3RlZF9mcm9tAAAAAAAAAgAAAAAAAAAKcHVibGljX2tleQAAAAAD7gAAACAAAAAAAAAAEWNvbXByb21pc2VkX3NpbmNlAAAAAAAABgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAADdUaGUgbWFya2V0IHJ1bGUgb2YgYW4gYWxsb3ctbGlzdGVkIGBPdGhlcihzeW0pYCBhY3Rpb24uAAAAABFvdGhlcl9hY3Rpb25fcnVsZQAAAAAAAAEAAAAAAAAAA3N5bQAAAAARAAAAAQAAA+gAAAfQAAAACU90aGVyUnVsZQAAAA==",
        "AAAAAAAAAElBbGxvdy1saXN0cyBhIGNvbnRyYWN0IChlLmcuIHRoZSB0cmVhc3VyeSkgdG8gY2FsbCBgY29uc3VtZV90cmFjZWAgKCM1MCkuAAAAAAAAEXJlZ2lzdGVyX2NvbnN1bWVyAAAAAAAAAQAAAAAAAAAIY29uc3VtZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAH4jMjk5OiBSZXR1cm5zIHRoZSBzaWduYXR1cmUtbGV2ZWwgdmVyZGljdCBmb3IgYSB0cmFjZSwgaW5kZXBlbmRlbnQgb2YKaGFzaC9mbGFnL2FnZW50IGNoZWNrcy4gVXNlcyBhIGNvbnN0YW50IG51bWJlciBvZiByZWFkcy4AAAAAABFzaWduYXR1cmVfdmVyZGljdAAAAAAAAAEAAAAAAAAACHRyYWNlX2lkAAAABgAAAAEAAAPpAAAH0AAAABBTaWduYXR1cmVWZXJkaWN0AAAAAw==",
        "AAAAAAAAAHRDaGVja3MgYSBjb21taXQtcmV2ZWFsIGNvbW1pdG1lbnQgKCM1MSk6CmBjb21taXRtZW50ID09IHNoYTI1Nigib3JhY2xlZGVzay50cmFjZS5jb21taXQudjEiIHx8IHRyYWNlX2hhc2ggfHwgc2FsdClgLgAAABF2ZXJpZnlfY29tbWl0bWVudAAAAAAAAAMAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAARzYWx0AAAD7gAAACAAAAAAAAAACmNvbW1pdG1lbnQAAAAAA+4AAAAgAAAAAQAAAAE=",
        "AAAAAAAAACtOdW1iZXIgb2YgdHJhY2VzIHB1Ymxpc2hlZCBmb3IgYG1hcmtldF9pZGAuAAAAABJtYXJrZXRfdHJhY2VfY291bnQAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABg==",
        "AAAAAAAAAAAAAAAScmV0aXJlX3NpZ25pbmdfa2V5AAAAAAACAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAATBSZXZva2VzIGEgc2lnbmluZyBrZXkgcmV0cm9hY3RpdmVseS4gVmVyZGljdHMgZm9yIHRyYWNlcyB0aGUga2V5IHNpZ25lZAphdCBvciBhZnRlciBgY29tcHJvbWlzZWRfc2luY2VgIGZsaXAgdG8gYEtleUNvbXByb21pc2VkYC4gQ2FsbGFibGUgYnkKdGhlIGFnZW50IG9yIHRoZSByZWdpc3RyeSBhZG1pbiwgaW5jbHVkaW5nIGZvciByZXRpcmVkIG9yIHJldm9rZWQKYWdlbnRzLiBSZXZvY2F0aW9uIGlzIHBlcm1hbmVudDsgYGNvbXByb21pc2VkX3NpbmNlYCBjYW4gb25seSBtb3ZlCmVhcmxpZXIgb24gYSBzdWJzZXF1ZW50IGNhbGwuAAAAEnJldm9rZV9zaWduaW5nX2tleQAAAAAABQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACnB1YmxpY19rZXkAAAAAA+4AAAAgAAAAAAAAABFjb21wcm9taXNlZF9zaW5jZQAAAAAAAAYAAAAAAAAABnJlYXNvbgAAAAAAEQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAATY29tcHV0ZV9tZXJrbGVfcm9vdAAAAAAEAAAAAAAAAApsZWFmX2NvdW50AAAAAAAEAAAAAAAAAAp0cmFjZV9oYXNoAAAAAAPuAAAAIAAAAAAAAAAFaW5kZXgAAAAAAAAEAAAAAAAAAAVwcm9vZgAAAAAAA+oAAAPuAAAAIAAAAAEAAAPpAAAD7gAAACAAAAAD",
        "AAAAAAAAAAAAAAATZ2V0X3RyYWNlX3NpZ25hdHVyZQAAAAABAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6AAAA+0AAAACAAAD7gAAACAAAAPuAAAAQA==",
        "AAAAAAAAAGxBbmNob3JzIGEgTWVya2xlIGJhdGNoIG9mIE4gdHJhY2VzIG9mZi1jaGFpbiwgc3RvcmluZyBvbmx5IHRoZSAzMi1ieXRlIHJvb3QKYW5kIG1hbmlmZXN0IENJRCBvbi1jaGFpbiAoIzU0KS4AAAATcHVibGlzaF90cmFjZV9iYXRjaAAAAAAEAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAABHJvb3QAAAPuAAAAIAAAAAAAAAAKbGVhZl9jb3VudAAAAAAABAAAAAAAAAAMbWFuaWZlc3RfY2lkAAAAEAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAAAAAAATc2lnbmluZ19rZXlfaGlzdG9yeQAAAAADAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAABXN0YXJ0AAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+kAAAPqAAAH0AAAABBTaWduaW5nS2V5UmVjb3JkAAAAAw==",
        "AAAAAAAAAAAAAAATdW5yZWdpc3Rlcl9jb25zdW1lcgAAAAABAAAAAAAAAAhjb25zdW1lcgAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADhUcmFjZSBpZCBhdCBwb3NpdGlvbiBgc2VxYCAoMS1iYXNlZCkgb2YgYGFnZW50YCdzIGNoYWluLgAAABRhZ2VudF9jaGFpbl90cmFjZV9hdAAAAAIAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAADc2VxAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAAAAAAAUcHVibGlzaF90cmFjZV9zaWduZWQAAAAHAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAtUcmFjZUFjdGlvbgAAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAAC3NpZ25pbmdfa2V5AAAAA+4AAAAgAAAAAAAAAAlzaWduYXR1cmUAAAAAAAPuAAAAQAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAOpQdWJsaXNoZXMgYSB0cmFjZSB0aGF0IGV4dGVuZHMgYGFnZW50YCdzIGhhc2ggY2hhaW4gKCM1MikuIEZhaWxzIHdpdGgKYENoYWluSGVhZE1pc21hdGNoYCB1bmxlc3MgYGV4cGVjdGVkX3NlcSA9PSBoZWFkLnNlcSArIDFgIGFuZApgcHJldl90cmFjZV9oYXNoID09IGhlYWQuaGVhZF9oYXNoYCwgc28gYSBza2lwcGVkIGRlY2lzaW9uIHNob3dzIHVwIGFzCmEgZ2FwIGFuZCBhIGZvcmsgaXMgaW1wb3NzaWJsZS4AAAAAABVwdWJsaXNoX2NoYWluZWRfdHJhY2UAAAAAAAAHAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAtUcmFjZUFjdGlvbgAAAAAAAAAACnRyYWNlX2hhc2gAAAAAA+4AAAAgAAAAAAAAAAhpcGZzX2NpZAAAABAAAAAAAAAADGV4cGVjdGVkX3NlcQAAAAYAAAAAAAAAD3ByZXZfdHJhY2VfaGFzaAAAAAPuAAAAIAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAFFUaGUgYGluZGV4YC10aCAoMC1iYXNlZCwgcHVibGlzaCBvcmRlcikgdHJhY2UgaWQgZm9yCmAobWFya2V0X2lkLCBhY3Rpb24pYCAoIzU3KS4AAAAAAAAWbWFya2V0X2FjdGlvbl90cmFjZV9hdAAAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAC1RyYWNlQWN0aW9uAAAAAAAAAAAFaW5kZXgAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAWdmVyaWZ5X3RyYWNlX2luY2x1c2lvbgAAAAAABAAAAAAAAAAIYmF0Y2hfaWQAAAAGAAAAAAAAAAp0cmFjZV9oYXNoAAAAAAPuAAAAIAAAAAAAAAAFaW5kZXgAAAAAAAAEAAAAAAAAAAVwcm9vZgAAAAAAA+oAAAPuAAAAIAAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAAAAAAAWdmVyaWZ5X3RyYWNlX3NpZ25hdHVyZQAAAAAAAQAAAAAAAAAIdHJhY2VfaWQAAAAGAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAAHJBIHBhZ2Ugb2YgZXZlcnkgdHJhY2UgZm9yIGAobWFya2V0X2lkLCBhY3Rpb24pYCwgaW4gcHVibGlzaCBvcmRlcgooIzU3KSDigJQgZS5nLiBldmVyeSBgQnV5YCBkZWNpc2lvbiBvbiBtYXJrZXQgNy4AAAAAABd0cmFjZXNfYnlfbWFya2V0X2FjdGlvbgAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZhY3Rpb24AAAAAB9AAAAALVHJhY2VBY3Rpb24AAAAAAAAAAAVzdGFydAAAAAAAAAYAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPpAAAH0AAAAAlUcmFjZVBhZ2UAAAAAAAAD",
        "AAAAAAAAADpOdW1iZXIgb2YgdHJhY2VzIGZvciB0aGUgYChtYXJrZXRfaWQsIGFjdGlvbilgIHBhaXIgKCM1NykuAAAAAAAZbWFya2V0X2FjdGlvbl90cmFjZV9jb3VudAAAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAtUcmFjZUFjdGlvbgAAAAABAAAABg==",
        "AAAAAAAAAAAAAAAZc2lnbmluZ19rZXlfaGlzdG9yeV9jb3VudAAAAAAAAAEAAAAAAAAABWFnZW50AAAAAAAAEwAAAAEAAAAE",
        "AAAAAAAAAAAAAAAccHVibGlzaF9jaGFpbmVkX3RyYWNlX3NpZ25lZAAAAAkAAAAAAAAABWFnZW50AAAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAC1RyYWNlQWN0aW9uAAAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAACGlwZnNfY2lkAAAAEAAAAAAAAAAMZXhwZWN0ZWRfc2VxAAAABgAAAAAAAAAPcHJldl90cmFjZV9oYXNoAAAAA+4AAAAgAAAAAAAAAAtzaWduaW5nX2tleQAAAAPuAAAAIAAAAAAAAAAJc2lnbmF0dXJlAAAAAAAD7gAAAEAAAAABAAAD6QAAAAYAAAAD" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<Result<string>>,
        get_agent: this.txFromJSON<Option<AgentRecord>>,
        get_batch: this.txFromJSON<Result<TraceBatch>>,
        get_trace: this.txFromJSON<Result<Trace>>,
        flag_trace: this.txFromJSON<Result<void>>,
        key_traces: this.txFromJSON<Result<Array<u64>>>,
        batch_count: this.txFromJSON<u64>,
        is_consumed: this.txFromJSON<boolean>,
        is_consumer: this.txFromJSON<boolean>,
        retire_self: this.txFromJSON<Result<void>>,
        trace_count: this.txFromJSON<u64>,
        trace_flags: this.txFromJSON<Result<Array<TraceFlag>>>,
        accept_admin: this.txFromJSON<Result<void>>,
        action_grace: this.txFromJSON<u64>,
        extend_agent: this.txFromJSON<Result<void>>,
        extend_index: this.txFromJSON<Result<u32>>,
        retire_agent: this.txFromJSON<Result<void>>,
        revoke_agent: this.txFromJSON<Result<void>>,
        unflag_trace: this.txFromJSON<Result<void>>,
        verify_trace: this.txFromJSON<Result<boolean>>,
        consume_trace: this.txFromJSON<Result<Trace>>,
        extend_traces: this.txFromJSON<Result<u32>>,
        get_key_agent: this.txFromJSON<Option<string>>,
        is_registered: this.txFromJSON<boolean>,
        is_trace_late: this.txFromJSON<boolean>,
        other_actions: this.txFromJSON<Array<string>>,
        pending_admin: this.txFromJSON<Option<PendingAdmin>>,
        propose_admin: this.txFromJSON<Result<void>>,
        publish_trace: this.txFromJSON<Result<u64>>,
        trace_verdict: this.txFromJSON<Result<TraceVerdict>>,
        agent_batch_at: this.txFromJSON<Result<u64>>,
        agent_trace_at: this.txFromJSON<Result<u64>>,
        get_trace_flag: this.txFromJSON<Option<TraceFlag>>,
        get_trace_link: this.txFromJSON<Option<ChainLink>>,
        register_agent: this.txFromJSON<Result<void>>,
        add_signing_key: this.txFromJSON<Result<void>>,
        affected_traces: this.txFromJSON<Result<Array<u64>>>,
        key_trace_count: this.txFromJSON<u64>,
        market_trace_at: this.txFromJSON<Result<u64>>,
        traces_by_agent: this.txFromJSON<Result<TracePage>>,
        agent_chain_head: this.txFromJSON<ChainHead>,
        get_signing_keys: this.txFromJSON<Array<Buffer>>,
        get_trace_ledger: this.txFromJSON<Option<u32>>,
        reactivate_agent: this.txFromJSON<Result<void>>,
        set_action_grace: this.txFromJSON<Result<void>>,
        set_other_action: this.txFromJSON<Result<void>>,
        traces_by_market: this.txFromJSON<Result<TracePage>>,
        unregister_agent: this.txFromJSON<Result<void>>,
        agent_batch_count: this.txFromJSON<u64>,
        agent_trace_count: this.txFromJSON<u64>,
        key_affected_from: this.txFromJSON<Result<u64>>,
        other_action_rule: this.txFromJSON<Option<OtherRule>>,
        register_consumer: this.txFromJSON<Result<void>>,
        signature_verdict: this.txFromJSON<Result<SignatureVerdict>>,
        verify_commitment: this.txFromJSON<boolean>,
        market_trace_count: this.txFromJSON<u64>,
        retire_signing_key: this.txFromJSON<Result<void>>,
        revoke_signing_key: this.txFromJSON<Result<void>>,
        compute_merkle_root: this.txFromJSON<Result<Buffer>>,
        get_trace_signature: this.txFromJSON<Option<readonly [Buffer, Buffer]>>,
        publish_trace_batch: this.txFromJSON<Result<u64>>,
        signing_key_history: this.txFromJSON<Result<Array<SigningKeyRecord>>>,
        unregister_consumer: this.txFromJSON<Result<void>>,
        agent_chain_trace_at: this.txFromJSON<Result<u64>>,
        publish_trace_signed: this.txFromJSON<Result<u64>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        publish_chained_trace: this.txFromJSON<Result<u64>>,
        market_action_trace_at: this.txFromJSON<Result<u64>>,
        verify_trace_inclusion: this.txFromJSON<Result<boolean>>,
        verify_trace_signature: this.txFromJSON<Result<boolean>>,
        traces_by_market_action: this.txFromJSON<Result<TracePage>>,
        market_action_trace_count: this.txFromJSON<u64>,
        signing_key_history_count: this.txFromJSON<u32>,
        publish_chained_trace_signed: this.txFromJSON<Result<u64>>
  }
}