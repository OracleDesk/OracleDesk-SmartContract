#![no_std]

pub mod peers;
pub mod retention;
pub mod ttl;

// The test module builds over-length `action`/`ipfs_cid` strings with
// `str::repeat`, which lives in `alloc`/`std`; the crate itself stays
// `no_std`.
#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, String, Symbol, Vec,
};
use soroban_sdk::xdr::ToXdr;

use peers::{CoreView, ResolutionRole, ResolverView};

// Tests register a native market-core (and resolver) instead of the removed
// vendored wasm (issue #322).
#[cfg(test)]
mod market_core {
    pub use market_core_native::{Category, MarketCore, MarketCoreClient as Client};
}

/// Domain tag for commit-reveal commitments (#51). Must match
/// `agents/core/trace.ts` byte-for-byte: `sha256(TAG || trace_hash || salt)`.
pub const COMMIT_DOMAIN_TAG: &[u8] = b"oracledesk.trace.commit.v1";

/// Merkle tree constants for batch anchoring (#54).
pub const MAX_LEAVES: u32 = 4096;
pub const MAX_PROOF_LEN: u32 = 12;
pub const MERKLE_LEAF_PREFIX: u8 = 0x00;
pub const MERKLE_NODE_PREFIX: u8 = 0x01;

/// Registry error codes occupy 3001..=3999 per ADR 0006.
pub const REGISTRY_ERROR_BASE: u32 = 3000;

/// Signing key constants for Ed25519 attestations (#53).
pub const MAX_AGENT_SIGNING_KEYS: u32 = 4;
pub const AGENT_KEY_BIND_DOMAIN: &[u8] = b"oracledesk-agent-key-v1";
pub const TRACE_SIG_DOMAIN: &[u8] = b"oracledesk-trace-v1";

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningKeyRecord {
    pub public_key: BytesN<32>,
    pub added_at: u64,
    pub retired_at: Option<u64>,
}

/// #299: Retroactive revocation record for a single signing key.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyRevocation {
    pub agent: Address,
    pub compromised_since: u64,
    pub revoked_at: u64,
    pub reason: Symbol,
    pub by_admin: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceBatch {
    pub agent: Address,
    pub root: BytesN<32>,
    pub leaf_count: u32,
    pub manifest_cid: String,
    pub published_at: u64,
}

pub const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;

/// Longest accepted `action` string, in bytes (#57). Bounding every trace's
/// variable-length fields is what makes the paginated batch reads below
/// provably safe: see [`MAX_PAGE_SIZE`].
pub const MAX_ACTION_LEN: u32 = 64;
/// Longest accepted IPFS CID/URI string, in bytes (#57).
pub const MAX_CID_LEN: u32 = 128;
/// Largest page a batch read returns (#57).
///
/// Safety bound: a `Trace`'s worst-case XDR is
/// `market_id` 8 + `agent` address 56 + `action` (4 + 64) + `trace_hash` 32
/// + `ipfs_cid` (4 + 128) + `published_at` 8 ≈ 304 bytes. Wrapping each entry
/// in `TracePageEntry` adds 8 bytes for `trace_id` and a small vector overhead,
/// so one entry is under 340 bytes. A page of 25 is therefore under ~8.5 KiB
/// of ledger reads, plus at most 25 storage keys of ~50 bytes each — an order
/// of magnitude below Soroban's per-transaction read limits even if every
/// trace is maximal length. (Before this bound existed, `action`/`ipfs_cid`
/// were unbounded, so no page size could have been proven safe.)
pub const MAX_PAGE_SIZE: u32 = 25;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TraceAction {
    CreateMarket,
    ProposeMarket,
    Buy,
    Sell,
    Skip,
    Redeem,
    ClaimRemainder,
    Resolve,
    Other(Symbol),
}

pub const NO_MARKET: u64 = u64::MAX;

/// Default post-close grace for Buy/Sell traces (issue #322): the agents
/// runtime publishes a trace on a later tick than the trade it describes.
pub const DEFAULT_ACTION_GRACE_SECS: u64 = 3_600;
/// Largest grace window the admin may set (one day).
pub const MAX_ACTION_GRACE_SECS: u64 = 86_400;
/// Most `Other(Symbol)` actions the allow-list may hold.
pub const MAX_OTHER_ACTIONS: u32 = 32;

