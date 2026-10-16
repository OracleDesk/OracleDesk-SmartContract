//! Close-time-aware storage TTL policy.
//!
//! Soroban archives a ledger entry once its TTL (in ledgers) runs out. An
//! archived persistent entry cannot be read or written until someone submits
//! a restore operation, and an archived **instance** entry makes the whole
//! contract uncallable until restored. Every contract in this workspace
//! therefore has to keep its entries alive at least as long as they can be
//! needed; this module is that policy.
//!
//! It is duplicated in all four contract crates because a contract crate
//! cannot depend on another contract crate (their `#[contractimpl]` wasm
//! exports collide on `__constructor`; see
//! `docs/adr/0002-cross-contract-calls.md`), and the copies must stay
//! byte-identical below this header.
//!
//! Policy
//! - A market's entries are kept until `close_time + SETTLEMENT_HORIZON`.
//!   Under a fixed 60-day bump a market closing more than 60 days out could
//!   archive before it closed, so the resolver's `get_market` cross-call
//!   failed until someone restored it.
//! - Every target is clamped to `env.storage().max_ttl()` — never hardcode
//!   network limits. Mainnet and testnet are both at 3_110_400 ledgers
//!   (180 days) today, so a market further than 90 days from close is capped
//!   at the network maximum and needs activity or the keeper
//!   (`docs/wave-issues/14-storage-ttl-keeper.md`) to outlive one bump.
//! - Persistent entries are only re-extended once their remaining TTL has
//!   dropped below half the target (`threshold_for`), so a busy hot path
//!   does not pay an extension write on every call.
//!
//! Rent: an extension rents `ceil(bytes / 1024) * ledgers *
//! rent_fee_per_1kb(live_state_size) / persistent_rent_rate_denominator`
//! (CAP-0066; denominator 1215, per-1KB rate interpolates from a 1_000
//! stroop floor to 10_000 as live Soroban state grows toward its target).
//! One 1-KB entry costs roughly 0.04-0.43 XLM per 30 days, so covering one
//! entry for the whole 90-day horizon costs roughly 0.13-1.28 XLM — cheap
//! next to a market that archives before it can be resolved, which blocks
//! resolution until a restore operation (also rent) is submitted.

use soroban_sdk::Env;

/// Stellar's target ledger close time. `DAY_IN_LEDGERS` assumes 5 s; if the
/// network ever re-targets close time, both values change together.
pub const LEDGER_SECS: u64 = 5;
pub const DAY_SECS: u64 = 86_400;
pub const DAY_IN_LEDGERS: u32 = (DAY_SECS / LEDGER_SECS) as u32;

/// Instance storage is bumped on every entrypoint: extend once fewer than
/// 7 days remain, out to 30. A month of cover keeps a contract invocable
/// through normal lulls while bounding the rent a single call can pay.
pub const INSTANCE_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
pub const INSTANCE_TARGET: u32 = 30 * DAY_IN_LEDGERS;

/// Time a market may need after `close_time`: resolution, a signer dispute
/// window, and holder redemptions.
pub const SETTLEMENT_HORIZON_SECS: u64 = 90 * DAY_SECS;

/// Target TTL for long-lived entries with no market association (registered
/// agents), so a routinely-used entry is never at risk; clamped by
/// `max_ttl()` in practice to the network maximum.
pub const LONG_LIVED_SECS: u64 = 365 * DAY_SECS;

/// Ledgers from now until `deadline_ts`, clamped to the network maximum.
pub fn secs_to_ledgers_clamped(env: &Env, secs: u64) -> u32 {
    let ledgers = secs / LEDGER_SECS;
    core::cmp::min(ledgers, env.storage().max_ttl() as u64) as u32
}

/// How long a market's storage must live: until `close_time` plus the
/// settlement horizon, clamped to `max_ttl()`.
pub fn market_target(env: &Env, close_time: u64) -> u32 {
    let now = env.ledger().timestamp();
    let until_close = close_time.saturating_sub(now);
    secs_to_ledgers_clamped(env, until_close.saturating_add(SETTLEMENT_HORIZON_SECS))
}

/// Target TTL for entries with no market association. See `LONG_LIVED_SECS`.
pub fn long_lived_target(env: &Env) -> u32 {
    secs_to_ledgers_clamped(env, LONG_LIVED_SECS)
}

/// Persistent entries are only re-extended when their remaining TTL has
/// fallen below half the target, which keeps touching an entry cheap.
pub fn threshold_for(target: u32) -> u32 {
    target / 2
}

/// Extends `key` toward `target` ledgers from now, if it exists and its
/// remaining TTL is under `threshold_for(target)`. Extending a missing key
/// panics, so callers must guard with `has()` where the key may be absent.
pub fn bump_persistent<K>(env: &Env, key: &K, target: u32)
where
    K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    env.storage()
        .persistent()
        .extend_ttl(key, threshold_for(target), target);
}

/// Extends instance storage to `INSTANCE_TARGET` when fewer than
/// `INSTANCE_THRESHOLD` ledgers remain. Called from every entrypoint that
/// reads instance storage — an archived instance entry bricks the contract
/// until restored, so this is the cheapest insurance the contract can buy.
pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_TARGET);
}
