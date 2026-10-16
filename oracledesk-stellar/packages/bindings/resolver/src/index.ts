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
  /**
   * `attest_cat` outcome index not below the committed `outcome_count`.
   */
  26: {message:"InvalidOutcomeIndex"}
}

/**
 * The escalation authority's ruling. `Invalid` voids the market.
 */
export type Verdict = {tag: "Yes", values: void} | {tag: "No", values: void} | {tag: "Invalid", values: void};


/**
 * Who rules on a dispute.
 */
export type Escalation = {tag: "Guardian", values: void} | {tag: "Committee", values: readonly [Array<string>, u32]};

/**
 * Which resolution path a market was on when it expired.
 */
export type ExpiryMode = {tag: "Unrevealed", values: void} | {tag: "Price", values: void} | {tag: "Signers", values: void} | {tag: "Scalar", values: void};

export type OracleAsset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


export interface PriceConfig {
  asset: OracleAsset;
  direction: PriceDirection;
  max_staleness: u64;
  reflector: string;
  threshold: i128;
}


export interface WeightedKey {
  /**
 * Raw Ed25519 public key. For a `G...` account address this is
 * `StrKey.decodeEd25519PublicKey(address)`; `C...` addresses have none.
 */
pubkey: Buffer;
  weight: u32;
}


export interface SignerConfig {
  dispute_window: u64;
  signers: Array<string>;
  threshold: u32;
}


export type PriceDirection = {tag: "Above", values: void} | {tag: "AtOrAbove", values: void} | {tag: "Below", values: void} | {tag: "AtOrBelow", values: void};

/**
 * The full resolution rule a market's `resolution_hash` commits to. Hashing
 * this (rather than the bare `PriceConfig`/`SignerConfig`) keeps the two
 * modes in disjoint hash spaces even if their field encodings could
 * otherwise collide. See `docs/adr/0001-resolution-commitment.md`.
 * 
 * Variants are append-only: the XDR tag is the variant position, so a new
 * mode goes at the end and existing commitments never move.
 */
export type ResolutionSpec = {tag: "Price", values: readonly [PriceConfig]} | {tag: "Signers", values: readonly [SignerConfig]} | {tag: "WeightedKeys", values: readonly [WeightedKeyConfig]} | {tag: "SignersDisputable", values: readonly [DisputableSignerConfig]} | {tag: "CategoricalSigners", values: readonly [CatSignerConfig]} | {tag: "Scalar", values: readonly [ScalarPriceConfig]};



/**
 * Categorical signer committee: like [`SignerConfig`], but signers attest one
 * outcome *index* of a categorical market instead of Yes/No. `outcome_count`
 * binds the market's outcome set to the commitment (2..=[`MAX_CAT_OUTCOMES`],
 * mirroring market-core's cap), so a reveal cannot silently change how many
 * outcomes signers are voting on.
 */
export interface CatSignerConfig {
  dispute_window: u64;
  outcome_count: u32;
  signers: Array<string>;
  threshold: u32;
}

export type ResolutionState = {tag: "Unconfigured", values: void} | {tag: "SignersPending", values: void} | {tag: "Finalized", values: void} | {tag: "Expired", values: void} | {tag: "Disputed", values: void};



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


