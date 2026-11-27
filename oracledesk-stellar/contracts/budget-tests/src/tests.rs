use crate::{
    baseline_path, compile_time_rustc, load_baseline, market_core_wasm, measure, registry_wasm,
    stellar_cli_version, treasury_wasm, wasm_bytes, write_baseline, Baseline, Meta, Metrics,
    Tolerance,
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

const UNIT: i128 = 10_000_000; // 1 USDC
const MIN_SEED: i128 = 100 * UNIT;
const BASE_TS: u64 = 1_000_000;
type Scenario = (&'static str, fn() -> Metrics);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct McFixture {
    env: Env,
    client: market_core_wasm::Client<'static>,
    token: TokenClient<'static>,
    admin: Address,
    creator: Address,
    trader: Address,
}

fn mc_fixture() -> McFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let resolver = Address::generate(&env);
    let creator = Address::generate(&env);
    let trader = Address::generate(&env);

    let collateral = env.register_stellar_asset_contract_v2(admin.clone());
    let token = collateral.address();
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&creator, &(10_000 * UNIT));
    sac.mint(&trader, &(10_000 * UNIT));

    let contract_id = env.register(
        market_core_wasm::WASM,
        (
            admin.clone(),
            token.clone(),
            treasury,
            resolver,
            100u32,
            10_000u32,
        ),
    );
    let client = market_core_wasm::Client::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);
    McFixture {
        env,
        client,
        token: token_client,
        admin,
        creator,
        trader,
    }
}

fn create_market_with_uri(fx: &McFixture, uri: &str) -> u64 {
    let s = String::from_str(&fx.env, uri);
    fx.client.create_market(
        &fx.creator,
        &BytesN::from_array(&fx.env, &[1u8; 32]),
        &BytesN::from_array(&fx.env, &[2u8; 32]),
        &s,
        &market_core_wasm::Category::Crypto,
        &(BASE_TS + 60_000),
        &MIN_SEED,
        &5_000u32,
    )
}

fn create_market(fx: &McFixture) -> u64 {
    create_market_with_uri(fx, "ipfs://budget")
}

fn buy(fx: &McFixture, market_id: u64, amount: i128) -> i128 {
    fx.client.buy(
        &fx.trader,
        &market_id,
        &market_core_wasm::Outcome::Yes,
        &amount,
        &0i128,
    )
}

// ---------------------------------------------------------------------------
// market-core scenarios
// ---------------------------------------------------------------------------

fn mc_create_market_min_uri() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, "ipfs://b");
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

fn mc_create_market_uri_1k() -> Metrics {
    let fx = mc_fixture();
    let env = fx.env.clone();
    let uri = String::from_str(&env, &"u".repeat(1_024));
    measure(&env, || {
        fx.client.create_market(
            &fx.creator,
            &BytesN::from_array(&env, &[1u8; 32]),
            &BytesN::from_array(&env, &[2u8; 32]),
            &uri,
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 60_000),
            &MIN_SEED,
            &5_000u32,
        )
    })
}

fn mc_buy_first_position() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || buy(&fx, market_id, 10 * UNIT))
}

fn mc_buy_existing_position() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || buy(&fx, market_id, 10 * UNIT))
}

fn mc_sell_partial() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.sell(
            &fx.trader,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &(2 * UNIT),
            &i128::MAX,
        )
    })
}

fn mc_sell_full_position_removal() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    // Sell everything the trader just bought: pick the largest collateral
    // payout whose required shares fit inside the position, so the position
    // entry is removed (exact when granularity allows).
    let shares = buy(&fx, market_id, UNIT);
    let m = fx.client.get_market(&market_id);
    let start = market_core::math::calc_sell_shares(
        m.reserve_yes,
        m.reserve_no,
        shares,
        m.fee_bps,
    )
    .unwrap()
    .collateral_out;
    let mut lo = 0i128;
    let mut hi = start.saturating_mul(3);
    let mut best = 0i128;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        match market_core::math::calc_sell(m.reserve_yes, m.reserve_no, mid, m.fee_bps) {
            Ok(q) if q.shares_in <= shares => {
                best = mid;
                lo = mid + 1;
            }
            _ => {
                if mid == 0 {
                    break;
                }
                hi = mid - 1;
            }
        }
    }
    let collateral_out = best.max(1);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.sell(
            &fx.trader,
            &market_id,
            &market_core_wasm::Outcome::Yes,
            &collateral_out,
            &i128::MAX,
        )
    })
}

