use super::*;
use market_core::MarketStatus;
// Test-only import of the vendored registry. Kept out of the crate root: the
// contract import's spec types would collide with the router's own event types.
mod reasoning_registry {
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "reasoning_registry.wasm");
}
use reasoning_registry::Client as RegistryClient;
use resolver::{PriceConfig, SignerConfig};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec,
};

const NETWORK_ID: [u8; 32] = [9; 32];
const SALT: [u8; 32] = [3; 32];

struct Fixture {
    env: Env,
    router: RouterClient<'static>,
    market_core: MarketCoreClient<'static>,
    resolver: ResolverClient<'static>,
    registry: RegistryClient<'static>,
    creator: Address,
    signer: Address,
}

fn signer_config(env: &Env, signer: &Address) -> SignerConfig {
    SignerConfig {
        signers: vec![env, signer.clone()],
        threshold: 1,
        dispute_window: 100,
    }
}

fn price_config(env: &Env, reflector: &Address) -> PriceConfig {
    PriceConfig {
        reflector: reflector.clone(),
        asset: resolver::OracleAsset::Other(soroban_sdk::Symbol::new(env, "XLM")),
        threshold: 2_000,
        direction: resolver::PriceDirection::Above,
        max_staleness: 10,
    }
}

fn envelope(env: &Env, market_core: &Address, rule: ResolutionSpec) -> ResolutionSpecV2 {
    ResolutionSpecV2 {
        version: 2,
        network_id: BytesN::from_array(env, &NETWORK_ID),
        market_core: market_core.clone(),
        salt: BytesN::from_array(env, &SALT),
        rule,
    }
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    env.ledger().set_network_id(NETWORK_ID);

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let signer = Address::generate(&env);
    let treasury = Address::generate(&env);

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = StellarAssetClient::new(&env, &collateral.address());
    token.mint(&creator, &(1_000 * 10_000_000_i128));

    let registry_id = Address::generate(&env);

    // market-core first needs a resolver address; deploy the real resolver
    // against a placeholder core, then deploy market-core, then re-point the
    // resolver's storage by deploying it once with the final address. Both are
    // constructed deterministically here (register_at with a fixed address).
    let resolver_id = Address::generate(&env);
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
    env.register_at(
        &resolver_id,
        resolver::WASM,
        (admin.clone(), market_core_id.clone()),
    );
    // The registry constructor binds both the admin and the market-core it
    // validates traces against, so it can only be deployed once core exists.
    env.register_at(
        &registry_id,
        reasoning_registry::WASM,
        (admin.clone(), market_core_id.clone()),
    );
    let registry = RegistryClient::new(&env, &registry_id);

    let router_id = env.register(
        Router,
        (
            market_core_id.clone(),
            resolver_id.clone(),
            Some(registry_id.clone()),
        ),
    );

    let market_core = MarketCoreClient::new(&env, &market_core_id);
    let resolver_client = ResolverClient::new(&env, &resolver_id);
    let router = RouterClient::new(&env, &router_id);

    Fixture {
        env,
        router,
        market_core,
        resolver: resolver_client,
        registry,
        creator,
        signer,
    }
}

