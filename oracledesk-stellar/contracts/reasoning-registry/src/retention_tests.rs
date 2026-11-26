//! #329 retention tests: views are TTL-free, writes apply per-class targets,
//! and the archivist entrypoints are bounded and skip missing keys.

use super::*;
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    vec,
};

/// Large enough that no target in these tests is clamped, so close-time
/// differences stay visible.
const MAX_TTL: u32 = 20_000_000;
/// Testnet/mainnet `max_ttl` today (180 days).
const MAINNET_MAX_TTL: u32 = 3_110_400;
/// Market 0 closes this far after setup; market 1 much later.
const NEAR_CLOSE_SECS: u64 = 60_000;
const FAR_CLOSE_SECS: u64 = 200 * ttl::DAY_SECS;

struct Fx {
    env: Env,
    client: ReasoningRegistryClient<'static>,
    agent: Address,
    t0: u64,
}

fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_max_entry_ttl(MAX_TTL);
    env.ledger().set_min_persistent_entry_ttl(4_096);
    env.ledger().set_timestamp(1_700_000_000);
    let t0 = env.ledger().timestamp();
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let creator = Address::generate(&env);
    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    soroban_sdk::token::StellarAssetClient::new(&env, &collateral.address())
        .mint(&creator, &(50_000 * 10_000_000_i128));
    let mc_id = env.register(
        market_core::MarketCore,
        (
            admin.clone(),
            collateral.address(),
            Address::generate(&env),
            Address::generate(&env),
            100u32,
            10_000u32,
        ),
    );
    let mc = market_core::Client::new(&env, &mc_id);
    for close in [t0 + NEAR_CLOSE_SECS, t0 + FAR_CLOSE_SECS] {
        mc.create_market(
            &creator,
            &BytesN::from_array(&env, &[42u8; 32]),
            &BytesN::from_array(&env, &[142u8; 32]),
            &String::from_str(&env, "ipfs://market"),
            &market_core::Category::Crypto,
            &close,
            &(100 * 10_000_000_i128),
            &5000u32,
        );
    }
    let id = env.register(
        ReasoningRegistry,
        ReasoningRegistryArgs::__constructor(&admin, &mc_id),
    );
    let client = ReasoningRegistryClient::new(&env, &id);
    client.register_agent(&agent);
    Fx {
        env,
        client,
        agent,
        t0,
    }
}

fn publish(fx: &Fx, market_id: u64, action: TraceAction, seed: u8) -> u64 {
    fx.client.publish_trace(
        &fx.agent,
        &market_id,
        &action,
        &BytesN::from_array(&fx.env, &[seed; 32]),
        &String::from_str(&fx.env, "ipfs://trace"),
    )
}

fn ttl_of(fx: &Fx, key: &DataKey) -> u32 {
    fx.env.as_contract(&fx.client.address, || {
        fx.env.storage().persistent().get_ttl(key)
    })
}

fn instance_ttl(fx: &Fx) -> u32 {
    fx.env
        .as_contract(&fx.client.address, || fx.env.storage().instance().get_ttl())
}

fn advance(env: &Env, secs: u64) {
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + (secs / ttl::LEDGER_SECS) as u32);
    env.ledger().set_timestamp(env.ledger().timestamp() + secs);
}

fn audit_target_at(fx: &Fx, close: u64) -> u32 {
    fx.env.as_contract(&fx.client.address, || {
        retention::audit_target(&fx.env, close)
    })
}

fn long_lived(fx: &Fx) -> u32 {
    fx.env
        .as_contract(&fx.client.address, || retention::long_lived_target(&fx.env))
}

