//! Issue #18 — in-place contract upgrade + versioned schema migration,
//! resolver side.
//!
//! `#[cfg(test)]` cases run in the default build. The cases that need a build
//! whose schema is already v2 (`SCHEMA_VERSION = 2`, the eager 1 -> 2 sweep in
//! `migrate_from`) are behind `#[cfg(all(test, feature = "test-v2"))]`, because
//! the shipped build must not widen what resolver reads through its vendored
//! `market_core.wasm` (docs/adr/0002-cross-contract-calls.md).
//!
//! Disclosure: none of these tests has been executed on the machine that
//! produced this PR, and no compiler has read this file. Measured at this base:
//! `rust-toolchain.toml` pins 1.90.0 while `Cargo.lock` holds soroban-sdk
//! 27.0.6, which requires rustc 1.91.0, so a check exits at dependency
//! resolution (EXIT 101) before compiling anything; with a 1.91 toolchain the
//! build dies inside `contracts/oracledesk-types` — 21 errors, 16 of them
//! "cannot find attribute `contracttype`", which that crate uses without
//! importing — so nothing downstream of it is analysed. resolver would
//! additionally fail on an illegal `//!` header in the file
//! `contracts/resolver/build.rs` `include!`s
//! (`scripts/verify-wasm-hash.rs` — read from source, never reached by a
//! compiler here). Run with `cargo test -p resolver`, or `cargo test -p resolver
//! --features test-v2` for the migration group, once the workspace builds again.
//! Do not merge on the assumption that they pass.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal, Vec,
};

#[cfg(all(test, feature = "test-v2"))]
extern crate std;

const NETWORK_ID: [u8; 32] = [7; 32];
const DISPUTE_WINDOW: u64 = 100;

/// A signer-mode market wired to the *vendored* `market_core.wasm`, the same
/// way the in-crate fixtures do (`env.register(market_core::WASM, …)`), so the
/// cross-contract half of the sweep is exercised against the blob that ships.
struct Fixture {
    env: Env,
    admin: Address,
    resolver: ResolverClient<'static>,
    resolver_id: Address,
    market_core: MarketCoreClient<'static>,
    market_id: u64,
    signer_a: Address,
    signer_b: Address,
}

fn fixture(markets: u64) -> Fixture {
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

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = StellarAssetClient::new(&env, &collateral.address());
    token.mint(&creator, &(1_000 * 10_000_000_i128));

    let spec = SignerConfig {
        signers: Vec::from_array(&env, [signer_a.clone(), signer_b.clone()]),
        threshold: 2,
        dispute_window: DISPUTE_WINDOW,
    };
    let resolution_hash = legacy_spec_hash(&env, &ResolutionSpec::Signers(spec.clone()));

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
    let market_core = MarketCoreClient::new(&env, &market_core_id);
    let mut market_id = 0u64;
    for _ in 0..markets.max(1) {
        market_id = market_core.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &resolution_hash.clone(),
            &soroban_sdk::String::from_str(&env, "ipfs://resolver-upgrade-test"),
            &Category::Crypto,
            &2_000,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
    }

    env.register_at(
        &resolver_id,
        Resolver,
        ResolverArgs::__constructor(&admin, &market_core_id),
    );
    let resolver = ResolverClient::new(&env, &resolver_id);
    resolver.register_signer_spec(&market_id, &spec);

    Fixture {
        env,
        admin,
        resolver,
        resolver_id,
        market_core,
        market_id,
        signer_a,
        signer_b,
    }
}

#[cfg(test)]
fn stored_version(env: &Env, resolver_id: &Address) -> Option<u32> {
    env.as_contract(resolver_id, || {
        env.storage().instance().get(&DataKey::SchemaVersion)
    })
}

/// Pretend this instance predates issue #18, exactly as an upgrade of an old
/// deployment leaves it: the new version's `__constructor` never ran, so the
/// stored number is the *old* one.
#[cfg(all(test, feature = "test-v2"))]
fn force_stored_version(env: &Env, resolver_id: &Address, version: u32) {
    env.as_contract(resolver_id, || {
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &version);
    });
}

// ---------------------------------------------------------------------------
// mechanism — default build
// ---------------------------------------------------------------------------

#[test]
fn constructor_stamps_the_current_schema_version() {
    let f = fixture(1);
    assert_eq!(f.resolver.schema_version(), SCHEMA_VERSION);
    assert_eq!(
        stored_version(&f.env, &f.resolver_id).as_ref(),
        Some(&SCHEMA_VERSION)
    );
}

