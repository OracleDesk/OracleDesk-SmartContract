#![no_std]

mod math;
#[cfg(kani)]
mod math_proofs;
// Issue #18: upgrade + schema-migration tests. `cfg(test)` keeps them out of
// the wasm build entirely, and the cross-version cases are additionally
// behind the opt-in `test-v2` feature so the default build is not widened.
#[cfg(any(test, feature = "test-v2"))]
mod tests_upgrade;

use math::{MathError, Settlement, BPS, MAX_SETS};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Ledger close time is ~5s, so 17_280 ledgers ~ 1 day. Tune if that changes.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 60 * DAY_IN_LEDGERS;

/// Fee ceiling: 10%.
const MAX_FEE_BPS: u32 = 1_000;
/// Minimum seed liquidity: 100 USDC (7 decimals). Stops spam markets.
const MIN_SEED: i128 = 100 * 10_000_000;

/// A proposed admin handover must be accepted (or cancelled) within this many
/// seconds, so a proposal forgotten by the outgoing admin cannot be used to
/// seize control months later. 7 days.
const ADMIN_PROPOSAL_TTL_SECS: u64 = 7 * 86_400;

// ---------------------------------------------------------------------------
// Upgrade / schema-version constants (issue #18)
// ---------------------------------------------------------------------------

/// The storage-schema version this build writes. Bump this *only* together
/// with a real step in [`MarketCore::migrate_from`], and never lower it.
///
/// `DataKey::SchemaVersion` is written by `__constructor` from now on, but
/// instances deployed before this feature have no such key, so readers treat
/// an absent key as [`PRE_VERSIONING_SCHEMA_VERSION`] and those deployments
/// are considered already-migrated at v1 (no migration, no re-write).
#[cfg(not(feature = "test-v2"))]
pub const SCHEMA_VERSION: u32 = 1;

/// The same constant as it looks in the *next* build: `--features test-v2`
/// compiles this crate as if it were already the post-1->2 version, which is
/// what makes the migration steps in `migrate_from` reachable from a test
/// without needing a second deployed wasm. The shipped build is the `cfg(not(…))`
/// one above; enabling the feature must never be part of a release build
/// (see `[features]` in this crate's `Cargo.toml`).
#[cfg(feature = "test-v2")]
pub const SCHEMA_VERSION: u32 = 2;

/// The version implicit in every instance that predates `SchemaVersion`.
const PRE_VERSIONING_SCHEMA_VERSION: u32 = 1;

/// Upper bound on one `migrate` batch. A migration step costs at most a
/// handful of ledger-entry reads/writes per market, so this bound keeps a
/// single call inside the instruction budget no matter how many markets the
/// deployment has; `scripts/upgrade.sh` loops it to completion.
const MAX_MIGRATION_BATCH: u32 = 50;

// ---------------------------------------------------------------------------
// Types shared with the frontend/backend
// ---------------------------------------------------------------------------
// The canonical definitions live in `oracledesk-types` and are re-exported
// here so every consumer (contracts, generated bindings, off-chain tooling)
// sees one Rust type. `#[contracttype]` still exports them into this
// contract's spec, so generated TypeScript bindings are unchanged.
pub use oracledesk_types::{Category, MarketStatus, Outcome};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub creator: Address,
    /// sha256 of the canonical question JSON stored off-chain (IPFS), so a
    /// client can prove the text it shows is the text that was committed.
    pub question_hash: BytesN<32>,
    /// Commitment to how this market will be resolved, fixed at creation so
    /// the creator cannot pick favorable resolution rules after seeing
    /// trading activity. The resolver contract verifies a revealed spec
    /// against this hash before configuring itself for the market. See
    /// `docs/adr/0001-resolution-commitment.md`.
    pub resolution_hash: BytesN<32>,
    /// IPFS CID / URI of the question metadata.
    pub meta_uri: String,
    pub category: Category,
    /// Unix seconds (ledger timestamp). Trading stops at this time.
    pub close_time: u64,
    /// Snapshot of the fee at creation so later config changes never move it.
    pub fee_bps: u32,
    pub status: MarketStatus,
    pub reserve_yes: i128,
    pub reserve_no: i128,
    /// Complete sets in existence == collateral locked for this market.
    pub sets_minted: i128,
    /// Trading fees waiting for `sweep_fees`.
    pub fees_accrued: i128,
    /// Creator has withdrawn the pool remainder after finality.
    pub lp_claimed: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Position {
    pub yes: i128,
    pub no: i128,
}

/// Fee destination and split, snapshotted per market at creation as a side
/// entry (`DataKey::FeeTerms`) so `Market`'s XDR shape never changes.
///
/// Markets created before this entry existed have no `FeeTerms` and keep the
/// legacy behaviour: `sweep_fees` pays whatever `DataKey::Treasury` holds at
/// sweep time, with the protocol keeping 100% of the fee. That fallback is
/// documented in `sweep_fees` and makes the upgrade migration-free.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeTerms {
    /// Where the protocol's fee share is swept. Frozen at creation: later
    /// `set_treasury` calls never redirect fees already earned.
    pub recipient: Address,
    /// Protocol's share of each trade fee in bps; the rest is the LP's.
    /// 0..=BPS. At BPS (the default) the split is exactly today's behaviour.
    pub protocol_share_bps: u32,
}

/// Per-market circuit breakers, snapshotted at creation from
/// `DataKey::DefaultBreaker`. 0 disables each check. A market without a
/// `Breaker` entry (created before breakers existed) is never checked.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BreakerConfig {
    /// Maximum |post-price - pre-price| a single trade may move in bps.
    pub max_impact_bps: u32,
    /// Maximum |post-price - ledger-open price| cumulative movement in bps.
    pub band_bps: u32,
}

/// Temporary (one ledger) band reference for a market.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BandState {
    pub ledger_seq: u32,
    pub ref_price_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub collateral: Address,
    pub treasury: Address,
    pub resolver: Address,
    pub default_fee_bps: u32,
    pub protocol_fee_share_bps: u32,
    pub paused: bool,
}

/// A proposed admin handover (#62). Absent when no transfer is pending.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub address: Address,
    pub expires_at: u64,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    // instance storage (one entry, shared TTL): global config
    Admin,
    PendingAdmin,
    Collateral,
    Treasury,
    Resolver,
    PendingResolver,
    PendingTreasury,
    DefaultFeeBps,
    ProtocolFeeShareBps,
    DefaultBreaker,
    Paused,
    NextId,
    // persistent storage (one entry each, own TTL)
    Market(u64),
    Position(u64, Address),
    FeeTerms(u64),
    LpFees(u64),
    Breaker(u64),
    // temporary storage (expires on its own, one entry per market)
    Band(u64),
    // ---- appended by issue #18; never renumber anything above this line ----
    // Existing variants keep their declaration index: `#[contracttype]` enums
    // serialise by *position*, so inserting or reordering one would change the
    // XDR of every stored key and silently break ADR-0001's hash commitments
    // (and the vendored `market_core.wasm` that resolver/treasury compile
    // against). New keys therefore go at the tail.
    /// Instance storage: the storage-schema version this instance is on
    /// (issue #18). Absent means [`PRE_VERSIONING_SCHEMA_VERSION`].
    SchemaVersion,
    /// Instance storage: resume point of the bounded `migrate` loop
    /// (issue #18). Removed once the migration reaches `done`.
    MigrationCursor,
    /// Only in the `test-v2` build: the v2 projection of a market, written by
    /// the 1 -> 2 step. It is a *separate* key, so the migration never rewrites
    /// `DataKey::Market(id)` and `Market`'s shape stays byte-identical to the
    /// `market_core.wasm` vendored by resolver/treasury (ADR-0002). Not present
    /// in the default build at all, so its declaration index is unused there.
    #[cfg(feature = "test-v2")]
    MarketV2(u64),
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    Paused = 2,
    InvalidFee = 3,
    InvalidAmount = 4,
    InvalidProbability = 5,
    InvalidCloseTime = 6,
    MarketNotFound = 7,
    MarketNotOpen = 8,
    MarketClosed = 9,
    NotClosedYet = 10,
    NotFinal = 11,
    SlippageExceeded = 12,
    InsufficientShares = 13,
    InsufficientLiquidity = 14,
    MarketTooLarge = 15,
    NothingToRedeem = 16,
    AlreadyClaimed = 17,
    Overflow = 18,
    /// `buy_v2` / `sell_v2` called with `env.ledger().timestamp() > deadline`.
    DeadlineExpired = 19,
    /// `buy_v2` / `sell_v2` average execution price worse than the limit.
    LimitPriceExceeded = 20,
    /// A single trade would move the price more than `max_impact_bps`.
    /// (Both this and the band reject the whole invocation, so their events,
    /// if any, roll back with it — see the note on `BreakerConfig`.)
    PriceImpactTooHigh = 21,
    /// Cumulative same-ledger movement would exceed `band_bps`.
    PriceBandExceeded = 22,
    NoPendingWiring = 23,
    InvalidWiring = 24,
    /// `accept_admin`/`cancel_admin_transfer` called with nothing proposed.
    NoPendingAdmin = 25,
    /// A proposed admin handover was not accepted within its `expires_at`.
    PendingAdminExpired = 26,
    // ---- appended by issue #18. Error codes are append-only for the same
    // reason `DataKey` variants are (they are the on-wire value). 27..=29 are
    // deliberately skipped: our own PR #184 claims 27 (`MetaUriTooLong`) on
    // this very enum and #167/#161 are expected to take 28..=29. Claiming a
    // number two features ahead is exactly how `treasury` grew five duplicate
    // discriminants and broke with E0081 — see ADR 0010.
    /// `migrate` called with a `batch` of 0 or larger than
    /// `MAX_MIGRATION_BATCH`, i.e. a batch that would not fit the instruction
    /// budget. Bounded by construction, so the call fails instead of trapping.
    MigrationBatchTooLarge = 30,
}

impl From<MathError> for Error {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => Error::Overflow,
            MathError::InvalidInput => Error::InvalidAmount,
            MathError::InsufficientLiquidity => Error::InsufficientLiquidity,
        }
    }
}

// ---------------------------------------------------------------------------
// Events (the backend indexes these into Postgres; RPC keeps only a short
// event window, so do not rely on querying old events live)
// ---------------------------------------------------------------------------

#[contractevent]
pub struct MarketCreated {
    #[topic]
    pub market_id: u64,
    pub creator: Address,
    pub category: Category,
    pub close_time: u64,
    pub seed_amount: i128,
    pub initial_yes_bps: u32,
}

#[contractevent]
pub struct Trade {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub trader: Address,
    pub outcome: Outcome,
    pub is_buy: bool,
    pub collateral: i128,
    pub shares: i128,
    pub fee: i128,
    pub reserve_yes: i128,
    pub reserve_no: i128,
}

#[contractevent]
pub struct MarketResolved {
    #[topic]
    pub market_id: u64,
    /// None means the market was voided.
    pub outcome: Option<Outcome>,
}

#[contractevent]
pub struct Redeemed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub holder: Address,
    pub payout: i128,
}