/// Market rule of an allow-listed `TraceAction::Other(Symbol)` (issue #322).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OtherRule {
    /// Must use `NO_MARKET`.
    NoMarketOnly,
    /// Must reference an existing market.
    MarketOnly,
    /// Either.
    Any,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentStatus {
    Active,
    Retired(u64),
    Revoked(u64, Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRecord {
    pub status: AgentStatus,
    pub registered_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceFlag {
    pub reason: Symbol,
    pub flagged_at: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TraceVerdict {
    Valid,
    HashMismatch,
    Flagged(Symbol),
    AgentRevokedAfter(u64),
    /// #299: The signing key was retroactively revoked; traces signed at or
    /// after `compromised_since` are tainted.
    KeyCompromised(u64),
    /// #322: a Buy/Sell trace published after the market's `close_time`,
    /// inside the grace window. Only reported when the hash matches and no
    /// flag, revocation or key compromise applies.
    Late,
}

/// #299: Verdict for a trace's signature alone (independent of hash/flag/agent).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignatureVerdict {
    NotSigned,
    WrongAgent,
    Valid,
    KeyCompromised(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRetired {
    #[topic]
    pub agent: Address,
    pub at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRevoked {
    #[topic]
    pub agent: Address,
    pub effective_from: u64,
    pub reason: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentReactivated {
    #[topic]
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceFlagged {
    #[topic]
    pub trace_id: u64,
    pub reason: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceUnflagged {
    #[topic]
    pub trace_id: u64,
    pub reason: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSigningKeyAdded {
    #[topic]
    pub agent: Address,
    #[topic]
    pub public_key: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSigningKeyRetired {
    #[topic]
    pub agent: Address,
    #[topic]
    pub public_key: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceSigned {
    #[topic]
    pub trace_id: u64,
    #[topic]
    pub agent: Address,
    #[topic]
    pub signing_key: BytesN<32>,
}

/// #299: Emitted when a signing key is retroactively revoked.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningKeyRevoked {
    #[topic]
    pub agent: Address,
    #[topic]
    pub public_key: BytesN<32>,
    pub compromised_since: u64,
    pub reason: Symbol,
    pub by_admin: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trace {
    pub market_id: u64,
    pub agent: Address,
    pub action: TraceAction,
    pub trace_hash: BytesN<32>,
    pub ipfs_cid: String,
    pub published_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceConsumeInfo {
    pub decision: Option<BytesN<32>>,
    pub ledger: u32,
}

/// One `(trace_id, Trace)` pair in a [`TracePage`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TracePageEntry {
    pub trace_id: u64,
    pub trace: Trace,
}

/// A page of traces returned by one simulation, plus the cursor to fetch the
/// next page (#57). `next == total` means the caller has seen everything.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TracePage {
    pub entries: Vec<TracePageEntry>,
    /// Index of the first entry the *next* page would return.
    pub next: u64,
    /// Total entries in this index at read time.
    pub total: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    NextId,
    Agent(Address),
    Trace(u64),
    MarketTraceCount(u64),
    MarketTrace(u64, u64),
    TraceLedger(u64),
    TraceDecision(u64),
    Flag(u64),
    Consumer(Address),
    Consumed(u64),
    AgentHead(Address),
    AgentTrace(Address, u64),
    TraceLink(u64),
    AgentTraceCount(Address),
    AgentTraceAt(Address, u64),
    MarketActionTraceCount(u64, TraceAction),
    MarketActionTraceAt(u64, TraceAction, u64),
    FlagHistoryCount(u64),
    FlagHistory(u64, u32),
    MarketCore,
    Batch(u64),
    NextBatchId,
    AgentBatchCount(Address),
    AgentBatch(Address, u64),
    AgentSigningKeys(Address),
    SigningKeyHistoryCount(Address),
    SigningKeyHistory(Address, u32),
    KeyToAgent(BytesN<32>),
    TraceSignature(u64),
    // ── #307 Per-agent consumer scoping ─────────────────────────────────────
    /// `AgentConsumer(agent, consumer)` → `ConsumerGrant { granted_at: u64 }`
    AgentConsumer(Address, Address),
    /// Count of consumers authorised by an agent (for the dense array).
    AgentConsumerCount(Address),
    /// Dense index: `AgentConsumerAt(agent, index)` → `Address` (consumer).
    AgentConsumerAt(Address, u32),
    /// Reverse slot: `AgentConsumerSlot(agent, consumer)` → `u32`.
    AgentConsumerSlot(Address, Address),
    /// Per-agent default consumer applied at publish time.
    AgentDefaultConsumer(Address),
    /// Per-trace consumer binding (write-once at publish or via bind_trace_consumer).
    TraceConsumer(u64),
    /// Batch-level consumer binding written from the agent's default at batch publish.
    BatchConsumer(u64),
    /// Instance flag: `true` once enable_consumer_scoping() has been called.
    ConsumerScoping,
    /// #299: per-key retroactive revocation record.
    KeyRevocation(BytesN<32>),
    /// #299: number of traces a key has signed (per-key index length).
    KeyTraceCount(BytesN<32>),
    /// #299: trace_id at a given index in a key's signed-trace index.
    KeyTraceAt(BytesN<32>, u64),
    // ── #316 Commit-reveal trace storage ─────────────────────────────────────
    /// Pending commitment: `TraceCommit` stored at submit time.
    TraceCommit(u64),
    /// Counter of pending commits assigned to an agent (for deadline scanning).
    AgentCommitCount(Address),
    /// Dense index: `AgentCommitAt(agent, index)` → commit_id.
    AgentCommitAt(Address, u64),
    /// Number of traces an agent missed the reveal deadline for.
    AgentMissedRevealCount(Address),
    /// #329: cached market `close_time`, written on the market's first trace
    /// so later publishes size audit TTLs without a market-core call.
    MarketClose(u64),
    /// #322: instance, admin-set post-close grace for Buy/Sell traces (secs).
    ActionGrace,
    /// #322: side flag for a Buy/Sell trace published after close, so the
    /// `Trace` XDR is unchanged.
    TraceLate(u64),
    /// #322: allow-listed `Other(Symbol)` action and its market rule.
    AllowedOther(Symbol),
    /// #322: instance list of allow-listed `Other` symbols (≤ 32).
    OtherActions,
}

/// Which secondary index `extend_index` walks (#329).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexKey {
    /// `MarketTrace(market_id, i)` / `MarketTraceCount(market_id)`.
    Market(u64),
    /// `AgentTraceAt(agent, i)` / `AgentTraceCount(agent)`.
    Agent(Address),
    /// `MarketActionTraceAt(market_id, action, i)` / its count.
    MarketAction(u64, TraceAction),
}

/// Head of an agent's append-only trace log (#52). Genesis is `seq = 0`
/// with an all-zero hash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainHead {
    pub seq: u64,
    pub head_hash: BytesN<32>,
    pub head_trace_id: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainLink {
    pub seq: u64,
    pub prev_trace_hash: BytesN<32>,
}

/// A proposed admin handover (#62). Absent when no transfer is pending.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub address: Address,
    pub expires_at: u64,
}

// ── #316 Commit-reveal trace storage ─────────────────────────────────────────

/// Default reveal deadline: 24 hours after commit.
pub const DEFAULT_REVEAL_DEADLINE_SECS: u64 = 86_400;

/// A pending trace commitment stored before the reveal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceCommit {
    pub agent: Address,
    pub market_id: u64,
    pub action: TraceAction,
    pub commitment: BytesN<32>,
    pub committed_at: u64,
    pub reveal_deadline: u64,
    /// True after `reveal_trace` succeeds; the record is kept for auditing.
    pub revealed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceCommitted {
    #[topic]
    pub commit_id: u64,
    #[topic]
    pub agent: Address,
    pub market_id: u64,
    pub commitment: BytesN<32>,
    pub reveal_deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceRevealed {
    #[topic]
    pub commit_id: u64,
    #[topic]
    pub trace_id: u64,
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevealDeadlineMissed {
    #[topic]
    pub commit_id: u64,
    #[topic]
    pub agent: Address,
    pub missed_total: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 3001,
    Unauthorized = 3002,
    AgentAlreadyRegistered = 3003,
    AgentNotRegistered = 3004,
    TraceNotFound = 3005,
    EmptyAction = 3006,
    EmptyCid = 3007,
    /// `expected_seq` / `prev_trace_hash` don't extend the agent's chain head (#52).
    ChainHeadMismatch = 3008,
    /// Agent already has a chain, so unchained `publish_trace` is refused (#52).
    ChainedAgentMustChain = 3009,
    /// Trace already backed an action (#50).
    TraceAlreadyConsumed = 3010,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 3011,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 3012,
    CannotReactivateRevoked = 3013,
    FlagHistoryFull = 3014,
    InvalidEffectiveTime = 3015,
    UnknownMarket = 3016,
    MarketRequired = 3017,
    ProposalMustUseNoMarket = 3018,
    UseCanonicalAction = 3019,
    BatchNotFound = 3020,
    InvalidBatch = 3021,
    InvalidProof = 3022,
    TooManyKeys = 3023,
    KeyAlreadyBound = 3024,
    InvalidKey = 3025,
    InvalidSignature = 3026,
    TraceNotSigned = 3027,
    AgentNotActive = 3028,
    ActionTooLong = 3029,
    CidTooLong = 3030,
    PageTooLarge = 3031,
    TraceFlagged = 3032,
    TraceTooOld = 3033,
    TraceDecisionMissing = 3034,
    TraceAgentMismatch = 3035,
    TraceMismatch = 3036,
    AlreadyRetired = 3037,
    NotRetired = 3038,
    SigningKeyNotFound = 3039,
    TooManySigningKeys = 3040,
    SigningKeyAlreadyBound = 3041,
    // ── #307 Per-agent consumer scoping ──────────────────────────────────
    /// `authorize_consumer` called after agent has reached MAX_AGENT_CONSUMERS.
    TooManyConsumers = 3042,
    /// `consume_trace` called by a consumer the publishing agent never granted.
    ConsumerNotAuthorized = 3043,
    /// `consume_trace` called by a consumer other than the one the trace is bound to.
    TraceBoundElsewhere = 3044,
    /// `set_default_consumer` or `bind_trace_consumer` called with a consumer the
    /// agent has not yet authorised.
    ConsumerGrantRequired = 3045,
    /// `bind_trace_consumer` called on a trace that already has a binding.
    TraceAlreadyBound = 3046,
    /// `grant_consumer_legacy` called after scoping has been enabled.
    ScopingAlreadyEnabled = 3047,
    /// #299: Key already revoked and `compromised_since` cannot move later.
    AlreadyRevoked = 3048,
    /// #329: an archivist call asked to extend more entries than one call allows.
    TooManyEntries = 3049,
    // ── #322 action/state validation ─────────────────────────────────────
    /// Buy/Sell on a market that is not open, or past `close_time + grace`.
    MarketClosed = 3050,
    /// Redeem/ClaimRemainder on a market that is still open.
    MarketNotFinal = 3051,
    /// CreateMarket by an agent that neither created the market nor acts
    /// through a registered consumer that did.
    NotMarketCreator = 3052,
    /// Resolve by an agent with no role in the market's resolution.
    NotResolutionSigner = 3053,
    /// Resolve (or CreateMarket after close) at the wrong time.
    MarketNotClosed = 3054,
    /// `Other(Symbol)` that is not on the admin allow-list.
    UnknownOtherAction = 3055,
    /// The `Other` allow-list is full, or a grace above the maximum.
    LimitExceeded = 3056,
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

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceChained {
    #[topic]
    pub agent: Address,
    #[topic]
    pub seq: u64,
    pub trace_id: u64,
    pub prev_trace_hash: BytesN<32>,
    pub trace_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConsumerRegistered {
    #[topic]
    pub consumer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConsumerUnregistered {
    #[topic]
    pub consumer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceConsumed {
    #[topic]
    pub trace_id: u64,
    pub consumer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRegistered {
    #[topic]
    pub agent: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TracePublished {
    #[topic]
    pub trace_id: u64,
    #[topic]
    pub market_id: u64,
    #[topic]
    pub agent: Address,
    pub action: TraceAction,
    pub trace_hash: BytesN<32>,
    pub ipfs_cid: String,
    pub published_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchPublished {
    #[topic]
    pub batch_id: u64,
    #[topic]
    pub agent: Address,
    pub root: BytesN<32>,
    pub leaf_count: u32,
    pub manifest_cid: String,
    pub published_at: u64,
}

#[contract]
pub struct ReasoningRegistry;

#[contractimpl]
impl ReasoningRegistry {
    pub fn __constructor(env: Env, admin: Address, market_core: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MarketCore, &market_core);
        env.storage().instance().set(&DataKey::NextId, &0u64);
        env.storage().instance().set(&DataKey::NextBatchId, &0u64);
    }

    // ----- admin ----------------------------------------------------------

    /// Starts a two-step handover of the admin role. The new admin must call
    /// `accept_admin` itself, so a typo cannot hand control to an address
    /// nobody holds.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
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
        ttl::bump_instance(&env);
        let pending = Self::load_pending(&env).ok_or(Error::NoPendingAdmin)?;
        if env.ledger().timestamp() > pending.expires_at {
            return Err(Error::PendingAdminExpired);
        }
        pending.address.require_auth();
        let old: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
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
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        if Self::load_pending(&env).is_none() {
            return Err(Error::NoPendingAdmin);
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        AdminTransferCancelled {}.publish(&env);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// The pending admin proposal, including its expiry, if one exists.
    pub fn pending_admin(env: Env) -> Option<PendingAdmin> {
        Self::load_pending(&env)
    }

    pub fn register_agent(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        if Self::load_agent(&env, &agent).is_some() {
            return Err(Error::AgentAlreadyRegistered);
        }
        let now = env.ledger().timestamp();
        let record = AgentRecord {
            status: AgentStatus::Active,
            registered_at: now,
        };
        let agent_key = DataKey::Agent(agent.clone());
        Self::put(&env, &agent_key, &record);
        // Registration is long-lived (issue #16), not the 60-day trace window
        // `put` bumps to, and is refreshed again on every `publish_trace`.
        ttl::bump_persistent(&env, &agent_key, ttl::long_lived_target(&env));
        AgentRegistered { agent }.publish(&env);
        Ok(())
    }

    pub fn retire_agent(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        Self::retire_agent_internal(&env, agent)
    }

    pub fn retire_self(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        Self::retire_agent_internal(&env, agent)
    }

    pub fn reactivate_agent(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        let mut record = Self::load_agent(&env, &agent).ok_or(Error::AgentNotRegistered)?;
        match record.status {
            AgentStatus::Retired(_) => {
                record.status = AgentStatus::Active;
                Self::put(&env, &DataKey::Agent(agent.clone()), &record);
                AgentReactivated { agent }.publish(&env);
                Ok(())
            }
            AgentStatus::Revoked(_, _) => Err(Error::CannotReactivateRevoked),
            AgentStatus::Active => Err(Error::AgentAlreadyRegistered),
        }
    }

    pub fn revoke_agent(
        env: Env,
        agent: Address,
        effective_from: u64,
        reason: Symbol,
    ) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        let mut record = Self::load_agent(&env, &agent).ok_or(Error::AgentNotRegistered)?;
        let now = env.ledger().timestamp();
        if effective_from < record.registered_at || effective_from > now {
            return Err(Error::InvalidEffectiveTime);
        }
        record.status = AgentStatus::Revoked(effective_from, reason.clone());
        Self::put(&env, &DataKey::Agent(agent.clone()), &record);
        AgentRevoked {
            agent,
            effective_from,
            reason,
        }
        .publish(&env);
        Ok(())
    }

    pub fn unregister_agent(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::retire_agent(env, agent)
    }

    /// Read-only view: no TTL writes, so an indexer's simulation stays cheap.
    /// The `Agent` entry is refreshed by `register_agent`/`publish_trace`.
    pub fn is_registered(env: Env, agent: Address) -> bool {
        Self::load_agent(&env, &agent).map_or(false, |r| matches!(r.status, AgentStatus::Active))
    }

    pub fn get_agent(env: Env, agent: Address) -> Option<AgentRecord> {
        Self::load_agent(&env, &agent)
    }

    pub fn publish_trace(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        // Refresh the registration TTL on every publish (#16): without this a
        // long-running agent's `Agent` entry archives and later publishes fail.
        ttl::bump_persistent(
            &env,
            &DataKey::Agent(agent.clone()),
            ttl::long_lived_target(&env),
        );
        // Once an agent keeps a chained log, unchained traces would sit outside
        // it unseen, so they're refused (#52).
        if Self::read_head(&env, &agent).seq > 0 {
            return Err(Error::ChainedAgentMustChain);
        }
        let (id, _) = Self::write_trace(&env, agent.clone(), market_id, action, trace_hash, ipfs_cid)?;
        Self::touch_head(&env, &agent);
        Ok(id)
    }

    /// Publishes a trace that extends `agent`'s hash chain (#52). Fails with
    /// `ChainHeadMismatch` unless `expected_seq == head.seq + 1` and
    /// `prev_trace_hash == head.head_hash`, so a skipped decision shows up as
    /// a gap and a fork is impossible.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_chained_trace(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
        expected_seq: u64,
        prev_trace_hash: BytesN<32>,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        ttl::bump_persistent(
            &env,
            &DataKey::Agent(agent.clone()),
            ttl::long_lived_target(&env),
        );
        let head = Self::read_head(&env, &agent);
        if expected_seq != head.seq + 1 || prev_trace_hash != head.head_hash {
            return Err(Error::ChainHeadMismatch);
        }

        let (id, target) = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash.clone(),
            ipfs_cid,
        )?;

        let link_key = DataKey::TraceLink(id);
        Self::put_class(
            &env,
            &link_key,
            &ChainLink {
                seq: expected_seq,
                prev_trace_hash: prev_trace_hash.clone(),
            },
            target,
        );
        Self::put_class(
            &env,
            &DataKey::AgentTrace(agent.clone(), expected_seq),
            &id,
            target,
        );
        Self::put(
            &env,
            &DataKey::AgentHead(agent.clone()),
            &ChainHead {
                seq: expected_seq,
                head_hash: trace_hash.clone(),
                head_trace_id: Some(id),
            },
        );

        TraceChained {
            agent,
            seq: expected_seq,
            trace_id: id,
            prev_trace_hash,
            trace_hash,
        }
        .publish(&env);
        Ok(id)
    }

    /// Current chain head for `agent` (genesis if it has never chained).
    pub fn agent_chain_head(env: Env, agent: Address) -> ChainHead {
        Self::read_head(&env, &agent)
    }

    /// Trace id at position `seq` (1-based) of `agent`'s chain.
    pub fn agent_chain_trace_at(env: Env, agent: Address, seq: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::AgentTrace(agent, seq))
            .ok_or(Error::TraceNotFound)
    }

    /// Chain link for a trace; `None` for legacy, unchained traces.
    pub fn get_trace_link(env: Env, trace_id: u64) -> Option<ChainLink> {
        env.storage()
            .persistent()
            .get(&DataKey::TraceLink(trace_id))
    }

    /// Ledger sequence the trace was written in (#50). `None` for traces
    /// written before this field existed.
    pub fn get_trace_ledger(env: Env, trace_id: u64) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::TraceLedger(trace_id))
    }

    /// Allow-lists a contract (e.g. the treasury) to call `consume_trace` (#50).
    pub fn register_consumer(env: Env, consumer: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        Self::put(&env, &DataKey::Consumer(consumer.clone()), &true);
        ConsumerRegistered { consumer }.publish(&env);
        Ok(())
    }

    pub fn unregister_consumer(env: Env, consumer: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .remove(&DataKey::Consumer(consumer.clone()));
        ConsumerUnregistered { consumer }.publish(&env);
        Ok(())
    }

    pub fn is_consumer(env: Env, consumer: Address) -> bool {
        env.storage().persistent().has(&DataKey::Consumer(consumer))
    }

    /// Sets the post-close grace window for Buy/Sell traces (issue #322),
    /// at most [`MAX_ACTION_GRACE_SECS`]. Admin only.
    pub fn set_action_grace(env: Env, secs: u64) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        if secs > MAX_ACTION_GRACE_SECS {
            return Err(Error::LimitExceeded);
        }
        env.storage().instance().set(&DataKey::ActionGrace, &secs);
        Ok(())
    }

    /// Current post-close grace window for Buy/Sell traces, in seconds.
    pub fn action_grace(env: Env) -> u64 {
        Self::grace(&env)
    }

    /// Whether a Buy/Sell trace was published after its market's close.
    pub fn is_trace_late(env: Env, trace_id: u64) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::TraceLate(trace_id))
    }

    /// Adds, changes (`Some`) or removes (`None`) an allow-listed
    /// `Other(sym)` action (issue #322). At most [`MAX_OTHER_ACTIONS`]
    /// symbols; canonical action names are refused. Admin only. Applies at
    /// publish time only, so existing traces are untouched.
    pub fn set_other_action(env: Env, sym: Symbol, rule: Option<OtherRule>) -> Result<(), Error> {
        ttl::bump_instance(&env);
        Self::require_admin(&env)?;
        Self::validate_action(&env, &TraceAction::Other(sym.clone()))?;
        let key = DataKey::AllowedOther(sym.clone());
        let mut list = Self::other_actions(env.clone());
        let pos = list.iter().position(|s| s == sym);
        match rule {
            Some(rule) => {
                if pos.is_none() {
                    if list.len() >= MAX_OTHER_ACTIONS {
                        return Err(Error::LimitExceeded);
                    }
                    list.push_back(sym);
                }
                Self::put(&env, &key, &rule);
            }
            None => {
                if let Some(i) = pos {
                    list.remove(i as u32);
                }
                env.storage().persistent().remove(&key);
            }
        }
        env.storage().instance().set(&DataKey::OtherActions, &list);
        Ok(())
    }

    /// The market rule of an allow-listed `Other(sym)` action.
    pub fn other_action_rule(env: Env, sym: Symbol) -> Option<OtherRule> {
        env.storage().persistent().get(&DataKey::AllowedOther(sym))
    }

    /// Every allow-listed `Other` symbol.
    pub fn other_actions(env: Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&DataKey::OtherActions)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Marks a trace as having backed an action, exactly once (#50). Only an
    /// allow-listed consumer contract can call it; the treasury passes its own
    /// address, which satisfies `require_auth` as the direct invoker.
    pub fn consume_trace(env: Env, consumer: Address, trace_id: u64) -> Result<Trace, Error> {
        consumer.require_auth();
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Consumer(consumer.clone()))
        {
            return Err(Error::Unauthorized);
        }
        let trace = Self::get_trace(env.clone(), trace_id)?;
        let key = DataKey::Consumed(trace_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::TraceAlreadyConsumed);
        }
        ttl::bump_instance(&env);
        let target = Self::market_target(&env, trace.market_id);
        Self::put_class(&env, &key, &true, target);
        TraceConsumed { trace_id, consumer }.publish(&env);
        Ok(trace)
    }

    pub fn is_consumed(env: Env, trace_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::Consumed(trace_id))
    }

    /// Checks a commit-reveal commitment (#51):
    /// `commitment == sha256("oracledesk.trace.commit.v1" || trace_hash || salt)`.
    pub fn verify_commitment(
        env: Env,
        trace_hash: BytesN<32>,
        salt: BytesN<32>,
        commitment: BytesN<32>,
    ) -> bool {
        Self::commitment_for(&env, &trace_hash, &salt) == commitment
    }

    /// Pure read (#329): views never extend TTL, so simulations have a
    /// read-only footprint. Retention comes from write-time targets and the
    /// archivist entrypoints (`extend_traces`).
    pub fn get_trace(env: Env, trace_id: u64) -> Result<Trace, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Trace(trace_id))
            .ok_or(Error::TraceNotFound)
    }

    pub fn flag_trace(env: Env, trace_id: u64, reason: Symbol) -> Result<(), Error> {
        Self::require_admin(&env)?;
        ttl::bump_instance(&env);
        let trace = Self::get_trace(env.clone(), trace_id)?;
        let target = Self::market_target(&env, trace.market_id);
        let count_key = DataKey::FlagHistoryCount(trace_id);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if count >= 16 {
            return Err(Error::FlagHistoryFull);
        }
        let now = env.ledger().timestamp();
        let flag = TraceFlag {
            reason: reason.clone(),
            flagged_at: now,
            active: true,
        };
        Self::put_class(&env, &DataKey::Flag(trace_id), &flag, target);
        Self::put_class(&env, &DataKey::FlagHistory(trace_id, count), &flag, target);
        Self::put_class(&env, &count_key, &(count + 1), target);
        TraceFlagged { trace_id, reason }.publish(&env);
        Ok(())
    }

    pub fn unflag_trace(env: Env, trace_id: u64, reason: Symbol) -> Result<(), Error> {
        Self::require_admin(&env)?;
        ttl::bump_instance(&env);
        let trace = Self::get_trace(env.clone(), trace_id)?;
        let target = Self::market_target(&env, trace.market_id);
        let count_key = DataKey::FlagHistoryCount(trace_id);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if count >= 16 {
            return Err(Error::FlagHistoryFull);
        }
        let now = env.ledger().timestamp();
        let flag = TraceFlag {
            reason: reason.clone(),
            flagged_at: now,
            active: false,
        };
        Self::put_class(&env, &DataKey::Flag(trace_id), &flag, target);
        Self::put_class(&env, &DataKey::FlagHistory(trace_id, count), &flag, target);
        Self::put_class(&env, &count_key, &(count + 1), target);
        TraceUnflagged { trace_id, reason }.publish(&env);
        Ok(())
    }

    pub fn trace_flags(
        env: Env,
        trace_id: u64,
        start: u32,
        limit: u32,
    ) -> Result<Vec<TraceFlag>, Error> {
        Self::get_trace(env.clone(), trace_id)?;
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::FlagHistoryCount(trace_id))
            .unwrap_or(0);
        let mut list = Vec::new(&env);
        let end = (start + limit).min(count);
        for i in start..end {
            if let Some(flag) = env
                .storage()
                .persistent()
                .get::<_, TraceFlag>(&DataKey::FlagHistory(trace_id, i))
            {
                list.push_back(flag);
            }
        }
        Ok(list)
    }

    pub fn get_trace_flag(env: Env, trace_id: u64) -> Option<TraceFlag> {
        env.storage().persistent().get(&DataKey::Flag(trace_id))
    }

    pub fn trace_verdict(
        env: Env,
        trace_id: u64,
        received_hash: BytesN<32>,
    ) -> Result<TraceVerdict, Error> {
        let trace = Self::get_trace(env.clone(), trace_id)?;
        if trace.trace_hash != received_hash {
            return Ok(TraceVerdict::HashMismatch);
        }
        if let Some(flag) = env
            .storage()
            .persistent()
            .get::<_, TraceFlag>(&DataKey::Flag(trace_id))
        {
            if flag.active {
                return Ok(TraceVerdict::Flagged(flag.reason));
            }
        }
        if let Some(record) = Self::load_agent(&env, &trace.agent) {
            if let AgentStatus::Revoked(effective_from, _) = record.status {
                if trace.published_at >= effective_from {
                    return Ok(TraceVerdict::AgentRevokedAfter(effective_from));
                }
            }
        }
        // #299: check per-key revocation. Precedence: AgentRevokedAfter >
        // KeyCompromised > Valid.
        if let Some((signing_key, _)) = env
            .storage()
            .persistent()
            .get::<_, (BytesN<32>, BytesN<64>)>(&DataKey::TraceSignature(trace_id))
        {
            if let Some(revocation) = env
                .storage()
                .persistent()
                .get::<_, KeyRevocation>(&DataKey::KeyRevocation(signing_key))
            {
                if trace.published_at >= revocation.compromised_since {
                    return Ok(TraceVerdict::KeyCompromised(revocation.compromised_since));
                }
            }
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::TraceLate(trace_id))
        {
            return Ok(TraceVerdict::Late);
        }
        Ok(TraceVerdict::Valid)
    }

    pub fn verify_trace(env: Env, trace_id: u64, received_hash: BytesN<32>) -> Result<bool, Error> {
        Ok(Self::trace_verdict(env, trace_id, received_hash)? == TraceVerdict::Valid)
    }

    /// Reads the instance's `NextId`. Pure read (#329): the instance is kept
    /// alive by mutating entrypoints (and `extend_traces`), not by views.
    pub fn trace_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// Number of traces published for `market_id`.
    pub fn market_trace_count(env: Env, market_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::MarketTraceCount(market_id))
            .unwrap_or(0)
    }

    /// The `index`-th (0-based, publish order) trace id for `market_id`.
    pub fn market_trace_at(env: Env, market_id: u64, index: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::MarketTrace(market_id, index))
            .ok_or(Error::TraceNotFound)
    }

    /// Number of traces published by `agent` (#57).
    pub fn agent_trace_count(env: Env, agent: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentTraceCount(agent))
            .unwrap_or(0)
    }

    /// The `index`-th (0-based, publish order) trace id for `agent` (#57).
    pub fn agent_trace_at(env: Env, agent: Address, index: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::AgentTraceAt(agent, index))
            .ok_or(Error::TraceNotFound)
    }

    /// Number of traces for the `(market_id, action)` pair (#57).
    pub fn market_action_trace_count(env: Env, market_id: u64, action: TraceAction) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::MarketActionTraceCount(market_id, action))
            .unwrap_or(0)
    }

    /// The `index`-th (0-based, publish order) trace id for
    /// `(market_id, action)` (#57).
    pub fn market_action_trace_at(
        env: Env,
        market_id: u64,
        action: TraceAction,
        index: u64,
    ) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::MarketActionTraceAt(market_id, action, index))
            .ok_or(Error::TraceNotFound)
    }

    /// A page of every trace for `market_id`, starting at `start` (#57).
    /// Replaces the `market_trace_count` + `market_trace_at` + `get_trace`
    /// loop (101 RPC simulations for 50 traces) with one simulation.
    pub fn traces_by_market(
        env: Env,
        market_id: u64,
        start: u64,
        limit: u32,
    ) -> Result<TracePage, Error> {
        let total = Self::market_trace_count(env.clone(), market_id);
        Self::trace_page(&env, total, start, limit, |index| {
            env.storage()
                .persistent()
                .get(&DataKey::MarketTrace(market_id, index))
                .ok_or(Error::TraceNotFound)
        })
    }

    /// A page of every trace `agent` published, in publish order (#57).
    pub fn traces_by_agent(
        env: Env,
        agent: Address,
        start: u64,
        limit: u32,
    ) -> Result<TracePage, Error> {
        let total = Self::agent_trace_count(env.clone(), agent.clone());
        Self::trace_page(&env, total, start, limit, |index| {
            env.storage()
                .persistent()
                .get(&DataKey::AgentTraceAt(agent.clone(), index))
                .ok_or(Error::TraceNotFound)
        })
    }

    /// A page of every trace for `(market_id, action)`, in publish order
    /// (#57) — e.g. every `Buy` decision on market 7.
    pub fn traces_by_market_action(
        env: Env,
        market_id: u64,
        action: TraceAction,
        start: u64,
        limit: u32,
    ) -> Result<TracePage, Error> {
        let total = Self::market_action_trace_count(env.clone(), market_id, action.clone());
        Self::trace_page(&env, total, start, limit, |index| {
            env.storage()
                .persistent()
                .get(&DataKey::MarketActionTraceAt(
                    market_id,
                    action.clone(),
                    index,
                ))
                .ok_or(Error::TraceNotFound)
        })
    }
    /// Anchors a Merkle batch of N traces off-chain, storing only the 32-byte root
    /// and manifest CID on-chain (#54).
    pub fn publish_trace_batch(
        env: Env,
        agent: Address,
        root: BytesN<32>,
        leaf_count: u32,
        manifest_cid: String,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        let record = Self::load_agent(&env, &agent).ok_or(Error::AgentNotRegistered)?;
        if !matches!(record.status, AgentStatus::Active) {
            return Err(Error::AgentNotActive);
        }
        if leaf_count == 0 || leaf_count > MAX_LEAVES || manifest_cid.is_empty() {
            return Err(Error::InvalidBatch);
        }

        let batch_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextBatchId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextBatchId, &(batch_id + 1));

        let batch = TraceBatch {
            agent: agent.clone(),
            root: root.clone(),
            leaf_count,
            manifest_cid: manifest_cid.clone(),
            published_at: env.ledger().timestamp(),
        };
        Self::put(&env, &DataKey::Batch(batch_id), &batch);

        let agent_count_key = DataKey::AgentBatchCount(agent.clone());
        let agent_idx: u64 = env.storage().persistent().get(&agent_count_key).unwrap_or(0);
        Self::put(&env, &DataKey::AgentBatch(agent.clone(), agent_idx), &batch_id);
        Self::put(&env, &agent_count_key, &(agent_idx + 1));

        BatchPublished {
            batch_id,
            agent,
            root,
            leaf_count,
            manifest_cid,
            published_at: batch.published_at,
        }
        .publish(&env);

        Ok(batch_id)
    }

    pub fn get_batch(env: Env, batch_id: u64) -> Result<TraceBatch, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Batch(batch_id))
            .ok_or(Error::BatchNotFound)
    }

    pub fn batch_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextBatchId).unwrap_or(0)
    }

    pub fn agent_batch_count(env: Env, agent: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentBatchCount(agent))
            .unwrap_or(0)
    }

    /// Shared body of the three paginated readers (#57): validates the page
    /// size, resolves up to `limit` trace ids through `id_at`, and loads each
    /// `Trace` into one return value. `total` is read once by the caller so a
    /// page can never straddle an inconsistent index length.
    fn trace_page(
        env: &Env,
        total: u64,
        start: u64,
        limit: u32,
        id_at: impl Fn(u64) -> Result<u64, Error>,
    ) -> Result<TracePage, Error> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(Error::PageTooLarge);
        }
        let mut entries = Vec::new(env);
        let end = core::cmp::min(start.saturating_add(limit as u64), total);
        let mut index = start;
        while index < end {
            let trace_id = id_at(index)?;
            let trace = Self::get_trace(env.clone(), trace_id)?;
            entries.push_back(TracePageEntry { trace_id, trace });
            index += 1;
        }
        Ok(TracePage {
            entries,
            next: end,
            total,
        })
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn load_pending(env: &Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn agent_batch_at(env: Env, agent: Address, index: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::AgentBatch(agent, index))
            .ok_or(Error::BatchNotFound)
    }

    pub fn verify_trace_inclusion(
        env: Env,
        batch_id: u64,
        trace_hash: BytesN<32>,
        index: u32,
        proof: Vec<BytesN<32>>,
    ) -> Result<bool, Error> {
        let batch = Self::get_batch(env.clone(), batch_id)?;
        if index >= batch.leaf_count {
            return Ok(false);
        }
        if proof.len() > MAX_PROOF_LEN {
            return Err(Error::InvalidProof);
        }
        match Self::compute_merkle_root(&env, batch.leaf_count, &trace_hash, index, &proof) {
            Ok(computed) => Ok(computed == batch.root),
            Err(Error::InvalidProof) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn compute_merkle_root(
        env: &Env,
        leaf_count: u32,
        trace_hash: &BytesN<32>,
        index: u32,
        proof: &Vec<BytesN<32>>,
    ) -> Result<BytesN<32>, Error> {
        let mut leaf_preimage = Bytes::new(env);
        leaf_preimage.push_back(MERKLE_LEAF_PREFIX);
        leaf_preimage.append(&trace_hash.clone().into());
        let mut current: BytesN<32> = env.crypto().sha256(&leaf_preimage).into();

        let mut curr_idx = index;
        let mut curr_len = leaf_count;
        let mut proof_idx: u32 = 0;

        while curr_len > 1 {
            if curr_len % 2 == 1 && curr_idx == curr_len - 1 {
                // Odd last node promoted unchanged: no sibling in proof
            } else {
                if proof_idx >= proof.len() {
                    return Err(Error::InvalidProof);
                }
                let sibling = proof.get(proof_idx).unwrap();
                proof_idx += 1;

                let mut node_preimage = Bytes::new(env);
                node_preimage.push_back(MERKLE_NODE_PREFIX);
                if curr_idx % 2 == 0 {
                    node_preimage.append(&current.clone().into());
                    node_preimage.append(&sibling.into());
                } else {
                    node_preimage.append(&sibling.into());
                    node_preimage.append(&current.clone().into());
                }
                current = env.crypto().sha256(&node_preimage).into();
            }
            curr_idx /= 2;
            curr_len = (curr_len + 1) / 2;
        }

        if proof_idx != proof.len() {
            return Err(Error::InvalidProof);
        }

        Ok(current)
    }

    pub fn add_signing_key(
        env: Env,
        agent: Address,
        public_key: BytesN<32>,
        proof_sig: BytesN<64>,
    ) -> Result<(), Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        Self::require_active_agent(&env, &agent)?;

        if public_key == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::InvalidKey);
        }

        let bind_msg = Self::key_bind_message(&env, &agent, &public_key);
        env.crypto().ed25519_verify(&public_key, &bind_msg, &proof_sig);

        let key_to_agent = DataKey::KeyToAgent(public_key.clone());
        if env.storage().persistent().has(&key_to_agent) {
            return Err(Error::KeyAlreadyBound);
        }

        let agent_keys_key = DataKey::AgentSigningKeys(agent.clone());
        let mut keys: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&agent_keys_key)
            .unwrap_or_else(|| Vec::new(&env));
        if keys.len() >= MAX_AGENT_SIGNING_KEYS {
            return Err(Error::TooManyKeys);
        }

        keys.push_back(public_key.clone());
        Self::put(&env, &agent_keys_key, &keys);
        Self::put(&env, &key_to_agent, &agent);

        let history_count_key = DataKey::SigningKeyHistoryCount(agent.clone());
        let count: u32 = env
            .storage()
            .persistent()
            .get(&history_count_key)
            .unwrap_or(0);
        let record = SigningKeyRecord {
            public_key: public_key.clone(),
            added_at: env.ledger().timestamp(),
            retired_at: None,
        };
        Self::put(&env, &DataKey::SigningKeyHistory(agent.clone(), count), &record);
        Self::put(&env, &history_count_key, &(count + 1));

        AgentSigningKeyAdded {
            agent,
            public_key,
        }
        .publish(&env);

        Ok(())
    }

    pub fn retire_signing_key(
        env: Env,
        agent: Address,
        public_key: BytesN<32>,
    ) -> Result<(), Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        Self::require_active_agent(&env, &agent)?;

        let agent_keys_key = DataKey::AgentSigningKeys(agent.clone());
        let mut keys: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&agent_keys_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut found_index: Option<u32> = None;
        for i in 0..keys.len() {
            if keys.get(i).unwrap() == public_key {
                found_index = Some(i);
                break;
            }
        }

        let Some(idx) = found_index else {
            return Err(Error::InvalidKey);
        };

        keys.remove(idx);
        Self::put(&env, &agent_keys_key, &keys);

        let history_count_key = DataKey::SigningKeyHistoryCount(agent.clone());
        let count: u32 = env
            .storage()
            .persistent()
            .get(&history_count_key)
            .unwrap_or(0);
        for i in 0..count {
            let hist_key = DataKey::SigningKeyHistory(agent.clone(), i);
            if let Some(mut record) = env.storage().persistent().get::<_, SigningKeyRecord>(&hist_key) {
                if record.public_key == public_key && record.retired_at.is_none() {
                    record.retired_at = Some(env.ledger().timestamp());
                    Self::put(&env, &hist_key, &record);
                    break;
                }
            }
        }

        AgentSigningKeyRetired {
            agent,
            public_key,
        }
        .publish(&env);

        Ok(())
    }

    /// Pure read (#329): views never extend TTL.
    pub fn get_signing_keys(env: Env, agent: Address) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get::<_, Vec<BytesN<32>>>(&DataKey::AgentSigningKeys(agent))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_key_agent(env: Env, public_key: BytesN<32>) -> Option<Address> {
        env.storage()
            .persistent()
            .get::<_, Address>(&DataKey::KeyToAgent(public_key))
    }

    pub fn signing_key_history_count(env: Env, agent: Address) -> u32 {
        env.storage()
            .persistent()
            .get::<_, u32>(&DataKey::SigningKeyHistoryCount(agent))
            .unwrap_or(0)
    }

    pub fn signing_key_history(
        env: Env,
        agent: Address,
        start: u32,
        limit: u32,
    ) -> Result<Vec<SigningKeyRecord>, Error> {
        let total = Self::signing_key_history_count(env.clone(), agent.clone());
        let mut out = Vec::new(&env);
        if start >= total || limit == 0 {
            return Ok(out);
        }
        let end = core::cmp::min(start + limit, total);
        for i in start..end {
            let key = DataKey::SigningKeyHistory(agent.clone(), i);
            if let Some(record) = env.storage().persistent().get::<_, SigningKeyRecord>(&key) {
                out.push_back(record);
            }
        }
        Ok(out)
    }

    pub fn publish_trace_signed(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
        signing_key: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        if Self::read_head(&env, &agent).seq > 0 {
            return Err(Error::ChainedAgentMustChain);
        }

        let keys: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AgentSigningKeys(agent.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let mut is_active = false;
        for k in keys.iter() {
            if k == signing_key {
                is_active = true;
                break;
            }
        }
        if !is_active {
            return Err(Error::InvalidKey);
        }

        let msg = Self::trace_attestation_message(
            &env,
            &agent,
            market_id,
            &action,
            &trace_hash,
        );
        env.crypto().ed25519_verify(&signing_key, &msg, &signature);

        let (id, target) = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash,
            ipfs_cid,
        )?;

        let sig_key = DataKey::TraceSignature(id);
        Self::put_class(&env, &sig_key, &(signing_key.clone(), signature), target);

        // #299: index this trace under the signing key for paged revocation views.
        let count_key = DataKey::KeyTraceCount(signing_key.clone());
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        Self::put_class(
            &env,
            &DataKey::KeyTraceAt(signing_key.clone(), count),
            &id,
            target,
        );
        Self::put_class(&env, &count_key, &(count + 1), target);

        TraceSigned {
            trace_id: id,
            agent,
            signing_key,
        }
        .publish(&env);

        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn publish_chained_trace_signed(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
        expected_seq: u64,
        prev_trace_hash: BytesN<32>,
        signing_key: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        let head = Self::read_head(&env, &agent);
        if expected_seq != head.seq + 1 || prev_trace_hash != head.head_hash {
            return Err(Error::ChainHeadMismatch);
        }

        let keys: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AgentSigningKeys(agent.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let mut is_active = false;
        for k in keys.iter() {
            if k == signing_key {
                is_active = true;
                break;
            }
        }
        if !is_active {
            return Err(Error::InvalidKey);
        }

        let msg = Self::trace_attestation_message(
            &env,
            &agent,
            market_id,
            &action,
            &trace_hash,
        );
        env.crypto().ed25519_verify(&signing_key, &msg, &signature);

        let (id, target) = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash.clone(),
            ipfs_cid,
        )?;

        let link_key = DataKey::TraceLink(id);
        Self::put_class(
            &env,
            &link_key,
            &ChainLink {
                seq: expected_seq,
                prev_trace_hash: prev_trace_hash.clone(),
            },
            target,
        );
        Self::put_class(
            &env,
            &DataKey::AgentTrace(agent.clone(), expected_seq),
            &id,
            target,
        );
        Self::put(
            &env,
            &DataKey::AgentHead(agent.clone()),
            &ChainHead {
                seq: expected_seq,
                head_hash: trace_hash.clone(),
                head_trace_id: Some(id),
            },
        );

        let sig_key = DataKey::TraceSignature(id);
        Self::put_class(&env, &sig_key, &(signing_key.clone(), signature), target);

        // #299: index this trace under the signing key for paged revocation views.
        let count_key = DataKey::KeyTraceCount(signing_key.clone());
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        Self::put_class(
            &env,
            &DataKey::KeyTraceAt(signing_key.clone(), count),
            &id,
            target,
        );
        Self::put_class(&env, &count_key, &(count + 1), target);

        TraceChained {
            agent: agent.clone(),
            seq: expected_seq,
            trace_id: id,
            prev_trace_hash,
            trace_hash,
        }
        .publish(&env);

        TraceSigned {
            trace_id: id,
            agent,
            signing_key,
        }
        .publish(&env);

        Ok(id)
    }

    pub fn get_trace_signature(env: Env, trace_id: u64) -> Option<(BytesN<32>, BytesN<64>)> {
        env.storage()
            .persistent()
            .get::<_, (BytesN<32>, BytesN<64>)>(&DataKey::TraceSignature(trace_id))
    }

    pub fn verify_trace_signature(env: Env, trace_id: u64) -> Result<bool, Error> {
        let trace = Self::load_trace(&env, trace_id)?;
        let key = DataKey::TraceSignature(trace_id);
        let Some((signing_key, signature)) = env
            .storage()
            .persistent()
            .get::<_, (BytesN<32>, BytesN<64>)>(&key)
        else {
            return Err(Error::TraceNotSigned);
        };

        let bound_agent = Self::get_key_agent(env.clone(), signing_key.clone());
        if bound_agent.as_ref() != Some(&trace.agent) {
            return Ok(false);
        }

        // #299: if the key has been retroactively revoked and this trace was
        // published at or after the compromise time, the signature is no
        // longer considered valid.
        if let Some(revocation) = env
            .storage()
            .persistent()
            .get::<_, KeyRevocation>(&DataKey::KeyRevocation(signing_key.clone()))
        {
            if trace.published_at >= revocation.compromised_since {
                return Ok(false);
            }
        }

        let msg = Self::trace_attestation_message(
            &env,
            &trace.agent,
            trace.market_id,
            &trace.action,
            &trace.trace_hash,
        );
        env.crypto().ed25519_verify(&signing_key, &msg, &signature);
        Ok(true)
    }

    // ── #299: Retroactive signing-key revocation ────────────────────────────

    /// Revokes a signing key retroactively. Verdicts for traces the key signed
    /// at or after `compromised_since` flip to `KeyCompromised`. Callable by
    /// the agent or the registry admin, including for retired or revoked
    /// agents. Revocation is permanent; `compromised_since` can only move
    /// earlier on a subsequent call.
    pub fn revoke_signing_key(
        env: Env,
        caller: Address,
        agent: Address,
        public_key: BytesN<32>,
        compromised_since: u64,
        reason: Symbol,
    ) -> Result<(), Error> {
        ttl::bump_instance(&env);
        caller.require_auth();

        // Caller must be the agent or the admin.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        let by_admin = caller == admin;
        if !by_admin && caller != agent {
            return Err(Error::Unauthorized);
        }

        // KeyToAgent must point to this agent.
        let key_to_agent_key = DataKey::KeyToAgent(public_key.clone());
        let bound_agent: Address = env
            .storage()
            .persistent()
            .get(&key_to_agent_key)
            .ok_or(Error::InvalidKey)?;
        if bound_agent != agent {
            return Err(Error::InvalidKey);
        }
        Self::bump_persistent(&env, &key_to_agent_key);

        // Find the key's SigningKeyRecord to validate compromised_since.
        let history_count_key = DataKey::SigningKeyHistoryCount(agent.clone());
        let count: u32 = env.storage().persistent().get(&history_count_key).unwrap_or(0);
        let mut found_record: Option<SigningKeyRecord> = None;
        for i in 0..count {
            let hist_key = DataKey::SigningKeyHistory(agent.clone(), i);
            if let Some(record) = env.storage().persistent().get::<_, SigningKeyRecord>(&hist_key) {
                if record.public_key == public_key {
                    found_record = Some(record);
                    break;
                }
            }
        }
        let record = found_record.ok_or(Error::SigningKeyNotFound)?;

        let now = env.ledger().timestamp();
        // compromised_since must be between added_at and now.
        if compromised_since < record.added_at || compromised_since > now {
            return Err(Error::InvalidEffectiveTime);
        }

        // If a revocation already exists, only allow widening (earlier since).
        let rev_key = DataKey::KeyRevocation(public_key.clone());
        if let Some(existing) = env.storage().persistent().get::<_, KeyRevocation>(&rev_key) {
            if compromised_since >= existing.compromised_since {
                return Err(Error::AlreadyRevoked);
            }
        }

        // Remove the key from the active list if still present.
        let agent_keys_key = DataKey::AgentSigningKeys(agent.clone());
        let mut keys: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&agent_keys_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut removed = false;
        for i in 0..keys.len() {
            if keys.get(i).unwrap() == public_key {
                keys.remove(i);
                removed = true;
                break;
            }
        }
        if removed {
            Self::put(&env, &agent_keys_key, &keys);
        }

        // Set retired_at if not already set.
        if record.retired_at.is_none() {
            for i in 0..count {
                let hist_key = DataKey::SigningKeyHistory(agent.clone(), i);
                if let Some(mut rec) = env.storage().persistent().get::<_, SigningKeyRecord>(&hist_key) {
                    if rec.public_key == public_key && rec.retired_at.is_none() {
                        rec.retired_at = Some(now);
                        Self::put(&env, &hist_key, &rec);
                        break;
                    }
                }
            }
        }

        // Write the revocation record.
        let revocation = KeyRevocation {
            agent: agent.clone(),
            compromised_since,
            revoked_at: now,
            reason: reason.clone(),
            by_admin,
        };
        Self::put(&env, &rev_key, &revocation);

        SigningKeyRevoked {
            agent,
            public_key,
            compromised_since,
            reason,
            by_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// #299: Returns the signature-level verdict for a trace, independent of
    /// hash/flag/agent checks. Uses a constant number of reads.
    pub fn signature_verdict(env: Env, trace_id: u64) -> Result<SignatureVerdict, Error> {
        let trace = Self::load_trace(&env, trace_id)?;
        let key = DataKey::TraceSignature(trace_id);
        let Some((signing_key, signature)) = env
            .storage()
            .persistent()
            .get::<_, (BytesN<32>, BytesN<64>)>(&key)
        else {
            return Ok(SignatureVerdict::NotSigned);
        };

        let bound_agent = Self::get_key_agent(env.clone(), signing_key.clone());
        if bound_agent.as_ref() != Some(&trace.agent) {
            return Ok(SignatureVerdict::WrongAgent);
        }

        // Check key revocation.
        if let Some(revocation) = env
            .storage()
            .persistent()
            .get::<_, KeyRevocation>(&DataKey::KeyRevocation(signing_key.clone()))
        {
            if trace.published_at >= revocation.compromised_since {
                return Ok(SignatureVerdict::KeyCompromised(revocation.compromised_since));
            }
        }

        // Fall through to actual crypto verification.
        let msg = Self::trace_attestation_message(
            &env,
            &trace.agent,
            trace.market_id,
            &trace.action,
            &trace.trace_hash,
        );
        env.crypto().ed25519_verify(&signing_key, &msg, &signature);
        Ok(SignatureVerdict::Valid)
    }

    /// #299: Number of traces a key has signed (length of the per-key index).
    pub fn key_trace_count(env: Env, public_key: BytesN<32>) -> u64 {
        let key = DataKey::KeyTraceCount(public_key);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// #299: Paged list of trace ids a key has signed.
    pub fn key_traces(
        env: Env,
        public_key: BytesN<32>,
        start: u64,
        limit: u32,
    ) -> Result<Vec<u64>, Error> {
        if limit > MAX_PAGE_SIZE {
            return Err(Error::PageTooLarge);
        }
        let total = Self::key_trace_count(env.clone(), public_key.clone());
        if start >= total {
            return Ok(Vec::new(&env));
        }
        let end = core::cmp::min(start + limit as u64, total);
        let mut out = Vec::new(&env);
        for i in start..end {
            let key = DataKey::KeyTraceAt(public_key.clone(), i);
            if let Some(trace_id) = env.storage().persistent().get::<_, u64>(&key) {
                out.push_back(trace_id);
            }
        }
        Ok(out)
    }

    /// #299: Binary search for the first trace index whose `published_at >=
    /// compromised_since`. Returns the index, or `total` if none qualify.
    pub fn key_affected_from(
        env: Env,
        public_key: BytesN<32>,
        compromised_since: u64,
    ) -> Result<u64, Error> {
        let total = Self::key_trace_count(env.clone(), public_key.clone());
        if total == 0 {
            return Ok(0);
        }
        // Binary search: find the first index where trace.published_at >= compromised_since.
        let mut lo: u64 = 0;
        let mut hi: u64 = total;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let key = DataKey::KeyTraceAt(public_key.clone(), mid);
            let trace_id: u64 = env
                .storage()
                .persistent()
                .get(&key)
                .ok_or(Error::TraceNotFound)?;
            let trace = Self::get_trace(env.clone(), trace_id)?;
            if trace.published_at < compromised_since {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        Ok(lo)
    }

    /// #299: Paged list of affected trace ids starting from the first
    /// trace published at or after `compromised_since`.
    pub fn affected_traces(
        env: Env,
        public_key: BytesN<32>,
        compromised_since: u64,
        page_start: u64,
        limit: u32,
    ) -> Result<Vec<u64>, Error> {
        if limit > MAX_PAGE_SIZE {
            return Err(Error::PageTooLarge);
        }
        let affected_from = Self::key_affected_from(env.clone(), public_key.clone(), compromised_since)?;
        let actual_start = affected_from + page_start;
        Self::key_traces(env, public_key, actual_start, limit)
    }

    // ── #329 Archivist entrypoints ───────────────────────────────────────────
    //
    // Permissionless: anyone may pay rent to keep audit data alive. Each is
    // bounded per call and skips missing keys (`extend_ttl` on a missing key
    // panics). They extend only, never shorten, and write no values.

    /// Extends every key of each trace (the trace plus its side keys) to its
    /// retention target. At most `retention::MAX_EXTEND_TRACES` ids; unknown
    /// ids are skipped. Returns the number of entries extended. Also bumps
    /// the instance, so archivist traffic alone keeps the contract live.
    pub fn extend_traces(env: Env, ids: Vec<u64>) -> Result<u32, Error> {
        if ids.len() > retention::MAX_EXTEND_TRACES {
            return Err(Error::TooManyEntries);
        }
        ttl::bump_instance(&env);
        let mut n = 0u32;
        for id in ids.iter() {
            n += Self::extend_trace_keys(&env, id);
        }
        Ok(n)
    }

    /// Extends index entries `[from, to)` (clamped to the index length) and
    /// the index's count to at least the target of each referenced trace.
    /// At most `retention::MAX_EXTEND_INDEX` entries per call.
    pub fn extend_index(env: Env, key: IndexKey, from: u64, to: u64) -> Result<u32, Error> {
        if to < from || to - from > retention::MAX_EXTEND_INDEX {
            return Err(Error::TooManyEntries);
        }
        ttl::bump_instance(&env);
        let count_key = match &key {
            IndexKey::Market(m) => DataKey::MarketTraceCount(*m),
            IndexKey::Agent(a) => DataKey::AgentTraceCount(a.clone()),
            IndexKey::MarketAction(m, a) => DataKey::MarketActionTraceCount(*m, a.clone()),
        };
        let total: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let end = core::cmp::min(to, total);
        let mut n = 0u32;
        let mut max_target = 0u32;
        let mut i = from;
        while i < end {
            let entry = match &key {
                IndexKey::Market(m) => DataKey::MarketTrace(*m, i),
                IndexKey::Agent(a) => DataKey::AgentTraceAt(a.clone(), i),
                IndexKey::MarketAction(m, a) => DataKey::MarketActionTraceAt(*m, a.clone(), i),
            };
            if let Some(trace_id) = env.storage().persistent().get::<_, u64>(&entry) {
                let target = match env
                    .storage()
                    .persistent()
                    .get::<_, Trace>(&DataKey::Trace(trace_id))
                {
                    Some(t) => Self::market_target(&env, t.market_id),
                    // The trace itself archived or never existed: keep the
                    // index entry for the long-lived horizon so the gap stays
                    // visible to readers.
                    None => retention::long_lived_target(&env),
                };
                max_target = core::cmp::max(max_target, target);
                if retention::extend_if_present(&env, &entry, target) {
                    n += 1;
                }
            }
            i += 1;
        }
        if max_target > 0 && retention::extend_if_present(&env, &count_key, max_target) {
            n += 1;
        }
        Ok(n)
    }

    /// Extends an agent's `Identity` entries (registration, chain head,
    /// signing keys and up to `retention::MAX_EXTEND_KEY_HISTORY` history
    /// records) to the long-lived target. A no-op for unknown agents.
    pub fn extend_agent(env: Env, agent: Address) -> Result<(), Error> {
        ttl::bump_instance(&env);
        let target = retention::long_lived_target(&env);
        retention::extend_if_present(&env, &DataKey::Agent(agent.clone()), target);
        retention::extend_if_present(&env, &DataKey::AgentHead(agent.clone()), target);
        let keys_key = DataKey::AgentSigningKeys(agent.clone());
        if let Some(keys) = env.storage().persistent().get::<_, Vec<BytesN<32>>>(&keys_key) {
            retention::extend_if_present(&env, &keys_key, target);
            for k in keys.iter() {
                retention::extend_if_present(&env, &DataKey::KeyToAgent(k), target);
            }
        }
        let hist_key = DataKey::SigningKeyHistoryCount(agent.clone());
        let hist: u32 = env.storage().persistent().get(&hist_key).unwrap_or(0);
        if hist > 0 {
            retention::extend_if_present(&env, &hist_key, target);
            for i in 0..core::cmp::min(hist, retention::MAX_EXTEND_KEY_HISTORY) {
                retention::extend_if_present(
                    &env,
                    &DataKey::SigningKeyHistory(agent.clone(), i),
                    target,
                );
            }
        }
        Ok(())
    }
}

impl ReasoningRegistry {
    pub fn key_bind_message(
        env: &Env,
        agent: &Address,
        public_key: &BytesN<32>,
    ) -> Bytes {
        let mut message = Bytes::from_slice(env, AGENT_KEY_BIND_DOMAIN);
        message.append(&env.ledger().network_id().into());
        message.append(&env.current_contract_address().to_xdr(env));
        message.append(&agent.to_xdr(env));
        message.append(&public_key.clone().into());
        message
    }

    pub fn trace_attestation_message(
        env: &Env,
        agent: &Address,
        market_id: u64,
        action: &TraceAction,
        trace_hash: &BytesN<32>,
    ) -> Bytes {
        let mut message = Bytes::from_slice(env, TRACE_SIG_DOMAIN);
        message.append(&env.ledger().network_id().into());
        message.append(&env.current_contract_address().to_xdr(env));
        message.append(&agent.to_xdr(env));
        message.extend_from_array(&market_id.to_be_bytes());
        message.push_back(match action {
            TraceAction::CreateMarket => 0,
            TraceAction::ProposeMarket => 1,
            TraceAction::Buy => 2,
            TraceAction::Sell => 3,
            TraceAction::Skip => 4,
            TraceAction::Redeem => 5,
            TraceAction::ClaimRemainder => 6,
            TraceAction::Resolve => 7,
            TraceAction::Other(_) => 8,
        });
        if let TraceAction::Other(sym) = action {
            message.append(&sym.to_xdr(env));
        }
        message.append(&trace_hash.clone().into());
        message
    }

    fn retire_agent_internal(env: &Env, agent: Address) -> Result<(), Error> {
        let mut record = Self::load_agent(env, &agent).ok_or(Error::AgentNotRegistered)?;
        if matches!(record.status, AgentStatus::Revoked(_, _)) {
            return Err(Error::CannotReactivateRevoked);
        }
        let now = env.ledger().timestamp();
        record.status = AgentStatus::Retired(now);
        Self::put(env, &DataKey::Agent(agent.clone()), &record);
        AgentRetired { agent, at: now }.publish(env);
        Ok(())
    }

    /// Pure read (#329), including the legacy `bool` registration fallback.
    /// Write paths refresh the entry with `retention::touch_identity`.
    fn load_agent(env: &Env, addr: &Address) -> Option<AgentRecord> {
        let key = DataKey::Agent(addr.clone());
        if let Some(record) = env.storage().persistent().get::<_, AgentRecord>(&key) {
            Some(record)
        } else if let Some(is_reg) = env.storage().persistent().get::<_, bool>(&key) {
            if is_reg {
                Some(AgentRecord {
                    status: AgentStatus::Active,
                    registered_at: 0,
                })
            } else {
                None
            }
        } else {
            None
        }
    }

    fn validate_action(env: &Env, action: &TraceAction) -> Result<(), Error> {
        if let TraceAction::Other(sym) = action {
            let s = sym.clone();
            if s == Symbol::new(env, "create_market")
                || s == Symbol::new(env, "propose_market")
                || s == Symbol::new(env, "buy")
                || s == Symbol::new(env, "sell")
                || s == Symbol::new(env, "skip")
                || s == Symbol::new(env, "redeem")
                || s == Symbol::new(env, "claim_remainder")
                || s == Symbol::new(env, "resolve")
            {
                return Err(Error::UseCanonicalAction);
            }
        }
        Ok(())
    }

    /// Checks `action` against the live state of the referenced market
    /// (issue #322). `now` is the ledger time and `G` the grace window:
    ///
    /// | Action | Requirement |
    /// | --- | --- |
    /// | `ProposeMarket` | `NO_MARKET` |
    /// | `CreateMarket` | creator is the agent or a registered consumer, `now <= close_time` |
    /// | `Buy`/`Sell` | `status == Open` and `now < close_time + G` |
    /// | `Skip` | market exists |
    /// | `Redeem`/`ClaimRemainder` | `status != Open` |
    /// | `Resolve` | `now >= close_time` and a resolution role for the agent or one of its keys |
    /// | `Other(sym)` | allow-listed; its `OtherRule` decides `NO_MARKET` |
    fn validate_action_state(
        env: &Env,
        agent: &Address,
        market_id: u64,
        action: &TraceAction,
    ) -> Result<(), Error> {
        let other_rule = match action {
            TraceAction::Other(sym) => Some(
                env.storage()
                    .persistent()
                    .get::<_, OtherRule>(&DataKey::AllowedOther(sym.clone()))
                    .ok_or(Error::UnknownOtherAction)?,
            ),
            _ => None,
        };
        let pre_creation = matches!(action, TraceAction::ProposeMarket);
        if market_id == NO_MARKET {
            return match other_rule {
                Some(OtherRule::MarketOnly) => Err(Error::MarketRequired),
                Some(_) => Ok(()),
                None if pre_creation => Ok(()),
                None => Err(Error::MarketRequired),
            };
        }
        if pre_creation || other_rule == Some(OtherRule::NoMarketOnly) {
            return Err(Error::ProposalMustUseNoMarket);
        }
        let core = CoreView::new(env, &Self::market_core_address(env)?);
        if market_id >= core.market_count() {
            return Err(Error::UnknownMarket);
        }
        let market = match core.try_get_market(&market_id) {
            Ok(Ok(m)) => m,
            _ => return Err(Error::UnknownMarket),
        };
        let now = env.ledger().timestamp();
        let open = market.status == oracledesk_types::MarketStatus::Open;
        match action {
            TraceAction::CreateMarket => {
                if market.creator != *agent && !Self::is_consumer(env.clone(), market.creator) {
                    return Err(Error::NotMarketCreator);
                }
                if now > market.close_time {
                    return Err(Error::MarketClosed);
                }
            }
            TraceAction::Buy | TraceAction::Sell => {
                // Status first: an early `void_market` has no close-time guard.
                let deadline = market.close_time.saturating_add(Self::grace(env));
                if !open || now >= deadline {
                    return Err(Error::MarketClosed);
                }
            }
            TraceAction::Redeem | TraceAction::ClaimRemainder => {
                if open {
                    return Err(Error::MarketNotFinal);
                }
            }
            TraceAction::Resolve => {
                if now < market.close_time {
                    return Err(Error::MarketNotClosed);
                }
                let keys = Self::get_signing_keys(env.clone(), agent.clone());
                let resolver = ResolverView::new(env, &Self::resolver_for(env, &core));
                match resolver.try_resolution_role(&market_id, agent, &keys) {
                    Ok(Ok(role)) if role != ResolutionRole::None => {}
                    _ => return Err(Error::NotResolutionSigner),
                }
            }
            TraceAction::Skip | TraceAction::ProposeMarket | TraceAction::Other(_) => {}
        }
        Ok(())
    }

    fn market_core_address(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::MarketCore)
            .ok_or(Error::NotInitialized)
    }

    /// The resolver whose signer sets decide `Resolve` traces: market-core's
    /// currently wired resolver, so a resolver rotation needs no registry
    /// wiring. The single place to switch to a per-market resolver snapshot
    /// once market-core records one.
    fn resolver_for(_env: &Env, core: &CoreView) -> Address {
        core.get_config().resolver
    }

    fn grace(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ActionGrace)
            .unwrap_or(DEFAULT_ACTION_GRACE_SECS)
    }

    /// Records `TraceLate` for a Buy/Sell trace published after close.
    fn mark_late(env: &Env, id: u64, market_id: u64, action: &TraceAction, target: u32) {
        if market_id == NO_MARKET || !matches!(action, TraceAction::Buy | TraceAction::Sell) {
            return;
        }
        if env.ledger().timestamp() >= Self::market_close(env, market_id) {
            Self::put_class(env, &DataKey::TraceLate(id), &true, target);
        }
    }

    fn check_publish(
        env: &Env,
        agent: &Address,
        market_id: u64,
        action: &TraceAction,
        ipfs_cid: &String,
    ) -> Result<(), Error> {
        agent.require_auth();
        let record = Self::load_agent(env, agent).ok_or(Error::AgentNotRegistered)?;
        if !matches!(record.status, AgentStatus::Active) {
            return Err(Error::AgentNotActive);
        }
        Self::validate_action(env, action)?;
        Self::validate_action_state(env, agent, market_id, action)?;
        if ipfs_cid.is_empty() {
            return Err(Error::EmptyCid);
        }
        Ok(())
    }

    /// Shared body of every publish path: allocates the id, stores the trace,
    /// its ledger and the per-market index, and emits `TracePublished`.
    fn write_trace(
        env: &Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        trace_hash: BytesN<32>,
        ipfs_cid: String,
    ) -> Result<(u64, u32), Error> {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        // #329: every key written here takes the trace's audit target; the
        // three indexes (and their counts) are extended to at least that
        // target, so an index never archives before its newest trace.
        let target = Self::market_target(env, market_id);

        let trace = Trace {
            market_id,
            agent: agent.clone(),
            action: action.clone(),
            trace_hash: trace_hash.clone(),
            ipfs_cid: ipfs_cid.clone(),
            published_at: env.ledger().timestamp(),
        };
        Self::put_class(env, &DataKey::Trace(id), &trace, target);
        Self::put_class(env, &DataKey::TraceLedger(id), &env.ledger().sequence(), target);

        let count_key = DataKey::MarketTraceCount(market_id);
        let index: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        Self::put_class(env, &DataKey::MarketTrace(market_id, index), &id, target);
        Self::put_class(env, &count_key, &(index + 1), target);

        let agent_count_key = DataKey::AgentTraceCount(agent.clone());
        let agent_index: u64 = env.storage().persistent().get(&agent_count_key).unwrap_or(0);
        Self::put_class(env, &DataKey::AgentTraceAt(agent.clone(), agent_index), &id, target);
        Self::put_class(env, &agent_count_key, &(agent_index + 1), target);

        let action_count_key =
            DataKey::MarketActionTraceCount(market_id, action.clone());
        let action_index: u64 = env
            .storage()
            .persistent()
            .get(&action_count_key)
            .unwrap_or(0);
        Self::put_class(
            env,
            &DataKey::MarketActionTraceAt(market_id, action.clone(), action_index),
            &id,
            target,
        );
        Self::put_class(env, &action_count_key, &(action_index + 1), target);
        Self::mark_late(env, id, market_id, &action, target);

        TracePublished {
            trace_id: id,
            market_id,
            agent,
            action,
            trace_hash,
            ipfs_cid,
            published_at: trace.published_at,
        }
        .publish(env);
        Ok((id, target))
    }

    /// Reads an agent's chain head without touching TTL (#329). Never reset
    /// by unregister/re-register, so history can't be rewritten (#52).
    fn read_head(env: &Env, agent: &Address) -> ChainHead {
        match env
            .storage()
            .persistent()
            .get::<_, ChainHead>(&DataKey::AgentHead(agent.clone()))
        {
            Some(head) => head,
            None => ChainHead {
                seq: 0,
                head_hash: BytesN::from_array(env, &[0u8; 32]),
                head_trace_id: None,
            },
        }
    }

    /// Keeps the agent's chain head alive; called only from publish paths.
    fn touch_head(env: &Env, agent: &Address) {
        retention::touch_identity(env, &DataKey::AgentHead(agent.clone()));
    }

    /// Writes a long-lived entry: `Identity`, `Batch`, and the batch/commit
    /// indexes (whose referenced records are themselves long-lived).
    fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
        retention::put(env, key, value, retention::long_lived_target(env));
    }

    /// Writes an entry with an explicit retention target (#329): `Audit`
    /// and `Index` entries take the target of the trace they belong to.
    fn put_class<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
        value: &V,
        target: u32,
    ) {
        retention::put(env, key, value, target);
    }

    fn commitment_for(env: &Env, trace_hash: &BytesN<32>, salt: &BytesN<32>) -> BytesN<32> {
        let mut bytes = Bytes::from_slice(env, COMMIT_DOMAIN_TAG);
        bytes.append(&trace_hash.clone().into());
        bytes.append(&salt.clone().into());
        env.crypto().sha256(&bytes).into()
    }

    // ── #316 Commit-reveal trace storage ─────────────────────────────────────

    /// Stores a commitment for a future unchained trace. Returns the commit id.
    /// The agent must reveal within `reveal_deadline_secs` (capped to
    /// `DEFAULT_REVEAL_DEADLINE_SECS` when zero).
    pub fn commit_trace(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        commitment: BytesN<32>,
        reveal_deadline_secs: u64,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        let record = Self::load_agent(&env, &agent).ok_or(Error::AgentNotRegistered)?;
        if !matches!(record.status, AgentStatus::Active) {
            return Err(Error::AgentNotActive);
        }
        Self::validate_action(&env, &action)?;
        Self::validate_action_state(&env, &agent, market_id, &action)?;

        let deadline_secs = if reveal_deadline_secs == 0 {
            DEFAULT_REVEAL_DEADLINE_SECS
        } else {
            reveal_deadline_secs
        };
        let now = env.ledger().timestamp();
        let commit_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextId, &(commit_id + 1));

        let commit = TraceCommit {
            agent: agent.clone(),
            market_id,
            action,
            commitment: commitment.clone(),
            committed_at: now,
            reveal_deadline: now.saturating_add(deadline_secs),
            revealed: false,
        };
        Self::put(&env, &DataKey::TraceCommit(commit_id), &commit);

        let count_key = DataKey::AgentCommitCount(agent.clone());
        let idx: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        Self::put(&env, &DataKey::AgentCommitAt(agent.clone(), idx), &commit_id);
        Self::put(&env, &count_key, &(idx + 1));

        TraceCommitted {
            commit_id,
            agent,
            market_id: commit.market_id,
            commitment,
            reveal_deadline: commit.reveal_deadline,
        }
        .publish(&env);
        Ok(commit_id)
    }

    /// Stores a commitment for a future chained trace. Same semantics as
    /// `commit_trace` but records the expected chain head for consistency.
    pub fn commit_chained_trace(
        env: Env,
        agent: Address,
        market_id: u64,
        action: TraceAction,
        commitment: BytesN<32>,
        reveal_deadline_secs: u64,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        // Validation identical to commit_trace; chaining is enforced at reveal.
        Self::commit_trace(env, agent, market_id, action, commitment, reveal_deadline_secs)
    }

    /// Reveals a previously committed trace. Verifies the commitment and
    /// publishes the trace through the normal `write_trace` path.
    /// If the reveal deadline has passed, increments the agent's missed-reveal
    /// counter and emits `RevealDeadlineMissed` before continuing.
    #[allow(clippy::too_many_arguments)]
    pub fn reveal_trace(
        env: Env,
        agent: Address,
        commit_id: u64,
        trace_hash: BytesN<32>,
        salt: BytesN<32>,
        ipfs_cid: String,
    ) -> Result<u64, Error> {
        ttl::bump_instance(&env);
        agent.require_auth();
        let commit_key = DataKey::TraceCommit(commit_id);
        let mut commit: TraceCommit = env
            .storage()
            .persistent()
            .get(&commit_key)
            .ok_or(Error::TraceNotFound)?;

        if commit.agent != agent {
            return Err(Error::TraceAgentMismatch);
        }
        if commit.revealed {
            return Err(Error::TraceAlreadyConsumed);
        }

        let expected = Self::commitment_for(&env, &trace_hash, &salt);
        if expected != commit.commitment {
            return Err(Error::TraceMismatch);
        }

        let now = env.ledger().timestamp();
        if now > commit.reveal_deadline {
            let missed_key = DataKey::AgentMissedRevealCount(agent.clone());
            let missed: u64 = env.storage().persistent().get(&missed_key).unwrap_or(0);
            let new_missed = missed + 1;
            Self::put(&env, &missed_key, &new_missed);
            RevealDeadlineMissed {
                commit_id,
                agent: agent.clone(),
                missed_total: new_missed,
            }
            .publish(&env);
        }

        if ipfs_cid.is_empty() {
            return Err(Error::EmptyCid);
        }

        // Bump the agent's TTL (mirrors publish_trace).
        ttl::bump_persistent(
            &env,
            &DataKey::Agent(agent.clone()),
            ttl::long_lived_target(&env),
        );

        let (trace_id, _) = Self::write_trace(
            &env,
            agent.clone(),
            commit.market_id,
            commit.action.clone(),
            trace_hash,
            ipfs_cid,
        )?;

        commit.revealed = true;
        Self::put(&env, &commit_key, &commit);

        TraceRevealed {
            commit_id,
            trace_id,
            agent,
        }
        .publish(&env);
        Ok(trace_id)
    }

    /// Returns a pending commitment record by its id.
    pub fn get_trace_commit(env: Env, commit_id: u64) -> Option<TraceCommit> {
        env.storage()
            .persistent()
            .get(&DataKey::TraceCommit(commit_id))
    }

    /// Number of traces an agent missed the reveal deadline for.
    pub fn agent_missed_reveal_count(env: Env, agent: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentMissedRevealCount(agent))
            .unwrap_or(0)
    }

}

