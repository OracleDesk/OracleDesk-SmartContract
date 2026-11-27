//! Retention classes for every reasoning-registry storage key (#329).
//!
//! The registry is an audit log whose entries have very different lifetimes,
//! so each [`DataKey`] variant is mapped to exactly one [`RetentionClass`]
//! (the `match` in [`class_of`] is exhaustive, so adding a key without
//! classifying it fails to compile). TTL is only ever extended on **writes**
//! and by the permissionless archivist entrypoints (`extend_traces`,
//! `extend_index`, `extend_agent`); views never touch TTL, so their
//! simulations carry read-only footprints and no rent.
//!
//! | Class           | Target                                                  |
//! | --------------- | ------------------------------------------------------- |
//! | `Identity`      | `ttl::long_lived_target` (365 d, clamped to `max_ttl`)  |
//! | `Audit`         | `audit_target(close_time)` for market traces,           |
//! |                 | `long_lived_target` for `NO_MARKET` traces              |
//! | `Index`         | `max(existing TTL, target of the referenced trace)`     |
//! | `Batch`         | `long_lived_target`                                     |
//! | `Instance`      | `ttl::bump_instance` on every mutating entrypoint       |
//!
//! `ttl.rs` stays byte-identical to the other contract crates; everything
//! registry-specific lives here.

use soroban_sdk::{Env, IntoVal, Val};

use crate::{ttl, DataKey};

/// Margin added on top of `ttl::SETTLEMENT_HORIZON_SECS` for audit data, so
/// traces outlive market-core's default 365-day redemption horizon
/// (`DefaultRedeemHorizon`): buyers, resolvers and redeemers may need the
/// trace that justified a position long after the market settles.
pub const AUDIT_MARGIN_SECS: u64 = 365 * ttl::DAY_SECS;

/// Largest `ids` vector accepted by `extend_traces`.
pub const MAX_EXTEND_TRACES: u32 = 32;
/// Largest `[from, to)` range accepted by `extend_index`.
pub const MAX_EXTEND_INDEX: u64 = 64;
/// Most signing-key history records `extend_agent` extends in one call.
pub const MAX_EXTEND_KEY_HISTORY: u32 = 32;

/// How long a key class must stay live. See the module table.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetentionClass {
    /// Agent registration, chain head, signing keys, consumers: as long as
    /// the agent exists.
    Identity,
    /// A trace and its side keys: until the market's settlement horizon plus
    /// the audit margin (`NO_MARKET` traces are long-lived).
    Audit,
    /// Secondary indexes: never shorter than the newest trace they reference.
    Index,
    /// Merkle batch anchors and commit-reveal records.
    Batch,
    /// Instance storage (admin, counters, market-core address).
    Instance,
}

/// Exhaustive retention mapping for every storage key.
pub fn class_of(key: &DataKey) -> RetentionClass {
    match key {
        DataKey::Admin
        | DataKey::PendingAdmin
        | DataKey::NextId
        | DataKey::MarketCore
        | DataKey::NextBatchId
        | DataKey::ConsumerScoping
        | DataKey::ActionGrace
        | DataKey::OtherActions => RetentionClass::Instance,

        DataKey::Agent(_)
        | DataKey::AgentHead(_)
        | DataKey::AgentSigningKeys(_)
        | DataKey::KeyToAgent(_)
        | DataKey::SigningKeyHistoryCount(_)
        | DataKey::SigningKeyHistory(_, _)
        | DataKey::KeyRevocation(_)
        | DataKey::Consumer(_)
        | DataKey::AgentConsumer(_, _)
        | DataKey::AgentConsumerCount(_)
        | DataKey::AgentConsumerAt(_, _)
        | DataKey::AgentConsumerSlot(_, _)
        | DataKey::AgentDefaultConsumer(_)
        | DataKey::AgentMissedRevealCount(_)
        | DataKey::AllowedOther(_) => RetentionClass::Identity,

        DataKey::Trace(_)
        | DataKey::TraceLedger(_)
        | DataKey::TraceDecision(_)
        | DataKey::TraceLink(_)
        | DataKey::TraceSignature(_)
        | DataKey::TraceConsumer(_)
        | DataKey::Consumed(_)
        | DataKey::Flag(_)
        | DataKey::FlagHistoryCount(_)
        | DataKey::FlagHistory(_, _)
        | DataKey::AgentTrace(_, _)
        | DataKey::MarketClose(_)
        | DataKey::TraceLate(_) => RetentionClass::Audit,

        DataKey::MarketTraceCount(_)
        | DataKey::MarketTrace(_, _)
        | DataKey::AgentTraceCount(_)
        | DataKey::AgentTraceAt(_, _)
        | DataKey::MarketActionTraceCount(_, _)
        | DataKey::MarketActionTraceAt(_, _, _)
        | DataKey::AgentBatchCount(_)
        | DataKey::AgentBatch(_, _)
        | DataKey::KeyTraceCount(_)
        | DataKey::KeyTraceAt(_, _)
        | DataKey::AgentCommitCount(_)
        | DataKey::AgentCommitAt(_, _) => RetentionClass::Index,

        DataKey::Batch(_) | DataKey::BatchConsumer(_) | DataKey::TraceCommit(_) => {
            RetentionClass::Batch
        }
    }
}

/// `close_time - now + SETTLEMENT_HORIZON + AUDIT_MARGIN`, in ledgers,
/// clamped to `max_ttl()`.
pub fn audit_target(env: &Env, close_time: u64) -> u32 {
    let until_close = close_time.saturating_sub(env.ledger().timestamp());
    ttl::secs_to_ledgers_clamped(
        env,
        until_close
            .saturating_add(ttl::SETTLEMENT_HORIZON_SECS)
            .saturating_add(AUDIT_MARGIN_SECS),
    )
}

/// Target for `Identity`, `Batch` and `NO_MARKET` audit entries.
pub fn long_lived_target(env: &Env) -> u32 {
    ttl::long_lived_target(env)
}

/// Writes `value` and guarantees `key` lives at least `target` ledgers.
///
/// `extend_ttl(key, target, target)` only ever extends, so an entry that is
/// already live longer (an index whose older trace had a later close time)
/// keeps its TTL: this is the `max(existing, target)` rule.
pub fn put<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &V, target: u32) {
    env.storage().persistent().set(key, value);
    env.storage().persistent().extend_ttl(key, target, target);
}

/// Extends `key` to at least `target` if it exists. Returns whether the key
/// existed (and so was considered). Extending a missing key panics, hence
/// the `has()` guard.
pub fn extend_if_present(env: &Env, key: &DataKey, target: u32) -> bool {
    if env.storage().persistent().has(key) {
        env.storage().persistent().extend_ttl(key, target, target);
        true
    } else {
        false
    }
}

/// Refreshes a long-lived `Identity` entry from a write path, only once its
/// TTL has fallen below half the target (as `ttl::bump_persistent`), so a
/// busy agent does not pay an extension on every publish.
pub fn touch_identity(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        ttl::bump_persistent(env, key, long_lived_target(env));
    }
}