#[contractevent]
pub struct FeesSwept {
    #[topic]
    pub market_id: u64,
    pub amount: i128,
}

/// Same sweep as `FeesSwept` plus the actual recipient. New event rather
/// than new fields so the existing `FeesSwept` XDR stays stable for
/// indexers; both are emitted on every sweep.
#[contractevent]
pub struct FeesSweptTo {
    #[topic]
    pub market_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
pub struct LpFeesClaimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub creator: Address,
    pub amount: i128,
}

#[contractevent]
pub struct PoolRemainderClaimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub creator: Address,
    /// Pool remainder plus any LP fees drained in the same call.
    pub payout: i128,
}

#[contractevent]
pub struct TreasuryChanged {
    pub old: Address,
    pub new: Address,
}

#[contractevent]
pub struct ResolverProposed {
    pub resolver: Address,
}
#[contractevent]
pub struct ResolverChanged {
    pub old: Address,
    pub new: Address,
}
#[contractevent]
pub struct TreasuryProposed {
    pub treasury: Address,
}

#[contractevent]
pub struct AdminTransferProposed {
    pub new_admin: Address,
}
#[contractevent]
pub struct AdminTransferred {
    pub old: Address,
    pub new: Address,
}
#[contractevent]
pub struct AdminTransferCancelled {}

#[soroban_sdk::contractclient(name = "WiringPeerClient")]
pub trait WiringPeer {
    fn market_core(env: Env) -> Address;
}

#[contractevent]
pub struct ProtocolFeeShareChanged {
    pub old: u32,
    pub new: u32,
}

/// Positions moved between holders. Indexers that track balances from
/// `Trade`/`Redeemed` must also apply this event (see docs/architecture.md).
#[contractevent]
pub struct PositionTransferred {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub from: Address,
    pub to: Address,
    pub outcome: Outcome,
    pub amount: i128,
}

#[contractevent]
pub struct LpTransferred {
    #[topic]
    pub market_id: u64,
    pub from: Address,
    pub to: Address,
}

// ---------------------------------------------------------------------------
// Upgrade / schema-migration types (issue #18)
// ---------------------------------------------------------------------------

/// Resume point of the bounded `migrate` sweep, in instance storage under
/// `DataKey::MigrationCursor`.
///
/// `next_id` is the first market id not yet processed, so an interrupted run
/// continues exactly where it stopped and a re-run over already-migrated
/// entries is a no-op (`migrate_market_entry` is idempotent by decode).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCursor {
    /// Schema version the sweep is migrating *from*, as read when it started.
    /// A cursor left behind by a different `from_version` is discarded rather
    /// than trusted.
    pub from_version: u32,
    /// First market id not yet processed.
    pub next_id: u64,
    /// True once `next_id` has passed the last market id.
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
    /// First market id not yet processed — the caller's resume point.
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

/// The v2 storage shape: a *projection* of `Market` under its own key
/// (`DataKey::MarketV2(id)`), carrying the version it was derived at. It exists
/// **only** under the opt-in `test-v2` feature.
///
/// Deliberately not a rewrite of `Market` in place. `Market`'s field list is
/// what resolver's and treasury's vendored `market_core.wasm` decodes
/// (`contractimport!`, ADR-0002), and those blobs cannot be rebuilt on a normal
/// dev box, so a schema bump gets a *new* key and keeps the old entry readable
/// — the "market-core first with a compatibility view" order in ADR 0010. Its
/// presence is also the migration's idempotence marker, which is why there is
/// no separate per-market version key (see `migrate_from` and ADR 0010's
/// storage-cost comparison).
///
/// A real schema bump replaces the step in `migrate_from` and this type
/// together; `Market` itself never changes shape.
#[cfg(feature = "test-v2")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketV2 {
    /// The v1 entry this projection was derived from, unchanged.
    pub v1: Market,
    /// Schema the projection was written at.
    pub schema: u32,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MarketCore;

#[contractimpl]
impl MarketCore {
    /// Runs atomically at deploy time, so nobody can front-run initialization.
    /// `protocol_fee_share_bps` is the default protocol/LP split for new
    /// markets; 10_000 keeps the whole fee with the protocol (pre-upgrade
    /// behaviour). Pass 0 to give all fees to the market creators.
    pub fn __constructor(
        env: Env,
        admin: Address,
        collateral: Address,
        treasury: Address,
        resolver: Address,
        default_fee_bps: u32,
        protocol_fee_share_bps: u32,
    ) {
        if default_fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        if protocol_fee_share_bps as i128 > BPS {
            panic_with_error!(&env, Error::InvalidFee);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Collateral, &collateral);
        s.set(&DataKey::Treasury, &treasury);
        s.set(&DataKey::Resolver, &resolver);
        s.set(&DataKey::DefaultFeeBps, &default_fee_bps);
        s.set(&DataKey::ProtocolFeeShareBps, &protocol_fee_share_bps);
        s.set(&DataKey::Paused, &false);
        s.set(&DataKey::NextId, &0u64);
        // Issue #18: stamp the schema this build writes. Instances deployed
        // before this line existed simply have no key, which readers treat as
        // `PRE_VERSIONING_SCHEMA_VERSION` (== this value), so a pre-existing
        // instance needs no migration to be version 1.
        s.set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
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
        let old: Address = Self::instance_get(&env, &DataKey::Admin)?;
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

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Affects markets created after the call; existing markets keep their fee.
    pub fn set_default_fee_bps(env: Env, fee_bps: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        env.storage()
            .instance()
            .set(&DataKey::DefaultFeeBps, &fee_bps);
        Ok(())
    }

    // ----- upgrades (issue #18) -------------------------------------------

    /// The storage-schema version this instance is on.
    ///
    /// Read-only and infallible by design: an instance deployed before this
    /// feature existed simply has no `DataKey::SchemaVersion`, and reports
    /// [`PRE_VERSIONING_SCHEMA_VERSION`] rather than `Error::NotInitialized`,
    /// so the accessor is safe to call on any live deployment.
    pub fn schema_version(env: Env) -> u32 {
        Self::load_schema_version(&env)
    }

    /// Admin-gated in-place upgrade to an already-uploaded wasm.
    ///
    /// `new_wasm_hash` is the sha256 of a wasm the caller must have installed
    /// on this network first (`stellar contract install`); it is not a file
    /// path, and `scripts/upgrade.sh` does the install before calling this.
    ///
    /// Two properties of `update_current_contract_wasm` shape the rest of this
    /// feature and are the reason `migrate` exists (issue #18's own pitfall):
    ///
    /// 1. The new version's `__constructor` does **not** run. Anything a new
    ///    build must initialise has to happen in `migrate`/`migrate_from`, not
    ///    in the constructor — which is why the constructor here only *stamps*
    ///    the version and every later change is a migration step.
    /// 2. Storage, keys, TTLs and the admin role survive the swap untouched,
    ///    so the version read here is the version the *new* code will migrate
    ///    from. `Upgraded` records it before the swap.
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
    /// markets. Call it repeatedly with a `batch` you can afford until the
    /// returned `done` is `true` (`scripts/upgrade.sh` does exactly that).
    ///
    /// Admin-gated because it walks *every* entry; it is not required for
    /// correctness. The same step runs for a single entry lazily on the paths
    /// that touch it (`ensure_entry_migrated`), which is the deliberate choice
    /// over the issue's alternative of returning `Error::MigrationInProgress`:
    /// a stalled or never-run batch must never freeze user funds — see ADR
    /// 0010 ("gating").
    pub fn migrate(env: Env, batch: u32) -> Result<MigrationProgress, Error> {
        Self::require_admin(&env)?;
        if batch == 0 || batch > MAX_MIGRATION_BATCH {
            return Err(Error::MigrationBatchTooLarge);
        }

        let from_version = Self::load_schema_version(&env);
        let total = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(0u64);

        if from_version >= SCHEMA_VERSION {
            // Nothing pending, and `migrate` never rewinds: calling it on an
            // already-current instance is cheap and safe, so the deploy driver
            // may run it unconditionally right after `upgrade`.
            return Ok(MigrationProgress {
                from_version,
                to_version: from_version,
                processed: 0,
                next_id: total,
                done: true,
            });
        }

        // Resume only a cursor that belongs to this migration. A stale cursor
        // (written before a later upgrade moved `from_version`) is discarded
        // and the sweep restarts from 0 — entries already converted are
        // detected as such, so restarting costs reads, not correctness.
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
            Self::migrate_market_entry(&env, id, from_version);
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
        // same path that writes them (ADR 0010, "instance TTL").
        let s = env.storage().instance();
        s.extend_ttl(BUMP_THRESHOLD, BUMP_TO);
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

    pub fn propose_resolver(env: Env, resolver: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingResolver, &resolver);
        ResolverProposed { resolver }.publish(&env);
        Ok(())
    }

    pub fn accept_resolver(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingResolver)
            .ok_or(Error::NoPendingWiring)?;
        pending.require_auth();
        if WiringPeerClient::new(&env, &pending).market_core() != env.current_contract_address() {
            return Err(Error::InvalidWiring);
        }
        let old: Address = Self::instance_get(&env, &DataKey::Resolver)?;
        env.storage().instance().set(&DataKey::Resolver, &pending);
        env.storage().instance().remove(&DataKey::PendingResolver);
        ResolverChanged { old, new: pending }.publish(&env);
        Ok(())
    }

