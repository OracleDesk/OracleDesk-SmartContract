# Treasury Ledger Segregation (Issue #141)

This document describes the internal ledger architecture for segregating protocol revenue from agent trading capital in the treasury contract.

## Problem Statement

The OracleDesk treasury serves two roles:
1. **Agent capital pool** — money the autonomous agent can spend
2. **Protocol revenue sink** — fees collected from markets

Both land in a single SEP-41 balance, causing:
- Protocol revenue silently becomes agent risk capital
- No way to query "how much has OracleDesk earned?" from on-chain state
- Admin cannot withdraw fees without also draining trading capital
- Misbehaving agents can lose fee revenue

## Solution: Internal Ledger with Three Buckets

### Storage Structure

```rust
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Bucket {
    AgentCapital,
    ProtocolRevenue,
    Unallocated,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Ledger {
    pub agent_capital: i128,
    pub protocol_revenue: i128,
    pub unallocated: i128,
    pub last_seen_balance: i128,
}
```

Stored as: `DataKey::Ledger` in instance storage.

### Invariant

```
sum(agent_capital, protocol_revenue, unallocated) ≤ token.balance(self)
```

Equality holds after `reconcile()` is called; difference indicates unreconciled inflows (from permissionless `sweep_fees` or direct donations).

## Inflow Attribution

| Source | Destination Bucket | Mechanism |
|--------|-------------------|-----------|
| `deposit(from, amount)` | `Unallocated` | Anyone can deposit; admin may move later |
| `deposit(from, amount, bucket)` (new) | Specified bucket | Admin can deposit directly to any bucket |
| `collect_market_fees(market_id)` | `ProtocolRevenue` | Admin-initiated; triggers `market-core.sweep_fees` |
| `agent_sell(market_id, ...)` | `AgentCapital` | Proceeds flow back as agent capital |
| `redeem(...)` | `AgentCapital` | LP redemption proceeds |
| `claim_pool_remainder(market_id)` | `AgentCapital` | Unclaimed LP remainder |
| **Unexplained inflow** | `Unallocated` | Third-party `sweep_fees` or direct `transfer` |

## Outflow Control

### Agent Spending (Agent-Only)

`agent_create_market`, `agent_buy`:
- **Debit:** `agent_capital` (checked)
- **Fail if:** `agent_capital < amount` → `Error::BucketInsufficient`
- Atomic: entire market-core call rolls back if debit fails

### Administrative Withdrawal (Admin-Only)

`withdraw(to, bucket, amount)` (new signature):
- **Debit:** specified `bucket` (checked)
- **Fail if:** `bucket_balance < amount` → `Error::BucketInsufficient`
- **Event:** `Withdrawn { to, bucket, amount }`

### Administrative Rebalance (Admin-Only)

`rebalance(from: Bucket, to: Bucket, amount)` (new):
- **Debit:** `from` bucket (checked)
- **Credit:** `to` bucket
- **Event:** `BucketTransfer { from, to, amount }`
- **Policy:** `ProtocolRevenue → AgentCapital` moves **must** go through timelock (future issue)

## Reconciliation

`reconcile() -> (delta: i128, reconciled: bool)` (permissionless):

1. Measure unexplained delta: `delta = balance - last_seen_balance`
2. If `delta > 0`: Credit `Unallocated`, emit `UnattributedInflow { amount }`
3. If `delta < 0`: Signal shortfall, emit `BalanceShortfall { amount }`, set `paused = true`
4. Update `last_seen_balance = balance`
5. Return `(delta, is_paused)`

**Automatic:** Every state-changing entrypoint must call `reconcile_internal()` before modifying state, ensuring attribution is always made before new movements.

## Error Codes

| Error | Code | Meaning |
|-------|------|---------|
| `BucketInsufficient` | 11 | Bucket balance is insufficient for requested operation |
| `NotReconciled` | 12 | (optional) Call `reconcile()` first to resolve unexplained balance |

## Events

```rust
// Inflows
UnattributedInflow { amount: i128 }  // from reconcile()
BalanceShortfall { amount: i128 }    // from reconcile() — also sets paused=true

// Outflows
Withdrawn { to: Address, bucket: Bucket, amount: i128 }
BucketTransfer { from: Bucket, to: Bucket, amount: i128 }
```

## Views

```rust
pub fn get_ledger() -> Ledger  // All bucket balances + last_seen_balance

pub fn bucket_balance(bucket: Bucket) -> i128  // Single bucket

pub fn available_capital() -> i128  // Redefined: returns agent_capital only
                                    // (breaking change; document and update bindings)

pub fn check_ledger() -> bool  // sum(buckets) ≤ balance
```

## Edge Cases

### Third-Party sweep_fees (Permissionless)

- **Window:** Between call and next `reconcile()`, fees are unattributed
- **Safety:** `reconcile()` attributes them to `Unallocated`, never `AgentCapital`
- **Incentive:** Anyone can call `reconcile()` to claim attribution rights (none today; potential future reward mechanism)

### Direct Token Donations

- Treated same as third-party `sweep_fees` → `Unallocated` on reconciliation
- Cannot be forced into `AgentCapital`

### Concurrent Agent Trading

- `last_seen_balance` updated **after** market-core call in `agent_buy`
- Guarantees: within single atomic transaction, all movements are accounted for
- If outflow happens before update, next `reconcile()` sees it as shortfall (pauses contract)

### Fee-on-Transfer Collateral

- Not supported; would break exact attribution
- `reconcile()` will flag transfers with rounding as unattributed/shortfall
- Document as unsupported edge case

## Migration Path

**Testnet:** Treasury is redeployed (pre-alpha; no data preservation needed)

**Future Mainnet:** If needed, migration handler:
1. Initialize all three buckets at zero
2. On first `reconcile()`, place entire pre-existing balance into `Unallocated`
3. Admin then explicitly moves capital to `AgentCapital` via `rebalance()`

## Testing Strategy

- **Unit:** Each bucket separately
- **Integration:** Deposit → trade → fee collection → reconciliation sequences
- **Adversarial:** Third-party `sweep_fees`, direct donations, concurrent trades
- **Invariant:** Randomized sequence of deposits, trades, settlements; assert invariant after each step

## References

- [Treasury Architecture](./architecture.md) treasury section
- [SEP-41 Token Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
- [Soroban Events](https://developers.stellar.org/docs/learn/encyclopedia/contract-development/events)
- [Soroban Storage & TTL](https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival)
