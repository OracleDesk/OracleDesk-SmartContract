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
    market_core, resolver, treasury,
    world::{World, MARKET_CLOSE, SEED, USDC},
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
                fn_name: "withdraw",
                args: (w.random.clone(), 1i128).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_withdraw(&w.random, &1i128);
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
                fn_name: "withdraw",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .withdraw(&w.random, &1i128);
    assert_eq!(
        w.env.auths(),
        vec![invocation(
            &w.env,
            &w.admin,
            &w.treasury_id,
            "withdraw",
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
                fn_name: "withdraw",
                args: (w.random.clone(), 1i128).into_val(&w.env),
                sub_invokes: &[],
            },
        }])
        .try_withdraw(&w.random, &1i128);
    assert!(agent_withdraw.is_err());
}

// ---------------------------------------------------------------------------
// Spec-driven coverage
// ---------------------------------------------------------------------------

/// Entrypoints with an explicit auth-matrix test above. Function names come
/// from the wasm spec, so a renamed/added entrypoint fails the coverage test
/// until this list (and a test) is updated.
const MATRIX: &[(&str, &[&str])] = &[
    (
        "market-core",
        &[
            "create_market",
            "buy",
            "sell",
            "redeem",
            "claim_pool_remainder",
            "set_paused",
            "accept_admin",
            "set_default_fee_bps",
            "resolve",
            "void_market",
        ],
    ),
    (
        "resolver",
        &[
            "attest",
            "propose_admin",
            "cancel_admin_transfer",
            "guardian_void_market",
            "resolve_price",
            "finalize_signers",
            "register_price_spec",
            "register_signer_spec",
            "snapshot_price",
            "create_committee",
        ],
    ),
    (
        "treasury",
        &[
            "deposit",
            "agent_buy",
            "set_paused",
            "withdraw",
            "collect_market_fees",
            "close_trade",
            "begin_migration",
            "cancel_migration",
            "migrate_markets",
            "migrate_idle",
            "accept_predecessor",
            "receive_migration",
            "receive_collateral",
            "transfer_shares",
            "exit_to_successor",
        ],
    ),
    (
        "reasoning-registry",
        &[
            "register_agent",
            "unregister_agent",
            "publish_trace",
            "register_consumer",
            "unregister_consumer",
            "consume_trace",
            "propose_admin",
            "accept_admin",
            "cancel_admin_transfer",
        ],
    ),
];

/// Functions that are deliberately permissionless or views. They still have a
/// classification row; the `permissionless_functions_record_no_auths` test
/// exercises the money-moving ones. An entrypoint missing from both tables
/// fails `every_entrypoint_has_a_matrix_row`.
const PERMISSIONLESS: &[(&str, &[&str])] = &[
    (
        "market-core",
        &[
            "admin",
            "pending_admin",
            "market_count",
            "get_market",
            "get_position",
            "get_price",
            "get_config",
            "quote_buy",
            "quote_sell",
            "breaker_config",
            "breaker_state",
            "would_trip",
            "sweep_fees",
            "buy_v2",
            "sell_v2",
            "claim_lp_fees",
            "transfer_position",
            "transfer_lp",
            "propose_admin",
            "cancel_admin_transfer",
            "propose_resolver",
            "accept_resolver",
            "propose_treasury",
            "accept_treasury",
            "set_default_fee_bps",
            "set_protocol_fee_share_bps",
            "set_default_breaker",
        ],
    ),
    (
        "resolver",
        &[
            "admin",
            "pending_admin",
            "market_core",
            "state",
            "snapshot",
            "current_round",
            "resolution_deadline",
            "guardian_options",
            "cancel_count",
            "evidence_count",
            "evidence_at",
            "evidence_config",
            "set_evidence_config",
            "get_committee",
            "propose_rotation",
            "execute_rotation",
            "cancel_rotation",
            "open_fallback",
            "expire_market",
            "expire_dispute",
            "claim_dispute_bond",
            "dispute",
            "settle_dispute",
            "escalation_attest",
            "submit_signatures",
            "accept_market_core_role",
            "accept_admin",
            "register_disputable_spec",
            "register_weighted_key_spec",
            "register_committee_spec",
            "register_hybrid_spec",
            "register_spec_v2",
            "attest_with_evidence",
            "cancel_proposal",
        ],
    ),
    (
        "treasury",
        &[
            "nav",
            "total_shares",
            "queue_reserved",
            "queue_bounds",
            "deposit",
            "request_withdraw",
            "claim_withdraw",
            "emergency_withdraw",
            "agent_sell",
            "agent_sell_v2",
            "agent_buy_v2",
            "agent_create_market",
            "agent_create_market_and_reveal",
            "agent_claim_lp_fees",
            "agent_daily_usage",
            "agent_at",
            "agent_count",
            "agent_buy",
            "get_agent",
            "pending_agent",
            "set_agent",
            "execute_agent",
            "cancel_agent",
            "remove_agent",
            "get_config",
            "get_global",
            "get_net_cap",
            "net_exposure",
            "net_position",
            "market_valuation",
            "market_pnl",
            "window_pnl",
            "realized",
            "realize",
            "drawdown_status",
            "acknowledge_drawdown",
            "reset_pnl_window",
            "set_drawdown_config",
            "get_creation_policy",
            "creation_usage",
            "set_creation_policy",
            "open_market_count",
            "open_market_at",
            "shares_of",
            "daily_usage",
            "daily_usage_detail",
            "daily_headroom",
            "available_capital",
            "liquid_capital",
            "capital_breakdown",
            "config_delay",
            "pending_config",
            "propose_config",
            "execute_config",
            "cancel_config",
            "set_config_delay",
            "get_price_policy",
            "pending_price_policy",
            "set_price_policy",
            "execute_price_policy",
            "cancel_price_policy",
            "set_yield_venue",
            "allocate_to_yield",
            "recall_from_yield",
            "disable_yield",
            "migration_version",
            "migration_state",
            "predecessor",
            "assets_of",
            "settle_market",
            "legacy_redeem",
            "legacy_claim_pool_remainder",
            "withdraw_ticket",
            "redeem",
            "claim_pool_remainder",
        ],
    ),
    (
        "reasoning-registry",
        &[
            "admin",
            "pending_admin",
            "is_registered",
            "is_consumer",
            "is_consumed",
            "get_trace",
            "verify_trace",
            "verify_commitment",
            "trace_count",
            "market_trace_count",
            "market_trace_at",
            "agent_chain_head",
            "agent_trace_at",
            "get_trace_link",
            "get_trace_ledger",
            "publish_chained_trace",
        ],
    ),
];

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

fn classified(contract: &str, function: &str) -> bool {
    MATRIX
        .iter()
        .chain(PERMISSIONLESS.iter())
        .any(|(c, fns)| *c == contract && fns.contains(&function))
}

#[test]
fn every_entrypoint_has_a_matrix_row() {
    let contracts: [(&str, &[u8]); 4] = [
        ("market-core", include_bytes!("../wasm/market_core.wasm")),
        ("resolver", include_bytes!("../wasm/resolver.wasm")),
        ("treasury", include_bytes!("../wasm/treasury.wasm")),
        (
            "reasoning-registry",
            include_bytes!("../wasm/reasoning_registry.wasm"),
        ),
    ];
    let mut missing = std::vec::Vec::new();
    for (name, wasm) in contracts {
        for function in spec_functions(wasm) {
            if !classified(name, &function) {
                missing.push(format!("{name}::{function}"));
            }
        }
    }
    missing.sort();
    assert!(
        missing.is_empty(),
        "entrypoints without an auth-matrix or permissionless row: {missing:#?}"
    );
}
