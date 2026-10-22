//! Bounded-exhaustive search over the treasury's spending caps.
//!
//!     cargo test -p integration-tests treasury_caps_exhaustive -- --nocapture
//!     TREASURY_SEARCH_DEPTH=10 cargo test -p integration-tests treasury_caps_exhaustive -- --nocapture
//!
//! Every interleaving of the alphabet in `sim::Sim::ops` (buys, sells,
//! creations, closes, clock advances, pause toggles) is applied to the real
//! treasury and market-core up to the configured depth, and `sim` asserts
//! invariants I1..I9 / A1 after each operation. Breadth-first order makes the
//! first violation a *shortest* counterexample, printed as a replayable test
//! body. See docs/architecture.md, "Treasury cap guarantees".

mod search;
mod sim;

use search::{explore, Branch};
use sim::{Alphabet, Cfg, McImpl, Res, Sim, CFG_CLOSING, CFG_EQUAL, CFG_SEED, CFG_TIGHT, DAY, U};
use std::time::Instant;

/// Runs `f` on a thread *without a name*. soroban-sdk writes a test-snapshot
/// JSON file whenever an `Env` is dropped on a named thread (every test
/// thread is named), which costs orders of magnitude more than the contract
/// calls; it skips the write when the thread has no name. `Env::from_snapshot`
/// offers no way to disable it, so this is also what makes snapshot
/// branching usable at all.
fn unnamed<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap_or_else(|e| std::panic::resume_unwind(e))
}

fn depth() -> usize {
    std::env::var("TREASURY_SEARCH_DEPTH")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6)
}

fn with_env(cfg: Cfg) -> Cfg {
    let cfg = Cfg {
        alphabet: match std::env::var("TREASURY_SEARCH_ALPHABET").as_deref() {
            Ok("full") => Alphabet::Full,
            _ => Alphabet::Lean,
        },
        ..cfg
    };
    match std::env::var("TREASURY_SEARCH_MARKET_CORE").as_deref() {
        Ok("wasm") => Cfg {
            mc: McImpl::Wasm,
            ..cfg
        },
        Ok("native") => Cfg {
            mc: McImpl::Native,
            ..cfg
        },
        _ => cfg,
    }
}

#[test]
fn treasury_caps_exhaustive() {
    unnamed(run_exhaustive)
}

fn run_exhaustive() {
    let depth = depth();
    let start = Instant::now();
    let mut total_states = 0usize;
    let mut total_ops = 0usize;
    println!(
        "treasury_caps_exhaustive: depth {depth}, {:?} alphabet",
        with_env(CFG_TIGHT).alphabet
    );
    for cfg in [CFG_TIGHT, CFG_EQUAL, CFG_SEED, CFG_CLOSING] {
        let cfg = with_env(cfg);
        let t = Instant::now();
        let report = explore(cfg, depth, Branch::Snapshot);
        println!(
            "  [{}] market-core={:?}: {} distinct states, {} operations executed, depth {} reached, {:.1}s",
            cfg.name,
            cfg.mc,
            report.states,
            report.ops,
            report.depth_reached,
            t.elapsed().as_secs_f64()
        );
        println!(
            "      new states per depth: {:?} (+ the last layer's operations, not expanded)",
            report.layers
        );
        if let Some(cx) = report.violation {
            panic!("{cx}");
        }
        total_states += report.states;
        total_ops += report.ops;
    }
    println!(
        "treasury_caps_exhaustive: {total_states} states, {total_ops} operations, depth {depth}, {:.1}s total; \
         I1-I9 and atomicity hold (I4 holds: the daily window is a sliding window)",
        start.elapsed().as_secs_f64()
    );
}

/// Measures the two ways to branch a search (re-running the prefix on a
/// fresh world vs. restoring an `Env` snapshot) so the choice documented in
/// docs/architecture.md rests on numbers.
#[test]
#[ignore = "benchmark; run with --ignored --nocapture"]
fn branching_benchmark() {
    unnamed(branching_benchmark_inner)
}

fn branching_benchmark_inner() {
    for cfg in [CFG_TIGHT] {
        for branch in [Branch::Replay, Branch::Snapshot] {
            let t = Instant::now();
            let report = explore(cfg, 3, branch);
            println!(
                "{:?}: {} states, {} ops in {:.2}s ({:.2} ms/op)",
                branch,
                report.states,
                report.ops,
                t.elapsed().as_secs_f64(),
                t.elapsed().as_secs_f64() * 1000.0 / report.ops.max(1) as f64
            );
        }
    }
}