#[test]
fn views_have_no_ttl_side_effects() {
    let fx = setup();
    let env = &fx.env;
    // A chained trace (head + link), a batch and a flag give every view
    // something to read.
    let zero = BytesN::from_array(env, &[0u8; 32]);
    let h1 = BytesN::from_array(env, &[1u8; 32]);
    let id = fx.client.publish_chained_trace(
        &fx.agent,
        &0,
        &TraceAction::Buy,
        &h1,
        &String::from_str(env, "ipfs://c"),
        &1,
        &zero,
    );
    fx.client.publish_trace_batch(
        &fx.agent,
        &BytesN::from_array(env, &[7u8; 32]),
        &4,
        &String::from_str(env, "ipfs://manifest"),
    );
    fx.client.flag_trace(&id, &Symbol::new(env, "spam"));
    // Age everything (but stay inside the 30-day instance window) so any
    // half-target bump in a view would have fired.
    advance(env, 20 * ttl::DAY_SECS);

    let keys = [
        DataKey::Trace(id),
        DataKey::TraceLedger(id),
        DataKey::TraceLink(id),
        DataKey::Flag(id),
        DataKey::Agent(fx.agent.clone()),
        DataKey::AgentHead(fx.agent.clone()),
        DataKey::AgentTrace(fx.agent.clone(), 1),
        DataKey::MarketTrace(0, 0),
        DataKey::MarketTraceCount(0),
        DataKey::AgentTraceAt(fx.agent.clone(), 0),
        DataKey::Batch(0),
        DataKey::AgentBatch(fx.agent.clone(), 0),
    ];
    let before: std::vec::Vec<u32> = keys.iter().map(|k| ttl_of(&fx, k)).collect();
    let inst_before = instance_ttl(&fx);

    fx.client.get_trace(&id);
    fx.client.traces_by_market(&0, &0, &25);
    fx.client.traces_by_agent(&fx.agent, &0, &25);
    fx.client
        .traces_by_market_action(&0, &TraceAction::Buy, &0, &25);
    fx.client.trace_verdict(&id, &h1);
    fx.client.verify_trace(&id, &h1);
    fx.client.get_batch(&0);
    fx.client.agent_batch_at(&fx.agent, &0);
    fx.client.agent_chain_head(&fx.agent);
    fx.client.agent_chain_trace_at(&fx.agent, &1);
    fx.client.trace_count();
    fx.client.is_registered(&fx.agent);
    fx.client.get_agent(&fx.agent);
    fx.client.get_signing_keys(&fx.agent);
    fx.client.signing_key_history_count(&fx.agent);
    fx.client.get_trace_signature(&id);
    fx.client.trace_flags(&id, &0, &16);

    let after: std::vec::Vec<u32> = keys.iter().map(|k| ttl_of(&fx, k)).collect();
    assert_eq!(before, after, "a view extended a persistent entry");
    assert_eq!(inst_before, instance_ttl(&fx), "a view bumped the instance");
}

#[test]
fn trace_target_follows_close_time() {
    let fx = setup();
    let near = publish(&fx, 0, TraceAction::Buy, 1);
    let far = publish(&fx, 1, TraceAction::Buy, 2);
    let near_target = audit_target_at(&fx, fx.t0 + NEAR_CLOSE_SECS);
    let far_target = audit_target_at(&fx, fx.t0 + FAR_CLOSE_SECS);
    assert_eq!(ttl_of(&fx, &DataKey::Trace(near)), near_target);
    assert_eq!(ttl_of(&fx, &DataKey::TraceLedger(near)), near_target);
    assert_eq!(ttl_of(&fx, &DataKey::Trace(far)), far_target);
    // close + 90 d settlement horizon + 365 d audit margin.
    let expected_far =
        ((FAR_CLOSE_SECS + ttl::SETTLEMENT_HORIZON_SECS + retention::AUDIT_MARGIN_SECS)
            / ttl::LEDGER_SECS) as u32;
    assert_eq!(far_target, expected_far);
    assert!(far_target > near_target);
    // The close time is cached on the market's first trace.
    let cached: Option<u64> = fx.env.as_contract(&fx.client.address, || {
        fx.env.storage().persistent().get(&DataKey::MarketClose(1))
    });
    assert_eq!(cached, Some(fx.t0 + FAR_CLOSE_SECS));
}

