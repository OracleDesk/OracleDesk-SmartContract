# OracleDesk Protocol Specification — Traceability Matrix

This document maps specification clauses to test implementations, ensuring every requirement is either tested or explicitly marked untested with a GitHub issue link.

## Overview

Each specification clause (AUTH, PRE, POST, EVT, ERR, INV) has a stable identifier (e.g., `MC-BUY-PRE-1`) and must be covered by at least one test, or explicitly marked `UNTESTED(#issue-number)` with a reason.

The traceability checker `scripts/spec-trace.py` scans:
1. All Rust test files (`contracts/**/src/*.rs` and `**/*.test.rs`)
2. Specification files in `docs/spec/`
3. Collects `// spec: <ID>` annotations on tests
4. Reports coverage per clause

---

## Coverage Report Format

Each clause entry in this matrix follows:

```
| Clause ID | Test Path::Name | Coverage | Notes |
|-----------|-----------------|----------|-------|
| MC-BUY-AUTH-1 | contracts/market-core/src/lib.rs::buy_requires_trader_auth | ✓ COVERED | - |
| MC-BUY-PRE-5 | contracts/market-core/src/lib.rs::buy_overflow_check | ✓ COVERED | Checked arithmetic. |
| MC-BUY-ERR-6 | - | ✗ UNTESTED(#issue) | Reason: ... |
```

---

## Test Annotation Format

Every test that covers one or more specification clauses includes a comment at the top:

```rust
#[test]
fn buy_requires_trader_auth_and_checks_pause_before_auth() {
    // spec: MC-BUY-AUTH-1, MC-BUY-PRE-1
    // This test verifies that buy checks Paused before auth,
    // so a paused market returns Paused(2), not an auth error.
    ...
}
```

If a clause cannot be tested (by design), mark it:

```rust
#[test]
fn buy_overflow_behavior() {
    // spec: MC-BUY-POST-2
    // spec: UNTESTED(#some-issue): Reason documented in GitHub issue
    ...
}
```

---

## Coverage Status Legend

