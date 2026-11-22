//! The bonded-dispute flow the proposal watcher (agents/runtime/tasks/watcher.ts,
//! issue #275) relies on, against the real wasm of market-core and the resolver,
//! with a funded *non-admin* disputer and no `mock_all_auths`: every call mocks
//! exactly the signer it needs, with its exact invocation (and the bond's token
//! transfer as a sub-invocation).
//!
//! The watcher's assumptions pinned here: `dispute` escrows `dispute_bond` from
//! the disputer; a ruling that overturns the proposal pays the bond back to the
//! disputer through the permissionless `claim_dispute_bond`; a ruling that
//! upholds it pays market-core's treasury instead; `expire_dispute` refunds the
//! bond once `escalation_timeout` lapses; and a second dispute is refused while
//! one is open (`DisputeActive`), which the watcher treats as "someone else got
//! there first".

use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Vec,
};

#[allow(clippy::too_many_arguments)]
mod market_core {
    soroban_sdk::contractimport!(file = "wasm/market_core.wasm");
}
#[allow(clippy::too_many_arguments)]
mod resolver {
    soroban_sdk::contractimport!(file = "wasm/resolver.wasm");
}

const USDC: i128 = 10_000_000;
const SEED: i128 = 100 * USDC;
const BOND: i128 = 25 * USDC;
const CLOSE: u64 = 2_000;
const WINDOW: u64 = 100;
const TIMEOUT: u64 = 1_000;

/// One targeted signer mock: `who` authorises exactly `contract.name(args)`,
/// optionally with sub-invocations.
macro_rules! auth {
    ($who:expr, $contract:expr, $name:expr, $args:expr) => {
        auth!($who, $contract, $name, $args, &[])
    };
    ($who:expr, $contract:expr, $name:expr, $args:expr, $subs:expr) => {
        MockAuth {
            address: $who,
            invoke: &MockAuthInvoke {
                contract: $contract,
                fn_name: $name,
                args: $args,
                sub_invokes: $subs,
            },
        }
    };
}

struct World {
    env: Env,
    admin: Address,
    disputer: Address,
    signers: [Address; 2],
    core: Address,
    resolver: Address,
    token: Address,
    market_id: u64,
}

impl World {
    /// A `SignersDisputable` market whose two signers proposed `No` at t = CLOSE.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_network_id([7u8; 32]);
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let disputer = Address::generate(&env);
        let signers = [Address::generate(&env), Address::generate(&env)];
        let treasury = Address::generate(&env);
        let resolver = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        for (who, amount) in [(&creator, 2 * SEED), (&disputer, 3 * BOND)] {
            StellarAssetClient::new(&env, &token)
                .mock_auths(&[auth!(
                    &admin,
                    &token,
                    "mint",
                    (who.clone(), amount).into_val(&env)
                )])
                .mint(who, &amount);
        }
        let core = env.register(
            market_core::WASM,
            (
                admin.clone(),
                token.clone(),
                treasury,
                resolver.clone(),
                100u32,
                10_000u32,
            ),
        );
        env.register_at(&resolver, resolver::WASM, (admin.clone(), core.clone()));

        // The commitment: sha256(domain || XDR(envelope)), as the resolver computes it.
        let spec = resolver::ResolutionSpecV2 {
            version: 2,
            network_id: env.ledger().network_id(),
            market_core: core.clone(),
            salt: BytesN::from_array(&env, &[9u8; 32]),
            rule: resolver::ResolutionSpec::SignersDisputable(resolver::DisputableSignerConfig {
                signers: Vec::from_array(&env, [signers[0].clone(), signers[1].clone()]),
                threshold: 2,
                dispute_window: WINDOW,
                dispute_bond: BOND,
                escalation: resolver::Escalation::Guardian,
                escalation_timeout: TIMEOUT,
            }),
        };
        let mut preimage = Bytes::from_slice(&env, b"oracledesk:resolution-spec");
        preimage.append(&spec.clone().to_xdr(&env));
        let commitment: BytesN<32> = env.crypto().sha256(&preimage).into();

        let qh = BytesN::from_array(&env, &[1u8; 32]);
        let uri = String::from_str(&env, "ipfs://dispute-flow");
        let create_args = (
            creator.clone(),
            qh.clone(),
            commitment.clone(),
            uri.clone(),
            market_core::Category::Crypto,
            CLOSE,
            SEED,
            5_000u32,
        );
        let pull = MockAuthInvoke {
            contract: &token,
            fn_name: "transfer",
            args: (creator.clone(), core.clone(), SEED).into_val(&env),
            sub_invokes: &[],
        };
        let market_id = market_core::Client::new(&env, &core)
            .mock_auths(&[auth!(
                &creator,
                &core,
                "create_market",
                create_args.into_val(&env),
                &[pull]
            )])
            .create_market(
                &creator,
                &qh,
                &commitment,
                &uri,
                &market_core::Category::Crypto,
                &CLOSE,
                &SEED,
                &5_000,
            );

        // Reveal is permissionless (the commitment is the authority).
        resolver::Client::new(&env, &resolver).register_spec_v2(&market_id, &spec);