#[test]
#[ignore = "profiling aid"]
fn profile_ops() {
    unnamed(|| {
        use sim::{Op, Sim, U};
        let mut s = Sim::new(CFG_TIGHT);
        s.apply(Op::Buy { m: 0, amt: U }, false).ok();
        s.apply(Op::Advance { dt: 43_200 }, false).ok();
        s.apply(Op::Buy { m: 1, amt: U }, false).ok();
        let n = 50u32;
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(s.env.to_snapshot());
        }
        println!(
            "to_snapshot: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
        let snap = s.env.to_snapshot();
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(search::restore(&s, &snap));
        }
        println!(
            "restore: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(s.observe());
        }
        println!(
            "observe: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(s.key());
        }
        println!(
            "key: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
        let t = Instant::now();
        for _ in 0..n {
            let mut c = search::restore(&s, &snap);
            c.apply(Op::Buy { m: 0, amt: U }, false).ok();
        }
        println!(
            "restore + unchecked buy: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
        let t = Instant::now();
        for _ in 0..n {
            let mut c = search::restore(&s, &snap);
            c.apply(Op::Buy { m: 0, amt: U }, true).ok();
        }
        println!(
            "restore + checked buy: {:.2} ms",
            t.elapsed().as_secs_f64() * 1000.0 / n as f64
        );
    })
}

/// The deep search runs market-core natively for speed. This is the
/// fidelity check: the vendored wasm, executed by the Soroban VM, explores
/// exactly the same abstract state space (same states, same operation count,
/// same per-depth growth), so the native run is a faithful stand-in.
#[test]
fn market_core_wasm_matches_native() {
    unnamed(|| {
        for cfg in [CFG_TIGHT, CFG_EQUAL, CFG_SEED, CFG_CLOSING] {
            let native = explore(
                Cfg {
                    mc: McImpl::Native,
                    ..cfg
                },
                4,
                Branch::Snapshot,
            );
            let wasm = explore(
                Cfg {
                    mc: McImpl::Wasm,
                    ..cfg
                },
                4,
                Branch::Snapshot,
            );
            assert!(
                native.violation.is_none() && wasm.violation.is_none(),
                "{:?} {:?}",
                native.violation,
                wasm.violation
            );
            assert_eq!(
                (native.states, native.ops, &native.layers),
                (wasm.states, wasm.ops, &wasm.layers),
                "[{}] native and wasm market-core diverge",
                cfg.name
            );
        }
    })
}

/// I5, documented: pausing stops spending and selling, but `close_trade`,
/// `redeem` and `claim_pool_remainder` stay callable (they spend nothing and
/// return capital), and their proceeds reconcile with the balance (I6).
#[test]
fn close_redeem_and_claim_remain_callable_while_paused() {
    unnamed(|| {
        // CFG_CLOSING: the pre-existing markets close after a day.
        let mut f = Sim::new(CFG_CLOSING);
        f.create(U); // market 2, the treasury is its LP
        f.buy(2, U);
        f.buy(0, U);
        f.pause(true);

        // Spending is refused while paused ...
        for op in [
            f.apply(sim::Op::Buy { m: 0, amt: U }, true).ok(),
            f.apply(sim::Op::Create { seed: U }, true).ok(),
            f.apply(sim::Op::Sell { m: 0, out: U / 2 }, true).ok(),
        ] {
            assert_eq!(op, Some(Res::Err(treasury::Error::Paused as u32)));
        }
        // ... but the exposure can still be closed.
        f.close(2);

        for _ in 0..31 {
            f.advance(DAY);
        }
        f.resolve_yes(2);
        f.resolve_yes(0);
        let balance_before = f.balance();
        assert!(matches!(f.settle("redeem", 2), Res::Ok(v) if v > 0));
        assert!(matches!(f.settle("claim_pool_remainder", 2), Res::Ok(v) if v > 0));
        assert!(matches!(f.settle("redeem", 0), Res::Ok(v) if v > 0));
        assert!(f.balance() > balance_before, "settlement returned capital");
        assert_eq!(
            f.balance(),
            f.expected_balance(),
            "I6 after settlement while paused"
        );
        assert!(f
            .apply(sim::Op::Buy { m: 1, amt: U }, true)
            .unwrap()
            .eq(&Res::Err(treasury::Error::Paused as u32)));
    })
}