#[test]
fn audit_target_is_clamped_to_max_ttl() {
    let fx = setup();
    fx.env.ledger().set_max_entry_ttl(MAINNET_MAX_TTL);
    let id = publish(&fx, 1, TraceAction::Buy, 3);
    assert_eq!(ttl_of(&fx, &DataKey::Trace(id)), MAINNET_MAX_TTL);
}

#[test]
fn no_market_trace_long_lived() {
    let fx = setup();
    let id = publish(&fx, NO_MARKET, TraceAction::ProposeMarket, 4);
    assert_eq!(ttl_of(&fx, &DataKey::Trace(id)), long_lived(&fx));
}

#[test]
fn index_never_shorter_than_newest_trace() {
    let fx = setup();
    let mut ids = std::vec::Vec::new();
    for seed in 0..3u8 {
        // #322: Skip is valid in any market state; a Buy would be rejected
        // once the 25-day steps pass the market's close.
        ids.push(publish(&fx, 1, TraceAction::Skip, seed));
        // Stay inside the instance window; each publish re-bumps it.
        advance(&fx.env, 25 * ttl::DAY_SECS);
    }
    // Past the old fixed 60-day window: under the pre-#329 policy the first
    // trace and its index entries would have archived by now.
    assert!(fx.env.ledger().timestamp() - fx.t0 > 60 * ttl::DAY_SECS);
    let page = fx.client.traces_by_market(&1, &0, &25);
    assert_eq!(page.entries.len(), 3);
    let newest = *ids.last().unwrap();
    let newest_ttl = ttl_of(&fx, &DataKey::Trace(newest));
    for key in [
        DataKey::MarketTraceCount(1),
        DataKey::AgentTraceCount(fx.agent.clone()),
        DataKey::MarketActionTraceCount(1, TraceAction::Skip),
        DataKey::MarketTrace(1, 2),
        DataKey::AgentTraceAt(fx.agent.clone(), 2),
        DataKey::MarketActionTraceAt(1, TraceAction::Skip, 2),
    ] {
        assert!(
            ttl_of(&fx, &key) >= newest_ttl,
            "index shorter than newest trace"
        );
    }
    // An index keeps the longer TTL when a later trace has an earlier close.
    let long_ttl = ttl_of(&fx, &DataKey::AgentTraceCount(fx.agent.clone()));
    publish(&fx, 0, TraceAction::Skip, 9);
    assert!(ttl_of(&fx, &DataKey::AgentTraceCount(fx.agent.clone())) >= long_ttl - 1);
}

#[test]
fn extend_traces_skips_missing_and_caps_len() {
    let fx = setup();
    // Mainnet's max_ttl (180 d) clamps the audit target, so an aged trace
    // falls below it and only an archivist (or a write) restores it.
    fx.env.ledger().set_max_entry_ttl(MAINNET_MAX_TTL);
    let id = publish(&fx, 1, TraceAction::Buy, 5);
    let too_many = Vec::from_array(&fx.env, [0u64; 33]);
    assert_eq!(
        fx.client.try_extend_traces(&too_many),
        Err(Ok(Error::TooManyEntries))
    );
    advance(&fx.env, 20 * ttl::DAY_SECS);
    let target = audit_target_at(&fx, fx.t0 + FAR_CLOSE_SECS);
    assert_eq!(target, MAINNET_MAX_TTL);
    assert!(ttl_of(&fx, &DataKey::Trace(id)) < target);
    // Unknown ids are skipped rather than panicking.
    let n = fx.client.extend_traces(&vec![&fx.env, id, 999]);
    // Trace, TraceLedger and the cached MarketClose.
    assert_eq!(n, 3);
    assert_eq!(ttl_of(&fx, &DataKey::Trace(id)), target);
    assert_eq!(ttl_of(&fx, &DataKey::TraceLedger(id)), target);
    assert_eq!(fx.client.extend_traces(&vec![&fx.env, 999]), 0);
}