        env.ledger().set_timestamp(CLOSE);
        for s in &signers {
            let args = (market_id, s.clone(), resolver::AttestedOutcome::No);
            resolver::Client::new(&env, &resolver)
                .mock_auths(&[auth!(s, &resolver, "attest", args.into_val(&env))])
                .attest(&market_id, s, &resolver::AttestedOutcome::No);
        }
        Self {
            env,
            admin,
            disputer,
            signers,
            core,
            resolver,
            token,
            market_id,
        }
    }

    fn resolver(&self) -> resolver::Client<'_> {
        resolver::Client::new(&self.env, &self.resolver)
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    /// `who` disputes the proposal, claiming `alternative`, escrowing the bond.
    fn dispute(&self, who: &Address, alternative: Option<resolver::Outcome>) -> bool {
        let args = (self.market_id, who.clone(), alternative.clone());
        let transfer = MockAuthInvoke {
            contract: &self.token,
            fn_name: "transfer",
            args: (who.clone(), self.resolver.clone(), BOND).into_val(&self.env),
            sub_invokes: &[],
        };
        self.resolver()
            .mock_auths(&[auth!(
                who,
                &self.resolver,
                "dispute",
                args.into_val(&self.env),
                &[transfer]
            )])
            .try_dispute(&self.market_id, who, &alternative)
            .is_ok()
    }

    fn settle(&self, verdict: resolver::Verdict) {
        let args = (self.market_id, verdict.clone());
        self.resolver()
            .mock_auths(&[auth!(
                &self.admin,
                &self.resolver,
                "settle_dispute",
                args.into_val(&self.env)
            )])
            .settle_dispute(&self.market_id, &verdict);
    }

    /// Permissionless: no signer is mocked at all.
    fn claim(&self) {
        self.env.set_auths(&[]);
        self.resolver().claim_dispute_bond(&self.market_id);
    }
}

#[test]
fn funded_non_admin_dispute_overturned_refunds_the_bond() {
    let w = World::new();
    assert_ne!(w.disputer, w.admin);
    let before = w.balance(&w.disputer);
    assert!(w.dispute(&w.disputer, Some(resolver::Outcome::Yes)));
    assert_eq!(w.balance(&w.disputer), before - BOND);
    assert_eq!(w.balance(&w.resolver), BOND, "escrowed by the resolver");
    assert_eq!(
        w.resolver().state(&w.market_id),
        resolver::ResolutionState::Disputed
    );

    // The guardian overturns the proposal: the disputer is the payee.
    w.settle(resolver::Verdict::Yes);
    w.claim();
    assert_eq!(w.balance(&w.disputer), before, "bond returned, no reward");
    assert_eq!(w.balance(&w.resolver), 0);
}

#[test]
fn dispute_upheld_forfeits_the_bond_to_market_cores_treasury() {
    let w = World::new();
    let treasury = market_core::Client::new(&w.env, &w.core)
        .get_config()
        .treasury;
    let before = w.balance(&w.disputer);
    assert!(w.dispute(&w.disputer, Some(resolver::Outcome::Yes)));
    w.settle(resolver::Verdict::No); // the proposal stands
    w.claim();
    assert_eq!(
        w.balance(&w.disputer),
        before - BOND,
        "a wrong dispute costs the bond"
    );
    assert_eq!(w.balance(&treasury), BOND);
}

#[test]
fn a_second_dispute_is_refused_while_one_is_open() {
    let w = World::new();
    assert!(w.dispute(&w.disputer, Some(resolver::Outcome::Yes)));
    let other = Address::generate(&w.env);
    StellarAssetClient::new(&w.env, &w.token)
        .mock_auths(&[auth!(
            &w.admin,
            &w.token,
            "mint",
            (other.clone(), BOND).into_val(&w.env)
        )])
        .mint(&other, &BOND);
    assert!(
        !w.dispute(&other, Some(resolver::Outcome::Yes)),
        "DisputeActive"
    );
    assert_eq!(w.balance(&other), BOND, "the loser's bond never left");
}

#[test]
fn dispute_after_the_window_is_refused() {
    let w = World::new();
    w.env.ledger().set_timestamp(CLOSE + WINDOW);
    assert!(
        !w.dispute(&w.disputer, Some(resolver::Outcome::Yes)),
        "DisputeWindowClosed at proposed_at + window"
    );
}

#[test]
fn expire_dispute_after_the_timeout_refunds_the_bond() {
    let w = World::new();
    let before = w.balance(&w.disputer);
    assert!(w.dispute(&w.disputer, Some(resolver::Outcome::Yes)));
    w.env.set_auths(&[]);
    w.env.ledger().set_timestamp(CLOSE + TIMEOUT - 1);
    assert!(
        w.resolver().try_expire_dispute(&w.market_id).is_err(),
        "one second early"
    );
    w.env.ledger().set_timestamp(CLOSE + TIMEOUT);
    w.resolver().expire_dispute(&w.market_id); // permissionless
    w.claim();
    assert_eq!(w.balance(&w.disputer), before);
}
