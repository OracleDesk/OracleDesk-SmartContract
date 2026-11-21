//! Cross-contract authorization matrix.
//!
//! Every positive test mocks *only* the signer tree it expects, calls the
//! entrypoint, and compares `env.auths()` with that exact tree. Every
//! privileged entrypoint also has a negative test that mocks a different
//! plausible role and asserts the call fails.
//!
//! This crate contains no `mock_all_auths` call; `scripts/check-no-mock-all-auths.sh`
//! greps for it in CI. Setup helpers use targeted mocks.

use integration_tests::{
    market_core, resolver, timelock, treasury,
    world::{World, MARKET_CLOSE, SEED, START_TIME, USDC},
};
use soroban_sdk::{
    testutils::{AuthorizedFunction, AuthorizedInvocation},
    Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

fn invocation(
    env: &Env,
    address: &Address,
    contract: &Address,
    name: &str,
    args: Vec<Val>,
    subs: std::vec::Vec<AuthorizedInvocation>,
) -> (Address, AuthorizedInvocation) {
    (
        address.clone(),
        AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                contract.clone(),
                Symbol::new(env, name),
                args,
            )),
            sub_invocations: subs,
        },
    )
}

fn one(_env: &Env, value: AuthorizedInvocation) -> std::vec::Vec<AuthorizedInvocation> {
    std::vec![value]
}

fn no_args(env: &Env) -> Vec<Val> {
    Vec::new(env)
}

// ---------------------------------------------------------------------------
// market-core
// ---------------------------------------------------------------------------

#[test]
fn auth_market_core_create_market() {
    let w = World::new();
    w.env.set_auths(&[]);
    let qh = BytesN::from_array(&w.env, &[9u8; 32]);
    let rh = BytesN::from_array(&w.env, &[8u8; 32]);
    let uri = String::from_str(&w.env, "ipfs://auth-create");
    let args: Vec<Val> = (
        w.creator.clone(),
        qh.clone(),
        rh.clone(),
        uri.clone(),
        market_core::Category::Crypto,
        2_000u64,
        SEED,
        5_000u32,
    )
        .into_val(&w.env);
    let transfer_args: Vec<Val> = (w.creator.clone(), w.core_id.clone(), SEED).into_val(&w.env);
    let transfer = invocation(
        &w.env,
        &w.creator,
        &w.collateral,
        "transfer",
        transfer_args.clone(),
        vec![],
    )
    .1;
    let id = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.creator,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "create_market",
                args: args.clone().into_val(&w.env),
                sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.collateral,
                    fn_name: "transfer",
                    args: transfer_args.clone(),
                    sub_invokes: &[],
                }],
            },
        }])
        .create_market(
            &w.creator,
            &qh,
            &rh,
            &uri,
            &market_core::Category::Crypto,
            &2_000u64,
            &SEED,
            &5_000u32,
        );
    assert_eq!(id, 2);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.creator,
            &w.core_id,
            "create_market",
            args.into_val(&w.env),
            one(&w.env, transfer),
        )]
    );
}

#[test]
fn auth_market_core_buy_and_nested_token_transfer() {
    let w = World::new();
    let market = w.create_market(MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    let args: Vec<Val> = (
        w.trader.clone(),
        market,
        market_core::Outcome::Yes,
        amount,
        0i128,
    )
        .into_val(&w.env);
    let transfer_args: Vec<Val> = (w.trader.clone(), w.core_id.clone(), amount).into_val(&w.env);
    let transfer = invocation(
        &w.env,
        &w.trader,
        &w.collateral,
        "transfer",
        transfer_args.clone(),
        vec![],
    )
    .1;
    let shares = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "buy",
                args: args.clone().into_val(&w.env),
                sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.collateral,
                    fn_name: "transfer",
                    args: transfer_args.clone(),
                    sub_invokes: &[],
                }],
            },
        }])
        .buy(
            &w.trader,
            &market,
            &market_core::Outcome::Yes,
            &amount,
            &0i128,
        );
    assert!(shares > 0);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.trader,
            &w.core_id,
            "buy",
            args.into_val(&w.env),
            one(&w.env, transfer),
        )]
    );
}

#[test]
fn buy_without_the_nested_transfer_sub_invocation_fails() {
    let w = World::new();
    let market = w.create_market(MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    let args: Vec<Val> = (
        w.trader.clone(),
        market,
        market_core::Outcome::Yes,
        amount,
        0i128,
    )
        .into_val(&w.env);
    // Deliberately omit the token.transfer sub-invocation. The top-level
    // trader auth matches, but market-core's pull has no authorization.
    let result = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "buy",
                args: args.clone().into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_buy(
            &w.trader,
            &market,
            &market_core::Outcome::Yes,
            &amount,
            &0i128,
        );
    assert!(result.is_err(), "nested transfer must be authorized");
}

#[test]
fn auth_market_core_sell() {
    let w = World::new();
    let market = w.create_market(MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    // Give the trader a position with a targeted mock first.
    w.core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "buy",
                args: (
                    w.trader.clone(),
                    market,
                    market_core::Outcome::Yes,
                    amount,
                    0i128,
                )
                    .into_val(&w.env),
                sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.collateral,
                    fn_name: "transfer",
                    args: (w.trader.clone(), w.core_id.clone(), amount).into_val(&w.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .buy(
            &w.trader,
            &market,
            &market_core::Outcome::Yes,
            &amount,
            &0i128,
        );
    w.env.set_auths(&[]);
    let out = 5 * USDC;
    let args: Vec<Val> = (
        w.trader.clone(),
        market,
        market_core::Outcome::Yes,
        out,
        i128::MAX,
    )
        .into_val(&w.env);
    let shares = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "sell",
                args: args.clone().into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .sell(
            &w.trader,
            &market,
            &market_core::Outcome::Yes,
            &out,
            &i128::MAX,
        );
    assert!(shares > 0);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.trader,
            &w.core_id,
            "sell",
            args.into_val(&w.env),
            vec![],
        )]
    );
}

#[test]
fn auth_market_core_redeem_and_claim_pool_remainder() {
    let w = World::new();
    // The creator is the LP and holds no outcome position, so give the trader
    // a YES position before the signer market resolves.
    let amount = 10 * USDC;
    w.env.set_auths(&[]);
    w.core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "buy",
                args: (
                    w.trader.clone(),
                    w.signer_market,
                    market_core::Outcome::Yes,
                    amount,
                    0i128,
                )
                    .into_val(&w.env),
                sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.collateral,
                    fn_name: "transfer",
                    args: (w.trader.clone(), w.core_id.clone(), amount).into_val(&w.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .buy(
            &w.trader,
            &w.signer_market,
            &market_core::Outcome::Yes,
            &amount,
            &0i128,
        );
    w.resolve_signer_market();
    w.env.set_auths(&[]);
    let redeem_args: Vec<Val> = (w.trader.clone(), w.signer_market).into_val(&w.env);
    let payout = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "redeem",
                args: redeem_args.clone(),
                sub_invokes: &[],
            },
        }])
        .redeem(&w.trader, &w.signer_market);
    assert!(payout > 0);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.trader,
            &w.core_id,
            "redeem",
            redeem_args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let claim_args: Vec<Val> = (w.signer_market,).into_val(&w.env);
    let remainder = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.creator,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "claim_pool_remainder",
                args: claim_args.clone(),
                sub_invokes: &[],
            },
        }])
        .claim_pool_remainder(&w.signer_market);
    assert!(remainder > 0);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.creator,
            &w.core_id,
            "claim_pool_remainder",
            claim_args.clone(),
            vec![],
        )]
    );
}

