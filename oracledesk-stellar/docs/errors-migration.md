# Reasoning registry error migration

ADR 0006 reserves contract error codes `3001..=3999` for the reasoning
registry. The registry now uses explicit discriminants in that range.

| Old code | New code | Variant |
|---|---:|---|
| 10 | 3010 | `TraceAlreadyConsumed` |
| 11 | 3011 | `NoPendingAdmin` |
| 12 | 3012 | `PendingAdminExpired` |

Codes `3013..=3048` replace the registry's former private implementation
codes (`100..=134` and `129` duplicate). Consumers should key on the registry
contract identity plus the contract error code and migrate all comparisons to
the explicit `3001..=3999` range.
