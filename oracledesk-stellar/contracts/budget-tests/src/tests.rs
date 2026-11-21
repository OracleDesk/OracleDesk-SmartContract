use crate::{
    baseline_path, compile_time_rustc, load_baseline, market_core_wasm, measure, registry_wasm,
    stellar_cli_version, wasm_bytes, write_baseline, Baseline, Meta, Metrics, Tolerance,
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

fn registry_fixture() -> RegistryFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.ledger().set_timestamp(BASE_TS);
    env.ledger().set_sequence_number(1);
    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let contract_id = env.register(registry_wasm::WASM, (admin,));
    let client = registry_wasm::Client::new(&env, &contract_id);
    client.register_agent(&agent);
    RegistryFixture { env, client, agent }
}

fn registry_publish(fx: &RegistryFixture, action: &str, cid: &str) -> Metrics {
    let action = String::from_str(&fx.env, action);
    let cid = String::from_str(&fx.env, cid);
    let env = fx.env.clone();
    measure(&env, || {
        fx.client.publish_trace(
            &fx.agent,
            &1u64,
            &action,
            &BytesN::from_array(&env, &[9u8; 32]),
            &cid,
        )
    })
}

fn reg_publish_small() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, "buy yes", "ipfs://small")
}

fn reg_publish_cid_1k() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, "buy yes", &"c".repeat(1_024))
}

fn reg_publish_action_1k() -> Metrics {
    let fx = registry_fixture();
    registry_publish(&fx, &"a".repeat(1_024), "ipfs://cid")
}

fn reg_get_trace() -> Metrics {
    let fx = registry_fixture();
    let trace_id = fx.client.publish_trace(
        &fx.agent,
        &1u64,
        &String::from_str(&fx.env, "buy yes"),
        &BytesN::from_array(&fx.env, &[9u8; 32]),
        &String::from_str(&fx.env, "ipfs://small"),
    );
    let env = fx.env.clone();
    measure(&env, || fx.client.get_trace(&trace_id))
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
        ("registry.view.get_trace", reg_get_trace),
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
