//! Issue #18 — in-place contract upgrade + versioned schema migration,
//! market-core side.
//!
//! Two groups, deliberately separated by feature:
//!
//! * `#[cfg(test)]` cases need only the mechanism (version stamping, the admin
//!   gate, the batch bound, "absent version means 1"). They belong to the
//!   default `cargo test` build and are the ones a maintainer can run as soon
//!   as the workspace compiles again.
//! * `#[cfg(all(test, feature = "test-v2"))]` cases need a build whose schema
//!   is *already* v2 (see the `SCHEMA_VERSION` pair in `lib.rs`). They are
//!   feature-gated because the shipped build must keep `Market`'s storage
//!   layout byte-identical to the `market_core.wasm` that resolver and treasury
//!   vendor (`contractimport!`, docs/adr/0002-cross-contract-calls.md).
//!   The one case that swaps real code (`upgrade_swaps_the_v2_blob_and_keeps_…`)
//!   additionally needs the artifact produced by `make build`
//!   (`target/wasm32v1-none/release/market_core.wasm` of a `--features test-v2`
//!   build), which is *not* committed here; it is passed in through
//!   `ORACLEDESK_MARKET_CORE_V2_WASM`.
//!
//! Disclosure: none of these tests has been executed on the machine that
//! produced this PR. The workspace does not compile at this base for two
//! pre-existing reasons unrelated to this file — an illegal `//!` header in the
//! file `include!`d by `contracts/resolver/build.rs` and `contracts/treasury/build.rs`
//! (14 x E0753 before anything else is even type-checked), and a
//! `rust-toolchain.toml` pin of 1.90.0, below soroban-sdk 27's MSRV. Run them
//! with `cargo test -p market-core` (mechanism) and
//! `cargo test -p market-core --features test-v2` (migration) once that is
//! fixed. Do not merge on the assumption that they pass.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal, String,
};

#[cfg(all(test, feature = "test-v2"))]
extern crate std;

/// Same shape as the in-crate `setup_market_full`, kept local so this module
/// cannot perturb the existing test suite's helpers.
fn setup() -> (
    Env,
    MarketCoreClient<'static>,
    Address,
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
    let issuer = StellarAssetClient::new(&env, &collateral.address());
    issuer.mint(&creator, &10_000_000_000_i128);
    issuer.mint(&trader, &10_000_000_000_i128);

    let contract_id = env.register(
        MarketCore,
        MarketCoreArgs::__constructor(
            &admin,
            &collateral.address(),
            &treasury,
            &resolver,
            &100u32,
            &10_000u32,
        ),
    );
    let client = MarketCoreClient::new(&env, &contract_id);
    (
        env,
        client,
        admin,
        creator,
        trader,
        resolver,
        collateral.address(),
    )
}

/// `n` open markets, each seeded 100 USDC at 50/50.
fn seed_markets(env: &Env, client: &MarketCoreClient<'_>, creator: &Address, n: u64) {
    for _ in 0..n {
        client.create_market(
            creator,
            &BytesN::from_array(env, &[1u8; 32]),
            &BytesN::from_array(env, &[2u8; 32]),
            &String::from_str(env, "ipfs://upgrade-test"),
            &Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5_000u32,
        );
    }
}

/// Pretend this instance predates the migration: drop the version key, or
/// lower it, exactly as an upgrade of an old deployment would leave it.
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

// ---------------------------------------------------------------------------
// mechanism — default build
// ---------------------------------------------------------------------------

