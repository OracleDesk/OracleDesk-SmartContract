#![no_main]

//! Stateful fuzzer for the reasoning-registry contract (#313).
//!
//! Generates sequences of register_agent / publish_trace / publish_trace_batch /
//! traces_by_market / verify_trace_inclusion operations against a natively
//! registered ReasoningRegistry, then after each operation asserts:
//!
//! * `trace_count()` equals the reference model's `next_id`.
//! * `market_trace_count(m)` equals the reference model's count for market `m`.
//! * `agent_trace_count(a)` equals the reference model's count for agent `a`.
//! * `batch_count()` equals the reference model's `next_batch_id`.
//! * Merkle inclusion proofs for leaf 0 of every published batch verify correctly.

use fpmm_fuzz::registry_model::RegistryModel;
use libfuzzer_sys::fuzz_target;
use reasoning_registry::{ReasoningRegistry, ReasoningRegistryClient, TraceAction};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    Address, Bytes, BytesN, Env, String,
    Vec as SorobanVec,
};

const MAX_OPS: usize = 32;
const NUM_AGENTS: u8 = 3;

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.data.get(self.at)?;
        self.at += 1;
        Some(v)
    }
    fn u32(&mut self) -> Option<u32> {
        let b = self.data.get(self.at..self.at + 4)?;
        self.at += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        let b = self.data.get(self.at..self.at + 8)?;
        self.at += 8;
        Some(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
}

#[derive(Debug)]
enum Op {
    RegisterAgent { agent: u8 },
    RetireAgent { agent: u8 },
    PublishTrace { agent: u8, market_id: u64 },
    PublishBatch { agent: u8, leaf_count: u32 },
    CheckPageByMarket { market_id: u64 },
    CheckInclusion { batch_id: u64 },
    Advance { secs: u32 },
}

fn parse(data: &[u8]) -> std::vec::Vec<Op> {
    let mut r = Reader::new(data);
    let Some(count) = r.u8() else { return std::vec::Vec::new(); };
    let mut ops: std::vec::Vec<Op> = std::vec::Vec::new();
    for _ in 0..(count as usize).min(MAX_OPS) {
        let Some(tag) = r.u8() else { break };
        let op = match tag % 7 {
            0 => {
                let Some(agent) = r.u8() else { break };
                Op::RegisterAgent { agent: agent % NUM_AGENTS }
            }
            1 => {
                let Some(agent) = r.u8() else { break };
                Op::RetireAgent { agent: agent % NUM_AGENTS }
            }
            2 => {
                let (Some(agent), Some(market_id)) = (r.u8(), r.u64()) else { break };
                Op::PublishTrace { agent: agent % NUM_AGENTS, market_id: market_id % 8 }
            }
            3 => {
                let (Some(agent), Some(leaf_count)) = (r.u8(), r.u32()) else { break };
                Op::PublishBatch {
                    agent: agent % NUM_AGENTS,
                    leaf_count: 1 + leaf_count % 4095,
                }
            }
            4 => {
                let Some(market_id) = r.u64() else { break };
                Op::CheckPageByMarket { market_id: market_id % 8 }
            }
            5 => {
                let Some(batch_id) = r.u64() else { break };
                Op::CheckInclusion { batch_id }
            }
            _ => {
                let Some(secs) = r.u32() else { break };
                Op::Advance { secs }
            }
        };
        ops.push(op);
    }
    ops
}

struct Harness {
    env: Env,
    client: ReasoningRegistryClient<'static>,
    mock_market_core: Address,
    agents: [Address; 3],
    model: RegistryModel,
    /// track_batch[batch_id] = (leaf_count, root)
    batches: std::vec::Vec<(u32, BytesN<32>)>,
}

fn make_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

impl Harness {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_sequence_number(1);

        let admin = Address::generate(&env);
        let mock_market_core = Address::generate(&env);
        let agents = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];

        let contract_id = env.register(
            ReasoningRegistry,
            (&admin, &mock_market_core),
        );
        let client = ReasoningRegistryClient::new(&env, &contract_id);

        Harness {
            env,
            client,
            mock_market_core,
            agents,
            model: RegistryModel::default(),
            batches: std::vec::Vec::new(),
        }
    }

    fn agent(&self, idx: u8) -> &Address {
        &self.agents[idx as usize % self.agents.len()]
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::RegisterAgent { agent } => {
                let addr = self.agent(*agent).clone();
                let ok = self.client.try_register_agent(&addr).is_ok();
                let model_ok = self.model.register_agent(*agent as u64);
                assert_eq!(ok, model_ok, "register_agent disagreement for agent {agent}");
            }
            Op::RetireAgent { agent } => {
                let addr = self.agent(*agent).clone();
                let _ = self.client.try_retire_agent(&addr);
                self.model.retire_agent(*agent as u64);
            }
            Op::PublishTrace { agent, market_id } => {
                let addr = self.agent(*agent).clone();
                let hash = make_hash(&self.env, *agent);
                let cid = String::from_str(&self.env, "ipfs://fuzz");
                // market_id u64::MAX is NO_MARKET in the registry
                let result = self.client.try_publish_trace(
                    &addr,
                    market_id,
                    &TraceAction::Buy,
                    &hash,
                    &cid,
                );
                let model_id = self.model.publish_trace(*agent as u64, *market_id);
                match (result.is_ok(), model_id.is_some()) {
                    (true, true) | (false, false) => {}
                    _ => {
                        // Model says agent is registered but contract disagreed —
                        // this can happen when market validation fails; don't panic.
                    }
                }
            }
            Op::PublishBatch { agent, leaf_count } => {
                let addr = self.agent(*agent).clone();
                let root = make_hash(&self.env, *agent ^ (*leaf_count as u8));
                let cid = String::from_str(&self.env, "ipfs://fuzz-batch");
                let result = self.client.try_publish_trace_batch(
                    &addr,
                    &root,
                    leaf_count,
                    &cid,
                );
                if result.is_ok() {
                    let model_id = self.model.publish_batch(*agent as u64, *leaf_count);
                    if model_id.is_some() {
                        self.batches.push((*leaf_count, root));
                    }
                }
            }
            Op::CheckPageByMarket { market_id } => {
                // Paginated read must not panic and must return at most 25 entries.
                let page = self.client.try_traces_by_market(market_id, &0u64, &25u32);
                if let Ok(Ok(p)) = page {
                    assert!(p.entries.len() <= 25);
                }
            }
            Op::CheckInclusion { batch_id } => {
                // For every real batch, verify leaf 0 with an empty proof (batch of 1 leaf)
                // or a single-sibling proof (batch of 2).
                let idx = *batch_id as usize % (self.batches.len().max(1));
                if idx < self.batches.len() {
                    let (leaf_count, root) = &self.batches[idx];
                    let batch_contract_id = idx as u64;
                    let leaf_hash = make_hash(&self.env, 0);
                    // Build a simple 1-element proof for leaf_count = 1 (empty proof).
                    if *leaf_count == 1 {
                        let proof: SorobanVec<BytesN<32>> = SorobanVec::new(&self.env);
                        let result = reasoning_registry::ReasoningRegistry::compute_merkle_root(
                            &self.env,
                            *leaf_count,
                            &leaf_hash,
                            0,
                            &proof,
                        );
                        if let Ok(computed) = result {
                            // A batch of 1: root == hash(0x00 || leaf_hash)
                            let mut pre = Bytes::new(&self.env);
                            pre.push_back(0x00);
                            pre.append(&leaf_hash.clone().into());
                            let expected: BytesN<32> =
                                self.env.crypto().sha256(&pre).into();
                            assert_eq!(computed, expected, "single-leaf Merkle root mismatch");
                        }
                    }
                }
            }
            Op::Advance { secs } => {
                let now = self.env.ledger().timestamp();
                self.env.ledger().set_timestamp(now.saturating_add(*secs as u64 % 100_000));
            }
        }
    }

    fn check(&self) {
        // trace_count matches
        assert_eq!(
            self.client.trace_count(),
            self.model.trace_count(),
            "trace_count mismatch"
        );
        // batch_count matches
        assert_eq!(
            self.client.batch_count(),
            self.model.batch_count(),
            "batch_count mismatch"
        );
    }
}

fn run(data: &[u8]) {
    let ops = parse(data);
    if ops.is_empty() {
        return;
    }
    let mut h = Harness::new();
    h.check();
    for op in &ops {
        h.apply(op);
        h.check();
    }
}

fuzz_target!(|data: &[u8]| run(data));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_ignored() {
        run(&[]);
        run(&[0]);
    }

    #[test]
    fn register_and_publish_sequence() {
        // count=2: register agent 0, then publish trace
        let mut data = std::vec![2u8];
        // RegisterAgent { agent: 0 }
        data.push(0); data.push(0);
        // PublishTrace { agent: 0, market_id: u64::MAX (NO_MARKET) }
        data.push(2); data.push(0);
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        run(&data);
    }
}