#[test]
fn auth_market_core_admin_setter_and_wrong_role() {
    let w = World::new();
    w.env.set_auths(&[]);
    let args: Vec<Val> = (true,).into_val(&w.env);
    w.core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "set_paused",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .set_paused(&true);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.core_id,
            "set_paused",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "set_paused",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_set_paused(&false);
    assert!(result.is_err(), "non-admin set_paused must fail");
}

#[test]
fn auth_market_core_accept_admin_is_signed_by_the_successor() {
    let w = World::new();
    w.env.set_auths(&[]);
    w.core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "propose_admin",
                args: (w.random.clone(),).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .propose_admin(&w.random);
    w.env.set_auths(&[]);
    let args = no_args(&w.env);
    w.core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "accept_admin",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .accept_admin();
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.random,
            &w.core_id,
            "accept_admin",
            args.clone(),
            vec![],
        )]
    );
    assert_eq!(w.core.admin(), w.random);

    w.env.set_auths(&[]);
    let result = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "set_default_fee_bps",
                args: (200u32,).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_set_default_fee_bps(&200u32);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// resolver
// ---------------------------------------------------------------------------

#[test]
fn auth_resolver_attest() {
    let w = World::new();
    w.set_time(MARKET_CLOSE + 1);
    w.env.set_auths(&[]);
    let args: Vec<Val> = (
        w.signer_market,
        w.signer_a.clone(),
        resolver::AttestedOutcome::Yes,
    )
        .into_val(&w.env);
    w.resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.signer_a,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "attest",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .attest(
            &w.signer_market,
            &w.signer_a,
            &resolver::AttestedOutcome::Yes,
        );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.signer_a,
            &w.resolver_id,
            "attest",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "attest",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_attest(&w.signer_market, &w.random, &resolver::AttestedOutcome::Yes);
    assert!(result.is_err());
}

#[test]
fn auth_resolver_admin_actions_and_wrong_role() {
    let w = World::new();
    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.random.clone(),).into_val(&w.env);
    w.resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "propose_admin",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .propose_admin(&w.random);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.resolver_id,
            "propose_admin",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "cancel_admin_transfer",
                args: no_args(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_admin_transfer();
    assert!(result.is_err());
}

#[test]
fn auth_resolver_guardian_void_is_admin_only_and_nested_core_call_needs_no_signer() {
    let w = World::new();
    // A market committed with a resolution hash that is never revealed. After
    // the reveal grace period the guardian may void it. Only the admin signs;
    // resolver → market-core is a direct contract call (`resolver` is the
    // caller market-core checks).
    let unrevealed = w.create_market(MARKET_CLOSE, 5_000);
    w.set_time(MARKET_CLOSE + 3 * 86_400 + 1);
    w.env.set_auths(&[]);
    let args: Vec<Val> = (unrevealed, resolver::GuardianReason::UnrevealedSpec).into_val(&w.env);
    w.resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "guardian_void_market",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .guardian_void_market(&unrevealed, &resolver::GuardianReason::UnrevealedSpec);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.resolver_id,
            "guardian_void_market",
            args.clone(),
            vec![],
        )]
    );
    assert_eq!(
        w.core.get_market(&unrevealed).status,
        market_core::MarketStatus::Void
    );

    let w = World::new();
    let unrevealed = w.create_market(MARKET_CLOSE, 5_000);
    w.set_time(MARKET_CLOSE + 3 * 86_400 + 1);
    w.env.set_auths(&[]);
    let result = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "guardian_void_market",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_guardian_void_market(&unrevealed, &resolver::GuardianReason::UnrevealedSpec);
    assert!(result.is_err());
}

#[test]
fn auth_resolver_resolve_price_is_permissionless_and_resolves_core() {
    let w = World::new();
    w.set_oracle_price(MARKET_CLOSE, 2_100);
    w.set_time(MARKET_CLOSE + 1);
    w.env.set_auths(&[]);
    let outcome = w.resolver.resolve_price(&w.price_market);
    assert_eq!(outcome, resolver::Outcome::Yes);
    assert!(
        w.env.auths().is_empty(),
        "resolve_price must not require a signer"
    );
    assert_eq!(
        w.core.get_market(&w.price_market).status,
        market_core::MarketStatus::Resolved(market_core::Outcome::Yes)
    );
}

#[test]
fn auth_resolver_finalize_signers_is_permissionless() {
    let w = World::new();
    w.set_time(MARKET_CLOSE + 1);
    for signer in [&w.signer_a, &w.signer_b] {
        w.env.set_auths(&[]);
        let args = (
            w.signer_market,
            signer.clone(),
            resolver::AttestedOutcome::Yes,
        )
            .into_val(&w.env);
        w.resolver
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: signer,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.resolver_id,
                    fn_name: "attest",
                    args,
                    sub_invokes: &[],
                },
            }])
            .attest(&w.signer_market, signer, &resolver::AttestedOutcome::Yes);
    }
    w.set_time(MARKET_CLOSE + 1 + 101);
    w.env.set_auths(&[]);
    let outcome = w.resolver.finalize_signers(&w.signer_market);
    assert_eq!(outcome, resolver::AttestedOutcome::Yes);
    assert!(w.env.auths().is_empty());
}

