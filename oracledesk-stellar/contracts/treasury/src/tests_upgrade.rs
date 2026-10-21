//! Issue #18 (completion) — in-place contract upgrade + versioned schema
//! migration, treasury side. Mirrors `contracts/market-core/src/tests_upgrade.rs`
//! and `contracts/resolver/src/tests_upgrade.rs` case-for-case, with the
//! treasury-specific state under test being per-market exposure
//! (`DataKey::Market(id)` / `DataKey::Net(id)`), not markets or proposals.
//!
//! Two groups, deliberately separated by feature:
//!
//! * `#[cfg(test)]` cases need only the mechanism (version stamping, the admin
//!   gate, the batch bound, "absent version means 1"). They belong to the
//!   default `cargo test` build and are the ones a maintainer can run as soon
//!   as the workspace compiles again.
//! * `#[cfg(all(test, feature = "test-v2"))]` cases need a build whose schema
//!   is *already* v2 (see the `SCHEMA_VERSION` pair in `lib.rs`). They are
//!   feature-gated because the shipped build must keep the exposure storage
//!   layout byte-identical to what the vendored `market_core.wasm` describes
//!   (`contractimport!`, docs/adr/0002-cross-contract-calls.md), and because
//!   the 1 -> 2 step itself only exists in that build.
//!
//! Disclosure: **none of these tests has ever been compiled or executed** on
//! the machine that produced this PR, and none can be at this base — the
//! pinned toolchain (1.90.0) is below soroban-sdk 27.0.6's MSRV, and `+stable`
//! dies in `oracledesk-types` (21 errors) long before `treasury` is analysed;
//! `treasury/build.rs` additionally hits the `E0753` include-wall on the way.
//! Run with `cargo test -p treasury` (mechanism) and `cargo test -p treasury
//! --features test-v2` (migration) once the workspace builds again. Do not
//! merge on the assumption that they pass.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal, String,
};

#[cfg(all(test, feature = "test-v2"))]
extern crate std;

// Same constants the in-crate test module uses, kept local so this module
// cannot perturb the existing suite's helpers.
const TEST_CLOSE: u64 = 1_000 + 30 * 86_400;
const DELAY: u64 = MIN_CONFIG_DELAY;
const PERMISSIVE: PricePolicy = PricePolicy {
    max_buy_price_bps: 10_000,
    min_sell_price_bps: 0,
    max_impact_bps: 10_000,
    max_slippage_bps: 9_999,
};

fn install_price_policy(env: &Env, treasury: &Address, policy: PricePolicy) {
    env.as_contract(treasury, || {
        env.storage().instance().set(&DataKey::PricePolicy, &policy);
    });
}

struct Setup {
    env: Env,
    admin: Address,
    agent: Address,
    client: TreasuryClient<'static>,
    market_id: u64,
}

/// Treasury + a real (vendored-interface) market-core with one seeded, open
/// market, the same shape as the in-crate `fixture_full_with_policy` but
/// minimal: caps are generous because these tests pin the *mechanism*, not the
/// risk limits (the existing suite covers the limits).
fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let creator = Address::generate(&env);
    let treasury_id = Address::generate(&env);
    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = StellarAssetClient::new(&env, &collateral.address());
    token.mint(&creator, &(1_000 * 10_000_000_i128));
    token.mint(&treasury_id, &(1_000 * 10_000_000_i128));

    let resolver = Address::generate(&env);
    let market_core_id = env.register(
        market_core::WASM,
        (
            admin.clone(),
            collateral.address(),
            treasury_id.clone(),
            resolver.clone(),
            100u32,
            10_000u32,
        ),
    );
    let market_core = MarketCoreClient::new(&env, &market_core_id);
    let market_id = market_core.create_market(
        &creator,
        &BytesN::from_array(&env, &[11u8; 32]),
        &BytesN::from_array(&env, &[111u8; 32]),
        &String::from_str(&env, "ipfs://upgrade-test"),
        &Category::Crypto,
        &TEST_CLOSE,
        &(100 * 10_000_000_i128),
        &5000u32,
    );
    let treasury = env.register_at(
        &treasury_id,
        Treasury,
        TreasuryArgs::__constructor(
            &admin,
            &agent,
            &collateral.address(),
            &market_core_id,
            &1_000_000_000_i128,  // max_trade
            &1_000_000_000_i128,  // max_market
            &10_000_000_000_i128, // max_daily
            &10_000_000_000_i128, // max_net_exposure
            &DELAY,
            &(100_000_000_000_i128), // max_drawdown
            &7u32,                   // window_days
            &permissive_creation_policy(),
        ),
    );
    install_price_policy(&env, &treasury, PERMISSIVE);
    Setup {
        env,
        admin,
        agent,
        client: TreasuryClient::new(&env, &treasury),
        market_id,
    }
}

