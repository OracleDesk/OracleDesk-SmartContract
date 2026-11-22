# Static Analysis: Soroban Scout Integration

This document records the OracleDesk contracts' static analysis results using CoinFabrik's Scout for Soroban, integrated into CI via `.github/workflows/scout.yml`.

## Overview

Scout detects Soroban-specific hazards:
- Unchecked arithmetic on token amounts and counters
- Storage written without TTL extension
- Unbounded iteration over user-supplied vectors
- Constructor arguments never validated
- Unprotected state mutation
- Panics in place of typed errors
- Cross-contract call failures not handled

## Running Scout Locally

```bash
cd oracledesk-stellar

# Install Scout
cargo install cargo-scout-audit

# Run audit
cargo scout-audit --output-format sarif --output-path scout.sarif

# View results
cat scout.sarif | jq '.'
```

**Pinned Scout toolchain:** `nightly-2025-11-18` (set in `.github/workflows/scout.yml`)

## Findings and Triages

### Suppression List

Every Scout finding is triaged as either **Fixed** (with regression test) or **Suppressed** (with written justification).

| File | Function | Detector | Status | Reason |
|------|----------|----------|--------|--------|
| `contracts/market-core/src/lib.rs` | `buy` | unchecked_arithmetic | Fixed | Position updates now use `checked_add` returning `Error::Overflow` |
| `contracts/market-core/src/lib.rs` | `sell` | unchecked_arithmetic | Fixed | `sets_minted` decrement now uses `checked_sub` |
| `contracts/market-core/src/lib.rs` | `create_market` | unchecked_arithmetic | Fixed | NextId increment uses `checked_add` with `Error::Overflow` |
| `contracts/market-core/src/lib.rs` | `__constructor` | unsafe_unwrap | Suppressed | Arguments validated in `__constructor` before any unwrap; see test `constructor_rejects_invalid_config` |
| `contracts/market-core/src/lib.rs` | `set_resolver` | missing_event | Suppressed | `set_resolver` and `set_treasury` are low-frequency admin functions; events added per ADR 0003 |
| `contracts/resolver/src/lib.rs` | `attest` | unchecked_arithmetic | Fixed | Count increments now use `checked_add` returning `Error::Overflow` |
| `contracts/resolver/src/lib.rs` | `finalize_signers` | unchecked_arithmetic | Fixed | `proposed_at + dispute_window` now uses `checked_add`; on overflow, treated as "window never elapses" → `DisputeWindowOpen` |
| `contracts/resolver/src/lib.rs` | `register_signer_spec` | unbounded_iteration | Fixed | Signers length capped at `MAX_SIGNERS = 32`; duplicate-signer check is O(n²) on bounded set |
| `contracts/resolver/src/lib.rs` | `instance_get` | missing_ttl_extension | Fixed | Instance TTL extended on every access via `extend_ttl` call |
| `contracts/treasury/src/lib.rs` | `__constructor` | unsafe_panic | Fixed | Constructor validation errors now return `Error::InvalidConfig` instead of `panic!` |
| `contracts/treasury/src/lib.rs` | `get_daily_usage` | unchecked_arithmetic | Fixed | `day_start + DAY_SECONDS` now uses `checked_add` |
| `contracts/treasury/src/lib.rs` | Persistent writes | missing_ttl_extension | Fixed | All persistent data writes now extend TTL with `extend_ttl` |
| `contracts/reasoning-registry/src/lib.rs` | `__constructor` | unsafe_panic | Fixed | Constructor returns `Error::InvalidConfig` instead of panicking |
| `contracts/reasoning-registry/src/lib.rs` | `publish_trace` | unbounded_iteration | Fixed | `action` and `ipfs_cid` length capped at 256 bytes; new errors appended |

### Detailed Fix Descriptions

#### Market-Core Unchecked Arithmetic (Positions & ID)

**Files:** `contracts/market-core/src/lib.rs`  
**Functions:** `buy`, `sell`, `create_market`  
**Issue:** Position Yes/No shares and market ID increments overflow without typed errors

**Fix:**
```rust
// Before
pos.yes += q.shares_out;

// After
pos.yes = pos.yes.checked_add(q.shares_out)
    .ok_or(Error::Overflow)?;
```

**Regression Test:** `buy_position_overflow_returns_overflow_error`

---

#### Resolver Dispute Window Overflow

**Files:** `contracts/resolver/src/lib.rs`  
**Function:** `finalize_signers`  
**Issue:** `proposed_at + dispute_window` can overflow, panicking the contract

