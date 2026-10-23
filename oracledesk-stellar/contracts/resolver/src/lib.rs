#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, xdr::ToXdr, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};

// market-core is imported from its compiled wasm rather than as a normal
// Cargo path dependency: `#[contractimpl]` exports every contract entrypoint
// as a `#[no_mangle]` wasm symbol, and a crate's wasm build merges in *all*
// contract functions reachable through its dependency graph (soroban-sdk's
// own docs on `#[contract]` note this). Depending on the market-core crate
// directly made `resolver`'s wasm build fail with "symbol `__constructor`
// multiply defined" — both contracts define one. `contractimport!` instead
// generates client bindings from the wasm's interface spec, with no such
// collision. See `docs/adr/0002-cross-contract-calls.md`; regenerating
// `market_core.wasm` here after a market-core change is a `make build` step.
#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "market_core.wasm");
}
use market_core::Client as MarketCoreClient;
use market_core::MarketKind;

// The resolution-spec surface is XDR-consensus-critical (`resolution_hash =
// sha256(spec.to_xdr())`), so its definitions now live in the shared
// `oracledesk-types` crate rather than being duplicated per contract. Re-export
// them so existing `resolver::PriceConfig` etc. paths (and `scripts/spec-hash`)
// keep working.
pub use oracledesk_types::{
    CatSignerConfig, CommitteeRef, DisputableSignerConfig, Escalation, HybridConfig, OracleAsset,
    Outcome, PriceConfig, PriceData, PriceDirection, ResolutionSpec, ResolutionSpecV2,
    ScalarPriceConfig, SignerConfig, WeightedKey, WeightedKeyConfig,
};

#[allow(clippy::too_many_arguments)]
mod reasoning_registry {
    soroban_sdk::contractimport!(file = "reasoning_registry.wasm");
}
use reasoning_registry::Client as RegistryClient;

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

/// How long a pending admin proposal stays acceptable. Kept short so a
/// mistyped or abandoned handover cannot linger as a live takeover path.
pub const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;

/// Most keys a weighted committee may hold. Bounds registration (O(n^2)
/// duplicate check) and the per-call signature scan.
pub const MAX_WEIGHTED_SIGNERS: u32 = 32;
/// Most signatures one `submit_signatures` call accepts. A committee cannot
/// contribute more than `MAX_WEIGHTED_SIGNERS` distinct valid signatures, so a
/// larger batch is never useful; the recorded budget test
/// (`max_sigs_per_call_budget`) shows this size stays far below the 400M
/// instruction / 40 MiB transaction limits.
pub const MAX_SIGS_PER_CALL: u32 = MAX_WEIGHTED_SIGNERS;
/// Outcome-count cap of a categorical market, mirroring market-core's
/// `MAX_MARKET_OUTCOMES`. Duplicated (not imported) because market-core is
/// consumed through `contractimport!`, which exposes no constants.
pub const MAX_CAT_OUTCOMES: u32 = 8;
/// Basis-point denominator shared by scalar payouts and the categorical caps.
pub const BPS: i128 = 10_000;
/// Domain tag of the message weighted-key signers sign (20 bytes).
const ATTEST_DOMAIN: &[u8] = b"oracledesk-attest-v1";

/// Longest a market may stay unresolved after `close_time` before anyone may
/// void it through [`Resolver::expire_market`]. A compile-time constant on
/// purpose: an admin setter could shorten it and void markets early.
pub const RESOLUTION_GRACE_SECS: u64 = 30 * 86_400;

/// Maximum members a reusable committee registry may have.
pub const MAX_COMMITTEE: u32 = 32;
/// Minimum time-lock delay for proposing and executing committee rotations (1 day).
pub const MIN_ROTATION_DELAY: u64 = 86_400;

/// Grace period for revealing specs before guardian void is allowed (3 days).
pub const REVEAL_GRACE_SECS: u64 = 3 * 86_400;
/// Grace period for oracle recovery before guardian void is allowed (1 day).
pub const ORACLE_GRACE_SECS: u64 = 86_400;
/// Grace period for stalled signers before guardian void is allowed (7 days).
pub const SIGNER_GRACE_SECS: u64 = 7 * 86_400;
/// Maximum number of proposal cancellations per market allowed by the guardian.
pub const MAX_CANCELS_PER_MARKET: u32 = 2;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionState {
    Unconfigured,
    SignersPending,
    Finalized,
    /// Voided by [`Resolver::expire_market`] after the resolution deadline.
    Expired,
    /// A bonded dispute is open; finalization is frozen until it settles.
    Disputed,
    HybridPricePending,
    HybridFallbackOpen,
}

impl ResolutionState {
    /// No further reveal, attestation, resolution or void is possible.
    fn is_terminal(self) -> bool {
        matches!(self, Self::Finalized | Self::Expired)
    }
}

/// Which resolution path a market was on when it expired.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpiryMode {
    Unrevealed,
    Price,
    Signers,
    /// Scalar counterpart of `Price` (appended).
    Scalar,
}

/// Legacy proposal shape, stored under [`DataKey::Proposal`]. Only read (as a
/// fallback) by resolvers that inherited state from before `AttestedOutcome`;
/// see [`SignerProposalV2`] and `docs/adr/0003-attested-outcome-migration.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerProposal {
    pub outcome: Outcome,
    pub proposed_at: u64,
}

/// What a signer attests to. Resolver-local so market-core's `Outcome` (and
/// the vendored `market_core.wasm`) never gains an `Invalid` variant: an
/// `Invalid` proposal finalizes through market-core's `void_market` instead
/// of `resolve`. Never part of a `ResolutionSpec`, so commitment hashes are
/// unaffected (ADR 0001).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttestedOutcome {
    Yes,
    No,
    /// The question is ambiguous or unanswerable; finalizing voids the market.
    Invalid,
}

impl AttestedOutcome {
    /// The market-core outcome this settles to; `None` for `Invalid` (void).
    fn to_market(self) -> Option<Outcome> {
        match self {
            Self::Yes => Some(Outcome::Yes),
            Self::No => Some(Outcome::No),
            Self::Invalid => None,
        }
    }

    fn from_market(outcome: &Outcome) -> Self {
        match outcome {
            Outcome::Yes => Self::Yes,
            Outcome::No => Self::No,
        }
    }
}

/// The pending proposal of a signer-mode market, stored under
/// [`DataKey::ProposalV2`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerProposalV2 {
    pub outcome: AttestedOutcome,
    pub proposed_at: u64,
}

/// A price read pinned by [`Resolver::snapshot_price`] so resolution survives
/// the oracle aging the `close_time` record out of its history.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSnapshot {
    pub data: PriceData,
    pub taken_at: u64,
    pub taken_by: Address,
}

/// The escalation authority's ruling. `Invalid` voids the market.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    Yes,
    No,
    Invalid,
}

/// An escrowed bond. `payee` is `None` while the dispute is open and the
/// recipient once it is settled; the bond leaves escrow only through the
/// permissionless `claim_dispute_bond` (a pull, so a payee that cannot receive
/// the token can never block settlement).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub disputer: Address,
    pub bond: i128,
    /// Collateral token snapshotted at dispute time so the refund uses the
    /// same token even if market-core's collateral ever changes.
    pub token: Address,
    pub opened_at: u64,
    pub payee: Option<Address>,
}

/// A categorical winner once `threshold` signers have attested the index.
/// Resolver-local storage only (never hashed), so it stays here while the
/// committed `CatSignerConfig` lives in `oracledesk-types`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatProposal {
    pub outcome_index: u32,
    pub proposed_at: u64,
}

/// Reusable committee managed by an admin under time-locked rotation rules.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Committee {
    pub admin: Address,
    pub members: Vec<Address>,
    pub threshold: u32,
    pub epoch: u32,
    pub rotation_delay: u64,
}

/// A proposed rotation of committee members/threshold waiting for its delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRotation {
    pub members: Vec<Address>,
    pub threshold: u32,
    pub executable_at: u64,
}

/// Evidence policy governing whether attestation evidence is required.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidencePolicy {
    Disabled,
    Optional,
    Required,
}

/// Stored link connecting an attestation to a reasoning registry trace.
/// `outcome` was a market-core `Outcome` before `Invalid` attestations; the
/// two enums encode `Yes`/`No` identically, so earlier entries still decode.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationEvidence {
    pub signer: Address,
    pub outcome: AttestedOutcome,
    pub trace_id: u64,
    pub trace_hash: BytesN<32>,
    pub attested_at: u64,
}

/// Reason code constraining guardian interventions.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardianReason {
    /// Past close_time + REVEAL_GRACE_SECS, no spec revealed.
    UnrevealedSpec,
    /// Price mode, past close_time + ORACLE_GRACE_SECS, price feed unavailable or stale.
    OracleUnavailable,
    /// Signer mode, past close_time + SIGNER_GRACE_SECS, no proposal.
    SignersStalled,
    /// Proposal exists and dispute window is currently active.
    DisputeUpheld,
}

/// Guardian action type emitted for audit trails.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardianActionKind {
    Void,
    CancelProposal,
}

/// Domain tag prepended to a [`ResolutionSpecV2`] before hashing. Every legacy
/// preimage is the XDR of an `ScVal` and so starts with the bytes `00 00 00 10`
/// (`ScValType::Vec`), never with ASCII, which keeps the two hash spaces
/// disjoint. See `docs/adr/0004-spec-versioning.md`.
pub const SPEC_DOMAIN: &str = "oracledesk:resolution-spec";
const SPEC_V2_VERSION: u32 = 2;

/// Hash a legacy commitment is checked against: `sha256(XDR(rule))`.
pub fn legacy_spec_hash(env: &Env, rule: &ResolutionSpec) -> BytesN<32> {
    env.crypto().sha256(&rule.clone().to_xdr(env)).into()
}

/// Hash a V2 commitment is checked against: `sha256(SPEC_DOMAIN || XDR(spec))`.
pub fn spec_v2_hash(env: &Env, spec: &ResolutionSpecV2) -> BytesN<32> {
    let mut preimage = Bytes::from_slice(env, SPEC_DOMAIN.as_bytes());
    preimage.append(&spec.clone().to_xdr(env));
    env.crypto().sha256(&preimage).into()
}

/// A proposed admin handover (#62). Absent when no transfer is pending.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub address: Address,
    pub expires_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidConfig = 3,
    MarketAlreadyConfigured = 4,
    MarketNotConfigured = 5,
    WrongMode = 6,
    MarketNotClosed = 7,
    PriceUnavailable = 8,
    StalePrice = 9,
    InvalidPrice = 10,
    NotSigner = 11,
    AlreadyAttested = 12,
    ThresholdNotReached = 13,
    DisputeActive = 14,
    DisputeWindowOpen = 15,
    NoProposal = 16,
    AlreadyFinalized = 17,
    SpecHashMismatch = 18,
    DeadlineNotReached = 19,
    ResolutionAvailable = 20,
    DomainMismatch = 21,
    StaleRound = 22,
    TooManySignatures = 23,
    DisputeWindowClosed = 24,
    NoDispute = 25,
    CommitteeNotFound = 26,
    RotationPending = 27,
    RotationNotReady = 28,
    RotationBoundExceeded = 29,
    DuplicateMember = 30,
    CommitteeTooLarge = 31,
    EvidenceDisabled = 32,
    EvidenceRequired = 33,
    EvidenceNotFound = 34,
    EvidenceAuthorMismatch = 35,
    EvidenceMarketMismatch = 36,
    EvidenceTooEarly = 37,
    EvidenceAlreadyUsed = 38,
    GuardianNotAllowed = 39,
    TooManyCancels = 40,
    SnapshotExists = 41,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 42,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 43,

    /// `attest_cat` outcome index not below the committed `outcome_count`.
    InvalidOutcomeIndex = 44,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    MarketCore,
    Price(u64),
    Signers(u64),
    /// Legacy (pre-`AttestedOutcome`) keys: never written any more, only read
    /// as a fallback and deleted on migration. See `ProposalV2`/`AttestationV2`/
    /// `CountV2` and `docs/adr/0003-attested-outcome-migration.md`.
    Proposal(u64),
    Attestation(u64, Outcome, Address),
    Count(u64, Outcome),
    State(u64),
    WeightedKeys(u64),
    /// Current attestation round of a weighted market (absent = 0).
    Round(u64),
    /// Outcome a key signed in a round; one signature per key per round.
    SigSeen(u64, u32, BytesN<32>),
    /// Accumulated signer weight for (market, round, outcome).
    Weight(u64, u32, Outcome),
    Disputable(u64),
    Dispute(u64),
    EscalationVote(u64, Address),
    EscalationCount(u64, Verdict),
    NextCommitteeId,
    Committee(u64),
    Rotation(u64),
    CommitteeSpec(u64),
    MemberAt(u64, u32),
    AttestEpoch(u64, Address),
    Hybrid(u64),
    EvidenceConfig,
    EvidencePolicy(u64),
    EvidenceUsed(u64),
    EvidenceCount(u64),
    Evidence(u64, u32),
    Cancels(u64),
    /// Versioned rather than reusing `Attestation`/`Count`/`Proposal` with a
    /// new payload type: explicit V2 keys keep the migration auditable and do
    /// not depend on the two outcome enums happening to share an encoding.
    AttestationV2(u64, AttestedOutcome, Address),
    CountV2(u64, AttestedOutcome),
    ProposalV2(u64),
    Snapshot(u64),

    // appended (new variants only ever go at the end — the XDR tag is the
    // variant position)
    /// Registered `CatSignerConfig` of a categorical market.
    CatSigners(u64),
    /// A signer's attestation of one categorical outcome index.
    CatAttestation(u64, u32, Address),
    /// Attestation count for (market, outcome index).
    CatCount(u64, u32),
    CatProposal(u64),
    /// Registered `ScalarPriceConfig` of a scalar market.
    Scalar(u64),
}

/// The registered signer group/authority, whichever kind the market committed to.
/// Gives `finalize_signers` and `expire_market` one view of "dispute window"
/// and "does this outcome have quorum".
enum SignerAuthority {
    Signers(SignerConfig),
    Weighted(WeightedKeyConfig),
    Disputable(DisputableSignerConfig),
    Committee(CommitteeRef, Committee),
    Hybrid(HybridConfig),
}

impl SignerAuthority {
    fn dispute_window(&self) -> u64 {
        match self {
            Self::Signers(cfg) => cfg.dispute_window,
            Self::Weighted(cfg) => cfg.dispute_window,
            Self::Disputable(cfg) => cfg.dispute_window,
            Self::Committee(r, _) => r.dispute_window,
            Self::Hybrid(cfg) => cfg.fallback.dispute_window,
        }
    }
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceResolution {
    #[topic]
    pub market_id: u64,
    pub price: i128,
    pub price_timestamp: u64,
    pub outcome: Outcome,
}

/// `PriceResolution` plus whether the price came from a stored
/// [`PriceSnapshot`]. Both are emitted for one release so indexers decoding
/// `PriceResolution` keep working while they move to this event.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceResolutionV2 {
    #[topic]
    pub market_id: u64,
    pub price: i128,
    pub price_timestamp: u64,
    pub outcome: Outcome,
    pub from_snapshot: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSnapshotted {
    #[topic]
    pub market_id: u64,
    pub price: i128,
    pub price_timestamp: u64,
    pub taken_by: Address,
}

/// No longer emitted (superseded by [`ResolutionFinalizedV2`]); kept in the
/// contract spec so clients can still decode historical events.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionFinalized {
    #[topic]
    pub market_id: u64,
    pub outcome: Outcome,
    pub finalized_at: u64,
}

/// No longer emitted (superseded by [`ResolutionProposedV2`]); kept in the
/// contract spec so clients can still decode historical events.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionProposed {
    #[topic]
    pub market_id: u64,
    pub outcome: Outcome,
    pub proposed_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionFinalizedV2 {
    #[topic]
    pub market_id: u64,
    pub outcome: AttestedOutcome,
    pub finalized_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionProposedV2 {
    #[topic]
    pub market_id: u64,
    pub outcome: AttestedOutcome,
    pub proposed_at: u64,
}

/// A signer committee finalized an `Invalid` proposal and voided the market.
/// Distinguishes committee voids from `GuardianAction { action: Void }`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitteeVoided {
    #[topic]
    pub market_id: u64,
    pub finalized_at: u64,
    pub invalid_count: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disputed {
    #[topic]
    pub market_id: u64,
    pub disputer: Address,
    pub bond: i128,
    /// What the disputer claims is correct; `None` claims the market is invalid.
    pub alternative: Option<Outcome>,
}

/// `disputer_won` is true when the bond returns to the disputer because the
/// ruling overturned the proposal. A timeout (`expire_dispute`) also refunds
/// the bond but is reported as `verdict: Invalid, disputer_won: false`. That
/// pair also describes a ruling of `Invalid` that upholds an `Invalid`
/// proposal; the two differ in the bond's payee (disputer on timeout,
/// market-core treasury when upheld), readable from the `Dispute` entry
/// until `claim_dispute_bond` runs. `payout` is the escrowed bond, claimable
/// by its payee.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeSettled {
    #[topic]
    pub market_id: u64,
    pub verdict: Verdict,
    pub disputer_won: bool,
    pub payout: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketExpired {
    #[topic]
    pub market_id: u64,
    pub close_time: u64,
    pub deadline: u64,
    pub mode: ExpiryMode,
}

/// Categorical counterpart of `ResolutionProposed`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatResolutionProposed {
    #[topic]
    pub market_id: u64,
    pub outcome_index: u32,
    pub proposed_at: u64,
}

/// Categorical counterpart of `ResolutionFinalized`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatResolutionFinalized {
    #[topic]
    pub market_id: u64,
    pub outcome_index: u32,
    pub finalized_at: u64,
}