fn permissive_creation_policy() -> CreationPolicy {
    CreationPolicy {
        max_seed: 1_000_000_000,
        max_markets_per_window: 100,
        creation_window_secs: 86_400,
        min_close_horizon: 60,
        max_close_horizon: 365 * 86_400,
        allowed_categories: 0x3F,
    }
}

/// Open a real position so `DataKey::Market(id)` / `DataKey::Net(id)` exist.
fn open_position(s: &Setup, amount: i128) {
    s.client
        .agent_buy(&s.agent, &s.market_id, &Outcome::Yes, &amount, &0i128);
}

/// Pretend this instance predates the migration: lower the stored version the
/// way upgrading an old deployment leaves it (the swap does not run the new
/// `__constructor`).
#[cfg(all(test, feature = "test-v2"))]
fn force_stored_version(env: &Env, contract_id: &Address, version: u32) {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &version);
    });
}

#[cfg(test)]
fn stored_version(env: &Env, contract_id: &Address) -> Option<u32> {
    env.as_contract(contract_id, || {
        env.storage().instance().get(&DataKey::SchemaVersion)
    })
}

#[cfg(test)]
fn read_exposure(env: &Env, contract_id: &Address, market_id: u64) -> Option<MarketExposure> {
    env.as_contract(contract_id, || {
        env.storage().persistent().get(&DataKey::Market(market_id))
    })
}

// ---------------------------------------------------------------------------
// mechanism — default build
// ---------------------------------------------------------------------------

/// A fresh deploy stamps the version it writes, so `migrate` has something to
/// compare against later.
#[test]
fn constructor_stamps_the_current_schema_version() {
    let s = setup();
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);
    let treasury_id = s.client.address.clone();
    assert_eq!(
        stored_version(&s.env, &treasury_id).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// The backwards-compatibility requirement: an instance from *before* this
/// feature has no `SchemaVersion` key. It must read as 1, and `migrate` must
/// find nothing to do — and must not invent state for old deployments.
#[test]
fn absent_schema_version_is_read_as_one_and_needs_no_migration() {
    let s = setup();
    open_position(&s, 50_000_000);
    let exposure_before = read_exposure(&s.env, &s.client.address, s.market_id);

    let treasury_id = s.client.address.clone();
    s.env.as_contract(&treasury_id, || {
        s.env.storage().instance().remove(&DataKey::SchemaVersion);
    });

    assert_eq!(s.client.schema_version(), PRE_VERSIONING_SCHEMA_VERSION);
    assert_eq!(s.client.schema_version(), 1);

    let progress = s.client.migrate(&MAX_MIGRATION_BATCH);
    assert_eq!(
        progress,
        MigrationProgress {
            from_version: 1,
            to_version: 1,
            processed: 0,
            next_id: 0,
            done: true,
        }
    );
    assert_eq!(stored_version(&s.env, &treasury_id), None);
    // The exposure entry is untouched.
    assert_eq!(
        read_exposure(&s.env, &treasury_id, s.market_id),
        exposure_before
    );
}

/// `upgrade` swaps the code that guards the whole capital pool, so it is
/// admin-only: a non-admin caller must fail on `require_admin`, the same
/// guard `set_paused` / `set_agent` use.
#[test]
fn upgrade_is_admin_gated() {
    let s = setup();
    let hash = BytesN::from_array(&s.env, &[7u8; 32]);
    let stranger = Address::generate(&s.env);

    s.env.set_auths(&[]);
    let as_stranger = s.client.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(as_stranger.try_upgrade(&hash).is_err());

    // The admin gets past the gate and fails later, on the uninstalled hash
    // (next test); the failure mode differs, which is the point.
    s.env.set_auths(&[]);
    let as_admin = s.client.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(as_admin.try_upgrade(&hash).is_err());
}

/// `upgrade` takes a wasm *hash*, not bytes: the target must already be
/// installed on this network (`stellar contract install`, done by
/// `scripts/upgrade.sh` before it invokes `upgrade`). An uninstalled hash
/// must fail rather than brick the instance.
#[test]
fn upgrade_rejects_a_wasm_hash_that_was_never_installed() {
    let s = setup();
    let bogus = BytesN::from_array(&s.env, &[0u8; 32]);
    assert!(s.client.try_upgrade(&bogus).is_err());
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);
}