impl ReasoningRegistry {
    /// A market's `close_time`, cached in `DataKey::MarketClose` on the
    /// market's first trace so later publishes skip the market-core call.
    fn market_close(env: &Env, market_id: u64) -> u64 {
        let key = DataKey::MarketClose(market_id);
        if let Some(close) = env.storage().persistent().get::<_, u64>(&key) {
            return close;
        }
        let mc: Address = env
            .storage()
            .instance()
            .get(&DataKey::MarketCore)
            .expect("market core configured");
        let close = CoreView::new(env, &mc).get_market(&market_id).close_time;
        let target = retention::audit_target(env, close);
        retention::put(env, &key, &close, target);
        close
    }

    /// Retention target (#329) for the audit keys of a trace on `market_id`:
    /// `audit_target(close_time)`, or long-lived for `NO_MARKET` traces.
    fn market_target(env: &Env, market_id: u64) -> u32 {
        if market_id == NO_MARKET {
            retention::long_lived_target(env)
        } else {
            retention::audit_target(env, Self::market_close(env, market_id))
        }
    }

    /// Extends every audit key of `trace_id` to its class target. Returns the
    /// number of entries extended (0 for an unknown trace).
    fn extend_trace_keys(env: &Env, trace_id: u64) -> u32 {
        let Some(trace) = env
            .storage()
            .persistent()
            .get::<_, Trace>(&DataKey::Trace(trace_id))
        else {
            return 0;
        };
        let target = Self::market_target(env, trace.market_id);
        let mut n = 0u32;
        let mut ext = |key: DataKey| {
            if retention::extend_if_present(env, &key, target) {
                n += 1;
            }
        };
        ext(DataKey::Trace(trace_id));
        ext(DataKey::TraceLedger(trace_id));
        ext(DataKey::TraceDecision(trace_id));
        ext(DataKey::TraceSignature(trace_id));
        ext(DataKey::TraceConsumer(trace_id));
        ext(DataKey::Consumed(trace_id));
        ext(DataKey::TraceLate(trace_id));
        ext(DataKey::Flag(trace_id));
        if trace.market_id != NO_MARKET {
            ext(DataKey::MarketClose(trace.market_id));
        }
        if let Some(link) = env
            .storage()
            .persistent()
            .get::<_, ChainLink>(&DataKey::TraceLink(trace_id))
        {
            ext(DataKey::TraceLink(trace_id));
            ext(DataKey::AgentTrace(trace.agent.clone(), link.seq));
        }
        let flags: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::FlagHistoryCount(trace_id))
            .unwrap_or(0);
        if flags > 0 {
            ext(DataKey::FlagHistoryCount(trace_id));
            for i in 0..flags {
                ext(DataKey::FlagHistory(trace_id, i));
            }
        }
        n
    }

    /// Write-path refresh of an `Identity` entry (e.g. `KeyToAgent` during
    /// `revoke_signing_key`). Never called from a view (#329).
    fn bump_persistent(env: &Env, key: &DataKey) {
        retention::touch_identity(env, key);
    }

    fn load_trace(env: &Env, trace_id: u64) -> Result<Trace, Error> {
        Self::get_trace(env.clone(), trace_id)
    }

    fn require_active_agent(env: &Env, agent: &Address) -> Result<(), Error> {
        let record = Self::load_agent(env, agent).ok_or(Error::AgentNotRegistered)?;
        if matches!(record.status, AgentStatus::Active) {
            Ok(())
        } else {
            Err(Error::AgentNotActive)
        }
    }
}

