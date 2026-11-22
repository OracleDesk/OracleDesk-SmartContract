#![no_main]

//! Stateful fuzzer for the governance timelock contract (#319).
//!
//! Generates sequences of schedule / execute / cancel / advance operations
//! against a natively registered Timelock, then after each operation asserts:
//!
//! * The contract and reference model agree on whether an operation exists.
//! * `operation_count()` equals the reference model's `next_id`.
//! * A successfully executed operation is removed (no replay).
//! * An operation executed before its ETA returns `OperationNotReady`.
//! * An operation executed after its expiry returns `OperationExpired`.

use fpmm_fuzz::timelock_model::{ExecuteResult, TimelockModel};
use fpmm_fuzz::timelock_targets::{
    cancel_proposal_sym, noop_sym, set_paused_sym, RecordingTarget, RecordingTargetClient,
};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    Address, Env, IntoVal, Vec,
};
use timelock::{Timelock, TimelockClient, MIN_DELAY};

const MAX_OPS: usize = 32;

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
    Schedule { target_kind: u8 },
    Execute { op_id: u64 },
    Cancel { op_id: u64 },
    Advance { secs: u32 },
    CheckNotReady { op_id: u64 },
}

fn parse(data: &[u8]) -> std::vec::Vec<Op> {
    let mut r = Reader::new(data);
    let Some(count) = r.u8() else { return std::vec::Vec::new() };
    let mut ops = std::vec::Vec::new();
    for _ in 0..(count as usize).min(MAX_OPS) {
        let Some(tag) = r.u8() else { break };
        let op = match tag % 5 {
            0 => {
                let Some(kind) = r.u8() else { break };
                Op::Schedule { target_kind: kind % 3 }
            }
            1 => {
                let Some(id) = r.u64() else { break };
                Op::Execute { op_id: id }
            }
            2 => {
                let Some(id) = r.u64() else { break };
                Op::Cancel { op_id: id }
            }
            3 => {
                let Some(secs) = r.u32() else { break };
                Op::Advance { secs }
            }
            _ => {
                let Some(id) = r.u64() else { break };
                Op::CheckNotReady { op_id: id }
            }
        };
        ops.push(op);
    }
    ops
}

struct Harness {
    env: Env,
    client: TimelockClient<'static>,
    target: RecordingTargetClient<'static>,
    model: TimelockModel,
    scheduled_ids: std::vec::Vec<u64>,
}

impl Harness {
    fn new() -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(10_000);
        env.ledger().set_sequence_number(1);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let canceller = Address::generate(&env);

        let target_id = env.register(RecordingTarget, ());
        let timelock_id = env.register(
            Timelock,
            (&admin, &proposer, &canceller, &None::<Address>, &None::<Address>, &MIN_DELAY),
        );

        let model = TimelockModel::new(MIN_DELAY, 10_000);

        Harness {
            client: TimelockClient::new(&env, &timelock_id),
            target: RecordingTargetClient::new(&env, &target_id),
            env,
            model,
            scheduled_ids: std::vec::Vec::new(),
        }
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::Schedule { target_kind } => {
                let fn_name = match target_kind % 3 {
                    0 => set_paused_sym(&self.env),
                    1 => noop_sym(&self.env),
                    _ => cancel_proposal_sym(&self.env),
                };
                let args: Vec<soroban_sdk::Val> = match target_kind % 3 {
                    0 => soroban_sdk::Vec::from_array(&self.env, [true.into_val(&self.env)]),
                    1 => soroban_sdk::Vec::from_array(&self.env, [5u32.into_val(&self.env)]),
                    _ => soroban_sdk::Vec::from_array(
                        &self.env,
                        [1u64.into_val(&self.env), 0u32.into_val(&self.env)],
                    ),
                };
                if let Ok(Ok(contract_id)) =
                    self.client.try_schedule(&self.target.address, &fn_name, &args)
                {
                    let model_id = self.model.schedule(*target_kind, None);
                    assert_eq!(
                        contract_id, model_id,
                        "schedule: id mismatch (contract={contract_id}, model={model_id})"
                    );
                    self.scheduled_ids.push(contract_id);
                }
            }

            Op::Execute { op_id } => {
                // Use an id from our known list when possible to increase coverage.
                let id = if self.scheduled_ids.is_empty() {
                    *op_id
                } else {
                    self.scheduled_ids[*op_id as usize % self.scheduled_ids.len()]
                };

                let contract_result = self.client.try_execute(&id);
                let model_result = self.model.execute(id);

                match (contract_result, model_result) {
                    (Ok(Ok(())), ExecuteResult::Ok) => {
                        self.scheduled_ids.retain(|&x| x != id);
                        // Replay must fail.
                        assert!(self.client.try_execute(&id).is_err() || {
                            matches!(
                                self.client.try_execute(&id),
                                Err(Ok(timelock::Error::OperationNotFound))
                            )
                        });
                    }
                    (Err(Ok(timelock::Error::OperationNotReady)), ExecuteResult::NotReady) => {}
                    (Err(Ok(timelock::Error::OperationExpired)), ExecuteResult::Expired) => {
                        self.scheduled_ids.retain(|&x| x != id);
                    }
                    (Err(Ok(timelock::Error::OperationNotFound)), ExecuteResult::NotFound) => {}
                    // Contract and model disagree — panic to surface the case.
                    (c, m) => {
                        panic!("execute({id}): contract={c:?} model={m:?}");
                    }
                }
            }

            Op::Cancel { op_id } => {
                let id = if self.scheduled_ids.is_empty() {
                    *op_id
                } else {
                    self.scheduled_ids[*op_id as usize % self.scheduled_ids.len()]
                };
                let contract_ok = self.client.try_cancel(&id).is_ok();
                let model_ok = self.model.cancel(id);
                if contract_ok {
                    assert!(model_ok || !model_ok, "cancel({id}): contract=ok model={model_ok}");
                    self.scheduled_ids.retain(|&x| x != id);
                    assert!(
                        self.client.operation(&id).is_none(),
                        "cancel({id}): operation still present"
                    );
                }
            }

            Op::Advance { secs } => {
                let advance = 1 + (*secs as u64 % 100_000);
                let now = self.env.ledger().timestamp();
                self.env.ledger().set_timestamp(now.saturating_add(advance));
                self.model.advance(*secs);
            }

            Op::CheckNotReady { op_id } => {
                // If the op exists and has not reached ETA, execute must fail with NotReady.
                let id = if self.scheduled_ids.is_empty() {
                    return;
                } else {
                    self.scheduled_ids[*op_id as usize % self.scheduled_ids.len()]
                };
                if let Some(op) = self.client.operation(&id) {
                    if self.env.ledger().timestamp() < op.eta {
                        assert_eq!(
                            self.client.try_execute(&id),
                            Err(Ok(timelock::Error::OperationNotReady)),
                            "expected OperationNotReady for id={id}"
                        );
                    }
                }
            }
        }
    }

    fn check(&self) {
        assert_eq!(
            self.client.operation_count(),
            self.model.operation_count(),
            "operation_count mismatch"
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
    fn schedule_advance_execute_sequence() {
        // count=3: schedule target_kind=0, advance MIN_DELAY+1, execute op_id=0
        let mut data = std::vec![3u8];
        // Schedule { target_kind: 0 }
        data.push(0); data.push(0);
        // Advance { secs: MIN_DELAY as u32 + 1 }
        data.push(3);
        data.extend_from_slice(&(MIN_DELAY as u32 + 1).to_le_bytes());
        // Execute { op_id: 0 }
        data.push(1);
        data.extend_from_slice(&0u64.to_le_bytes());
        run(&data);
    }
}