fn mc_redeem_void() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    fx.client.void_market(&market_id);
    let env = fx.env.clone();
    measure(&env, || fx.client.redeem(&fx.trader, &market_id))
}

fn mc_claim_pool_remainder() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    fx.env.ledger().set_timestamp(BASE_TS + 70_000);
    fx.client.void_market(&market_id);
    let env = fx.env.clone();
    measure(&env, || fx.client.claim_pool_remainder(&market_id))
}

fn mc_sweep_fees() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 100 * UNIT);
    let env = fx.env.clone();
    measure(&env, || fx.client.sweep_fees(&market_id))
}

fn mc_get_market() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || fx.client.get_market(&market_id))
}

fn mc_quote_buy() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .quote_buy(&market_id, &market_core_wasm::Outcome::Yes, &(10 * UNIT))
    })
}

fn mc_quote_sell() -> Metrics {
    let fx = mc_fixture();
    let market_id = create_market(&fx);
    buy(&fx, market_id, 10 * UNIT);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client
            .quote_sell(&market_id, &market_core_wasm::Outcome::Yes, &(2 * UNIT))
    })
}

// ---------------------------------------------------------------------------
// reasoning-registry scenarios
// ---------------------------------------------------------------------------

struct RegistryFixture {
    env: Env,
    client: registry_wasm::Client<'static>,
    agent: Address,
}

/// Registers the registry with its real constructor `(admin, market_core)`
/// (#329) and one market for traces to reference.
fn registry_fixture() -> RegistryFixture {
    let mc = mc_fixture();
    create_market(&mc);
    let env = mc.env.clone();
    let agent = Address::generate(&env);
    let contract_id = env.register(registry_wasm::WASM, (mc.admin.clone(), mc.client.address.clone()));
    let client = registry_wasm::Client::new(&env, &contract_id);
    client.register_agent(&agent);
    RegistryFixture { env, client, agent }
}

fn registry_action(env: &Env, action: &str) -> registry_wasm::TraceAction {
    registry_wasm::TraceAction::Other(soroban_sdk::Symbol::new(env, action))
}

fn registry_publish_raw(fx: &RegistryFixture, seed: u8) -> u64 {
    fx.client.publish_trace(
        &fx.agent,
        &0u64,
        &registry_wasm::TraceAction::Buy,
        &BytesN::from_array(&fx.env, &[seed; 32]),
        &String::from_str(&fx.env, "ipfs://small"),
    )
}

fn registry_publish(fx: &RegistryFixture, action: &str, cid: &str) -> Metrics {
    let action = registry_action(&fx.env, action);
    let cid = String::from_str(&fx.env, cid);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.publish_trace(
            &fx.agent,
            &0u64,
            &action,
            &BytesN::from_array(&env, &[9u8; 32]),
            &cid,
        )
    })
}

fn reg_publish_small() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, "buy_yes", "ipfs://small")
}

fn reg_publish_cid_1k() -> Metrics {
    let fx = registry_fixture();
    // MAX_CID_LEN (128) is the longest accepted CID since #57.
    registry_publish(&fx, "buy_yes", &"c".repeat(128))
}

fn reg_publish_action_1k() -> Metrics {
    let fx = registry_fixture();
    // Symbols are at most 32 chars; the longest accepted `Other` action.
    registry_publish(&fx, &"a".repeat(32), "ipfs://cid")
}

/// #329: first trace on a market writes every audit/index key at the
/// market's audit target and caches its close time.
fn reg_publish_audit_class() -> Metrics {
    let fx = registry_fixture();
    let env = fx.env.clone();
    measure(&env, || registry_publish_raw(&fx, 1))
}

fn reg_get_trace() -> Metrics {
    let fx = registry_fixture();
    let trace_id = registry_publish_raw(&fx, 9);
    let env = fx.env.clone();
    measure(&env, || fx.client.get_trace(&trace_id))
}

fn reg_traces_by_market_page25() -> Metrics {
    let fx = registry_fixture();
    for seed in 0..25u8 {
        registry_publish_raw(&fx, seed);
    }
    let env = fx.env.clone();
    measure(&env, || fx.client.traces_by_market(&0u64, &0u64, &25u32))
}

