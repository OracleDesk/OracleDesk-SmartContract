# Coverage

```bash
make setup                       # once: installs the bindings, x402, agents
cargo install --locked cargo-llvm-cov --version 0.9.1
rustup component add llvm-tools-preview
make coverage                    # coverage/{rust,x402,agents}.lcov, lcov.info, html/index.html
make coverage-gate               # fails below coverage/thresholds.json
make coverage-gate BASE=/path/to/base/lcov.info   # also fails on a drop > 0.5 points
```

## What is measured

- **Rust**: line coverage from `cargo llvm-cov` over every contract. Inline
  `#[cfg(test)]` modules are removed from the report (`scripts/coverage-tools.py
  rust-filter` cuts each file at its first `#[cfg(test)] mod`), as are
  `contracts/integration-tests`, `scripts/spec-hash`, vendored wasm and
  dependencies. Branch coverage needs a nightly toolchain
  (`-Zcoverage-options=branch`), so the stable report is line and function
  coverage only.
- **TypeScript**: `c8` wrapping `tsx --test` in `x402/` and `agents/`
  (`npm run coverage`), with `--all` so untested files count as 0%. Paths map to
  `.ts` sources (tsx emits source maps). Statements, branches and functions are
  in each package's `coverage/<pkg>/lcov.info`.

## Why market-core runs twice

`resolver` and `treasury` tests register `market-core` from its compiled wasm
(ADR 0002), which runs inside the Soroban VM and produces no host coverage, so
market-core lines reached through those scenarios were invisible. Their tests now
choose a registration at run time (`MARKET_CORE_IMPL=native|wasm`, default wasm;
`both_modes!` pins individual scenarios to both), and the report accumulates a
wasm run and a native run. `native_and_wasm_market_core_agree` (in both crates)
asserts the two behave identically step by step, which also catches the vendored
`market_core.wasm` drifting from the source.

Measured: `cargo test -p resolver` alone covers **0 of 1,114** market-core lines
with market-core as wasm and **636 (57.1%)** with it native.

## Reading the numbers

- `#[contractimpl]` / `#[contract]` expand to wrapper functions and spec statics
  that llvm-cov attributes to the attribute line; they are not filtered.
- `contractimport!` expands to a client for the imported wasm; its lines are
  attributed to the one-line macro call.
- The 11 treasury tests that already fail on `develop` still contribute the lines
  they reach (`--ignore-run-fail`); pass/fail is the test job's concern.

## Gate

`coverage/thresholds.json` holds per-package minimums, set from the measured value
minus 2 points. `scripts/coverage-gate.py` fails a package below its minimum, or
(with a base report) one that dropped more than 0.5 points. It skips the delta
with a notice when no base exists. `python3 scripts/coverage-gate.py --self-test`
covers pass, below-minimum and drop-versus-base.

## Known-unreachable error codes

These `Error` variants are declared but constructed nowhere in production code
today. They are listed, not removed, because deleting a variant renumbers or
retires a code the generated bindings and integrators already see.

| Contract | Variant | Code |
|---|---|---|
| resolver | `Unauthorized` | 2 |
| resolver | `InvalidPrice` | 10 |
| treasury | `NoPendingAdmin` | 46 |
| treasury | `PendingAdminExpired` | 47 |
| timelock | `Unauthorized` | 2 |
| timelock | `OperationNotPending` | 7 |

(`CategoryCapExceeded` and `BucketCapExceeded` are constructed in
`contracts/treasury/src/correlation.rs`, so they are reachable.) Regenerate the
list by scanning each contract's `Error` enum for variants with no `Error::<name>`
use outside its test modules.
