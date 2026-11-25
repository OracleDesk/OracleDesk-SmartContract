//! Stateful system-model harness: random operation sequences are executed
//! against the real wasm contracts and replayed by `model/system_model.py`.
//!
//! The model and the contracts must agree on two things after every step:
//!
//! * whether the step succeeded, and
//! * the exact snapshot (market reserves, positions, token balances, resolver
//!   state, registry counters).
//!
//! Whenever they disagree the contract is treated as the source of truth and
//! the test fails; proptest then shrinks the sequence to a minimal
//! counterexample. The committed traces under `model/regressions/` pin the
//! cases that have failed at least once, and `make model-test` runs both the
//! Python self-test and this harness.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use integration_tests::world::{World, MARKET_CLOSE, USDC};
use integration_tests::{market_core, reasoning_registry::TraceAction, resolver};
use market_core::Outcome as CoreOutcome;
use proptest::prelude::*;
use resolver::AttestedOutcome;
use resolver_contract as resolver_native;
use serde::{Deserialize, Serialize};
use soroban_sdk::{
    testutils::{MockAuth, MockAuthInvoke},
    Address, BytesN, IntoVal, String,
};

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActorName {
    Creator,
    Trader,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OutcomeName {
    Yes,
    No,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Op {
    Create {
        time: u64,
        close_time: u64,
        yes_bps: u32,
    },
    Buy {
        time: u64,
        actor: ActorName,
        outcome: OutcomeName,
        amount: i64,
    },
    Sell {
        time: u64,
        actor: ActorName,
        outcome: OutcomeName,
        collateral_out: i64,
    },
    TreasuryBuy {
        time: u64,
        outcome: OutcomeName,
        amount: i64,
    },
    Resolve {
        time: u64,
        outcome: OutcomeName,
    },
    Redeem {
        time: u64,
        actor: ActorName,
    },
    ClaimRemainder {
        time: u64,
    },
    SweepFees {
        time: u64,
    },
    PublishTrace {
        time: u64,
    },
    AdvanceTime {
        time: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TraceFile {
    schema_version: u32,
    steps: Vec<Op>,
    #[serde(default)]
    snapshots: Option<Vec<serde_json::Value>>,
}

fn actor_address(w: &World, actor: &ActorName) -> Address {
    match actor {
        ActorName::Creator => w.creator.clone(),
        ActorName::Trader => w.trader.clone(),
    }
}

fn core_outcome(outcome: &OutcomeName) -> CoreOutcome {
    match outcome {
        OutcomeName::Yes => CoreOutcome::Yes,
        OutcomeName::No => CoreOutcome::No,
    }
}

fn attested_outcome(outcome: &OutcomeName) -> AttestedOutcome {
    match outcome {
        OutcomeName::Yes => AttestedOutcome::Yes,
        OutcomeName::No => AttestedOutcome::No,
    }
}

fn treasury_outcome(outcome: &OutcomeName) -> integration_tests::treasury::Outcome {
    match outcome {
        OutcomeName::Yes => integration_tests::treasury::Outcome::Yes,
        OutcomeName::No => integration_tests::treasury::Outcome::No,
    }
}

/// Executes an op sequence against the wasm contracts, returning the per-step
/// success flags and snapshots in the same shape as `system_model.py`.
struct Harness {
    w: World,
    market: Option<u64>,
    close_time: u64,
}

impl Harness {
    fn new() -> Self {
        let w = World::new();
        // The registry requires a registered agent before publish_trace.
        w.env.set_auths(&[]);
        let args = (w.agent.clone(),).into_val(&w.env);
        w.registry
            .mock_auths(&[MockAuth {
                address: &w.admin,
                invoke: &MockAuthInvoke {
                    contract: &w.registry_id,
                    fn_name: "register_agent",
                    args,
                    sub_invokes: &[],
                },
            }])
            .register_agent(&w.agent);
        w.env.set_auths(&[]);
        Self {
            w,
            market: None,
            close_time: 0,
        }
    }

    fn execute(&mut self, step: &Op) -> bool {
        match step {
            Op::Create {
                time,
                close_time,
                yes_bps,
            } => self.create(*time, *close_time, *yes_bps),
            Op::Buy {
                time,
                actor,
                outcome,
                amount,
            } => self.buy(*time, actor, outcome, *amount as i128),
            Op::Sell {
                time,
                actor,
                outcome,
                collateral_out,
            } => self.sell(*time, actor, outcome, *collateral_out as i128),
            Op::TreasuryBuy {
                time,
                outcome,
                amount,
            } => self.treasury_buy(*time, outcome, *amount as i128),
            Op::Resolve { time, outcome } => self.resolve(*time, outcome),
            Op::Redeem { time, actor } => self.redeem(*time, actor),
            Op::ClaimRemainder { time } => self.claim_remainder(*time),
            Op::SweepFees { time } => self.sweep_fees(*time),
            Op::PublishTrace { time } => self.publish_trace(*time),
            Op::AdvanceTime { time } => {
                self.w.set_time(*time);
                true
            }
        }
    }

    fn create(&mut self, time: u64, close_time: u64, yes_bps: u32) -> bool {
        if self.market.is_some() {
            return false;
        }
        self.w.set_time(time);
        if close_time <= time || !(100..=9_900).contains(&yes_bps) {
            return false;
        }
        let (native_spec, import_spec) =
            signer_spec(&self.w.env, &self.w.signer_a, &self.w.signer_b);
        let hash = resolver_native::legacy_spec_hash(
            &self.w.env,
            &resolver_native::ResolutionSpec::Signers(native_spec),
        );
        let id = self.w.create_market_with_hash(hash, close_time, yes_bps);
        self.w.env.set_auths(&[]);
        self.w.resolver.register_signer_spec(&id, &import_spec);
        self.w.env.set_auths(&[]);
        self.market = Some(id);
        self.close_time = close_time;
        true
    }

    fn buy(&mut self, time: u64, actor: &ActorName, outcome: &OutcomeName, amount: i128) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let from = actor_address(&self.w, actor);
        let core_outcome = core_outcome(outcome);
        let args = (from.clone(), id, core_outcome.clone(), amount, 0i128).into_val(&self.w.env);
        let transfer = MockAuthInvoke {
            contract: &self.w.collateral,
            fn_name: "transfer",
            args: (from.clone(), self.w.core_id.clone(), amount).into_val(&self.w.env),
            sub_invokes: &[],
        };
        self.w.env.set_auths(&[]);
        self.w
            .core
            .mock_auths(&[MockAuth {
                address: &from,
                invoke: &MockAuthInvoke {
                    contract: &self.w.core_id,
                    fn_name: "buy",
                    args,
                    sub_invokes: &[transfer],
                },
            }])
            .try_buy(&from, &id, &core_outcome, &amount, &0i128)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn sell(
        &mut self,
        time: u64,
        actor: &ActorName,
        outcome: &OutcomeName,
        collateral_out: i128,
    ) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let from = actor_address(&self.w, actor);
        let core_outcome = core_outcome(outcome);
        let args = (
            from.clone(),
            id,
            core_outcome.clone(),
            collateral_out,
            i128::MAX,
        )
            .into_val(&self.w.env);
        self.w.env.set_auths(&[]);
        self.w
            .core
            .mock_auths(&[MockAuth {
                address: &from,
                invoke: &MockAuthInvoke {
                    contract: &self.w.core_id,
                    fn_name: "sell",
                    args,
                    sub_invokes: &[],
                },
            }])
            .try_sell(&from, &id, &core_outcome, &collateral_out, &i128::MAX)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn treasury_buy(&mut self, time: u64, outcome: &OutcomeName, amount: i128) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let core_outcome = treasury_outcome(outcome);
        let args = (
            self.w.agent.clone(),
            id,
            core_outcome.clone(),
            amount,
            0i128,
        )
            .into_val(&self.w.env);
        self.w.env.set_auths(&[]);
        self.w
            .treasury
            .mock_auths(&[MockAuth {
                address: &self.w.agent,
                invoke: &MockAuthInvoke {
                    contract: &self.w.treasury_id,
                    fn_name: "agent_buy",
                    args,
                    sub_invokes: &[],
                },
            }])
            .try_agent_buy(&self.w.agent, &id, &core_outcome, &amount, &0i128)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn resolve(&mut self, time: u64, outcome: &OutcomeName) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        if time < self.close_time {
            return false;
        }
        self.w.set_time(time);
        let core_outcome = attested_outcome(outcome);
        for signer in [&self.w.signer_a, &self.w.signer_b] {
            self.w.env.set_auths(&[]);
            let args = (id, signer.clone(), core_outcome.clone()).into_val(&self.w.env);
            let result = self
                .w
                .resolver
                .mock_auths(&[MockAuth {
                    address: signer,
                    invoke: &MockAuthInvoke {
                        contract: &self.w.resolver_id,
                        fn_name: "attest",
                        args,
                        sub_invokes: &[],
                    },
                }])
                .try_attest(&id, signer, &core_outcome);
            if !matches!(result, Ok(Ok(()))) {
                return false;
            }
        }
        self.w.env.set_auths(&[]);
        // The signer spec's dispute window is the protocol minimum, so
        // finalize runs that many ledger seconds after the attestations land.
        self.w.set_time(time + 60);
        self.w
            .resolver
            .try_finalize_signers(&id)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn redeem(&mut self, time: u64, actor: &ActorName) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let who = actor_address(&self.w, actor);
        let args = (who.clone(), id).into_val(&self.w.env);
        self.w.env.set_auths(&[]);
        self.w
            .core
            .mock_auths(&[MockAuth {
                address: &who,
                invoke: &MockAuthInvoke {
                    contract: &self.w.core_id,
                    fn_name: "redeem",
                    args,
                    sub_invokes: &[],
                },
            }])
            .try_redeem(&who, &id)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn claim_remainder(&mut self, time: u64) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let args = (id,).into_val(&self.w.env);
        self.w.env.set_auths(&[]);
        self.w
            .core
            .mock_auths(&[MockAuth {
                address: &self.w.creator,
                invoke: &MockAuthInvoke {
                    contract: &self.w.core_id,
                    fn_name: "claim_pool_remainder",
                    args,
                    sub_invokes: &[],
                },
            }])
            .try_claim_pool_remainder(&id)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn sweep_fees(&mut self, time: u64) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        self.w.env.set_auths(&[]);
        self.w
            .core
            .try_sweep_fees(&id)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn publish_trace(&mut self, time: u64) -> bool {
        let Some(id) = self.market else {
            return false;
        };
        self.w.set_time(time);
        let action = TraceAction::Buy;
        let hash = BytesN::from_array(&self.w.env, &[3u8; 32]);
        let cid = String::from_str(&self.w.env, "ipfs://model");
        let args = (
            self.w.agent.clone(),
            id,
            action.clone(),
            hash.clone(),
            cid.clone(),
        )
            .into_val(&self.w.env);
        self.w.env.set_auths(&[]);
        self.w
            .registry
            .mock_auths(&[MockAuth {
                address: &self.w.agent,
                invoke: &MockAuthInvoke {
                    contract: &self.w.registry_id,
                    fn_name: "publish_trace",
                    args,
                    sub_invokes: &[],
                },
            }])
            .try_publish_trace(&self.w.agent, &id, &action, &hash, &cid)
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    fn snapshot(&self) -> serde_json::Value {
        use serde_json::json;
        let market = self.market.map(|id| {
            let m = self.w.core.get_market(&id);
            let status = match m.status {
                market_core::MarketStatus::Open => "open",
                market_core::MarketStatus::Resolved(CoreOutcome::Yes) => "resolved_yes",
                market_core::MarketStatus::Resolved(CoreOutcome::No) => "resolved_no",
                market_core::MarketStatus::ResolvedScalar(_) => "resolved_scalar",
                market_core::MarketStatus::Void => "void",
            };
            json!({
                "reserve_yes": m.reserve_yes as i64,
                "reserve_no": m.reserve_no as i64,
                "sets_minted": m.sets_minted as i64,
                "fees_accrued": m.fees_accrued as i64,
                "lp_claimed": m.lp_claimed,
                "status": status,
            })
        });
        let position = |who: &Address| {
            let p = self
                .market
                .map(|id| self.w.core.get_position(&id, who))
                .unwrap_or(market_core::Position { yes: 0, no: 0 });
            json!({"yes": p.yes as i64, "no": p.no as i64})
        };
        let resolver_state = self
            .market
            .map(|id| match self.w.resolver.state(&id) {
                resolver::ResolutionState::Unconfigured => "Unconfigured",
                resolver::ResolutionState::SignersPending => "SignersPending",
                resolver::ResolutionState::Finalized => "Finalized",
                resolver::ResolutionState::Expired => "Expired",
                resolver::ResolutionState::Disputed => "Dispute",
                _ => "Other",
            })
            .unwrap_or("Unconfigured");
        let balance = |who: &Address| self.w.token.balance(who) as i64;
        json!({
            "market": market,
            "positions": {
                "creator": position(&self.w.creator),
                "trader": position(&self.w.trader),
                "treasury": position(&self.w.treasury_id),
            },
            "balances": {
                "creator": balance(&self.w.creator),
                "trader": balance(&self.w.trader),
                "treasury": balance(&self.w.treasury_id),
                "core": balance(&self.w.core_id),
            },
            "resolver_state": resolver_state,
            "trace_count": self.w.registry.trace_count() as i64,
            "market_trace_count": self
                .market
                .map(|id| self.w.registry.market_trace_count(&id) as i64)
                .unwrap_or(0),
        })
    }
}

fn signer_spec(
    env: &soroban_sdk::Env,
    a: &Address,
    b: &Address,
) -> (resolver_native::SignerConfig, resolver::SignerConfig) {
    let native = resolver_native::SignerConfig {
        signers: soroban_sdk::Vec::from_array(env, [a.clone(), b.clone()]),
        threshold: 2,
        // The protocol floor (`bounds::MIN_WINDOW_SECS`); the model finalizes
        // inside `resolve`, so the harness waits exactly this long before
        // calling `finalize_signers`.
        dispute_window: 60,
    };
    let imported = resolver::SignerConfig {
        signers: native.signers.clone(),
        threshold: native.threshold,
        dispute_window: native.dispute_window,
    };
    (native, imported)
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate lives under <repo>/contracts")
        .to_path_buf()
}

fn run_model(trace: &TraceFile, label: &str) -> serde_json::Value {
    let root = repo_root();
    let out_dir = root.join("target/system-model");
    fs::create_dir_all(&out_dir).expect("create trace dir");
    let trace_path = out_dir.join(format!("{label}.trace.json"));
    fs::write(
        &trace_path,
        serde_json::to_vec_pretty(trace).expect("serialize trace"),
    )
    .expect("write trace");
    let output = Command::new("python3")
        .arg(root.join("model/system_model.py"))
        .arg("--replay")
        .arg(&trace_path)
        .current_dir(root.join("model"))
        .output()
        .expect("run python3 model/system_model.py");
    if !output.status.success() {
        panic!(
            "model replay failed for {label}: {}\n{}",
            output.status,
            std::string::String::from_utf8_lossy(&output.stderr)
        );
    }
    serde_json::from_slice(&output.stdout).expect("model output must be JSON")
}

/// Runs `steps` against wasm and Python, then asserts they agree. Returns the
/// snapshot list (the contract side) for regression pinning.
fn run_and_compare(steps: Vec<Op>, label: &str) -> Vec<serde_json::Value> {
    let mut harness = Harness::new();
    let mut oks = Vec::new();
    let mut snapshots = Vec::new();
    for step in &steps {
        let ok = harness.execute(step);
        oks.push(ok);
        snapshots.push(harness.snapshot());
    }
    let trace = TraceFile {
        schema_version: SCHEMA_VERSION,
        steps,
        snapshots: None,
    };
    let model = run_model(&trace, label);

    let model_steps = model
        .get("steps")
        .and_then(|v| v.as_array())
        .expect("model steps");
    assert_eq!(model_steps.len(), oks.len(), "{label}: step count");
    for (i, (model_step, ok)) in model_steps.iter().zip(oks.iter()).enumerate() {
        assert_eq!(
            model_step.get("ok").and_then(|v| v.as_bool()),
            Some(*ok),
            "{label}: step {i} success mismatch: {:?}",
            trace.steps[i]
        );
    }
    let model_snapshots = model
        .get("snapshots")
        .and_then(|v| v.as_array())
        .expect("model snapshots");
    assert_eq!(
        model_snapshots.len(),
        snapshots.len(),
        "{label}: snapshot count"
    );
    for (i, (model_snap, wasm_snap)) in model_snapshots.iter().zip(snapshots.iter()).enumerate() {
        assert_eq!(
            model_snap,
            wasm_snap,
            "{label}: snapshot {i} mismatch\nmodel: {}\nwasm:  {}",
            serde_json::to_string_pretty(model_snap).unwrap(),
            serde_json::to_string_pretty(wasm_snap).unwrap()
        );
    }
    snapshots
}

// ----- generator ------------------------------------------------------------

fn time_strategy() -> impl Strategy<Value = u64> {
    1_000u64..5_000
}

fn actor_strategy() -> impl Strategy<Value = ActorName> {
    prop_oneof![Just(ActorName::Creator), Just(ActorName::Trader)]
}

fn outcome_strategy() -> impl Strategy<Value = OutcomeName> {
    prop_oneof![Just(OutcomeName::Yes), Just(OutcomeName::No)]
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        (1u32..=30).prop_flat_map(|n| {
            (time_strategy(), actor_strategy(), outcome_strategy()).prop_map(
                move |(time, actor, outcome)| Op::Buy {
                    time,
                    actor,
                    outcome,
                    amount: n as i64 * USDC as i64,
                },
            )
        }),
        (1u32..=30).prop_flat_map(|n| {
            (time_strategy(), actor_strategy(), outcome_strategy()).prop_map(
                move |(time, actor, outcome)| Op::Sell {
                    time,
                    actor,
                    outcome,
                    collateral_out: n as i64 * USDC as i64,
                },
            )
        }),
        (1u32..=30).prop_flat_map(|n| {
            (time_strategy(), outcome_strategy()).prop_map(move |(time, outcome)| Op::TreasuryBuy {
                time,
                outcome,
                amount: n as i64 * USDC as i64,
            })
        }),
        (time_strategy(), outcome_strategy())
            .prop_map(|(time, outcome)| Op::Resolve { time, outcome }),
        (time_strategy(), actor_strategy()).prop_map(|(time, actor)| Op::Redeem { time, actor }),
        time_strategy().prop_map(|time| Op::ClaimRemainder { time }),
        time_strategy().prop_map(|time| Op::SweepFees { time }),
        time_strategy().prop_map(|time| Op::PublishTrace { time }),
        time_strategy().prop_map(|time| Op::AdvanceTime { time }),
    ]
}

fn sequence_strategy() -> impl Strategy<Value = Vec<Op>> {
    (100u32..=9_900, prop::collection::vec(op_strategy(), 0..20)).prop_map(|(yes_bps, rest)| {
        let mut steps = vec![Op::Create {
            time: 1_000,
            close_time: MARKET_CLOSE,
            yes_bps,
        }];
        steps.extend(rest);
        steps
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 12, max_shrink_iters: 4096, .. ProptestConfig::default() })]
    #[test]
    fn random_sequences_match_python_model(steps in sequence_strategy()) {
        run_and_compare(steps, "proptest");
    }
}

#[test]
fn committed_regressions_match() {
    let dir = repo_root().join("model/regressions");
    let mut found = 0usize;
    for entry in fs::read_dir(&dir).expect("model/regressions must exist") {
        let path = entry.expect("read dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let trace: TraceFile = serde_json::from_slice(&fs::read(&path).expect("read regression"))
            .expect("regression trace must parse");
        let label = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("regression");
        let snapshots = run_and_compare(trace.steps, label);
        if let Some(expected) = trace.snapshots {
            assert_eq!(
                expected, snapshots,
                "{label}: committed snapshots drifted from the contracts"
            );
        }
        found += 1;
    }
    assert!(
        found > 0,
        "no regression traces committed under model/regressions"
    );
}

#[test]
fn model_selftest_runs() {
    let root = repo_root();
    let output = Command::new("python3")
        .arg(root.join("model/system_model.py"))
        .arg("--selftest")
        .current_dir(root.join("model"))
        .output()
        .expect("run python model selftest");
    assert!(
        output.status.success(),
        "model selftest failed: {}",
        std::string::String::from_utf8_lossy(&output.stderr)
    );
}