/// Scalar counterpart of `PriceResolution`: the settled market carries a
/// fractional LONG payout instead of a side.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScalarPriceResolution {
    #[topic]
    pub market_id: u64,
    pub price: i128,
    pub price_timestamp: u64,
    pub payout_long_bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitteeCreated {
    #[topic]
    pub committee_id: u64,
    pub admin: Address,
    pub threshold: u32,
    pub members: Vec<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotationProposed {
    #[topic]
    pub committee_id: u64,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotationExecuted {
    #[topic]
    pub committee_id: u64,
    pub epoch: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotationCancelled {
    #[topic]
    pub committee_id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackOpened {
    #[topic]
    pub market_id: u64,
    pub opened_at: u64,
    pub last_error: u32,
}

/// `proposal_outcome` (like `Attested::outcome`) was a market-core `Outcome`;
/// `Yes`/`No` encode identically, so only `Invalid` is new to decoders.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackSuperseded {
    #[topic]
    pub market_id: u64,
    pub proposal_outcome: AttestedOutcome,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attested {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub signer: Address,
    pub outcome: AttestedOutcome,
    pub trace_id: Option<u64>,
    pub count: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianAction {
    #[topic]
    pub market_id: u64,
    pub action: GuardianActionKind,
    pub reason: GuardianReason,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposed {
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferred {
    pub old: Address,
    pub new: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferCancelled {}

#[soroban_sdk::contractclient(name = "ReflectorPriceClient")]
pub trait ReflectorPrice {
    fn price(env: Env, asset: OracleAsset, timestamp: u64) -> Option<PriceData>;
}

#[contract]
pub struct Resolver;

#[soroban_sdk::contractclient(name = "MarketCoreWiringClient")]
pub trait MarketCoreWiring {
    fn accept_resolver(env: Env) -> Result<(), soroban_sdk::Error>;
}

#[contractimpl]
impl Resolver {
    pub fn __constructor(env: Env, admin: Address, market_core: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MarketCore, &market_core);
    }

    pub fn market_core(env: Env) -> Address {
        env.storage().instance().get(&DataKey::MarketCore).unwrap()
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        Self::instance_get(&env, DataKey::Admin)
    }

    /// The pending admin proposal, including its expiry, if one exists.
    pub fn pending_admin(env: Env) -> Option<PendingAdmin> {
        Self::load_pending(&env)
    }

    pub fn accept_market_core_role(env: Env) {
        let core = Self::market_core(env.clone());
        MarketCoreWiringClient::new(&env, &core).accept_resolver();
    }

    // ----- admin ----------------------------------------------------------

    /// Starts a two-step handover of the admin role. The new admin must call
    /// `accept_admin` itself, so a typo cannot hand control to an address
    /// nobody holds.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        env.storage().instance().set(
            &DataKey::PendingAdmin,
            &PendingAdmin {
                address: new_admin.clone(),
                expires_at: env.ledger().timestamp() + ADMIN_PROPOSAL_TTL_SECS,
            },
        );
        AdminTransferProposed { new_admin }.publish(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = Self::load_pending(&env).ok_or(Error::NoPendingAdmin)?;
        if env.ledger().timestamp() > pending.expires_at {
            return Err(Error::PendingAdminExpired);
        }
        pending.address.require_auth();
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        let old: Address = Self::instance_get(&env, DataKey::Admin)?;
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &pending.address);
        s.remove(&DataKey::PendingAdmin);
        AdminTransferred {
            old,
            new: pending.address,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::load_pending(&env).is_none() {
            return Err(Error::NoPendingAdmin);
        }
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        AdminTransferCancelled {}.publish(&env);
        Ok(())
    }

    /// Reveals the resolution rule committed to at market creation. Anyone
    /// may call this (there is no admin gate) because the only thing that
    /// makes a spec acceptable is that it hashes to `market.resolution_hash`
    /// — the commitment, not the caller, is the authority. Fails if a spec
    /// was already registered for this market.
    pub fn register_price_spec(env: Env, market_id: u64, spec: PriceConfig) -> Result<(), Error> {
        let rule = ResolutionSpec::Price(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// See `register_price_spec` — same commit/reveal rule, signer mode.
    pub fn register_signer_spec(env: Env, market_id: u64, spec: SignerConfig) -> Result<(), Error> {
        let rule = ResolutionSpec::Signers(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// See `register_price_spec` — same commit/reveal rule, signer mode whose
    /// proposals can be challenged with a bond (see `dispute`).
    pub fn register_disputable_spec(
        env: Env,
        market_id: u64,
        spec: DisputableSignerConfig,
    ) -> Result<(), Error> {
        let rule = ResolutionSpec::SignersDisputable(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// See `register_price_spec` — same commit/reveal rule, weighted Ed25519
    /// committee that signs off-chain and is verified by `submit_signatures`.
    pub fn register_weighted_key_spec(
        env: Env,
        market_id: u64,
        spec: WeightedKeyConfig,
    ) -> Result<(), Error> {
        let rule = ResolutionSpec::WeightedKeys(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// See `register_price_spec` — same commit/reveal rule, categorical
    /// outcome-index committee. Only meaningful for markets whose
    /// `resolution_hash` commits to `ResolutionSpec::CategoricalSigners` with
    /// this exact `outcome_count`; the reveal target's `resolution_hash` is
    /// read from whichever market kind owns the id.
    pub fn register_cat_signer_spec(
        env: Env,
        market_id: u64,
        spec: CatSignerConfig,
    ) -> Result<(), Error> {
        let rule = ResolutionSpec::CategoricalSigners(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// See `register_price_spec` — same commit/reveal rule, scalar mode:
    /// the market settles fractionally from the feed price clamped into
    /// `[lower, upper]` (see `resolve_scalar_price`).
    pub fn register_scalar_spec(
        env: Env,
        market_id: u64,
        spec: ScalarPriceConfig,
    ) -> Result<(), Error> {
        let rule = ResolutionSpec::Scalar(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// Reveals a rule committed to through a [`ResolutionSpecV2`] envelope.
    /// The envelope must name this network and this resolver's market-core
    /// (`DomainMismatch`), use a non-zero salt and the current `version`
    /// (`InvalidConfig`), and hash to the market's commitment
    /// (`SpecHashMismatch`). The inner rule is then validated and stored
    /// exactly as the legacy entrypoints do.
    pub fn register_spec_v2(env: Env, market_id: u64, spec: ResolutionSpecV2) -> Result<(), Error> {
        if spec.version != SPEC_V2_VERSION || spec.salt == BytesN::from_array(&env, &[0; 32]) {
            return Err(Error::InvalidConfig);
        }
        if spec.network_id != env.ledger().network_id()
            || spec.market_core != Self::instance_get::<Address>(&env, DataKey::MarketCore)?
        {
            return Err(Error::DomainMismatch);
        }
        Self::reveal(&env, market_id, &spec.rule, &spec_v2_hash(&env, &spec))
    }

    /// Registers a reusable committee specification for `market_id`.
    pub fn register_committee_spec(
        env: Env,
        market_id: u64,
        spec: CommitteeRef,
    ) -> Result<(), Error> {
        Self::assert_unconfigured(&env, market_id)?;
        let committee = Self::load_committee(&env, spec.committee_id)?;
        if committee.epoch < spec.min_epoch {
            return Err(Error::RotationBoundExceeded);
        }
        if spec.dispute_window == 0 {
            return Err(Error::InvalidConfig);
        }
        let rule = ResolutionSpec::Committee(spec);
        Self::assert_matches_commitment(&env, market_id, &legacy_spec_hash(&env, &rule))?;
        Self::store_rule(&env, market_id, &rule);
        Ok(())
    }

    /// Registers a hybrid resolution specification (price feed with attested fallback).
    pub fn register_hybrid_spec(env: Env, market_id: u64, spec: HybridConfig) -> Result<(), Error> {
        let rule = ResolutionSpec::Hybrid(spec);
        Self::reveal(&env, market_id, &rule, &legacy_spec_hash(&env, &rule))
    }

    /// Creates a reusable committee with an admin, member set, threshold, and time-lock delay.
    pub fn create_committee(
        env: Env,
        admin: Address,
        members: Vec<Address>,
        threshold: u32,
        rotation_delay: u64,
    ) -> Result<u64, Error> {
        Self::validate_committee_members(&members)?;
        if threshold == 0 || threshold > members.len() {
            return Err(Error::InvalidConfig);
        }
        if rotation_delay < MIN_ROTATION_DELAY {
            return Err(Error::InvalidConfig);
        }
        let id_key = DataKey::NextCommitteeId;
        let id: u64 = env.storage().instance().get(&id_key).unwrap_or(0);
        env.storage().instance().set(&id_key, &(id + 1));

        let committee = Committee {
            admin: admin.clone(),
            members: members.clone(),
            threshold,
            epoch: 1,
            rotation_delay,
        };
        let comm_key = DataKey::Committee(id);
        Self::persist(&env, &comm_key, &committee);

        let snap_key = DataKey::MemberAt(id, 1);
        Self::persist(&env, &snap_key, &(members.clone(), threshold));

        CommitteeCreated {
            committee_id: id,
            admin,
            threshold,
            members,
        }
        .publish(&env);
        Ok(id)
    }

    /// Proposes a new member set and threshold for a committee, executable after rotation_delay.
    pub fn propose_rotation(
        env: Env,
        committee_id: u64,
        members: Vec<Address>,
        threshold: u32,
    ) -> Result<u64, Error> {
        let committee: Committee = Self::load_committee(&env, committee_id)?;
        committee.admin.require_auth();
        let rot_key = DataKey::Rotation(committee_id);
        if env.storage().persistent().has(&rot_key) {
            return Err(Error::RotationPending);
        }
        Self::validate_committee_members(&members)?;
        if threshold == 0 || threshold > members.len() {
            return Err(Error::InvalidConfig);
        }
        let executable_at = env
            .ledger()
            .timestamp()
            .saturating_add(committee.rotation_delay);
        let pending = PendingRotation {
            members,
            threshold,
            executable_at,
        };
        Self::persist(&env, &rot_key, &pending);
        RotationProposed {
            committee_id,
            executable_at,
        }
        .publish(&env);
        Ok(executable_at)
    }

    /// Permissionlessly executes a matured rotation for a committee, bumping its epoch.
    pub fn execute_rotation(env: Env, committee_id: u64) -> Result<u32, Error> {
        let mut committee: Committee = Self::load_committee(&env, committee_id)?;
        let rot_key = DataKey::Rotation(committee_id);
        let pending: PendingRotation = env
            .storage()
            .persistent()
            .get(&rot_key)
            .ok_or(Error::RotationNotReady)?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::RotationNotReady);
        }
        env.storage().persistent().remove(&rot_key);
        let new_epoch = committee.epoch.checked_add(1).ok_or(Error::InvalidConfig)?;
        committee.epoch = new_epoch;
        committee.members = pending.members.clone();
        committee.threshold = pending.threshold;
        Self::persist(&env, &DataKey::Committee(committee_id), &committee);
        Self::persist(
            &env,
            &DataKey::MemberAt(committee_id, new_epoch),
            &(pending.members, pending.threshold),
        );
        RotationExecuted {
            committee_id,
            epoch: new_epoch,
        }
        .publish(&env);
        Ok(new_epoch)
    }

    /// Cancels a pending rotation for a committee (admin only).
    pub fn cancel_rotation(env: Env, committee_id: u64) -> Result<(), Error> {
        let committee: Committee = Self::load_committee(&env, committee_id)?;
        committee.admin.require_auth();
        let rot_key = DataKey::Rotation(committee_id);
        if !env.storage().persistent().has(&rot_key) {
            return Err(Error::RotationNotReady);
        }
        env.storage().persistent().remove(&rot_key);
        RotationCancelled { committee_id }.publish(&env);
        Ok(())
    }

    /// Reads committee state and extends its storage TTL.
    pub fn get_committee(env: Env, committee_id: u64) -> Result<Committee, Error> {
        Self::load_committee(&env, committee_id)
    }

    /// Opens fallback signer attestation in a hybrid market if the feed failed past the deadline.
    pub fn open_fallback(env: Env, market_id: u64) -> Result<(), Error> {
        let config: HybridConfig = Self::load(&env, DataKey::Hybrid(market_id))?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        let now = env.ledger().timestamp();
        let fallback_deadline = market.close_time.saturating_add(config.fallback_after);
        if now < fallback_deadline {
            return Err(Error::DeadlineNotReached);
        }
        // If the price feed recovered and returns a valid price, resolve by price instead of opening fallback.
        match Self::price_outcome(&env, market_id, &config.price, market.close_time) {
            Ok((outcome, data, from_snapshot)) => {
                Self::settle_price(
                    &env,
                    &market_core,
                    market_id,
                    &outcome,
                    &data,
                    from_snapshot,
                )?;
                Ok(())
            }
            Err(err) => {
                Self::set_state(&env, market_id, ResolutionState::HybridFallbackOpen);
                FallbackOpened {
                    market_id,
                    opened_at: now,
                    last_error: err as u32,
                }
                .publish(&env);
                Ok(())
            }
        }
    }

    /// Configures the reasoning registry contract address and evidence policy (admin only).
    pub fn set_evidence_config(
        env: Env,
        registry: Address,
        policy: EvidencePolicy,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::EvidenceConfig, &(registry, policy));
        Ok(())
    }

    /// Reads the currently configured evidence settings, if any.
    pub fn evidence_config(env: Env) -> Option<(Address, EvidencePolicy)> {
        env.storage().instance().get(&DataKey::EvidenceConfig)
    }

    /// Total evidence citations recorded for `market_id`.
    pub fn evidence_count(env: Env, market_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::EvidenceCount(market_id))
            .unwrap_or(0)
    }

    /// Reads the evidence citation at `index` for `market_id`.
    pub fn evidence_at(env: Env, market_id: u64, index: u32) -> Result<AttestationEvidence, Error> {
        let key = DataKey::Evidence(market_id, index);
        let evidence: AttestationEvidence = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EvidenceNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(evidence)
    }

    /// Total proposal cancellations executed by the guardian for `market_id`.
    pub fn cancel_count(env: Env, market_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Cancels(market_id))
            .unwrap_or(0)
    }

    /// Returns the guardian reason codes valid for `market_id` right now.
    pub fn guardian_options(env: Env, market_id: u64) -> Vec<GuardianReason> {
        let mut reasons = Vec::new(&env);
        if Self::resolution_state(&env, market_id).is_terminal() {
            return reasons;
        }
        let Ok(market_core) = Self::instance_get::<Address>(&env, DataKey::MarketCore) else {
            return reasons;
        };
        let Ok(market) =
            core_call(MarketCoreClient::new(&env, &market_core).try_get_market(&market_id))
        else {
            return reasons;
        };
        let now = env.ledger().timestamp();
        let storage = env.storage().persistent();

        if let Some(proposal) = Self::load_proposal(&env, market_id) {
            if let Ok(authority) = Self::signer_authority(&env, market_id) {
                if now
                    < proposal
                        .proposed_at
                        .saturating_add(authority.dispute_window())
                {
                    reasons.push_back(GuardianReason::DisputeUpheld);
                }
            }
        }

        if now >= market.close_time {
            if Self::expiry_mode(&env, market_id) == ExpiryMode::Unrevealed
                && now >= market.close_time.saturating_add(REVEAL_GRACE_SECS)
            {
                reasons.push_back(GuardianReason::UnrevealedSpec);
            }

            let price_cfg = if let Some(cfg) =
                storage.get::<_, PriceConfig>(&DataKey::Price(market_id))
            {
                Some(cfg)
            } else if let Some(h) = storage.get::<_, HybridConfig>(&DataKey::Hybrid(market_id)) {
                Some(h.price)
            } else {
                None
            };
            if let Some(cfg) = price_cfg {
                if now >= market.close_time.saturating_add(ORACLE_GRACE_SECS) {
                    if let Err(Error::PriceUnavailable | Error::StalePrice) =
                        Self::price_outcome(&env, market_id, &cfg, market.close_time)
                    {
                        reasons.push_back(GuardianReason::OracleUnavailable);
                    }
                }
            }

            let is_signer_mode = storage.has(&DataKey::Signers(market_id))
                || storage.has(&DataKey::Disputable(market_id))
                || storage.has(&DataKey::WeightedKeys(market_id))
                || storage.has(&DataKey::CommitteeSpec(market_id))
                || (storage.has(&DataKey::Hybrid(market_id))
                    && Self::resolution_state(&env, market_id)
                        == ResolutionState::HybridFallbackOpen);
            if is_signer_mode
                && !Self::has_proposal(&env, market_id)
                && now >= market.close_time.saturating_add(SIGNER_GRACE_SECS)
            {
                reasons.push_back(GuardianReason::SignersStalled);
            }
        }
        reasons
    }

    /// Guardian action: withdraws an unfinalized signer proposal during the dispute window
    /// subject to a rate limit of MAX_CANCELS_PER_MARKET.
    ///
    /// Works the same for an `Invalid` proposal. Only the proposal is removed:
    /// attestations and per-outcome counts stay, so the next attestation that
    /// brings any outcome to threshold (for example a further `Yes` once
    /// `Yes` already has quorum) proposes again. A categorical market keeps its
    /// pending winner in a separate slot, cleared the same way.
    pub fn cancel_proposal(env: Env, market_id: u64, reason: GuardianReason) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if reason != GuardianReason::DisputeUpheld {
            return Err(Error::GuardianNotAllowed);
        }
        Self::assert_not_disputed(&env, market_id)?;
        let storage = env.storage().persistent();
        let cat_key = DataKey::CatProposal(market_id);
        let cat_proposal: Option<CatProposal> = storage.get(&cat_key);
        let proposed_at = match (Self::load_proposal(&env, market_id), &cat_proposal) {
            (Some(p), _) => p.proposed_at,
            (None, Some(p)) => p.proposed_at,
            (None, None) => return Err(Error::NoProposal),
        };
        let dispute_window =
            if let Some(cfg) = storage.get::<_, CatSignerConfig>(&DataKey::CatSigners(market_id)) {
                cfg.dispute_window
            } else {
                Self::signer_authority(&env, market_id)?.dispute_window()
            };
        if env.ledger().timestamp() >= proposed_at.saturating_add(dispute_window) {
            return Err(Error::DisputeWindowClosed);
        }
        let cancel_key = DataKey::Cancels(market_id);
        let cancels: u32 = storage.get(&cancel_key).unwrap_or(0);
        if cancels >= MAX_CANCELS_PER_MARKET {
            return Err(Error::TooManyCancels);
        }
        Self::persist(&env, &cancel_key, &(cancels + 1));
        Self::remove_proposal(&env, market_id);
        storage.remove(&cat_key);
        if storage.has(&DataKey::WeightedKeys(market_id)) {
            Self::persist(
                &env,
                &DataKey::Round(market_id),
                &(Self::round(&env, market_id) + 1),
            );
        }
        GuardianAction {
            market_id,
            action: GuardianActionKind::CancelProposal,
            reason: GuardianReason::DisputeUpheld,
            at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(())
    }

    /// Guardian action: voids a market subject to verified on-chain reason codes and grace periods.
    pub fn guardian_void_market(
        env: Env,
        market_id: u64,
        reason: GuardianReason,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(&env, &market_core);
        let market = core_call(core.try_get_market(&market_id))?;
        let now = env.ledger().timestamp();

        if reason != GuardianReason::DisputeUpheld && now < market.close_time {
            return Err(Error::GuardianNotAllowed);
        }

        match reason {
            GuardianReason::UnrevealedSpec => {
                if Self::expiry_mode(&env, market_id) != ExpiryMode::Unrevealed {
                    return Err(Error::GuardianNotAllowed);
                }
                if now < market.close_time.saturating_add(REVEAL_GRACE_SECS) {
                    return Err(Error::GuardianNotAllowed);
                }
            }
            GuardianReason::OracleUnavailable => {
                let storage = env.storage().persistent();
                let config: PriceConfig = if let Some(cfg) = storage.get(&DataKey::Price(market_id))
                {
                    cfg
                } else if let Some(hybrid) =
                    storage.get::<_, HybridConfig>(&DataKey::Hybrid(market_id))
                {
                    hybrid.price
                } else {
                    return Err(Error::GuardianNotAllowed);
                };
                if now < market.close_time.saturating_add(ORACLE_GRACE_SECS) {
                    return Err(Error::GuardianNotAllowed);
                }
                match Self::price_outcome(&env, market_id, &config, market.close_time) {
                    Err(Error::PriceUnavailable | Error::StalePrice) => {}
                    _ => return Err(Error::GuardianNotAllowed),
                }
            }
            GuardianReason::SignersStalled => {
                let storage = env.storage().persistent();
                let is_signer_mode = storage.has(&DataKey::Signers(market_id))
                    || storage.has(&DataKey::Disputable(market_id))
                    || storage.has(&DataKey::WeightedKeys(market_id))
                    || storage.has(&DataKey::CommitteeSpec(market_id))
                    || (storage.has(&DataKey::Hybrid(market_id))
                        && Self::resolution_state(&env, market_id)
                            == ResolutionState::HybridFallbackOpen);
                if !is_signer_mode || Self::has_proposal(&env, market_id) {
                    return Err(Error::GuardianNotAllowed);
                }
                if now < market.close_time.saturating_add(SIGNER_GRACE_SECS) {
                    return Err(Error::GuardianNotAllowed);
                }
            }
            GuardianReason::DisputeUpheld => {
                let Some(proposal) = Self::load_proposal(&env, market_id) else {
                    return Err(Error::GuardianNotAllowed);
                };
                let dispute_window = Self::signer_authority(&env, market_id)?.dispute_window();
                if now >= proposal.proposed_at.saturating_add(dispute_window) {
                    return Err(Error::GuardianNotAllowed);
                }
            }
        }

        core_call(core.try_void_market(&market_id))?;
        Self::refund_open_dispute(&env, market_id);
        Self::set_state(&env, market_id, ResolutionState::Finalized);
        GuardianAction {
            market_id,
            action: GuardianActionKind::Void,
            reason,
            at: now,
        }
        .publish(&env);
        Ok(())
    }

    pub fn resolve_price(env: Env, market_id: u64) -> Result<Outcome, Error> {
        let (config, is_hybrid) = if let Ok(cfg) =
            Self::load::<PriceConfig>(&env, DataKey::Price(market_id))
        {
            (cfg, false)
        } else if let Ok(hybrid) = Self::load::<HybridConfig>(&env, DataKey::Hybrid(market_id)) {
            (hybrid.price, true)
        } else {
            return Err(Error::WrongMode);
        };
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        // A stored snapshot takes precedence and skips the oracle call; see
        // `snapshot_price`.
        let (outcome, data, from_snapshot) =
            Self::price_outcome(&env, market_id, &config, market.close_time)?;
        if is_hybrid {
            if let Some(proposal) = Self::load_proposal(&env, market_id) {
                Self::remove_proposal(&env, market_id);
                FallbackSuperseded {
                    market_id,
                    proposal_outcome: proposal.outcome,
                }
                .publish(&env);
            }
        }
        Self::settle_price(
            &env,
            &market_core,
            market_id,
            &outcome,
            &data,
            from_snapshot,
        )?;
        Ok(outcome)
    }

    /// Pins the committed feed's price for `close_time` in resolver storage,
    /// so `resolve_price` still works after the oracle's bounded history has
    /// aged that record out (SEP-40 `price(asset, timestamp)` returns `None`
    /// outside the retained window). Permissionless: `caller` only authorizes
    /// being recorded as `taken_by`.
    ///
    /// Callable any time after `close_time` while the market is unresolved,
    /// but in practice it must run within the oracle's retention window (see
    /// `docs/architecture.md`, "Oracle history retention"). The first valid
    /// snapshot wins (`SnapshotExists` afterwards): for a fixed
    /// `(asset, close_time)` the answer is deterministic, and freezing it
    /// deliberately prefers determinism over an oracle later rewriting
    /// history. A price `resolve_price` would reject is never stored.
    pub fn snapshot_price(env: Env, market_id: u64, caller: Address) -> Result<PriceData, Error> {
        caller.require_auth();
        let config = Self::price_config(&env, market_id)?;
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        let now = env.ledger().timestamp();
        if now < market.close_time {
            return Err(Error::MarketNotClosed);
        }
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let key = DataKey::Snapshot(market_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::SnapshotExists);
        }
        let data = Self::read_feed(&env, &config, market.close_time)?;
        Self::persist(
            &env,
            &key,
            &PriceSnapshot {
                data: data.clone(),
                taken_at: now,
                taken_by: caller.clone(),
            },
        );
        PriceSnapshotted {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            taken_by: caller,
        }
        .publish(&env);
        Ok(data)
    }

    /// The price pinned by `snapshot_price`, if any.
    pub fn snapshot(env: Env, market_id: u64) -> Option<PriceSnapshot> {
        env.storage()
            .persistent()
            .get(&DataKey::Snapshot(market_id))
    }

    /// Resolves a scalar market from its Reflector feed. The reading is
    /// clamped into the committed `[lower, upper]` range and settled as the
    /// fractional LONG payout `(clamped - lower) / (upper - lower)` in bps
    /// (SHORT pays the complement). Returns the payout.
    ///
    /// A non-positive reading is `InvalidPrice` rather than a clamp: it means
    /// the feed is broken, not that the value sits at the bottom of the
    /// range. Same close-time, staleness and terminal-state rules as
    /// `resolve_price`.
    pub fn resolve_scalar_price(env: Env, market_id: u64) -> Result<u32, Error> {
        let config: ScalarPriceConfig = Self::load(&env, DataKey::Scalar(market_id))?;
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let (payout, data) = Self::try_scalar_payout(&env, &config, market.close_time)?;
        Self::settle_scalar(&env, &market_core, market_id, payout, &data);
        Ok(payout)
    }

    /// When `expire_market` becomes callable for `market_id`: `close_time` plus
    /// [`RESOLUTION_GRACE_SECS`]. Needs only market-core's `close_time`, so it
    /// is known before (and without) a spec reveal, for either market kind.
    pub fn resolution_deadline(env: Env, market_id: u64) -> Result<u64, Error> {
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        Ok(Self::deadline(&market))
    }

    /// Permissionless liveness fallback: once `resolution_deadline` has passed,
    /// anyone may void a market that is still unresolved, so collateral is
    /// never locked behind a missing reveal, a dead feed or silent signers.
    ///
    /// Resolution is preferred over voiding. A price market whose feed is
    /// valid right now is *resolved* instead (so a stalled caller can never
    /// force a void on a resolvable market), and a market with a pending
    /// signer or categorical proposal is refused with `ResolutionAvailable`
    /// until it is finalized.
    pub fn expire_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::assert_not_disputed(&env, market_id)?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(&env, &market_core);
        let market = core_call(core.try_get_market(&market_id))?;
        let deadline = Self::deadline(&market);
        if env.ledger().timestamp() < deadline {
            return Err(Error::DeadlineNotReached);
        }

        let mode = Self::expiry_mode(&env, market_id);
        match mode {
            ExpiryMode::Price => {
                let config: PriceConfig = Self::load(&env, DataKey::Price(market_id))?;
                match Self::price_outcome(&env, market_id, &config, market.close_time) {
                    Ok((outcome, data, from_snapshot)) => {
                        Self::settle_price(
                            &env,
                            &market_core,
                            market_id,
                            &outcome,
                            &data,
                            from_snapshot,
                        )?;
                        return Ok(());
                    }
                    // Only an unusable feed lets the market expire; any other
                    // error (e.g. NotInitialized) is a real fault.
                    Err(Error::PriceUnavailable | Error::StalePrice) => {}
                    Err(other) => return Err(other),
                }
            }
            ExpiryMode::Scalar => {
                let config: ScalarPriceConfig = Self::load(&env, DataKey::Scalar(market_id))?;
                match Self::try_scalar_payout(&env, &config, market.close_time) {
                    Ok((payout, data)) => {
                        Self::settle_scalar(&env, &market_core, market_id, payout, &data);
                        return Ok(());
                    }
                    // A broken feed (missing, stale or non-positive) lets the
                    // market expire; any other error is a real fault.
                    Err(Error::PriceUnavailable | Error::StalePrice | Error::InvalidPrice) => {}
                    Err(other) => return Err(other),
                }
            }
            ExpiryMode::Signers
                if Self::has_valid_proposal(&env, market_id)?
                    || Self::has_valid_cat_proposal(&env, market_id)? =>
            {
                return Err(Error::ResolutionAvailable);
            }
            ExpiryMode::Signers | ExpiryMode::Unrevealed => {}
        }

        core_call(core.try_void_market(&market_id))?;
        Self::set_state(&env, market_id, ResolutionState::Expired);
        MarketExpired {
            market_id,
            close_time: market.close_time,
            deadline,
            mode,
        }
        .publish(&env);
        Ok(())
    }

    /// Records `signer`'s vote for `outcome` (allowed only once `close_time`
    /// has passed). `Invalid` claims the question is unanswerable; an
    /// `Invalid` proposal finalizes by voiding the market.
    ///
    /// Split votes: every outcome, `Invalid` included, has its own counter,
    /// and a signer is deduplicated per `(outcome, signer)`, so one signer may
    /// attest several outcomes (existing behaviour, extended to `Invalid`).
    /// The first outcome to reach threshold becomes the proposal and later
    /// `Yes`/`No` quorums never move it. The one exception: `Invalid` reaching
    /// threshold replaces a pending `Yes`/`No` proposal and restarts the
    /// dispute window, because a quorum saying the question cannot be
    /// answered outranks an answer to it. An `Invalid` proposal is never
    /// replaced. (Requiring `Invalid` to beat every other count is a possible
    /// follow-up.)
    pub fn attest(
        env: Env,
        market_id: u64,
        signer: Address,
        outcome: AttestedOutcome,
    ) -> Result<(), Error> {
        signer.require_auth();
        Self::record_attestation(&env, market_id, signer, outcome, None)
    }

    /// Attests to an outcome backed by an on-chain reasoning trace in reasoning-registry.
    pub fn attest_with_evidence(
        env: Env,
        market_id: u64,
        signer: Address,
        outcome: AttestedOutcome,
        trace_id: u64,
    ) -> Result<(), Error> {
        signer.require_auth();
        Self::record_attestation(&env, market_id, signer, outcome, Some(trace_id))
    }

    /// Counts Ed25519 signatures from a weighted committee. Permissionless: the
    /// signatures, not the submitter, carry the authority. Each signature is
    /// over the message built by `attestation_message`; non-members and keys
    /// that already signed this round (for either outcome) are skipped, and a
    /// single invalid signature aborts the whole batch, so submitters should
    /// pre-filter with a verifier. Once the accumulated weight for `outcome`
    /// first reaches the threshold a proposal is recorded and the dispute
    /// window starts; later calls never move it.
    pub fn submit_signatures(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        round: u32,
        sigs: Vec<(BytesN<32>, BytesN<64>)>,
    ) -> Result<(), Error> {
        let config: WeightedKeyConfig = Self::load(&env, DataKey::WeightedKeys(market_id))?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        if sigs.len() > MAX_SIGS_PER_CALL {
            return Err(Error::TooManySignatures);
        }
        if round != Self::round(&env, market_id) {
            return Err(Error::StaleRound);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(&env, &market_core).try_get_market(&market_id),
        )?;
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }

        let message =
            Self::attestation_message(&env, market_id, round, &outcome, &market.resolution_hash);
        let storage = env.storage().persistent();
        let before = Self::round_weight(&env, market_id, round, &outcome);
        let mut weight = before;
        for (pubkey, signature) in sigs.iter() {
            let Some(key_weight) = Self::weight_of(&config, &pubkey) else {
                continue;
            };
            let seen = DataKey::SigSeen(market_id, round, pubkey.clone());
            if storage.has(&seen) {
                continue;
            }
            env.crypto().ed25519_verify(&pubkey, &message, &signature);
            Self::persist(&env, &seen, &outcome);
            weight += key_weight;
        }
        if weight == before {
            return Ok(());
        }
        Self::persist(
            &env,
            &DataKey::Weight(market_id, round, outcome.clone()),
            &weight,
        );

        if before < config.weight_threshold
            && weight >= config.weight_threshold
            && !Self::has_proposal(&env, market_id)
        {
            Self::propose(&env, market_id, AttestedOutcome::from_market(&outcome));
        }
        Ok(())
    }

    /// Current attestation round of a weighted-key market; the `round`
    /// argument of `submit_signatures` and part of every signed message.
    pub fn current_round(env: Env, market_id: u64) -> u32 {
        Self::round(&env, market_id)
    }

    /// Settles the pending proposal once its dispute window has elapsed:
    /// `Yes`/`No` resolve the market, `Invalid` voids it (and emits
    /// `CommitteeVoided`). market-core's `void_market` has no `close_time`
    /// guard, but every attestation path requires `now >= close_time` before
    /// any write, so no proposal (and no void) can exist before close.
    pub fn finalize_signers(env: Env, market_id: u64) -> Result<AttestedOutcome, Error> {
        Self::assert_not_disputed(&env, market_id)?;
        let authority = Self::signer_authority(&env, market_id)?;
        let proposal = Self::load_proposal(&env, market_id).ok_or(Error::NoProposal)?;
        if env.ledger().timestamp() < proposal.proposed_at + authority.dispute_window() {
            return Err(Error::DisputeWindowOpen);
        }
        if !Self::has_quorum(&env, &authority, market_id, proposal.outcome) {
            return Err(Error::ThresholdNotReached);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(&env, &market_core);
        let now = env.ledger().timestamp();
        match proposal.outcome.to_market() {
            Some(outcome) => core_call(core.try_resolve(&market_id, &to_core_outcome(&outcome)))?,
            None => {
                core_call(core.try_void_market(&market_id))?;
                CommitteeVoided {
                    market_id,
                    finalized_at: now,
                    invalid_count: Self::attestation_count(
                        &env,
                        market_id,
                        AttestedOutcome::Invalid,
                    ),
                }
                .publish(&env);
            }
        }
        Self::set_state(&env, market_id, ResolutionState::Finalized);
        ResolutionFinalizedV2 {
            market_id,
            outcome: proposal.outcome,
            finalized_at: now,
        }
        .publish(&env);
        Ok(proposal.outcome)
    }

    /// Categorical counterpart of `attest`: `signer` attests that
    /// `outcome_index` is the winner. `outcome_index` must be below the
    /// `outcome_count` the market's commitment fixed. Once `threshold`
    /// members have attested an index it becomes the proposal and the
    /// dispute window opens.
    pub fn attest_cat(
        env: Env,
        market_id: u64,
        signer: Address,
        outcome_index: u32,
    ) -> Result<(), Error> {
        signer.require_auth();
        let config: CatSignerConfig = Self::load(&env, DataKey::CatSigners(market_id))?;
        if !Self::contains(&config.signers, &signer) {
            return Err(Error::NotSigner);
        }
        Self::assert_not_disputed(&env, market_id)?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        if outcome_index >= config.outcome_count {
            return Err(Error::InvalidOutcomeIndex);
        }
        if env.storage().persistent().has(&DataKey::CatAttestation(
            market_id,
            outcome_index,
            signer.clone(),
        )) {
            return Err(Error::AlreadyAttested);
        }
        if env.ledger().timestamp() < Self::market_close_time(&env, market_id)? {
            return Err(Error::MarketNotClosed);
        }
        Self::persist(
            &env,
            &DataKey::CatAttestation(market_id, outcome_index, signer),
            &true,
        );
        let count_key = DataKey::CatCount(market_id, outcome_index);
        let count = Self::cat_attestation_count(&env, market_id, outcome_index) + 1;
        Self::persist(&env, &count_key, &count);
        if count >= config.threshold
            && !env
                .storage()
                .persistent()
                .has(&DataKey::CatProposal(market_id))
        {
            let proposal = CatProposal {
                outcome_index,
                proposed_at: env.ledger().timestamp(),
            };
            Self::persist(&env, &DataKey::CatProposal(market_id), &proposal);
            CatResolutionProposed {
                market_id,
                outcome_index,
                proposed_at: proposal.proposed_at,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Categorical counterpart of `finalize_signers`: once the dispute window
    /// of a proposal has passed and its index still has `threshold`
    /// attestations, resolves the market in market-core and returns the
    /// winning index.
    pub fn finalize_cat(env: Env, market_id: u64) -> Result<u32, Error> {
        Self::assert_not_disputed(&env, market_id)?;
        let config: CatSignerConfig = Self::load(&env, DataKey::CatSigners(market_id))?;
        let proposal: CatProposal =
            Self::load(&env, DataKey::CatProposal(market_id)).map_err(|_| Error::NoProposal)?;
        if env.ledger().timestamp() < proposal.proposed_at + config.dispute_window {
            return Err(Error::DisputeWindowOpen);
        }
        if Self::cat_attestation_count(&env, market_id, proposal.outcome_index) < config.threshold {
            return Err(Error::ThresholdNotReached);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        MarketCoreClient::new(&env, &market_core).resolve_cat(&market_id, &proposal.outcome_index);
        Self::set_state(&env, market_id, ResolutionState::Finalized);
        CatResolutionFinalized {
            market_id,
            outcome_index: proposal.outcome_index,
            finalized_at: env.ledger().timestamp(),
        }
        .publish(&env);
        Ok(proposal.outcome_index)
    }

    /// Challenges the current proposal of a `SignersDisputable` market while
    /// its dispute window is still open (strictly before `proposed_at +
    /// dispute_window`, the instant `finalize_signers` becomes callable). The
    /// disputer escrows `dispute_bond` of the collateral token, which freezes
    /// finalization until the escalation authority rules or
    /// `escalation_timeout` lapses. `alternative` is the outcome the disputer
    /// claims is correct (`None`: the market is invalid); it only informs the
    /// ruling and must differ from the proposal (so `None` is rejected for an
    /// `Invalid` proposal). The disputer may also be a proposing signer.
    pub fn dispute(
        env: Env,
        market_id: u64,
        disputer: Address,
        alternative: Option<Outcome>,
    ) -> Result<(), Error> {
        disputer.require_auth();
        let config: DisputableSignerConfig = Self::load(&env, DataKey::Disputable(market_id))?;
        Self::assert_not_disputed(&env, market_id)?;
        if Self::resolution_state(&env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let proposal = Self::load_proposal(&env, market_id).ok_or(Error::NoProposal)?;
        let now = env.ledger().timestamp();
        if now >= proposal.proposed_at.saturating_add(config.dispute_window) {
            return Err(Error::DisputeWindowClosed);
        }
        let claimed = alternative
            .as_ref()
            .map_or(AttestedOutcome::Invalid, AttestedOutcome::from_market);
        if claimed == proposal.outcome {
            return Err(Error::InvalidConfig);
        }

        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        let token = core_call(MarketCoreClient::new(&env, &market_core).try_get_config())?.collateral;
        token::Client::new(&env, &token).transfer(
            &disputer,
            env.current_contract_address(),
            &config.dispute_bond,
        );
        Self::persist(
            &env,
            &DataKey::Dispute(market_id),
            &Dispute {
                disputer: disputer.clone(),
                bond: config.dispute_bond,
                token,
                opened_at: now,
                payee: None,
            },
        );
        Self::set_state(&env, market_id, ResolutionState::Disputed);
        Disputed {
            market_id,
            disputer,
            bond: config.dispute_bond,
            alternative,
        }
        .publish(&env);
        Ok(())
    }

    /// Guardian escalation: the admin rules on an open dispute.
    pub fn settle_dispute(env: Env, market_id: u64, verdict: Verdict) -> Result<(), Error> {
        let config: DisputableSignerConfig = Self::load(&env, DataKey::Disputable(market_id))?;
        if config.escalation != Escalation::Guardian {
            return Err(Error::WrongMode);
        }
        Self::require_admin(&env)?;
        Self::apply_verdict(&env, market_id, verdict)
    }

    /// Committee escalation: each member votes once; the first verdict to
    /// gather `k` votes settles the dispute.
    pub fn escalation_attest(
        env: Env,
        market_id: u64,
        member: Address,
        verdict: Verdict,
    ) -> Result<(), Error> {
        member.require_auth();
        let config: DisputableSignerConfig = Self::load(&env, DataKey::Disputable(market_id))?;
        let Escalation::Committee(members, k) = config.escalation else {
            return Err(Error::WrongMode);
        };
        if !Self::contains(&members, &member) {
            return Err(Error::NotSigner);
        }
        Self::open_dispute(&env, market_id)?;
        let vote = DataKey::EscalationVote(market_id, member);
        if env.storage().persistent().has(&vote) {
            return Err(Error::AlreadyAttested);
        }
        Self::persist(&env, &vote, &true);
        let count_key = DataKey::EscalationCount(market_id, verdict);
        let count = env.storage().persistent().get(&count_key).unwrap_or(0u32) + 1;
        Self::persist(&env, &count_key, &count);
        if count >= k {
            Self::apply_verdict(&env, market_id, verdict)?;
        }
        Ok(())
    }

    /// Permissionless fallback when the escalation authority never rules:
    /// `escalation_timeout` after the dispute opened, the bond is refunded and
    /// the market is voided, so neither side wins by default.
    pub fn expire_dispute(env: Env, market_id: u64) -> Result<(), Error> {
        let config: DisputableSignerConfig = Self::load(&env, DataKey::Disputable(market_id))?;
        let dispute = Self::open_dispute(&env, market_id)?;
        if env.ledger().timestamp() < dispute.opened_at.saturating_add(config.escalation_timeout) {
            return Err(Error::DeadlineNotReached);
        }
        let market_core: Address = Self::instance_get(&env, DataKey::MarketCore)?;
        core_call(MarketCoreClient::new(&env, &market_core).try_void_market(&market_id))?;
        Self::refund_open_dispute(&env, market_id);
        Self::set_state(&env, market_id, ResolutionState::Finalized);
        DisputeSettled {
            market_id,
            verdict: Verdict::Invalid,
            disputer_won: false,
            payout: dispute.bond,
        }
        .publish(&env);
        Ok(())
    }

    /// Pays a settled dispute's bond to its payee (the disputer, or the
    /// market-core treasury when the proposal was upheld). Permissionless.
    pub fn claim_dispute_bond(env: Env, market_id: u64) -> Result<(), Error> {
        let key = DataKey::Dispute(market_id);
        let dispute: Dispute = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoDispute)?;
        let payee = dispute.payee.ok_or(Error::DisputeActive)?;
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &dispute.token).transfer(
            &env.current_contract_address(),
            &payee,
            &dispute.bond,
        );
        Ok(())
    }

    pub fn state(env: Env, market_id: u64) -> ResolutionState {
        Self::resolution_state(&env, market_id)
    }
}

impl Resolver {
    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> Result<V, Error> {
        env.storage()
            .instance()
            .get(&key)
            .ok_or(Error::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::instance_get(env, DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn load_pending(env: &Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    fn load<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> Result<V, Error> {
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotConfigured)
    }

    fn resolution_state(env: &Env, market_id: u64) -> ResolutionState {
        env.storage()
            .persistent()
            .get(&DataKey::State(market_id))
            .unwrap_or(ResolutionState::Unconfigured)
    }

    /// Writes the per-market state and extends its TTL. An archived entry is
    /// not lost (it must be restored before any transaction can touch it),
    /// but keeping terminal state live spares every later call the restore.
    fn set_state(env: &Env, market_id: u64, state: ResolutionState) {
        let key = DataKey::State(market_id);
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// `close_time` of either market kind, so spec-independent entrypoints
    /// (`expire_market`, `resolution_deadline`, `attest_cat`) work for
    /// categorical markets too.
    fn market_close_time(env: &Env, market_id: u64) -> Result<u64, Error> {
        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(env, &market_core);
        Ok(match core.market_kind(&market_id) {
            MarketKind::Binary => core.get_market(&market_id).close_time,
            MarketKind::Categorical(_) => core.get_cat_market(&market_id).close_time,
        })
    }

    /// Committed `resolution_hash` of either market kind.
    fn market_resolution_hash(env: &Env, market_id: u64) -> Result<BytesN<32>, Error> {
        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(env, &market_core);
        Ok(match core.market_kind(&market_id) {
            MarketKind::Binary => core.get_market(&market_id).resolution_hash,
            MarketKind::Categorical(_) => core.get_cat_market(&market_id).resolution_hash,
        })
    }

    /// `close_time + RESOLUTION_GRACE_SECS` for either market kind.
    fn market_deadline(env: &Env, market_id: u64) -> Result<u64, Error> {
        Ok(Self::market_close_time(env, market_id)?.saturating_add(RESOLUTION_GRACE_SECS))
    }

    fn expiry_mode(env: &Env, market_id: u64) -> ExpiryMode {
        let storage = env.storage().persistent();
        if storage.has(&DataKey::Price(market_id))
            || (storage.has(&DataKey::Hybrid(market_id))
                && Self::resolution_state(env, market_id) != ResolutionState::HybridFallbackOpen)
        {
            ExpiryMode::Price
        } else if storage.has(&DataKey::Scalar(market_id)) {
            ExpiryMode::Scalar
        } else if storage.has(&DataKey::Signers(market_id))
            || storage.has(&DataKey::Disputable(market_id))
            || storage.has(&DataKey::WeightedKeys(market_id))
            || storage.has(&DataKey::CatSigners(market_id))
            || storage.has(&DataKey::CommitteeSpec(market_id))
            || (storage.has(&DataKey::Hybrid(market_id))
                && Self::resolution_state(env, market_id) == ResolutionState::HybridFallbackOpen)
        {
            ExpiryMode::Signers
        } else {
            ExpiryMode::Unrevealed
        }
    }

    fn assert_not_disputed(env: &Env, market_id: u64) -> Result<(), Error> {
        if Self::resolution_state(env, market_id) == ResolutionState::Disputed {
            return Err(Error::DisputeActive);
        }
        Ok(())
    }

    /// The dispute of `market_id` if it is still waiting for a ruling.
    fn open_dispute(env: &Env, market_id: u64) -> Result<Dispute, Error> {
        let dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(market_id))
            .ok_or(Error::NoDispute)?;
        if dispute.payee.is_some() {
            return Err(Error::AlreadyFinalized);
        }
        Ok(dispute)
    }

    /// Marks an open dispute's bond as refundable to its disputer (a no-op if
    /// there is none). The funds move on `claim_dispute_bond`.
    fn refund_open_dispute(env: &Env, market_id: u64) {
        if let Ok(mut dispute) = Self::open_dispute(env, market_id) {
            dispute.payee = Some(dispute.disputer.clone());
            Self::persist(env, &DataKey::Dispute(market_id), &dispute);
        }
    }

    /// Executes the escalation authority's ruling: finalizes the market in
    /// market-core and assigns the bond. Upholding the proposal forfeits the
    /// bond to the treasury; any other ruling returns it to the disputer.
    fn apply_verdict(env: &Env, market_id: u64, verdict: Verdict) -> Result<(), Error> {
        let mut dispute = Self::open_dispute(env, market_id)?;
        let proposal = Self::load_proposal(env, market_id).ok_or(Error::MarketNotConfigured)?;
        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let core = MarketCoreClient::new(env, &market_core);

        let upheld = proposal.outcome
            == match verdict {
                Verdict::Yes => AttestedOutcome::Yes,
                Verdict::No => AttestedOutcome::No,
                Verdict::Invalid => AttestedOutcome::Invalid,
            };
        match verdict {
            Verdict::Yes => core_call(core.try_resolve(&market_id, &market_core::Outcome::Yes))?,
            Verdict::No => core_call(core.try_resolve(&market_id, &market_core::Outcome::No))?,
            Verdict::Invalid => core_call(core.try_void_market(&market_id))?,
        }
        dispute.payee = Some(if upheld {
            core_call(core.try_get_config())?.treasury
        } else {
            dispute.disputer.clone()
        });
        Self::persist(env, &DataKey::Dispute(market_id), &dispute);
        Self::set_state(env, market_id, ResolutionState::Finalized);
        DisputeSettled {
            market_id,
            verdict,
            disputer_won: !upheld,
            payout: dispute.bond,
        }
        .publish(env);
        Ok(())
    }

    // ----- legacy_reads: V2 keys with fallback to pre-`AttestedOutcome` keys --
    //
    // A redeployed resolver never has legacy entries; these helpers only
    // matter if the contract is upgraded in place (ADR 0003, option B). Reads
    // combine both key generations; every write goes to the V2 key and
    // deletes the matching legacy key in the same invocation, so nothing is
    // ever counted twice.

    /// Attestations for `outcome`: `CountV2` plus any legacy `Count` (Yes/No
    /// only; `Invalid` has no legacy key).
    fn attestation_count(env: &Env, market_id: u64, outcome: AttestedOutcome) -> u32 {
        let storage = env.storage().persistent();
        let current: u32 = storage
            .get(&DataKey::CountV2(market_id, outcome))
            .unwrap_or(0);
        let legacy: u32 = outcome
            .to_market()
            .and_then(|o| storage.get(&DataKey::Count(market_id, o)))
            .unwrap_or(0);
        current + legacy
    }

    /// Stores `count` under `CountV2` and drops the legacy `Count`, whose value
    /// `count` already includes (it came from `attestation_count`).
    fn save_attestation_count(env: &Env, market_id: u64, outcome: AttestedOutcome, count: u32) {
        Self::persist(env, &DataKey::CountV2(market_id, outcome), &count);
        if let Some(o) = outcome.to_market() {
            env.storage()
                .persistent()
                .remove(&DataKey::Count(market_id, o));
        }
    }

    fn has_attested(env: &Env, market_id: u64, outcome: AttestedOutcome, signer: &Address) -> bool {
        let storage = env.storage().persistent();
        storage.has(&DataKey::AttestationV2(market_id, outcome, signer.clone()))
            || outcome
                .to_market()
                .is_some_and(|o| storage.has(&DataKey::Attestation(market_id, o, signer.clone())))
    }

    fn load_proposal(env: &Env, market_id: u64) -> Option<SignerProposalV2> {
        let storage = env.storage().persistent();
        storage.get(&DataKey::ProposalV2(market_id)).or_else(|| {
            storage
                .get::<_, SignerProposal>(&DataKey::Proposal(market_id))
                .map(|p| SignerProposalV2 {
                    outcome: AttestedOutcome::from_market(&p.outcome),
                    proposed_at: p.proposed_at,
                })
        })
    }

    fn has_proposal(env: &Env, market_id: u64) -> bool {
        let storage = env.storage().persistent();
        storage.has(&DataKey::ProposalV2(market_id)) || storage.has(&DataKey::Proposal(market_id))
    }

    fn remove_proposal(env: &Env, market_id: u64) {
        let storage = env.storage().persistent();
        storage.remove(&DataKey::ProposalV2(market_id));
        storage.remove(&DataKey::Proposal(market_id));
    }

    /// Records `outcome` as the pending proposal (replacing any earlier one,
    /// legacy included) and starts its dispute window now.
    fn propose(env: &Env, market_id: u64, outcome: AttestedOutcome) {
        let proposal = SignerProposalV2 {
            outcome,
            proposed_at: env.ledger().timestamp(),
        };
        Self::remove_proposal(env, market_id);
        Self::persist(env, &DataKey::ProposalV2(market_id), &proposal);
        ResolutionProposedV2 {
            market_id,
            outcome,
            proposed_at: proposal.proposed_at,
        }
        .publish(env);
    }

    fn signer_authority(env: &Env, market_id: u64) -> Result<SignerAuthority, Error> {
        let storage = env.storage().persistent();
        if let Some(cfg) = storage.get(&DataKey::Signers(market_id)) {
            return Ok(SignerAuthority::Signers(cfg));
        }
        if let Some(cfg) = storage.get(&DataKey::Disputable(market_id)) {
            return Ok(SignerAuthority::Disputable(cfg));
        }
        if let Some(cfg) = storage.get(&DataKey::WeightedKeys(market_id)) {
            return Ok(SignerAuthority::Weighted(cfg));
        }
        if let Some(ref_spec) = storage.get::<_, CommitteeRef>(&DataKey::CommitteeSpec(market_id)) {
            let comm = Self::load_committee(env, ref_spec.committee_id)?;
            return Ok(SignerAuthority::Committee(ref_spec, comm));
        }
        if let Some(cfg) = storage.get::<_, HybridConfig>(&DataKey::Hybrid(market_id)) {
            return Ok(SignerAuthority::Hybrid(cfg));
        }
        Err(Error::MarketNotConfigured)
    }

    /// Whether `outcome` currently has enough attestations / signature weight
    /// (in the current round) to be finalized.
    fn has_quorum(
        env: &Env,
        authority: &SignerAuthority,
        market_id: u64,
        outcome: AttestedOutcome,
    ) -> bool {
        match authority {
            SignerAuthority::Signers(SignerConfig { threshold, .. })
            | SignerAuthority::Disputable(DisputableSignerConfig { threshold, .. }) => {
                Self::attestation_count(env, market_id, outcome) >= *threshold
            }
            // Weighted keys sign market-core outcomes only (the signed message
            // encodes `Outcome`), so they can never propose `Invalid`.
            SignerAuthority::Weighted(cfg) => outcome.to_market().is_some_and(|o| {
                let round = Self::round(env, market_id);
                Self::round_weight(env, market_id, round, &o) >= cfg.weight_threshold
            }),
            SignerAuthority::Committee(ref_spec, comm) => {
                let current = comm.epoch;
                if current < ref_spec.min_epoch
                    || current.saturating_sub(ref_spec.min_epoch) > ref_spec.max_rotation_delta
                {
                    return false;
                }
                let mut votes: u32 = 0;
                for member in comm.members.iter() {
                    if Self::has_attested(env, market_id, outcome, &member) {
                        votes += 1;
                    }
                }
                votes >= comm.threshold
            }
            SignerAuthority::Hybrid(cfg) => {
                Self::attestation_count(env, market_id, outcome) >= cfg.fallback.threshold
            }
        }
    }

    /// A proposal exists whose outcome still has quorum, so `finalize_signers`
    /// will succeed once the dispute window elapses.
    fn has_valid_proposal(env: &Env, market_id: u64) -> Result<bool, Error> {
        let Some(proposal) = Self::load_proposal(env, market_id) else {
            return Ok(false);
        };
        let authority = Self::signer_authority(env, market_id)?;
        Ok(Self::has_quorum(
            env,
            &authority,
            market_id,
            proposal.outcome,
        ))
    }

    fn cat_attestation_count(env: &Env, market_id: u64, outcome_index: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::CatCount(market_id, outcome_index))
            .unwrap_or(0)
    }

    /// Categorical counterpart of `has_valid_proposal`: a `CatProposal` exists
    /// whose attested count still meets the configured threshold, so
    /// `finalize_cat` will succeed once the dispute window elapses.
    fn has_valid_cat_proposal(env: &Env, market_id: u64) -> Result<bool, Error> {
        let Some(proposal) = env
            .storage()
            .persistent()
            .get::<_, CatProposal>(&DataKey::CatProposal(market_id))
        else {
            return Ok(false);
        };
        let config: CatSignerConfig = env
            .storage()
            .persistent()
            .get(&DataKey::CatSigners(market_id))
            .ok_or(Error::MarketNotConfigured)?;
        Ok(Self::cat_attestation_count(env, market_id, proposal.outcome_index) >= config.threshold)
    }

    /// Sets a persistent entry and extends its TTL.
    fn persist<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
        value: &V,
    ) {
        env.storage().persistent().set(key, value);
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn round(env: &Env, market_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Round(market_id))
            .unwrap_or(0)
    }

    fn round_weight(env: &Env, market_id: u64, round: u32, outcome: &Outcome) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Weight(market_id, round, outcome.clone()))
            .unwrap_or(0)
    }

    fn weight_of(config: &WeightedKeyConfig, pubkey: &BytesN<32>) -> Option<u32> {
        config
            .signers
            .iter()
            .find(|key| key.pubkey == *pubkey)
            .map(|key| key.weight)
    }

    /// The exact bytes weighted-key signers sign (never hashed first, so any
    /// Ed25519 library can reproduce it):
    fn attestation_message(
        env: &Env,
        market_id: u64,
        round: u32,
        outcome: &Outcome,
        resolution_hash: &BytesN<32>,
    ) -> Bytes {
        let mut message = Bytes::from_slice(env, ATTEST_DOMAIN);
        message.append(&env.ledger().network_id().into());
        message.append(&env.current_contract_address().to_xdr(env));
        message.extend_from_array(&market_id.to_be_bytes());
        message.extend_from_array(&round.to_be_bytes());
        message.push_back(match outcome {
            Outcome::Yes => 0,
            Outcome::No => 1,
        });
        message.append(&resolution_hash.clone().into());
        message
    }

    fn disputable_config_is_valid(cfg: &DisputableSignerConfig) -> bool {
        let committee_ok = match &cfg.escalation {
            Escalation::Guardian => true,
            Escalation::Committee(members, k) => {
                *k != 0
                    && *k <= members.len()
                    && members.iter().enumerate().all(|(index, member)| {
                        !Self::contains(&cfg.signers, &member)
                            && !members.iter().take(index).any(|earlier| earlier == member)
                    })
            }
        };
        committee_ok
            && !cfg.signers.is_empty()
            && cfg.threshold != 0
            && cfg.threshold <= cfg.signers.len()
            && cfg.dispute_window != 0
            && cfg.dispute_bond > 0
            && cfg.escalation_timeout != 0
    }

    fn weighted_config_is_valid(cfg: &WeightedKeyConfig) -> bool {
        let count = cfg.signers.len();
        if count == 0 || count > MAX_WEIGHTED_SIGNERS || cfg.dispute_window == 0 {
            return false;
        }
        let mut total: u32 = 0;
        for (index, key) in cfg.signers.iter().enumerate() {
            let Some(sum) = total.checked_add(key.weight) else {
                return false;
            };
            total = sum;
            let duplicate = cfg
                .signers
                .iter()
                .take(index)
                .any(|earlier| earlier.pubkey == key.pubkey);
            if key.weight == 0 || duplicate {
                return false;
            }
        }
        cfg.weight_threshold != 0 && cfg.weight_threshold <= total
    }

    /// The single rule for whether a feed read may settle a market, shared by
    /// `snapshot_price` and every resolution path so a snapshot can never pin
    /// a price resolution would reject. The place to add further checks (for
    /// example rejecting `price <= 0`).
    fn validate_price(
        config: &PriceConfig,
        close_time: u64,
        data: &PriceData,
    ) -> Result<(), Error> {
        if data.timestamp > close_time || close_time - data.timestamp > config.max_staleness {
            return Err(Error::StalePrice);
        }
        Ok(())
    }

    /// Applies the committed comparison.
    fn outcome_for(config: &PriceConfig, price: i128) -> Outcome {
        let hit = match config.direction {
            PriceDirection::Above => price > config.threshold,
            PriceDirection::AtOrAbove => price >= config.threshold,
            PriceDirection::Below => price < config.threshold,
            PriceDirection::AtOrBelow => price <= config.threshold,
        };
        if hit {
            Outcome::Yes
        } else {
            Outcome::No
        }
    }

    /// Reads the committed feed at `close_time` and validates it. A missing
    /// record or a trapping oracle is `PriceUnavailable`, never a host error.
    fn read_feed(env: &Env, config: &PriceConfig, close_time: u64) -> Result<PriceData, Error> {
        let Ok(Ok(Some(data))) =
            ReflectorPriceClient::new(env, &config.reflector).try_price(&config.asset, &close_time)
        else {
            return Err(Error::PriceUnavailable);
        };
        Self::validate_price(config, close_time, &data)?;
        Ok(data)
    }

    /// The outcome the market's price rule gives, from its stored snapshot
    /// when there is one (re-validated, no oracle call), else from a live
    /// read. The flag reports whether the snapshot was used.
    fn price_outcome(
        env: &Env,
        market_id: u64,
        config: &PriceConfig,
        close_time: u64,
    ) -> Result<(Outcome, PriceData, bool), Error> {
        let key = DataKey::Snapshot(market_id);
        let storage = env.storage().persistent();
        let (data, from_snapshot) = match storage.get::<_, PriceSnapshot>(&key) {
            Some(snapshot) => {
                storage.extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
                Self::validate_price(config, close_time, &snapshot.data)?;
                (snapshot.data, true)
            }
            None => (Self::read_feed(env, config, close_time)?, false),
        };
        Ok((Self::outcome_for(config, data.price), data, from_snapshot))
    }

    /// The price rule of a price or hybrid market. Signer-mode markets are
    /// `WrongMode`; markets with no revealed spec `MarketNotConfigured`.
    fn price_config(env: &Env, market_id: u64) -> Result<PriceConfig, Error> {
        let storage = env.storage().persistent();
        if let Some(cfg) = storage.get(&DataKey::Price(market_id)) {
            return Ok(cfg);
        }
        if let Some(hybrid) = storage.get::<_, HybridConfig>(&DataKey::Hybrid(market_id)) {
            return Ok(hybrid.price);
        }
        match Self::signer_authority(env, market_id) {
            Ok(_) => Err(Error::WrongMode),
            Err(_) => Err(Error::MarketNotConfigured),
        }
    }

    fn settle_price(
        env: &Env,
        market_core: &Address,
        market_id: u64,
        outcome: &Outcome,
        data: &PriceData,
        from_snapshot: bool,
    ) -> Result<(), Error> {
        core_call(
            MarketCoreClient::new(env, market_core)
                .try_resolve(&market_id, &to_core_outcome(outcome)),
        )?;
        Self::set_state(env, market_id, ResolutionState::Finalized);
        PriceResolution {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            outcome: outcome.clone(),
        }
        .publish(env);
        PriceResolutionV2 {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            outcome: outcome.clone(),
            from_snapshot,
        }
        .publish(env);
        Ok(())
    }

    /// Scalar counterpart of `try_price_outcome`: same feed read and
    /// staleness rules, then the clamped in-range position as bps. The
    /// multiply cannot overflow `i128` because `validate_rule` caps `upper`
    /// at `i128::MAX / BPS` and `lower >= 0`, so
    /// `0 <= clamped - lower <= upper - lower <= i128::MAX / BPS`.
    fn try_scalar_payout(
        env: &Env,
        config: &ScalarPriceConfig,
        close_time: u64,
    ) -> Result<(u32, PriceData), Error> {
        let Ok(Ok(Some(data))) =
            ReflectorPriceClient::new(env, &config.reflector).try_price(&config.asset, &close_time)
        else {
            return Err(Error::PriceUnavailable);
        };
        if data.timestamp > close_time || close_time - data.timestamp > config.max_staleness {
            return Err(Error::StalePrice);
        }
        if data.price <= 0 {
            return Err(Error::InvalidPrice);
        }
        let clamped = data.price.clamp(config.lower, config.upper);
        let payout = (clamped - config.lower) * BPS / (config.upper - config.lower);
        Ok((payout as u32, data))
    }

    fn settle_scalar(
        env: &Env,
        market_core: &Address,
        market_id: u64,
        payout_long_bps: u32,
        data: &PriceData,
    ) {
        MarketCoreClient::new(env, market_core).resolve_scalar(&market_id, &payout_long_bps);
        Self::set_state(env, market_id, ResolutionState::Finalized);
        ScalarPriceResolution {
            market_id,
            price: data.price,
            price_timestamp: data.timestamp,
            payout_long_bps,
        }
        .publish(env);
    }

    fn contains(list: &Vec<Address>, address: &Address) -> bool {
        list.iter().any(|candidate| candidate == *address)
    }

    fn assert_unconfigured(env: &Env, market_id: u64) -> Result<(), Error> {
        if Self::resolution_state(env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        let storage = env.storage().persistent();
        if storage.has(&DataKey::Price(market_id))
            || storage.has(&DataKey::Signers(market_id))
            || storage.has(&DataKey::WeightedKeys(market_id))
            || storage.has(&DataKey::Disputable(market_id))
            || storage.has(&DataKey::CatSigners(market_id))
            || storage.has(&DataKey::Scalar(market_id))
            || storage.has(&DataKey::CommitteeSpec(market_id))
            || storage.has(&DataKey::Hybrid(market_id))
        {
            return Err(Error::MarketAlreadyConfigured);
        }
        Ok(())
    }

    /// Shared reveal pipeline for every entrypoint.
    fn reveal(
        env: &Env,
        market_id: u64,
        rule: &ResolutionSpec,
        commitment: &BytesN<32>,
    ) -> Result<(), Error> {
        Self::assert_unconfigured(env, market_id)?;
        Self::validate_rule(rule)?;
        Self::assert_matches_commitment(env, market_id, commitment)?;
        Self::store_rule(env, market_id, rule);
        Ok(())
    }

    fn validate_rule(rule: &ResolutionSpec) -> Result<(), Error> {
        let valid = match rule {
            ResolutionSpec::Price(cfg) => cfg.threshold >= 0 && cfg.max_staleness != 0,
            ResolutionSpec::Signers(cfg) => {
                !cfg.signers.is_empty()
                    && cfg.threshold != 0
                    && cfg.threshold <= cfg.signers.len()
                    && cfg.dispute_window != 0
            }
            ResolutionSpec::WeightedKeys(cfg) => Self::weighted_config_is_valid(cfg),
            ResolutionSpec::SignersDisputable(cfg) => Self::disputable_config_is_valid(cfg),
            ResolutionSpec::CategoricalSigners(cfg) => {
                !cfg.signers.is_empty()
                    && cfg.threshold != 0
                    && cfg.threshold <= cfg.signers.len()
                    && cfg.dispute_window != 0
                    && (2..=MAX_CAT_OUTCOMES).contains(&cfg.outcome_count)
            }
            // `upper <= i128::MAX / BPS` keeps `try_scalar_payout`'s multiply
            // provably overflow-free.
            ResolutionSpec::Scalar(cfg) => {
                cfg.lower >= 0
                    && cfg.lower < cfg.upper
                    && cfg.upper <= i128::MAX / BPS
                    && cfg.max_staleness != 0
            }

            ResolutionSpec::Committee(cfg) => cfg.dispute_window != 0,
            ResolutionSpec::Hybrid(cfg) => {
                cfg.price.threshold >= 0
                    && cfg.price.max_staleness != 0
                    && !cfg.fallback.signers.is_empty()
                    && cfg.fallback.threshold != 0
                    && cfg.fallback.threshold <= cfg.fallback.signers.len()
                    && cfg.fallback.dispute_window != 0
                    && cfg.fallback_after > 0
                    && cfg.fallback_after >= cfg.price.max_staleness
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::InvalidConfig)
        }
    }

    fn store_rule(env: &Env, market_id: u64, rule: &ResolutionSpec) {
        let storage = env.storage().persistent();
        let (key, state) = match rule {
            ResolutionSpec::Price(cfg) => {
                let key = DataKey::Price(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::Unconfigured)
            }
            ResolutionSpec::Signers(cfg) => {
                let key = DataKey::Signers(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::SignersPending)
            }
            ResolutionSpec::WeightedKeys(cfg) => {
                let key = DataKey::WeightedKeys(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::SignersPending)
            }
            ResolutionSpec::SignersDisputable(cfg) => {
                let key = DataKey::Disputable(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::SignersPending)
            }
            ResolutionSpec::CategoricalSigners(cfg) => {
                let key = DataKey::CatSigners(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::SignersPending)
            }
            ResolutionSpec::Scalar(cfg) => {
                let key = DataKey::Scalar(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::Unconfigured)
            }

            ResolutionSpec::Committee(cfg) => {
                let key = DataKey::CommitteeSpec(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::SignersPending)
            }
            ResolutionSpec::Hybrid(cfg) => {
                let key = DataKey::Hybrid(market_id);
                storage.set(&key, cfg);
                (key, ResolutionState::HybridPricePending)
            }
        };
        storage.extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        if let Some((_, policy)) = Self::evidence_config_internal(env) {
            let p_key = DataKey::EvidencePolicy(market_id);
            storage.set(&p_key, &policy);
            storage.extend_ttl(&p_key, BUMP_THRESHOLD, BUMP_TO);
        }
        Self::set_state(env, market_id, state);
    }

    fn evidence_config_internal(env: &Env) -> Option<(Address, EvidencePolicy)> {
        env.storage().instance().get(&DataKey::EvidenceConfig)
    }

    fn validate_committee_members(members: &Vec<Address>) -> Result<(), Error> {
        if members.is_empty() {
            return Err(Error::InvalidConfig);
        }
        if members.len() > MAX_COMMITTEE {
            return Err(Error::CommitteeTooLarge);
        }
        for (i, member) in members.iter().enumerate() {
            if members.iter().take(i).any(|earlier| earlier == member) {
                return Err(Error::DuplicateMember);
            }
        }
        Ok(())
    }

    fn load_committee(env: &Env, committee_id: u64) -> Result<Committee, Error> {
        let key = DataKey::Committee(committee_id);
        let comm: Committee = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CommitteeNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(comm)
    }

    fn record_attestation(
        env: &Env,
        market_id: u64,
        signer: Address,
        outcome: AttestedOutcome,
        evidence: Option<u64>,
    ) -> Result<(), Error> {
        let authority = Self::signer_authority(env, market_id)?;
        let (threshold, members_opt) = match &authority {
            SignerAuthority::Signers(cfg) => {
                if !Self::contains(&cfg.signers, &signer) {
                    return Err(Error::NotSigner);
                }
                (cfg.threshold, None)
            }
            SignerAuthority::Disputable(cfg) => {
                if !Self::contains(&cfg.signers, &signer) {
                    return Err(Error::NotSigner);
                }
                (cfg.threshold, None)
            }
            SignerAuthority::Weighted(_) => return Err(Error::WrongMode),
            SignerAuthority::Committee(ref_spec, comm) => {
                let current = comm.epoch;
                if current < ref_spec.min_epoch
                    || current.saturating_sub(ref_spec.min_epoch) > ref_spec.max_rotation_delta
                {
                    return Err(Error::RotationBoundExceeded);
                }
                if !Self::contains(&comm.members, &signer) {
                    return Err(Error::NotSigner);
                }
                (comm.threshold, Some(current))
            }
            SignerAuthority::Hybrid(cfg) => {
                if Self::resolution_state(env, market_id) != ResolutionState::HybridFallbackOpen {
                    return Err(Error::WrongMode);
                }
                if !Self::contains(&cfg.fallback.signers, &signer) {
                    return Err(Error::NotSigner);
                }
                (cfg.fallback.threshold, None)
            }
        };

        let storage = env.storage().persistent();
        let policy = storage
            .get(&DataKey::EvidencePolicy(market_id))
            .or_else(|| Self::evidence_config_internal(env).map(|(_, p)| p))
            .unwrap_or(EvidencePolicy::Disabled);

        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(env, &market_core).try_get_market(&market_id),
        )?;
        // Before any write: this is what keeps an `Invalid` proposal (and so
        // `void_market`, which has no close-time guard) from existing before
        // close.
        if env.ledger().timestamp() < market.close_time {
            return Err(Error::MarketNotClosed);
        }

        if let Some(trace_id) = evidence {
            if policy == EvidencePolicy::Disabled {
                return Err(Error::EvidenceDisabled);
            }
            let Some((registry, _)) = Self::evidence_config_internal(env) else {
                return Err(Error::EvidenceDisabled);
            };
            if storage.has(&DataKey::EvidenceUsed(trace_id)) {
                return Err(Error::EvidenceAlreadyUsed);
            }
            let trace = match registry_call(
                RegistryClient::new(env, &registry).try_get_trace(&trace_id),
            ) {
                Ok(trace) => trace,
                // A missing trace (or a registry that cannot be read) is the
                // same caller-facing condition: the cited evidence is not
                // available. The registry's own numeric code is never leaked.
                Err(_) => return Err(Error::EvidenceNotFound),
            };
            if trace.agent != signer {
                return Err(Error::EvidenceAuthorMismatch);
            }
            if trace.market_id != market_id {
                return Err(Error::EvidenceMarketMismatch);
            }
            if trace.published_at < market.close_time {
                return Err(Error::EvidenceTooEarly);
            }
            let count_key = DataKey::EvidenceCount(market_id);
            let count: u32 = storage.get(&count_key).unwrap_or(0);
            let ev_key = DataKey::Evidence(market_id, count);
            let att_ev = AttestationEvidence {
                signer: signer.clone(),
                outcome,
                trace_id,
                trace_hash: trace.trace_hash,
                attested_at: env.ledger().timestamp(),
            };
            Self::persist(env, &ev_key, &att_ev);
            Self::persist(env, &count_key, &(count + 1));
            Self::persist(env, &DataKey::EvidenceUsed(trace_id), &true);
        } else if policy == EvidencePolicy::Required {
            return Err(Error::EvidenceRequired);
        }

        Self::assert_not_disputed(env, market_id)?;
        if Self::resolution_state(env, market_id).is_terminal() {
            return Err(Error::AlreadyFinalized);
        }
        if Self::has_attested(env, market_id, outcome, &signer) {
            return Err(Error::AlreadyAttested);
        }

        Self::persist(
            env,
            &DataKey::AttestationV2(market_id, outcome, signer.clone()),
            &true,
        );
        if let Some(epoch) = members_opt {
            Self::persist(
                env,
                &DataKey::AttestEpoch(market_id, signer.clone()),
                &epoch,
            );
        }

        let count = Self::attestation_count(env, market_id, outcome) + 1;
        Self::save_attestation_count(env, market_id, outcome, count);

        Attested {
            market_id,
            signer,
            outcome,
            trace_id: evidence,
            count,
        }
        .publish(env);

        let quorum_reached = if members_opt.is_some() {
            Self::has_quorum(env, &authority, market_id, outcome)
        } else {
            count >= threshold
        };

        // See `attest` for the split-vote rule.
        let may_propose = match Self::load_proposal(env, market_id) {
            None => true,
            Some(pending) => {
                outcome == AttestedOutcome::Invalid && pending.outcome != AttestedOutcome::Invalid
            }
        };
        if quorum_reached && may_propose {
            Self::propose(env, market_id, outcome);
        }
        Ok(())
    }

    /// Verifies `commitment` equals the market's `resolution_hash`, read from
    /// whichever market kind owns the id (binary or categorical).
    fn assert_matches_commitment(
        env: &Env,
        market_id: u64,
        commitment: &BytesN<32>,
    ) -> Result<(), Error> {
        let market_core: Address = Self::instance_get(env, DataKey::MarketCore)?;
        let market = core_call(
            MarketCoreClient::new(env, &market_core).try_get_market(&market_id),
        )?;
        if *commitment != market.resolution_hash {
            return Err(Error::SpecHashMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use market_core::{CatStatus, Category, MarketStatus};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
        token::{self, StellarAssetClient},
        BytesN, IntoVal,
    };
    use std::format;

    // ---- dual registration of market-core (coverage, issue #75) ---------------
    //
    // The wasm copy is what ships and what ADR 0002 requires the contract to be
    // *built* against, but code running inside the wasm VM is invisible to
    // `cargo llvm-cov`. A native `market-core` registration (a dev-dependency:
    // the duplicate `__constructor` export that forbids this in the wasm build
    // does not exist in a native test binary) runs the same scenarios as host
    // code. `MARKET_CORE_IMPL=native cargo test` flips the whole suite;
    // `both_modes!` pins individual scenarios to both.

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum McImpl {
        Wasm,
        Native,
    }

    std::thread_local! {
        static MC_OVERRIDE: core::cell::Cell<Option<McImpl>> = const { core::cell::Cell::new(None) };
    }

    fn mc_impl() -> McImpl {
        MC_OVERRIDE.with(|c| c.get()).unwrap_or_else(|| {
            match std::env::var("MARKET_CORE_IMPL").as_deref() {
                Ok("native") => McImpl::Native,
                _ => McImpl::Wasm,
            }
        })
    }

    /// Runs `f` with market-core registered as `how`, restoring the previous
    /// choice even if `f` panics.
    fn with_market_core<R>(how: McImpl, f: impl FnOnce() -> R) -> R {
        struct Restore(Option<McImpl>);
        impl Drop for Restore {
            fn drop(&mut self) {
                MC_OVERRIDE.with(|c| c.set(self.0));
            }
        }
        let _restore = Restore(MC_OVERRIDE.with(|c| c.replace(Some(how))));
        f()
    }

    /// `(admin, collateral, treasury, resolver, default_fee_bps, protocol_share_bps)`.
    fn register_market_core(
        env: &Env,
        args: (Address, Address, Address, Address, u32, u32),
    ) -> Address {
        match mc_impl() {
            McImpl::Wasm => env.register(market_core::WASM, args),
            McImpl::Native => env.register(
                ::market_core_native::MarketCore,
                ::market_core_native::MarketCoreArgs::__constructor(
                    &args.0, &args.1, &args.2, &args.3, &args.4, &args.5,
                ),
            ),
        }
    }

    /// Re-runs existing scenario tests (`#[test]` functions are plain functions
    /// too) once per market-core registration, as `<name>::wasm` and
    /// `<name>::native`.
    macro_rules! both_modes {
        ($($name:ident),+ $(,)?) => {$(
            mod $name {
                #[test]
                fn wasm() {
                    super::with_market_core(super::McImpl::Wasm, super::$name);
                }
                #[test]
                fn native() {
                    super::with_market_core(super::McImpl::Native, super::$name);
                }
            }
        )+};
    }

    #[contract]
    struct MockReflector;

    #[contractimpl]
    impl MockReflector {
        pub fn set_price(env: Env, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&0u32, &PriceData { price, timestamp });
        }

        pub fn price(env: Env, _asset: OracleAsset, _timestamp: u64) -> Option<PriceData> {
            env.storage().instance().get(&0u32)
        }
    }

    const NETWORK_ID: [u8; 32] = [7; 32];

    struct Fixture {
        env: Env,
        admin: Address,
        resolver: ResolverClient<'static>,
        resolver_id: Address,
        market_core: MarketCoreClient<'static>,
        market_id: u64,
        signer_a: Address,
        signer_b: Address,
        reflector_id: Address,
        spec: ResolutionSpec,
    }

    /// Builds a market whose `resolution_hash` commits to whatever
    /// `ResolutionSpec` the closure returns, mirroring the real flow: the
    /// creator decides the resolution rule up front, then it is revealed
    /// later via `register_price_spec` / `register_signer_spec`.
    fn fixture(
        spec_fn: impl FnOnce(&Env, &Address, &Address, &Address) -> ResolutionSpec,
    ) -> Fixture {
        fixture_with(spec_fn, |env, spec, _market_core| {
            legacy_spec_hash(env, spec)
        })
    }

    /// Like [`fixture`], but `commit` chooses the `resolution_hash` the market
    /// is created with, given the rule and the market-core address, so V2
    /// envelopes can be committed to.
    fn fixture_with(
        spec_fn: impl FnOnce(&Env, &Address, &Address, &Address) -> ResolutionSpec,
        commit: impl FnOnce(&Env, &ResolutionSpec, &Address) -> BytesN<32>,
    ) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_network_id(NETWORK_ID);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver_id = Address::generate(&env);
        let reflector_id = env.register(MockReflector, ());

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));

        let spec = spec_fn(&env, &reflector_id, &signer_a, &signer_b);
        let market_core_id = register_market_core(
            &env,
            (
                admin.clone(),
                collateral.address(),
                treasury.clone(),
                resolver_id.clone(),
                100u32,
                // Protocol keeps the whole fee; resolver tests do no splits.
                10_000u32,
            ),
        );
        let resolution_hash = commit(&env, &spec, &market_core_id);
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &resolution_hash,
            &soroban_sdk::String::from_str(&env, "ipfs://resolver-test"),
            &Category::Crypto,
            &2_000,
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        env.register_at(
            &resolver_id,
            Resolver,
            ResolverArgs::__constructor(&admin, &market_core_id),
        );
        let resolver = ResolverClient::new(&env, &resolver_id);

        Fixture {
            env,
            admin,
            resolver,
            resolver_id,
            market_core,
            market_id,
            signer_a,
            signer_b,
            reflector_id,
            spec,
        }
    }

    fn price_spec(env: &Env, reflector: &Address) -> PriceConfig {
        PriceConfig {
            reflector: reflector.clone(),
            asset: OracleAsset::Other(Symbol::new(env, "XLM")),
            threshold: 2_000,
            direction: PriceDirection::Above,
            max_staleness: 10,
        }
    }

    fn signer_spec(env: &Env, a: &Address, b: &Address) -> SignerConfig {
        SignerConfig {
            signers: Vec::from_array(env, [a.clone(), b.clone()]),
            threshold: 2,
            dispute_window: 100,
        }
    }

    fn v2_envelope(
        env: &Env,
        market_core: &Address,
        salt: [u8; 32],
        rule: &ResolutionSpec,
    ) -> ResolutionSpecV2 {
        ResolutionSpecV2 {
            version: 2,
            network_id: BytesN::from_array(env, &NETWORK_ID),
            market_core: market_core.clone(),
            salt: BytesN::from_array(env, &salt),
            rule: rule.clone(),
        }
    }

    fn envelope(f: &Fixture, salt: [u8; 32]) -> ResolutionSpecV2 {
        v2_envelope(&f.env, &f.market_core.address, salt, &f.spec)
    }

    /// A fixture whose market commits to the V2 envelope of the rule `spec_fn`
    /// returns, salted with `salt`.
    fn v2_fixture(
        salt: [u8; 32],
        spec_fn: impl FnOnce(&Env, &Address, &Address, &Address) -> ResolutionSpec,
    ) -> Fixture {
        fixture_with(spec_fn, move |env, rule, market_core| {
            spec_v2_hash(env, &v2_envelope(env, market_core, salt, rule))
        })
    }

    fn v2_signer_fixture(salt: [u8; 32]) -> Fixture {
        v2_fixture(salt, |env, _r, a, b| {
            ResolutionSpec::Signers(signer_spec(env, a, b))
        })
    }

    fn cat_signer_spec(env: &Env, a: &Address, b: &Address, outcome_count: u32) -> CatSignerConfig {
        CatSignerConfig {
            signers: Vec::from_array(env, [a.clone(), b.clone()]),
            threshold: 2,
            dispute_window: 100,
            outcome_count,
        }
    }

    /// A fixture whose market is categorical (3 outcomes, seeded from
    /// [5000, 3000, 2000] bps) and whose commitment is the legacy hash of the
    /// `CategoricalSigners` rule `spec_fn` returns.
    fn cat_fixture(spec_fn: impl FnOnce(&Env, &Address, &Address) -> CatSignerConfig) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_network_id(NETWORK_ID);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver_id = Address::generate(&env);
        let reflector_id = env.register(MockReflector, ());

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));

        let spec = ResolutionSpec::CategoricalSigners(spec_fn(&env, &signer_a, &signer_b));
        let market_core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.address(),
                treasury.clone(),
                resolver_id.clone(),
                100u32,
                10_000u32,
            ),
        );
        let resolution_hash = legacy_spec_hash(&env, &spec);
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let market_id = market_core.create_categorical_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &resolution_hash,
            &soroban_sdk::String::from_str(&env, "ipfs://resolver-cat-test"),
            &Category::Crypto,
            &2_000,
            &1_000_000_000_i128,
            &Vec::from_array(&env, [5_000u32, 3_000, 2_000]),
        );

        env.register_at(
            &resolver_id,
            Resolver,
            ResolverArgs::__constructor(&admin, &market_core_id),
        );
        let resolver = ResolverClient::new(&env, &resolver_id);

        Fixture {
            env,
            admin,
            resolver,
            resolver_id,
            market_core,
            market_id,
            signer_a,
            signer_b,
            reflector_id,
            spec,
        }
    }

    fn scalar_spec(env: &Env, reflector: &Address) -> ScalarPriceConfig {
        ScalarPriceConfig {
            reflector: reflector.clone(),
            asset: OracleAsset::Other(Symbol::new(env, "XLM")),
            lower: 100,
            upper: 250,
            max_staleness: 10,
        }
    }

    /// A fixture whose market is scalar over `[100, 250]` and whose commitment
    /// is the legacy hash of the `Scalar` rule `spec_fn` returns.
    fn scalar_fixture(spec_fn: impl FnOnce(&Env, &Address) -> ScalarPriceConfig) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_network_id(NETWORK_ID);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let signer_a = Address::generate(&env);
        let signer_b = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver_id = Address::generate(&env);
        let reflector_id = env.register(MockReflector, ());

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = StellarAssetClient::new(&env, &collateral.address());
        token.mint(&creator, &(1_000 * 10_000_000_i128));

        let spec = ResolutionSpec::Scalar(spec_fn(&env, &reflector_id));
        let market_core_id = env.register(
            market_core::WASM,
            (
                admin.clone(),
                collateral.address(),
                treasury.clone(),
                resolver_id.clone(),
                100u32,
                10_000u32,
            ),
        );
        let resolution_hash = legacy_spec_hash(&env, &spec);
        let market_core = MarketCoreClient::new(&env, &market_core_id);
        let ResolutionSpec::Scalar(cfg) = &spec else {
            unreachable!()
        };
        let market_id = market_core.create_scalar_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &resolution_hash,
            &soroban_sdk::String::from_str(&env, "ipfs://resolver-scalar-test"),
            &Category::Crypto,
            &2_000,
            &1_000_000_000_i128,
            &5000u32,
            &cfg.lower,
            &cfg.upper,
        );

        env.register_at(
            &resolver_id,
            Resolver,
            ResolverArgs::__constructor(&admin, &market_core_id),
        );
        let resolver = ResolverClient::new(&env, &resolver_id);

        Fixture {
            env,
            admin,
            resolver,
            resolver_id,
            market_core,
            market_id,
            signer_a,
            signer_b,
            reflector_id,
            spec,
        }
    }

    #[test]
    fn price_mode_resolves_from_historical_reflector_price() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);
        reflector.set_price(&2_500_i128, &1_999_u64);

        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn signer_mode_requires_threshold_and_waits_for_dispute_window() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::No);

        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::No
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::No)
        );
    }

    #[test]
    fn cat_signer_mode_requires_threshold_and_waits_for_dispute_window() {
        let f = cat_fixture(|env, a, b| cat_signer_spec(env, a, b, 3));
        let ResolutionSpec::CategoricalSigners(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_cat_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        f.resolver.attest_cat(&f.market_id, &f.signer_a, &2u32);
        f.resolver.attest_cat(&f.market_id, &f.signer_b, &2u32);

        assert_eq!(
            f.resolver.try_finalize_cat(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(f.resolver.finalize_cat(&f.market_id), 2u32);
        assert_eq!(
            f.market_core.get_cat_market(&f.market_id).status,
            CatStatus::Resolved(2)
        );
    }

    #[test]
    fn cat_attest_validations() {
        let f = cat_fixture(|env, a, b| cat_signer_spec(env, a, b, 3));

        // Nothing revealed yet: attestations cannot be recorded.
        assert_eq!(
            f.resolver.try_attest_cat(&f.market_id, &f.signer_a, &0u32),
            Err(Ok(Error::MarketNotConfigured))
        );

        let ResolutionSpec::CategoricalSigners(spec) = f.spec.clone() else {
            unreachable!()
        };
        // Outcome counts outside 2..=8 and a zero threshold are rejected by
        // validation before the commitment is checked.
        for bad_count in [1u32, 9] {
            let mut bad = spec.clone();
            bad.outcome_count = bad_count;
            assert_eq!(
                f.resolver.try_register_cat_signer_spec(&f.market_id, &bad),
                Err(Ok(Error::InvalidConfig))
            );
        }
        let mut bad = spec.clone();
        bad.threshold = 0;
        assert_eq!(
            f.resolver.try_register_cat_signer_spec(&f.market_id, &bad),
            Err(Ok(Error::InvalidConfig))
        );
        // A valid-but-different rule does not match the committed hash.
        let mut wrong = spec.clone();
        wrong.threshold = 1;
        assert_eq!(
            f.resolver
                .try_register_cat_signer_spec(&f.market_id, &wrong),
            Err(Ok(Error::SpecHashMismatch))
        );
        f.resolver.register_cat_signer_spec(&f.market_id, &spec);
        // One reveal per market.
        assert_eq!(
            f.resolver.try_register_cat_signer_spec(&f.market_id, &spec),
            Err(Ok(Error::MarketAlreadyConfigured))
        );

        // Attesting before close is rejected.
        f.env.ledger().set_timestamp(1_500);
        assert_eq!(
            f.resolver.try_attest_cat(&f.market_id, &f.signer_a, &0u32),
            Err(Ok(Error::MarketNotClosed))
        );
        f.env.ledger().set_timestamp(2_000);
        // Only configured signers can attest.
        let outsider = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_attest_cat(&f.market_id, &outsider, &0u32),
            Err(Ok(Error::NotSigner))
        );
        // Indices at or above the committed outcome count are rejected.
        assert_eq!(
            f.resolver.try_attest_cat(&f.market_id, &f.signer_a, &3u32),
            Err(Ok(Error::InvalidOutcomeIndex))
        );
        // An attestation is recorded at most once per signer and index.
        f.resolver.attest_cat(&f.market_id, &f.signer_a, &1u32);
        assert_eq!(
            f.resolver.try_attest_cat(&f.market_id, &f.signer_a, &1u32),
            Err(Ok(Error::AlreadyAttested))
        );
    }

    #[test]
    fn cat_proposal_opens_with_quorum_and_guards_expiry() {
        let f = cat_fixture(|env, a, b| cat_signer_spec(env, a, b, 3));
        let ResolutionSpec::CategoricalSigners(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_cat_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        // No proposal until `threshold` signers attest the same index.
        assert_eq!(
            f.resolver.try_finalize_cat(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
        f.resolver.attest_cat(&f.market_id, &f.signer_a, &0u32);
        f.resolver.attest_cat(&f.market_id, &f.signer_b, &1u32);
        assert_eq!(
            f.resolver.try_finalize_cat(&f.market_id),
            Err(Ok(Error::NoProposal))
        );

        // The quorum that opens the proposal lands past the grace deadline, so
        // the pending winner blocks expiry…
        f.env
            .ledger()
            .set_timestamp(2_000 + RESOLUTION_GRACE_SECS + 1);
        f.resolver.attest_cat(&f.market_id, &f.signer_b, &0u32);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::ResolutionAvailable))
        );
        // …and the guardian can still withdraw it, because `cancel_proposal`
        // is bounded by the proposal's own dispute window. Afterwards the
        // market voids.
        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.market_core.get_cat_market(&f.market_id).status,
            CatStatus::Void
        );
    }

    #[test]
    fn scalar_price_mode_resolves_mid_range() {
        let f = scalar_fixture(scalar_spec);
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);
        reflector.set_price(&176_i128, &1_999_u64);

        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_scalar_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        // (176 - 100) / (250 - 100) in bps: 760_000 / 150 = 5066.67 -> 5066.
        assert_eq!(f.resolver.resolve_scalar_price(&f.market_id), 5_066);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::ResolvedScalar(5_066)
        );
        // One-shot: the market is terminal after resolution.
        assert_eq!(
            f.resolver.try_resolve_scalar_price(&f.market_id),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn scalar_price_clamps_below_lower() {
        let f = scalar_fixture(scalar_spec);
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);
        // 50 is below `lower` (100): the payout clamps to zero instead of
        // reverting, so the market always resolves.
        reflector.set_price(&50_i128, &1_999_u64);

        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_scalar_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        assert_eq!(f.resolver.resolve_scalar_price(&f.market_id), 0);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::ResolvedScalar(0)
        );
    }

    #[test]
    fn scalar_price_clamps_above_upper() {
        let f = scalar_fixture(scalar_spec);
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);
        // 400 is above `upper` (250): the payout saturates at 10_000 bps.
        reflector.set_price(&400_i128, &1_999_u64);

        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_scalar_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        assert_eq!(f.resolver.resolve_scalar_price(&f.market_id), 10_000);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::ResolvedScalar(10_000)
        );
    }

    #[test]
    fn scalar_rejects_non_positive_price() {
        let f = scalar_fixture(scalar_spec);
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);

        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_scalar_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        // A non-positive reading is a broken feed, not a value at the bottom
        // of the range, so it must not clamp silently.
        for bad in [0_i128, -5] {
            reflector.set_price(&bad, &1_999_u64);
            assert_eq!(
                f.resolver.try_resolve_scalar_price(&f.market_id),
                Err(Ok(Error::InvalidPrice))
            );
            assert_eq!(
                f.market_core.get_market(&f.market_id).status,
                MarketStatus::Open
            );
        }

        // The rejection is recoverable: a healthy reading resolves normally.
        reflector.set_price(&200_i128, &1_999_u64);
        assert_eq!(f.resolver.resolve_scalar_price(&f.market_id), 6_666);
    }

    #[test]
    fn scalar_rejects_stale_price() {
        let f = scalar_fixture(scalar_spec);
        let reflector = MockReflectorClient::new(&f.env, &f.reflector_id);

        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_scalar_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        // One second older than `max_staleness` (10) is stale...
        reflector.set_price(&176_i128, &1_989_u64);
        assert_eq!(
            f.resolver.try_resolve_scalar_price(&f.market_id),
            Err(Ok(Error::StalePrice))
        );
        // ...a future-dated reading is stale too...
        reflector.set_price(&176_i128, &2_001_u64);
        assert_eq!(
            f.resolver.try_resolve_scalar_price(&f.market_id),
            Err(Ok(Error::StalePrice))
        );
        // ...and exactly `max_staleness` old is the last accepted age.
        reflector.set_price(&176_i128, &1_990_u64);
        assert_eq!(f.resolver.resolve_scalar_price(&f.market_id), 5_066);
    }

    #[test]
    fn scalar_spec_registration_validations() {
        let f = scalar_fixture(scalar_spec);
        let ResolutionSpec::Scalar(spec) = f.spec.clone() else {
            unreachable!()
        };

        // The reveal is validated before the commitment is checked.
        for (lower, upper, max_staleness) in [
            (100_i128, 100_i128, 10u64), // empty range
            (250, 100, 10),              // inverted range
            (-1, 250, 10),               // negative lower
            (0, i128::MAX / BPS + 1, 10),
            (100, 250, 0), // staleness window disabled
        ] {
            let mut bad = spec.clone();
            bad.lower = lower;
            bad.upper = upper;
            bad.max_staleness = max_staleness;
            assert_eq!(
                f.resolver.try_register_scalar_spec(&f.market_id, &bad),
                Err(Ok(Error::InvalidConfig))
            );
        }

        // A valid-but-different rule does not match the committed hash.
        let mut wrong = spec.clone();
        wrong.upper = 251;
        assert_eq!(
            f.resolver.try_register_scalar_spec(&f.market_id, &wrong),
            Err(Ok(Error::SpecHashMismatch))
        );

        f.resolver.register_scalar_spec(&f.market_id, &spec);
        // One reveal per market, even with the identical rule.
        assert_eq!(
            f.resolver.try_register_scalar_spec(&f.market_id, &spec),
            Err(Ok(Error::MarketAlreadyConfigured))
        );
    }

    #[test]
    fn scalar_spec_hash_disjoint_from_price() {
        // A price rule revealed against a scalar commitment mismatches...
        let f = scalar_fixture(scalar_spec);
        let as_price = PriceConfig {
            reflector: f.reflector_id.clone(),
            asset: OracleAsset::Other(Symbol::new(&f.env, "XLM")),
            threshold: 100,
            direction: PriceDirection::Above,
            max_staleness: 10,
        };
        assert_eq!(
            f.resolver.try_register_price_spec(&f.market_id, &as_price),
            Err(Ok(Error::SpecHashMismatch))
        );

        // ...and a scalar rule cannot be revealed against a price commitment.
        let g = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let as_scalar = ScalarPriceConfig {
            reflector: g.reflector_id.clone(),
            asset: OracleAsset::Other(Symbol::new(&g.env, "XLM")),
            lower: 100,
            upper: 250,
            max_staleness: 10,
        };
        assert_eq!(
            g.resolver
                .try_register_scalar_spec(&g.market_id, &as_scalar),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    /// Appending `ResolutionSpec::Scalar` must not move the commitment of any
    /// variant that existed before it. These hashes pre-date scalar support;
    /// they are re-pinned here through the production `legacy_spec_hash` path
    /// (the `golden` module pins the same bytes via raw `sha256(to_xdr)`).
    #[test]
    fn existing_spec_hashes_unchanged() {
        let env = Env::default();
        let hex = |h: &BytesN<32>| -> std::string::String {
            h.to_array().iter().map(|b| format!("{b:02x}")).collect()
        };
        let g1 = Address::from_str(
            &env,
            "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF",
        );

        let price = ResolutionSpec::Price(PriceConfig {
            reflector: Address::from_str(
                &env,
                "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ",
            ),
            asset: OracleAsset::Other(Symbol::new(&env, "XLM")),
            threshold: 2_000,
            direction: PriceDirection::Above,
            max_staleness: 10,
        });
        assert_eq!(
            hex(&legacy_spec_hash(&env, &price)),
            "b6f2458326d5f76bd9b53a93a103ea6c0fed7129c5496e91e3faef9a9a23d469",
        );

        let signers = ResolutionSpec::Signers(SignerConfig {
            signers: Vec::from_array(&env, [g1.clone()]),
            threshold: 1,
            dispute_window: 5,
        });
        assert_eq!(
            hex(&legacy_spec_hash(&env, &signers)),
            "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4",
        );

        let cat = ResolutionSpec::CategoricalSigners(CatSignerConfig {
            signers: Vec::from_array(&env, [g1]),
            threshold: 1,
            dispute_window: 5,
            outcome_count: 2,
        });
        assert_eq!(
            hex(&legacy_spec_hash(&env, &cat)),
            "16db57d51742d266dccd1a70539afc160971c942605a0ae8f15b5a18cd1b2837",
        );
    }

    #[test]
    fn rejects_revealed_spec_with_wrong_commitment() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let ResolutionSpec::Price(mut wrong_spec) = f.spec.clone() else {
            unreachable!()
        };
        wrong_spec.threshold = 9_999;

        assert_eq!(
            f.resolver
                .try_register_price_spec(&f.market_id, &wrong_spec),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    #[test]
    fn rejects_re_registering_an_already_configured_market() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        assert_eq!(
            f.resolver.try_register_price_spec(&f.market_id, &spec),
            Err(Ok(Error::MarketAlreadyConfigured))
        );
    }

    #[test]
    fn guardian_can_cancel_a_disputed_proposal() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::No);

        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
    }

    #[test]
    fn v2_reveal_rejected_once_legacy_spec_registered() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        assert_eq!(
            f.resolver
                .try_register_spec_v2(&f.market_id, &envelope(&f, [9; 32])),
            Err(Ok(Error::MarketAlreadyConfigured))
        );
    }

    #[test]
    fn v2_reveal_accepted() {
        let f = v2_signer_fixture([9; 32]);
        f.resolver
            .register_spec_v2(&f.market_id, &envelope(&f, [9; 32]));
        assert_eq!(
            f.resolver.state(&f.market_id),
            ResolutionState::SignersPending
        );

        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::Yes);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn v2_price_rule_reveal_accepted() {
        let f = v2_fixture([9; 32], |env, reflector, _a, _b| {
            ResolutionSpec::Price(price_spec(env, reflector))
        });
        f.resolver
            .register_spec_v2(&f.market_id, &envelope(&f, [9; 32]));
        f.env.as_contract(&f.resolver_id, || {
            assert!(f
                .env
                .storage()
                .persistent()
                .has(&DataKey::Price(f.market_id)));
        });
    }

    #[test]
    fn v2_wrong_network_rejected() {
        let f = v2_signer_fixture([9; 32]);
        let mut spec = envelope(&f, [9; 32]);
        spec.network_id = BytesN::from_array(&f.env, &[8; 32]);
        assert_eq!(
            f.resolver.try_register_spec_v2(&f.market_id, &spec),
            Err(Ok(Error::DomainMismatch))
        );
    }

    #[test]
    fn v2_wrong_market_core_rejected() {
        let f = v2_signer_fixture([9; 32]);
        let mut spec = envelope(&f, [9; 32]);
        spec.market_core = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_register_spec_v2(&f.market_id, &spec),
            Err(Ok(Error::DomainMismatch))
        );
    }

    #[test]
    fn v2_wrong_salt_rejected() {
        let f = v2_signer_fixture([9; 32]);
        assert_eq!(
            f.resolver
                .try_register_spec_v2(&f.market_id, &envelope(&f, [10; 32])),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    #[test]
    fn v2_zero_salt_and_unknown_version_rejected() {
        let f = v2_signer_fixture([0; 32]);
        assert_eq!(
            f.resolver
                .try_register_spec_v2(&f.market_id, &envelope(&f, [0; 32])),
            Err(Ok(Error::InvalidConfig))
        );
        let mut spec = envelope(&f, [9; 32]);
        spec.version = 3;
        assert_eq!(
            f.resolver.try_register_spec_v2(&f.market_id, &spec),
            Err(Ok(Error::InvalidConfig))
        );
    }

    #[test]
    fn legacy_reveal_of_v2_commitment_rejected() {
        let f = v2_signer_fixture([9; 32]);
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        assert_eq!(
            f.resolver.try_register_signer_spec(&f.market_id, &spec),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    /// Both preimages hash with sha256, so disjoint hashes follow from disjoint
    /// preimages: a legacy preimage starts with the `ScValType::Vec` tag
    /// (`00 00 00 10`) and a V2 preimage with ASCII `SPEC_DOMAIN`.
    #[test]
    fn v2_and_legacy_hash_spaces_disjoint() {
        let f = v2_signer_fixture([9; 32]);
        let env = &f.env;
        let vec_tag = Bytes::from_array(env, &[0, 0, 0, 16]);
        let domain_tag = Bytes::from_slice(env, &SPEC_DOMAIN.as_bytes()[..4]);
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..64 {
            let rule = if next() % 2 == 0 {
                ResolutionSpec::Price(PriceConfig {
                    reflector: f.reflector_id.clone(),
                    asset: OracleAsset::Other(Symbol::new(env, "XLM")),
                    threshold: (next() >> 1) as i128,
                    direction: PriceDirection::Above,
                    max_staleness: next() | 1,
                })
            } else {
                ResolutionSpec::Signers(SignerConfig {
                    signers: Vec::from_array(env, [f.signer_a.clone()]),
                    threshold: 1,
                    dispute_window: next() | 1,
                })
            };
            let salt = [(next() & 0xff) as u8 | 1; 32];
            let spec = v2_envelope(env, &f.market_core.address, salt, &rule);
            assert_ne!(legacy_spec_hash(env, &rule), spec_v2_hash(env, &spec));
            assert_eq!(rule.to_xdr(env).slice(0..4), vec_tag);
            assert_ne!(domain_tag, vec_tag);
        }
    }

    // ----- expiry (liveness fallback) -------------------------------------

    /// `close_time` in the fixture is 2_000.
    const DEADLINE: u64 = 2_000 + RESOLUTION_GRACE_SECS;

    fn signer_fixture() -> Fixture {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_signer_spec(&f.market_id, &spec);
        f
    }

    fn price_fixture(price: i128, price_timestamp: u64) -> Fixture {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        MockReflectorClient::new(&f.env, &f.reflector_id).set_price(&price, &price_timestamp);
        f.resolver.register_price_spec(&f.market_id, &spec);
        f
    }

    fn assert_expired_event(f: &Fixture, mode: ExpiryMode) {
        let expected = MarketExpired {
            market_id: f.market_id,
            close_time: 2_000,
            deadline: DEADLINE,
            mode,
        };
        let events = f.env.events().all().filter_by_contract(&f.resolver_id);
        assert_eq!(
            events,
            [soroban_sdk::Event::to_xdr(
                &expected,
                &f.env,
                &f.resolver_id
            )]
        );
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Expired);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Void
        );
    }

    #[test]
    fn resolution_deadline_is_close_time_plus_grace() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        assert_eq!(f.resolver.resolution_deadline(&f.market_id), DEADLINE);
    }

    #[test]
    fn expire_rejects_before_deadline() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        f.env.ledger().set_timestamp(DEADLINE - 1);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::DeadlineNotReached))
        );
    }

    #[test]
    fn expire_voids_unrevealed_market_after_deadline() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_expired_event(&f, ExpiryMode::Unrevealed);
    }

    #[test]
    fn expire_resolves_price_market_when_feed_is_valid() {
        let f = price_fixture(2_500, 1_999);
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Finalized);
    }

    #[test]
    fn expire_voids_price_market_with_stale_feed() {
        let f = price_fixture(2_500, 1);
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_expired_event(&f, ExpiryMode::Price);
    }

    #[test]
    fn expire_voids_price_market_whose_feed_traps() {
        // `a` is a generated address with no contract deployed, so the feed
        // call fails inside the host.
        let f = fixture(|env, _reflector, a, _b| ResolutionSpec::Price(price_spec(env, a)));
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_expired_event(&f, ExpiryMode::Price);
    }

    #[test]
    fn expire_refuses_when_signer_proposal_is_finalizable() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::No);

        f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::ResolutionAvailable))
        );
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::No
        );
    }

    #[test]
    fn expire_waits_for_open_dispute_window() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(DEADLINE - 50);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::Yes);

        // Deadline passes with 50s of the 100s dispute window left.
        f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::ResolutionAvailable))
        );
        f.env.ledger().set_timestamp(DEADLINE + 50);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn expire_voids_signer_market_once_proposal_is_cancelled() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::No);
        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);

        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_expired_event(&f, ExpiryMode::Signers);
    }

    #[test]
    fn register_spec_rejected_after_expiry() {
        let f = fixture(|env, _r, a, b| ResolutionSpec::Signers(signer_spec(env, a, b)));
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        let ResolutionSpec::Signers(spec) = f.spec.clone() else {
            unreachable!()
        };
        assert_eq!(
            f.resolver.try_register_signer_spec(&f.market_id, &spec),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn attest_rejected_after_expiry() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn guardian_void_rejected_after_expiry() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.resolver
                .try_guardian_void_market(&f.market_id, &GuardianReason::SignersStalled),
            Err(Ok(Error::AlreadyFinalized))
        );
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn expire_and_resolve_price_same_ledger_second_call_fails() {
        let f = price_fixture(2_500, 1_999);
        f.env.ledger().set_timestamp(DEADLINE - 1);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::DeadlineNotReached))
        );
        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);

        // The same timestamp is now past the deadline; whoever runs second loses.
        f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::AlreadyFinalized))
        );
        assert_eq!(
            f.resolver.try_resolve_price(&f.market_id),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn expire_is_permissionless() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        f.env.ledger().set_timestamp(DEADLINE);
        f.env.set_auths(&[]);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Expired);
    }

    // ----- weighted Ed25519 committee -------------------------------------

    fn key(seed: u8) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
    }

    fn weighted_key(env: &Env, seed: u8, weight: u32) -> WeightedKey {
        WeightedKey {
            pubkey: BytesN::from_array(env, key(seed).verifying_key().as_bytes()),
            weight,
        }
    }

    fn weighted_config(env: &Env, weights: &[(u8, u32)], threshold: u32) -> WeightedKeyConfig {
        let mut signers = Vec::new(env);
        for (seed, weight) in weights {
            signers.push_back(weighted_key(env, *seed, *weight));
        }
        WeightedKeyConfig {
            signers,
            weight_threshold: threshold,
            dispute_window: 100,
        }
    }

    /// Keys 1, 2, 3 with weights 2, 1, 1 (total 4) and threshold 3.
    fn weighted_fixture() -> Fixture {
        let f = fixture(|env, _r, _a, _b| {
            ResolutionSpec::WeightedKeys(weighted_config(env, &[(1, 2), (2, 1), (3, 1)], 3))
        });
        let ResolutionSpec::WeightedKeys(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_weighted_key_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);
        f
    }

    fn message_for(f: &Fixture, resolver: &Address, round: u32, outcome: &Outcome) -> Bytes {
        let hash = f.market_core.get_market(&f.market_id).resolution_hash;
        f.env.as_contract(resolver, || {
            Resolver::attestation_message(&f.env, f.market_id, round, outcome, &hash)
        })
    }

    fn sign_message(f: &Fixture, seed: u8, message: &Bytes) -> (BytesN<32>, BytesN<64>) {
        use ed25519_dalek::Signer;
        let signing = key(seed);
        let signature = signing.sign(&bytes_to_vec(message)).to_bytes();
        (
            BytesN::from_array(&f.env, signing.verifying_key().as_bytes()),
            BytesN::from_array(&f.env, &signature),
        )
    }

    fn sign(f: &Fixture, seed: u8, round: u32, outcome: &Outcome) -> (BytesN<32>, BytesN<64>) {
        sign_message(f, seed, &message_for(f, &f.resolver_id, round, outcome))
    }

    fn sigs(f: &Fixture, list: &[(BytesN<32>, BytesN<64>)]) -> Vec<(BytesN<32>, BytesN<64>)> {
        Vec::from_slice(&f.env, list)
    }

    #[test]
    fn weighted_keys_reach_threshold_and_finalize() {
        let f = weighted_fixture();
        let batch = sigs(
            &f,
            &[sign(&f, 1, 0, &Outcome::No), sign(&f, 2, 0, &Outcome::No)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::No, &0, &batch);

        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::No
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::No)
        );
    }

    #[test]
    fn weights_accumulate_across_calls_and_never_restart_the_window() {
        let f = weighted_fixture();
        let one = |seed| sigs(&f, &[sign(&f, seed, 0, &Outcome::Yes)]);
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &one(2));
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &one(3));
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &one(1));

        // A later signature past the threshold must not push proposed_at out.
        f.env.ledger().set_timestamp(2_050);
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &one(1));
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn weighted_duplicate_sig_ignored() {
        let f = weighted_fixture();
        let dup = sign(&f, 1, 0, &Outcome::Yes);
        let batch = sigs(&f, &[dup.clone(), dup.clone(), dup]);
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch);
        f.env.ledger().set_timestamp(2_100);
        // Weight 2 of 3: three copies of one key must not reach the threshold.
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
    }

    #[test]
    fn non_member_sig_ignored() {
        let f = weighted_fixture();
        let outsider = sign(&f, 99, 0, &Outcome::Yes);
        f.resolver.submit_signatures(
            &f.market_id,
            &Outcome::Yes,
            &0,
            &sigs(&f, core::slice::from_ref(&outsider)),
        );
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
        let batch = sigs(
            &f,
            &[
                outsider,
                sign(&f, 1, 0, &Outcome::Yes),
                sign(&f, 3, 0, &Outcome::Yes),
            ],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn invalid_sig_aborts_batch() {
        let f = weighted_fixture();
        let forged = (
            sign(&f, 2, 0, &Outcome::Yes).0,
            sign(&f, 2, 0, &Outcome::No).1,
        );
        let batch = sigs(&f, &[sign(&f, 1, 0, &Outcome::Yes), forged]);
        assert!(f
            .resolver
            .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch)
            .is_err());

        // Nothing from the aborted batch was recorded: key 1 can still sign.
        let good = sigs(
            &f,
            &[sign(&f, 1, 0, &Outcome::Yes), sign(&f, 2, 0, &Outcome::Yes)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &good);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn stale_round_rejected_after_cancel() {
        let f = weighted_fixture();
        let old = sigs(
            &f,
            &[sign(&f, 1, 0, &Outcome::Yes), sign(&f, 2, 0, &Outcome::Yes)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &old);
        assert_eq!(f.resolver.current_round(&f.market_id), 0);

        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(f.resolver.current_round(&f.market_id), 1);
        assert_eq!(
            f.resolver
                .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &old),
            Err(Ok(Error::StaleRound))
        );
        // Relabelling the old signatures as round 1 fails verification.
        assert!(f
            .resolver
            .try_submit_signatures(&f.market_id, &Outcome::Yes, &1, &old)
            .is_err());

        let fresh = sigs(
            &f,
            &[sign(&f, 1, 1, &Outcome::No), sign(&f, 3, 1, &Outcome::No)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::No, &1, &fresh);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::No
        );
    }

    #[test]
    fn key_cannot_sign_both_outcomes() {
        let f = weighted_fixture();
        let yes = sigs(&f, &[sign(&f, 1, 0, &Outcome::Yes)]);
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &yes);
        // Key 1 (weight 2) already spent its vote on Yes; with it counted for
        // No as well, keys 1 + 3 would reach the threshold of 3.
        let no = sigs(
            &f,
            &[sign(&f, 1, 0, &Outcome::No), sign(&f, 3, 0, &Outcome::No)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::No, &0, &no);
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
    }

    #[test]
    fn wrong_network_signature_fails() {
        let f = weighted_fixture();
        f.env.ledger().set_network_id([8; 32]);
        let foreign = sigs(&f, &[sign(&f, 1, 0, &Outcome::Yes)]);
        f.env.ledger().set_network_id(NETWORK_ID);
        assert!(f
            .resolver
            .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &foreign)
            .is_err());
    }

    #[test]
    fn wrong_resolver_signature_fails() {
        let f = weighted_fixture();
        let other = f
            .env
            .register(Resolver, (f.admin.clone(), f.market_core.address.clone()));
        let message = message_for(&f, &other, 0, &Outcome::Yes);
        let foreign = sigs(&f, &[sign_message(&f, 1, &message)]);
        assert!(f
            .resolver
            .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &foreign)
            .is_err());
    }

    #[test]
    fn submit_signatures_guards() {
        let f = weighted_fixture();
        let batch = sigs(&f, &[sign(&f, 1, 0, &Outcome::Yes)]);

        f.env.ledger().set_timestamp(1_999);
        assert_eq!(
            f.resolver
                .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch),
            Err(Ok(Error::MarketNotClosed))
        );
        f.env.ledger().set_timestamp(2_000);

        let mut too_many = Vec::new(&f.env);
        for _ in 0..=MAX_SIGS_PER_CALL {
            too_many.push_back(batch.get(0).unwrap());
        }
        assert_eq!(
            f.resolver
                .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &too_many),
            Err(Ok(Error::TooManySignatures))
        );

        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.resolver
                .try_submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn expire_refuses_a_pending_weighted_proposal() {
        let f = weighted_fixture();
        let batch = sigs(
            &f,
            &[sign(&f, 1, 0, &Outcome::Yes), sign(&f, 2, 0, &Outcome::Yes)],
        );
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &batch);
        f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::ResolutionAvailable))
        );
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn max_sigs_per_call_budget() {
        let seeds: std::vec::Vec<u8> = (1..=MAX_WEIGHTED_SIGNERS as u8).collect();
        let weights: std::vec::Vec<(u8, u32)> = seeds.iter().map(|s| (*s, 1)).collect();
        let f = fixture(|env, _r, _a, _b| {
            ResolutionSpec::WeightedKeys(weighted_config(env, &weights, 17))
        });
        let ResolutionSpec::WeightedKeys(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_weighted_key_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);

        let message = message_for(&f, &f.resolver_id, 0, &Outcome::Yes);
        let batch: std::vec::Vec<_> = seeds
            .iter()
            .map(|seed| sign_message(&f, *seed, &message))
            .collect();
        f.env.cost_estimate().budget().reset_unlimited();
        f.resolver
            .submit_signatures(&f.market_id, &Outcome::Yes, &0, &sigs(&f, &batch));

        let used = f.env.cost_estimate().resources();
        std::println!(
            "submit_signatures x{}: {} instructions, {} memory bytes",
            MAX_SIGS_PER_CALL,
            used.instructions,
            used.mem_bytes
        );
        // Recorded for 32 signatures: 17.5M instructions / 1.7 MB here (native
        // contract) and 23.1M / 2.9 MB with the compiled wasm resolver and
        // market-core, i.e. under 6% / 7% of the limits. Network limits per
        // transaction (`stellar network settings`, testnet and mainnet):
        // 400M instructions, 40 MiB memory; stay under 60% of both.
        assert!(used.instructions <= 240_000_000);
        assert!(used.mem_bytes <= 25_165_824);
    }

    #[test]
    fn register_weighted_validates_config() {
        let f = fixture(|env, _r, _a, _b| {
            ResolutionSpec::WeightedKeys(weighted_config(env, &[(1, 1)], 1))
        });
        let env = &f.env;
        let duplicate_keys = weighted_config(env, &[(1, 1), (1, 1)], 1);
        let threshold_above_total = weighted_config(env, &[(1, 1), (2, 1)], 3);
        let zero_weight = weighted_config(env, &[(1, 0), (2, 1)], 1);
        let zero_threshold = weighted_config(env, &[(1, 1)], 0);
        let weight_overflow = weighted_config(env, &[(1, u32::MAX), (2, 1)], 1);
        let mut empty = weighted_config(env, &[], 1);
        let mut zero_window = weighted_config(env, &[(1, 1)], 1);
        zero_window.dispute_window = 0;
        let too_many: std::vec::Vec<(u8, u32)> = (1..=MAX_WEIGHTED_SIGNERS as u8 + 1)
            .map(|s| (s, 1))
            .collect();
        let over_cap = weighted_config(env, &too_many, 1);
        empty.dispute_window = 100;

        for invalid in [
            duplicate_keys,
            threshold_above_total,
            zero_weight,
            zero_threshold,
            weight_overflow,
            empty,
            zero_window,
            over_cap,
        ] {
            // Validation runs before the commitment check, so the hash is moot.
            assert_eq!(
                f.resolver
                    .try_register_weighted_key_spec(&f.market_id, &invalid),
                Err(Ok(Error::InvalidConfig))
            );
        }
        assert_eq!(
            f.resolver
                .try_register_weighted_key_spec(&f.market_id, &weighted_config(env, &[(2, 1)], 1)),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    // ----- bonded disputes -------------------------------------------------

    const BOND: i128 = 25 * 10_000_000;

    struct DisputeFixture {
        f: Fixture,
        disputer: Address,
        members: std::vec::Vec<Address>,
    }

    /// A `SignersDisputable` market (signers a, b, threshold 2, window 100,
    /// escalation timeout 1_000) whose signers proposed `No` at t = 2_000.
    /// `committee` selects a 2-of-3 escalation committee over the guardian.
    fn dispute_fixture(committee: bool) -> DisputeFixture {
        let members = std::cell::RefCell::new(std::vec::Vec::new());
        let f = fixture(|env, _r, a, b| {
            let escalation = if committee {
                let list: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(env)).collect();
                members.borrow_mut().extend(list.iter().cloned());
                Escalation::Committee(Vec::from_slice(env, &list), 2)
            } else {
                Escalation::Guardian
            };
            ResolutionSpec::SignersDisputable(DisputableSignerConfig {
                signers: Vec::from_array(env, [a.clone(), b.clone()]),
                threshold: 2,
                dispute_window: 100,
                dispute_bond: BOND,
                escalation,
                escalation_timeout: 1_000,
            })
        });
        let ResolutionSpec::SignersDisputable(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_disputable_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::No);

        let disputer = Address::generate(&f.env);
        let collateral = f.market_core.get_config().collateral;
        StellarAssetClient::new(&f.env, &collateral).mint(&disputer, &(2 * BOND));
        DisputeFixture {
            f,
            disputer,
            members: members.into_inner(),
        }
    }

    fn balance(d: &DisputeFixture, who: &Address) -> i128 {
        token::Client::new(&d.f.env, &d.f.market_core.get_config().collateral).balance(who)
    }

    /// Solvency: the resolver holds exactly the bonds it has not paid out.
    fn assert_escrow(d: &DisputeFixture, expected: i128) {
        assert_eq!(balance(d, &d.f.resolver_id), expected);
    }

    fn open(d: &DisputeFixture) {
        d.f.resolver
            .dispute(&d.f.market_id, &d.disputer, &Some(Outcome::Yes));
        assert_escrow(d, BOND);
        assert_eq!(
            d.f.resolver.state(&d.f.market_id),
            ResolutionState::Disputed
        );
    }

    fn status(d: &DisputeFixture) -> MarketStatus {
        d.f.market_core.get_market(&d.f.market_id).status
    }

    #[test]
    fn dispute_freezes_finalization() {
        let d = dispute_fixture(false);
        open(&d);
        d.f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            d.f.resolver.try_finalize_signers(&d.f.market_id),
            Err(Ok(Error::DisputeActive))
        );
        assert_eq!(status(&d), MarketStatus::Open);
    }

    #[test]
    fn dispute_after_window_rejected() {
        let d = dispute_fixture(false);
        d.f.env.ledger().set_timestamp(2_500);
        assert_eq!(
            d.f.resolver.try_dispute(&d.f.market_id, &d.disputer, &None),
            Err(Ok(Error::DisputeWindowClosed))
        );
        assert_escrow(&d, 0);
    }

    #[test]
    fn dispute_at_exact_window_end() {
        let d = dispute_fixture(false);
        // At proposed_at + dispute_window finalization opens and disputes close.
        d.f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            d.f.resolver.try_dispute(&d.f.market_id, &d.disputer, &None),
            Err(Ok(Error::DisputeWindowClosed))
        );
        assert_eq!(
            d.f.resolver.finalize_signers(&d.f.market_id),
            AttestedOutcome::No
        );

        let d = dispute_fixture(false);
        d.f.env.ledger().set_timestamp(2_099);
        d.f.resolver.dispute(&d.f.market_id, &d.disputer, &None);
        assert_escrow(&d, BOND);
    }

    #[test]
    fn double_dispute_rejected() {
        let d = dispute_fixture(false);
        open(&d);
        assert_eq!(
            d.f.resolver.try_dispute(&d.f.market_id, &d.disputer, &None),
            Err(Ok(Error::DisputeActive))
        );
        assert_escrow(&d, BOND);
    }

    #[test]
    fn dispute_preconditions() {
        let d = dispute_fixture(false);
        assert_eq!(
            d.f.resolver
                .try_dispute(&d.f.market_id, &d.disputer, &Some(Outcome::No)),
            Err(Ok(Error::InvalidConfig))
        );
        d.f.resolver
            .cancel_proposal(&d.f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(
            d.f.resolver.try_dispute(&d.f.market_id, &d.disputer, &None),
            Err(Ok(Error::NoProposal))
        );

        let legacy = signer_fixture();
        assert_eq!(
            legacy
                .resolver
                .try_dispute(&legacy.market_id, &legacy.signer_a, &None),
            Err(Ok(Error::MarketNotConfigured))
        );
    }

    #[test]
    fn guardian_upholds_proposal_disputer_loses_bond() {
        let d = dispute_fixture(false);
        open(&d);
        let treasury = d.f.market_core.get_config().treasury;
        d.f.resolver.settle_dispute(&d.f.market_id, &Verdict::No);
        assert_eq!(status(&d), MarketStatus::Resolved(Outcome::No));
        assert_eq!(
            d.f.resolver.state(&d.f.market_id),
            ResolutionState::Finalized
        );
        assert_escrow(&d, BOND);

        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_escrow(&d, 0);
        assert_eq!(balance(&d, &treasury), BOND);
        assert_eq!(balance(&d, &d.disputer), BOND);
        assert_eq!(
            d.f.resolver.try_claim_dispute_bond(&d.f.market_id),
            Err(Ok(Error::NoDispute))
        );
    }

    #[test]
    fn guardian_overturns_proposal_disputer_refunded() {
        let d = dispute_fixture(false);
        open(&d);
        d.f.resolver.settle_dispute(&d.f.market_id, &Verdict::Yes);
        assert_eq!(status(&d), MarketStatus::Resolved(Outcome::Yes));
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_escrow(&d, 0);
        assert_eq!(balance(&d, &d.disputer), 2 * BOND);
    }

    #[test]
    fn guardian_rules_invalid_market_voided() {
        let d = dispute_fixture(false);
        open(&d);
        d.f.resolver
            .settle_dispute(&d.f.market_id, &Verdict::Invalid);
        assert_eq!(status(&d), MarketStatus::Void);
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_eq!(balance(&d, &d.disputer), 2 * BOND);
        assert_escrow(&d, 0);
    }

    #[test]
    fn settlement_and_claim_require_an_open_then_settled_dispute() {
        let d = dispute_fixture(false);
        assert_eq!(
            d.f.resolver
                .try_settle_dispute(&d.f.market_id, &Verdict::Yes),
            Err(Ok(Error::NoDispute))
        );
        open(&d);
        assert_eq!(
            d.f.resolver.try_claim_dispute_bond(&d.f.market_id),
            Err(Ok(Error::DisputeActive))
        );
        assert_eq!(
            d.f.resolver
                .try_escalation_attest(&d.f.market_id, &d.disputer, &Verdict::Yes),
            Err(Ok(Error::WrongMode))
        );
        d.f.resolver.settle_dispute(&d.f.market_id, &Verdict::Yes);
        assert_eq!(
            d.f.resolver
                .try_settle_dispute(&d.f.market_id, &Verdict::No),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn committee_escalation_reaches_threshold() {
        let d = dispute_fixture(true);
        open(&d);
        assert_eq!(
            d.f.resolver
                .try_settle_dispute(&d.f.market_id, &Verdict::Yes),
            Err(Ok(Error::WrongMode))
        );
        d.f.resolver
            .escalation_attest(&d.f.market_id, &d.members[0], &Verdict::Yes);
        d.f.resolver
            .escalation_attest(&d.f.market_id, &d.members[1], &Verdict::No);
        assert_eq!(status(&d), MarketStatus::Open);
        d.f.resolver
            .escalation_attest(&d.f.market_id, &d.members[2], &Verdict::Yes);
        assert_eq!(status(&d), MarketStatus::Resolved(Outcome::Yes));
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_eq!(balance(&d, &d.disputer), 2 * BOND);
        assert_escrow(&d, 0);
    }

    #[test]
    fn non_member_cannot_escalation_attest() {
        let d = dispute_fixture(true);
        open(&d);
        assert_eq!(
            d.f.resolver
                .try_escalation_attest(&d.f.market_id, &d.f.signer_a, &Verdict::No),
            Err(Ok(Error::NotSigner))
        );
    }

    #[test]
    fn member_cannot_vote_twice() {
        let d = dispute_fixture(true);
        open(&d);
        d.f.resolver
            .escalation_attest(&d.f.market_id, &d.members[0], &Verdict::No);
        assert_eq!(
            d.f.resolver
                .try_escalation_attest(&d.f.market_id, &d.members[0], &Verdict::Yes),
            Err(Ok(Error::AlreadyAttested))
        );
        assert_eq!(status(&d), MarketStatus::Open);
    }

    #[test]
    fn committee_vote_needs_an_open_dispute() {
        let d = dispute_fixture(true);
        assert_eq!(
            d.f.resolver
                .try_escalation_attest(&d.f.market_id, &d.members[0], &Verdict::No),
            Err(Ok(Error::NoDispute))
        );
    }

    #[test]
    fn escalation_timeout_voids_and_refunds() {
        let d = dispute_fixture(false);
        d.f.env.ledger().set_timestamp(2_050);
        open(&d);
        d.f.env.ledger().set_timestamp(3_049);
        assert_eq!(
            d.f.resolver.try_expire_dispute(&d.f.market_id),
            Err(Ok(Error::DeadlineNotReached))
        );
        d.f.env.ledger().set_timestamp(3_050);
        d.f.env.set_auths(&[]);
        d.f.resolver.expire_dispute(&d.f.market_id);
        assert_eq!(status(&d), MarketStatus::Void);
        assert_eq!(
            d.f.resolver.state(&d.f.market_id),
            ResolutionState::Finalized
        );
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_eq!(balance(&d, &d.disputer), 2 * BOND);
        assert_escrow(&d, 0);
    }

    #[test]
    fn attest_blocked_while_disputed() {
        let d = dispute_fixture(false);
        open(&d);
        assert_eq!(
            d.f.resolver
                .try_attest(&d.f.market_id, &d.f.signer_a, &AttestedOutcome::Yes),
            Err(Ok(Error::DisputeActive))
        );
    }

    #[test]
    fn cancel_proposal_blocked_while_disputed() {
        let d = dispute_fixture(false);
        open(&d);
        assert_eq!(
            d.f.resolver
                .try_cancel_proposal(&d.f.market_id, &GuardianReason::DisputeUpheld),
            Err(Ok(Error::DisputeActive))
        );
    }

    #[test]
    fn expire_market_blocked_while_disputed() {
        let d = dispute_fixture(false);
        open(&d);
        d.f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            d.f.resolver.try_expire_market(&d.f.market_id),
            Err(Ok(Error::DisputeActive))
        );
    }

    #[test]
    fn guardian_void_while_disputed_refunds_bond() {
        let d = dispute_fixture(false);
        open(&d);
        d.f.resolver
            .guardian_void_market(&d.f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(status(&d), MarketStatus::Void);
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_eq!(balance(&d, &d.disputer), 2 * BOND);
        assert_escrow(&d, 0);
    }

    #[test]
    fn undisputed_disputable_market_finalizes_normally() {
        let d = dispute_fixture(false);
        d.f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            d.f.resolver.finalize_signers(&d.f.market_id),
            AttestedOutcome::No
        );
        assert_escrow(&d, 0);
    }

    #[test]
    fn wrong_caller_cannot_settle_dispute() {
        let d = dispute_fixture(false);
        open(&d);
        let intruder = Address::generate(&d.f.env);
        d.f.env.set_auths(&[]);
        assert!(d
            .f
            .resolver
            .mock_auths(&[MockAuth {
                address: &intruder,
                invoke: &MockAuthInvoke {
                    contract: &d.f.resolver_id,
                    fn_name: "settle_dispute",
                    args: (d.f.market_id, Verdict::No).into_val(&d.f.env),
                    sub_invokes: &[],
                }
            }])
            .try_settle_dispute(&d.f.market_id, &Verdict::No)
            .is_err());

        // Admin auth for this exact call succeeds.
        d.f.resolver
            .mock_auths(&[MockAuth {
                address: &d.f.admin,
                invoke: &MockAuthInvoke {
                    contract: &d.f.resolver_id,
                    fn_name: "settle_dispute",
                    args: (d.f.market_id, Verdict::No).into_val(&d.f.env),
                    sub_invokes: &[],
                },
            }])
            .settle_dispute(&d.f.market_id, &Verdict::No);
        assert_eq!(status(&d), MarketStatus::Resolved(Outcome::No));
    }

    #[test]
    fn wrong_caller_cannot_vote_or_dispute_for_someone_else() {
        let d = dispute_fixture(true);
        let intruder = Address::generate(&d.f.env);
        d.f.env.set_auths(&[]);
        assert!(d
            .f
            .resolver
            .mock_auths(&[MockAuth {
                address: &intruder,
                invoke: &MockAuthInvoke {
                    contract: &d.f.resolver_id,
                    fn_name: "dispute",
                    args: (d.f.market_id, d.disputer.clone(), None::<Outcome>).into_val(&d.f.env),
                    sub_invokes: &[],
                },
            }])
            .try_dispute(&d.f.market_id, &d.disputer, &None)
            .is_err());
        assert_escrow(&d, 0);

        d.f.env.mock_all_auths();
        open(&d);
        d.f.env.set_auths(&[]);
        assert!(d
            .f
            .resolver
            .mock_auths(&[MockAuth {
                address: &intruder,
                invoke: &MockAuthInvoke {
                    contract: &d.f.resolver_id,
                    fn_name: "escalation_attest",
                    args: (d.f.market_id, d.members[0].clone(), Verdict::Yes).into_val(&d.f.env),
                    sub_invokes: &[],
                },
            }])
            .try_escalation_attest(&d.f.market_id, &d.members[0], &Verdict::Yes)
            .is_err());
    }

    #[test]
    fn register_disputable_validates_config() {
        // A fresh market, so validation (which precedes the commitment check)
        // is what rejects each config.
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let env = &f.env;
        let outsider = Address::generate(env);
        let valid = DisputableSignerConfig {
            signers: Vec::from_array(env, [f.signer_a.clone(), f.signer_b.clone()]),
            threshold: 2,
            dispute_window: 100,
            dispute_bond: BOND,
            escalation: Escalation::Guardian,
            escalation_timeout: 1_000,
        };
        let committee =
            |members: &[Address], k: u32| Escalation::Committee(Vec::from_slice(env, members), k);
        let with = |change: &dyn Fn(&mut DisputableSignerConfig)| {
            let mut cfg = valid.clone();
            change(&mut cfg);
            cfg
        };
        for invalid in [
            with(&|c| c.dispute_bond = 0),
            with(&|c| c.escalation_timeout = 0),
            with(&|c| c.dispute_window = 0),
            with(&|c| c.threshold = 3),
            with(&|c| c.escalation = committee(&[], 1)),
            with(&|c| c.escalation = committee(core::slice::from_ref(&outsider), 2)),
            // Overlaps the proposing signers.
            with(&|c| c.escalation = committee(core::slice::from_ref(&f.signer_a), 1)),
            with(&|c| c.escalation = committee(&[outsider.clone(), outsider.clone()], 2)),
        ] {
            assert_eq!(
                f.resolver
                    .try_register_disputable_spec(&f.market_id, &invalid),
                Err(Ok(Error::InvalidConfig))
            );
        }
        assert_eq!(
            f.resolver
                .try_register_disputable_spec(&f.market_id, &valid),
            Err(Ok(Error::SpecHashMismatch))
        );
    }

    #[test]
    fn wrong_caller_cannot_use_guardian_functions() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let not_admin = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .resolver
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &f.resolver_id,
                    fn_name: "guardian_void_market",
                    args: (f.market_id, GuardianReason::UnrevealedSpec).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_guardian_void_market(&f.market_id, &GuardianReason::UnrevealedSpec)
            .is_err());
        let _ = f.admin;
    }

    // ----- Invalid attestations (committee voids) -------------------------

    fn attest_both(f: &Fixture, outcome: AttestedOutcome) {
        f.resolver.attest(&f.market_id, &f.signer_a, &outcome);
        f.resolver.attest(&f.market_id, &f.signer_b, &outcome);
    }

    fn stored_proposal(f: &Fixture) -> Option<SignerProposalV2> {
        f.env.as_contract(&f.resolver_id, || {
            Resolver::load_proposal(&f.env, f.market_id)
        })
    }

    #[test]
    fn invalid_attestations_void_market_after_dispute_window() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Invalid);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Invalid
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Void
        );
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Finalized);
    }

    #[test]
    fn invalid_cannot_be_attested_before_close_time() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(1_999);
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid),
            Err(Ok(Error::MarketNotClosed))
        );
        assert_eq!(stored_proposal(&f), None);
        f.env.as_contract(&f.resolver_id, || {
            assert_eq!(
                Resolver::attestation_count(&f.env, f.market_id, AttestedOutcome::Invalid),
                0
            );
        });
        // So `void_market`, which has no close-time guard, is unreachable
        // before close through the committee path.
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Open
        );
    }

    #[test]
    fn split_vote_invalid_overrides_yes_proposal_and_restarts_window() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        assert_eq!(
            stored_proposal(&f),
            Some(SignerProposalV2 {
                outcome: AttestedOutcome::Yes,
                proposed_at: 2_000
            })
        );

        f.env.ledger().set_timestamp(2_050);
        attest_both(&f, AttestedOutcome::Invalid);
        assert_eq!(
            stored_proposal(&f),
            Some(SignerProposalV2 {
                outcome: AttestedOutcome::Invalid,
                proposed_at: 2_050
            })
        );
        // The Yes window would have closed at 2_100; Invalid's runs to 2_150.
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_150);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Invalid
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Void
        );
    }

    #[test]
    fn yes_quorum_never_replaces_an_invalid_proposal() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Invalid);
        f.env.ledger().set_timestamp(2_050);
        attest_both(&f, AttestedOutcome::Yes);
        assert_eq!(
            stored_proposal(&f).map(|p| (p.outcome, p.proposed_at)),
            Some((AttestedOutcome::Invalid, 2_000))
        );
    }

    #[test]
    fn guardian_cancel_of_invalid_proposal_then_yes_finalizes() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Invalid);
        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(stored_proposal(&f), None);

        f.env.ledger().set_timestamp(2_010);
        attest_both(&f, AttestedOutcome::Yes);
        f.env.ledger().set_timestamp(2_110);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    /// Documents existing behaviour, extended to `Invalid`: dedupe is per
    /// `(outcome, signer)`, so one signer can back several outcomes.
    #[test]
    fn signer_can_attest_invalid_and_yes_independently_documented_behavior() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid);
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid),
            Err(Ok(Error::AlreadyAttested))
        );
        f.env.as_contract(&f.resolver_id, || {
            for outcome in [AttestedOutcome::Yes, AttestedOutcome::Invalid] {
                assert_eq!(Resolver::attestation_count(&f.env, f.market_id, outcome), 1);
            }
        });
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
    }

    #[test]
    fn legacy_count_and_attestation_keys_are_read_and_migrated() {
        let f = signer_fixture();
        let storage = || f.env.storage().persistent();
        f.env.as_contract(&f.resolver_id, || {
            storage().set(&DataKey::Count(f.market_id, Outcome::Yes), &1u32);
            storage().set(
                &DataKey::Attestation(f.market_id, Outcome::Yes, f.signer_a.clone()),
                &true,
            );
        });
        f.env.ledger().set_timestamp(2_000);
        // The legacy dedupe flag still applies.
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes),
            Err(Ok(Error::AlreadyAttested))
        );
        // signer_b's vote plus the legacy one reaches the threshold of 2.
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::Yes);
        f.env.as_contract(&f.resolver_id, || {
            assert_eq!(
                storage().get::<_, u32>(&DataKey::CountV2(f.market_id, AttestedOutcome::Yes)),
                Some(2)
            );
            assert!(!storage().has(&DataKey::Count(f.market_id, Outcome::Yes)));
        });
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
    }

    #[test]
    fn legacy_keys_not_double_counted_after_migration() {
        let f = signer_fixture();
        f.env.as_contract(&f.resolver_id, || {
            f.env
                .storage()
                .persistent()
                .set(&DataKey::Count(f.market_id, Outcome::No), &1u32);
        });
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::No);
        // Further writes for other outcomes leave the migrated count alone.
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid);
        f.env.as_contract(&f.resolver_id, || {
            assert_eq!(
                Resolver::attestation_count(&f.env, f.market_id, AttestedOutcome::No),
                2
            );
            assert_eq!(
                Resolver::attestation_count(&f.env, f.market_id, AttestedOutcome::Invalid),
                1
            );
        });
    }

    #[test]
    fn legacy_proposal_is_finalized_through_fallback() {
        let f = signer_fixture();
        f.env.as_contract(&f.resolver_id, || {
            let storage = f.env.storage().persistent();
            storage.set(&DataKey::Count(f.market_id, Outcome::No), &2u32);
            storage.set(
                &DataKey::Proposal(f.market_id),
                &SignerProposal {
                    outcome: Outcome::No,
                    proposed_at: 2_000,
                },
            );
        });
        f.env.ledger().set_timestamp(2_050);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::No
        );
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::No)
        );
    }

    #[test]
    fn committee_voided_event_emitted() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        f.resolver
            .attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid);
        f.resolver
            .attest(&f.market_id, &f.signer_b, &AttestedOutcome::Invalid);
        assert_eq!(
            f.env.events().all().filter_by_contract(&f.resolver_id),
            [
                soroban_sdk::Event::to_xdr(
                    &Attested {
                        market_id: f.market_id,
                        signer: f.signer_b.clone(),
                        outcome: AttestedOutcome::Invalid,
                        trace_id: None,
                        count: 2,
                    },
                    &f.env,
                    &f.resolver_id
                ),
                soroban_sdk::Event::to_xdr(
                    &ResolutionProposedV2 {
                        market_id: f.market_id,
                        outcome: AttestedOutcome::Invalid,
                        proposed_at: 2_000,
                    },
                    &f.env,
                    &f.resolver_id
                ),
            ]
        );

        f.env.ledger().set_timestamp(2_100);
        f.resolver.finalize_signers(&f.market_id);
        assert_eq!(
            f.env.events().all().filter_by_contract(&f.resolver_id),
            [
                soroban_sdk::Event::to_xdr(
                    &CommitteeVoided {
                        market_id: f.market_id,
                        finalized_at: 2_100,
                        invalid_count: 2,
                    },
                    &f.env,
                    &f.resolver_id
                ),
                soroban_sdk::Event::to_xdr(
                    &ResolutionFinalizedV2 {
                        market_id: f.market_id,
                        outcome: AttestedOutcome::Invalid,
                        finalized_at: 2_100,
                    },
                    &f.env,
                    &f.resolver_id
                ),
            ]
        );
    }

    #[test]
    fn price_mode_market_rejects_attest() {
        let f = price_fixture(2_500, 1_999);
        f.env.ledger().set_timestamp(2_000);
        for outcome in [AttestedOutcome::Yes, AttestedOutcome::Invalid] {
            assert_eq!(
                f.resolver.try_attest(&f.market_id, &f.signer_a, &outcome),
                Err(Ok(Error::MarketNotConfigured))
            );
        }
    }

    #[test]
    fn dispute_of_invalid_proposal_must_name_an_outcome_and_invalid_ruling_upholds() {
        let d = dispute_fixture(false);
        // dispute_fixture proposes No; replace it with an Invalid proposal.
        d.f.resolver
            .attest(&d.f.market_id, &d.f.signer_a, &AttestedOutcome::Invalid);
        d.f.resolver
            .attest(&d.f.market_id, &d.f.signer_b, &AttestedOutcome::Invalid);
        assert_eq!(
            d.f.resolver.try_dispute(&d.f.market_id, &d.disputer, &None),
            Err(Ok(Error::InvalidConfig))
        );
        open(&d);
        let treasury = d.f.market_core.get_config().treasury;
        d.f.resolver
            .settle_dispute(&d.f.market_id, &Verdict::Invalid);
        assert_eq!(status(&d), MarketStatus::Void);
        d.f.resolver.claim_dispute_bond(&d.f.market_id);
        assert_eq!(balance(&d, &treasury), BOND);
    }

    // ----- price snapshots (oracle history retention) ---------------------

    /// SEP-40 feed with bounded history: `price(ts)` returns the newest
    /// record at or before `ts`, but only among the last `retention` pushed.
    #[contract]
    struct RetentionReflector;

    #[contractimpl]
    impl RetentionReflector {
        pub fn push(env: Env, price: i128, timestamp: u64) {
            let mut history: Vec<PriceData> = env
                .storage()
                .instance()
                .get(&0u32)
                .unwrap_or(Vec::new(&env));
            history.push_back(PriceData { price, timestamp });
            env.storage().instance().set(&0u32, &history);
        }

        pub fn set_retention(env: Env, n: u32) {
            env.storage().instance().set(&1u32, &n);
        }

        pub fn price(env: Env, _asset: OracleAsset, timestamp: u64) -> Option<PriceData> {
            let history: Vec<PriceData> = env
                .storage()
                .instance()
                .get(&0u32)
                .unwrap_or(Vec::new(&env));
            let retention: u32 = env.storage().instance().get(&1u32).unwrap_or(u32::MAX);
            let oldest = history.len().saturating_sub(retention);
            (oldest..history.len())
                .rev()
                .map(|i| history.get_unchecked(i))
                .find(|record| record.timestamp <= timestamp)
        }
    }

    /// A revealed price market (threshold 2_000 Above, max_staleness 10,
    /// close 2_000) on a `RetentionReflector` keeping 3 records, at t = 2_001.
    fn retention_fixture() -> (Fixture, RetentionReflectorClient<'static>) {
        let f = fixture(|env, _r, _a, _b| {
            let feed = env.register(RetentionReflector, ());
            ResolutionSpec::Price(price_spec(env, &feed))
        });
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        let feed = RetentionReflectorClient::new(&f.env, &spec.reflector);
        feed.set_retention(&3);
        f.env.ledger().set_timestamp(2_001);
        (f, feed)
    }

    fn age_out(feed: &RetentionReflectorClient) {
        for ts in [2_010_u64, 2_020, 2_030] {
            feed.push(&1_000, &ts);
        }
    }

    fn last_price_resolution(f: &Fixture) -> PriceResolutionV2 {
        use soroban_sdk::{xdr, TryFromVal};
        let events = f.env.events().all().filter_by_contract(&f.resolver_id);
        let last = events.events().last().unwrap().clone();
        let xdr::ContractEventBody::V0(body) = last.body;
        let data = soroban_sdk::Val::try_from_val(&f.env, &body.data).unwrap();
        let map: soroban_sdk::Map<Symbol, soroban_sdk::Val> =
            soroban_sdk::Map::try_from_val(&f.env, &data).unwrap();
        let get = |name: &str| map.get(Symbol::new(&f.env, name)).unwrap();
        PriceResolutionV2 {
            market_id: f.market_id,
            price: i128::try_from_val(&f.env, &get("price")).unwrap(),
            price_timestamp: u64::try_from_val(&f.env, &get("price_timestamp")).unwrap(),
            outcome: Outcome::try_from_val(&f.env, &get("outcome")).unwrap(),
            from_snapshot: bool::try_from_val(&f.env, &get("from_snapshot")).unwrap(),
        }
    }

    #[test]
    fn snapshot_then_resolve_after_retention_expired() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.snapshot_price(&f.market_id, &caller),
            PriceData {
                price: 2_500,
                timestamp: 2_000
            }
        );
        assert_eq!(
            f.env.events().all().filter_by_contract(&f.resolver_id),
            [soroban_sdk::Event::to_xdr(
                &PriceSnapshotted {
                    market_id: f.market_id,
                    price: 2_500,
                    price_timestamp: 2_000,
                    taken_by: caller.clone(),
                },
                &f.env,
                &f.resolver_id
            )]
        );
        let stored = f.resolver.snapshot(&f.market_id).unwrap();
        assert_eq!((stored.taken_at, stored.taken_by), (2_001, caller));

        age_out(&feed);
        let asset = OracleAsset::Other(Symbol::new(&f.env, "XLM"));
        assert_eq!(feed.price(&asset, &2_000), None);

        f.env.ledger().set_timestamp(2_040);
        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert!(last_price_resolution(&f).from_snapshot);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn resolve_without_snapshot_uses_live_read() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert_eq!(
            last_price_resolution(&f),
            PriceResolutionV2 {
                market_id: f.market_id,
                price: 2_500,
                price_timestamp: 2_000,
                outcome: Outcome::Yes,
                from_snapshot: false,
            }
        );
    }

    #[test]
    fn resolve_without_snapshot_after_retention_fails_price_unavailable() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        age_out(&feed);
        assert_eq!(
            f.resolver.try_resolve_price(&f.market_id),
            Err(Ok(Error::PriceUnavailable))
        );
    }

    #[test]
    fn snapshot_after_retention_fails_and_stores_nothing() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        age_out(&feed);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::PriceUnavailable))
        );
        assert_eq!(f.resolver.snapshot(&f.market_id), None);
    }

    #[test]
    fn snapshot_rejects_stale_price_and_stores_nothing() {
        let (f, feed) = retention_fixture();
        // 11s before close with max_staleness 10.
        feed.push(&2_500, &1_989);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::StalePrice))
        );
        assert_eq!(f.resolver.snapshot(&f.market_id), None);
    }

    #[test]
    fn second_snapshot_rejected_snapshot_exists() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        let caller = Address::generate(&f.env);
        f.resolver.snapshot_price(&f.market_id, &caller);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::SnapshotExists))
        );
    }

    #[test]
    fn snapshot_before_close_rejected() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &1_999);
        f.env.ledger().set_timestamp(1_999);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::MarketNotClosed))
        );
    }

    #[test]
    fn snapshot_on_signer_market_rejected_wrong_mode() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::WrongMode))
        );
        let unrevealed =
            fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        unrevealed.env.ledger().set_timestamp(2_000);
        assert_eq!(
            unrevealed
                .resolver
                .try_snapshot_price(&unrevealed.market_id, &Address::generate(&unrevealed.env)),
            Err(Ok(Error::MarketNotConfigured))
        );
    }

    #[test]
    fn snapshot_after_finalize_rejected() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        f.resolver.resolve_price(&f.market_id);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    #[test]
    fn snapshot_boundary_equal_max_staleness_accepted() {
        let (f, feed) = retention_fixture();
        // Exactly max_staleness (10s) before close: accepted (`>` comparison).
        feed.push(&2_000, &1_990);
        let caller = Address::generate(&f.env);
        f.resolver.snapshot_price(&f.market_id, &caller);
        age_out(&feed);
        // 2_000 is not Above the 2_000 threshold.
        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::No);
    }

    #[test]
    fn snapshot_with_trapping_oracle_is_price_unavailable() {
        // `a` has no contract deployed, so the feed call fails in the host.
        let f = fixture(|env, _reflector, a, _b| ResolutionSpec::Price(price_spec(env, a)));
        let ResolutionSpec::Price(spec) = f.spec.clone() else {
            unreachable!()
        };
        f.resolver.register_price_spec(&f.market_id, &spec);
        f.env.ledger().set_timestamp(2_000);
        let caller = Address::generate(&f.env);
        assert_eq!(
            f.resolver.try_snapshot_price(&f.market_id, &caller),
            Err(Ok(Error::PriceUnavailable))
        );
    }

    #[test]
    fn snapshot_blocks_oracle_unavailable_void_and_expiry_resolves_from_it() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        let caller = Address::generate(&f.env);
        f.resolver.snapshot_price(&f.market_id, &caller);
        age_out(&feed);

        f.env.ledger().set_timestamp(2_000 + ORACLE_GRACE_SECS);
        assert_eq!(
            f.resolver
                .try_guardian_void_market(&f.market_id, &GuardianReason::OracleUnavailable),
            Err(Ok(Error::GuardianNotAllowed))
        );
        f.env.ledger().set_timestamp(DEADLINE);
        f.resolver.expire_market(&f.market_id);
        assert_eq!(
            f.market_core.get_market(&f.market_id).status,
            MarketStatus::Resolved(Outcome::Yes)
        );
    }

    #[test]
    fn snapshot_requires_caller_auth() {
        let (f, feed) = retention_fixture();
        feed.push(&2_500, &2_000);
        let caller = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .resolver
            .try_snapshot_price(&f.market_id, &caller)
            .is_err());
        assert_eq!(f.resolver.snapshot(&f.market_id), None);
    }
    #[test]
    fn two_step_admin_transfer() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let new_admin = Address::generate(&f.env);
        assert_eq!(f.resolver.admin(), f.admin);
        assert_eq!(f.resolver.pending_admin(), None);

        f.resolver.propose_admin(&new_admin);
        assert_eq!(
            f.resolver.pending_admin().map(|p| p.address),
            Some(new_admin.clone())
        );
        f.resolver.accept_admin();
        assert_eq!(f.resolver.admin(), new_admin);
        assert_eq!(f.resolver.pending_admin(), None);
    }

    #[test]
    fn admin_transfer_can_be_cancelled() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let new_admin = Address::generate(&f.env);
        f.resolver.propose_admin(&new_admin);
        f.resolver.cancel_admin_transfer();
        assert_eq!(f.resolver.pending_admin(), None);
        assert_eq!(
            f.resolver.try_accept_admin(),
            Err(Ok(Error::NoPendingAdmin))
        );
    }

    #[test]
    fn expired_admin_transfer_cannot_be_accepted() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let new_admin = Address::generate(&f.env);
        f.resolver.propose_admin(&new_admin);
        f.env
            .ledger()
            .set_timestamp(f.env.ledger().timestamp() + ADMIN_PROPOSAL_TTL_SECS + 1);
        assert_eq!(
            f.resolver.try_accept_admin(),
            Err(Ok(Error::PendingAdminExpired))
        );
        // The expired record stays visible so operators can inspect/clear it.
        assert!(f
            .resolver
            .pending_admin()
            .map(|p| p.expires_at < f.env.ledger().timestamp())
            .unwrap_or(false));
    }

    #[test]
    fn wrong_caller_cannot_accept_admin() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let new_admin = Address::generate(&f.env);
        f.resolver.propose_admin(&new_admin);
        // `accept_admin` must be called by the *proposed* admin; a bystander
        // cannot usher it in.
        let bystander = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .resolver
            .mock_auths(&[MockAuth {
                address: &bystander,
                invoke: &MockAuthInvoke {
                    contract: &f.resolver_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin()
            .is_err());
        assert_eq!(f.resolver.admin(), f.admin);
    }

    #[test]
    fn wrong_caller_cannot_propose_or_cancel_admin() {
        let f = fixture(|env, reflector, _a, _b| ResolutionSpec::Price(price_spec(env, reflector)));
        let new_admin = Address::generate(&f.env);
        f.env.set_auths(&[]);
        assert!(f
            .resolver
            .mock_auths(&[MockAuth {
                address: &f.signer_a,
                invoke: &MockAuthInvoke {
                    contract: &f.resolver_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&new_admin)
            .is_err());
        assert!(f
            .resolver
            .mock_auths(&[MockAuth {
                address: &f.signer_a,
                invoke: &MockAuthInvoke {
                    contract: &f.resolver_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer()
            .is_err());
    }

    // ---- model_trace_*: conformance replays of docs/formal/resolver.tla ----
    //
    // Each test replays a trace produced by TLC (see docs/formal/README.md
    // for the config that yields it) against the real contracts. The fixture
    // has 2 signers, threshold 2, dispute window 100, close_time 2_000.

    fn market_status(f: &Fixture) -> MarketStatus {
        f.market_core.get_market(&f.market_id).status
    }

    /// resolver.cfg happy path: RegisterSigners, Tick, Attest, Attest,
    /// Tick x W, Finalize.
    #[test]
    fn model_trace_signers_happy_path_yes() {
        let f = signer_fixture();
        assert_eq!(
            f.resolver.state(&f.market_id),
            ResolutionState::SignersPending
        );
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        assert_eq!(market_status(&f), MarketStatus::Open);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::Yes));
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Finalized);
        // FinalImpliesClosed + AtMostOnceFinal: nothing can change it again.
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::No),
            Err(Ok(Error::AlreadyFinalized))
        );
        assert!(f.resolver.try_finalize_signers(&f.market_id).is_err());
        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::Yes));
    }

    /// resolver.cfg happy path in price mode: RegisterPrice, Tick, ResolvePrice.
    /// Price mode never enters `SignersPending`.
    #[test]
    fn model_trace_price_happy_path_yes() {
        let f = price_fixture(2_500, 1_999);
        assert_eq!(
            f.resolver.state(&f.market_id),
            ResolutionState::Unconfigured
        );
        f.env.ledger().set_timestamp(1_500);
        assert_eq!(
            f.resolver.try_resolve_price(&f.market_id),
            Err(Ok(Error::MarketNotClosed))
        );
        f.env.ledger().set_timestamp(2_000);
        assert_eq!(f.resolver.resolve_price(&f.market_id), Outcome::Yes);
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Finalized);
        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::Yes));
        assert_eq!(
            f.resolver.try_resolve_price(&f.market_id),
            Err(Ok(Error::AlreadyFinalized))
        );
    }

    /// resolver_cancel.cfg (NoStrandedQuorum): RegisterSigners, Tick,
    /// Attest(s1,Yes), Attest(s2,Yes), Cancel. Both signers already backed
    /// Yes, so the Yes quorum can never re-propose and `finalize_signers`
    /// reports NoProposal although quorum exists. The cancelled proposal is
    /// never finalized; the market stays open until a guardian void
    /// (SignersStalled) or expiry.
    #[test]
    fn model_trace_cancel_strands_quorum_until_stalled_void() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        f.resolver
            .cancel_proposal(&f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(stored_proposal(&f), None);
        assert_eq!(
            f.resolver.state(&f.market_id),
            ResolutionState::SignersPending
        );

        // Stranded: quorum for Yes, yet nothing can re-propose it.
        f.env.ledger().set_timestamp(2_500);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::NoProposal))
        );
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Yes),
            Err(Ok(Error::AlreadyAttested))
        );
        assert_eq!(market_status(&f), MarketStatus::Open);

        // The recourse is the guardian's SignersStalled void, after the grace.
        assert_eq!(
            f.resolver
                .try_guardian_void_market(&f.market_id, &GuardianReason::SignersStalled),
            Err(Ok(Error::GuardianNotAllowed))
        );
        f.env.ledger().set_timestamp(2_000 + SIGNER_GRACE_SECS);
        f.resolver
            .guardian_void_market(&f.market_id, &GuardianReason::SignersStalled);
        assert_eq!(market_status(&f), MarketStatus::Void);
        assert_eq!(f.resolver.state(&f.market_id), ResolutionState::Finalized);
    }

    /// resolver_invalid.cfg (NoInvalidDisplacement), intended behaviour:
    /// an Invalid quorum displaces a pending Yes proposal and restarts the
    /// dispute window.
    #[test]
    fn model_trace_invalid_quorum_displaces_yes_and_restarts_window() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        assert_eq!(stored_proposal(&f).unwrap().outcome, AttestedOutcome::Yes);

        f.env.ledger().set_timestamp(2_050);
        attest_both(&f, AttestedOutcome::Invalid);
        let p = stored_proposal(&f).unwrap();
        assert_eq!(
            (p.outcome, p.proposed_at),
            (AttestedOutcome::Invalid, 2_050)
        );

        // The Yes window would have closed at 2_100; the restarted one has not.
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.try_finalize_signers(&f.market_id),
            Err(Ok(Error::DisputeWindowOpen))
        );
        f.env.ledger().set_timestamp(2_150);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Invalid
        );
        assert_eq!(market_status(&f), MarketStatus::Void);
    }

    /// resolver_both_outcomes.cfg (ProposalTimestampStable) refutes the
    /// suspected griefing: signers attesting the other outcome after a
    /// proposal exists neither move it nor reset `proposed_at`.
    #[test]
    fn model_trace_other_outcome_quorum_does_not_reset_window() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        f.env.ledger().set_timestamp(2_050);
        attest_both(&f, AttestedOutcome::No);
        let p = stored_proposal(&f).unwrap();
        assert_eq!((p.outcome, p.proposed_at), (AttestedOutcome::Yes, 2_000));
        f.env.ledger().set_timestamp(2_100);
        assert_eq!(
            f.resolver.finalize_signers(&f.market_id),
            AttestedOutcome::Yes
        );
        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::Yes));
    }

    /// resolver.cfg (NoResolveBeforeClose): the guardian cannot void before
    /// close_time for any reason, and no attestation can exist yet.
    #[test]
    fn model_trace_no_void_or_attestation_before_close() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(1_500);
        for reason in [
            GuardianReason::UnrevealedSpec,
            GuardianReason::OracleUnavailable,
            GuardianReason::SignersStalled,
            GuardianReason::DisputeUpheld,
        ] {
            assert_eq!(
                f.resolver.try_guardian_void_market(&f.market_id, &reason),
                Err(Ok(Error::GuardianNotAllowed))
            );
        }
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::Invalid),
            Err(Ok(Error::MarketNotClosed))
        );
        assert_eq!(market_status(&f), MarketStatus::Open);
    }

    /// resolver.cfg: a guardian void is terminal for the resolver. Later
    /// attestations fail on `AlreadyFinalized`, and `finalize_signers` on a
    /// proposal that predates the void fails inside market-core.
    #[test]
    fn model_trace_guardian_void_blocks_later_attest_and_finalize() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        f.resolver
            .guardian_void_market(&f.market_id, &GuardianReason::DisputeUpheld);
        assert_eq!(market_status(&f), MarketStatus::Void);
        assert_eq!(
            f.resolver
                .try_attest(&f.market_id, &f.signer_a, &AttestedOutcome::No),
            Err(Ok(Error::AlreadyFinalized))
        );
        f.env.ledger().set_timestamp(2_100);
        assert!(f.resolver.try_finalize_signers(&f.market_id).is_err());
        assert_eq!(market_status(&f), MarketStatus::Void);
    }

    /// resolver.cfg (Expire): expiry refuses while a quorum-backed proposal
    /// exists and voids once it is cancelled.
    #[test]
    fn model_trace_expire_blocked_by_valid_proposal() {
        let f = signer_fixture();
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::Yes);
        f.env.ledger().set_timestamp(DEADLINE);
        assert_eq!(
            f.resolver.try_expire_market(&f.market_id),
            Err(Ok(Error::ResolutionAvailable))
        );
        assert_eq!(market_status(&f), MarketStatus::Open);
    }

    /// Stand-in for "some other resolver": all market-core's wiring
    /// handshake needs from the peer is `market_core()`.
    #[contract]
    struct WiringPeer;

    #[contractimpl]
    impl WiringPeer {
        pub fn __constructor(env: Env, core: Address) {
            env.storage().instance().set(&0u32, &core);
        }

        pub fn market_core(env: Env) -> Address {
            env.storage().instance().get(&0u32).unwrap()
        }
    }

    /// resolver_bypass.cfg (ResolvedOutcomeHadThreshold fails by design):
    /// the market-core admin hands the resolver role to another contract,
    /// which resolves without this resolver's signers ever reaching quorum.
    /// A documented trust assumption (ADR 0001, 0006, 0007), not a contract
    /// bug in the resolver.
    #[test]
    fn model_trace_admin_bypass_resolves_without_threshold() {
        let f = signer_fixture();
        let peer = f.env.register(WiringPeer, (f.market_core.address.clone(),));
        f.market_core.propose_resolver(&peer);
        f.market_core.accept_resolver();

        f.env.ledger().set_timestamp(2_000);
        f.market_core.resolve(&f.market_id, &Outcome::No);

        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::No));
        // This resolver saw none of it: no votes, still "pending", and it
        // can no longer move the market (market-core rejects it as resolver).
        assert_eq!(
            f.resolver.state(&f.market_id),
            ResolutionState::SignersPending
        );
        f.env.as_contract(&f.resolver_id, || {
            assert_eq!(
                Resolver::attestation_count(&f.env, f.market_id, AttestedOutcome::No),
                0
            );
        });
        attest_both(&f, AttestedOutcome::Yes);
        f.env.ledger().set_timestamp(2_100);
        assert!(f.resolver.try_finalize_signers(&f.market_id).is_err());
        assert_eq!(market_status(&f), MarketStatus::Resolved(Outcome::No));
    }

    /// Everything observable about market-core through a resolver scenario,
    /// as text: trading maths, final status, payouts, balances.
    fn market_core_trace() -> std::vec::Vec<std::string::String> {
        use std::format;
        let f = signer_fixture();
        let id = f.market_id;
        let creator = f.market_core.get_market(&id).creator;
        let one = 10_000_000_i128;
        let mut t = std::vec::Vec::new();
        t.push(format!(
            "price {}",
            f.market_core.get_price(&id, &Outcome::Yes)
        ));
        t.push(format!(
            "quote {}",
            f.market_core.quote_buy(&id, &Outcome::Yes, &(10 * one))
        ));
        t.push(format!(
            "buy {}",
            f.market_core
                .buy(&creator, &id, &Outcome::Yes, &(10 * one), &0)
        ));
        t.push(format!(
            "price {}",
            f.market_core.get_price(&id, &Outcome::Yes)
        ));
        t.push(format!(
            "sell {}",
            f.market_core
                .sell(&creator, &id, &Outcome::Yes, &(3 * one), &(100 * one))
        ));
        t.push(format!(
            "pos {:?}",
            f.market_core.get_position(&id, &creator)
        ));
        f.env.ledger().set_timestamp(2_000);
        attest_both(&f, AttestedOutcome::No);
        t.push(format!("early {:?}", f.resolver.try_finalize_signers(&id)));
        f.env.ledger().set_timestamp(2_100);
        t.push(format!("finalize {:?}", f.resolver.finalize_signers(&id)));
        t.push(format!("status {:?}", f.market_core.get_market(&id).status));
        t.push(format!("again {:?}", f.resolver.try_finalize_signers(&id)));
        t.push(format!("redeem {}", f.market_core.redeem(&creator, &id)));
        t.push(format!("claim {}", f.market_core.claim_pool_remainder(&id)));
        t.push(format!("sweep {}", f.market_core.sweep_fees(&id)));
        t
    }

    /// The native registration (which coverage can see) must be a faithful
    /// stand-in for the wasm that ships, and for the vendored copy drifting
    /// from the source: identical observable behaviour, step by step.
    #[test]
    fn native_and_wasm_market_core_agree() {
        let wasm = with_market_core(McImpl::Wasm, market_core_trace);
        let native = with_market_core(McImpl::Native, market_core_trace);
        assert_eq!(wasm, native);
        assert!(wasm.len() > 10, "{wasm:?}");
    }

    both_modes!(
        price_mode_resolves_from_historical_reflector_price,
        signer_mode_requires_threshold_and_waits_for_dispute_window,
        invalid_attestations_void_market_after_dispute_window,
        guardian_cancel_of_invalid_proposal_then_yes_finalizes,
        expire_voids_signer_market_once_proposal_is_cancelled,
        attest_rejected_after_expiry,
        guardian_void_rejected_after_expiry,
        cancel_proposal_blocked_while_disputed,
        guardian_void_while_disputed_refunds_bond,
        model_trace_signers_happy_path_yes,
        model_trace_price_happy_path_yes,
        model_trace_cancel_strands_quorum_until_stalled_void,
        model_trace_invalid_quorum_displaces_yes_and_restarts_window,
        model_trace_other_outcome_quorum_does_not_reset_window,
        model_trace_no_void_or_attestation_before_close,
        model_trace_guardian_void_blocks_later_attest_and_finalize,
        model_trace_expire_blocked_by_valid_proposal,
        model_trace_admin_bypass_resolves_without_threshold,
    );
}