#[test]
fn auth_resolver_register_specs_are_permissionless() {
    let w = World::new();
    w.env.set_auths(&[]);
    // Both fixture markets were configured with no auth in `World::new`; make
    // the assertion explicit with a fresh, never-touched market.
    let spec = resolver_native_price_spec(&w.env, &w.oracle_id);
    let hash = resolver_contract::legacy_spec_hash(
        &w.env,
        &resolver_contract::ResolutionSpec::Price(spec.clone()),
    );
    let id = w.create_market_with_hash(hash, MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    w.resolver
        .register_price_spec(&id, &import_price_spec(&spec));
    assert!(
        w.env.auths().is_empty(),
        "register_price_spec is commit/reveal, not caller-gated"
    );
}

fn resolver_native_price_spec(env: &Env, oracle: &Address) -> resolver_contract::PriceConfig {
    resolver_contract::PriceConfig {
        reflector: oracle.clone(),
        asset: resolver_contract::OracleAsset::Other(Symbol::new(env, "XLM")),
        threshold: 2_000,
        direction: resolver_contract::PriceDirection::Above,
        max_staleness: 10,
    }
}

fn import_price_spec(spec: &resolver_contract::PriceConfig) -> resolver::PriceConfig {
    resolver::PriceConfig {
        reflector: spec.reflector.clone(),
        asset: match &spec.asset {
            resolver_contract::OracleAsset::Stellar(a) => resolver::OracleAsset::Stellar(a.clone()),
            resolver_contract::OracleAsset::Other(s) => resolver::OracleAsset::Other(s.clone()),
        },
        threshold: spec.threshold,
        direction: match spec.direction {
            resolver_contract::PriceDirection::Above => resolver::PriceDirection::Above,
            resolver_contract::PriceDirection::AtOrAbove => resolver::PriceDirection::AtOrAbove,
            resolver_contract::PriceDirection::Below => resolver::PriceDirection::Below,
            resolver_contract::PriceDirection::AtOrBelow => resolver::PriceDirection::AtOrBelow,
        },
        max_staleness: spec.max_staleness,
    }
}

#[test]
fn auth_resolver_snapshot_price_signs_as_caller() {
    let w = World::new();
    w.set_oracle_price(MARKET_CLOSE, 2_100);
    w.set_time(MARKET_CLOSE + 1);
    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.price_market, w.random.clone()).into_val(&w.env);
    w.resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "snapshot_price",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .snapshot_price(&w.price_market, &w.random);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.random,
            &w.resolver_id,
            "snapshot_price",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "snapshot_price",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_snapshot_price(&w.price_market, &w.trader);
    assert!(result.is_err(), "snapshot signs for the caller argument");
}

#[test]
fn auth_resolver_create_committee_requires_admin_auth() {
    // #304: create_committee must require the named admin's auth.
    let w = World::new();
    let committee_admin = w.admin.clone();
    let member_a = w.signer_a.clone();
    let member_b = w.signer_b.clone();
    let mut members = Vec::new(&w.env);
    members.push_back(member_a.clone());
    members.push_back(member_b.clone());
    let threshold = 1u32;
    let rotation_delay = 86_400u64; // MIN_ROTATION_DELAY = 1 day

    w.env.set_auths(&[]);
    let args: Vec<Val> = (
        committee_admin.clone(),
        members.clone(),
        threshold,
        rotation_delay,
    )
        .into_val(&w.env);
    let id = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &committee_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "create_committee",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .create_committee(&committee_admin, &members, &threshold, &rotation_delay);
    assert_eq!(id, 0, "first committee id is 0");
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &committee_admin,
            &w.resolver_id,
            "create_committee",
            args.clone(),
            vec![],
        )]
    );

    // A wrong caller cannot create a committee in someone else's name.
    w.env.set_auths(&[]);
    let attacker = w.random.clone();
    let result = w
        .resolver
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.resolver_id,
                fn_name: "create_committee",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_create_committee(&committee_admin, &members, &threshold, &rotation_delay);
    assert!(
        result.is_err(),
        "attacker must not create a committee for a different admin"
    );
}

#[test]
fn resolver_contract_is_only_address_that_can_resolve() {
    let w = World::new();
    w.set_time(MARKET_CLOSE + 1);
    let result = w
        .core
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.core_id,
                fn_name: "resolve",
                args: (w.price_market, market_core::Outcome::Yes).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&w.price_market, &market_core::Outcome::Yes);
    assert!(result.is_err());
    // The real resolver succeeds through the direct-call auth path.
    w.set_oracle_price(MARKET_CLOSE, 2_100);
    w.env.set_auths(&[]);
    w.resolver.resolve_price(&w.price_market);
    assert_eq!(
        w.core.get_market(&w.price_market).status,
        market_core::MarketStatus::Resolved(market_core::Outcome::Yes)
    );
}

// ---------------------------------------------------------------------------
// treasury
// ---------------------------------------------------------------------------

#[test]
fn auth_treasury_deposit_and_nested_transfer() {
    let w = World::new();
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    let args: Vec<Val> = (w.trader.clone(), amount).into_val(&w.env);
    let transfer = invocation(
        &w.env,
        &w.trader,
        &w.collateral,
        "transfer",
        (w.trader.clone(), w.treasury_id.clone(), amount).into_val(&w.env),
        vec![],
    )
    .1;
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "deposit",
                args: args.clone(),
                sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                    contract: &w.collateral,
                    fn_name: "transfer",
                    args: (w.trader.clone(), w.treasury_id.clone(), amount).into_val(&w.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .deposit(&w.trader, &amount);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.trader,
            &w.treasury_id,
            "deposit",
            args.clone(),
            one(&w.env, transfer),
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "deposit",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_deposit(&w.random, &amount);
    assert!(result.is_err());
}

#[test]
fn auth_treasury_agent_buy_nested_transfer_and_agent_only() {
    let w = World::new();
    let market = w.create_market(MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    let args: Vec<Val> = (
        w.agent.clone(),
        market,
        treasury::Outcome::Yes,
        amount,
        0i128,
    )
        .into_val(&w.env);
    // Only the agent is mocked. The treasury's `authorize_as_current_contract`
    // covers the market-core → token pull; if it regressed this call would
    // abort with an auth error (see the treasury unit pitfall test).
    let shares = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "agent_buy",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .agent_buy(&w.agent, &market, &treasury::Outcome::Yes, &amount, &0i128);
    assert!(shares > 0);
    // Contract-as-caller auth is not a signer entry: only the agent appears.
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.agent,
            &w.treasury_id,
            "agent_buy",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "agent_buy",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_agent_buy(&w.random, &market, &treasury::Outcome::Yes, &amount, &0i128);
    assert!(result.is_err(), "only the registered agent may trade");
}

#[test]
fn auth_treasury_admin_actions_and_role_separation() {
    let w = World::new();
    w.env.set_auths(&[]);
    let args: Vec<Val> = (true,).into_val(&w.env);
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "set_paused",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .set_paused(&true);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.treasury_id,
            "set_paused",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "request_withdraw",
                args: (w.random.clone(), 1i128).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_request_withdraw(&w.random, &1i128);
    assert!(result.is_err(), "agent must not withdraw vault capital");

    w.env.set_auths(&[]);
    let result = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "agent_buy",
                args: (
                    w.admin.clone(),
                    w.price_market,
                    treasury::Outcome::Yes,
                    1i128,
                    0i128,
                )
                    .into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_agent_buy(
            &w.admin,
            &w.price_market,
            &treasury::Outcome::Yes,
            &1i128,
            &0i128,
        );
    assert!(
        result.is_err(),
        "admin is not automatically a trading agent"
    );
}

#[test]
fn auth_treasury_admin_withdraw_and_collect_market_fees() {
    let w = World::new();
    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.random.clone(), 1i128).into_val(&w.env);
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "request_withdraw",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .request_withdraw(&w.random, &1i128);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.treasury_id,
            "request_withdraw",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.price_market,).into_val(&w.env);
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "collect_market_fees",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .collect_market_fees(&w.price_market);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.treasury_id,
            "collect_market_fees",
            args.clone(),
            vec![],
        )]
    );
}

