//! Plain-Rust reference model for the governance timelock (#319).
//!
//! Tracks pending operations and enforces the delay/expiry rules so the
//! fuzzer can compare the contract's output to an independent implementation.

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct PendingOp {
    pub target_idx: u8,
    pub eta: u64,
    pub expires: u64,
}

#[derive(Clone, Debug)]
pub struct TimelockModel {
    pub next_id: u64,
    pub default_delay: u64,
    pub ops: HashMap<u64, PendingOp>,
    pub now: u64,
}

impl TimelockModel {
    pub fn new(default_delay: u64, now: u64) -> Self {
        Self {
            next_id: 0,
            default_delay,
            ops: HashMap::new(),
            now,
        }
    }

    pub fn advance(&mut self, secs: u32) {
        self.now = self.now.saturating_add(secs as u64);
    }

    /// Returns the new op id on success (always succeeds if proposer is correct).
    pub fn schedule(&mut self, target_idx: u8, override_delay: Option<u64>) -> u64 {
        let delay = override_delay.unwrap_or(self.default_delay).max(self.default_delay);
        let eta = self.now.saturating_add(delay);
        let expires = eta.saturating_add(7 * 86_400);
        let id = self.next_id;
        self.next_id += 1;
        self.ops.insert(id, PendingOp { target_idx, eta, expires });
        id
    }

    pub fn execute(&mut self, id: u64) -> ExecuteResult {
        let op = match self.ops.get(&id) {
            Some(op) => op.clone(),
            None => return ExecuteResult::NotFound,
        };
        if self.now < op.eta {
            return ExecuteResult::NotReady;
        }
        if self.now > op.expires {
            self.ops.remove(&id);
            return ExecuteResult::Expired;
        }
        self.ops.remove(&id);
        ExecuteResult::Ok
    }

    pub fn cancel(&mut self, id: u64) -> bool {
        self.ops.remove(&id).is_some()
    }

    pub fn operation_count(&self) -> u64 {
        self.next_id
    }

    pub fn has_op(&self, id: u64) -> bool {
        self.ops.contains_key(&id)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum ExecuteResult {
    Ok,
    NotFound,
    NotReady,
    Expired,
}