#[test]
fn extend_index_and_agent_are_bounded_and_extend() {
    let fx = setup();
    fx.env.ledger().set_max_entry_ttl(MAINNET_MAX_TTL);
    for seed in 0..3u8 {
        publish(&fx, 1, TraceAction::Buy, seed);
    }
    assert_eq!(
        fx.client.try_extend_index(&IndexKey::Market(1), &0, &65),
        Err(Ok(Error::TooManyEntries))
    );
    assert_eq!(
        fx.client.try_extend_index(&IndexKey::Market(1), &3, &1),
        Err(Ok(Error::TooManyEntries))
    );
    advance(&fx.env, 20 * ttl::DAY_SECS);
    let target = audit_target_at(&fx, fx.t0 + FAR_CLOSE_SECS);
    assert!(ttl_of(&fx, &DataKey::MarketTrace(1, 0)) < target);
    // `to` beyond the index length is clamped: 3 entries + the count.
    assert_eq!(fx.client.extend_index(&IndexKey::Market(1), &0, &64), 4);
    assert_eq!(ttl_of(&fx, &DataKey::MarketTrace(1, 0)), target);
    assert_eq!(ttl_of(&fx, &DataKey::MarketTraceCount(1)), target);
    assert_eq!(
        fx.client
            .extend_index(&IndexKey::MarketAction(1, TraceAction::Buy), &0, &2),
        3
    );
    assert_eq!(
        fx.client
            .extend_index(&IndexKey::Agent(Address::generate(&fx.env)), &0, &10),
        0
    );

    // An agent registered under the clamp ages below it; extend_agent
    // restores it.
    let agent = Address::generate(&fx.env);
    fx.client.register_agent(&agent);
    advance(&fx.env, 20 * ttl::DAY_SECS);
    let agent_key = DataKey::Agent(agent.clone());
    assert!(ttl_of(&fx, &agent_key) < long_lived(&fx));
    fx.client.extend_agent(&agent);
    assert_eq!(ttl_of(&fx, &agent_key), long_lived(&fx));
    // Unknown agent: no panic.
    fx.client.extend_agent(&Address::generate(&fx.env));
}

#[test]
fn instance_bumped_on_writes_only() {
    let fx = setup();
    let id = publish(&fx, 1, TraceAction::Buy, 6);
    // Under the 7-day instance threshold.
    advance(&fx.env, 24 * ttl::DAY_SECS);
    let before = instance_ttl(&fx);
    assert!(before < ttl::INSTANCE_THRESHOLD);
    fx.client.trace_count();
    fx.client.get_trace(&id);
    fx.client.traces_by_market(&1, &0, &25);
    assert_eq!(instance_ttl(&fx), before, "view bumped the instance");
    fx.client.register_consumer(&Address::generate(&fx.env));
    assert_eq!(instance_ttl(&fx), ttl::INSTANCE_TARGET);
    advance(&fx.env, 24 * ttl::DAY_SECS);
    fx.client.extend_traces(&vec![&fx.env, id]);
    assert_eq!(instance_ttl(&fx), ttl::INSTANCE_TARGET);
}

#[test]
fn every_key_class_is_mapped() {
    let env = Env::default();
    let a = Address::generate(&env);
    let k = BytesN::from_array(&env, &[0u8; 32]);
    use retention::{class_of, RetentionClass::*};
    assert_eq!(class_of(&DataKey::Agent(a.clone())), Identity);
    assert_eq!(class_of(&DataKey::KeyToAgent(k.clone())), Identity);
    assert_eq!(class_of(&DataKey::Trace(0)), Audit);
    assert_eq!(class_of(&DataKey::FlagHistory(0, 0)), Audit);
    assert_eq!(class_of(&DataKey::AgentTrace(a.clone(), 1)), Audit);
    assert_eq!(class_of(&DataKey::MarketTrace(0, 0)), Index);
    assert_eq!(class_of(&DataKey::KeyTraceAt(k, 0)), Index);
    assert_eq!(class_of(&DataKey::Batch(0)), Batch);
    assert_eq!(class_of(&DataKey::NextId), Instance);
}