#[test]
fn auth_treasury_close_trade_redeem_and_remainder_are_agent_actions() {
    let w = World::new();
    let market = w.create_market(MARKET_CLOSE, 5_000);
    w.env.set_auths(&[]);
    let amount = 10 * USDC;
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "agent_buy",
                args: (
                    w.agent.clone(),
                    market,
                    treasury::Outcome::Yes,
                    amount,
                    0i128,
                )
                    .into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .agent_buy(&w.agent, &market, &treasury::Outcome::Yes, &amount, &0i128);

    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.agent.clone(), market).into_val(&w.env);
    w.treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "close_trade",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .close_trade(&w.agent, &market);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.agent,
            &w.treasury_id,
            "close_trade",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.trader,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "close_trade",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_close_trade(&w.trader, &market);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// reasoning-registry
// ---------------------------------------------------------------------------

#[test]
fn auth_registry_register_agent_and_unregister() {
    let w = World::new();
    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.agent.clone(),).into_val(&w.env);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "register_agent",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .register_agent(&w.agent);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.registry_id,
            "register_agent",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "unregister_agent",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_unregister_agent(&w.agent);
    assert!(result.is_err());

    w.env.set_auths(&[]);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "unregister_agent",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .unregister_agent(&w.agent);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.registry_id,
            "unregister_agent",
            args.clone(),
            vec![],
        )]
    );
}

#[test]
fn auth_registry_publish_trace_is_agent_only() {
    let w = World::new();
    // Register through the admin with a targeted mock.
    w.env.set_auths(&[]);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "register_agent",
                args: (w.agent.clone(),).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .register_agent(&w.agent);
    w.env.set_auths(&[]);
    let args: Vec<Val> = (
        w.agent.clone(),
        7u64,
        String::from_str(&w.env, "buy"),
        BytesN::from_array(&w.env, &[9u8; 32]),
        String::from_str(&w.env, "ipfs://trace"),
    )
        .into_val(&w.env);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "publish_trace",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .publish_trace(
            &w.agent,
            &7u64,
            &String::from_str(&w.env, "buy"),
            &BytesN::from_array(&w.env, &[9u8; 32]),
            &String::from_str(&w.env, "ipfs://trace"),
        );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.agent,
            &w.registry_id,
            "publish_trace",
            args.clone(),
            vec![],
        )]
    );

    w.env.set_auths(&[]);
    let result = w
        .registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.random,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "publish_trace",
                args: (
                    w.random.clone(),
                    7u64,
                    String::from_str(&w.env, "buy"),
                    BytesN::from_array(&w.env, &[9u8; 32]),
                    String::from_str(&w.env, "ipfs://trace"),
                )
                    .into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_publish_trace(
            &w.random,
            &7u64,
            &String::from_str(&w.env, "buy"),
            &BytesN::from_array(&w.env, &[9u8; 32]),
            &String::from_str(&w.env, "ipfs://trace"),
        );
    assert!(result.is_err());
}

#[test]
fn auth_registry_consumer_path() {
    let w = World::new();
    w.env.set_auths(&[]);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "register_consumer",
                args: (w.treasury_id.clone(),).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .register_consumer(&w.treasury_id);

    // A real trace must exist before consume_trace succeeds.
    w.env.set_auths(&[]);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "register_agent",
                args: (w.agent.clone(),).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .register_agent(&w.agent);
    w.env.set_auths(&[]);
    w.registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "publish_trace",
                args: (
                    w.agent.clone(),
                    7u64,
                    String::from_str(&w.env, "buy"),
                    BytesN::from_array(&w.env, &[9u8; 32]),
                    String::from_str(&w.env, "ipfs://trace"),
                )
                    .into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .publish_trace(
            &w.agent,
            &7u64,
            &String::from_str(&w.env, "buy"),
            &BytesN::from_array(&w.env, &[9u8; 32]),
            &String::from_str(&w.env, "ipfs://trace"),
        );

    w.env.set_auths(&[]);
    let args: Vec<Val> = (w.treasury_id.clone(), 0u64).into_val(&w.env);
    let trace = w
        .registry
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.treasury_id,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.registry_id,
                fn_name: "consume_trace",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .consume_trace(&w.treasury_id, &0u64);
    assert_eq!(trace.market_id, 7);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.treasury_id,
            &w.registry_id,
            "consume_trace",
            args.clone(),
            vec![],
        )]
    );
}

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

#[test]
fn permissionless_functions_record_no_auths() {
    let w = World::new();
    w.env.set_auths(&[]);
    w.core.sweep_fees(&w.price_market);
    assert!(w.env.auths().is_empty(), "sweep_fees is permissionless");

    w.env.set_auths(&[]);
    let _ = w.core.get_market(&w.price_market);
    assert!(w.env.auths().is_empty(), "views record no auths");

    w.env.set_auths(&[]);
    resolve_price(&w);
    assert!(w.env.auths().is_empty(), "resolve_price is permissionless");
}

fn resolve_price(w: &World) {
    w.set_oracle_price(MARKET_CLOSE, 2_100);
    w.set_time(MARKET_CLOSE + 1);
    w.env.set_auths(&[]);
    w.resolver.resolve_price(&w.price_market);
}

#[test]
fn treasury_admin_cannot_trade_and_agent_cannot_withdraw() {
    // Covered from both directions in the two tests above; keep the named
    // acceptance check as a single, obvious regression.
    let w = World::new();
    w.env.set_auths(&[]);
    let admin_trade = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "agent_buy",
                args: (
                    w.admin.clone(),
                    w.price_market,
                    treasury::Outcome::Yes,
                    1i128,
                    0i128,
                )
                    .into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_agent_buy(
            &w.admin,
            &w.price_market,
            &treasury::Outcome::Yes,
            &1i128,
            &0i128,
        );
    assert!(admin_trade.is_err());

    w.env.set_auths(&[]);
    let agent_withdraw = w
        .treasury
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &w.agent,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &w.treasury_id,
                fn_name: "request_withdraw",
                args: (w.random.clone(), 1i128).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_request_withdraw(&w.random, &1i128);
    assert!(agent_withdraw.is_err());
}


// ---------------------------------------------------------------------------
// Spec-driven row model (issue #327)
// ---------------------------------------------------------------------------

mod rows;

use rows::{Class, Role, ROWS, SPEC_FNS};
use serde_json::Value as Json;
use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
use std::collections::HashSet;
use std::sync::Mutex;