/// A fresh deploy stamps the version it writes, so `migrate` has something to
/// compare against later.
#[test]
fn constructor_stamps_the_current_schema_version() {
    let (env, client, _, _, _, _, _) = setup();
    assert_eq!(client.schema_version(), SCHEMA_VERSION);
    assert_eq!(
        stored_version(&env, &client.address).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// The issue's backwards-compatibility requirement, spelled out: an instance
/// from *before* this feature has no `SchemaVersion` key at all. Reading it
/// must yield 1 (not `NotInitialized`, not a panic), and `migrate` must then
/// find nothing to do rather than rewriting the world.
#[test]
fn absent_schema_version_is_read_as_one_and_needs_no_migration() {
    let (env, client, _, creator, _, _, _) = setup();
    seed_markets(&env, &client, &creator, 2);

    let contract_id = client.address.clone();
    env.as_contract(&contract_id, || {
        env.storage().instance().remove(&DataKey::SchemaVersion);
    });

    assert_eq!(client.schema_version(), PRE_VERSIONING_SCHEMA_VERSION);
    assert_eq!(client.schema_version(), 1);

    // A v1 build over a v1 instance: done immediately, nothing processed, and
    // still no version key written (a no-op `migrate` must not start
    // inventing state for old deployments).
    let progress = client.migrate(&MAX_MIGRATION_BATCH);
    assert_eq!(
        progress,
        MigrationProgress {
            from_version: 1,
            to_version: 1,
            processed: 0,
            next_id: 2,
            done: true,
        }
    );
    assert_eq!(stored_version(&env, &contract_id), None);
    // The markets are untouched.
    assert_eq!(client.get_market(&0).status, MarketStatus::Open);
    assert_eq!(client.get_market(&1).status, MarketStatus::Open);
}

/// `upgrade` swaps the code that secures every position in the contract, so it
/// is admin-only: a non-admin caller must fail on the `require_admin` auth, the
/// same guard `set_paused` / `set_default_fee_bps` use.
#[test]
fn upgrade_is_admin_gated() {
    let (env, client, admin, _, trader, _, _) = setup();
    let hash = BytesN::from_array(&env, &[7u8; 32]);

    // Explicitly authorise the *trader* for the call: the contract's admin is a
    // different address, so `require_admin` must reject it (mirrors
    // `propose_resolver_requires_admin`'s shape).
    env.set_auths(&[]);
    let as_trader = client.mock_auths(&[MockAuth {
        address: &trader,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(as_trader.try_upgrade(&hash).is_err());

    // And the admin reaches the wasm-lookup step instead (see the next test:
    // the hash below was never installed, so this still fails — just later).
    env.set_auths(&[]);
    let as_admin = client.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(as_admin.try_upgrade(&hash).is_err());
}

/// `upgrade` takes a wasm *hash*, not bytes: the target must already be
/// installed on this network (`stellar contract install`, done by
/// `scripts/upgrade.sh` before it invokes `upgrade`). An uninstalled hash must
/// fail rather than brick the instance.
#[test]
fn upgrade_rejects_a_wasm_hash_that_was_never_installed() {
    let (env, client, _, _, _, _, _) = setup();
    let bogus = BytesN::from_array(&env, &[0u8; 32]);
    assert!(client.try_upgrade(&bogus).is_err());
    // Storage is untouched by the failed attempt.
    assert_eq!(client.schema_version(), SCHEMA_VERSION);
}

/// `batch` is caller-provided and must be clamped: 0 would spin, and an
/// unbounded batch would let the admin write a sweep large enough to trap on
/// the instruction budget. `MAX_MIGRATION_BATCH` is the contract's bound.
#[test]
fn migrate_batch_is_bounded_at_both_ends() {
    let (env, client, _, creator, _, _, _) = setup();
    seed_markets(&env, &client, &creator, 1);

    assert_eq!(
        client.try_migrate(&0),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert_eq!(
        client.try_migrate(&(MAX_MIGRATION_BATCH + 1)),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert_eq!(
        client.try_migrate(&(MAX_MIGRATION_BATCH + 1_000_000)),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    // The exact bound is accepted.
    assert!(client.try_migrate(&MAX_MIGRATION_BATCH).is_ok());
    // Nothing was written by the rejected calls.
    assert_eq!(
        stored_version(&env, &client.address).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// A `migrate` on a current instance is idempotent and emits one `Migrated`
/// event per call — the property `scripts/upgrade.sh` relies on when it loops
/// `migrate` until `done` and then verifies `schema_version`.
#[test]
fn migrate_on_a_current_instance_is_idempotent() {
    let (env, client, _, creator, _, _, _) = setup();
    seed_markets(&env, &client, &creator, 3);
    let before = client.get_market(&2);

    let first = client.migrate(&10);
    let second = client.migrate(&10);
    assert_eq!(first, second);
    assert!(first.done);
    assert_eq!(first.processed, 0);
    assert_eq!(client.market_count(), 3);
    assert_eq!(client.get_market(&2), before);
    assert_eq!(env.events().all().events().len(), 1);
}

// ---------------------------------------------------------------------------
// migration — `--features test-v2` build (never executed on the PR box)
// ---------------------------------------------------------------------------

/// The core promise of an in-place upgrade: swapping the code must not lose or
/// alter a single market or position. Under `test-v2` the storage is treated as
/// pre-migration, the sweep runs in batches, and every entry reads back
/// identically through the compatibility view (`get_market` still decodes the
/// untouched v1 `Market`, so resolver's vendored client keeps working).
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn migrate_in_batches_preserves_markets_and_positions() {
    let (env, client, _, creator, trader, _, _) = setup();
    seed_markets(&env, &client, &creator, 5);
    client.buy(&trader, &1, &Outcome::Yes, &10_000_000_i128, &0i128);
    let markets_before: std::vec::Vec<Market> = (0..5u64).map(|i| client.get_market(&i)).collect();
    let pos_before = client.get_position(&1, &trader);

    // The instance is "old": version lowered to 1 while the build is 2.
    force_stored_version(&env, &client.address, 1);

    let first = client.migrate(&2);
    assert_eq!(first.processed, 2);
    assert_eq!(first.next_id, 2);
    assert!(!first.done);
    assert_eq!(
        first.to_version, 1,
        "a partial sweep must not flip the version"
    );
    // Resume point persisted so the next call continues instead of restarting.
    let cursor: MigrationCursor = env
        .as_contract(&client.address, || {
            env.storage().instance().get(&DataKey::MigrationCursor)
        })
        .unwrap();
    assert_eq!(
        cursor,
        MigrationCursor {
            from_version: 1,
            next_id: 2,
            done: false
        }
    );

    let second = client.migrate(&10);
    assert_eq!(second.processed, 3);
    assert!(second.done);
    assert_eq!(second.to_version, SCHEMA_VERSION);
    assert_eq!(client.schema_version(), SCHEMA_VERSION);

    // Nothing lost: every market and the trader's position read back as before,
    // and the v2 projections carry the identical v1 payload.
    for i in 0..5u64 {
        assert_eq!(client.get_market(&i), markets_before[i as usize]);
    }
    assert_eq!(client.get_position(&1, &trader), pos_before);
    let v2: MarketV2 = env
        .as_contract(&client.address, || {
            env.storage().persistent().get(&DataKey::MarketV2(1u64))
        })
        .unwrap();
    assert_eq!(v2.schema, 2);
    assert_eq!(v2.v1, client.get_market(&1));

    // Cursor is gone once done, and a replay is a no-op.
    let cursor_after: Option<MigrationCursor> = env.as_contract(&client.address, || {
        env.storage().instance().get(&DataKey::MigrationCursor)
    });
    assert_eq!(cursor_after, None);
    assert_eq!(client.migrate(&10).processed, 0);
}

/// Two different batch schedules over the same data must reach the same state
/// — resumability. `5 x batch 1` vs `1 x batch 5` (the "uninterrupted" run).
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn interrupted_batch_resumes_to_the_same_state_as_one_run() {
    let (env_a, client_a, _, creator_a, _, _, _) = setup();
    seed_markets(&env_a, &client_a, &creator_a, 4);
    force_stored_version(&env_a, &client_a.address, 1);
    let mut done_a = false;
    for _ in 0..10 {
        let p = client_a.migrate(&1);
        done_a = p.done;
        if done_a {
            break;
        }
    }
    assert!(done_a);

    let (env_b, client_b, _, creator_b, _, _, _) = setup();
    seed_markets(&env_b, &client_b, &creator_b, 4);
    force_stored_version(&env_b, &client_b.address, 1);
    assert!(client_b.migrate(&4).done);

    for id in 0..4u64 {
        let a: Option<MarketV2> = env_a.as_contract(&client_a.address, || {
            env_a.storage().persistent().get(&DataKey::MarketV2(id))
        });
        let b: Option<MarketV2> = env_b.as_contract(&client_b.address, || {
            env_b.storage().persistent().get(&DataKey::MarketV2(id))
        });
        assert_eq!(a.is_some(), b.is_some());
        assert_eq!(a.map(|v| v.schema), b.map(|v| v.schema));
        // v1 payloads differ only in `creator`/`lp` addresses (two fresh test
        // envs), so compare the shape-critical fields.
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.v1.status, b.v1.status);
        assert_eq!(a.v1.reserve_yes, b.v1.reserve_yes);
        assert_eq!(a.v1.sets_minted, b.v1.sets_minted);
    }
    assert_eq!(client_a.schema_version(), client_b.schema_version());
}

/// Idempotence of a *single* entry, the other direction: a market already
/// migrated is not rewritten when the sweep passes over it again (a cursor
/// reset after a later upgrade replays ids 0..n).
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn re_running_a_step_over_the_same_entry_writes_nothing() {
    let (env, client, _, creator, _, _, _) = setup();
    seed_markets(&env, &client, &creator, 1);
    force_stored_version(&env, &client.address, 1);

    let first = client.migrate(&10);
    assert_eq!(first.processed, 1);
    let written: MarketV2 = env
        .as_contract(&client.address, || {
            env.storage().persistent().get(&DataKey::MarketV2(0u64))
        })
        .unwrap();

    // Lower the version again and replay the same id: the projection already
    // exists, so the step is skipped and the entry is byte-identical.
    force_stored_version(&env, &client.address, 1);
    let again = client.migrate(&10);
    assert_eq!(again.processed, 1);
    let after: MarketV2 = env
        .as_contract(&client.address, || {
            env.storage().persistent().get(&DataKey::MarketV2(0u64))
        })
        .unwrap();
    assert_eq!(after, written);
}

/// The gating decision (ADR 0010): a *stalled* admin batch must never freeze
/// user funds, so the paths that touch a market migrate that one entry first
/// and then proceed. Here no `migrate` call ever happens; a `buy` and a
/// `redeem`-able market still work while the instance is on version 1, and each
/// migrates only the entry it used.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn lazy_migration_on_user_paths_does_not_wait_for_the_admin_batch() {
    let (env, client, _, creator, trader, resolver, _) = setup();
    seed_markets(&env, &client, &creator, 2);
    force_stored_version(&env, &client.address, 1);

    // A user trade on market 1 migrates entry 1 and still settles normally.
    client.buy(&trader, &1, &Outcome::Yes, &10_000_000_i128, &0i128);
    let migrated_1: Option<MarketV2> = env.as_contract(&client.address, || {
        env.storage().persistent().get(&DataKey::MarketV2(1u64))
    });
    assert!(migrated_1.is_some(), "the touched entry must be migrated");
    let migrated_0: Option<MarketV2> = env.as_contract(&client.address, || {
        env.storage().persistent().get(&DataKey::MarketV2(0u64))
    });
    assert_eq!(migrated_0, None, "an untouched entry must not be swept");

    // No cursor was invented by the lazy path, and the version stays 1: the
    // admin batch is still resumable and remains the only thing that flips it.
    let cursor: Option<MigrationCursor> = env.as_contract(&client.address, || {
        env.storage().instance().get(&DataKey::MigrationCursor)
    });
    assert_eq!(cursor, None);
    assert_eq!(client.schema_version(), 1);

    // Resolution of the migrated market still works end to end.
    let close = client.get_market(&1).close_time;
    env.ledger().set_timestamp(close + 1);
    client.resolve(&1, &Outcome::Yes);
    assert_eq!(
        client.get_market(&1).status,
        MarketStatus::Resolved(Outcome::Yes)
    );
    let payout = client.redeem(&trader, &1);
    assert!(payout > 0);
    let _ = resolver;
}

/// The real cross-version case: install this crate's `test-v2` wasm, upgrade
/// into it, and assert the pre-upgrade markets survive the swap. Needs the
/// artifact `make build` produces; it is *not* committed in this PR (the repo's
/// seven vendored blobs cannot be rebuilt on an ordinary dev box — stellar CLI
/// 22.0.0 vs the expected 27.1.0), so the path is supplied out of band.
///
/// This test has never run anywhere, including CI, and CI has never run on this
/// repository at all. Treat it as a specification of the check, not as evidence.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn upgrade_swaps_the_v2_blob_and_keeps_every_market() {
    let path = std::env::var("ORACLEDESK_MARKET_CORE_V2_WASM")
        .expect("set ORACLEDESK_MARKET_CORE_V2_WASM to the `make build` output, e.g. target/wasm32v1-none/release/market_core.wasm");
    let wasm = std::fs::read(&path).expect("v2 blob missing — run `make build` first");
    let (env, client, _, creator, trader, _, _) = setup();
    seed_markets(&env, &client, &creator, 2);
    client.buy(&trader, &0, &Outcome::Yes, &10_000_000_i128, &0i128);
    let before = client.get_market(&0);
    let pos_before = client.get_position(&0, &trader);

    let hash = env.deployer().upload_contract_wasm(wasm.as_slice());
    client.upgrade(&hash);
    assert_eq!(client.schema_version(), SCHEMA_VERSION);
    assert_eq!(client.get_market(&0), before);
    assert_eq!(client.get_position(&0, &trader), pos_before);

    // The upgrade did not run the constructor, so a pre-migration instance
    // still reports the version it was deployed with — the whole reason
    // `scripts/upgrade.sh` invokes `migrate` after `upgrade`.
    let _ = client.migrate(&MAX_MIGRATION_BATCH);
    assert_eq!(client.get_market(&0), before);
}