#[test]
fn create_and_reveal_signers_is_atomic_and_revealed() {
    let f = fixture();
    let spec = envelope(
        &f.env,
        &f.market_core.address,
        ResolutionSpec::Signers(signer_config(&f.env, &f.signer)),
    );

    let market_id = f.router.create_and_reveal_signers(
        &f.creator,
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &String::from_str(&f.env, "ipfs://q"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
        &spec,
    );

    assert_eq!(market_id, 0);
    // Both halves landed: the market exists and is configured (a spec was
    // revealed), so the "unrevealed market" failure mode is gone.
    let market = f.market_core.get_market(&market_id);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(market.resolution_hash, spec_v2_hash(&f.env, &spec));
    assert_ne!(
        f.resolver.state(&market_id),
        resolver::ResolutionState::Unconfigured
    );
}

#[test]
fn create_and_reveal_price_is_atomic_and_revealed() {
    let f = fixture();
    let reflector = Address::generate(&f.env);
    let spec = envelope(
        &f.env,
        &f.market_core.address,
        ResolutionSpec::Price(price_config(&f.env, &reflector)),
    );

    let market_id = f.router.create_and_reveal_price(
        &f.creator,
        &BytesN::from_array(&f.env, &[8u8; 32]),
        &String::from_str(&f.env, "ipfs://p"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
        &spec,
    );
    // Price rules keep the default Unconfigured state but the rule is stored;
    // re-revealing the same market must now fail as already configured.
    let err = f.router.try_reveal_spec(&market_id, &spec);
    assert!(err.is_err(), "a second reveal must be rejected");
    let market = f.market_core.get_market(&market_id);
    assert_eq!(market.resolution_hash, spec_v2_hash(&f.env, &spec));
}

#[test]
fn mismatched_network_reverts_before_moving_collateral() {
    let f = fixture();
    let mut spec = envelope(
        &f.env,
        &f.market_core.address,
        ResolutionSpec::Signers(signer_config(&f.env, &f.signer)),
    );
    spec.network_id = BytesN::from_array(&f.env, &[1u8; 32]);

    let token = TokenClient::new(&f.env, &f.market_core.get_config().collateral);
    let before = token.balance(&f.creator);

    let err = f.router.try_create_and_reveal_signers(
        &f.creator,
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &String::from_str(&f.env, "ipfs://q"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
        &spec,
    );
    assert_eq!(err, Err(Ok(Error::DomainMismatch)));
    // No market created, no collateral moved.
    assert_eq!(f.market_core.market_count(), 0);
    assert_eq!(token.balance(&f.creator), before);
}

#[test]
fn malformed_rule_reverts_with_no_market() {
    let f = fixture();
    // threshold > signers len is rejected by the resolver's own rules.
    let bad = SignerConfig {
        signers: vec![&f.env, f.signer.clone()],
        threshold: 2,
        dispute_window: 100,
    };
    let spec = envelope(&f.env, &f.market_core.address, ResolutionSpec::Signers(bad));

    let err = f.router.try_create_and_reveal_signers(
        &f.creator,
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &String::from_str(&f.env, "ipfs://q"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
        &spec,
    );
    assert_eq!(err, Err(Ok(Error::InvalidConfig)));
    assert_eq!(f.market_core.market_count(), 0);
}

#[test]
fn reveal_spec_works_for_deferred_commit() {
    let f = fixture();
    let spec = envelope(
        &f.env,
        &f.market_core.address,
        ResolutionSpec::Signers(signer_config(&f.env, &f.signer)),
    );
    let market_id = f.market_core.create_market(
        &f.creator,
        &BytesN::from_array(&f.env, &[9u8; 32]),
        &spec_v2_hash(&f.env, &spec),
        &String::from_str(&f.env, "ipfs://deferred"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
    );
    assert_eq!(
        f.resolver.state(&market_id),
        resolver::ResolutionState::Unconfigured
    );
    f.router.reveal_spec(&market_id, &spec);
    assert_ne!(
        f.resolver.state(&market_id),
        resolver::ResolutionState::Unconfigured
    );
}

#[test]
fn buy_and_publish_trace_does_both() {
    let f = fixture();
    let spec = envelope(
        &f.env,
        &f.market_core.address,
        ResolutionSpec::Signers(signer_config(&f.env, &f.signer)),
    );
    let market_id = f.router.create_and_reveal_signers(
        &f.creator,
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &String::from_str(&f.env, "ipfs://q"),
        &Category::Crypto,
        &2_000,
        &(100 * 10_000_000_i128),
        &5000u32,
        &spec,
    );

    // The registry must know the trader as an agent.
    let admin = f.market_core.get_config().admin;
    f.registry.register_agent(&admin);
    // fund trader
    let token = StellarAssetClient::new(&f.env, &f.market_core.get_config().collateral);
    token.mint(&admin, &(100 * 10_000_000_i128));

    let result = f.router.buy_and_publish_trace(
        &admin,
        &market_id,
        &Outcome::Yes,
        &(10 * 10_000_000_i128),
        &0i128,
        &BytesN::from_array(&f.env, &[1u8; 32]),
        &String::from_str(&f.env, "ipfs://trace"),
    );
    assert_eq!(result.trace_id, 0);
    assert!(result.shares > 0);
    assert_eq!(result.chain_seq, None);
    // The position exists (the buy landed) and the trace exists.
    let pos = f.market_core.get_position(&market_id, &admin);
    assert!(pos.yes > 0);
}

#[test]
fn action_mismatch_rejected_before_any_call() {
    let f = fixture();
    let err = f.router.try_trade_and_publish_trace(
        &f.creator,
        &0u64,
        &Outcome::Yes,
        &Side::Buy,
        &TradeBounds {
            amount: 1,
            limit_shares: 0,
            limit_price_bps: 0,
            deadline: 2_000,
        },
        &TraceArgs {
            action: TraceAction::Sell,
            trace_hash: BytesN::from_array(&f.env, &[1u8; 32]),
            ipfs_cid: String::from_str(&f.env, "ipfs://trace"),
            chained: false,
            chain_expected_seq: 0,
            chain_prev_trace_hash: BytesN::from_array(&f.env, &[0u8; 32]),
            signed: false,
            signing_key: BytesN::from_array(&f.env, &[0u8; 32]),
            signature: BytesN::from_array(&f.env, &[0u8; 64]),
        },
    );
    assert_eq!(err, Err(Ok(Error::ActionMismatch)));
}

#[test]
fn buy_and_publish_trace_without_registry_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let router_id = env.register(Router, (a.clone(), b.clone(), None::<Address>));
    let router = RouterClient::new(&env, &router_id);
    let err = router.try_buy_and_publish_trace(
        &a,
        &0u64,
        &Outcome::Yes,
        &1i128,
        &0i128,
        &BytesN::from_array(&env, &[1u8; 32]),
        &String::from_str(&env, "ipfs://trace"),
    );
    assert_eq!(err, Err(Ok(Error::NotInitialized)));
}
