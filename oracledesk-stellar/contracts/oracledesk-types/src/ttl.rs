//! Shared storage TTL policy (issue #371).
//!
//! Soroban archives a ledger entry once its TTL (in ledgers) runs out. An
//! archived persistent entry cannot be read or written until someone submits
//! a restore operation, and an archived **instance** entry makes the whole
//! contract uncallable until restored. Every contract in this workspace
//! therefore has to keep its entries alive at least as long as they can be
//! needed; this module is that policy.
//!
//! Previously this module was byte-identical in all four contract crates,
//! because a contract crate could not depend on another contract crate's
//! wasm exports. `oracledesk-types` has no `#[contract]` / `#[contractimpl]`
//! items (see its module doc), so it never collides on `__constructor` and
//! every contract can depend on it directly. This is now the single copy.
//!
//! Policy
//! - While a market is open, its entries are kept until `close_time +
//!   SETTLEMENT_HORIZON_SECS` ([`TtlClass::MarketOpen`]).
//! - Once final, every entry a holder needs to redeem is kept until the
//!   market's own redemption deadline, plus a small margin so a caller who
//!   shows up right at the deadline still succeeds ([`TtlClass::MarketSettling`]).
//! - Every target is clamped to `env.storage().max_ttl()` — never hardcode
//!   network limits. A deadline further out than the network maximum needs
//!   either activity (any write re-extends the entry, up to `max_ttl` each
//!   time) or the permissionless extension entrypoint / an off-chain keeper
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
//! next to a market that archives before it can be resolved or redeemed,
//! which blocks that call until a restore operation (also rent) is
//! submitted.

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

/// Time a market may need after `close_time` while it is still Open and has
/// not finalized yet: resolution and a signer dispute window. Once final,
/// [`TtlClass::MarketSettling`] takes over with the market's own redemption
/// deadline, which can be much further out.
pub const SETTLEMENT_HORIZON_SECS: u64 = 90 * DAY_SECS;

/// Target TTL for long-lived entries with no market association (registered
/// agents), so a routinely-used entry is never at risk; clamped by
/// `max_ttl()` in practice to the network maximum.
pub const LONG_LIVED_SECS: u64 = 365 * DAY_SECS;

/// Margin added past a market's redemption deadline so a `finalize_market`
/// (or any other deadline-triggered) caller that shows up right at the
/// deadline still finds the entries it needs to read live.
pub const DEADLINE_MARGIN_SECS: u64 = 7 * DAY_SECS;

/// Named storage-lifetime classes. Keeping the class (rather than a bare
/// ledger count) at call sites is what lets `target()` apply the right
/// formula without every caller re-deriving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtlClass {
    /// Instance storage: see `INSTANCE_THRESHOLD`/`INSTANCE_TARGET`.
    Instance,
    /// An entry with no market association (see `LONG_LIVED_SECS`), or a
    /// legacy final market with no known redemption deadline.
    LongLived,
    /// A still-open market: kept until `close_time + SETTLEMENT_HORIZON_SECS`.
    MarketOpen { close_time: u64 },
    /// A finalized market: kept until its own redemption `deadline`, plus
    /// `DEADLINE_MARGIN_SECS` so a caller right at the deadline still reads
    /// a live entry.
    MarketSettling { deadline: u64 },
}

/// Ledgers from now until `deadline_ts`, clamped to the network maximum.
pub fn secs_to_ledgers_clamped(env: &Env, secs: u64) -> u32 {
    let ledgers = secs / LEDGER_SECS;
    core::cmp::min(ledgers, env.storage().max_ttl() as u64) as u32
}

/// Target TTL (in ledgers from now, clamped to `max_ttl()`) for the given
/// class.
pub fn target(env: &Env, class: TtlClass) -> u32 {
    let now = env.ledger().timestamp();
    match class {
        TtlClass::Instance => INSTANCE_TARGET,
        TtlClass::LongLived => secs_to_ledgers_clamped(env, LONG_LIVED_SECS),
        TtlClass::MarketOpen { close_time } => {
            let until_close = close_time.saturating_sub(now);
            secs_to_ledgers_clamped(env, until_close.saturating_add(SETTLEMENT_HORIZON_SECS))
        }
        TtlClass::MarketSettling { deadline } => {
            let until_deadline = deadline.saturating_sub(now);
            secs_to_ledgers_clamped(env, until_deadline.saturating_add(DEADLINE_MARGIN_SECS))
        }
    }
}

/// How long a market's storage must live: until `close_time` plus the
/// settlement horizon, clamped to `max_ttl()`.
///
/// Equivalent to `target(env, TtlClass::MarketOpen { close_time })`. Kept as
/// a thin wrapper so existing call sites that only ever deal with an open
/// market (and have no lifecycle information handy) do not need to name the
/// class explicitly.
pub fn market_target(env: &Env, close_time: u64) -> u32 {
    target(env, TtlClass::MarketOpen { close_time })
}

/// Target TTL for entries with no market association. See `LONG_LIVED_SECS`.
/// Equivalent to `target(env, TtlClass::LongLived)`.
pub fn long_lived_target(env: &Env) -> u32 {
    target(env, TtlClass::LongLived)
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

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Ledger;

    fn env_at(now: u64, max_ttl: u32) -> Env {
        let env = Env::default();
        env.ledger().set_timestamp(now);
        env.ledger().set_max_entry_ttl(max_ttl);
        env
    }

    #[test]
    fn market_open_matches_close_plus_horizon() {
        let env = env_at(1_000, 1_000_000_000);
        let close_time = 1_000 + 10 * DAY_SECS;
        let got = target(&env, TtlClass::MarketOpen { close_time });
        let want = ((10 * DAY_SECS + SETTLEMENT_HORIZON_SECS) / LEDGER_SECS) as u32;
        assert_eq!(got, want);
        assert_eq!(got, market_target(&env, close_time));
    }

    #[test]
    fn market_settling_targets_deadline_plus_margin() {
        let env = env_at(1_000, 1_000_000_000);
        let deadline = 1_000 + 400 * DAY_SECS;
        let got = target(&env, TtlClass::MarketSettling { deadline });
        let want = ((400 * DAY_SECS + DEADLINE_MARGIN_SECS) / LEDGER_SECS) as u32;
        assert_eq!(got, want);
    }

    #[test]
    fn market_settling_near_deadline_still_extends_past_it() {
        // A touch one day before a deadline must still push the TTL past
        // the deadline itself (the margin, not just the shrinking target).
        let env = env_at(1_000, 1_000_000_000);
        let deadline = 1_000 + DAY_SECS;
        let got = target(&env, TtlClass::MarketSettling { deadline });
        assert!(got as u64 * LEDGER_SECS >= DAY_SECS + DEADLINE_MARGIN_SECS);
    }

    #[test]
    fn deadline_in_the_past_clamps_to_margin_only() {
        let env = env_at(10_000, 1_000_000_000);
        let got = target(&env, TtlClass::MarketSettling { deadline: 1_000 });
        assert_eq!(got, (DEADLINE_MARGIN_SECS / LEDGER_SECS) as u32);
    }

    #[test]
    fn every_class_clamps_to_max_ttl() {
        let env = env_at(1_000, 100);
        assert_eq!(
            target(
                &env,
                TtlClass::MarketOpen {
                    close_time: 1_000 + 10_000 * DAY_SECS
                }
            ),
            100
        );
        assert_eq!(
            target(
                &env,
                TtlClass::MarketSettling {
                    deadline: 1_000 + 10_000 * DAY_SECS
                }
            ),
            100
        );
        assert_eq!(target(&env, TtlClass::LongLived), 100);
    }
}