/// `batch` is caller-provided and must be clamped: 0 would spin, and an
/// unbounded batch would let the admin write a sweep large enough to trap on
/// the instruction budget.
#[test]
fn migrate_batch_is_bounded_at_both_ends() {
    let s = setup();
    open_position(&s, 50_000_000);

    assert_eq!(
        s.client.try_migrate(&0),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert_eq!(
        s.client.try_migrate(&(MAX_MIGRATION_BATCH + 1)),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert_eq!(
        s.client.try_migrate(&(MAX_MIGRATION_BATCH + 1_000_000)),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    // The exact bound is accepted.
    assert!(s.client.try_migrate(&MAX_MIGRATION_BATCH).is_ok());
    assert_eq!(
        stored_version(&s.env, &s.client.address).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// A `migrate` on a current instance is idempotent and emits one `Migrated`
/// event per call — the property `scripts/upgrade.sh` relies on when it loops
/// `migrate` until `done`. For treasury the thing that must not move is the
/// exposure accounting, not market data.
#[test]
fn migrate_on_a_current_instance_is_idempotent() {
    let s = setup();
    open_position(&s, 50_000_000);
    let exposure_before = read_exposure(&s.env, &s.client.address, s.market_id);

    let first = s.client.migrate(&10);
    let second = s.client.migrate(&10);
    assert_eq!(first, second);
    assert!(first.done);
    assert_eq!(first.processed, 0);
    assert_eq!(
        read_exposure(&s.env, &s.client.address, s.market_id),
        exposure_before
    );
}

// ---------------------------------------------------------------------------
// migration — `--features test-v2` build (never executed on the PR box)
// ---------------------------------------------------------------------------

/// The case the issue asks for by name: exposure limits survive an upgrade
/// with an **open position**. The sweep converts entry by entry; the legacy
/// keys stay authoritative and every projected `ExposureV2` carries the exact
/// v1 amount/open pair, so the caps the next trade is checked against are the
/// ones from before the swap.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn exposure_limits_survive_the_upgrade_with_an_open_position() {
    let s = setup();
    open_position(&s, 50_000_000);
    let exposure_before = read_exposure(&s.env, &s.client.address, s.market_id)
        .expect("position open before the sweep");
    let net_before = s.client.net_exposure();

    force_stored_version(&s.env, &s.client.address, 1);
    let p = s.client.migrate(&10);
    assert!(p.done);
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);

    // Nothing moved: same exposure, same net, and the projection agrees.
    assert_eq!(
        read_exposure(&s.env, &s.client.address, s.market_id),
        Some(exposure_before.clone())
    );
    assert_eq!(s.client.net_exposure(), net_before);
    let v2: ExposureV2 = s
        .env
        .as_contract(&s.client.address, || {
            s.env
                .storage()
                .persistent()
                .get(&DataKey::ExposureV2(s.market_id))
        })
        .unwrap();
    assert_eq!(v2.schema, 2);
    assert_eq!(v2.v1, exposure_before);

    // And the cap *still bites* on the migrated entry: drain the per-market
    // cap, then try one more unit than `max_market` allows.
    let over = s.client.try_agent_buy(
        &s.agent,
        &s.market_id,
        &Outcome::Yes,
        &1_000_000_000_i128,
        &0i128,
    );
    assert!(over.is_err(), "the market cap must survive the migration");
}

/// Batched, resumable sweep over exposure state: partial batches persist the
/// cursor, do not flip the version, and the replayed tail is a no-op. Mirrors
/// market-core's `migrate_in_batches_preserves_markets_and_positions`.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn migrate_is_idempotent_and_bounded_over_exposure_state() {
    let s = setup();
    open_position(&s, 30_000_000);
    let market_id = s.market_id;
    force_stored_version(&s.env, &s.client.address, 1);

    // A batch of 1 at most processes one id; ids above the bound write
    // nothing (no source entry), which is what makes replay cheap.
    let first = s.client.migrate(&1);
    assert!(first.done || first.processed <= 1);
    let mut seen = s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .persistent()
            .has(&DataKey::ExposureV2(market_id))
    });
    while !seen {
        let p = s.client.migrate(&1);
        assert!(p.processed <= 1, "never more than `batch` per call");
        seen = s.env.as_contract(&s.client.address, || {
            s.env
                .storage()
                .persistent()
                .has(&DataKey::ExposureV2(market_id))
        });
    }
    assert!(s.client.migrate(&10).done);
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);

    // Replay after `done`: a no-op on a current instance, and the projection
    // is untouched.
    let v2: ExposureV2 = s
        .env
        .as_contract(&s.client.address, || {
            s.env
                .storage()
                .persistent()
                .get(&DataKey::ExposureV2(market_id))
        })
        .unwrap();
    force_stored_version(&s.env, &s.client.address, 1);
    s.client.migrate(&10);
    let again: ExposureV2 = s
        .env
        .as_contract(&s.client.address, || {
            s.env
                .storage()
                .persistent()
                .get(&DataKey::ExposureV2(market_id))
        })
        .unwrap();
    assert_eq!(
        again, v2,
        "the already-migrated entry must not be rewritten"
    );
}

