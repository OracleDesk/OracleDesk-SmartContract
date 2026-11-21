//! Plain-Rust reference model for the reasoning-registry (#313).
//!
//! Every state transition mirrors the contract's rules, but is implemented
//! without Soroban SDK types so the fuzzer can compare them cheaply.

use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct RegistryModel {
    pub next_id: u64,
    pub next_batch_id: u64,
    pub agents: HashSet<u64>,   // agent index (0..NUM_AGENTS)
    pub traces: Vec<TraceEntry>,
    /// market_id → list of trace indices
    pub market_traces: HashMap<u64, Vec<u64>>,
    /// agent_idx → list of trace indices
    pub agent_traces: HashMap<u64, Vec<u64>>,
    /// batch_id → (agent_idx, leaf_count)
    pub batches: HashMap<u64, (u64, u32)>,
    /// agent_idx → batch count
    pub agent_batches: HashMap<u64, u64>,
}

#[derive(Clone, Debug)]
pub struct TraceEntry {
    pub id: u64,
    pub agent_idx: u64,
    pub market_id: u64,
}

impl RegistryModel {
    pub fn register_agent(&mut self, agent_idx: u64) -> bool {
        if self.agents.contains(&agent_idx) {
            return false;
        }
        self.agents.insert(agent_idx);
        true
    }

    pub fn retire_agent(&mut self, agent_idx: u64) -> bool {
        self.agents.remove(&agent_idx)
    }

    /// Returns the new trace id on success.
    pub fn publish_trace(&mut self, agent_idx: u64, market_id: u64) -> Option<u64> {
        if !self.agents.contains(&agent_idx) {
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let entry = TraceEntry { id, agent_idx, market_id };
        self.market_traces.entry(market_id).or_default().push(id);
        self.agent_traces.entry(agent_idx).or_default().push(id);
        self.traces.push(entry);
        Some(id)
    }

    /// Returns the new batch id on success.
    pub fn publish_batch(&mut self, agent_idx: u64, leaf_count: u32) -> Option<u64> {
        if !self.agents.contains(&agent_idx) || leaf_count == 0 || leaf_count > 4096 {
            return None;
        }
        let id = self.next_batch_id;
        self.next_batch_id += 1;
        self.batches.insert(id, (agent_idx, leaf_count));
        *self.agent_batches.entry(agent_idx).or_insert(0) += 1;
        Some(id)
    }

    pub fn trace_count(&self) -> u64 {
        self.next_id
    }

    pub fn market_trace_count(&self, market_id: u64) -> u64 {
        self.market_traces.get(&market_id).map_or(0, |v| v.len() as u64)
    }

    pub fn agent_trace_count(&self, agent_idx: u64) -> u64 {
        self.agent_traces.get(&agent_idx).map_or(0, |v| v.len() as u64)
    }

    pub fn batch_count(&self) -> u64 {
        self.next_batch_id
    }

    pub fn agent_batch_count(&self, agent_idx: u64) -> u64 {
        self.agent_batches.get(&agent_idx).copied().unwrap_or(0)
    }
}