- **✓ COVERED** — At least one test annotated with this clause ID.
- **⊡ PARTIAL** — Covered indirectly (clause is exercised but not explicitly annotated). Should be promoted to explicit annotation.
- **✗ UNTESTED** — No test covers this clause. Must be marked UNTESTED(#issue-number) with a reason.
- **⊕ INTENTIONAL** — Design decision documented (marked INTENTIONAL in spec).

---

## Per-Contract Checklist

### market-core Contract

- **Constructor** (`__constructor`): 
  - [ ] MC-CONSTRUCTOR-AUTH-1
  - [ ] MC-CONSTRUCTOR-PRE-1..3
  - [ ] MC-CONSTRUCTOR-POST-1..7

- **set_paused**: 
  - [ ] MC-SET-PAUSED-AUTH-1
  - [ ] MC-SET-PAUSED-POST-1

- **create_market**: 
  - [ ] MC-CREATE-MARKET-AUTH-1
  - [ ] MC-CREATE-MARKET-PRE-1..6
  - [ ] MC-CREATE-MARKET-POST-1..8
  - [ ] MC-CREATE-MARKET-EVT-1
  - [ ] MC-CREATE-MARKET-ERR-1..6

- **buy**: 
  - [ ] MC-BUY-AUTH-1
  - [ ] MC-BUY-PRE-1..6
  - [ ] MC-BUY-POST-1..9
  - [ ] MC-BUY-EVT-1
  - [ ] MC-BUY-ERR-1..8

- **sell**: 
  - [ ] MC-SELL-AUTH-1
  - [ ] MC-SELL-PRE-1..6
  - [ ] MC-SELL-POST-1..7
  - [ ] MC-SELL-EVT-1
  - [ ] MC-SELL-ERR-1..7

- **transfer_position** (Issue #146):
  - [ ] MC-TRANSFER-POSITION-AUTH-1
  - [ ] MC-TRANSFER-POSITION-PRE-1..4
  - [ ] MC-TRANSFER-POSITION-POST-1..3
  - [ ] MC-TRANSFER-POSITION-EVT-1
  - [ ] MC-TRANSFER-POSITION-ERR-1..4

- **resolve**: 
  - [ ] MC-RESOLVE-AUTH-1
  - [ ] MC-RESOLVE-PRE-1..3
  - [ ] MC-RESOLVE-POST-1..3
  - [ ] MC-RESOLVE-EVT-1
  - [ ] MC-RESOLVE-ERR-1..3

- **void_market**: 
  - [ ] MC-VOID-MARKET-AUTH-1
  - [ ] MC-VOID-MARKET-PRE-1..2
  - [ ] MC-VOID-MARKET-POST-1..3
  - [ ] MC-VOID-MARKET-EVT-1
  - [ ] MC-VOID-MARKET-ERR-1..3

- **redeem**: 
  - [ ] MC-REDEEM-AUTH-1
  - [ ] MC-REDEEM-PRE-1..4
  - [ ] MC-REDEEM-POST-1..4
  - [ ] MC-REDEEM-EVT-1
  - [ ] MC-REDEEM-ERR-1..3

- **claim_pool_remainder**: 
  - [ ] MC-CLAIM-POOL-REMAINDER-AUTH-1
  - [ ] MC-CLAIM-POOL-REMAINDER-PRE-1..3
  - [ ] MC-CLAIM-POOL-REMAINDER-POST-1..4
  - [ ] MC-CLAIM-POOL-REMAINDER-EVT-1
  - [ ] MC-CLAIM-POOL-REMAINDER-ERR-1..4

- **sweep_fees**: 
  - [ ] MC-SWEEP-FEES-PRE-1..2
  - [ ] MC-SWEEP-FEES-POST-1..3
  - [ ] MC-SWEEP-FEES-EVT-1
  - [ ] MC-SWEEP-FEES-ERR-1..2

- **Views** (get_config, get_market, get_position, get_price, quote_buy, quote_sell):
  - [ ] MC-GET-CONFIG-POST-1
  - [ ] MC-GET-MARKET-POST-1
  - [ ] MC-GET-POSITION-POST-1
  - [ ] MC-GET-PRICE-POST-1
  - [ ] MC-QUOTE-BUY-POST-1
  - [ ] MC-QUOTE-SELL-POST-1

### resolver Contract

- **register_signer_spec**: 
  - [ ] RS-REGISTER-SIGNER-SPEC-AUTH-1
  - [ ] RS-REGISTER-SIGNER-SPEC-PRE-1..5
  - [ ] RS-REGISTER-SIGNER-SPEC-POST-1..4
  - [ ] RS-REGISTER-SIGNER-SPEC-EVT-1
  - [ ] RS-REGISTER-SIGNER-SPEC-ERR-1..4

- **register_price_spec**: 
  - [ ] RS-REGISTER-PRICE-SPEC-AUTH-1
  - [ ] RS-REGISTER-PRICE-SPEC-PRE-1..3
  - [ ] RS-REGISTER-PRICE-SPEC-POST-1..2
  - [ ] RS-REGISTER-PRICE-SPEC-EVT-1
  - [ ] RS-REGISTER-PRICE-SPEC-ERR-1..2

- **attest**: 
  - [ ] RS-ATTEST-AUTH-1
  - [ ] RS-ATTEST-PRE-1..4
  - [ ] RS-ATTEST-POST-1..3
  - [ ] RS-ATTEST-EVT-1
  - [ ] RS-ATTEST-ERR-1..3

- **finalize_signers**: 
  - [ ] RS-FINALIZE-SIGNERS-AUTH-1
  - [ ] RS-FINALIZE-SIGNERS-PRE-1..4
  - [ ] RS-FINALIZE-SIGNERS-POST-1..4
  - [ ] RS-FINALIZE-SIGNERS-EVT-1
  - [ ] RS-FINALIZE-SIGNERS-ERR-1..4

- **finalize_signers_for** (Issue #149):
  - [ ] RS-FINALIZE-SIGNERS-FOR-AUTH-1
  - [ ] RS-FINALIZE-SIGNERS-FOR-PRE-1..4
  - [ ] RS-FINALIZE-SIGNERS-FOR-POST-1..2
  - [ ] RS-FINALIZE-SIGNERS-FOR-EVT-1
  - [ ] RS-FINALIZE-SIGNERS-FOR-ERR-1..2

- **resolve_price_for** (Issue #149):
  - [ ] RS-RESOLVE-PRICE-FOR-AUTH-1
  - [ ] RS-RESOLVE-PRICE-FOR-PRE-1..4
  - [ ] RS-RESOLVE-PRICE-FOR-POST-1..2
  - [ ] RS-RESOLVE-PRICE-FOR-EVT-1
  - [ ] RS-RESOLVE-PRICE-FOR-ERR-1..1

- **fund_bounty** (Issue #149):
  - [ ] RS-FUND-BOUNTY-AUTH-1
  - [ ] RS-FUND-BOUNTY-PRE-1..4
  - [ ] RS-FUND-BOUNTY-POST-1..3
  - [ ] RS-FUND-BOUNTY-EVT-1
  - [ ] RS-FUND-BOUNTY-ERR-1..4

- **guardian_void_market**: 
  - [ ] RS-GUARDIAN-VOID-MARKET-AUTH-1
  - [ ] RS-GUARDIAN-VOID-MARKET-PRE-1..2
  - [ ] RS-GUARDIAN-VOID-MARKET-POST-1..2
  - [ ] RS-GUARDIAN-VOID-MARKET-EVT-1
  - [ ] RS-GUARDIAN-VOID-MARKET-ERR-1..3

### treasury Contract

- **agent_create_market**: 
  - [ ] TR-AGENT-CREATE-MARKET-AUTH-1
  - [ ] TR-AGENT-CREATE-MARKET-PRE-1..5
  - [ ] TR-AGENT-CREATE-MARKET-POST-1..6
  - [ ] TR-AGENT-CREATE-MARKET-EVT-1

- **agent_create_market_with_bounty** (Issue #149):
  - [ ] TR-AGENT-CREATE-MARKET-WITH-BOUNTY-AUTH-1
  - [ ] TR-AGENT-CREATE-MARKET-WITH-BOUNTY-PRE-1..5
  - [ ] TR-AGENT-CREATE-MARKET-WITH-BOUNTY-POST-1..6
  - [ ] TR-AGENT-CREATE-MARKET-WITH-BOUNTY-EVT-1
  - [ ] TR-AGENT-CREATE-MARKET-WITH-BOUNTY-ERR-1..2

- **agent_buy**: 
  - [ ] TR-AGENT-BUY-AUTH-1
  - [ ] TR-AGENT-BUY-PRE-1..5
  - [ ] TR-AGENT-BUY-POST-1..5
  - [ ] TR-AGENT-BUY-EVT-1

### reasoning-registry Contract

- **register_reasoner**: 
  - [ ] RR-REGISTER-REASONER-AUTH-1
  - [ ] RR-REGISTER-REASONER-PRE-1..2
  - [ ] RR-REGISTER-REASONER-POST-1..3
  - [ ] RR-REGISTER-REASONER-EVT-1
  - [ ] RR-REGISTER-REASONER-ERR-1

- **publish_trace**: 
  - [ ] RR-PUBLISH-TRACE-AUTH-1
  - [ ] RR-PUBLISH-TRACE-PRE-1..3
  - [ ] RR-PUBLISH-TRACE-POST-1..4
  - [ ] RR-PUBLISH-TRACE-EVT-1
  - [ ] RR-PUBLISH-TRACE-ERR-1..3

- **verify_trace**: 
  - [ ] RR-VERIFY-TRACE-PRE-1
  - [ ] RR-VERIFY-TRACE-POST-1..3
  - [ ] RR-VERIFY-TRACE-ERR-1..2

### System Invariants

- [ ] SYS-INV-1 (Solvency per market)
- [ ] SYS-INV-2 (Reserve invariant)
- [ ] SYS-INV-3 (Position conservation)
- [ ] SYS-INV-4 (Fee monotonicity)
- [ ] SYS-INV-5 (Single LP payout)
- [ ] SYS-INV-6 (Resolver finalizes once)
- [ ] SYS-INV-7 (Treasury exposure monotone)
- [ ] SYS-INV-8 (Single redeem per holder per market)
- [ ] SYS-INV-9 (Void payout bounded)

---

## Running the Traceability Checker

```bash
cd oracledesk-stellar
python3 scripts/spec-trace.py
```

This reports:
- Total clauses defined in `docs/spec/`.
- Clauses with ≥1 test annotation.
- Clauses marked UNTESTED(#issue).
- Clauses with no coverage and no UNTESTED mark (error).

Exit code 0 if all clauses are covered or marked UNTESTED; 1 otherwise.

---

## See Also

- `docs/spec/conventions.md` — clause ID scheme.
- `docs/spec/market-core.md`, `resolver.md`, `treasury.md`, `reasoning-registry.md` — per-contract specs.
- `scripts/spec-trace.py` — the checker script.
