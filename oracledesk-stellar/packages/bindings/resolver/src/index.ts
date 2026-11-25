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


export interface PriceData {
  price: i128;
  timestamp: u64;
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
  18: {message:"SpecHashMismatch"},
  19: {message:"DeadlineNotReached"},
  20: {message:"ResolutionAvailable"},
  21: {message:"DomainMismatch"},
  22: {message:"StaleRound"},
  23: {message:"TooManySignatures"},
  24: {message:"DisputeWindowClosed"},
  25: {message:"NoDispute"},
  26: {message:"CommitteeNotFound"},
  27: {message:"RotationPending"},
  28: {message:"RotationNotReady"},
  29: {message:"RotationBoundExceeded"},
  30: {message:"DuplicateMember"},
  31: {message:"CommitteeTooLarge"},
  32: {message:"EvidenceDisabled"},
  33: {message:"EvidenceRequired"},
  34: {message:"EvidenceNotFound"},
  35: {message:"EvidenceAuthorMismatch"},
  36: {message:"EvidenceMarketMismatch"},
  37: {message:"EvidenceTooEarly"},
  38: {message:"EvidenceAlreadyUsed"},
  39: {message:"GuardianNotAllowed"},
  40: {message:"TooManyCancels"},
  41: {message:"SnapshotExists"},
  /**
   * `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
   */
  42: {message:"NoPendingAdmin"},
  /**
   * A proposed admin handover was not accepted within its `expires_at`.
   */
  43: {message:"PendingAdminExpired"},
  /**
   * #149: a bounty operation ran before `set_bounty_token`.
   */
  44: {message:"BountyTokenNotSet"},
  /**
   * #149: bounty amounts must be positive.
   */
  45: {message:"InvalidBounty"},
  /**
   * #149: bounties are funded only before the market's `close_time`.
   */
  46: {message:"BountyFundingClosed"},
  /**
   * #149: a market's escrow has one funder; any other address can neither
   * top it up nor reclaim it.
   */
  47: {message:"BountyFunderMismatch"},
  /**
   * #149: no bounty was funded for this market.
   */
  48: {message:"NoBounty"},
  /**
   * #149: a bounty can be reclaimed only once the market is final.
   */
  49: {message:"BountyNotFinal"},
  /**
   * `attest_cat` outcome index not below the committed `outcome_count`.
   * Renumbered after develop's #149 bounty codes claimed 44..=49.
   */
  50: {message:"InvalidOutcomeIndex"},
  1044: {message:"MarketCoreMarketNotFound"},
  1045: {message:"MarketCoreNotFinal"},
  1046: {message:"MarketCoreMarketNotOpen"},
  1047: {message:"MarketCoreMarketClosed"},
  1048: {message:"MarketCoreInsufficientLiquidity"},
  1049: {message:"MarketCoreInsufficientShares"},
  1050: {message:"MarketCoreAlreadyClaimed"},
  1051: {message:"MarketCoreNothingToRedeem"},
  1052: {message:"MarketCoreInvalidAmount"},
  1053: {message:"MarketCoreOverflow"},
  1054: {message:"MarketCoreSlippageExceeded"},
  1055: {message:"MarketCoreCallFailed"},
  1056: {message:"RegistryCallFailed"}
}

/**
 * The escalation authority's ruling. `Invalid` voids the market.
 */
export type Verdict = {tag: "Yes", values: void} | {tag: "No", values: void} | {tag: "Invalid", values: void};

export type RuleKind = {tag: "Price", values: void} | {tag: "Signers", values: void} | {tag: "WeightedKeys", values: void} | {tag: "SignersDisputable", values: void} | {tag: "Committee", values: void} | {tag: "Hybrid", values: void} | {tag: "ScaledPrice", values: void} | {tag: "Twap", values: void} | {tag: "CategoricalSigners", values: void} | {tag: "Scalar", values: void} | {tag: "HybridV2", values: void};

/**
 * Which kind of resolution rule a market has *revealed*, as read by
 * [`Resolver::spec_kind`]. `ResolutionState` cannot tell "revealed" from "not
 * revealed": a revealed price or signer market still reads `Unconfigured`
 * until it is finalized, disputed or reset, so the kind is derived from which
 * spec entry exists (#273).
 */
export type SpecKind = {tag: "None", values: void} | {tag: "Price", values: void} | {tag: "ScaledPrice", values: void} | {tag: "Twap", values: void} | {tag: "Signers", values: void} | {tag: "Disputable", values: void} | {tag: "WeightedKeys", values: void} | {tag: "Committee", values: void} | {tag: "Hybrid", values: void} | {tag: "HybridV2", values: void};




/**
 * Reusable committee managed by an admin under time-locked rotation rules.
 */
export interface Committee {
  admin: string;
  epoch: u32;
  members: Array<string>;
  rotation_delay: u64;
  threshold: u32;
}

/**
 * Which resolution path a market was on when it expired.
 */
export type ExpiryMode = {tag: "Unrevealed", values: void} | {tag: "Price", values: void} | {tag: "Signers", values: void} | {tag: "Scalar", values: void};


/**
 * Time-weighted-average price rule (issue #27). The market settles on the
 * average of the feed's records over a window ending at `close_time`
 * instead of a single print: a manipulated or anomalous close record can no
 * longer decide the market on its own. Like the legacy [`PriceConfig`] (and
 * unlike [`ScaledPriceConfig`], issue #26) the `threshold` is in
 * feed-native units — the TWAP is a raw-price average — and the committed
 * comparison applies to the floored average (see `twap_outcome` and ADR
 * 0001). `min_samples`/`max_gap` encode how much of the window the feed
 * must actually have filled: resolution is rejected (`StalePrice`) below
 * `min_samples` present records or when any gap — window start to first
 * sample, consecutive samples, or last sample to `close_time` — exceeds
 * `max_gap`.
 * 
 * Same canonical-home note as [`ScaledPriceConfig`]: this is a
 * resolver-local type committing through a domain-tagged preimage
 * ([`twap_spec_hash`]) because PR #176 froze `oracledesk-types`'
 * `ResolutionSpec` as the shared enum router 
 */
export interface TwapConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_gap: u64;
  min_samples: u32;
  reflector: string;
  threshold: i128;
  window: u64;
}



/**
 * Everything the treasury's pre-trade resolvability check needs, in one
 * cross-contract call (#273).
 */
export interface TradeStatus {
  /**
 * market-core `close_time`.
 */
close_time: u64;
  /**
 * `close_time + RESOLUTION_GRACE_SECS`: when `expire_market` becomes callable.
 */
deadline: u64;
  /**
 * A signer proposal is pending (its dispute window may be open).
 */
open_proposal: boolean;
  spec: SpecKind;
  state: ResolutionState;
}


/**
 * A proposed admin handover (#62). Absent when no transfer is pending.
 */
export interface PendingAdmin {
  address: string;
  expires_at: u64;
}



/**
 * A price read pinned by [`Resolver::snapshot_price`] so resolution survives
 * the oracle aging the `close_time` record out of its history.
 */
export interface PriceSnapshot {
  data: PriceData;
  taken_at: u64;
  taken_by: string;
}


/**
 * Evidence policy governing whether attestation evidence is required.
 */
export type EvidencePolicy = {tag: "Disabled", values: void} | {tag: "Optional", values: void} | {tag: "Required", values: void};

/**
 * Reason code constraining guardian interventions.
 */
export type GuardianReason = {tag: "UnrevealedSpec", values: void} | {tag: "OracleUnavailable", values: void} | {tag: "SignersStalled", values: void} | {tag: "DisputeUpheld", values: void};






/**
 * What a signer attests to. Resolver-local so market-core's `Outcome` (and
 * the vendored `market_core.wasm`) never gains an `Invalid` variant: an
 * `Invalid` proposal finalizes through market-core's `void_market` instead
 * of `resolve`. Never part of a `ResolutionSpec`, so commitment hashes are
 * unaffected (ADR 0001).
 */
export type AttestedOutcome = {tag: "Yes", values: void} | {tag: "No", values: void} | {tag: "Invalid", values: void};

export type ResolutionState = {tag: "Unconfigured", values: void} | {tag: "SignersPending", values: void} | {tag: "Finalized", values: void} | {tag: "Expired", values: void} | {tag: "Disputed", values: void} | {tag: "HybridPricePending", values: void} | {tag: "HybridFallbackOpen", values: void};








/**
 * Decimal-explicit price rule (issue #26, goal 2). Unlike the legacy
 * [`PriceConfig`] — re-exported here from `oracledesk-types`, whose
 * `threshold` is in *feed-native units* and is compared to the raw feed
 * price with no scaling, so every committed legacy hash and meaning is
 * unchanged (ADR 0001) — this struct records
 * `threshold_decimals`, and resolution rescales both the threshold and the
 * feed price to `max(feed_decimals, threshold_decimals)` with checked
 * arithmetic before comparing. A creator who means "$0.20" commits
 * `threshold = 20`, `threshold_decimals = 2` instead of guessing the feed's
 * scale.
 * 
 * `PriceConfig` and `SignerConfig` deliberately do **not** appear here:
 * PR #176 made `contracts/oracledesk-types` their canonical home and this
 * crate re-exports them (see the `pub use` at the top of this file), so a
 * `resolution_hash` commitment never depends on which crate declared the
 * type. [`ScaledPriceConfig`] stays resolver-local for now for the same
 * reason ADR 0001 can state its append-only rule so precisely 
 */
export interface ScaledPriceConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_staleness: u64;
  reflector: string;
  threshold: i128;
  threshold_decimals: u32;
}



/**
 * Guardian action type emitted for audit trails.
 */
export type GuardianActionKind = {tag: "Void", values: void} | {tag: "CancelProposal", values: void};



/**
 * Stored link connecting an attestation to a reasoning registry trace.
 * `outcome` was a market-core `Outcome` before `Invalid` attestations; the
 * two enums encode `Yes`/`No` identically, so earlier entries still decode.
 */
export interface AttestationEvidence {
  attested_at: u64;
  outcome: AttestedOutcome;
  signer: string;
  trace_hash: Buffer;
  trace_id: u64;
}








/**
 * Who rules on a dispute.
 */
export type Escalation = {tag: "Guardian", values: void} | {tag: "Committee", values: readonly [Array<string>, u32]};


export interface WeightedKey {
  /**
 * Raw Ed25519 public key. For a `G...` account address this is
 * `StrKey.decodeEd25519PublicKey(address)`; `C...` addresses have none.
 */
pubkey: Buffer;
  weight: u32;
}


/**
 * Binds a market to a reusable committee registry subject to rotation bounds.
 */
export interface CommitteeRef {
  committee_id: u64;
  dispute_window: u64;
  max_rotation_delta: u32;
  min_epoch: u32;
}


/**
 * Dual-path resolution mode: price feed first, falling back to signers.
 */
export interface HybridConfig {
  fallback: SignerConfig;
  fallback_after: u64;
  price: PriceConfig;
}


/**
 * Extended hybrid mode: price feed first, falling back to any attested
 * authority after `fallback_after` seconds past `close_time`.
 * 
 * A separate struct (not an in-place update to `HybridConfig`) because
 * `HybridConfig` is consensus-critical — existing commitment hashes must
 * continue to verify.
 */
export interface HybridConfigV2 {
  fallback: FallbackAuthority;
  fallback_after: u64;
  price: PriceConfig;
}

/**
 * The full resolution rule a market's `resolution_hash` commits to. Hashing
 * this (rather than the bare `PriceConfig`/`SignerConfig`) keeps the two
 * modes in disjoint hash spaces even if their field encodings could
 * otherwise collide. See `docs/adr/0001-resolution-commitment.md`.
 */
export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "Hybrid", values: readonly [HybridConfig]} | {tag: "HybridV2", values: readonly [HybridConfigV2]} | {tag: "CategoricalSigners", values: readonly [CatSignerConfig]} | {tag: "Scalar", values: readonly [ScalarPriceConfig]};


/**
 * Categorical counterpart of [`SignerConfig`]: signers attest an outcome
 * *index* of a categorical market instead of Yes/No. `outcome_count`
 * binds the market's outcome set to the commitment (2..=8, mirroring
 * market-core's cap), so a reveal cannot silently change how many outcomes
 * signers are voting on.
 */
export interface CatSignerConfig {
  dispute_window: u64;
  outcome_count: u32;
  signers: Array<string>;
  threshold: u32;
}


/**
 * Versioned commitment envelope. Unlike a bare [`ResolutionSpec`] it binds the
 * network and the market-core instance, and carries a creator-chosen `salt`
 * that makes a pre-reveal brute-force of the (low-entropy) rule infeasible.
 */
export interface ResolutionSpecV2 {
  market_core: string;
  /**
 * `sha256(network passphrase)`, i.e. `env.ledger().network_id()`.
 */
network_id: Buffer;
  rule: ResolutionSpec;
  salt: Buffer;
  version: u32;
}

/**
 * Richer fallback authority for `HybridV2`: any attested resolution mode
 * that can produce a quorum, not just bare signers.
 * 
 * Variants are intentionally additive and appended after `Signers` so that
 * existing discriminant positions are stable (Soroban encodes as positional).
 */
export type FallbackAuthority = {tag: "Signers", values: readonly [SignerConfig]} | {tag: "Committee", values: readonly [CommitteeRef]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]};


/**
 * Scalar (range) counterpart of [`PriceConfig`]. The market settles on the
 * fractional position of `price` inside `[lower, upper]`:
 * `payout_long_bps = (clamped_price - lower) / (upper - lower)`, and the
 * SHORT side pays the complement. A reading below the range clamps to
 * `lower` (LONG pays 0), above to `upper` (LONG pays 1.0); a non-positive
 * reading is an invalid price, never a clamp.
 */
export interface ScalarPriceConfig {
  asset: OracleAsset;
  /**
 * Bottom of the staked range. Validated `0 <= lower < upper`, with
 * `upper` capped so `upper * BPS` cannot overflow.
 */
lower: i128;
  max_staleness: u64;
  reflector: string;
  upper: i128;
}


export interface WeightedKeyConfig {
  dispute_window: u64;
  signers: Array<WeightedKey>;
  /**
 * Total weight that must sign one outcome. Choose it above half the total
 * weight so two outcomes can never both reach it.
 */
weight_threshold: u32;
}


/**
 * Attested resolution whose proposal can be challenged with a bond during
 * the dispute window. Hashed as `ResolutionSpec::SignersDisputable`, a
 * separate variant, so existing `Signers` commitments are unaffected.
 */
export interface DisputableSignerConfig {
  /**
 * Collateral escrowed by `dispute`; must be positive.
 */
dispute_bond: i128;
  dispute_window: u64;
  escalation: Escalation;
  /**
 * Seconds after a dispute opens before anyone may void it unresolved.
 */
escalation_timeout: u64;
  signers: Array<string>;
  threshold: u32;
}