fn reg_extend_traces_32() -> Metrics {
    let fx = registry_fixture();
    let mut ids = soroban_sdk::Vec::new(&fx.env);
    for seed in 0..32u8 {
        ids.push_back(registry_publish_raw(&fx, seed));
    }
    let env = fx.env.clone();
    measure(&env, || fx.client.extend_traces(&ids))
}

/// #329: registry views must have read-only footprints.
#[test]
fn registry_views_write_nothing() {
    for (name, f) in [
        ("get_trace.read_only", reg_get_trace as fn() -> Metrics),
        ("traces_by_market.page25.read_only", reg_traces_by_market_page25),
    ] {
        let m = f();
        assert_eq!(m.write_entries, 0, "{name} wrote ledger entries");
        assert_eq!(m.write_bytes, 0, "{name} wrote ledger bytes");
    }
}

// ---------------------------------------------------------------------------
// Treasury withdrawal queue scenarios (#277)
//
// Every scenario deploys the real treasury and market-core wasm, queues
// `tickets` full withdrawals behind `markets` open markets, and measures one
// top-level call that drains the queue. `QUEUE_WINDOW` / `MAX_QUEUE_STEPS`
// in contracts/treasury are sized so the worst case stays under 80% of the
// network limits (`queue_worst_cases_under_80_percent`).
// ---------------------------------------------------------------------------

struct TrFixture {
    env: Env,
    core: market_core_wasm::Client<'static>,
    treasury: treasury_wasm::Client<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    agent: Address,
    owners: Vec<Address>,
    markets: Vec<u64>,
}

fn tr_fixture(tickets: u32, markets: u32) -> TrFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let creator = Address::generate(&env);
    let collateral = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &collateral);
    sac.mint(&creator, &(100_000 * UNIT));
    let treasury_id = Address::generate(&env);
    let resolver = Address::generate(&env);
    let core_id = env.register(
        market_core_wasm::WASM,
        (admin.clone(), collateral.clone(), treasury_id.clone(), resolver, 100u32, 10_000u32),
    );
    let policy = treasury_wasm::CreationPolicy {
        max_seed: 200 * UNIT,
        max_markets_per_window: 100,
        creation_window_secs: 86_400,
        min_close_horizon: 60,
        max_close_horizon: 10_000_000,
        allowed_categories: 0x3F,
    };
    env.register_at(
        &treasury_id,
        treasury_wasm::WASM,
        (
            admin.clone(),
            agent.clone(),
            collateral.clone(),
            core_id.clone(),
            1_000 * UNIT,
            2_000 * UNIT,
            3_000 * UNIT,
            3_000 * UNIT,
            86_400u64,
            10_000 * UNIT,
            7u32,
            policy,
        ),
    );
    let core = market_core_wasm::Client::new(&env, &core_id);
    let treasury = treasury_wasm::Client::new(&env, &treasury_id);
    let mut ids = Vec::new();
    for i in 0..markets {
        ids.push(core.create_market(
            &creator,
            &BytesN::from_array(&env, &[i as u8 + 1; 32]),
            &BytesN::from_array(&env, &[i as u8 + 101; 32]),
            &String::from_str(&env, "ipfs://budget"),
            &market_core_wasm::Category::Crypto,
            &(BASE_TS + 30 * 86_400),
            &MIN_SEED,
            &5_000u32,
        ));
    }
    // `max(tickets, 1)` depositors of 20 USDC; all but 10 USDC is deployed
    // into complete sets spread over the open markets.
    let n = tickets.max(1);
    let mut owners = Vec::new();
    for _ in 0..n {
        let who = Address::generate(&env);
        sac.mint(&who, &(20 * UNIT));
        treasury.deposit(&who, &(20 * UNIT));
        owners.push(who);
    }
    let deploy = 20 * UNIT * n as i128 - 10 * UNIT;
    let share = deploy / markets as i128;
    // Paired YES / NO buys of at most 5 USDC each keep the price inside the
    // treasury's default impact band and build complete sets, which NAV
    // counts (directional exposure is valued at zero).
    for id in &ids {
        let mut left = share;
        while left > 1 {
            let chunk = left.min(5 * UNIT);
            let yes = chunk / 2;
            let no = chunk - yes;
            treasury.agent_buy(&agent, id, &treasury_wasm::Outcome::Yes, &yes, &0);
            treasury.agent_buy(&agent, id, &treasury_wasm::Outcome::No, &no, &0);
            left -= chunk;
        }
    }
    for who in owners.iter().take(tickets as usize) {
        treasury.request_withdraw(who, &treasury.shares_of(who));
    }
    let token = TokenClient::new(&env, &collateral);
    TrFixture {
        env,
        core,
        treasury,
        token,
        token_admin: sac,
        agent,
        owners,
        markets: ids,
    }
}

