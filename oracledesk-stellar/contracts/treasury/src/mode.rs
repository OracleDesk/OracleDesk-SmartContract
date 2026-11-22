//! The treasury's operating mode (issue #272).
//!
//! Before this module the treasury tracked four booleans (`Paused`,
//! `Paused`, `DrawdownTripped`, `DrawdownAcknowledged`) and every
//! entrypoint read a different combination of them. The result was accidental:
//! a drawdown trip (agents lost money) opened `emergency_withdraw`, the exit
//! meant for "market-core is broken", and clearing one pause silently cleared
//! another.
//!
//! Now each *reason* the treasury is not running normally is stored on its own
//! ([`ModeState`]), the effective [`Mode`] is derived from them with a fixed
//! priority, and every state-changing entrypoint asks one function,
//! [`allowed`], whether its [`Op`] is permitted in that mode. The table is an
//! exhaustive `match`, so adding an `Op` is a compile error until it has a row
//! for every mode. The rationale for each cell is in ADR 0005.

use soroban_sdk::{contracttype, Symbol};

/// What the treasury is doing right now, derived from [`ModeState`] with the
/// priority `Emergency > Paused > AgentsHalted > Unwinding > Normal`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// Everything runs.
    Normal,
    /// A drawdown tripped: agents may not open or add exposure, but may reduce
    /// it. Depositors keep their normal exit (queued withdrawals at NAV).
    AgentsHalted,
    /// The admin paused the treasury: no deposits and no agent trading.
    Paused,
    /// The admin declared an emergency (only from `Paused`): the
    /// in-kind/idle `emergency_withdraw` exit opens, and queueing new
    /// withdrawals closes.
    Emergency,
    /// The admin chose an orderly wind-down (`set_mode(Unwinding)`, #150):
    /// agents may not open or add exposure, but may sell (see `unwind_sell` and
    /// the per-market exit floors), and everything else runs as in `Normal`.
    Unwinding,
}

/// Why the treasury is not in `Normal`. Each reason is stored independently, so
/// clearing one never clears another.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModeState {
    /// Ledger time a drawdown halted the agents. Cleared by `resume_agents`.
    pub drawdown_halt: Option<u64>,
    /// Ledger time of the admin pause. Cleared by `unpause` / `set_paused(false)`.
    pub admin_pause_at: Option<u64>,
    /// The reason the admin gave (`admin` for `set_paused(true)`; `legacy` for a
    /// pause read from the pre-#272 flags). Set with `admin_pause_at`.
    pub admin_pause_reason: Option<Symbol>,
    /// Ledger time the admin declared an emergency. Cleared by `end_emergency`.
    pub emergency_at: Option<u64>,
    /// The reason the admin gave. Set with `emergency_at`.
    pub emergency_reason: Option<Symbol>,
    /// Ledger time the admin set `Unwinding`. Cleared by `set_mode(Normal)`.
    pub unwinding_at: Option<u64>,
}

// The two (time, reason) pairs are flat fields rather than `Option<(u64,
// Symbol)>` or an `Option` of a struct: neither has a `ScVal` conversion for a
// `#[contracttype]` field in test builds.

impl ModeState {
    pub fn normal() -> Self {
        Self {
            drawdown_halt: None,
            admin_pause_at: None,
            admin_pause_reason: None,
            emergency_at: None,
            emergency_reason: None,
            unwinding_at: None,
        }
    }

    /// The effective mode: `Emergency > Paused > AgentsHalted > Unwinding > Normal`.
    pub fn mode(&self) -> Mode {
        if self.emergency_at.is_some() {
            Mode::Emergency
        } else if self.admin_pause_at.is_some() {
            Mode::Paused
        } else if self.drawdown_halt.is_some() {
            Mode::AgentsHalted
        } else if self.unwinding_at.is_some() {
            Mode::Unwinding
        } else {
            Mode::Normal
        }
    }
}

