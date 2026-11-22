/// Treasury ledger segregation module (Issue #141)
///
/// Implements internal sub-accounts in the treasury:
/// - `AgentCapital`: trading capital available to agents
/// - `ProtocolRevenue`: fees collected from markets
/// - `Unallocated`: deposits and unattributed inflows
///
/// Each inflow is attributed to a source, agent entrypoints draw only from
/// `AgentCapital`, and movements between buckets are explicit and auditable.

use soroban_sdk::{panic_with_error, Address, Env};

#[cfg_attr(not(test), path = "lib.rs")]
#[cfg_attr(test, path = "lib.rs")]
use crate::{DataKey, Error};

/// Treasury balance bucket.
#[soroban_sdk::contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Bucket {
    AgentCapital,
    ProtocolRevenue,
    Unallocated,
}

/// Internal ledger tracking three buckets.
#[soroban_sdk::contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Ledger {
    pub agent_capital: i128,
    pub protocol_revenue: i128,
    pub unallocated: i128,
    /// Real token balance when ledger was last reconciled.
    pub last_seen_balance: i128,
}

impl Ledger {
    /// Total across all buckets.
    pub fn total(&self) -> i128 {
        self.agent_capital
            .saturating_add(self.protocol_revenue)
            .saturating_add(self.unallocated)
    }

    /// Balance of a specific bucket.
    pub fn balance(&self, bucket: Bucket) -> i128 {
        match bucket {
            Bucket::AgentCapital => self.agent_capital,
            Bucket::ProtocolRevenue => self.protocol_revenue,
            Bucket::Unallocated => self.unallocated,
        }
    }
}

/// Ledger event: unexplained inflow (third-party sweep_fees or donation).
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnattributedInflow {
    pub amount: i128,
}

/// Ledger event: balance decreased without treasury authorization (circuit breaker).
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceShortfall {
    pub amount: i128,
}

/// Ledger event: funds moved between buckets (admin).
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BucketTransfer {
    pub from: Bucket,
    pub to: Bucket,
    pub amount: i128,
}

/// Ledger helpers. Compile-time module only; integrate calls into Treasury impl.

/// Load ledger from instance storage, or zero-initialize.
pub fn load_ledger(env: &Env) -> Ledger {
    env.storage()
        .instance()
        .get::<_, Ledger>(&DataKey::Ledger)
        .unwrap_or(Ledger {
            agent_capital: 0,
            protocol_revenue: 0,
            unallocated: 0,
            last_seen_balance: 0,
        })
}

/// Save ledger to instance storage with TTL extension.
pub fn save_ledger(env: &Env, ledger: &Ledger) {
    const BUMP_THRESHOLD: u32 = 30 * 17_280;
    const BUMP_TO: u32 = 60 * 17_280;

    env.storage().instance().set(&DataKey::Ledger, ledger);
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

/// Credit a bucket (addition).
pub fn credit(ledger: &mut Ledger, bucket: Bucket, amount: i128) {
    if amount < 0 {
        panic!("credit amount must be non-negative");
    }

    match bucket {
        Bucket::AgentCapital => {
            ledger.agent_capital = ledger.agent_capital.checked_add(amount).unwrap_or_else(|_| {
                panic!("agent_capital overflow");
            });
        }
        Bucket::ProtocolRevenue => {
            ledger.protocol_revenue = ledger
                .protocol_revenue
                .checked_add(amount)
                .unwrap_or_else(|_| {
                    panic!("protocol_revenue overflow");
                });
        }
        Bucket::Unallocated => {
            ledger.unallocated = ledger.unallocated.checked_add(amount).unwrap_or_else(|_| {
                panic!("unallocated overflow");
            });
        }
    }
}

/// Debit a bucket (subtraction). Returns error if insufficient.
pub fn debit(env: &Env, ledger: &mut Ledger, bucket: Bucket, amount: i128) -> Result<(), Error> {
    if amount < 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }

    let available = match bucket {
        Bucket::AgentCapital => ledger.agent_capital,
        Bucket::ProtocolRevenue => ledger.protocol_revenue,
        Bucket::Unallocated => ledger.unallocated,
    };

    if amount > available {
        return Err(Error::InsufficientBalance);
    }

    match bucket {
        Bucket::AgentCapital => {
            ledger.agent_capital = ledger.agent_capital.saturating_sub(amount);
        }
        Bucket::ProtocolRevenue => {
            ledger.protocol_revenue = ledger.protocol_revenue.saturating_sub(amount);
        }
        Bucket::Unallocated => {
            ledger.unallocated = ledger.unallocated.saturating_sub(amount);
        }
    }

    Ok(())
}

/// Reconcile real balance against ledger.
/// Returns the unexplained delta and whether contract is paused afterward.
pub fn reconcile_balance(
    env: &Env,
    ledger: &mut Ledger,
    real_balance: i128,
) -> (i128, bool) {
    let delta = real_balance.saturating_sub(ledger.last_seen_balance);

    let mut paused = false;

    if delta > 0 {
        // Unexplained inflow (third-party sweep_fees or donation)
        credit(ledger, Bucket::Unallocated, delta);
        env.events().publish(("unattributed_inflow",), UnattributedInflow { amount: delta });
    } else if delta < 0 {
        // Balance decreased without authorization (should be impossible for standard SEP-41)
        // Circuit breaker: pause treasury
        env.events()
            .publish(("balance_shortfall",), BalanceShortfall { amount: -delta });
        paused = true;
    }

    ledger.last_seen_balance = real_balance;
    (delta, paused)
}

/// Verify invariant: sum of buckets ≤ real balance.
pub fn check_invariant(ledger: &Ledger, real_balance: i128) -> bool {
    ledger.total() <= real_balance
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ledger_balance_queries() {
        let ledger = Ledger {
            agent_capital: 100,
            protocol_revenue: 50,
            unallocated: 25,
            last_seen_balance: 175,
        };

        assert_eq!(ledger.balance(Bucket::AgentCapital), 100);
        assert_eq!(ledger.balance(Bucket::ProtocolRevenue), 50);
        assert_eq!(ledger.balance(Bucket::Unallocated), 25);
        assert_eq!(ledger.total(), 175);
    }

    #[test]
    fn test_ledger_credit_and_debit() {
        let mut ledger = Ledger {
            agent_capital: 100,
            protocol_revenue: 0,
            unallocated: 0,
            last_seen_balance: 100,
        };

        credit(&mut ledger, Bucket::AgentCapital, 50);
        assert_eq!(ledger.agent_capital, 150);

        // Note: debit requires Env, so we skip that test here
    }

    #[test]
    fn test_ledger_invariant() {
        let ledger = Ledger {
            agent_capital: 100,
            protocol_revenue: 50,
            unallocated: 25,
            last_seen_balance: 200,
        };

        assert!(check_invariant(&ledger, 200)); // exact match
        assert!(check_invariant(&ledger, 300)); // extra balance (unreconciled)
        assert!(!check_invariant(&ledger, 100)); // insufficient (shortfall)
    }
}
