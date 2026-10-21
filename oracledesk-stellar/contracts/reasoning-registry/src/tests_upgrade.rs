//! Issue #18 (completion) — in-place contract upgrade + versioned schema
//! migration, reasoning-registry side. Mirrors
//! `contracts/market-core/src/tests_upgrade.rs`,
//! `contracts/resolver/src/tests_upgrade.rs` and
//! `contracts/treasury/src/tests_upgrade.rs` case-for-case, with the
//! registry-specific state under test being per-trace evidence
//! (`DataKey::Trace(id)`), bounded by this contract's own `DataKey::NextId`.
//!
//! Two groups, deliberately separated by feature:
//!
//! * `#[cfg(test)]` cases need only the mechanism (version stamping, the admin
//!   gate, the batch bound, "absent version means 1"). They belong to the
//!   default `cargo test` build and are the ones a maintainer can run as soon
//!   as the workspace compiles again.
//! * `#[cfg(all(test, feature = "test-v2"))]` cases need a build whose schema
//!   is *already* v2 (see the `SCHEMA_VERSION` pair in `lib.rs`). They are
//!   feature-gated because the shipped build must keep the trace storage
//!   layout byte-identical to what consumers and the vendored
//!   `market_core.wasm` describe (`contractimport!`,
//!   docs/adr/0002-cross-contract-calls.md), and because the 1 -> 2 step
//!   itself only exists in that build.
//!
//! Disclosure: **none of these tests has ever been compiled or executed** on
//! the machine that produced this PR, and none can be at this base — the
//! pinned toolchain (1.90.0) is below soroban-sdk 27.0.6's MSRV, `+stable`
//! dies in `oracledesk-types` (21 errors) long before this crate is analysed,
//! and on top of that this crate's `src/lib.rs` does not even *parse* at the
//! base commit (the `publish_batch` function header is missing upstream; see
//! the PR body's registry report). `mod test` in `lib.rs` itself references
//! `market_core::WASM` and undeclared `DataKey`/`Error` variants the same way
//! the fixture below does, so these tests are authored against the *repaired*
//! file, deliberately shaped to run unchanged once upstream restores what the
//! bad merge dropped. Do not merge on the assumption that they pass.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal, String,
};

#[cfg(all(test, feature = "test-v2"))]
extern crate std;

struct Setup {
    env: Env,
    admin: Address,
    agent: Address,
    consumer: Address,
    client: ReasoningRegistryClient<'static>,
    market_id: u64,
}

/// Registry + a real (vendored-interface) market-core with exactly one
/// market, reusing the in-crate `mod test` fixture shape (`register_agent`
/// then `publish_trace` against market 0), but without its 50-market loop:
/// these tests pin the *mechanism*, and the sweep bound is this contract's
/// own `NextId`, not market-core's count.
fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let consumer = Address::generate(&env);
    let creator = Address::generate(&env);

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = StellarAssetClient::new(&env, &collateral.address());
    token.mint(&creator, &(50_000 * 10_000_000_i128));

    let treasury = Address::generate(&env);
    let resolver = Address::generate(&env);
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
    let market_core = market_core::Client::new(&env, &market_core_id);
    // Exactly one market (id 0). The loop-and-ignore-return shape is copied
    // from the in-crate `register_market_core` helper on purpose: this
    // crate's vendored `market_core.wasm` copy is a *different* blob from
    // treasury's (`sha256 a3c539eb… vs ec19a91e…`), so the only call shape
    // known-good against it is the one the existing suite already uses.
    for _ in 0..1 {
        market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[11u8; 32]),
            &BytesN::from_array(&env, &[111u8; 32]),
            &String::from_str(&env, "ipfs://upgrade-test"),
            &market_core::Category::Crypto,
            &(env.ledger().timestamp() + 60_000),
            &(100 * 10_000_000_i128),
            &5000u32,
        );
    }
    let market_id = 0u64;

    let contract_id = env.register(
        ReasoningRegistry,
        ReasoningRegistryArgs::__constructor(&admin, &market_core_id),
    );
    let client = ReasoningRegistryClient::new(&env, &contract_id);
    client.register_agent(&agent);
    Setup {
        env,
        admin,
        agent,
        consumer,
        client,
        market_id,
    }
}