export type Outcome = {tag: "Yes", values: void} | {tag: "No", values: void};

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
   * Construct and simulate a dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Challenges the current proposal of a `SignersDisputable` market while
   * its dispute window is still open (strictly before `proposed_at +
   * dispute_window`, the instant `finalize_signers` becomes callable). The
   * disputer escrows `dispute_bond` of the collateral token, which freezes
   * finalization until the escalation authority rules or
   * `escalation_timeout` lapses. `alternative` is the outcome the disputer
   * claims is correct (`None`: the market is invalid); it only informs the
   * ruling and must differ from the proposal. The disputer may also be a
   * proposing signer.
   */
  dispute: ({market_id, disputer, alternative}: {market_id: u64, disputer: string, alternative: Option<Outcome>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a finalize_cat transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Categorical counterpart of `finalize_signers`: once the dispute window
   * of a proposal has passed and its index still has `threshold`
   * attestations, resolves the market in market-core and returns the
   * winning index.
   */
  finalize_cat: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

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
   * Construct and simulate a resolve_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_price: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

  /**
   * Construct and simulate a expire_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless fallback when the escalation authority never rules:
   * `escalation_timeout` after the dispute opened, the bond is refunded and
   * the market is voided, so neither side wins by default.
   */
  expire_dispute: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian escalation: the admin rules on an open dispute.
   */
  settle_dispute: ({market_id, verdict}: {market_id: u64, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: withdraws an unfinalized signer proposal, e.g. because
   * evidence surfaced during the dispute window that it is wrong. For
   * address-based signers voting can restart once the counts are cleared by
   * re-attesting; a weighted-key market moves to a fresh round, which makes
   * every signature collected so far unusable. Works for both the binary
   * and the categorical proposal slot.
   */
  cancel_proposal: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a finalize_signers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  finalize_signers: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Outcome>>>

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
   * Construct and simulate a escalation_attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Committee escalation: each member votes once; the first verdict to
   * gather `k` votes settles the dispute.
   */
  escalation_attest: ({market_id, member, verdict}: {market_id: u64, member: string, verdict: Verdict}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a guardian_void_market transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Guardian action: voids an unresolvable market directly through
   * market-core. The resolver is the direct caller, so market-core's
   * `require_resolver` check passes the same way `resolve_price` does.
   */
  guardian_void_market: ({market_id}: {market_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a register_weighted_key_spec transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * See `register_price_spec` — same commit/reveal rule, weighted Ed25519
   * committee that signs off-chain and is verified by `submit_signatures`.
   */
  register_weighted_key_spec: ({market_id, spec}: {market_id: u64, spec: WeightedKeyConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAAAIAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAADAAAAAAAAABdNYXJrZXRBbHJlYWR5Q29uZmlndXJlZAAAAAAEAAAAAAAAABNNYXJrZXROb3RDb25maWd1cmVkAAAAAAUAAAAAAAAACVdyb25nTW9kZQAAAAAAAAYAAAAAAAAAD01hcmtldE5vdENsb3NlZAAAAAAHAAAAAAAAABBQcmljZVVuYXZhaWxhYmxlAAAACAAAAAAAAAAKU3RhbGVQcmljZQAAAAAACQAAAAAAAAAMSW52YWxpZFByaWNlAAAACgAAAAAAAAAJTm90U2lnbmVyAAAAAAAACwAAAAAAAAAPQWxyZWFkeUF0dGVzdGVkAAAAAAwAAAAAAAAAE1RocmVzaG9sZE5vdFJlYWNoZWQAAAAADQAAAAAAAAANRGlzcHV0ZUFjdGl2ZQAAAAAAAA4AAAAAAAAAEURpc3B1dGVXaW5kb3dPcGVuAAAAAAAADwAAAAAAAAAKTm9Qcm9wb3NhbAAAAAAAEAAAAAAAAAAQQWxyZWFkeUZpbmFsaXplZAAAABEAAAAAAAAAEFNwZWNIYXNoTWlzbWF0Y2gAAAASAAAAAAAAABJEZWFkbGluZU5vdFJlYWNoZWQAAAAAABMAAAAAAAAAE1Jlc29sdXRpb25BdmFpbGFibGUAAAAAFAAAAAAAAAAORG9tYWluTWlzbWF0Y2gAAAAAABUAAAAAAAAAClN0YWxlUm91bmQAAAAAABYAAAAAAAAAEVRvb01hbnlTaWduYXR1cmVzAAAAAAAAFwAAAAAAAAATRGlzcHV0ZVdpbmRvd0Nsb3NlZAAAAAAYAAAAAAAAAAlOb0Rpc3B1dGUAAAAAAAAZAAAAQ2BhdHRlc3RfY2F0YCBvdXRjb21lIGluZGV4IG5vdCBiZWxvdyB0aGUgY29tbWl0dGVkIGBvdXRjb21lX2NvdW50YC4AAAAAE0ludmFsaWRPdXRjb21lSW5kZXgAAAAAGg==",
        "AAAAAgAAAD5UaGUgZXNjYWxhdGlvbiBhdXRob3JpdHkncyBydWxpbmcuIGBJbnZhbGlkYCB2b2lkcyB0aGUgbWFya2V0LgAAAAAAAAAAAAdWZXJkaWN0AAAAAAMAAAAAAAAAAAAAAANZZXMAAAAAAAAAAAAAAAACTm8AAAAAAAAAAAAAAAAAB0ludmFsaWQA",
        "AAAABQAAAAAAAAAAAAAACERpc3B1dGVkAAAAAQAAAAhkaXNwdXRlZAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAARib25kAAAACwAAAAAAAABJV2hhdCB0aGUgZGlzcHV0ZXIgY2xhaW1zIGlzIGNvcnJlY3Q7IGBOb25lYCBjbGFpbXMgdGhlIG1hcmtldCBpcyBpbnZhbGlkLgAAAAAAAAthbHRlcm5hdGl2ZQAAAAPoAAAH0AAAAAdPdXRjb21lAAAAAAAAAAAC",
        "AAAAAgAAABdXaG8gcnVsZXMgb24gYSBkaXNwdXRlLgAAAAAAAAAACkVzY2FsYXRpb24AAAAAAAIAAAAAAAAALVRoZSByZXNvbHZlciBhZG1pbiwgdGhyb3VnaCBgc2V0dGxlX2Rpc3B1dGVgLgAAAAAAAAhHdWFyZGlhbgAAAAEAAABfYGtgIG9mIHRoZXNlIG1lbWJlcnMsIHRocm91Z2ggYGVzY2FsYXRpb25fYXR0ZXN0YC4gTXVzdCBiZSBkaXNqb2ludApmcm9tIHRoZSBwcm9wb3Npbmcgc2lnbmVycy4AAAAACUNvbW1pdHRlZQAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAgAAADZXaGljaCByZXNvbHV0aW9uIHBhdGggYSBtYXJrZXQgd2FzIG9uIHdoZW4gaXQgZXhwaXJlZC4AAAAAAAAAAAAKRXhwaXJ5TW9kZQAAAAAABAAAAAAAAAAAAAAAClVucmV2ZWFsZWQAAAAAAAAAAAAAAAAABVByaWNlAAAAAAAAAAAAAAAAAAAHU2lnbmVycwAAAAAAAAAAKVNjYWxhciBjb3VudGVycGFydCBvZiBgUHJpY2VgIChhcHBlbmRlZCkuAAAAAAAABlNjYWxhcgAA",
        "AAAAAgAAAAAAAAAAAAAAC09yYWNsZUFzc2V0AAAAAAIAAAABAAAAAAAAAAdTdGVsbGFyAAAAAAEAAAATAAAAAQAAAAAAAAAFT3RoZXIAAAAAAAABAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1ByaWNlQ29uZmlnAAAAAAUAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAtPcmFjbGVBc3NldAAAAAAAAAAACWRpcmVjdGlvbgAAAAAAB9AAAAAOUHJpY2VEaXJlY3Rpb24AAAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAACXJlZmxlY3RvcgAAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAC1dlaWdodGVkS2V5AAAAAAIAAACCUmF3IEVkMjU1MTkgcHVibGljIGtleS4gRm9yIGEgYEcuLi5gIGFjY291bnQgYWRkcmVzcyB0aGlzIGlzCmBTdHJLZXkuZGVjb2RlRWQyNTUxOVB1YmxpY0tleShhZGRyZXNzKWA7IGBDLi4uYCBhZGRyZXNzZXMgaGF2ZSBub25lLgAAAAAABnB1YmtleQAAAAAD7gAAACAAAAAAAAAABndlaWdodAAAAAAABA==",
        "AAAAAQAAAAAAAAAAAAAADFNpZ25lckNvbmZpZwAAAAMAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAAAAAAAl0aHJlc2hvbGQAAAAAAAAE",
        "AAAABQAAAAAAAAAAAAAADU1hcmtldEV4cGlyZWQAAAAAAAABAAAADm1hcmtldF9leHBpcmVkAAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAKY2xvc2VfdGltZQAAAAAABgAAAAAAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAAAAAABG1vZGUAAAfQAAAACkV4cGlyeU1vZGUAAAAAAAAAAAAC",
        "AAAAAgAAAAAAAAAAAAAADlByaWNlRGlyZWN0aW9uAAAAAAAEAAAAAAAAAAAAAAAFQWJvdmUAAAAAAAAAAAAAAAAAAAlBdE9yQWJvdmUAAAAAAAAAAAAAAAAAAAVCZWxvdwAAAAAAAAAAAAAAAAAACUF0T3JCZWxvdwAAAA==",
        "AAAAAgAAAZZUaGUgZnVsbCByZXNvbHV0aW9uIHJ1bGUgYSBtYXJrZXQncyBgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvLiBIYXNoaW5nCnRoaXMgKHJhdGhlciB0aGFuIHRoZSBiYXJlIGBQcmljZUNvbmZpZ2AvYFNpZ25lckNvbmZpZ2ApIGtlZXBzIHRoZSB0d28KbW9kZXMgaW4gZGlzam9pbnQgaGFzaCBzcGFjZXMgZXZlbiBpZiB0aGVpciBmaWVsZCBlbmNvZGluZ3MgY291bGQKb3RoZXJ3aXNlIGNvbGxpZGUuIFNlZSBgZG9jcy9hZHIvMDAwMS1yZXNvbHV0aW9uLWNvbW1pdG1lbnQubWRgLgoKVmFyaWFudHMgYXJlIGFwcGVuZC1vbmx5OiB0aGUgWERSIHRhZyBpcyB0aGUgdmFyaWFudCBwb3NpdGlvbiwgc28gYSBuZXcKbW9kZSBnb2VzIGF0IHRoZSBlbmQgYW5kIGV4aXN0aW5nIGNvbW1pdG1lbnRzIG5ldmVyIG1vdmUuAAAAAAAAAAAADlJlc29sdXRpb25TcGVjAAAAAAAGAAAAAQAAAAAAAAAFUHJpY2UAAAAAAAABAAAH0AAAAAtQcmljZUNvbmZpZwAAAAABAAAAAAAAAAdTaWduZXJzAAAAAAEAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAAAAAAADFdlaWdodGVkS2V5cwAAAAEAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAAAAAAAARU2lnbmVyc0Rpc3B1dGFibGUAAAAAAAABAAAH0AAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAABAAAAN0NhdGVnb3JpY2FsIGNvdW50ZXJwYXJ0IG9mIGBTaWduZXJzYCAoYXBwZW5kZWQsIHRhZyA0KS4AAAAAEkNhdGVnb3JpY2FsU2lnbmVycwAAAAAAAQAAB9AAAAAPQ2F0U2lnbmVyQ29uZmlnAAAAAAEAAAB3U2NhbGFyIGNvdW50ZXJwYXJ0IG9mIGBQcmljZWAgKGFwcGVuZGVkLCB0YWcgNSk6IHRoZSBiaW5hcnkgcG9vbApzZXR0bGVzIGF0IGEgZnJhY3Rpb25hbCBMT05HIHBheW91dCBpbnN0ZWFkIG9mIGEgc2lkZS4AAAAABlNjYWxhcgAAAAAAAQAAB9AAAAARU2NhbGFyUHJpY2VDb25maWcAAAA=",
        "AAAABQAAAVlgZGlzcHV0ZXJfd29uYCBpcyB0cnVlIHdoZW4gdGhlIGJvbmQgcmV0dXJucyB0byB0aGUgZGlzcHV0ZXIgYmVjYXVzZSB0aGUKcnVsaW5nIG92ZXJ0dXJuZWQgdGhlIHByb3Bvc2FsLiBBIHRpbWVvdXQgKGBleHBpcmVfZGlzcHV0ZWApIGFsc28gcmVmdW5kcwp0aGUgYm9uZCBidXQgaXMgcmVwb3J0ZWQgYXMgYHZlcmRpY3Q6IEludmFsaWQsIGRpc3B1dGVyX3dvbjogZmFsc2VgOiBhCnJ1bGluZyBvZiBgSW52YWxpZGAgYWx3YXlzIG92ZXJ0dXJucywgc28gdGhhdCBwYWlyIGlkZW50aWZpZXMgYSB0aW1lb3V0LgpgcGF5b3V0YCBpcyB0aGUgZXNjcm93ZWQgYm9uZCwgY2xhaW1hYmxlIGJ5IGl0cyBwYXllZS4AAAAAAAAAAAAADkRpc3B1dGVTZXR0bGVkAAAAAAABAAAAD2Rpc3B1dGVfc2V0dGxlZAAAAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAAAAAAAAAAAMZGlzcHV0ZXJfd29uAAAAAQAAAAAAAAAAAAAABnBheW91dAAAAAAACwAAAAAAAAAC",
        "AAAAAQAAAUxDYXRlZ29yaWNhbCBzaWduZXIgY29tbWl0dGVlOiBsaWtlIFtgU2lnbmVyQ29uZmlnYF0sIGJ1dCBzaWduZXJzIGF0dGVzdCBvbmUKb3V0Y29tZSAqaW5kZXgqIG9mIGEgY2F0ZWdvcmljYWwgbWFya2V0IGluc3RlYWQgb2YgWWVzL05vLiBgb3V0Y29tZV9jb3VudGAKYmluZHMgdGhlIG1hcmtldCdzIG91dGNvbWUgc2V0IHRvIHRoZSBjb21taXRtZW50ICgyLi49W2BNQVhfQ0FUX09VVENPTUVTYF0sCm1pcnJvcmluZyBtYXJrZXQtY29yZSdzIGNhcCksIHNvIGEgcmV2ZWFsIGNhbm5vdCBzaWxlbnRseSBjaGFuZ2UgaG93IG1hbnkKb3V0Y29tZXMgc2lnbmVycyBhcmUgdm90aW5nIG9uLgAAAAAAAAAPQ2F0U2lnbmVyQ29uZmlnAAAAAAQAAAAAAAAADmRpc3B1dGVfd2luZG93AAAAAAAGAAAAAAAAAA1vdXRjb21lX2NvdW50AAAAAAAABAAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAAAgAAAAAAAAAAAAAAD1Jlc29sdXRpb25TdGF0ZQAAAAAFAAAAAAAAAAAAAAAMVW5jb25maWd1cmVkAAAAAAAAAAAAAAAOU2lnbmVyc1BlbmRpbmcAAAAAAAAAAAAAAAAACUZpbmFsaXplZAAAAAAAAAAAAABEVm9pZGVkIGJ5IFtgUmVzb2x2ZXI6OmV4cGlyZV9tYXJrZXRgXSBhZnRlciB0aGUgcmVzb2x1dGlvbiBkZWFkbGluZS4AAAAHRXhwaXJlZAAAAAAAAAAAQkEgYm9uZGVkIGRpc3B1dGUgaXMgb3BlbjsgZmluYWxpemF0aW9uIGlzIGZyb3plbiB1bnRpbCBpdCBzZXR0bGVzLgAAAAAACERpc3B1dGVk",
        "AAAABQAAAAAAAAAAAAAAD1ByaWNlUmVzb2x1dGlvbgAAAAABAAAAEHByaWNlX3Jlc29sdXRpb24AAAAEAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAAAAAAPcHJpY2VfdGltZXN0YW1wAAAAAAYAAAAAAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAg==",
        "AAAAAQAAAOBWZXJzaW9uZWQgY29tbWl0bWVudCBlbnZlbG9wZS4gVW5saWtlIGEgYmFyZSBbYFJlc29sdXRpb25TcGVjYF0gaXQgYmluZHMgdGhlCm5ldHdvcmsgYW5kIHRoZSBtYXJrZXQtY29yZSBpbnN0YW5jZSwgYW5kIGNhcnJpZXMgYSBjcmVhdG9yLWNob3NlbiBgc2FsdGAKdGhhdCBtYWtlcyBhIHByZS1yZXZlYWwgYnJ1dGUtZm9yY2Ugb2YgdGhlIChsb3ctZW50cm9weSkgcnVsZSBpbmZlYXNpYmxlLgAAAAAAAAAQUmVzb2x1dGlvblNwZWNWMgAAAAUAAAAAAAAAC21hcmtldF9jb3JlAAAAABMAAAA/YHNoYTI1NihuZXR3b3JrIHBhc3NwaHJhc2UpYCwgaS5lLiBgZW52LmxlZGdlcigpLm5ldHdvcmtfaWQoKWAuAAAAAApuZXR3b3JrX2lkAAAAAAPuAAAAIAAAAAAAAAAEcnVsZQAAB9AAAAAOUmVzb2x1dGlvblNwZWMAAAAAAAAAAAAEc2FsdAAAA+4AAAAgAAAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAX9TY2FsYXIgKHJhbmdlKSBjb3VudGVycGFydCBvZiBbYFByaWNlQ29uZmlnYF0uIFRoZSBtYXJrZXQgc2V0dGxlcyBvbiB0aGUKZnJhY3Rpb25hbCBwb3NpdGlvbiBvZiBgcHJpY2VgIGluc2lkZSBgW2xvd2VyLCB1cHBlcl1gOgpgcGF5b3V0X2xvbmdfYnBzID0gKGNsYW1wZWRfcHJpY2UgLSBsb3dlcikgLyAodXBwZXIgLSBsb3dlcilgLCBhbmQgdGhlClNIT1JUIHNpZGUgcGF5cyB0aGUgY29tcGxlbWVudC4gQSByZWFkaW5nIGJlbG93IHRoZSByYW5nZSBjbGFtcHMgdG8KYGxvd2VyYCAoTE9ORyBwYXlzIDApLCBhYm92ZSB0byBgdXBwZXJgIChMT05HIHBheXMgMS4wKTsgYSBub24tcG9zaXRpdmUKcmVhZGluZyBpcyBhbiBpbnZhbGlkIHByaWNlLCBuZXZlciBhIGNsYW1wLgAAAAAAAAAAEVNjYWxhclByaWNlQ29uZmlnAAAAAAAABQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAAC09yYWNsZUFzc2V0AAAAAHFCb3R0b20gb2YgdGhlIHN0YWtlZCByYW5nZS4gVmFsaWRhdGVkIGAwIDw9IGxvd2VyIDwgdXBwZXJgLCB3aXRoCmB1cHBlcmAgY2FwcGVkIHNvIGB1cHBlciAqIEJQU2AgY2Fubm90IG92ZXJmbG93LgAAAAAAAAVsb3dlcgAAAAAAAAsAAAAAAAAADW1heF9zdGFsZW5lc3MAAAAAAAAGAAAAAAAAAAlyZWZsZWN0b3IAAAAAAAATAAAAAAAAAAV1cHBlcgAAAAAAAAs=",
        "AAAAAQAAAAAAAAAAAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAAB3NpZ25lcnMAAAAD6gAAB9AAAAALV2VpZ2h0ZWRLZXkAAAAAd1RvdGFsIHdlaWdodCB0aGF0IG11c3Qgc2lnbiBvbmUgb3V0Y29tZS4gQ2hvb3NlIGl0IGFib3ZlIGhhbGYgdGhlIHRvdGFsCndlaWdodCBzbyB0d28gb3V0Y29tZXMgY2FuIG5ldmVyIGJvdGggcmVhY2ggaXQuAAAAABB3ZWlnaHRfdGhyZXNob2xkAAAABA==",
        "AAAABQAAAAAAAAAAAAAAElJlc29sdXRpb25Qcm9wb3NlZAAAAAAAAQAAABNyZXNvbHV0aW9uX3Byb3Bvc2VkAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAtwcm9wb3NlZF9hdAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE1Jlc29sdXRpb25GaW5hbGl6ZWQAAAAAAQAAABRyZXNvbHV0aW9uX2ZpbmFsaXplZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAdvdXRjb21lAAAAB9AAAAAHT3V0Y29tZQAAAAAAAAAAAAAAAAxmaW5hbGl6ZWRfYXQAAAAGAAAAAAAAAAI=",
        "AAAABQAAADBDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgUmVzb2x1dGlvblByb3Bvc2VkYC4AAAAAAAAAFUNhdFJlc29sdXRpb25Qcm9wb3NlZAAAAAAAAAEAAAAXY2F0X3Jlc29sdXRpb25fcHJvcG9zZWQAAAAAAwAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAAAAAAADW91dGNvbWVfaW5kZXgAAAAAAAAEAAAAAAAAAAAAAAALcHJvcG9zZWRfYXQAAAAABgAAAAAAAAAC",
        "AAAABQAAAG9TY2FsYXIgY291bnRlcnBhcnQgb2YgYFByaWNlUmVzb2x1dGlvbmA6IHRoZSBzZXR0bGVkIG1hcmtldCBjYXJyaWVzIGEKZnJhY3Rpb25hbCBMT05HIHBheW91dCBpbnN0ZWFkIG9mIGEgc2lkZS4AAAAAAAAAABVTY2FsYXJQcmljZVJlc29sdXRpb24AAAAAAAABAAAAF3NjYWxhcl9wcmljZV9yZXNvbHV0aW9uAAAAAAQAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAAAAAAAA9wcmljZV90aW1lc3RhbXAAAAAABgAAAAAAAAAAAAAAD3BheW91dF9sb25nX2JwcwAAAAAEAAAAAAAAAAI=",
        "AAAAAQAAANBBdHRlc3RlZCByZXNvbHV0aW9uIHdob3NlIHByb3Bvc2FsIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIGR1cmluZwp0aGUgZGlzcHV0ZSB3aW5kb3cuIEhhc2hlZCBhcyBgUmVzb2x1dGlvblNwZWM6OlNpZ25lcnNEaXNwdXRhYmxlYCwgYQpzZXBhcmF0ZSB2YXJpYW50LCBzbyBleGlzdGluZyBgU2lnbmVyc2AgY29tbWl0bWVudHMgYXJlIHVuYWZmZWN0ZWQuAAAAAAAAABZEaXNwdXRhYmxlU2lnbmVyQ29uZmlnAAAAAAAGAAAAM0NvbGxhdGVyYWwgZXNjcm93ZWQgYnkgYGRpc3B1dGVgOyBtdXN0IGJlIHBvc2l0aXZlLgAAAAAMZGlzcHV0ZV9ib25kAAAACwAAAAAAAAAOZGlzcHV0ZV93aW5kb3cAAAAAAAYAAAAAAAAACmVzY2FsYXRpb24AAAAAB9AAAAAKRXNjYWxhdGlvbgAAAAAAQ1NlY29uZHMgYWZ0ZXIgYSBkaXNwdXRlIG9wZW5zIGJlZm9yZSBhbnlvbmUgbWF5IHZvaWQgaXQgdW5yZXNvbHZlZC4AAAAAEmVzY2FsYXRpb25fdGltZW91dAAAAAAABgAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAABQAAADFDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgUmVzb2x1dGlvbkZpbmFsaXplZGAuAAAAAAAAAAAAABZDYXRSZXNvbHV0aW9uRmluYWxpemVkAAAAAAABAAAAGGNhdF9yZXNvbHV0aW9uX2ZpbmFsaXplZAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAAAAAAAA1vdXRjb21lX2luZGV4AAAAAAAABAAAAAAAAAAAAAAADGZpbmFsaXplZF9hdAAAAAYAAAAAAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAAB091dGNvbWUAAAAAAgAAAAAAAAAAAAAAA1llcwAAAAAAAAAAAAAAAAJObwAA",
        "AAAAAAAAAAAAAAAFc3RhdGUAAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAB9AAAAAPUmVzb2x1dGlvblN0YXRlAA==",
        "AAAAAAAAAAAAAAAGYXR0ZXN0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAAB291dGNvbWUAAAAH0AAAAAdPdXRjb21lAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAi5DaGFsbGVuZ2VzIHRoZSBjdXJyZW50IHByb3Bvc2FsIG9mIGEgYFNpZ25lcnNEaXNwdXRhYmxlYCBtYXJrZXQgd2hpbGUKaXRzIGRpc3B1dGUgd2luZG93IGlzIHN0aWxsIG9wZW4gKHN0cmljdGx5IGJlZm9yZSBgcHJvcG9zZWRfYXQgKwpkaXNwdXRlX3dpbmRvd2AsIHRoZSBpbnN0YW50IGBmaW5hbGl6ZV9zaWduZXJzYCBiZWNvbWVzIGNhbGxhYmxlKS4gVGhlCmRpc3B1dGVyIGVzY3Jvd3MgYGRpc3B1dGVfYm9uZGAgb2YgdGhlIGNvbGxhdGVyYWwgdG9rZW4sIHdoaWNoIGZyZWV6ZXMKZmluYWxpemF0aW9uIHVudGlsIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBydWxlcyBvcgpgZXNjYWxhdGlvbl90aW1lb3V0YCBsYXBzZXMuIGBhbHRlcm5hdGl2ZWAgaXMgdGhlIG91dGNvbWUgdGhlIGRpc3B1dGVyCmNsYWltcyBpcyBjb3JyZWN0IChgTm9uZWA6IHRoZSBtYXJrZXQgaXMgaW52YWxpZCk7IGl0IG9ubHkgaW5mb3JtcyB0aGUKcnVsaW5nIGFuZCBtdXN0IGRpZmZlciBmcm9tIHRoZSBwcm9wb3NhbC4gVGhlIGRpc3B1dGVyIG1heSBhbHNvIGJlIGEKcHJvcG9zaW5nIHNpZ25lci4AAAAAAAdkaXNwdXRlAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAALYWx0ZXJuYXRpdmUAAAAD6AAAB9AAAAAHT3V0Y29tZQAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAARBDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgYXR0ZXN0YDogYHNpZ25lcmAgYXR0ZXN0cyB0aGF0CmBvdXRjb21lX2luZGV4YCBpcyB0aGUgd2lubmVyLiBgb3V0Y29tZV9pbmRleGAgbXVzdCBiZSBiZWxvdyB0aGUKYG91dGNvbWVfY291bnRgIHRoZSBtYXJrZXQncyBjb21taXRtZW50IGZpeGVkLiBPbmNlIGB0aHJlc2hvbGRgCm1lbWJlcnMgaGF2ZSBhdHRlc3RlZCBhbiBpbmRleCBpdCBiZWNvbWVzIHRoZSBwcm9wb3NhbCBhbmQgdGhlCmRpc3B1dGUgd2luZG93IG9wZW5zLgAAAAphdHRlc3RfY2F0AAAAAAADAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAADW91dGNvbWVfaW5kZXgAAAAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAANNDYXRlZ29yaWNhbCBjb3VudGVycGFydCBvZiBgZmluYWxpemVfc2lnbmVyc2A6IG9uY2UgdGhlIGRpc3B1dGUgd2luZG93Cm9mIGEgcHJvcG9zYWwgaGFzIHBhc3NlZCBhbmQgaXRzIGluZGV4IHN0aWxsIGhhcyBgdGhyZXNob2xkYAphdHRlc3RhdGlvbnMsIHJlc29sdmVzIHRoZSBtYXJrZXQgaW4gbWFya2V0LWNvcmUgYW5kIHJldHVybnMgdGhlCndpbm5pbmcgaW5kZXguAAAAAAxmaW5hbGl6ZV9jYXQAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALbWFya2V0X2NvcmUAAAAAEwAAAAA=",
        "AAAAAAAAAIFDdXJyZW50IGF0dGVzdGF0aW9uIHJvdW5kIG9mIGEgd2VpZ2h0ZWQta2V5IG1hcmtldDsgdGhlIGByb3VuZGAKYXJndW1lbnQgb2YgYHN1Ym1pdF9zaWduYXR1cmVzYCBhbmQgcGFydCBvZiBldmVyeSBzaWduZWQgbWVzc2FnZS4AAAAAAAANY3VycmVudF9yb3VuZAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAABA==",
        "AAAAAAAAAfhQZXJtaXNzaW9ubGVzcyBsaXZlbmVzcyBmYWxsYmFjazogb25jZSBgcmVzb2x1dGlvbl9kZWFkbGluZWAgaGFzIHBhc3NlZCwKYW55b25lIG1heSB2b2lkIGEgbWFya2V0IHRoYXQgaXMgc3RpbGwgdW5yZXNvbHZlZCwgc28gY29sbGF0ZXJhbCBpcwpuZXZlciBsb2NrZWQgYmVoaW5kIGEgbWlzc2luZyByZXZlYWwsIGEgZGVhZCBmZWVkIG9yIHNpbGVudCBzaWduZXJzLgoKUmVzb2x1dGlvbiBpcyBwcmVmZXJyZWQgb3ZlciB2b2lkaW5nLiBBIHByaWNlIG1hcmtldCB3aG9zZSBmZWVkIGlzCnZhbGlkIHJpZ2h0IG5vdyBpcyAqcmVzb2x2ZWQqIGluc3RlYWQgKHNvIGEgc3RhbGxlZCBjYWxsZXIgY2FuIG5ldmVyCmZvcmNlIGEgdm9pZCBvbiBhIHJlc29sdmFibGUgbWFya2V0KSwgYW5kIGEgbWFya2V0IHdpdGggYSBwZW5kaW5nCnNpZ25lciBvciBjYXRlZ29yaWNhbCBwcm9wb3NhbCBpcyByZWZ1c2VkIHdpdGggYFJlc29sdXRpb25BdmFpbGFibGVgCnVudGlsIGl0IGlzIGZpbmFsaXplZC4AAAANZXhwaXJlX21hcmtldAAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANcmVzb2x2ZV9wcmljZQAAAAAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAAAAAAAMFQZXJtaXNzaW9ubGVzcyBmYWxsYmFjayB3aGVuIHRoZSBlc2NhbGF0aW9uIGF1dGhvcml0eSBuZXZlciBydWxlczoKYGVzY2FsYXRpb25fdGltZW91dGAgYWZ0ZXIgdGhlIGRpc3B1dGUgb3BlbmVkLCB0aGUgYm9uZCBpcyByZWZ1bmRlZCBhbmQKdGhlIG1hcmtldCBpcyB2b2lkZWQsIHNvIG5laXRoZXIgc2lkZSB3aW5zIGJ5IGRlZmF1bHQuAAAAAAAADmV4cGlyZV9kaXNwdXRlAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADhHdWFyZGlhbiBlc2NhbGF0aW9uOiB0aGUgYWRtaW4gcnVsZXMgb24gYW4gb3BlbiBkaXNwdXRlLgAAAA5zZXR0bGVfZGlzcHV0ZQAAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAYFHdWFyZGlhbiBhY3Rpb246IHdpdGhkcmF3cyBhbiB1bmZpbmFsaXplZCBzaWduZXIgcHJvcG9zYWwsIGUuZy4gYmVjYXVzZQpldmlkZW5jZSBzdXJmYWNlZCBkdXJpbmcgdGhlIGRpc3B1dGUgd2luZG93IHRoYXQgaXQgaXMgd3JvbmcuIEZvcgphZGRyZXNzLWJhc2VkIHNpZ25lcnMgdm90aW5nIGNhbiByZXN0YXJ0IG9uY2UgdGhlIGNvdW50cyBhcmUgY2xlYXJlZCBieQpyZS1hdHRlc3Rpbmc7IGEgd2VpZ2h0ZWQta2V5IG1hcmtldCBtb3ZlcyB0byBhIGZyZXNoIHJvdW5kLCB3aGljaCBtYWtlcwpldmVyeSBzaWduYXR1cmUgY29sbGVjdGVkIHNvIGZhciB1bnVzYWJsZS4gV29ya3MgZm9yIGJvdGggdGhlIGJpbmFyeQphbmQgdGhlIGNhdGVnb3JpY2FsIHByb3Bvc2FsIHNsb3QuAAAAAAAAD2NhbmNlbF9wcm9wb3NhbAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAQZmluYWxpemVfc2lnbmVycwAAAAEAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHT3V0Y29tZQAAAAAD",
        "AAAAAAAAAWlSZXZlYWxzIGEgcnVsZSBjb21taXR0ZWQgdG8gdGhyb3VnaCBhIFtgUmVzb2x1dGlvblNwZWNWMmBdIGVudmVsb3BlLgpUaGUgZW52ZWxvcGUgbXVzdCBuYW1lIHRoaXMgbmV0d29yayBhbmQgdGhpcyByZXNvbHZlcidzIG1hcmtldC1jb3JlCihgRG9tYWluTWlzbWF0Y2hgKSwgdXNlIGEgbm9uLXplcm8gc2FsdCBhbmQgdGhlIGN1cnJlbnQgYHZlcnNpb25gCihgSW52YWxpZENvbmZpZ2ApLCBhbmQgaGFzaCB0byB0aGUgbWFya2V0J3MgY29tbWl0bWVudAooYFNwZWNIYXNoTWlzbWF0Y2hgKS4gVGhlIGlubmVyIHJ1bGUgaXMgdGhlbiB2YWxpZGF0ZWQgYW5kIHN0b3JlZApleGFjdGx5IGFzIHRoZSBsZWdhY3kgZW50cnlwb2ludHMgZG8uAAAAAAAAEHJlZ2lzdGVyX3NwZWNfdjIAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzcGVjAAAH0AAAABBSZXNvbHV0aW9uU3BlY1YyAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAGhDb21taXR0ZWUgZXNjYWxhdGlvbjogZWFjaCBtZW1iZXIgdm90ZXMgb25jZTsgdGhlIGZpcnN0IHZlcmRpY3QgdG8KZ2F0aGVyIGBrYCB2b3RlcyBzZXR0bGVzIHRoZSBkaXNwdXRlLgAAABFlc2NhbGF0aW9uX2F0dGVzdAAAAAAAAAMAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABm1lbWJlcgAAAAAAEwAAAAAAAAAHdmVyZGljdAAAAAfQAAAAB1ZlcmRpY3QAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAhRDb3VudHMgRWQyNTUxOSBzaWduYXR1cmVzIGZyb20gYSB3ZWlnaHRlZCBjb21taXR0ZWUuIFBlcm1pc3Npb25sZXNzOiB0aGUKc2lnbmF0dXJlcywgbm90IHRoZSBzdWJtaXR0ZXIsIGNhcnJ5IHRoZSBhdXRob3JpdHkuIEVhY2ggc2lnbmF0dXJlIGlzCm92ZXIgdGhlIG1lc3NhZ2UgYnVpbHQgYnkgYGF0dGVzdGF0aW9uX21lc3NhZ2VgOyBub24tbWVtYmVycyBhbmQga2V5cwp0aGF0IGFscmVhZHkgc2lnbmVkIHRoaXMgcm91bmQgKGZvciBlaXRoZXIgb3V0Y29tZSkgYXJlIHNraXBwZWQsIGFuZCBhCnNpbmdsZSBpbnZhbGlkIHNpZ25hdHVyZSBhYm9ydHMgdGhlIHdob2xlIGJhdGNoLCBzbyBzdWJtaXR0ZXJzIHNob3VsZApwcmUtZmlsdGVyIHdpdGggYSB2ZXJpZmllci4gT25jZSB0aGUgYWNjdW11bGF0ZWQgd2VpZ2h0IGZvciBgb3V0Y29tZWAKZmlyc3QgcmVhY2hlcyB0aGUgdGhyZXNob2xkIGEgcHJvcG9zYWwgaXMgcmVjb3JkZWQgYW5kIHRoZSBkaXNwdXRlCndpbmRvdyBzdGFydHM7IGxhdGVyIGNhbGxzIG5ldmVyIG1vdmUgaXQuAAAAEXN1Ym1pdF9zaWduYXR1cmVzAAAAAAAABAAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAHb3V0Y29tZQAAAAfQAAAAB091dGNvbWUAAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAABHNpZ3MAAAPqAAAD7QAAAAIAAAPuAAAAIAAAA+4AAABAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAIRQYXlzIGEgc2V0dGxlZCBkaXNwdXRlJ3MgYm9uZCB0byBpdHMgcGF5ZWUgKHRoZSBkaXNwdXRlciwgb3IgdGhlCm1hcmtldC1jb3JlIHRyZWFzdXJ5IHdoZW4gdGhlIHByb3Bvc2FsIHdhcyB1cGhlbGQpLiBQZXJtaXNzaW9ubGVzcy4AAAASY2xhaW1fZGlzcHV0ZV9ib25kAAAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAATpSZXZlYWxzIHRoZSByZXNvbHV0aW9uIHJ1bGUgY29tbWl0dGVkIHRvIGF0IG1hcmtldCBjcmVhdGlvbi4gQW55b25lCm1heSBjYWxsIHRoaXMgKHRoZXJlIGlzIG5vIGFkbWluIGdhdGUpIGJlY2F1c2UgdGhlIG9ubHkgdGhpbmcgdGhhdAptYWtlcyBhIHNwZWMgYWNjZXB0YWJsZSBpcyB0aGF0IGl0IGhhc2hlcyB0byBgbWFya2V0LnJlc29sdXRpb25faGFzaGAK4oCUIHRoZSBjb21taXRtZW50LCBub3QgdGhlIGNhbGxlciwgaXMgdGhlIGF1dGhvcml0eS4gRmFpbHMgaWYgYSBzcGVjCndhcyBhbHJlYWR5IHJlZ2lzdGVyZWQgZm9yIHRoaXMgbWFya2V0LgAAAAAAE3JlZ2lzdGVyX3ByaWNlX3NwZWMAAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAALUHJpY2VDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAANVXaGVuIGBleHBpcmVfbWFya2V0YCBiZWNvbWVzIGNhbGxhYmxlIGZvciBgbWFya2V0X2lkYDogYGNsb3NlX3RpbWVgIHBsdXMKW2BSRVNPTFVUSU9OX0dSQUNFX1NFQ1NgXS4gTmVlZHMgb25seSBtYXJrZXQtY29yZSdzIGBjbG9zZV90aW1lYCwgc28gaXQKaXMga25vd24gYmVmb3JlIChhbmQgd2l0aG91dCkgYSBzcGVjIHJldmVhbCwgZm9yIGVpdGhlciBtYXJrZXQga2luZC4AAAAAAAATcmVzb2x1dGlvbl9kZWFkbGluZQAAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAMJHdWFyZGlhbiBhY3Rpb246IHZvaWRzIGFuIHVucmVzb2x2YWJsZSBtYXJrZXQgZGlyZWN0bHkgdGhyb3VnaAptYXJrZXQtY29yZS4gVGhlIHJlc29sdmVyIGlzIHRoZSBkaXJlY3QgY2FsbGVyLCBzbyBtYXJrZXQtY29yZSdzCmByZXF1aXJlX3Jlc29sdmVyYCBjaGVjayBwYXNzZXMgdGhlIHNhbWUgd2F5IGByZXNvbHZlX3ByaWNlYCBkb2VzLgAAAAAAFGd1YXJkaWFuX3ZvaWRfbWFya2V0AAAAAQAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAALNTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2NhbGFyIG1vZGU6CnRoZSBtYXJrZXQgc2V0dGxlcyBmcmFjdGlvbmFsbHkgZnJvbSB0aGUgZmVlZCBwcmljZSBjbGFtcGVkIGludG8KYFtsb3dlciwgdXBwZXJdYCAoc2VlIGByZXNvbHZlX3NjYWxhcl9wcmljZWApLgAAAAAUcmVnaXN0ZXJfc2NhbGFyX3NwZWMAAAACAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAAAAAARzcGVjAAAH0AAAABFTY2FsYXJQcmljZUNvbmZpZwAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAENTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUuAAAAABRyZWdpc3Rlcl9zaWduZXJfc3BlYwAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAADFNpZ25lckNvbmZpZwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAdJSZXNvbHZlcyBhIHNjYWxhciBtYXJrZXQgZnJvbSBpdHMgUmVmbGVjdG9yIGZlZWQuIFRoZSByZWFkaW5nIGlzCmNsYW1wZWQgaW50byB0aGUgY29tbWl0dGVkIGBbbG93ZXIsIHVwcGVyXWAgcmFuZ2UgYW5kIHNldHRsZWQgYXMgdGhlCmZyYWN0aW9uYWwgTE9ORyBwYXlvdXQgYChjbGFtcGVkIC0gbG93ZXIpIC8gKHVwcGVyIC0gbG93ZXIpYCBpbiBicHMKKFNIT1JUIHBheXMgdGhlIGNvbXBsZW1lbnQpLiBSZXR1cm5zIHRoZSBwYXlvdXQuCgpBIG5vbi1wb3NpdGl2ZSByZWFkaW5nIGlzIGBJbnZhbGlkUHJpY2VgIHJhdGhlciB0aGFuIGEgY2xhbXA6IGl0IG1lYW5zCnRoZSBmZWVkIGlzIGJyb2tlbiwgbm90IHRoYXQgdGhlIHZhbHVlIHNpdHMgYXQgdGhlIGJvdHRvbSBvZiB0aGUKcmFuZ2UuIFNhbWUgY2xvc2UtdGltZSwgc3RhbGVuZXNzIGFuZCB0ZXJtaW5hbC1zdGF0ZSBydWxlcyBhcwpgcmVzb2x2ZV9wcmljZWAuAAAAAAAUcmVzb2x2ZV9zY2FsYXJfcHJpY2UAAAABAAAAAAAAAAltYXJrZXRfaWQAAAAAAAAGAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAATZTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgY2F0ZWdvcmljYWwKb3V0Y29tZS1pbmRleCBjb21taXR0ZWUuIE9ubHkgbWVhbmluZ2Z1bCBmb3IgbWFya2V0cyB3aG9zZQpgcmVzb2x1dGlvbl9oYXNoYCBjb21taXRzIHRvIGBSZXNvbHV0aW9uU3BlYzo6Q2F0ZWdvcmljYWxTaWduZXJzYCB3aXRoCnRoaXMgZXhhY3QgYG91dGNvbWVfY291bnRgOyB0aGUgcmV2ZWFsIHRhcmdldCdzIGByZXNvbHV0aW9uX2hhc2hgIGlzCnJlYWQgZnJvbSB3aGljaGV2ZXIgbWFya2V0IGtpbmQgb3ducyB0aGUgaWQuAAAAAAAYcmVnaXN0ZXJfY2F0X3NpZ25lcl9zcGVjAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAPQ2F0U2lnbmVyQ29uZmlnAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAIFTZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgc2lnbmVyIG1vZGUgd2hvc2UKcHJvcG9zYWxzIGNhbiBiZSBjaGFsbGVuZ2VkIHdpdGggYSBib25kIChzZWUgYGRpc3B1dGVgKS4AAAAAAAAYcmVnaXN0ZXJfZGlzcHV0YWJsZV9zcGVjAAAAAgAAAAAAAAAJbWFya2V0X2lkAAAAAAAABgAAAAAAAAAEc3BlYwAAB9AAAAAWRGlzcHV0YWJsZVNpZ25lckNvbmZpZwAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAI5TZWUgYHJlZ2lzdGVyX3ByaWNlX3NwZWNgIOKAlCBzYW1lIGNvbW1pdC9yZXZlYWwgcnVsZSwgd2VpZ2h0ZWQgRWQyNTUxOQpjb21taXR0ZWUgdGhhdCBzaWducyBvZmYtY2hhaW4gYW5kIGlzIHZlcmlmaWVkIGJ5IGBzdWJtaXRfc2lnbmF0dXJlc2AuAAAAAAAacmVnaXN0ZXJfd2VpZ2h0ZWRfa2V5X3NwZWMAAAAAAAIAAAAAAAAACW1hcmtldF9pZAAAAAAAAAYAAAAAAAAABHNwZWMAAAfQAAAAEVdlaWdodGVkS2V5Q29uZmlnAAAAAAAAAQAAA+kAAAACAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    state: this.txFromJSON<ResolutionState>,
        attest: this.txFromJSON<Result<void>>,
        dispute: this.txFromJSON<Result<void>>,
        attest_cat: this.txFromJSON<Result<void>>,
        finalize_cat: this.txFromJSON<Result<u32>>,
        current_round: this.txFromJSON<u32>,
        expire_market: this.txFromJSON<Result<void>>,
        resolve_price: this.txFromJSON<Result<Outcome>>,
        expire_dispute: this.txFromJSON<Result<void>>,
        settle_dispute: this.txFromJSON<Result<void>>,
        cancel_proposal: this.txFromJSON<Result<void>>,
        finalize_signers: this.txFromJSON<Result<Outcome>>,
        register_spec_v2: this.txFromJSON<Result<void>>,
        escalation_attest: this.txFromJSON<Result<void>>,
        submit_signatures: this.txFromJSON<Result<void>>,
        claim_dispute_bond: this.txFromJSON<Result<void>>,
        register_price_spec: this.txFromJSON<Result<void>>,
        resolution_deadline: this.txFromJSON<Result<u64>>,
        guardian_void_market: this.txFromJSON<Result<void>>,
        register_scalar_spec: this.txFromJSON<Result<void>>,
        register_signer_spec: this.txFromJSON<Result<void>>,
        resolve_scalar_price: this.txFromJSON<Result<u32>>,
        register_cat_signer_spec: this.txFromJSON<Result<void>>,
        register_disputable_spec: this.txFromJSON<Result<void>>,
        register_weighted_key_spec: this.txFromJSON<Result<void>>
  }
}