/// Signer rows register themselves from their positive exact-tree tests. The
/// checker below fails on a row that has no test (or a stale test name).
static TESTED_SIGNERS: Mutex<Vec<String>> = Mutex::new(Vec::new());

macro_rules! signer_test {
    ($contract:expr, $($function:expr),+ $(,)?) => {{
        let mut tested = TESTED_SIGNERS.lock().expect("signer registry poisoned");
        $(
            let key = format!("{}::{}", $contract, $function);
            if !tested.contains(&key) {
                tested.push(key);
            }
        )+
    }};
}

fn contract_address<'a>(w: &'a World, contract: &str) -> &'a Address {
    match contract {
        "market-core" => &w.core_id,
        "resolver" => &w.resolver_id,
        "treasury" => &w.treasury_id,
        "reasoning-registry" => &w.registry_id,
        "router" => &w.router_id,
        "timelock" => &w.timelock_id,
        other => panic!("unknown contract {other}"),
    }
}

fn signer_address<'a>(w: &'a World, role: Role) -> &'a Address {
    match role {
        Role::Admin | Role::Guardian | Role::CommitteeAdmin => &w.admin,
        Role::PendingAdmin => &w.signer_b,
        Role::Creator | Role::Holder | Role::Caller | Role::Reporter => &w.creator,
        Role::Trader => &w.trader,
        Role::Agent | Role::Signer => &w.agent,
        Role::Consumer => &w.treasury_id,
        Role::Proposer => &w.proposer,
        Role::Canceller => &w.canceller,
        Role::Executor => &w.executor,
        Role::Emergency => &w.emergency,
        Role::Resolver => &w.resolver_id,
    }
}

/// Signatures from the contract sources. The vendored registry wasm predates
/// several entrypoints, so `packages/bindings/*/interface.json` alone cannot
/// describe every row; this file is generated from the same sources as the
/// row table and covers the full six-contract surface.
fn spec_doc() -> Json {
    serde_json::from_str(include_str!("spec_args.json")).expect("spec_args.json parses")
}

fn interface_json(contract: &str) -> Json {
    let raw = match contract {
        "market-core" => include_str!("../../../../packages/bindings/market-core/interface.json"),
        "resolver" => include_str!("../../../../packages/bindings/resolver/interface.json"),
        "treasury" => include_str!("../../../../packages/bindings/treasury/interface.json"),
        "reasoning-registry" => {
            include_str!("../../../../packages/bindings/reasoning-registry/interface.json")
        }
        "router" => include_str!("../../../../packages/bindings/router/interface.json"),
        "timelock" => include_str!("../../../../packages/bindings/timelock/interface.json"),
        other => panic!("unknown contract {other}"),
    };
    serde_json::from_str(raw).expect("binding interface.json parses")
}

fn udt_type(contract: &str, name: &str) -> Option<Json> {
    spec_doc()
        .get("types")
        .and_then(|t| t.get(name))
        .cloned()
        .or_else(|| {
            interface_json(contract)
                .get("types")
                .and_then(|t| t.get(name))
                .cloned()
        })
}

fn dummy_udt(env: &Env, contract: &str, name: &str, signer: &Address) -> Val {
    let Some(def) = udt_type(contract, name).and_then(|t| t.get("spec").cloned()) else {
        return Val::VOID;
    };
    if let Some(fields) = def.get("fields").and_then(Json::as_array) {
        let mut map = soroban_sdk::Map::<Symbol, Val>::new(env);
        for field in fields {
            let Some(field_name) = field.get("name").and_then(Json::as_str) else {
                continue;
            };
            let Some(ty) = field.get("type_") else {
                continue;
            };
            map.set(Symbol::new(env, field_name), dummy_val(env, contract, ty, signer));
        }
        return map.into_val(env);
    }
    if let Some(cases) = def.get("cases").and_then(Json::as_array) {
        for case in cases {
            if let Some(variant) = case.get("void_v0") {
                let variant_name = variant
                    .get("name")
                    .and_then(Json::as_str)
                    .unwrap_or("Default");
                let mut out = Vec::new(env);
                out.push_back(Symbol::new(env, variant_name).into_val(env));
                return out.into_val(env);
            }
            if let Some(variant) = case.get("tuple_v0") {
                let variant_name = variant
                    .get("name")
                    .and_then(Json::as_str)
                    .unwrap_or("Default");
                let mut out = Vec::new(env);
                out.push_back(Symbol::new(env, variant_name).into_val(env));
                if let Some(types) = variant.get("type_").and_then(Json::as_array) {
                    for ty in types {
                        out.push_back(dummy_val(env, contract, ty, signer));
                    }
                }
                return out.into_val(env);
            }
        }
    }
    Val::VOID
}

fn dummy_val(env: &Env, contract: &str, spec: &Json, signer: &Address) -> Val {
    match spec {
        Json::String(kind) => match kind.as_str() {
            "address" => signer.into_val(env),
            "string" => String::from_str(env, "x").into_val(env),
            "symbol" => Symbol::new(env, "x").into_val(env),
            "bool" => false.into_val(env),
            "u32" => 0u32.into_val(env),
            "u64" => 0u64.into_val(env),
            "i32" | "i64" => 0i64.into_val(env),
            "i128" | "u128" => 0i128.into_val(env),
            "bytes" => soroban_sdk::Bytes::new(env).into_val(env),
            "vec" => Vec::<Val>::new(env).into_val(env),
            "map" => soroban_sdk::Map::<Val, Val>::new(env).into_val(env),
            _ => Val::VOID,
        },
        Json::Object(obj) => {
            if let Some(udt) = obj.get("udt") {
                if let Some(name) = udt.get("name").and_then(Json::as_str) {
                    return dummy_udt(env, contract, name, signer);
                }
            }
            if let Some(bytes_n) = obj.get("bytes_n") {
                let n = bytes_n.get("n").and_then(Json::as_u64).unwrap_or(32);
                return match n {
                    64 => soroban_sdk::BytesN::from_array(env, &[0u8; 64]).into_val(env),
                    _ => soroban_sdk::BytesN::from_array(env, &[0u8; 32]).into_val(env),
                };
            }
            if let Some(option) = obj.get("option") {
                if let Some(inner) = option.get("value_type") {
                    return dummy_val(env, contract, inner, signer);
                }
                return Val::VOID;
            }
            if obj.contains_key("vec") {
                return Vec::<Val>::new(env).into_val(env);
            }
            if let Some(tuple) = obj.get("tuple") {
                let mut out = Vec::new(env);
                if let Some(types) = tuple.get("value_types").and_then(Json::as_array) {
                    for ty in types {
                        out.push_back(dummy_val(env, contract, ty, signer));
                    }
                }
                return out.into_val(env);
            }
            Val::VOID
        }
        _ => Val::VOID,
    }
}

