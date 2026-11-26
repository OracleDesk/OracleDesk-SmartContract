//! Issue #322: trace actions are checked against live market-core and
//! resolver state, through the `#[contractclient]` mirrors in `peers.rs`.

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::IntoVal;

const SEED: i128 = 100 * 10_000_000;
const CLOSE_IN: u64 = 10_000;

struct Fx {
    env: Env,
    client: ReasoningRegistryClient<'static>,
    core: market_core::Client<'static>,
    resolver: resolver::ResolverClient<'static>,
    agent: Address,
    /// A market the agent created, resolved by signers `[agent]`.
    own: u64,
    /// A market a third party created.
    other: u64,
    close: u64,
}

fn signer_spec(env: &Env, signer: &Address) -> oracledesk_types::ResolutionSpec {
    oracledesk_types::ResolutionSpec::Signers(oracledesk_types::SignerConfig {
        signers: soroban_sdk::vec![env, signer.clone()],
        threshold: 1,
        dispute_window: 3_600,
    })
}

fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let third = Address::generate(&env);
    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = soroban_sdk::token::StellarAssetClient::new(&env, &collateral.address());
    token.mint(&agent, &(1_000 * SEED));
    token.mint(&third, &(1_000 * SEED));

    // market-core and the resolver point at each other, so the resolver is
    // registered at a pre-generated address.
    let resolver_id = Address::generate(&env);
    let core_id = env.register(
        market_core::MarketCore,
        (
            admin.clone(),
            collateral.address(),
            Address::generate(&env),
            resolver_id.clone(),
            100u32,
            10_000u32,
        ),
    );
    env.register_at(
        &resolver_id,
        resolver::Resolver,
        (admin.clone(), core_id.clone()),
    );
    let core = market_core::Client::new(&env, &core_id);
    let resolver = resolver::ResolverClient::new(&env, &resolver_id);

    let close = env.ledger().timestamp() + CLOSE_IN;
    let spec = signer_spec(&env, &agent);
    let create = |creator: &Address| {
        core.create_market(
            creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &resolver::legacy_spec_hash(&env, &spec),
            &String::from_str(&env, "ipfs://m"),
            &market_core::Category::Crypto,
            &close,
            &SEED,
            &5000u32,
        )
    };
    let own = create(&agent);
    let other = create(&third);
    let oracledesk_types::ResolutionSpec::Signers(cfg) = spec else {
        unreachable!()
    };
    resolver.register_signer_spec(&own, &cfg);

    let id = env.register(
        ReasoningRegistry,
        ReasoningRegistryArgs::__constructor(&admin, &core_id),
    );
    let client = ReasoningRegistryClient::new(&env, &id);
    client.register_agent(&agent);
    Fx {
        env,
        client,
        core,
        resolver,
        agent,
        own,
        other,
        close,
    }
}

fn publish(fx: &Fx, market_id: u64, action: TraceAction) -> Result<u64, Error> {
    fx.client
        .try_publish_trace(
            &fx.agent,
            &market_id,
            &action,
            &BytesN::from_array(&fx.env, &[9u8; 32]),
            &String::from_str(&fx.env, "ipfs://t"),
        )
        .map(|r| r.unwrap())
        .map_err(|e| e.unwrap())
}

fn at(fx: &Fx, ts: u64) {
    fx.env.ledger().set_timestamp(ts);
}

#[test]
fn buy_on_resolved_market_rejected() {
    let fx = setup();
    fx.core.void_market(&fx.own);
    // Still before close: the status check fires, not the clock.
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Buy),
        Err(Error::MarketClosed)
    );
}

#[test]
fn buy_within_grace_marked_late() {
    let fx = setup();
    let on_time = publish(&fx, fx.own, TraceAction::Buy).unwrap();
    assert!(!fx.client.is_trace_late(&on_time));
    at(&fx, fx.close + 10);
    let late = publish(&fx, fx.own, TraceAction::Sell).unwrap();
    assert!(fx.client.is_trace_late(&late));
    let hash = BytesN::from_array(&fx.env, &[9u8; 32]);
    assert_eq!(fx.client.trace_verdict(&late, &hash), TraceVerdict::Late);
    assert_eq!(
        fx.client.trace_verdict(&on_time, &hash),
        TraceVerdict::Valid
    );
    // A hash mismatch still wins over lateness.
    assert_eq!(
        fx.client
            .trace_verdict(&late, &BytesN::from_array(&fx.env, &[0u8; 32])),
        TraceVerdict::HashMismatch
    );
}

#[test]
fn sell_after_grace_rejected() {
    let fx = setup();
    at(&fx, fx.close + DEFAULT_ACTION_GRACE_SECS);
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Sell),
        Err(Error::MarketClosed)
    );
    // A wider (admin-set) grace admits it.
    fx.client.set_action_grace(&(2 * DEFAULT_ACTION_GRACE_SECS));
    assert!(publish(&fx, fx.own, TraceAction::Sell).is_ok());
    assert_eq!(
        fx.client.try_set_action_grace(&(MAX_ACTION_GRACE_SECS + 1)),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn redeem_on_open_market_rejected() {
    let fx = setup();
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Redeem),
        Err(Error::MarketNotFinal)
    );
    assert_eq!(
        publish(&fx, fx.own, TraceAction::ClaimRemainder),
        Err(Error::MarketNotFinal)
    );
    // Void is final.
    fx.core.void_market(&fx.own);
    assert!(publish(&fx, fx.own, TraceAction::Redeem).is_ok());
}