/// A class of state-changing entrypoint. Every one the treasury exposes maps to
/// exactly one `Op` (or is pure admin configuration, which is never gated; see
/// the `matrix` test in `lib.rs`).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Op {
    /// `deposit`.
    Deposit,
    /// `request_withdraw`.
    RequestWithdraw,
    /// `claim_withdraw` (pays a ticket that already exists).
    ClaimWithdraw,
    /// `emergency_withdraw`.
    EmergencyWithdraw,
    /// `agent_create_market`, `agent_create_market_and_reveal`, `agent_buy`,
    /// `agent_buy_v2`: anything that opens or adds exposure.
    AgentOpen,
    /// `agent_sell`, `agent_sell_v2`, `close_trade`: anything that reduces it.
    AgentReduce,
    /// `redeem`, `claim_pool_remainder`, the batch variants and
    /// `agent_claim_lp_fees`: bringing collateral home after resolution.
    AgentSettle,
    /// `settle_market`, `realize`, `collect_market_fees`: permissionless
    /// settlement.
    PermissionlessSettle,
    /// `allocate_to_yield`.
    YieldAllocate,
    /// `recall_from_yield`.
    YieldRecall,
    /// `migrate_market`.
    Migrate,
}

/// The gate table. One exhaustive `match` on `op` with an exhaustive `match` on
/// `mode` inside each arm, so a new `Op` or `Mode` does not compile until every
/// cell is decided.
///
/// | Op | Normal | AgentsHalted | Paused | Emergency | Unwinding |
/// |---|---|---|---|---|---|
/// | Deposit | yes | no | no | no | yes |
/// | RequestWithdraw | yes | yes | yes | no | yes |
/// | ClaimWithdraw | yes | yes | yes | yes | yes |
/// | EmergencyWithdraw | no | no | no | yes | no |
/// | AgentOpen | yes | no | no | no | no |
/// | AgentReduce | yes | yes | no | no | yes |
/// | AgentSettle | yes | yes | yes | yes | yes |
/// | PermissionlessSettle | yes | yes | yes | yes | yes |
/// | YieldAllocate | yes | no | no | no | yes |
/// | YieldRecall | yes | yes | yes | yes | yes |
/// | Migrate | yes | no | no | yes | yes |
pub const fn allowed(mode: Mode, op: Op) -> bool {
    match op {
        Op::Deposit | Op::YieldAllocate => match mode {
            Mode::Normal | Mode::Unwinding => true,
            Mode::AgentsHalted | Mode::Paused | Mode::Emergency => false,
        },
        Op::AgentOpen => match mode {
            Mode::Normal => true,
            Mode::AgentsHalted | Mode::Paused | Mode::Emergency | Mode::Unwinding => false,
        },
        Op::RequestWithdraw => match mode {
            Mode::Normal | Mode::AgentsHalted | Mode::Paused | Mode::Unwinding => true,
            Mode::Emergency => false,
        },
        Op::ClaimWithdraw | Op::AgentSettle | Op::PermissionlessSettle | Op::YieldRecall => {
            match mode {
                Mode::Normal
                | Mode::AgentsHalted
                | Mode::Paused
                | Mode::Emergency
                | Mode::Unwinding => true,
            }
        }
        Op::EmergencyWithdraw => match mode {
            Mode::Emergency => true,
            Mode::Normal | Mode::AgentsHalted | Mode::Paused | Mode::Unwinding => false,
        },
        Op::AgentReduce => match mode {
            Mode::Normal | Mode::AgentsHalted | Mode::Unwinding => true,
            Mode::Paused | Mode::Emergency => false,
        },
        Op::Migrate => match mode {
            Mode::Normal | Mode::Emergency | Mode::Unwinding => true,
            Mode::AgentsHalted | Mode::Paused => false,
        },
    }
}

/// Every `Op`, in declaration order (used by the matrix test and `allowed`'s
/// own exhaustiveness test).
#[cfg(test)]
pub const ALL_OPS: [Op; 11] = [
    Op::Deposit,
    Op::RequestWithdraw,
    Op::ClaimWithdraw,
    Op::EmergencyWithdraw,
    Op::AgentOpen,
    Op::AgentReduce,
    Op::AgentSettle,
    Op::PermissionlessSettle,
    Op::YieldAllocate,
    Op::YieldRecall,
    Op::Migrate,
];

