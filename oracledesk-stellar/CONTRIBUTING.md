# Contributing to OracleDesk (Stellar)

Thanks for considering contributing. This is a testnet-only, unaudited,
pre-alpha project — see `docs/STATUS.md` for exactly what works today.

## Dev setup

```bash
git clone <this repo>
cd oracledesk-stellar
make setup   # npm install in x402/, agents/, packages/bindings/*
make build   # cargo build + stellar contract build
make test    # cargo test + model/fpmm_model.py + x402 tests
```

You'll need Rust (stable, with the `wasm32v1-none` target —
`rust-toolchain.toml` handles this via `rustup`), the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli) v27+, Node 20+,
Python 3.10+, and `jq`.

## Branch and commit conventions

- Branch names: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`. Keep them small
  and scoped to one logical change.
- No force-pushes to shared branches.

## Running the test suites

```bash
cargo test --workspace                          # all 4 contracts
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
python3 model/fpmm_model.py                      # FPMM math property tests
cd x402 && npm test                              # x402 trace API
cd agents && npm test                            # FPMM (BigInt), trace, strategy, adapter
```

Contract changes need:

- A test for every new state transition.
- A non-mocked-auth test proving the wrong caller is rejected, for every
  privileged function (see `wrong_caller_cannot_*` tests across
  `contracts/*/src/lib.rs` for the pattern — `env.set_auths(&[])` plus
  `mock_auths` for a specific *other* address, not `mock_all_auths`, which
  would hide a missing `require_auth`).
- If the change touches `market-core`, rebuild its wasm and re-copy it into
  `contracts/resolver/market_core.wasm` and
  `contracts/treasury/market_core.wasm` before those crates will see the
  change — `make build` does this in the right order automatically; running
  `cargo build -p resolver` on its own after touching market-core will
  silently build against the stale copy. See
  [docs/adr/0002-cross-contract-calls.md](docs/adr/0002-cross-contract-calls.md).

## Code style

- Rust: `cargo fmt` (rustfmt defaults) and a clean `clippy -D warnings`.
- TypeScript: no linter is configured yet (see `docs/wave-issues/`) —
  follow the style already in the file you're editing.
- Doc comments explain *why*, not *what* — see the existing contract source
  for the level of comment density we're going for (sparse, but present at
  every non-obvious invariant).

## Pull request checklist

- [ ] `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D
      warnings` both pass.
- [ ] `cargo test --workspace` passes.
- [ ] If you touched contract interfaces, bindings were regenerated
      (`make bindings`) and the diff is included.
- [ ] If you touched `market-core`'s interface, `resolver`'s and
      `treasury`'s vendored `market_core.wasm` copies were refreshed.
- [ ] New behavior has a test; changed behavior's existing test was updated,
      not deleted.
- [ ] `docs/STATUS.md` updated if this changes what's verified/unverified.

## Issues and how to ask for one

Issues are scoped as files in `docs/wave-issues/NN-title.md` before being
filed to GitHub (each has context, files to touch, acceptance criteria, how
to test, and a complexity label). If you want to work on one, comment on the
filed GitHub issue (once filed) to claim it, or open a new issue referencing
the relevant `docs/wave-issues/` file if it hasn't been filed yet.

<!-- TODO(maintainer): state an expected review turnaround here once you
have one — not committing to a number without your input. -->

## Reporting security issues

Do not open a public issue for a security vulnerability — see
[SECURITY.md](SECURITY.md).