/// Like `measure`, but never aborts on the budget: the point of these
/// scenarios is to *report* the cost so `queue_worst_cases_under_80_percent`
/// can compare it with the network limits.
fn measure_tr<R>(env: &Env, f: impl FnOnce() -> R) -> Metrics {
    env.cost_estimate().budget().reset_unlimited();
    let _ = f();
    let r = env.cost_estimate().resources();
    Metrics {
        cpu_insns: r.instructions.max(0) as u64,
        mem_bytes: r.mem_bytes.max(0) as u64,
        read_entries: r.memory_read_entries.saturating_add(r.disk_read_entries),
        write_entries: r.write_entries,
        read_bytes: r.disk_read_bytes,
        write_bytes: r.write_bytes,
        events_bytes: r.contract_events_size_bytes,
    }
}

fn tr_settle(tickets: u32) -> Metrics {
    let f = tr_fixture(tickets, 1);
    let m = f.markets[0];
    f.env.ledger().set_timestamp(BASE_TS + 30 * 86_400);
    f.core.resolve(&m, &market_core_wasm::Outcome::Yes);
    let keeper = Address::generate(&f.env);
    measure_tr(&f.env, || f.treasury.settle_market(&keeper, &m))
}

fn tr_settle_0_tickets() -> Metrics {
    tr_settle(0)
}
fn tr_settle_1_ticket() -> Metrics {
    tr_settle(1)
}
fn tr_settle_8_tickets() -> Metrics {
    tr_settle(8)
}

/// Full head window (8 tickets) paid pro rata from a partial payment.
fn tr_drain_pro_rata_window() -> Metrics {
    let f = tr_fixture(8, 1);
    let owed = f.treasury.queue_reserved();
    f.token_admin.mint(&f.treasury.address, &(owed / 3 + 7));
    measure_tr(&f.env, || f.treasury.claim_withdraw(&1))
}

fn tr_cancel_12_markets() -> Metrics {
    let f = tr_fixture(1, 12);
    f.env.ledger().set_timestamp(BASE_TS + 86_400 + 1);
    let owner = f.owners[0].clone();
    measure_tr(&f.env, || f.treasury.cancel_withdraw(&owner, &1))
}

fn tr_deposit_12_markets_8_tickets() -> Metrics {
    let f = tr_fixture(8, 12);
    let who = Address::generate(&f.env);
    f.token_admin.mint(&who, &(50 * UNIT));
    let _ = &f.agent;
    let _ = &f.token;
    measure_tr(&f.env, || f.treasury.deposit(&who, &(50 * UNIT)))
}

// ---------------------------------------------------------------------------
// Registry of scenarios
// ---------------------------------------------------------------------------