/// Backwards compatibility as the issue states it: no `SchemaVersion` key is
/// version 1, must not error, and must not trigger a rewrite.
#[test]
fn absent_schema_version_is_read_as_one_and_needs_no_migration() {
    let f = fixture(1);
    env_drop_version(&f.env, &f.resolver_id);

    assert_eq!(f.resolver.schema_version(), 1);
    let progress = f.resolver.migrate(&MAX_MIGRATION_BATCH);
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
    // The no-op sweep invented no state, and the market's resolution config is
    // untouched.
    assert_eq!(stored_version(&f.env, &f.resolver_id), None);
    assert_eq!(
        cursor_of(&f.env, &f.resolver_id),
        None,
        "a current instance must not grow a cursor"
    );
    assert_ne!(
        f.resolver.state(&f.market_id),
        ResolutionState::Unconfigured,
        "the revealed spec must survive a no-op migrate"
    );
}

#[cfg(test)]
fn env_drop_version(env: &Env, resolver_id: &Address) {
    env.as_contract(resolver_id, || {
        env.storage().instance().remove(&DataKey::SchemaVersion);
    });
}

#[cfg(test)]
fn cursor_of(env: &Env, resolver_id: &Address) -> Option<MigrationCursor> {
    env.as_contract(resolver_id, || {
        env.storage().instance().get(&DataKey::MigrationCursor)
    })
}