#[cfg(test)]
fn bytes_to_vec(bytes: &Bytes) -> std::vec::Vec<u8> {
    let mut out = std::vec![0u8; bytes.len() as usize];
    bytes.copy_into_slice(&mut out);
    out
}

/// Proves the shared `oracledesk-types` definitions encode byte-for-byte the
/// same as the types `contractimport!` generates from the vendored
/// `market_core.wasm` spec. If a field or variant is ever renamed on one side
/// only, this fails instead of silently changing the cross-contract ABI.
#[cfg(test)]
mod shared_types {
    use super::*;
    use soroban_sdk::xdr::ToXdr;

    #[test]
    fn shared_types_are_byte_identical_to_imported_wasm_types() {
        let env = Env::default();
        for (shared, imported) in [
            (Outcome::Yes, market_core::Outcome::Yes),
            (Outcome::No, market_core::Outcome::No),
        ] {
            assert_eq!(shared.to_xdr(&env), imported.to_xdr(&env));
        }
        for (shared, imported) in [
            (oracledesk_types::Category::Crypto, market_core::Category::Crypto),
            (oracledesk_types::Category::Macro, market_core::Category::Macro),
            (
                oracledesk_types::Category::Geopolitics,
                market_core::Category::Geopolitics,
            ),
            (oracledesk_types::Category::Sports, market_core::Category::Sports),
            (
                oracledesk_types::Category::Culture,
                market_core::Category::Culture,
            ),
            (oracledesk_types::Category::Other, market_core::Category::Other),
        ] {
            assert_eq!(shared.to_xdr(&env), imported.to_xdr(&env));
        }
        assert_eq!(
            oracledesk_types::MarketStatus::Resolved(Outcome::Yes).to_xdr(&env),
            market_core::MarketStatus::Resolved(market_core::Outcome::Yes).to_xdr(&env)
        );
        assert_eq!(
            oracledesk_types::MarketStatus::Void.to_xdr(&env),
            market_core::MarketStatus::Void.to_xdr(&env)
        );
    }
}