#[cfg(test)]
mod retention_tests;

#[cfg(test)]
mod action_state_tests;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::{Instance as _, Persistent as _},
            Address as _, Ledger as _, MockAuth, MockAuthInvoke,
        },
        IntoVal,
    };

    #[test]
    fn registry_errors_stay_in_reserved_range_and_unique() {
        let codes = [
            Error::NotInitialized as u32,
            Error::Unauthorized as u32,
            Error::TraceAlreadyConsumed as u32,
            Error::NoPendingAdmin as u32,
            Error::PendingAdminExpired as u32,
            Error::AlreadyRevoked as u32,
        ];
        for code in codes {
            assert!(code > REGISTRY_ERROR_BASE && code <= 3999);
        }
    }

    fn register_market_core(env: &Env, admin: &Address) -> (Address, market_core::Client<'static>) {
        let treasury = Address::generate(env);
        let resolver = Address::generate(env);
        let creator = Address::generate(env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = soroban_sdk::token::StellarAssetClient::new(env, &collateral.address());
        token.mint(&creator, &(50_000 * 10_000_000_i128));

        let market_core_id = env.register(
            market_core::MarketCore,
            (
                admin.clone(),
                collateral.address(),
                treasury,
                resolver,
                100u32,
                10_000u32,
            ),
        );
        let market_core = market_core::Client::new(env, &market_core_id);
        for _ in 0..50 {
            market_core.create_market(
                &creator,
                &BytesN::from_array(env, &[42u8; 32]),
                &BytesN::from_array(env, &[142u8; 32]),
                &String::from_str(env, "ipfs://market"),
                &market_core::Category::Crypto,
                &(env.ledger().timestamp() + 60_000),
                &(100 * 10_000_000_i128),
                &5000u32,
            );
        }
        (market_core_id, market_core)
    }

    fn setup() -> (Env, ReasoningRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let (market_core_id, _) = register_market_core(&env, &admin);
        let contract_id = env.register(
            ReasoningRegistry,
            ReasoningRegistryArgs::__constructor(&admin, &market_core_id),
        );
        let client = ReasoningRegistryClient::new(&env, &contract_id);
        (env, client, admin, agent)
    }

    #[test]
    fn registered_agent_can_publish_and_buyer_can_verify_hash() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let trace_hash = BytesN::from_array(&env, &[7u8; 32]);
        let trace_id = client.publish_trace(
            &agent,
            &42,
            &TraceAction::Buy,
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-42"),
        );

        assert_eq!(trace_id, 0);
        assert_eq!(client.trace_count(), 1);
        assert!(client.verify_trace(&trace_id, &trace_hash));
        assert!(!client.verify_trace(&trace_id, &BytesN::from_array(&env, &[8u8; 32]),));

        let trace = client.get_trace(&trace_id);
        assert_eq!(trace.market_id, 42);
        assert_eq!(trace.agent, agent);
        assert_eq!(trace.action, TraceAction::Buy);
        assert_eq!(trace.ipfs_cid, String::from_str(&env, "ipfs://trace-42"));
        assert!(client.is_registered(&agent));

        client.unregister_agent(&agent);
        assert!(!client.is_registered(&agent));
        let record = client.get_agent(&agent).unwrap();
        assert!(matches!(record.status, AgentStatus::Retired(_)));
        assert!(client.verify_trace(&trace_id, &trace_hash));
        let _ = admin;
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3004)")]
    fn unregistered_agent_cannot_publish() {
        let (env, client, _, agent) = setup();
        client.publish_trace(
            &agent,
            &1,
            &TraceAction::Skip,
            &BytesN::from_array(&env, &[1u8; 32]),
            &String::from_str(&env, "ipfs://unauthorized"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3005)")]
    fn unknown_trace_cannot_be_verified() {
        let (env, client, _, _) = setup();
        client.verify_trace(&99, &BytesN::from_array(&env, &[0u8; 32]));
    }

    #[test]
    fn traces_are_indexed_per_market() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let t0 = client.publish_trace(
            &agent,
            &7,
            &TraceAction::Skip,
            &BytesN::from_array(&env, &[1u8; 32]),
            &String::from_str(&env, "ipfs://t0"),
        );
        let t1 = client.publish_trace(
            &agent,
            &7,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[2u8; 32]),
            &String::from_str(&env, "ipfs://t1"),
        );
        // A trace on a different market must not appear in market 7's index.
        client.publish_trace(
            &agent,
            &8,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[3u8; 32]),
            &String::from_str(&env, "ipfs://t2"),
        );

        assert_eq!(client.market_trace_count(&7), 2);
        assert_eq!(client.market_trace_at(&7, &0), t0);
        assert_eq!(client.market_trace_at(&7, &1), t1);
        assert_eq!(client.market_trace_count(&8), 1);
    }

    #[test]
    fn wrong_caller_cannot_register_agents() {
        let (env, client, _, agent) = setup();
        let not_admin = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "register_agent",
                    args: (agent.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_agent(&agent)
            .is_err());
    }

    #[test]
    fn agent_cannot_publish_trace_impersonating_another_agent() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let impostor = Address::generate(&env);
        env.set_auths(&[]);
        // `impostor` authorizes itself, but the call claims `agent` published
        // the trace; only `agent`'s own signature may satisfy that.
        assert!(client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "publish_trace",
                    args: (
                        agent.clone(),
                        1u64,
                        TraceAction::Buy,
                        BytesN::from_array(&env, &[9u8; 32]),
                        String::from_str(&env, "ipfs://impostor"),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_publish_trace(
                &agent,
                &1,
                &TraceAction::Buy,
                &BytesN::from_array(&env, &[9u8; 32]),
                &String::from_str(&env, "ipfs://impostor"),
            )
            .is_err());
    }

    fn advance_ledgers(env: &Env, secs: u64) {
        assert_eq!(secs % ttl::LEDGER_SECS, 0);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + (secs / ttl::LEDGER_SECS) as u32);
        env.ledger().set_timestamp(env.ledger().timestamp() + secs);
    }

    fn persistent_ttl(env: &Env, contract: &Address, key: &DataKey) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    fn instance_ttl(env: &Env, contract: &Address) -> u32 {
        env.as_contract(contract, || env.storage().instance().get_ttl())
    }

    fn publish_trace_at_day(
        client: &ReasoningRegistryClient,
        env: &Env,
        agent: &Address,
        day: u64,
    ) {
        let trace_hash = BytesN::from_array(env, &[day as u8; 32]);
        let cid = String::from_str(env, "ipfs://publish-refresh");
        client.publish_trace(
            agent,
            &(day % 50),
            &TraceAction::Other(Symbol::new(env, "trade")),
            &trace_hash,
            &cid,
        );
    }

    #[test]
    fn agent_entry_extended_on_publish() {
        let (env, client, _, agent) = setup();
        let max_ttl = 3_110_400u32;
        env.ledger().set_max_entry_ttl(max_ttl);
        env.ledger().set_min_persistent_entry_ttl(4_096);
        let agent_key = DataKey::Agent(agent.clone());

        client.register_agent(&agent);
        // #322: `Other` actions must be allow-listed.
        client.set_other_action(&Symbol::new(&env, "trade"), &Some(OtherRule::Any));
        assert!(persistent_ttl(&env, &client.address, &agent_key) >= max_ttl - 1);

        // Day 0 and day 59 publishes; the day-100 publish only succeeds if the
        // registration was not archived in between (it would be past the old
        // 60-day window with no `Agent` extension on publish).
        publish_trace_at_day(&client, &env, &agent, 0);
        advance_ledgers(&env, 59 * ttl::DAY_SECS);
        publish_trace_at_day(&client, &env, &agent, 59);

        advance_ledgers(&env, 41 * ttl::DAY_SECS);
        let before = persistent_ttl(&env, &client.address, &agent_key);
        assert!(before < max_ttl / 2, "refresh was already due at day 100");
        assert!(client.is_registered(&agent));

        publish_trace_at_day(&client, &env, &agent, 100);
        assert!(
            persistent_ttl(&env, &client.address, &agent_key) >= max_ttl - 1,
            "publish_trace did not refresh the Agent entry"
        );
        assert_eq!(instance_ttl(&env, &client.address), ttl::INSTANCE_TARGET);

    // ── #52 hash-chained traces ──────────────────────────────────────────

    fn chained(
        env: &Env,
        client: &ReasoningRegistryClient,
        agent: &Address,
        seq: u64,
        prev: &BytesN<32>,
        hash: u8,
    ) -> Result<u64, Error> {
        client
            .try_publish_chained_trace(
                agent,
                &1,
                &TraceAction::Buy,
                &BytesN::from_array(env, &[hash; 32]),
                &String::from_str(env, "ipfs://chain"),
                &seq,
                prev,
            )
            .map(|r| r.unwrap())
            .map_err(|e| e.unwrap())
    }

    #[test]
    fn first_chained_trace_requires_genesis_head() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        assert_eq!(
            chained(&env, &client, &agent, 2, &zero, 1),
            Err(Error::ChainHeadMismatch)
        );
        assert_eq!(
            chained(
                &env,
                &client,
                &agent,
                1,
                &BytesN::from_array(&env, &[5u8; 32]),
                1
            ),
            Err(Error::ChainHeadMismatch)
        );
        assert_eq!(chained(&env, &client, &agent, 1, &zero, 1), Ok(0));
    }

    #[test]
    fn chain_extends_sequentially_and_views_return_ids() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let id1 = chained(&env, &client, &agent, 1, &zero, 1).unwrap();
        let id2 = chained(
            &env,
            &client,
            &agent,
            2,
            &BytesN::from_array(&env, &[1u8; 32]),
            2,
        )
        .unwrap();

        let head = client.agent_chain_head(&agent);
        assert_eq!(head.seq, 2);
        assert_eq!(head.head_hash, BytesN::from_array(&env, &[2u8; 32]));
        assert_eq!(head.head_trace_id, Some(id2));
        assert_eq!(client.agent_trace_at(&agent, &1), id1);
        assert_eq!(client.agent_trace_at(&agent, &2), id2);
        assert_eq!(
            client.get_trace_link(&id2),
            Some(ChainLink {
                seq: 2,
                prev_trace_hash: BytesN::from_array(&env, &[1u8; 32])
            })
        );
    }

    #[test]
    fn stale_head_publish_is_rejected() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        chained(&env, &client, &agent, 1, &zero, 1).unwrap();
        // A racing publisher that read the same genesis head loses.
        assert_eq!(
            chained(&env, &client, &agent, 1, &zero, 9),
            Err(Error::ChainHeadMismatch)
        );
    }

    #[test]
    fn wrong_prev_hash_is_rejected() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        chained(
            &env,
            &client,
            &agent,
            1,
            &BytesN::from_array(&env, &[0u8; 32]),
            1,
        )
        .unwrap();
        assert_eq!(
            chained(
                &env,
                &client,
                &agent,
                2,
                &BytesN::from_array(&env, &[3u8; 32]),
                2
            ),
            Err(Error::ChainHeadMismatch)
        );
    }

    #[test]
    fn legacy_publish_blocked_after_chain_started() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        chained(
            &env,
            &client,
            &agent,
            1,
            &BytesN::from_array(&env, &[0u8; 32]),
            1,
        )
        .unwrap();
        let res = client.try_publish_trace(
            &agent,
            &1,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[4u8; 32]),
            &String::from_str(&env, "ipfs://legacy"),
        );
        assert_eq!(res, Err(Ok(Error::ChainedAgentMustChain)));
    }

    #[test]
    fn legacy_publish_still_works_for_unchained_agent() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let id = client.publish_trace(
            &agent,
            &1,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[4u8; 32]),
            &String::from_str(&env, "ipfs://legacy"),
        );
        assert_eq!(client.get_trace_link(&id), None);
        assert_eq!(client.agent_chain_head(&agent).seq, 0);
    }

    #[test]
    fn reregistration_does_not_reset_chain_head() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        chained(
            &env,
            &client,
            &agent,
            1,
            &BytesN::from_array(&env, &[0u8; 32]),
            1,
        )
        .unwrap();
        client.unregister_agent(&agent);
        client.register_agent(&agent);
        assert_eq!(client.agent_chain_head(&agent).seq, 1);
        assert_eq!(
            chained(
                &env,
                &client,
                &agent,
                1,
                &BytesN::from_array(&env, &[0u8; 32]),
                7
            ),
            Err(Error::ChainHeadMismatch)
        );
    }

    #[test]
    fn impostor_cannot_extend_another_agents_chain() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let impostor = Address::generate(&env);
        let (market_core_id, _) = register_market_core(&env, &admin);
        let id = env.register(
            ReasoningRegistry,
            ReasoningRegistryArgs::__constructor(&admin, &market_core_id),
        );
        let client = ReasoningRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.register_agent(&agent);

        let action = TraceAction::Buy;
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        let cid = String::from_str(&env, "ipfs://x");
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "publish_chained_trace",
                args: (&agent, 1u64, &action, &hash, &cid, 1u64, &zero).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        assert!(client
            .try_publish_chained_trace(&agent, &1, &action, &hash, &cid, &1, &zero)
            .is_err());
        assert_eq!(client.agent_chain_head(&agent).seq, 0);
    }

    // ── #50 trace consumption + ledger ───────────────────────────────────

    #[test]
    fn trace_records_ledger_and_is_consumed_once() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        env.ledger().set_sequence_number(77);
        let id = client.publish_trace(
            &agent,
            &3,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[6u8; 32]),
            &String::from_str(&env, "ipfs://intent"),
        );
        assert_eq!(client.get_trace_ledger(&id), Some(77));

        let treasury = Address::generate(&env);
        client.register_consumer(&treasury);
        assert!(client.is_consumer(&treasury));
        let trace = client.consume_trace(&treasury, &id);
        assert_eq!(trace.market_id, 3);
        assert!(client.is_consumed(&id));
        assert_eq!(
            client.try_consume_trace(&treasury, &id),
            Err(Ok(Error::TraceAlreadyConsumed))
        );
    }

    #[test]
    fn only_registered_consumer_can_consume() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let id = client.publish_trace(
            &agent,
            &3,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[6u8; 32]),
            &String::from_str(&env, "ipfs://intent"),
        );
        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_consume_trace(&stranger, &id),
            Err(Ok(Error::Unauthorized))
        );

        client.register_consumer(&stranger);
        client.unregister_consumer(&stranger);
        assert_eq!(
            client.try_consume_trace(&stranger, &id),
            Err(Ok(Error::Unauthorized))
        );
        assert!(!client.is_consumed(&id));
    }

    #[test]
    fn wrong_caller_cannot_register_consumer() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (market_core_id, _) = register_market_core(&env, &admin);
        let id = env.register(
            ReasoningRegistry,
            ReasoningRegistryArgs::__constructor(&admin, &market_core_id),
        );
        let client = ReasoningRegistryClient::new(&env, &id);
        let attacker = Address::generate(&env);
        let consumer = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "register_consumer",
                args: (&consumer,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        assert!(client.try_register_consumer(&consumer).is_err());
        assert!(!client.is_consumer(&consumer));
    }

    // ── #51 commit-reveal commitment ─────────────────────────────────────

    #[test]
    fn commitment_vector_matches_typescript() {
        let (env, client, _, _) = setup();
        let hash = BytesN::from_array(&env, &[7u8; 32]);
        let salt = BytesN::from_array(&env, &[9u8; 32]);
        // Same vector as agents/core/trace.test.ts.
        let expected: [u8; 32] = [
            0x50, 0xa6, 0x30, 0xb8, 0x3f, 0x3b, 0x4e, 0x9c, 0x44, 0x42, 0x65, 0xcc, 0x6a, 0xf2,
            0xa0, 0x94, 0xbf, 0xf7, 0xe3, 0x84, 0x8a, 0x33, 0x4f, 0x01, 0x67, 0xfb, 0x54, 0x9d,
            0x6c, 0xa7, 0xee, 0x52,
        ];
        assert!(client.verify_commitment(&hash, &salt, &BytesN::from_array(&env, &expected)));
        assert!(!client.verify_commitment(
            &hash,
            &BytesN::from_array(&env, &[8u8; 32]),
            &BytesN::from_array(&env, &expected)
        ));
    }

    // ── #56 Trace lifecycle: retirement, revocation, and flagging ─────────

    #[test]
    fn retired_agent_cannot_publish_but_old_traces_valid() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let trace_hash = BytesN::from_array(&env, &[1u8; 32]);
        let trace_id = client.publish_trace(
            &agent,
            &1,
            &TraceAction::Buy,
            &trace_hash,
            &String::from_str(&env, "ipfs://t1"),
        );

        client.retire_agent(&agent);
        assert!(!client.is_registered(&agent));

        assert_eq!(
            client.try_publish_trace(
                &agent,
                &1,
                &TraceAction::Buy,
                &BytesN::from_array(&env, &[2u8; 32]),
                &String::from_str(&env, "ipfs://t2"),
            ),
            Err(Ok(Error::AgentNotActive))
        );

        assert_eq!(
            client.trace_verdict(&trace_id, &trace_hash),
            TraceVerdict::Valid
        );
        assert!(client.verify_trace(&trace_id, &trace_hash));

        client.reactivate_agent(&agent);
        assert!(client.is_registered(&agent));
        let trace_id2 = client.publish_trace(
            &agent,
            &1,
            &TraceAction::Buy,
            &BytesN::from_array(&env, &[3u8; 32]),
            &String::from_str(&env, "ipfs://t3"),
        );
        assert_eq!(trace_id2, 1);
        let _ = admin;
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3004)")]
    fn unregistered_agent_cannot_publish() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let trace_hash = BytesN::from_array(&env, &[11u8; 32]);
        let trace_id = client.publish_trace(
            &agent,
            &0,
            &TraceAction::Buy,
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-0"),
        );
        let trace = client.get_trace(&trace_id);
        assert_eq!(trace.market_id, 0);
        assert_eq!(trace.action, TraceAction::Buy);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3005)")]
    fn unknown_trace_cannot_be_verified() {
        let (env, client, _, _) = setup();
        client.verify_trace(&99, &BytesN::from_array(&env, &[0u8; 32]));
    }

    #[test]
    fn propose_market_requires_no_market_sentinel() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let trace_hash = BytesN::from_array(&env, &[13u8; 32]);
        // ProposeMarket with an actual market_id must fail with ProposalMustUseNoMarket
        assert_eq!(
            client.try_publish_trace(
                &agent,
                &1,
                &TraceAction::ProposeMarket,
                &trace_hash,
                &String::from_str(&env, "ipfs://trace-propose"),
            ),
            Err(Ok(Error::ProposalMustUseNoMarket))
        );
        // ProposeMarket with NO_MARKET must succeed
        let id = client.publish_trace(
            &agent,
            &NO_MARKET,
            &TraceAction::ProposeMarket,
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-propose"),
        );
        let trace = client.get_trace(&id);
        assert_eq!(trace.market_id, NO_MARKET);
        assert_eq!(trace.action, TraceAction::ProposeMarket);
    }

    #[test]
    fn no_market_sentinel_rejected_for_buy() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let trace_hash = BytesN::from_array(&env, &[14u8; 32]);
        assert_eq!(
            client.try_publish_trace(
                &agent,
                &NO_MARKET,
                &TraceAction::Buy,
                &trace_hash,
                &String::from_str(&env, "ipfs://trace-buy-nomarket"),
            ),
            Err(Ok(Error::MarketRequired))
        );
    }

    #[test]
    fn other_action_cannot_shadow_canonical_name() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let trace_hash = BytesN::from_array(&env, &[15u8; 32]);
        // Attempting to use Other with canonical names
        let canonical_names = [
            "create_market",
            "propose_market",
            "buy",
            "sell",
            "skip",
            "redeem",
            "claim_remainder",
            "resolve",
        ];
        for name in canonical_names.iter() {
            assert_eq!(
                client.try_publish_trace(
                    &agent,
                    &0,
                    &TraceAction::Other(Symbol::new(&env, name)),
                    &trace_hash,
                    &String::from_str(&env, "ipfs://trace-shadow"),
                ),
                Err(Ok(Error::UseCanonicalAction))
            );
        }
        // Non-canonical name succeeds (works with NO_MARKET or valid market_id)
        let id1 = client.publish_trace(
            &agent,
            &NO_MARKET,
            &TraceAction::Other(Symbol::new(&env, "custom_strategy")),
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-custom"),
        );
        let trace1 = client.get_trace(&id1);
        assert_eq!(trace1.action, TraceAction::Other(Symbol::new(&env, "custom_strategy")));

        let id2 = client.publish_trace(
            &agent,
            &0,
            &TraceAction::Other(Symbol::new(&env, "custom_strategy_2")),
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-custom-2"),
        );
        let trace2 = client.get_trace(&id2);
        assert_eq!(trace2.action, TraceAction::Other(Symbol::new(&env, "custom_strategy_2")));
    }

    #[test]
    fn publish_works_while_market_core_paused() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let agent = Address::generate(&env);
        let (market_core_id, market_core_client) = register_market_core(&env, &admin);
        let contract_id = env.register(
            ReasoningRegistry,
            ReasoningRegistryArgs::__constructor(&admin, &market_core_id),
        );
        let client = ReasoningRegistryClient::new(&env, &contract_id);
        client.register_agent(&agent);

        // Pause market-core
        market_core_client.set_paused(&true);

        // Registry publish_trace must still succeed because market_count is a view call
        let trace_hash = BytesN::from_array(&env, &[16u8; 32]);
        let trace_id = client.publish_trace(
            &agent,
            &0,
            &TraceAction::Buy,
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-while-paused"),
        );
        assert_eq!(trace_id, 0);
    }

    #[test]
    fn market_ids_are_dense_assumption_holds() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (_market_core_id, market_core_client) = register_market_core(&env, &admin);
        let count = market_core_client.market_count();
        assert_eq!(count, 50);
    }

    // ── #54 Merkle-batched trace anchoring ──────────────────────────────

    #[test]
    fn merkle_vector_sizes_match_spec() {
        let (env, client, _, _) = setup();

        // Size 1: leaf 0
        let trace_0 = BytesN::from_array(
            &env,
            &[
                0x63, 0x6e, 0xef, 0xad, 0x93, 0xfd, 0xbc, 0x03, 0xa2, 0x58, 0x52, 0x2c, 0x63, 0x67,
                0x2a, 0xf9, 0x1a, 0x5f, 0x67, 0x62, 0x4e, 0x9b, 0xc9, 0x31, 0xbe, 0xe4, 0xf4, 0x37,
                0x4e, 0x1f, 0xab, 0x58,
            ],
        );
        let root_1 = BytesN::from_array(
            &env,
            &[
                0xd2, 0xea, 0x33, 0x68, 0xe7, 0x8c, 0x8f, 0xf7, 0x63, 0xb5, 0x92, 0x3a, 0x59, 0xf8,
                0xaf, 0x10, 0x1d, 0xda, 0x4c, 0x3b, 0xff, 0x46, 0xae, 0x74, 0xe1, 0xe9, 0xa5, 0x2c,
                0x77, 0x55, 0xaa, 0xeb,
            ],
        );
        let proof_1: Vec<BytesN<32>> = Vec::new(&env);
        let computed_1 = client.compute_merkle_root(&1, &trace_0, &0, &proof_1);
        assert_eq!(computed_1, root_1);

        // Size 2: leaf 0 with leaf 1 sibling
        let root_2 = BytesN::from_array(
            &env,
            &[
                0xcd, 0x3a, 0x97, 0xb9, 0x45, 0x78, 0x20, 0x45, 0x0f, 0xf6, 0xd5, 0x77, 0xb6, 0xdd,
                0x8a, 0x13, 0xbe, 0xf9, 0x4a, 0xce, 0x08, 0xb8, 0xec, 0xba, 0xbe, 0x4e, 0x2c, 0xa4,
                0x74, 0x71, 0xe2, 0x29,
            ],
        );
        let sibling_1 = BytesN::from_array(
            &env,
            &[
                0x17, 0x82, 0x46, 0xc1, 0x01, 0xf8, 0x2f, 0xba, 0x9b, 0x1b, 0xb6, 0x30, 0x3f, 0x1e,
                0x9f, 0x13, 0x12, 0x04, 0x26, 0x55, 0x65, 0x76, 0xc5, 0xeb, 0xc7, 0x8c, 0x42, 0xd7,
                0x6a, 0x73, 0x48, 0xb3,
            ],
        );
        let mut proof_2: Vec<BytesN<32>> = Vec::new(&env);
        proof_2.push_back(sibling_1);
        let computed_2 = client.compute_merkle_root(&2, &trace_0, &0, &proof_2);
        assert_eq!(computed_2, root_2);

        // Size 3: leaf 2 (odd node promoted to level 1, then paired with root_2)
        let trace_2 = BytesN::from_array(
            &env,
            &[
                0x42, 0x4d, 0xa8, 0xb6, 0x08, 0x8f, 0xd9, 0xf1, 0xc2, 0xd0, 0xd1, 0x1c, 0x5a, 0x6c,
                0xd5, 0xd6, 0x1b, 0xf5, 0x31, 0x6d, 0xee, 0x8e, 0x61, 0xb3, 0xb0, 0xa3, 0x0f, 0x2a,
                0x01, 0xb8, 0xb4, 0xa1,
            ],
        );
        let root_3 = BytesN::from_array(
            &env,
            &[
                0xa5, 0xb9, 0x47, 0x06, 0xba, 0xa6, 0x8c, 0x77, 0x8b, 0x70, 0x11, 0xab, 0x43, 0xea,
                0x96, 0x29, 0x31, 0xbe, 0x6d, 0xfc, 0x2e, 0xef, 0x99, 0x57, 0xb5, 0x53, 0x68, 0x9b,
                0x49, 0xf8, 0xdc, 0x91,
            ],
        );
        let mut proof_3: Vec<BytesN<32>> = Vec::new(&env);
        proof_3.push_back(root_2.clone());
        let computed_3 = client.compute_merkle_root(&3, &trace_2, &2, &proof_3);
        assert_eq!(computed_3, root_3);
    }

    #[test]
    fn publish_batch_and_verify_inclusion() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let root = BytesN::from_array(
            &env,
            &[
                0xa5, 0xb9, 0x47, 0x06, 0xba, 0xa6, 0x8c, 0x77, 0x8b, 0x70, 0x11, 0xab, 0x43, 0xea,
                0x96, 0x29, 0x31, 0xbe, 0x6d, 0xfc, 0x2e, 0xef, 0x99, 0x57, 0xb5, 0x53, 0x68, 0x9b,
                0x49, 0xf8, 0xdc, 0x91,
            ],
        );
        let batch_id = client.publish_trace_batch(
            &agent,
            &root,
            &3,
            &String::from_str(&env, "ipfs://manifest-3"),
        );
        assert_eq!(batch_id, 0);
        assert_eq!(client.batch_count(), 1);
        assert_eq!(client.agent_batch_count(&agent), 1);
        assert_eq!(client.agent_batch_at(&agent, &0), 0);

        let batch = client.get_batch(&batch_id);
        assert_eq!(batch.agent, agent);
        assert_eq!(batch.root, root);
        assert_eq!(batch.leaf_count, 3);
        assert_eq!(batch.manifest_cid, String::from_str(&env, "ipfs://manifest-3"));

        let trace_2 = BytesN::from_array(
            &env,
            &[
                0x42, 0x4d, 0xa8, 0xb6, 0x08, 0x8f, 0xd9, 0xf1, 0xc2, 0xd0, 0xd1, 0x1c, 0x5a, 0x6c,
                0xd5, 0xd6, 0x1b, 0xf5, 0x31, 0x6d, 0xee, 0x8e, 0x61, 0xb3, 0xb0, 0xa3, 0x0f, 0x2a,
                0x01, 0xb8, 0xb4, 0xa1,
            ],
        );
        let sibling_root_2 = BytesN::from_array(
            &env,
            &[
                0xcd, 0x3a, 0x97, 0xb9, 0x45, 0x78, 0x20, 0x45, 0x0f, 0xf6, 0xd5, 0x77, 0xb6, 0xdd,
                0x8a, 0x13, 0xbe, 0xf9, 0x4a, 0xce, 0x08, 0xb8, 0xec, 0xba, 0xbe, 0x4e, 0x2c, 0xa4,
                0x74, 0x71, 0xe2, 0x29,
            ],
        );
        let mut proof: Vec<BytesN<32>> = Vec::new(&env);
        proof.push_back(sibling_root_2);

        // Valid inclusion check returns true
        assert!(client.verify_trace_inclusion(&batch_id, &trace_2, &2, &proof));

        // Wrong trace hash returns false
        let fake_trace = BytesN::from_array(&env, &[99u8; 32]);
        assert!(!client.verify_trace_inclusion(&batch_id, &fake_trace, &2, &proof));

        // Index out of bounds (index 3 with leaf_count 3) returns false
        assert!(!client.verify_trace_inclusion(&batch_id, &trace_2, &3, &proof));

        // Mutated proof element returns false
        let mut bad_proof: Vec<BytesN<32>> = Vec::new(&env);
        bad_proof.push_back(BytesN::from_array(&env, &[0u8; 32]));
        assert!(!client.verify_trace_inclusion(&batch_id, &trace_2, &2, &bad_proof));
    }

    #[test]
    fn merkle_second_preimage_resistance() {
        let env = Env::default();
        let trace = BytesN::from_array(&env, &[1u8; 32]);
        // Leaf hash is sha256(0x00 || trace)
        let mut leaf_preimage = Bytes::new(&env);
        leaf_preimage.push_back(MERKLE_LEAF_PREFIX);
        leaf_preimage.append(&trace.clone().into());
        let leaf_hash: BytesN<32> = env.crypto().sha256(&leaf_preimage).into();

        // Node hash is sha256(0x01 || left || right)
        let mut node_preimage = Bytes::new(&env);
        node_preimage.push_back(MERKLE_NODE_PREFIX);
        node_preimage.append(&trace.clone().into());
        node_preimage.append(&trace.into());
        let node_hash: BytesN<32> = env.crypto().sha256(&node_preimage).into();

        assert_ne!(leaf_hash, node_hash);
    }

    #[test]
    fn merkle_proof_length_bounded() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let batch_id = client.publish_trace_batch(
            &agent,
            &root,
            &100,
            &String::from_str(&env, "ipfs://manifest"),
        );

        // Proof of length 13 (> MAX_PROOF_LEN = 12) must fail with InvalidProof
        let mut long_proof: Vec<BytesN<32>> = Vec::new(&env);
        for _ in 0..13 {
            long_proof.push_back(BytesN::from_array(&env, &[2u8; 32]));
        }
        assert_eq!(
            client.try_verify_trace_inclusion(&batch_id, &BytesN::from_array(&env, &[3u8; 32]), &0, &long_proof),
            Err(Ok(Error::InvalidProof))
        );
    }

    #[test]
    fn merkle_batch_size_bounded() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let root = BytesN::from_array(&env, &[1u8; 32]);

        // leaf_count = 0 fails
        assert_eq!(
            client.try_publish_trace_batch(
                &agent,
                &root,
                &0,
                &String::from_str(&env, "ipfs://manifest"),
            ),
            Err(Ok(Error::InvalidBatch))
        );

        // leaf_count = 4097 (> MAX_LEAVES = 4096) fails
        assert_eq!(
            client.try_publish_trace_batch(
                &agent,
                &root,
                &4097,
                &String::from_str(&env, "ipfs://manifest"),
            ),
            Err(Ok(Error::InvalidBatch))
        );

        // empty manifest_cid fails
        assert_eq!(
            client.try_publish_trace_batch(
                &agent,
                &root,
                &10,
                &String::from_str(&env, ""),
            ),
            Err(Ok(Error::InvalidBatch))
        );
    }

    #[test]
    fn unregistered_or_retired_agent_cannot_publish_batch() {
        let (env, client, _, agent) = setup();
        let root = BytesN::from_array(&env, &[1u8; 32]);

        // Unregistered agent fails
        assert_eq!(
            client.try_publish_trace_batch(
                &agent,
                &root,
                &5,
                &String::from_str(&env, "ipfs://manifest"),
            ),
            Err(Ok(Error::AgentNotRegistered))
        );

        // Register then retire
        client.register_agent(&agent);
        client.retire_agent(&agent);

        // Retired agent fails
        assert_eq!(
            client.try_publish_trace_batch(
                &agent,
                &root,
                &5,
                &String::from_str(&env, "ipfs://manifest"),
            ),
            Err(Ok(Error::AgentNotActive))
        );
    }

    fn bytes_to_vec(bytes: &Bytes) -> std::vec::Vec<u8> {
        let mut out = std::vec![0u8; bytes.len() as usize];
        bytes.copy_into_slice(&mut out);
        out
    }

    #[test]
    fn add_signing_key_and_publish_signed_trace() {
        use ed25519_dalek::Signer;
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32]);
        let pubkey_bytes: [u8; 32] = signing_key.verifying_key().to_bytes();
        let pubkey = BytesN::from_array(&env, &pubkey_bytes);

        // Build key bind message
        let bind_msg = env.as_contract(&client.address, || {
            ReasoningRegistry::key_bind_message(&env, &agent, &pubkey)
        });
        let msg_bytes = bytes_to_vec(&bind_msg);
        let proof_sig_bytes = signing_key.sign(&msg_bytes).to_bytes();
        let proof_sig = BytesN::from_array(&env, &proof_sig_bytes);

        // Add signing key
        client.add_signing_key(&agent, &pubkey, &proof_sig);

        // Check queries
        let active_keys = client.get_signing_keys(&agent);
        assert_eq!(active_keys.len(), 1);
        assert_eq!(active_keys.get(0).unwrap(), pubkey);
        assert_eq!(client.get_key_agent(&pubkey), Some(agent.clone()));
        assert_eq!(client.signing_key_history_count(&agent), 1);

        // Publish signed trace
        let trace_hash = BytesN::from_array(&env, &[9u8; 32]);
        let attestation_msg = env.as_contract(&client.address, || {
            ReasoningRegistry::trace_attestation_message(
                &env,
                &agent,
                NO_MARKET,
                &TraceAction::ProposeMarket,
                &trace_hash,
            )
        });
        let att_bytes = bytes_to_vec(&attestation_msg);
        let trace_sig_bytes = signing_key.sign(&att_bytes).to_bytes();
        let trace_sig = BytesN::from_array(&env, &trace_sig_bytes);

        let trace_id = client.publish_trace_signed(
            &agent,
            &NO_MARKET,
            &TraceAction::ProposeMarket,
            &trace_hash,
            &String::from_str(&env, "ipfs://trace-1"),
            &pubkey,
            &trace_sig,
        );

        assert_eq!(trace_id, 0);
        let stored_sig = client.get_trace_signature(&trace_id);
        assert_eq!(stored_sig, Some((pubkey.clone(), trace_sig)));
        assert!(client.verify_trace_signature(&trace_id));

        // Retire signing key
        client.retire_signing_key(&agent, &pubkey);
        assert_eq!(client.get_signing_keys(&agent).len(), 0);
        assert_eq!(client.signing_key_history_count(&agent), 1);
        let history = client.signing_key_history(&agent, &0, &10);
        assert_eq!(history.len(), 1);
        assert!(history.get(0).unwrap().retired_at.is_some());
    }

    #[test]
    fn signing_key_max_limit_and_uniqueness() {
        use ed25519_dalek::Signer;
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        for i in 1..=4 {
            let sk = ed25519_dalek::SigningKey::from_bytes(&[i as u8; 32]);
            let pk = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
            let bind_msg = env.as_contract(&client.address, || {
                ReasoningRegistry::key_bind_message(&env, &agent, &pk)
            });
            let sig = BytesN::from_array(&env, &sk.sign(&bytes_to_vec(&bind_msg)).to_bytes());
            client.add_signing_key(&agent, &pk, &sig);
        }

        assert_eq!(client.get_signing_keys(&agent).len(), 4);

        // 5th key exceeds MAX_AGENT_SIGNING_KEYS
        let sk5 = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]);
        let pk5 = BytesN::from_array(&env, &sk5.verifying_key().to_bytes());
        let bind_msg5 = env.as_contract(&client.address, || {
            ReasoningRegistry::key_bind_message(&env, &agent, &pk5)
        });
        let sig5 = BytesN::from_array(&env, &sk5.sign(&bytes_to_vec(&bind_msg5)).to_bytes());
        assert_eq!(
            client.try_add_signing_key(&agent, &pk5, &sig5),
            Err(Ok(Error::TooManyKeys))
        );

        // Duplicate key binding fails
        let sk1 = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32]);
        let pk1 = BytesN::from_array(&env, &sk1.verifying_key().to_bytes());
        let bind_msg1 = env.as_contract(&client.address, || {
            ReasoningRegistry::key_bind_message(&env, &agent, &pk1)
        });
        let sig1 = BytesN::from_array(&env, &sk1.sign(&bytes_to_vec(&bind_msg1)).to_bytes());
        assert_eq!(
            client.try_add_signing_key(&agent, &pk1, &sig1),
            Err(Ok(Error::KeyAlreadyBound))
        );
    }

    #[test]
    fn retiring_unowned_key_fails() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let fake_key = BytesN::from_array(&env, &[99u8; 32]);
        assert_eq!(
            client.try_retire_signing_key(&agent, &fake_key),
            Err(Ok(Error::InvalidKey))
        );
    }

    #[test]
    fn publish_signed_trace_with_unregistered_key_fails() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let unreg_key = BytesN::from_array(&env, &[99u8; 32]);
        let fake_sig = BytesN::from_array(&env, &[0u8; 64]);
        assert_eq!(
            client.try_publish_trace_signed(
                &agent,
                &NO_MARKET,
                &TraceAction::ProposeMarket,
                &BytesN::from_array(&env, &[1u8; 32]),
                &String::from_str(&env, "ipfs://cid"),
                &unreg_key,
                &fake_sig,
            ),
            Err(Ok(Error::InvalidKey))
        );
    }

    #[test]
    fn unregistered_or_retired_agent_cannot_add_signing_key() {
        use ed25519_dalek::Signer;
        let (env, client, _, agent) = setup();
        let sk = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32]);
        let pk = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
        let bind_msg = env.as_contract(&client.address, || {
            ReasoningRegistry::key_bind_message(&env, &agent, &pk)
        });
        let sig = BytesN::from_array(&env, &sk.sign(&bytes_to_vec(&bind_msg)).to_bytes());

        // Unregistered
        assert_eq!(
            client.try_add_signing_key(&agent, &pk, &sig),
            Err(Ok(Error::AgentNotRegistered))
        );

        // Register and retire
        client.register_agent(&agent);
        client.retire_agent(&agent);

        // Retired
        assert_eq!(
            client.try_add_signing_key(&agent, &pk, &sig),
            Err(Ok(Error::AgentNotActive))
        );
    }

    #[test]
    fn unsigned_trace_signature_queries() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);
        let trace_id = client.publish_trace(
            &agent,
            &NO_MARKET,
            &TraceAction::ProposeMarket,
            &BytesN::from_array(&env, &[1u8; 32]),
            &String::from_str(&env, "ipfs://cid"),
        );

        assert_eq!(client.get_trace_signature(&trace_id), None);
        assert_eq!(
            client.try_verify_trace_signature(&trace_id),
            Err(Ok(Error::TraceNotSigned))
        );
    }
    #[test]
    fn two_step_admin_transfer() {
        let (env, client, admin, _) = setup();
        let new_admin = Address::generate(&env);
        assert_eq!(client.admin(), admin);
        assert_eq!(client.pending_admin(), None);

        client.propose_admin(&new_admin);
        assert_eq!(
            client.pending_admin().map(|p| p.address),
            Some(new_admin.clone())
        );
        client.accept_admin();
        assert_eq!(client.admin(), new_admin);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn admin_transfer_can_be_cancelled() {
        let (env, client, _, _) = setup();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.cancel_admin_transfer();
        assert_eq!(client.pending_admin(), None);
        assert_eq!(client.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    }

    #[test]
    fn expired_admin_transfer_cannot_be_accepted() {
        let (env, client, _, _) = setup();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + ADMIN_PROPOSAL_TTL_SECS + 1);
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(Error::PendingAdminExpired))
        );
        // The expired record stays visible so operators can inspect/clear it.
        assert!(client
            .pending_admin()
            .map(|p| p.expires_at < env.ledger().timestamp())
            .unwrap_or(false));
    }

    #[test]
    fn wrong_caller_cannot_accept_admin() {
        let (env, client, admin, _) = setup();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        let bystander = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &bystander,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin()
            .is_err());
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn wrong_caller_cannot_propose_or_cancel_admin() {
        let (env, client, _, _) = setup();
        let not_admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&new_admin)
            .is_err());
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_admin,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer()
            .is_err());
    }

    // ── #299: Retroactive signing-key revocation tests ───────────────────────

    /// Helper: register an agent, add a signing key, and publish a signed trace.
    fn setup_signed_key_and_trace(
        env: &Env,
        client: &ReasoningRegistryClient<'static>,
        agent: &Address,
        key_seed: u8,
        trace_seed: u8,
    ) -> (BytesN<32>, u64, ed25519_dalek::SigningKey) {
        use ed25519_dalek::Signer;
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[key_seed; 32]);
        let pubkey_bytes: [u8; 32] = signing_key.verifying_key().to_bytes();
        let pubkey = BytesN::from_array(env, &pubkey_bytes);

        let bind_msg = env.as_contract(&client.address, || {
            ReasoningRegistry::key_bind_message(env, agent, &pubkey)
        });
        let proof_sig = BytesN::from_array(env, &signing_key.sign(&bytes_to_vec(&bind_msg)).to_bytes());
        client.add_signing_key(agent, &pubkey, &proof_sig);

        let trace_hash = BytesN::from_array(env, &[trace_seed; 32]);
        let att_msg = env.as_contract(&client.address, || {
            ReasoningRegistry::trace_attestation_message(
                env,
                agent,
                NO_MARKET,
                &TraceAction::ProposeMarket,
                &trace_hash,
            )
        });
        let trace_sig = BytesN::from_array(env, &signing_key.sign(&bytes_to_vec(&att_msg)).to_bytes());
        let trace_id = client.publish_trace_signed(
            agent,
            &NO_MARKET,
            &TraceAction::ProposeMarket,
            &trace_hash,
            &String::from_str(env, "ipfs://trace"),
            &pubkey,
            &trace_sig,
        );
        (pubkey, trace_id, signing_key)
    }

    #[test]
    fn revoke_key_taints_only_traces_at_or_after_since() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, trace_id1, _) = setup_signed_key_and_trace(&env, &client, &agent, 1, 10);
        // Advance time so the second trace has a later published_at.
        env.ledger().set_timestamp(env.ledger().timestamp() + 100);
        let (_, trace_id2, _) = setup_signed_key_and_trace(&env, &client, &agent, 1, 20);

        // Both traces are valid before revocation.
        assert!(client.verify_trace_signature(&trace_id1));
        assert!(client.verify_trace_signature(&trace_id2));
        assert_eq!(
            client.trace_verdict(&trace_id1, &BytesN::from_array(&env, &[10u8; 32])),
            TraceVerdict::Valid
        );

        // Revoke with compromised_since = time after trace_id1 but before trace_id2.
        let compromise_time = env.ledger().timestamp() - 50;
        client.revoke_signing_key(
            &agent,
            &agent,
            &pubkey,
            &compromise_time,
            &Symbol::new(&env, "leak"),
        );

        // trace_id1 (published before compromise) stays valid.
        assert!(client.verify_trace_signature(&trace_id1));
        assert_eq!(
            client.trace_verdict(&trace_id1, &BytesN::from_array(&env, &[10u8; 32])),
            TraceVerdict::Valid
        );

        // trace_id2 (published after compromise) is tainted.
        assert!(!client.verify_trace_signature(&trace_id2));
        assert_eq!(
            client.trace_verdict(&trace_id2, &BytesN::from_array(&env, &[20u8; 32])),
            TraceVerdict::KeyCompromised(compromise_time)
        );

        let _ = admin;
    }

    #[test]
    fn revoke_by_admin_and_for_retired_agent() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, trace_id, _) = setup_signed_key_and_trace(&env, &client, &agent, 2, 30);

        // Retire the agent.
        client.retire_agent(&agent);

        // Admin can still revoke the key even for a retired agent.
        let compromise_time = 0u64;
        client.revoke_signing_key(
            &admin,
            &agent,
            &pubkey,
            &compromise_time,
            &Symbol::new(&env, "admin_revoke"),
        );

        // The trace published after compromise (all traces, since time=0) is tainted.
        assert!(!client.verify_trace_signature(&trace_id));
        assert_eq!(
            client.trace_verdict(&trace_id, &BytesN::from_array(&env, &[30u8; 32])),
            TraceVerdict::KeyCompromised(0)
        );
    }

    #[test]
    fn since_can_only_move_earlier() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, _, _) = setup_signed_key_and_trace(&env, &client, &agent, 3, 40);

        let now = env.ledger().timestamp();
        client.revoke_signing_key(&agent, &agent, &pubkey, &now, &Symbol::new(&env, "first"));

        // A later compromised_since must be rejected.
        assert_eq!(
            client.try_revoke_signing_key(&agent, &agent, &pubkey, &(now + 1), &Symbol::new(&env, "second")),
            Err(Ok(Error::AlreadyRevoked))
        );

        // An earlier compromised_since is accepted.
        client.revoke_signing_key(&agent, &agent, &pubkey, &(now - 1), &Symbol::new(&env, "widened"));
    }

    #[test]
    fn since_before_added_at_rejected() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, _, _) = setup_signed_key_and_trace(&env, &client, &agent, 4, 50);
        let added_at = env.ledger().timestamp();

        // compromised_since before added_at is rejected.
        assert_eq!(
            client.try_revoke_signing_key(&agent, &agent, &pubkey, &(added_at + 1_000_000), &Symbol::new(&env, "future")),
            Err(Ok(Error::InvalidEffectiveTime))
        );
    }

    #[test]
    fn signature_verdict_returns_key_compromised() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, trace_id, _) = setup_signed_key_and_trace(&env, &client, &agent, 5, 60);

        // Before revocation, signature_verdict is Valid.
        assert_eq!(
            client.signature_verdict(&trace_id),
            SignatureVerdict::Valid
        );

        // Revoke with compromised_since = 0 (taints all traces).
        client.revoke_signing_key(&agent, &agent, &pubkey, &0u64, &Symbol::new(&env, "leak"));

        // After revocation, signature_verdict is KeyCompromised.
        assert_eq!(
            client.signature_verdict(&trace_id),
            SignatureVerdict::KeyCompromised(0)
        );
    }

    #[test]
    fn key_trace_count_and_key_traces() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, trace_id1, _) = setup_signed_key_and_trace(&env, &client, &agent, 6, 70);
        env.ledger().set_timestamp(env.ledger().timestamp() + 100);
        let (_, trace_id2, _) = setup_signed_key_and_trace(&env, &client, &agent, 6, 80);

        assert_eq!(client.key_trace_count(&pubkey), 2);
        let traces = client.key_traces(&pubkey, &0, &10);
        assert_eq!(traces.len(), 2);
        assert_eq!(traces.get(0).unwrap(), trace_id1);
        assert_eq!(traces.get(1).unwrap(), trace_id2);
    }

    #[test]
    fn key_affected_from_binary_search() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, _, _) = setup_signed_key_and_trace(&env, &client, &agent, 7, 90);
        let t1 = env.ledger().timestamp();
        env.ledger().set_timestamp(t1 + 100);
        let (_, trace_id2, _) = setup_signed_key_and_trace(&env, &client, &agent, 7, 91);
        let t2 = env.ledger().timestamp();
        env.ledger().set_timestamp(t2 + 100);
        let (_, _, _) = setup_signed_key_and_trace(&env, &client, &agent, 7, 92);

        // Search for first trace at or after t2: should be index 1.
        let idx = client.key_affected_from(&pubkey, &t2);
        assert_eq!(idx, 1);

        // Search for first trace at or after a future time: should be total (3).
        let idx_future = client.key_affected_from(&pubkey, &(t2 + 1000));
        assert_eq!(idx_future, 3);

        // Empty index.
        let empty_pk = BytesN::from_array(&env, &[99u8; 32]);
        assert_eq!(client.key_affected_from(&empty_pk, &0), 0);
    }

    #[test]
    fn other_keys_unaffected_by_revocation() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey1, trace_id1, _) = setup_signed_key_and_trace(&env, &client, &agent, 8, 100);
        let (pubkey2, trace_id2, _) = setup_signed_key_and_trace(&env, &client, &agent, 9, 110);

        // Revoke only key 1.
        client.revoke_signing_key(&agent, &agent, &pubkey1, &0u64, &Symbol::new(&env, "leak1"));

        // key1's trace is tainted.
        assert!(!client.verify_trace_signature(&trace_id1));
        // key2's trace is still valid.
        assert!(client.verify_trace_signature(&trace_id2));
    }

    #[test]
    fn verdict_precedence_hash_mismatch_over_key_compromised() {
        let (env, client, _, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, trace_id, _) = setup_signed_key_and_trace(&env, &client, &agent, 10, 120);

        // Revoke the key.
        client.revoke_signing_key(&agent, &agent, &pubkey, &0u64, &Symbol::new(&env, "leak"));

        // Hash mismatch takes precedence over KeyCompromised.
        let wrong_hash = BytesN::from_array(&env, &[255u8; 32]);
        assert_eq!(
            client.trace_verdict(&trace_id, &wrong_hash),
            TraceVerdict::HashMismatch
        );
    }

    #[test]
    fn revoke_key_unauthorized_caller_rejected() {
        let (env, client, admin, agent) = setup();
        client.register_agent(&agent);

        let (pubkey, _, _) = setup_signed_key_and_trace(&env, &client, &agent, 11, 130);

        let bystander = Address::generate(&env);
        assert_eq!(
            client.try_revoke_signing_key(&bystander, &agent, &pubkey, &0u64, &Symbol::new(&env, "bad")),
            Err(Ok(Error::Unauthorized))
        );

        let _ = admin;
    }
}
}