**Fix:**
```rust
// Before
let deadline = proposal.proposed_at + config.dispute_window;

// After
let deadline = proposal.proposed_at.checked_add(config.dispute_window)
    .unwrap_or(u64::MAX);  // On overflow, window never elapses

// In finalize check
if env.ledger().timestamp() > deadline {
    // Finalize allowed
} else {
    return Err(Error::DisputeWindowOpen);
}
```

**Regression Test:** `finalize_with_huge_dispute_window_does_not_panic`

---

#### Signer Count Cap

**Files:** `contracts/resolver/src/lib.rs`  
**Function:** `register_signer_spec`  
**Issue:** Unbounded signer vector allows O(n²) duplicate check and large scans

**Fix:**
```rust
const MAX_SIGNERS: u32 = 32;

pub fn register_signer_spec(...) {
    if signers.len() > MAX_SIGNERS as usize {
        return Err(Error::TooManySigners);
    }
    // Duplicate check is now O(n²) on a bounded 32-element set
}
```

**Regression Test:** `register_signer_spec_rejects_too_many_signers`

---

#### Treasury Constructor Validation

**Files:** `contracts/treasury/src/lib.rs`  
**Function:** `__constructor`  
**Issue:** Constructor calls `panic!` for invalid config instead of returning typed error

**Fix:**
```rust
// Before
if config.invalid() {
    panic!("invalid configuration");
}

// After
if config.invalid() {
    panic_with_error!(&env, Error::InvalidConfig);
}
```

**Regression Test:** `constructor_invalid_caps_returns_error`

---

#### Unbounded Trace Action/CID

**Files:** `contracts/reasoning-registry/src/lib.rs`  
**Function:** `publish_trace`  
**Issue:** `action` and `ipfs_cid` strings unbounded; oversized strings can cause memory exhaustion

**Fix:**
```rust
const MAX_ACTION_LEN: u32 = 256;
const MAX_CID_LEN: u32 = 256;

pub fn publish_trace(..., action: String, ipfs_cid: String) {
    if action.len() > MAX_ACTION_LEN as usize {
        return Err(Error::ActionTooLong);
    }
    if ipfs_cid.len() > MAX_CID_LEN as usize {
        return Err(Error::CidTooLong);
    }
    // proceed
}
```

**Regression Tests:**
- `publish_trace_rejects_oversized_action`
- `publish_trace_rejects_oversized_cid`

---

## New Error Codes

The following error codes were appended (never renumbered) to maintain XDR compatibility:

| Contract | Error Code | Name | Reason |
|----------|-----------|------|--------|
| `market-core` | 19 | `InvalidConfig` | Constructor validation, `treasury != self`, etc. |
| `resolver` | 19 | `InvalidConfig` | Signer count cap, TTL validation |
| `resolver` | 20 | `TooManySigners` | Register spec with > 32 signers |
| `treasury` | (varies) | `InvalidConfig` | Constructor validation, cap validation |
| `reasoning-registry` | 20 | `ActionTooLong` | Publish action > 256 bytes |
| `reasoning-registry` | 21 | `CidTooLong` | Publish CID > 256 bytes |

(Exact codes depend on current max error in each contract; always appended to avoid conflicts.)

## Validation Checklist

- [x] Scout runs in CI on every PR touching `contracts/`
- [x] SARIF output uploaded to GitHub code scanning
- [x] All findings triaged in this document
- [x] Fixed findings have regression tests
- [x] Suppressed findings have written justifications
- [x] XDR type shapes unchanged (verified against `scripts/spec-hash`)
- [x] New errors appended, never renumbered
- [x] `cargo test --workspace` passes with all fixes
- [x] `make lint` passes (clippy + formatter)

## Post-Merge

After this PR merges to `develop`:

1. **Workflow activation:** `.github/workflows/scout.yml` runs on all subsequent PRs
2. **Baseline:** This commit's suppression list is the baseline; new unsuppressed findings will fail CI
3. **Policy:** Future findings require reviewer sign-off on the justification before merge
4. **Maintenance:** `docs/static-analysis.md` is the source of truth; suppressions must be reflected here and in inline comments

## References

- [CoinFabrik Scout for Soroban](https://github.com/CoinFabrik/scout-soroban)
- [Soroban SDK Documentation](https://developers.stellar.org/docs/learn/encyclopedia/contract-development)
- [ADR 0001: Resolution Commitment](./adr/0001-resolution-commitment.md) — XDR stability
- [ADR 0002: Cross-Contract Calls](./adr/0002-cross-contract-calls.md) — Interface stability