#[test]
fn create_market_trace_requires_creator_or_consumer() {
    let fx = setup();
    assert!(publish(&fx, fx.own, TraceAction::CreateMarket).is_ok());
    assert_eq!(
        publish(&fx, fx.other, TraceAction::CreateMarket),
        Err(Error::NotMarketCreator)
    );
    // A registered consumer (e.g. the treasury) creating on the agent's behalf.
    let creator = fx.core.get_market(&fx.other).creator;
    fx.client.register_consumer(&creator);
    assert!(publish(&fx, fx.other, TraceAction::CreateMarket).is_ok());
    at(&fx, fx.close + 1);
    assert_eq!(
        publish(&fx, fx.own, TraceAction::CreateMarket),
        Err(Error::MarketClosed)
    );
}

#[test]
fn resolve_before_close_rejected() {
    let fx = setup();
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Resolve),
        Err(Error::MarketNotClosed)
    );
}

#[test]
fn resolve_requires_resolution_signer() {
    let fx = setup();
    at(&fx, fx.close);
    assert!(publish(&fx, fx.own, TraceAction::Resolve).is_ok());
    // No spec revealed for `other`, and the agent is not the resolver admin.
    assert_eq!(
        publish(&fx, fx.other, TraceAction::Resolve),
        Err(Error::NotResolutionSigner)
    );
    let stranger = Address::generate(&fx.env);
    assert_eq!(
        fx.resolver
            .resolution_role(&fx.own, &stranger, &Vec::new(&fx.env)),
        resolver::ResolutionRole::None
    );
}

#[test]
fn skip_allowed_any_state() {
    let fx = setup();
    assert!(publish(&fx, fx.own, TraceAction::Skip).is_ok());
    fx.core.void_market(&fx.own);
    at(&fx, fx.close + 10 * DEFAULT_ACTION_GRACE_SECS);
    assert!(publish(&fx, fx.own, TraceAction::Skip).is_ok());
    assert_eq!(
        publish(&fx, 999, TraceAction::Skip),
        Err(Error::UnknownMarket)
    );
}

#[test]
fn other_requires_allow_list_and_rule() {
    let fx = setup();
    let hedge = Symbol::new(&fx.env, "hedge");
    let note = Symbol::new(&fx.env, "note");
    assert_eq!(
        publish(&fx, NO_MARKET, TraceAction::Other(hedge.clone())),
        Err(Error::UnknownOtherAction)
    );
    fx.client
        .set_other_action(&hedge, &Some(OtherRule::MarketOnly));
    fx.client
        .set_other_action(&note, &Some(OtherRule::NoMarketOnly));
    assert_eq!(
        publish(&fx, NO_MARKET, TraceAction::Other(hedge.clone())),
        Err(Error::MarketRequired)
    );
    assert!(publish(&fx, fx.own, TraceAction::Other(hedge.clone())).is_ok());
    assert!(publish(&fx, NO_MARKET, TraceAction::Other(note.clone())).is_ok());
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Other(note.clone())),
        Err(Error::ProposalMustUseNoMarket)
    );
    assert_eq!(fx.client.other_actions().len(), 2);
    assert_eq!(
        fx.client.other_action_rule(&hedge),
        Some(OtherRule::MarketOnly)
    );
    // Canonical names can never be allow-listed.
    assert_eq!(
        fx.client
            .try_set_other_action(&Symbol::new(&fx.env, "buy"), &Some(OtherRule::Any)),
        Err(Ok(Error::UseCanonicalAction))
    );
    fx.client.set_other_action(&hedge, &None);
    assert_eq!(fx.client.other_actions().len(), 1);
    assert_eq!(
        publish(&fx, fx.own, TraceAction::Other(hedge)),
        Err(Error::UnknownOtherAction)
    );
}

#[test]
fn other_allow_list_is_bounded() {
    let fx = setup();
    for i in 0..MAX_OTHER_ACTIONS {
        let sym = Symbol::new(&fx.env, &std::format!("act{i}"));
        fx.client.set_other_action(&sym, &Some(OtherRule::Any));
    }
    assert_eq!(
        fx.client
            .try_set_other_action(&Symbol::new(&fx.env, "one_more"), &Some(OtherRule::Any)),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn market_mirror_decodes_real_market_core_values() {
    let fx = setup();
    let real = fx.core.get_market(&fx.own);
    let raw: soroban_sdk::Val = real.clone().into_val(&fx.env);
    let mirror: peers::Market = raw.into_val(&fx.env);
    assert_eq!(mirror.creator, real.creator);
    assert_eq!(mirror.close_time, real.close_time);
    assert_eq!(mirror.resolution_hash, real.resolution_hash);
    let raw: soroban_sdk::Val = fx.core.get_config().into_val(&fx.env);
    let cfg: peers::CoreConfig = raw.into_val(&fx.env);
    assert_eq!(cfg.resolver, fx.resolver.address);
}
