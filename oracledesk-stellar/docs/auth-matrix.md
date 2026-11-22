# Cross-contract authorization matrix

`contracts/integration-tests` is a test-only crate that imports the **shipping
wasm** for `market-core`, `resolver`, `treasury` and `reasoning-registry`
(`contractimport!` from `contracts/integration-tests/wasm/`) and wires them the
same way the deploy scripts do. The wasm copies are refreshed by `make build`.

```bash
make auth-matrix
# or
cargo test -p integration-tests --test auth_matrix
```

## Why wasm, not Rust symbols

`contractimport!` gives the test the exact exported interface and bytecode that
ships. A refactor that changes an argument order, an auth check or a nested
sub-invocation changes the wasm and therefore fails here, instead of passing
against a linked Rust copy that production never runs.

## What every test asserts

Each positive test:

1. clears all auth state (`env.set_auths(&[])`);
2. installs **only** the exact `MockAuth` tree it expects, including nested
   token `transfer` invocations where the contract performs one;
3. calls the entrypoint;
4. compares `env.auths()` with that exact tree — no "some auth happened"
   shortcuts, and no blanket `mock_all_auths()`.

Negative tests install a *wrong* signer (or no signer), call the same
entrypoint with `try_*`, and assert it fails. The matrix also includes
role-separation cases (resolver admin vs market-core admin vs treasury admin),
successor-admin acceptance, and permissionless calls that must record **no**
signer auth.

`every_entrypoint_has_a_matrix_row` parses each wasm's `contractspecv0`
section with `wasmparser`/`stellar-xdr` and fails if an exported entrypoint is
missing from the matrix's positive-row table.

`scripts/check-no-mock-all-auths.sh` (run by `make lint` and `make
auth-matrix`) fails the build if `mock_all_auths` ever appears in this crate.

## Nested authorization: what `env.auths()` does and does not show

Soroban's `env.auths()` only reports **signer** authorization entries
(addresses backed by signatures or explicit mocks). Two real nested cases
therefore look different:

* **market-core buy/create** pulls collateral with
  `token.transfer(trader → market-core)`, so the matrix mocks and asserts the
  signer entry plus the nested token invocation.
* **treasury.agent_buy** pulls collateral from the treasury itself. The
  treasury is the direct caller of market-core, so its self-authorization
  covers the token transfer; `env.auths()` records only the agent entry. The
  test asserts that exact tree, and a separate negative test proves that
  removing the agent fails even though the contract self-auth still exists.
* **resolver → market-core** resolution is a contract-to-contract call. The
  resolver's admin signs the resolver entrypoint; market-core sees the
  resolver address as the caller (`require_resolver`), not the admin. The
  guardian-void test exercises the nested call end-to-end and a negative test
  proves a non-admin cannot trigger it.

## Coverage table

| Contract | Positive rows | Notable negative / role cases |
| --- | --- | --- |
| market-core | admin setters, create, buy, sell, resolve/void via resolver, redeem, claim remainder/fees, sweep, position/LP transfers | wrong admin, creator-only claim, wrong signer on buy/sell |
| resolver | admin actions, spec registration, attest, finalize, price resolution, guardian void, committee epoch pin | non-admin admin actions, non-signer attest, wrong signer |
| treasury | admin actions, deposit/request_withdraw, agent create/buy/sell, unwind modes/floors, agent_halt, settle, redeem, claim, fee collection, delayed ops, correlation/token caps | wrong admin, non-agent trade, non-unwinder unwind, agent-role separation |
| reasoning-registry | admin actions, register/unregister agent, publish trace, consumer path | non-agent publish, wrong admin |

## Adding an entrypoint

1. add the positive row to `MATRIX` or `PERMISSIONLESS` in
   `tests/auth_matrix.rs`;
2. add a targeted test with the exact signer/sub-invocation tree;
3. add at least one negative case if the entrypoint has an auth gate;
4. run `make auth-matrix`. The spec-coverage test lists any missing rows.

## Scope

This matrix verifies **authorization**, not business logic, math, or
cross-chain/off-chain behaviour. Math is covered by unit tests, the Python
model and the Kani harnesses; state-machine sequences are covered by
`tests/system_model.rs`; a real quickstart network is covered by
`scripts/e2e-local.sh`.