/// Pins the exact bytes behind every legacy `resolution_hash`. A change to
/// field names, variant names or soroban-sdk's `to_xdr` encoding changes these
/// hashes and strands every unrevealed market, so a failure here must never be
/// "fixed" by editing the vectors: add a new `ResolutionSpec` variant instead
/// (see `docs/adr/0004-spec-versioning.md`).
#[cfg(test)]
mod golden {
    use super::*;
    use std::{format, string::String};

    const G1: &str = "GBAKBHXK7SV7C3HGY3DDYB4QWUEGL52SEF6OO77LAD672JVXD4QCYJLF";
    const G2: &str = "GCKBJQ6633JFYSFV6HHF2FQUN4QUX5PVE63PODYIKO2CE3RCXAF5NZCW";
    const G3: &str = "GAJ7BAGE252F636J2HNCRCSFLALJRBY3YQK6DE7Q7DWZECWIR2VOTYZL";
    const C1: &str = "CC3KU5TWAATOBXLWIV4ZTXNEM44VIOY3ZTR7KTJTBOOBP7YIXMCDSWDJ";
    const C2: &str = "CCILJXZCHKAIBTMJ7NSQE756OGLKTOYNSWNNZXWAYZZA4ECAUEC2CNVF";
    const C3: &str = "CCAMJLLDELRB4PCMI5Z526NOEPM7IMUUY2MX6ERSUFOTQBALUGEXCREV";

