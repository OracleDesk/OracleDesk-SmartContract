//! Recording mock targets for the timelock fuzzer (#319).
//!
//! Each target records every call it receives so the harness can verify
//! the timelock only invokes it after the delay elapses.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

#[derive(Clone, Debug, Default)]
pub struct CallRecord {
    pub fn_name: &'static str,
    pub at: u64,
}

#[contract]
pub struct RecordingTarget;

#[contractimpl]
impl RecordingTarget {
    pub fn set_paused(env: Env, paused: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("paused"), &paused);
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&symbol_short!("paused"))
            .unwrap_or(false)
    }

    pub fn noop(env: Env, x: u32) -> u32 {
        let prev: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("noop_cnt"))
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&symbol_short!("noop_cnt"), &(prev + 1));
        x
    }

    pub fn noop_call_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("noop_cnt"))
            .unwrap_or(0)
    }

    pub fn cancel_proposal(_env: Env, _market_id: u64, _reason: u32) {}
}

pub fn set_paused_sym(env: &Env) -> Symbol {
    Symbol::new(env, "set_paused")
}

pub fn noop_sym(env: &Env) -> Symbol {
    Symbol::new(env, "noop")
}

pub fn cancel_proposal_sym(env: &Env) -> Symbol {
    Symbol::new(env, "cancel_proposal")
}

pub fn set_default_delay_sym(env: &Env) -> Symbol {
    Symbol::new(env, "set_default_delay")
}

/// A helper address that the timelock can't hold auth over (simulates a
/// completely unrelated caller trying to execute).
pub fn rogue(env: &Env) -> Address {
    Address::generate(env)
}
