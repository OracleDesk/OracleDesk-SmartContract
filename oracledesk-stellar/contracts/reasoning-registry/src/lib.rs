#![no_std]

// The test module builds over-length `action`/`ipfs_cid` strings with
// `str::repeat`, which lives in `alloc`/`std`; the crate itself stays
// `no_std`.
#[cfg(test)]
extern crate std;

// Issue #18 (completion): upgrade + schema-migration tests for the registry.
// `cfg(test)` keeps them out of the wasm build entirely, and the cross-version
// cases are additionally behind the opt-in `test-v2` feature so the default
// build is not widened — same pattern as market-core/resolver/treasury
// (ADR 0010 §9).
#[cfg(any(test, feature = "test-v2"))]
mod tests_upgrade;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, String, Vec,
};

mod market_core {
    #[allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "market_core.wasm");
}

/// Domain tag for commit-reveal commitments (#51). Must match
/// `agents/core/trace.ts` byte-for-byte: `sha256(TAG || trace_hash || salt)`.
pub const COMMIT_DOMAIN_TAG: &[u8] = b"oracledesk.trace.commit.v1";

/// Merkle tree constants for batch anchoring (#54).
pub const MAX_LEAVES: u32 = 4096;
pub const MAX_PROOF_LEN: u32 = 12;
pub const MERKLE_LEAF_PREFIX: u8 = 0x00;
pub const MERKLE_NODE_PREFIX: u8 = 0x01;

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceBatch {
    pub agent: Address,
    pub root: BytesN<32>,
    pub leaf_count: u32,
    pub manifest_cid: String,
    pub published_at: u64,
}

const BUMP_THRESHOLD: u32 = 30 * 17_280;
const BUMP_TO: u32 = 60 * 17_280;

// ---------------------------------------------------------------------------
// Upgrade / schema-version constants (issue #18, completion lane)
// ---------------------------------------------------------------------------

/// The storage-schema version this build writes. Bump this *only* together
/// with a real step in [`ReasoningRegistry::migrate_from`], and never lower
/// it.
///
/// `DataKey::SchemaVersion` is stamped by `__constructor` from now on, but
/// instances deployed before this feature have no such key, so readers treat
/// an absent key as [`PRE_VERSIONING_SCHEMA_VERSION`] and those deployments
/// are considered already-migrated at v1 (no migration, no re-write). Same
/// contract as market-core/resolver/treasury establish in ADR 0010 §4.
#[cfg(not(feature = "test-v2"))]
pub const SCHEMA_VERSION: u32 = 1;

/// The same constant as it looks in the *next* build: `--features test-v2`
/// compiles this crate as if it were already the post-1->2 version, which is
/// what makes the migration step in `migrate_from` reachable from a test
/// without needing a second deployed wasm. The shipped build is the
/// `cfg(not(…))` one above; enabling the feature must never be part of a
/// release build (see `[features]` in this crate's `Cargo.toml`).
#[cfg(feature = "test-v2")]
pub const SCHEMA_VERSION: u32 = 2;

/// The version implicit in every instance that predates `SchemaVersion`.
const PRE_VERSIONING_SCHEMA_VERSION: u32 = 1;