/// The gating decision (ADR 0010 §6) for the contract that holds the capital:
/// a *stalled* admin batch must never lock funds. No `migrate` call ever
/// happens here; the agent's own `agent_buy` migrates exactly the market it
/// is about to touch and still enforces the caps on the way through.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn lazy_migration_on_trade_paths_does_not_wait_for_the_admin_batch() {
    let s = setup();
    let market_id = s.market_id;
    force_stored_version(&s.env, &s.client.address, 1);

    // The first trade on the market migrates its entry and settles normally.
    open_position(&s, 40_000_000);
    let migrated: Option<ExposureV2> = s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .persistent()
            .get(&DataKey::ExposureV2(market_id))
    });
    assert!(
        migrated.is_some(),
        "the touched entry must be migrated by the trade path itself"
    );
    assert_eq!(migrated.unwrap().v1.amount, 40_000_000);

    // No cursor invented by the lazy path, version still 1: the admin batch
    // stays resumable and remains the only thing that flips the version.
    let cursor: Option<MigrationCursor> = s.env.as_contract(&s.client.address, || {
        s.env.storage().instance().get(&DataKey::MigrationCursor)
    });
    assert_eq!(cursor, None);
    assert_eq!(s.client.schema_version(), 1);

    // A second trade on the now-projected market still checks the caps.
    open_position(&s, 40_000_000);
    let exposure = read_exposure(&s.env, &s.client.address, market_id).unwrap();
    assert_eq!(exposure.amount, 80_000_000);
    assert!(exposure.open);
}

/// Interruption cannot corrupt the projection: two batch schedules over the
/// same pre-migration state converge, entry for entry.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn interrupted_batch_resumes_to_the_same_state_as_one_run() {
    let a = setup();
    open_position(&a, 30_000_000);
    force_stored_version(&a.env, &a.client.address, 1);
    let mut done_a = false;
    for _ in 0..64 {
        done_a = a.client.migrate(&1).done;
        if done_a {
            break;
        }
    }
    assert!(done_a);

    let b = setup();
    open_position(&b, 30_000_000);
    force_stored_version(&b.env, &b.client.address, 1);
    assert!(b.client.migrate(&MAX_MIGRATION_BATCH).done);

    for (env, client) in [(&a.env, &a.client), (&b.env, &b.client)] {
        let v2: ExposureV2 = env
            .as_contract(&client.address, || {
                env.storage().persistent().get(&DataKey::ExposureV2(0u64))
            })
            .unwrap();
        assert_eq!(v2.schema, 2);
        assert_eq!(v2.v1.amount, 30_000_000);
        assert!(v2.v1.open);
    }
    assert_eq!(a.client.schema_version(), b.client.schema_version());
}