/// `upgrade` replaces the code that finalizes every dispute, so it is
/// admin-only: the same `require_admin` shape as `propose_admin`.
#[test]
fn upgrade_is_admin_gated() {
    let f = fixture(1);
    let hash = BytesN::from_array(&f.env, &[9u8; 32]);
    let not_admin = Address::generate(&f.env);

    f.env.set_auths(&[]);
    let as_stranger = f.resolver.mock_auths(&[MockAuth {
        address: &not_admin,
        invoke: &MockAuthInvoke {
            contract: &f.resolver_id,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(as_stranger.try_upgrade(&hash).is_err());
    // With no auth supplied at all the admin's `require_auth` still refuses.
    f.env.set_auths(&[]);
    assert!(f.resolver.try_upgrade(&hash).is_err());
    // The admin gets past the guard (and then fails on the uninstalled hash).
    f.env.mock_all_auths();
    assert!(f.resolver.try_upgrade(&hash).is_err());
    assert_eq!(f.resolver.schema_version(), SCHEMA_VERSION);
}

/// The hash must already be installed on this network: `upgrade` takes a
/// `BytesN<32>`, not bytes. `scripts/upgrade.sh` installs first for this
/// reason.
#[test]
fn upgrade_rejects_a_wasm_hash_that_was_never_installed() {
    let f = fixture(1);
    let bogus = BytesN::from_array(&f.env, &[0u8; 32]);
    assert!(f.resolver.try_upgrade(&bogus).is_err());
    assert_eq!(f.resolver.schema_version(), SCHEMA_VERSION);
    assert_ne!(
        f.resolver.state(&f.market_id),
        ResolutionState::Unconfigured,
        "the revealed spec must survive a no-op migrate"
    );
}

#[test]
fn migrate_batch_is_bounded_at_both_ends() {
    let f = fixture(1);
    assert_eq!(
        f.resolver.try_migrate(&0),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert_eq!(
        f.resolver.try_migrate(&(MAX_MIGRATION_BATCH + 1)),
        Err(Ok(Error::MigrationBatchTooLarge))
    );
    assert!(f.resolver.try_migrate(&MAX_MIGRATION_BATCH).is_ok());
}

#[test]
fn migrate_on_a_current_instance_is_idempotent() {
    let f = fixture(3);
    let first = f.resolver.migrate(&10);
    let second = f.resolver.migrate(&10);
    assert_eq!(first, second);
    assert!(first.done);
    assert_eq!(first.processed, 0);
    // Nothing about the markets moved.
    assert_ne!(
        f.resolver.state(&f.market_id),
        ResolutionState::Unconfigured,
        "the revealed spec must survive a no-op migrate"
    );
    assert_eq!(f.market_core.get_market(&f.market_id).close_time, 2_000);
}

// ---------------------------------------------------------------------------
// migration — `--features test-v2` build (never executed on the PR box)
// ---------------------------------------------------------------------------

/// The issue's resolver-specific requirement: an upgrade that lands *while a
/// dispute window is open* must not lose the proposal, the tally, or the
/// per-signer dedupe, and must not move the window.
///
/// The window is `proposed_at + dispute_window`, i.e. pure stored data, so the
/// guarantee is really "the sweep preserves `proposed_at` exactly". This test
/// writes the ADR-0003 *legacy* keys directly (as a pre-#18 instance would hold
/// them), lowers the version, and then resolves the market through the normal
/// entrypoints — `attest` and `finalize_signers`, each of which runs the lazy
/// per-entry step.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn upgrade_mid_dispute_window_preserves_proposal_count_and_attestation() {
    let f = fixture(1);
    let market = f.market_id;
    let proposed_at = 1_500u64;

    f.env.as_contract(&f.resolver_id, || {
        f.env.storage().persistent().set(
            &DataKey::Proposal(market),
            &SignerProposal {
                outcome: Outcome::Yes,
                proposed_at,
            },
        );
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Count(market, Outcome::Yes), &1u32);
        f.env.storage().persistent().set(
            &DataKey::Attestation(market, Outcome::Yes, f.signer_a.clone()),
            &true,
        );
    });
    force_stored_version(&f.env, &f.resolver_id, 1);
    f.env.ledger().set_timestamp(1_550);

    // A second attestation arrives mid-window. The lazy step converts the
    // proposal and folds the legacy tally in, in the same call, and the legacy
    // dedupe flag for signer_a still applies.
    assert_eq!(
        f.resolver
            .try_attest(&market, &f.signer_a, &AttestedOutcome::Yes),
        Err(Ok(Error::AlreadyAttested)),
        "the non-enumerable legacy Attestation flag must still be honoured"
    );
    f.resolver
        .attest(&market, &f.signer_b, &AttestedOutcome::Yes);

    f.env.as_contract(&f.resolver_id, || {
        let p: SignerProposalV2 = f
            .env
            .storage()
            .persistent()
            .get(&DataKey::ProposalV2(market))
            .unwrap();
        // The window is unchanged by the migration: `proposed_at` is carried
        // over verbatim, so finalization is still gated at 1_600.
        assert_eq!(p.proposed_at, proposed_at);
        assert_eq!(p.outcome, AttestedOutcome::Yes);
        assert_eq!(
            f.env
                .storage()
                .persistent()
                .get::<_, u32>(&DataKey::CountV2(market, AttestedOutcome::Yes)),
            Some(2),
            "legacy count folded in exactly once"
        );
        assert!(
            !f.env
                .storage()
                .persistent()
                .has(&DataKey::Count(market, Outcome::Yes)),
            "legacy count deleted in the same invocation that folded it in"
        );
        assert!(
            !f.env.storage().persistent().has(&DataKey::Proposal(market)),
            "legacy proposal retired"
        );
    });

    // Still inside the window: the upgrade did not let anyone finalize early.
    assert_eq!(
        f.resolver.try_finalize_signers(&market),
        Err(Ok(Error::DisputeWindowOpen))
    );
    f.env.ledger().set_timestamp(proposed_at + DISPUTE_WINDOW);
    assert_eq!(f.resolver.finalize_signers(&market), AttestedOutcome::Yes);
    assert_eq!(
        f.market_core.get_market(&market).status,
        MarketStatus::Resolved(Outcome::Yes)
    );
}

/// The batch sweep: bounded, resumable, and driven by market-core's
/// enumeration (resolver has no `NextId` of its own). One market per round
/// versus a single wide batch must end in the same state, and the version flips
/// only on the round that reaches the end.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn migrate_sweep_is_resumable_and_flips_the_version_last() {
    let f = fixture(4);
    force_stored_version(&f.env, &f.resolver_id, 1);
    f.env.as_contract(&f.resolver_id, || {
        for id in 0..4u64 {
            f.env
                .storage()
                .persistent()
                .set(&DataKey::Count(id, Outcome::Yes), &3u32);
        }
    });

    let first = f.resolver.migrate(&2);
    assert_eq!(first.processed, 2);
    assert_eq!(first.next_id, 2);
    assert!(!first.done);
    assert_eq!(
        first.to_version, 1,
        "a partial sweep must not flip the version"
    );
    assert_eq!(
        cursor_of(&f.env, &f.resolver_id),
        Some(MigrationCursor {
            from_version: 1,
            next_id: 2,
            done: false
        })
    );
    assert_eq!(f.resolver.schema_version(), 1);

    let second = f.resolver.migrate(&2);
    assert!(second.done);
    assert_eq!(second.to_version, SCHEMA_VERSION);
    assert_eq!(f.resolver.schema_version(), SCHEMA_VERSION);
    assert_eq!(
        cursor_of(&f.env, &f.resolver_id),
        None,
        "cursor is one-shot"
    );

    // Every enumerable legacy key is folded in and gone; replay is a no-op.
    f.env.as_contract(&f.resolver_id, || {
        for id in 0..4u64 {
            assert_eq!(
                f.env
                    .storage()
                    .persistent()
                    .get::<_, u32>(&DataKey::CountV2(id, AttestedOutcome::Yes)),
                Some(3)
            );
            assert!(
                !f.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Count(id, Outcome::Yes)),
                "legacy count gone for market {id}"
            );
        }
    });
    let third = f.resolver.migrate(&10);
    assert_eq!(third.processed, 0);
    assert!(third.done);
}

/// Lazy migration must not depend on the admin ever running the batch: a
/// `finalize_signers` on an unmigrated market migrates that one entry and
/// proceeds. Here the *sweep* is never run at all.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn lazy_path_migrates_only_the_entry_it_touches_and_never_blocks() {
    let f = fixture(2);
    let other = 0u64;
    let market = f.market_id;
    force_stored_version(&f.env, &f.resolver_id, 1);
    f.env.as_contract(&f.resolver_id, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Count(other, Outcome::No), &5u32);
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Count(market, Outcome::Yes), &5u32);
    });

    // `state()` is a read-only view and must not migrate anything.
    assert_ne!(
        f.resolver.state(&market),
        ResolutionState::Unconfigured,
        "the market is configured before the sweep"
    );
    f.env.as_contract(&f.resolver_id, || {
        assert!(f
            .env
            .storage()
            .persistent()
            .has(&DataKey::Count(market, Outcome::Yes)));
    });

    // A signer attestation touches this market only.
    f.env.ledger().set_timestamp(1_100);
    f.resolver
        .attest(&market, &f.signer_a, &AttestedOutcome::Yes);
    f.env.as_contract(&f.resolver_id, || {
        assert!(
            !f.env
                .storage()
                .persistent()
                .has(&DataKey::Count(market, Outcome::Yes)),
            "the touched entry is migrated"
        );
        assert!(
            f.env
                .storage()
                .persistent()
                .has(&DataKey::Count(other, Outcome::No)),
            "an untouched entry must not be swept by a user transaction"
        );
    });
    // And still no cursor: the lazy path deliberately cannot finish the sweep.
    assert_eq!(cursor_of(&f.env, &f.resolver_id), None);
    assert_eq!(f.resolver.schema_version(), 1);
}