    /// Affects markets created after the call and the legacy fallback in
    /// `sweep_fees`. Markets with a snapshotted `FeeTerms` keep paying their
    /// original recipient.
    pub fn propose_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingTreasury, &treasury);
        TreasuryProposed { treasury }.publish(&env);
        Ok(())
    }

    pub fn accept_treasury(env: Env) -> Result<(), Error> {
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingTreasury)
            .ok_or(Error::NoPendingWiring)?;
        treasury.require_auth();
        if WiringPeerClient::new(&env, &treasury).market_core() != env.current_contract_address() {
            return Err(Error::InvalidWiring);
        }
        let old: Address = Self::instance_get(&env, &DataKey::Treasury)?;
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().remove(&DataKey::PendingTreasury);
        TreasuryChanged { old, new: treasury }.publish(&env);
        Ok(())
    }

    /// Affects markets created after the call; existing markets keep the
    /// split they snapshotted at creation.
    pub fn set_protocol_fee_share_bps(env: Env, share_bps: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if share_bps as i128 > BPS {
            return Err(Error::InvalidFee);
        }
        let old: u32 = Self::instance_get(&env, &DataKey::ProtocolFeeShareBps)?;
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeShareBps, &share_bps);
        ProtocolFeeShareChanged {
            old,
            new: share_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Sets the breaker defaults copied into markets created after the call.
    /// `band_bps < max_impact_bps` (both non-zero) is rejected: a single
    /// trade that is allowed by the impact cap could then never fit inside
    /// the band, locking trading.
    pub fn set_default_breaker(env: Env, breaker: BreakerConfig) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if breaker.max_impact_bps as i128 > BPS || breaker.band_bps as i128 > BPS {
            return Err(Error::InvalidAmount);
        }
        if breaker.max_impact_bps > 0
            && breaker.band_bps > 0
            && breaker.band_bps < breaker.max_impact_bps
        {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::DefaultBreaker, &breaker);
        Ok(())
    }

    // ----- market lifecycle -----------------------------------------------

    /// Creates a market and seeds the pool. `creator` becomes the sole LP.
    /// `initial_yes_bps` in [100, 9900] sets the opening YES probability;
    /// the creator receives the leftover shares of the likelier outcome.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        env: Env,
        creator: Address,
        question_hash: BytesN<32>,
        resolution_hash: BytesN<32>,
        meta_uri: String,
        category: Category,
        close_time: u64,
        seed_amount: i128,
        initial_yes_bps: u32,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        creator.require_auth();

        if close_time <= env.ledger().timestamp() {
            return Err(Error::InvalidCloseTime);
        }
        if !(MIN_SEED..=MAX_SETS).contains(&seed_amount) {
            return Err(Error::InvalidAmount);
        }
        if !(math::MIN_PROB_BPS..=math::MAX_PROB_BPS).contains(&initial_yes_bps) {
            return Err(Error::InvalidProbability);
        }
        let seed = math::seed_reserves(seed_amount, initial_yes_bps)?;

        let s = env.storage().instance();
        let id: u64 = s.get(&DataKey::NextId).ok_or(Error::NotInitialized)?;
        s.set(&DataKey::NextId, &(id + 1));
        let fee_bps: u32 = s
            .get(&DataKey::DefaultFeeBps)
            .ok_or(Error::NotInitialized)?;
        let protocol_share_bps: u32 = s
            .get(&DataKey::ProtocolFeeShareBps)
            .ok_or(Error::NotInitialized)?;
        let treasury: Address = s.get(&DataKey::Treasury).ok_or(Error::NotInitialized)?;
        let breaker: Option<BreakerConfig> = s.get(&DataKey::DefaultBreaker);

        let market = Market {
            creator: creator.clone(),
            question_hash,
            resolution_hash,
            meta_uri,
            category,
            close_time,
            fee_bps,
            status: MarketStatus::Open,
            reserve_yes: seed.reserve_yes,
            reserve_no: seed.reserve_no,
            sets_minted: seed_amount,
            fees_accrued: 0,
            lp_claimed: false,
        };
        Self::save_market(&env, id, &market);
        Self::save_fee_terms(
            &env,
            id,
            &FeeTerms {
                recipient: treasury,
                protocol_share_bps,
            },
        );
        if let Some(b) = breaker {
            Self::save_breaker(&env, id, &b);
        }
        if seed.creator_yes > 0 || seed.creator_no > 0 {
            Self::save_position(
                &env,
                id,
                &creator,
                &Position {
                    yes: seed.creator_yes,
                    no: seed.creator_no,
                },
            );
        }

        Self::token(&env)?.transfer(&creator, env.current_contract_address(), &seed_amount);

        MarketCreated {
            market_id: id,
            creator,
            category,
            close_time,
            seed_amount,
            initial_yes_bps,
        }
        .publish(&env);
        Ok(id)
    }

    // ----- trading --------------------------------------------------------

    /// Spend `collateral_in` to buy `outcome` shares. Returns shares received.
    /// Reverts if fewer than `min_shares_out` would be received.
    ///
    /// Legacy entrypoint: no deadline and no limit price, so a signed bound
    /// can execute at any later time. Prefer `buy_v2`.
    pub fn buy(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
    ) -> Result<i128, Error> {
        Self::do_buy(
            env,
            trader,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            None,
        )
    }

    /// `buy` plus a deadline (`env.ledger().timestamp()` seconds — network
    /// time, not the client clock) and an average-price limit
    /// (`limit_price_bps` per share, 1.0 = BPS; 0 = no limit).
    ///
    /// The average price includes the fee (`fee` is part of `collateral_in`)
    /// and, for a NO buy, is compared against the NO price. Because the
    /// deadline check runs before `require_auth`, an expired transaction
    /// fails cheaply. A limit above BPS can never pass for a buy and is
    /// rejected as invalid.
    #[allow(clippy::too_many_arguments)]
    pub fn buy_v2(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }
        Self::do_buy(
            env,
            trader,
            market_id,
            outcome,
            collateral_in,
            min_shares_out,
            if limit_price_bps == 0 {
                None
            } else {
                Some(limit_price_bps)
            },
        )
    }

    /// Shared implementation of `buy` / `buy_v2` (single copy of the
    /// breaker, effect and interaction logic).
    #[allow(clippy::too_many_arguments)]
    fn do_buy(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
        min_shares_out: i128,
        limit_price_bps: Option<u32>,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        if let Some(limit) = limit_price_bps {
            if limit as i128 > BPS {
                return Err(Error::InvalidAmount);
            }
        }
        trader.require_auth();
        Self::ensure_entry_migrated(&env, market_id);
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?;
        if q.shares_out < min_shares_out {
            return Err(Error::SlippageExceeded);
        }
        if let Some(limit) = limit_price_bps {
            if !math::buy_within_limit(collateral_in, q.shares_out, limit)? {
                return Err(Error::LimitPriceExceeded);
            }
        }
        Self::check_breakers(
            &env,
            market_id,
            &m,
            outcome,
            q.new_reserve_bought,
            q.new_reserve_other,
        )?;
        let new_sets = m.sets_minted.checked_add(q.net).ok_or(Error::Overflow)?;
        if new_sets > MAX_SETS {
            return Err(Error::MarketTooLarge);
        }

        // effects
        Self::set_reserves(&mut m, outcome, q.new_reserve_bought, q.new_reserve_other);
        m.sets_minted = new_sets;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        let mut pos = Self::load_position(&env, market_id, &trader);
        match outcome {
            Outcome::Yes => pos.yes += q.shares_out,
            Outcome::No => pos.no += q.shares_out,
        }
        Self::save_position(&env, market_id, &trader, &pos);
        Self::save_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&trader, env.current_contract_address(), &collateral_in);

        Trade {
            market_id,
            trader,
            outcome,
            is_buy: true,
            collateral: collateral_in,
            shares: q.shares_out,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        Ok(q.shares_out)
    }

    /// Receive exactly `collateral_out` by selling `outcome` shares. Returns
    /// shares sold. Reverts if more than `max_shares_in` would be needed.
    /// Clients turn "sell N shares" into `collateral_out` off-chain
    /// (see `math::calc_sell` docs) and add a slippage margin to `max_shares_in`.
    ///
    /// Legacy entrypoint: no deadline and no limit price. Prefer `sell_v2`.
    pub fn sell(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
    ) -> Result<i128, Error> {
        Self::do_sell(
            env,
            trader,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            None,
        )
    }

    /// `sell` plus a deadline (ledger timestamp, seconds) and a minimum
    /// average execution price (`limit_price_bps` per share, 1.0 = BPS).
    ///
    /// A zero limit is trivially satisfied for sells — unlike buys, where 0
    /// means "no limit" — and a limit above BPS can never pass, so neither
    /// needs a special case. The average includes the fee, which the trader
    /// pays out of the gross.
    #[allow(clippy::too_many_arguments)]
    pub fn sell_v2(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: u32,
        deadline: u64,
    ) -> Result<i128, Error> {
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }
        Self::do_sell(
            env,
            trader,
            market_id,
            outcome,
            collateral_out,
            max_shares_in,
            if limit_price_bps == 0 {
                None
            } else {
                Some(limit_price_bps)
            },
        )
    }

    /// Shared implementation of `sell` / `sell_v2`.
    #[allow(clippy::too_many_arguments)]
    fn do_sell(
        env: Env,
        trader: Address,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
        max_shares_in: i128,
        limit_price_bps: Option<u32>,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        trader.require_auth();
        Self::ensure_entry_migrated(&env, market_id);
        let mut m = Self::load_market(&env, market_id)?;
        Self::assert_tradable(&env, &m)?;

        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_sell(r_sold, r_other, collateral_out, m.fee_bps)?;
        if q.shares_in > max_shares_in {
            return Err(Error::SlippageExceeded);
        }
        if let Some(limit) = limit_price_bps {
            if !math::sell_within_limit(collateral_out, q.shares_in, limit)? {
                return Err(Error::LimitPriceExceeded);
            }
        }
        Self::check_breakers(
            &env,
            market_id,
            &m,
            outcome,
            q.new_reserve_sold,
            q.new_reserve_other,
        )?;

        let mut pos = Self::load_position(&env, market_id, &trader);
        let held = match outcome {
            Outcome::Yes => pos.yes,
            Outcome::No => pos.no,
        };
        if held < q.shares_in {
            return Err(Error::InsufficientShares);
        }

        // effects
        match outcome {
            Outcome::Yes => pos.yes -= q.shares_in,
            Outcome::No => pos.no -= q.shares_in,
        }
        Self::save_position(&env, market_id, &trader, &pos);
        Self::set_reserves(&mut m, outcome, q.new_reserve_sold, q.new_reserve_other);
        m.sets_minted -= q.gross;
        let protocol_fee = Self::accrue_fees(&env, market_id, q.fee)?;
        m.fees_accrued = m
            .fees_accrued
            .checked_add(protocol_fee)
            .ok_or(Error::Overflow)?;
        Self::save_market(&env, market_id, &m);

        // interaction
        Self::token(&env)?.transfer(&env.current_contract_address(), &trader, &collateral_out);

        Trade {
            market_id,
            trader,
            outcome,
            is_buy: false,
            collateral: collateral_out,
            shares: q.shares_in,
            fee: q.fee,
            reserve_yes: m.reserve_yes,
            reserve_no: m.reserve_no,
        }
        .publish(&env);
        Ok(q.shares_in)
    }

    // ----- resolution -----------------------------------------------------
    // Only the configured resolver contract may call these. When the resolver
    // contract is the direct caller, `require_auth` on its address passes.

    pub fn resolve(env: Env, market_id: u64, outcome: Outcome) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        Self::ensure_entry_migrated(&env, market_id);
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() < m.close_time {
            return Err(Error::NotClosedYet);
        }
        m.status = MarketStatus::Resolved(outcome);
        Self::save_market(&env, market_id, &m);
        MarketResolved {
            market_id,
            outcome: Some(outcome),
        }
        .publish(&env);
        Ok(())
    }

    /// Invalid or unresolvable market. Allowed any time before finality.
    pub fn void_market(env: Env, market_id: u64) -> Result<(), Error> {
        Self::require_resolver(&env)?;
        Self::ensure_entry_migrated(&env, market_id);
        let mut m = Self::load_market(&env, market_id)?;
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        m.status = MarketStatus::Void;
        Self::save_market(&env, market_id, &m);
        MarketResolved {
            market_id,
            outcome: None,
        }
        .publish(&env);
        Ok(())
    }

    // ----- settlement -----------------------------------------------------

    /// Pays out `holder`'s position for a final market and clears it.
    /// Losing positions clear with a payout of 0.
    pub fn redeem(env: Env, holder: Address, market_id: u64) -> Result<i128, Error> {
        holder.require_auth();
        Self::ensure_entry_migrated(&env, market_id);
        let m = Self::load_market(&env, market_id)?;
        let kind = Self::settlement(&m)?;
        let pos = Self::load_position(&env, market_id, &holder);
        if pos.yes == 0 && pos.no == 0 {
            return Err(Error::NothingToRedeem);
        }
        let payout = math::settle_value(kind, pos.yes, pos.no);

        Self::save_position(&env, market_id, &holder, &Position { yes: 0, no: 0 });
        if payout > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &holder, &payout);
        }
        Redeemed {
            market_id,
            holder,
            payout,
        }
        .publish(&env);
        Ok(payout)
    }

    /// Creator (the LP) withdraws whatever the pool still holds once final,
    /// plus any unclaimed LP fees. Returns the total paid out.
    pub fn claim_pool_remainder(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let kind = Self::settlement(&m)?;
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        let pool_value = math::settle_value(kind, m.reserve_yes, m.reserve_no);
        let payout = pool_value
            .checked_add(Self::load_lp_fees(&env, market_id))
            .ok_or(Error::Overflow)?;
        Self::save_lp_fees(&env, market_id, 0);
        m.reserve_yes = 0;
        m.reserve_no = 0;
        m.lp_claimed = true;
        let creator = m.creator.clone();
        Self::save_market(&env, market_id, &m);
        if payout > 0 {
            Self::token(&env)?.transfer(&env.current_contract_address(), &creator, &payout);
        }
        PoolRemainderClaimed {
            market_id,
            creator,
            payout,
        }
        .publish(&env);
        Ok(payout)
    }

    /// The creator (the LP) claims their share of accrued trade fees at any
    /// time, including before finality. Returns the amount claimed (0 when
    /// nothing is pending, mirroring `sweep_fees`).
    pub fn claim_lp_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        let amount = Self::load_lp_fees(&env, market_id);
        if amount <= 0 {
            return Ok(0);
        }
        Self::save_lp_fees(&env, market_id, 0);
        Self::token(&env)?.transfer(&env.current_contract_address(), &m.creator, &amount);
        LpFeesClaimed {
            market_id,
            creator: m.creator.clone(),
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Anyone can move accrued protocol fees to the market's fee recipient.
    ///
    /// Sends to the recipient snapshotted in `FeeTerms` at creation. Markets
    /// created before `FeeTerms` existed have none and keep the legacy
    /// behaviour: the `DataKey::Treasury` of the moment of the sweep.
    pub fn sweep_fees(env: Env, market_id: u64) -> Result<i128, Error> {
        let mut m = Self::load_market(&env, market_id)?;
        let amount = m.fees_accrued;
        if amount <= 0 {
            return Ok(0);
        }
        m.fees_accrued = 0;
        Self::save_market(&env, market_id, &m);
        let recipient = match Self::load_fee_terms(&env, market_id) {
            Some(t) => t.recipient,
            None => Self::instance_get(&env, &DataKey::Treasury)?,
        };
        Self::token(&env)?.transfer(&env.current_contract_address(), &recipient, &amount);
        FeesSwept { market_id, amount }.publish(&env);
        FeesSweptTo {
            market_id,
            recipient,
            amount,
        }
        .publish(&env);
        Ok(amount)
    }

    // ----- transferability --------------------------------------------------
    // Positions and the single LP role are plain storage entries, so moving
    // them is bookkeeping only: no collateral moves, `k` is untouched, and
    // the invariant `reserve_yes + Σ pos.yes == sets_minted` holds by
    // construction. Transfers are allowed while the market is Open, Paused,
    // or final — a transfer spends no collateral, so the pause does not
    // apply. After `redeem` the position is empty and transfers fail
    // naturally with `InsufficientShares`.

    /// Moves `amount` shares of `outcome` from `from` to `to`.
    pub fn transfer_position(
        env: Env,
        from: Address,
        to: Address,
        market_id: u64,
        outcome: Outcome,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 || from == to {
            return Err(Error::InvalidAmount);
        }
        if to == env.current_contract_address() {
            // Shares held by the contract itself could never be redeemed
            // (`redeem` requires the holder's auth), so this would burn them.
            return Err(Error::InvalidAmount);
        }
        Self::load_market(&env, market_id)?;
        let mut a = Self::load_position(&env, market_id, &from);
        let mut b = Self::load_position(&env, market_id, &to);
        match outcome {
            Outcome::Yes => {
                if a.yes < amount {
                    return Err(Error::InsufficientShares);
                }
                a.yes -= amount;
                b.yes = b.yes.checked_add(amount).ok_or(Error::Overflow)?;
            }
            Outcome::No => {
                if a.no < amount {
                    return Err(Error::InsufficientShares);
                }
                a.no -= amount;
                b.no = b.no.checked_add(amount).ok_or(Error::Overflow)?;
            }
        }
        Self::save_position(&env, market_id, &from, &a);
        Self::save_position(&env, market_id, &to, &b);
        PositionTransferred {
            market_id,
            from,
            to,
            outcome,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Transfers the single LP role (the right to `claim_pool_remainder` and
    /// `claim_lp_fees`) to `new_creator`. Only until the remainder has been
    /// claimed; after that the role has no remaining value.
    pub fn transfer_lp(env: Env, market_id: u64, new_creator: Address) -> Result<(), Error> {
        let mut m = Self::load_market(&env, market_id)?;
        m.creator.require_auth();
        if m.lp_claimed {
            return Err(Error::AlreadyClaimed);
        }
        if new_creator == m.creator || new_creator == env.current_contract_address() {
            return Err(Error::InvalidAmount);
        }
        let from = m.creator.clone();
        m.creator = new_creator.clone();
        Self::save_market(&env, market_id, &m);
        LpTransferred {
            market_id,
            from,
            to: new_creator,
        }
        .publish(&env);
        Ok(())
    }

    // ----- views ----------------------------------------------------------

    pub fn get_config(env: Env) -> Result<Config, Error> {
        Ok(Config {
            admin: Self::instance_get(&env, &DataKey::Admin)?,
            collateral: Self::instance_get(&env, &DataKey::Collateral)?,
            treasury: Self::instance_get(&env, &DataKey::Treasury)?,
            resolver: Self::instance_get(&env, &DataKey::Resolver)?,
            default_fee_bps: Self::instance_get(&env, &DataKey::DefaultFeeBps)?,
            protocol_fee_share_bps: Self::instance_get(&env, &DataKey::ProtocolFeeShareBps)?,
            paused: Self::instance_get(&env, &DataKey::Paused)?,
        })
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        Self::instance_get(&env, &DataKey::Admin)
    }

    /// The pending admin proposal, including its expiry, if one exists.
    pub fn pending_admin(env: Env) -> Option<PendingAdmin> {
        Self::load_pending(&env)
    }

    pub fn market_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        Self::load_market(&env, market_id)
    }

    pub fn get_position(env: Env, market_id: u64, holder: Address) -> Position {
        Self::load_position(&env, market_id, &holder)
    }

    /// Spot price of `outcome` in bps (0..=10_000). YES + NO ~ 10_000.
    pub fn get_price(env: Env, market_id: u64, outcome: Outcome) -> Result<u32, Error> {
        let m = Self::load_market(&env, market_id)?;
        let yes = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let p = match outcome {
            Outcome::Yes => yes,
            Outcome::No => BPS - yes,
        };
        Ok(p as u32)
    }

    /// Shares a `buy` of `collateral_in` would return right now.
    pub fn quote_buy(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?.shares_out)
    }

    /// Shares a `sell` for exactly `collateral_out` would consume right now.
    pub fn quote_sell(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_out: i128,
    ) -> Result<i128, Error> {
        let m = Self::load_market(&env, market_id)?;
        let (r_sold, r_other) = Self::reserves_for(&m, outcome);
        Ok(math::calc_sell(r_sold, r_other, collateral_out, m.fee_bps)?.shares_in)
    }

    /// The market's snapshotted breakers (`None` for legacy markets created
    /// before breakers existed — those are never checked).
    pub fn breaker_config(env: Env, market_id: u64) -> Result<Option<BreakerConfig>, Error> {
        Self::load_market(&env, market_id)?;
        Ok(Self::load_breaker(&env, market_id))
    }

    /// The current ledger's band reference, if a band check has run this
    /// ledger. `None` means the next trade sets the reference (to its own
    /// pre-trade price, which equals the ledger-open price).
    pub fn breaker_state(env: Env, market_id: u64) -> Result<Option<BandState>, Error> {
        Self::load_market(&env, market_id)?;
        let state = env
            .storage()
            .temporary()
            .get::<_, BandState>(&DataKey::Band(market_id));
        Ok(match state {
            Some(s) if s.ledger_seq == env.ledger().sequence() => Some(s),
            _ => None,
        })
    }

    /// True when a `buy` of `collateral_in` would be rejected by the
    /// market's breakers right now. Read-only: never writes band state, so
    /// on a fresh ledger the reference is taken as the current price — the
    /// same value a subsequent real trade would use.
    pub fn would_trip(
        env: Env,
        market_id: u64,
        outcome: Outcome,
        collateral_in: i128,
    ) -> Result<bool, Error> {
        let m = Self::load_market(&env, market_id)?;
        let cfg = match Self::load_breaker(&env, market_id) {
            Some(c) => c,
            None => return Ok(false),
        };
        if cfg.max_impact_bps == 0 && cfg.band_bps == 0 {
            return Ok(false);
        }
        let (r_bought, r_other) = Self::reserves_for(&m, outcome);
        let q = math::calc_buy(r_bought, r_other, collateral_in, m.fee_bps)?;
        let pre = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let post = math::price_after(
            matches!(outcome, Outcome::Yes),
            q.new_reserve_bought,
            q.new_reserve_other,
        )?;
        if cfg.max_impact_bps > 0 && (post - pre).abs() > cfg.max_impact_bps as i128 {
            return Ok(true);
        }
        if cfg.band_bps > 0 {
            let reference = env
                .storage()
                .temporary()
                .get::<_, BandState>(&DataKey::Band(market_id))
                .filter(|s| s.ledger_seq == env.ledger().sequence())
                .map(|s| s.ref_price_bps)
                .unwrap_or(pre as u32);
            if (post - reference as i128).abs() > cfg.band_bps as i128 {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl MarketCore {
    fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Result<V, Error> {
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        env.storage()
            .instance()
            .get(key)
            .ok_or(Error::NotInitialized)
    }

    fn token(env: &Env) -> Result<token::TokenClient<'_>, Error> {
        let addr: Address = Self::instance_get(env, &DataKey::Collateral)?;
        Ok(token::TokenClient::new(env, &addr))
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::instance_get(env, &DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn load_pending(env: &Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
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

    /// Lazy, per-entry migration on the paths that touch a market: `buy`,
    /// `sell`, `resolve`, `void_market`, `redeem`.
    ///
    /// Costs one instance read that those callers mostly perform anyway, and
    /// returns without touching storage whenever the instance is current — in
    /// the shipped build (`SCHEMA_VERSION == 1`) that is *always*, so the
    /// default path pays a read and nothing else. Never blocks: if the admin
    /// batch has stalled, the user's own transaction migrates just the entry
    /// it is about to use and proceeds.
    fn ensure_entry_migrated(env: &Env, market_id: u64) {
        let from_version = Self::load_schema_version(env);
        if from_version >= SCHEMA_VERSION {
            return;
        }
        Self::migrate_market_entry(env, market_id, from_version);
        // A migrated entry is a persistent write; the cursor/version are not
        // touched, so a half-done migration stays half-done and resumable.
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    /// One entry's migration step, shared by the lazy path and the batch
    /// sweep so the two can never disagree about what "migrated" means.
    fn migrate_market_entry(env: &Env, market_id: u64, from_version: u32) {
        Self::migrate_from(env, market_id, from_version);
    }

    /// The version-specific rewrite. Idempotent by construction: the target
    /// entry doubles as the "already done" marker, so re-running a step (the
    /// lazy path and the admin batch can both hit the same market, and a batch
    /// can be interrupted and replayed) writes nothing the second time.
    ///
    /// The default build has no pending step — v1 is current, and both callers
    /// guard before reaching here — which keeps the storage layout byte-for-byte
    /// what the vendored `market_core.wasm` describes (ADR-0002). A real schema
    /// bump adds its branch here and bumps `SCHEMA_VERSION`; it must not change
    /// `Market`'s shape in place.
    fn migrate_from(env: &Env, market_id: u64, from_version: u32) {
        #[cfg(feature = "test-v2")]
        {
            if from_version < 2 {
                let storage = env.storage().persistent();
                let target = DataKey::MarketV2(market_id);
                if storage.has(&target) {
                    // Already migrated: this entry's existence is the marker.
                    return;
                }
                // Read the source as an opaque `Val` and *attempt* the v1
                // decode, rather than `get::<_, Market>()`: a stored entry of a
                // shape this build does not recognise then falls through to the
                // `Err` branch below instead of aborting the caller's
                // transaction. Same reason resolver reads a legacy `Val` before
                // converting it (ADR-0003).
                let source = DataKey::Market(market_id);
                let Some(raw) = storage.get::<_, soroban_sdk::Val>(&source) else {
                    return;
                };
                let Ok(v1) =
                    <Market as soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>::try_from_val(
                        env, &raw,
                    )
                else {
                    // Not a shape we understand: leave it for a human.
                    // Rewriting bytes we cannot parse is how a migration turns
                    // one corrupt entry into a lost one.
                    return;
                };
                let v2 = MarketV2 { v1, schema: 2 };
                storage.set(&target, &v2);
                storage.extend_ttl(&target, BUMP_THRESHOLD, BUMP_TO);
            }
        }
        #[cfg(not(feature = "test-v2"))]
        {
            let _ = (env, market_id, from_version);
        }
    }

    fn require_resolver(env: &Env) -> Result<(), Error> {
        let resolver: Address = Self::instance_get(env, &DataKey::Resolver)?;
        resolver.require_auth();
        Ok(())
    }

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = Self::instance_get(env, &DataKey::Paused)?;
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn assert_tradable(env: &Env, m: &Market) -> Result<(), Error> {
        if m.status != MarketStatus::Open {
            return Err(Error::MarketNotOpen);
        }
        if env.ledger().timestamp() >= m.close_time {
            return Err(Error::MarketClosed);
        }
        Ok(())
    }

    fn settlement(m: &Market) -> Result<Settlement, Error> {
        match m.status {
            MarketStatus::Open => Err(Error::NotFinal),
            MarketStatus::Resolved(Outcome::Yes) => Ok(Settlement::Yes),
            MarketStatus::Resolved(Outcome::No) => Ok(Settlement::No),
            MarketStatus::Void => Ok(Settlement::Void),
        }
    }

    /// (reserve of `outcome`, reserve of the other outcome)
    fn reserves_for(m: &Market, outcome: Outcome) -> (i128, i128) {
        match outcome {
            Outcome::Yes => (m.reserve_yes, m.reserve_no),
            Outcome::No => (m.reserve_no, m.reserve_yes),
        }
    }

    fn set_reserves(m: &mut Market, outcome: Outcome, r_outcome: i128, r_other: i128) {
        match outcome {
            Outcome::Yes => {
                m.reserve_yes = r_outcome;
                m.reserve_no = r_other;
            }
            Outcome::No => {
                m.reserve_no = r_outcome;
                m.reserve_yes = r_other;
            }
        }
    }

    fn load_market(env: &Env, id: u64) -> Result<Market, Error> {
        let key = DataKey::Market(id);
        let m: Market = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::MarketNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        Ok(m)
    }

    fn save_market(env: &Env, id: u64, m: &Market) {
        let key = DataKey::Market(id);
        env.storage().persistent().set(&key, m);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_position(env: &Env, id: u64, holder: &Address) -> Position {
        let key = DataKey::Position(id, holder.clone());
        match env.storage().persistent().get::<_, Position>(&key) {
            Some(p) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
                p
            }
            None => Position { yes: 0, no: 0 },
        }
    }

    /// Empty positions are removed so storage does not grow with dust entries.
    fn save_position(env: &Env, id: u64, holder: &Address, p: &Position) {
        let key = DataKey::Position(id, holder.clone());
        if p.yes == 0 && p.no == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, p);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    fn load_fee_terms(env: &Env, id: u64) -> Option<FeeTerms> {
        let key = DataKey::FeeTerms(id);
        let terms = env.storage().persistent().get(&key);
        if terms.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        terms
    }

    fn save_fee_terms(env: &Env, id: u64, terms: &FeeTerms) {
        let key = DataKey::FeeTerms(id);
        env.storage().persistent().set(&key, terms);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    fn load_lp_fees(env: &Env, id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LpFees(id))
            .unwrap_or(0)
    }

    /// Removing the entry at zero keeps storage from growing with dust.
    fn save_lp_fees(env: &Env, id: u64, amount: i128) {
        let key = DataKey::LpFees(id);
        if amount <= 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &amount);
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
    }

    /// Splits a trade `fee` per the market's snapshotted `FeeTerms` (legacy
    /// markets: everything to the protocol), records the LP portion under
    /// `LpFees(id)` and returns the protocol portion for `fees_accrued`.
    /// Must be called once per trade, never recomputed later.
    fn accrue_fees(env: &Env, id: u64, fee: i128) -> Result<i128, Error> {
        let (protocol, lp) = match Self::load_fee_terms(env, id) {
            Some(t) => math::split_fee(fee, t.protocol_share_bps)?,
            None => (fee, 0),
        };
        if lp > 0 {
            let current = Self::load_lp_fees(env, id);
            Self::save_lp_fees(env, id, current.checked_add(lp).ok_or(Error::Overflow)?);
        }
        Ok(protocol)
    }

    fn load_breaker(env: &Env, id: u64) -> Option<BreakerConfig> {
        let key = DataKey::Breaker(id);
        let cfg: Option<BreakerConfig> = env.storage().persistent().get(&key);
        if cfg.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        }
        cfg
    }

    fn save_breaker(env: &Env, id: u64, cfg: &BreakerConfig) {
        let key = DataKey::Breaker(id);
        env.storage().persistent().set(&key, cfg);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }

    /// Runs the market's snapshotted breakers against a quote's
    /// outcome-relative post-trade reserves. Absent entry (legacy market) or
    /// an all-zero config means no checks.
    ///
    /// Both failures abort the whole invocation, so any event describing the
    /// trip would be rolled back with it — this contract therefore emits
    /// **no** breaker event. The error code (`PriceImpactTooHigh` /
    /// `PriceBandExceeded`) in the transaction result, and the
    /// `would_trip` / `breaker_state` views, are the observability path.
    fn check_breakers(
        env: &Env,
        id: u64,
        m: &Market,
        outcome: Outcome,
        new_outcome_reserve: i128,
        new_other_reserve: i128,
    ) -> Result<(), Error> {
        let cfg = match Self::load_breaker(env, id) {
            Some(c) => c,
            None => return Ok(()),
        };
        if cfg.max_impact_bps == 0 && cfg.band_bps == 0 {
            return Ok(());
        }
        let pre = math::price_yes_bps(m.reserve_yes, m.reserve_no)?;
        let post = math::price_after(
            matches!(outcome, Outcome::Yes),
            new_outcome_reserve,
            new_other_reserve,
        )?;
        // `>`, not `>=`: a trade that moves exactly max_impact_bps passes.
        if cfg.max_impact_bps > 0 && (post - pre).abs() > cfg.max_impact_bps as i128 {
            return Err(Error::PriceImpactTooHigh);
        }
        if cfg.band_bps > 0 {
            let reference = Self::band_ref(env, id, pre);
            if (post - reference as i128).abs() > cfg.band_bps as i128 {
                return Err(Error::PriceBandExceeded);
            }
        }
        Ok(())
    }

    /// The band reference for the current ledger: the price at the ledger's
    /// first trade (== the ledger-open price, because no trade earlier this
    /// ledger succeeded), written to short-TTL temporary storage. A missing
    /// or stale entry means "new ledger", which is safe: the reference
    /// becomes the current price.
    fn band_ref(env: &Env, id: u64, pre_price: i128) -> u32 {
        let key = DataKey::Band(id);
        let seq = env.ledger().sequence();
        if let Some(state) = env.storage().temporary().get::<_, BandState>(&key) {
            if state.ledger_seq == seq {
                return state.ref_price_bps;
            }
        }
        let reference = pre_price as u32;
        env.storage().temporary().set(
            &key,
            &BandState {
                ledger_seq: seq,
                ref_price_bps: reference,
            },
        );
        env.storage().temporary().extend_ttl(&key, 1, 16);
        reference
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
        token::StellarAssetClient,
        IntoVal,
    };

    /// Minimal contract used to exercise the resolver/treasury wiring
    /// handshake: it reports a `market_core` address exactly like the real
    /// resolver and treasury do.
    #[contract]
    pub struct MockWiringPeer;

    #[contractimpl]
    impl MockWiringPeer {
        pub fn __constructor(env: Env, core: Address) {
            env.storage()
                .instance()
                .set(&soroban_sdk::symbol_short!("core"), &core);
        }

        pub fn market_core(env: Env) -> Address {
            env.storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("core"))
                .unwrap()
        }
    }

    fn register_wiring_peer(env: &Env, client: &MarketCoreClient) -> Address {
        env.register(MockWiringPeer, (client.address.clone(),))
    }

    fn setup_market() -> (
        Env,
        MarketCoreClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        setup_market_full(10_000u32, None)
    }

    fn setup_market_full(
        protocol_share_bps: u32,
        breaker: Option<BreakerConfig>,
    ) -> (
        Env,
        MarketCoreClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let creator = Address::generate(&env);
        let trader = Address::generate(&env);

        let collateral = env.register_stellar_asset_contract_v2(admin.clone());
        let collateral_client = StellarAssetClient::new(&env, &collateral.address());
        collateral_client.mint(&creator, &10_000_000_000_i128);
        collateral_client.mint(&trader, &10_000_000_000_i128);

        let contract_id = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                &admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
                &protocol_share_bps,
            ),
        );
        let client = MarketCoreClient::new(&env, &contract_id);
        if let Some(b) = breaker {
            client.set_default_breaker(&b);
        }

        (env, client, creator, trader, resolver, collateral.address())
    }

    /// One 100 USDC market seeded at the given opening probability.
    fn new_market(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        initial_yes_bps: u32,
    ) -> u64 {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[42u8; 32]),
            &BytesN::from_array(env, &[142u8; 32]),
            &String::from_str(env, "ipfs://test-market"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &initial_yes_bps,
        )
    }

    fn lp_fees_stored(env: &Env, client: &MarketCoreClient, market_id: u64) -> i128 {
        let contract = client.address.clone();
        env.as_contract(&contract, || {
            env.storage()
                .persistent()
                .get::<DataKey, i128>(&DataKey::LpFees(market_id))
                .unwrap_or(0)
        })
    }

    fn remove_side_entry(env: &Env, client: &MarketCoreClient, key: DataKey) {
        let contract = client.address.clone();
        env.as_contract(&contract, || {
            env.storage().persistent().remove(&key);
        });
    }

    #[test]
    fn create_market_sets_initial_price() {
        let (env, client, creator, _, _, _) = setup_market();
        let question_hash = BytesN::from_array(&env, &[1u8; 32]);
        let resolution_hash = BytesN::from_array(&env, &[101u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-1");

        let market_id = client.create_market(
            &creator,
            &question_hash,
            &resolution_hash,
            &meta_uri,
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &6800u32,
        );

        assert_eq!(market_id, 0);
        assert_eq!(client.market_count(), 1);

        let market = client.get_market(&market_id);
        assert_eq!(market.category, Category::Crypto);
        assert_eq!(market.status, MarketStatus::Open);
        assert!(client.get_price(&market_id, &Outcome::Yes) > 6000);
    }

    #[test]
    fn buy_moves_price_and_redeem_after_resolution() {
        let (env, client, creator, trader, _, _) = setup_market();
        let question_hash = BytesN::from_array(&env, &[2u8; 32]);
        let resolution_hash = BytesN::from_array(&env, &[102u8; 32]);
        let meta_uri = String::from_str(&env, "ipfs://market-2");
        let market_id = client.create_market(
            &creator,
            &question_hash,
            &resolution_hash,
            &meta_uri,
            &Category::Macro,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        let price_before = client.get_price(&market_id, &Outcome::Yes);
        let shares_out = client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert!(shares_out > 0);
        let price_after = client.get_price(&market_id, &Outcome::Yes);
        assert!(price_after > price_before);

        let close_time = client.get_market(&market_id).close_time;
        env.ledger().set_timestamp(close_time + 1);
        client.resolve(&market_id, &Outcome::Yes);

        let payout = client.redeem(&trader, &market_id);
        assert!(payout > 0);
        assert_eq!(client.get_position(&market_id, &trader).yes, 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn rejects_close_time_in_the_past() {
        let (env, client, creator, _, _, _) = setup_market();
        client.create_market(
            &creator,
            &BytesN::from_array(&env, &[3u8; 32]),
            &BytesN::from_array(&env, &[103u8; 32]),
            &String::from_str(&env, "ipfs://invalid-close"),
            &Category::Other,
            &env.ledger().timestamp(),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn rejects_probability_outside_bounds() {
        let (env, client, creator, _, _, _) = setup_market();
        client.create_market(
            &creator,
            &BytesN::from_array(&env, &[4u8; 32]),
            &BytesN::from_array(&env, &[104u8; 32]),
            &String::from_str(&env, "ipfs://invalid-probability"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &9901u32,
        );
    }

    #[test]
    fn sell_returns_collateral_and_reduces_position() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[5u8; 32]),
            &BytesN::from_array(&env, &[105u8; 32]),
            &String::from_str(&env, "ipfs://sell"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let balance_before = token.balance(&trader);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let position_before = client.get_position(&market_id, &trader);

        let shares_sold = client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10_000_000_i128),
            &client.quote_sell(&market_id, &Outcome::Yes, &(10_000_000_i128)),
        );

        let position_after = client.get_position(&market_id, &trader);
        assert!(shares_sold > 0);
        assert_eq!(position_before.yes - position_after.yes, shares_sold);
        assert!(token.balance(&trader) > balance_before - 10 * 10_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn sell_rejects_excessive_share_slippage() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[6u8; 32]),
            &BytesN::from_array(&env, &[106u8; 32]),
            &String::from_str(&env, "ipfs://sell-slippage"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let required = client.quote_sell(&market_id, &Outcome::Yes, &(10_000_000_i128));
        client.sell(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10_000_000_i128),
            &(required - 1),
        );
    }

    #[test]
    fn void_market_allows_creator_to_claim_pool_remainder() {
        let (env, client, creator, _, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[7u8; 32]),
            &BytesN::from_array(&env, &[107u8; 32]),
            &String::from_str(&env, "ipfs://void"),
            &Category::Geopolitics,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );

        client.void_market(&market_id);
        assert_eq!(client.get_market(&market_id).status, MarketStatus::Void);

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        let payout = client.claim_pool_remainder(&market_id);
        assert!(payout > 0);
        assert_eq!(token.balance(&creator), before + payout);
        assert!(client.get_market(&market_id).lp_claimed);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn creator_cannot_claim_pool_remainder_twice() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[8u8; 32]),
            &BytesN::from_array(&env, &[108u8; 32]),
            &String::from_str(&env, "ipfs://claim-once"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.void_market(&market_id);
        client.claim_pool_remainder(&market_id);
        client.claim_pool_remainder(&market_id);
    }

    #[test]
    fn sweep_fees_transfers_accrued_fees_to_treasury() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[9u8; 32]),
            &BytesN::from_array(&env, &[109u8; 32]),
            &String::from_str(&env, "ipfs://fees"),
            &Category::Macro,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);

        let treasury = client.get_config().treasury;
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let treasury_before = token.balance(&treasury);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&treasury), treasury_before + accrued);
        assert_eq!(client.get_market(&market_id).fees_accrued, 0);
        assert_eq!(client.sweep_fees(&market_id), 0);
    }

    #[test]
    fn create_market_commits_to_resolution_hash() {
        let (env, client, creator, _, _, _) = setup_market();
        let resolution_hash = BytesN::from_array(&env, &[200u8; 32]);
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[10u8; 32]),
            &resolution_hash,
            &String::from_str(&env, "ipfs://commitment"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        assert_eq!(
            client.get_market(&market_id).resolution_hash,
            resolution_hash
        );
    }

    #[test]
    fn wrong_caller_cannot_use_admin_functions() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_paused",
                    args: (true,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_paused(&true)
            .is_err());
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_fee_bps",
                    args: (200u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_fee_bps(&200u32)
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_resolve_market() {
        let (env, client, creator, _, _, _) = setup_market();
        let not_resolver = Address::generate(&env);
        let market_id = client.create_market(
            &creator,
            &BytesN::from_array(&env, &[11u8; 32]),
            &BytesN::from_array(&env, &[111u8; 32]),
            &String::from_str(&env, "ipfs://wrong-resolver"),
            &Category::Other,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 60_001);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &not_resolver,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "resolve",
                    args: (market_id, Outcome::Yes).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_resolve(&market_id, &Outcome::Yes)
            .is_err());
    }

    // ----- #8: fee recipient snapshot + protocol/LP fee split ---------------

    #[test]
    fn fee_recipient_snapshotted_at_creation() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let original_treasury = client.get_config().treasury;

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);

        // Changing the contract-wide treasury must not redirect fees the
        // market already committed to the treasury of creation time.
        let replacement = register_wiring_peer(&env, &client);
        client.propose_treasury(&replacement);
        client.accept_treasury();

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&original_treasury);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&original_treasury), before + accrued);
        assert_eq!(token.balance(&replacement), 0);
    }

    #[test]
    fn lp_fees_accrue_and_claimable_before_finality() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // 1% of 10 USDC, split 50/50.
        assert_eq!(client.get_market(&market_id).fees_accrued, 500_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 500_000);

        // LP fees are claimable before finality — unlike the pool remainder.
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        assert_eq!(client.claim_lp_fees(&market_id), 500_000);
        assert_eq!(token.balance(&creator), before + 500_000);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);
        assert_eq!(client.claim_lp_fees(&market_id), 0);
    }

    #[test]
    fn claim_pool_remainder_includes_lp_fees() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let lp_fees = lp_fees_stored(&env, &client, market_id);
        assert!(lp_fees > 0);

        client.void_market(&market_id);
        let m = client.get_market(&market_id);
        let expected_pool = (m.reserve_yes + m.reserve_no) / 2; // void pays half

        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&creator);
        let payout = client.claim_pool_remainder(&market_id);
        assert_eq!(payout, expected_pool + lp_fees);
        assert_eq!(token.balance(&creator), before + payout);
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);
    }

    #[test]
    fn protocol_plus_lp_equals_total_fee() {
        let (env, client, creator, trader, _, _) = setup_market_full(3333, None);
        let market_id = new_market(&env, &client, &creator, 5000);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        // Fee is exactly 1_000_000; split 3333/6667 rounds the protocol's
        // ceil so the two parts always sum to the fee.
        let accrued = client.get_market(&market_id).fees_accrued;
        let lp = lp_fees_stored(&env, &client, market_id);
        assert_eq!(accrued, 333_300);
        assert_eq!(lp, 666_700);
        assert_eq!(accrued + lp, 1_000_000);
    }

    #[test]
    fn legacy_market_without_fee_terms_uses_current_treasury() {
        let (env, client, creator, trader, _, collateral) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        // Simulate a market created before FeeTerms existed.
        remove_side_entry(&env, &client, DataKey::FeeTerms(market_id));

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let accrued = client.get_market(&market_id).fees_accrued;
        assert!(accrued > 0);
        // No terms: the whole fee stays on the protocol side.
        assert_eq!(lp_fees_stored(&env, &client, market_id), 0);

        let replacement = register_wiring_peer(&env, &client);
        client.propose_treasury(&replacement);
        client.accept_treasury();
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&replacement);
        assert_eq!(client.sweep_fees(&market_id), accrued);
        assert_eq!(token.balance(&replacement), before + accrued);
    }

    #[test]
    fn wrong_caller_cannot_set_protocol_fee_share() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_protocol_fee_share_bps",
                    args: (2500u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_protocol_fee_share_bps(&2500u32)
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_claim_lp_fees() {
        let (env, client, creator, trader, _, _) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert!(lp_fees_stored(&env, &client, market_id) > 0);

        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "claim_lp_fees",
                    args: (market_id,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_lp_fees(&market_id)
            .is_err());
    }

    #[test]
    fn wiring_and_split_change_emit_events() {
        let (env, client, _, _, _, _) = setup_market();
        // `env.events().all()` reports the last invocation's events only, so
        // each setter must publish exactly one event in its own invocation.
        client.propose_treasury(&register_wiring_peer(&env, &client));
        assert_eq!(env.events().all().events().len(), 1);
        client.set_protocol_fee_share_bps(&2500u32);
        assert_eq!(env.events().all().events().len(), 1);
        assert_eq!(client.get_config().protocol_fee_share_bps, 2500);
        assert_eq!(
            client.try_set_protocol_fee_share_bps(&10_001u32),
            Err(Ok(Error::InvalidFee))
        );
    }

    // ----- #61: resolver/treasury wiring handshake --------------------------

    #[test]
    fn resolver_wiring_handshake_updates_config() {
        let (env, client, _, _, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        client.propose_resolver(&peer);
        client.accept_resolver();
        assert_eq!(client.get_config().resolver, peer);
    }

    #[test]
    fn treasury_wiring_handshake_updates_config() {
        let (env, client, _, _, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        client.propose_treasury(&peer);
        client.accept_treasury();
        assert_eq!(client.get_config().treasury, peer);
    }

    #[test]
    fn accept_resolver_requires_a_pending_proposal() {
        let (_env, client, _, _, _, _) = setup_market();
        assert_eq!(
            client.try_accept_resolver(),
            Err(Ok(Error::NoPendingWiring))
        );
    }

    #[test]
    fn accept_resolver_rejects_peer_for_another_core() {
        let (env, client, _, _, _, _) = setup_market();
        // A contract that serves a *different* market-core must not be able
        // to wire itself in.
        let other_core = Address::generate(&env);
        let peer = env.register(MockWiringPeer, (other_core,));
        client.propose_resolver(&peer);
        assert_eq!(client.try_accept_resolver(), Err(Ok(Error::InvalidWiring)));
    }

    #[test]
    fn accept_treasury_rejects_peer_for_another_core() {
        let (env, client, _, _, _, _) = setup_market();
        let other_core = Address::generate(&env);
        let peer = env.register(MockWiringPeer, (other_core,));
        client.propose_treasury(&peer);
        assert_eq!(client.try_accept_treasury(), Err(Ok(Error::InvalidWiring)));
    }

    #[test]
    fn propose_resolver_requires_admin() {
        let (env, client, _, trader, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_resolver",
                    args: (peer.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_resolver(&peer)
            .is_err());
    }

    // ----- #10: price-impact and per-ledger price-band breakers -------------

    /// Measures how many bps a 10 USDC YES buy moves the YES price on a
    /// fresh 100 USDC market — exactly the impact a breaker must allow.
    fn measure_impact_10_usdc(
        env: &Env,
        client: &MarketCoreClient,
        creator: &Address,
        trader: &Address,
    ) -> u32 {
        let market_id = new_market(env, client, creator, 5000);
        let before = client.get_price(&market_id, &Outcome::Yes);
        client.buy(
            trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.get_price(&market_id, &Outcome::Yes) - before
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #21)")]
    fn impact_cap_rejects_large_buy() {
        let (env, client, creator, trader, _, _) = setup_market();
        let impact = measure_impact_10_usdc(&env, &client, &creator, &trader);
        assert!(impact > 0);
        client.set_default_breaker(&BreakerConfig {
            max_impact_bps: impact - 1,
            band_bps: 0,
        });
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn impact_cap_allows_exact_bound() {
        let (env, client, creator, trader, _, _) = setup_market();
        let impact = measure_impact_10_usdc(&env, &client, &creator, &trader);
        client.set_default_breaker(&BreakerConfig {
            max_impact_bps: impact,
            band_bps: 0,
        });
        let market_id = new_market(&env, &client, &creator, 5000);
        // A trade that moves exactly max_impact_bps passes.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(client.get_price(&market_id, &Outcome::Yes), 5000 + impact);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_cumulative_moves_within_ledger() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // First trade: ~470 bps from the ledger-open reference, inside band.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        // Second trade moves ~420 bps on its own — each trade individually
        // fits the band, but the cumulative move from the ledger's first
        // price (~890 bps) does not.
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn band_resets_next_ledger() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        assert_eq!(client.breaker_state(&market_id), None);

        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let first_ledger_price = client.get_price(&market_id, &Outcome::Yes);
        assert_eq!(
            client.breaker_state(&market_id),
            Some(BandState {
                ledger_seq: env.ledger().sequence(),
                ref_price_bps: 5000,
            })
        );

        // On the next ledger the band re-anchors to the current price, so the
        // same second buy that trips within one ledger now passes.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 1);
        assert_eq!(client.breaker_state(&market_id), None);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(
            client.breaker_state(&market_id),
            Some(BandState {
                ledger_seq: env.ledger().sequence(),
                ref_price_bps: first_ledger_price,
            })
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_downward_sell() {
        let (env, client, creator, _, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        // Seeded at 68%: the creator holds the leftover YES shares and can
        // sell enough to move the price down far more than the band.
        let market_id = new_market(&env, &client, &creator, 6800);
        client.sell(
            &creator,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &i128::MAX,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn band_trips_on_no_side_buy() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // Buying NO moves YES's price down, so the band must trip on the
        // absolute move regardless of which outcome is bought.
        client.buy(
            &trader,
            &market_id,
            &Outcome::No,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn breaker_disabled_when_zero() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // The snapshot exists but an all-zero config disables all checks.
        assert_eq!(
            client.breaker_config(&market_id),
            Some(BreakerConfig {
                max_impact_bps: 0,
                band_bps: 0,
            })
        );
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn legacy_market_without_breaker_unaffected() {
        let (env, client, creator, trader, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        // Simulate a market created before breakers existed: no snapshot, so
        // even trades that would trip the default are allowed.
        remove_side_entry(&env, &client, DataKey::Breaker(market_id));
        assert_eq!(client.breaker_config(&market_id), None);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(20 * 10_000_000_i128),
            &0_i128,
        );
    }

    #[test]
    fn set_default_breaker_rejects_invalid_configs() {
        let (_env, client, _, _, _, _) = setup_market();
        // A band narrower than the impact cap could lock trading.
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 200,
                band_bps: 100,
            }),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 10_001,
                band_bps: 0,
            }),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 100,
                band_bps: 100,
            }),
            Ok(Ok(()))
        );
        assert_eq!(
            client.try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 0,
                band_bps: 500,
            }),
            Ok(Ok(()))
        );
    }

    #[test]
    fn wrong_caller_cannot_set_default_breaker() {
        let (env, client, _, trader, _, _) = setup_market();
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_default_breaker",
                    args: (BreakerConfig {
                        max_impact_bps: 100,
                        band_bps: 0,
                    },)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_default_breaker(&BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            })
            .is_err());
    }

    #[test]
    fn would_trip_previews_impact_cap() {
        let (env, client, creator, _, _, _) = setup_market_full(
            10_000,
            Some(BreakerConfig {
                max_impact_bps: 100,
                band_bps: 0,
            }),
        );
        let market_id = new_market(&env, &client, &creator, 5000);
        assert!(client.would_trip(&market_id, &Outcome::Yes, &(20 * 10_000_000_i128)));
        assert!(!client.would_trip(&market_id, &Outcome::Yes, &(1_000_000_i128)));
        // Read-only: previewing writes no band state.
        assert_eq!(client.breaker_state(&market_id), None);
    }

    // ----- #12: deadlines and limit prices ----------------------------------

    #[test]
    #[should_panic(expected = "Error(Contract, #19)")]
    fn buy_v2_rejects_after_deadline() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        env.ledger().set_timestamp(1_000);
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &0u32,
            &999u64,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #20)")]
    fn buy_v2_rejects_worse_than_limit() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let deadline = env.ledger().timestamp();
        // Average fill price incl. fee is ~5289 bps; limit 5000 must reject.
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &5000u32,
            &deadline,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #20)")]
    fn sell_v2_rejects_below_limit() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let deadline = env.ledger().timestamp();
        let max_shares = client.quote_sell(&market_id, &Outcome::Yes, &(5 * 10_000_000_i128));
        // Average execution price is ~5302 bps; limit 6000 must reject.
        client.sell_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(5 * 10_000_000_i128),
            &max_shares,
            &6000u32,
            &deadline,
        );
    }

    #[test]
    fn buy_v2_matches_buy_when_unbounded() {
        let (env, client, creator, trader, _, _) = setup_market();
        let v2_market = new_market(&env, &client, &creator, 5000);
        let legacy_market = new_market(&env, &client, &creator, 5000);
        // deadline == now passes (only a strictly later timestamp expires),
        // and limit 0 disables the price bound.
        let deadline = env.ledger().timestamp();

        let shares_v2 = client.buy_v2(
            &trader,
            &v2_market,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &0u32,
            &deadline,
        );
        let shares_legacy = client.buy(
            &trader,
            &legacy_market,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        assert_eq!(shares_v2, shares_legacy);
        assert_eq!(
            client.get_price(&v2_market, &Outcome::Yes),
            client.get_price(&legacy_market, &Outcome::Yes)
        );

        let out = 5 * 10_000_000_i128;
        let max_v2 = client.quote_sell(&v2_market, &Outcome::Yes, &out);
        let max_legacy = client.quote_sell(&legacy_market, &Outcome::Yes, &out);
        let sold_v2 = client.sell_v2(
            &trader,
            &v2_market,
            &Outcome::Yes,
            &out,
            &max_v2,
            &0u32,
            &deadline,
        );
        let sold_legacy = client.sell(&trader, &legacy_market, &Outcome::Yes, &out, &max_legacy);
        assert_eq!(sold_v2, sold_legacy);
        assert_eq!(
            client.get_price(&v2_market, &Outcome::Yes),
            client.get_price(&legacy_market, &Outcome::Yes)
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn buy_v2_rejects_limit_above_bps() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let deadline = env.ledger().timestamp();
        client.buy_v2(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
            &20_000u32,
            &deadline,
        );
    }

    // ----- #13: transferable positions and LP role --------------------------

    #[test]
    fn transfer_position_moves_shares_and_preserves_invariant() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let receiver = Address::generate(&env);
        let moved = 100_000_000_i128;
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &moved);

        let a = client.get_position(&market_id, &trader);
        let b = client.get_position(&market_id, &receiver);
        assert_eq!(b.yes, moved);
        let m = client.get_market(&market_id);
        // reserve_yes + Σ positions == sets_minted, always.
        assert_eq!(m.reserve_yes + a.yes + b.yes, m.sets_minted);

        // Transfers spend no collateral, so the pause does not block them.
        client.set_paused(&true);
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &1_i128);
        assert_eq!(client.get_position(&market_id, &receiver).yes, moved + 1);
    }

    #[test]
    fn transfer_position_removes_empty_entry() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let held = client.get_position(&market_id, &trader).yes;

        let receiver = Address::generate(&env);
        client.transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &held);
        assert_eq!(
            client.get_position(&market_id, &trader),
            Position { yes: 0, no: 0 }
        );

        let contract = client.address.clone();
        let raw = env.as_contract(&contract, || {
            env.storage()
                .persistent()
                .get::<DataKey, Position>(&DataKey::Position(market_id, trader.clone()))
        });
        assert_eq!(raw, None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn transfer_position_rejects_insufficient_shares() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let held = client.get_position(&market_id, &trader).yes;
        client.transfer_position(
            &trader,
            &Address::generate(&env),
            &market_id,
            &Outcome::Yes,
            &(held + 1),
        );
    }

    #[test]
    fn transfer_position_rejects_invalid_destinations() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        let receiver = Address::generate(&env);
        assert_eq!(
            client.try_transfer_position(&trader, &trader, &market_id, &Outcome::Yes, &1_i128),
            Err(Ok(Error::InvalidAmount))
        );
        // The contract address would burn the shares: redeem needs the
        // holder's auth, so shares held by the contract are unreachable.
        assert_eq!(
            client.try_transfer_position(
                &trader,
                &client.address,
                &market_id,
                &Outcome::Yes,
                &1_i128
            ),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_transfer_position(&trader, &receiver, &market_id, &Outcome::Yes, &0_i128),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn wrong_caller_cannot_transfer_position() {
        let (env, client, creator, trader, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );

        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "transfer_position",
                    args: (
                        trader.clone(),
                        attacker.clone(),
                        market_id,
                        Outcome::Yes,
                        1_i128
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_transfer_position(&trader, &attacker, &market_id, &Outcome::Yes, &1_i128)
            .is_err());
    }

    #[test]
    fn transfer_lp_then_new_creator_claims() {
        let (env, client, creator, trader, _, collateral) = setup_market_full(5000, None);
        let market_id = new_market(&env, &client, &creator, 5000);
        client.buy(
            &trader,
            &market_id,
            &Outcome::Yes,
            &(10 * 10_000_000_i128),
            &0_i128,
        );
        client.void_market(&market_id);

        let successor = Address::generate(&env);
        client.transfer_lp(&market_id, &successor);
        assert_eq!(client.get_market(&market_id).creator, successor);

        let m = client.get_market(&market_id);
        let expected_pool = (m.reserve_yes + m.reserve_no) / 2;
        let lp_fees = lp_fees_stored(&env, &client, market_id);
        let token = soroban_sdk::token::TokenClient::new(&env, &collateral);
        let before = token.balance(&successor);
        let payout = client.claim_pool_remainder(&market_id);
        assert_eq!(payout, expected_pool + lp_fees);
        assert_eq!(token.balance(&successor), before + payout);
    }

    #[test]
    fn wrong_caller_cannot_transfer_lp() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        let attacker = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "transfer_lp",
                    args: (market_id, attacker.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_transfer_lp(&market_id, &attacker)
            .is_err());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn transfer_lp_rejected_after_claim() {
        let (env, client, creator, _, _, _) = setup_market();
        let market_id = new_market(&env, &client, &creator, 5000);
        client.void_market(&market_id);
        client.claim_pool_remainder(&market_id);
        client.transfer_lp(&market_id, &Address::generate(&env));
    }

    // ----- #62: two-step admin transfer -------------------------------------

    #[test]
    fn two_step_admin_transfer() {
        let (env, client, _, _, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        assert_eq!(client.pending_admin(), None);

        client.propose_admin(&new_admin);
        assert_eq!(
            client.pending_admin().map(|p| p.address),
            Some(new_admin.clone())
        );

        client.accept_admin();
        assert_eq!(client.admin(), new_admin);
        assert_eq!(client.get_config().admin, new_admin);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn admin_transfer_can_be_cancelled() {
        let (env, client, _, _, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.cancel_admin_transfer();
        assert_eq!(client.pending_admin(), None);
        assert_eq!(client.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    }

    #[test]
    fn expired_admin_transfer_cannot_be_accepted() {
        let (env, client, _, _, _, _) = setup_market();
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
        let (env, client, _, trader, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin()
            .is_err());
    }

    #[test]
    fn wrong_caller_cannot_propose_or_cancel_admin() {
        let (env, client, _, trader, _, _) = setup_market();
        let new_admin = Address::generate(&env);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
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
                address: &trader,
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

    #[test]
    fn wrong_caller_cannot_propose_treasury_or_cancel_wiring() {
        let (env, client, _, trader, _, _) = setup_market();
        let peer = register_wiring_peer(&env, &client);
        env.set_auths(&[]);
        assert!(client
            .mock_auths(&[MockAuth {
                address: &trader,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "propose_treasury",
                    args: (peer.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_treasury(&peer)
            .is_err());
    }
}

// ---------------------------------------------------------------------------
// Test-only custom account: a weighted ed25519 multisig. It exists to prove
// that `require_admin` really works when the admin is a contract account (the
// `__check_auth` path), not just an `Address::generate` account that
// `mock_all_auths` approves unconditionally.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod multisig_account {
    extern crate std;

    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        crypto::Hash,
        testutils::Address as _,
        xdr::{
            Hash as XdrHash, HashIdPreimage, HashIdPreimageSorobanAuthorization,
            InvokeContractArgs, Limits, ScAddress, ScVal, SorobanAddressCredentials,
            SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
            SorobanCredentials, StringM, VecM, WriteXdr,
        },
        Bytes, IntoVal, TryFromVal, Vec,
    };

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum AccountError {
        BelowThreshold = 1,
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct WeightedSig {
        pub key: BytesN<32>,
        pub signature: BytesN<64>,
    }

    #[contracttype]
    enum AccountKey {
        Signers,
        Threshold,
    }

    #[contract]
    pub struct MultisigAccount;

    #[contractimpl]
    impl MultisigAccount {
        pub fn __constructor(env: Env, signers: Vec<(BytesN<32>, u32)>, threshold: u32) {
            env.storage().instance().set(&AccountKey::Signers, &signers);
            env.storage()
                .instance()
                .set(&AccountKey::Threshold, &threshold);
        }
    }

    #[contractimpl]
    impl CustomAccountInterface for MultisigAccount {
        type Signature = Vec<WeightedSig>;
        type Error = AccountError;

        fn __check_auth(
            env: Env,
            signature_payload: Hash<32>,
            signatures: Vec<WeightedSig>,
            _auth_contexts: Vec<Context>,
        ) -> Result<(), AccountError> {
            let signers: Vec<(BytesN<32>, u32)> =
                env.storage().instance().get(&AccountKey::Signers).unwrap();
            let threshold: u32 = env
                .storage()
                .instance()
                .get(&AccountKey::Threshold)
                .unwrap();
            let message = Bytes::from_array(&env, &signature_payload.to_array());
            let mut weight = 0u32;
            // Each configured signer contributes at most once, so replaying
            // the same signature cannot reach the threshold on its own.
            for (key, key_weight) in signers.iter() {
                for sig in signatures.iter() {
                    if sig.key == key {
                        env.crypto().ed25519_verify(&key, &message, &sig.signature);
                        weight += key_weight;
                        break;
                    }
                }
            }
            if weight < threshold {
                return Err(AccountError::BelowThreshold);
            }
            Ok(())
        }
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn account_with(
        env: &Env,
        weights: &[(u8, u32)],
        threshold: u32,
    ) -> (Address, std::vec::Vec<SigningKey>) {
        let mut keys = std::vec::Vec::new();
        let mut signers = Vec::new(env);
        for (seed, weight) in weights {
            let sk = signing_key(*seed);
            signers.push_back((
                BytesN::from_array(env, &sk.verifying_key().to_bytes()),
                *weight,
            ));
            keys.push(sk);
        }
        let account = env.register(MultisigAccount, (signers, threshold));
        (account, keys)
    }

    /// Builds the address-credential auth entry a wallet would produce for
    /// `market_core.set_paused(true)`, signing the host's payload with the
    /// supplied keys.
    fn auth_entry(
        env: &Env,
        account: &Address,
        core: &Address,
        nonce: i64,
        keys: &[SigningKey],
    ) -> SorobanAuthorizationEntry {
        let expiration = 1_000u32;
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: ScAddress::from(core.clone()),
                function_name: StringM::try_from("set_paused").unwrap().into(),
                args: std::vec![ScVal::Bool(true)].try_into().unwrap(),
            }),
            sub_invocations: VecM::default(),
        };
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: XdrHash(env.ledger().network_id().to_array()),
            invocation: invocation.clone(),
            nonce,
            signature_expiration_ledger: expiration,
        });
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(
                env,
                &preimage.to_xdr(Limits::none()).unwrap(),
            ))
            .to_array();

        let mut signatures = Vec::new(env);
        for sk in keys {
            signatures.push_back(WeightedSig {
                key: BytesN::from_array(env, &sk.verifying_key().to_bytes()),
                signature: BytesN::from_array(env, &sk.sign(&payload).to_bytes()),
            });
        }
        let signature_val: soroban_sdk::Val = signatures.into_val(env);
        let signature = ScVal::try_from_val(env, &signature_val).unwrap();

        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(account.clone()),
                nonce,
                signature_expiration_ledger: expiration,
                signature,
            }),
            root_invocation: invocation,
        }
    }

    fn core_with_admin(
        env: &Env,
        admin: &Address,
    ) -> (MarketCoreClient<'static>, Address, Address) {
        let collateral = env.register_stellar_asset_contract_v2(Address::generate(env));
        let treasury = Address::generate(env);
        let resolver = Address::generate(env);
        let core = env.register(
            MarketCore,
            MarketCoreArgs::__constructor(
                admin,
                &collateral.address(),
                &treasury,
                &resolver,
                &100u32,
                &10_000u32,
            ),
        );
        let client = MarketCoreClient::new(env, &core);
        (client, core, collateral.address())
    }

    #[test]
    fn require_admin_accepts_weighted_multisig() {
        let env = Env::default();
        // Weight 1 + weight 2, threshold 2: the weight-2 key alone suffices.
        let (account, keys) = account_with(&env, &[(1, 1), (2, 2)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        // Only the weight-1 key: below threshold, rejected through the real
        // __check_auth path (no mock_all_auths, no mocked auth entries).
        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            1,
            &[keys.first().unwrap().clone()],
        )]);
        assert!(client.try_set_paused(&true).is_err());

        // The weight-2 key alone reaches threshold.
        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            2,
            &[keys.get(1).unwrap().clone()],
        )]);
        client.set_paused(&true);
        assert!(client.get_config().paused);
    }

    #[test]
    fn require_admin_accepts_both_multisig_keys() {
        let env = Env::default();
        let (account, keys) = account_with(&env, &[(3, 1), (4, 1)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        env.set_auths(&[auth_entry(
            &env,
            &account,
            &core,
            7,
            &[keys.first().unwrap().clone(), keys.get(1).unwrap().clone()],
        )]);
        client.set_paused(&true);
        assert!(client.get_config().paused);
    }

    #[test]
    fn require_admin_rejects_bad_multisig_signature() {
        let env = Env::default();
        let (account, keys) = account_with(&env, &[(5, 2)], 2);
        let (client, core, _) = core_with_admin(&env, &account);

        let mut entry = auth_entry(&env, &account, &core, 9, &[keys.first().unwrap().clone()]);
        // Corrupt the signature bytes: the ed25519 check inside __check_auth
        // must reject it.
        let bad_sig = WeightedSig {
            key: BytesN::from_array(&env, &keys.first().unwrap().verifying_key().to_bytes()),
            signature: BytesN::from_array(&env, &[0u8; 64]),
        };
        let bad = Vec::from_array(&env, [bad_sig]);
        if let SorobanCredentials::Address(creds) = &mut entry.credentials {
            let bad_val: soroban_sdk::Val = bad.into_val(&env);
            creds.signature = ScVal::try_from_val(&env, &bad_val).unwrap();
        }
        env.set_auths(&[entry]);
        assert!(client.try_set_paused(&true).is_err());
    }
}