fn scenarios() -> Vec<Scenario> {
    vec![
        (
            "market_core.create_market.min_uri",
            mc_create_market_min_uri,
        ),
        ("market_core.create_market.uri_1k", mc_create_market_uri_1k),
        ("market_core.buy.first_position", mc_buy_first_position),
        (
            "market_core.buy.existing_position",
            mc_buy_existing_position,
        ),
        ("market_core.sell.partial", mc_sell_partial),
        (
            "market_core.sell.full_position_removal",
            mc_sell_full_position_removal,
        ),
        ("market_core.redeem.void", mc_redeem_void),
        ("market_core.claim_pool_remainder", mc_claim_pool_remainder),
        ("market_core.sweep_fees", mc_sweep_fees),
        ("market_core.view.get_market", mc_get_market),
        ("market_core.view.quote_buy", mc_quote_buy),
        ("market_core.view.quote_sell", mc_quote_sell),
        ("registry.publish_trace.small", reg_publish_small),
        ("registry.publish_trace.cid_1k", reg_publish_cid_1k),
        ("registry.publish_trace.action_1k", reg_publish_action_1k),
        ("registry.publish_trace.audit_class", reg_publish_audit_class),
        ("registry.view.get_trace", reg_get_trace),
        ("treasury.settle_market.queue_0", tr_settle_0_tickets),
        ("treasury.settle_market.queue_1", tr_settle_1_ticket),
        ("treasury.settle_market.queue_8", tr_settle_8_tickets),
        ("treasury.claim_withdraw.pro_rata_window", tr_drain_pro_rata_window),
        ("treasury.cancel_withdraw.markets_12", tr_cancel_12_markets),
        (
            "treasury.deposit.markets_12_tickets_8",
            tr_deposit_12_markets_8_tickets,
        ),
        ("registry.get_trace.read_only", reg_get_trace),
        (
            "registry.traces_by_market.page25.read_only",
            reg_traces_by_market_page25,
        ),
        ("registry.extend_traces.32", reg_extend_traces_32),
    ]
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const METRIC_NAMES: [&str; 7] = [
    "cpu_insns",
    "mem_bytes",
    "read_entries",
    "write_entries",
    "read_bytes",
    "write_bytes",
    "events_bytes",
];

fn metric(m: &Metrics, name: &str) -> u64 {
    match name {
        "cpu_insns" => m.cpu_insns,
        "mem_bytes" => m.mem_bytes,
        "read_entries" => m.read_entries as u64,
        "write_entries" => m.write_entries as u64,
        "read_bytes" => m.read_bytes as u64,
        "write_bytes" => m.write_bytes as u64,
        "events_bytes" => m.events_bytes as u64,
        _ => unreachable!(),
    }
}

fn tolerance(t: &Tolerance, name: &str) -> f64 {
    match name {
        "cpu_insns" => t.cpu_insns,
        "mem_bytes" => t.mem_bytes,
        "read_entries" => t.read_entries,
        "write_entries" => t.write_entries,
        "read_bytes" => t.read_bytes,
        "write_bytes" => t.write_bytes,
        "events_bytes" => t.events_bytes,
        _ => unreachable!(),
    }
}

#[derive(Debug)]
struct Diff {
    scenario: &'static str,
    metric: &'static str,
    base: u64,
    actual: u64,
    change_pct: f64,
    direction: &'static str,
}

#[test]
fn budget_baseline() {
    let update = std::env::var("BUDGET_UPDATE").as_deref() == Ok("1");
    let mut baseline = load_baseline().unwrap_or_else(Baseline::empty);
    let running_rustc = compile_time_rustc();
    let same_toolchain = baseline.meta.rustc == running_rustc;
    if !same_toolchain {
        eprintln!(
            "warning: baseline was produced with rustc {} but this run uses {}; \
             skipping CPU/memory comparison (entry and byte metrics still checked)",
            baseline.meta.rustc, running_rustc
        );
    }

    let mut diffs = Vec::new();
    for (name, run) in scenarios() {
        let actual = run();
        match baseline.scenarios.get(name) {
            Some(base) => {
                for metric_name in METRIC_NAMES {
                    if !same_toolchain && matches!(metric_name, "cpu_insns" | "mem_bytes") {
                        continue;
                    }
                    let b = metric(base, metric_name);
                    let a = metric(&actual, metric_name);
                    let tol = tolerance(&baseline.tolerance, metric_name);
                    let within = if tol == 0.0 {
                        a == b
                    } else {
                        let allowed = (b as f64 * tol).max(1.0);
                        (a as f64 - b as f64).abs() <= allowed
                    };
                    if !within {
                        let change_pct = if b == 0 {
                            0.0
                        } else {
                            (a as f64 - b as f64) / b as f64 * 100.0
                        };
                        diffs.push(Diff {
                            scenario: name,
                            metric: metric_name,
                            base: b,
                            actual: a,
                            change_pct,
                            direction: if a > b { "regression" } else { "improvement" },
                        });
                    }
                }
            }
            None if !update => {
                panic!(
                    "scenario `{name}` is missing from {}; run `make budget-update`",
                    baseline_path().display()
                );
            }
            None => {}
        }
        baseline.scenarios.insert(name.to_string(), actual);
    }

    if update {
        baseline.meta = Meta {
            soroban_sdk: "27.0.6".into(),
            rustc: running_rustc,
            stellar_cli: stellar_cli_version(),
            wasm_bytes: wasm_bytes(),
        };
        write_baseline(&baseline);
        eprintln!(
            "budget baseline updated: {} scenarios -> {}",
            baseline.scenarios.len(),
            baseline_path().display()
        );
        return;
    }

    if !diffs.is_empty() {
        eprintln!("\nresource budget diff (baseline vs actual):");
        eprintln!(
            "{:<44} {:<14} {:>12} {:>12} {:>9}  {:<11}",
            "scenario", "metric", "baseline", "actual", "delta", "kind"
        );
        for d in &diffs {
            eprintln!(
                "{:<44} {:<14} {:>12} {:>12} {:>8.2}%  {:<11}",
                d.scenario, d.metric, d.base, d.actual, d.change_pct, d.direction
            );
        }
        eprintln!(
            "\nIf the change is intentional, refresh the baseline with `make budget-update` \
             and include the diff in the PR."
        );
        panic!(
            "{} resource budget metric(s) changed beyond tolerance",
            diffs.len()
        );
    }
    eprintln!(
        "budget: {} scenarios within tolerance ({})",
        baseline.scenarios.len(),
        baseline_path().display()
    );
}

// ---------------------------------------------------------------------------
// Network limits
// ---------------------------------------------------------------------------

/// Snapshot of Stellar Mainnet invocation limits, 2026-07-10
/// (soroban-sdk 27.0.6's `InvocationResourceLimits::mainnet`).
/// Source: https://developers.stellar.org/docs/networks/resource-limits-fees
mod network {
    pub const INSTRUCTIONS: u64 = 400_000_000;
    pub const MEM_BYTES: u64 = 41_943_040;
    pub const DISK_READ_ENTRIES: u64 = 200;
    pub const WRITE_ENTRIES: u64 = 200;
    pub const LEDGER_ENTRIES: u64 = 400;
    pub const DISK_READ_BYTES: u64 = 200_000;
    pub const WRITE_BYTES: u64 = 132_096;
    pub const EVENTS_BYTES: u64 = 16_384;
    pub const MAX_DATA_ENTRY_BYTES: u64 = 65_536;
    pub const MAX_CODE_ENTRY_BYTES: u64 = 131_072;
}

#[test]
fn worst_cases_within_network_limits() {
    let mut failures = Vec::new();
    for (name, run) in scenarios() {
        let m = run();
        let checks = [
            ("cpu_insns", m.cpu_insns, network::INSTRUCTIONS),
            ("mem_bytes", m.mem_bytes, network::MEM_BYTES),
            (
                "read_entries",
                m.read_entries as u64,
                network::DISK_READ_ENTRIES,
            ),
            (
                "write_entries",
                m.write_entries as u64,
                network::WRITE_ENTRIES,
            ),
            (
                "ledger_entries",
                (m.read_entries + m.write_entries) as u64,
                network::LEDGER_ENTRIES,
            ),
            ("read_bytes", m.read_bytes as u64, network::DISK_READ_BYTES),
            ("write_bytes", m.write_bytes as u64, network::WRITE_BYTES),
            ("events_bytes", m.events_bytes as u64, network::EVENTS_BYTES),
        ];
        for (metric, actual, limit) in checks {
            if actual > limit {
                failures.push(format!("{name}: {metric}={actual} > {limit}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "scenarios exceed mainnet limits:\n  {}",
        failures.join("\n  ")
    );
}

/// The treasury scenarios that drain the queue must stay under 80% of the
/// network instruction, read-entry and write-entry limits, so the constants
/// `QUEUE_WINDOW` and `MAX_QUEUE_STEPS` leave headroom for market growth.
#[test]
fn queue_worst_cases_under_80_percent() {
    let mut failures = Vec::new();
    for (name, run) in scenarios().into_iter().filter(|(n, _)| n.starts_with("treasury.")) {
        let m = run();
        for (metric, actual, limit) in [
            ("cpu_insns", m.cpu_insns, network::INSTRUCTIONS),
            ("read_entries", m.read_entries as u64, network::DISK_READ_ENTRIES),
            ("write_entries", m.write_entries as u64, network::WRITE_ENTRIES),
            ("write_bytes", m.write_bytes as u64, network::WRITE_BYTES),
        ] {
            if actual * 100 > limit * 80 {
                failures.push(format!("{name}: {metric}={actual} > 80% of {limit}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n  "));
}