/// The genuine cross-version case: install the `test-v2` blob into a running
/// v1 instance and prove the swap keeps the market, its resolution config and
/// the admin role, then migrate. Needs the `make build` artifact
/// (`target/wasm32v1-none/release/resolver.wasm` of a `--features test-v2`
/// build), supplied out of band because this repo's vendored blobs cannot be
/// rebuilt on an ordinary dev box (stellar CLI 22.0.0 vs the expected 27.1.0).
///
/// Never executed anywhere, including CI, which has never run on this
/// repository. Treat it as a specification of the check, not as evidence.
#[cfg(all(test, feature = "test-v2"))]
#[test]
fn upgrade_swaps_the_v2_blob_and_resolution_still_completes() {
    let path = std::env::var("ORACLEDESK_RESOLVER_V2_WASM")
        .expect("set ORACLEDESK_RESOLVER_V2_WASM to the `make build` output, e.g. target/wasm32v1-none/release/resolver.wasm");
    let wasm = std::fs::read(&path).expect("v2 blob missing — run `make build` first");
    let f = fixture(1);
    let before = f.resolver.state(&f.market_id);
    let admin_before = f.resolver.admin();

    let hash = f.env.deployer().upload_contract_wasm(wasm.as_slice());
    f.resolver.upgrade(&hash);

    // Code swapped, data intact: role, config and market all read back.
    assert_eq!(f.resolver.admin(), admin_before);
    assert_eq!(f.resolver.state(&f.market_id), before);
    assert_eq!(f.market_core.get_market(&f.market_id).close_time, 2_000);

    // The constructor did not run, so the version is still 1 until migrated.
    assert_eq!(f.resolver.schema_version(), 1);
    assert!(f.resolver.migrate(&MAX_MIGRATION_BATCH).done);
    assert_eq!(f.resolver.schema_version(), SCHEMA_VERSION);
}