/// Upper bound on one `migrate` batch. Identical to the other three contracts'
/// value on purpose: `scripts/upgrade.sh` passes one `BATCH` to every contract
/// it drives, and the bound keeps a single call inside the instruction budget
/// no matter how many traces the deployment holds.
const MAX_MIGRATION_BATCH: u32 = 50;

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
    /// Number of traces published for a market, so a client can page through
    /// `MarketTrace(market_id, 0..count)` without the contract ever holding
    /// an unbounded Vec of trace ids in one storage entry.
    MarketTraceCount(u64),
    MarketTrace(u64, u64),
    /// Ledger sequence a trace was written in (#50). Kept beside `Trace`
    /// rather than inside it so the `Trace` XDR shape doesn't change.
    TraceLedger(u64),
    /// Contracts allowed to call `consume_trace` (#50).
    Consumer(Address),
    /// Set once a trace has backed an action (#50).
    Consumed(u64),
    /// Per-agent hash-chain head (#52).
    AgentHead(Address),
    /// Per-agent `seq -> trace_id` (#52).
    AgentTrace(Address, u64),
    /// `trace_id -> ChainLink`; absent for legacy traces (#52).
    TraceLink(u64),
    /// Number of traces published by an agent, in publish order (#57).
    AgentTraceCount(Address),
    /// `agent, index -> trace_id`, a secondary index parallel to
    /// `MarketTrace` so "everything agent X published" is one page (#57).
    AgentTraceAt(Address, u64),
    /// Number of traces for a `(market, action)` pair (#57).
    MarketActionTraceCount(u64, String),
    /// `market, action, index -> trace_id`, so "every Buy decision on market
    /// 7" is one page instead of scanning the market's whole index (#57).
    MarketActionTraceAt(u64, String, u64),
    // ---- appended by issue #18 (completion); never renumber anything above
    // this line (positional XDR, ADR 0010 §2). RE-LAYOUT NOTE for whoever
    // restores the variants this file's own code still references but this
    // enum no longer declares (`MarketCore`, `NextBatchId`, `Batch`, `Flag`,
    // `AgentSigningKeys`, `KeyToAgent`, `SigningKeyHistory*`, `TraceSignature`,
    // …; the PR body counts them): those restorations must be *re-inserted
    // above these two new keys in their original positions*, which is safe
    // only because `SchemaVersion`/`MigrationCursor`/`TraceV2` are brand-new
    // keys no pre-existing instance ever
    // wrote — renumbering them before the first deployment of this build
    // changes nothing on any ledger. Renumbering anything above the marker
    // still would.
    /// Instance storage: the storage-schema version this instance is on
    /// (issue #18). Absent means [`PRE_VERSIONING_SCHEMA_VERSION`].
    SchemaVersion,
    /// Instance storage: resume point of the bounded `migrate` loop
    /// (issue #18). Removed once the migration reaches `done`.
    MigrationCursor,
    /// Only in the `test-v2` build: the projection of a trace under its own
    /// key, written by the 1 -> 2 step. A *separate* key, so `Trace(id)`
    /// stays readable and byte-identical (ADR-0002). Not present in the
    /// default build at all, so its declaration index is unused there.
    #[cfg(feature = "test-v2")]
    TraceV2(u64),
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
    TraceAlreadyConsumed = 10,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 11,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 12,
    // ---- appended by issue #18 (completion). Error codes are append-only for
    // the same reason `DataKey` variants are (they are the on-wire value).
    // 13..=3000 are deliberately left unassigned: this file's code references
    // eighteen `Error::…` variants the enum at this tip no longer declares
    // (`FlagHistoryFull`, `InvalidProof`, `TooManyKeys`, …; the PR body lists
    // them), and only the features that shipped them know their original
    // discriminants. The registry's own numeric series continues from its
    // highest *declared* code instead of colliding with that unknown space.
    /// `migrate` called with a `batch` of 0 or larger than
    /// `MAX_MIGRATION_BATCH`, i.e. a batch that would not fit the instruction
    /// budget. Bounded by construction, so the call fails instead of trapping.
    MigrationBatchTooLarge = 3010,
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

// ---------------------------------------------------------------------------
// Upgrade / schema-migration types and events (issue #18, completion lane)
// ---------------------------------------------------------------------------

/// Resume point of the bounded `migrate` sweep; stored under
/// `DataKey::MigrationCursor`. `next_id` is the first *trace* id not yet
/// processed — the registry's own id space (`DataKey::NextId`) is the one
/// enumerable sweep, exactly like market-core sweeps `[0, NextId)` of its
/// markets; see `migrate` for what the sweep deliberately does *not* cover.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCursor {
    /// Schema version the sweep is migrating *from*, as read when it started.
    /// A cursor left behind by a different `from_version` is discarded rather
    /// than trusted.
    pub from_version: u32,
    /// First trace id not yet processed.
    pub next_id: u64,
    /// True once `next_id` has passed `DataKey::NextId`.
    pub done: bool,
}

/// What one `migrate` call reports. Returned rather than only emitted so
/// `scripts/upgrade.sh` can loop on `done` without parsing event XDR.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationProgress {
    pub from_version: u32,
    /// The version the storage is on after this call: `to_version` once the
    /// sweep finished, otherwise still `from_version`.
    pub to_version: u32,
    /// Entries rewritten by *this* call (never more than `batch`).
    pub processed: u32,
    /// First trace id not yet processed — the caller's resume point.
    pub next_id: u64,
    pub done: bool,
}

