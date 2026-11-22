//! Breadth-first exploration with memoization on `Sim::key`.

use crate::sim::{Cfg, McImpl, Op, Sim, U};
use soroban_sdk::{Address, Env};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use treasury::Treasury;

#[derive(Clone, Copy, Debug)]
pub enum Branch {
    /// Rebuild the world and re-run the prefix for every child.
    Replay,
    /// Restore an `Env` snapshot of the parent for every child.
    Snapshot,
}

pub struct Report {
    pub states: usize,
    pub ops: usize,
    pub depth_reached: usize,
    /// New abstract states discovered at each depth.
    pub layers: Vec<usize>,
    pub violation: Option<String>,
}

/// Re-runs `path` on a fresh world (no invariant checks: it was checked when
/// the path was first explored).
pub fn replay(cfg: Cfg, path: &[Op]) -> Sim {
    let mut sim = Sim::new(cfg);
    for op in path {
        sim.apply(*op, false).ok();
    }
    sim
}

/// Delegates to a native contract but turns its constructor into a no-op:
/// a restored world already holds the constructor's effects in its ledger
/// state, and `register_contract` otherwise runs the constructor again.
struct NoConstructor<T>(T);

impl<T: soroban_sdk::testutils::ContractFunctionSet> soroban_sdk::testutils::ContractFunctionSet
    for NoConstructor<T>
{
    fn call(&self, func: &str, env: Env, args: &[soroban_sdk::Val]) -> Option<soroban_sdk::Val> {
        if func == "__constructor" {
            return Some(soroban_sdk::Val::VOID.into());
        }
        self.0.call(func, env, args)
    }
}

/// A new world equal to `sim`, from a ledger snapshot. Native contracts live
/// in the host's registry, not in the snapshot, so they are registered again
/// (without running the constructor a second time).
pub fn restore(sim: &Sim, snap: &soroban_sdk::testutils::Snapshot) -> Sim {
    let env = Env::from_snapshot(snap.clone());
    env.mock_all_auths();
    // `Address` values are handles into one `Env`'s host; rebuild them.
    let addr = |a: &Address| {
        let s = a.to_string();
        let mut buf = vec![0u8; s.len() as usize];
        s.copy_into_slice(&mut buf);
        Address::from_str(&env, std::str::from_utf8(&buf).unwrap())
    };
    let (admin, agent, treasury, token, core) = (
        addr(&sim.admin),
        addr(&sim.agent),
        addr(&sim.treasury),
        addr(&sim.token),
        addr(&sim.core),
    );
    #[allow(deprecated)]
    {
        env.register_contract(&treasury, NoConstructor(Treasury));
        if sim.cfg.mc == McImpl::Native {
            env.register_contract(&core, NoConstructor(::market_core::MarketCore));
        }
    }
    let mut child = sim.shallow();
    child.env = env;
    child.admin = admin;
    child.agent = agent;
    child.treasury = treasury;
    child.token = token;
    child.core = core;
    child.spends = sim.spends.clone();
    child
}

pub fn explore(cfg: Cfg, depth: usize, branch: Branch) -> Report {
    let root = Sim::new(cfg);
    let mut seen: HashSet<Vec<i128>> = HashSet::new();
    seen.insert(root.key());
    drop(root);
    let mut frontier: Vec<Vec<Op>> = vec![Vec::new()];
    let ops = AtomicUsize::new(0);
    let mut layers = Vec::new();
    let workers = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(16);

    for d in 0..depth {
        let cursor = AtomicUsize::new(0);
        let stop = AtomicBool::new(false);
        let found: Mutex<Vec<(Vec<Op>, String)>> = Mutex::new(Vec::new());
        let children: Mutex<Vec<(Vec<i128>, Vec<Op>)>> = Mutex::new(Vec::new());
        let seen_ref = &seen;
        std::thread::scope(|scope| {
            for _ in 0..workers {
                // No thread name: see `unnamed` in main.rs.
                std::thread::Builder::new()
                    .stack_size(16 * 1024 * 1024)
                    .spawn_scoped(scope, || {
                        let mut local: Vec<(Vec<i128>, Vec<Op>)> = Vec::new();
                        while !stop.load(Ordering::Relaxed) {
                            let i = cursor.fetch_add(1, Ordering::Relaxed);
                            let Some(path) = frontier.get(i) else { break };
                            let parent = replay(cfg, path);
                            let snap = matches!(branch, Branch::Snapshot)
                                .then(|| parent.env.to_snapshot());
                            for op in parent.ops() {
                                let mut child = match &snap {
                                    Some(s) => restore(&parent, s),
                                    None => replay(cfg, path),
                                };
                                ops.fetch_add(1, Ordering::Relaxed);
                                let mut p = path.clone();
                                p.push(op);
                                match child.apply(op, true) {
                                    Err(v) => {
                                        stop.store(true, Ordering::Relaxed);
                                        found.lock().unwrap().push((
                                            p.clone(),
                                            counterexample(cfg, &p, v.invariant, &v.detail),
                                        ));
                                    }
                                    // Children of the last layer are never expanded,
                                    // so they need no key.
                                    Ok(_) if d + 1 == depth => {}
                                    Ok(_) => {
                                        let key = child.key();
                                        if !seen_ref.contains(&key) {
                                            local.push((key, p));
                                        }
                                    }
                                }
                            }
                        }
                        children.lock().unwrap().extend(local);
                    })
                    .unwrap();
            }
        });
        if let Some((_, cx)) = found
            .into_inner()
            .unwrap()
            .into_iter()
            .min_by_key(|(p, _)| p.clone())
        {
            return Report {
                states: seen.len(),
                ops: ops.load(Ordering::Relaxed),
                depth_reached: d + 1,
                layers,
                violation: Some(cx),
            };
        }
        // Deterministic merge: the lexicographically least path represents
        // each new state, whatever order the workers finished in.
        let mut kids = children.into_inner().unwrap();
        kids.sort_by(|a, b| a.1.cmp(&b.1));
        let mut next = Vec::new();
        for (key, path) in kids {
            if seen.insert(key) {
                next.push(path);
            }
        }
        // The last layer's children are never keyed, so it has no count.
        if d + 1 < depth {
            layers.push(next.len());
        }
        if next.is_empty() {
            return Report {
                states: seen.len(),
                ops: ops.load(Ordering::Relaxed),
                depth_reached: d + 1,
                layers,
                violation: None,
            };
        }
        frontier = next;
    }
    Report {
        states: seen.len(),
        ops: ops.load(Ordering::Relaxed),
        depth_reached: depth,
        layers,
        violation: None,
    }
}

/// A shortest violating sequence as a replayable test body.
pub fn counterexample(cfg: Cfg, path: &[Op], invariant: &str, detail: &str) -> String {
    let mut s = format!(
        "\n// counterexample {invariant} (depth {}), caps [{}], U = {U}\n// {detail}\n// paste into a test in tests/treasury_caps_exhaustive/ (use sim::*):\n",
        path.len(),
        cfg.name
    );
    s.push_str(&format!("let mut f = Sim::new({});\n", cfg.ident));
    for op in path {
        s.push_str(&op.snippet());
        s.push('\n');
    }
    s
}