/// Every `Mode`, in priority order of declaration.
#[cfg(test)]
pub const ALL_MODES: [Mode; 5] = [
    Mode::Normal,
    Mode::AgentsHalted,
    Mode::Paused,
    Mode::Emergency,
    Mode::Unwinding,
];

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Symbol};

    /// The table from the issue and ADR 0005, written out cell by cell
    /// independently of `allowed`'s `match`.
    ///
    /// Columns: Normal, AgentsHalted, Paused, Emergency, Unwinding.
    const TABLE: [(Op, [bool; 5]); 11] = [
        (Op::Deposit, [true, false, false, false, true]),
        (Op::RequestWithdraw, [true, true, true, false, true]),
        (Op::ClaimWithdraw, [true; 5]),
        (Op::EmergencyWithdraw, [false, false, false, true, false]),
        (Op::AgentOpen, [true, false, false, false, false]),
        (Op::AgentReduce, [true, true, false, false, true]),
        (Op::AgentSettle, [true; 5]),
        (Op::PermissionlessSettle, [true; 5]),
        (Op::YieldAllocate, [true, false, false, false, true]),
        (Op::YieldRecall, [true; 5]),
        (Op::Migrate, [true, false, false, true, true]),
    ];

    #[test]
    fn allowed_matches_the_documented_table_cell_by_cell() {
        for (op, row) in TABLE {
            for (mode, want) in ALL_MODES.into_iter().zip(row) {
                assert_eq!(allowed(mode, op), want, "{op:?} in {mode:?}");
            }
        }
    }

    #[test]
    fn every_op_has_exactly_one_table_row() {
        for op in ALL_OPS {
            assert_eq!(TABLE.iter().filter(|(o, _)| *o == op).count(), 1, "{op:?}");
        }
        assert_eq!(TABLE.len(), ALL_OPS.len());
    }

    #[test]
    fn settlement_and_recall_are_open_in_every_mode() {
        // They only bring collateral home, so no mode may close them.
        for mode in ALL_MODES {
            for op in [
                Op::ClaimWithdraw,
                Op::AgentSettle,
                Op::PermissionlessSettle,
                Op::YieldRecall,
            ] {
                assert!(allowed(mode, op), "{op:?} in {mode:?}");
            }
        }
    }

    #[test]
    fn only_emergency_opens_the_emergency_exit() {
        for mode in ALL_MODES {
            assert_eq!(
                allowed(mode, Op::EmergencyWithdraw),
                mode == Mode::Emergency
            );
        }
    }

    #[test]
    fn a_drawdown_halts_agent_openings_only() {
        // The bug this module exists to fix: a drawdown must not open the
        // forfeiting exit, and must not stop reductions or exits.
        assert!(!allowed(Mode::AgentsHalted, Op::AgentOpen));
        assert!(!allowed(Mode::AgentsHalted, Op::EmergencyWithdraw));
        assert!(allowed(Mode::AgentsHalted, Op::AgentReduce));
        assert!(allowed(Mode::AgentsHalted, Op::RequestWithdraw));
        assert!(allowed(Mode::AgentsHalted, Op::ClaimWithdraw));
    }

    #[test]
    fn mode_is_derived_with_priority_emergency_pause_halt_unwinding_normal() {
        let env = Env::default();
        let why = Symbol::new(&env, "why");
        let mut s = ModeState::normal();
        assert_eq!(s.mode(), Mode::Normal);
        s.drawdown_halt = Some(10);
        assert_eq!(s.mode(), Mode::AgentsHalted);
        s.admin_pause_at = Some(20);
        s.admin_pause_reason = Some(why.clone());
        assert_eq!(s.mode(), Mode::Paused, "pause outranks a halt");
        s.emergency_at = Some(30);
        s.emergency_reason = Some(why);
        assert_eq!(s.mode(), Mode::Emergency, "emergency outranks a pause");
        // Reasons are independent: dropping the outer ones reveals the inner.
        s.emergency_at = None;
        s.emergency_reason = None;
        assert_eq!(s.mode(), Mode::Paused);
        s.admin_pause_at = None;
        s.admin_pause_reason = None;
        assert_eq!(s.mode(), Mode::AgentsHalted);
        s.drawdown_halt = None;
        s.unwinding_at = Some(40);
        assert_eq!(s.mode(), Mode::Unwinding);
        s.unwinding_at = None;
        assert_eq!(s.mode(), Mode::Normal);
    }
}