/// Publishes one trace through the real entrypoint so `DataKey::Trace(id)`,
/// the market index and `NextId` all move the way production moves them.
/// `seq` seeds distinct hashes so two traces are never confused.
fn publish_trace(s: &Setup, seq: u8) -> u64 {
    s.client.publish_trace(
        &s.agent,
        &s.market_id,
        &TraceAction::Buy,
        &BytesN::from_array(&s.env, &[seq; 32]),
        &String::from_str(&s.env, "ipfs://trace-upgrade"),
    )
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
fn read_trace(env: &Env, contract_id: &Address, trace_id: u64) -> Option<Trace> {
    env.as_contract(contract_id, || {
        env.storage().persistent().get(&DataKey::Trace(trace_id))
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
    assert_eq!(
        stored_version(&s.env, &s.client.address).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// The backwards-compatibility requirement: an instance from *before* this
/// feature has no `SchemaVersion` key. It must read as 1, and `migrate` must
/// find nothing to do — and must not invent state for old deployments. For
/// the registry "must not move" means the published evidence itself.
#[test]
fn absent_schema_version_is_read_as_one_and_needs_no_migration() {
    let s = setup();
    let trace_id = publish_trace(&s, 1);
    let trace_before = read_trace(&s.env, &s.client.address, trace_id);

    s.env.as_contract(&s.client.address, || {
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
    assert_eq!(stored_version(&s.env, &s.client.address), None);
    // The trace entry and the id counter are untouched.
    assert_eq!(
        read_trace(&s.env, &s.client.address, trace_id),
        trace_before
    );
    assert_eq!(s.client.trace_count(), 1);
}

/// `upgrade` swaps the code that guards the audit trail every consumer acts
/// on, so it is admin-only: a non-admin caller must fail on `require_admin`,
/// the same guard `register_agent` / `flag_trace` use.
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
    publish_trace(&s, 1);

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
/// `migrate` until `done`. For the registry the thing that must not move is
/// the published evidence and its id counter.
#[test]
fn migrate_on_a_current_instance_is_idempotent() {
    let s = setup();
    let trace_id = publish_trace(&s, 1);
    let trace_before = read_trace(&s.env, &s.client.address, trace_id);

    let first = s.client.migrate(&10);
    let second = s.client.migrate(&10);
    assert_eq!(first, second);
    assert!(first.done);
    assert_eq!(first.processed, 0);
    assert_eq!(
        read_trace(&s.env, &s.client.address, trace_id),
        trace_before
    );
}

// ---------------------------------------------------------------------------
// migration — `--features test-v2` build (never executed on the PR box)
// ---------------------------------------------------------------------------

/// The case the issue asks for by name: published evidence survives an
/// upgrade with a *consumed* trace. The sweep converts entry by entry; the
/// legacy `Trace(id)` stays authoritative and every projected `TraceV2`
/// carries the exact v1 record, so `verify_trace` / `get_trace` answers are
/// the ones from before the swap.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn trace_evidence_survives_the_upgrade_with_a_consumed_trace() {
    let s = setup();
    let t0 = publish_trace(&s, 1);
    let t1 = publish_trace(&s, 2);
    s.client.register_consumer(&s.consumer);
    let consumed = s.client.consume_trace(&s.consumer, &t0);
    let trace_before = read_trace(&s.env, &s.client.address, t1);

    force_stored_version(&s.env, &s.client.address, 1);
    let p = s.client.migrate(&MAX_MIGRATION_BATCH);
    assert!(p.done);
    assert_eq!(p.processed, 2);
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);

    // Nothing moved: same traces, same counter, and the projections agree.
    assert_eq!(s.client.get_trace(&t1), trace_before);
    assert_eq!(s.client.trace_count(), 2);
    assert!(s.client.is_consumed(&t0));
    assert_eq!(consumed, s.client.get_trace(&t0));
    for id in [t0, t1] {
        let v2: TraceV2 = s
            .env
            .as_contract(&s.client.address, || {
                s.env.storage().persistent().get(&DataKey::TraceV2(id))
            })
            .unwrap();
        assert_eq!(v2.schema, 2);
        assert_eq!(v2.v1, s.client.get_trace(&id));
    }
}

/// Batched, resumable sweep over trace state: partial batches persist the
/// cursor, do not flip the version, and the replayed tail is a no-op. Mirrors
/// market-core's `migrate_in_batches_preserves_markets_and_positions`.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn migrate_is_idempotent_and_bounded_over_traces() {
    let s = setup();
    for seq in 1..=3u8 {
        publish_trace(&s, seq);
    }
    force_stored_version(&s.env, &s.client.address, 1);

    // A batch of 1 processes at most one id, keeps the version down, and
    // leaves a resumable cursor; ids without a source entry write nothing,
    // which is what makes replay cheap.
    let first = s.client.migrate(&1);
    assert_eq!(first.processed, 1);
    assert!(!first.done);
    assert_eq!(s.client.schema_version(), 1);
    let cursor: MigrationCursor = s
        .env
        .as_contract(&s.client.address, || {
            s.env.storage().instance().get(&DataKey::MigrationCursor)
        })
        .unwrap();
    assert_eq!(cursor.next_id, 1);

    let second = s.client.migrate(&1);
    assert_eq!(second.processed, 1);
    assert_eq!(s.client.schema_version(), 1);

    let third = s.client.migrate(&1);
    assert!(third.done);
    assert_eq!(s.client.schema_version(), SCHEMA_VERSION);
    let cursor: Option<MigrationCursor> = s.env.as_contract(&s.client.address, || {
        s.env.storage().instance().get(&DataKey::MigrationCursor)
    });
    assert_eq!(cursor, None, "the cursor is removed once done");

    // Replay after `done`: a no-op on a current instance, and the projections
    // are untouched.
    let v2: TraceV2 = s
        .env
        .as_contract(&s.client.address, || {
            s.env.storage().persistent().get(&DataKey::TraceV2(0u64))
        })
        .unwrap();
    force_stored_version(&s.env, &s.client.address, 1);
    s.client.migrate(&MAX_MIGRATION_BATCH);
    let again: TraceV2 = s
        .env
        .as_contract(&s.client.address, || {
            s.env.storage().persistent().get(&DataKey::TraceV2(0u64))
        })
        .unwrap();
    assert_eq!(
        again, v2,
        "the already-migrated entry must not be rewritten"
    );
}

/// The gating decision (ADR 0010 §6) for the contract that gates consumer
/// actions: a *stalled* admin batch must never freeze a redemption backed by
/// a trace. No `migrate` call ever happens here; the consumer's own
/// `consume_trace` migrates exactly the trace it is about to read and
/// proceeds.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn lazy_migration_on_consumer_path_does_not_wait_for_the_admin_batch() {
    let s = setup();
    let t0 = publish_trace(&s, 1);
    let t1 = publish_trace(&s, 2);
    s.client.register_consumer(&s.consumer);
    force_stored_version(&s.env, &s.client.address, 1);

    // The first consume migrates *only* the trace it touches and succeeds.
    let trace = s.client.consume_trace(&s.consumer, &t0);
    assert_eq!(trace.trace_hash, BytesN::from_array(&s.env, &[1u8; 32]));
    let migrated: Option<TraceV2> = s.env.as_contract(&s.client.address, || {
        s.env.storage().persistent().get(&DataKey::TraceV2(t0))
    });
    assert!(
        migrated.is_some(),
        "the touched trace must be migrated by the consumer path itself"
    );
    assert_eq!(migrated.unwrap().v1, trace);
    let untouched: Option<TraceV2> = s.env.as_contract(&s.client.address, || {
        s.env.storage().persistent().get(&DataKey::TraceV2(t1))
    });
    assert_eq!(untouched, None, "the sweep is still the admin's job");

    // No cursor invented by the lazy path, version still 1: the admin batch
    // stays resumable and remains the only thing that flips the version.
    let cursor: Option<MigrationCursor> = s.env.as_contract(&s.client.address, || {
        s.env.storage().instance().get(&DataKey::MigrationCursor)
    });
    assert_eq!(cursor, None);
    assert_eq!(s.client.schema_version(), 1);

    // The same consumer's second call is refused for the *pre-existing*
    // reason (single-use), not a migration reason: the lazy step never
    // blocks a path.
    assert_eq!(
        s.client.try_consume_trace(&s.consumer, &t0),
        Err(Ok(Error::TraceAlreadyConsumed))
    );
}

/// Interruption cannot corrupt the projection: two batch schedules over the
/// same pre-migration state converge, entry for entry.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn interrupted_batch_resumes_to_the_same_state_as_one_run() {
    let a = setup();
    for seq in 1..=4u8 {
        publish_trace(&a, seq);
    }
    force_stored_version(&a.env, &a.client.address, 1);
    let mut done_a = false;
    for _ in 0..16 {
        done_a = a.client.migrate(&1).done;
        if done_a {
            break;
        }
    }
    assert!(done_a);

    let b = setup();
    for seq in 1..=4u8 {
        publish_trace(&b, seq);
    }
    force_stored_version(&b.env, &b.client.address, 1);
    assert!(b.client.migrate(&MAX_MIGRATION_BATCH).done);

    for id in 0..4u64 {
        let va: TraceV2 = a
            .env
            .as_contract(&a.client.address, || {
                a.env.storage().persistent().get(&DataKey::TraceV2(id))
            })
            .unwrap();
        let vb: TraceV2 = b
            .env
            .as_contract(&b.client.address, || {
                b.env.storage().persistent().get(&DataKey::TraceV2(id))
            })
            .unwrap();
        assert_eq!(va.schema, 2);
        assert_eq!(va.v1, vb.v1, "one scheduled sweep == the other");
        assert_eq!(va.v1, b.client.get_trace(&id));
    }
    assert_eq!(a.client.schema_version(), b.client.schema_version());
}