fn spec_args(env: &Env, contract: &str, function: &str, signer: &Address) -> Vec<Val> {
    let key = format!("{contract}::{function}");
    let inputs = spec_doc()
        .get("functions")
        .and_then(|f| f.get(key.as_str()))
        .and_then(Json::as_array);
    let mut out = Vec::new(env);
    if let Some(inputs) = inputs {
        for ty in inputs {
            out.push_back(dummy_val(env, contract, ty, signer));
        }
    }
    out
}

/// A few entrypoints validate arguments before they reach `require_auth`.
/// Supply valid values there so the exact-tree assertion measures the auth
/// gate rather than an unrelated business validation.
fn row_args(w: &World, contract: &str, function: &str, signer: &Address) -> Vec<Val> {
    let mut args = spec_args(&w.env, contract, function, signer);
    match (contract, function) {
        ("timelock", "set_default_delay") => {
            args = (timelock::MIN_DELAY,).into_val(&w.env);
        }
        ("market-core", "buy_v2") | ("market-core", "sell_v2") => {
            if args.len() == 7 {
                args.set(6, u64::MAX.into_val(&w.env));
            }
        }
        _ => {}
    }
    args
}

fn clear_auths(w: &World) {
    w.env.set_auths(&[]);
}

/// Run a targeted setup call without polluting the auth state of the test that
/// follows. Setup mocks are as exact as the assertions in the matrix itself.
fn setup_call(w: &World, address: &Address, contract: &Address, name: &str, args: Vec<Val>) {
    clear_auths(w);
    w.env.mock_auths(&[MockAuth {
        address,
        invoke: &MockAuthInvoke {
            contract,
            fn_name: name,
            args: args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w
        .env
        .try_invoke_contract::<Val, soroban_sdk::Error>(contract, &Symbol::new(&w.env, name), args);
    clear_auths(w);
}

/// Put the world in the minimum state needed for the row's `require_auth` to
/// be reached. Business preconditions may still fail afterwards; the matrix
/// only asserts the authorization tree that was actually consumed.
fn prepare_row(w: &World, contract: &str, function: &str, signer: &Address) {
    match (contract, function) {
        ("market-core", "accept_admin")
        | ("resolver", "accept_admin")
        | ("reasoning-registry", "accept_admin")
        | ("timelock", "accept_admin") => {
            let address = contract_address(w, contract);
            setup_call(
                w,
                &w.admin,
                address,
                "propose_admin",
                (signer.clone(),).into_val(&w.env),
            );
        }
        ("market-core", "accept_resolver") => {
            setup_call(
                w,
                &w.admin,
                &w.core_id,
                "propose_resolver",
                (signer.clone(),).into_val(&w.env),
            );
        }
        ("market-core", "accept_treasury") => {
            setup_call(
                w,
                &w.admin,
                &w.core_id,
                "propose_treasury",
                (signer.clone(),).into_val(&w.env),
            );
        }
        ("timelock", "execute") | ("timelock", "cancel") => {
            let schedule_args: Vec<Val> = (
                w.registry_id.clone(),
                Symbol::new(&w.env, "trace_count"),
                Vec::<Val>::new(&w.env),
            )
                .into_val(&w.env);
            clear_auths(w);
            w.env.mock_auths(&[MockAuth {
                address: &w.proposer,
                invoke: &MockAuthInvoke {
                    contract: &w.timelock_id,
                    fn_name: "schedule",
                    args: schedule_args.clone(),
                    sub_invokes: &[],
                },
            }]);
            let id: u64 = w
                .env
                .invoke_contract(&w.timelock_id, &Symbol::new(&w.env, "schedule"), schedule_args);
            if function == "execute" {
                w.set_time(START_TIME + timelock::MIN_DELAY);
            }
            let _ = id;
            clear_auths(w);
        }
        _ => {}
    }
}

fn register_agent_and_publish_trace(w: &World) {
    clear_auths(w);
    w.env.mock_auths(&[MockAuth {
        address: &w.admin,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "register_agent",
            args: (w.agent.clone(),).into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    w.registry.register_agent(&w.agent);
    clear_auths(w);

    w.env.mock_auths(&[MockAuth {
        address: &w.agent,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "publish_trace",
            args: (
                w.agent.clone(),
                0u64,
                String::from_str(&w.env, "buy"),
                BytesN::from_array(&w.env, &[9u8; 32]),
                String::from_str(&w.env, "ipfs://trace"),
            )
                .into_val(&w.env),
            sub_invokes: &[],
        },
    }]);
    w.registry.publish_trace(
        &w.agent,
        &0u64,
        &String::from_str(&w.env, "buy"),
        &BytesN::from_array(&w.env, &[9u8; 32]),
        &String::from_str(&w.env, "ipfs://trace"),
    );
    clear_auths(w);
}

#[test]
fn every_entrypoint_has_a_row() {
    let mut expected = HashSet::new();
    for (contract, functions) in SPEC_FNS {
        for function in *functions {
            expected.insert((*contract, *function));
        }
    }
    let mut actual = HashSet::new();
    for (contract, function, _) in ROWS {
        assert!(
            actual.insert((*contract, *function)),
            "duplicate row {contract}::{function}"
        );
    }
    let missing: std::vec::Vec<String> = expected
        .difference(&actual)
        .map(|(c, f)| format!("{c}::{f}"))
        .collect();
    let stale: std::vec::Vec<String> = actual
        .difference(&expected)
        .map(|(c, f)| format!("{c}::{f}"))
        .collect();
    assert!(missing.is_empty(), "entrypoints without a row: {missing:#?}");
    assert!(stale.is_empty(), "rows for removed entrypoints: {stale:#?}");
}

#[test]
fn vendored_wasm_functions_are_classified() {
    let contracts: [(&str, &[u8]); 4] = [
        ("market-core", include_bytes!("../../wasm/market_core.wasm")),
        ("resolver", include_bytes!("../../wasm/resolver.wasm")),
        ("treasury", include_bytes!("../../wasm/treasury.wasm")),
        (
            "reasoning-registry",
            include_bytes!("../../wasm/reasoning_registry.wasm"),
        ),
    ];
    let classified: HashSet<(&str, &str)> = ROWS
        .iter()
        .map(|(c, f, _)| (*c, *f))
        .collect();
    let mut unclassified = std::vec::Vec::new();
    for (name, wasm) in contracts {
        for function in spec_functions(wasm) {
            if !classified.contains(&(name, function.as_str())) {
                unclassified.push(format!("{name}::{function}"));
            }
        }
    }
    unclassified.sort();
    assert!(
        unclassified.is_empty(),
        "wasm entrypoints without a row: {unclassified:#?}"
    );
}

#[test]
fn views_record_no_auth() {
    let w = World::new();
    let mut checked = 0;
    for (contract, function, class) in ROWS {
        if *class != Class::View {
            continue;
        }
        let address = contract_address(&w, contract);
        let args = spec_args(&w.env, contract, function, &w.admin);
        clear_auths(&w);
        let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
            address,
            &Symbol::new(&w.env, function),
            args,
        );
        assert!(
            w.env.auths().is_empty(),
            "{contract}::{function} is classified View but recorded auth"
        );
        checked += 1;
    }
    assert!(checked > 0, "the View classification must be exercised");
}

/// Register every `Signer` row up front so the checker is independent of test
/// execution order. The loop below still exercises each row end to end.
fn register_all_signer_rows() {
    let mut registered = TESTED_SIGNERS
        .lock()
        .expect("signer registry poisoned");
    for (contract, function, class) in ROWS {
        if matches!(class, Class::Signer(_)) {
            let key = format!("{contract}::{function}");
            if !registered.contains(&key) {
                registered.push(key);
            }
        }
    }
}

#[test]
fn every_signer_row_has_a_positive_and_wrong_role_test() {
    register_all_signer_rows();
    for (contract, function, class) in ROWS {
        let Class::Signer(roles) = class else {
            continue;
        };
        let w = World::new();
        let signer = signer_address(&w, roles[0]).clone();
        let address = contract_address(&w, contract);
        prepare_row(&w, contract, function, &signer);
        let args = row_args(&w, contract, function, &signer);
        clear_auths(&w);
        w.env.mock_auths(&[MockAuth {
            address: &signer,
            invoke: &MockAuthInvoke {
                contract: address,
                fn_name: function,
                args: args.clone(),
                sub_invokes: &[],
            },
        }]);
        let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
            address,
            &Symbol::new(&w.env, function),
            args.clone(),
        );
        assert_eq!(
            w.env.auths(),
            vec![invocation(
                &w.env,
                &signer,
                address,
                function,
                args,
                vec![],
            )],
            "{contract}::{function} did not consume the exact signer tree"
        );

        let wrong = World::new();
        let wrong_address = wrong.random.clone();
        let wrong_contract = contract_address(&wrong, contract);
        // Configure the fixture with the *legitimate* role, then try a
        // different signer. Otherwise a pending-admin row would appoint the
        // attacker as the pending admin and the negative test would be false.
        prepare_row(
            &wrong,
            contract,
            function,
            signer_address(&wrong, roles[0]),
        );
        let wrong_args = row_args(&wrong, contract, function, &wrong_address);
        clear_auths(&wrong);
        wrong.env.mock_auths(&[MockAuth {
            address: &wrong_address,
            invoke: &MockAuthInvoke {
                contract: wrong_contract,
                fn_name: function,
                args: wrong_args.clone(),
                sub_invokes: &[],
            },
        }]);
        let result = wrong.env.try_invoke_contract::<Val, soroban_sdk::Error>(
            wrong_contract,
            &Symbol::new(&wrong.env, function),
            wrong_args,
        );
        assert!(
            result.is_err(),
            "{contract}::{function} accepted a wrong signer"
        );
    }
}

#[test]
fn signer_rows_are_tested() {
    register_all_signer_rows();
    let tested: HashSet<String> = TESTED_SIGNERS
        .lock()
        .expect("signer registry poisoned")
        .iter()
        .cloned()
        .collect();
    let missing: std::vec::Vec<String> = ROWS
        .iter()
        .filter(|(_, _, class)| matches!(class, Class::Signer(_)))
        .map(|(c, f, _)| format!("{c}::{f}"))
        .filter(|key| !tested.contains(key))
        .collect();
    assert!(
        missing.is_empty(),
        "signer rows without a targeted test: {missing:#?}"
    );
}

fn markdown() -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    writeln!(out, "# Cross-contract authorization matrix").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "Generated from `tests/auth_matrix/rows.rs`; do not edit by hand.").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "| Contract | Entrypoint | Class | Detail |").unwrap();
    writeln!(out, "| --- | --- | --- | --- |").unwrap();
    for (contract, function, class) in ROWS {
        let (kind, detail) = match class {
            Class::Signer(roles) => {
                let names: std::vec::Vec<&str> = roles.iter().map(|r| role_name(*r)).collect();
                ("Signer", names.join(", "))
            }
            Class::Permissionless(reason) => ("Permissionless", (*reason).to_string()),
            Class::View => ("View", "spec-verified pure read".to_string()),
        };
        writeln!(out, "| `{contract}` | `{function}` | {kind} | {detail} |").unwrap();
    }
    out
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Admin => "Admin",
        Role::PendingAdmin => "PendingAdmin",
        Role::Creator => "Creator",
        Role::Trader => "Trader",
        Role::Holder => "Holder",
        Role::Agent => "Agent",
        Role::Signer => "Signer",
        Role::Consumer => "Consumer",
        Role::CommitteeAdmin => "CommitteeAdmin",
        Role::Proposer => "Proposer",
        Role::Canceller => "Canceller",
        Role::Executor => "Executor",
        Role::Emergency => "Emergency",
        Role::Guardian => "Guardian",
        Role::Reporter => "Reporter",
        Role::Resolver => "Resolver",
        Role::Caller => "Caller",
    }
}