export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pure view: no TTL extensions. The instance and the market's entries
   * are kept alive by the mutating entrypoints above, so a view-only
   * simulation stays read-only.
   */
  state: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<ResolutionState>>

  /**
   * Construct and simulate a attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records `signer`'s vote for `outcome` (allowed only once `close_time`
   * has passed). `Invalid` claims the question is unanswerable; an
   * `Invalid` proposal finalizes by voiding the market.
   * 
   * Split votes: every outcome, `Invalid` included, has its own counter,
   * and a signer is deduplicated per `(outcome, signer)`, so one signer may
   * attest several outcomes (existing behaviour, extended to `Invalid`).
   * The first outcome to reach threshold becomes the proposal and later
   * `Yes`/`No` quorums never move it. The one exception: `Invalid` reaching
   * threshold replaces a pending `Yes`/`No` proposal and restarts the
   * dispute window, because a quorum saying the question cannot be
   * answered outranks an answer to it. An `Invalid` proposal is never
   * replaced. (Requiring `Invalid` to beat every other count is a possible
   * follow-up.)
   */
  attest: ({market_id, signer, outcome}: {market_id: u64, signer: string, outcome: AttestedOutcome}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Challenges the current proposal of a `SignersDisputable` market while
   * its dispute window is still open (strictly before `proposed_at +
   * dispute_window`, the instant `finalize_signers` becomes callable). The
   * disputer escrows `dispute_bond` of the collateral token, which freezes
   * finalization until the escalation authority rules or
   * `escalation_timeout` lapses. `alternative` is the outcome the disputer
   * claims is correct (`None`: the market is invalid); it only informs the
   * ruling and must differ from the proposal (so `None` is rejected for an
   * `Invalid` proposal). The disputer may also be a proposing signer.
   */
  dispute: ({market_id, disputer, alternative}: {market_id: u64, disputer: string, alternative: Option<Outcome>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a snapshot transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The price pinned by `snapshot_price`, if any.
   */
  snapshot: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceSnapshot>>>

  /**
   * Construct and simulate a rule_kind transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  rule_kind: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<RuleKind>>>

  /**
   * Construct and simulate a spec_kind transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Which kind of rule `market_id` has revealed (`SpecKind::None` before any
   * reveal). Existence checks only (`has`), so the read footprint stays
   * minimal; a missing or archived entry reads as `None`, it never panics.
   * Needed because `state()` stays `Unconfigured` for a revealed price or
   * signer market (#273).
   */
  spec_kind: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<SpecKind>>

  /**
   * Construct and simulate a attest_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical counterpart of `attest`: `signer` attests that
   * `outcome_index` is the winner. `outcome_index` must be below the
   * `outcome_count` the market's commitment fixed. Once `threshold`
   * members have attested an index it becomes the proposal and the
   * dispute window opens.
   */
  attest_cat: ({market_id, signer, outcome_index}: {market_id: u64, signer: string, outcome_index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a evidence_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reads the evidence citation at `index` for `market_id`.
   */
  evidence_at: ({market_id, index}: {market_id: u64, index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AttestationEvidence>>>

  /**
   * Construct and simulate a fund_bounty transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #149: escrows `amount` of the bounty token for `market_id`. Anyone may
   * fund a market before its `close_time`. An escrow has a single funder
   * (refunds go back to it), so a top-up must come from that same address.
   */
  fund_bounty: ({funder, market_id, amount}: {funder: string, market_id: u64, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a market_core transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  market_core: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Total proposal cancellations executed by the guardian for `market_id`.
   */
  cancel_count: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a finalize_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical counterpart of `finalize_signers`: once the dispute window
   * of a proposal has passed and its index still has `threshold`
   * attestations, resolves the market in market-core and returns the
   * winning index.
   */
  finalize_cat: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a resolve_twap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Resolves a [`TwapConfig`] market (issue #27). Same lifecycle as
   * `resolve_price` (closed, not terminal), and markets already revealed
   * as TWAP also resolve through `resolve_price`, which dispatches here.
   * Non-TWAP markets are `WrongMode`.
   */
  resolve_twap: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a trade_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The spec kind, resolution state, deadline and proposal flag in one read:
   * one cross-contract call from the treasury instead of four. Reads
   * market-core's `close_time` once. A pure view: it does not extend any TTL
   * (so a simulation stays read-only), unlike `instance_get`.
   */
  trade_status: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TradeStatus>>>

  /**
   * Construct and simulate a current_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current attestation round of a weighted-key market; the `round`
   * argument of `submit_signatures` and part of every signed message.
   */
  current_round: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a expire_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless liveness fallback: once `resolution_deadline` has passed,
   * anyone may void a market that is still unresolved, so collateral is
   * never locked behind a missing reveal, a dead feed or silent signers.
   * 
   * Resolution is preferred over voiding. A price market whose feed is
   * valid right now is *resolved* instead (so a stalled caller can never
   * force a void on a resolvable market), and a market with a pending
   * signer or categorical proposal is refused with `ResolutionAvailable`
   * until it is finalized.
   */
  expire_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_committee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reads committee state and extends its storage TTL.
   */
  get_committee: ({committee_id}: {committee_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Committee>>>

  /**
   * Construct and simulate a open_fallback transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Opens fallback signer attestation in a hybrid market if the feed failed past the deadline.
   */
  open_fallback: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The pending admin proposal, including its expiry, if one exists.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingAdmin>>>

  /**
   * Construct and simulate a preview_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The feed's newest observation (`lastprice`) for the market's committed
   * asset: a read-only health check for keepers before calling
   * `resolve_price`. Resolution never consults it (issue #26): a live
   * `lastprice` can be fresher than `close_time`, and the historical grid
   * lookup is the only settlement source. A trapping feed or a feed with
   * no record is `PriceUnavailable`; signer-mode markets are `WrongMode`.
   */
  preview_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PriceData>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Starts a two-step handover of the admin role. The new admin must call
   * `accept_admin` itself, so a typo cannot hand control to an address
   * nobody holds.
   */
  propose_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a evidence_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Total evidence citations recorded for `market_id`.
   */
  evidence_count: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a expire_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless fallback when the escalation authority never rules:
   * `escalation_timeout` after the dispute opened, the bond is refunded and
   * the market is voided, so neither side wins by default.
   */
  expire_dispute: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reclaim_bounty transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #149: returns an unpaid escrow to its funder once the market is final.
   * This covers a market finalized through `resolve_price` or
   * `finalize_signers` rather than their `_for` variants, which would
   * otherwise leave the escrow stranded. Returns the amount refunded.
   */
  reclaim_bounty: ({funder, market_id}: {funder: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a settle_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian escalation: the admin rules on an open dispute.
   */
  settle_dispute: ({market_id, verdict}: {market_id: u64, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a snapshot_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pins the committed feed's price for `close_time` in resolver storage,
   * so `resolve_price` still works after the oracle's bounded history has
   * aged that record out (SEP-40 `price(asset, timestamp)` returns `None`
   * outside the retained window). Permissionless: `caller` only authorizes
   * being recorded as `taken_by`.
   * 
   * Callable any time after `close_time` while the market is unresolved,
   * but in practice it must run within the oracle's retention window (see
   * `docs/architecture.md`, "Oracle history retention"). The first valid
   * snapshot wins (`SnapshotExists` afterwards): for a fixed
   * `(asset, close_time)` the answer is deterministic, and freezing it
   * deliberately prefers determinism over an oracle later rewriting
   * history. A price `resolve_price` would reject is never stored.
   */
  snapshot_price: ({market_id, caller}: {market_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PriceData>>>

  /**
   * Construct and simulate a cancel_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: withdraws an unfinalized signer proposal during the dispute window
   * subject to a rate limit of MAX_CANCELS_PER_MARKET.
   * 
   * Works the same for an `Invalid` proposal. Only the proposal is removed:
   * attestations and per-outcome counts stay, so the next attestation that
   * brings any outcome to threshold (for example a further `Yes` once
   * `Yes` already has quorum) proposes again. A categorical market keeps its
   * pending winner in a separate slot, cleared the same way.
   */
  cancel_proposal: ({market_id, reason}: {market_id: u64, reason: GuardianReason}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_rotation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels a pending rotation for a committee (admin only).
   */
  cancel_rotation: ({committee_id}: {committee_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a evidence_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reads the currently configured evidence settings, if any.
   */
  evidence_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [string, EvidencePolicy]>>>

  /**
   * Construct and simulate a create_committee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a reusable committee with an admin, member set, threshold, and time-lock delay.
   * The named `admin` must authorise creation (#304): without this gate anyone could
   * create a committee claiming any address as its admin, consuming sequential ids and
   * filling instance storage at zero cost beyond fees.
   */
  create_committee: ({admin, members, threshold, rotation_delay}: {admin: string, members: Array<string>, threshold: u32, rotation_delay: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a execute_rotation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionlessly executes a matured rotation for a committee, bumping its epoch.
   */
  execute_rotation: ({committee_id}: {committee_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a finalize_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settles the pending proposal once its dispute window has elapsed:
   * `Yes`/`No` resolve the market, `Invalid` voids it (and emits
   * `CommitteeVoided`). market-core's `void_market` has no `close_time`
   * guard, but every attestation path requires `now >= close_time` before
   * any write, so no proposal (and no void) can exist before close.
   */
  finalize_signers: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AttestedOutcome>>>

  /**
   * Construct and simulate a guardian_options transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the guardian reason codes valid for `market_id` right now.
   */
  guardian_options: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<GuardianReason>>>

  /**
   * Construct and simulate a propose_rotation transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Proposes a new member set and threshold for a committee, executable after rotation_delay.
   */
  propose_rotation: ({committee_id, members, threshold}: {committee_id: u64, members: Array<string>, threshold: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a register_spec_v2 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals a rule committed to through a [`ResolutionSpecV2`] envelope.
   * The envelope must name this network and this resolver's market-core
   * (`DomainMismatch`), use a non-zero salt and the current `version`
   * (`InvalidConfig`), and hash to the market's commitment
   * (`SpecHashMismatch`). The inner rule is then validated and stored
   * exactly as the legacy entrypoints do.
   */
  register_spec_v2: ({market_id, spec}: {market_id: u64, spec: ResolutionSpecV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_bounty_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #149: records the token that resolution bounties are escrowed in. It
   * must be market-core's collateral token, so bounties and market
   * collateral share one asset. Because the only accepted value is the
   * collateral address, this setter cannot repoint existing escrow at a
   * different token, and no entrypoint lets an admin withdraw escrow.
   */
  set_bounty_token: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a escalation_attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Committee escalation: each member votes once; the first verdict to
   * gather `k` votes settles the dispute.
   */
  escalation_attest: ({market_id, member, verdict}: {market_id: u64, member: string, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_price_for transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #149: [`Resolver::resolve_price`] that pays the market's bounty to
   * `caller`. The payout happens in the same invocation that makes the
   * market final, so a call that fails also pays nothing.
   */
  resolve_price_for: ({caller, market_id}: {caller: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a submit_signatures transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Counts Ed25519 signatures from a weighted committee. Permissionless: the
   * signatures, not the submitter, carry the authority. Each signature is
   * over the message built by `attestation_message`; non-members and keys
   * that already signed this round (for either outcome) are skipped, and a
   * single invalid signature aborts the whole batch, so submitters should
   * pre-filter with a verifier. Once the accumulated weight for `outcome`
   * first reaches the threshold a proposal is recorded and the dispute
   * window starts; later calls never move it.
   */
  submit_signatures: ({market_id, outcome, round, sigs}: {market_id: u64, outcome: Outcome, round: u32, sigs: Array<readonly [Buffer, Buffer]>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_dispute_bond transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays a settled dispute's bond to its payee (the disputer, or the
   * market-core treasury when the proposal was upheld). Permissionless.
   */
  claim_dispute_bond: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_twap_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals a time-weighted-average price rule committed to as
   * `sha256(TWAP_SPEC_DOMAIN || XDR(TwapConfig))` (issue #27). Same
   * commit/reveal flow as [`register_scaled_price_spec`], with two
   * differences. First, the static validation
   * ([`validate_twap_rule`]): `window > 0`, `min_samples >= 2`,
   * `max_gap` in `(0, window]`, `threshold >= 0`. Second, feasibility is
   * checked *against the live feed*: the grid period only exists
   * on-chain, so registration calls `resolution()` on the configured
   * reflector and rejects `window / resolution > MAX_TWAP_SAMPLES` or
   * `min_samples > window / resolution` with `InvalidConfig`. This makes
   * the reflector required reachable at registration (a trapping feed
   * gives `PriceUnavailable`) — deliberate: an unresolvable TWAP market
   * is caught at reveal time, not at close.
   */
  register_twap_spec: ({market_id, spec}: {market_id: u64, spec: TwapConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pin_committee_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #297: Permissionlessly pins the committee epoch for a market to the
   * epoch in force at `close_time`. Can be called by keepers right after
   * close, before any rotation lands. Idempotent: if already pinned, the
   * existing pin is kept. Must not run before close_time.
   */
  pin_committee_epoch: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [u64, u32]>>>

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
   * Construct and simulate a resolution_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * When `expire_market` becomes callable for `market_id`: `close_time` plus
   * [`RESOLUTION_GRACE_SECS`]. Needs only market-core's `close_time`, so it
   * is known before (and without) a spec reveal, for either market kind.
   */
  resolution_deadline: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a set_evidence_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the reasoning registry contract address and evidence policy (admin only).
   */
  set_evidence_config: ({registry, policy}: {registry: string, policy: EvidencePolicy}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a attest_with_evidence transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attests to an outcome backed by an on-chain reasoning trace in reasoning-registry.
   */
  attest_with_evidence: ({market_id, signer, outcome, trace_id}: {market_id: u64, signer: string, outcome: AttestedOutcome, trace_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a committee_members_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #297: View returning the members and threshold for a committee at a
   * specific epoch, from the `MemberAt` snapshot.
   */
  committee_members_at: ({committee_id, epoch}: {committee_id: u64, epoch: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [Array<string>, u32]>>>

  /**
   * Construct and simulate a finalize_signers_for transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #149: [`Resolver::finalize_signers`] that pays the market's bounty to
   * `caller`, with the same single-invocation guarantee as
   * [`Resolver::resolve_price_for`].
   */
  finalize_signers_for: ({caller, market_id}: {caller: string, market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AttestedOutcome>>>

  /**
   * Construct and simulate a guardian_void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: voids a market subject to verified on-chain reason codes and grace periods.
   */
  guardian_void_market: ({market_id, reason}: {market_id: u64, reason: GuardianReason}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_hybrid_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Registers a hybrid resolution specification (price feed with attested fallback).
   */
  register_hybrid_spec: ({market_id, spec}: {market_id: u64, spec: HybridConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_scalar_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, scalar mode:
   * the market settles fractionally from the feed price clamped into
   * `[lower, upper]` (see `resolve_scalar_price`).
   */
  register_scalar_spec: ({market_id, spec}: {market_id: u64, spec: ScalarPriceConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_signer_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, signer mode.
   */
  register_signer_spec: ({market_id, spec}: {market_id: u64, spec: SignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_scalar_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Resolves a scalar market from its Reflector feed. The reading is
   * clamped into the committed `[lower, upper]` range and settled as the
   * fractional LONG payout `(clamped - lower) / (upper - lower)` in bps
   * (SHORT pays the complement). Returns the payout.
   * 
   * A non-positive reading is `InvalidPrice` rather than a clamp: it means
   * the feed is broken, not that the value sits at the bottom of the
   * range. Same close-time, staleness and terminal-state rules as
   * `resolve_price`.
   */
  resolve_scalar_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a cancel_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cancel_admin_transfer: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a market_committee_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * #297: View returning the pinned (committee_id, epoch) for a market, or
   * `None` if not yet pinned.
   */
  market_committee_epoch: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [u64, u32]>>>

  /**
   * Construct and simulate a accept_market_core_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_market_core_role: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a register_committee_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Registers a reusable committee specification for `market_id`.
   */
  register_committee_spec: ({market_id, spec}: {market_id: u64, spec: CommitteeRef}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_hybrid_v2_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Registers a hybrid V2 resolution specification (price feed with richer fallback).
   * 
   * Unlike `register_hybrid_spec`, the fallback can be a committee or a
   * weighted-key group, not only bare signers (issue #314).
   */
  register_hybrid_v2_spec: ({market_id, spec}: {market_id: u64, spec: HybridConfigV2}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_cat_signer_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, categorical
   * outcome-index committee. Only meaningful for markets whose
   * `resolution_hash` commits to `ResolutionSpec::CategoricalSigners` with
   * this exact `outcome_count`; the reveal target's `resolution_hash` is
   * read from whichever market kind owns the id.
   */
  register_cat_signer_spec: ({market_id, spec}: {market_id: u64, spec: CatSignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_disputable_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, signer mode whose
   * proposals can be challenged with a bond (see `dispute`).
   */
  register_disputable_spec: ({market_id, spec}: {market_id: u64, spec: DisputableSignerConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_scaled_price_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveals a decimal-explicit price rule committed to as
   * `sha256(SCALED_SPEC_DOMAIN || XDR(ScaledPriceConfig))` (issue #26).
   * Same commit/reveal flow as [`register_price_spec`];
   * `threshold_decimals` above [`MAX_THRESHOLD_DECIMALS`] is
   * `InvalidConfig` (no `i128` scale factor exists that large). The
   * preimage is its own domain-tagged space rather than a
   * `ResolutionSpec` variant because PR #176 moved that enum to
   * `oracledesk-types` (edited only via maintainer follow-up; see ADR
   * 0001) — every existing `Price` / `Signers` / V2 commitment stays
   * byte-for-byte valid either way.
   */
  register_scaled_price_spec: ({market_id, spec}: {market_id: u64, spec: ScaledPriceConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_weighted_key_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, weighted Ed25519
   * committee that signs off-chain and is verified by `submit_signatures`.
   */
  register_weighted_key_spec: ({market_id, spec}: {market_id: u64, spec: WeightedKeyConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a consent_market_resolver_migrate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Consent to migrate one market from this resolver to a newly wired resolver.
   * The market-core migration only succeeds while this resolver's address
   * authorizes the market-core call, so this entrypoint provides governance
   * acknowledgement from the resolver admin.
   */
  consent_market_resolver_migrate: ({market_id, new_resolver}: {market_id: u64, new_resolver: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
        "AAAAAQAAAAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAABQAAAAAAAAAAAAAAEEFkbWluVHJhbnNmZXJyZWQAAAABAAAAEWFkbWluX3RyYW5zZmVycmVkAAAAAAAAAgAAAAAAAAADb2xkAAAAABMAAAAAAAAAAAAAAANuZXcAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFUFkbWluVHJhbnNmZXJQcm9wb3NlZAAAAAAAAAEAAAAXYWRtaW5fdHJhbnNmZXJfcHJvcG9zZWQAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFkFkbWluVHJhbnNmZXJDYW5jZWxsZWQAAAAAAAEAAAAYYWRtaW5fdHJhbnNmZXJfY2FuY2VsbGVkAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAPwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAABdNYXJrZXRBbHJlYWR5Q29uZmlndXJlZAAAAAAEAAAAAAAAABNNYXJrZXROb3RDb25maWd1cmVkAAAAAAUAAAAAAAAACVdyb25nTW9kZQAAAAAAAAYAAAAAAAAAD01hcmtldE5vdENsb3NlZAAAAAAHAAAAAAAAABBQcmljZVVuYXZhaWxhYmxlAAAACAAAAAAAAAAKU3RhbGVQcmljZQAAAAAACQAAAAAAAAAMSW52YWxpZFByaWNlAAAACgAAAAAAAAAJTm90U2lnbmVyAAAAAAAACwAAAAAAAAAPQWxyZWFkeUF0dGVzdGVkAAAAAAwAAAAAAAAAE1RocmVzaG9sZE5vdFJlYWNoZWQAAAAADQAAAAAAAAANRGlzcHV0ZUFjdGl2ZQAAAAAAAA4AAAAAAAAAEURpc3B1dGVXaW5kb3dPcGVuAAAAAAAADwAAAAAAAAAKTm9Qcm9wb3NhbAAAAAAAEAAAAAAAAAAQQWxyZWFkeUZpbmFsaXplZAAAABEAAAAAAAAAEFNwZWNIYXNoTWlzbWF0Y2gAAAASAAAAAAAAABJEZWFkbGluZU5vdFJlYWNoZWQAAAAAABMAAAAAAAAAE1Jlc29sdXRpb25BdmFpbGFibGUAAAAAFAAAAAAAAAAORG9tYWluTWlzbWF0Y2gAAAAAABUAAAAAAAAAClN0YWxlUm91bmQAAAAAABYAAAAAAAAAEVRvb01hbnlTaWduYXR1cmVzAAAAAAAAFwAAAAAAAAATRGlzcHV0ZVdpbmRvd0Nsb3NlZAAAAAAYAAAAAAAAAAlOb0Rpc3B1dGUAAAAAAAAZAAAAAAAAABFDb21taXR0ZWVOb3RGb3VuZAAAAAAAABoAAAAAAAAAD1JvdGF0aW9uUGVuZGluZwAAAAAbAAAAAAAAABBSb3RhdGlvbk5vdFJlYWR5AAAAHAAAAAAAAAAVUm90YXRpb25Cb3VuZEV4Y2VlZGVkAAAAAAAAHQAAAAAAAAAPRHVwbGljYXRlTWVtYmVyAAAAAB4AAAAAAAAAEUNvbW1pdHRlZVRvb0xhcmdlAAAAAAAAHwAAAAAAAAAQRXZpZGVuY2VEaXNhYmxlZAAAACAAAAAAAAAAEEV2aWRlbmNlUmVxdWlyZWQAAAAhAAAAAAAAABBFdmlkZW5jZU5vdEZvdW5kAAAAIgAAAAAAAAAWRXZpZGVuY2VBdXRob3JNaXNtYXRjaAAAAAAAIwAAAAAAAAAWRXZpZGVuY2VNYXJrZXRNaXNtYXRjaAAAAAAAJAAAAAAAAAAQRXZpZGVuY2VUb29FYXJseQAAACUAAAAAAAAAE0V2aWRlbmNlQWxyZWFkeVVzZWQAAAAAJgAAAAAAAAASR3VhcmRpYW5Ob3RBbGxvd2VkAAAAAAAnAAAAAAAAAA5Ub29NYW55Q2FuY2VscwAAAAAAKAAAAAAAAAAOU25hcHNob3RFeGlzdHMAAAAAACkAAABEYGFjY2VwdF9hZG1pbmAvYGNhbmNlbF9hZG1pbl90cmFuc2ZlcmAgY2FsbGVkIHdpdGggbm90aGluZyBwcm9wb3NlZC4AAAAOTm9QZW5kaW5nQWRtaW4AAAAAACoAAABDQSBwcm9wb3NlZCBhZG1pbiBoYW5kb3ZlciB3YXMgbm90IGFjY2VwdGVkIHdpdGhpbiBpdHMgYGV4cGlyZXNfYXRgLgAAAAATUGVuZGluZ0FkbWluRXhwaXJlZAAAAAArAAAANyMxNDk6IGEgYm91bnR5IG9wZXJhdGlvbiByYW4gYmVmb3JlIGBzZXRfYm91bnR5X3Rva2VuYC4AAAAAEUJvdW50eVRva2VuTm90U2V0AAAAAAAALAAAACYjMTQ5OiBib3VudHkgYW1vdW50cyBtdXN0IGJlIHBvc2l0aXZlLgAAAAAADUludmFsaWRCb3VudHkAAAAAAAAtAAAAQCMxNDk6IGJvdW50aWVzIGFyZSBmdW5kZWQgb25seSBiZWZvcmUgdGhlIG1hcmtldCdzIGBjbG9zZV90aW1lYC4AAAATQm91bnR5RnVuZGluZ0Nsb3NlZAAAAAAuAAAAXyMxNDk6IGEgbWFya2V0J3MgZXNjcm93IGhhcyBvbmUgZnVuZGVyOyBhbnkgb3RoZXIgYWRkcmVzcyBjYW4gbmVpdGhlcgp0b3AgaXQgdXAgbm9yIHJlY2xhaW0gaXQuAAAAABRCb3VudHlGdW5kZXJNaXNtYXRjaAAAAC8AAAArIzE0OTogbm8gYm91bnR5IHdhcyBmdW5kZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAITm9Cb3VudHkAAAAwAAAAPiMxNDk6IGEgYm91bnR5IGNhbiBiZSByZWNsYWltZWQgb25seSBvbmNlIHRoZSBtYXJrZXQgaXMgZmluYWwuAAAAAAAOQm91bnR5Tm90RmluYWwAAAAAADEAAACBYGF0dGVzdF9jYXRgIG91dGNvbWUgaW5kZXggbm90IGJlbG93IHRoZSBjb21taXR0ZWQgYG91dGNvbWVfY291bnRgLgpSZW51bWJlcmVkIGFmdGVyIGRldmVsb3AncyAjMTQ5IGJvdW50eSBjb2RlcyBjbGFpbWVkIDQ0Li49NDkuAAAAAAAAE0ludmFsaWRPdXRjb21lSW5kZXgAAAAAMgAAAAAAAAAYTWFya2V0Q29yZU1hcmtldE5vdEZvdW5kAAAEFAAAAAAAAAASTWFya2V0Q29yZU5vdEZpbmFsAAAAAAQVAAAAAAAAABdNYXJrZXRDb3JlTWFya2V0Tm90T3BlbgAAAAQWAAAAAAAAABZNYXJrZXRDb3JlTWFya2V0Q2xvc2VkAAAAAAQXAAAAAAAAAB9NYXJrZXRDb3JlSW5zdWZmaWNpZW50TGlxdWlkaXR5AAAABBgAAAAAAAAAHE1hcmtldENvcmVJbnN1ZmZpY2llbnRTaGFyZXMAAAQZAAAAAAAAABhNYXJrZXRDb3JlQWxyZWFkeUNsYWltZWQAAAQaAAAAAAAAABlNYXJrZXRDb3JlTm90aGluZ1RvUmVkZWVtAAAAAAAEGwAAAAAAAAAXTWFya2V0Q29yZUludmFsaWRBbW91bnQAAAAEHAAAAAAAAAASTWFya2V0Q29yZU92ZXJmbG93AAAAAAQdAAAAAAAAABpNYXJrZXRDb3JlU2xpcHBhZ2VFeGNlZWRlZAAAAAAEHgAAAAAAAAAUTWFya2V0Q29yZUNhbGxGYWlsZWQAAAQfAAAAAAAAABJSZWdpc3RyeUNhbGxGYWlsZWQAAAAABCA=",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+kAAAATAAAAAw==",
        "AAAAAAAAAKBQdXJlIHZpZXc6IG5vIFRUTCBleHRlbnNpb25zLiBUaGUgaW5zdGFuY2UgYW5kIHRoZSBtYXJrZXQncyBlbnRyaWVzCmFyZSBrZXB0IGFsaXZlIGJ5IHRoZSBtdXRhdGluZyBlbnRyeXBvaW50cyBhYm92ZSwgc28gYSB2aWV3LW9ubHkKc2ltdWxhdGlvbiBzdGF5cyByZWFkLW9ubHkuAAAABXN0YXRlAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAfQAAAAD1Jlc29sdXRpb25TdGF0ZQA=",
        "AAAAAgAAAD5UaGUgZXNjYWxhdGlvbiBhdXRob3JpdHkncyBydWxpbmcuIGBJbnZhbGlkYCB2b2lkcyB0aGUgbWFya2V0LgAAAAAAAAAAAAdWZXJkaWN0AAAAAAMAAAAAAAAAAAAAAANZZXMAAAAAAAAAAAAAAAACTm8AAAAAAAAAAAAAAAAAB0ludmFsaWQA",
        "AAAAAAAAAy1SZWNvcmRzIGBzaWduZXJgJ3Mgdm90ZSBmb3IgYG91dGNvbWVgIChhbGxvd2VkIG9ubHkgb25jZSBgY2xvc2VfdGltZWAKaGFzIHBhc3NlZCkuIGBJbnZhbGlkYCBjbGFpbXMgdGhlIHF1ZXN0aW9uIGlzIHVuYW5zd2VyYWJsZTsgYW4KYEludmFsaWRgIHByb3Bvc2FsIGZpbmFsaXplcyBieSB2b2lkaW5nIHRoZSBtYXJrZXQuCgpTcGxpdCB2b3RlczogZXZlcnkgb3V0Y29tZSwgYEludmFsaWRgIGluY2x1ZGVkLCBoYXMgaXRzIG93biBjb3VudGVyLAphbmQgYSBzaWduZXIgaXMgZGVkdXBsaWNhdGVkIHBlciBgKG91dGNvbWUsIHNpZ25lcilgLCBzbyBvbmUgc2lnbmVyIG1heQphdHRlc3Qgc2V2ZXJhbCBvdXRjb21lcyAoZXhpc3RpbmcgYmVoYXZpb3VyLCBleHRlbmRlZCB0byBgSW52YWxpZGApLgpUaGUgZmlyc3Qgb3V0Y29tZSB0byByZWFjaCB0aHJlc2hvbGQgYmVjb21lcyB0aGUgcHJvcG9zYWwgYW5kIGxhdGVyCmBZZXNgL2BOb2AgcXVvcnVtcyBuZXZlciBtb3ZlIGl0LiBUaGUgb25lIGV4Y2VwdGlvbjogYEludmFsaWRgIHJlYWNoaW5nCnRocmVzaG9sZCByZXBsYWNlcyBhIHBlbmRpbmcgYFllc2AvYE5vYCBwcm9wb3NhbCBhbmQgcmVzdGFydHMgdGhlCmRpc3B1dGUgd2luZG93LCBiZWNhdXNlIGEgcXVvcnVtIHNheWluZyB0aGUgcXVlc3Rpb24gY2Fubm90IGJlCmFuc3dlcmVkIG91dHJhbmtzIGFuIGFuc3dlciB0byBpdC4gQW4gYEludmFsaWRgIHByb3Bvc2FsIGlzIG5ldmVyCnJlcGxhY2VkLiAoUmVxdWlyaW5nIGBJbnZhbGlkYCB0byBiZWF0IGV2ZXJ5IG90aGVyIGNvdW50IGlzIGEgcG9zc2libGUKZm9sbG93LXVwLikAAAAAAAAGYXR0ZXN0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAAB291dGNvbWUAAAAH0AAAAA9BdHRlc3RlZE91dGNvbWUAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAgAAAAAAAAAAAAAACFJ1bGVLaW5kAAAACwAAAAAAAAAAAAAABVByaWNlAAAAAAAAAAAAAAAAAAAHU2lnbmVycwAAAAAAAAAAAAAAAAxXZWlnaHRlZEtleXMAAAAAAAAAAAAAABFTaWduZXJzRGlzcHV0YWJsZQAAAAAAAAAAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAAAAAAAAAAABkh5YnJpZAAAAAAAAAAAAAAAAAALU2NhbGVkUHJpY2UAAAAAAAAAAAAAAAAEVHdhcAAAAAAAAACHQXBwZW5kZWQgbGFzdDogYFJ1bGVLaW5kYCBjcm9zc2VzIHRoZSByZXNvbHZlcuKGknRyZWFzdXJ5L3JvdXRlciBib3VuZGFyeSwKc28gbmV3IHZhcmlhbnRzIG11c3Qga2VlcCB0aGUgZXhpc3RpbmcgZGlzY3JpbWluYW50cyBzdGFibGUuAAAAABJDYXRlZ29yaWNhbFNpZ25lcnMAAAAAAAAAAAAAAAAABlNjYWxhcgAAAAAAAAAAAAAAAAAISHlicmlkVjI=",
        "AAAAAgAAATtXaGljaCBraW5kIG9mIHJlc29sdXRpb24gcnVsZSBhIG1hcmtldCBoYXMgKnJldmVhbGVkKiwgYXMgcmVhZCBieQpbYFJlc29sdmVyOjpzcGVjX2tpbmRgXS4gYFJlc29sdXRpb25TdGF0ZWAgY2Fubm90IHRlbGwgInJldmVhbGVkIiBmcm9tICJub3QKcmV2ZWFsZWQiOiBhIHJldmVhbGVkIHByaWNlIG9yIHNpZ25lciBtYXJrZXQgc3RpbGwgcmVhZHMgYFVuY29uZmlndXJlZGAKdW50aWwgaXQgaXMgZmluYWxpemVkLCBkaXNwdXRlZCBvciByZXNldCwgc28gdGhlIGtpbmQgaXMgZGVyaXZlZCBmcm9tIHdoaWNoCnNwZWMgZW50cnkgZXhpc3RzICgjMjczKS4AAAAAAAAAAAhTcGVjS2luZAAAAAoAAAAAAAAAKk5vIHNwZWMgaGFzIGJlZW4gcmV2ZWFsZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAABE5vbmUAAAAAAAAAAAAAAAVQcmljZQAAAAAAAAAAAAAAAAAAC1NjYWxlZFByaWNlAAAAAAAAAAAAAAAABFR3YXAAAAAAAAAAAAAAAAdTaWduZXJzAAAAAAAAAAAAAAAACkRpc3B1dGFibGUAAAAAAAAAAAAAAAAADFdlaWdodGVkS2V5cwAAAAAAAAAAAAAACUNvbW1pdHRlZQAAAAAAAAAAAABIQSBoeWJyaWQgcHJpY2UtdGhlbi1zaWduZXJzIG1hcmtldCwgYmVmb3JlIGFuZCBhZnRlciBpdHMgZmFsbGJhY2sgb3BlbnMuAAAABkh5YnJpZAAAAAAAAAAAAEVFeHRlbmRlZCBoeWJyaWQgd2l0aCBjb21taXR0ZWUgb3Igd2VpZ2h0ZWQta2V5IGZhbGxiYWNrIChpc3N1ZSAjMzE0KS4AAAAAAAAISHlicmlkVjI=",
        "AAAAAAAAAmBDaGFsbGVuZ2VzIHRoZSBjdXJyZW50IHByb3Bvc2FsIG9mIGEgYFNpZ25lcnNEaXNwdXRhYmxlYCBtYXJrZXQgd2hpbGUKaXRzIGRpc3B1dGUgd2luZG93IGlzIHN0aWxsIG9wZW4gKHN0cmljdGx5IGJlZm9yZSBgcHJvcG9zZWRfYXQgKwpkaXNwdXRlX3dpbmRvd2AsIHRoZSBpbnN0YW50IGBmaW5hbGl6ZV9zaWduZXJzYCBiZWNvbWVzIGNhbGxhYmxlKS4gVGhlCmRpc3B1dGVyIGVzY3Jvd3MgYGRpc3B1dGVfYm9uZGAgb2YgdGhlIGNvbGxhdGVyYWwgdG9rZW4sIHdoaWNoIGZyZWV6ZXMKZmluYWxpemF0aW9uIHVudGlsIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBydWxlcyBvcgpgZXNjYWxhdGlvbl90aW1lb3V0YCBsYXBzZXMuIGBhbHRlcm5hdGl2ZWAgaXMgdGhlIG91dGNvbWUgdGhlIGRpc3B1dGVyCmNsYWltcyBpcyBjb3JyZWN0IChgTm9uZWA6IHRoZSBtYXJrZXQgaXMgaW52YWxpZCk7IGl0IG9ubHkgaW5mb3JtcyB0aGUKcnVsaW5nIGFuZCBtdXN0IGRpZmZlciBmcm9tIHRoZSBwcm9wb3NhbCAoc28gYE5vbmVgIGlzIHJlamVjdGVkIGZvciBhbgpgSW52YWxpZGAgcHJvcG9zYWwpLiBUaGUgZGlzcHV0ZXIgbWF5IGFsc28gYmUgYSBwcm9wb3Npbmcgc2lnbmVyLgAAAAdkaXNwdXRlAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAALYWx0ZXJuYXRpdmUAAAAD6AAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAACEF0dGVzdGVkAAAAAQAAAAhhdHRlc3RlZAAAAAUAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAZzaWduZXIAAAAAABMAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAPQXR0ZXN0ZWRPdXRjb21lAAAAAAAAAAAAAAAACHRyYWNlX2lkAAAD6AAAAAYAAAAAAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACERpc3B1dGVkAAAAAQAAAAhkaXNwdXRlZAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAARib25kAAAACwAAAAAAAABJV2hhdCB0aGUgZGlzcHV0ZXIgY2xhaW1zIGlzIGNvcnJlY3Q7IGBOb25lYCBjbGFpbXMgdGhlIG1hcmtldCBpcyBpbnZhbGlkLgAAAAAAAAthbHRlcm5hdGl2ZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAAAQAAAEhSZXVzYWJsZSBjb21taXR0ZWUgbWFuYWdlZCBieSBhbiBhZG1pbiB1bmRlciB0aW1lLWxvY2tlZCByb3RhdGlvbiBydWxlcy4AAAAAAAAACUNvbW1pdHRlZQAAAAAAAAUAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFZXBvY2gAAAAAAAAEAAAAAAAAAAdtZW1iZXJzAAAAA+oAAAATAAAAAAAAAA5yb3RhdGlvbl9kZWxheQAAAAAABgAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAAAAAAAC1UaGUgcHJpY2UgcGlubmVkIGJ5IGBzbmFwc2hvdF9wcmljZWAsIGlmIGFueS4AAAAAAAAIc25hcHNob3QAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+gAAAfQAAAADVByaWNlU25hcHNob3QAAAA=",
        "AAAAAgAAADZXaGljaCByZXNvbHV0aW9uIHBhdGggYSBtYXJrZXQgd2FzIG9uIHdoZW4gaXQgZXhwaXJlZC4AAAAAAAAAAAAKRXhwaXJ5TW9kZQAAAAAABAAAAAAAAAAAAAAAClVucmV2ZWFsZWQAAAAAAAAAAAAAAAAABVByaWNlAAAAAAAAAAAAAAAAAAAHU2lnbmVycwAAAAAAAAAAKVNjYWxhciBjb3VudGVycGFydCBvZiBgUHJpY2VgIChhcHBlbmRlZCkuAAAAAAAABlNjYWxhcgAA",
        "AAAAAQAABABUaW1lLXdlaWdodGVkLWF2ZXJhZ2UgcHJpY2UgcnVsZSAoaXNzdWUgIzI3KS4gVGhlIG1hcmtldCBzZXR0bGVzIG9uIHRoZQphdmVyYWdlIG9mIHRoZSBmZWVkJ3MgcmVjb3JkcyBvdmVyIGEgd2luZG93IGVuZGluZyBhdCBgY2xvc2VfdGltZWAKaW5zdGVhZCBvZiBhIHNpbmdsZSBwcmludDogYSBtYW5pcHVsYXRlZCBvciBhbm9tYWxvdXMgY2xvc2UgcmVjb3JkIGNhbiBubwpsb25nZXIgZGVjaWRlIHRoZSBtYXJrZXQgb24gaXRzIG93bi4gTGlrZSB0aGUgbGVnYWN5IFtgUHJpY2VDb25maWdgXSAoYW5kCnVubGlrZSBbYFNjYWxlZFByaWNlQ29uZmlnYF0sIGlzc3VlICMyNikgdGhlIGB0aHJlc2hvbGRgIGlzIGluCmZlZWQtbmF0aXZlIHVuaXRzIOKAlCB0aGUgVFdBUCBpcyBhIHJhdy1wcmljZSBhdmVyYWdlIOKAlCBhbmQgdGhlIGNvbW1pdHRlZApjb21wYXJpc29uIGFwcGxpZXMgdG8gdGhlIGZsb29yZWQgYXZlcmFnZSAoc2VlIGB0d2FwX291dGNvbWVgIGFuZCBBRFIKMDAwMSkuIGBtaW5fc2FtcGxlc2AvYG1heF9nYXBgIGVuY29kZSBob3cgbXVjaCBvZiB0aGUgd2luZG93IHRoZSBmZWVkCm11c3QgYWN0dWFsbHkgaGF2ZSBmaWxsZWQ6IHJlc29sdXRpb24gaXMgcmVqZWN0ZWQgKGBTdGFsZVByaWNlYCkgYmVsb3cKYG1pbl9zYW1wbGVzYCBwcmVzZW50IHJlY29yZHMgb3Igd2hlbiBhbnkgZ2FwIOKAlCB3aW5kb3cgc3RhcnQgdG8gZmlyc3QKc2FtcGxlLCBjb25zZWN1dGl2ZSBzYW1wbGVzLCBvciBsYXN0IHNhbXBsZSB0byBgY2xvc2VfdGltZWAg4oCUIGV4Y2VlZHMKYG1heF9nYXBgLgoKU2FtZSBjYW5vbmljYWwtaG9tZSBub3RlIGFzIFtgU2NhbGVkUHJpY2VDb25maWdgXTogdGhpcyBpcyBhCnJlc29sdmVyLWxvY2FsIHR5cGUgY29tbWl0dGluZyB0aHJvdWdoIGEgZG9tYWluLXRhZ2dlZCBwcmVpbWFnZQooW2B0d2FwX3NwZWNfaGFzaGBdKSBiZWNhdXNlIFBSICMxNzYgZnJvemUgYG9yYWNsZWRlc2stdHlwZXNgJwpgUmVzb2x1dGlvblNwZWNgIGFzIHRoZSBzaGFyZWQgZW51bSByb3V0ZXIgAAAAAAAAAApUd2FwQ29uZmlnAAAAAAAHAAAAAAAAAAVhc3NldAAAAAAAB9AAAAALT3JhY2xlQXNzZXQAAAAAAAAAAAlkaXJlY3Rpb24AAAAAAAfQAAAADlByaWNlRGlyZWN0aW9uAAAAAAAAAAAAB21heF9nYXAAAAAABgAAAAAAAAALbWluX3NhbXBsZXMAAAAABAAAAAAAAAAJcmVmbGVjdG9yAAAAAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAACwAAAAAAAAAGd2luZG93AAAAAAAG",
        "AAAAAAAAAAAAAAAJcnVsZV9raW5kAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPoAAAH0AAAAAhSdWxlS2luZA==",
        "AAAAAAAAAS9XaGljaCBraW5kIG9mIHJ1bGUgYG1hcmtldF9pZGAgaGFzIHJldmVhbGVkIChgU3BlY0tpbmQ6Ok5vbmVgIGJlZm9yZSBhbnkKcmV2ZWFsKS4gRXhpc3RlbmNlIGNoZWNrcyBvbmx5IChgaGFzYCksIHNvIHRoZSByZWFkIGZvb3RwcmludCBzdGF5cwptaW5pbWFsOyBhIG1pc3Npbmcgb3IgYXJjaGl2ZWQgZW50cnkgcmVhZHMgYXMgYE5vbmVgLCBpdCBuZXZlciBwYW5pY3MuCk5lZWRlZCBiZWNhdXNlIGBzdGF0ZSgpYCBzdGF5cyBgVW5jb25maWd1cmVkYCBmb3IgYSByZXZlYWxlZCBwcmljZSBvcgpzaWduZXIgbWFya2V0ICgjMjczKS4AAAAACXNwZWNfa2luZAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAH0AAAAAhTcGVjS2luZA==",
        "AAAABQAAAEEjMTQ5OiBhIG1hcmtldCdzIGJvdW50eSB3YXMgcGFpZCB0byB0aGUgY2FsbGVyIHRoYXQgZmluYWxpemVkIGl0LgAAAAAAAAAAAAAKQm91bnR5UGFpZAAAAAAAAQAAAAtib3VudHlfcGFpZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAGFFdmVyeXRoaW5nIHRoZSB0cmVhc3VyeSdzIHByZS10cmFkZSByZXNvbHZhYmlsaXR5IGNoZWNrIG5lZWRzLCBpbiBvbmUKY3Jvc3MtY29udHJhY3QgY2FsbCAoIzI3MykuAAAAAAAAAAAAAAtUcmFkZVN0YXR1cwAAAAAFAAAAGW1hcmtldC1jb3JlIGBjbG9zZV90aW1lYC4AAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAExgY2xvc2VfdGltZSArIFJFU09MVVRJT05fR1JBQ0VfU0VDU2A6IHdoZW4gYGV4cGlyZV9tYXJrZXRgIGJlY29tZXMgY2FsbGFibGUuAAAACGRlYWRsaW5lAAAABgAAAD5BIHNpZ25lciBwcm9wb3NhbCBpcyBwZW5kaW5nIChpdHMgZGlzcHV0ZSB3aW5kb3cgbWF5IGJlIG9wZW4pLgAAAAAADW9wZW5fcHJvcG9zYWwAAAAAAAABAAAAAAAAAARzcGVjAAAH0AAAAAhTcGVjS2luZAAAAAAAAAAFc3RhdGUAAAAAAAfQAAAAD1Jlc29sdXRpb25TdGF0ZQA=",
        "AAAAAAAAARBDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgYXR0ZXN0YDogYHNpZ25lcmAgYXR0ZXN0cyB0aGF0CmBvdXRjb21lX2luZGV4YCBpcyB0aGUgd2lubmVyLiBgb3V0Y29tZV9pbmRleGAgbXVzdCBiZSBiZWxvdyB0aGUKYG91dGNvbWVfY291bnRgIHRoZSBtYXJrZXQncyBjb21taXRtZW50IGZpeGVkLiBPbmNlIGB0aHJlc2hvbGRgCm1lbWJlcnMgaGF2ZSBhdHRlc3RlZCBhbiBpbmRleCBpdCBiZWNvbWVzIHRoZSBwcm9wb3NhbCBhbmQgdGhlCmRpc3B1dGUgd2luZG93IG9wZW5zLgAAAAphdHRlc3RfY2F0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAADW91dGNvbWVfaW5kZXgAAAAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAQAAAERBIHByb3Bvc2VkIGFkbWluIGhhbmRvdmVyICgjNjIpLiBBYnNlbnQgd2hlbiBubyB0cmFuc2ZlciBpcyBwZW5kaW5nLgAAAAAAAAAMUGVuZGluZ0FkbWluAAAAAgAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAG",
        "AAAAAAAAADdSZWFkcyB0aGUgZXZpZGVuY2UgY2l0YXRpb24gYXQgYGluZGV4YCBmb3IgYG1hcmtldF9pZGAuAAAAAAtldmlkZW5jZV9hdAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAVpbmRleAAAAAAAAAQAAAABAAAD6QAAB9AAAAATQXR0ZXN0YXRpb25FdmlkZW5jZQAAAAAD",
        "AAAAAAAAANIjMTQ5OiBlc2Nyb3dzIGBhbW91bnRgIG9mIHRoZSBib3VudHkgdG9rZW4gZm9yIGBtYXJrZXRfaWRgLiBBbnlvbmUgbWF5CmZ1bmQgYSBtYXJrZXQgYmVmb3JlIGl0cyBgY2xvc2VfdGltZWAuIEFuIGVzY3JvdyBoYXMgYSBzaW5nbGUgZnVuZGVyCihyZWZ1bmRzIGdvIGJhY2sgdG8gaXQpLCBzbyBhIHRvcC11cCBtdXN0IGNvbWUgZnJvbSB0aGF0IHNhbWUgYWRkcmVzcy4AAAAAAAtmdW5kX2JvdW50eQAAAAADAAAAAAAAAAZmdW5kZXIAAAAAABMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAALbWFya2V0X2NvcmUAAAAAAAAAAAEAAAAT",
        "AAAABQAAAEojMTQ5OiBhIG1hcmtldCdzIGJvdW50eSB3YXMgZXNjcm93ZWQgKGB0b3RhbGAgaXMgdGhlIGVzY3JvdyBhZnRlciB0b3AtdXApLgAAAAAAAAAAAAxCb3VudHlGdW5kZWQAAAABAAAADWJvdW50eV9mdW5kZWQAAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAFdG90YWwAAAAAAAALAAAAAAAAAAI=",
        "AAAAAQAAAIdBIHByaWNlIHJlYWQgcGlubmVkIGJ5IFtgUmVzb2x2ZXI6OnNuYXBzaG90X3ByaWNlYF0gc28gcmVzb2x1dGlvbiBzdXJ2aXZlcwp0aGUgb3JhY2xlIGFnaW5nIHRoZSBgY2xvc2VfdGltZWAgcmVjb3JkIG91dCBvZiBpdHMgaGlzdG9yeS4AAAAAAAAAAA1QcmljZVNuYXBzaG90AAAAAAAAAwAAAAAAAAAEZGF0YQAAB9AAAAAJUHJpY2VEYXRhAAAAAAAAAAAAAAh0YWtlbl9hdAAAAAYAAAAAAAAACHRha2VuX2J5AAAAEw==",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEZUb3RhbCBwcm9wb3NhbCBjYW5jZWxsYXRpb25zIGV4ZWN1dGVkIGJ5IHRoZSBndWFyZGlhbiBmb3IgYG1hcmtldF9pZGAuAAAAAAAMY2FuY2VsX2NvdW50AAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAE",
        "AAAAAAAAANNDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgZmluYWxpemVfc2lnbmVyc2A6IG9uY2UgdGhlIGRpc3B1dGUgd2luZG93Cm9mIGEgcHJvcG9zYWwgaGFzIHBhc3NlZCBhbmQgaXRzIGluZGV4IHN0aWxsIGhhcyBgdGhyZXNob2xkYAphdHRlc3RhdGlvbnMsIHJlc29sdmVzIHRoZSBtYXJrZXQgaW4gbWFya2V0LWNvcmUgYW5kIHJldHVybnMgdGhlCndpbm5pbmcgaW5kZXguAAAAAAxmaW5hbGl6ZV9jYXQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAOtSZXNvbHZlcyBhIFtgVHdhcENvbmZpZ2BdIG1hcmtldCAoaXNzdWUgIzI3KS4gU2FtZSBsaWZlY3ljbGUgYXMKYHJlc29sdmVfcHJpY2VgIChjbG9zZWQsIG5vdCB0ZXJtaW5hbCksIGFuZCBtYXJrZXRzIGFscmVhZHkgcmV2ZWFsZWQKYXMgVFdBUCBhbHNvIHJlc29sdmUgdGhyb3VnaCBgcmVzb2x2ZV9wcmljZWAsIHdoaWNoIGRpc3BhdGNoZXMgaGVyZS4KTm9uLVRXQVAgbWFya2V0cyBhcmUgYFdyb25nTW9kZWAuAAAAAAxyZXNvbHZlX3R3YXAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAB091dGNvbWUAAAAAAw==",
        "AAAAAAAAAQxUaGUgc3BlYyBraW5kLCByZXNvbHV0aW9uIHN0YXRlLCBkZWFkbGluZSBhbmQgcHJvcG9zYWwgZmxhZyBpbiBvbmUgcmVhZDoKb25lIGNyb3NzLWNvbnRyYWN0IGNhbGwgZnJvbSB0aGUgdHJlYXN1cnkgaW5zdGVhZCBvZiBmb3VyLiBSZWFkcwptYXJrZXQtY29yZSdzIGBjbG9zZV90aW1lYCBvbmNlLiBBIHB1cmUgdmlldzogaXQgZG9lcyBub3QgZXh0ZW5kIGFueSBUVEwKKHNvIGEgc2ltdWxhdGlvbiBzdGF5cyByZWFkLW9ubHkpLCB1bmxpa2UgYGluc3RhbmNlX2dldGAuAAAADHRyYWRlX3N0YXR1cwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAALVHJhZGVTdGF0dXMAAAAAAw==",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldEV4cGlyZWQAAAAAAAABAAAADm1hcmtldF9leHBpcmVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAABG1vZGUAAAfQAAAACkV4cGlyeU1vZGUAAAAAAAAAAAAC",
        "AAAAAgAAAENFdmlkZW5jZSBwb2xpY3kgZ292ZXJuaW5nIHdoZXRoZXIgYXR0ZXN0YXRpb24gZXZpZGVuY2UgaXMgcmVxdWlyZWQuAAAAAAAAAAAORXZpZGVuY2VQb2xpY3kAAAAAAAMAAAAAAAAAAAAAAAhEaXNhYmxlZAAAAAAAAAAAAAAACE9wdGlvbmFsAAAAAAAAAAAAAAAIUmVxdWlyZWQ=",
        "AAAAAgAAADBSZWFzb24gY29kZSBjb25zdHJhaW5pbmcgZ3VhcmRpYW4gaW50ZXJ2ZW50aW9ucy4AAAAAAAAADkd1YXJkaWFuUmVhc29uAAAAAAAEAAAAAAAAADZQYXN0IGNsb3NlX3RpbWUgKyBSRVZFQUxfR1JBQ0VfU0VDUywgbm8gc3BlYyByZXZlYWxlZC4AAAAAAA5VbnJldmVhbGVkU3BlYwAAAAAAAAAAAFFQcmljZSBtb2RlLCBwYXN0IGNsb3NlX3RpbWUgKyBPUkFDTEVfR1JBQ0VfU0VDUywgcHJpY2UgZmVlZCB1bmF2YWlsYWJsZSBvciBzdGFsZS4AAAAAAAART3JhY2xlVW5hdmFpbGFibGUAAAAAAAAAAAAAPlNpZ25lciBtb2RlLCBwYXN0IGNsb3NlX3RpbWUgKyBTSUdORVJfR1JBQ0VfU0VDUywgbm8gcHJvcG9zYWwuAAAAAAAOU2lnbmVyc1N0YWxsZWQAAAAAAAAAAAA3UHJvcG9zYWwgZXhpc3RzIGFuZCBkaXNwdXRlIHdpbmRvdyBpcyBjdXJyZW50bHkgYWN0aXZlLgAAAAANRGlzcHV0ZVVwaGVsZAAAAA==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAA=",
        "AAAAAAAAAIFDdXJyZW50IGF0dGVzdGF0aW9uIHJvdW5kIG9mIGEgd2VpZ2h0ZWQta2V5IG1hcmtldDsgdGhlIGByb3VuZGAKYXJndW1lbnQgb2YgYHN1Ym1pdF9zaWduYXR1cmVzYCBhbmQgcGFydCBvZiBldmVyeSBzaWduZWQgbWVzc2FnZS4AAAAAAAANY3VycmVudF9yb3VuZAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABA==",
        "AAAAAAAAAfhQZXJtaXNzaW9ubGVzcyBsaXZlbmVzcyBmYWxsYmFjazogb25jZSBgcmVzb2x1dGlvbl9kZWFkbGluZWAgaGFzIHBhc3NlZCwKYW55b25lIG1heSB2b2lkIGEgbWFya2V0IHRoYXQgaXMgc3RpbGwgdW5yZXNvbHZlZCwgc28gY29sbGF0ZXJhbCBpcwpuZXZlciBsb2NrZWQgYmVoaW5kIGEgbWlzc2luZyByZXZlYWwsIGEgZGVhZCBmZWVkIG9yIHNpbGVudCBzaWduZXJzLgoKUmVzb2x1dGlvbiBpcyBwcmVmZXJyZWQgb3ZlciB2b2lkaW5nLiBBIHByaWNlIG1hcmtldCB3aG9zZSBmZWVkIGlzCnZhbGlkIHJpZ2h0IG5vdyBpcyAqcmVzb2x2ZWQqIGluc3RlYWQgKHNvIGEgc3RhbGxlZCBjYWxsZXIgY2FuIG5ldmVyCmZvcmNlIGEgdm9pZCBvbiBhIHJlc29sdmFibGUgbWFya2V0KSwgYW5kIGEgbWFya2V0IHdpdGggYSBwZW5kaW5nCnNpZ25lciBvciBjYXRlZ29yaWNhbCBwcm9wb3NhbCBpcyByZWZ1c2VkIHdpdGggYFJlc29sdXRpb25BdmFpbGFibGVgCnVudGlsIGl0IGlzIGZpbmFsaXplZC4AAAANZXhwaXJlX21hcmtldAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADJSZWFkcyBjb21taXR0ZWUgc3RhdGUgYW5kIGV4dGVuZHMgaXRzIHN0b3JhZ2UgVFRMLgAAAAAADWdldF9jb21taXR0ZWUAAAAAAAABAAAAAAAAAAxjb21taXR0ZWVfaWQAAAAGAAAAAQAAA+kAAAfQAAAACUNvbW1pdHRlZQAAAAAAAAM=",
        "AAAAAAAAAFpPcGVucyBmYWxsYmFjayBzaWduZXIgYXR0ZXN0YXRpb24gaW4gYSBoeWJyaWQgbWFya2V0IGlmIHRoZSBmZWVkIGZhaWxlZCBwYXN0IHRoZSBkZWFkbGluZS4AAAAAAA1vcGVuX2ZhbGxiYWNrAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEBUaGUgcGVuZGluZyBhZG1pbiBwcm9wb3NhbCwgaW5jbHVkaW5nIGl0cyBleHBpcnksIGlmIG9uZSBleGlzdHMuAAAADXBlbmRpbmdfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAfQAAAADFBlbmRpbmdBZG1pbg==",
        "AAAAAAAAAZRUaGUgZmVlZCdzIG5ld2VzdCBvYnNlcnZhdGlvbiAoYGxhc3RwcmljZWApIGZvciB0aGUgbWFya2V0J3MgY29tbWl0dGVkCmFzc2V0OiBhIHJlYWQtb25seSBoZWFsdGggY2hlY2sgZm9yIGtlZXBlcnMgYmVmb3JlIGNhbGxpbmcKYHJlc29sdmVfcHJpY2VgLiBSZXNvbHV0aW9uIG5ldmVyIGNvbnN1bHRzIGl0IChpc3N1ZSAjMjYpOiBhIGxpdmUKYGxhc3RwcmljZWAgY2FuIGJlIGZyZXNoZXIgdGhhbiBgY2xvc2VfdGltZWAsIGFuZCB0aGUgaGlzdG9yaWNhbCBncmlkCmxvb2t1cCBpcyB0aGUgb25seSBzZXR0bGVtZW50IHNvdXJjZS4gQSB0cmFwcGluZyBmZWVkIG9yIGEgZmVlZCB3aXRoCm5vIHJlY29yZCBpcyBgUHJpY2VVbmF2YWlsYWJsZWA7IHNpZ25lci1tb2RlIG1hcmtldHMgYXJlIGBXcm9uZ01vZGVgLgAAAA1wcmV2aWV3X3ByaWNlAAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAlQcmljZURhdGEAAAAAAAAD",
        "AAAAAAAAAJZTdGFydHMgYSB0d28tc3RlcCBoYW5kb3ZlciBvZiB0aGUgYWRtaW4gcm9sZS4gVGhlIG5ldyBhZG1pbiBtdXN0IGNhbGwKYGFjY2VwdF9hZG1pbmAgaXRzZWxmLCBzbyBhIHR5cG8gY2Fubm90IGhhbmQgY29udHJvbCB0byBhbiBhZGRyZXNzCm5vYm9keSBob2xkcy4AAAAAAA1wcm9wb3NlX2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAANcmVzb2x2ZV9wcmljZQAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAABQAAAC8jMTQ5OiBhbiB1bnBhaWQgYm91bnR5IHdlbnQgYmFjayB0byBpdHMgZnVuZGVyLgAAAAAAAAAADkJvdW50eVJlZnVuZGVkAAAAAAABAAAAD2JvdW50eV9yZWZ1bmRlZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAgBgZGlzcHV0ZXJfd29uYCBpcyB0cnVlIHdoZW4gdGhlIGJvbmQgcmV0dXJucyB0byB0aGUgZGlzcHV0ZXIgYmVjYXVzZSB0aGUKcnVsaW5nIG92ZXJ0dXJuZWQgdGhlIHByb3Bvc2FsLiBBIHRpbWVvdXQgKGBleHBpcmVfZGlzcHV0ZWApIGFsc28gcmVmdW5kcwp0aGUgYm9uZCBidXQgaXMgcmVwb3J0ZWQgYXMgYHZlcmRpY3Q6IEludmFsaWQsIGRpc3B1dGVyX3dvbjogZmFsc2VgLiBUaGF0CnBhaXIgYWxzbyBkZXNjcmliZXMgYSBydWxpbmcgb2YgYEludmFsaWRgIHRoYXQgdXBob2xkcyBhbiBgSW52YWxpZGAKcHJvcG9zYWw7IHRoZSB0d28gZGlmZmVyIGluIHRoZSBib25kJ3MgcGF5ZWUgKGRpc3B1dGVyIG9uIHRpbWVvdXQsCm1hcmtldC1jb3JlIHRyZWFzdXJ5IHdoZW4gdXBoZWxkKSwgcmVhZGFibGUgZnJvbSB0aGUgYERpc3B1dGVgIGVudHJ5CnVudGlsIGBjbGFpbV9kaXNwdXRlX2JvbmRgIHJ1bnMuIGBwYXlvdXRgIGlzIHRoZSBlc2Nyb3dlZCBib25kLCBjbGFpbWFibGUKYnkgaXRzIHBheWVlLgAAAAAAAAAORGlzcHV0ZVNldHRsZWQAAAAAAAEAAAAPZGlzcHV0ZV9zZXR0bGVkAAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAd2ZXJkaWN0AAAAB9AAAAAHVmVyZGljdAAAAAAAAAAAAAAAAAxkaXNwdXRlcl93b24AAAABAAAAAAAAAAAAAAAGcGF5b3V0AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkZhbGxiYWNrT3BlbmVkAAAAAAABAAAAD2ZhbGxiYWNrX29wZW5lZAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAAAAAACmxhc3RfZXJyb3IAAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADkd1YXJkaWFuQWN0aW9uAAAAAAABAAAAD2d1YXJkaWFuX2FjdGlvbgAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAGYWN0aW9uAAAAAAfQAAAAEkd1YXJkaWFuQWN0aW9uS2luZAAAAAAAAAAAAAAAAAAGcmVhc29uAAAAAAfQAAAADkd1YXJkaWFuUmVhc29uAAAAAAAAAAAAAAAAAAJhdAAAAAAABgAAAAAAAAAC",
        "AAAABQAAARlFbWl0dGVkIGFsb25nc2lkZSB0aGUgW2BQcmljZVJlc29sdXRpb25gXS9bYFByaWNlUmVzb2x1dGlvblYyYF0gcGFpciBmb3IKYSBbYFR3YXBDb25maWdgXSBzZXR0bGVtZW50IChpc3N1ZSAjMjcpOiB0aGUgZmxvb3JlZCB0aW1lLXdlaWdodGVkCmF2ZXJhZ2UsIGhvdyBtYW55IGdyaWQgcmVjb3JkcyBhbnN3ZXJlZCwgYW5kIHRoZSBvbGRlc3QvbmV3ZXN0IHNhbXBsZQp0aW1lc3RhbXBzLiBOZXcgZXZlbnQgdHlwZSwgc28gZXhpc3RpbmcgaW5kZXhlciBkZWNvZGVycyBhcmUgdW50b3VjaGVkLgAAAAAAAAAAAAAOVHdhcFJlc29sdXRpb24AAAAAAAEAAAAPdHdhcF9yZXNvbHV0aW9uAAAAAAYAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAR0d2FwAAAACwAAAAAAAAAAAAAAB3NhbXBsZXMAAAAABAAAAAAAAAAAAAAACGZpcnN0X3RzAAAABgAAAAAAAAAAAAAAB2xhc3RfdHMAAAAABgAAAAAAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAAAgAAATdXaGF0IGEgc2lnbmVyIGF0dGVzdHMgdG8uIFJlc29sdmVyLWxvY2FsIHNvIG1hcmtldC1jb3JlJ3MgYE91dGNvbWVgIChhbmQKdGhlIHZlbmRvcmVkIGBtYXJrZXRfY29yZS53YXNtYCkgbmV2ZXIgZ2FpbnMgYW4gYEludmFsaWRgIHZhcmlhbnQ6IGFuCmBJbnZhbGlkYCBwcm9wb3NhbCBmaW5hbGl6ZXMgdGhyb3VnaCBtYXJrZXQtY29yZSdzIGB2b2lkX21hcmtldGAgaW5zdGVhZApvZiBgcmVzb2x2ZWAuIE5ldmVyIHBhcnQgb2YgYSBgUmVzb2x1dGlvblNwZWNgLCBzbyBjb21taXRtZW50IGhhc2hlcyBhcmUKdW5hZmZlY3RlZCAoQURSIDAwMDEpLgAAAAAAAAAAD0F0dGVzdGVkT3V0Y29tZQAAAAADAAAAAAAAAAAAAAADWWVzAAAAAAAAAAAAAAAAAk5vAAAAAAAAAAAAR1RoZSBxdWVzdGlvbiBpcyBhbWJpZ3VvdXMgb3IgdW5hbnN3ZXJhYmxlOyBmaW5hbGl6aW5nIHZvaWRzIHRoZSBtYXJrZXQuAAAAAAdJbnZhbGlkAA==",
        "AAAAAgAAAAAAAAAAAAAAD1Jlc29sdXRpb25TdGF0ZQAAAAAHAAAAAAAAAAAAAAAMVW5jb25maWd1cmVkAAAAAAAAAAAAAAAOU2lnbmVyc1BlbmRpbmcAAAAAAAAAAAAAAAAACUZpbmFsaXplZAAAAAAAAAAAAABEVm9pZGVkIGJ5IFtgUmVzb2x2ZXI6OmV4cGlyZV9tYXJrZXRgXSBhZnRlciB0aGUgcmVzb2x1dGlvbiBkZWFkbGluZS4AAAAHRXhwaXJlZAAAAAAAAAAAQkEgYm9uZGVkIGRpc3B1dGUgaXMgb3BlbjsgZmluYWxpemF0aW9uIGlzIGZyb3plbiB1bnRpbCBpdCBzZXR0bGVzLgAAAAAACERpc3B1dGVkAAAAAAAAAAAAAAASSHlicmlkUHJpY2VQZW5kaW5nAAAAAAAAAAAAAAAAABJIeWJyaWRGYWxsYmFja09wZW4AAA==",
        "AAAAAAAAADJUb3RhbCBldmlkZW5jZSBjaXRhdGlvbnMgcmVjb3JkZWQgZm9yIGBtYXJrZXRfaWRgLgAAAAAADmV2aWRlbmNlX2NvdW50AAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAQ=",
        "AAAAAAAAAMFQZXJtaXNzaW9ubGVzcyBmYWxsYmFjayB3aGVuIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBuZXZlciBydWxlczoKYGVzY2FsYXRpb25fdGltZW91dGAgYWZ0ZXIgdGhlIGRpc3B1dGUgb3BlbmVkLCB0aGUgYm9uZCBpcyByZWZ1bmRlZCBhbmQKdGhlIG1hcmtldCBpcyB2b2lkZWQsIHNvIG5laXRoZXIgc2lkZSB3aW5zIGJ5IGRlZmF1bHQuAAAAAAAADmV4cGlyZV9kaXNwdXRlAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQQjMTQ5OiByZXR1cm5zIGFuIHVucGFpZCBlc2Nyb3cgdG8gaXRzIGZ1bmRlciBvbmNlIHRoZSBtYXJrZXQgaXMgZmluYWwuClRoaXMgY292ZXJzIGEgbWFya2V0IGZpbmFsaXplZCB0aHJvdWdoIGByZXNvbHZlX3ByaWNlYCBvcgpgZmluYWxpemVfc2lnbmVyc2AgcmF0aGVyIHRoYW4gdGhlaXIgYF9mb3JgIHZhcmlhbnRzLCB3aGljaCB3b3VsZApvdGhlcndpc2UgbGVhdmUgdGhlIGVzY3JvdyBzdHJhbmRlZC4gUmV0dXJucyB0aGUgYW1vdW50IHJlZnVuZGVkLgAAAA5yZWNsYWltX2JvdW50eQAAAAAAAgAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAADhHdWFyZGlhbiBlc2NhbGF0aW9uOiB0aGUgYWRtaW4gcnVsZXMgb24gYW4gb3BlbiBkaXNwdXRlLgAAAA5zZXR0bGVfZGlzcHV0ZQAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAwJQaW5zIHRoZSBjb21taXR0ZWQgZmVlZCdzIHByaWNlIGZvciBgY2xvc2VfdGltZWAgaW4gcmVzb2x2ZXIgc3RvcmFnZSwKc28gYHJlc29sdmVfcHJpY2VgIHN0aWxsIHdvcmtzIGFmdGVyIHRoZSBvcmFjbGUncyBib3VuZGVkIGhpc3RvcnkgaGFzCmFnZWQgdGhhdCByZWNvcmQgb3V0IChTRVAtNDAgYHByaWNlKGFzc2V0LCB0aW1lc3RhbXApYCByZXR1cm5zIGBOb25lYApvdXRzaWRlIHRoZSByZXRhaW5lZCB3aW5kb3cpLiBQZXJtaXNzaW9ubGVzczogYGNhbGxlcmAgb25seSBhdXRob3JpemVzCmJlaW5nIHJlY29yZGVkIGFzIGB0YWtlbl9ieWAuCgpDYWxsYWJsZSBhbnkgdGltZSBhZnRlciBgY2xvc2VfdGltZWAgd2hpbGUgdGhlIG1hcmtldCBpcyB1bnJlc29sdmVkLApidXQgaW4gcHJhY3RpY2UgaXQgbXVzdCBydW4gd2l0aGluIHRoZSBvcmFjbGUncyByZXRlbnRpb24gd2luZG93IChzZWUKYGRvY3MvYXJjaGl0ZWN0dXJlLm1kYCwgIk9yYWNsZSBoaXN0b3J5IHJldGVudGlvbiIpLiBUaGUgZmlyc3QgdmFsaWQKc25hcHNob3Qgd2lucyAoYFNuYXBzaG90RXhpc3RzYCBhZnRlcndhcmRzKTogZm9yIGEgZml4ZWQKYChhc3NldCwgY2xvc2VfdGltZSlgIHRoZSBhbnN3ZXIgaXMgZGV0ZXJtaW5pc3RpYywgYW5kIGZyZWV6aW5nIGl0CmRlbGliZXJhdGVseSBwcmVmZXJzIGRldGVybWluaXNtIG92ZXIgYW4gb3JhY2xlIGxhdGVyIHJld3JpdGluZwpoaXN0b3J5LiBBIHByaWNlIGByZXNvbHZlX3ByaWNlYCB3b3VsZCByZWplY3QgaXMgbmV2ZXIgc3RvcmVkLgAAAAAADnNuYXBzaG90X3ByaWNlAAAAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAB9AAAAAJUHJpY2VEYXRhAAAAAAAAAw==",
        "AAAABQAAAI9BIHNpZ25lciBjb21taXR0ZWUgZmluYWxpemVkIGFuIGBJbnZhbGlkYCBwcm9wb3NhbCBhbmQgdm9pZGVkIHRoZSBtYXJrZXQuCkRpc3Rpbmd1aXNoZXMgY29tbWl0dGVlIHZvaWRzIGZyb20gYEd1YXJkaWFuQWN0aW9uIHsgYWN0aW9uOiBWb2lkIH1gLgAAAAAAAAAAD0NvbW1pdHRlZVZvaWRlZAAAAAABAAAAEGNvbW1pdHRlZV92b2lkZWQAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAMZmluYWxpemVkX2F0AAAABgAAAAAAAAAAAAAADWludmFsaWRfY291bnQAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1ByaWNlUmVzb2x1dGlvbgAAAAABAAAAEHByaWNlX3Jlc29sdXRpb24AAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAAAAAAPcHJpY2VfdGltZXN0YW1wAAAAAAYAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAg==",
        "AAAAAAAAAdpHdWFyZGlhbiBhY3Rpb246IHdpdGhkcmF3cyBhbiB1bmZpbmFsaXplZCBzaWduZXIgcHJvcG9zYWwgZHVyaW5nIHRoZSBkaXNwdXRlIHdpbmRvdwpzdWJqZWN0IHRvIGEgcmF0ZSBsaW1pdCBvZiBNQVhfQ0FOQ0VMU19QRVJfTUFSS0VULgoKV29ya3MgdGhlIHNhbWUgZm9yIGFuIGBJbnZhbGlkYCBwcm9wb3NhbC4gT25seSB0aGUgcHJvcG9zYWwgaXMgcmVtb3ZlZDoKYXR0ZXN0YXRpb25zIGFuZCBwZXItb3V0Y29tZSBjb3VudHMgc3RheSwgc28gdGhlIG5leHQgYXR0ZXN0YXRpb24gdGhhdApicmluZ3MgYW55IG91dGNvbWUgdG8gdGhyZXNob2xkIChmb3IgZXhhbXBsZSBhIGZ1cnRoZXIgYFllc2Agb25jZQpgWWVzYCBhbHJlYWR5IGhhcyBxdW9ydW0pIHByb3Bvc2VzIGFnYWluLiBBIGNhdGVnb3JpY2FsIG1hcmtldCBrZWVwcyBpdHMKcGVuZGluZyB3aW5uZXIgaW4gYSBzZXBhcmF0ZSBzbG90LCBjbGVhcmVkIHRoZSBzYW1lIHdheS4AAAAAAA9jYW5jZWxfcHJvcG9zYWwAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAGcmVhc29uAAAAAAfQAAAADkd1YXJkaWFuUmVhc29uAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAADhDYW5jZWxzIGEgcGVuZGluZyByb3RhdGlvbiBmb3IgYSBjb21taXR0ZWUgKGFkbWluIG9ubHkpLgAAAA9jYW5jZWxfcm90YXRpb24AAAAAAQAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADlSZWFkcyB0aGUgY3VycmVudGx5IGNvbmZpZ3VyZWQgZXZpZGVuY2Ugc2V0dGluZ3MsIGlmIGFueS4AAAAAAAAPZXZpZGVuY2VfY29uZmlnAAAAAAAAAAABAAAD6AAAA+0AAAACAAAAEwAAB9AAAAAORXZpZGVuY2VQb2xpY3kAAA==",
        "AAAABQAAAAAAAAAAAAAAEENvbW1pdHRlZUNyZWF0ZWQAAAABAAAAEWNvbW1pdHRlZV9jcmVhdGVkAAAAAAAABAAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQAAAAAAAAAAAAAAAdtZW1iZXJzAAAAA+oAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEFByaWNlU25hcHNob3R0ZWQAAAABAAAAEXByaWNlX3NuYXBzaG90dGVkAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAAAAAAD3ByaWNlX3RpbWVzdGFtcAAAAAAGAAAAAAAAAAAAAAAIdGFrZW5fYnkAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEFJvdGF0aW9uRXhlY3V0ZWQAAAABAAAAEXJvdGF0aW9uX2V4ZWN1dGVkAAAAAAAAAgAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAEAAAAAAAAABWVwb2NoAAAAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEFJvdGF0aW9uUHJvcG9zZWQAAAABAAAAEXJvdGF0aW9uX3Byb3Bvc2VkAAAAAAAAAgAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAEAAAAAAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAAAQAAA/5EZWNpbWFsLWV4cGxpY2l0IHByaWNlIHJ1bGUgKGlzc3VlICMyNiwgZ29hbCAyKS4gVW5saWtlIHRoZSBsZWdhY3kKW2BQcmljZUNvbmZpZ2BdIOKAlCByZS1leHBvcnRlZCBoZXJlIGZyb20gYG9yYWNsZWRlc2stdHlwZXNgLCB3aG9zZQpgdGhyZXNob2xkYCBpcyBpbiAqZmVlZC1uYXRpdmUgdW5pdHMqIGFuZCBpcyBjb21wYXJlZCB0byB0aGUgcmF3IGZlZWQKcHJpY2Ugd2l0aCBubyBzY2FsaW5nLCBzbyBldmVyeSBjb21taXR0ZWQgbGVnYWN5IGhhc2ggYW5kIG1lYW5pbmcgaXMKdW5jaGFuZ2VkIChBRFIgMDAwMSkg4oCUIHRoaXMgc3RydWN0IHJlY29yZHMKYHRocmVzaG9sZF9kZWNpbWFsc2AsIGFuZCByZXNvbHV0aW9uIHJlc2NhbGVzIGJvdGggdGhlIHRocmVzaG9sZCBhbmQgdGhlCmZlZWQgcHJpY2UgdG8gYG1heChmZWVkX2RlY2ltYWxzLCB0aHJlc2hvbGRfZGVjaW1hbHMpYCB3aXRoIGNoZWNrZWQKYXJpdGhtZXRpYyBiZWZvcmUgY29tcGFyaW5nLiBBIGNyZWF0b3Igd2hvIG1lYW5zICIkMC4yMCIgY29tbWl0cwpgdGhyZXNob2xkID0gMjBgLCBgdGhyZXNob2xkX2RlY2ltYWxzID0gMmAgaW5zdGVhZCBvZiBndWVzc2luZyB0aGUgZmVlZCdzCnNjYWxlLgoKYFByaWNlQ29uZmlnYCBhbmQgYFNpZ25lckNvbmZpZ2AgZGVsaWJlcmF0ZWx5IGRvICoqbm90KiogYXBwZWFyIGhlcmU6ClBSICMxNzYgbWFkZSBgY29udHJhY3RzL29yYWNsZWRlc2stdHlwZXNgIHRoZWlyIGNhbm9uaWNhbCBob21lIGFuZCB0aGlzCmNyYXRlIHJlLWV4cG9ydHMgdGhlbSAoc2VlIHRoZSBgcHViIHVzZWAgYXQgdGhlIHRvcCBvZiB0aGlzIGZpbGUpLCBzbyBhCmByZXNvbHV0aW9uX2hhc2hgIGNvbW1pdG1lbnQgbmV2ZXIgZGVwZW5kcyBvbiB3aGljaCBjcmF0ZSBkZWNsYXJlZCB0aGUKdHlwZS4gW2BTY2FsZWRQcmljZUNvbmZpZ2BdIHN0YXlzIHJlc29sdmVyLWxvY2FsIGZvciBub3cgZm9yIHRoZSBzYW1lCnJlYXNvbiBBRFIgMDAwMSBjYW4gc3RhdGUgaXRzIGFwcGVuZC1vbmx5IHJ1bGUgc28gcHJlY2lzZWx5IAAAAAAAAAAAABFTY2FsZWRQcmljZUNvbmZpZwAAAAAAAAYAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAsAAAAAAAAAEnRocmVzaG9sZF9kZWNpbWFscwAAAAAABA==",
        "AAAAAAAAAS5DcmVhdGVzIGEgcmV1c2FibGUgY29tbWl0dGVlIHdpdGggYW4gYWRtaW4sIG1lbWJlciBzZXQsIHRocmVzaG9sZCwgYW5kIHRpbWUtbG9jayBkZWxheS4KVGhlIG5hbWVkIGBhZG1pbmAgbXVzdCBhdXRob3Jpc2UgY3JlYXRpb24gKCMzMDQpOiB3aXRob3V0IHRoaXMgZ2F0ZSBhbnlvbmUgY291bGQKY3JlYXRlIGEgY29tbWl0dGVlIGNsYWltaW5nIGFueSBhZGRyZXNzIGFzIGl0cyBhZG1pbiwgY29uc3VtaW5nIHNlcXVlbnRpYWwgaWRzIGFuZApmaWxsaW5nIGluc3RhbmNlIHN0b3JhZ2UgYXQgemVybyBjb3N0IGJleW9uZCBmZWVzLgAAAAAAEGNyZWF0ZV9jb21taXR0ZWUAAAAEAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB21lbWJlcnMAAAAD6gAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQAAAAAAAAADnJvdGF0aW9uX2RlbGF5AAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAFBQZXJtaXNzaW9ubGVzc2x5IGV4ZWN1dGVzIGEgbWF0dXJlZCByb3RhdGlvbiBmb3IgYSBjb21taXR0ZWUsIGJ1bXBpbmcgaXRzIGVwb2NoLgAAABBleGVjdXRlX3JvdGF0aW9uAAAAAQAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAUhTZXR0bGVzIHRoZSBwZW5kaW5nIHByb3Bvc2FsIG9uY2UgaXRzIGRpc3B1dGUgd2luZG93IGhhcyBlbGFwc2VkOgpgWWVzYC9gTm9gIHJlc29sdmUgdGhlIG1hcmtldCwgYEludmFsaWRgIHZvaWRzIGl0IChhbmQgZW1pdHMKYENvbW1pdHRlZVZvaWRlZGApLiBtYXJrZXQtY29yZSdzIGB2b2lkX21hcmtldGAgaGFzIG5vIGBjbG9zZV90aW1lYApndWFyZCwgYnV0IGV2ZXJ5IGF0dGVzdGF0aW9uIHBhdGggcmVxdWlyZXMgYG5vdyA+PSBjbG9zZV90aW1lYCBiZWZvcmUKYW55IHdyaXRlLCBzbyBubyBwcm9wb3NhbCAoYW5kIG5vIHZvaWQpIGNhbiBleGlzdCBiZWZvcmUgY2xvc2UuAAAAEGZpbmFsaXplX3NpZ25lcnMAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAD0F0dGVzdGVkT3V0Y29tZQAAAAAD",
        "AAAAAAAAAEJSZXR1cm5zIHRoZSBndWFyZGlhbiByZWFzb24gY29kZXMgdmFsaWQgZm9yIGBtYXJrZXRfaWRgIHJpZ2h0IG5vdy4AAAAAABBndWFyZGlhbl9vcHRpb25zAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPqAAAH0AAAAA5HdWFyZGlhblJlYXNvbgAA",
        "AAAAAAAAAFlQcm9wb3NlcyBhIG5ldyBtZW1iZXIgc2V0IGFuZCB0aHJlc2hvbGQgZm9yIGEgY29tbWl0dGVlLCBleGVjdXRhYmxlIGFmdGVyIHJvdGF0aW9uX2RlbGF5LgAAAAAAABBwcm9wb3NlX3JvdGF0aW9uAAAAAwAAAAAAAAAMY29tbWl0dGVlX2lkAAAABgAAAAAAAAAHbWVtYmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAWlSZXZlYWxzIGEgcnVsZSBjb21taXR0ZWQgdG8gdGhyb3VnaCBhIFtgUmVzb2x1dGlvblNwZWNWMmBdIGVudmVsb3BlLgpUaGUgZW52ZWxvcGUgbXVzdCBuYW1lIHRoaXMgbmV0d29yayBhbmQgdGhpcyByZXNvbHZlcidzIG1hcmtldC1jb3JlCihgRG9tYWluTWlzbWF0Y2hgKSwgdXNlIGEgbm9uLXplcm8gc2FsdCBhbmQgdGhlIGN1cnJlbnQgYHZlcnNpb25gCihgSW52YWxpZENvbmZpZ2ApLCBhbmQgaGFzaCB0byB0aGUgbWFya2V0J3MgY29tbWl0bWVudAooYFNwZWNIYXNoTWlzbWF0Y2hgKS4gVGhlIGlubmVyIHJ1bGUgaXMgdGhlbiB2YWxpZGF0ZWQgYW5kIHN0b3JlZApleGFjdGx5IGFzIHRoZSBsZWdhY3kgZW50cnlwb2ludHMgZG8uAAAAAAAAEHJlZ2lzdGVyX3NwZWNfdjIAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzcGVjAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAUwjMTQ5OiByZWNvcmRzIHRoZSB0b2tlbiB0aGF0IHJlc29sdXRpb24gYm91bnRpZXMgYXJlIGVzY3Jvd2VkIGluLiBJdAptdXN0IGJlIG1hcmtldC1jb3JlJ3MgY29sbGF0ZXJhbCB0b2tlbiwgc28gYm91bnRpZXMgYW5kIG1hcmtldApjb2xsYXRlcmFsIHNoYXJlIG9uZSBhc3NldC4gQmVjYXVzZSB0aGUgb25seSBhY2NlcHRlZCB2YWx1ZSBpcyB0aGUKY29sbGF0ZXJhbCBhZGRyZXNzLCB0aGlzIHNldHRlciBjYW5ub3QgcmVwb2ludCBleGlzdGluZyBlc2Nyb3cgYXQgYQpkaWZmZXJlbnQgdG9rZW4sIGFuZCBubyBlbnRyeXBvaW50IGxldHMgYW4gYWRtaW4gd2l0aGRyYXcgZXNjcm93LgAAABBzZXRfYm91bnR5X3Rva2VuAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAMJgUHJpY2VSZXNvbHV0aW9uYCBwbHVzIHdoZXRoZXIgdGhlIHByaWNlIGNhbWUgZnJvbSBhIHN0b3JlZApbYFByaWNlU25hcHNob3RgXS4gQm90aCBhcmUgZW1pdHRlZCBmb3Igb25lIHJlbGVhc2Ugc28gaW5kZXhlcnMgZGVjb2RpbmcKYFByaWNlUmVzb2x1dGlvbmAga2VlcCB3b3JraW5nIHdoaWxlIHRoZXkgbW92ZSB0byB0aGlzIGV2ZW50LgAAAAAAAAAAABFQcmljZVJlc29sdXRpb25WMgAAAAAAAAEAAAATcHJpY2VfcmVzb2x1dGlvbl92MgAAAAAFAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAAAAAAPcHJpY2VfdGltZXN0YW1wAAAAAAYAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAA1mcm9tX3NuYXBzaG90AAAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEVJvdGF0aW9uQ2FuY2VsbGVkAAAAAAAAAQAAABJyb3RhdGlvbl9jYW5jZWxsZWQAAAAAAAEAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAABAAAAAg==",
        "AAAAAgAAAC5HdWFyZGlhbiBhY3Rpb24gdHlwZSBlbWl0dGVkIGZvciBhdWRpdCB0cmFpbHMuAAAAAAAAAAAAEkd1YXJkaWFuQWN0aW9uS2luZAAAAAAAAgAAAAAAAAAAAAAABFZvaWQAAAAAAAAAAAAAAA5DYW5jZWxQcm9wb3NhbAAA",
        "AAAAAAAAAGhDb21taXR0ZWUgZXNjYWxhdGlvbjogZWFjaCBtZW1iZXIgdm90ZXMgb25jZTsgdGhlIGZpcnN0IHZlcmRpY3QgdG8KZ2F0aGVyIGBrYCB2b3RlcyBzZXR0bGVzIHRoZSBkaXNwdXRlLgAAABFlc2NhbGF0aW9uX2F0dGVzdAAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABm1lbWJlcgAAAAAAEwAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAALsjMTQ5OiBbYFJlc29sdmVyOjpyZXNvbHZlX3ByaWNlYF0gdGhhdCBwYXlzIHRoZSBtYXJrZXQncyBib3VudHkgdG8KYGNhbGxlcmAuIFRoZSBwYXlvdXQgaGFwcGVucyBpbiB0aGUgc2FtZSBpbnZvY2F0aW9uIHRoYXQgbWFrZXMgdGhlCm1hcmtldCBmaW5hbCwgc28gYSBjYWxsIHRoYXQgZmFpbHMgYWxzbyBwYXlzIG5vdGhpbmcuAAAAABFyZXNvbHZlX3ByaWNlX2ZvcgAAAAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAdPdXRjb21lAAAAAAM=",
        "AAAAAAAAAhRDb3VudHMgRWQyNTUxOSBzaWduYXR1cmVzIGZyb20gYSB3ZWlnaHRlZCBjb21taXR0ZWUuIFBlcm1pc3Npb25sZXNzOiB0aGUKc2lnbmF0dXJlcywgbm90IHRoZSBzdWJtaXR0ZXIsIGNhcnJ5IHRoZSBhdXRob3JpdHkuIEVhY2ggc2lnbmF0dXJlIGlzCm92ZXIgdGhlIG1lc3NhZ2UgYnVpbHQgYnkgYGF0dGVzdGF0aW9uX21lc3NhZ2VgOyBub24tbWVtYmVycyBhbmQga2V5cwp0aGF0IGFscmVhZHkgc2lnbmVkIHRoaXMgcm91bmQgKGZvciBlaXRoZXIgb3V0Y29tZSkgYXJlIHNraXBwZWQsIGFuZCBhCnNpbmdsZSBpbnZhbGlkIHNpZ25hdHVyZSBhYm9ydHMgdGhlIHdob2xlIGJhdGNoLCBzbyBzdWJtaXR0ZXJzIHNob3VsZApwcmUtZmlsdGVyIHdpdGggYSB2ZXJpZmllci4gT25jZSB0aGUgYWNjdW11bGF0ZWQgd2VpZ2h0IGZvciBgb3V0Y29tZWAKZmlyc3QgcmVhY2hlcyB0aGUgdGhyZXNob2xkIGEgcHJvcG9zYWwgaXMgcmVjb3JkZWQgYW5kIHRoZSBkaXNwdXRlCndpbmRvdyBzdGFydHM7IGxhdGVyIGNhbGxzIG5ldmVyIG1vdmUgaXQuAAAAEXN1Ym1pdF9zaWduYXR1cmVzAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAABHNpZ3MAAAPqAAAD7QAAAAIAAAPuAAAAIAAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAI9gcHJvcG9zYWxfb3V0Y29tZWAgKGxpa2UgYEF0dGVzdGVkOjpvdXRjb21lYCkgd2FzIGEgbWFya2V0LWNvcmUgYE91dGNvbWVgOwpgWWVzYC9gTm9gIGVuY29kZSBpZGVudGljYWxseSwgc28gb25seSBgSW52YWxpZGAgaXMgbmV3IHRvIGRlY29kZXJzLgAAAAAAAAAAEkZhbGxiYWNrU3VwZXJzZWRlZAAAAAAAAQAAABNmYWxsYmFja19zdXBlcnNlZGVkAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAABBwcm9wb3NhbF9vdXRjb21lAAAH0AAAAA9BdHRlc3RlZE91dGNvbWUAAAAAAAAAAAI=",
        "AAAAAQAAANdTdG9yZWQgbGluayBjb25uZWN0aW5nIGFuIGF0dGVzdGF0aW9uIHRvIGEgcmVhc29uaW5nIHJlZ2lzdHJ5IHRyYWNlLgpgb3V0Y29tZWAgd2FzIGEgbWFya2V0LWNvcmUgYE91dGNvbWVgIGJlZm9yZSBgSW52YWxpZGAgYXR0ZXN0YXRpb25zOyB0aGUKdHdvIGVudW1zIGVuY29kZSBgWWVzYC9gTm9gIGlkZW50aWNhbGx5LCBzbyBlYXJsaWVyIGVudHJpZXMgc3RpbGwgZGVjb2RlLgAAAAAAAAAAE0F0dGVzdGF0aW9uRXZpZGVuY2UAAAAABQAAAAAAAAALYXR0ZXN0ZWRfYXQAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAD0F0dGVzdGVkT3V0Y29tZQAAAAAAAAAABnNpZ25lcgAAAAAAEwAAAAAAAAAKdHJhY2VfaGFzaAAAAAAD7gAAACAAAAAAAAAACHRyYWNlX2lkAAAABg==",
        "AAAAAAAAAIRQYXlzIGEgc2V0dGxlZCBkaXNwdXRlJ3MgYm9uZCB0byBpdHMgcGF5ZWUgKHRoZSBkaXNwdXRlciwgb3IgdGhlCm1hcmtldC1jb3JlIHRyZWFzdXJ5IHdoZW4gdGhlIHByb3Bvc2FsIHdhcyB1cGhlbGQpLiBQZXJtaXNzaW9ubGVzcy4AAAASY2xhaW1fZGlzcHV0ZV9ib25kAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAxlSZXZlYWxzIGEgdGltZS13ZWlnaHRlZC1hdmVyYWdlIHByaWNlIHJ1bGUgY29tbWl0dGVkIHRvIGFzCmBzaGEyNTYoVFdBUF9TUEVDX0RPTUFJTiB8fCBYRFIoVHdhcENvbmZpZykpYCAoaXNzdWUgIzI3KS4gU2FtZQpjb21taXQvcmV2ZWFsIGZsb3cgYXMgW2ByZWdpc3Rlcl9zY2FsZWRfcHJpY2Vfc3BlY2BdLCB3aXRoIHR3bwpkaWZmZXJlbmNlcy4gRmlyc3QsIHRoZSBzdGF0aWMgdmFsaWRhdGlvbgooW2B2YWxpZGF0ZV90d2FwX3J1bGVgXSk6IGB3aW5kb3cgPiAwYCwgYG1pbl9zYW1wbGVzID49IDJgLApgbWF4X2dhcGAgaW4gYCgwLCB3aW5kb3ddYCwgYHRocmVzaG9sZCA+PSAwYC4gU2Vjb25kLCBmZWFzaWJpbGl0eSBpcwpjaGVja2VkICphZ2FpbnN0IHRoZSBsaXZlIGZlZWQqOiB0aGUgZ3JpZCBwZXJpb2Qgb25seSBleGlzdHMKb24tY2hhaW4sIHNvIHJlZ2lzdHJhdGlvbiBjYWxscyBgcmVzb2x1dGlvbigpYCBvbiB0aGUgY29uZmlndXJlZApyZWZsZWN0b3IgYW5kIHJlamVjdHMgYHdpbmRvdyAvIHJlc29sdXRpb24gPiBNQVhfVFdBUF9TQU1QTEVTYCBvcgpgbWluX3NhbXBsZXMgPiB3aW5kb3cgLyByZXNvbHV0aW9uYCB3aXRoIGBJbnZhbGlkQ29uZmlnYC4gVGhpcyBtYWtlcwp0aGUgcmVmbGVjdG9yIHJlcXVpcmVkIHJlYWNoYWJsZSBhdCByZWdpc3RyYXRpb24gKGEgdHJhcHBpbmcgZmVlZApnaXZlcyBgUHJpY2VVbmF2YWlsYWJsZWApIOKAlCBkZWxpYmVyYXRlOiBhbiB1bnJlc29sdmFibGUgVFdBUCBtYXJrZXQKaXMgY2F1Z2h0IGF0IHJldmVhbCB0aW1lLCBub3QgYXQgY2xvc2UuAAAAAAAAEnJlZ2lzdGVyX3R3YXBfc3BlYwAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAKVHdhcENvbmZpZwAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQMjMjk3OiBQZXJtaXNzaW9ubGVzc2x5IHBpbnMgdGhlIGNvbW1pdHRlZSBlcG9jaCBmb3IgYSBtYXJrZXQgdG8gdGhlCmVwb2NoIGluIGZvcmNlIGF0IGBjbG9zZV90aW1lYC4gQ2FuIGJlIGNhbGxlZCBieSBrZWVwZXJzIHJpZ2h0IGFmdGVyCmNsb3NlLCBiZWZvcmUgYW55IHJvdGF0aW9uIGxhbmRzLiBJZGVtcG90ZW50OiBpZiBhbHJlYWR5IHBpbm5lZCwgdGhlCmV4aXN0aW5nIHBpbiBpcyBrZXB0LiBNdXN0IG5vdCBydW4gYmVmb3JlIGNsb3NlX3RpbWUuAAAAABNwaW5fY29tbWl0dGVlX2Vwb2NoAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAA+0AAAACAAAABgAAAAQAAAAD",
        "AAAAAAAAATpSZXZlYWxzIHRoZSByZXNvbHV0aW9uIHJ1bGUgY29tbWl0dGVkIHRvIGF0IG1hcmtldCBjcmVhdGlvbi4gQW55b25lCm1heSBjYWxsIHRoaXMgKHRoZXJlIGlzIG5vIGFkbWluIGdhdGUpIGJlY2F1c2UgdGhlIG9ubHkgdGhpbmcgdGhhdAptYWtlcyBhIHNwZWMgYWNjZXB0YWJsZSBpcyB0aGF0IGl0IGhhc2hlcyB0byBgbWFya2V0LnJlc29sdXRpb25faGFzaGAK4oCUIHRoZSBjb21taXRtZW50LCBub3QgdGhlIGNhbGxlciwgaXMgdGhlIGF1dGhvcml0eS4gRmFpbHMgaWYgYSBzcGVjCndhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAAE3JlZ2lzdGVyX3ByaWNlX3NwZWMAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAALUHJpY2VDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAANVXaGVuIGBleHBpcmVfbWFya2V0YCBiZWNvbWVzIGNhbGxhYmxlIGZvciBgbWFya2V0X2lkYDogYGNsb3NlX3RpbWVgIHBsdXMKW2BSRVNPTFVUSU9OX0dSQUNFX1NFQ1NgXS4gTmVlZHMgb25seSBtYXJrZXQtY29yZSdzIGBjbG9zZV90aW1lYCwgc28gaXQKaXMga25vd24gYmVmb3JlIChhbmQgd2l0aG91dCkgYSBzcGVjIHJldmVhbCwgZm9yIGVpdGhlciBtYXJrZXQga2luZC4AAAAAAAATcmVzb2x1dGlvbl9kZWFkbGluZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAFRDb25maWd1cmVzIHRoZSByZWFzb25pbmcgcmVnaXN0cnkgY29udHJhY3QgYWRkcmVzcyBhbmQgZXZpZGVuY2UgcG9saWN5IChhZG1pbiBvbmx5KS4AAAATc2V0X2V2aWRlbmNlX2NvbmZpZwAAAAACAAAAAAAAAAhyZWdpc3RyeQAAABMAAAAAAAAABnBvbGljeQAAAAAH0AAAAA5FdmlkZW5jZVBvbGljeQAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAKMjMjk3OiBFbWl0dGVkIHdoZW4gYSBjb21taXR0ZWUgbWFya2V0J3MgZXBvY2ggaXMgcGlubmVkIHRvIHRoZSBlcG9jaCBpbgpmb3JjZSBhdCBjbG9zZV90aW1lLCBlaXRoZXIgdGhyb3VnaCB0aGUgZmlyc3QgYXR0ZXN0YXRpb24gb3IgdGhyb3VnaApgcGluX2NvbW1pdHRlZV9lcG9jaGAuAAAAAAAAAAAUQ29tbWl0dGVlRXBvY2hQaW5uZWQAAAABAAAAFmNvbW1pdHRlZV9lcG9jaF9waW5uZWQAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAxjb21taXR0ZWVfaWQAAAAGAAAAAAAAAAAAAAAFZXBvY2gAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFFJlc29sdXRpb25Qcm9wb3NlZFYyAAAAAQAAABZyZXNvbHV0aW9uX3Byb3Bvc2VkX3YyAAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAD0F0dGVzdGVkT3V0Y29tZQAAAAAAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAGAAAAAAAAAAI=",
        "AAAAAAAAAFJBdHRlc3RzIHRvIGFuIG91dGNvbWUgYmFja2VkIGJ5IGFuIG9uLWNoYWluIHJlYXNvbmluZyB0cmFjZSBpbiByZWFzb25pbmctcmVnaXN0cnkuAAAAAAAUYXR0ZXN0X3dpdGhfZXZpZGVuY2UAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAAB291dGNvbWUAAAAH0AAAAA9BdHRlc3RlZE91dGNvbWUAAAAAAAAAAAh0cmFjZV9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHEjMjk3OiBWaWV3IHJldHVybmluZyB0aGUgbWVtYmVycyBhbmQgdGhyZXNob2xkIGZvciBhIGNvbW1pdHRlZSBhdCBhCnNwZWNpZmljIGVwb2NoLCBmcm9tIHRoZSBgTWVtYmVyQXRgIHNuYXBzaG90LgAAAAAAABRjb21taXR0ZWVfbWVtYmVyc19hdAAAAAIAAAAAAAAADGNvbW1pdHRlZV9pZAAAAAYAAAAAAAAABWVwb2NoAAAAAAAABAAAAAEAAAPpAAAD7QAAAAIAAAPqAAAAEwAAAAQAAAAD",
        "AAAAAAAAAJ0jMTQ5OiBbYFJlc29sdmVyOjpmaW5hbGl6ZV9zaWduZXJzYF0gdGhhdCBwYXlzIHRoZSBtYXJrZXQncyBib3VudHkgdG8KYGNhbGxlcmAsIHdpdGggdGhlIHNhbWUgc2luZ2xlLWludm9jYXRpb24gZ3VhcmFudGVlIGFzCltgUmVzb2x2ZXI6OnJlc29sdmVfcHJpY2VfZm9yYF0uAAAAAAAAFGZpbmFsaXplX3NpZ25lcnNfZm9yAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAAD0F0dGVzdGVkT3V0Y29tZQAAAAAD",
        "AAAAAAAAAFxHdWFyZGlhbiBhY3Rpb246IHZvaWRzIGEgbWFya2V0IHN1YmplY3QgdG8gdmVyaWZpZWQgb24tY2hhaW4gcmVhc29uIGNvZGVzIGFuZCBncmFjZSBwZXJpb2RzLgAAABRndWFyZGlhbl92b2lkX21hcmtldAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABnJlYXNvbgAAAAAH0AAAAA5HdWFyZGlhblJlYXNvbgAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAFBSZWdpc3RlcnMgYSBoeWJyaWQgcmVzb2x1dGlvbiBzcGVjaWZpY2F0aW9uIChwcmljZSBmZWVkIHdpdGggYXR0ZXN0ZWQgZmFsbGJhY2spLgAAABRyZWdpc3Rlcl9oeWJyaWRfc3BlYwAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADEh5YnJpZENvbmZpZwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAALNTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2NhbGFyIG1vZGU6CnRoZSBtYXJrZXQgc2V0dGxlcyBmcmFjdGlvbmFsbHkgZnJvbSB0aGUgZmVlZCBwcmljZSBjbGFtcGVkIGludG8KYFtsb3dlciwgdXBwZXJdYCAoc2VlIGByZXNvbHZlX3NjYWxhcl9wcmljZWApLgAAAAAUcmVnaXN0ZXJfc2NhbGFyX3NwZWMAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzcGVjAAAH0AAAABFTY2FsYXJQcmljZUNvbmZpZwAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAENTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUuAAAAABRyZWdpc3Rlcl9zaWduZXJfc3BlYwAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAdJSZXNvbHZlcyBhIHNjYWxhciBtYXJrZXQgZnJvbSBpdHMgUmVmbGVjdG9yIGZlZWQuIFRoZSByZWFkaW5nIGlzCmNsYW1wZWQgaW50byB0aGUgY29tbWl0dGVkIGBbbG93ZXIsIHVwcGVyXWAgcmFuZ2UgYW5kIHNldHRsZWQgYXMgdGhlCmZyYWN0aW9uYWwgTE9ORyBwYXlvdXQgYChjbGFtcGVkIC0gbG93ZXIpIC8gKHVwcGVyIC0gbG93ZXIpYCBpbiBicHMKKFNIT1JUIHBheXMgdGhlIGNvbXBsZW1lbnQpLiBSZXR1cm5zIHRoZSBwYXlvdXQuCgpBIG5vbi1wb3NpdGl2ZSByZWFkaW5nIGlzIGBJbnZhbGlkUHJpY2VgIHJhdGhlciB0aGFuIGEgY2xhbXA6IGl0IG1lYW5zCnRoZSBmZWVkIGlzIGJyb2tlbiwgbm90IHRoYXQgdGhlIHZhbHVlIHNpdHMgYXQgdGhlIGJvdHRvbSBvZiB0aGUKcmFuZ2UuIFNhbWUgY2xvc2UtdGltZSwgc3RhbGVuZXNzIGFuZCB0ZXJtaW5hbC1zdGF0ZSBydWxlcyBhcwpgcmVzb2x2ZV9wcmljZWAuAAAAAAAUcmVzb2x2ZV9zY2FsYXJfcHJpY2UAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAABQAAADBDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgUmVzb2x1dGlvblByb3Bvc2VkYC4AAAAAAAAAFUNhdFJlc29sdXRpb25Qcm9wb3NlZAAAAAAAAAEAAAAXY2F0X3Jlc29sdXRpb25fcHJvcG9zZWQAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAADW91dGNvbWVfaW5kZXgAAAAAAAAEAAAAAAAAAAAAAAALcHJvcG9zZWRfYXQAAAAABgAAAAAAAAAC",
        "AAAABQAAAT1FbWl0dGVkIGFsb25nc2lkZSB0aGUgdW5jaGFuZ2VkIFtgUHJpY2VSZXNvbHV0aW9uYF0vW2BQcmljZVJlc29sdXRpb25WMmBdCmZvciBhIFtgU2NhbGVkUHJpY2VDb25maWdgXSBzZXR0bGVtZW50IChpc3N1ZSAjMjYpOiB0aGUgcmF3IGZlZWQgcHJpY2UsCnRoZSBmZWVkJ3MgYGRlY2ltYWxzKClgLCB0aGUgdGhyZXNob2xkIHJlc2NhbGVkIHRvIHRoZSBjb21wYXJpc29uIHNjYWxlLAphbmQgdGhlIGdyaWQtYWxpZ25lZCBsb29rdXAgdGltZXN0YW1wLiBOZXcgZXZlbnQgdHlwZSwgc28gZXhpc3RpbmcKaW5kZXhlciBkZWNvZGVycyBhcmUgdW50b3VjaGVkLgAAAAAAAAAAAAAVUHJpY2VSZXNvbHV0aW9uU2NhbGVkAAAAAAAAAQAAABdwcmljZV9yZXNvbHV0aW9uX3NjYWxlZAAAAAAGAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAJcmF3X3ByaWNlAAAAAAAACwAAAAAAAAAAAAAADWZlZWRfZGVjaW1hbHMAAAAAAAAEAAAAAAAAAAAAAAAQdGhyZXNob2xkX3NjYWxlZAAAAAsAAAAAAAAAAAAAABBsb29rdXBfdGltZXN0YW1wAAAABgAAAAAAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFVJlc29sdXRpb25GaW5hbGl6ZWRWMgAAAAAAAAEAAAAXcmVzb2x1dGlvbl9maW5hbGl6ZWRfdjIAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAAB291dGNvbWUAAAAH0AAAAA9BdHRlc3RlZE91dGNvbWUAAAAAAAAAAAAAAAAMZmluYWxpemVkX2F0AAAABgAAAAAAAAAC",
        "AAAABQAAAG9TY2FsYXIgY291bnRlcnBhcnQgb2YgYFByaWNlUmVzb2x1dGlvbmA6IHRoZSBzZXR0bGVkIG1hcmtldCBjYXJyaWVzIGEKZnJhY3Rpb25hbCBMT05HIHBheW91dCBpbnN0ZWFkIG9mIGEgc2lkZS4AAAAAAAAAABVTY2FsYXJQcmljZVJlc29sdXRpb24AAAAAAAABAAAAF3NjYWxhcl9wcmljZV9yZXNvbHV0aW9uAAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAAAAAAAA9wcmljZV90aW1lc3RhbXAAAAAABgAAAAAAAAAAAAAAD3BheW91dF9sb25nX2JwcwAAAAAEAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAVY2FuY2VsX2FkbWluX3RyYW5zZmVyAAAAAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABQAAADFDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgUmVzb2x1dGlvbkZpbmFsaXplZGAuAAAAAAAAAAAAABZDYXRSZXNvbHV0aW9uRmluYWxpemVkAAAAAAABAAAAGGNhdF9yZXNvbHV0aW9uX2ZpbmFsaXplZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAAAAAAAAAAADGZpbmFsaXplZF9hdAAAAAYAAAAAAAAAAg==",
        "AAAAAAAAAGAjMjk3OiBWaWV3IHJldHVybmluZyB0aGUgcGlubmVkIChjb21taXR0ZWVfaWQsIGVwb2NoKSBmb3IgYSBtYXJrZXQsIG9yCmBOb25lYCBpZiBub3QgeWV0IHBpbm5lZC4AAAAWbWFya2V0X2NvbW1pdHRlZV9lcG9jaAAAAAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPoAAAD7QAAAAIAAAAGAAAABA==",
        "AAAAAAAAAAAAAAAXYWNjZXB0X21hcmtldF9jb3JlX3JvbGUAAAAAAAAAAAA=",
        "AAAAAAAAAD1SZWdpc3RlcnMgYSByZXVzYWJsZSBjb21taXR0ZWUgc3BlY2lmaWNhdGlvbiBmb3IgYG1hcmtldF9pZGAuAAAAAAAAF3JlZ2lzdGVyX2NvbW1pdHRlZV9zcGVjAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADENvbW1pdHRlZVJlZgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAM5SZWdpc3RlcnMgYSBoeWJyaWQgVjIgcmVzb2x1dGlvbiBzcGVjaWZpY2F0aW9uIChwcmljZSBmZWVkIHdpdGggcmljaGVyIGZhbGxiYWNrKS4KClVubGlrZSBgcmVnaXN0ZXJfaHlicmlkX3NwZWNgLCB0aGUgZmFsbGJhY2sgY2FuIGJlIGEgY29tbWl0dGVlIG9yIGEKd2VpZ2h0ZWQta2V5IGdyb3VwLCBub3Qgb25seSBiYXJlIHNpZ25lcnMgKGlzc3VlICMzMTQpLgAAAAAAF3JlZ2lzdGVyX2h5YnJpZF92Ml9zcGVjAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADkh5YnJpZENvbmZpZ1YyAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAATZTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgY2F0ZWdvcmljYWwKb3V0Y29tZS1pbmRleCBjb21taXR0ZWUuIE9ubHkgbWVhbmluZ2Z1bCBmb3IgbWFya2V0cyB3aG9zZQpgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvIGBSZXNvbHV0aW9uU3BlYzo6Q2F0ZWdvcmljYWxTaWduZXJzYCB3aXRoCnRoaXMgZXhhY3QgYG91dGNvbWVfY291bnRgOyB0aGUgcmV2ZWFsIHRhcmdldCdzIGByZXNvbHV0aW9uX2hhc2hgIGlzCnJlYWQgZnJvbSB3aGljaGV2ZXIgbWFya2V0IGtpbmQgb3ducyB0aGUgaWQuAAAAAAAYcmVnaXN0ZXJfY2F0X3NpZ25lcl9zcGVjAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAPQ2F0U2lnbmVyQ29uZmlnAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIFTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUgd2hvc2UKcHJvcG9zYWxzIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIChzZWUgYGRpc3B1dGVgKS4AAAAAAAAYcmVnaXN0ZXJfZGlzcHV0YWJsZV9zcGVjAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAWRGlzcHV0YWJsZVNpZ25lckNvbmZpZwAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAj1SZXZlYWxzIGEgZGVjaW1hbC1leHBsaWNpdCBwcmljZSBydWxlIGNvbW1pdHRlZCB0byBhcwpgc2hhMjU2KFNDQUxFRF9TUEVDX0RPTUFJTiB8fCBYRFIoU2NhbGVkUHJpY2VDb25maWcpKWAgKGlzc3VlICMyNikuClNhbWUgY29tbWl0L3JldmVhbCBmbG93IGFzIFtgcmVnaXN0ZXJfcHJpY2Vfc3BlY2BdOwpgdGhyZXNob2xkX2RlY2ltYWxzYCBhYm92ZSBbYE1BWF9USFJFU0hPTERfREVDSU1BTFNgXSBpcwpgSW52YWxpZENvbmZpZ2AgKG5vIGBpMTI4YCBzY2FsZSBmYWN0b3IgZXhpc3RzIHRoYXQgbGFyZ2UpLiBUaGUKcHJlaW1hZ2UgaXMgaXRzIG93biBkb21haW4tdGFnZ2VkIHNwYWNlIHJhdGhlciB0aGFuIGEKYFJlc29sdXRpb25TcGVjYCB2YXJpYW50IGJlY2F1c2UgUFIgIzE3NiBtb3ZlZCB0aGF0IGVudW0gdG8KYG9yYWNsZWRlc2stdHlwZXNgIChlZGl0ZWQgb25seSB2aWEgbWFpbnRhaW5lciBmb2xsb3ctdXA7IHNlZSBBRFIKMDAwMSkg4oCUIGV2ZXJ5IGV4aXN0aW5nIGBQcmljZWAgLyBgU2lnbmVyc2AgLyBWMiBjb21taXRtZW50IHN0YXlzCmJ5dGUtZm9yLWJ5dGUgdmFsaWQgZWl0aGVyIHdheS4AAAAAAAAacmVnaXN0ZXJfc2NhbGVkX3ByaWNlX3NwZWMAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAAEVNjYWxlZFByaWNlQ29uZmlnAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAI5TZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgd2VpZ2h0ZWQgRWQyNTUxOQpjb21taXR0ZWUgdGhhdCBzaWducyBvZmYtY2hhaW4gYW5kIGlzIHZlcmlmaWVkIGJ5IGBzdWJtaXRfc2lnbmF0dXJlc2AuAAAAAAAacmVnaXN0ZXJfd2VpZ2h0ZWRfa2V5X3NwZWMAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAQJDb25zZW50IHRvIG1pZ3JhdGUgb25lIG1hcmtldCBmcm9tIHRoaXMgcmVzb2x2ZXIgdG8gYSBuZXdseSB3aXJlZCByZXNvbHZlci4KVGhlIG1hcmtldC1jb3JlIG1pZ3JhdGlvbiBvbmx5IHN1Y2NlZWRzIHdoaWxlIHRoaXMgcmVzb2x2ZXIncyBhZGRyZXNzCmF1dGhvcml6ZXMgdGhlIG1hcmtldC1jb3JlIGNhbGwsIHNvIHRoaXMgZW50cnlwb2ludCBwcm92aWRlcyBnb3Zlcm5hbmNlCmFja25vd2xlZGdlbWVudCBmcm9tIHRoZSByZXNvbHZlciBhZG1pbi4AAAAAAB9jb25zZW50X21hcmtldF9yZXNvbHZlcl9taWdyYXRlAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAADG5ld19yZXNvbHZlcgAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAgAAABdXaG8gcnVsZXMgb24gYSBkaXNwdXRlLgAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAALVRoZSByZXNvbHZlciBhZG1pbiwgdGhyb3VnaCBgc2V0dGxlX2Rpc3B1dGVgLgAAAAAAAAhHdWFyZGlhbgAAAAEAAABfYGtgIG9mIHRoZXNlIG1lbWJlcnMsIHRocm91Z2ggYGVzY2FsYXRpb25fYXR0ZXN0YC4gTXVzdCBiZSBkaXNqb2ludApmcm9tIHRoZSBwcm9wb3Npbmcgc2lnbmVycy4AAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAACCUmF3IEVkMjU1MTkgcHVibGljIGtleS4gRm9yIGEgYEcuLi5gIGFjY291bnQgYWRkcmVzcyB0aGlzIGlzCmBTdHJLZXkuZGVjb2RlRWQyNTUxOVB1YmxpY0tleShhZGRyZXNzKWA7IGBDLi4uYCBhZGRyZXNzZXMgaGF2ZSBub25lLgAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAEtCaW5kcyBhIG1hcmtldCB0byBhIHJldXNhYmxlIGNvbW1pdHRlZSByZWdpc3RyeSBzdWJqZWN0IHRvIHJvdGF0aW9uIGJvdW5kcy4AAAAAAAAAAAxDb21taXR0ZWVSZWYAAAAEAAAAAAAAAAxjb21taXR0ZWVfaWQAAAAGAAAAAAAAAA5kaXNwdXRlX3dpbmRvdwAAAAAABgAAAAAAAAASbWF4X3JvdGF0aW9uX2RlbHRhAAAAAAAEAAAAAAAAAAltaW5fZXBvY2gAAAAAAAAE",
        "AAAAAQAAAEVEdWFsLXBhdGggcmVzb2x1dGlvbiBtb2RlOiBwcmljZSBmZWVkIGZpcnN0LCBmYWxsaW5nIGJhY2sgdG8gc2lnbmVycy4AAAAAAAAAAAAADEh5YnJpZENvbmZpZwAAAAMAAAAAAAAACGZhbGxiYWNrAAAH0AAAAAxTaWduZXJDb25maWcAAAAAAAAADmZhbGxiYWNrX2FmdGVyAAAAAAAGAAAAAAAAAAVwcmljZQAAAAAAB9AAAAALUHJpY2VDb25maWcA",
        "AAAAAQAAASNFeHRlbmRlZCBoeWJyaWQgbW9kZTogcHJpY2UgZmVlZCBmaXJzdCwgZmFsbGluZyBiYWNrIHRvIGFueSBhdHRlc3RlZAphdXRob3JpdHkgYWZ0ZXIgYGZhbGxiYWNrX2FmdGVyYCBzZWNvbmRzIHBhc3QgYGNsb3NlX3RpbWVgLgoKQSBzZXBhcmF0ZSBzdHJ1Y3QgKG5vdCBhbiBpbi1wbGFjZSB1cGRhdGUgdG8gYEh5YnJpZENvbmZpZ2ApIGJlY2F1c2UKYEh5YnJpZENvbmZpZ2AgaXMgY29uc2Vuc3VzLWNyaXRpY2FsIOKAlCBleGlzdGluZyBjb21taXRtZW50IGhhc2hlcyBtdXN0CmNvbnRpbnVlIHRvIHZlcmlmeS4AAAAAAAAAAA5IeWJyaWRDb25maWdWMgAAAAAAAwAAAAAAAAAIZmFsbGJhY2sAAAfQAAAAEUZhbGxiYWNrQXV0aG9yaXR5AAAAAAAAAAAAAA5mYWxsYmFja19hZnRlcgAAAAAABgAAAAAAAAAFcHJpY2UAAAAAAAfQAAAAC1ByaWNlQ29uZmlnAA==",
        "AAAAAgAAARNUaGUgZnVsbCByZXNvbHV0aW9uIHJ1bGUgYSBtYXJrZXQncyBgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvLiBIYXNoaW5nCnRoaXMgKHJhdGhlciB0aGFuIHRoZSBiYXJlIGBQcmljZUNvbmZpZ2AvYFNpZ25lckNvbmZpZ2ApIGtlZXBzIHRoZSB0d28KbW9kZXMgaW4gZGlzam9pbnQgaGFzaCBzcGFjZXMgZXZlbiBpZiB0aGVpciBmaWVsZCBlbmNvZGluZ3MgY291bGQKb3RoZXJ3aXNlIGNvbGxpZGUuIFNlZSBgZG9jcy9hZHIvMDAwMS1yZXNvbHV0aW9uLWNvbW1pdG1lbnQubWRgLgAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAJAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAAAAAAAZIeWJyaWQAAAAAAAEAAAfQAAAADEh5YnJpZENvbmZpZwAAAAEAAACDRXh0ZW5kZWQgaHlicmlkIHdpdGggcmljaGVyIGZhbGxiYWNrIGF1dGhvcml0eSAoaXNzdWUgIzMxNCkuCkFwcGVuZGVkIGxhc3QgdG8gcHJlc2VydmUgZGlzY3JpbWluYW50IHBvc2l0aW9ucyBvZiBleGlzdGluZyB2YXJpYW50cy4AAAAACEh5YnJpZFYyAAAAAQAAB9AAAAAOSHlicmlkQ29uZmlnVjIAAAAAAAEAAAB4Q2F0ZWdvcmljYWwgY291bnRlcnBhcnQgb2YgYFNpZ25lcnNgIChhcHBlbmRlZCwgdGFnIDcsIGFmdGVyCmBIeWJyaWRWMmAgc28gZGV2ZWxvcCdzIGRlcGxveWVkIGRpc2NyaW1pbmFudHMgbmV2ZXIgbW92ZSkuAAAAEkNhdGVnb3JpY2FsU2lnbmVycwAAAAAAAQAAB9AAAAAPQ2F0U2lnbmVyQ29uZmlnAAAAAAEAAAB3U2NhbGFyIGNvdW50ZXJwYXJ0IG9mIGBQcmljZWAgKGFwcGVuZGVkLCB0YWcgOCk6IHRoZSBiaW5hcnkgcG9vbApzZXR0bGVzIGF0IGEgZnJhY3Rpb25hbCBMT05HIHBheW91dCBpbnN0ZWFkIG9mIGEgc2lkZS4AAAAABlNjYWxhcgAAAAAAAQAAB9AAAAARU2NhbGFyUHJpY2VDb25maWcAAAA=",
        "AAAAAQAAASxDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBbYFNpZ25lckNvbmZpZ2BdOiBzaWduZXJzIGF0dGVzdCBhbiBvdXRjb21lCippbmRleCogb2YgYSBjYXRlZ29yaWNhbCBtYXJrZXQgaW5zdGVhZCBvZiBZZXMvTm8uIGBvdXRjb21lX2NvdW50YApiaW5kcyB0aGUgbWFya2V0J3Mgb3V0Y29tZSBzZXQgdG8gdGhlIGNvbW1pdG1lbnQgKDIuLj04LCBtaXJyb3JpbmcKbWFya2V0LWNvcmUncyBjYXApLCBzbyBhIHJldmVhbCBjYW5ub3Qgc2lsZW50bHkgY2hhbmdlIGhvdyBtYW55IG91dGNvbWVzCnNpZ25lcnMgYXJlIHZvdGluZyBvbi4AAAAAAAAAD0NhdFNpZ25lckNvbmZpZwAAAAAEAAAAAAAAAA5kaXNwdXRlX3dpbmRvdwAAAAAABgAAAAAAAAANb3V0Y29tZV9jb3VudAAAAAAAAAQAAAAAAAAAB3NpZ25lcnMAAAAD6gAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQ=",
        "AAAAAQAAAOBWZXJzaW9uZWQgY29tbWl0bWVudCBlbnZlbG9wZS4gVW5saWtlIGEgYmFyZSBbYFJlc29sdXRpb25TcGVjYF0gaXQgYmluZHMgdGhlCm5ldHdvcmsgYW5kIHRoZSBtYXJrZXQtY29yZSBpbnN0YW5jZSwgYW5kIGNhcnJpZXMgYSBjcmVhdG9yLWNob3NlbiBgc2FsdGAKdGhhdCBtYWtlcyBhIHByZS1yZXZlYWwgYnJ1dGUtZm9yY2Ugb2YgdGhlIChsb3ctZW50cm9weSkgcnVsZSBpbmZlYXNpYmxlLgAAAAAAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAUAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAA/YHNoYTI1NihuZXR3b3JrIHBhc3NwaHJhc2UpYCwgaS5lLiBgZW52LmxlZGdlcigpLm5ldHdvcmtfaWQoKWAuAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAgAAAQ5SaWNoZXIgZmFsbGJhY2sgYXV0aG9yaXR5IGZvciBgSHlicmlkVjJgOiBhbnkgYXR0ZXN0ZWQgcmVzb2x1dGlvbiBtb2RlCnRoYXQgY2FuIHByb2R1Y2UgYSBxdW9ydW0sIG5vdCBqdXN0IGJhcmUgc2lnbmVycy4KClZhcmlhbnRzIGFyZSBpbnRlbnRpb25hbGx5IGFkZGl0aXZlIGFuZCBhcHBlbmRlZCBhZnRlciBgU2lnbmVyc2Agc28gdGhhdApleGlzdGluZyBkaXNjcmltaW5hbnQgcG9zaXRpb25zIGFyZSBzdGFibGUgKFNvcm9iYW4gZW5jb2RlcyBhcyBwb3NpdGlvbmFsKS4AAAAAAAAAAAARRmFsbGJhY2tBdXRob3JpdHkAAAAAAAADAAAAAQAAAClBIHNpbXBsZSB0aHJlc2hvbGQgb2Ygd2VsbC1rbm93biBzaWduZXJzLgAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAyQSBjb21taXR0ZWUgcmVnaXN0ZXJlZCBpbiB0aGUgcmVzb2x2ZXIncyByZWdpc3RyeS4AAAAAAAlDb21taXR0ZWUAAAAAAAABAAAH0AAAAAxDb21taXR0ZWVSZWYAAAABAAAAMEFuIGV4cGxpY2l0IHNldCBvZiBwdWJrZXlzIHdpdGggcGVyLWtleSB3ZWlnaHRzLgAAAAxXZWlnaHRlZEtleXMAAAABAAAH0AAAABFXZWlnaHRlZEtleUNvbmZpZwAAAA==",
        "AAAAAQAAAX9TY2FsYXIgKHJhbmdlKSBjb3VudGVycGFydCBvZiBbYFByaWNlQ29uZmlnYF0uIFRoZSBtYXJrZXQgc2V0dGxlcyBvbiB0aGUKZnJhY3Rpb25hbCBwb3NpdGlvbiBvZiBgcHJpY2VgIGluc2lkZSBgW2xvd2VyLCB1cHBlcl1gOgpgcGF5b3V0X2xvbmdfYnBzID0gKGNsYW1wZWRfcHJpY2UgLSBsb3dlcikgLyAodXBwZXIgLSBsb3dlcilgLCBhbmQgdGhlClNIT1JUIHNpZGUgcGF5cyB0aGUgY29tcGxlbWVudC4gQSByZWFkaW5nIGJlbG93IHRoZSByYW5nZSBjbGFtcHMgdG8KYGxvd2VyYCAoTE9ORyBwYXlzIDApLCBhYm92ZSB0byBgdXBwZXJgIChMT05HIHBheXMgMS4wKTsgYSBub24tcG9zaXRpdmUKcmVhZGluZyBpcyBhbiBpbnZhbGlkIHByaWNlLCBuZXZlciBhIGNsYW1wLgAAAAAAAAAAEVNjYWxhclByaWNlQ29uZmlnAAAAAAAABQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAAC09yYWNsZUFzc2V0AAAAAHFCb3R0b20gb2YgdGhlIHN0YWtlZCByYW5nZS4gVmFsaWRhdGVkIGAwIDw9IGxvd2VyIDwgdXBwZXJgLCB3aXRoCmB1cHBlcmAgY2FwcGVkIHNvIGB1cHBlciAqIEJQU2AgY2Fubm90IG92ZXJmbG93LgAAAAAAAAVsb3dlcgAAAAAAAAsAAAAAAAAADW1heF9zdGFsZW5lc3MAAAAAAAAGAAAAAAAAAAlyZWZsZWN0b3IAAAAAAAATAAAAAAAAAAV1cHBlcgAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAd1RvdGFsIHdlaWdodCB0aGF0IG11c3Qgc2lnbiBvbmUgb3V0Y29tZS4gQ2hvb3NlIGl0IGFib3ZlIGhhbGYgdGhlIHRvdGFsCndlaWdodCBzbyB0d28gb3V0Y29tZXMgY2FuIG5ldmVyIGJvdGggcmVhY2ggaXQuAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAAAQAAANBBdHRlc3RlZCByZXNvbHV0aW9uIHdob3NlIHByb3Bvc2FsIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIGR1cmluZwp0aGUgZGlzcHV0ZSB3aW5kb3cuIEhhc2hlZCBhcyBgUmVzb2x1dGlvblNwZWM6OlNpZ25lcnNEaXNwdXRhYmxlYCwgYQpzZXBhcmF0ZSB2YXJpYW50LCBzbyBleGlzdGluZyBgU2lnbmVyc2AgY29tbWl0bWVudHMgYXJlIHVuYWZmZWN0ZWQuAAAAAAAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAAGAAAAM0NvbGxhdGVyYWwgZXNjcm93ZWQgYnkgYGRpc3B1dGVgOyBtdXN0IGJlIHBvc2l0aXZlLgAAAAAMZGlzcHV0ZV9ib25kAAAACwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAACmVzY2FsYXRpb24AAAAAB9AAAAAKRXNjYWxhdGlvbgAAAAAAQ1NlY29uZHMgYWZ0ZXIgYSBkaXNwdXRlIG9wZW5zIGJlZm9yZSBhbnlvbmUgbWF5IHZvaWQgaXQgdW5yZXNvbHZlZC4AAAAAEmVzY2FsYXRpb25fdGltZW91dAAAAAAABgAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<Result<string>>,
        state: this.txFromJSON<ResolutionState>,
        attest: this.txFromJSON<Result<void>>,
        dispute: this.txFromJSON<Result<void>>,
        snapshot: this.txFromJSON<Option<PriceSnapshot>>,
        rule_kind: this.txFromJSON<Option<RuleKind>>,
        spec_kind: this.txFromJSON<SpecKind>,
        attest_cat: this.txFromJSON<Result<void>>,
        evidence_at: this.txFromJSON<Result<AttestationEvidence>>,
        fund_bounty: this.txFromJSON<Result<void>>,
        market_core: this.txFromJSON<string>,
        accept_admin: this.txFromJSON<Result<void>>,
        cancel_count: this.txFromJSON<u32>,
        finalize_cat: this.txFromJSON<Result<u32>>,
        resolve_twap: this.txFromJSON<Result<Outcome>>,
        trade_status: this.txFromJSON<Result<TradeStatus>>,
        current_round: this.txFromJSON<u32>,
        expire_market: this.txFromJSON<Result<void>>,
        get_committee: this.txFromJSON<Result<Committee>>,
        open_fallback: this.txFromJSON<Result<void>>,
        pending_admin: this.txFromJSON<Option<PendingAdmin>>,
        preview_price: this.txFromJSON<Result<PriceData>>,
        propose_admin: this.txFromJSON<Result<void>>,
        resolve_price: this.txFromJSON<Result<Outcome>>,
        evidence_count: this.txFromJSON<u32>,
        expire_dispute: this.txFromJSON<Result<void>>,
        reclaim_bounty: this.txFromJSON<Result<i128>>,
        settle_dispute: this.txFromJSON<Result<void>>,
        snapshot_price: this.txFromJSON<Result<PriceData>>,
        cancel_proposal: this.txFromJSON<Result<void>>,
        cancel_rotation: this.txFromJSON<Result<void>>,
        evidence_config: this.txFromJSON<Option<readonly [string, EvidencePolicy]>>,
        create_committee: this.txFromJSON<Result<u64>>,
        execute_rotation: this.txFromJSON<Result<u32>>,
        finalize_signers: this.txFromJSON<Result<AttestedOutcome>>,
        guardian_options: this.txFromJSON<Array<GuardianReason>>,
        propose_rotation: this.txFromJSON<Result<u64>>,
        register_spec_v2: this.txFromJSON<Result<void>>,
        set_bounty_token: this.txFromJSON<Result<void>>,
        escalation_attest: this.txFromJSON<Result<void>>,
        resolve_price_for: this.txFromJSON<Result<Outcome>>,
        submit_signatures: this.txFromJSON<Result<void>>,
        claim_dispute_bond: this.txFromJSON<Result<void>>,
        register_twap_spec: this.txFromJSON<Result<void>>,
        pin_committee_epoch: this.txFromJSON<Result<readonly [u64, u32]>>,
        register_price_spec: this.txFromJSON<Result<void>>,
        resolution_deadline: this.txFromJSON<Result<u64>>,
        set_evidence_config: this.txFromJSON<Result<void>>,
        attest_with_evidence: this.txFromJSON<Result<void>>,
        committee_members_at: this.txFromJSON<Result<readonly [Array<string>, u32]>>,
        finalize_signers_for: this.txFromJSON<Result<AttestedOutcome>>,
        guardian_void_market: this.txFromJSON<Result<void>>,
        register_hybrid_spec: this.txFromJSON<Result<void>>,
        register_scalar_spec: this.txFromJSON<Result<void>>,
        register_signer_spec: this.txFromJSON<Result<void>>,
        resolve_scalar_price: this.txFromJSON<Result<u32>>,
        cancel_admin_transfer: this.txFromJSON<Result<void>>,
        market_committee_epoch: this.txFromJSON<Option<readonly [u64, u32]>>,
        accept_market_core_role: this.txFromJSON<null>,
        register_committee_spec: this.txFromJSON<Result<void>>,
        register_hybrid_v2_spec: this.txFromJSON<Result<void>>,
        register_cat_signer_spec: this.txFromJSON<Result<void>>,
        register_disputable_spec: this.txFromJSON<Result<void>>,
        register_scaled_price_spec: this.txFromJSON<Result<void>>,
        register_weighted_key_spec: this.txFromJSON<Result<void>>,
        consent_market_resolver_migrate: this.txFromJSON<Result<void>>
  }
}