/// Emitted by `upgrade`. `update_current_contract_wasm` swaps the executing
/// code but does *not* run the new version's `__constructor`, so this event is
/// the off-chain record that the following `migrate` is mandatory, not
/// optional.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    /// Schema version in force at the moment of the swap.
    #[topic]
    pub old_version: u32,
    pub new_wasm_hash: BytesN<32>,
}

/// Emitted by `migrate` on every batch, so an indexer can follow a long
/// migration instead of only seeing its end.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Migrated {
    #[topic]
    pub from_version: u32,
    pub to_version: u32,
    pub processed: u32,
    pub done: bool,
}

/// The v2 storage shape: a *projection* of `Trace` under its own key
/// (`DataKey::TraceV2(id)`), carrying the version it was derived at. It exists
/// **only** under the opt-in `test-v2` feature.
///
/// Deliberately not a rewrite of `Trace` in place: `Trace` is what the other
/// vendored interfaces decode (ADR-0002), so a schema bump gets a *new* key
/// and leaves the old entry readable — the compatibility view ADR 0010 §2/§3
/// require. Its presence is also the migration's idempotence marker (ADR 0010
/// §7: no separate per-entry version key). A real schema bump replaces the
/// step in `migrate_from` and this type together; `Trace` itself never changes
/// shape.
#[cfg(feature = "test-v2")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceV2 {
    /// The v1 entry this projection was derived from, unchanged.
    pub v1: Trace,
    /// Schema the projection was written at.
    pub schema: u32,
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
        // Issue #18: stamp the schema this build writes. Instances deployed
        // before this line existed simply have no key, which readers treat as
        // `PRE_VERSIONING_SCHEMA_VERSION` (== this value), so a pre-existing
        // instance needs no migration to be version 1. The extend below is
        // ADR 0010 §8 applied to the registry: no instance read in this
        // contract ever bumps, so the key that decides whether a sweep is
        // pending must not be the first one this contract lets expire
        // unnoticed.
        let s = env.storage().instance();
        s.set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
        s.extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    // ----- admin ----------------------------------------------------------

    /// Starts a two-step handover of the admin role. The new admin must call
    /// `accept_admin` itself, so a typo cannot hand control to an address
    /// nobody holds.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
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
        Self::require_admin(&env)?;
        if Self::load_agent(&env, &agent).is_some() {
            return Err(Error::AgentAlreadyRegistered);
        }
        let now = env.ledger().timestamp();
        let record = AgentRecord {
            status: AgentStatus::Active,
            registered_at: now,
        };
        Self::put(&env, &DataKey::Agent(agent.clone()), &record);
        AgentRegistered { agent }.publish(&env);
        Ok(())
    }

    pub fn retire_agent(env: Env, agent: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::retire_agent_internal(&env, agent)
    }

    pub fn retire_self(env: Env, agent: Address) -> Result<(), Error> {
        agent.require_auth();
        Self::retire_agent_internal(&env, agent)
    }

    pub fn reactivate_agent(env: Env, agent: Address) -> Result<(), Error> {
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
        Self::retire_agent(env, agent)
    }

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
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        // Once an agent keeps a chained log, unchained traces would sit outside
        // it unseen, so they're refused (#52).
        if Self::load_head(&env, &agent).seq > 0 {
            return Err(Error::ChainedAgentMustChain);
        }
        Self::write_trace(&env, agent, market_id, action, trace_hash, ipfs_cid)
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
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        let head = Self::load_head(&env, &agent);
        if expected_seq != head.seq + 1 || prev_trace_hash != head.head_hash {
            return Err(Error::ChainHeadMismatch);
        }

        let id = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash.clone(),
            ipfs_cid,
        )?;

        let link_key = DataKey::TraceLink(id);
        Self::put(
            &env,
            &link_key,
            &ChainLink {
                seq: expected_seq,
                prev_trace_hash: prev_trace_hash.clone(),
            },
        );
        Self::put(&env, &DataKey::AgentTrace(agent.clone(), expected_seq), &id);
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
        Self::load_head(&env, &agent)
    }

    /// Trace id at position `seq` (1-based) of `agent`'s chain.
    pub fn agent_trace_at(env: Env, agent: Address, seq: u64) -> Result<u64, Error> {
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
        Self::require_admin(&env)?;
        Self::put(&env, &DataKey::Consumer(consumer.clone()), &true);
        ConsumerRegistered { consumer }.publish(&env);
        Ok(())
    }

    pub fn unregister_consumer(env: Env, consumer: Address) -> Result<(), Error> {
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
        // Issue #18: lazy per-trace migration before the first read of the
        // trace this consumer is about to act on (ADR 0010 §6 — a stalled
        // admin batch must never freeze the action the trace unlocks).
        Self::ensure_entry_migrated(&env, trace_id);
        let trace = Self::get_trace(env.clone(), trace_id)?;
        let key = DataKey::Consumed(trace_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::TraceAlreadyConsumed);
        }
        Self::put(&env, &key, &true);
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

    pub fn get_trace(env: Env, trace_id: u64) -> Result<Trace, Error> {
        let key = DataKey::Trace(trace_id);
        let trace: Trace = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TraceNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(trace)
    }

    pub fn flag_trace(env: Env, trace_id: u64, reason: Symbol) -> Result<(), Error> {
        Self::require_admin(&env)?;
        // Issue #18: same lazy step as `consume_trace`, on the admin's
        // integrity path this time (ADR 0010 §6).
        Self::ensure_entry_migrated(&env, trace_id);
        Self::get_trace(env.clone(), trace_id)?;
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
        Self::put(&env, &DataKey::Flag(trace_id), &flag);
        Self::put(&env, &DataKey::FlagHistory(trace_id, count), &flag);
        Self::put(&env, &count_key, &(count + 1));
        TraceFlagged { trace_id, reason }.publish(&env);
        Ok(())
    }

    pub fn unflag_trace(env: Env, trace_id: u64, reason: Symbol) -> Result<(), Error> {
        Self::require_admin(&env)?;
        Self::get_trace(env.clone(), trace_id)?;
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
        Self::put(&env, &DataKey::Flag(trace_id), &flag);
        Self::put(&env, &DataKey::FlagHistory(trace_id, count), &flag);
        Self::put(&env, &count_key, &(count + 1));
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
        Ok(TraceVerdict::Valid)
    }

    pub fn verify_trace(env: Env, trace_id: u64, received_hash: BytesN<32>) -> Result<bool, Error> {
        Ok(Self::trace_verdict(env, trace_id, received_hash)? == TraceVerdict::Valid)
    }

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
    pub fn market_action_trace_count(env: Env, market_id: u64, action: String) -> u64 {
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
        action: String,
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
        action: String,
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
        agent.require_auth();
        let record = Self::load_agent(&env, &agent).ok_or(Error::AgentNotRegistered)?;
        if !matches!(record.status, AgentStatus::Active) {
            return Err(Error::AgentNotActive);
        }
        if action.len() > MAX_ACTION_LEN {
            return Err(Error::ActionTooLong);
        }
        if ipfs_cid.is_empty() {
            return Err(Error::EmptyCid);
        }
        if ipfs_cid.len() > MAX_CID_LEN {
            return Err(Error::CidTooLong);
        }
        Ok(())
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

        // Secondary index by agent (#57).
        let agent_count_key = DataKey::AgentTraceCount(agent.clone());
        let agent_index: u64 = env.storage().persistent().get(&agent_count_key).unwrap_or(0);
        Self::put(env, &DataKey::AgentTraceAt(agent.clone(), agent_index), &id);
        Self::put(env, &agent_count_key, &(agent_index + 1));

        // Secondary index by (market, action) (#57).
        let action_count_key = DataKey::MarketActionTraceCount(market_id, action.clone());
        let action_index: u64 = env
            .storage()
            .persistent()
            .get(&action_count_key)
            .unwrap_or(0);
        Self::put(
            env,
            &DataKey::MarketActionTraceAt(market_id, action.clone(), action_index),
            &id,
        );
        Self::put(env, &action_count_key, &(action_index + 1));

        TracePublished {
            trace_id: id,
            market_id,
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
        let key = DataKey::Batch(batch_id);
        let batch: TraceBatch = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::BatchNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(batch)
    }

    pub fn batch_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextBatchId).unwrap_or(0)
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
}

    pub fn agent_batch_at(env: Env, agent: Address, index: u64) -> Result<u64, Error> {
        let key = DataKey::AgentBatch(agent, index);
        let id: u64 = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::BatchNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(id)
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

    pub fn get_signing_keys(env: Env, agent: Address) -> Vec<BytesN<32>> {
        let key = DataKey::AgentSigningKeys(agent);
        match env.storage().persistent().get::<_, Vec<BytesN<32>>>(&key) {
            Some(keys) => {
                Self::bump_persistent(&env, &key);
                keys
            }
            None => Vec::new(&env),
        }
    }

    pub fn get_key_agent(env: Env, public_key: BytesN<32>) -> Option<Address> {
        let key = DataKey::KeyToAgent(public_key);
        match env.storage().persistent().get::<_, Address>(&key) {
            Some(agent) => {
                Self::bump_persistent(&env, &key);
                Some(agent)
            }
            None => None,
        }
    }

    pub fn signing_key_history_count(env: Env, agent: Address) -> u32 {
        let key = DataKey::SigningKeyHistoryCount(agent);
        match env.storage().persistent().get::<_, u32>(&key) {
            Some(count) => {
                Self::bump_persistent(&env, &key);
                count
            }
            None => 0,
        }
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
                Self::bump_persistent(&env, &key);
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
        agent.require_auth();
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        if Self::load_head(&env, &agent).seq > 0 {
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

        let id = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash,
            ipfs_cid,
        )?;

        let sig_key = DataKey::TraceSignature(id);
        Self::put(&env, &sig_key, &(signing_key.clone(), signature));

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
        agent.require_auth();
        Self::check_publish(&env, &agent, market_id, &action, &ipfs_cid)?;
        let head = Self::load_head(&env, &agent);
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

        let id = Self::write_trace(
            &env,
            agent.clone(),
            market_id,
            action,
            trace_hash.clone(),
            ipfs_cid,
        )?;

        let link_key = DataKey::TraceLink(id);
        Self::put(
            &env,
            &link_key,
            &ChainLink {
                seq: expected_seq,
                prev_trace_hash: prev_trace_hash.clone(),
            },
        );
        Self::put(&env, &DataKey::AgentTrace(agent.clone(), expected_seq), &id);
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
        Self::put(&env, &sig_key, &(signing_key.clone(), signature));

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
        let key = DataKey::TraceSignature(trace_id);
        match env
            .storage()
            .persistent()
            .get::<_, (BytesN<32>, BytesN<64>)>(&key)
        {
            Some(sig) => {
                Self::bump_persistent(&env, &key);
                Some(sig)
            }
            None => None,
        }
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
        Self::bump_persistent(&env, &key);

        let bound_agent = Self::get_key_agent(env.clone(), signing_key.clone());
        if bound_agent.as_ref() != Some(&trace.agent) {
            return Ok(false);
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

    fn load_agent(env: &Env, addr: &Address) -> Option<AgentRecord> {
        let key = DataKey::Agent(addr.clone());
        if let Some(record) = env.storage().persistent().get::<_, AgentRecord>(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
            Some(record)
        } else if let Some(is_reg) = env.storage().persistent().get::<_, bool>(&key) {
            if is_reg {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
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

    fn validate_reference(env: &Env, market_id: u64, action: &TraceAction) -> Result<(), Error> {
        let pre_creation = matches!(action, TraceAction::ProposeMarket);
        if market_id == NO_MARKET {
            return if pre_creation || matches!(action, TraceAction::Other(_)) {
                Ok(())
            } else {
                Err(Error::MarketRequired)
            };
        }
        if pre_creation {
            return Err(Error::ProposalMustUseNoMarket);
        }
        let mc: Address = env
            .storage()
            .instance()
            .get(&DataKey::MarketCore)
            .ok_or(Error::NotInitialized)?;
        let count = market_core::Client::new(env, &mc).market_count();
        if market_id >= count {
            return Err(Error::UnknownMarket);
        }
        Ok(())
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
        Self::validate_reference(env, market_id, action)?;
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
    ) -> Result<u64, Error> {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let trace = Trace {
            market_id,
            agent: agent.clone(),
            action: action.clone(),
            trace_hash: trace_hash.clone(),
            ipfs_cid: ipfs_cid.clone(),
            published_at: env.ledger().timestamp(),
        };
        Self::put(env, &DataKey::Trace(id), &trace);
        Self::put(env, &DataKey::TraceLedger(id), &env.ledger().sequence());

        let count_key = DataKey::MarketTraceCount(market_id);
        let index: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        Self::put(env, &DataKey::MarketTrace(market_id, index), &id);
        Self::put(env, &count_key, &(index + 1));

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
        Ok(id)
    }

    /// Loads (and keeps alive) an agent's chain head. Never reset by
    /// unregister/re-register, so history can't be rewritten (#52).
    fn load_head(env: &Env, agent: &Address) -> ChainHead {
        let key = DataKey::AgentHead(agent.clone());
        match env.storage().persistent().get::<_, ChainHead>(&key) {
            Some(head) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
                head
            }
            None => ChainHead {
                seq: 0,
                head_hash: BytesN::from_array(env, &[0u8; 32]),
                head_trace_id: None,
            },
        }
    }

    fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
        env.storage().persistent().set(key, value);
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn commitment_for(env: &Env, trace_hash: &BytesN<32>, salt: &BytesN<32>) -> BytesN<32> {
        let mut bytes = Bytes::from_slice(env, COMMIT_DOMAIN_TAG);
        bytes.append(&trace_hash.clone().into());
        bytes.append(&salt.clone().into());
        env.crypto().sha256(&bytes).into()
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
}

// Issue #18: a second `#[contractimpl]` block so the three new entrypoints are
// exported without touching any existing line of the main block (soroban-sdk
// merges them; market-core and resolver put theirs inline in the main block —
// the registry's 1100-line block and its pre-existing duplicate-definition
// breakage make the separate additive block the safer hunk). It intentionally
// does *not* define another `require_admin`: this type already declares that
// helper twice at this tip (main block and the plain block above), and a third
// copy would add to the breakage rather than to the feature.
#[contractimpl]
impl ReasoningRegistry {
    // ----- upgrades (issue #18, completion lane) ----------------------------

    /// The storage-schema version this instance is on.
    ///
    /// Read-only and infallible by design: an instance deployed before this
    /// feature existed simply has no `DataKey::SchemaVersion`, and reports
    /// [`PRE_VERSIONING_SCHEMA_VERSION`] rather than `Error::NotInitialized`,
    /// so `scripts/upgrade.sh` can call it against any live deployment —
    /// including the one about to be upgraded. Extends the instance TTL
    /// because the version lives in instance storage and the registry's plain
    /// instance reads never bump it (ADR 0010 §8 — `trace_count` is the
    /// proof: it reads `NextId` and extends nothing).
    pub fn schema_version(env: Env) -> u32 {
        Self::bump_instance_ttl(&env);
        Self::load_schema_version(&env)
    }

    /// Admin-gated in-place upgrade to an already-uploaded wasm.
    ///
    /// `new_wasm_hash` is the sha256 of a wasm the caller must have installed
    /// on this network first (`stellar contract install`); it is not a file
    /// path, and `scripts/upgrade.sh` does the install before calling this.
    ///
    /// Two properties of `update_current_contract_wasm` shape the rest of
    /// this feature and are the reason `migrate` exists (issue #18's own
    /// pitfall):
    ///
    /// 1. The new version's `__constructor` does **not** run. Anything a new
    ///    build must initialise has to happen in `migrate`/`migrate_from`, not
    ///    in the constructor.
    /// 2. Storage, keys, TTLs and the admin role survive the swap untouched,
    ///    so the version read here is the version the *new* code will migrate
    ///    from. `Upgraded` records it before the swap.
    ///
    /// The registry holds no capital, but it holds the audit trail consumers
    /// like the treasury rely on (`consume_trace`, `verify_trace`), so the
    /// migration is about not breaking *evidence*, and the same ADR 0010 §1
    /// rule applies: on any network with real value the admin must be the
    /// timelock. `scripts/upgrade.sh` refuses to auto-call when the recorded
    /// admin is the timelock.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let old_version = Self::load_schema_version(&env);
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        Upgraded {
            old_version,
            new_wasm_hash,
        }
        .publish(&env);
        Ok(())
    }

    /// Bounded, resumable, idempotent migration sweep over this instance's
    /// per-trace state. Call it repeatedly with a `batch` you can afford
    /// until the returned `done` is `true` (`scripts/upgrade.sh` does exactly
    /// that).
    ///
    /// Admin-gated because it walks *every* entry; it is not required for
    /// correctness. The same step runs for a single trace lazily on the paths
    /// that touch it (`ensure_entry_migrated`), which is the deliberate choice
    /// over returning `Error::MigrationInProgress`: a stalled or never-run
    /// batch must never freeze a consumer's action (ADR 0010 §6).
    ///
    /// The sweep covers the trace id space `[0, DataKey::NextId)` — the one
    /// range this contract can enumerate on its own, exactly like market-core
    /// sweeps `[0, NextId)` of its markets. It deliberately does **not**
    /// cover the address-keyed state (`Agent`, `AgentHead`, `AgentTrace`,
    /// `Consumer`, key-binding indexes) or the market/action index keys
    /// (`MarketTrace*`, `MarketActionTrace*`): those key spaces are not
    /// enumerable from inside the contract, and under this build's
    /// append-only projection they have no legacy shape to move anyway.
    /// `done` therefore means "everything enumerable is converted", the same
    /// explicit carve-out ADR 0010 §10 records for the other three
    /// contracts — not "no v1-shaped bytes remain on this instance".
    pub fn migrate(env: Env, batch: u32) -> Result<MigrationProgress, Error> {
        Self::require_admin(&env)?;
        if batch == 0 || batch > MAX_MIGRATION_BATCH {
            return Err(Error::MigrationBatchTooLarge);
        }

        let from_version = Self::load_schema_version(&env);
        if from_version >= SCHEMA_VERSION {
            // Nothing pending, and `migrate` never rewinds: calling it on an
            // already-current instance is cheap and safe, so the deploy driver
            // may run it unconditionally right after `upgrade`.
            return Ok(MigrationProgress {
                from_version,
                to_version: from_version,
                processed: 0,
                next_id: 0,
                done: true,
            });
        }

        let total = Self::migration_bound(&env);
        let mut cursor = match Self::load_migration_cursor(&env) {
            Some(c) if c.from_version == from_version => c,
            _ => MigrationCursor {
                from_version,
                next_id: 0,
                done: false,
            },
        };

        let mut processed = 0u32;
        while processed < batch && cursor.next_id < total {
            let id = cursor.next_id;
            Self::migrate_trace_entry(&env, id, from_version);
            cursor.next_id = id + 1;
            processed += 1;
        }
        cursor.done = cursor.next_id >= total;
        let to_version = if cursor.done {
            SCHEMA_VERSION
        } else {
            from_version
        };

        // Instance writes only protect their own TTL window, so extend in the
        // same path that writes them (ADR 0010 §8).
        Self::bump_instance_ttl(&env);
        let s = env.storage().instance();
        if cursor.done {
            s.set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
            s.remove(&DataKey::MigrationCursor);
        } else {
            s.set(&DataKey::MigrationCursor, &cursor);
        }

        Migrated {
            from_version,
            to_version,
            processed,
            done: cursor.done,
        }
        .publish(&env);
        Ok(MigrationProgress {
            from_version,
            to_version,
            processed,
            next_id: cursor.next_id,
            done: cursor.done,
        })
    }
}

impl ReasoningRegistry {
    // ----- upgrade helpers (issue #18, completion lane) ---------------------

    /// The registry's instance reads never bump the instance TTL (`trace_count`
    /// and `require_admin` both read instance keys and extend nothing), so
    /// every path here that *writes* an instance key extends it in the same
    /// call — otherwise `SchemaVersion`/`MigrationCursor` would be the first
    /// keys this contract ever let expire unnoticed. Same finding resolver
    /// recorded in ADR 0010 §8; expired `SchemaVersion` silently reads back
    /// as v1.
    fn bump_instance_ttl(env: &Env) {
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    /// `DataKey::SchemaVersion` with the pre-#18 default applied (issue #18).
    fn load_schema_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(PRE_VERSIONING_SCHEMA_VERSION)
    }

    fn load_migration_cursor(env: &Env) -> Option<MigrationCursor> {
        env.storage().instance().get(&DataKey::MigrationCursor)
    }

    /// The sweep's upper bound: this contract's own trace id counter, the
    /// exact value `trace_count` publishes. Unlike treasury/resolver the
    /// bound is a *local* instance read, so there is no cross-contract
    /// dependency on the vendored `market_core.wasm` interface to hide behind
    /// a `cfg` split (ADR-0002), and the default build is one function
    /// shorter, not one behaviour different: `migrate` returns before ever
    /// reaching this read whenever the stored version is already current.
    fn migration_bound(env: &Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// Lazy, per-entry migration on the paths that mutate a trace's
    /// bookkeeping: `consume_trace` (the one every consumer takes before
    /// acting on evidence) and `flag_trace` (the admin's integrity signal).
    ///
    /// Costs one instance read and returns immediately whenever the instance
    /// is current — *always*, in the shipped build (`SCHEMA_VERSION == 1`), so
    /// the default path pays a read and nothing else. Never blocks: if the
    /// admin batch has stalled, the consumer's own transaction migrates just
    /// the trace it is about to use and proceeds (ADR 0010 §6).
    fn ensure_entry_migrated(env: &Env, trace_id: u64) {
        let from_version = Self::load_schema_version(env);
        if from_version >= SCHEMA_VERSION {
            return;
        }
        Self::migrate_trace_entry(env, trace_id, from_version);
        // A migrated entry is a persistent write; the cursor/version are not
        // touched, so a half-done migration stays half-done and resumable.
        Self::bump_instance_ttl(env);
    }

    /// One entry's migration step, shared by the lazy path and the batch
    /// sweep so the two can never disagree about what "migrated" means.
    fn migrate_trace_entry(env: &Env, trace_id: u64, from_version: u32) {
        Self::migrate_from(env, trace_id, from_version);
    }

    /// The version-specific rewrite. Idempotent by construction: the target
    /// entry doubles as the "already done" marker, so re-running a step (the
    /// lazy path and the admin batch can both hit the same trace, and a batch
    /// can be interrupted and replayed) writes nothing the second time.
    ///
    /// The default build has no pending step — v1 is current, and both callers
    /// guard before reaching here — which keeps the storage layout
    /// byte-for-byte what the vendored blobs and ADR-0002 describe. A real
    /// schema bump adds its branch here and bumps `SCHEMA_VERSION`; it must
    /// not change `Trace`'s shape in place, and it must not remove the legacy
    /// keys: every existing read path (`get_trace`, `verify_trace`,
    /// `get_trace_link`, the market indexes) still treats `Trace(id)` as
    /// authoritative, so the projection is additive state — the same rule
    /// market-core, resolver and treasury record, and reading it back here
    /// costs nothing because `Trace` is exactly the shape the consumer
    /// interfaces decode.
    ///
    /// Detection reads the source entry as an opaque `Val` and *attempts* the
    /// v1 decode, so an entry of an unrecognisable shape is left alone for a
    /// human instead of trapping the whole sweep (ADR 0010 §7).
    fn migrate_from(env: &Env, trace_id: u64, from_version: u32) {
        #[cfg(feature = "test-v2")]
        {
            if from_version < 2 {
                let storage = env.storage().persistent();
                let target = DataKey::TraceV2(trace_id);
                if storage.has(&target) {
                    // Already migrated: this entry's existence is the marker.
                    return;
                }
                let source = DataKey::Trace(trace_id);
                let Some(raw) = storage.get::<_, soroban_sdk::Val>(&source) else {
                    return;
                };
                let Ok(v1) =
                    <Trace as soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>::try_from_val(
                        env, &raw,
                    )
                else {
                    // Not a shape we understand: leave it for a human.
                    return;
                };
                let v2 = TraceV2 { v1, schema: 2 };
                storage.set(&target, &v2);
                storage.extend_ttl(&target, BUMP_THRESHOLD, BUMP_TO);
            }
        }
        #[cfg(not(feature = "test-v2"))]
        {
            let _ = (env, trace_id, from_version);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
        IntoVal,
    };

    fn register_market_core(env: &Env, admin: &Address) -> (Address, market_core::Client<'static>) {
        let treasury = Address::generate(env);
        let resolver = Address::generate(env);
        let creator = Address::generate(env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let token = soroban_sdk::token::StellarAssetClient::new(env, &collateral.address());
        token.mint(&creator, &(50_000 * 10_000_000_i128));

        let market_core_id = env.register(
            market_core::WASM,
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
    #[should_panic(expected = "Error(Contract, #4)")]
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
    #[should_panic(expected = "Error(Contract, #5)")]
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
            &TraceAction::CreateMarket,
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
}