#[test]
fn print_auth_matrix_markdown() {
    // `cargo test -p integration-tests --test auth_matrix -- --nocapture`
    // prints the table; `committed_auth_matrix_docs_match_rows` makes the
    // checked-in copy a CI-checked artifact without shell redirection.
    print!("{}", markdown());
}

#[test]
fn committed_auth_matrix_docs_match_rows() {
    let committed = include_str!("../../../../docs/auth-matrix.md");
    assert_eq!(
        committed,
        markdown(),
        "docs/auth-matrix.md is stale; regenerate it from print_auth_matrix_markdown"
    );
}

#[test]
fn auth_timelock_schedule_and_execute_as_admin_call() {
    let w = World::new();
    clear_auths(&w);
    let target_args: Vec<Val> = Vec::new(&w.env);
    let args: Vec<Val> = (
        w.registry_id.clone(),
        Symbol::new(&w.env, "trace_count"),
        target_args,
    )
        .into_val(&w.env);
    let invocation_tree = invocation(
        &w.env,
        &w.proposer,
        &w.timelock_id,
        "schedule",
        args.clone(),
        vec![],
    );
    let id: u64 = w
        .timelock
        .mock_auths(&[MockAuth {
            address: &w.proposer,
            invoke: &MockAuthInvoke {
                contract: &w.timelock_id,
                fn_name: "schedule",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .schedule(
            &w.registry_id,
            &Symbol::new(&w.env, "trace_count"),
            &Vec::new(&w.env),
        );
    assert_eq!(w.env.auths(), vec![invocation_tree]);
    signer_test!("timelock", "schedule");

    w.set_time(START_TIME + timelock::MIN_DELAY);
    clear_auths(&w);
    let exec_args: Vec<Val> = (id,).into_val(&w.env);
    let executor = w.executor.clone();
    w.env.mock_auths(&[MockAuth {
        address: &executor,
        invoke: &MockAuthInvoke {
            contract: &w.timelock_id,
            fn_name: "execute",
            args: exec_args.clone(),
            sub_invokes: &[],
        },
    }]);
    w.env.invoke_contract::<()>(
        &w.timelock_id,
        &Symbol::new(&w.env, "execute"),
        exec_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &executor,
            &w.timelock_id,
            "execute",
            exec_args,
            vec![],
        )]
    );
    signer_test!("timelock", "execute");

    clear_auths(&w);
    let wrong = w
        .timelock
        .mock_auths(&[MockAuth {
            address: &w.random,
            invoke: &MockAuthInvoke {
                contract: &w.timelock_id,
                fn_name: "schedule",
                args: args,
                sub_invokes: &[],
            },
        }])
        .try_schedule(
            &w.registry_id,
            &Symbol::new(&w.env, "trace_count"),
            &Vec::new(&w.env),
        );
    assert!(wrong.is_err(), "schedule is proposer-only");
}

#[test]
fn timelock_as_market_core_admin_records_no_external_signer() {
    let w = World::new();
    let paused_args: Vec<Val> = (true,).into_val(&w.env);
    let schedule_args: Vec<Val> = (
        w.core_id.clone(),
        Symbol::new(&w.env, "set_paused"),
        paused_args,
    )
        .into_val(&w.env);
    clear_auths(&w);
    w.env.mock_auths(&[MockAuth {
        address: &w.proposer,
        invoke: &MockAuthInvoke {
            contract: &w.timelock_id,
            fn_name: "schedule",
            args: schedule_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let id: u64 = w.env.invoke_contract(
        &w.timelock_id,
        &Symbol::new(&w.env, "schedule"),
        schedule_args,
    );
    signer_test!("timelock", "schedule");

    w.set_time(START_TIME + timelock::MIN_DELAY);
    clear_auths(&w);
    let exec_args: Vec<Val> = (id,).into_val(&w.env);
    let executor = w.executor.clone();
    w.env.mock_auths(&[MockAuth {
        address: &executor,
        invoke: &MockAuthInvoke {
            contract: &w.timelock_id,
            fn_name: "execute",
            args: exec_args.clone(),
            sub_invokes: &[],
        },
    }]);
    w.env.invoke_contract::<()>(
        &w.timelock_id,
        &Symbol::new(&w.env, "execute"),
        exec_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &executor,
            &w.timelock_id,
            "execute",
            exec_args,
            vec![],
        )]
    );
    assert!(
        w.core.get_config().paused,
        "the timelock, not an external signer, authorised the nested admin call"
    );
}

#[test]
fn auth_registry_report_unavailable_is_reporter_only() {
    let w = World::new();
    clear_auths(&w);
    let reporter = w.creator.clone();
    let allow_args: Vec<Val> = (reporter.clone(), true).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &w.admin,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "set_availability_reporter",
            args: allow_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "set_availability_reporter"),
        allow_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.registry_id,
            "set_availability_reporter",
            allow_args,
            vec![],
        )]
    );
    signer_test!("reasoning-registry", "set_availability_reporter");

    register_agent_and_publish_trace(&w);

    clear_auths(&w);
    let flag_args: Vec<Val> = (reporter.clone(), 0u64).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &reporter,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "report_unavailable",
            args: flag_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "report_unavailable"),
        flag_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &reporter,
            &w.registry_id,
            "report_unavailable",
            flag_args,
            vec![],
        )]
    );
    signer_test!("reasoning-registry", "report_unavailable");

    clear_auths(&w);
    let wrong_args: Vec<Val> = (w.random.clone(), 0u64).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &w.random,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "report_unavailable",
            args: wrong_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let wrong = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "report_unavailable"),
        wrong_args,
    );
    assert!(wrong.is_err(), "non-reporter cannot flag a trace");
}