    fn signers(env: &Env, keys: &[&str], threshold: u32, dispute_window: u64) -> ResolutionSpec {
        let mut signers = Vec::new(env);
        for key in keys {
            signers.push_back(Address::from_str(env, key));
        }
        ResolutionSpec::Signers(SignerConfig {
            signers,
            threshold,
            dispute_window,
        })
    }

    fn cat_signers(
        env: &Env,
        keys: &[&str],
        outcome_count: u32,
        threshold: u32,
        dispute_window: u64,
    ) -> ResolutionSpec {
        let mut signers = Vec::new(env);
        for key in keys {
            signers.push_back(Address::from_str(env, key));
        }
        ResolutionSpec::CategoricalSigners(CatSignerConfig {
            signers,
            threshold,
            dispute_window,
            outcome_count,
        })
    }

    fn price(
        env: &Env,
        asset: OracleAsset,
        threshold: i128,
        direction: PriceDirection,
        max_staleness: u64,
    ) -> ResolutionSpec {
        ResolutionSpec::Price(PriceConfig {
            reflector: Address::from_str(env, C1),
            asset,
            threshold,
            direction,
            max_staleness,
        })
    }

    fn scalar(
        env: &Env,
        asset: OracleAsset,
        lower: i128,
        upper: i128,
        max_staleness: u64,
    ) -> ResolutionSpec {
        ResolutionSpec::Scalar(ScalarPriceConfig {
            reflector: Address::from_str(env, C1),
            asset,
            lower,
            upper,
            max_staleness,
        })
    }

