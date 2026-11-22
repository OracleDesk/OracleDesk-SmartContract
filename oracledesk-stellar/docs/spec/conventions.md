# OracleDesk Protocol Specification — Conventions

This document defines the notation, terminology, and clause identifier scheme used across the OracleDesk protocol specification in `docs/spec/`.

## RFC 2119 Keywords

This specification uses RFC 2119 keywords to indicate requirement levels:

- **MUST** / **SHALL** — absolute requirement; non-compliance is a bug.
- **MUST NOT** — absolute prohibition; non-compliance is a bug.
- **SHOULD** — recommended but not required; deviations must be documented.
- **SHOULD NOT** — not recommended; deviations must be documented.
- **MAY** / **CAN** — optional; the implementation is free to choose.

## Notation

### Storage and State

- **`P[Key]`** — persistent storage entry (data-keyed state live across transactions).
  - Example: `P[Market(id)]` refers to the persistent market entry for market ID `id`.
  - Persistent keys remain until explicitly deleted; their TTLs must be extended on every touch.

- **`I[Key]`** — instance storage entry (contract-scoped global state, one per contract instance).
  - Example: `I[Paused]` refers to the instance-level pause flag.
  - Instance storage is never TTL-extended unless explicitly documented.

- **`V[key]`** — view function result (pure read, no state change).

### Time and Ledger

- **`now`** — shorthand for `ledger().timestamp()`, the current Stellar ledger timestamp (seconds since Jan 1, 1970 UTC).
- **`latest_ledger`** — the current ledger number.
- **`DAY_SECONDS`** — 86400 seconds (24 hours).
- **`DAY_IN_LEDGERS`** — approximately 17280 ledgers (24 hours / 5-second slot time), as defined by the Stellar network.

### Authorization and Signatures

- **`auth(x)`** — `x.require_auth()` in Soroban Rust; enforces that address `x` has authorized the current invocation.
- **`invoker_auth`** — the authorization tree's direct caller.
- **`auth_tree`** — the full chain of invocations and their authorizations, used for nested cross-contract calls.

### Arithmetic

- **floor, ceil** — rounding direction (explicitly stated in every arithmetic postcondition).
- **`checked_*`** — arithmetic that traps (reverts) on overflow/underflow (Rust `checked_add`, `checked_sub`, etc.).
- **`wrapping_*`** — arithmetic that overflows/underflows silently (not used in normative code).
- **BPS** — basis points; 1 BPS = 0.01% = 1/10000. Example: 25 BPS = 0.25%.

### Sets and Contracts

- **Contract prefix** — in clause IDs (see below):
  - **`MC`** — market-core
  - **`RS`** — resolver
  - **`TR`** — treasury
  - **`RR`** — reasoning-registry
  - **`SYS`** — system-level (cross-contract)

- **Function and outcome types:**
  - **`Outcome`** — enum: `Yes` or `No` (binary markets only in this release).
  - **`MarketStatus`** — enum: `Open`, `Closed`, `Resolved`, `Void`, `Finalized`.
  - **`ResolutionState`** — enum state machine for resolver (details in `resolver.md`).

## Clause Identifier Scheme

Every requirement, precondition, postcondition, event, error, and invariant has a stable, machine-readable ID.

### Format

```
<CONTRACT>-<FUNCTION>-<KIND>-<n>
```

- **`<CONTRACT>`** — one of `MC`, `RS`, `TR`, `RR`, `SYS`.
- **`<FUNCTION>`** — the entrypoint or view name, all caps (e.g., `BUY`, `RESOLVE_PRICE`, `TRANSFER_POSITION`).
- **`<KIND>`** — the type of clause:
  - **`AUTH`** — authorization requirement (who must sign).
  - **`PRE`** — precondition (must be true before the entrypoint runs).
  - **`POST`** — postcondition (must be true after the entrypoint succeeds).
  - **`EVT`** — emitted event.
  - **`ERR`** — error code and condition.
  - **`INV`** — invariant preserved by this entrypoint.
- **`<n>`** — ordinal (1, 2, 3, ...), in the order clauses appear in the spec.

### Examples

- `MC-BUY-AUTH-1` — first authorization clause for market-core's `buy` entrypoint.
- `MC-BUY-PRE-3` — third precondition for `buy`.
- `MC-BUY-POST-2` — second postcondition for `buy`.
- `MC-BUY-EVT-1` — first event emitted by `buy`.
- `MC-BUY-ERR-5` — fifth error clause (and its code) for `buy`.
- `SYS-INV-1` — first system-level invariant.

### Stability

Clause IDs are stable once published. If a clause is split, removed, or reordered:
- **Split** — the original ID is kept for the first part; new IDs are added for new parts.
- **Remove** — the ID is marked deprecated; a new issue documents why.
- **Reorder** — only add clauses to the end of a function's clause list; never renumber existing ones.

## Test Traceability

Every test that enforces a specification clause is annotated in its source code with a comment:

```rust
#[test]
fn buy_requires_trader_auth_and_checks_pause_before_auth() {
    // spec: MC-BUY-AUTH-1, MC-BUY-PRE-1
    ...
}
```

The traceability checker `scripts/spec-trace.py` scans all test files and verifies that every clause (`AUTH`, `PRE`, `POST`, `EVT`, `ERR`, `INV`) is either:
1. Annotated on at least one test, or
2. Marked with `UNTESTED(#issue-number)` and linked to a GitHub issue explaining why.

## Cross-Contract Error Codes

Error codes are contract-scoped (each contract has its own code space: 1–18, etc.). When one contract calls another and the nested call fails, the error code bubbles up with the **calling contract's** contract type, not the callee's.

Example: If `treasury` calls `market_core::buy` and it fails with `MarketClosed` (code 9 in market-core), the caller observes `treasury::Error { code: X }` where `X` is treasury's error space. This mapping is documented per error in each contract's spec.

## Implementation Notes

- **Order of checks is normative.** If a precondition clause list says "check Paused, then auth, then existence," that order determines which error a client sees first. The order is intended and tested.
- **State updates before external calls** (interactions). Exceptions are explicitly documented in the postcondition.
- **TTL extension.** Persistent keys are explicitly noted where TTL is extended (e.g., on read, on write, on function entry). Instance keys are never extended.

## References

- RFC 2119: https://www.rfc-editor.org/rfc/rfc2119
- Soroban authorization model: https://developers.stellar.org/docs/learn/encyclopedia/security/authorization
- Stellar Consensus Protocol (ledger state machine): https://developers.stellar.org/docs/learn/fundamentals/stellar-consensus-protocol

## See Also

- `docs/spec/market-core.md` — market-core contract specification.
- `docs/spec/resolver.md` — resolver contract specification.
- `docs/spec/treasury.md` — treasury contract specification.
- `docs/spec/reasoning-registry.md` — reasoning-registry contract specification.
- `docs/spec/system.md` — cross-contract invariants and flows.
- `docs/spec/traceability.md` — clause-to-test mapping and coverage report.