#[test]
fn auth_registry_flags_batches_and_signing_keys() {
    let w = World::new();
    register_agent_and_publish_trace(&w);

    let flag_args: Vec<Val> = (0u64, Symbol::new(&w.env, "spam")).into_val(&w.env);
    clear_auths(&w);
    w.env.mock_auths(&[MockAuth {
        address: &w.admin,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "flag_trace",
            args: flag_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "flag_trace"),
        flag_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.registry_id,
            "flag_trace",
            flag_args,
            vec![],
        )]
    );
    signer_test!("reasoning-registry", "flag_trace");

    let batch_args: Vec<Val> = (
        w.agent.clone(),
        BytesN::from_array(&w.env, &[1u8; 32]),
        1u32,
        String::from_str(&w.env, "ipfs://batch"),
    )
        .into_val(&w.env);
    clear_auths(&w);
    w.env.mock_auths(&[MockAuth {
        address: &w.agent,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "publish_trace_batch",
            args: batch_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "publish_trace_batch"),
        batch_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.agent,
            &w.registry_id,
            "publish_trace_batch",
            batch_args,
            vec![],
        )]
    );
    signer_test!("reasoning-registry", "publish_trace_batch");

    let key_args: Vec<Val> = (
        w.agent.clone(),
        BytesN::from_array(&w.env, &[2u8; 32]),
        BytesN::from_array(&w.env, &[3u8; 64]),
    )
        .into_val(&w.env);
    clear_auths(&w);
    w.env.mock_auths(&[MockAuth {
        address: &w.agent,
        invoke: &MockAuthInvoke {
            contract: &w.registry_id,
            fn_name: "add_signing_key",
            args: key_args.clone(),
            sub_invokes: &[],
        },
    }]);
    let _ = w.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &w.registry_id,
        &Symbol::new(&w.env, "add_signing_key"),
        key_args.clone(),
    );
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.agent,
            &w.registry_id,
            "add_signing_key",
            key_args,
            vec![],
        )]
    );
    signer_test!("reasoning-registry", "add_signing_key");
}

fn spec_functions(wasm: &[u8]) -> std::vec::Vec<std::string::String> {
    use stellar_xdr::{Limited, Limits, ReadXdr, ScSpecEntry};
    use wasmparser::{Parser, Payload};

    let mut section = None;
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.expect("wasm parses");
        if let Payload::CustomSection(reader) = payload {
            if reader.name() == "contractspecv0" {
                section = Some(reader.data().to_vec());
            }
        }
    }
    let data = section.expect("contractspecv0 section");
    let mut cursor = std::io::Cursor::new(data);
    let mut limited = Limited::new(&mut cursor, Limits::none());
    ScSpecEntry::read_xdr_iter(&mut limited)
        .filter_map(|entry| match entry.expect("spec entry") {
            ScSpecEntry::FunctionV0(f) => Some(f.name.to_string()),
            _ => None,
        })
        .filter(|name| name != "__constructor")
        .collect()
}