    fn hex_of(env: &Env, spec: &ResolutionSpec) -> String {
        let hash: BytesN<32> = env.crypto().sha256(&spec.clone().to_xdr(env)).into();
        hash.to_array().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Shared byte-for-byte with `golden_scalar_vectors` in
    /// `scripts/spec-hash`: the scalar variant (tag 5) mirrors the price
    /// fields, so it must be pinned against drifting into the price hash
    /// space.
    #[test]
    fn golden_legacy_scalar_spec_hashes() {
        let env = Env::default();
        let xlm = || OracleAsset::Other(Symbol::new(&env, "XLM"));
        let asset = |id: &str| OracleAsset::Stellar(Address::from_str(&env, id));
        let vectors = [
            (
                scalar(&env, xlm(), 100, 250, 10),
                "e97c4bccc39a4538850b22e703019c3b69971a00b99bc73117cc67e044e26822",
            ),
            (
                scalar(&env, asset(C2), 0, 1_000_000_000_000, 300),
                "1d94380e9112c6f80f7542106dcc75ffc1426a634da2a07440fac72d2033fa08",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hex_of(&env, &spec), expected);
        }
        assert_ne!(
            hex_of(&env, &scalar(&env, xlm(), 2_000, 2_000, 10)),
            hex_of(&env, &price(&env, xlm(), 2_000, PriceDirection::Above, 10)),
        );
    }

    #[test]
    fn golden_legacy_signer_spec_hashes() {
        let env = Env::default();
        let vectors = [
            (
                signers(&env, &[G1], 1, 5),
                "b935a3beeebdbf7b9defc916410f19a1740a3920623230152e41a812b6f141c4",
            ),
            (
                signers(&env, &[G1, G2, G3], 2, 3_600),
                "4373448f97b0dd998a70efd9a1bfd3b3b8639bebaf682d9fc083c11f248a99ee",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hex_of(&env, &spec), expected);
        }
    }

    /// Shared byte-for-byte with `golden_cat_signers_vectors` in
    /// `scripts/spec-hash`: the CLI parsers and the contract types must produce
    /// byte-identical commitments, and the appended variant must not collide
    /// with any existing one.
    #[test]
    fn golden_legacy_cat_signer_spec_hashes() {
        let env = Env::default();
        let vectors = [
            (
                cat_signers(&env, &[G1], 2, 1, 5),
                "16db57d51742d266dccd1a70539afc160971c942605a0ae8f15b5a18cd1b2837",
            ),
            (
                cat_signers(&env, &[G1, G2, G3], 3, 2, 3_600),
                "21b750237b5cb3f54bdc71ec55a1d8073a3b860f6cb3cb3b9717570dc42092e7",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hex_of(&env, &spec), expected);
        }
        assert_ne!(
            hex_of(&env, &cat_signers(&env, &[G1], 2, 1, 5)),
            hex_of(&env, &signers(&env, &[G1], 1, 5)),
        );
    }

    /// `Vec` order is part of the XDR, so the same signer set in another
    /// order is a different commitment. Off-chain tooling (the market-maker's
    /// `agents/core/spec.ts`, `scripts/seed-market.sh`) must hash and reveal
    /// one canonical order: lexicographic strkey.
    #[test]
    fn signer_spec_hash_depends_on_signer_order() {
        let env = Env::default();
        let declared = hex_of(&env, &signers(&env, &[G1, G2, G3], 2, 3_600));
        let canonical = hex_of(&env, &signers(&env, &[G3, G1, G2], 2, 3_600));
        assert_eq!(
            declared,
            "4373448f97b0dd998a70efd9a1bfd3b3b8639bebaf682d9fc083c11f248a99ee"
        );
        assert_ne!(declared, canonical);
    }

    #[test]
    fn golden_legacy_price_spec_hashes() {
        let env = Env::default();
        let xlm = || OracleAsset::Other(Symbol::new(&env, "XLM"));
        let asset = |id: &str| OracleAsset::Stellar(Address::from_str(&env, id));
        let vectors = [
            (
                price(&env, xlm(), 2_000, PriceDirection::Above, 10),
                "b6f2458326d5f76bd9b53a93a103ea6c0fed7129c5496e91e3faef9a9a23d469",
            ),
            (
                price(&env, asset(C2), 100, PriceDirection::AtOrAbove, 300),
                "fa4cb1bbf39e94a2e699906ddd7228bd0b23ff8c4e968828485dcf3c644dadc2",
            ),
            (
                price(&env, xlm(), 0, PriceDirection::Below, 600),
                "0236202a346acee0cc18c7c47e4e31b67efa559dc2ff6ac66783f9ea5254f03d",
            ),
            (
                price(
                    &env,
                    asset(C3),
                    7_500_000_000_000,
                    PriceDirection::AtOrBelow,
                    86_400,
                ),
                "c9e1a0fb8443cdf1ea0190af347ff45f54bec12499f3b5111ff81b96b4794570",
            ),
        ];
        for (spec, expected) in vectors {
            assert_eq!(hex_of(&env, &spec), expected);
        }
    }

    /// V2 golden vector, re-derived independently from raw XDR (no Soroban) in
    /// `scripts/spec-hash` tests. The ledger network id is fixed explicitly so
    /// the vector never depends on the test `Env` default.
    #[test]
    fn golden_v2_spec_hash() {
        use soroban_sdk::testutils::Ledger;
        let env = Env::default();
        let testnet_id: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Test SDF Network ; September 2015",
            ))
            .into();
        env.ledger().set_network_id(testnet_id.to_array());
        let spec = ResolutionSpecV2 {
            version: 2,
            network_id: env.ledger().network_id(),
            market_core: Address::from_str(&env, C2),
            salt: BytesN::from_array(&env, &core::array::from_fn(|i| i as u8 + 1)),
            rule: signers(&env, &[G1], 1, 5),
        };
        let hash = spec_v2_hash(&env, &spec);
        assert_eq!(
            hash.to_array()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "27e995544f9f631be41177890b7a1be7e17c667e4e531aa08e5089dd899566ae"
        );
    }

    /// Shared byte-for-byte with `agents/core/attestation.test.ts`: the Rust
    /// contract and the TypeScript signer must build the identical message.
    #[test]
    fn golden_attestation_message_and_signature() {
        use ed25519_dalek::Signer;
        use soroban_sdk::testutils::Ledger;
        let env = Env::default();
        let testnet_id: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Test SDF Network ; September 2015",
            ))
            .into();
        env.ledger().set_network_id(testnet_id.to_array());
        let resolver_id = env.register_at(
            &Address::from_str(&env, C1),
            Resolver,
            (Address::from_str(&env, G1), Address::from_str(&env, C2)),
        );
        let spec_hash = BytesN::from_array(&env, &core::array::from_fn(|i| 0xa0 + i as u8));

        let message = env.as_contract(&resolver_id, || {
            Resolver::attestation_message(&env, 7, 3, &Outcome::No, &spec_hash)
        });
        let message_hex: String = bytes_to_vec(&message)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(message_hex, "6f7261636c656465736b2d6174746573742d7631cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd4720000001200000001b6aa76760026e0dd76457999dda46739543b1bcce3f54d330b9c17ff08bb043900000000000000070000000301a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");

        let signing = ed25519_dalek::SigningKey::from_bytes(&core::array::from_fn(|i| i as u8));
        let signature_hex: String = signing
            .sign(&bytes_to_vec(&message))
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(signature_hex, "3f7bfc9882bbe894518d059b50326069523358f3da1d74b7ed90b8b395862367155ae6ac7934b3ae610e21c3dd595b7d99c2ab122037918917c96543c0cde002");
    }

    #[contracttype]
    #[derive(Clone)]
    struct DeclaredAlphabetically {
        alpha: u32,
        beta: u32,
    }

    #[contracttype]
    #[derive(Clone)]
    struct DeclaredReversed {
        beta: u32,
        alpha: u32,
    }

    /// `#[contracttype]` structs encode as an `ScMap` keyed by field *name*,
    /// so declaration order is irrelevant but renaming a field changes the hash.
    #[test]
    fn xdr_encoding_depends_on_field_names_not_declaration_order() {
        let env = Env::default();
        let a = DeclaredAlphabetically { alpha: 1, beta: 2 }.to_xdr(&env);
        let b = DeclaredReversed { beta: 2, alpha: 1 }.to_xdr(&env);
        assert_eq!(a, b);
    }
}
